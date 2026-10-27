// Catalog routes: purpose catalog, availability, and provider-only writes.
let mockUser;

jest.mock('../middleware/auth', () => ({
  auth: (req, res, next) => {
    if (!mockUser) return res.status(401).json({ message: 'No token' });
    req.user = mockUser;
    next();
  },
  providerAuth: (req, res, next) => {
    if (!mockUser) return res.status(401).json({ message: 'No token' });
    if (!['provider', 'admin'].includes(mockUser.role)) {
      return res.status(403).json({ message: 'Access denied. Provider only.' });
    }
    req.user = mockUser;
    next();
  }
}));

jest.mock('../services/catalogService', () => {
  class CatalogError extends Error {
    constructor(message, code = 'invalid_catalog', status = 400) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  class CatalogUnavailable extends CatalogError {
    constructor() {
      super('The catalog is not available on this deployment yet (migration 012 not applied).',
        'catalog_unavailable', 503);
    }
  }
  return {
    CatalogError,
    CatalogUnavailable,
    listPurposes: jest.fn(),
    getListingCatalog: jest.fn(),
    replacePurposes: jest.fn(),
    replaceSoftware: jest.fn(),
    setAccessMethods: jest.fn(),
    describeAvailability: jest.fn(),
    replaceAvailability: jest.fn(),
    addBlackout: jest.fn(),
    removeBlackout: jest.fn()
  };
});

const express = require('express');
const request = require('supertest');

const catalog = require('../services/catalogService');
const catalogRoutes = require('./catalogRoutes');

const app = express();
app.use(express.json());
app.use('/api', catalogRoutes);

const LISTING_ID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'provider-1', role: 'provider' };
});

describe('GET /api/purposes', () => {
  test('is public and exposes the enabled flag per purpose', async () => {
    mockUser = null;
    catalog.listPurposes.mockResolvedValue([
      { key: 'training', labelEn: 'Model training', enabled: true },
      { key: 'mining', labelEn: 'Mining-friendly', enabled: false }
    ]);

    const res = await request(app).get('/api/purposes');

    expect(res.status).toBe(200);
    expect(res.body.purposes).toHaveLength(2);
    expect(res.body.purposes[1]).toMatchObject({ key: 'mining', enabled: false });
  });
});

describe('GET /api/listings/:id/availability', () => {
  test('rejects a malformed id before touching the catalog', async () => {
    const res = await request(app).get('/api/listings/not-a-uuid/availability');

    expect(res.status).toBe(400);
    expect(catalog.describeAvailability).not.toHaveBeenCalled();
  });

  test('returns the public availability view', async () => {
    mockUser = null;
    catalog.describeAvailability.mockResolvedValue({
      restricted: true, timezone: 'UTC', openNow: false, nextOpeningAt: '2026-10-28T08:00:00.000Z',
      windows: [{ weekday: 3, startMinute: 480, endMinute: 1080 }], blackouts: [], busy: []
    });

    const res = await request(app).get(`/api/listings/${LISTING_ID}/availability`);

    expect(res.status).toBe(200);
    expect(res.body.availability).toMatchObject({ openNow: false, restricted: true });
  });
});

describe('provider-only catalog writes', () => {
  test('a renter cannot change purposes', async () => {
    mockUser = { id: 'renter-1', role: 'renter' };

    const res = await request(app)
      .put(`/api/listings/${LISTING_ID}/purposes`)
      .send({ purposes: [{ key: 'training' }] });

    expect(res.status).toBe(403);
    expect(catalog.replacePurposes).not.toHaveBeenCalled();
  });

  test('saves purposes for the owner', async () => {
    catalog.replacePurposes.mockResolvedValue({ purposes: [{ key: 'training' }], software: [], accessMethods: ['ssh'] });

    const res = await request(app)
      .put(`/api/listings/${LISTING_ID}/purposes`)
      .send({ purposes: [{ key: 'training', pricePerHour: 2.5 }] });

    expect(res.status).toBe(200);
    expect(catalog.replacePurposes).toHaveBeenCalledWith({
      listingId: LISTING_ID,
      providerId: 'provider-1',
      purposes: [{ key: 'training', pricePerHour: 2.5 }]
    });
  });

  test('maps a validation error to its status and stable code', async () => {
    catalog.replacePurposes.mockRejectedValue(
      new catalog.CatalogError('Mining listings must set their own price per hour', 'mining_price_required', 400)
    );

    const res = await request(app)
      .put(`/api/listings/${LISTING_ID}/purposes`)
      .send({ purposes: [{ key: 'mining' }] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('mining_price_required');
  });

  test('answers 503 (not 500) while migration 012 is pending', async () => {
    catalog.replaceSoftware.mockRejectedValue(new catalog.CatalogUnavailable());

    const res = await request(app)
      .put(`/api/listings/${LISTING_ID}/software`)
      .send({ software: [] });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('catalog_unavailable');
  });

  test('validates the blackout id and 404s a missing one', async () => {
    catalog.removeBlackout.mockResolvedValue(false);

    const bad = await request(app).delete(`/api/listings/${LISTING_ID}/blackouts/nope`);
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .delete(`/api/listings/${LISTING_ID}/blackouts/22222222-3333-4444-5555-666666666666`);
    expect(missing.status).toBe(404);
  });
});
