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
const HOLD_DAYS = Math.max(0, Number(process.env.PAYOUT_HOLD_DAYS || 7));
const LOOKBACK_DAYS = 90;
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
 * @param {{earnings?: Object, withdrawals?: Object, scheduled?: Object, minimumMinor?: number}} input
 *        per-provider totals in cents
 * @returns {Array<{providerId: string, amountMinor: number}>}
 */
function selectPayouts({
  earnings = {},
  withdrawals = {},
  scheduled = {},
  minimumMinor = MINIMUM_MINOR
} = {}) {
  const plan = [];
  for (const providerId of Object.keys(earnings)) {
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
  let rows = [];
  try {
    const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await getSupabaseClient(true)
      .from('transactions')
      .select('user_id,type,amount,status')
      .gte('created_at', since)
      .in('type', ['provider_earning', 'withdrawal'])
      .eq('status', 'completed');
    if (error) throw error;
    rows = data || [];
  } catch (error) {
    // No ledger table on this deployment: nothing to pay.
    return { skipped: 'unavailable', plan: [], created: [] };
  }

  const earnings = {};
  const withdrawals = {};
  for (const row of rows) {
    const amount = Math.abs(cents(row.amount));
    if (row.type === 'provider_earning') {
      earnings[row.user_id] = (earnings[row.user_id] || 0) + amount;
    } else {
      withdrawals[row.user_id] = (withdrawals[row.user_id] || 0) + amount;
    }
  }

  let pending = [];
  try {
    pending = await money.listPendingPayouts();
  } catch (error) {
    pending = [];
  }
  const scheduled = {};
  for (const payout of pending) {
    if (!payout || !payout.providerId) continue;
    scheduled[payout.providerId] = (scheduled[payout.providerId] || 0) + cents(Number(payout.amountMinor || 0) / 100);
  }

  const plan = selectPayouts({ earnings, withdrawals, scheduled });
  if (dryRun) return { plan, created: [], scheduledFor: scheduleDateFor(now).toISOString() };

  const scheduledFor = scheduleDateFor(now).toISOString();
  const created = [];
  for (const item of plan) {
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
