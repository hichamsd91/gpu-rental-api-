// ============================================
// Token pricing utilities
// ============================================
// Design (see docs/pricing-model.md):
//   - The wallet ledger stays in USD (single source of truth).
//   - Tokens are a FIXED-PEG display/charging unit: 1 token = $0.01.
//   - TOKENS_PER_USD default 100 => 100 tokens = $1.00.
//   - tokensPerHour is always DERIVED server-side from pricePerHour
//     (never accepted from a client) so the peg can never be broken.
//   - Same conversion for GPU hours and phone minutes: a unit is a unit.
//     Token pricing runs PARALLEL to hourly pricing (no extra cost for the
//     renter, no reduced earnings for the provider — pure unit conversion).

const parsed = Number(process.env.TOKENS_PER_USD);
const TOKENS_PER_USD = Number.isFinite(parsed) && parsed > 0 ? parsed : 100;

/** USD -> tokens (rounded to 3 decimals, whole tokens for display). */
const usdToTokens = (usd) => {
  const value = Number(usd);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * TOKENS_PER_USD * 1000) / 1000;
};

/** tokens -> USD (rounded to 3 decimals to stay NUMERIC(12,3)-safe). */
const tokensToUsd = (tokens) => {
  const value = Number(tokens);
  if (!Number.isFinite(value)) return 0;
  return Math.round((value / TOKENS_PER_USD) * 1000) / 1000;
};

module.exports = { TOKENS_PER_USD, usdToTokens, tokensToUsd };
