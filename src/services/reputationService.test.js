jest.mock('../config/supabase', () => ({ getSupabaseClient: jest.fn() }));

const { getSupabaseClient } = require('../config/supabase');
const reputation = require('./reputationService');

const INPUT = {
  rentalId: '66666666-6666-4666-8666-666666666666',
  reviewerId: '77777777-7777-4777-8777-777777777777',
  revieweeId: '88888888-8888-4888-8888-888888888888',
  direction: 'renter_to_provider',
  rating: 5,
  title: 'Great GPU',
  body: 'Exactly as described',
};

const fakeClient = (result) => {
  const single = jest.fn(async () => result);
  const select = jest.fn(() => ({ single }));
  const insert = jest.fn(() => ({ select }));
  return { from: jest.fn(() => ({ insert })) };
};

beforeEach(() => jest.clearAllMocks());

describe('createReview error mapping', () => {
  test('maps a duplicate review (23505) to 409 already_reviewed', async () => {
    // The unique index is (rental_id, direction): a second review is a client
    // mistake and used to surface as an opaque 500.
    getSupabaseClient.mockReturnValue(fakeClient({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "reviews_rental_direction_key"' },
    }));

    await expect(reputation.createReview(INPUT)).rejects.toMatchObject({
      code: 'already_reviewed',
      status: 409,
    });
  });

  test('maps a missing table to 503 reputation_unavailable', async () => {
    getSupabaseClient.mockReturnValue(fakeClient({
      data: null,
      error: { code: '42P01', message: 'relation "reviews" does not exist' },
    }));

    await expect(reputation.createReview(INPUT)).rejects.toMatchObject({
      code: 'reputation_unavailable',
      status: 503,
    });
  });

  test('returns the created review as camelCase', async () => {
    getSupabaseClient.mockReturnValue(fakeClient({
      data: { id: 'rev-1', rental_id: INPUT.rentalId, created_at: '2026-01-01T00:00:00Z' },
      error: null,
    }));

    const row = await reputation.createReview(INPUT);

    expect(row).toEqual({
      id: 'rev-1',
      rentalId: INPUT.rentalId,
      createdAt: '2026-01-01T00:00:00Z',
    });
  });

  test('lets an unexpected database error bubble so ops can see it', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: '08006' });
    getSupabaseClient.mockReturnValue(fakeClient({ data: null, error: boom }));

    await expect(reputation.createReview(INPUT)).rejects.toThrow('connection reset');
  });
});
