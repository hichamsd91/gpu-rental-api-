// Job queue: the allowlist is the security boundary, so most of these tests are
// about what it REFUSES. The fake database only implements the chains this
// service uses, which keeps the tests about the rules rather than about SQL.

const mockState = {
  rows: { session_jobs: [], gpu_listings: [], rentals: [] },
  failNext: null
};

const mockMatches = (filters, row) => filters.every(([key, op, value]) => {
  if (op === 'in') return Array.isArray(value) && value.includes(row[key]);
  if (op === 'lt') return row[key] != null && String(row[key]) < String(value);
  return row[key] === value;
});

const mockQuery = (table, op, payload) => {
  const state = { filters: [], single: false };
  const query = {};
  const run = () => {
    if (mockState.failNext && mockState.failNext.table === table) {
      const { error } = mockState.failNext;
      mockState.failNext = null;
      return { data: null, error };
    }
    const rows = mockState.rows[table] || (mockState.rows[table] = []);
    const matching = rows.filter((row) => mockMatches(state.filters, row));

    if (op === 'select') {
      return { data: state.single ? (matching[0] || null) : matching, error: null };
    }
    if (op === 'insert') {
      const record = { status: 'queued', progress: 0, log: null, result: null, ...payload[0] };
      if (rows.some((row) => row.rental_id === record.rental_id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value' } };
      }
      rows.push(record);
      return { data: record, error: null };
    }
    // update
    if (!matching.length) return { data: null, error: null };
    for (const row of matching) Object.assign(row, payload);
    return { data: state.single ? matching[0] : matching, error: null };
  };

  query.select = () => query;
  query.eq = (key, value) => { state.filters.push([key, 'eq', value]); return query; };
  query.in = (key, value) => { state.filters.push([key, 'in', value]); return query; };
  query.lt = (key, value) => { state.filters.push([key, 'lt', value]); return query; };
  query.maybeSingle = () => { state.single = true; return Promise.resolve(run()); };
  query.single = () => { state.single = true; return Promise.resolve(run()); };
  query.then = (resolve, reject) => Promise.resolve(run()).then(resolve, reject);
  return query;
};

jest.mock('../config/supabase', () => ({
  getSupabaseClient: () => ({
    from: (table) => ({
      select: jest.fn(() => mockQuery(table, 'select')),
      insert: jest.fn((payload) => mockQuery(table, 'insert', payload)),
      update: jest.fn((payload) => mockQuery(table, 'update', payload))
    })
  })
}));

const jobs = require('./jobService');

const RENTAL_ID = '11111111-1111-4111-8111-111111111111';
const RENTER_ID = '22222222-2222-4222-8222-222222222222';
const PROVIDER_ID = '33333333-3333-4333-8333-333333333333';

const rental = (overrides = {}) => ({
  id: RENTAL_ID,
  renterId: RENTER_ID,
  providerId: PROVIDER_ID,
  purpose: 'rendering',
  status: 'active',
  ...overrides
});

const queuedJob = (overrides = {}) => ({
  rental_id: RENTAL_ID,
  kind: 'render.mandelbrot',
  spec: { width: 320, height: 240, iterations: 80 },
  status: 'queued',
  progress: 0,
  log: null,
  result: null,
  ...overrides
});

beforeEach(() => {
  mockState.rows = { session_jobs: [], gpu_listings: [], rentals: [] };
  mockState.failNext = null;
});

describe('normalizeSpec', () => {
  test('fills every declared parameter with its default', () => {
    expect(jobs.normalizeSpec('render.mandelbrot', {})).toEqual({ width: 320, height: 240, iterations: 80 });
    expect(jobs.normalizeSpec('compute.matmul', undefined)).toEqual({ size: 1024, repeats: 3 });
  });

  test('accepts a value inside the range and ignores undeclared keys', () => {
    expect(jobs.normalizeSpec('render.mandelbrot', { width: 640, shell: 'rm -rf /' }))
      .toEqual({ width: 640, height: 240, iterations: 80 });
  });

  test('rejects a value outside the closed range', () => {
    expect(() => jobs.normalizeSpec('render.mandelbrot', { width: 4096 }))
      .toThrow(/between 64 and 1024/);
    expect(() => jobs.normalizeSpec('compute.matmul', { size: 128 }))
      .toThrow(/between 256 and 4096/);
  });

  test('rejects non-numeric and fractional integers', () => {
    expect(() => jobs.normalizeSpec('render.mandelbrot', { width: 'wide' })).toThrow(/whole number/);
    expect(() => jobs.normalizeSpec('render.mandelbrot', { width: 320.5 })).toThrow(/whole number/);
    expect(() => jobs.normalizeSpec('compute.matmul', { size: Infinity })).toThrow(/whole number/);
  });

  test('rejects an unknown kind instead of guessing one', () => {
    expect(() => jobs.normalizeSpec('render.blender', {})).toThrow(/Unknown job kind/);
  });
});

describe('purpose → kind allowlist', () => {
  test('batch and interactive compute purposes may run matmul', () => {
    for (const purpose of ['training', 'inference', 'research']) {
      expect(jobs.PURPOSE_KINDS[purpose]).toEqual(['compute.matmul']);
    }
  });

  test('rendering runs the render preset, and mining runs nothing yet', () => {
    expect(jobs.PURPOSE_KINDS.rendering).toEqual(['render.mandelbrot']);
    expect(jobs.PURPOSE_KINDS.mining).toEqual([]);
  });
});

describe('submit', () => {
  test('only the renter who owns the session can submit', async () => {
    await expect(jobs.submit({ rental: rental(), userId: PROVIDER_ID, kind: 'render.mandelbrot' }))
      .rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  test('a session that is not running refuses new work', async () => {
    await expect(jobs.submit({ rental: rental({ status: 'pending' }), userId: RENTER_ID, kind: 'render.mandelbrot' }))
      .rejects.toMatchObject({ code: 'rental_not_active', status: 409 });
  });

  test('a session with no declared purpose cannot run anything', async () => {
    await expect(jobs.submit({ rental: rental({ purpose: null }), userId: RENTER_ID, kind: 'render.mandelbrot' }))
      .rejects.toMatchObject({ code: 'purpose_required' });
  });

  test('a mining session answers "no executor" rather than pretending', async () => {
    await expect(jobs.submit({ rental: rental({ purpose: 'mining' }), userId: RENTER_ID, kind: 'render.mandelbrot' }))
      .rejects.toMatchObject({ code: 'job_kind_unavailable', status: 501 });
  });

  test('a rendering session cannot submit a compute job', async () => {
    await expect(jobs.submit({ rental: rental(), userId: RENTER_ID, kind: 'compute.matmul' }))
      .rejects.toMatchObject({ code: 'job_kind_not_allowed' });
  });

  test('a valid submission is stored as queued with normalized parameters', async () => {
    const job = await jobs.submit({
      rental: rental(), userId: RENTER_ID, kind: 'render.mandelbrot', params: { width: 512 }
    });

    expect(job.status).toBe('queued');
    expect(job.spec).toEqual({ width: 512, height: 240, iterations: 80 });
    expect(job.kindLabel).toBe('GPU render (Mandelbrot)');
    expect(mockState.rows.session_jobs).toHaveLength(1);
  });

  test('a second job on the same session is refused by the primary key', async () => {
    await jobs.submit({ rental: rental(), userId: RENTER_ID, kind: 'render.mandelbrot' });
    await expect(jobs.submit({ rental: rental(), userId: RENTER_ID, kind: 'render.mandelbrot' }))
      .rejects.toMatchObject({ code: 'job_exists', status: 409 });
  });
});

describe('pendingForDevice', () => {
  test('returns queued jobs for active rentals on that provider device only', async () => {
    mockState.rows.gpu_listings = [{ id: 'listing-1', provider_id: PROVIDER_ID, device_id: 'device-1' }];
    mockState.rows.rentals = [
      { id: RENTAL_ID, listing_id: 'listing-1', status: 'active' },
      { id: 'rental-ended', listing_id: 'listing-1', status: 'ended' }
    ];
    mockState.rows.session_jobs = [
      queuedJob(),
      queuedJob({ rental_id: 'rental-ended' })
    ];

    const pending = await jobs.pendingForDevice({ providerId: PROVIDER_ID, deviceId: 'device-1' });

    expect(pending.map((job) => job.rentalId)).toEqual([RENTAL_ID]);
  });

  test('work abandoned by a crashed agent is offered again, queued work still comes first', async () => {
    mockState.rows.gpu_listings = [{ id: 'listing-1', provider_id: PROVIDER_ID, device_id: 'device-1' }];
    mockState.rows.rentals = [{ id: RENTAL_ID, listing_id: 'listing-1', status: 'active' }];
    mockState.rows.session_jobs = [
      queuedJob({ status: 'running', updated_at: new Date(Date.now() - 15 * 60 * 1000).toISOString() })
    ];

    const pending = await jobs.pendingForDevice({ providerId: PROVIDER_ID, deviceId: 'device-1' });

    expect(pending.map((job) => job.rentalId)).toEqual([RENTAL_ID]);
  });

  test('a device with no listings has no work', async () => {
    await expect(jobs.pendingForDevice({ providerId: PROVIDER_ID, deviceId: 'device-1' })).resolves.toEqual([]);
  });
});

describe('claim', () => {
  test('claiming flips the job to running exactly once', async () => {
    mockState.rows.session_jobs = [queuedJob()];
    const requested = { rentalId: RENTAL_ID };

    const first = await jobs.claim({ rental: rental(), job: requested, deviceId: 'device-1' });
    expect(first.status).toBe('running');
    expect(first.startedAt).toBeTruthy();
    expect(first.deviceId).toBe('device-1');

    const second = await jobs.claim({ rental: rental(), job: requested, deviceId: 'device-1' });
    expect(second).toBeNull();
  });

  test('a job whose session already ended is never claimed', async () => {
    mockState.rows.session_jobs = [queuedJob()];
    await expect(jobs.claim({ rental: rental({ status: 'ended' }), job: { rentalId: RENTAL_ID }, deviceId: 'd' }))
      .resolves.toBeNull();
  });

  test('a job left running by a crashed agent is taken over after the stale window', async () => {
    mockState.rows.session_jobs = [queuedJob({
      status: 'running',
      updated_at: new Date(Date.now() - 15 * 60 * 1000).toISOString()
    })];

    const reclaimed = await jobs.claim({ rental: rental(), job: { rentalId: RENTAL_ID }, deviceId: 'device-2' });

    expect(reclaimed.status).toBe('running');
    expect(reclaimed.reclaimed).toBe(true);
    expect(reclaimed.deviceId).toBe('device-2');
    expect(mockState.rows.session_jobs[0].status).toBe('running');
  });

  test('a healthy running job is never stolen from the agent working on it', async () => {
    mockState.rows.session_jobs = [queuedJob({
      status: 'running',
      updated_at: new Date().toISOString()
    })];

    await expect(jobs.claim({ rental: rental(), job: { rentalId: RENTAL_ID }, deviceId: 'device-2' }))
      .resolves.toBeNull();
  });
});

describe('progress', () => {
  test('appends a bounded log line and clamps the percentage', async () => {
    mockState.rows.session_jobs = [queuedJob({ status: 'running' })];
    mockState.rows.rentals = [{ id: RENTAL_ID, status: 'active' }];

    const result = await jobs.progress({ rentalId: RENTAL_ID, message: 'tile 1/4', percent: 140 });

    expect(result).toEqual({ accepted: true, status: 'running' });
    const row = mockState.rows.session_jobs[0];
    expect(row.progress).toBe(100);
    expect(row.log).toMatch(/tile 1\/4/);
  });

  test('a session that ended under the GPU cancels the job and tells the agent to stop', async () => {
    mockState.rows.session_jobs = [queuedJob({ status: 'running' })];
    mockState.rows.rentals = [{ id: RENTAL_ID, status: 'ended' }];

    await expect(jobs.progress({ rentalId: RENTAL_ID, message: 'still going', percent: 40 }))
      .resolves.toEqual({ accepted: false, status: 'cancelled' });
    expect(mockState.rows.session_jobs[0].status).toBe('cancelled');
    expect(mockState.rows.session_jobs[0].log).toMatch(/no longer running/);
  });

  test('a terminal job tells the agent to stop working', async () => {
    mockState.rows.session_jobs = [queuedJob({ status: 'cancelled' })];
    await expect(jobs.progress({ rentalId: RENTAL_ID, message: 'still going' }))
      .resolves.toEqual({ accepted: false, status: 'cancelled' });
  });

  test('progress on a session with no job is a 404', async () => {
    await expect(jobs.progress({ rentalId: RENTAL_ID, message: 'x' }))
      .rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('complete', () => {
  test('stores the result and refuses an invalid terminal status', async () => {
    mockState.rows.session_jobs = [queuedJob({ status: 'running' })];

    const job = await jobs.complete({
      rentalId: RENTAL_ID, status: 'succeeded', exitCode: 0, result: { checksum: 'abc' }
    });
    expect(job.status).toBe('succeeded');
    expect(job.result).toEqual({ checksum: 'abc' });
    expect(job.exitCode).toBe(0);

    await expect(jobs.complete({ rentalId: RENTAL_ID, status: 'done' }))
      .rejects.toMatchObject({ code: 'job_status_invalid' });
  });

  test('a retry after completion returns the stored job instead of rewriting it', async () => {
    mockState.rows.session_jobs = [queuedJob({ status: 'running' })];
    await jobs.complete({ rentalId: RENTAL_ID, status: 'succeeded', result: { ok: true } });

    const retry = await jobs.complete({ rentalId: RENTAL_ID, status: 'failed', result: { ok: false } });
    expect(retry.status).toBe('succeeded');
    expect(retry.result).toEqual({ ok: true });
  });

  test('an oversized result is rejected', async () => {
    mockState.rows.session_jobs = [queuedJob({ status: 'running' })];
    const huge = { blob: 'x'.repeat(jobs.RESULT_LIMIT) };
    await expect(jobs.complete({ rentalId: RENTAL_ID, status: 'succeeded', result: huge }))
      .rejects.toMatchObject({ code: 'job_result_too_large', status: 413 });
  });
});

describe('missing schema', () => {
  test('a deployment without migration 022 answers 503, not 500', async () => {
    mockState.failNext = {
      table: 'session_jobs',
      error: { code: '42P01', message: 'relation "public.session_jobs" does not exist' }
    };
    await expect(jobs.findByRental(RENTAL_ID))
      .rejects.toMatchObject({ code: 'jobs_unavailable', status: 503 });
  });
});
