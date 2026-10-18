-- ============================================================
-- Migration 003: عمولة تشغيلية 5% + حساب المنصة
-- ------------------------------------------------------------
-- قرار المالك (المشروع): نموذج الدخل = 5% عمولة تشغيلية على الجلسات
-- المدفوعة + إعلانات عرضية. الإيجارات المجانية (المموّلة بإعلان)
-- تبقى بعمولة 0%.
--
-- التغيير في التسوية:
--   المحصّل  →  5% حساب المنصة  +  95% المؤجّر
-- المستأجر يدفع السعر المعروض تماماً (العمولة من نصيب المؤجّر).
-- المبلغ غير المحصّل لا تُقتطع منه عمولة (لا عمولة على مال لم يُجمع).
--
-- التوقيع (p_rental_id, p_end_reason) لا يتغير ← الخادم لا يحتاج أي
-- تعديل لاستدعاء الـ RPC. الوظيفة تحلّ محلّ نسخة 002 (CREATE OR REPLACE).
--
-- متطابق يدوياً مع:
--   server/src/services/commissionService.js  (COMMISSION_RATE = 0.05)
--   ACCOUNT = 00000000-0000-4000-8000-000000000001
--
-- شغّله في Supabase SQL Editor — آمن للتكرار.
-- ============================================================

-- ------------------------------------------------------------
-- 1) حساب المنصة (وجهة العمولة في السجلّ)
--    password_hash: تجزئة صالحة لكلمة عشوائية لا يعرفها أحد —
--    الحساب للسجلّ لا لتسجيل الدخول (أي محاولة دخول تفشل عاديًا).
-- ------------------------------------------------------------
INSERT INTO profiles (id, email, full_name, password_hash, role, is_active, is_verified, bio)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'platform@veloxora.com',
  'Veloxora Platform',
  '$2a$12$zB5ImWxn6SuD4LwTYXIItu40iRnAaqY81N.9wt7muzyVACnF0hsNe',
  'admin',
  true,
  false,
  'System account: platform commission ledger (not a login target)'
)
ON CONFLICT DO NOTHING;

