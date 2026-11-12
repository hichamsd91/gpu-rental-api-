-- Migration 015: Session usage, heartbeats, temp SSH keys, disk wipe (Phase 5)
-- Graceful degradation: application returns 503 session_unavailable when absent.

create table if not exists public.session_heartbeats (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  recorded_at timestamptz not null default now(),
  cpu_percent numeric(5,2),
  gpu_percent numeric(5,2),
  gpu_temp_c numeric(5,2),
  ram_used_mb integer,
  disk_used_gb numeric(8,2),
  network_rx_bytes bigint,
  network_tx_bytes bigint,
  idle_seconds integer not null default 0
);
create index if not exists idx_heartbeats_rental_time on public.session_heartbeats(rental_id, recorded_at desc);

create table if not exists public.session_events (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  event_type text not null check (event_type in ('started','stopped','auto_stopped','idle_warning','key_issued','key_revoked','disk_wiped','error')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_session_events_rental on public.session_events(rental_id, created_at desc);

create table if not exists public.session_ssh_keys (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  public_key text not null,
  fingerprint text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text
);
create index if not exists idx_ssh_keys_rental on public.session_ssh_keys(rental_id);

create table if not exists public.session_disk_wipes (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','running','done','failed')),
  started_at timestamptz,
  finished_at timestamptz,
  method text,
  error text,
  created_at timestamptz not null default now()
);

ALTER TABLE public.session_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_ssh_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_disk_wipes ENABLE ROW LEVEL SECURITY;

-- ROLLBACK:
-- drop table if exists public.session_disk_wipes;
-- drop table if exists public.session_ssh_keys;
-- drop table if exists public.session_events;
-- drop table if exists public.session_heartbeats;
