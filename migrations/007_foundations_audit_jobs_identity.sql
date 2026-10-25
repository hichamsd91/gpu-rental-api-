-- ============================================================================
-- 007_foundations_audit_jobs_identity.sql
-- ----------------------------------------------------------------------------
-- Phase 0 foundations for the pre-launch build-out (docs/MASTER_PLAN.md).
-- Everything here is ADDITIVE: no existing table or column is altered, so this
-- migration cannot change behavior of the running API.
--
-- Contents:
--   1. audit_log             append-only trail of privileged/administrative actions
--   2. jobs                  durable background queue with atomic claiming
--   3. feature_flags         server-side kill switches (payments, mining, ...)
--   4. identities + signals  identity-cluster base for ban-evasion resistance
--   5. enforcement_actions   every restriction/suspension/ban is recorded
--
-- Access model: the API is the only client (service role). Direct PostgREST
-- access to these tables is revoked exactly like migration 006 did for
-- gpu_listings — anon/authenticated must never read the audit trail or the
-- identity graph.
--
-- Apply manually in Supabase Dashboard -> SQL Editor (same workflow as 002-006).
--
-- Rollback (destructive, review before running):
--   DROP FUNCTION IF EXISTS public.claim_jobs(TEXT, INT);
--   DROP FUNCTION IF EXISTS public.finish_job(UUID, TEXT, TEXT);
--   DROP TABLE IF EXISTS public.enforcement_actions, public.identity_links,
--     public.identity_signals, public.identities, public.feature_flags,
--     public.jobs, public.audit_log;
-- ============================================================================

-- ============================================
-- 1) AUDIT LOG — append-only
-- ============================================
CREATE TABLE IF NOT EXISTS public.audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  ip          TEXT,
  user_agent  TEXT,
  request_id  TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_log IS
  'Append-only trail. Never update or delete rows: a dispute or a ban must be explainable months later.';

CREATE INDEX IF NOT EXISTS idx_audit_entity  ON public.audit_log(entity, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON public.audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON public.audit_log(created_at DESC);

-- Append-only guard: block UPDATE/DELETE even for the API's service role.
CREATE OR REPLACE FUNCTION public.audit_log_is_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (attempted %)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_append_only ON public.audit_log;
CREATE TRIGGER trg_audit_log_append_only
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_is_append_only();

-- ============================================
-- 2) JOBS — durable queue
-- ============================================
CREATE TABLE IF NOT EXISTS public.jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 50),
  run_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at     TIMESTAMPTZ,
  locked_by     TEXT,
  -- Optional idempotency key: two enqueues with the same key produce one job.
  dedupe_key    TEXT UNIQUE,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.jobs IS
  'Durable background queue. Claim with claim_jobs() so two workers can never take the same row.';

CREATE INDEX IF NOT EXISTS idx_jobs_due ON public.jobs(status, run_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_jobs_kind ON public.jobs(kind, created_at DESC);

-- Atomic claim: SELECT ... FOR UPDATE SKIP LOCKED inside one statement, so the
-- queue stays correct under any number of concurrent workers.
CREATE OR REPLACE FUNCTION public.claim_jobs(p_worker TEXT, p_batch INTEGER DEFAULT 1)
RETURNS SETOF public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_size INTEGER := GREATEST(1, LEAST(COALESCE(p_batch, 1), 50));
BEGIN
  IF p_worker IS NULL OR length(trim(p_worker)) = 0 THEN
    RAISE EXCEPTION 'p_worker is required';
  END IF;

  RETURN QUERY
  WITH picked AS (
    SELECT j.id
      FROM public.jobs j
     WHERE j.status = 'queued'
       AND j.run_after <= now()
     ORDER BY j.run_after, j.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT v_size
  )
  UPDATE public.jobs j
     SET status     = 'running',
         attempts   = j.attempts + 1,
         locked_at  = now(),
         locked_by  = p_worker,
         updated_at = now()
    FROM picked
   WHERE j.id = picked.id
  RETURNING j.*;
END;
$$;

-- Finish a claimed job. On failure the row is re-queued with exponential
-- backoff until max_attempts, then parked as 'dead' for human review.
CREATE OR REPLACE FUNCTION public.finish_job(p_id UUID, p_status TEXT, p_error TEXT DEFAULT NULL)
RETURNS public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.jobs;
BEGIN
  IF p_status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'invalid job status: %', p_status;
  END IF;

  IF p_status = 'succeeded' THEN
    UPDATE public.jobs
       SET status = 'succeeded', last_error = NULL,
           locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = p_id
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
           last_error = left(COALESCE(p_error, 'unknown error'), 2000),
           run_after = CASE
                         WHEN attempts >= max_attempts THEN run_after
                         ELSE now() + make_interval(
                                secs => LEAST(power(2, GREATEST(attempts, 1)) * 30, 3600)::double precision)
                       END,
           locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = p_id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

-- ============================================
-- 3) FEATURE FLAGS — server-side kill switches
-- ============================================
CREATE TABLE IF NOT EXISTS public.feature_flags (
  key         TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  updated_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.feature_flags (key, enabled, description) VALUES
  ('payments.enabled', false, 'Stripe gateway + escrow flow'),
  ('mining.allowed',   false, 'Opt-in mining-friendly listings (decision D2)'),
  ('payouts.enabled',  false, 'Provider payouts (T+7 dispute window)'),
  ('multi_listing_orders.enabled', false, 'Cart with several listings per order')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- 4) IDENTITY GRAPH — ban evasion resistance (decision A7)
