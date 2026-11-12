-- CONSOLIDATED MIGRATIONS (apply in Supabase SQL Editor in one shot)
-- Order: 008,011,012,013,014,015,016,017,018


-- ============================================================
-- migrations/008_double_entry_ledger.sql
-- ============================================================

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



-- ============================================================
-- migrations/011_active_sessions.sql
-- ============================================================

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



-- ============================================================
-- migrations/012_catalog_purposes_availability.sql
-- ============================================================

-- ============================================================================
-- 012_catalog_purposes_availability.sql
-- ----------------------------------------------------------------------------
-- Phase 2 (P2-01 … P2-06): rental purposes, installed software, access
-- methods, availability windows, blackouts and the priced mining opt-in (D2).
--
-- Everything is ADDITIVE. The API degrades gracefully while this migration is
-- pending: listings still list/book, only the new catalog extras disappear.
--
-- Money note: price columns are NUMERIC(10,2) dollars like the existing
-- gpu_listings.price_per_hour. Conversion to integer minor units happens at the
-- ledger boundary (decision A1), never here.
--
-- Apply manually in Supabase Dashboard -> SQL Editor (same workflow as 002-011).
--
-- Rollback (destructive, review before running):
--   ALTER TABLE public.rentals DROP COLUMN IF EXISTS purpose;
--   ALTER TABLE public.gpu_listings
--     DROP CONSTRAINT IF EXISTS gpu_listings_access_methods_valid,
--     DROP COLUMN IF EXISTS access_methods;
--   DROP TABLE IF EXISTS public.listing_blackouts, public.listing_availability,
--     public.listing_software, public.listing_purposes, public.rental_purposes;
-- ============================================================================

-- ============================================
-- 1) RENTAL PURPOSES — the catalog (P2-01)
-- ============================================
CREATE TABLE IF NOT EXISTS public.rental_purposes (
  key             TEXT PRIMARY KEY,
  label_en        TEXT NOT NULL,
  description_en  TEXT,
  -- Client-side icon hint; unknown values fall back to a generic icon.
  icon            TEXT,
  -- Optional feature flag that must be enabled before this purpose can be
  -- offered. Mining is the only gated one today (decision D2).
  requires_flag   TEXT,
  sort_order      SMALLINT NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.rental_purposes IS
  'Catalog of rental intents. Labels are English; the app localizes by key.';

INSERT INTO public.rental_purposes (key, label_en, description_en, icon, requires_flag, sort_order) VALUES
  ('training',  'Model training',       'Fine-tuning and training runs on dedicated VRAM.',            'training',  NULL,             10),
  ('inference', 'Inference & serving',  'Low-latency serving for LLMs, vision and embeddings.',        'inference', NULL,             20),
  ('rendering', '3D rendering',         'Blender, Octane and CUDA render jobs.',                       'rendering', NULL,             30),
  ('research',  'Research & experiments','Notebooks, benchmarks and one-off experiments.',             'research',  NULL,             40),
  ('mining',    'Mining-friendly',      'Opt-in hashing with a declared power cap and its own price.', 'mining',    'mining.allowed', 50)
ON CONFLICT (key) DO UPDATE
  SET label_en       = EXCLUDED.label_en,
      description_en = EXCLUDED.description_en,
      icon           = EXCLUDED.icon,
      requires_flag  = EXCLUDED.requires_flag,
      sort_order     = EXCLUDED.sort_order;

-- ============================================
-- 2) LISTING ↔ PURPOSE (P2-02, P2-06)
-- ============================================
-- A listing may serve several purposes. The row carries an optional price
-- override (mining MUST set one — its price is independent of the base rate)
-- plus purpose-specific specifications.
CREATE TABLE IF NOT EXISTS public.listing_purposes (
  listing_id     UUID NOT NULL REFERENCES public.gpu_listings(id) ON DELETE CASCADE,
  purpose_key    TEXT NOT NULL REFERENCES public.rental_purposes(key) ON DELETE RESTRICT,
  -- NULL = use gpu_listings.price_per_hour. Set = a separate price for this
  -- purpose (mining is required to set it).
  price_per_hour NUMERIC(10,2),
  -- e.g. mining: {"powerCapWatts":320,"disclosure":"...","coin":"..."}
  specs          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, purpose_key),
  CONSTRAINT listing_purposes_price_nonnegative
    CHECK (price_per_hour IS NULL OR price_per_hour >= 0)
);

CREATE INDEX IF NOT EXISTS idx_listing_purposes_key
  ON public.listing_purposes(purpose_key);

