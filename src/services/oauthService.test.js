jest.mock('../config/supabase', () => ({ getSupabaseClient: jest.fn() }));
jest.mock('./supabaseService', () => ({
  UserService: {
    findById: jest.fn(),
    findByEmail: jest.fn(),
    create: jest.fn(),
    markVerified: jest.fn()
  }
}));

const { getSupabaseClient } = require('../config/supabase');
const { UserService } = require('./supabaseService');
const oauth = require('./oauthService');

const PLATFORM_ID = '00000000-0000-4000-8000-000000000001';

const makeClient = ({ link = null, linkError = null } = {}) => {
  const maybeSingle = jest.fn().mockResolvedValue({ data: link, error: linkError });
  const eq2 = jest.fn(() => ({ maybeSingle }));
  const eq1 = jest.fn(() => ({ eq: eq2 }));
  const select = jest.fn(() => ({ eq: eq1 }));

  const updateEq2 = jest.fn().mockResolvedValue({ error: null });
  const updateEq1 = jest.fn(() => ({ eq: updateEq2 }));
  const update = jest.fn(() => ({ eq: updateEq1 }));

  const upsert = jest.fn().mockResolvedValue({ error: null });
  const from = jest.fn(() => ({ select, update, upsert }));
  return { from, spies: { select, update, upsert } };
};

const googleProfile = (overrides = {}) => ({
  id: 'google-123',
  displayName: 'Hicham',
  emails: [{ value: 'hicham@example.com', verified: true, primary: true }],
  photos: [{ value: 'https://img.example/a.png' }],
  ...overrides
});

beforeEach(() => jest.clearAllMocks());

describe('profile normalization', () => {
  test('picks the verified email and builds a normalized identity', () => {
    const p = oauth.normalizeProfile('google', googleProfile());
    expect(p).toMatchObject({
      provider: 'google',
      providerUserId: 'google-123',
      email: 'hicham@example.com',
      emailVerified: true,
      displayName: 'Hicham',
      avatarUrl: 'https://img.example/a.png'
    });
  });

  test('rejects an unsupported provider', () => {
    expect(() => oauth.normalizeProfile('facebook', googleProfile())).toThrow(/Unsupported provider/);
  });

  test('accepts an unverified email but flags it as unverified', () => {
    const p = oauth.normalizeProfile('github', {
      id: 'gh-1',
      emails: [{ value: 'a@example.com', verified: false }]
    });
    expect(p.email).toBe('a@example.com');
    expect(p.emailVerified).toBe(false);
  });
});

describe('linkOrCreate', () => {
  test('returns the linked user without any email matching', async () => {
    getSupabaseClient.mockReturnValue(makeClient({ link: { user_id: 'u-1' } }));
    UserService.findById.mockResolvedValue({ id: 'u-1', isActive: true });

    const result = await oauth.linkOrCreate('google', googleProfile());

    expect(result).toMatchObject({ created: false, linked: false });
    expect(result.user.id).toBe('u-1');
    expect(UserService.findByEmail).not.toHaveBeenCalled();
  });

  test('refuses the platform system account', async () => {
    getSupabaseClient.mockReturnValue(makeClient({ link: { user_id: PLATFORM_ID } }));
    UserService.findById.mockResolvedValue({ id: PLATFORM_ID, isActive: true });

    await expect(oauth.linkOrCreate('google', googleProfile())).rejects.toMatchObject({ code: 'platform_account' });
  });

  test('refuses an inactive linked account', async () => {
    getSupabaseClient.mockReturnValue(makeClient({ link: { user_id: 'u-1' } }));
    UserService.findById.mockResolvedValue({ id: 'u-1', isActive: false });

    await expect(oauth.linkOrCreate('google', googleProfile())).rejects.toMatchObject({ code: 'account_inactive' });
  });

  test('requires an email when there is no link yet', async () => {
    getSupabaseClient.mockReturnValue(makeClient());
    const profile = googleProfile({ emails: [] });

    await expect(oauth.linkOrCreate('google', profile)).rejects.toMatchObject({ code: 'no_email' });
  });

  test('refuses to link an account using an unverified provider email', async () => {
    getSupabaseClient.mockReturnValue(makeClient());
    const profile = googleProfile({ emails: [{ value: 'victim@example.com', verified: false }] });

    await expect(oauth.linkOrCreate('google', profile)).rejects.toMatchObject({ code: 'email_unverified' });
    expect(UserService.findByEmail).not.toHaveBeenCalled();
  });

  test('links to an existing account when the verified email matches', async () => {
    const client = makeClient();
    getSupabaseClient.mockReturnValue(client);
    UserService.findByEmail.mockResolvedValue({ id: 'u-2', isActive: true, isVerified: false });
    UserService.markVerified.mockResolvedValue(true);

    const result = await oauth.linkOrCreate('google', googleProfile());

    expect(result).toMatchObject({ created: false, linked: true });
    expect(client.spies.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u-2', provider: 'google', provider_user_id: 'google-123' }),
      { onConflict: 'provider,provider_user_id' }
    );
    expect(UserService.markVerified).toHaveBeenCalledWith('u-2');
  });

  test('creates a passwordless profile for a brand new person', async () => {
    const client = makeClient();
    getSupabaseClient.mockReturnValue(client);
    UserService.findByEmail.mockResolvedValue(null);
    UserService.create.mockResolvedValue({ id: 'u-new', email: 'hicham@example.com' });
    UserService.markVerified.mockResolvedValue(true);

    const result = await oauth.linkOrCreate('google', googleProfile());

    expect(result).toMatchObject({ created: true, linked: true });
    expect(UserService.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'hicham@example.com', role: 'renter' })
    );
    expect(UserService.markVerified).toHaveBeenCalledWith('u-new');
    expect(client.spies.upsert).toHaveBeenCalled();
  });
});
