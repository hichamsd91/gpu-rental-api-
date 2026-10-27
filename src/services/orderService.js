/**
 * Multi-item orders / cart (Phase 3).
 *
 * Flow (each step safe to retry with the same Idempotency-Key):
 *   draft  --reserve-->  awaiting_payment (holds, TTL)
 *   awaiting_payment --pay--> paid (one `rentals` row per item)
 *   draft|awaiting_payment --cancel--> cancelled | partially cancelled
 *
 * The concurrency-sensitive parts are Postgres functions (migration 013):
 * all-items-or-none holds, compare-and-set state changes and stale-hold sweeps.
 * This module owns validation, server-side pricing and the HTTP-facing errors.
 *
 * Money: no debit happens here. `pay` creates `pending` rentals; the existing
 * wallet/escrow gate at rental start stays the single debit path until Phase 4
 * replaces it with Stripe + the double-entry ledger.
 */
const { getSupabaseClient } = require('../config/supabase');
const { GpuListingService } = require('./supabaseService');
const catalog = require('./catalogService');
const crypto = require('crypto');
const { isMissingSchema } = catalog;

const ORDERS = 'orders';
const ITEMS = 'order_items';

const MAX_ITEMS = 10;
const DEFAULT_HOLD_SECONDS = 900;   // 15 minutes to pay
const MAX_HOLD_SECONDS = 3600;

class OrderError extends Error {
  constructor(message, code = 'order_error', status = 400, extra = {}) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

class OrdersUnavailable extends OrderError {
  constructor() {
    super(
      'Orders are not available on this deployment yet (migration 013 not applied).',
      'orders_unavailable',
      503
    );
    this.name = 'OrdersUnavailable';
  }
}

const client = () => getSupabaseClient(true);

const camel = (row) => {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return out;
};

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const failOpen = (error) => { throw isMissingSchema(error) ? new OrdersUnavailable() : error; };

// ============================================
// Pricing + validation
// ============================================

/**
 * The purpose actually being bought and the hourly price that applies to it.
 * A purpose with its own price (mining) always wins over the base rate — the
 * renter must never be billed at the base rate for a product priced differently.
 */
const quotePurpose = (listing, requested) => {
  const purposes = Array.isArray(listing.purposes) ? listing.purposes : [];
  const key = requested === undefined || requested === null ? '' : String(requested).trim();

  if (!key) {
    if (!purposes.length) return { purpose: null, pricePerHour: Number(listing.pricePerHour) };
    const first = purposes[0];
    return {
      purpose: first.key,
      pricePerHour: first.pricePerHour === null || first.pricePerHour === undefined
        ? Number(listing.pricePerHour)
        : Number(first.pricePerHour)
    };
  }

  const match = purposes.find((p) => p.key === key);
  if (!match) {
    throw new OrderError(`This listing is not offered for "${key}"`, 'purpose_not_offered', 400);
  }
  return {
    purpose: match.key,
    pricePerHour: match.pricePerHour === null || match.pricePerHour === undefined
      ? Number(listing.pricePerHour)
      : Number(match.pricePerHour)
  };
};

const validateDuration = (minutes, listing) => {
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new OrderError('plannedDurationMinutes must be a positive whole number', 'invalid_duration', 400);
  }
  const minMinutes = Number(listing.minRentalMinutes);
  if (Number.isFinite(minMinutes) && minutes < minMinutes) {
    throw new OrderError(`The minimum rental for this machine is ${minMinutes} minutes`, 'duration_below_minimum', 400);
  }
  const maxMinutes = Number(listing.maxRentalHours) * 60;
  if (Number.isFinite(maxMinutes) && maxMinutes > 0 && minutes > maxMinutes) {
    throw new OrderError(`The maximum rental for this machine is ${maxMinutes} minutes`, 'duration_above_maximum', 400);
  }
};

/** Loads a listing the renter is allowed to buy from (public + active). */
const loadPurchasableListing = async (listingId) => {
  let listing;
  try {
    listing = await GpuListingService.findById(listingId, null, { publicOnly: true });
  } catch (error) {
    failOpen(error);
  }
  if (!listing) throw new OrderError('Listing not found', 'listing_not_found', 404);
  return listing;
};

