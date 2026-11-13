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

