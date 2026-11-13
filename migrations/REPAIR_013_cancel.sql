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
