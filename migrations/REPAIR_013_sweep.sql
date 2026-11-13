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
