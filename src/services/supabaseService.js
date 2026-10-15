/**
 * Supabase Service Layer - Replaces Mongoose Models
 * Provides a unified interface for all database operations
 */
const { getSupabaseClient } = require('../config/supabase');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PlatformCommissionService } = require('./commissionService');

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

// Helper: Build filter object for Supabase queries
const buildFilters = (query) => {
  const filters = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      filters[key] = value;
    }
  }
  return filters;
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
const LISTING_CREATE_FIELDS = [
  'deviceId', 'gpuId', 'gpuName', 'gpuBrand', 'vramGb', 'cpuModel', 'cpuCores',
  'ramGb', 'storageGb', 'osName', 'pricePerHour', 'pricePerMinute',
  'minRentalMinutes', 'maxRentalHours', 'isPublic',
  'locationCountry', 'locationCity', 'networkSpeedMbps',
  'allowRemoteDesktop', 'allowFileTransfer', 'allowCustomSoftware',
  'description', 'tags'
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
    let query = client
      .from(SUPABASE_TABLES.gpu_listings)
      .select('*', { count: 'exact' });

    // Apply filters
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.isPublic !== undefined) query = query.eq('is_public', filters.isPublic);
    if (filters.providerId) query = query.eq('provider_id', filters.providerId);
    if (filters.gpuBrand) query = query.eq('gpu_brand', filters.gpuBrand);
    if (filters.minVram) query = query.gte('vram_gb', parseInt(filters.minVram));
    if (filters.maxPrice) query = query.lte('price_per_hour', parseFloat(filters.maxPrice));
    if (filters.search) {
      // SECURITY: strip PostgREST filter metacharacters (,, (), ', %) and cap length
      const safeSearch = String(filters.search)
        .replace(/[%,()\\'"]/g, ' ')
        .trim()
        .slice(0, 100);
      if (safeSearch) {
        query = query.or(`gpu_name.ilike.%${safeSearch}%,gpu_brand.ilike.%${safeSearch}%,cpu_model.ilike.%${safeSearch}%,description.ilike.%${safeSearch}%`);
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
    query = query.order(sort.column, { ascending: sort.ascending });

    // Pagination
    const page = parseInt(options.page) || 1;
    const limit = parseInt(options.limit) || 20;
    query = query.range((page - 1) * limit, page * limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    return {
      listings: toCamel(data || []),
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
      .from(SUPABASE_TABLES.gpu_listings)
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data ? toCamel(data) : null;
  },

  async create(listingData, providerId) {
    const client = getClient();
    // Whitelist: provider cannot set own id, ratings, totals, revenue, status
    const record = {
      ...toSnake(pickAllowed(listingData, LISTING_CREATE_FIELDS)),
      id: crypto.randomUUID(),
      provider_id: providerId
    };
    const { data, error } = await client
      .from(SUPABASE_TABLES.gpu_listings)
      .insert([record])
      .select()
      .single();
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
    snakeUpdates.updated_at = new Date().toISOString();
    const { data, error } = await client
      .from(SUPABASE_TABLES.gpu_listings)
      .update(snakeUpdates)
      .eq('id', id)
      .eq('provider_id', providerId)
      .select()
      .single();
    if (error) throw error;
    return toCamel(data);
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
    const { error } = await client
      .from(SUPABASE_TABLES.gpu_listings)
      .delete()
      .eq('id', id)
      .eq('provider_id', providerId);
    if (error) throw error;
    return true;
  }
};

// ============================================
// RENTAL SERVICE
// ============================================
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
    const page = parseInt(options.page) || 1;
    const limit = parseInt(options.limit) || 20;
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
    return data ? toCamel(data) : null;
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
    const { data, error } = await client
      .from(SUPABASE_TABLES.rentals)
      .insert([record])
      .select()
      .single();
    if (error) throw error;
    return toCamel(data);
  },

  async createFree(rentalData, renterId) {
    const client = getClient();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours
    const record = {
      ...toSnake(rentalData),
      id: crypto.randomUUID(),
      renter_id: renterId,
      start_time: now.toISOString(),
      end_time: expiresAt.toISOString(),
      status: 'active', // Free rentals start immediately as active
      is_free: true,
      session_type: 'free_ad_supported',
      expires_at: expiresAt.toISOString()
    };
    const { data, error } = await client
      .from(SUPABASE_TABLES.rentals)
      .insert([record])
      .select()
      .single();
    if (error) throw error;
    const rental = toCamel(data);
    
    // Update listing status to rented for free session
    if (rentalData.listingId) {
      await client
        .from(SUPABASE_TABLES.gpu_listings)
        .update({ status: 'rented', updated_at: new Date().toISOString() })
        .eq('id', rentalData.listingId)
        .eq('status', 'active');
    }
    
    // Emit signaling event via Supabase realtime for provider notification
    await client
      .from(SUPABASE_TABLES.rentals)
      .update({ signaling_payload: JSON.stringify({
        type: 'free_session_started',
        rentalId: data.id,
        expiresAt: expiresAt.toISOString()
      }), updated_at: new Date().toISOString() })
      .eq('id', data.id);
    
    return toCamel(data);
  },

  async startRental(id, renterId) {
    const client = getClient();
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

    // Update listing status to rented
    const { error: listingError } = await client
      .from(SUPABASE_TABLES.gpu_listings)
      .update({ status: 'rented', updated_at: new Date().toISOString() })
      .eq('id', rental.listing_id)
      .eq('status', 'active');

    if (listingError) {
      // Rollback rental
      await client
        .from(SUPABASE_TABLES.rentals)
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', id);
      throw listingError;
    }

    return toCamel(rental);
  },

  async endRental(id, userId, userRole) {
    const client = getClient();
    const rental = await this.findById(id);
    if (!rental) throw new Error('Rental not found');

    const canManage = userRole === 'admin' || rental.renterId === userId || rental.providerId === userId;
    if (!canManage) throw new Error('Not authorized');

    if (rental.status !== 'active') throw new Error('Rental is not active');

    const endTime = new Date();
    const startTime = new Date(rental.startTime);
    const actualDurationMinutes = Math.max(1, Math.ceil((endTime - startTime) / (1000 * 60)));
    
    const listing = await GpuListingService.findById(rental.listingId);
    const actualCost = (actualDurationMinutes / 60) * (listing?.pricePerHour || 0);
    
    // Free platform: 0% commission, 100% to provider
    const isFree = rental.isFree === true;
    const commissionRate = 0; // Free platform: 0% commission
    const platformCommission = 0;
    const providerEarning = actualCost; // 100% to provider

    const { data, error } = await client
      .from(SUPABASE_TABLES.rentals)
      .update({
        status: 'ended',
        end_time: endTime.toISOString(),
        actual_duration_minutes: actualDurationMinutes,
        actual_cost: actualCost,
        cost_so_far: actualCost,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('status', 'active')
      .select()
      .single();

    if (error) throw error;

    // Update provider wallet with earnings (100% to provider, 0% platform fee)
    if (actualCost > 0 && rental.providerId) {
      await WalletService.adjustBalance(rental.providerId, actualCost, true);
      
      // Create transaction record for provider earnings
      await TransactionService.create({
        type: 'provider_earning',
        status: 'completed',
        amount: actualCost,
        relatedId: id,
        description: `Rental earnings (${actualDurationMinutes} min session)`
      }, rental.providerId);
    }

    // Update renter wallet (deduct cost) if not free
    if (actualCost > 0 && rental.renterId) {
      await WalletService.adjustBalance(rental.renterId, -actualCost, false);
      
      // Create transaction record for renter charge
      await TransactionService.create({
        type: 'rental_charge',
        status: 'completed',
        amount: actualCost,
        relatedId: id,
        description: `Rental charge (${actualDurationMinutes} min session)`
      }, rental.renterId);
    }

    // Update listing status back to active
    await client
      .from(SUPABASE_TABLES.gpu_listings)
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', rental.listingId)
      .eq('status', 'rented');

    const { data: rentalData, error: rentalError } = await client
      .from(SUPABASE_TABLES.rentals)
      .select('*')
      .eq('id', id)
      .single();

    if (rentalError) throw rentalError;
    return toCamel(rentalData);
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

    const page = parseInt(options.page) || 1;
    const limit = parseInt(options.limit) || 20;
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
      user_id: userId,
      status: 'pending'
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

  async adjustBalance(userId, amount, isEarning = false) {
    const client = getClient();
    const wallet = await this.getOrCreate(userId);
    const newBalance = Math.max(0, wallet.balance + amount);
    const updates = {
      balance: newBalance,
      updated_at: new Date().toISOString()
    };
    if (isEarning && amount > 0) updates.total_earnings = wallet.totalEarnings + amount;
    if (!isEarning && amount < 0) updates.total_spent = wallet.totalSpent + Math.abs(amount);

    const { data, error } = await client
      .from(SUPABASE_TABLES.wallets)
      .update(updates)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw error;
    return toCamel(data);
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
  SUPABASE_TABLES
};