/**
 * Rental catalog (Phase 2): purposes, per-purpose pricing, installed software,
 * access methods and availability.
 *
 * Every function here is written to survive a deployment where migration 012
 * has not been applied yet: reads fall back to "no catalog data" and writes
 * answer a clear 503 instead of a 500. Listings keep listing and booking.
 *
 * Money: prices stay decimal dollars like gpu_listings.price_per_hour. The
 * ledger converts to integer minor units at its own boundary (decision A1).
 */
const { getSupabaseClient } = require('../config/supabase');
const flags = require('./featureFlagService');

const LISTINGS = 'gpu_listings';
const RENTALS = 'rentals';
const PURPOSES = 'rental_purposes';
const LISTING_PURPOSES = 'listing_purposes';
const SOFTWARE = 'listing_software';
const AVAILABILITY = 'listing_availability';
const BLACKOUTS = 'listing_blackouts';

const ACCESS_METHODS = ['ssh', 'rdp', 'streaming', 'jupyter'];
const SOFTWARE_CATEGORIES = ['cuda', 'framework', 'tool', 'other'];

// D2 guard rails: a mining listing must declare a bounded power budget and a
// human-readable disclosure — an unbounded "mining allowed" toggle is how a
// marketplace gets banned by its own hosting provider.
const MINING_MIN_WATTS = 50;
const MINING_MAX_WATTS = 1000;
const MINING_MIN_DISCLOSURE = 20;
const MINING_MAX_DISCLOSURE = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RENTAL_LOOKBACK_MS = 30 * DAY_MS;

class CatalogError extends Error {
  constructor(message, code = 'invalid_catalog', status = 400) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.status = status;
  }
}

class CatalogUnavailable extends CatalogError {
  constructor() {
    super('The catalog is not available on this deployment yet (migration 012 not applied).',
      'catalog_unavailable', 503);
    this.name = 'CatalogUnavailable';
  }
}

const client = () => getSupabaseClient(true);

/** PostgREST reports a missing table/column as 42P01/42703 or a schema-cache error. */
const isMissingSchema = (error) => {
  if (!error) return false;
  const msg = String(error.message || '');
  return (
    error.code === '42P01' ||
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    msg.includes('schema cache') ||
    msg.includes('does not exist')
  );
};

const camel = (row) => {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return out;
};

// Used only when migration 012 is absent, so the public catalog still renders
// (with mining correctly disabled, because its flag defaults to false).
const FALLBACK_PURPOSES = [
  { key: 'training', labelEn: 'Model training', descriptionEn: 'Fine-tuning and training runs on dedicated VRAM.', icon: 'training', requiresFlag: null, sortOrder: 10 },
  { key: 'inference', labelEn: 'Inference & serving', descriptionEn: 'Low-latency serving for LLMs, vision and embeddings.', icon: 'inference', requiresFlag: null, sortOrder: 20 },
  { key: 'rendering', labelEn: '3D rendering', descriptionEn: 'Blender, Octane and CUDA render jobs.', icon: 'rendering', requiresFlag: null, sortOrder: 30 },
  { key: 'research', labelEn: 'Research & experiments', descriptionEn: 'Notebooks, benchmarks and one-off experiments.', icon: 'research', requiresFlag: null, sortOrder: 40 },
  { key: 'mining', labelEn: 'Mining-friendly', descriptionEn: 'Opt-in hashing with a declared power cap and its own price.', icon: 'mining', requiresFlag: 'mining.allowed', sortOrder: 50 }
];

// ============================================
// PURPOSES
// ============================================

/** The public catalog: every active purpose plus whether it is enabled here. */
const listPurposes = async () => {
  let rows = null;
  try {
    const { data, error } = await client()
      .from(PURPOSES)
      .select('key, label_en, description_en, icon, requires_flag, sort_order, is_active')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) {
      if (!isMissingSchema(error)) console.error('catalog.listPurposes failed:', error.message);
    } else {
      rows = data;
    }
  } catch (error) {
    console.error('catalog.listPurposes threw:', error.message || String(error));
  }

  const catalog = rows && rows.length ? rows.map(camel) : FALLBACK_PURPOSES;
  const gated = catalog.map((p) => p.requiresFlag).filter(Boolean);
  const enabledFlags = await flags.enabledMap(gated);

  return catalog.map((purpose) => ({
    key: purpose.key,
    labelEn: purpose.labelEn,
    descriptionEn: purpose.descriptionEn,
    icon: purpose.icon,
    sortOrder: purpose.sortOrder,
    requiresFlag: purpose.requiresFlag || null,
    enabled: !purpose.requiresFlag || enabledFlags[purpose.requiresFlag] === true
  }));
};

