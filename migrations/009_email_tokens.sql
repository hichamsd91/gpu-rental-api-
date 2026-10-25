-- ============================================================================
-- 009_email_tokens.sql
-- ----------------------------------------------------------------------------
-- Phase 1 (auth): single-use, expiring tokens for email verification and
-- password reset (docs/MASTER_PLAN.md P1-01 / P1-02).
--
-- Security posture:
--   - Only the SHA-256 HASH of a token is stored; the raw token is returned to
--     the caller exactly once (a DB leak must never leak a usable link).
--   - Single-use: `used_at` is set on consumption and enforced atomically.
--   - Expiry is enforced on consumption, and a unique index makes re-use / re-
--     issue of the same hash impossible.
--
-- Apply manually in Supabase Dashboard -> SQL Editor.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.email_tokens;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.email_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_tokens IS
  'Single-use, expiring email tokens (verification + password reset). Stores only a SHA-256 hash.';

CREATE INDEX IF NOT EXISTS idx_email_tokens_lookup ON public.email_tokens(purpose, token_hash);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user   ON public.email_tokens(user_id, purpose, created_at DESC);

ALTER TABLE public.email_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.email_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.email_tokens TO service_role;

-- ============================================
-- VERIFY (run after apply)
-- ============================================
-- SELECT grantee, privilege_type
--   FROM information_schema.role_table_grants
--  WHERE table_schema = 'public' AND table_name = 'email_tokens'
--    AND grantee IN ('anon','authenticated','PUBLIC');
--   -- expected: zero rows
