// ============================================================
// Platform commission model — owner decision (2026-11-15): 0%
// ------------------------------------------------------------
// The platform takes NO cut of a rental. The provider keeps 100%
// of the amount the session actually costs. Revenue comes from
// ads/sponsorship, never from the rental margin.
//
// The renter pays the displayed price; the provider receives it
// in full. Interruption compensation (provider ends early) is
// funded by the provider's own balance, not by the platform.
//
// NOTE: settlement now lives in supabaseService.settleRentalFunded
// (escrow aware). This service is kept for compatibility with the
// existing routes/tests and reads the same zero rate.
// ============================================================

const COMMISSION_RATE = 0;

// Platform ledger account id (created by migration 003). Kept so any
// historical platform_fee rows still resolve to a real profile.
const PLATFORM_USER_ID = '00000000-0000-4000-8000-000000000001';

const round3 = (value) => Math.round((Number(value) || 0) * 1000) / 1000;

const PlatformCommissionService = {
  rate: COMMISSION_RATE,
  platformUserId: PLATFORM_USER_ID,

  // Returns the split of the collected amount: { total, commission, providerEarning }
  // (fee + earning equal the amount exactly — no dollar is lost or created)
  calculateCommission(amount) {
    const total = round3(amount);
    return {
      total,
      commission: 0,
      providerEarning: total
    };
  },

  async processRentalPayment(rental) {
    const actualCost = rental.actualCost || rental.estimatedCost;
    const split = this.calculateCommission(actualCost);

    return {
      success: true,
      breakdown: {
        total: split.total,
        platformCommission: split.commission,
        providerEarning: split.providerEarning
      }
    };
  }
};

module.exports = { PlatformCommissionService };
