// ============================================================
// Platform commission model — قرار المالك: 5% عمولة تشغيلية + إعلانات
// ------------------------------------------------------------
// - الإيجارات المدفوعة: المنصة تأخذ 5% من المبلغ المحصّل فعلاً،
//   والمؤجّر يأخذ 95%. المستأجر يدفع دائماً السعر المعروض تماماً
//   (العمولة تخرج من نصيب المؤجّر لا من جيب المستأجر).
// - الإيجارات المجانية (التي تُموّلها الإعلانات): عمولة 0% —
//   الإعلان هو مصدر الدخل عنها، لا المستأجر.
// - المبلغ غير المحصّل (محفظة المستأجر لا تكفي) لا تُقتطع منه
//   أي عمولة — لا عمولة على مال لم يُجمع.
//
// IMPORTANT: هذا المعدل (0.05) وحساب المنصة (PLATFORM_USER_ID)
// متطابقان يدوياً مع migrations/003_settle_commission_5pct.sql —
// أي تغيير هنا يتطلب إعادة تشغيل الـ migration ذاته.
// ============================================================

const COMMISSION_RATE = 0.05;

// حساب المنصة الثابت في السجلّ (يُنشأ في migration 003):
// profiles + wallets بنفس المعرّف هذا — كل المسارات تتفق عليه.
const PLATFORM_USER_ID = '00000000-0000-4000-8000-000000000001';

const round3 = (value) => Math.round((Number(value) || 0) * 1000) / 1000;

const PlatformCommissionService = {
  rate: COMMISSION_RATE,
  platformUserId: PLATFORM_USER_ID,

  // يرجع تقسيم المبلغ المحصّل: { total, commission, providerEarning }
  // (fee + earning يتبادلان المبلغ بالضبط — لا دولار يضيع ولا يُخلَق)
  calculateCommission(amount, isFree = false) {
    const total = round3(amount);
    const commission = (isFree || total <= 0)
      ? 0
      : round3(total * COMMISSION_RATE);
    return {
      total,
      commission,
      providerEarning: round3(total - commission)
    };
  },

  async processRentalPayment(rental, listing) {
    const actualCost = rental.actualCost || rental.estimatedCost;
    const isFree = rental.isFree === true;
    const commission = this.calculateCommission(actualCost, isFree);

    return {
      success: true,
      breakdown: {
        total: commission.total,
        platformCommission: commission.commission,
        providerEarning: commission.providerEarning
      }
    };
  }
};

module.exports = { PlatformCommissionService };
