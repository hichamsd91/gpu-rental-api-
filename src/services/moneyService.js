/**
 * Money service (Phase 4): Stripe-backed intake, escrow, payouts, refunds, invoices.
 *
 * Backing: migration 014. Every public function fails with `MoneyUnavailable`
 * (503) when the migration is absent, so a missing table never 500s. Stripe
 * calls are delegated to stripeService and are no-ops when STRIPE_SECRET_KEY
 * is unset.
 */
const { getSupabaseClient } = require('../config/supabase');
const catalog = require('./catalogService');
const { isMissingSchema } = catalog;
const stripe = require('./stripeService');
const crypto = require('crypto');

const TABLES = {
  accounts: 'stripe_accounts',
  intents: 'payment_intents',
  escrow: 'escrow_holds',
  payouts: 'payouts',
  refunds: 'refunds',
  invoices: 'invoices'
};

class MoneyError extends Error {
  constructor(message, code = 'money_error', status = 400, extra = {}) {
    super(message); this.name = 'MoneyError'; this.code = code; this.status = status; this.extra = extra;
  }
}
class MoneyUnavailable extends MoneyError {
  constructor() { super('Money features are not available on this deployment yet (migration 014 not applied).', 'money_unavailable', 503); this.name = 'MoneyUnavailable'; }
}

const client = () => getSupabaseClient(true);
const failOpen = (error) => { throw isMissingSchema(error) ? new MoneyUnavailable() : error; };
const camel = (row) => {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
};

// ─── Stripe Connect accounts ─────────────────────────────────────────────────
const getStripeAccount = async (userId) => {
  try {
    const { data, error } = await client().from(TABLES.accounts).select('*').eq('user_id', userId).maybeSingle();
    if (error) { failOpen(error); return null; }
    return data ? camel(data) : null;
  } catch (e) { failOpen(e); }
};

