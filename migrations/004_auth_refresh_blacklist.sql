-- ============================================================================
-- Migration 004 — Auth hardening: refresh-token revocation (jti blacklist)
--
-- Why: a refresh token currently stays valid for its full 30-day lifetime —
-- "logout" is client-side only, so a stolen device can keep re-authenticating.
-- This table lets the API revoke tokens server-side:
--
--   * utils/token.js now signs one random `jti` per login/refresh cycle and
--     puts it in BOTH the access token and the refresh token (one pair).
--   * POST /api/auth/logout is a public, best-effort endpoint that takes
--     { refreshToken }, decodes it unverified (we only need jti + exp) and
--     inserts one row here. It returns 200 on success; failure must never be
--     allowed to block the client's local sign-out.
--   * POST /api/auth/refresh rejects any token whose jti is blacklisted, so a
--     logged-out (or rotated-away) refresh token dies immediately instead of
--     at expiry.
--
-- Rows are append-only; nothing deletes rows in code. The optional scheduled
-- cleanup below only removes already-expired entries:
-- ============================================================================

CREATE TABLE IF NOT EXISTS auth_blacklist (
  jti         TEXT        PRIMARY KEY,   -- JWT id claim, unique per token pair
  user_id     UUID,                      -- denormalized for admin/debug visibility
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL       -- original refresh-token expiry (exp*1000ms)
);

CREATE INDEX IF NOT EXISTS idx_auth_blacklist_expires ON auth_blacklist (expires_at);

-- RLS: enabled with NO policies -> reachable ONLY via the service-role key (the API server's own access path).
-- The live project was provisioned through the Supabase SQL editor "Run and enable RLS" flow on 2026-10-19; this
-- line keeps every future restore/re-provision byte-equivalent to what is actually deployed. No policy should ever be
-- added here: anon/authenticated keys must NOT read or write revocation entries (dropping one row re-validates a token).
ALTER TABLE auth_blacklist ENABLE ROW LEVEL SECURITY;

-- Optional daily cleanup (safe to run any time — only already-expired rows):
-- DELETE FROM auth_blacklist WHERE expires_at < now();
