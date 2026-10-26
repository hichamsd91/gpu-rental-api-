-- ============================================================================
-- 011_active_sessions.sql
-- ----------------------------------------------------------------------------
-- Phase 1 (P1-05): one row per issued token pair, so a user can see "where am
-- I signed in" and kill a device they no longer trust.
--
-- Why a table instead of deriving sessions from tokens: a JWT proves itself,
-- it does not record itself. Without a row there is no list to show and no way
-- to name the device being killed.
--
-- Enforcement does NOT happen here: revoking a session writes both jtis into
-- auth_blacklist (migration 004), which middleware/auth.js already consults on
-- every request. This table is the inventory; the blacklist is the switch.
--
-- Apply manually in Supabase Dashboard -> SQL Editor.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.sessions;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- The jti is shared by the access and refresh token of one pair (see
  -- utils/token.js), so a single column identifies the whole session.
  jti            TEXT NOT NULL,
  user_agent     TEXT,
  ip_address     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT
);

COMMENT ON TABLE public.sessions IS
  'Issued token pairs (one row per sign-in). Revoking writes the jti to auth_blacklist.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_jti ON public.sessions(jti);
CREATE INDEX IF NOT EXISTS idx_sessions_user_active
  ON public.sessions(user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.sessions TO service_role;

-- ============================================
-- VERIFY (run after apply)
-- ============================================
-- SELECT grantee, privilege_type
--   FROM information_schema.role_table_grants
--  WHERE table_schema = 'public' AND table_name = 'sessions'
--    AND grantee IN ('anon','authenticated','PUBLIC');
--   -- expected: zero rows
