const express = require('express');
const request = require('supertest');

let mockUser;

jest.mock('../middleware/auth', () => ({
  auth: (req, res, next) => {
    req.user = mockUser;
    next();
  },
  providerAuth: (req, res, next) => next()
}));

jest.mock('../services/supabaseService', () => ({
  GpuListingService: {
    findAll: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn()
  }
}));

const { GpuListingService } = require('../services/supabaseService');
const listingRoutes = require('./listingRoutes');

const app = express();
app.use(express.json());
app.use('/api/listings', listingRoutes);

const ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  mockUser = { id: 'provider-1', role: 'provider' };
  jest.clearAllMocks();
});

describe('GET /api/listings/:id (public visibility)', () => {
  test('rejects a malformed uuid with 400 before touching the database', async () => {
    const response = await request(app).get('/api/listings/not-a-uuid');

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Invalid listing id');
    expect(GpuListingService.findById).not.toHaveBeenCalled();
  });

  test('asks for a public-only row and returns 404 when it is hidden or paused', async () => {
    GpuListingService.findById.mockResolvedValue(null);

    const response = await request(app).get(`/api/listings/${ID}`);

    expect(response.status).toBe(404);
    expect(GpuListingService.findById).toHaveBeenCalledWith(ID, null, { publicOnly: true });
  });

  test('returns an active public listing', async () => {
    GpuListingService.findById.mockResolvedValue({
      id: ID,
      status: 'active',
      isPublic: true,
      pricePerHour: 1.25
    });

    const response = await request(app).get(`/api/listings/${ID}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.listing.id).toBe(ID);
  });
});

describe('PUT /api/listings/:id (owner scoping)', () => {
  test('rejects a malformed uuid with 400', async () => {
    const response = await request(app).put('/api/listings/not-a-uuid').send({ pricePerHour: 0.01 });

    expect(response.status).toBe(400);
    expect(GpuListingService.update).not.toHaveBeenCalled();
  });

  test('answers 404 when the id does not belong to the calling provider', async () => {
    GpuListingService.update.mockResolvedValue(null);

    const response = await request(app).put(`/api/listings/${ID}`).send({ pricePerHour: 0.01 });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Listing not found');
  });

  test('returns the updated listing for its owner', async () => {
    GpuListingService.update.mockResolvedValue({ id: ID, pricePerHour: 1.5 });

    const response = await request(app).put(`/api/listings/${ID}`).send({ pricePerHour: 1.5 });

    expect(response.status).toBe(200);
    expect(response.body.listing.pricePerHour).toBe(1.5);
    expect(GpuListingService.update).toHaveBeenCalledWith(ID, { pricePerHour: 1.5 }, 'provider-1');
  });
});

describe('DELETE /api/listings/:id (owner scoping)', () => {
  test('does not claim success when nothing was deleted', async () => {
    GpuListingService.delete.mockResolvedValue(false);

    const response = await request(app).delete(`/api/listings/${ID}`);

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Listing not found');
  });

  test('returns success only after a row was actually deleted', async () => {
    GpuListingService.delete.mockResolvedValue(true);

    const response = await request(app).delete(`/api/listings/${ID}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(GpuListingService.delete).toHaveBeenCalledWith(ID, 'provider-1');
  });

  test('answers a plain 500 on service failure', async () => {
    GpuListingService.delete.mockRejectedValue(new Error('boom'));

    const response = await request(app).delete(`/api/listings/${ID}`);

    expect(response.status).toBe(500);
    expect(response.body.message).toBe('Server error');
  });
});
