// The revocation service is mocked so these route tests never touch Supabase (or construct a client that would need
// real credentials) — the blacklist gate's own behaviour is what these cases prove, in isolation.
jest.mock('./services/revocation', () => ({
  isJtiBlacklisted: jest.fn(),
  revokeJti: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('./server');

jest.mock('./services/supabaseService', () => ({
  UserService: {
    findByEmail: jest.fn(),
    create: jest.fn(),
    comparePassword: jest.fn(),
    findById: jest.fn(),
    updateLastLogin: jest.fn(),
  },
}));

const { isJtiBlacklisted, revokeJti } = require('./services/revocation');
const { UserService } = require('./services/supabaseService');

// Per-request secrets: the middleware and routes read process.env at call time, so tests sign with these exact values.
// They OVERWRITE whatever dotenv loaded (otherwise signatures would not verify), which is why they must be RESTORED in
// afterAll — jest may run several test files inside one worker, and a leaked test-only secret would corrupt any sibling
// suite that also verifies tokens against the environment variables.
const ACCESS_SECRET = 'test-access-secret';
const REFRESH_SECRET = 'test-refresh-secret';

describe('auth routes', () => {
  let origAccess = null;
  let origRefresh = null;

  beforeAll(() => {
    origAccess = process.env.JWT_SECRET ?? null; // `?? null` distinguishes "never set" from an empty string
    origRefresh = process.env.JWT_REFRESH_SECRET ?? null;
    process.env.JWT_SECRET = ACCESS_SECRET;
    process.env.JWT_REFRESH_SECRET = REFRESH_SECRET;
  });

  afterAll(() => {
    // Put the worker's env exactly back the way this test file found it.
    if (origAccess === null) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = origAccess;
    if (origRefresh === null) delete process.env.JWT_REFRESH_SECRET; else process.env.JWT_REFRESH_SECRET = origRefresh;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('register rejects an already registered email', async () => {
    UserService.findByEmail.mockResolvedValue({ email: 'existing@example.com' });

    const response = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'existing@example.com',
        password: 'StrongPass123',
        fullName: 'Existing User',
        role: 'renter',
      });

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/already exists/i);
  });

  test('login rejects invalid credentials', async () => {
    UserService.findByEmail.mockResolvedValue(null);

    const response = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'no-user@example.com',
        password: 'wrongpass',
      });

    expect(response.statusCode).toBe(401);
    expect(response.body.message).toMatch(/invalid credentials/i);
  });

  test('me route rejects requests without a bearer token', async () => {
    const response = await request(app).get('/api/auth/me');

    expect(response.statusCode).toBe(401);
    expect(response.body.message).toMatch(/authorization denied|token is not valid/i);
  });

  // === Revocation gate on protected routes (middleware blacklist check) ======================================

  test('me route accepts a live token whose jti is NOT blacklisted', async () => {
    isJtiBlacklisted.mockResolvedValue(false);
    UserService.findById.mockResolvedValue({ id: 'u1', email: 'live@example.com', role: 'renter', isActive: true });
    const token = jwt.sign({ id: 'u1', jti: 'j-happy' }, ACCESS_SECRET, { expiresIn: '1h' });

    const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(response.statusCode).toBe(200);
    expect(isJtiBlacklisted).toHaveBeenCalledTimes(1);
    expect(isJtiBlacklisted).toHaveBeenCalledWith('j-happy');
  });

  test('me route rejects a blacklisted jti EVEN THOUGH the token is signed and unexpired', async () => {
    // This is the gap the gate closes: without it, a logged-out pair would keep authenticating until its TTL (7d).
    isJtiBlacklisted.mockResolvedValue(true);
    const token = jwt.sign({ id: 'u1', jti: 'j-dead' }, ACCESS_SECRET, { expiresIn: '1h' });

    const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(response.statusCode).toBe(401);
    expect(response.body.message).toMatch(/revoked/i);
    expect(UserService.findById).not.toHaveBeenCalled(); // rejected at the gate, profile lookup not even attempted
  });

  test('me route FAILS CLOSED (503) when the revocation lookup itself errors — never a silent pass-through', async () => {
    isJtiBlacklisted.mockRejectedValue(new Error('revocation lookup failed for jti j-err…: simulated DB outage'));
    const token = jwt.sign({ id: 'u1', jti: 'j-err' }, ACCESS_SECRET, { expiresIn: '1h' });

    const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(response.statusCode).toBe(503);
    expect(response.body.message).toMatch(/temporarily unavailable/i);
  });

  test('me route answers plain 401 for an expired (or malformed) token WITHOUT consulting the blacklist', async () => {
    // Expired/malformed tokens are unauthenticated by their own signature; no revocation lookup is needed or attempted.
    const validButExpired = jwt.sign({ id: 'u1', jti: 'j-exp' }, ACCESS_SECRET, { expiresIn: '-10m' });

    const expired = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${validButExpired}`);
    expect(expired.statusCode).toBe(401);

    const malformed = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not.a.jwt');
    expect(malformed.statusCode).toBe(401);

    // The blacklist gate is only consulted AFTER a token verifies — neither case may reach it.
    expect(isJtiBlacklisted).not.toHaveBeenCalled();
  });

  test('me route returns transient 503, not a misleading 401, when the PROFILE lookup itself fails', async () => {
    // During an outage, "we cannot read your row" must never cost connected clients their valid local state; only a
    // verified-genuine revocation (above) or dead signature may answer 401 on this route.
    isJtiBlacklisted.mockResolvedValue(false);
    UserService.findById.mockRejectedValue(new Error('PGRST205: relation "public.profiles" does not exist'));
    const token = jwt.sign({ id: 'u1', jti: 'j-db' }, ACCESS_SECRET, { expiresIn: '1h' });

    const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(response.statusCode).toBe(503);
    expect(response.body.message).toMatch(/temporarily unavailable/i);
  });

  // === Refresh rotation with old-jti revocation ==================================================================

  test('refresh rotates the previous jti into the blacklist and returns a fresh pair', async () => {
    isJtiBlacklisted.mockResolvedValue(false);
    revokeJti.mockResolvedValue(true);
    UserService.findById.mockResolvedValue({ id: 'u1', email: 'live@example.com', role: 'renter', isActive: true });
    const oldRefresh = jwt.sign({ id: 'u1', jti: 'j-old' }, REFRESH_SECRET, { expiresIn: '30d' });

    const response = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: oldRefresh });

    expect(response.statusCode).toBe(200);
    expect(typeof response.body.token).toBe('string');
    expect(typeof response.body.refreshToken).toBe('string');
    expect(revokeJti).toHaveBeenCalledTimes(1);
    const [rotatedJti, meta] = revokeJti.mock.calls[0];
    expect(rotatedJti).toBe('j-old');
    expect(meta.userId).toBe('u1');
  });

  test('refresh rejects a blacklisted refresh token before any rotation happens', async () => {
    isJtiBlacklisted.mockResolvedValue(true);
    const oldRefresh = jwt.sign({ id: 'u1', jti: 'j-dead' }, REFRESH_SECRET, { expiresIn: '30d' });

    const response = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: oldRefresh });

    expect(response.statusCode).toBe(401);
    expect(response.body.message).toMatch(/revoked/i);
    expect(revokeJti).not.toHaveBeenCalled(); // nothing to rotate — the presented pair was already dead
  });

  test('refresh answers 503 (retry later), not a fake 401, when infrastructure fails mid-check', async () => {
    // A bogus 401 here would make the client wipe valid local state during an outage; this is the exact failure class
    // introduced by fail-closed lookups and it must be classified as transient.
    isJtiBlacklisted.mockRejectedValue(new Error('revocation lookup failed for jti j-err…: PGRST205 table not found'));

    const oldRefresh = jwt.sign({ id: 'u1', jti: 'j-err' }, REFRESH_SECRET, { expiresIn: '30d' });
    const response = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: oldRefresh });

    expect(response.statusCode).toBe(503);
    expect(response.body.message).toMatch(/temporarily unavailable/i);
  });

  test('refresh returns transient 503, not a misleading 401, when the PROFILE lookup itself fails', async () => {
    // Same contract as the middleware: an outage reading the profile row must never masquerade as bad credentials —
    // a bogus 401 here would wipe valid local state on every in-flight client during the outage.
    isJtiBlacklisted.mockResolvedValue(false);
    UserService.findById.mockRejectedValue(new Error('PGRST205: relation "public.profiles" does not exist'));

    const oldRefresh = jwt.sign({ id: 'u1', jti: 'j-profile' }, REFRESH_SECRET, { expiresIn: '30d' });
    const response = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: oldRefresh });

    expect(response.statusCode).toBe(503);
    expect(response.body.message).toMatch(/temporarily unavailable/i);
  });
});
