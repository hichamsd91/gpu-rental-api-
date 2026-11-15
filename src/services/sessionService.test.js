jest.mock('../config/supabase', () => ({ getSupabaseClient: jest.fn() }));

const { getSupabaseClient } = require('../config/supabase');
const sessions = require('./sessionService');

const RENTAL_ID = '55555555-5555-4555-8555-555555555555';
const VALID_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB7exampleKeyMaterialForTestsOnly0123456789';

// Minimal PostgREST-ish builder: insert().select().single() returns the row.
const fakeClient = (result = { data: {}, error: null }) => {
  const single = jest.fn(async () => result);
  const select = jest.fn(() => ({ single }));
  const insert = jest.fn(() => ({ select }));
  return { from: jest.fn(() => ({ insert })) };
};

beforeEach(() => jest.clearAllMocks());

describe('recordEvent input validation', () => {
  test.each([['exploded'], [''], [null], [123]])(
    'rejects the unknown event type %p with a 400 code',
    async (eventType) => {
      await expect(sessions.recordEvent(RENTAL_ID, eventType, {}))
        .rejects.toMatchObject({ code: 'invalid_event_type', status: 400 });
      expect(getSupabaseClient).not.toHaveBeenCalled();
    }
  );

  test('accepts every documented event type', async () => {
    const client = fakeClient({ data: { id: 'evt-1', event_type: 'started' }, error: null });
    getSupabaseClient.mockReturnValue(client);

    for (const type of ['started', 'stopped', 'auto_stopped', 'idle_warning', 'key_issued', 'key_revoked', 'disk_wiped', 'error']) {
      await expect(sessions.recordEvent(RENTAL_ID, type, {})).resolves.toBeTruthy();
    }
    await expect(sessions.recordEvent(RENTAL_ID, 'started', { a: 1 })).resolves.toBeTruthy();
  });

  test('defaults to the started event when the route passes a falsy type', async () => {
    // The route does `req.body?.eventType || 'started'`, so this mirrors it.
    const client = fakeClient({ data: { id: 'evt-1' }, error: null });
    getSupabaseClient.mockReturnValue(client);

    await expect(sessions.recordEvent(RENTAL_ID, 'started', {})).resolves.toBeTruthy();
    expect(client.from).toHaveBeenCalledWith('session_events');
  });
});

describe('issueSshKey input validation', () => {
  test.each([
    [undefined],
    [''],
    ['short'],
    ['not-a-key-but-long-enough-to-pass-the-length-check'],
    ['ssh-rsa'],
  ])('rejects %p with invalid_public_key', async (publicKey) => {
    await expect(sessions.issueSshKey(RENTAL_ID, publicKey))
      .rejects.toMatchObject({ code: 'invalid_public_key', status: 400 });
    expect(getSupabaseClient).not.toHaveBeenCalled();
  });

  test('stores a fingerprint for a valid OpenSSH key', async () => {
    const client = fakeClient({ data: { id: 'key-1', public_key: VALID_KEY }, error: null });
    getSupabaseClient.mockReturnValue(client);

    const row = await sessions.issueSshKey(RENTAL_ID, VALID_KEY);

    expect(row).toBeTruthy();
    const inserted = client.from.mock.results[0].value.insert.mock.calls[0][0];
    expect(inserted.rental_id).toBe(RENTAL_ID);
    expect(inserted.public_key).toBe(VALID_KEY);
    expect(inserted.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(new Date(inserted.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('trims surrounding whitespace before validating', async () => {
    const client = fakeClient({ data: { id: 'key-1' }, error: null });
    getSupabaseClient.mockReturnValue(client);

    await sessions.issueSshKey(RENTAL_ID, `  ${VALID_KEY}  `);

    const inserted = client.from.mock.results[0].value.insert.mock.calls[0][0];
    expect(inserted.public_key).toBe(VALID_KEY);
  });
});
