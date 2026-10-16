-- ============================================================
-- Migration: multi-resource foundations + token pricing + waitlist
-- السكريبت آمن للتكرار (idempotent) — شغّله في Supabase SQL Editor
-- حتى لو سبق تنفيذ أي جزء منه
-- ============================================================

-- 1) العروض: نوع المورد + سعر التوكن + حقل المواصفات الحر
ALTER TABLE gpu_listings ADD COLUMN IF NOT EXISTS resource_type TEXT NOT NULL DEFAULT 'gpu';
ALTER TABLE gpu_listings ADD COLUMN IF NOT EXISTS tokens_per_hour NUMERIC(12,3);
ALTER TABLE gpu_listings ADD COLUMN IF NOT EXISTS specs JSONB NOT NULL DEFAULT '{}'::jsonb;

-- اشتقاق سعر التوكن للعروض الحالية: 1 توكن = 0.01$ (100 توكن = 1$)
UPDATE gpu_listings
SET tokens_per_hour = ROUND(price_per_hour * 100, 3)
WHERE tokens_per_hour IS NULL;

CREATE INDEX IF NOT EXISTS idx_gpu_listings_resource_type ON gpu_listings(resource_type);

-- 2) الإيجارات: نمط الفوترة (ساعة/توكن) + التقدير بالتوكنات
--    التوكنز يسيران بجانب التسعير بالساعة — لا استبدال
ALTER TABLE rentals ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'time';
ALTER TABLE rentals ADD COLUMN IF NOT EXISTS estimated_cost_tokens NUMERIC(12,3);

UPDATE rentals
SET estimated_cost_tokens = ROUND(estimated_cost * 100, 3)
WHERE estimated_cost_tokens IS NULL AND estimated_cost IS NOT NULL;

-- 3) الأجهزة: نوع الجهاز (كرت/هاتف/بروكسي لاحقاً) + حقل التوثيق (Play Integrity لاحقاً)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_kind TEXT NOT NULL DEFAULT 'gpu';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS attestation JSONB;

-- 4) قائمة انتظار أسطول الهواتف ("قريباً" في الصفحة الرئيسية)
CREATE TABLE IF NOT EXISTS waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'provider'
    CHECK (role IN ('provider','renter','both')),
  source TEXT DEFAULT 'phone_fleet_landing',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "waitlist_public_insert" ON waitlist;
CREATE POLICY "waitlist_public_insert" ON waitlist
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "waitlist_service_full" ON waitlist;
CREATE POLICY "waitlist_service_full" ON waitlist
  FOR ALL USING (true) WITH CHECK (true);

GRANT INSERT, SELECT ON waitlist TO anon, authenticated;

-- ============================================================
-- انتهى — التحقق: SELECT resource_type, tokens_per_hour FROM gpu_listings LIMIT 3;
-- ============================================================
