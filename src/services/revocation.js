const { getSupabaseClient } = require('../config/supabase');

// ============================================================================
// Revocation service — single source of truth for the jti blacklist.
// See migrations/004_auth_refresh_blacklist.sql.
//
// Why it lives in its own module: the auth middleware (middleware/auth.js)
// consults it on EVERY authenticated request, so an access token dies at
// logout / refresh-rotation time — not when its TTL expires. The refresh
// handler also writes here once per rotation. One implementation, one query shape.
//
// Failure posture:
// - Reads run with the service-role client (RLS-exempt): auth can never hang on
//   this table's RLS state. Read failures RE-THROW: the caller fails closed
//   (503 "temporary"), because answering a request from a token whose revocation
//   status we could not check is exactly the old 7-day gap this module exists to close.
// - Writes are best-effort at the call sites: clients must never be blocked from
//   signing out or refreshing by a transient database problem (pre-existing contract).
// ============================================================================

const BLACKLIST_TABLE = 'auth_blacklist'; // raw snake_case-safe ad-hoc table name
const LOG_JTI_PREFIX_LEN = 8; // log a short prefix, never the full id

async function isJtiBlacklisted(jti) {
  if (!jti) return false; // legacy pre-jti tokens: nothing to look up — fail open by design there
  const client = getSupabaseClient(true);
  try {
    let result;
    try {
      result = await client.from(BLACKLIST_TABLE).select('jti').eq('jti', jti).maybeSingle();
    } catch (networkError) {
      // Transport-level failure (server down, DNS flap) — supabase-js rejects the Promise.
      throw new Error(`revocation lookup failed for jti ${String(jti).slice(0, LOG_JTI_PREFIX_LEN)}…: ${networkError.message || networkError}`);
    }
    if (result.error) {
      // HTTP-level failure (table missing, PostgREST hiccup) — supabase-js resolves with .error. Both shapes must fail closed.
      throw new Error(`revocation lookup failed for jti ${String(jti).slice(0, LOG_JTI_PREFIX_LEN)}…: ${result.error.message}`);
    }
    return Boolean(result.data);
  } catch (error) {
    // Re-throw only if we ourselves raised it above; anything else is a genuine unexpected fault — also fail closed.
    throw error instanceof Error && /revocation lookup failed/.test(error.message) ? error : new Error(`revocation lookup failed for jti ${String(jti).slice(0, LOG_JTI_PREFIX_LEN)}…: ${error.message || error}`);
  }
}

async function revokeJti(jti, { userId = null, expSeconds = null } = {}) {
  if (!jti) return false;
  const client = getSupabaseClient(true);
  // Keep the row slightly past the original expiry so a late rotation carrying
  // this same jti still finds it. The enforcer-style prune deletes expired rows.
  const expiresAt = Number.isFinite(expSeconds) ? new Date((expSeconds + 2 * 60 * 60) * 1000).toISOString() : null;
  try {
    await client.from(BLACKLIST_TABLE).upsert(
      { jti, user_id: userId || null, created_at: new Date().toISOString(), expires_at: expiresAt },
      { onConflict: 'jti' }
    );
    if (userId) console.log(`Revocation persisted for jti ${String(jti).slice(0, LOG_JTI_PREFIX_LEN)}… (user ${userId})`);
    return true;
  } catch (error) {
    // Table missing yet (fresh deploy before migration 004) or DB down — best-effort contract: report false.
    console.error(`revocation persist failed for jti ${String(jti).slice(0, LOG_JTI_PREFIX_LEN)}…:`, error.message ? error.message : String(error));
    return false;
  }
}

module.exports = { isJtiBlacklisted, revokeJti };
