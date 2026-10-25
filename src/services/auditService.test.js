jest.mock('../config/supabase', () => ({ getSupabaseClient: jest.fn() }));

const { getSupabaseClient } = require('../config/supabase');
const { record, recordFromRequest, list, sanitizeMeta } = require('./auditService');

const clientWith = (overrides = {}) => ({ ...overrides });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

describe('sanitizeMeta (redaction boundary)', () => {
  test('redacts credential-looking keys at any depth', () => {
    const clean = sanitizeMeta({
      email: 'a@b.c',
      password: 'hunter2',
      nested: { refreshToken: 'abc', apiKey: 'k-1', note: 'ok' },
      list: [{ cardNumber: '4111111111111111', amount: 5 }]
    });

    expect(clean.email).toBe('a@b.c');
    expect(clean.password).toBe('[redacted]');
    expect(clean.nested.refreshToken).toBe('[redacted]');
    expect(clean.nested.apiKey).toBe('[redacted]');
    expect(clean.nested.note).toBe('ok');
    expect(clean.list[0].cardNumber).toBe('[redacted]');
    expect(clean.list[0].amount).toBe(5);
  });

  test('bounds long strings, deep nesting and oversized arrays', () => {
    const deep = { a: { b: { c: { d: { e: 'too deep' } } } } };
    expect(sanitizeMeta('x'.repeat(900))).toHaveLength(501);
    expect(JSON.stringify(sanitizeMeta(deep))).toContain('[depth-limit]');
    expect(sanitizeMeta(Array.from({ length: 80 }, (_, i) => i))).toHaveLength(50);
  });
});

describe('record', () => {
  test('normalizes request context and writes one row', async () => {
    const insert = jest.fn().mockResolvedValue({ error: null });
    getSupabaseClient.mockReturnValue(clientWith({ from: jest.fn(() => ({ insert })) }));

    const ok = await record({
      actorId: 'user-1',
      actorRole: 'provider',
      action: 'listing.delete',
      entity: 'gpu_listings',
      entityId: 'listing-1',
      ip: '203.0.113.7, 70.41.3.18',
      userAgent: 'Mozilla/5.0 ' + 'a'.repeat(400),
      requestId: 'req-9',
      meta: { pricePerHour: 1.25, token: 'secret-value' }
    });

    expect(ok).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row.action).toBe('listing.delete');
    expect(row.ip).toBe('203.0.113.7');
    expect(row.user_agent).toHaveLength(300);
    expect(row.meta.token).toBe('[redacted]');
    expect(row.meta.pricePerHour).toBe(1.25);
  });

  test('never throws when the database rejects the write', async () => {
    const insert = jest.fn().mockResolvedValue({ error: { message: 'relation missing' } });
    getSupabaseClient.mockReturnValue(clientWith({ from: jest.fn(() => ({ insert })) }));

    await expect(record({ action: 'auth.login' })).resolves.toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  test('never throws when the client itself cannot be created', async () => {
    getSupabaseClient.mockImplementation(() => {
      throw new Error('Supabase configuration is missing');
    });

    await expect(record({ action: 'auth.login' })).resolves.toBe(false);
  });

  test('rejects an empty action (programmer error, not infrastructure)', async () => {
    await expect(record({ action: '   ' })).rejects.toThrow(/action is required/);
  });
});

describe('recordFromRequest', () => {
  test('reads actor, forwarded ip, user agent and request id off the request', async () => {
    const insert = jest.fn().mockResolvedValue({ error: null });
    getSupabaseClient.mockReturnValue(clientWith({ from: jest.fn(() => ({ insert })) }));

    const req = {
      user: { id: 'user-7', role: 'admin' },
      headers: {
        'x-forwarded-for': '198.51.100.4, 10.0.0.1',
        'user-agent': 'jest',
        'x-request-id': 'req-42'
      },
      ip: '10.0.0.1'
    };

    await recordFromRequest(req, 'admin.user.deactivate', { entity: 'profiles', entityId: 'user-8' });

    const row = insert.mock.calls[0][0];
    expect(row.actor_id).toBe('user-7');
    expect(row.actor_role).toBe('admin');
    expect(row.ip).toBe('198.51.100.4');
    expect(row.request_id).toBe('req-42');
    expect(row.entity).toBe('profiles');
    expect(row.entity_id).toBe('user-8');
  });
});

describe('list', () => {
  test('caps the page size at 200 and orders newest first', async () => {
    const limit = jest.fn().mockResolvedValue({ data: [{ id: 'a' }], error: null });
    const order = jest.fn(() => ({ limit }));
    const select = jest.fn(() => ({ order }));
    getSupabaseClient.mockReturnValue(clientWith({ from: jest.fn(() => ({ select })) }));

    const rows = await list({ limit: 5000 });

    expect(rows).toEqual([{ id: 'a' }]);
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(limit).toHaveBeenCalledWith(200);
  });

  test('surfaces read failures', async () => {
    const limit = jest.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
    const order = jest.fn(() => ({ limit }));
    getSupabaseClient.mockReturnValue(clientWith({ from: jest.fn(() => ({ select: () => ({ order }) })) }));

    await expect(list()).rejects.toThrow(/audit read failed/);
  });
});
