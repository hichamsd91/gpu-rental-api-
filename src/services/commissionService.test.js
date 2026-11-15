// Owner decision 2026-11-15: the platform takes 0% of a rental. These tests
// pin the split so a future edit cannot silently reintroduce a fee.
const { PlatformCommissionService } = require('./commissionService');

describe('PlatformCommissionService — zero commission', () => {
  test('the rate is zero', () => {
    expect(PlatformCommissionService.rate).toBe(0);
  });

  test('the provider keeps every cent of the collected amount', () => {
    expect(PlatformCommissionService.calculateCommission(12.345)).toEqual({
      total: 12.345,
      commission: 0,
      providerEarning: 12.345
    });
  });

  test('the split never loses or creates money, including zero and junk input', () => {
    for (const amount of [0, 0.01, 1, 3.333, '2.5', null, undefined, NaN]) {
      const split = PlatformCommissionService.calculateCommission(amount);
      expect(split.commission).toBe(0);
      expect(split.providerEarning).toBe(split.total);
    }
  });

  test('processRentalPayment reports the same zero-fee breakdown', async () => {
    const result = await PlatformCommissionService.processRentalPayment({ actualCost: 4.2 });
    expect(result.success).toBe(true);
    expect(result.breakdown.platformCommission).toBe(0);
    expect(result.breakdown.providerEarning).toBe(4.2);
  });
});
