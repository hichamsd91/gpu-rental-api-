// ============================================
// Rental enforcer — auto-settlement job
// ============================================
const { RentalService, healStuckListings } = require('../services/supabaseService');

const INTERVAL_MS = Math.max(10, Number(process.env.RENTAL_ENFORCER_INTERVAL_SEC) || 60) * 1000;
const PENDING_EXPIRY_MS = 2 * 60 * 60 * 1000;

let timer = null;
let initialTimer = null;

async function sweepOne(rental) {
  if (rental.status === 'active') {
    const settled = await RentalService.settleRental(rental.id, 'auto_expired');
    console.log(`[enforcer] auto-settled rental ${rental.id}`);
  } else if (rental.status === 'pending') {
    await RentalService.expirePendingRental(rental.id);
    console.log(`[enforcer] expired pending rental ${rental.id}`);
  }
}

async function sweep() {
  try {
    const due = await RentalService.findDueRentals(PENDING_EXPIRY_MS);
    for (const rental of due) {
      try { await sweepOne(rental); }
      catch (err) { console.error(`[enforcer] rental ${rental.id} failed:`, err.message); }
    }
    try { await healStuckListings(); }
    catch (err) { console.error('[enforcer] healStuckListings failed:', err.message); }

    try {
      const orderService = require('../services/orderService');
      const swept = await orderService.expireStale(200);
      if (swept.orders || swept.items) console.log(`[enforcer] expired ${swept.orders} stale order hold(s), ${swept.items} item(s)`);
    } catch (err) {
      if (err.code !== 'orders_unavailable') console.error('[enforcer] order hold sweep failed:', err.message);
    }

    try {
      const moneyService = require('../services/moneyService');
      const payouts = await moneyService.duePayouts();
      for (const p of payouts) {
        try {
          const stripeService = require('../services/stripeService');
          if (stripeService.isStripeConfigured() && p.amountMinor > 0) {
            const acct = await moneyService.getStripeAccount(p.providerId);
            if (acct && acct.stripeAccountId && acct.payoutsEnabled) {
              const transfer = await stripeService.createTransfer({
                amountMinor: p.amountMinor, currency: p.currency,
                destinationAccountId: acct.stripeAccountId, transferGroup: `payout:${p.id}`
              });
              await moneyService.markPayoutPaid(p.id, { transferId: transfer.id });
              console.log(`[enforcer] paid out ${p.id}`);
            }
          }
        } catch (err) {
          await moneyService.markPayoutFailed(p.id, err.message);
          console.error(`[enforcer] payout ${p.id} failed:`, err.message);
        }
      }
    } catch (err) {
      if (err.code !== 'money_unavailable') console.error('[enforcer] payout sweep failed:', err.message);
    }
  } catch (err) {
    console.error('[enforcer] sweep failed:', err.message);
  }
}

function start() {
  if (timer) return;
  timer = setInterval(sweep, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  initialTimer = setTimeout(sweep, 8000);
  if (typeof initialTimer.unref === 'function') initialTimer.unref();
  console.log(`[enforcer] rental enforcer started (every ${INTERVAL_MS / 1000}s)`);
}
function stop() {
  if (timer) clearInterval(timer);
  if (initialTimer) clearTimeout(initialTimer);
  timer = null; initialTimer = null;
}
module.exports = { start, stop, sweep };
