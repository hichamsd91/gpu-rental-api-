/**
 * OAuth identity linking.
 *
 * Rules that matter:
 *  - The stable identity is (provider, provider_user_id) — never the email.
 *  - An existing Veloxora account is linked ONLY when the provider asserts a
 *    verified email that matches it. An unverified email must never be able to
 *    take over somebody else's account.
 *  - The platform system account (used by migration 003 for the commission
 *    ledger) can never be signed into, with a password or a provider.
 */
const crypto = require('crypto');
const { getSupabaseClient } = require('../config/supabase');
const { UserService } = require('./supabaseService');

const TABLE = 'oauth_accounts';
const PROVIDERS = new Set(['google', 'github']);
const PLATFORM_USER_ID = process.env.PLATFORM_USER_ID || '00000000-0000-4000-8000-000000000001';

class OAuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const isPlatformAccount = (userId) => String(userId) === String(PLATFORM_USER_ID);

/** Pick the best email from a passport profile; prefer a verified one. */
const pickEmail = (profile) => {
  const list = Array.isArray(profile?.emails) ? profile.emails : [];
  const usable = list.filter((e) => e && typeof e.value === 'string' && e.value.includes('@'));
  if (!usable.length) return null;
  const verified = usable.find((e) => e.verified !== false && e.verified !== undefined);
  const primary = usable.find((e) => e.primary);
  return (verified || primary || usable[0]).value.toLowerCase().trim();
};

/** True only when the provider explicitly marks the email verified. */
const emailIsVerified = (profile) => {
  const list = Array.isArray(profile?.emails) ? profile.emails : [];
  return list.some((e) => e && e.verified === true);
};

const normalizeProfile = (provider, profile) => {
  if (!PROVIDERS.has(provider)) throw new OAuthError('bad_provider', 'Unsupported provider');
  if (!profile?.id) throw new OAuthError('no_provider_id', 'Provider did not return an id');

  const email = pickEmail(profile);
  return {
    provider,
    providerUserId: String(profile.id),
    email,
    emailVerified: emailIsVerified(profile),
    displayName: profile.displayName || profile.username || (email ? email.split('@')[0] : null),
    avatarUrl: profile.photos?.[0]?.value || null
  };
};

const findLink = async (provider, providerUserId) => {
  const client = getSupabaseClient(true);
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('provider', provider)
    .eq('provider_user_id', providerUserId)
    .maybeSingle();
  if (error) throw new Error(`oauth link lookup failed: ${error.message}`);
  return data;
};

const upsertLink = async (userId, p) => {
  const client = getSupabaseClient(true);
  const { error } = await client.from(TABLE).upsert(
    {
      user_id: userId,
      provider: p.provider,
      provider_user_id: p.providerUserId,
      email: p.email,
      display_name: p.displayName,
      avatar_url: p.avatarUrl,
      last_login_at: new Date().toISOString()
    },
    { onConflict: 'provider,provider_user_id' }
  );
  if (error) throw new Error(`oauth link upsert failed: ${error.message}`);
};

const touchLink = async (provider, providerUserId) => {
  const client = getSupabaseClient(true);
  await client
    .from(TABLE)
    .update({ last_login_at: new Date().toISOString() })
    .eq('provider', provider)
    .eq('provider_user_id', providerUserId);
};

/**
 * Resolve a passport result to a Veloxora user, creating or linking as needed.
 * Returns { user, created, linked }.
 */
const linkOrCreate = async (provider, profile) => {
  const p = normalizeProfile(provider, profile);

  // 1) Known external identity — no email matching involved.
  const existingLink = await findLink(p.provider, p.providerUserId);
  if (existingLink) {
    const user = await UserService.findById(existingLink.user_id);
    if (!user || user.isActive === false || user.is_active === false) {
      throw new OAuthError('account_inactive', 'Account is not available');
    }
    if (isPlatformAccount(user.id)) throw new OAuthError('platform_account', 'This system account cannot sign in');
    await touchLink(p.provider, p.providerUserId);
    return { user, created: false, linked: false };
  }

  // 2) No link yet: an email is required, and it must be verified by the provider.
  if (!p.email) throw new OAuthError('no_email', 'The provider did not return an email address');
  if (!p.emailVerified) throw new OAuthError('email_unverified', 'The provider has not verified this email address');

  const existingUser = await UserService.findByEmail(p.email);
  if (existingUser) {
    if (existingUser.isActive === false || existingUser.is_active === false) {
      throw new OAuthError('account_inactive', 'Account is not available');
    }
    if (isPlatformAccount(existingUser.id)) throw new OAuthError('platform_account', 'This system account cannot sign in');

    await upsertLink(existingUser.id, p);
    // The provider vouched for the address; reflect that on the profile.
    if (existingUser.isVerified !== true && existingUser.is_verified !== true) {
      await UserService.markVerified(existingUser.id);
    }
    return { user: { ...existingUser, isVerified: true }, created: false, linked: true };
  }

  // 3) Brand new person: create a passwordless (random) profile.
  const created = await UserService.create({
    email: p.email,
    password: crypto.randomBytes(32).toString('hex'),
    fullName: p.displayName || p.email.split('@')[0],
    role: 'renter'
  });
  await UserService.markVerified(created.id);
  await upsertLink(created.id, p);
  return { user: { ...created, isVerified: true }, created: true, linked: true };
};

module.exports = {
  linkOrCreate,
  normalizeProfile,
  pickEmail,
  emailIsVerified,
  isPlatformAccount,
  OAuthError,
  PROVIDERS,
  PLATFORM_USER_ID,
  TABLE
};
