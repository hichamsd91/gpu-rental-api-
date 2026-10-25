// Focused tests for the email-verification and password-reset endpoints.
jest.mock('../middleware/auth', () => ({
  auth: (req, res, next) => {
    req.user = { id: 'u-1', email: 'a@b.c', role: 'renter' };
    next();
  }
}));
jest.mock('../services/revocation', () => ({ isJtiBlacklisted: jest.fn(), revokeJti: jest.fn() }));
jest.mock('../utils/token', () => ({ generateTokens: jest.fn(), sendTokenResponse: jest.fn() }));
jest.mock('../services/mailerService', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue({ sent: true }),
  sendPasswordResetEmail: jest.fn().mockResolvedValue({ sent: true })
}));
jest.mock('../services/emailTokenService', () => ({
  issue: jest.fn(),
  consume: jest.fn(),
  revokeAllForUser: jest.fn().mockResolvedValue(true),
  PURPOSE: { VERIFY_EMAIL: 'verify_email', RESET_PASSWORD: 'reset_password' }
}));
jest.mock('../services/supabaseService', () => ({
  UserService: {
    findByEmail: jest.fn(),
    markVerified: jest.fn(),
    updatePassword: jest.fn()
  }
}));

const express = require('express');
const request = require('supertest');

const { UserService } = require('../services/supabaseService');
const emailTokens = require('../services/emailTokenService');
const mailer = require('../services/mailerService');
const authRoutes = require('./authRoutes');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

beforeEach(() => jest.clearAllMocks());

describe('POST /api/auth/verify-email/resend', () => {
  test('issues a token and sends a verification email', async () => {
    emailTokens.issue.mockResolvedValue('raw-token');
    const response = await request(app).post('/api/auth/verify-email/resend');

    expect(response.status).toBe(200);
    expect(emailTokens.issue).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'verify_email' }));
    expect(mailer.sendVerificationEmail).toHaveBeenCalled();
  });
});

describe('GET /api/auth/verify-email', () => {
  test('marks the user verified on a valid token', async () => {
    emailTokens.consume.mockResolvedValue('u-1');
    UserService.markVerified.mockResolvedValue(true);

    const response = await request(app).get('/api/auth/verify-email').query({ token: 'ok' });

    expect(response.status).toBe(200);
    expect(UserService.markVerified).toHaveBeenCalledWith('u-1');
  });

  test('rejects a missing token', async () => {
    const response = await request(app).get('/api/auth/verify-email');
    expect(response.status).toBe(400);
  });

  test('rejects an invalid/expired token', async () => {
    emailTokens.consume.mockResolvedValue(null);
    const response = await request(app).get('/api/auth/verify-email').query({ token: 'bad' });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/auth/forgot-password', () => {
  test('sends a reset link when the account exists', async () => {
    UserService.findByEmail.mockResolvedValue({ id: 'u-1', email: 'a@example.com' });
    emailTokens.issue.mockResolvedValue('token');

    const response = await request(app).post('/api/auth/forgot-password').send({ email: 'a@example.com' });

    expect(response.status).toBe(200);
    expect(emailTokens.issue).toHaveBeenCalledWith({ userId: 'u-1', purpose: 'reset_password' });
    expect(mailer.sendPasswordResetEmail).toHaveBeenCalled();
  });

  test('answers identically for an unknown email (no enumeration)', async () => {
    UserService.findByEmail.mockResolvedValue(null);

    const response = await request(app).post('/api/auth/forgot-password').send({ email: 'ghost@example.com' });

    expect(response.status).toBe(200);
    expect(emailTokens.issue).not.toHaveBeenCalled();
    expect(mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/reset-password', () => {
  test('resets the password on a valid token', async () => {
    emailTokens.consume.mockResolvedValue('u-1');
    UserService.updatePassword.mockResolvedValue(true);

    const response = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'ok', newPassword: 'NewPass123' });

    expect(response.status).toBe(200);
    expect(UserService.updatePassword).toHaveBeenCalledWith('u-1', 'NewPass123');
  });

  test('rejects an invalid token', async () => {
    emailTokens.consume.mockResolvedValue(null);

    const response = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'bad', newPassword: 'NewPass123' });

    expect(response.status).toBe(400);
  });

  test('rejects a short password', async () => {
    const response = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'ok', newPassword: 'short' });

    expect(response.status).toBe(400);
    expect(emailTokens.consume).not.toHaveBeenCalled();
  });
});
