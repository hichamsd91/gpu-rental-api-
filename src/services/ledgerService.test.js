jest.mock('../config/supabase', () => ({ getSupabaseClient: jest.fn() }));

const { getSupabaseClient } = require('../config/supabase');
const ledger = require('./ledgerService');

beforeEach(() => jest.clearAllMocks());

describe('money conversion', () => {
  test('rounds dollars to integer cents half-up', () => {
    expect(ledger.toMinor('10.99')).toBe(1099);
    expect(ledger.toMinor(0.038)).toBe(4); // 3.8 cents rounds to 4
    expect(ledger.toMinor(0.75)).toBe(75);
  });

  test('uses factor 1 for zero-decimal currencies', () => {
    expect(ledger.toMinor(500, 'JPY')).toBe(500);
    expect(ledger.fromMinor(500, 'JPY')).toBe(500);
  });

  test('rejects non-finite input', () => {
    expect(() => ledger.toMinor('abc')).toThrow(/not a number/);
  });

  test('fromMinor restores the presentation value', () => {
    expect(ledger.fromMinor(1099)).toBe(10.99);
  });
});

describe('account naming', () => {
  test('namespaces accounts by convention', () => {
    expect(ledger.walletAccount('user-1')).toBe('wallet:user-1');
    expect(ledger.commissionAccount()).toBe('platform.commission');
    expect(ledger.escrowAccount('rental-9')).toBe('escrow:rental-9');
  });
});

describe('postTransfer', () => {
  test('delegates to the SQL function with normalized currency', async () => {
    const rpc = jest.fn().mockResolvedValue({ error: null });
    getSupabaseClient.mockReturnValue({ rpc });

    const result = await ledger.postTransfer({
      from: 'wallet:a',
      to: 'platform.commission',
      amountMinor: 1234,
      currency: 'usd',
      refType: 'commission',
      refId: 'r-1'
    });

    expect(result.idempotent).toBe(false);
    expect(result.group).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('post_transfer', {
      p_group: result.group,
      p_from: 'wallet:a',
      p_to: 'platform.commission',
      p_amount_minor: 1234,
      p_currency: 'USD',
      p_ref_type: 'commission',
      p_ref_id: 'r-1'
    });
  });

  test('treats a duplicate group as idempotent success', async () => {
    const rpc = jest.fn().mockResolvedValue({ error: { code: '23505', message: 'duplicate key value' } });
    getSupabaseClient.mockReturnValue({ rpc });

    const group = '11111111-1111-4111-8111-111111111111';
    const result = await ledger.postTransfer({ from: 'a', to: 'b', amountMinor: 100, group });

    expect(result).toEqual({ group, idempotent: true });
  });

  test('rejects a non-positive or fractional amount', async () => {
    await expect(ledger.postTransfer({ from: 'a', to: 'b', amountMinor: 0 })).rejects.toThrow(/positive integer/);
    await expect(ledger.postTransfer({ from: 'a', to: 'b', amountMinor: 1.5 })).rejects.toThrow(/positive integer/);
  });

  test('rejects identical from/to accounts', async () => {
    await expect(ledger.postTransfer({ from: 'a', to: 'a', amountMinor: 10 })).rejects.toThrow(/must differ/);
  });

  test('surfaces real database failures', async () => {
    const rpc = jest.fn().mockResolvedValue({ error: { code: '23514', message: 'check violation' } });
    getSupabaseClient.mockReturnValue({ rpc });

    await expect(ledger.postTransfer({ from: 'a', to: 'b', amountMinor: 10 })).rejects.toThrow(/post_transfer failed/);
  });
});

describe('balance', () => {
  test('returns the summed minor units', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: 4200, error: null });
    getSupabaseClient.mockReturnValue({ rpc });

    const value = await ledger.balance('wallet:a', 'USD');

    expect(value).toBe(4200);
    expect(rpc).toHaveBeenCalledWith('ledger_balance', { p_account: 'wallet:a', p_currency: 'USD' });
  });

  test('surfaces balance read failures', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
    getSupabaseClient.mockReturnValue({ rpc });

    await expect(ledger.balance('wallet:a')).rejects.toThrow(/balance failed/);
  });
});
