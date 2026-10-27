-- ============================================================================
-- 012_catalog_purposes_availability.sql
-- ----------------------------------------------------------------------------
-- Phase 2 (P2-01 … P2-06): rental purposes, installed software, access
-- methods, availability windows, blackouts and the priced mining opt-in (D2).
--
-- Everything is ADDITIVE. The API degrades gracefully while this migration is
-- pending: listings still list/book, only the new catalog extras disappear.
--
-- Money note: price columns are NUMERIC(10,2) dollars like the existing
-- gpu_listings.price_per_hour. Conversion to integer minor units happens at the
-- ledger boundary (decision A1), never here.
--
-- Apply manually in Supabase Dashboard -> SQL Editor (same workflow as 002-011).
--
-- Rollback (destructive, review before running):
--   ALTER TABLE public.rentals DROP COLUMN IF EXISTS purpose;
--   ALTER TABLE public.gpu_listings
--     DROP CONSTRAINT IF EXISTS gpu_listings_access_methods_valid,
--     DROP COLUMN IF EXISTS access_methods;
--   DROP TABLE IF EXISTS public.listing_blackouts, public.listing_availability,
--     public.listing_software, public.listing_purposes, public.rental_purposes;
-- ============================================================================

-- ============================================
-- 1) RENTAL PURPOSES — the catalog (P2-01)
-- ============================================
CREATE TABLE IF NOT EXISTS public.rental_purposes (
  key             TEXT PRIMARY KEY,
  label_en        TEXT NOT NULL,
  description_en  TEXT,
  -- Client-side icon hint; unknown values fall back to a generic icon.
  icon            TEXT,
  -- Optional feature flag that must be enabled before this purpose can be
  -- offered. Mining is the only gated one today (decision D2).
  requires_flag   TEXT,
  sort_order      SMALLINT NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.rental_purposes IS
  'Catalog of rental intents. Labels are English; the app localizes by key.';

INSERT INTO public.rental_purposes (key, label_en, description_en, icon, requires_flag, sort_order) VALUES
  ('training',  'Model training',       'Fine-tuning and training runs on dedicated VRAM.',            'training',  NULL,             10),
  ('inference', 'Inference & serving',  'Low-latency serving for LLMs, vision and embeddings.',        'inference', NULL,             20),
  ('rendering', '3D rendering',         'Blender, Octane and CUDA render jobs.',                       'rendering', NULL,             30),
  ('research',  'Research & experiments','Notebooks, benchmarks and one-off experiments.',             'research',  NULL,             40),
  ('mining',    'Mining-friendly',      'Opt-in hashing with a declared power cap and its own price.', 'mining',    'mining.allowed', 50)
ON CONFLICT (key) DO UPDATE
  SET label_en       = EXCLUDED.label_en,
      description_en = EXCLUDED.description_en,
      icon           = EXCLUDED.icon,
      requires_flag  = EXCLUDED.requires_flag,
      sort_order     = EXCLUDED.sort_order;

-- ============================================
-- 2) LISTING ↔ PURPOSE (P2-02, P2-06)
-- ============================================
-- A listing may serve several purposes. The row carries an optional price
-- override (mining MUST set one — its price is independent of the base rate)
-- plus purpose-specific specifications.
CREATE TABLE IF NOT EXISTS public.listing_purposes (
  listing_id     UUID NOT NULL REFERENCES public.gpu_listings(id) ON DELETE CASCADE,
  purpose_key    TEXT NOT NULL REFERENCES public.rental_purposes(key) ON DELETE RESTRICT,
  -- NULL = use gpu_listings.price_per_hour. Set = a separate price for this
  -- purpose (mining is required to set it).
  price_per_hour NUMERIC(10,2),
  -- e.g. mining: {"powerCapWatts":320,"disclosure":"...","coin":"..."}
  specs          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, purpose_key),
  CONSTRAINT listing_purposes_price_nonnegative
    CHECK (price_per_hour IS NULL OR price_per_hour >= 0)
);

CREATE INDEX IF NOT EXISTS idx_listing_purposes_key
  ON public.listing_purposes(purpose_key);

-- ============================================
-- 3) INSTALLED SOFTWARE + ACCESS METHOD (P2-05)
-- ============================================
CREATE TABLE IF NOT EXISTS public.listing_software (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES public.gpu_listings(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  version    TEXT,
  category   TEXT NOT NULL DEFAULT 'other'
             CHECK (category IN ('cuda', 'framework', 'tool', 'other')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, name)
);

CREATE INDEX IF NOT EXISTS idx_listing_software_listing
  ON public.listing_software(listing_id);

-- How a renter reaches the machine. Kept as a small array so one listing can
-- offer more than one route; the concrete credentials stay in specs.access.
ALTER TABLE public.gpu_listings
  ADD COLUMN IF NOT EXISTS access_methods TEXT[] NOT NULL DEFAULT ARRAY['ssh']::TEXT[];

DO $$
BEGIN
  ALTER TABLE public.gpu_listings
    ADD CONSTRAINT gpu_listings_access_methods_valid
    CHECK (access_methods <@ ARRAY['ssh', 'rdp', 'streaming', 'jupyter']::TEXT[]);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- 4) AVAILABILITY (P2-04)
-- ============================================
-- Recurring weekly windows in UTC minutes-since-midnight. No rows for a listing
-- = always open. A window never crosses midnight (start < end) so the check
-- stays a simple containment test per UTC day.
CREATE TABLE IF NOT EXISTS public.listing_availability (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID NOT NULL REFERENCES public.gpu_listings(id) ON DELETE CASCADE,
  weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday (UTC)
  start_minute SMALLINT NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   SMALLINT NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT listing_availability_order CHECK (start_minute < end_minute),
  UNIQUE (listing_id, weekday, start_minute, end_minute)
);

CREATE INDEX IF NOT EXISTS idx_listing_availability_listing
  ON public.listing_availability(listing_id, weekday);

-- One-off closures. ends_at is exclusive.
CREATE TABLE IF NOT EXISTS public.listing_blackouts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES public.gpu_listings(id) ON DELETE CASCADE,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT listing_blackouts_order CHECK (starts_at < ends_at)
);

CREATE INDEX IF NOT EXISTS idx_listing_blackouts_window
  ON public.listing_blackouts(listing_id, starts_at, ends_at);

-- The chosen purpose is recorded on the rental so settlement and disputes can
-- tell a training run from a mining job.
ALTER TABLE public.rentals
  ADD COLUMN IF NOT EXISTS purpose TEXT;

-- ============================================
-- 5) ACCESS CONTROL
-- ============================================
ALTER TABLE public.rental_purposes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_purposes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_software     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_blackouts    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rental_purposes, public.listing_purposes,
                   public.listing_software, public.listing_availability,
                   public.listing_blackouts
  FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.rental_purposes, public.listing_purposes,
                  public.listing_software, public.listing_availability,
                  public.listing_blackouts
  TO service_role;

-- ============================================
-- VERIFY (run after apply)
-- ============================================
-- SELECT key, label_en, requires_flag FROM public.rental_purposes ORDER BY sort_order;
--   -- expected: 5 rows (training, inference, rendering, research, mining)
--
-- SELECT grantee, privilege_type
--   FROM information_schema.role_table_grants
--  WHERE table_schema = 'public'
--    AND table_name IN ('rental_purposes','listing_purposes','listing_software',
--                       'listing_availability','listing_blackouts')
--    AND grantee IN ('anon','authenticated','PUBLIC');
--   -- expected: zero rows
--
-- SELECT column_name, data_type
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='gpu_listings'
--    AND column_name='access_methods';
--   -- expected: one row, ARRAY
