/**
 * Supabase Service Layer - Replaces Mongoose Models
 * Provides a unified interface for all database operations
 */
const { getSupabaseClient } = require('../config/supabase');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { usdToTokens } = require('../utils/pricing');
const catalogService = require('./catalogService');

const SUPABASE_TABLES = {
  profiles: 'profiles',
  gpus: 'gpus',
  devices: 'devices',
  gpu_listings: 'gpu_listings',
  rentals: 'rentals',
  transactions: 'transactions',
  wallets: 'wallets'
};

// Helper: Get service role client for backend operations
const getClient = () => getSupabaseClient(true);

// Helper: Convert snake_case to camelCase
const toCamel = (obj) => {
  if (!obj) return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camelKey] = value;
  }
  return result;
};

// Helper: Convert camelCase to snake_case
const toSnake = (obj) => {
  if (!obj) return obj;
  if (Array.isArray(obj)) return obj.map(toSnake);
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    // Handle consecutive uppercase letters (e.g., ramGB -> ram_gb, not ram_g_b)
    const snakeKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
    result[snakeKey] = value;
  }
  return result;
};

// Helper: Pick only explicitly allowed fields (mass-assignment protection)
const pickAllowed = (obj, allowed) => {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
      out[key] = obj[key];
    }
  }
  return out;
};

// SECURITY: provider-configured remote access (SSH) lives in listing.specs.access.
// It is never part of public list/detail responses — only the owning provider's
// self-service views and the per-rental connection_data row carry it. Mutates a
// listing payload in place so both raw rows and embedded joins are covered.
const stripListingAccess = (listing) => {
  if (!listing || typeof listing !== 'object') return;
  let specs = listing.specs;
  if (typeof specs === 'string') {
    try { specs = JSON.parse(specs); } catch { specs = null; }
  }
  if (!specs || typeof specs !== 'object' || Array.isArray(specs)) return;
  if (!Object.prototype.hasOwnProperty.call(specs, 'access')) return;
  const rest = { ...specs };
  delete rest.access;
  listing.specs = rest;
};

// Builds the per-rental access payload from provider-configured remote access
// details (listing.specs.access = { host, port?, user? }). Written onto the
// RENTAL row's connection_data at start — never on public listing responses.
// Returns null when nothing usable was configured: the client then renders no
// access card content instead of inventing one.
const buildAccessPayload = (listing) => {
  let specs = listing && listing.specs;
  if (typeof specs === 'string') {
    try { specs = JSON.parse(specs); } catch { specs = null; }
  }
  const access = (specs && typeof specs === 'object' && !Array.isArray(specs)) ? specs.access : null;
  if (!access || typeof access !== 'object' || Array.isArray(access)) return null;

  // SECURITY: reject values that cannot safely enter the one-liner — this blob
  // becomes an ssh command the renter copies straight into a terminal.
  const host = String(access.host ?? '').trim();
  const user = String(access.user ?? '').trim();
  if (!/^[A-Za-z0-9._:-]*$/.test(host)) return null;
  if (user && !/^[A-Za-z0-9._\-@]*$/.test(user)) return null;

  let port = parseInt(String(access.port), 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) port = 22;

  if (!host) return null; // a user-only spec would render as a malformed command
  const target = user ? `${user}@${host}` : host;
  return { type: 'ssh', host, port, user: user || null, command: `ssh -p ${port} ${target}` };
};

// Writes the access payload onto a rental row (connection_data). Best-effort by
// design — missing/misconfigured access must never block the session lifecycle.
const attachAccessPayload = async (client, rentalId, listingId) => {
  if (!rentalId || !listingId) return;
  try {
    const { data: row, error } = await client
      .from(SUPABASE_TABLES.gpu_listings)
      .select('specs')
      .eq('id', listingId)
      .maybeSingle();
    if (error) throw error;
    const payload = buildAccessPayload(row);
    if (!payload || !rentalId) return;
    await client
      .from(SUPABASE_TABLES.rentals)
      .update({ connection_data: JSON.stringify(payload), updated_at: new Date().toISOString() })
      .eq('id', rentalId); // no select — a failure here must not break the lifecycle
  } catch (err) {
    if (!isMissingSchemaObject(err)) console.warn('[rentals] access payload skipped:', err && err.message || err);
  }
};

// Allowed client-supplied fields per surface (server-controlled fields like
// id, provider_id, status, is_trusted, device_token, totals are excluded)
const DEVICE_CREATE_FIELDS = [
  'userId', 'name', 'hostname', 'osName', 'osVersion', 'cpuModel', 'cpuCores',
  'ramGb', 'storageGb', 'networkInfo', 'agentVersion',
  'gpuTemperature', 'gpuUtilization', 'vramUsedGb', 'vramTotalGb', 'powerUsageWatts'
];
const DEVICE_UPDATE_FIELDS = [
  'name', 'hostname', 'osName', 'osVersion', 'networkInfo', 'agentVersion', 'autoStartEnabled'
];
const HEARTBEAT_FIELDS = [
  'gpuTemperature', 'gpuUtilization', 'vramUsedGb', 'vramTotalGb', 'powerUsageWatts'
];
// True while an additive migration has not run yet: PostgREST reports the
// missing table/column either with a raw SQL code or as a schema-cache error
// ("Could not find the table/column ... in the schema cache", PGRST204/205).
const isMissingSchemaObject = (error) => {
  if (!error) return false;
  const msg = String(error.message || '');
  return (
    error.code === '42703' ||
    error.code === '42P01' ||
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    msg.includes('schema cache') ||
    msg.includes('does not exist')
  );
};

const LISTING_CREATE_FIELDS = [
  'deviceId', 'gpuId', 'gpuName', 'gpuBrand', 'vramGb', 'cpuModel', 'cpuCores',
  'ramGb', 'storageGb', 'osName', 'pricePerHour', 'pricePerMinute',
  'minRentalMinutes', 'maxRentalHours', 'isPublic',
  'locationCountry', 'locationCity', 'networkSpeedMbps',
  'allowRemoteDesktop', 'allowFileTransfer', 'allowCustomSoftware',
  'description', 'tags',
  // Multi-resource foundations (GPU now / phones later):
  'resourceType', 'specs'
];
const LISTING_UPDATE_FIELDS = [...LISTING_CREATE_FIELDS, 'status'];
const LISTING_PROVIDER_STATUSES = ['active', 'paused', 'maintenance'];

