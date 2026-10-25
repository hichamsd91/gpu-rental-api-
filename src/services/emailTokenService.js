/**
 * Email token service — single-use tokens for verification and password reset.
 *
 * The raw token is generated here and returned to the caller exactly once; only
 * its SHA-256 hash reaches the database. Consumption is atomic (one UPDATE
 * guarded by `used_at IS NULL` and `expires_at >= now()`), so a token can never
 * be replayed, and two concurrent links for the same user are independent.
 */
const crypto = require('crypto');
const { getSupabaseClient } = require('../config/supabase');

const TABLE = 'email_tokens';
const PURPOSE = { VERIFY_EMAIL: 'verify_email', RESET_PASSWORD: 'reset_password' };
const TTL_HOURS = { [PURPOSE.VERIFY_EMAIL]: 48, [PURPOSE.RESET_PASSWORD]: 24 };

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const newToken = () => crypto.randomBytes(32).toString('hex');

/**
 * Create a token. Returns the RAW token (what goes into the email link).
 */
const issue = async ({ userId, purpose, ttlHours = null }) => {
  if (!userId) throw new TypeError('issue: userId is required');
  if (!Object.values(PURPOSE).includes(purpose)) throw new TypeError(`issue: invalid purpose ${purpose}`);

  const raw = newToken();
  const hours = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : TTL_HOURS[purpose];
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  const client = getSupabaseClient(true);
  const { error } = await client.from(TABLE).insert({
    user_id: userId,
    purpose,
    token_hash: sha256(raw),
    expires_at: expiresAt
  });
  if (error) throw new Error(`email token issue failed: ${error.message}`);

  return raw;
};

/**
 * Consume a token atomically. Returns the userId on success, or null when the
 * token is unknown, already used, or expired (all look identical to a caller).
 */
const consume = async (rawToken, purpose) => {
  if (!rawToken || !Object.values(PURPOSE).includes(purpose)) return null;

  const client = getSupabaseClient(true);
  const nowIso = new Date().toISOString();

  const { data, error } = await client
    .from(TABLE)
    .update({ used_at: nowIso })
    .eq('token_hash', sha256(rawToken))
    .eq('purpose', purpose)
    .is('used_at', null)
    .gte('expires_at', nowIso)
    .select('user_id')
    .maybeSingle();

  if (error) throw new Error(`email token consume failed: ${error.message}`);
  return data?.user_id || null;
};

/** Invalidate every outstanding token of a purpose for a user (logout-all / re-issue). */
const revokeAllForUser = async (userId, purpose) => {
  const client = getSupabaseClient(true);
  const { error } = await client
    .from(TABLE)
    .update({ used_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('purpose', purpose)
    .is('used_at', null);
  if (error) throw new Error(`email token revoke failed: ${error.message}`);
  return true;
};

module.exports = { issue, consume, revokeAllForUser, PURPOSE, TTL_HOURS, sha256, TABLE };
