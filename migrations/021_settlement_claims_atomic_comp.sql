-- ============================================================
-- 021 — cross-process settlement claims, atomic compensation,
--       retire the 5% settlement RPC
-- ============================================================
-- WHY
--   1) Settlement idempotency was process-local (`withSettlementLock` is an
--      in-memory Map). Two API instances (Render scale-out, a rolling deploy,
--      a second worker) could both repair the same rental and pay the provider
--      twice. `settlement_claims` makes the claim a database fact: the INSERT
--      is the atomic test-and-set, one row per (rental, step).
--   2) Provider-end compensation moved money in two JS calls (debit the
--      provider, credit the renter). A crash between them took money from the
--      provider and gave it to nobody. `apply_compensation` does both legs in
--      one transaction.
--   3) `settle_rental(...)` from migration 003/014 still exists with a 5%
--      commission default and no caller. It contradicts the 0% rule and is one
--      `select` away from being called by mistake. Dropped.
--
-- APPLIED: Supabase SQL Editor, 2026-11-17.
-- ============================================================

-- ── 1. settlement claims ─────────────────────────────────────────────────────
create table if not exists public.settlement_claims (
  rental_id uuid not null references public.rentals(id) on delete cascade,
  step text not null check (step in ('refund', 'earning', 'comp')),
  amount numeric,
  claimed_at timestamptz not null default now(),
  primary key (rental_id, step)
);

alter table public.settlement_claims enable row level security;

-- No policies: service_role bypasses RLS, nobody else can read or write.
revoke all on public.settlement_claims from anon, authenticated;
grant select, insert, update, delete on public.settlement_claims to service_role;

-- ── 2. atomic provider → renter compensation ─────────────────────────────────
create or replace function public.apply_compensation(
  p_provider_id uuid,
  p_renter_id uuid,
  p_amount numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric := round(coalesce(p_amount, 0), 3);
  v_balance numeric;
  v_taken numeric;
begin
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_amount');
  end if;
  if p_provider_id is null or p_renter_id is null or p_provider_id = p_renter_id then
    return jsonb_build_object('ok', false, 'code', 'invalid_party');
  end if;

  select balance into v_balance
    from public.wallets
   where user_id = p_provider_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_provider_wallet');
  end if;

  -- Never overdraw the provider: take only what is actually there.
  v_taken := least(greatest(coalesce(v_balance, 0), 0), v_amount);
  if v_taken <= 0 then
    return jsonb_build_object('ok', false, 'code', 'insufficient', 'taken', 0);
  end if;

  update public.wallets
     set balance = balance - v_taken,
         updated_at = now()
   where user_id = p_provider_id;

  insert into public.wallets (user_id, balance)
  values (p_renter_id, v_taken)
  on conflict (user_id) do update
     set balance = public.wallets.balance + excluded.balance,
         updated_at = now();

  return jsonb_build_object('ok', true, 'taken', v_taken);
end;
$$;

revoke execute on function public.apply_compensation(uuid, uuid, numeric) from anon, authenticated, public;
grant execute on function public.apply_compensation(uuid, uuid, numeric) to service_role;

-- ── 3. drop the 5% settlement RPC ────────────────────────────────────────────
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'settle_rental'
  loop
    execute 'drop function ' || r.signature;
    raise notice 'dropped %', r.signature;
  end loop;
end;
$$;

-- ============================================================
-- Verification
--   select * from public.settlement_claims;                        -- empty
--   select has_function_privilege('anon','public.apply_compensation(uuid,uuid,numeric)','execute');  -- false
--   select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='public' and p.proname='settle_rental';       -- 0
-- ============================================================