// ============================================
// Read
// ============================================

const findOrderRow = async (orderId, renterId) => {
  let data;
  try {
    const result = await client()
      .from(ORDERS)
      .select('*')
      .eq('id', orderId)
      .maybeSingle();
    if (result.error) failOpen(result.error);
    data = result.data;
  } catch (error) {
    if (error instanceof OrderError) throw error;
    failOpen(error);
  }
  // Someone else's order answers exactly like a missing one (no id probing).
  if (!data || String(data.renter_id).toLowerCase() !== String(renterId).toLowerCase()) {
    throw new OrderError('Order not found', 'order_not_found', 404);
  }
  return data;
};

const decorate = (orderRow, itemRows) => {
  const order = camel(orderRow);
  const items = (itemRows || []).map(camel);
  const holdExpiresAt = order.holdExpiresAt ? new Date(order.holdExpiresAt) : null;
  const holdLive = !!holdExpiresAt && holdExpiresAt.getTime() > Date.now();
  return {
    ...order,
    items,
    holdActive: order.status === 'awaiting_payment' && holdLive,
    secondsUntilHoldExpires: holdLive ? Math.max(0, Math.round((holdExpiresAt.getTime() - Date.now()) / 1000)) : 0
  };
};

const getOrder = async (orderId, renterId) => {
  const orderRow = await findOrderRow(orderId, renterId);
  let items;
  try {
    const result = await client()
      .from(ITEMS)
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true });
    if (result.error) failOpen(result.error);
    items = result.data;
  } catch (error) {
    if (error instanceof OrderError) throw error;
    failOpen(error);
  }
  return decorate(orderRow, items);
};

const listOrders = async (renterId, { page = 1, limit = 20, status = '' } = {}) => {
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

  let query = client()
    .from(ORDERS)
    .select('*', { count: 'exact' })
    .eq('renter_id', renterId);
  if (status) query = query.eq('status', status);
  query = query.order('created_at', { ascending: false })
    .range((safePage - 1) * safeLimit, safePage * safeLimit - 1);

  const { data, error, count } = await query;
  if (error) failOpen(error);

  return {
    orders: (data || []).map((row) => decorate(row, [])),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: count || 0,
      pages: Math.ceil((count || 0) / safeLimit)
    }
  };
};

// ============================================
// Create (draft) — P3-01
// ============================================

/**
 * Creates an order in `draft` with server-computed prices. Nothing is reserved
 * yet: reservation is the separate, explicit `reserve` step.
 */
const createDraft = async ({ renterId, items }) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new OrderError('items must be a non-empty array', 'invalid_items', 400);
  }
  if (items.length > MAX_ITEMS) {
    throw new OrderError(`An order may contain at most ${MAX_ITEMS} items`, 'too_many_items', 400);
  }

  const now = new Date();
  const prepared = [];

  for (const raw of items) {
    const listingId = raw && raw.listingId ? String(raw.listingId).trim() : '';
    if (!listingId) throw new OrderError('Every item needs a listingId', 'invalid_items', 400);

    const listing = await loadPurchasableListing(listingId);
    const minutes = Number(raw.plannedDurationMinutes);
    validateDuration(minutes, listing);

    const quoted = quotePurpose(listing, raw.purpose);
    if (!Number.isFinite(quoted.pricePerHour) || quoted.pricePerHour < 0) {
      throw new OrderError('Listing has an invalid price', 'invalid_price', 400);
    }

    const lineTotal = round2(quoted.pricePerHour * (minutes / 60));
    const startsAt = now;
    const endsAt = new Date(now.getTime() + minutes * 60000);

    prepared.push({
      listing_id: listingId,
      provider_id: listing.providerId,
      purpose: quoted.purpose,
      planned_duration_minutes: minutes,
      unit_price_per_hour: quoted.pricePerHour,
      line_total: lineTotal,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: 'draft'
    });
  }

  const subtotal = round2(prepared.reduce((sum, item) => sum + item.line_total, 0));
  const orderId = crypto.randomUUID();
  const stamp = new Date().toISOString();

  try {
    const { error: orderError } = await client().from(ORDERS).insert([{
      id: orderId,
      renter_id: renterId,
      status: 'draft',
      currency: 'USD',
      subtotal,
      total: subtotal,
      created_at: stamp,
      updated_at: stamp
    }]);
    if (orderError) failOpen(orderError);

    const { error: itemsError } = await client().from(ITEMS).insert(
      prepared.map((item) => ({ ...item, id: crypto.randomUUID(), order_id: orderId, created_at: stamp, updated_at: stamp }))
    );
    if (itemsError) {
      // Do not leave a header without lines behind.
      await client().from(ORDERS).delete().eq('id', orderId);
      failOpen(itemsError);
    }
  } catch (error) {
    if (error instanceof OrderError) throw error;
    failOpen(error);
  }

  return getOrder(orderId, renterId);
};

