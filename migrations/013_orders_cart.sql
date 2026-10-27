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
