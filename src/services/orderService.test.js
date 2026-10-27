// Orders/cart service (P3-01…P3-06): server-side pricing, hold semantics and
// RPC error mapping. No real database involved.
const mockState = {
  tables: { orders: [], order_items: [] },
  rpc: { ok: true, code: 'reserved', holdExpiresAt: new Date(Date.now() + 900000).toISOString() },
  rpcCalls: []
};

const matches = (row, filters) => filters.every(([col, value]) => String(row[col]) === String(value));

const execute = (op, table) => {
  const rows = mockState.tables[table] || (mockState.tables[table] = []);
  if (op.type === 'insert') {
    for (const row of op.values) rows.push({ ...row });
    return { data: null, error: null };
  }
  if (op.type === 'select') {
    const found = rows.filter((row) => matches(row, op.filters));
    return { data: op.single ? (found[0] || null) : found, error: null };
  }
  if (op.type === 'update') {
    for (const row of rows) {
      if (matches(row, op.filters)) Object.assign(row, op.values);
    }
    return { data: null, error: null };
  }
  if (op.type === 'delete') {
    mockState.tables[table] = rows.filter((row) => !matches(row, op.filters));
    return { data: null, error: null };
  }
  return { data: null, error: null };
};

const makeBuilder = (table) => {
  const op = { type: null, filters: [], values: null, single: false };
  const builder = {
    insert(rows) { op.type = 'insert'; op.values = Array.isArray(rows) ? rows : [rows]; return builder; },
    update(values) { op.type = 'update'; op.values = values; return builder; },
    delete() { op.type = 'delete'; return builder; },
    select() { if (!op.type) op.type = 'select'; return builder; },
    eq(column, value) { op.filters.push([column, value]); return builder; },
    order() { return builder; },
    range() { return builder; },
    maybeSingle() { op.single = true; return Promise.resolve(execute(op, table)); },
    single() { op.single = true; return Promise.resolve(execute(op, table)); },
    then(resolve, reject) { return Promise.resolve(execute(op, table)).then(resolve, reject); }
  };
  return builder;
};

jest.mock('../config/supabase', () => ({
  getSupabaseClient: () => ({
    from: (table) => makeBuilder(table),
    rpc: (fn, args) => {
      mockState.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: mockState.rpc, error: null });
    }
  })
}));

jest.mock('./supabaseService', () => ({
  GpuListingService: { findById: jest.fn() }
}));

jest.mock('./catalogService', () => ({
  getAvailabilityRows: jest.fn(async () => ({ windows: [], blackouts: [] })),
  isWindowOpen: jest.fn(() => true),
  findNextOpening: jest.fn(() => null),
  isMissingSchema: () => false
}));

const { GpuListingService } = require('./supabaseService');
const catalog = require('./catalogService');
const orders = require('./orderService');

const LISTING_ID = '11111111-2222-3333-4444-555555555555';

const baseListing = (overrides = {}) => ({
  id: LISTING_ID,
  providerId: 'provider-1',
  gpuName: 'RTX 4090',
  status: 'active',
  isPublic: true,
  pricePerHour: 2,
  minRentalMinutes: 30,
  maxRentalHours: 24,
  purposes: [
    { key: 'inference', labelEn: 'Inference', pricePerHour: null, specs: {} },
    { key: 'mining', labelEn: 'Mining', pricePerHour: 0.5, specs: { powerCapWatts: 300 } }
  ],
  ...overrides
});

const orderRow = (overrides = {}) => ({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  renter_id: 'renter-1',
  status: 'awaiting_payment',
  currency: 'USD',
  subtotal: 1,
  total: 1,
  version: 1,
  hold_expires_at: new Date(Date.now() + 600000).toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides
});

const itemRow = (overrides = {}) => ({
  id: '99999999-8888-7777-6666-555555555555',
  order_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  listing_id: LISTING_ID,
  provider_id: 'provider-1',
  purpose: 'inference',
  planned_duration_minutes: 60,
  unit_price_per_hour: 2,
  line_total: 2,
  starts_at: new Date().toISOString(),
  ends_at: new Date(Date.now() + 3600000).toISOString(),
  status: 'draft',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides
});