-- ============================================
CREATE TABLE IF NOT EXISTS public.identities (
  user_id         UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'restricted', 'suspended', 'banned')),
  risk_score      SMALLINT NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  cluster_id      UUID,
  verified_email  BOOLEAN NOT NULL DEFAULT false,
  verified_phone  BOOLEAN NOT NULL DEFAULT false,
  verified_payment BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_identities_cluster ON public.identities(cluster_id);
CREATE INDEX IF NOT EXISTS idx_identities_status  ON public.identities(status);

-- Signals are stored as HMAC hashes only. Raw phone numbers / card fingerprints
-- must never land in this table: the graph only needs equality, never the value.
CREATE TABLE IF NOT EXISTS public.identity_signals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
                'email', 'email_domain', 'phone', 'card_fingerprint',
                'device', 'ip', 'asn', 'gpu_uuid', 'payout_account', 'behavior')),
  value_hash  TEXT NOT NULL,
  weight      SMALLINT NOT NULL DEFAULT 10 CHECK (weight BETWEEN 1 AND 100),
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (user_id, kind, value_hash)
);

CREATE INDEX IF NOT EXISTS idx_signals_lookup ON public.identity_signals(kind, value_hash);
CREATE INDEX IF NOT EXISTS idx_signals_user   ON public.identity_signals(user_id);

-- Undirected pair, stored once (a_user < b_user) to keep the graph tidy.
CREATE TABLE IF NOT EXISTS public.identity_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  a_user      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  b_user      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  weight      SMALLINT NOT NULL DEFAULT 10 CHECK (weight BETWEEN 1 AND 100),
  confidence  NUMERIC(4, 3) NOT NULL DEFAULT 0.500 CHECK (confidence >= 0 AND confidence <= 1),
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT identity_links_ordered CHECK (a_user < b_user)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_links_pair ON public.identity_links(a_user, b_user);
CREATE INDEX IF NOT EXISTS idx_identity_links_b ON public.identity_links(b_user);

CREATE TABLE IF NOT EXISTS public.enforcement_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action      TEXT NOT NULL CHECK (action IN ('flag', 'restrict', 'suspend', 'ban', 'unban')),
  reason      TEXT NOT NULL,
  actor_id    UUID,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enforcement_user ON public.enforcement_actions(user_id, created_at DESC);

-- ============================================
-- 5) ACCESS CONTROL
-- ============================================
ALTER TABLE public.audit_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identities           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identity_signals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identity_links       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enforcement_actions  ENABLE ROW LEVEL SECURITY;

-- Service role owns these tables; the public PostgREST roles own nothing.
REVOKE ALL ON TABLE public.audit_log, public.jobs, public.feature_flags,
                       public.identities, public.identity_signals,
                       public.identity_links, public.enforcement_actions
  FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.audit_log, public.jobs, public.feature_flags,
                     public.identities, public.identity_signals,
                     public.identity_links, public.enforcement_actions
  TO service_role;

-- SECURITY DEFINER functions must not be callable by the public roles.
REVOKE ALL ON FUNCTION public.claim_jobs(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_job(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_jobs(TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_job(UUID, TEXT, TEXT) TO service_role;

-- ============================================
-- VERIFY (run after apply)
-- ============================================
-- SELECT table_name, privilege_type, grantee
--   FROM information_schema.role_table_grants
--  WHERE table_schema = 'public'
--    AND table_name IN ('audit_log','jobs','feature_flags','identities',
--                       'identity_signals','identity_links','enforcement_actions')
--    AND grantee IN ('anon','authenticated','PUBLIC');
--   -- expected: zero rows
--
-- SELECT * FROM public.feature_flags ORDER BY key;
--   -- expected: 4 flags, all disabled