-- ============================================
-- 3) INSTALLED SOFTWARE + ACCESS METHOD (P2-05)
-- ============================================
CREATE TABLE IF NOT EXISTS public.listing_software (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES public.gpu_listings(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  version    TEXT,
  category   TEXT NOT NULL DEFAULT 'other'
             CHECK (category IN ('cuda', 'framework', 'tool', 'other')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, name)
);

CREATE INDEX IF NOT EXISTS idx_listing_software_listing
  ON public.listing_software(listing_id);

-- How a renter reaches the machine. Kept as a small array so one listing can
-- offer more than one route; the concrete credentials stay in specs.access.
ALTER TABLE public.gpu_listings
  ADD COLUMN IF NOT EXISTS access_methods TEXT[] NOT NULL DEFAULT ARRAY['ssh']::TEXT[];

DO $$
BEGIN
  ALTER TABLE public.gpu_listings
    ADD CONSTRAINT gpu_listings_access_methods_valid
    CHECK (access_methods <@ ARRAY['ssh', 'rdp', 'streaming', 'jupyter']::TEXT[]);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- 4) AVAILABILITY (P2-04)
-- ============================================
-- Recurring weekly windows in UTC minutes-since-midnight. No rows for a listing
-- = always open. A window never crosses midnight (start < end) so the check
-- stays a simple containment test per UTC day.
CREATE TABLE IF NOT EXISTS public.listing_availability (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID NOT NULL REFERENCES public.gpu_listings(id) ON DELETE CASCADE,
  weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday (UTC)
  start_minute SMALLINT NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   SMALLINT NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT listing_availability_order CHECK (start_minute < end_minute),
  UNIQUE (listing_id, weekday, start_minute, end_minute)
);

CREATE INDEX IF NOT EXISTS idx_listing_availability_listing
  ON public.listing_availability(listing_id, weekday);

-- One-off closures. ends_at is exclusive.
CREATE TABLE IF NOT EXISTS public.listing_blackouts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES public.gpu_listings(id) ON DELETE CASCADE,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT listing_blackouts_order CHECK (starts_at < ends_at)
);

CREATE INDEX IF NOT EXISTS idx_listing_blackouts_window
  ON public.listing_blackouts(listing_id, starts_at, ends_at);

-- The chosen purpose is recorded on the rental so settlement and disputes can
-- tell a training run from a mining job.
ALTER TABLE public.rentals
  ADD COLUMN IF NOT EXISTS purpose TEXT;

-- ============================================
-- 5) ACCESS CONTROL
-- ============================================
ALTER TABLE public.rental_purposes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_purposes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_software     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_blackouts    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rental_purposes, public.listing_purposes,
                   public.listing_software, public.listing_availability,
                   public.listing_blackouts
  FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.rental_purposes, public.listing_purposes,
                  public.listing_software, public.listing_availability,
                  public.listing_blackouts
  TO service_role;

-- ============================================
-- VERIFY (run after apply)
-- ============================================
-- SELECT key, label_en, requires_flag FROM public.rental_purposes ORDER BY sort_order;
--   -- expected: 5 rows (training, inference, rendering, research, mining)
--
-- SELECT grantee, privilege_type
--   FROM information_schema.role_table_grants
--  WHERE table_schema = 'public'
--    AND table_name IN ('rental_purposes','listing_purposes','listing_software',
--                       'listing_availability','listing_blackouts')
--    AND grantee IN ('anon','authenticated','PUBLIC');
--   -- expected: zero rows
--
-- SELECT column_name, data_type
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='gpu_listings'
--    AND column_name='access_methods';
--   -- expected: one row, ARRAY



-- ============================================================
-- migrations/013_orders_cart.sql
-- ============================================================

