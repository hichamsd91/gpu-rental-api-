// ============================================
// Rental enforcer — auto-settlement job
// ============================================
// Closes rentals that ran past their planned duration (billing them by the
// real settlement rules), cancels pending rentals that were never started,
// and heals listings stuck in 'rented' with no active rental holding them.
// Render runs a single free instance, so an in-process interval is enough —
// and it is safe because settleRental() is idempotent (the settle_rental RPC
// row-locks the rental; the JS fallback uses a conditional 'active' ->
// 'ended' flip, so a manual /end racing this job settles exactly once).
//
//   RENTAL_ENFORCER=false         -> disable entirely
//   RENTAL_ENFORCER_INTERVAL_SEC  -> sweep period (default 60s)
//
// PENDING NEVER-STARTED WINDOW: 2 hours after booking (generous — the renter
// may be setting up; after that the booking expires and the slot is free).
//
// HARDENING: each rental is processed inside its own try/catch — one broken
// rental can never stall the rest of the sweep (peer-review fix).
const { RentalService, healStuckListings } = require('../services/supabaseService');

const INTERVAL_MS = Math.max(10, Number(process.env.RENTAL_ENFORCER_INTERVAL_SEC) || 60) * 1000;
const PENDING_EXPIRY_MS = 2 * 60 * 60 * 1000;

let timer = null;

async function sweepOne(rental) {
  if (rental.status === 'active') {
    const settled = await RentalService.settleRental(rental.id, 'auto_expired');
    console.log(
      `[enforcer] auto-settled rental ${rental.id} (${settled?.actualCost ?? '?'}$ — ${settled?.actualDurationMinutes ?? '?'} min)`
    );
  } else if (rental.status === 'pending') {
    await RentalService.expirePendingRental(rental.id);
    console.log(`[enforcer] expired pending rental ${rental.id} (never started)`);
  }
}

async function sweep() {
  try {
    const due = await RentalService.findDueRentals(PENDING_EXPIRY_MS);
    for (const rental of due) {
      try {
        await sweepOne(rental);
      } catch (err) {
        // One bad rental must never stop the sweep — log and continue
        console.error(`[enforcer] rental ${rental.id} failed:`, err.message);
      }
    }
    // Second net: flip back listings stuck 'rented' with no active rental
    try {
      await healStuckListings();
    } catch (err) {
      console.error('[enforcer] healStuckListings failed:', err.message);
    }
  } catch (err) {
    console.error('[enforcer] sweep failed:', err.message);
  }
}

function start() {
  if (timer) return;
  timer = setInterval(sweep, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  setTimeout(sweep, 8000); // first sweep shortly after boot
  console.log(`[enforcer] rental enforcer started (every ${INTERVAL_MS / 1000}s)`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, sweep };