const purposeMap = async () => {
  const catalog = await listPurposes();
  return new Map(catalog.map((p) => [p.key, p]));
};

/** Ownership is checked against the row, never against a client-supplied id. */
const assertOwnership = async (listingId, providerId) => {
  if (!listingId || !providerId) {
    throw new CatalogError('Listing not found', 'not_found', 404);
  }
  const { data, error } = await client()
    .from(LISTINGS)
    .select('id, provider_id, access_methods, price_per_hour, status, is_public')
    .eq('id', listingId)
    .maybeSingle();
  if (error) {
    if (isMissingSchema(error)) throw new CatalogUnavailable();
    throw new Error(`catalog ownership check failed: ${error.message}`);
  }
  // A different provider's listing answers exactly like a missing one, so ids
  // cannot be probed across tenants.
  if (!data || String(data.provider_id).toLowerCase() !== String(providerId).toLowerCase()) {
    throw new CatalogError('Listing not found', 'not_found', 404);
  }
  return data;
};

const sanitizePurposeSpecs = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const specs = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || key.length > 40) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      specs[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    }
  }
  if (JSON.stringify(specs).length > 2000) {
    throw new CatalogError('Purpose specifications are too large', 'specs_too_large');
  }
  return specs;
};

const validateMining = ({ pricePerHour, specs }) => {
  if (!(Number(pricePerHour) > 0)) {
    throw new CatalogError('Mining listings must set their own price per hour', 'mining_price_required');
  }
  const watts = Number(specs.powerCapWatts);
  if (!Number.isInteger(watts) || watts < MINING_MIN_WATTS || watts > MINING_MAX_WATTS) {
    throw new CatalogError(
      `Mining power cap must be a whole number of watts between ${MINING_MIN_WATTS} and ${MINING_MAX_WATTS}`,
      'mining_power_cap_invalid'
    );
  }
  const disclosure = String(specs.disclosure || '').trim();
  if (disclosure.length < MINING_MIN_DISCLOSURE || disclosure.length > MINING_MAX_DISCLOSURE) {
    throw new CatalogError(
      `Mining disclosure must be ${MINING_MIN_DISCLOSURE}-${MINING_MAX_DISCLOSURE} characters`,
      'mining_disclosure_invalid'
    );
  }
  return { ...specs, powerCapWatts: watts, disclosure };
};

/**
 * Replaces the listing's purpose set. Upsert-then-prune: a failed insert can
 * never leave the listing with zero purposes.
 */
const replacePurposes = async ({ listingId, providerId, purposes }) => {
  await assertOwnership(listingId, providerId);
  if (!Array.isArray(purposes)) {
    throw new CatalogError('purposes must be an array', 'invalid_purposes');
  }
  if (purposes.length > 20) {
    throw new CatalogError('Too many purposes', 'invalid_purposes');
  }

  const catalog = await purposeMap();
  const seen = new Set();
  const rows = purposes.map((raw) => {
    const key = String(raw && raw.key ? raw.key : '').trim();
    const purpose = catalog.get(key);
    if (!purpose) throw new CatalogError(`Unknown purpose "${key}"`, 'unknown_purpose');
    if (!purpose.enabled) {
      throw new CatalogError(`Purpose "${key}" is not enabled on this deployment`, 'purpose_disabled', 403);
    }
    if (seen.has(key)) throw new CatalogError(`Duplicate purpose "${key}"`, 'duplicate_purpose');
    seen.add(key);

    const rawPrice = raw.pricePerHour;
    const pricePerHour = rawPrice === undefined || rawPrice === null || rawPrice === ''
      ? null
      : Number(rawPrice);
    if (pricePerHour !== null && (!Number.isFinite(pricePerHour) || pricePerHour < 0)) {
      throw new CatalogError('pricePerHour must be a non-negative number', 'invalid_price');
    }

    let specs = sanitizePurposeSpecs(raw.specs);
    if (key === 'mining') specs = validateMining({ pricePerHour, specs });

    return {
      listing_id: listingId,
      purpose_key: key,
      price_per_hour: pricePerHour,
      specs
    };
  });

  const db = client();
  if (rows.length) {
    const { error } = await db
      .from(LISTING_PURPOSES)
      .upsert(rows, { onConflict: 'listing_id,purpose_key' });
    if (error) {
      if (isMissingSchema(error)) throw new CatalogUnavailable();
      throw new Error(`catalog.replacePurposes failed: ${error.message}`);
    }
  }

  // Prune purposes the provider removed (or every row, when the set is empty).
  const keep = rows.map((row) => row.purpose_key);
  let prune = db.from(LISTING_PURPOSES).delete().eq('listing_id', listingId);
  if (keep.length) {
    prune = prune.not('purpose_key', 'in', `(${keep.map((key) => `"${key}"`).join(',')})`);
  }
  const { error: pruneError } = await prune;
  if (pruneError && !isMissingSchema(pruneError)) {
    throw new Error(`catalog.replacePurposes prune failed: ${pruneError.message}`);
  }

  return getListingCatalog(listingId);
};

