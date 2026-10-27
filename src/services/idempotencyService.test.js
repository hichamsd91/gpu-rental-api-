// Idempotency gate (P3-03): the same key must never run a mutation twice.
const mockDb = {
  rows: new Map(),
  insertError: null,
  updates: []
};

const matches = (row, filters) => filters.every(([col, val]) => row[col] === val);

const execute = (op) => {
  if (op.type === 'insert') {
    if (mockDb.insertError) return { error: mockDb.insertError };
    const row = op.values[0];
    const id = `${row.user_id}:${row.key}`;
    if (mockDb.rows.has(id)) {
      return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
    }
    mockDb.rows.set(id, {
      status: 'in_flight',
      updated_at: new Date().toISOString(),
      response_status: null,
      response_body: null,
      ...row
    });
    return { error: null };
  }
  if (op.type === 'select') {
    const found = [...mockDb.rows.values()].find((row) => matches(row, op.filters));
    return { data: found || null, error: null };
  }
  if (op.type === 'update') {
    mockDb.updates.push(op.values);
    let changed = 0;
    for (const row of mockDb.rows.values()) {
      if (matches(row, op.filters)) {
        Object.assign(row, op.values);
        changed += 1;
      }
    }
    return { data: null, error: null, changed };
  }
  if (op.type === 'delete') {
    for (const [id, row] of [...mockDb.rows.entries()]) {
      if (matches(row, op.filters)) mockDb.rows.delete(id);
    }
    return { data: null, error: null };
  }
  return { data: null, error: null };
};

const makeBuilder = () => {
  const op = { type: null, filters: [], values: null };
  const builder = {
    insert(rows) { op.type = 'insert'; op.values = Array.isArray(rows) ? rows : [rows]; return builder; },
    update(values) { op.type = 'update'; op.values = values; return builder; },
    delete() { op.type = 'delete'; return builder; },
    select() { if (!op.type) op.type = 'select'; return builder; },
    eq(column, value) { op.filters.push([column, value]); return builder; },
    maybeSingle() { return Promise.resolve(execute(op)); },
    single() { return Promise.resolve(execute(op)); },
    then(resolve, reject) { return Promise.resolve(execute(op)).then(resolve, reject); }
  };
  return builder;
};

jest.mock('../config/supabase', () => ({
  getSupabaseClient: () => ({ from: () => makeBuilder() })
}));

const idempotency = require('./idempotencyService');

const KEY = 'order-key-0001';
const USER = 'user-1';

beforeEach(() => {
  mockDb.rows.clear();
  mockDb.insertError = null;
  mockDb.updates = [];
});

describe('idempotency.run', () => {
  test('refuses to mutate without a usable key', async () => {
    const handler = jest.fn();

    await expect(idempotency.run({ userId: USER, key: '', scope: 'orders.pay', body: {}, handler }))
      .rejects.toMatchObject({ status: 400, code: 'idempotency_key_required' });
    await expect(idempotency.run({ userId: USER, key: 'short', scope: 'orders.pay', body: {}, handler }))
      .rejects.toMatchObject({ status: 400 });
    expect(handler).not.toHaveBeenCalled();
    expect(mockDb.rows.size).toBe(0);
  });

  test('runs the handler once and stores the answer', async () => {
    const handler = jest.fn(async () => ({ status: 201, body: { success: true, order: { id: 'o-1' } } }));

    const result = await idempotency.run({ userId: USER, key: KEY, scope: 'orders.create', body: { items: [1] }, handler });

    expect(result).toEqual({ replay: false, status: 201, body: { success: true, order: { id: 'o-1' } } });
    expect(handler).toHaveBeenCalledTimes(1);
    const stored = mockDb.rows.get(`${USER}:${KEY}`);
    expect(stored).toMatchObject({ status: 'succeeded', response_status: 201, scope: 'orders.create' });
  });

  test('a retry with the same key and body replays the stored answer', async () => {
    const first = jest.fn(async () => ({ status: 201, body: { order: { id: 'o-1' } } }));
    await idempotency.run({ userId: USER, key: KEY, scope: 'orders.create', body: { items: [1] }, handler: first });

    const second = jest.fn(async () => ({ status: 201, body: { order: { id: 'o-2' } } }));
    const replayed = await idempotency.run({
      userId: USER, key: KEY, scope: 'orders.create', body: { items: [1] }, handler: second
    });

    expect(replayed.replay).toBe(true);
    expect(replayed.body).toEqual({ order: { id: 'o-1' } });
    expect(second).not.toHaveBeenCalled();
  });

  test('the same key with a different body is a hard conflict', async () => {
    await idempotency.run({
      userId: USER, key: KEY, scope: 'orders.create', body: { items: [1] }, handler: async () => ({ status: 201, body: {} })
    });
    const handler = jest.fn();

    await expect(idempotency.run({
      userId: USER, key: KEY, scope: 'orders.create', body: { items: [2] }, handler
    })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
    expect(handler).not.toHaveBeenCalled();
  });

  test('refuses while an identical request is still in flight', async () => {
    mockDb.rows.set(`${USER}:${KEY}`, {
      user_id: USER, key: KEY, scope: 'orders.pay',
      request_hash: idempotency.hashBody({}),
      status: 'in_flight', updated_at: new Date().toISOString()
    });

    await expect(idempotency.run({
      userId: USER, key: KEY, scope: 'orders.pay', body: {}, handler: jest.fn()
    })).rejects.toMatchObject({ status: 409, code: 'idempotency_inflight' });
  });

  test('a failed attempt releases the key so the retry can succeed', async () => {
    const error = Object.assign(new Error('Listing busy'), { status: 409, code: 'listing_busy' });

    await expect(idempotency.run({
      userId: USER, key: KEY, scope: 'orders.reserve', body: {}, handler: async () => { throw error; }
    })).rejects.toBe(error);
    expect(mockDb.rows.has(`${USER}:${KEY}`)).toBe(false);

    const retried = await idempotency.run({
      userId: USER, key: KEY, scope: 'orders.reserve', body: {},
      handler: async () => ({ status: 200, body: { ok: true } })
    });
    expect(retried.status).toBe(200);
  });

  test('reports a missing migration as 503 instead of a generic failure', async () => {
    mockDb.insertError = { code: '42P01', message: 'relation "idempotency_keys" does not exist' };

    await expect(idempotency.run({
      userId: USER, key: KEY, scope: 'orders.create', body: {}, handler: jest.fn()
    })).rejects.toMatchObject({ status: 503, code: 'orders_unavailable' });
  });
});