-- ============================================================================
-- 013_orders_cart.sql
-- ----------------------------------------------------------------------------
-- Phase 3 (P3-01 … P3-06): multi-item orders, atomic reservation, idempotent
-- mutations and partial cancellation.
--
-- Why the logic lives in SQL: a cart touches several rows (order, items, the
-- listings' availability, other renters' holds). Only a single transaction can
-- make "all items reserved or none" true. The API therefore calls three RPCs:
--
--   order_reserve(p_order_id, p_renter_id, p_ttl_seconds)
--   order_pay    (p_order_id, p_renter_id)
--   order_cancel (p_order_id, p_renter_id, p_item_ids)
--   order_expire_stale(p_limit)
--
-- Design decisions honoured here:
--   * A hold is a TTL, never a permanent lock: every conflict query ignores
--     rows whose hold_expires_at has passed. A client that vanishes mid-flight
--     can therefore never block a GPU — the hold simply stops counting.
--   * Status transitions are compare-and-set under SELECT ... FOR UPDATE, so a
--     retried or duplicated request cannot double-create rentals.
--   * Listings are locked in id order (deadlock-free) before items change.
--   * No money moves here. Paying converts holds to `rentals` rows; the
--     existing wallet/escrow gate at rental start remains the only debit path
--     until Phase 4 replaces it with Stripe + the double-entry ledger.
--
-- Everything is additive and idempotent. Without this migration the API answers
-- 503 { code: 'orders_unavailable' } and the rest of the platform keeps working.
--
-- Apply manually in Supabase Dashboard -> SQL Editor (same flow as 002-012).
--
-- Rollback (destructive, review before running):
--   DROP FUNCTION IF EXISTS public.order_expire_stale(integer);
--   DROP FUNCTION IF EXISTS public.order_cancel(uuid, uuid, uuid[]);
--   DROP FUNCTION IF EXISTS public.order_pay(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.order_reserve(uuid, uuid, integer);
--   DROP TABLE IF EXISTS public.idempotency_keys, public.order_items, public.orders;
-- ============================================================================

-- ============================================
-- 1) ORDERS (P3-01)
-- ============================================
CREATE TABLE IF NOT EXISTS public.orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  renter_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- draft -> awaiting_payment -> paid ; draft/awaiting_payment -> cancelled|expired
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'awaiting_payment', 'paid', 'cancelled', 'expired')),
  currency        TEXT NOT NULL DEFAULT 'USD',
  subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  total           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  -- Optimistic concurrency token: bumped by every state change.
  version         INTEGER NOT NULL DEFAULT 1,
  -- Deadline of the CURRENT hold set (null while draft).
  hold_expires_at TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_renter_status
  ON public.orders(renter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_stale_holds
  ON public.orders(hold_expires_at)
  WHERE status = 'awaiting_payment';

-- ============================================
-- 2) ORDER ITEMS (P3-01, P3-04, P3-06)
-- ============================================
CREATE TABLE IF NOT EXISTS public.order_items (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  listing_id               UUID NOT NULL REFERENCES public.gpu_listings(id) ON DELETE RESTRICT,
  provider_id              UUID,
  purpose                  TEXT,
  planned_duration_minutes INTEGER NOT NULL CHECK (planned_duration_minutes > 0),
  -- Price quoted and frozen at draft time. `unit_price_per_hour` is the
  -- purpose's own price when it has one (mining), never a client value.
  unit_price_per_hour      NUMERIC(12,2) NOT NULL CHECK (unit_price_per_hour >= 0),
  line_total               NUMERIC(12,2) NOT NULL CHECK (line_total >= 0),
  starts_at                TIMESTAMPTZ NOT NULL,
  ends_at                  TIMESTAMPTZ NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'held', 'rental_created', 'cancelled', 'expired', 'failed')),
  rental_id                UUID,
  hold_expires_at          TIMESTAMPTZ,
  failure_code             TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_items_window CHECK (ends_at > starts_at),
  -- Same GPU may appear twice only for two DIFFERENT windows.
  UNIQUE (order_id, listing_id, purpose, starts_at)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order
  ON public.order_items(order_id);
-- Drives the overlap query: only live holds matter.
CREATE INDEX IF NOT EXISTS idx_order_items_live_holds
  ON public.order_items(listing_id, hold_expires_at)
  WHERE status = 'held';

-- ============================================
-- 3) IDEMPOTENCY KEYS (P3-03)
-- ============================================
-- One row per (user, key). A retry with the same key replays the stored
-- response verbatim instead of re-running the mutation; a different body under
-- the same key is a hard 409 so a stolen key can never rewrite an order.
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  user_id         UUID NOT NULL,
  key             TEXT NOT NULL,
  scope           TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'in_flight'
                  CHECK (status IN ('in_flight', 'succeeded', 'failed')),
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created
  ON public.idempotency_keys(created_at);