beforeEach(() => {
  mockState.tables = { orders: [], order_items: [] };
  mockState.rpc = { ok: true, code: 'reserved', holdExpiresAt: new Date(Date.now() + 900000).toISOString() };
  mockState.rpcCalls = [];
  jest.clearAllMocks();
  catalog.getAvailabilityRows.mockResolvedValue({ windows: [], blackouts: [] });
  catalog.isWindowOpen.mockReturnValue(true);
  GpuListingService.findById.mockResolvedValue(baseListing());
});

describe('quotePurpose', () => {
  test('a purpose with its own price wins over the base rate', () => {
    expect(orders.quotePurpose(baseListing(), 'mining')).toEqual({ purpose: 'mining', pricePerHour: 0.5 });
  });

  test('a purpose without an override uses the base hourly price', () => {
    expect(orders.quotePurpose(baseListing(), 'inference')).toEqual({ purpose: 'inference', pricePerHour: 2 });
  });

  test('no purposes on the listing means base price and no purpose', () => {
    expect(orders.quotePurpose(baseListing({ purposes: [] }), undefined)).toEqual({ purpose: null, pricePerHour: 2 });
  });

  test('refuses a purpose the listing does not offer', () => {
    expect(() => orders.quotePurpose(baseListing(), 'rendering')).toThrow(/not offered/);
  });
});

describe('createDraft', () => {
  test('rejects an empty cart', async () => {
    await expect(orders.createDraft({ renterId: 'renter-1', items: [] }))
      .rejects.toMatchObject({ code: 'invalid_items', status: 400 });
  });

  test('rejects more than 10 lines', async () => {
    const items = Array.from({ length: 11 }, () => ({ listingId: LISTING_ID, plannedDurationMinutes: 60 }));
    await expect(orders.createDraft({ renterId: 'renter-1', items }))
      .rejects.toMatchObject({ code: 'too_many_items' });
  });

  test('rejects a duration below the listing minimum', async () => {
    await expect(orders.createDraft({
      renterId: 'renter-1',
      items: [{ listingId: LISTING_ID, plannedDurationMinutes: 10 }]
    })).rejects.toMatchObject({ code: 'duration_below_minimum' });
  });

  test('rejects a hidden or paused machine', async () => {
    GpuListingService.findById.mockResolvedValue(null);

    await expect(orders.createDraft({
      renterId: 'renter-1',
      items: [{ listingId: LISTING_ID, plannedDurationMinutes: 60 }]
    })).rejects.toMatchObject({ code: 'listing_not_found', status: 404 });
  });

  test('prices every line server-side and returns the draft', async () => {
    const order = await orders.createDraft({
      renterId: 'renter-1',
      items: [
        { listingId: LISTING_ID, plannedDurationMinutes: 120, purpose: 'inference' },
        { listingId: LISTING_ID, plannedDurationMinutes: 60, purpose: 'mining', pricePerHour: 0.01 }
      ]
    });

    // Client-sent prices are ignored: 2$/h * 2h and mining's own 0.5$/h * 1h.
    expect(order.subtotal).toBe(4.5);
    expect(order.items.map((i) => i.lineTotal)).toEqual([4, 0.5]);
    expect(order.items[1]).toMatchObject({ purpose: 'mining', unitPricePerHour: 0.5, status: 'draft' });
    expect(mockState.tables.orders).toHaveLength(1);
    expect(mockState.tables.order_items).toHaveLength(2);
  });
});