/** Purposes + software + access methods for ONE listing (public shape). */
const getListingCatalog = async (listingId) => {
  const empty = { purposes: [], software: [], accessMethods: [] };
  try {
    const [purposeRows, softwareRows, listingRow] = await Promise.all([
      client().from(LISTING_PURPOSES)
        .select('purpose_key, price_per_hour, specs')
        .eq('listing_id', listingId),
      client().from(SOFTWARE)
        .select('id, name, version, category')
        .eq('listing_id', listingId)
        .order('name', { ascending: true }),
      client().from(LISTINGS)
        .select('access_methods')
        .eq('id', listingId)
        .maybeSingle()
    ]);

    if (purposeRows.error || softwareRows.error || listingRow.error) {
      const error = purposeRows.error || softwareRows.error || listingRow.error;
      if (isMissingSchema(error)) return empty;
      throw new Error(`catalog.getListingCatalog failed: ${error.message}`);
    }

    const catalog = await purposeMap();
    const purposes = (purposeRows.data || [])
      .map((row) => {
        const meta = catalog.get(row.purpose_key);
        if (!meta) return null; // purpose was retired from the catalog
        return {
          key: row.purpose_key,
          labelEn: meta.labelEn,
          enabled: meta.enabled,
          pricePerHour: row.price_per_hour === null ? null : Number(row.price_per_hour),
          specs: row.specs || {}
        };
      })
      // A gated purpose disappears entirely while its flag is off — the public
      // payload must not advertise mining when the platform disabled it.
      .filter((purpose) => purpose && purpose.enabled)
      .sort((a, b) => (catalog.get(a.key).sortOrder || 0) - (catalog.get(b.key).sortOrder || 0));

    return {
      purposes,
      software: (softwareRows.data || []).map(camel),
      accessMethods: Array.isArray(listingRow.data?.access_methods) ? listingRow.data.access_methods : []
    };
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    console.error('catalog.getListingCatalog threw:', error.message || String(error));
    return empty;
  }
};

/** Bulk version used by the marketplace: one extra query for every listing. */
const getCatalogForListings = async (listingIds = []) => {
  const result = new Map();
  if (!listingIds.length) return result;

  try {
    const [purposeRows, softwareRows, listingRows] = await Promise.all([
      client().from(LISTING_PURPOSES)
        .select('listing_id, purpose_key, price_per_hour, specs')
        .in('listing_id', listingIds),
      client().from(SOFTWARE)
        .select('id, listing_id, name, version, category')
        .in('listing_id', listingIds)
        .order('name', { ascending: true }),
      client().from(LISTINGS)
        .select('id, access_methods')
        .in('id', listingIds)
    ]);
    const error = purposeRows.error || softwareRows.error || listingRows.error;
    if (error) {
      if (isMissingSchema(error)) return result;
      throw new Error(`catalog.getCatalogForListings failed: ${error.message}`);
    }

    const catalog = await purposeMap();
    for (const id of listingIds) result.set(id, { purposes: [], software: [], accessMethods: [] });

    for (const row of purposeRows.data || []) {
      const meta = catalog.get(row.purpose_key);
      if (!meta || !meta.enabled) continue;
      const entry = result.get(row.listing_id);
      if (!entry) continue;
      entry.purposes.push({
        key: row.purpose_key,
        labelEn: meta.labelEn,
        enabled: meta.enabled,
        pricePerHour: row.price_per_hour === null ? null : Number(row.price_per_hour),
        specs: row.specs || {}
      });
    }
    for (const entry of result.values()) {
      entry.purposes.sort((a, b) => (catalog.get(a.key)?.sortOrder || 0) - (catalog.get(b.key)?.sortOrder || 0));
    }
    for (const row of softwareRows.data || []) {
      const entry = result.get(row.listing_id);
      if (entry) entry.software.push(camel(row));
    }
    for (const row of listingRows.data || []) {
      const entry = result.get(row.id);
      if (entry && Array.isArray(row.access_methods)) entry.accessMethods = row.access_methods;
    }
  } catch (error) {
    console.error('catalog.getCatalogForListings threw:', error.message || String(error));
  }
  return result;
};