-- ============================================
-- 4) RPC: reserve every item, or none (P3-02)
-- ============================================
CREATE OR REPLACE FUNCTION public.order_reserve(
  p_order_id    UUID,
  p_renter_id   UUID,
  p_ttl_seconds INTEGER DEFAULT 900
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order    public.orders%ROWTYPE;
  v_item     public.order_items%ROWTYPE;
  v_expires  TIMESTAMPTZ := now() + make_interval(secs => GREATEST(COALESCE(p_ttl_seconds, 900), 60));
  v_items    INTEGER := 0;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.renter_id <> p_renter_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'order_not_found');
  END IF;

  -- Already holding a live set: a retried request gets the same answer.
  IF v_order.status = 'awaiting_payment' AND v_order.hold_expires_at > now() THEN
    RETURN jsonb_build_object('ok', true, 'code', 'already_reserved',
                              'holdExpiresAt', v_order.hold_expires_at);
  END IF;

  IF v_order.status NOT IN ('draft', 'expired') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'order_not_reservable', 'status', v_order.status);
  END IF;

  -- Deadlock-free: every transaction locks the same listings in id order.
  PERFORM 1 FROM public.gpu_listings
   WHERE id IN (SELECT listing_id FROM public.order_items WHERE order_id = p_order_id)
   ORDER BY id
   FOR UPDATE;

  -- PHASE 1 — validate everything. A plpgsql RETURN still COMMITS earlier
  -- writes, so nothing may be written until every item is known to be free.
  FOR v_item IN
    SELECT * FROM public.order_items
     WHERE order_id = p_order_id AND status IN ('draft', 'expired', 'failed')
     ORDER BY listing_id
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.gpu_listings
       WHERE id = v_item.listing_id AND status = 'active' AND is_public = true
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'listing_unavailable',
                                'itemId', v_item.id, 'listingId', v_item.listing_id);
    END IF;

    -- Someone else's live hold on an overlapping window.
    IF EXISTS (
      SELECT 1
        FROM public.order_items oi
       WHERE oi.listing_id = v_item.listing_id
         AND oi.order_id <> p_order_id
         AND oi.status = 'held'
         AND oi.hold_expires_at > now()
         AND tstzrange(oi.starts_at, oi.ends_at, '[)') && tstzrange(v_item.starts_at, v_item.ends_at, '[)')
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'listing_busy',
                                'itemId', v_item.id, 'listingId', v_item.listing_id);
    END IF;

    -- A rental that already occupies the machine.
    IF EXISTS (
      SELECT 1
        FROM public.rentals r
       WHERE r.listing_id = v_item.listing_id
         AND r.status IN ('pending', 'active')
         AND r.start_time < v_item.ends_at
         AND COALESCE(
               r.end_time,
               r.start_time + make_interval(mins => COALESCE(r.planned_duration_minutes, 1440))
             ) > v_item.starts_at
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'listing_busy',
                                'itemId', v_item.id, 'listingId', v_item.listing_id);
    END IF;
  END LOOP;

  -- PHASE 2 — apply. Reaching here means every item passed validation.
  UPDATE public.order_items
     SET status = 'held',
         hold_expires_at = v_expires,
         failure_code = NULL,
         updated_at = now()
   WHERE order_id = p_order_id
     AND status IN ('draft', 'expired', 'failed');
  GET DIAGNOSTICS v_items = ROW_COUNT;

  IF v_items = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'order_empty');
  END IF;

  UPDATE public.orders
     SET status = 'awaiting_payment',
         hold_expires_at = v_expires,
         version = version + 1,
         updated_at = now()
   WHERE id = p_order_id;

  RETURN jsonb_build_object('ok', true, 'code', 'reserved', 'holdExpiresAt', v_expires, 'items', v_items);
END;
$$;

-- ============================================
-- 5) RPC: pay = turn every hold into a rental (P3-06)
-- ============================================
CREATE OR REPLACE FUNCTION public.order_pay(
  p_order_id  UUID,
  p_renter_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order   public.orders%ROWTYPE;
  v_item    public.order_items%ROWTYPE;
  v_rental  UUID;
  v_rentals JSONB := '[]'::jsonb;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.renter_id <> p_renter_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'order_not_found');
  END IF;

  -- Retry of a successful payment: hand back the same rentals, create nothing.
  IF v_order.status = 'paid' THEN
    RETURN jsonb_build_object('ok', true, 'code', 'already_paid', 'orderId', p_order_id);
  END IF;

  IF v_order.status <> 'awaiting_payment' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'order_not_payable', 'status', v_order.status);
  END IF;

  IF v_order.hold_expires_at IS NULL OR v_order.hold_expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'hold_expired', 'orderId', p_order_id);
  END IF;

  -- Validate before writing: a plpgsql RETURN commits earlier writes, so any
  -- refusal must happen while the transaction has written nothing yet.
  FOR v_item IN
    SELECT * FROM public.order_items
     WHERE order_id = p_order_id AND status = 'held'
     ORDER BY listing_id
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.gpu_listings
       WHERE id = v_item.listing_id AND status = 'active' AND is_public = true
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'listing_unavailable',
                                'itemId', v_item.id, 'listingId', v_item.listing_id);
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT * FROM public.order_items
     WHERE order_id = p_order_id AND status = 'held'
     ORDER BY listing_id
  LOOP
    INSERT INTO public.rentals (
      listing_id, provider_id, renter_id, start_time,
      planned_duration_minutes, estimated_cost, status, purpose
    ) VALUES (
      v_item.listing_id, v_item.provider_id, p_renter_id, v_item.starts_at,
      v_item.planned_duration_minutes, v_item.line_total, 'pending', v_item.purpose
    )
    RETURNING id INTO v_rental;

    UPDATE public.order_items
       SET status = 'rental_created',
           rental_id = v_rental,
           updated_at = now()
     WHERE id = v_item.id;

    v_rentals := v_rentals || jsonb_build_array(jsonb_build_object(
      'itemId', v_item.id, 'rentalId', v_rental, 'listingId', v_item.listing_id));
  END LOOP;

  IF jsonb_array_length(v_rentals) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'order_empty');
  END IF;

  UPDATE public.orders
     SET status = 'paid',
         paid_at = now(),
         -- The hold stops mattering: the rentals themselves now block the GPU.
         hold_expires_at = NULL,
         version = version + 1,
         updated_at = now()
   WHERE id = p_order_id;

  RETURN jsonb_build_object('ok', true, 'code', 'paid', 'rentals', v_rentals);
