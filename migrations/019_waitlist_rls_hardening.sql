-- ============================================================
-- 019 — waitlist RLS hardening
-- ============================================================
-- FINDING (comprehensive audit, 2026-11-14)
--   An anonymous caller holding only the public key could read every row:
--     * GRANT INSERT, SELECT ON waitlist TO anon, authenticated
--     * policy "waitlist_service_full" FOR ALL USING (true) — created without
--       a TO clause, so it applied to PUBLIC (anon included)
--   Verified live: GET /rest/v1/waitlist with the publishable key returned
--   real signup emails.
--
-- WHY REVOKING IS SAFE
--   The Flutter web app has no Supabase client at all (no `supabase` package,
--   no `from(...)` calls). Every read/write goes through the API, which uses
--   the service role and therefore bypasses RLS. Anon needs no access here.
--
-- RUN IN: Supabase SQL Editor → "Run without RLS".
--
-- ROLLBACK (only if a public client ever needs the waitlist again):
--   GRANT INSERT ON waitlist TO anon, authenticated;
--   CREATE POLICY "waitlist_public_insert" ON waitlist FOR INSERT WITH CHECK (true);
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS "waitlist_public_insert" ON waitlist;
DROP POLICY IF EXISTS "waitlist_service_full" ON waitlist;
DROP POLICY IF EXISTS "waitlist_service_role_all" ON waitlist;

-- Belt and braces: strip the table-level grants that made the leak reachable.
REVOKE ALL ON TABLE waitlist FROM anon, authenticated;

-- service_role bypasses RLS; the explicit policy documents the intent and
-- keeps the table closed to everything else.
CREATE POLICY "waitlist_service_role_all" ON waitlist
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;

-- ============================================================
-- Verification (run after COMMIT):
--   SELECT polname, polroles::regrole[] FROM pg_policy
--    WHERE polrelid = 'waitlist'::regclass;
--   -- expect: waitlist_service_role_all | {service_role}
--
--   With the publishable key:
--   curl "<SUPABASE_URL>/rest/v1/waitlist?select=*" -H "apikey: <publishable>"
--   -- expect: 401 / permission denied (never rows)
-- ============================================================