// ============================================
// SOFTWARE + ACCESS METHODS (P2-05)
// ============================================

const replaceSoftware = async ({ listingId, providerId, software }) => {
  await assertOwnership(listingId, providerId);
  if (!Array.isArray(software)) throw new CatalogError('software must be an array', 'invalid_software');
  if (software.length > 40) throw new CatalogError('Too many software entries (max 40)', 'invalid_software');

  const seen = new Set();
  const rows = software.map((raw) => {
    const name = String(raw && raw.name ? raw.name : '').trim().slice(0, 80);
    if (!name) throw new CatalogError('Every software entry needs a name', 'invalid_software');
    const key = name.toLowerCase();
    if (seen.has(key)) throw new CatalogError(`Duplicate software "${name}"`, 'duplicate_software');
    seen.add(key);

    const version = raw.version === undefined || raw.version === null || raw.version === ''
      ? null
      : String(raw.version).trim().slice(0, 40);
    const category = SOFTWARE_CATEGORIES.includes(raw.category) ? raw.category : 'other';
    return { listing_id: listingId, name, version, category };
  });

  const db = client();
  const { error: deleteError } = await db.from(SOFTWARE).delete().eq('listing_id', listingId);
  if (deleteError) {
    if (isMissingSchema(deleteError)) throw new CatalogUnavailable();
    throw new Error(`catalog.replaceSoftware failed: ${deleteError.message}`);
  }
  if (rows.length) {
    const { error } = await db.from(SOFTWARE).insert(rows);
    if (error) throw new Error(`catalog.replaceSoftware insert failed: ${error.message}`);
  }
  return getListingCatalog(listingId);
};

const setAccessMethods = async ({ listingId, providerId, methods }) => {
  await assertOwnership(listingId, providerId);
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new CatalogError('At least one access method is required', 'invalid_access_methods');
  }
  const unique = [...new Set(methods.map((m) => String(m).trim().toLowerCase()))];
  const unknown = unique.filter((m) => !ACCESS_METHODS.includes(m));
  if (unknown.length) {
    throw new CatalogError(`Unknown access method(s): ${unknown.join(', ')}`, 'invalid_access_methods');
  }

  const { error } = await client()
    .from(LISTINGS)
    .update({ access_methods: unique, updated_at: new Date().toISOString() })
    .eq('id', listingId);
  if (error) {
    if (isMissingSchema(error)) throw new CatalogUnavailable();
    throw new Error(`catalog.setAccessMethods failed: ${error.message}`);
  }
  return getListingCatalog(listingId);
};

// ============================================
// AVAILABILITY (P2-04)
// ============================================

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

const normalizeWindows = (rows = []) =>
  rows.map((row) => ({
    weekday: Number(row.weekday),
    startMinute: Number(row.start_minute),
    endMinute: Number(row.end_minute)
  }));

const normalizeBlackouts = (rows = []) =>
  rows
    .map((row) => ({
      id: row.id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      reason: row.reason || null
    }))
    .filter((row) => row.startsAt && row.endsAt);

const getAvailabilityRows = async (listingId) => {
  try {
    const [windows, blackouts] = await Promise.all([
      client().from(AVAILABILITY)
        .select('weekday, start_minute, end_minute')
        .eq('listing_id', listingId)
        .order('weekday', { ascending: true })
        .order('start_minute', { ascending: true }),
      client().from(BLACKOUTS)
        .select('id, starts_at, ends_at, reason')
        .eq('listing_id', listingId)
        .gte('ends_at', new Date(Date.now() - MAX_RENTAL_LOOKBACK_MS).toISOString())
        .order('starts_at', { ascending: true })
    ]);
    const error = windows.error || blackouts.error;
    if (error) {
      if (isMissingSchema(error)) return { windows: [], blackouts: [] };
      throw new Error(`catalog.getAvailabilityRows failed: ${error.message}`);
    }
    return {
      windows: normalizeWindows(windows.data),
      blackouts: normalizeBlackouts(blackouts.data)
    };
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    console.error('catalog.getAvailabilityRows threw:', error.message || String(error));
    return { windows: [], blackouts: [] };
  }
};

