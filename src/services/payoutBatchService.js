/**
 * Weekly batched payouts (owner decision D7).
 *
 * Why batches instead of per-session transfers: Stripe charges 2.9% + $0.30
 * per charge, so paying a provider after every $1–$3 session would eat 30%+
 * of their earnings. One transfer a week costs ~0.75% (ACH) instead.
 *
 * Rules:
 *   - a provider is paid only when the unpaid net reaches $50 (env
 *     PAYOUT_MINIMUM_USD, default 50) — smaller amounts roll over,
 *   - transfers land on a Monday, never sooner than the dispute hold
 *     (env PAYOUT_HOLD_DAYS, default 7) after the earnings were booked,
 *   - money already queued (`scheduled`/`processing`) is subtracted, so the
 *     same earnings can never be scheduled twice,
 *   - a session paid out this way is then debited from the provider's
 *     spendable wallet (WalletService.debitForPayout) when the transfer
 *     succeeds — the wallet stays the single source of truth on screen.
 */
const { getSupabaseClient } = require('../config/supabase');

const MINIMUM_MINOR = Math.max(100, Math.round(Number(process.env.PAYOUT_MINIMUM_USD || 50) * 100));
const MAXIMUM_MINOR = Math.max(MINIMUM_MINOR, Math.round(Number(process.env.PAYOUT_MAX_USD || 5000) * 100));
const HOLD_DAYS = Math.max(0, Number(process.env.PAYOUT_HOLD_DAYS || 7));
const MIN_BATCH_INTERVAL_MS = 60 * 60 * 1000; // at most one batch an hour

const cents = (value) => Math.round((Number(value) || 0) * 100) || 0;

// Next Monday 00:00 UTC strictly after `now`.
function nextMondayUtc(now = new Date()) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekday = day.getUTCDay(); // 0 = Sunday, 1 = Monday
  let add = (1 - weekday + 7) % 7;
  if (add === 0) add = 7;
  day.setUTCDate(day.getUTCDate() + add);
  return day;
}

// Payouts land on a Monday, never before the dispute hold has passed.
function scheduleDateFor(now = new Date(), holdDays = HOLD_DAYS) {
  const weekly = nextMondayUtc(now);
  const held = new Date(now.getTime() + holdDays * 24 * 60 * 60 * 1000);
  return new Date(Math.max(weekly.getTime(), held.getTime()));
}

/**
 * Pure planner — no I/O, so the money rules are testable.
 * @param {{earnings?: Object, withdrawals?: Object, scheduled?: Object,
 *          frozen?: Set<string>|string[], minimumMinor?: number}} input
 *        per-provider totals in cents; `frozen` = providers with an open dispute
 * @returns {Array<{providerId: string, amountMinor: number}>}
 */
function selectPayouts({
  earnings = {},
  withdrawals = {},
  scheduled = {},
  frozen = [],
  minimumMinor = MINIMUM_MINOR
} = {}) {
  const blocked = frozen instanceof Set ? frozen : new Set(frozen || []);
  const plan = [];
  for (const providerId of Object.keys(earnings)) {
    if (blocked.has(providerId)) continue;
    const net = (earnings[providerId] || 0) - (withdrawals[providerId] || 0) - (scheduled[providerId] || 0);
    if (net >= minimumMinor && net > 0) plan.push({ providerId, amountMinor: net });
  }
  return plan.sort((a, b) => b.amountMinor - a.amountMinor);
}

let lastRunAt = 0;

/**
 * Queue this week's payouts. Safe to call from the enforcer sweep every
 * minute: the planner subtracts already-queued money and the module also
 * rate-limits itself to one run an hour.
 */
