jest.mock('../config/supabase', () => ({ getSupabaseClient: jest.fn() }));
jest.mock('./moneyService', () => ({
  listPendingPayouts: jest.fn(),
  schedulePayout: jest.fn()
}));

const { getSupabaseClient } = require('../config/supabase');
const moneyService = require('./moneyService');
const payouts = require('./payoutBatchService');

const mockTransactions = (rows, error = null) => {
  const query = {
    select: jest.fn(() => query),
    gte: jest.fn(() => query),
    in: jest.fn(() => query),
    eq: jest.fn(() => Promise.resolve({ data: rows, error }))
  };
  getSupabaseClient.mockReturnValue({ from: jest.fn(() => query) });
  return query;
};

beforeEach(() => {
  jest.clearAllMocks();
  payouts._resetThrottle();
  moneyService.listPendingPayouts.mockResolvedValue([]);
  moneyService.schedulePayout.mockImplementation(async ({ providerId, amountMinor, scheduledFor }) => ({
    id: `payout-${providerId}`,
    providerId,
    amountMinor,
    scheduledFor
  }));
});

describe('weekly payout dates', () => {
  test('the weekly run lands on a Monday', () => {
    // Wednesday 18 Nov 2026 -> Monday 23 Nov 2026
    const monday = payouts.nextMondayUtc(new Date('2026-11-18T10:00:00Z'));
    expect(monday.toISOString()).toBe('2026-11-23T00:00:00.000Z');
  });

  test('a Monday schedules the following Monday, never the same day', () => {
    const monday = payouts.nextMondayUtc(new Date('2026-11-23T08:00:00Z'));
    expect(monday.toISOString()).toBe('2026-11-30T00:00:00.000Z');
  });

  test('the dispute hold wins when it is later than the next Monday', () => {
    const when = payouts.scheduleDateFor(new Date('2026-11-18T10:00:00Z'), 7);
    expect(when.toISOString()).toBe('2026-11-25T10:00:00.000Z');
  });

  test('with no hold the payout waits for Monday', () => {
    const when = payouts.scheduleDateFor(new Date('2026-11-18T10:00:00Z'), 0);
    expect(when.toISOString()).toBe('2026-11-23T00:00:00.000Z');
  });
});

describe('selectPayouts (pure planner)', () => {
  test('nothing below the minimum is paid', () => {
    expect(payouts.selectPayouts({ earnings: { a: 4999 }, withdrawals: {}, scheduled: {} })).toEqual([]);
  });

  test('exactly the minimum is paid in full', () => {
    expect(payouts.selectPayouts({ earnings: { a: 5000 } })).toEqual([
      { providerId: 'a', amountMinor: 5000 }
    ]);
  });

  test('withdrawals already paid are subtracted', () => {
    expect(payouts.selectPayouts({ earnings: { a: 12000 }, withdrawals: { a: 5000 } })).toEqual([
      { providerId: 'a', amountMinor: 7000 }
    ]);
  });

  test('subtracting a paid withdrawal can drop a provider below the minimum', () => {
    expect(payouts.selectPayouts({ earnings: { a: 9000 }, withdrawals: { a: 5000 } })).toEqual([]);
  });

  test('money already queued is never queued twice', () => {
    expect(payouts.selectPayouts({ earnings: { a: 12000 }, scheduled: { a: 12000 } })).toEqual([]);
  });

  test('the biggest balance is planned first', () => {
    const plan = payouts.selectPayouts({
      earnings: { a: 5000, b: 20000, c: 100 }
    });
    expect(plan.map((p) => p.providerId)).toEqual(['b', 'a']);
  });

  test('junk amounts never produce a payout', () => {
    expect(payouts.selectPayouts({ earnings: { a: NaN, b: null, c: undefined } })).toEqual([]);
  });
});

describe('runBatch', () => {
  test('books one payout per provider above the threshold', async () => {
    mockTransactions([
      { user_id: 'provider-1', type: 'provider_earning', amount: 80.0, status: 'completed' },
      { user_id: 'provider-1', type: 'withdrawal', amount: 20.0, status: 'completed' },
      { user_id: 'provider-2', type: 'provider_earning', amount: 10.0, status: 'completed' }
    ]);

    const result = await payouts.runBatch({ now: new Date('2026-11-18T10:00:00Z'), force: true });

    expect(result.plan).toEqual([{ providerId: 'provider-1', amountMinor: 6000 }]);
    expect(moneyService.schedulePayout).toHaveBeenCalledTimes(1);
    expect(moneyService.schedulePayout).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'provider-1', amountMinor: 6000 })
    );
  });

  test('queued money is subtracted from the next batch', async () => {
    mockTransactions([
      { user_id: 'provider-1', type: 'provider_earning', amount: 120.0, status: 'completed' }
    ]);
    moneyService.listPendingPayouts.mockResolvedValue([
      { providerId: 'provider-1', amountMinor: 4000, status: 'scheduled' }
    ]);

    const result = await payouts.runBatch({ now: new Date('2026-11-18T10:00:00Z'), force: true });

    expect(result.plan).toEqual([{ providerId: 'provider-1', amountMinor: 8000 }]);
  });

  test('dry run never schedules anything', async () => {
    mockTransactions([
      { user_id: 'provider-1', type: 'provider_earning', amount: 80.0, status: 'completed' }
    ]);

    const result = await payouts.runBatch({ now: new Date('2026-11-18T10:00:00Z'), dryRun: true });

    expect(result.plan).toHaveLength(1);
    expect(moneyService.schedulePayout).not.toHaveBeenCalled();
  });

  test('a missing ledger table is reported, not thrown', async () => {
    mockTransactions(null, { code: '42P01', message: 'relation "transactions" does not exist' });

    const result = await payouts.runBatch({ now: new Date('2026-11-18T10:00:00Z'), force: true });

    expect(result.skipped).toBe('unavailable');
    expect(moneyService.schedulePayout).not.toHaveBeenCalled();
  });

  test('the batch throttles itself instead of running on every sweep', async () => {
    mockTransactions([]);
    const now = new Date('2026-11-18T10:00:00Z');

    const first = await payouts.runBatch({ now });
    const second = await payouts.runBatch({ now: new Date(now.getTime() + 60 * 1000) });

    expect(first.skipped).toBeUndefined();
    expect(second.skipped).toBe('throttled');
  });
});
