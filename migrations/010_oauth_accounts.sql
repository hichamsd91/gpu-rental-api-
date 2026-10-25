-- ============================================================================
-- 010_oauth_accounts.sql
-- ----------------------------------------------------------------------------
-- Phase 1 (P1-03/P1-04): links an external identity (Google, GitHub) to a
-- Veloxora profile.
--
-- Why a table instead of matching by email on every login: a provider can change
-- the email on the account, and two providers can share one email. The stable
-- (provider, provider_user_id) pair is what identifies the person.
--
-- Linking rule (enforced in code, documented here):
--   - an existing Veloxora account is linked ONLY when the provider asserts a
--     VERIFIED email that matches it — never by an unverified one.
--
-- Apply manually in Supabase Dashboard -> SQL Editor.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.oauth_accounts;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.oauth_accounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  provider_user_id TEXT NOT NULL,
  email            TEXT,
  display_name     TEXT,
  avatar_url       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at    TIMESTAMPTZ
);

COMMENT ON TABLE public.oauth_accounts IS
  'External identity links. (provider, provider_user_id) is the stable identity; email is informational.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_provider_user
  ON public.oauth_accounts(provider, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user
  ON public.oauth_accounts(user_id);

ALTER TABLE public.oauth_accounts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.oauth_accounts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.oauth_accounts TO service_role;

-- ============================================
-- VERIFY (run after apply)
-- ============================================
-- SELECT grantee, privilege_type
--   FROM information_schema.role_table_grants
--  WHERE table_schema = 'public' AND table_name = 'oauth_accounts'
--    AND grantee IN ('anon','authenticated','PUBLIC');
--   -- expected: zero rows
