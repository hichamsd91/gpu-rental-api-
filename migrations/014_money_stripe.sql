-- Migration 014: Money, Stripe Connect, escrow, payouts, invoices (Phase 4)
-- Reversible: see ROLLBACK section at the bottom.
-- Graceful degradation: application code checks for these tables and returns
-- 503 money_unavailable when absent, so a missing migration never 500s.

-- ─── Stripe Connect accounts (providers) ─────────────────────────────────────
create table if not exists public.stripe_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  stripe_account_id text not null unique,
  onboarding_status text not null default 'pending' check (onboarding_status in ('pending','in_progress','complete','restricted')),
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  country text,
  default_currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create index if not exists idx_stripe_accounts_user on public.stripe_accounts(user_id);

-- ─── Payment intents (money intake) ───────────────────────────────────────────
create table if not exists public.payment_intents (
  id text primary key,                       -- Stripe PaymentIntent id (pi_...)
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'USD',
  status text not null default 'requires_payment_method'
    check (status in ('requires_payment_method','requires_confirmation','requires_action','processing','succeeded','canceled','failed')),
  order_id uuid references public.orders(id) on delete set null,
  rental_id uuid references public.rentals(id) on delete set null,
  client_secret text,
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payment_intents_user on public.payment_intents(user_id);
create index if not exists idx_payment_intents_order on public.payment_intents(order_id);

-- ─── Escrow holds (rental funds held until completion) ───────────────────────
create table if not exists public.escrow_holds (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  payment_intent_id text references public.payment_intents(id) on delete set null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'USD',
  status text not null default 'held' check (status in ('held','released','refunded','partial_refund')),
  held_at timestamptz not null default now(),
  released_at timestamptz,
  refunded_at timestamptz,
  release_group text,        -- ledger entry_group used on release
  refund_group text,         -- ledger entry_group used on refund
  unique (rental_id)
);

create index if not exists idx_escrow_holds_rental on public.escrow_holds(rental_id);
create index if not exists idx_escrow_holds_status on public.escrow_holds(status);

-- ─── Payouts (T+7 to providers) ──────────────────────────────────────────────
create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.profiles(id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'USD',
  status text not null default 'scheduled'
    check (status in ('scheduled','processing','paid','failed','canceled')),
  scheduled_for timestamptz not null,
  paid_at timestamptz,
  stripe_transfer_id text,
  stripe_payout_id text,
  rental_ids uuid[] not null default '{}',
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payouts_provider on public.payouts(provider_id);
create index if not exists idx_payouts_status on public.payouts(status);
create index if not exists idx_payouts_scheduled on public.payouts(scheduled_for) where status = 'scheduled';

-- ─── Refunds ──────────────────────────────────────────────────────────────────
create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_intent_id text references public.payment_intents(id) on delete set null,
  rental_id uuid references public.rentals(id) on delete set null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'USD',
  reason text,
  status text not null default 'pending' check (status in ('pending','succeeded','failed','canceled')),
  stripe_refund_id text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_refunds_payment_intent on public.refunds(payment_intent_id);

-- ─── Invoices ────────────────────────────────────────────────────────────────
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  rental_id uuid references public.rentals(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null default 'USD',
  invoice_number text not null unique,
  pdf_url text,
  issued_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_invoices_user on public.invoices(user_id);

-- ─── RPC: release escrow into provider wallet + commission ───────────────────
-- Moves held funds: escrow:<rental> -> wallet:<provider> (95%) and
-- escrow:<rental> -> platform.commission (5%), atomically. Idempotent by group.
create or replace function public.release_escrow(
  p_rental_id uuid,
  p_provider_id uuid,
  p_commission_bps integer default 500,   -- 5% = 500 bps
  p_group text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold public.escrow_holds%rowtype;
  v_group text := coalesce(p_group, gen_random_uuid()::text);
  v_total bigint;
  v_commission bigint;
  v_provider bigint;
begin
  select * into v_hold from public.escrow_holds where rental_id = p_rental_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_hold');
  end if;
  if v_hold.status <> 'held' then
    return jsonb_build_object('ok', true, 'code', 'already_' || v_hold.status, 'group', v_hold.release_group);
  end if;

  v_total := v_hold.amount_minor;
  v_commission := (v_total * p_commission_bps) / 10000;
  v_provider := v_total - v_commission;

  -- provider wallet credit
  perform public.post_transfer(
    'escrow:' || p_rental_id::text,
    'wallet:' || p_provider_id::text,
    v_provider,
    v_hold.currency,
    'escrow_release',
    p_rental_id::text,
    v_group
  );
  -- platform commission
  if v_commission > 0 then
    perform public.post_transfer(
      'escrow:' || p_rental_id::text,
      'platform.commission',
      v_commission,
      v_hold.currency,
      'commission',
      p_rental_id::text,
      v_group || ':commission'
    );
  end if;

  update public.escrow_holds
    set status = 'released',
        released_at = now(),
        release_group = v_group
    where id = v_hold.id;

  return jsonb_build_object('ok', true, 'code', 'released', 'group', v_group,
    'provider_minor', v_provider, 'commission_minor', v_commission);
end;
$$;

-- ─── RPC: refund escrow back to renter wallet ────────────────────────────────
create or replace function public.refund_escrow(
  p_rental_id uuid,
  p_renter_id uuid,
  p_amount_minor bigint default null,
  p_group text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold public.escrow_holds%rowtype;
  v_group text := coalesce(p_group, gen_random_uuid()::text);
  v_amount bigint;
begin
  select * into v_hold from public.escrow_holds where rental_id = p_rental_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_hold');
  end if;
  if v_hold.status not in ('held','partial_refund') then
    return jsonb_build_object('ok', true, 'code', 'already_' || v_hold.status);
  end if;

  v_amount := coalesce(p_amount_minor, v_hold.amount_minor);
  if v_amount <= 0 or v_amount > v_hold.amount_minor then
    return jsonb_build_object('ok', false, 'code', 'invalid_amount');
  end if;

  perform public.post_transfer(
    'escrow:' || p_rental_id::text,
    'wallet:' || p_renter_id::text,
    v_amount,
    v_hold.currency,
    'escrow_refund',
    p_rental_id::text,
    v_group
  );

  if v_amount = v_hold.amount_minor then
    update public.escrow_holds
      set status = 'refunded', refunded_at = now(), refund_group = v_group
      where id = v_hold.id;
  else
    update public.escrow_holds
      set status = 'partial_refund', refund_group = v_group,
          amount_minor = amount_minor - v_amount
      where id = v_hold.id;
  end if;

  return jsonb_build_object('ok', true, 'code', 'refunded', 'group', v_group, 'amount_minor', v_amount);
end;
$$;

grant execute on function public.release_escrow(uuid, uuid, integer, text) to service_role;
grant execute on function public.refund_escrow(uuid, uuid, bigint, text) to service_role;

-- Row Level Security: service_role only (API-only DB pattern).
ALTER TABLE public.stripe_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escrow_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- ROLLBACK:
-- drop function if exists public.refund_escrow(uuid, uuid, bigint, text);
-- drop function if exists public.release_escrow(uuid, uuid, integer, text);
-- drop table if exists public.invoices;
-- drop table if exists public.refunds;
-- drop table if exists public.payouts;
-- drop table if exists public.escrow_holds;
-- drop table if exists public.payment_intents;
-- drop table if exists public.stripe_accounts;
