-- Migration 016: Trust & safety — identity clusters, device fingerprints, bans, fraud signals (Phase 6)
create table if not exists public.identity_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  signal_type text not null check (signal_type in ('email','phone','device','card','ip','wallet','ssh_key')),
  signal_value text not null,
  cluster_id uuid,
  risk_score integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, signal_type, signal_value)
);
create index if not exists idx_identity_links_value on public.identity_links(signal_type, signal_value);
create index if not exists idx_identity_links_cluster on public.identity_links(cluster_id);

create table if not exists public.device_fingerprints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  fingerprint text not null,
  user_agent text,
  ip_address text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (fingerprint)
);

create table if not exists public.account_bans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  reason text not null,
  scope text not null default 'account' check (scope in ('account','device','cluster','payment')),
  banned_by uuid references public.users(id),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid references public.users(id)
);
create index if not exists idx_bans_user on public.account_bans(user_id) where lifted_at is null;

create table if not exists public.fraud_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  cluster_id uuid,
  alert_type text not null,
  severity text not null default 'low' check (severity in ('low','medium','high','critical')),
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.users(id)
);
create index if not exists idx_fraud_alerts_status on public.fraud_alerts(status, created_at desc);

ALTER TABLE public.identity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_alerts ENABLE ROW LEVEL SECURITY;

-- ROLLBACK:
-- drop table if exists public.fraud_alerts;
-- drop table if exists public.account_bans;
-- drop table if exists public.device_fingerprints;
-- drop table if exists public.identity_links;
