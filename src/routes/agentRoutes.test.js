// Worker-agent endpoints: the machine proves both who it works for (JWT) and
// which machine it is (a device it owns, matching the rental's listing). These
// tests pin that double check and the shapes the agent relies on.
const express = require('express');
const request = require('supertest');

let mockUser;

jest.mock('../middleware/auth', () => ({
  auth: (req, res, next) => { req.user = mockUser; next(); },
  providerAuth: (req, res, next) => { req.user = mockUser; next(); }
}));

jest.mock('../services/supabaseService', () => ({
  DeviceService: {
    findById: jest.fn(),
    updateHeartbeat: jest.fn()
  },
  GpuListingService: { findById: jest.fn() },
  RentalService: { findById: jest.fn() }
}));

jest.mock('../services/jobService', () => ({
  JobError: class JobError extends Error {
    constructor(message, code, status = 400) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  PURPOSE_KINDS: { rendering: ['render.mandelbrot'] },
  find: jest.fn(),
  findByRental: jest.fn(),
  pendingForDevice: jest.fn(),
  claim: jest.fn(),
  progress: jest.fn(),
  complete: jest.fn()
}));

const { DeviceService, GpuListingService, RentalService } = require('../services/supabaseService');
const jobService = require('../services/jobService');
const agentRoutes = require('./agentRoutes');

const app = express();
app.use(express.json());
app.use('/api/agent', agentRoutes);

const PROVIDER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const RENTAL_ID = '11111111-1111-4111-8111-111111111111';
const LISTING_ID = '66666666-6666-4666-8666-666666666666';

const owned = () => {
  mockUser = { id: PROVIDER_ID, role: 'provider' };
  DeviceService.findById.mockResolvedValue({ id: DEVICE_ID, userId: PROVIDER_ID });
  RentalService.findById.mockResolvedValue({
    id: RENTAL_ID, providerId: PROVIDER_ID, listingId: LISTING_ID, status: 'active'
  });
  GpuListingService.findById.mockResolvedValue({ id: LISTING_ID, deviceId: DEVICE_ID });
};

beforeEach(() => {
  jest.clearAllMocks();
  owned();
});

describe('POST /api/agent/heartbeat', () => {
  test('requires a device uuid', async () => {
    const res = await request(app).post('/api/agent/heartbeat').send({ stats: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('device_required');
  });

  test('refuses a device owned by someone else', async () => {
    DeviceService.findById.mockResolvedValue({ id: DEVICE_ID, userId: OTHER_ID });
    const res = await request(app).post('/api/agent/heartbeat').send({ deviceId: DEVICE_ID });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('device_not_owned');
    expect(DeviceService.updateHeartbeat).not.toHaveBeenCalled();
  });

  test('records telemetry and returns the queued work', async () => {
    jobService.pendingForDevice.mockResolvedValue([{ rentalId: RENTAL_ID, kind: 'render.mandelbrot' }]);

    const res = await request(app)
      .post('/api/agent/heartbeat')
      .send({ deviceId: DEVICE_ID, stats: { gpuUtilization: 42, gpuTemperature: 61 } });

    expect(res.status).toBe(200);
    expect(DeviceService.updateHeartbeat).toHaveBeenCalledWith(DEVICE_ID, { gpuUtilization: 42, gpuTemperature: 61 });
    expect(jobService.pendingForDevice).toHaveBeenCalledWith({ providerId: PROVIDER_ID, deviceId: DEVICE_ID });
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.serverTime).toBeTruthy();
  });
});

describe('POST /api/agent/jobs/:rentalId/claim', () => {
  test('rejects a rental that belongs to another provider', async () => {
    RentalService.findById.mockResolvedValue({
      id: RENTAL_ID, providerId: OTHER_ID, listingId: LISTING_ID, status: 'active'
    });
    const res = await request(app).post(`/api/agent/jobs/${RENTAL_ID}/claim`).send({ deviceId: DEVICE_ID });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  test('rejects a rental that does not run on this device', async () => {
    GpuListingService.findById.mockResolvedValue({ id: LISTING_ID, deviceId: OTHER_ID });
    const res = await request(app).post(`/api/agent/jobs/${RENTAL_ID}/claim`).send({ deviceId: DEVICE_ID });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('device_mismatch');
  });

  test('answers 404 when the session has no jobs', async () => {
    jobService.findByRental.mockResolvedValue(null);
    const res = await request(app).post(`/api/agent/jobs/${RENTAL_ID}/claim`).send({ deviceId: DEVICE_ID });
    expect(res.status).toBe(404);
  });

  test('answers 409 when another agent won the claim', async () => {
    jobService.findByRental.mockResolvedValue({ rentalId: RENTAL_ID, status: 'queued' });
    jobService.claim.mockResolvedValue(null);
    const res = await request(app).post(`/api/agent/jobs/${RENTAL_ID}/claim`).send({ deviceId: DEVICE_ID });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('job_not_claimable');
  });

  test('returns the claimed job with its device', async () => {
    jobService.findByRental.mockResolvedValue({ rentalId: RENTAL_ID, kind: 'render.mandelbrot', status: 'queued' });
    jobService.claim.mockResolvedValue({ rentalId: RENTAL_ID, status: 'running', deviceId: DEVICE_ID });

    const res = await request(app).post(`/api/agent/jobs/${RENTAL_ID}/claim`).send({ deviceId: DEVICE_ID });

    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe('running');
    expect(jobService.claim).toHaveBeenCalledWith(expect.objectContaining({ deviceId: DEVICE_ID }));
  });
});

describe('progress and completion', () => {
  test('progress answers whether the job is still running', async () => {
    jobService.progress.mockResolvedValue({ accepted: false, status: 'cancelled' });
    const res = await request(app)
      .post(`/api/agent/jobs/${RENTAL_ID}/progress`)
      .send({ deviceId: DEVICE_ID, message: 'tile 2/4', percent: 50 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, accepted: false, status: 'cancelled' });
  });

  test('completion is scoped to the owning device', async () => {
    const res = await request(app)
      .post(`/api/agent/jobs/${RENTAL_ID}/complete`)
      .send({ status: 'succeeded', exitCode: 0 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('device_required');
    expect(jobService.complete).not.toHaveBeenCalled();
  });

  test('a job error keeps its status and code', async () => {
    jobService.complete.mockRejectedValue(new jobService.JobError('Job result is too large', 'job_result_too_large', 413));
    const res = await request(app)
      .post(`/api/agent/jobs/${RENTAL_ID}/complete`)
      .send({ deviceId: DEVICE_ID, status: 'succeeded' });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('job_result_too_large');
  });
});
