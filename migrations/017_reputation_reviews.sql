-- Migration 017: Reputation & disputes (Phase 7)
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  reviewer_id uuid not null references public.profiles(id) on delete cascade,
  reviewee_id uuid not null references public.profiles(id) on delete cascade,
  direction text not null check (direction in ('renter_to_provider','provider_to_renter')),
  rating integer not null check (rating between 1 and 5),
  title text,
  body text,
  verified boolean not null default true,
  created_at timestamptz not null default now(),
  unique (rental_id, direction)
);
create index if not exists idx_reviews_reviewee on public.reviews(reviewee_id, created_at desc);

create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid references public.rentals(id) on delete set null,
  opened_by uuid not null references public.profiles(id) on delete cascade,
  against uuid references public.profiles(id) on delete set null,
  reason text not null,
  status text not null default 'open' check (status in ('open','investigating','resolved','dismissed')),
  resolution text,
  refund_amount_minor bigint,
  resolved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_disputes_status on public.disputes(status, created_at desc);

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;

-- ROLLBACK:
-- drop table if exists public.disputes;
-- drop table if exists public.reviews;
