// Pure availability + mining-guard logic. No database is touched here; the
// catalog's DB reads have their own graceful-degradation test at the bottom.
jest.mock('../config/supabase', () => ({
  getSupabaseClient: jest.fn(() => {
    throw new Error('no database in this test');
  })
}));

jest.mock('./featureFlagService', () => ({
  isEnabled: jest.fn(async () => false),
  enabledMap: jest.fn(async () => ({ 'mining.allowed': false }))
}));

const catalog = require('./catalogService');

const MONDAY_9_TO_17 = [{ weekday: 1, startMinute: 540, endMinute: 1020 }];

describe('isWindowOpen', () => {
  test('an empty schedule means always open', () => {
    expect(catalog.isWindowOpen([], [], '2026-10-26T03:00:00Z', '2026-10-26T04:00:00Z')).toBe(true);
  });

  test('accepts a window fully inside the opening hours', () => {
    expect(catalog.isWindowOpen(MONDAY_9_TO_17, [], '2026-10-26T10:00:00Z', '2026-10-26T12:00:00Z')).toBe(true);
  });

  test('rejects a window that starts before opening', () => {
    expect(catalog.isWindowOpen(MONDAY_9_TO_17, [], '2026-10-26T08:30:00Z', '2026-10-26T10:00:00Z')).toBe(false);
  });

  test('rejects a window that runs past closing into the next day', () => {
    expect(catalog.isWindowOpen(MONDAY_9_TO_17, [], '2026-10-26T16:00:00Z', '2026-10-26T18:00:00Z')).toBe(false);
  });

  test('rejects a day with no window at all', () => {
    expect(catalog.isWindowOpen(MONDAY_9_TO_17, [], '2026-10-27T10:00:00Z', '2026-10-27T11:00:00Z')).toBe(false);
  });

  test('a blackout wins even inside opening hours', () => {
    const blackouts = [{ startsAt: '2026-10-26T11:00:00Z', endsAt: '2026-10-26T13:00:00Z' }];
    expect(catalog.isWindowOpen(MONDAY_9_TO_17, blackouts, '2026-10-26T12:00:00Z', '2026-10-26T12:30:00Z')).toBe(false);
  });

  test('a zero-length or inverted window is never open', () => {
    expect(catalog.isWindowOpen([], [], '2026-10-26T10:00:00Z', '2026-10-26T10:00:00Z')).toBe(false);
    expect(catalog.isWindowOpen([], [], '2026-10-26T10:00:00Z', '2026-10-26T09:00:00Z')).toBe(false);
  });
});

describe('findNextOpening', () => {
  test('unrestricted listings have no next opening (they are always open)', () => {
    expect(catalog.findNextOpening([], [], new Date('2026-10-26T10:00:00Z'))).toBeNull();
  });

  test('finds the next slot inside the weekly schedule', () => {
    const next = catalog.findNextOpening(MONDAY_9_TO_17, [], new Date('2026-10-26T18:00:00Z'));

    expect(next).toBeTruthy();
    // Monday 18:00 is closed → the next slot is Tuesday? No: only Monday is
    // configured, so the answer must be the FOLLOWING Monday 09:00.
    expect(new Date(next).getUTCDay()).toBe(1);
    expect(new Date(next).getUTCHours()).toBe(9);
  });
});

describe('validateMining (D2 guard rails)', () => {
  const disclosure = 'Declared 320W continuous load, 78 dB fans, 99% uptime on this unit.';

  test('requires its own price', () => {
    expect(() => catalog.validateMining({ pricePerHour: null, specs: { powerCapWatts: 320, disclosure } }))
      .toThrow(/own price/);
  });

  test('bounds the power cap', () => {
    expect(() => catalog.validateMining({ pricePerHour: 2, specs: { powerCapWatts: 5000, disclosure } }))
      .toThrow(/between 50 and 1000/);
    expect(() => catalog.validateMining({ pricePerHour: 2, specs: { powerCapWatts: 320.5, disclosure } }))
      .toThrow(/between 50 and 1000/);
  });

  test('requires a real disclosure', () => {
    expect(() => catalog.validateMining({ pricePerHour: 2, specs: { powerCapWatts: 320, disclosure: 'ok' } }))
      .toThrow(/disclosure/);
  });

  test('accepts a compliant listing and normalizes the watts', () => {
    const specs = catalog.validateMining({
      pricePerHour: 2,
      specs: { powerCapWatts: '320', disclosure, coin: 'ETC' }
    });

    expect(specs).toMatchObject({ powerCapWatts: 320, coin: 'ETC' });
  });
});

describe('graceful degradation without migration 012', () => {
  test('the catalog still renders with mining disabled when the DB is unreachable', async () => {
    const purposes = await catalog.listPurposes();

    expect(purposes.length).toBe(5);
    expect(purposes.map((p) => p.key)).toEqual(['training', 'inference', 'rendering', 'research', 'mining']);
    expect(purposes.find((p) => p.key === 'mining').enabled).toBe(false);
    expect(purposes.find((p) => p.key === 'training').enabled).toBe(true);
  });

  test('availability reads degrade to "always open"', async () => {
    await expect(catalog.getAvailabilityRows('listing-1')).resolves.toEqual({ windows: [], blackouts: [] });
  });
});
