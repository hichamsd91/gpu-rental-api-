// Active-session inventory: the list, single revoke, and "revoke everything else".
jest.mock('../middleware/auth', () => ({
  auth: (req, res, next) => {
    req.user = { id: 'u-1', email: 'a@b.c', role: 'renter' };
    req.authJti = 'jti-current';
    next();
  }
}));
jest.mock('../services/sessionService', () => ({
  listActive: jest.fn(),
  revokeOne: jest.fn(),
  revokeAllExcept: jest.fn(),
  SessionsUnavailable: class SessionsUnavailable extends Error {}
}));

const express = require('express');
const request = require('supertest');

const sessions = require('../services/sessionService');
const authRoutes = require('./authRoutes');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

beforeEach(() => jest.clearAllMocks());

describe('GET /api/auth/sessions', () => {
  test('marks the calling session as current and never leaks the jti', async () => {
    sessions.listActive.mockResolvedValue([
      {
        id: 's-1', jti: 'jti-current', user_agent: 'Chrome on Windows',
        ip_address: '1.2.3.4', created_at: '2026-10-26T10:00:00Z', last_seen_at: '2026-10-26T11:00:00Z'
      },
      {
        id: 's-2', jti: 'jti-other', user_agent: 'Safari on iPhone',
        ip_address: '5.6.7.8', created_at: '2026-10-25T09:00:00Z', last_seen_at: '2026-10-25T10:00:00Z'
      }
    ]);

    const res = await request(app).get('/api/auth/sessions');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions[0]).toMatchObject({ id: 's-1', current: true });
    expect(res.body.sessions[1]).toMatchObject({ id: 's-2', current: false });
    // The jti is the revocation secret — it must never reach the client.
    expect(JSON.stringify(res.body)).not.toContain('jti-current');
    expect(JSON.stringify(res.body)).not.toContain('jti-other');
  });

  test('answers 503 with a clear code when migration 011 is not applied', async () => {
    sessions.listActive.mockRejectedValue(new sessions.SessionsUnavailable('not available'));

    const res = await request(app).get('/api/auth/sessions');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('sessions_unavailable');
  });
});

describe('POST /api/auth/sessions/:id/revoke', () => {
  const goodId = '11111111-2222-3333-4444-555555555555';

  test('rejects a malformed id before touching the database', async () => {
    const res = await request(app).post('/api/auth/sessions/not-a-uuid/revoke');
    expect(res.status).toBe(400);
    expect(sessions.revokeOne).not.toHaveBeenCalled();
  });

  test('answers 404 for a session that is missing or owned by somebody else', async () => {
    sessions.revokeOne.mockResolvedValue(false);

    const res = await request(app).post(`/api/auth/sessions/${goodId}/revoke`);

    expect(res.status).toBe(404);
    expect(sessions.revokeOne).toHaveBeenCalledWith({ userId: 'u-1', sessionId: goodId });
  });

  test('ends the session', async () => {
    sessions.revokeOne.mockResolvedValue(true);

    const res = await request(app).post(`/api/auth/sessions/${goodId}/revoke`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/auth/sessions/revoke-others', () => {
  test('keeps the calling session and reports how many died', async () => {
    sessions.revokeAllExcept.mockResolvedValue(2);

    const res = await request(app).post('/api/auth/sessions/revoke-others');

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(2);
    expect(sessions.revokeAllExcept).toHaveBeenCalledWith({ userId: 'u-1', keepJti: 'jti-current' });
  });
});