describe('reserve', () => {
  test('a live hold is returned unchanged without touching the RPC', async () => {
    mockState.tables.orders.push(orderRow());
    mockState.tables.order_items.push(itemRow({ status: 'held', hold_expires_at: new Date(Date.now() + 600000).toISOString() }));

    const order = await orders.reserve({ orderId: orderRow().id, renterId: 'renter-1' });

    expect(order.holdActive).toBe(true);
    expect(mockState.rpcCalls).toHaveLength(0);
  });

  test('a provider price change answers quote_stale with the new total', async () => {
    mockState.tables.orders.push(orderRow({ status: 'draft', hold_expires_at: null }));
    mockState.tables.order_items.push(itemRow());
    GpuListingService.findById.mockResolvedValue(baseListing({ pricePerHour: 3 }));

    await expect(orders.reserve({ orderId: orderRow().id, renterId: 'renter-1' }))
      .rejects.toMatchObject({ code: 'quote_stale' });

    const updated = mockState.tables.orders[0];
    expect(updated.total).toBe(3);
    expect(mockState.tables.order_items[0].unit_price_per_hour).toBe(3);
  });

  test('refuses to hold outside the provider windows', async () => {
    mockState.tables.orders.push(orderRow({ status: 'draft', hold_expires_at: null }));
    mockState.tables.order_items.push(itemRow());
    catalog.isWindowOpen.mockReturnValue(false);

    await expect(orders.reserve({ orderId: orderRow().id, renterId: 'renter-1' }))
      .rejects.toMatchObject({ code: 'listing_closed', status: 409 });
    expect(mockState.rpcCalls).toHaveLength(0);
  });

  test('maps a busy RPC answer to 409 listing_busy', async () => {
    mockState.tables.orders.push(orderRow({ status: 'draft', hold_expires_at: null }));
    mockState.tables.order_items.push(itemRow());
    mockState.rpc = { ok: false, code: 'listing_busy', itemId: itemRow().id, listingId: LISTING_ID };

    await expect(orders.reserve({ orderId: orderRow().id, renterId: 'renter-1' }))
      .rejects.toMatchObject({ code: 'listing_busy', status: 409, extra: { itemId: itemRow().id } });

    expect(mockState.rpcCalls[0].fn).toBe('order_reserve');
  });

  test('an expired hold is asked to be reserved again', async () => {
    mockState.tables.orders.push(orderRow({ status: 'awaiting_payment' }));
    mockState.rpc = { ok: false, code: 'hold_expired' };

    await expect(orders.pay({ orderId: orderRow().id, renterId: 'renter-1' }))
      .rejects.toMatchObject({ code: 'hold_expired', status: 409 });
  });
});

describe('pay + cancel', () => {
  test('pay returns the rental created for each line', async () => {
    const orderId = orderRow({ status: 'paid' }).id;
    mockState.tables.orders.push(orderRow({ status: 'paid' }));
    mockState.tables.order_items.push(itemRow({ status: 'rental_created', rental_id: 'rental-1' }));
    mockState.rpc = { ok: true, code: 'paid', rentals: [{ itemId: itemRow().id, rentalId: 'rental-1' }] };

    const order = await orders.pay({ orderId, renterId: 'renter-1' });

    expect(order.rentals).toEqual([{ itemId: itemRow().id, rentalId: 'rental-1' }]);
    expect(mockState.rpcCalls[0]).toEqual({ fn: 'order_pay', args: { p_order_id: orderId, p_renter_id: 'renter-1' } });
  });

  test('cancelling a paid order is refused (refund belongs to Phase 4)', async () => {
    mockState.tables.orders.push(orderRow({ status: 'paid' }));
    mockState.rpc = { ok: false, code: 'order_already_paid' };

    await expect(orders.cancel({ orderId: orderRow().id, renterId: 'renter-1' }))
      .rejects.toMatchObject({ code: 'order_already_paid', status: 409 });
  });

  test('another renter cannot read the order', async () => {
    mockState.tables.orders.push(orderRow());

    await expect(orders.getOrder(orderRow().id, 'renter-2'))
      .rejects.toMatchObject({ code: 'order_not_found', status: 404 });
  });
});

describe('expireStale', () => {
  test('reports how many holds were released', async () => {
    mockState.rpc = { ok: true, orders: 3, items: 5 };

    await expect(orders.expireStale(50)).resolves.toEqual({ orders: 3, items: 5 });
    expect(mockState.rpcCalls[0]).toEqual({ fn: 'order_expire_stale', args: { p_limit: 50 } });
  });
});
