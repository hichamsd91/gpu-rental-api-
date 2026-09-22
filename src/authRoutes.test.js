const request = require('supertest');
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

const { UserService } = require('./services/supabaseService');

describe('auth routes', () => {
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
});