INSERT INTO wallets (user_id, balance)
VALUES ('00000000-0000-4000-8000-000000000001', 0)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- 2) settle_rental v2 — نفس التوقيع، مقسّم5/95
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_rental(
  p_rental_id uuid,
  p_end_reason text DEFAULT 'manual'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rental       rentals%ROWTYPE;
  v_listing      gpu_listings%ROWTYPE;
  v_price        numeric;
  v_min_minutes  int;
  v_planned      int;
  v_elapsed      int;
  v_billable     int;
  v_cost         numeric(12,3);
  v_available    numeric(12,3);
  v_charged      numeric(12,3);
  v_unpaid       numeric(12,3);
  v_fee          numeric(12,3) := 0;  -- 5% للمنصة (من المحصّل فقط)
  v_provider     numeric(12,3) := 0;  -- 95% للمؤجّر
  v_now          timestamptz := now();
BEGIN
  -- قفل صف الإيجار: يُسلسل كل محاولات الإنهاء (يدوي + منفّذ) — idempotent
  SELECT * INTO v_rental
  FROM rentals
  WHERE id = p_rental_id
  FOR UPDATE;

  IF NOT FOUND OR v_rental.status <> 'active' THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'not_active');
  END IF;

  SELECT * INTO v_listing
  FROM gpu_listings
  WHERE id = v_rental.listing_id;

  v_price       := COALESCE(v_listing.price_per_hour, 0);
  v_min_minutes := GREATEST(1, COALESCE(v_listing.min_rental_minutes, 1));
  v_planned     := GREATEST(1, COALESCE(v_rental.planned_duration_minutes, v_min_minutes));
  v_elapsed     := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_now - v_rental.start_time)) / 60.0)::int);

  IF v_rental.is_free THEN
    v_cost     := 0;
    v_billable := 0;
  ELSE
    -- أرضية الحد الأدنى + سقف المقدّر (لا يدفع المستأجر أكثر مما رآه)
    v_billable := LEAST(GREATEST(v_elapsed, v_min_minutes), v_planned);
    v_cost     := ROUND((v_billable / 60.0) * v_price, 3);
  END IF;

  -- الإغلاق (تحت قفل الصف — من يفوز بال.flip يُسوّي مرة واحدة فقط)
  UPDATE rentals SET
    status                  = 'ended',
    end_time                = v_now,
    actual_duration_minutes = v_elapsed,
    actual_cost             = v_cost,
    cost_so_far             = v_cost,
    end_reason              = p_end_reason,
    updated_at              = v_now
  WHERE id = p_rental_id AND status = 'active';

  IF v_cost > 0 THEN
    -- ضمان وجود محفظتين
    INSERT INTO wallets (user_id, balance) VALUES (v_rental.renter_id, 0)
      ON CONFLICT (user_id) DO NOTHING;
    INSERT INTO wallets (user_id, balance) VALUES (v_rental.provider_id, 0)
      ON CONFLICT (user_id) DO NOTHING;

    -- قفل محفظة المستأجر: لا سباق بين تسويتين متزامنتين
    SELECT balance INTO v_available
    FROM wallets
    WHERE user_id = v_rental.renter_id
    FOR UPDATE;

    v_charged := LEAST(v_cost, GREATEST(0, v_available));
    v_unpaid  := v_cost - v_charged;

    IF v_charged > 0 THEN
      UPDATE wallets SET
        balance     = balance - v_charged,
        total_spent = COALESCE(total_spent, 0) + v_charged,
        updated_at  = v_now
      WHERE user_id = v_rental.renter_id;

      INSERT INTO transactions (user_id, type, status, amount, related_id, description)
      VALUES (v_rental.renter_id, 'rental_charge', 'completed', v_charged, p_rental_id,
              format('Rental charge (%s min session, billed %s min)', v_elapsed, v_billable));
    END IF;

    IF v_unpaid > 0 THEN
      INSERT INTO transactions (user_id, type, status, amount, related_id, description)
      VALUES (v_rental.renter_id, 'rental_charge', 'pending', v_unpaid, p_rental_id,
              'Unpaid rental remainder (top up your wallet)');
    END IF;

    -- مقسّم المحصّل: 5% للمنصة + 95% للمؤجّر (من المجمّع فعلاً فقط)
    IF v_charged > 0 THEN
      v_fee      := ROUND(v_charged * 0.05, 3);
      v_provider := v_charged - v_fee;
    END IF;

    -- حصة المنصة (فشلها لا يعطّل أبداً حصة المؤجّر — الترتيب هنا
    -- داخل نفس المعاملة: إما أن ينجح الكل أو لا شيء)
    IF v_fee > 0 THEN
      INSERT INTO wallets (user_id, balance)
      VALUES ('00000000-0000-4000-8000-000000000001', 0)
      ON CONFLICT (user_id) DO NOTHING;

      UPDATE wallets SET
        balance    = balance + v_fee,
        updated_at = v_now
      WHERE user_id = '00000000-0000-4000-8000-000000000001';

      INSERT INTO transactions (user_id, type, status, amount, related_id, description)
      VALUES ('00000000-0000-4000-8000-000000000001', 'platform_fee', 'completed',
              v_fee, p_rental_id,
              'Platform operational commission (5%)');
    END IF;

    -- 95% للمؤجّر — مما جُمع فعلاً فقط
    IF v_provider > 0 AND v_rental.provider_id IS NOT NULL THEN
      UPDATE wallets SET
        balance         = balance + v_provider,
        total_earnings  = COALESCE(total_earnings, 0) + v_provider,
        updated_at      = v_now
      WHERE user_id = v_rental.provider_id;

      INSERT INTO transactions (user_id, type, status, amount, related_id, description)
      VALUES (v_rental.provider_id, 'provider_earning', 'completed', v_provider, p_rental_id,
              format('Rental earnings (%s min session, after 5%% platform commission)', v_elapsed));
    END IF;
  END IF;

  -- تحرير البطاقة (نفس المعاملة — لا وضع rented للأبد)
  UPDATE gpu_listings SET status = 'active', updated_at = v_now
  WHERE id = v_rental.listing_id AND status = 'rented';

  RETURN jsonb_build_object(
    'settled', true,
    'cost', v_cost,
    'charged', v_charged,
    'unpaid', v_unpaid,
    'platform_fee', v_fee,
    'provider_earning', v_provider,
    'elapsed_minutes', v_elapsed,
    'billable_minutes', v_billable
  );
END;
$$;

-- الدالة للأداة الخادمة فقط (لا يراها المستأجر مباشرة أبداً)
REVOKE ALL ON FUNCTION public.settle_rental(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.settle_rental(uuid, text) TO service_role;

-- ============================================================
-- التحقق: SELECT settle_rental('00000000-0000-0000-0000-000000000000');
-- (سترجع {"settled": false, "reason": "not_active"} — هذا هو المتوقع)
-- ============================================================
