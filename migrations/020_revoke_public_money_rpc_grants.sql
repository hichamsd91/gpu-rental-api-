-- ============================================================
-- 020 — money RPC grants: service_role only
-- ============================================================
-- FINDING (live audit, 2026-11-17)
--   `release_escrow` and `refund_escrow` were EXECUTABLE BY `anon` — anyone
--   holding the public browser key (it ships in every web page) could call
--   them through PostgREST:
--
--     POST /rest/v1/rpc/refund_escrow
--     { "p_rental_id": "<any held rental>", "p_renter_id": "<attacker>",
--       "p_amount_minor": 100000 }
--
--   which credits the attacker's wallet from someone else's escrow, and
--
--     POST /rest/v1/rpc/release_escrow
--     { "p_rental_id": "...", "p_provider_id": "...", "p_commission_bps": 10000 }
--
--   which can pay a provider early (skipping settlement and the renter's
--   refund) or push the whole hold to the platform commission account.
--   Verified live: anon got HTTP 200 `{"ok": false, "code": "no_hold"}` for a
--   fake id, i.e. the function ran as the caller — only a missing hold stopped
--   it. Both are SECURITY DEFINER, so they bypass RLS once invoked.
--
-- WHY THIS IS SAFE
--   The API is the only caller and it uses the service-role key
--   (moneyService.releaseEscrow / refundEscrow). No client ever calls these
--   RPCs directly: the Flutter app has no Supabase client at all.
--
-- APPLIED: Supabase SQL Editor, 2026-11-17. Verified after: anon -> 401
-- `42501 permission denied`, service_role -> allowed, and the live escrow
-- scenario (scripts/e2e/escrow.js) still passes 17/17.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.release_escrow(uuid, uuid, integer, text) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.refund_escrow(uuid, uuid, bigint, text) FROM anon, authenticated, public;

GRANT EXECUTE ON FUNCTION public.release_escrow(uuid, uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_escrow(uuid, uuid, bigint, text) TO service_role;

-- ============================================================
-- Verification (run after):
--   select p.proname,
--          has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
--          has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname in ('release_escrow','refund_escrow');
--   -- expect: anon_exec = false, svc_exec = true for both rows
--
--   Any other public function that can move money must be checked the same way:
--   select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');
-- ============================================================