// ============================================
// Reserve (holds) — P3-02
// ============================================

/**
 * Re-prices the draft against the live listings. Returns null when unchanged,
 * or the refreshed order when a provider changed a price/duration since the
 * quote. The caller answers 409 quote_stale so the renter can accept the new
 * total — silently charging a different amount is never acceptable.
 */
const repriceIfChanged = async (order) => {
  let changed = false;
  const updates = [];

  for (const item of order.items) {
    if (item.status !== 'draft' && item.status !== 'expired' && item.status !== 'failed') continue;

    let listing;
    try {
      listing = await loadPurchasableListing(item.listingId);
    } catch (error) {
      if (error.code === 'listing_not_found') {
        throw new OrderError('A machine in this order is no longer available', 'listing_unavailable', 409, {
          itemId: item.id,
          listingId: item.listingId
        });
      }
      throw error;
    }

    const quoted = quotePurpose(listing, item.purpose);
    const lineTotal = round2(quoted.pricePerHour * (item.plannedDurationMinutes / 60));
    const priceChanged = Math.abs(Number(item.unitPricePerHour) - quoted.pricePerHour) > 0.005;
    const lineChanged = Math.abs(Number(item.lineTotal) - lineTotal) > 0.005;

    if (priceChanged || lineChanged) {
      changed = true;
      updates.push({
        id: item.id,
        unit_price_per_hour: quoted.pricePerHour,
        line_total: lineTotal
      });
    }
  }

  if (!changed) return null;

  const subtotal = round2(order.items.reduce((sum, item) => {
    const updated = updates.find((u) => u.id === item.id);
    return sum + (updated ? updated.line_total : Number(item.lineTotal));
  }, 0));

  const db = client();
  for (const update of updates) {
    const { error } = await db.from(ITEMS)
      .update({
        unit_price_per_hour: update.unit_price_per_hour,
        line_total: update.line_total,
        updated_at: new Date().toISOString()
      })
      .eq('id', update.id);
    if (error) failOpen(error);
  }
  const { error: orderError } = await db.from(ORDERS)
    .update({ subtotal, total: subtotal, updated_at: new Date().toISOString() })
    .eq('id', order.id);
  if (orderError) failOpen(orderError);

  return getOrder(order.id, order.renterId);
};

const callRpc = async (fn, args) => {
  const { data, error } = await client().rpc(fn, args);
  if (error) failOpen(error);
  return data || {};
};

/** Maps a failed RPC answer to the matching HTTP status. */
const raiseForRpc = (result) => {
  const code = result.code || 'order_failed';
  const statusByCode = {
    order_not_found: 404,
    listing_unavailable: 409,
    listing_busy: 409,
    order_not_reservable: 409,
    order_not_payable: 409,
    hold_expired: 409,
    order_already_paid: 409,
    order_empty: 400,
    nothing_to_cancel: 409
  };
  throw new OrderError(
    {
      listing_unavailable: 'A machine in this order is no longer available',
      listing_busy: 'A machine in this order is already reserved for that window',
      order_not_reservable: 'This order can no longer be reserved',
      order_not_payable: 'This order cannot be paid in its current state',
      hold_expired: 'The reservation expired before payment — please reserve again',
      order_already_paid: 'This order is already paid',
      order_empty: 'This order has no items left',
      nothing_to_cancel: 'Nothing in this order can be cancelled',
      order_not_found: 'Order not found'
    }[code] || 'The order could not be updated',
    code,
    statusByCode[code] || 400,
    {
      itemId: result.itemId || null,
      listingId: result.listingId || null,
      status: result.status || null
    }
  );
};