END;
$$;

-- ============================================
-- 6) RPC: cancel whole order or selected items (P3-04)
-- ============================================
CREATE OR REPLACE FUNCTION public.order_cancel(
  p_order_id  UUID,
  p_renter_id UUID,
  p_item_ids  UUID[] DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order    public.orders%ROWTYPE;
  v_remaining INTEGER := 0;
  v_subtotal NUMERIC(12,2) := 0;
  v_cancelled INTEGER := 0;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.renter_id <> p_renter_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'order_not_found');
  END IF;

  -- Cancelling a paid order is a refund flow (Phase 4): refuse rather than
  -- silently diverge the money from the rental.
  IF v_order.status = 'paid' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'order_already_paid', 'orderId', p_order_id);
  END IF;

  IF v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'code', 'already_cancelled', 'orderId', p_order_id);
  END IF;

  UPDATE public.order_items
     SET status = 'cancelled', updated_at = now()
   WHERE order_id = p_order_id
     AND status IN ('draft', 'held', 'expired', 'failed')
     AND (p_item_ids IS NULL OR id = ANY(p_item_ids));
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  IF p_item_ids IS NOT NULL AND v_cancelled = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'nothing_to_cancel');
  END IF;

  SELECT COUNT(*), COALESCE(SUM(line_total), 0)
    INTO v_remaining, v_subtotal
    FROM public.order_items
   WHERE order_id = p_order_id AND status IN ('draft', 'held', 'rental_created');

  UPDATE public.orders
     SET subtotal = v_subtotal,
         total = v_subtotal,
         status = CASE WHEN v_remaining = 0 THEN 'cancelled' ELSE status END,
         cancelled_at = CASE WHEN v_remaining = 0 THEN now() ELSE cancelled_at END,
         hold_expires_at = CASE WHEN v_remaining = 0 THEN NULL ELSE hold_expires_at END,
         version = version + 1,
         updated_at = now()
   WHERE id = p_order_id;

  RETURN jsonb_build_object('ok', true, 'code', 'cancelled',
                            'cancelledItems', v_cancelled,
                            'remainingItems', v_remaining,
                            'total', v_subtotal);
END;
$$;

-- ============================================
-- 7) RPC: sweep holds whose TTL ran out (self-healing)
-- ============================================
CREATE OR REPLACE FUNCTION public.order_expire_stale(p_limit INTEGER DEFAULT 100)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_orders INTEGER := 0;
  v_items  INTEGER := 0;
BEGIN
  WITH stale AS (
    SELECT id FROM public.orders
     WHERE status = 'awaiting_payment'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at <= now()
     ORDER BY hold_expires_at
     LIMIT GREATEST(COALESCE(p_limit, 100), 1)
     FOR UPDATE SKIP LOCKED
  ), expired_items AS (
    UPDATE public.order_items oi
       SET status = 'expired', updated_at = now()
      FROM stale
     WHERE oi.order_id = stale.id AND oi.status = 'held'
    RETURNING 1
  )
  SELECT count(*) INTO v_items FROM expired_items;

  WITH stale AS (
    UPDATE public.orders
       SET status = 'expired', hold_expires_at = NULL,
           version = version + 1, updated_at = now()
     WHERE status = 'awaiting_payment'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at <= now()
    RETURNING 1
  )
  SELECT count(*) INTO v_orders FROM stale;

  RETURN jsonb_build_object('ok', true, 'orders', v_orders, 'items', v_items);