/**
 * True when [start, end) fits inside the weekly windows and touches no blackout.
 * An empty window set means "always open" (the provider never configured hours).
 */
const isWindowOpen = (windows, blackouts, start, end) => {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false;

  if (blackouts.some((b) => overlaps(startMs, endMs, new Date(b.startsAt).getTime(), new Date(b.endsAt).getTime()))) {
    return false;
  }
  if (!windows.length) return true;

  let cursor = startMs;
  while (cursor < endMs) {
    const date = new Date(cursor);
    const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const segmentEnd = Math.min(endMs, midnight + DAY_MS);
    const fromMinute = Math.floor((cursor - midnight) / 60000);
    const toMinute = Math.ceil((segmentEnd - midnight) / 60000);
    const weekday = new Date(midnight).getUTCDay();

    const covered = windows.some((w) =>
      Number(w.weekday) === weekday && Number(w.startMinute) <= fromMinute && Number(w.endMinute) >= toMinute
    );
    if (!covered) return false;
    cursor = segmentEnd;
  }
  return true;
};

/** Next 15-minute boundary that opens a window, or null when none is found. */
const findNextOpening = (windows, blackouts, from = new Date(), horizonDays = 14) => {
  if (!windows.length && !blackouts.length) return null;
  const step = 15 * 60 * 1000;
  const start = Math.ceil(new Date(from).getTime() / step) * step;
  const horizon = start + horizonDays * DAY_MS;
  for (let t = start; t < horizon; t += step) {
    if (isWindowOpen(windows, blackouts, new Date(t), new Date(t + step))) {
      return new Date(t).toISOString();
    }
  }
  return null;
};

const replaceAvailability = async ({ listingId, providerId, windows }) => {
  await assertOwnership(listingId, providerId);
  if (!Array.isArray(windows)) throw new CatalogError('windows must be an array', 'invalid_windows');
  if (windows.length > 50) throw new CatalogError('Too many availability windows (max 50)', 'invalid_windows');

  const rows = windows.map((raw) => {
    const weekday = Number(raw && raw.weekday);
    const startMinute = Number(raw && raw.startMinute);
    const endMinute = Number(raw && raw.endMinute);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new CatalogError('weekday must be 0 (Sunday) to 6 (Saturday)', 'invalid_windows');
    }
    if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute > 1439) {
      throw new CatalogError('startMinute must be 0-1439', 'invalid_windows');
    }
    if (!Number.isInteger(endMinute) || endMinute < 1 || endMinute > 1440 || endMinute <= startMinute) {
      throw new CatalogError('endMinute must be after startMinute (max 1440)', 'invalid_windows');
    }
    return { listing_id: listingId, weekday, start_minute: startMinute, end_minute: endMinute };
  });

  const db = client();
  const { error: deleteError } = await db.from(AVAILABILITY).delete().eq('listing_id', listingId);
  if (deleteError) {
    if (isMissingSchema(deleteError)) throw new CatalogUnavailable();
    throw new Error(`catalog.replaceAvailability failed: ${deleteError.message}`);
  }
  if (rows.length) {
    const { error } = await db.from(AVAILABILITY).insert(rows);
    if (error) throw new Error(`catalog.replaceAvailability insert failed: ${error.message}`);
  }
  return getAvailabilityRows(listingId);
};

const addBlackout = async ({ listingId, providerId, startsAt, endsAt, reason }) => {
  await assertOwnership(listingId, providerId);
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new CatalogError('endsAt must be after startsAt', 'invalid_blackout');
  }
  if (end - start > 365 * DAY_MS) {
    throw new CatalogError('A blackout cannot exceed 365 days', 'invalid_blackout');
  }
  const cleanReason = reason === undefined || reason === null ? null : String(reason).trim().slice(0, 200);

  const { data, error } = await client()
    .from(BLACKOUTS)
    .insert([{ listing_id: listingId, starts_at: start.toISOString(), ends_at: end.toISOString(), reason: cleanReason }])
    .select('id, starts_at, ends_at, reason')
    .single();
  if (error) {
    if (isMissingSchema(error)) throw new CatalogUnavailable();
    throw new Error(`catalog.addBlackout failed: ${error.message}`);
  }
  return camel(data);
};

