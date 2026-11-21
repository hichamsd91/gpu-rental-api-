const express = require('express');
const request = require('supertest');

let mockUser;

jest.mock('../middleware/auth', () => ({
  auth: (req, res, next) => {
    req.user = mockUser;
    next();
  }
}));

jest.mock('../services/supabaseService', () => ({
  RentalService: {
    findAll: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    startRental: jest.fn(),
    endRental: jest.fn(),
    cancelRental: jest.fn(),
  },
  GpuListingService: {
    findById: jest.fn(),
    update: jest.fn(),
  },
}));

// Phase 2 guards: availability/conflict lookups default to "open and free" so
// the pre-existing lifecycle tests keep testing exactly what they were written
// for; the new tests below override per case.
jest.mock('../services/catalogService', () => ({
  getAvailabilityRows: jest.fn(async () => ({ windows: [], blackouts: [] })),
  isWindowOpen: jest.fn(() => true),
  findNextOpening: jest.fn(() => null),
  findConflicts: jest.fn(async () => []),
}));

jest.mock('../services/featureFlagService', () => ({
  isEnabled: jest.fn(async () => true),
  enabledMap: jest.fn(async () => ({})),
}));

// The job routes talk to the queue service; keep this suite about the HTTP
// contract (signed link, status codes, headers) with a controlled stub.
jest.mock('../services/jobService', () => {
  class JobError extends Error {
    constructor(message, code, status = 400) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return {
    JobError,
    PURPOSE_KINDS: { rendering: ['render.mandelbrot'], compute: ['compute.matmul'] },
    findByRental: jest.fn(),
    forRenter: jest.fn((job) => job),
    getArtifact: jest.fn(),
    artifactLinkValid: jest.fn(),
    submit: jest.fn(),
  };
});

const { RentalService, GpuListingService } = require('../services/supabaseService');
const catalog = require('../services/catalogService');
const featureFlags = require('../services/featureFlagService');
const jobs = require('../services/jobService');
const rentalRoutes = require('./rentalRoutes');

const app = express();
app.use(express.json());
app.use('/api/rentals', rentalRoutes);

describe('rental lifecycle hardening', () => {
  // /api/rentals/:id only accepts uuids (router.param guard).
  const RENTAL_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    mockUser = { id: 'renter-1', role: 'renter' };
    jest.clearAllMocks();
  });

  test('rejects planned durations outside listing bounds', async () => {
    GpuListingService.findById.mockResolvedValue({
      id: 'listing-1',
      status: 'active',
      minRentalMinutes: 30,
      maxRentalHours: 2,
      pricePerHour: 10,
      providerId: 'provider-1'
    });

    const response = await request(app)
      .post('/api/rentals')
      .send({ listingId: 'listing-1', plannedDurationMinutes: 15 });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/at least 30/);
    expect(RentalService.create).not.toHaveBeenCalled();
  });

  test('does not allow another renter to start a rental', async () => {
    RentalService.findById.mockResolvedValue({
      id: RENTAL_ID,
      renterId: 'renter-2',
      providerId: 'provider-1',
      status: 'pending'
    });

    const response = await request(app).post(`/api/rentals/${RENTAL_ID}/start`);

    expect(response.status).toBe(403);
    expect(RentalService.startRental).not.toHaveBeenCalled();
  });

  test('allows only one concurrent start to claim a listing', async () => {
    let callCount = 0;
    RentalService.findById.mockImplementation(async (id) => {
      callCount += 1;
      // First call: return pending, second call: return pending (simulating race condition)
      return {
        id: RENTAL_ID,
        listingId: 'listing-1',
        renterId: 'renter-1',
        providerId: 'provider-1',
        status: 'pending'
      };
    });
    
    let startCallCount = 0;
    RentalService.startRental.mockImplementation(async (id, renterId) => {
      startCallCount += 1;
      if (startCallCount === 1) {
        return {
          id: RENTAL_ID,
          listingId: 'listing-1',
          renterId: 'renter-1',
          providerId: 'provider-1',
          status: 'active',
          startTime: new Date()
        };
      }
      // Simulate Supabase constraint violation when listing already rented
      const error = new Error('Rental cannot be started');
      error.code = 'PGRST116';
      throw error;
    });

    const responses = await Promise.all([
      request(app).post(`/api/rentals/${RENTAL_ID}/start`),
      request(app).post(`/api/rentals/${RENTAL_ID}/start`)
    ]);

    // Current implementation returns 500 for generic errors (could be improved to 409)
    expect(responses.map(response => response.status).sort()).toEqual([200, 500]);
    // startRental should be called twice (once success, once failure)
    expect(RentalService.startRental).toHaveBeenCalledTimes(2);
  });

  test('maps a wallet-insufficient rejection from start to 402 with a stable code', async () => {
    RentalService.findById.mockResolvedValue({
      id: RENTAL_ID,
      renterId: 'renter-1',
      providerId: 'provider-1',
      status: 'pending'
    });

    const err = new Error('Insufficient wallet balance');
    err.code = 'WALLET_INSUFFICIENT';
    err.required = 2.5;
    err.available = 0;
    RentalService.startRental.mockRejectedValue(err);

    const response = await request(app).post(`/api/rentals/${RENTAL_ID}/start`).send({ plannedMinutes: 60 });

    expect(response.status).toBe(402);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('WALLET_INSUFFICIENT');
    expect(typeof response.body.message).toBe('string');
    // Numbers pass through verbatim so the client can localize {required}/{available}
    expect(response.body.required).toBe(2.5);
    expect(response.body.available).toBe(0);
    expect(RentalService.endRental).not.toHaveBeenCalled();
  });
});