const upsertStripeAccount = async (userId, fields) => {
  const payload = { user_id: userId, updated_at: new Date().toISOString(), ...fields };
  try {
    const { data, error } = await client().from(TABLES.accounts).upsert(payload, { onConflict: 'user_id' }).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const ensureConnectAccount = async (userId, email, country = 'US') => {
  if (!stripe.isStripeConfigured()) throw new MoneyError('Stripe is not configured', 'stripe_unavailable', 503);
  const existing = await getStripeAccount(userId);
  if (existing) return existing;
  const account = await stripe.createConnectAccount({ email, country, metadata: { userId } });
  return upsertStripeAccount(userId, {
    stripe_account_id: account.id,
    onboarding_status: 'pending',
    charges_enabled: account.charges_enabled === true,
    payouts_enabled: account.payouts_enabled === true,
    details_submitted: account.details_submitted === true,
    country: account.country || country,
    default_currency: (account.default_currency || 'usd').toUpperCase()
  });
};

const refreshConnectAccount = async (userId) => {
  const acct = await getStripeAccount(userId);
  if (!acct) return null;
  const remote = await stripe.retrieveAccount(acct.stripeAccountId);
  return upsertStripeAccount(userId, {
    onboarding_status: remote.details_submitted ? (remote.charges_enabled ? 'complete' : 'in_progress') : 'pending',
    charges_enabled: remote.charges_enabled === true,
    payouts_enabled: remote.payouts_enabled === true,
    details_submitted: remote.details_submitted === true
  });
};

// ─── Payment intents ──────────────────────────────────────────────────────────
const recordPaymentIntent = async (row) => {
  const payload = {
    id: row.id, user_id: row.userId, amount_minor: row.amountMinor, currency: row.currency || 'USD',
    status: row.status || 'requires_payment_method', order_id: row.orderId || null,
    rental_id: row.rentalId || null, client_secret: row.clientSecret || null,
    idempotency_key: row.idempotencyKey || null, metadata: row.metadata || {}
  };
  try {
    const { data, error } = await client().from(TABLES.intents).upsert(payload, { onConflict: 'id' }).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const getPaymentIntent = async (id) => {
  try {
    const { data, error } = await client().from(TABLES.intents).select('*').eq('id', id).maybeSingle();
    if (error) { failOpen(error); return null; }
    return data ? camel(data) : null;
  } catch (e) { failOpen(e); }
};

const updatePaymentIntentStatus = async (id, status) => {
  try {
    const { data, error } = await client().from(TABLES.intents).update({ status, updated_at: new Date().toISOString() }).eq('id', id).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const createPaymentIntentForOrder = async ({ userId, orderId, amountMinor, currency = 'USD', idempotencyKey = null }) => {
  if (!stripe.isStripeConfigured()) throw new MoneyError('Stripe is not configured', 'stripe_unavailable', 503);
  const pi = await stripe.createPaymentIntent({ amountMinor, currency, userId, orderId, idempotencyKey });
  return recordPaymentIntent({
    id: pi.id, userId, amountMinor, currency, status: pi.status,
    orderId, clientSecret: pi.client_secret, idempotencyKey, metadata: { orderId }
  });
};

// ─── Escrow ───────────────────────────────────────────────────────────────────
const createEscrowHold = async ({ rentalId, paymentIntentId = null, amountMinor, currency = 'USD' }) => {
  const payload = {
    rental_id: rentalId, payment_intent_id: paymentIntentId,
    amount_minor: amountMinor, currency, status: 'held'
  };
  try {
    const { data, error } = await client().from(TABLES.escrow).upsert(payload, { onConflict: 'rental_id' }).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const getEscrowHold = async (rentalId) => {
  try {
    const { data, error } = await client().from(TABLES.escrow).select('*').eq('rental_id', rentalId).maybeSingle();
    if (error) { failOpen(error); return null; }
    return data ? camel(data) : null;
  } catch (e) { failOpen(e); }
};

const releaseEscrow = async (rentalId, providerId, { commissionBps = 500, group = null } = {}) => {
  const g = group || crypto.randomUUID();
  try {
    const { data, error } = await client().rpc('release_escrow', {
      p_rental_id: rentalId, p_provider_id: providerId,
      p_commission_bps: commissionBps, p_group: g
    });
    if (error) { failOpen(error); return { ok: false, code: 'rpc_error', message: error.message }; }
    return data;
  } catch (e) { failOpen(e); }
};

const refundEscrow = async (rentalId, renterId, { amountMinor = null, group = null } = {}) => {
  const g = group || crypto.randomUUID();
  try {
    const { data, error } = await client().rpc('refund_escrow', {
      p_rental_id: rentalId, p_renter_id: renterId,
      p_amount_minor: amountMinor, p_group: g
    });
    if (error) { failOpen(error); return { ok: false, code: 'rpc_error', message: error.message }; }
    return data;
  } catch (e) { failOpen(e); }
};

// ─── Payouts (T+7) ───────────────────────────────────────────────────────────
const schedulePayout = async ({ providerId, amountMinor, currency = 'USD', rentalIds = [], delayDays = 7 }) => {
  const scheduledFor = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000).toISOString();
  const payload = {
    provider_id: providerId, amount_minor: amountMinor, currency,
    status: 'scheduled', scheduled_for: scheduledFor, rental_ids: rentalIds
  };
  try {
    const { data, error } = await client().from(TABLES.payouts).insert(payload).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const listPayouts = async (providerId) => {
  try {
    const { data, error } = await client().from(TABLES.payouts).select('*').eq('provider_id', providerId).order('created_at', { ascending: false });
    if (error) { failOpen(error); return []; }
    return (data || []).map(camel);
  } catch (e) { failOpen(e); return []; }
};

const duePayouts = async () => {
  try {
    const now = new Date().toISOString();
    const { data, error } = await client().from(TABLES.payouts).select('*').eq('status', 'scheduled').lte('scheduled_for', now);
    if (error) { failOpen(error); return []; }
    return (data || []).map(camel);
  } catch (e) { failOpen(e); return []; }
};

const markPayoutPaid = async (id, { transferId = null, payoutId = null } = {}) => {
  try {
    const { data, error } = await client().from(TABLES.payouts).update({
      status: 'paid', paid_at: new Date().toISOString(),
      stripe_transfer_id: transferId, stripe_payout_id: payoutId, updated_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const markPayoutFailed = async (id, reason) => {
  try {
    const { data, error } = await client().from(TABLES.payouts).update({
      status: 'failed', failure_reason: reason, updated_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

// ─── Refunds ──────────────────────────────────────────────────────────────────
const createRefundRecord = async ({ paymentIntentId, rentalId = null, amountMinor, currency = 'USD', reason = null, idempotencyKey = null }) => {
  const payload = {
    payment_intent_id: paymentIntentId, rental_id: rentalId,
    amount_minor: amountMinor, currency, reason, status: 'pending',
    idempotency_key: idempotencyKey
  };
  try {
    const { data, error } = await client().from(TABLES.refunds).insert(payload).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const updateRefundStatus = async (id, status, stripeRefundId = null) => {
  try {
    const { data, error } = await client().from(TABLES.refunds).update({
      status, stripe_refund_id: stripeRefundId, updated_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

// ─── Invoices ─────────────────────────────────────────────────────────────────
const nextInvoiceNumber = () => `INV-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const createInvoice = async ({ userId, rentalId = null, orderId = null, amountMinor, currency = 'USD', pdfUrl = null }) => {
  const payload = {
    user_id: userId, rental_id: rentalId, order_id: orderId,
    amount_minor: amountMinor, currency, invoice_number: nextInvoiceNumber(), pdf_url: pdfUrl
  };
  try {
    const { data, error } = await client().from(TABLES.invoices).insert(payload).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const listInvoices = async (userId) => {
  try {
    const { data, error } = await client().from(TABLES.invoices).select('*').eq('user_id', userId).order('issued_at', { ascending: false });
    if (error) { failOpen(error); return []; }
    return (data || []).map(camel);
  } catch (e) { failOpen(e); return []; }
};

module.exports = {
  MoneyError, MoneyUnavailable, isMissingSchema: isMissingSchema,
  getStripeAccount, upsertStripeAccount, ensureConnectAccount, refreshConnectAccount,
  recordPaymentIntent, getPaymentIntent, updatePaymentIntentStatus, createPaymentIntentForOrder,
  createEscrowHold, getEscrowHold, releaseEscrow, refundEscrow,
  schedulePayout, listPayouts, duePayouts, markPayoutPaid, markPayoutFailed,
  createRefundRecord, updateRefundStatus, createInvoice, listInvoices,
  TABLES
};