// ============================================
// USER / PROFILE SERVICE
// ============================================
const UserService = {
  async findByEmail(email) {
    const client = getClient();
    try {
      const { data, error } = await client
        .from(SUPABASE_TABLES.profiles)
        .select('*')
        .eq('email', email.toLowerCase().trim())
        .maybeSingle();
      if (error) throw error;
      return data ? toCamel(data) : null;
    } catch (err) {
      console.error('UserService.findByEmail error:', { 
        message: err.message, 
        code: err.code,
        details: err.details,
        hint: err.hint,
        stack: err.stack 
      });
      throw err;
    }
  },

  async findById(id) {
    const client = getClient();
    try {
      const { data, error } = await client
        .from(SUPABASE_TABLES.profiles)
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data ? toCamel(data) : null;
    } catch (err) {
      console.error('UserService.findById error:', { 
        message: err.message, 
        code: err.code,
        details: err.details,
        hint: err.hint 
      });
      throw err;
    }
  },

  async create({ email, password, fullName, role = 'renter' }) {
    const client = getClient();
    const passwordHash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    const record = {
      id: crypto.randomUUID(),
      email: email.toLowerCase().trim(),
      full_name: fullName,
      role,
      password_hash: passwordHash,
      is_active: true,
      is_verified: false,
      created_at: new Date().toISOString()
    };
    const { data, error } = await client
      .from(SUPABASE_TABLES.profiles)
      .insert([record])
      .select()
      .single();
    if (error) throw error;
    return toCamel(data);
  },

  async update(id, updates) {
    const client = getClient();
    const snakeUpdates = toSnake(updates);
    const { data, error } = await client
      .from(SUPABASE_TABLES.profiles)
      .update(snakeUpdates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return toCamel(data);
  },

  async comparePassword(user, candidatePassword) {
    const hash = user.passwordHash || user.password_hash;
    if (!hash) return false;
    return bcrypt.compare(candidatePassword, hash);
  },

  async updateLastLogin(id) {
    return await this.update(id, { lastLoginAt: new Date().toISOString() });
  },

  // Password updates go through bcrypt to password_hash — the generic update()
  // maps to a non-existent `password` column, so this method exists on purpose.
  async updatePassword(id, newPassword) {
    const client = getClient();
    const passwordHash = await bcrypt.hash(newPassword, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    const { data, error } = await client
      .from(SUPABASE_TABLES.profiles)
      .update({ password_hash: passwordHash })
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  },

  async markVerified(id) {
    const client = getClient();
    const { data, error } = await client
      .from(SUPABASE_TABLES.profiles)
      .update({ is_verified: true })
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }
};

// ============================================
// GPU SERVICE
// ============================================
const GpuService = {
  async findAll({ isActive = true } = {}) {
    const client = getClient();
    let query = client.from(SUPABASE_TABLES.gpus).select('*');
    if (isActive !== undefined) query = query.eq('is_active', isActive);
    const { data, error } = await query.order('name');
    if (error) throw error;
    return toCamel(data || []);
  },

  async findById(id) {
    const client = getClient();
    const { data, error } = await client
      .from(SUPABASE_TABLES.gpus)
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data ? toCamel(data) : null;
  },

  async create(gpuData) {
    const client = getClient();
    const record = { ...toSnake(gpuData), id: crypto.randomUUID() };
    const { data, error } = await client
      .from(SUPABASE_TABLES.gpus)
      .insert([record])
      .select()
      .single();
    if (error) throw error;
    return toCamel(data);
  }
};

// ============================================
// DEVICE SERVICE
// ============================================
const DeviceService = {
  async findByUserId(userId) {
    const client = getClient();
    const { data, error } = await client
      .from(SUPABASE_TABLES.devices)
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return toCamel(data || []);
  },

  async findById(id) {
    const client = getClient();
    const { data, error } = await client
      .from(SUPABASE_TABLES.devices)
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data ? toCamel(data) : null;
  },

  async create(deviceData) {
    const client = getClient();
    // Whitelist: clients cannot set status, is_trusted, device_token, heartbeats, etc.
    const record = {
      ...toSnake(pickAllowed(deviceData, DEVICE_CREATE_FIELDS)),
      id: crypto.randomUUID()
    };
    const { data, error } = await client
      .from(SUPABASE_TABLES.devices)
      .insert([record])
      .select()
      .single();
    if (error) throw error;
    return toCamel(data);
  },

  async update(id, updates, userId) {
    const client = getClient();
    const snakeUpdates = toSnake(pickAllowed(updates, DEVICE_UPDATE_FIELDS));
    snakeUpdates.updated_at = new Date().toISOString();
    const { data, error } = await client
      .from(SUPABASE_TABLES.devices)
      .update(snakeUpdates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw error;
    return toCamel(data);
  },

  async updateHeartbeat(id, stats) {
    const client = getClient();
    const updates = {
      // Server-controlled fields come LAST so client stats can never override them
      ...toSnake(pickAllowed(stats, HEARTBEAT_FIELDS)),
      last_heartbeat_at: new Date().toISOString(),
      status: 'online'
    };
    const { data, error } = await client
      .from(SUPABASE_TABLES.devices)
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return toCamel(data);
  }
};

// ============================================
// GPU LISTING SERVICE
// ============================================
const GpuListingService = {
  async findAll(filters = {}, options = {}) {
    const client = getClient();
    // Purpose filtering happens in PostgREST (inner join) so pagination stays
    // correct. When migration 012 is absent the join errors: we retry without
    // it and report catalogAvailable=false instead of returning a misleading
    // "no listings" page.
    const purpose = filters.purpose ? String(filters.purpose).trim() : '';
    let catalogAvailable = true;

    const runQuery = (withPurpose) => {
      let q = client
        .from(SUPABASE_TABLES.gpu_listings)
        .select(withPurpose ? '*, listing_purposes!inner(purpose_key)' : '*', { count: 'exact' });

      if (withPurpose) q = q.eq('listing_purposes.purpose_key', purpose);
      if (filters.status) q = q.eq('status', filters.status);
      if (filters.isPublic !== undefined) q = q.eq('is_public', filters.isPublic);
      if (filters.providerId) q = q.eq('provider_id', filters.providerId);
      if (filters.gpuBrand) q = q.eq('gpu_brand', filters.gpuBrand);
      if (filters.minVram) {
        const minVram = Number.parseInt(filters.minVram, 10);
        if (Number.isFinite(minVram)) q = q.gte('vram_gb', minVram); // `?minVram=abc` must not become a 500
      }
      if (filters.maxPrice) {
        const maxPrice = Number.parseFloat(filters.maxPrice);
        if (Number.isFinite(maxPrice)) q = q.lte('price_per_hour', maxPrice);
      }
      if (filters.search) {
        // SECURITY: strip PostgREST filter metacharacters (,, (), ', %) and cap length
        const safeSearch = String(filters.search)
          .replace(/[%,()\\'"]/g, ' ')
          .trim()
          .slice(0, 100);
        if (safeSearch) {
          // Quoted per PostgREST rules: an unquoted value lets '.', '*' or ':' alter the filter.
          q = q.or(`gpu_name.ilike."%${safeSearch}%",gpu_brand.ilike."%${safeSearch}%",cpu_model.ilike."%${safeSearch}%",description.ilike."%${safeSearch}%"`);
        }
      }

      // Sorting
      const sortMap = {
        price_asc: { column: 'price_per_hour', ascending: true },
        price_desc: { column: 'price_per_hour', ascending: false },
        rating: { column: 'average_rating', ascending: false },
        rentals: { column: 'total_rentals', ascending: false }
      };
      const sort = sortMap[options.sortBy] || sortMap.price_asc;
      q = q.order(sort.column, { ascending: sort.ascending });

      // Pagination
      const page = Math.max(parseInt(options.page, 10) || 1, 1);
      const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 200);
      return q.range((page - 1) * limit, page * limit - 1);
    };

    let { data, error, count } = await runQuery(Boolean(purpose));
    if (error && purpose && isMissingSchemaObject(error)) {
      catalogAvailable = false;
      ({ data, error, count } = await runQuery(false));
    }
    if (error) throw error;

    // SECURITY by default: listing responses scrub the provider's remote-access
    // config. includeAccess opts in for ONE surface only — the owning
    // provider's self-service list (edit round-trip of their own values).
    const listings = toCamel(data || []);
    if (!options || !options.includeAccess) {
      for (const listing of listings) stripListingAccess(listing);
    }

    // Attach purposes / software / access methods in one extra round trip.
    if (catalogAvailable && listings.length) {
      try {
        const catalog = await catalogService.getCatalogForListings(listings.map((l) => l.id));
        for (const listing of listings) {
          const extra = catalog.get(listing.id);
          if (!extra) continue;
          listing.purposes = extra.purposes;
          listing.software = extra.software;
          listing.accessMethods = extra.accessMethods;
        }
      } catch (catalogError) {
        console.error('Listings: catalog attach skipped:', catalogError.message || String(catalogError));
      }
    }

    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 200);
    return {
      listings,
      catalogAvailable,
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    };
  },

  async findById(id, viewer = null, { publicOnly = false } = {}) {
    const client = getClient();
    let query = client
      .from(SUPABASE_TABLES.gpu_listings)
      .select('*')
      .eq('id', id);

    // Public detail must use the same visibility rule as the public list:
    // hidden/paused rows are not addressable just because their uuid leaked.
    if (publicOnly) {
      query = query.eq('is_public', true).eq('status', 'active');
    }

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    const listing = data ? toCamel(data) : null;
    // Owner-aware access: the owning provider may read their own remote-access
    // config back (edit round-trip); everyone else gets it scrubbed.
    const isOwnerViewer = !!(
      viewer &&
      viewer.id && data &&
      String(viewer.id).toLowerCase() === String(data.provider_id || '').toLowerCase() &&
      ['provider', 'admin'].includes(viewer.role)
    );
    if (listing && !isOwnerViewer) stripListingAccess(listing);

    // Purposes / software / access methods are public-safe (the provider's
    // credentials stay under specs.access, which was just scrubbed above).
    if (listing) {
      try {
        const catalog = await catalogService.getListingCatalog(listing.id);
        listing.purposes = catalog.purposes;
        listing.software = catalog.software;
        listing.accessMethods = catalog.accessMethods;
      } catch (catalogError) {
        console.error('Listing detail: catalog attach skipped:', catalogError.message || String(catalogError));
      }
    }
    return listing;
  },

  async create(listingData, providerId) {
    const client = getClient();
    // Whitelist: provider cannot set own id, ratings, totals, revenue, status
    const record = {
      ...toSnake(pickAllowed(listingData, LISTING_CREATE_FIELDS)),
      id: crypto.randomUUID(),
      provider_id: providerId
    };
    // Derived token price — always computed server-side from the USD price
    // (clients can never set tokensPerHour: it is not whitelisted).
    if (record.price_per_hour !== undefined) {
      record.tokens_per_hour = usdToTokens(record.price_per_hour);
    }
    let { data, error } = await client
      .from(SUPABASE_TABLES.gpu_listings)
      .insert([record])
      .select()
      .single();
    // Graceful fallback while the additive migration is pending
    // (42703 = column does not exist yet).
    if (isMissingSchemaObject(error)) {
      delete record.resource_type;
      delete record.specs;
      delete record.tokens_per_hour;
      ({ data, error } = await client
        .from(SUPABASE_TABLES.gpu_listings)
        .insert([record])
        .select()
        .single());
    }
    if (error) throw error;
    return toCamel(data);
  },

  async update(id, updates, providerId) {
    const client = getClient();
    const allowed = pickAllowed(updates, LISTING_UPDATE_FIELDS);
    // Providers may only toggle availability states — never force 'rented'/'offline'
    if (allowed.status !== undefined && !LISTING_PROVIDER_STATUSES.includes(allowed.status)) {
      delete allowed.status;
    }
    const snakeUpdates = toSnake(allowed);
    // Keep the derived token price in sync whenever the USD price changes
    if (snakeUpdates.price_per_hour !== undefined) {
      snakeUpdates.tokens_per_hour = usdToTokens(snakeUpdates.price_per_hour);
    }
    snakeUpdates.updated_at = new Date().toISOString();
    let { data, error } = await client
      .from(SUPABASE_TABLES.gpu_listings)
      .update(snakeUpdates)
      .eq('id', id)
      .eq('provider_id', providerId)
      .select()
      .maybeSingle();
    if (isMissingSchemaObject(error)) {
      delete snakeUpdates.resource_type;
      delete snakeUpdates.specs;
      delete snakeUpdates.tokens_per_hour;
      ({ data, error } = await client
        .from(SUPABASE_TABLES.gpu_listings)
        .update(snakeUpdates)
        .eq('id', id)
        .eq('provider_id', providerId)
        .select()
        .maybeSingle());
    }
    if (error) throw error;
    // No row matched the (id, provider_id) pair: a different provider's id or
    // a stale id. Return null so the route can answer 404 instead of throwing
    // PGRST116 and leaking a 500.
    return data ? toCamel(data) : null;
  },

  async updateStatus(id, status, providerId) {
    const client = getClient();
    const { data, error } = await client
      .from(SUPABASE_TABLES.gpu_listings)
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('provider_id', providerId)
      .select()
      .single();
    if (error) throw error;
    return toCamel(data);
  },

  async delete(id, providerId) {
    const client = getClient();
    // .select('id') makes PostgREST return the deleted row(s); an empty result
    // means the id did not belong to this provider (or no longer exists).
    const { data, error } = await client
      .from(SUPABASE_TABLES.gpu_listings)
      .delete()
      .eq('id', id)
      .eq('provider_id', providerId)
      .select('id');
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  }
};

// ============================================
// LISTING RECOVERY (peer-review fix)
// ============================================
// Heals listings stuck in 'rented' with no active rental holding them — a
// crash between settlement steps used to leave them that way forever (the
// enforcer only scans rentals, never listings). Called by every sweep.
const healStuckListings = async (limit = 100) => {
  const client = getClient();
  const { data: rented, error } = await client
    .from(SUPABASE_TABLES.gpu_listings)
    .select('id')
    .eq('status', 'rented')
    .limit(limit);
  if (error) throw error;

  let healed = 0;
  for (const listing of rented || []) {
    const { count, error: countError } = await client
      .from(SUPABASE_TABLES.rentals)
      .select('id', { count: 'exact', head: true })
      .eq('listing_id', listing.id)
      .in('status', ['active', 'connecting']);
    if (countError) continue;
    if (!count) {
      const { error: updateError } = await client
        .from(SUPABASE_TABLES.gpu_listings)
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('id', listing.id)
        .eq('status', 'rented');
      if (!updateError) healed += 1;
    }
  }
  if (healed > 0) console.log(`[enforcer] healed ${healed} stuck 'rented' listing(s)`);
  return healed;
};

// ============================================
// RENTAL SERVICE
// ============================================
// Escrow prepay at start: charge the full quote now, refund unused at settle.
// The funding row is the marker settlement looks for, so a legacy in-flight
// rental (started before this shipped) still settles through the old path.
async function fundRentalEscrow(rentalRow) {
  const renterId = rentalRow.renter_id || rentalRow.renterId;
  const rentalId = rentalRow.id;
  const plannedMinutes = Math.max(
    1,
    Number(rentalRow.planned_duration_minutes ?? rentalRow.plannedDurationMinutes) || 0
  );
  const estimate = Math.round(
    Math.max(0, Number(rentalRow.estimated_cost ?? rentalRow.estimatedCost) || 0) * 1000
  ) / 1000;
  if (!(estimate > 0)) return 0;

  const wallet = await WalletService.getOrCreate(renterId);
  const available = Math.max(0, Number(wallet.balance) || 0);
  if (Math.round(available * 1000) < Math.round(estimate * 1000)) {
    throw Object.assign(
      new Error(
        `Insufficient wallet balance to start this rental. Required $${estimate.toFixed(2)} but only $${available.toFixed(2)} available.`
      ),
      { code: 'WALLET_INSUFFICIENT', required: estimate, available }
    );
  }

  // Claim first, move money second — the same rule the settlement steps use.
  // If the process dies after the claim, the row stays pending instead of the
  // debit happening silently; settlement then sees the rental as prepaid and
  // can never charge the renter a second time for the same session.
  const claim = await TransactionService.create(
    {
      type: 'rental_charge',
      status: 'pending',
      amount: estimate,
      relatedId: rentalId,
      description: `Session escrow hold (refundable) — ${plannedMinutes} min`
    },
    renterId
  );
  try {
    await WalletService.adjustBalance(renterId, -estimate, false);
    await TransactionService.updateStatus(claim.id, 'completed', renterId);
  } catch (debitError) {
    // Nothing moved: leave a failed claim so the next attempt is not blocked.
    try { await TransactionService.updateStatus(claim.id, 'failed', renterId); } catch { /* claim stays pending -> flagged for review */ }
    throw debitError;
  }
  return estimate;
}

// Ledger truth for one rental: which settlement steps already left a row.
// Settlement is multi-step (refund + provider credit + compensation), so every
// step must be skippable on retry — otherwise a crash between two steps either
// pays the provider twice or never pays them. A row in ANY status counts as
// claimed: the claim is written BEFORE the money moves, so a repeated pass can
// never move it twice. Pending claims are surfaced for manual review.
//
// A ledger read failure THROWS on purpose: treating "could not read" as "this
// rental was never prepaid" would take the legacy path and bill the renter a
// second time. Settlement is retried by the enforcer, which is free.
async function listSettlementRows(rentalId) {
  const client = getClient();
  const rows = { escrow: false, escrowAmount: 0, refund: false, earning: false, comp: false, pending: [] };
  const { data, error } = await client
    .from(SUPABASE_TABLES.transactions)
    .select('type,status,amount,description')
    .eq('related_id', rentalId);
  if (error) throw error;
  for (const row of data || []) {
    const description = String(row.description || '');
    const step = description.startsWith('Session escrow hold') ? 'escrow'
      : description.startsWith('Unused session time refunded') ? 'refund'
        : description.startsWith('Rental earnings') ? 'earning'
          : description.startsWith('Goodwill credit') ? 'comp'
            : null;
    if (!step) continue;
    // A failed/cancelled claim never moved money: it must not block a retry.
    if (row.status === 'failed' || row.status === 'cancelled') continue;
    rows[step] = true;
    if (step === 'escrow') {
      rows.escrowAmount = Math.max(rows.escrowAmount, Number(row.amount) || 0);
    }
    if (row.status === 'pending') rows.pending.push(step);
  }
  return rows;
}

// One settlement per rental per process: the enforcer, the request handler and
// a manual repair can all arrive at once. Chained promises keep them in order.
const settlementLocks = new Map();
function withSettlementLock(key, task) {
  const previous = settlementLocks.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tracked = run.catch(() => {});
  settlementLocks.set(key, tracked);
  tracked.then(() => {
    if (settlementLocks.get(key) === tracked) settlementLocks.delete(key);
  });
  return run;
}

// Write the claim row BEFORE the balance moves: if the process dies mid-step
// the row is still there, so no later pass repeats the transfer.
//
// The in-process lock only covers one API instance. The settlement_claims
// table (primary key rental_id + step) is the cross-process claim: the INSERT
// is the atomic test-and-set, so two Render instances (or a second worker)
// racing the same repair cannot both pay. Returns null when someone else owns
// the step — callers must skip the money move entirely.
async function claimSettlementStep({ rentalId, userId, type, description, amount, step }) {
  const client = getClient();
  if (step) {
    const { error } = await client
      .from('settlement_claims')
      .insert([{ rental_id: rentalId, step, amount: Number.isFinite(Number(amount)) ? Number(amount) : null }]);
    if (error) {
      if (error.code === '23505') return null; // already claimed by another process
      // Deployment without the table (older database): fall back to the row-based
      // guard instead of failing the settlement.
      if (error.code !== '42P01' && !/does not exist/i.test(error.message || '')) throw error;
    }
  }
  return TransactionService.create(
    { type, status: 'pending', amount, relatedId: rentalId, description },
    userId
  );
}

// A retryable failure (the wallet lost a CAS race) released its claim: no money
// moved, so the next pass may take the step again.
async function releaseSettlementClaim(rentalId, step) {
  if (!step) return;
  try {
    await getClient().from('settlement_claims').delete().eq('rental_id', rentalId).eq('step', step);
  } catch (error) {
    console.error(`[settlement] could not release claim ${rentalId}/${step}:`, error.message);
  }
}

async function completeSettlementStep(claim, userId) {
  try {
    await TransactionService.updateStatus(claim.id, 'completed', userId);
  } catch (error) {
    // The money moved; the row stays pending and is reported for review.
    console.error(`[settlement] could not mark ${claim.id} completed:`, error.message);
  }
}

// One money step, at most once across every API instance: claim atomically,
// then move, then mark the claim completed. Errors that prove nothing moved
// (the wallet lost a CAS race, the compensation RPC refused) release the claim
// so the next sweep can retry — everything else stays claimed for review.
async function settleStep({ rentalId, step, userId, type, description, amount, move }) {
  const claim = await claimSettlementStep({ rentalId, step, userId, type, description, amount });
  if (!claim) return false;
  try {
    await move();
  } catch (error) {
    const retryable = Boolean(error) && (error.code === 'WALLET_BUSY' || error.retryable === true);
    if (retryable) {
      await releaseSettlementClaim(rentalId, step);
      try {
        await TransactionService.updateStatus(claim.id, 'failed', userId);
      } catch (statusError) {
        console.error(`[settlement] could not mark ${claim.id} failed:`, statusError.message);
      }
    }
    throw error;
  }
  await completeSettlementStep(claim, userId);
  return true;
}

const RentalService = {
  async findAll(userId, userRole, filters = {}, options = {}) {
    const client = getClient();
    let query = client
      .from(SUPABASE_TABLES.rentals)
      .select(`
        *,
        gpu_listings!listing_id (gpu_name, gpu_brand, price_per_hour),
        provider:profiles!provider_id (full_name),
        renter:profiles!renter_id (full_name)
      `, { count: 'exact' });

    // Role-based filtering
    if (userRole === 'renter') query = query.eq('renter_id', userId);
    else if (userRole === 'provider') query = query.eq('provider_id', userId);

    if (filters.status) query = query.eq('status', filters.status);

    // Pagination
    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 200);
    query = query.order('start_time', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    return {
      rentals: toCamel(data || []),
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    };
  },

  async findById(id) {
    const client = getClient();
    const { data, error } = await client
      .from(SUPABASE_TABLES.rentals)
      .select(`
        *,
        gpu_listings!listing_id (*),
        provider:profiles!provider_id (full_name, email),
        renter:profiles!renter_id (full_name, email)
      `)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    const rental = data ? toCamel(data) : null;
    // The full listing embed (*) includes the provider's SSH config — the
    // per-rental connection_data row is the only API surface meant to carry it.
    if (rental && rental.gpuListings) stripListingAccess(rental.gpuListings);
    return rental;
  },

  async create(rentalData, renterId) {
    const client = getClient();
    const record = {
      ...toSnake(rentalData),
      id: crypto.randomUUID(),
      renter_id: renterId,
      start_time: new Date().toISOString(),
      status: 'pending'
    };
    let { data, error } = await client
      .from(SUPABASE_TABLES.rentals)
      .insert([record])
      .select()
      .single();
    // Graceful fallback while the additive billing migration is pending
    if (isMissingSchemaObject(error)) {
      delete record.billing_mode;
      delete record.estimated_cost_tokens;
      delete record.purpose;
      ({ data, error } = await client
        .from(SUPABASE_TABLES.rentals)
        .insert([record])
        .select()
        .single());
    }
    if (error) throw error;
    return toCamel(data);
  },

  async startRental(id, renterId) {
    const client = getClient();

    // Balance gate (see docs/pricing-model.md, "start-time balance gate"):
    // a paid pending rental may not start
    // unless the renter's wallet already covers the full quote. The check runs
    // BEFORE any state change — listing and rental stay untouched on failure,
    // so there is nothing to roll back. Settlement remains the last line of
    // defense (final cost capped at estimate, charge capped at balance).
    const pendingRental = await this.findById(id);
    if (pendingRental && pendingRental.isFree !== true) {
      // Wallet source of truth is the rental ROW's renter — an admin who starts
      // on behalf of a renter still triggers the same gate.
      let requiredCost = Math.max(0, Number(pendingRental.estimatedCost) || 0);
      if (!(requiredCost > 0)) {
        // Estimate missing on legacy rows: re-quote from the live listing price
        const listing = await GpuListingService.findById(pendingRental.listingId, null);
        const pricePerHour = Number(listing?.pricePerHour) || 0;
        const minutes = Math.max(1, Number(pendingRental.plannedDurationMinutes) || 60);
        requiredCost = Math.round((minutes / 60) * pricePerHour * 100) / 100;
      }
      if (requiredCost > 0) {
        const wallet = await WalletService.getOrCreate(pendingRental.renterId);
        const available = Math.max(0, Number(wallet.balance) || 0);
        // Cents-precision comparison: the quote is stored rounded to milliunits
        if (Math.round(available * 1000) < Math.round(requiredCost * 1000)) {
          throw Object.assign(new Error(
            `Insufficient wallet balance to start this rental. Required $${requiredCost.toFixed(2)} but only $${available.toFixed(2)} available.`
          ), { code: 'WALLET_INSUFFICIENT', required: requiredCost, available });
        }
      }
    }

    // Atomic: claim rental and update listing status
    const { data: rental, error: rentalError } = await client
      .from(SUPABASE_TABLES.rentals)
      .update({
        status: 'active',
        start_time: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('status', 'pending')
      .eq('renter_id', renterId)
      .select()
      .single();

    if (rentalError || !rental) throw rentalError || new Error('Rental cannot be started');

    // Claim the listing: the 'active' -> 'rented' flip MUST affect a row.
    // A silent 0-row update would let a second pending rental start while
    // another session already holds the GPU (double booking).
    const { data: claimed, error: listingError } = await client
      .from(SUPABASE_TABLES.gpu_listings)
      .update({ status: 'rented', updated_at: new Date().toISOString() })
      .eq('id', rental.listing_id)
      .eq('status', 'active')
      .select('id');

    if (listingError || !claimed || claimed.length === 0) {
      // Rollback rental — the slot is taken (stale pending rentals are
      // cancelled later by the enforcer)
      await client
        .from(SUPABASE_TABLES.rentals)
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', id);
      throw listingError || new Error('Listing is not available (already rented)');
    }

    // Hard deadline for the enforcer: planned duration from the start moment
    const plannedMinutes = Number(rental.planned_duration_minutes);
    if (Number.isFinite(plannedMinutes) && plannedMinutes > 0) {
      await client
        .from(SUPABASE_TABLES.rentals)
        .update({
          expires_at: new Date(Date.now() + plannedMinutes * 60000).toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', id);
    }

    // Prepay (escrow): the renter's wallet is charged the full quote BEFORE
    // the machine is handed over. Settlement refunds whatever was not used.
    // On failure the claim is undone so the renter can top up and retry.
    try {
      await fundRentalEscrow(rental);
    } catch (fundError) {
      await client
        .from(SUPABASE_TABLES.gpu_listings)
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('id', rental.listing_id)
        .eq('status', 'rented');
      await client
        .from(SUPABASE_TABLES.rentals)
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', id);
      throw fundError;
    }

    // Best-effort: publish provider-configured remote access for THIS rental.
    // Never blocks the start (see attachAccessPayload — it swallows its own
    // errors and degrades when a schema object is still missing). Skipped when
    // the row already carries a payload from an earlier attempt.
    const started = await this.findById(id);
    if (!started) return toCamel(rental);
    if (started.connectionData == null) {
      await attachAccessPayload(client, id, started.listingId ?? rental.listing_id);
      // Re-read so the response already carries the fresh connection payload.
      const withAccess = await this.findById(id);
      return withAccess || started;
    }
    return started;
  },

  async endRental(id, userId, userRole, endReason = 'renter_ended') {
    const rental = await this.findById(id);
    if (!rental) throw new Error('Rental not found');

    const canManage = userRole === 'admin' || rental.renterId === userId || rental.providerId === userId;
    if (!canManage) throw new Error('Not authorized');

    if (rental.status !== 'active') throw new Error('Rental is not active');

    // A provider may only end a session for a declared reason — never
    // "completed". The route validates the reason; settlement compensates.
    return this.settleRental(id, endReason);
  },

  // ============================================
  // SETTLEMENT (single source of truth for money)
  // ============================================
  // Rules (docs/pricing-model.md):
  //   - the renter is charged the full quote at start (escrow) and refunded
  //     whatever the session did not use
  //   - billable minutes are floored at the listing minimum and capped at
  //     the planned duration the renter was quoted (never pay more than
  //     the estimate)
  //   - the provider earns 100% of the actual amount (0% commission)
  //   - a provider that ends a session early owes the renter a goodwill
  //     credit (10% interactive / 2x remaining for batch work), capped by
  //     the provider's own balance
  // Idempotent: the 'active' -> 'ended' flip is a conditional update, so a
  // manual end racing the enforcer settles exactly once.
  async settleRental(id, endReason = 'renter_ended') {
    // One settlement path for every caller (renter end, provider end,
    // enforcer expiry, heartbeat loss, repair pass). Serialised per rental so
    // two callers can never move the same money twice.
    return withSettlementLock(id, () => this.settleRentalFunded(id, endReason));
  },

  // Escrow-aware settlement. Every money step is individually guarded, the
  // listing release ALWAYS runs, and a failed money step is recorded as a
  // pending row for manual review (no silent losses, no stuck listings).
  async settleRentalFunded(id, endReason = 'renter_ended') {
    const client = getClient();
    const rental = await this.findById(id);
    if (!rental) return rental;

    // Crash recovery: a rental that already flipped to 'ended' can still be
    // missing money rows (the process died between steps). Resume only when a
    // gap is provable; every step below skips itself when its row exists.
    const settled = await listSettlementRows(id);
    if (settled.pending.length) {
      console.warn(
        `[settlement] rental ${id} has pending claims (${settled.pending.join(', ')}) — they block a repeat transfer and need manual review`
      );
    }
    const resuming = rental.status !== 'active';
    if (resuming) {
      const moneyGap = settled.escrow && (!settled.earning || !settled.refund);
      if (!moneyGap) return rental;
    }

    const endTime = resuming && rental.endTime ? new Date(rental.endTime) : new Date();
    const startTime = new Date(rental.startTime);
    const elapsedMinutes = Math.max(1, Math.ceil((endTime - startTime) / (1000 * 60)));

    const listing = await GpuListingService.findById(rental.listingId);

    let finalCost = 0;
    let billableMinutes = 0;
    let pricePerHour = 0;
    let minMinutes = 1;
    let planned = 1;
    if (rental.isFree !== true) {
      minMinutes = Math.max(1, Number(listing?.minRentalMinutes) || 1);
      planned = Math.max(1, Number(rental.plannedDurationMinutes) || minMinutes);
      // The agreed rate is the one the renter was QUOTED, not the listing's base
      // price: a purpose-priced listing (e.g. training at a different rate) must
      // settle at that rate. The quote is frozen on the rental as estimated_cost,
      // so the rate is reconstructed from it — reading the live listing price
      // here would pay a provider more than the renter was ever charged.
      const quoted = Number(rental.estimatedCost) || 0;
      const plannedHours = planned / 60;
      pricePerHour = quoted > 0
        ? quoted / plannedHours
        : Number(listing?.pricePerHour) || 0;
      if (resuming) {
        // The session's own numbers are already frozen on the rental row.
        finalCost = Math.max(0, Number(rental.actualCost) || 0);
        billableMinutes = Math.max(1, Number(rental.actualDurationMinutes) || minMinutes);
      } else {
        billableMinutes = Math.min(Math.max(elapsedMinutes, minMinutes), planned);
        finalCost = Math.round((billableMinutes / 60) * pricePerHour * 1000) / 1000;
      }
    }

    // Was this session prepaid at start? The funding row is written by
    // fundRentalEscrow(); its absence means a legacy (pre-escrow) rental.
    const prepaid = settled.escrowAmount;

    // Never pay out more than was collected: a purpose-priced or edited listing
    // must not turn settlement into money creation.
    if (prepaid > 0 && finalCost > prepaid) {
      console.warn(`[settlement] rental ${id}: computed $${finalCost} > escrow $${prepaid} — capped at the escrow amount`);
      finalCost = prepaid;
      billableMinutes = Math.min(billableMinutes, planned);
    }

    // Atomic close: only one caller wins the 'active' -> 'ended' flip.
    // A resume never flips — the row is already closed.
    if (!resuming) {
      const { data: flip, error: flipError } = await client
        .from(SUPABASE_TABLES.rentals)
        .update({
          status: 'ended',
          end_time: endTime.toISOString(),
          actual_duration_minutes: elapsedMinutes,
          actual_cost: finalCost,
          cost_so_far: finalCost,
          end_reason: endReason,
          updated_at: endTime.toISOString()
        })
        .eq('id', id)
        .eq('status', 'active')
        .select('id');
      if (flipError) throw flipError;
      if (!flip || flip.length === 0) return this.findById(id); // already settled
    }

    let moneyError = null;
    // Ledger truth-tracker: which side actually moved — so the audit trail
    // below can never re-bill money that already left the renter's wallet
    let renterCharged = false;
    let providerOwedAmount = 0; // what the provider is owed (0% commission: the whole amount)
    let providerCredited = false;
    try {
      if (prepaid > 0) {
        // ── Escrow path: money was taken at start ─────────────────────
        const refund = Math.round(Math.max(0, prepaid - finalCost) * 1000) / 1000;
        if (refund > 0 && !settled.refund) {
          await settleStep({
            rentalId: id,
            step: 'refund',
            userId: rental.renterId,
            type: 'refund',
            amount: refund,
            description: `Unused session time refunded (${billableMinutes} min billed of ${planned} planned)`,
            move: () => WalletService.adjustBalance(rental.renterId, refund, false)
          });
        }

        // 0% platform commission: the provider keeps the whole amount.
        providerOwedAmount = finalCost;
        if (finalCost > 0 && rental.providerId && !settled.earning) {
          await settleStep({
            rentalId: id,
            step: 'earning',
            userId: rental.providerId,
            type: 'provider_earning',
            amount: finalCost,
            description: `Rental earnings (${billableMinutes} min, 0% platform commission)`,
            move: () => WalletService.adjustBalance(rental.providerId, finalCost, true)
          });
          providerCredited = true;
        }
      } else if (finalCost > 0 && !resuming) {
        // ── Legacy path: rental started before escrow shipped ─────────
        const renterWallet = await WalletService.getOrCreate(rental.renterId);
        const available = Math.max(0, Number(renterWallet.balance) || 0);
        const charged = Math.round(Math.min(finalCost, available) * 1000) / 1000;
        const unpaid = Math.round((finalCost - charged) * 1000) / 1000;

        if (charged > 0) {
          await WalletService.adjustBalance(rental.renterId, -charged, false);
          renterCharged = true; // remember BEFORE any ledger row can fail
          await TransactionService.create({
            type: 'rental_charge',
            status: 'completed',
            amount: charged,
            relatedId: id,
            description: `Rental charge (${elapsedMinutes} min session, billed ${billableMinutes} min)`
          }, rental.renterId);
        }
        if (unpaid > 0) {
          await TransactionService.create({
            type: 'rental_charge',
            status: 'pending',
            amount: unpaid,
            relatedId: id,
            description: 'Unpaid rental remainder (top up your wallet)'
          }, rental.renterId);
        }

        if (charged > 0 && rental.providerId && !settled.earning) {
          providerOwedAmount = charged; // 0% commission: provider keeps 100%
          await settleStep({
            rentalId: id,
            step: 'earning',
            userId: rental.providerId,
            type: 'provider_earning',
            amount: charged,
            description: `Rental earnings (${billableMinutes} min, 0% platform commission)`,
            move: () => WalletService.adjustBalance(rental.providerId, charged, true)
          });
          providerCredited = true;
        }
      }

      // ── Provider-caused interruption: goodwill credit ────────────────
      // Interactive sessions: 10% of the planned value.
      // Batch work (training/rendering): 2x the value of the remaining time.
      // Always paid by the provider (never the platform), capped by their
      // balance so a wallet can never go negative.
      if (String(endReason).startsWith('provider_ended') && rental.providerId && finalCost > 0 && !settled.comp) {
        const remaining = Math.max(0, planned - Math.min(elapsedMinutes, planned));
        const plannedValue = Math.round((planned / 60) * pricePerHour * 1000) / 1000;
        const batch = ['training', 'rendering'].includes(String(rental.purpose || ''));
        let due = batch
          ? Math.round(2 * (remaining / 60) * pricePerHour * 1000) / 1000
          : Math.round(plannedValue * 0.10 * 1000) / 1000;
        if (batch && due <= 0) {
          due = Math.round(plannedValue * 0.10 * 1000) / 1000;
        }
        const providerWallet = await WalletService.findByUserId(rental.providerId);
        const providerBalance = Math.max(0, Number(providerWallet?.balance) || 0);
        const comp = Math.round(Math.min(due, providerBalance) * 1000) / 1000;
        if (comp > 0) {
          await settleStep({
            rentalId: id,
            step: 'comp',
            userId: rental.renterId,
            type: 'refund',
            amount: comp,
            description: `Goodwill credit — provider ended the session early (${endReason})`,
            // Both legs (debit the provider, credit the renter) happen inside one
            // SQL function: a crash can no longer take the money from the
            // provider without giving it to the renter.
            move: async () => {
              const { data, error } = await client.rpc('apply_compensation', {
                p_provider_id: rental.providerId,
                p_renter_id: rental.renterId,
                p_amount: comp
              });
              if (error) throw error;
              if (!data || data.ok !== true) {
                throw Object.assign(new Error(`compensation refused: ${data?.code || 'unknown'}`), { retryable: true });
              }
              await TransactionService.create({
                type: 'refund',
                status: 'completed',
                amount: -Number(data.taken || comp),
                relatedId: id,
                description: `Provider early-end compensation (${endReason})`
              }, rental.providerId);
            }
          });
        }
      }
    } catch (err) {
      moneyError = err;
      console.error(`[settlement] money step failed for rental ${id}:`, err.message);
    } finally {
      // ALWAYS release the listing — even if a money step failed (prevents
      // the 'rented forever' trap; healStuckListings is the second net)
      try {
        await client
          .from(SUPABASE_TABLES.gpu_listings)
          .update({ status: 'active', updated_at: new Date().toISOString() })
          .eq('id', rental.listingId)
          .eq('status', 'rented');
      } catch (releaseError) {
        console.error(`[settlement] listing release failed for rental ${id}:`, releaseError.message);
      }
    }

    if (moneyError) {
      // Audit ONLY what truly has no ledger row — never re-bill an amount
      // that already left the renter's wallet (peer-review fix)
      if (prepaid === 0 && finalCost > 0 && !renterCharged) {
        try {
          await TransactionService.create({
            type: 'rental_charge',
            status: 'pending',
            amount: finalCost,
            relatedId: id,
            description: 'Settlement money-step failed — manual review'
          }, rental.renterId);
        } catch (logError) {
          console.error(`[settlement] audit row failed for rental ${id}:`, logError.message);
        }
      }
      if (renterCharged && !providerCredited && providerOwedAmount > 0 && rental.providerId) {
        try {
          await TransactionService.create({
            type: 'provider_earning',
            status: 'pending',
            amount: providerOwedAmount,
            relatedId: id,
            description: 'Provider credit failed after renter charge — manual review'
          }, rental.providerId);
        } catch (logError) {
          console.error(`[settlement] provider audit row failed for rental ${id}:`, logError.message);
        }
      }
    }

    return this.findById(id);
  },

  // Sessions that closed but whose money rows are incomplete — the repair
  // pass for a crash between settlement steps. Bounded and recent only.
  async findSettlementGaps(limit = 25) {
    const client = getClient();
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: rentals, error } = await client
      .from(SUPABASE_TABLES.rentals)
      .select('*')
      .eq('status', 'ended')
      .gte('updated_at', since)
      .order('updated_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    const rows = rentals || [];
    if (!rows.length) return [];

    const { data: txns, error: txnError } = await client
      .from(SUPABASE_TABLES.transactions)
      .select('related_id,status,description')
      .in('related_id', rows.map((r) => r.id));
    if (txnError) throw txnError;

    const byRental = new Map();
    for (const t of txns || []) {
      const set = byRental.get(t.related_id) || { escrow: false, earning: false, refund: false };
      const description = String(t.description || '');
      if (description.startsWith('Session escrow hold')) set.escrow = true;
      if (description.startsWith('Rental earnings')) set.earning = true;
      if (description.startsWith('Unused session time refunded')) set.refund = true;
      byRental.set(t.related_id, set);
    }

    return rows.map(toCamel).filter((r) => {
      const set = byRental.get(r.id);
      return Boolean(set && set.escrow && (!set.earning || !set.refund));
    });
  },

  // Rentals due for auto-settlement (used by the enforcer job).
  async findDueRentals(pendingExpiryMs = 2 * 60 * 60 * 1000) {
    const client = getClient();
    const { data, error } = await client
      .from(SUPABASE_TABLES.rentals)
      .select('*')
      .in('status', ['active', 'pending'])
      .order('start_time', { ascending: true })
      .limit(200);
    if (error) throw error;
    return (data || [])
      .map(toCamel)
      .filter((r) => {
        if (r.status === 'active') {
          if (r.expiresAt && new Date(r.expiresAt).getTime() <= Date.now()) return true;
          const dueAt = new Date(r.startTime).getTime() +
            (Number(r.plannedDurationMinutes) || 1) * 60000;
          return dueAt <= Date.now();
        }
        if (r.status === 'pending') {
          const created = new Date(r.createdAt || r.startTime).getTime();
          return Date.now() - created > pendingExpiryMs;
        }
        return false;
      });
  },

  // Close a never-started pending rental (no money moves — nothing ran).
  async expirePendingRental(id) {
    const client = getClient();
    const { data, error } = await client
      .from(SUPABASE_TABLES.rentals)
      .update({
        status: 'cancelled',
        end_reason: 'expired (never started)',
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id');
    if (error) throw error;
    return Boolean(data && data.length);
  },

  async cancelRental(id, userId, userRole) {
    const client = getClient();
    const rental = await this.findById(id);
    if (!rental) throw new Error('Rental not found');

    const canManage = userRole === 'admin' || rental.renterId === userId || rental.providerId === userId;
    if (!canManage) throw new Error('Not authorized');

    if (!['pending', 'connecting'].includes(rental.status)) {
      throw new Error('Rental cannot be cancelled');
    }

    const { data, error } = await client
      .from(SUPABASE_TABLES.rentals)
      .update({
        status: 'cancelled',
        end_reason: 'Cancelled by user',
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .in('status', ['pending', 'connecting'])
      .select()
      .single();

    if (error) throw error;
    return toCamel(data);
  }
};

// ============================================
// TRANSACTION SERVICE
// ============================================
const TransactionService = {
  async findByUserId(userId, filters = {}, options = {}) {
    const client = getClient();
    let query = client
      .from(SUPABASE_TABLES.transactions)
      .select('*', { count: 'exact' })
      .eq('user_id', userId);

    if (filters.type) query = query.eq('type', filters.type);

    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 200);
    query = query.order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    return {
      transactions: toCamel(data || []),
      pagination: { page, limit, total: count || 0, pages: Math.ceil((count || 0) / limit) }
    };
  },

  async create(transactionData, userId) {
    const client = getClient();
    const record = {
      ...toSnake(transactionData),
      id: crypto.randomUUID(),
      user_id: userId
      // status: the caller's value wins (completed/pending/...); the DB
      // defaults to 'pending' when omitted.
    };
    const { data, error } = await client
      .from(SUPABASE_TABLES.transactions)
      .insert([record])
      .select()
      .single();
    if (error) throw error;
    return toCamel(data);
  },

  async updateStatus(id, status, userId) {
    const client = getClient();
    const updates = { status, updated_at: new Date().toISOString() };
    if (status === 'completed') updates.completed_at = new Date().toISOString();
    const { data, error } = await client
      .from(SUPABASE_TABLES.transactions)
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw error;
    return toCamel(data);
  }
};

// ============================================
// WALLET SERVICE
// ============================================
const WalletService = {
  async findByUserId(userId) {
    const client = getClient();
    const { data, error } = await client
      .from(SUPABASE_TABLES.wallets)
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    return data ? toCamel(data) : null;
  },

  async getOrCreate(userId) {
    let wallet = await this.findByUserId(userId);
    if (!wallet) {
      wallet = await this.create(userId);
    }
    return wallet;
  },

  async create(userId) {
    const client = getClient();
    const record = { id: crypto.randomUUID(), user_id: userId, balance: 0 };
    const { data, error } = await client
      .from(SUPABASE_TABLES.wallets)
      .insert([record])
      .select()
      .single();
    if (error) throw error;
    return toCamel(data);
  },

  // Balance changes are compare-and-swap, not read-modify-write: two concurrent
  // requests (double-tap on Start, a retry racing the first) used to read the
  // same balance and both write `old - quote`, so one session was never paid
  // for. Now the UPDATE only applies when the balance is still the value we
  // read; otherwise we re-read and retry.
  async adjustBalance(userId, amount, isEarning = false) {
    const client = getClient();
    const delta = Number(amount) || 0; // NaN guard: a NULL ledger column must never poison the next value
    const MAX_ATTEMPTS = 5;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const wallet = await this.getOrCreate(userId);
      const current = Number(wallet.balance) || 0;
      const newBalance = Math.max(0, current + delta);
      const updates = {
        balance: newBalance,
        updated_at: new Date().toISOString()
      };
      if (isEarning && delta > 0) updates.total_earnings = (Number(wallet.totalEarnings) || 0) + delta;
      if (!isEarning && delta < 0) updates.total_spent = (Number(wallet.totalSpent) || 0) + Math.abs(delta);

      const { data, error } = await client
        .from(SUPABASE_TABLES.wallets)
        .update(updates)
        .eq('user_id', userId)
        .eq('balance', current) // CAS: only if nobody changed it under us
        .select();
      if (error) throw error;
      if (data && data.length > 0) return toCamel(data[0]);
      // Lost the race: somebody else moved the balance. Re-read and retry.
    }
    throw Object.assign(new Error('Wallet is busy, please retry'), { code: 'WALLET_BUSY', status: 409 });
  },

  // Payout settlement: move the money out of the provider's spendable wallet
  // and record it. Without this the same earnings look payable again on the
  // next batch — the classic double-payout bug.
  async debitForPayout(providerId, amount, payoutId) {
    const value = Math.round(Math.max(0, Number(amount) || 0) * 1000) / 1000;
    if (!(value > 0)) return 0;
    const wallet = await this.getOrCreate(providerId);
    const available = Math.max(0, Number(wallet.balance) || 0);
    const taken = Math.round(Math.min(value, available) * 1000) / 1000;
    if (!(taken > 0)) return 0;
    await this.adjustBalance(providerId, -taken, false);
    try {
      await TransactionService.create({
        type: 'withdrawal',
        status: 'completed',
        amount: taken,
        relatedId: payoutId,
        description: 'Weekly payout transferred to provider'
      }, providerId);
    } catch (txnError) {
      // Never leave a debit without its audit row.
      await this.adjustBalance(providerId, taken, false);
      throw txnError;
    }
    return taken;
  }
};

// ============================================
// WAITLIST SERVICE (phone-fleet coming soon)
// ============================================
const WaitlistService = {
  // Idempotent join: a repeated email returns { alreadyJoined: true }
  async add(email, role) {
    const client = getClient();
    const record = {
      id: crypto.randomUUID(),
      email,
      role,
      source: 'phone_fleet_landing'
    };
    const { data, error } = await client
      .from('waitlist')
      .upsert([record], { onConflict: 'email', ignoreDuplicates: true })
      .select('id')
      .maybeSingle();
    if (error) throw error;
    return { alreadyJoined: !data };
  }
};

module.exports = {
  UserService,
  GpuService,
  DeviceService,
  GpuListingService,
  RentalService,
  TransactionService,
  WalletService,
  WaitlistService,
  isMissingSchemaObject,
  healStuckListings,
  SUPABASE_TABLES
};