END;
$$;

-- ============================================
-- 8) ACCESS CONTROL (API-only, like 006/007/012)
-- ============================================
ALTER TABLE public.orders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.orders, public.order_items, public.idempotency_keys
  FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.orders, public.order_items, public.idempotency_keys
  TO service_role;

REVOKE ALL ON FUNCTION public.order_reserve(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_pay(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_cancel(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_expire_stale(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.order_reserve(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_pay(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_cancel(uuid, uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_expire_stale(integer) TO service_role;

-- ============================================
-- VERIFY (run after apply)
-- ============================================
-- SELECT proname FROM pg_proc
--  WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'order_%';
--   -- expected: order_reserve, order_pay, order_cancel, order_expire_stale
--
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema='public' AND table_name IN ('orders','order_items','idempotency_keys')
--    AND grantee IN ('anon','authenticated','PUBLIC');
--   -- expected: zero rows



-- ============================================================
-- migrations/014_money_stripe.sql
-- ============================================================

-- Migration 014: Money, Stripe Connect, escrow, payouts, invoices (Phase 4)
-- Reversible: see ROLLBACK section at the bottom.
-- Graceful degradation: application code checks for these tables and returns
-- 503 money_unavailable when absent, so a missing migration never 500s.

-- ─── Stripe Connect accounts (providers) ─────────────────────────────────────
create table if not exists public.stripe_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  stripe_account_id text not null unique,
  onboarding_status text not null default 'pending' check (onboarding_status in ('pending','in_progress','complete','restricted')),
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  country text,
  default_currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create index if not exists idx_stripe_accounts_user on public.stripe_accounts(user_id);

-- ─── Payment intents (money intake) ───────────────────────────────────────────
create table if not exists public.payment_intents (
  id text primary key,                       -- Stripe PaymentIntent id (pi_...)
  user_id uuid not null references public.users(id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'USD',
  status text not null default 'requires_payment_method'
    check (status in ('requires_payment_method','requires_confirmation','requires_action','processing','succeeded','canceled','failed')),
  order_id uuid references public.orders(id) on delete set null,
  rental_id uuid references public.rentals(id) on delete set null,
  client_secret text,
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payment_intents_user on public.payment_intents(user_id);
create index if not exists idx_payment_intents_order on public.payment_intents(order_id);

-- ─── Escrow holds (rental funds held until completion) ───────────────────────
create table if not exists public.escrow_holds (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  payment_intent_id text references public.payment_intents(id) on delete set null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'USD',
  status text not null default 'held' check (status in ('held','released','refunded','partial_refund')),
  held_at timestamptz not null default now(),
  released_at timestamptz,
  refunded_at timestamptz,
  release_group text,        -- ledger entry_group used on release
  refund_group text,         -- ledger entry_group used on refund
  unique (rental_id)
);

create index if not exists idx_escrow_holds_rental on public.escrow_holds(rental_id);
create index if not exists idx_escrow_holds_status on public.escrow_holds(status);

-- ─── Payouts (T+7 to providers) ──────────────────────────────────────────────
create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.users(id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'USD',
  status text not null default 'scheduled'
    check (status in ('scheduled','processing','paid','failed','canceled')),
  scheduled_for timestamptz not null,
  paid_at timestamptz,
  stripe_transfer_id text,
  stripe_payout_id text,
  rental_ids uuid[] not null default '{}',
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payouts_provider on public.payouts(provider_id);
create index if not exists idx_payouts_status on public.payouts(status);
create index if not exists idx_payouts_scheduled on public.payouts(scheduled_for) where status = 'scheduled';

-- ─── Refunds ──────────────────────────────────────────────────────────────────
create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_intent_id text references public.payment_intents(id) on delete set null,
  rental_id uuid references public.rentals(id) on delete set null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'USD',
  reason text,
  status text not null default 'pending' check (status in ('pending','succeeded','failed','canceled')),
  stripe_refund_id text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_refunds_payment_intent on public.refunds(payment_intent_id);

-- ─── Invoices ────────────────────────────────────────────────────────────────
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  rental_id uuid references public.rentals(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null default 'USD',
  invoice_number text not null unique,
  pdf_url text,
  issued_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_invoices_user on public.invoices(user_id);

-- ─── RPC: release escrow into provider wallet + commission ───────────────────
-- Moves held funds: escrow:<rental> -> wallet:<provider> (95%) and
-- escrow:<rental> -> platform.commission (5%), atomically. Idempotent by group.
create or replace function public.release_escrow(
  p_rental_id uuid,
  p_provider_id uuid,
  p_commission_bps integer default 500,   -- 5% = 500 bps
  p_group text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold public.escrow_holds%rowtype;
  v_group text := coalesce(p_group, gen_random_uuid()::text);
  v_total bigint;
  v_commission bigint;
  v_provider bigint;
begin
  select * into v_hold from public.escrow_holds where rental_id = p_rental_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_hold');
  end if;
  if v_hold.status <> 'held' then
    return jsonb_build_object('ok', true, 'code', 'already_' || v_hold.status, 'group', v_hold.release_group);
  end if;

  v_total := v_hold.amount_minor;
  v_commission := (v_total * p_commission_bps) / 10000;
  v_provider := v_total - v_commission;

  -- provider wallet credit
  perform public.post_transfer(
    'escrow:' || p_rental_id::text,
    'wallet:' || p_provider_id::text,
    v_provider,
    v_hold.currency,
    'escrow_release',
    p_rental_id::text,
    v_group
  );
  -- platform commission
  if v_commission > 0 then
    perform public.post_transfer(
      'escrow:' || p_rental_id::text,
      'platform.commission',
      v_commission,
      v_hold.currency,
      'commission',
      p_rental_id::text,
      v_group || ':commission'
    );
  end if;

  update public.escrow_holds
    set status = 'released',
        released_at = now(),
        release_group = v_group
    where id = v_hold.id;

  return jsonb_build_object('ok', true, 'code', 'released', 'group', v_group,
    'provider_minor', v_provider, 'commission_minor', v_commission);
end;
$$;

-- ─── RPC: refund escrow back to renter wallet ────────────────────────────────
create or replace function public.refund_escrow(
  p_rental_id uuid,
  p_renter_id uuid,
  p_amount_minor bigint default null,
  p_group text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold public.escrow_holds%rowtype;
  v_group text := coalesce(p_group, gen_random_uuid()::text);
  v_amount bigint;
begin
  select * into v_hold from public.escrow_holds where rental_id = p_rental_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_hold');
  end if;
  if v_hold.status not in ('held','partial_refund') then
    return jsonb_build_object('ok', true, 'code', 'already_' || v_hold.status);
  end if;

  v_amount := coalesce(p_amount_minor, v_hold.amount_minor);
  if v_amount <= 0 or v_amount > v_hold.amount_minor then
    return jsonb_build_object('ok', false, 'code', 'invalid_amount');
  end if;

  perform public.post_transfer(
    'escrow:' || p_rental_id::text,
    'wallet:' || p_renter_id::text,
    v_amount,
    v_hold.currency,
    'escrow_refund',
    p_rental_id::text,
    v_group
  );

  if v_amount = v_hold.amount_minor then
    update public.escrow_holds
      set status = 'refunded', refunded_at = now(), refund_group = v_group
      where id = v_hold.id;
  else
    update public.escrow_holds
      set status = 'partial_refund', refund_group = v_group,
          amount_minor = amount_minor - v_amount
      where id = v_hold.id;
  end if;

  return jsonb_build_object('ok', true, 'code', 'refunded', 'group', v_group, 'amount_minor', v_amount);
end;
$$;

grant execute on function public.release_escrow(uuid, uuid, integer, text) to service_role;
grant execute on function public.refund_escrow(uuid, uuid, bigint, text) to service_role;

-- Row Level Security: service_role only (API-only DB pattern).
ALTER TABLE public.stripe_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escrow_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- ROLLBACK:
-- drop function if exists public.refund_escrow(uuid, uuid, bigint, text);
-- drop function if exists public.release_escrow(uuid, uuid, integer, text);
-- drop table if exists public.invoices;
-- drop table if exists public.refunds;
-- drop table if exists public.payouts;
-- drop table if exists public.escrow_holds;
-- drop table if exists public.payment_intents;
-- drop table if exists public.stripe_accounts;



-- ============================================================
-- migrations/015_sessions_usage.sql
-- ============================================================

-- Migration 015: Session usage, heartbeats, temp SSH keys, disk wipe (Phase 5)
-- Graceful degradation: application returns 503 session_unavailable when absent.

create table if not exists public.session_heartbeats (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  recorded_at timestamptz not null default now(),
  cpu_percent numeric(5,2),
  gpu_percent numeric(5,2),
  gpu_temp_c numeric(5,2),
  ram_used_mb integer,
  disk_used_gb numeric(8,2),
  network_rx_bytes bigint,
  network_tx_bytes bigint,
  idle_seconds integer not null default 0
);
create index if not exists idx_heartbeats_rental_time on public.session_heartbeats(rental_id, recorded_at desc);

create table if not exists public.session_events (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  event_type text not null check (event_type in ('started','stopped','auto_stopped','idle_warning','key_issued','key_revoked','disk_wiped','error')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_session_events_rental on public.session_events(rental_id, created_at desc);

create table if not exists public.session_ssh_keys (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  public_key text not null,
  fingerprint text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text
);
create index if not exists idx_ssh_keys_rental on public.session_ssh_keys(rental_id);

create table if not exists public.session_disk_wipes (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','running','done','failed')),
  started_at timestamptz,
  finished_at timestamptz,
  method text,
  error text,
  created_at timestamptz not null default now()
);

ALTER TABLE public.session_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_ssh_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_disk_wipes ENABLE ROW LEVEL SECURITY;

-- ROLLBACK:
-- drop table if exists public.session_disk_wipes;
-- drop table if exists public.session_ssh_keys;
-- drop table if exists public.session_events;
-- drop table if exists public.session_heartbeats;



-- ============================================================
-- migrations/016_trust_safety.sql
-- ============================================================

-- Migration 016: Trust & safety — identity clusters, device fingerprints, bans, fraud signals (Phase 6)
create table if not exists public.identity_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  signal_type text not null check (signal_type in ('email','phone','device','card','ip','wallet','ssh_key')),
  signal_value text not null,
  cluster_id uuid,
  risk_score integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, signal_type, signal_value)
);
create index if not exists idx_identity_links_value on public.identity_links(signal_type, signal_value);
create index if not exists idx_identity_links_cluster on public.identity_links(cluster_id);

create table if not exists public.device_fingerprints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  fingerprint text not null,
  user_agent text,
  ip_address text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (fingerprint)
);

create table if not exists public.account_bans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  reason text not null,
  scope text not null default 'account' check (scope in ('account','device','cluster','payment')),
  banned_by uuid references public.users(id),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid references public.users(id)
);
create index if not exists idx_bans_user on public.account_bans(user_id) where lifted_at is null;

create table if not exists public.fraud_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  cluster_id uuid,
  alert_type text not null,
  severity text not null default 'low' check (severity in ('low','medium','high','critical')),
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.users(id)
);
create index if not exists idx_fraud_alerts_status on public.fraud_alerts(status, created_at desc);

ALTER TABLE public.identity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_alerts ENABLE ROW LEVEL SECURITY;

-- ROLLBACK:
-- drop table if exists public.fraud_alerts;
-- drop table if exists public.account_bans;
-- drop table if exists public.device_fingerprints;
-- drop table if exists public.identity_links;



-- ============================================================
-- migrations/017_reputation_reviews.sql
-- ============================================================

-- Migration 017: Reputation & disputes (Phase 7)
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  reviewer_id uuid not null references public.users(id) on delete cascade,
  reviewee_id uuid not null references public.users(id) on delete cascade,
  direction text not null check (direction in ('renter_to_provider','provider_to_renter')),
  rating integer not null check (rating between 1 and 5),
  title text,
  body text,
  verified boolean not null default true,
  created_at timestamptz not null default now(),
  unique (rental_id, direction)
);
create index if not exists idx_reviews_reviewee on public.reviews(reviewee_id, created_at desc);

create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid references public.rentals(id) on delete set null,
  opened_by uuid not null references public.users(id) on delete cascade,
  against uuid references public.users(id) on delete set null,
  reason text not null,
  status text not null default 'open' check (status in ('open','investigating','resolved','dismissed')),
  resolution text,
  refund_amount_minor bigint,
  resolved_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_disputes_status on public.disputes(status, created_at desc);

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;

-- ROLLBACK:
-- drop table if exists public.disputes;
-- drop table if exists public.reviews;



-- ============================================================
-- migrations/018_ops_support_notifications.sql
-- ============================================================

-- Migration 018: Ops — support tickets, notifications, admin audit (Phase 8)
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  subject text not null,
  body text not null,
  status text not null default 'open' check (status in ('open','pending','resolved','closed')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  assigned_to uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_tickets_status on public.support_tickets(status, created_at desc);

create table if not exists public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  author_id uuid references public.users(id) on delete set null,
  body text not null,
  is_internal boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_user on public.notifications(user_id, created_at desc);

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.users(id),
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_admin_audit_time on public.admin_audit_log(created_at desc);

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

-- ROLLBACK:
-- drop table if exists public.admin_audit_log;
-- drop table if exists public.notifications;
-- drop table if exists public.ticket_messages;
-- drop table if exists public.support_tickets;

