-- ============================================================
-- 022 — session jobs: the paid session meets the provider's worker agent
-- ============================================================
-- WHY
--   A rental is a contract, but until now nothing carried the actual work from
--   the renter's request to the provider's GPU. `session_jobs` is that bridge:
--   the renter submits an allowlisted *kind* + numeric parameters, the provider's
--   worker agent claims it atomically, streams progress, and reports a result.
--
--   One job per rental (rental_id is the primary key). Claiming is an UPDATE
--   guarded by status = 'queued' in the API layer, so two agents can never run
--   the same work twice; the unique key makes "two jobs on one session" a
--   database error rather than a race.
--
--   Nothing here is executable text from the renter: `kind` is validated against
--   a server-side allowlist and `spec` only holds numbers in closed ranges.
--
-- APPLIED: Supabase SQL Editor, 2026-11-17.
-- ============================================================

create table if not exists public.session_jobs (
  rental_id uuid primary key references public.rentals(id) on delete cascade,
  kind text not null,
  spec jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  progress integer not null default 0 check (progress between 0 and 100),
  log text,
  result jsonb,
  telemetry jsonb,
  exit_code integer,
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The agent's hot query is "queued work for these rentals"; a partial index
-- keeps it tiny even after millions of finished jobs.
create index if not exists session_jobs_queued_idx
  on public.session_jobs (created_at)
  where status = 'queued';

create index if not exists session_jobs_status_idx
  on public.session_jobs (status, updated_at desc);

alter table public.session_jobs enable row level security;

-- No policies: only the API (service_role) reads or writes jobs. A renter sees
-- their job through /api/rentals/:id/job, never by querying the table directly.
revoke all on public.session_jobs from anon, authenticated;
grant select, insert, update, delete on public.session_jobs to service_role;

-- ============================================================
-- Verification
--   select count(*) from public.session_jobs;                                  -- 0
--   select relrowsecurity from pg_class where relname = 'session_jobs';        -- true
--   select has_table_privilege('anon', 'public.session_jobs', 'select');      -- false
--   select indexname from pg_indexes where tablename = 'session_jobs';        -- 2 indexes + pkey
-- ============================================================
