jest.mock('../config/supabase', () => ({ getSupabaseClient: jest.fn() }));
jest.mock('./moneyService', () => ({
  listPendingPayouts: jest.fn(),
  schedulePayout: jest.fn(),
  getStripeAccount: jest.fn()
}));

const { getSupabaseClient } = require('../config/supabase');
const moneyService = require('./moneyService');
const payouts = require('./payoutBatchService');

// The batch reads wallet balances (the on-screen truth) and only then the
// dispute table, so the mock answers per table.
const mockTables = (wallets, {
  walletError = null,
  disputes = [],
  disputeError = null,
  rentals = []
} = {}) => {
  const makeQuery = (result, err = null) => {
    const resolved = { data: result, error: err };
    const query = {
      select: jest.fn(() => query),
      gte: jest.fn(() => query),
      in: jest.fn(() => query),
      eq: jest.fn(() => Promise.resolve(resolved)),
      then: (resolve, reject) => Promise.resolve(resolved).then(resolve, reject)
    };
    return query;
  };
  const from = jest.fn((table) => {
    if (table === 'disputes') return makeQuery(disputes, disputeError);
    if (table === 'rentals') return makeQuery(rentals);
    return makeQuery(wallets, walletError);
  });
  getSupabaseClient.mockReturnValue({ from });
  return from;
};

const walletsOf = (entries) => entries.map(([user_id, balance]) => ({ user_id, balance }));

beforeEach(() => {
  jest.clearAllMocks();
  payouts._resetThrottle();
  moneyService.listPendingPayouts.mockResolvedValue([]);
  moneyService.getStripeAccount.mockResolvedValue({ stripeAccountId: 'acct_test', payoutsEnabled: true });
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
    expect(payouts.selectPayouts({ earnings: { a: 4999 }, scheduled: {} })).toEqual([]);
  });

  test('exactly the minimum is paid in full', () => {
    expect(payouts.selectPayouts({ earnings: { a: 5000 } })).toEqual([
      { providerId: 'a', amountMinor: 5000 }
    ]);
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

  test('a frozen provider (open dispute) is never paid', () => {
    const plan = payouts.selectPayouts({
      earnings: { a: 20000, b: 20000 },
      frozen: ['a']
    });
    expect(plan).toEqual([{ providerId: 'b', amountMinor: 20000 }]);
  });

  test('a frozen Set is accepted too', () => {
    expect(payouts.selectPayouts({ earnings: { a: 20000 }, frozen: new Set(['a']) })).toEqual([]);
  });
});

describe('runBatch', () => {
  test('pays the provider wallet balance above the minimum', async () => {
    mockTables(walletsOf([['provider-1', 80], ['provider-2', 10]]));

    const result = await payouts.runBatch({ now: new Date('2026-11-18T10:00:00Z'), force: true });

    expect(result.plan).toEqual([{ providerId: 'provider-1', amountMinor: 8000 }]);
    expect(moneyService.schedulePayout).toHaveBeenCalledTimes(1);
    expect(moneyService.schedulePayout).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'provider-1', amountMinor: 8000 })
    );
  });

  test('a wallet already reduced by a completed transfer is not paid again', async () => {
    // The old ledger-sum approach paid 120 again; the wallet says 40 is left.
    mockTables(walletsOf([['provider-1', 40]]));
    const result = await payouts.runBatch({ now: new Date('2026-11-18T10:00:00Z'), force: true });
    expect(result.plan).toEqual([]);
    expect(moneyService.schedulePayout).not.toHaveBeenCalled();
  });

  test('queued money is subtracted from the next batch', async () => {
    mockTables(walletsOf([['provider-1', 120]]));
    moneyService.listPendingPayouts.mockResolvedValue([
      { providerId: 'provider-1', amountMinor: 4000, status: 'scheduled' }
    ]);

    const result = await payouts.runBatch({ now: new Date('2026-11-18T10:00:00Z'), force: true });

    expect(result.plan).toEqual([{ providerId: 'provider-1', amountMinor: 8000 }]);
  });

  test('dry run never schedules anything', async () => {
    mockTables(walletsOf([['provider-1', 80]]));

    const result = await payouts.runBatch({ now: new Date('2026-11-18T10:00:00Z'), dryRun: true });

    expect(result.plan).toHaveLength(1);
    expect(moneyService.schedulePayout).not.toHaveBeenCalled();
  });

  test('a missing wallet table is reported, not thrown', async () => {
    mockTables(null, { walletError: { code: '42P01', message: 'relation "wallets" does not exist' } });

    const result = await payouts.runBatch({ now: new Date('2026-11-18T10:00:00Z'), force: true });

    expect(result.skipped).toBe('unavailable');
    expect(moneyService.schedulePayout).not.toHaveBeenCalled();
  });

  test('a provider with an open dispute is held back', async () => {
    mockTables(walletsOf([['provider-1', 80], ['provider-2', 90]]), {
      disputes: [{ rental_id: 'rental-1' }],
      rentals: [{ id: 'rental-1', provider_id: 'provider-1' }]
    });

    const result = await payouts.runBatch({ now: new Date('2026-11-18T10:00:00Z'), force: true });

    expect(result.plan).toEqual([{ providerId: 'provider-2', amountMinor: 9000 }]);
    expect(moneyService.schedulePayout).toHaveBeenCalledTimes(1);
  });

  test('when the dispute lookup fails the whole batch is skipped (fail closed)', async () => {
    mockTables(walletsOf([['provider-1', 80]]), {
      disputeError: { code: '57014', message: 'canceling statement due to statement timeout' }
    });

    const result = await payouts.runBatch({ now: new Date('2026-11-18T10:00:00Z'), force: true });

    expect(result.skipped).toBe('dispute_lookup_failed');
    expect(moneyService.schedulePayout).not.toHaveBeenCalled();
  });

  test('a provider that has not finished Stripe onboarding is not queued', async () => {
    mockTables(walletsOf([['provider-1', 80]]));
    moneyService.getStripeAccount.mockResolvedValue({ stripeAccountId: null, payoutsEnabled: false });

    const result = await payouts.runBatch({ now: new Date('2026-11-18T10:00:00Z'), force: true });

    expect(result.plan).toHaveLength(1);
    expect(result.created).toEqual([]);
    expect(moneyService.schedulePayout).not.toHaveBeenCalled();
  });

  test('a balance above the payout cap is held, not transferred', async () => {
    mockTables(walletsOf([['provider-1', 90000]]));

    const result = await payouts.runBatch({ now: new Date('2026-11-18T10:00:00Z'), force: true });

    expect(result.plan).toHaveLength(1);
    expect(result.created).toEqual([]);
    expect(moneyService.schedulePayout).not.toHaveBeenCalled();
  });

  test('the batch throttles itself instead of running on every sweep', async () => {
    mockTables(walletsOf([]));
    const now = new Date('2026-11-18T10:00:00Z');

    const first = await payouts.runBatch({ now });
    const second = await payouts.runBatch({ now: new Date(now.getTime() + 60 * 1000) });

    expect(first.skipped).toBeUndefined();
    expect(second.skipped).toBe('throttled');
  });
});
