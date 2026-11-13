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
