// Tests for the social sign-in entry points and the one-time code exchange.
jest.mock('../middleware/auth', () => ({ auth: (req, res, next) => next() }));
jest.mock('../config/passport', () => ({
  passport: { initialize: () => (req, res, next) => next(), authenticate: jest.fn() },
  googleEnabled: false,
  githubEnabled: false
}));
jest.mock('../services/revocation', () => ({
  isJtiBlacklisted: jest.fn(),
  revokeJti: jest.fn()
}));
jest.mock('../utils/token', () => ({
  generateTokens: jest.fn(),
  sendTokenResponse: jest.fn()
}));
jest.mock('../services/mailerService', () => ({
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn()
}));
jest.mock('../services/emailTokenService', () => ({
  issue: jest.fn(),
  consume: jest.fn(),
  revokeAllForUser: jest.fn(),
  PURPOSE: { VERIFY_EMAIL: 'verify_email', RESET_PASSWORD: 'reset_password' }
}));
jest.mock('../services/supabaseService', () => ({
  UserService: {
    findById: jest.fn(),
    findByEmail: jest.fn(),
    updatePassword: jest.fn(),
    markVerified: jest.fn()
  }
}));
jest.mock('../services/oauthService', () => ({
  linkOrCreate: jest.fn(),
  isPlatformAccount: jest.fn(() => false),
  PLATFORM_USER_ID: '00000000-0000-4000-8000-000000000001'
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { isJtiBlacklisted, revokeJti } = require('../services/revocation');
const { generateTokens } = require('../utils/token');
const { UserService } = require('../services/supabaseService');
const oauth = require('../services/oauthService');
const authRoutes = require('./authRoutes');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

const SECRET = 'test-oauth-secret';
let originalSecret;

beforeAll(() => {
  originalSecret = process.env.JWT_SECRET ?? null;
  process.env.JWT_SECRET = SECRET;
});

afterAll(() => {
  if (originalSecret === null) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});

beforeEach(() => {
  jest.clearAllMocks();
  oauth.isPlatformAccount.mockReturnValue(false);
  revokeJti.mockResolvedValue(true);
  generateTokens.mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' });
});

const signCode = (claims, options = { expiresIn: '2m' }) => jwt.sign(claims, SECRET, options);

describe('provider entry points', () => {
  test('google answers 503 when it is not configured', async () => {
    const res = await request(app).get('/api/auth/google');
    expect(res.status).toBe(503);
  });

  test('github answers 503 when it is not configured', async () => {
    const res = await request(app).get('/api/auth/github');
    expect(res.status).toBe(503);
  });
});

describe('POST /api/auth/oauth/exchange', () => {
  test('requires a code', async () => {
    const res = await request(app).post('/api/auth/oauth/exchange').send({});
    expect(res.status).toBe(400);
  });

  test('rejects a code signed with another secret', async () => {
    const bad = jwt.sign({ id: 'u-1', purpose: 'oauth_exchange', jti: 'j-1' }, 'wrong-secret', { expiresIn: '2m' });
    const res = await request(app).post('/api/auth/oauth/exchange').send({ code: bad });
    expect(res.status).toBe(401);
  });

  test('rejects a token that is not an exchange code', async () => {
    const code = signCode({ id: 'u-1', jti: 'j-1' });
    const res = await request(app).post('/api/auth/oauth/exchange').send({ code });
    expect(res.status).toBe(401);
  });

  test('rejects a code that was already spent', async () => {
    isJtiBlacklisted.mockResolvedValue(true);
    const code = signCode({ id: 'u-1', purpose: 'oauth_exchange', jti: 'j-used' });

    const res = await request(app).post('/api/auth/oauth/exchange').send({ code });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Code already used');
    expect(generateTokens).not.toHaveBeenCalled();
  });

  test('exchanges a valid code once and revokes it', async () => {
    isJtiBlacklisted.mockResolvedValue(false);
    UserService.findById.mockResolvedValue({
      id: 'u-1', email: 'a@example.com', fullName: 'A', role: 'renter', isActive: true
    });
    const code = signCode({ id: 'u-1', purpose: 'oauth_exchange', jti: 'j-fresh' });

    const res = await request(app).post('/api/auth/oauth/exchange').send({ code });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('access');
    expect(res.body.refreshToken).toBe('refresh');
    expect(revokeJti).toHaveBeenCalledWith('j-fresh', expect.objectContaining({ userId: 'u-1' }));
  });

  test('refuses to mint a session for the platform account', async () => {
    isJtiBlacklisted.mockResolvedValue(false);
    UserService.findById.mockResolvedValue({ id: 'u-1', isActive: true });
    oauth.isPlatformAccount.mockReturnValue(true);
    const code = signCode({ id: 'u-1', purpose: 'oauth_exchange', jti: 'j-x' });

    const res = await request(app).post('/api/auth/oauth/exchange').send({ code });

    expect(res.status).toBe(403);
    expect(generateTokens).not.toHaveBeenCalled();
  });
});

describe('platform account cannot sign in with a password', () => {
  test('login answers 403 even with valid credentials', async () => {
    UserService.findByEmail.mockResolvedValue({
      id: 'platform', email: 'platform@veloxora.com', isActive: true, passwordHash: 'x'
    });
    UserService.comparePassword = jest.fn().mockResolvedValue(true);
    oauth.isPlatformAccount.mockReturnValue(true);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'platform@veloxora.com', password: 'whatever' });

    expect(res.status).toBe(403);
  });
});
