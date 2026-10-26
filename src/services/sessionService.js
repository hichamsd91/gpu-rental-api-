/**
 * Active-session inventory (P1-05).
 *
 * One row per issued token pair. The row is the LIST the user sees; the actual
 * kill switch is `auth_blacklist` (migration 004), already enforced by
 * middleware/auth.js on every request.
 *
 * Failure posture: this feature must never take authentication down. If
 * migration 011 has not been applied yet (or the DB hiccups), every function
 * degrades to "no inventory" and the caller answers a clear 503 — sign-in,
 * refresh and logout keep working exactly as before.
 */
const { getSupabaseClient } = require('../config/supabase');
const { revokeJti } = require('./revocation');

const TABLE = 'sessions';

/** PostgREST reports a missing table as 42P01 — that is "not deployed", not "broken". */
const isMissingTable = (error) =>
  Boolean(error) && (error.code === '42P01' || /does not exist|Could not find the table/i.test(error.message || ''));

class SessionsUnavailable extends Error {
  constructor() {
    super('Active sessions are not available on this deployment (migration 011 not applied).');
    this.code = 'sessions_unavailable';
  }
}

const client = () => getSupabaseClient(true);

/** Human-friendly, and short enough to store without thinking. */
const describeRequest = (req) => {
  const userAgent = (req?.headers?.['user-agent'] || '').slice(0, 300) || null;
  const forwarded = (req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req?.ip || null;
  return { userAgent, ipAddress: ip ? String(ip).slice(0, 60) : null };
};

/** Records a freshly issued pair. Never throws: a missing inventory must not block sign-in. */
const record = async ({ userId, jti, req }) => {
  if (!userId || !jti) return null;
  const { userAgent, ipAddress } = describeRequest(req);
  try {
    const { error } = await client().from(TABLE).insert({
      user_id: userId,
      jti,
      user_agent: userAgent,
      ip_address: ipAddress,
      last_seen_at: new Date().toISOString()
    });
    if (error) {
      if (!isMissingTable(error)) console.error('sessions.record failed:', error.message);
      return null;
    }
    return true;
  } catch (error) {
    console.error('sessions.record threw:', error.message || String(error));
    return null;
  }
};

/** Marks the moment a session was last used. Best-effort and never blocking. */
const touch = async (jti) => {
  if (!jti) return;
  try {
    const { error } = await client()
      .from(TABLE)
      .update({ last_seen_at: new Date().toISOString() })
      .eq('jti', jti)
      .is('revoked_at', null);
    if (error && !isMissingTable(error)) console.error('sessions.touch failed:', error.message);
  } catch {
    // ignore — activity tracking is cosmetic
  }
};

/** Rotation on refresh: the old row is retired, a new one takes its place. */
const rotate = async ({ userId, oldJti, newJti, req }) => {
  if (!newJti) return null;
  if (oldJti) {
    try {
      await client()
        .from(TABLE)
        .update({ revoked_at: new Date().toISOString(), revoked_reason: 'rotated' })
        .eq('jti', oldJti)
        .is('revoked_at', null);
    } catch {
      // best effort
    }
  }
  return record({ userId, jti: newJti, req });
};

/** The user's live sessions, newest first. Throws SessionsUnavailable when the table is absent. */
const listActive = async (userId) => {
  const { data, error } = await client()
    .from(TABLE)
    .select('id, jti, user_agent, ip_address, created_at, last_seen_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('last_seen_at', { ascending: false });
  if (error) {
    if (isMissingTable(error)) throw new SessionsUnavailable();
    throw new Error(`sessions.listActive failed: ${error.message}`);
  }
  return data || [];
};

/**
 * Revokes ONE session belonging to [userId].
 * Returns false when the row does not exist or belongs to somebody else — the
 * caller answers 404 either way, so ids cannot be probed across accounts.
 */
const revokeOne = async ({ userId, sessionId }) => {
  const { data, error } = await client()
    .from(TABLE)
    .select('id, jti, revoked_at')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) throw new SessionsUnavailable();
    throw new Error(`sessions.revokeOne lookup failed: ${error.message}`);
  }
  if (!data) return false;
  if (data.revoked_at) return true; // already dead — idempotent

  await client()
    .from(TABLE)
    .update({ revoked_at: new Date().toISOString(), revoked_reason: 'user_revoked' })
    .eq('id', data.id);
  // The jti is what every protected route and the refresh endpoint actually check.
  await revokeJti(data.jti, { userId });
  return true;
};

/** Kills every session except the one making the request. Returns how many died. */
const revokeAllExcept = async ({ userId, keepJti }) => {
  const { data, error } = await client()
    .from(TABLE)
    .select('id, jti')
    .eq('user_id', userId)
    .is('revoked_at', null);
  if (error) {
    if (isMissingTable(error)) throw new SessionsUnavailable();
    throw new Error(`sessions.revokeAllExcept failed: ${error.message}`);
  }
  const targets = (data || []).filter((row) => row.jti !== keepJti);
  for (const row of targets) {
    await client()
      .from(TABLE)
      .update({ revoked_at: new Date().toISOString(), revoked_reason: 'revoked_others' })
      .eq('id', row.id);
    await revokeJti(row.jti, { userId });
  }
  return targets.length;
};

/** Logout: retire the row that belongs to the presented refresh token. */
const revokeByJti = async ({ jti }) => {
  if (!jti) return false;
  try {
    const { error } = await client()
      .from(TABLE)
      .update({ revoked_at: new Date().toISOString(), revoked_reason: 'logout' })
      .eq('jti', jti)
      .is('revoked_at', null);
    if (error && !isMissingTable(error)) console.error('sessions.revokeByJti failed:', error.message);
    return true;
  } catch (error) {
    console.error('sessions.revokeByJti threw:', error.message || String(error));
    return false;
  }
};

module.exports = {
  record,
  touch,
  rotate,
  listActive,
  revokeOne,
  revokeAllExcept,
  revokeByJti,
  isMissingTable,
  SessionsUnavailable,
  TABLE
};