async function runBatch({ now = new Date(), dryRun = false, force = false } = {}) {
  if (!dryRun && !force && now.getTime() - lastRunAt < MIN_BATCH_INTERVAL_MS) {
    return { skipped: 'throttled', plan: [], created: [] };
  }

  const money = require('./moneyService');
  const sb = getSupabaseClient(true);

  // The wallet is the source of truth for what a provider is owed: settlement
  // credits it, compensation debits it, a completed transfer debits it. Deriving
  // the amount from the ledger instead let a short-debited payout (or a
  // compensation) be paid twice.
  let wallets = [];
  try {
    const { data, error } = await sb.from('wallets').select('user_id,balance');
    if (error) throw error;
    wallets = data || [];
  } catch {
    // No wallet table on this deployment: nothing to pay.
    return { skipped: 'unavailable', plan: [], created: [] };
  }

  const earnings = {};
  for (const wallet of wallets) {
    const balance = cents(Number(wallet.balance) || 0);
    if (balance > 0) earnings[wallet.user_id] = balance;
  }

  let pending = [];
  try {
    pending = await money.listPendingPayouts();
  } catch {
    pending = [];
  }
  const scheduled = {};
  for (const payout of pending) {
    if (!payout || !payout.providerId) continue;
    scheduled[payout.providerId] = (scheduled[payout.providerId] || 0) + cents(Number(payout.amountMinor || 0) / 100);
  }

  // Freeze providers with an open dispute: their money stays in the wallet
  // until an admin resolves it (dispute window sits inside the T+7 hold).
  let frozen = [];
  try {
    const { data: openDisputes, error: disputeError } = await sb
      .from('disputes')
      .select('rental_id')
      .eq('status', 'open');
    if (disputeError) throw disputeError;
    const rentalIds = [...new Set((openDisputes || []).map((d) => d.rental_id).filter(Boolean))];
    if (rentalIds.length) {
      const { data: disputedRentals, error: rentalError } = await sb
        .from('rentals')
        .select('id,provider_id')
        .in('id', rentalIds);
      if (rentalError) throw rentalError;
      frozen = [...new Set((disputedRentals || []).map((r) => r.provider_id).filter(Boolean))];
    }
  } catch (error) {
    // Fail CLOSED: "we could not check the disputes" must never mean "pay
    // everyone". The next hourly run will try again.
    const missingTable = error.code === '42P01' || /does not exist/i.test(error.message || '');
    if (!missingTable) {
      console.error('[payouts] dispute freeze lookup failed — batch skipped:', error.message);
      return { skipped: 'dispute_lookup_failed', plan: [], created: [] };
    }
    frozen = [];
  }

  const plan = selectPayouts({ earnings, scheduled, frozen });
  if (dryRun) return { plan, created: [], scheduledFor: scheduleDateFor(now).toISOString() };

  const scheduledFor = scheduleDateFor(now).toISOString();
  const created = [];
  for (const item of plan) {
    // Sanity cap: a ledger anomaly must never become an automatic transfer.
    if (item.amountMinor > MAXIMUM_MINOR) {
      console.error(
        `[payouts] provider ${item.providerId} net ${item.amountMinor} exceeds the payout cap ${MAXIMUM_MINOR} — held for review`
      );
      continue;
    }
    // Only pay providers who finished Stripe onboarding: a transfer to a
    // non-onboarded account just fails (or worse, sits as a zombie payout).
    let account = null;
    try {
      account = await money.getStripeAccount(item.providerId);
    } catch {
      account = null;
    }
    if (!account || !account.stripeAccountId || !account.payoutsEnabled) continue;

    try {
      const payout = await money.schedulePayout({
        providerId: item.providerId,
        amountMinor: item.amountMinor,
        scheduledFor
      });
      if (payout) created.push(payout);
    } catch (error) {
      // One provider's failure must not block the rest of the batch.
      if (error.code !== 'money_unavailable') {
        console.error(`[payouts] scheduling failed for ${item.providerId}:`, error.message);
      }
    }
  }
  lastRunAt = now.getTime();
  return { plan, created, scheduledFor };
}

module.exports = {
  MINIMUM_MINOR,
  HOLD_DAYS,
  nextMondayUtc,
  scheduleDateFor,
  selectPayouts,
  runBatch,
  // exposed for tests
  _resetThrottle: () => { lastRunAt = 0; }
};
