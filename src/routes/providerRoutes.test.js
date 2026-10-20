const express = require('express');
const request = require('supertest');

let mockUser;

// The real middleware's role gate lives in auth.js and is covered there end-to-end — the
// route under test can trust it, so this stub faithfully plays "authenticated provider".
jest.mock('../middleware/auth', () => ({
  providerAuth: (req, res, next) => {
    req.user = mockUser;
    next();
  }
}));

jest.mock('../services/supabaseService', () => ({
  GpuListingService: {
    findAll: jest.fn(),
  },
}));

const { GpuListingService } = require('../services/supabaseService');
const providerRoutes = require('./providerRoutes');

const app = express();
app.use(express.json());
app.use('/api/provider', providerRoutes);

describe('GET /api/provider/listings (owner-scoped)', () => {
  beforeEach(() => {
    mockUser = { id: 'provider-1', role: 'provider' };
    jest.clearAllMocks();
  });

  test('scopes the query to the authenticated provider only — never a client-supplied id', async () => {
    GpuListingService.findAll.mockResolvedValue({
      listings: [
        { id: 'l1', status: 'paused' }, // paused rows MUST be visible to their owner
        { id: 'l2', status: 'active', isPublic: false } // private too
      ],
      pagination: { page: 1, limit: 20, total: 2, pages: 1 }
    });

    const response = await request(app)
      .get('/api/provider/listings?limit=5')
      .query({ providerId: 'someone-else' }); // client-side attempt to widen scope — must be ignored

    expect(response.status).toBe(200);
    expect(GpuListingService.findAll).toHaveBeenCalledTimes(1);
    const [filters, options] = GpuListingService.findAll.mock.calls[0];
    expect(filters.providerId).toBe('provider-1'); // hard-scoped to req.user.id
    expect(options.limit).toBe(5);

    // Own listings of ANY status come back; metadata is nested under `pagination`.
    expect(response.body.success).toBe(true);
    expect(response.body.pagination.total).toBe(2);
    expect(response.body.listings.map((l) => l.status)).toEqual(['paused', 'active']);
  });

  test('caps the page limit at 50 (abuse guard, mirrors the public endpoint)', async () => {
    GpuListingService.findAll.mockResolvedValue({ listings: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } });

    await request(app).get('/api/provider/listings?limit=999');

    const [, options] = GpuListingService.findAll.mock.calls[0];
    expect(options.limit).toBe(50);
  });

  test('answers a plain 500 on service failure — no stack leak', async () => {
    GpuListingService.findAll.mockRejectedValue(new Error('boom'));

    const response = await request(app).get('/api/provider/listings');

    expect(response.status).toBe(500);
    expect(response.body.message).toBe('Server error');
  });
});
