/**
 * Stripe integration (Phase 4).
 *
 * Soft dependency: the `stripe` npm package is required, but the service is a
 * no-op (returns { enabled: false }) unless STRIPE_SECRET_KEY is set, so the
 * rest of the platform keeps working in dev/test without credentials. Money
 * intake endpoints answer a clean 503 `stripe_unavailable` when disabled.
 */
let stripeClient = null;
let stripeLoadError = null;

const isStripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.trim());

const getClient = () => {
  if (!isStripeConfigured()) return null;
  if (stripeClient) return stripeClient;
  if (stripeLoadError) return null;
  try {
    const Stripe = require('stripe');
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-06-20',
      appInfo: { name: 'Veloxora', version: '1.0.0' }
    });
    return stripeClient;
  } catch (error) {
    stripeLoadError = error;
    console.warn('[stripe] failed to load SDK:', error.message);
    return null;
  }
};

const requireClient = () => {
  const client = getClient();
  if (!client) {
    const err = new Error('Stripe is not configured');
    err.code = 'stripe_unavailable';
    throw err;
  }
  return client;
};

const toStripeAmount = (minor) => {
  // Stripe expects the smallest currency unit; for zero-decimal currencies the
  // minor unit IS the major unit, so pass through.
  return Math.round(Number(minor));
};

const createPaymentIntent = async ({ amountMinor, currency = 'USD', userId, orderId = null, rentalId = null, idempotencyKey = null, metadata = {} }) => {
  const client = requireClient();
  const params = {
    amount: toStripeAmount(amountMinor),
    currency: String(currency).toLowerCase(),
    automatic_payment_methods: { enabled: true },
    metadata: { userId: String(userId), orderId: orderId || '', rentalId: rentalId || '', ...metadata }
  };
  const options = idempotencyKey ? { idempotencyKey } : undefined;
  return client.paymentIntents.create(params, options);
};

const retrievePaymentIntent = async (id) => {
  const client = requireClient();
  return client.paymentIntents.retrieve(id);
};

const cancelPaymentIntent = async (id) => {
  const client = requireClient();
  return client.paymentIntents.cancel(id);
};

const createRefund = async ({ paymentIntentId, amountMinor = null, reason = null, idempotencyKey = null }) => {
  const client = requireClient();
  const params = { payment_intent: paymentIntentId };
  if (amountMinor != null) params.amount = toStripeAmount(amountMinor);
  if (reason) params.reason = reason;
  const options = idempotencyKey ? { idempotencyKey } : undefined;
  return client.refunds.create(params, options);
};

// ─── Connect Express (providers) ──────────────────────────────────────────────
const createConnectAccount = async ({ email, country = 'US', metadata = {} }) => {
  const client = requireClient();
  return client.accounts.create({
    type: 'express',
    country,
    email,
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    metadata
  });
};

const createAccountLink = async ({ accountId, refreshUrl, returnUrl }) => {
  const client = requireClient();
  return client.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding'
  });
};

const retrieveAccount = async (accountId) => {
  const client = requireClient();
  return client.accounts.retrieve(accountId);
};

const createTransfer = async ({ amountMinor, currency = 'USD', destinationAccountId, transferGroup = null, metadata = {} }) => {
  const client = requireClient();
  const params = {
    amount: toStripeAmount(amountMinor, currency),
    currency: String(currency).toLowerCase(),
    destination: destinationAccountId,
    metadata
  };
  if (transferGroup) params.transfer_group = transferGroup;
  return client.transfers.create(params);
};

// ─── Webhook verification ─────────────────────────────────────────────────────
const verifyWebhook = (rawBody, signature) => {
  const client = requireClient();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    const err = new Error('STRIPE_WEBHOOK_SECRET not configured');
    err.code = 'stripe_unavailable';
    throw err;
  }
  return client.webhooks.constructEvent(rawBody, signature, secret);
};

module.exports = {
  isStripeConfigured,
  getClient,
  requireClient,
  createPaymentIntent,
  retrievePaymentIntent,
  cancelPaymentIntent,
  createRefund,
  createConnectAccount,
  createAccountLink,
  retrieveAccount,
  createTransfer,
  verifyWebhook
};