describe('POST /api/rentals — purposes, availability and mining (Phase 2)', () => {
  const baseListing = {
    id: 'listing-1',
    status: 'active',
    minRentalMinutes: 30,
    maxRentalHours: 168,
    pricePerHour: 10,
    providerId: 'provider-1',
    purposes: [
      { key: 'inference', pricePerHour: null, specs: {} },
      { key: 'mining', pricePerHour: 3.5, specs: { powerCapWatts: 320, disclosure: 'Declared 320W continuous load, 78 dB fans, 99% uptime.' } }
    ]
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'renter-1', role: 'renter' };
    catalog.getAvailabilityRows.mockResolvedValue({ windows: [], blackouts: [] });
    catalog.isWindowOpen.mockReturnValue(true);
    catalog.findConflicts.mockResolvedValue([]);
    featureFlags.isEnabled.mockResolvedValue(true);
    RentalService.create.mockImplementation(async (data) => ({ id: 'rental-new', ...data }));
    GpuListingService.findById.mockResolvedValue(baseListing);
  });

  test('bills a purpose that carries its own price', async () => {
    const response = await request(app)
      .post('/api/rentals')
      .send({ listingId: 'listing-1', plannedDurationMinutes: 60, purpose: 'mining', miningAcknowledged: true });

    expect(response.status).toBe(201);
    expect(RentalService.create).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'mining', estimatedCost: 3.5 }),
      'renter-1'
    );
  });

  test('falls back to the base price for a purpose without an override', async () => {
    await request(app)
      .post('/api/rentals')
      .send({ listingId: 'listing-1', plannedDurationMinutes: 60, purpose: 'inference' });

    expect(RentalService.create).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'inference', estimatedCost: 10 }),
      'renter-1'
    );
  });

  test('refuses a purpose the listing does not offer', async () => {
    const response = await request(app)
      .post('/api/rentals')
      .send({ listingId: 'listing-1', plannedDurationMinutes: 60, purpose: 'rendering' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('purpose_not_offered');
    expect(RentalService.create).not.toHaveBeenCalled();
  });

  test('refuses mining without the renter acknowledgement', async () => {
    const response = await request(app)
      .post('/api/rentals')
      .send({ listingId: 'listing-1', plannedDurationMinutes: 60, purpose: 'mining' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('mining_ack_required');
    expect(RentalService.create).not.toHaveBeenCalled();
  });

  test('refuses mining when the platform flag is off (D2 kill switch)', async () => {
    featureFlags.isEnabled.mockResolvedValue(false);

    const response = await request(app)
      .post('/api/rentals')
      .send({ listingId: 'listing-1', plannedDurationMinutes: 60, purpose: 'mining', miningAcknowledged: true });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('mining_disabled');
    expect(RentalService.create).not.toHaveBeenCalled();
  });

  test('answers 409 when the requested window is outside the provider hours', async () => {
    catalog.isWindowOpen.mockReturnValue(false);
    catalog.findNextOpening.mockReturnValue('2026-10-28T08:00:00.000Z');

    const response = await request(app)
      .post('/api/rentals')
      .send({ listingId: 'listing-1', plannedDurationMinutes: 60 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('listing_closed');
    expect(response.body.nextOpeningAt).toBe('2026-10-28T08:00:00.000Z');
    expect(RentalService.create).not.toHaveBeenCalled();
  });

  test('answers 409 when another rental already holds the window', async () => {
    catalog.findConflicts.mockResolvedValue([
      { id: 'r-other', start_time: new Date().toISOString(), end_time: new Date(Date.now() + 3600000).toISOString() }
    ]);

    const response = await request(app)
      .post('/api/rentals')
      .send({ listingId: 'listing-1', plannedDurationMinutes: 60 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('listing_busy');
    expect(RentalService.create).not.toHaveBeenCalled();
  });

  test('legacy listing without purposes still books at the base price', async () => {
    GpuListingService.findById.mockResolvedValue({ ...baseListing, purposes: [] });

    const response = await request(app)
      .post('/api/rentals')
      .send({ listingId: 'listing-1', plannedDurationMinutes: 60 });

    expect(response.status).toBe(201);
    expect(RentalService.create).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: null, estimatedCost: 10 }),
      'renter-1'
    );
  });
});

describe('POST /api/rentals/:id/end — provider guard + retired free tier', () => {
  const RENTAL_ID = '44444444-4444-4444-8444-444444444444';

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'renter-1', role: 'renter' };
    RentalService.endRental.mockResolvedValue({ id: RENTAL_ID, status: 'ended' });
  });

  test('free ad-supported sessions are gone (410, no rental created)', async () => {
    const response = await request(app)
      .post('/api/rentals/free')
      .send({ listingId: 'listing-1' });

    expect(response.status).toBe(410);
    expect(response.body.code).toBe('free_sessions_retired');
    expect(RentalService.create).not.toHaveBeenCalled();
  });

  test('a provider must declare why they ended the session', async () => {
    mockUser = { id: 'provider-1', role: 'provider' };

    const response = await request(app)
      .post(`/api/rentals/${RENTAL_ID}/end`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('provider_reason_required');
    expect(RentalService.endRental).not.toHaveBeenCalled();
  });

  test('a provider cannot end a session as "completed"', async () => {
    mockUser = { id: 'provider-1', role: 'provider' };

    const response = await request(app)
      .post(`/api/rentals/${RENTAL_ID}/end`)
      .send({ reason: 'completed' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('provider_reason_required');
  });

  test('a declared provider end is recorded and settles with compensation', async () => {
    mockUser = { id: 'provider-1', role: 'provider' };

    const response = await request(app)
      .post(`/api/rentals/${RENTAL_ID}/end`)
      .send({ reason: 'hardware_failure' });

    expect(response.status).toBe(200);
    expect(RentalService.endRental).toHaveBeenCalledWith(
      RENTAL_ID,
      'provider-1',
      'provider',
      'provider_ended:hardware_failure'
    );
  });

  test('the renter always ends their own session without a reason', async () => {
    const response = await request(app)
      .post(`/api/rentals/${RENTAL_ID}/end`)
      .send({});

    expect(response.status).toBe(200);
    expect(RentalService.endRental).toHaveBeenCalledWith(
      RENTAL_ID,
      'renter-1',
      'renter',
      'renter_ended'
    );
  });

  test('admin ends stay neutral (no provider penalty)', async () => {
    mockUser = { id: 'admin-1', role: 'admin' };

    await request(app).post(`/api/rentals/${RENTAL_ID}/end`).send({});

    expect(RentalService.endRental).toHaveBeenCalledWith(
      RENTAL_ID,
      'admin-1',
      'admin',
      'admin_ended'
    );
  });
});

describe('GET /api/rentals/:id (owner-scoped read)', () => {
  // Route params are uuids in production, so the fixtures have to be uuids too:
  // the router.param guard rejects anything else before the handler runs.
  const RENTAL_ID = '22222222-2222-4222-8222-222222222222';
  const MISSING_ID = '33333333-3333-4333-8333-333333333333';
  const rental = { id: RENTAL_ID, renterId: 'u-renter', providerId: 'u-provider', status: 'active' };

  beforeEach(() => {
    jest.clearAllMocks();
    RentalService.findById.mockResolvedValue(rental);
  });

  test('returns the row to its own renter', async () => {
    mockUser = { id: 'u-renter', role: 'renter' };

    const response = await request(app).get(`/api/rentals/${RENTAL_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.rental.id).toBe(RENTAL_ID);
  });

  test("returns the row to its own provider", async () => {
    mockUser = { id: 'u-provider', role: 'provider' };

    const response = await request(app).get(`/api/rentals/${RENTAL_ID}`);

    expect(response.status).toBe(200);
  });

  test('returns the row to an admin', async () => {
    mockUser = { id: 'u-admin', role: 'admin' };

    const response = await request(app).get(`/api/rentals/${RENTAL_ID}`);

    expect(response.status).toBe(200);
  });

  test('blocks a stranger (403) and answers a missing row with a clean 404', async () => {
    mockUser = { id: 'u-other', role: 'renter' };

    const denied = await request(app).get(`/api/rentals/${RENTAL_ID}`);
    expect(denied.status).toBe(403);

    RentalService.findById.mockResolvedValue(null);
    const missing = await request(app).get(`/api/rentals/${MISSING_ID}`);
    expect(missing.status).toBe(404);
  });

  test('rejects a non-uuid id with 400 before touching the database', async () => {
    mockUser = { id: 'u-admin', role: 'admin' };

    const response = await request(app).get('/api/rentals/not-a-uuid');

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Invalid rental id');
    expect(RentalService.findById).not.toHaveBeenCalled();
  });

  test('rejects a non-uuid id on mutating routes too', async () => {
    mockUser = { id: 'u-renter', role: 'renter' };

    const ended = await request(app).post('/api/rentals/nope/end').send({});
    expect(ended.status).toBe(400);

    const events = await request(app).post('/api/rentals/123/cancel').send({});
    expect(events.status).toBe(400);

    expect(RentalService.endRental).not.toHaveBeenCalled();
  });
});

describe('job artifact delivery over a signed link', () => {
  const RENTAL_ID = '11111111-1111-4111-8111-111111111111';
  const png = Buffer.from('89504e470d0a1a0a', 'hex');

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'renter-1', role: 'renter' };
  });

  test('serves the exact bytes with download headers', async () => {
    jobs.artifactLinkValid.mockReturnValue(true);
    jobs.getArtifact.mockResolvedValue({ mime: 'image/png', filename: 'frame.png', bytes: png });

    const res = await request(app).get(`/api/rentals/${RENTAL_ID}/job/artifact?exp=1&sig=x`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="frame.png"');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Buffer.from(res.body).equals(png)).toBe(true);
  });

  test('a wrong, edited or expired signature is refused before reading the artifact', async () => {
    jobs.artifactLinkValid.mockReturnValue(false);

    const res = await request(app).get(`/api/rentals/${RENTAL_ID}/job/artifact?exp=1&sig=00`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('artifact_link_invalid');
    expect(jobs.getArtifact).not.toHaveBeenCalled();
  });

  test('a valid link with no stored artifact is an honest 404', async () => {
    jobs.artifactLinkValid.mockReturnValue(true);
    jobs.getArtifact.mockResolvedValue(null);

    const res = await request(app).get(`/api/rentals/${RENTAL_ID}/job/artifact?exp=1&sig=x`);
    expect(res.status).toBe(404);
  });

  test('the renter read attaches a link built from the request origin', async () => {
    RentalService.findById.mockResolvedValue({ id: RENTAL_ID, renterId: 'renter-1', providerId: 'p-1', purpose: 'rendering' });
    jobs.findByRental.mockResolvedValue({ rentalId: RENTAL_ID, status: 'succeeded' });
    jobs.forRenter.mockImplementation((job, origin) => ({ ...job, origin }));

    const res = await request(app).get(`/api/rentals/${RENTAL_ID}/job`);
    expect(res.status).toBe(200);
    expect(jobs.forRenter).toHaveBeenCalledWith(expect.objectContaining({ rentalId: RENTAL_ID }), expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/));
    expect(res.body.job.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
