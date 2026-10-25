jest.mock('../config/supabase', () => ({ getSupabaseClient: jest.fn() }));

const { getSupabaseClient } = require('../config/supabase');
const { issue, consume, revokeAllForUser, PURPOSE, sha256 } = require('./emailTokenService');

beforeEach(() => jest.clearAllMocks());

// Builds the full supabase-js chain used by consume():
// update(...).eq(...).eq(...).is(...).gte(...).select(...).maybeSingle()
const useConsumeChain = (maybeSingleResult) => {
  const maybeSingle = jest.fn().mockResolvedValue(maybeSingleResult);
  const select = jest.fn(() => ({ maybeSingle }));
  const gte = jest.fn(() => ({ select }));
  const is = jest.fn(() => ({ gte }));
  const eq2 = jest.fn(() => ({ is }));
  const eq = jest.fn(() => ({ eq: eq2 }));
  const update = jest.fn(() => ({ eq }));
  getSupabaseClient.mockReturnValue({ from: jest.fn(() => ({ update })) });
  return { update, eq, eq2, is, gte, maybeSingle };
};

describe('issue', () => {
  test('stores only a SHA-256 hash and returns the raw token', async () => {
    const insert = jest.fn().mockResolvedValue({ error: null });
    getSupabaseClient.mockReturnValue({ from: jest.fn(() => ({ insert })) });

    const raw = await issue({ userId: 'u-1', purpose: PURPOSE.VERIFY_EMAIL });

    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    const row = insert.mock.calls[0][0];
    expect(row.user_id).toBe('u-1');
    expect(row.purpose).toBe('verify_email');
    expect(row.token_hash).toBe(sha256(raw));
    expect(row.token_hash).not.toBe(raw);
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('rejects an unknown purpose', async () => {
    await expect(issue({ userId: 'u-1', purpose: 'nope' })).rejects.toThrow(/invalid purpose/);
  });
});

describe('consume', () => {
  test('atomically marks used and returns the user id', async () => {
    const { update, eq, eq2, maybeSingle } = useConsumeChain({ data: { user_id: 'u-1' }, error: null });

    const raw = 'aa'.repeat(32);
    const userId = await consume(raw, PURPOSE.RESET_PASSWORD);

    expect(userId).toBe('u-1');
    expect(update).toHaveBeenCalledWith({ used_at: expect.any(String) });
    expect(eq).toHaveBeenCalledWith('token_hash', sha256(raw));
    expect(eq2).toHaveBeenCalledWith('purpose', 'reset_password');
    expect(maybeSingle).toHaveBeenCalled();
  });

  test('returns null for a missing or invalid token', async () => {
    await expect(consume(null, PURPOSE.VERIFY_EMAIL)).resolves.toBeNull();
    await expect(consume('x', 'bogus')).resolves.toBeNull();
  });

  test('returns null when no row matches (used/expired/unknown)', async () => {
    useConsumeChain({ data: null, error: null });
    await expect(consume('aa'.repeat(32), PURPOSE.VERIFY_EMAIL)).resolves.toBeNull();
  });

  test('surfaces database failures', async () => {
    useConsumeChain({ data: null, error: { message: 'boom' } });
    await expect(consume('aa'.repeat(32), PURPOSE.VERIFY_EMAIL)).rejects.toThrow(/consume failed/);
  });
});

describe('revokeAllForUser', () => {
  test('invalidates all outstanding tokens for the user/purpose', async () => {
    const is = jest.fn().mockResolvedValue({ error: null });
    const eq2 = jest.fn(() => ({ is }));
    const eq = jest.fn(() => ({ eq: eq2 }));
    const update = jest.fn(() => ({ eq }));
    getSupabaseClient.mockReturnValue({ from: jest.fn(() => ({ update })) });

    await expect(revokeAllForUser('u-1', PURPOSE.RESET_PASSWORD)).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith({ used_at: expect.any(String) });
  });
});
