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
