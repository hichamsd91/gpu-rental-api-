jest.mock('../config/supabase', () => ({ getSupabaseClient: jest.fn() }));

const { getSupabaseClient } = require('../config/supabase');
const jobService = require('./jobService');

const useClient = (client) => getSupabaseClient.mockReturnValue(client);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('enqueue', () => {
  test('inserts a job and returns its id', async () => {
    const single = jest.fn().mockResolvedValue({ data: { id: 'job-1' }, error: null });
    const select = jest.fn(() => ({ single }));
    const insert = jest.fn(() => ({ select }));
    useClient({ from: jest.fn(() => ({ insert })) });

    const result = await jobService.enqueue('rental.settle', { rentalId: 'r-1' });

    expect(result).toEqual({ id: 'job-1', deduped: false });
    const row = insert.mock.calls[0][0];
    expect(row.kind).toBe('rental.settle');
    expect(row.payload).toEqual({ rentalId: 'r-1' });
    expect(row.max_attempts).toBe(5);
  });

  test('rejects an unknown kind instead of parking an unclaimable job', async () => {
    await expect(jobService.enqueue('rental.settle.typo', {})).rejects.toThrow(/unknown job kind/);
  });

  test('rejects a non-object payload', async () => {
    await expect(jobService.enqueue('rental.settle', 'nope')).rejects.toThrow(/payload must be an object/);
  });

  test('normalizes maxAttempts into the database bounds', async () => {
    const single = jest.fn().mockResolvedValue({ data: { id: 'job-2' }, error: null });
    const insert = jest.fn(() => ({ select: () => ({ single }) }));
    useClient({ from: jest.fn(() => ({ insert })) });

    await jobService.enqueue('rental.expire', {}, { maxAttempts: 999 });
    expect(insert.mock.calls[0][0].max_attempts).toBe(50);
  });

  test('turns a duplicate dedupe key into a no-op', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const select = jest.fn(() => ({ maybeSingle }));
    const upsert = jest.fn(() => ({ select }));
    useClient({ from: jest.fn(() => ({ upsert })) });

    const result = await jobService.enqueue('notification.send', { to: 'a' }, { dedupeKey: 'welcome:user-1' });

    expect(result).toEqual({ id: null, deduped: true });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ dedupe_key: 'welcome:user-1' }),
      { onConflict: 'dedupe_key', ignoreDuplicates: true }
    );
  });

  test('surfaces a write failure', async () => {
    const single = jest.fn().mockResolvedValue({ data: null, error: { message: 'rls denied' } });
    const insert = jest.fn(() => ({ select: () => ({ single }) }));
    useClient({ from: jest.fn(() => ({ insert })) });

    await expect(jobService.enqueue('rental.settle', {})).rejects.toThrow(/job enqueue failed: rls denied/);
  });
});

describe('claim', () => {
  test('clamps the batch size and passes the worker id to the SQL function', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: [{ id: 'job-1' }], error: null });
    useClient({ rpc });

    const claimed = await jobService.claim({ worker: 'worker-a', batch: 999 });

    expect(claimed).toEqual([{ id: 'job-1' }]);
    expect(rpc).toHaveBeenCalledWith('claim_jobs', { p_worker: 'worker-a', p_batch: 50 });
  });

  test('requires a worker id', async () => {
    await expect(jobService.claim({})).rejects.toThrow(/worker id is required/);
  });

  test('fails loudly when the claim RPC fails', async () => {
    useClient({ rpc: jest.fn().mockResolvedValue({ data: null, error: { message: 'function missing' } }) });
    await expect(jobService.claim({ worker: 'w' })).rejects.toThrow(/job claim failed: function missing/);
  });

  test('returns an empty list when nothing is due', async () => {
    useClient({ rpc: jest.fn().mockResolvedValue({ data: null, error: null }) });
    await expect(jobService.claim({ worker: 'w' })).resolves.toEqual([]);
  });
});

describe('finish', () => {
  test('delegates the retry/backoff decision to the database', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: { id: 'job-1', status: 'dead' }, error: null });
    useClient({ rpc });

    const row = await jobService.finish('job-1', { status: 'failed', error: 'boom' });

    expect(row.status).toBe('dead');
    expect(rpc).toHaveBeenCalledWith('finish_job', { p_id: 'job-1', p_status: 'failed', p_error: 'boom' });
  });

  test('rejects any status other than succeeded/failed', async () => {
    await expect(jobService.finish('job-1', { status: 'queued' })).rejects.toThrow(/invalid finish status/);
  });

  test('fail() truncates the error message before it reaches the column', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: {}, error: null });
    useClient({ rpc });

    await jobService.fail('job-1', new Error('x'.repeat(5000)));

    const args = rpc.mock.calls[0][1];
    expect(args.p_status).toBe('failed');
    expect(args.p_error).toHaveLength(2000);
  });
});

describe('stats', () => {
  test('counts every status in the queue', async () => {
    const counts = { queued: 3, running: 1, succeeded: 10, failed: 2, dead: 0 };
    const eq = jest.fn((column, status) => Promise.resolve({ count: counts[status], error: null }));
    const select = jest.fn(() => ({ eq }));
    useClient({ from: jest.fn(() => ({ select })) });

    await expect(jobService.stats()).resolves.toEqual(counts);
  });
});
