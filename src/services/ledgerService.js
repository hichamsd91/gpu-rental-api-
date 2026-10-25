/**
 * Ledger service — double-entry money movements in integer minor units.
 *
 * Backing: migrations/008_double_entry_ledger.sql. The only writer is the
 * `post_transfer` SQL function (SECURITY DEFINER); Node never inserts ledger
 * rows directly, so a balanced debit/credit pair is guaranteed even if two
 * callers race.
 *
 * Money representation (docs/MASTER_PLAN.md 2.1):
 *   - amounts are integers in the currency's minor unit (USD: cents),
 *   - balances are SUMs over the append-only ledger, never a stored column,
 *   - every transfer carries an `entry_group` used as an idempotency key.
 */
const crypto = require('crypto');
const { getSupabaseClient } = require('../config/supabase');

const TABLE = 'ledger_entries';
const DEFAULT_CURRENCY = 'USD';

// Currencies without fractional minor units (Stripe "zero-decimal").
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'PYG', 'RWF', 'UGX', 'XOF', 'XAF', 'XPF', 'GNF', 'ISK', 'HUF', 'TWD']);

const normalizeCurrency = (currency) => {
  const value = String(currency || DEFAULT_CURRENCY).toUpperCase().trim();
  return value || DEFAULT_CURRENCY;
};

const minorUnitFactor = (currency) => (ZERO_DECIMAL.has(normalizeCurrency(currency)) ? 1 : 100);

/** Dollars (float, presentation only) -> integer minor units. Rounds half-up. */
const toMinor = (amount, currency = DEFAULT_CURRENCY) => {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new TypeError(`toMinor: not a number (${amount})`);
  return Math.round(value * minorUnitFactor(currency));
};

/** Integer minor units -> dollars (for display only). */
const fromMinor = (minor, currency = DEFAULT_CURRENCY) => Number(minor) / minorUnitFactor(currency);

const walletAccount = (userId) => `wallet:${userId}`;
const commissionAccount = () => 'platform.commission';
const escrowAccount = (rentalId) => `escrow:${rentalId}`;
const cashAccount = () => 'stripe.cash';

const isDuplicateGroup = (error) =>
  Boolean(error && (error.code === '23505' || /duplicate key/i.test(error.message || '')));

/**
 * Post a balanced transfer. Returns { group, idempotent }.
 * Re-posting the same `group` is a no-op (idempotent: true), enforced by the
 * unique (entry_group, account) index — the database, not this code, decides.
 */
const postTransfer = async ({
  from,
  to,
  amountMinor,
  currency = DEFAULT_CURRENCY,
  refType = null,
  refId = null,
  group = null
}) => {
  if (!from || !to) throw new TypeError('postTransfer: from and to are required');
  if (from === to) throw new TypeError('postTransfer: from and to must differ');
  const minor = Number(amountMinor);
  if (!Number.isInteger(minor) || minor <= 0) {
    throw new TypeError(`postTransfer: amountMinor must be a positive integer (got ${amountMinor})`);
  }

  const client = getSupabaseClient(true);
  const groupId = group || crypto.randomUUID();

  const { error } = await client.rpc('post_transfer', {
    p_group: groupId,
    p_from: from,
    p_to: to,
    p_amount_minor: minor,
    p_currency: normalizeCurrency(currency),
    p_ref_type: refType,
    p_ref_id: refId
  });

  if (error) {
    if (isDuplicateGroup(error)) return { group: groupId, idempotent: true };
    throw new Error(`ledger post_transfer failed: ${error.message}`);
  }

  return { group: groupId, idempotent: false };
};

/** Current balance in minor units (defaults to 0 when the account is new). */
const balance = async (account, currency = DEFAULT_CURRENCY) => {
  if (!account) throw new TypeError('balance: account is required');
  const client = getSupabaseClient(true);
  const { data, error } = await client.rpc('ledger_balance', {
    p_account: account,
    p_currency: normalizeCurrency(currency)
  });
  if (error) throw new Error(`ledger balance failed: ${error.message}`);
  return Number(data);
};

module.exports = {
  postTransfer,
  balance,
  toMinor,
  fromMinor,
  minorUnitFactor,
  walletAccount,
  commissionAccount,
  escrowAccount,
  cashAccount,
  TABLE,
  DEFAULT_CURRENCY
};