const removeBlackout = async ({ listingId, providerId, blackoutId }) => {
  await assertOwnership(listingId, providerId);
  const { data, error } = await client()
    .from(BLACKOUTS)
    .delete()
    .eq('id', blackoutId)
    .eq('listing_id', listingId)
    .select('id');
  if (error) {
    if (isMissingSchema(error)) throw new CatalogUnavailable();
    throw new Error(`catalog.removeBlackout failed: ${error.message}`);
  }
  return Array.isArray(data) && data.length > 0;
};

// ============================================
// CONFLICTS + PUBLIC AVAILABILITY VIEW
// ============================================

const rentalEnd = (row) => {
  if (row.end_time) return new Date(row.end_time).getTime();
  const start = new Date(row.start_time).getTime();
  const minutes = Number(row.planned_duration_minutes);
  if (Number.isFinite(minutes) && minutes > 0) return start + minutes * 60000;
  // Active rental without any end information: assume it still holds the GPU.
  return Math.max(Date.now(), start) + DAY_MS;
};

/** Rentals that would overlap [start, end) on this listing. */
const findConflicts = async ({ listingId, start, end }) => {
  try {
    const { data, error } = await client()
      .from(RENTALS)
      .select('id, status, start_time, end_time, planned_duration_minutes, renter_id')
      .eq('listing_id', listingId)
      .in('status', ['pending', 'active'])
      .lt('start_time', new Date(end).toISOString())
      .gte('start_time', new Date(Date.now() - MAX_RENTAL_LOOKBACK_MS).toISOString());
    if (error) {
      if (isMissingSchema(error)) return [];
      throw new Error(error.message);
    }
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    return (data || []).filter((row) => overlaps(new Date(row.start_time).getTime(), rentalEnd(row), startMs, endMs));
  } catch (error) {
    console.error('catalog.findConflicts threw:', error.message || String(error));
    return [];
  }
};

/**
 * What the renter sees: open now?, the weekly schedule, upcoming blackouts and
 * the windows already taken by other rentals.
 */
const describeAvailability = async (listingId, { hours = 48 } = {}) => {
  const { windows, blackouts } = await getAvailabilityRows(listingId);
  const now = new Date();
  const from = now.toISOString();
  const to = new Date(now.getTime() + Math.min(Math.max(Number(hours) || 48, 1), 24 * 30) * 60 * 60 * 1000).toISOString();

  let rentals = [];
  try {
    const { data, error } = await client()
      .from(RENTALS)
      .select('id, status, start_time, end_time, planned_duration_minutes')
      .eq('listing_id', listingId)
      .in('status', ['pending', 'active'])
      .lt('start_time', to)
      .gte('start_time', new Date(now.getTime() - MAX_RENTAL_LOOKBACK_MS).toISOString());
    if (!error) rentals = data || [];
    else if (!isMissingSchema(error)) throw new Error(error.message);
  } catch (error) {
    console.error('catalog.describeAvailability rentals failed:', error.message || String(error));
  }

  const busy = rentals
    .map((row) => ({ start: row.start_time, end: new Date(rentalEnd(row)).toISOString(), kind: 'rental' }))
    .filter((row) => new Date(row.end).getTime() > now.getTime())
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  const restrictionActive = windows.length > 0 || blackouts.length > 0;
  const openNow = isWindowOpen(windows, blackouts, from, new Date(now.getTime() + 60000).toISOString());

  return {
    restricted: restrictionActive,
    timezone: 'UTC',
    openNow,
    nextOpeningAt: openNow ? null : findNextOpening(windows, blackouts, now),
    windows,
    blackouts,
    busy,
    from,
    to
  };
};

module.exports = {
  ACCESS_METHODS,
  SOFTWARE_CATEGORIES,
  MINING_MIN_WATTS,
  MINING_MAX_WATTS,
  CatalogError,
  CatalogUnavailable,
  listPurposes,
  getListingCatalog,
  getCatalogForListings,
  replacePurposes,
  replaceSoftware,
  setAccessMethods,
  getAvailabilityRows,
  replaceAvailability,
  addBlackout,
  removeBlackout,
  isWindowOpen,
  findNextOpening,
  findConflicts,
  describeAvailability,
  validateMining,
  isMissingSchema
};
