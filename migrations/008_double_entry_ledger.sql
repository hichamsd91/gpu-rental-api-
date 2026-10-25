-- ============================================================================
-- 008_double_entry_ledger.sql
-- ----------------------------------------------------------------------------
-- P0-02: double-entry ledger in integer minor units (docs/MASTER_PLAN.md 2.1).
--
-- Why a ledger at all:
--   Wallets as a single "balance" column invite rounding drift and can be edited
--   by accident; a dispute or an audit then has no way to prove where money went.
--   A double-entry ledger makes every movement a balanced pair of entries, so
--   any balance is a SUM, never a stored guess.
--
-- Why integer minor units (BIGINT cents):
--   Stripe and every serious gateway express money in the currency's smallest
--   unit (e.g. 1099 = $10.99). Integers never accumulate floating-point error,
--   and the current NUMERIC rounding in settle_rental (ROUND(...,3)) stops being
--   a source of truth the moment a movement is recorded here.
--
-- Scope of THIS migration: the mechanism only. No existing table or function is
-- altered, and nothing writes to the ledger yet — wiring it into settlement and
-- payments happens in Phase 4 (money), so this cannot change live behavior.
--
-- Account naming (convention; the full chart of accounts lands with Stripe):
--   wallet:<user_id>       user spendable balance (a platform liability)
--   platform.commission    platform revenue (5%)
--   escrow:<rental_id>     funds held during a rental
--   stripe.cash            external money in/out
--
-- Apply manually in Supabase Dashboard -> SQL Editor.
--
-- Rollback (destructive):
--   DROP FUNCTION IF EXISTS public.post_transfer(UUID,TEXT,TEXT,BIGINT,TEXT,TEXT,UUID);
--   DROP FUNCTION IF EXISTS public.ledger_balance(TEXT,TEXT);
--   DROP TABLE IF EXISTS public.ledger_entries;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ledger_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_group  UUID NOT NULL,            -- one group = one balanced transfer (idempotency key)
  account      TEXT NOT NULL,            -- e.g. 'wallet:<user_id>'
  currency     CHAR(3) NOT NULL DEFAULT 'USD',
  amount_minor BIGINT NOT NULL CHECK (amount_minor <> 0),  -- signed: +credit / -debit, integer cents
  ref_type     TEXT,                     -- 'rental' | 'deposit' | 'payout' | 'commission' | 'refund'
  ref_id       UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ledger_entries IS
  'Append-only double-entry ledger. Every transfer posts a matched debit/credit pair summing to zero.';

-- Each account appears at most once per group => re-posting the same group is a
-- no-op (unique violation), giving idempotency for free at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_group_account ON public.ledger_entries(entry_group, account);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON public.ledger_entries(account, currency);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON public.ledger_entries(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON public.ledger_entries(created_at);

-- Append-only guard: a ledger row can never change once written.
CREATE OR REPLACE FUNCTION public.ledger_entries_is_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only (attempted %)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_entries_append_only ON public.ledger_entries;
CREATE TRIGGER trg_ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.ledger_entries_is_append_only();

-- Post one transfer as a balanced debit/credit pair, atomically.
CREATE OR REPLACE FUNCTION public.post_transfer(
  p_group UUID,
  p_from TEXT,
  p_to TEXT,
  p_amount_minor BIGINT,
  p_currency TEXT DEFAULT 'USD',
  p_ref_type TEXT DEFAULT NULL,
  p_ref_id UUID DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'amount_minor must be a positive integer';
  END IF;
  IF p_from IS NULL OR btrim(p_from) = '' OR p_to IS NULL OR btrim(p_to) = '' THEN
    RAISE EXCEPTION 'from and to accounts are required';
  END IF;
  IF p_from = p_to THEN
    RAISE EXCEPTION 'from and to accounts must differ';
  END IF;

  INSERT INTO public.ledger_entries (entry_group, account, currency, amount_minor, ref_type, ref_id)
  VALUES
    (p_group, p_from, upper(p_currency), -p_amount_minor, p_ref_type, p_ref_id),
    (p_group, p_to,   upper(p_currency),  p_amount_minor, p_ref_type, p_ref_id);
END;
$$;

-- Balance is a SUM over the append-only entries — never a stored column.
CREATE OR REPLACE FUNCTION public.ledger_balance(p_account TEXT, p_currency TEXT DEFAULT 'USD')
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(amount_minor), 0)
    FROM public.ledger_entries
   WHERE account = p_account
     AND currency = upper(p_currency);
$$;

-- ============================================
-- ACCESS CONTROL (service role only)
-- ============================================
ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ledger_entries FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ledger_entries TO service_role;

REVOKE ALL ON FUNCTION public.post_transfer(UUID, TEXT, TEXT, BIGINT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_balance(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_transfer(UUID, TEXT, TEXT, BIGINT, TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.ledger_balance(TEXT, TEXT) TO service_role;

-- ============================================
-- VERIFY (run after apply)
-- ============================================
-- SELECT public.post_transfer(gen_random_uuid(), 'test.a', 'test.b', 1234, 'USD', 'test', NULL);
-- SELECT public.ledger_balance('test.a');  -- expect -1234
-- SELECT public.ledger_balance('test.b');  -- expect  1234
-- DELETE FROM public.ledger_entries WHERE account IN ('test.a','test.b');  -- will be blocked (append-only)
