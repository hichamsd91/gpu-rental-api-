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