/**
 * Holds every item, or none. A repeated call while the hold is still live is a
 * no-op that returns the same order (safe to retry after a dropped response).
 */
const reserve = async ({ orderId, renterId, ttlSeconds = DEFAULT_HOLD_SECONDS }) => {
  const order = await getOrder(orderId, renterId);

  if (order.status === 'paid') throw new OrderError('This order is already paid', 'order_already_paid', 409);
  if (order.status === 'cancelled') throw new OrderError('This order was cancelled', 'order_cancelled', 409);
  if (order.holdActive) return order;

  const repriced = await repriceIfChanged(order);
  if (repriced) {
    throw new OrderError('Prices changed since this quote — review the new total', 'quote_stale', 409, {
      order: repriced
    });
  }

  const ttl = Math.min(Math.max(parseInt(ttlSeconds, 10) || DEFAULT_HOLD_SECONDS, 60), MAX_HOLD_SECONDS);
  const now = new Date();

  for (const item of order.items) {
    if (!['draft', 'expired', 'failed'].includes(item.status)) continue;
    const { windows, blackouts } = await catalog.getAvailabilityRows(item.listingId);
    const start = item.startsAt || now;
    const end = item.endsAt || new Date(now.getTime() + item.plannedDurationMinutes * 60000);
    if (!catalog.isWindowOpen(windows, blackouts, start, end)) {
      throw new OrderError('This machine is not available for the requested window', 'listing_closed', 409, {
        itemId: item.id,
        listingId: item.listingId,
        nextOpeningAt: catalog.findNextOpening(windows, blackouts, new Date(start))
      });
    }
  }

  const result = await callRpc('order_reserve', {
    p_order_id: orderId,
    p_renter_id: renterId,
    p_ttl_seconds: ttl
  });
  if (!result.ok && result.code !== 'already_reserved') raiseForRpc(result);

  return getOrder(orderId, renterId);
};

// ============================================
// Pay — P3-06
// ============================================

const pay = async ({ orderId, renterId }) => {
  const result = await callRpc('order_pay', { p_order_id: orderId, p_renter_id: renterId });
  if (!result.ok && result.code !== 'already_paid') raiseForRpc(result);

  const order = await getOrder(orderId, renterId);
  return {
    ...order,
    // Explicit for the client: which rental each line became.
    rentals: Array.isArray(result.rentals) ? result.rentals : []
  };
};

// ============================================
// Cancel / partial cancel — P3-04
// ============================================

const cancel = async ({ orderId, renterId, itemIds = null }) => {
  const ids = Array.isArray(itemIds) && itemIds.length ? itemIds.map(String) : null;
  const result = await callRpc('order_cancel', {
    p_order_id: orderId,
    p_renter_id: renterId,
    p_item_ids: ids
  });
  if (!result.ok && result.code !== 'already_cancelled') raiseForRpc(result);

  return getOrder(orderId, renterId);
};

// ============================================
// Sweep — self-healing holds
// ============================================

/** Expires holds whose TTL ran out. Called by the background enforcer. */
const expireStale = async (limit = 100) => {
  const result = await callRpc('order_expire_stale', { p_limit: Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500) });
  return { orders: Number(result.orders) || 0, items: Number(result.items) || 0 };
};

module.exports = {
  MAX_ITEMS,
  DEFAULT_HOLD_SECONDS,
  MAX_HOLD_SECONDS,
  OrderError,
  OrdersUnavailable,
  quotePurpose,
  createDraft,
  getOrder,
  listOrders,
  reserve,
  pay,
  cancel,
  expireStale
};
