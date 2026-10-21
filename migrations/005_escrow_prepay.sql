-- ============================================================================
-- MIGRATION 005 — ESCROW / PREPAY FOUNDATION (STAGED)
-- ---------------------------------------------------------------------------
-- HOW TO APPLY:  Supabase Dashboard -> project veloxora-app database ->
--                SQL Editor -> paste this whole file -> Run.
-- SAFETY:        Every object here is ADDITIVE and idempotent (IF NOT EXISTS).
--                Applying it changes NO current behavior — the start-time
--                balance gate already ships with zero schema change, and full
--                prepay (hold-at-start / release-at-settle) only activates
--                when its env-gated code lands. Nothing here is wired into the
--                live settle_rental RPC on purpose: the 002/003 installed RPC
--                deducts renter balance at settlement, and a JS-side debit
--                shipped before the RPC is aligned would DOUBLE-CHARGE.
-- ============================================================================

BEGIN;

-- 1) Reserved funds column — amounts parked against active sessions.
--    "Spendable" = balance - reserved_balance (enforced app-side by the gate).
ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS reserved_balance NUMERIC(14,3) NOT NULL DEFAULT 0
  CHECK (reserved_balance >= 0);

COMMENT ON COLUMN wallets.reserved_balance IS
  'Funds held as escrow for in-flight rentals. Additive staging (migration 005): inert until env-gated prepay code ships.';

-- 2) Spendable balance view — the number money UIs should display from here on.
CREATE OR REPLACE VIEW wallet_spendable AS
SELECT w.id,
       w.user_id,
       w.balance,
       GREATEST(w.balance - COALESCE(w.reserved_balance, 0), 0)::numeric(14,3) AS spendable_balance
FROM wallets w;

COMMIT;

-- VERIFY: SELECT user_id, balance, reserved_balance FROM wallets LIMIT 5;
--         SELECT * FROM wallet_spendable LIMIT 5;
