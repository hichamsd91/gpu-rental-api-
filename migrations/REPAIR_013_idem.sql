-- 3) IDEMPOTENCY KEYS (P3-03)
-- ============================================
-- One row per (user, key). A retry with the same key replays the stored
-- response verbatim instead of re-running the mutation; a different body under
-- the same key is a hard 409 so a stolen key can never rewrite an order.
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  user_id         UUID NOT NULL,
  key             TEXT NOT NULL,
  scope           TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'in_flight'
                  CHECK (status IN ('in_flight', 'succeeded', 'failed')),
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created
  ON public.idempotency_keys(created_at);

-- ============================================
