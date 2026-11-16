/**
 * Money routes (Phase 4): Stripe Connect onboarding, payment intents, webhooks,
 * escrow, payouts, refunds, invoices.
 *
 * Mounted at /api/money. Money intake respects PAYMENTS_ENABLED + STRIPE keys:
 * disabled endpoints answer clean 503s.
 */
const express = require('express');
const router = express.Router();
const money = require('../services/moneyService');
const stripe = require('../services/stripeService');
const { auth, providerAuth, renterAuth } = require('../middleware/auth');
const { isUuid } = require('../middleware/validation');

const stripeOff = (res) => res.status(503).json({ success: false, code: 'stripe_unavailable', message: 'Stripe is not configured on this deployment.' });

const handleError = (error, res) => {
  if (error instanceof money.MoneyUnavailable) {
    return res.status(503).json({ success: false, code: error.code, message: error.message });
  }
  if (error instanceof money.MoneyError) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message, ...(error.extra || {}) });
  }
  if (error && error.code === 'stripe_unavailable') {
    return stripeOff(res);
  }
  console.error('Money route error:', error);
  return res.status(500).json({ success: false, code: 'server_error', message: 'Server error' });
};

// ─── Stripe Connect (provider) ────────────────────────────────────────────────
router.get('/stripe-account', auth, providerAuth, async (req, res) => {
  try {
    const account = await money.getStripeAccount(req.user.id);
    res.json({ success: true, account, stripeConfigured: stripe.isStripeConfigured() });
  } catch (error) { handleError(error, res); }
});

router.post('/stripe-account/onboard', auth, providerAuth, async (req, res) => {
  try {
    if (!stripe.isStripeConfigured()) return stripeOff(res);
    const { country = 'US', refreshUrl, returnUrl } = req.body || {};
    const account = await money.ensureConnectAccount(req.user.id, req.user.email, country);
    const link = await stripe.createAccountLink({
      accountId: account.stripeAccountId,
      refreshUrl: refreshUrl || `${process.env.APP_URL || 'http://localhost:8080'}/provider/stripe/refresh`,
      returnUrl: returnUrl || `${process.env.APP_URL || 'http://localhost:8080'}/provider/stripe/return`
    });
    res.json({ success: true, account, onboardingUrl: link.url });
  } catch (error) { handleError(error, res); }
});

router.post('/stripe-account/refresh', auth, providerAuth, async (req, res) => {
  try {
    const account = await money.refreshConnectAccount(req.user.id);
    res.json({ success: true, account });
  } catch (error) { handleError(error, res); }
});

// ─── Payment intent for an order (renter) ─────────────────────────────────────
router.post('/payment-intents', auth, renterAuth, async (req, res) => {
  try {
    const { orderId, amount, currency = 'USD', idempotencyKey } = req.body || {};
    if (!orderId || !isUuid(orderId)) return res.status(400).json({ success: false, code: 'invalid_order_id', message: 'orderId is required' });
    const amountMinor = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) return res.status(400).json({ success: false, code: 'invalid_amount', message: 'amount must be positive' });
    const pi = await money.createPaymentIntentForOrder({
      userId: req.user.id, orderId, amountMinor, currency, idempotencyKey: idempotencyKey || req.get('Idempotency-Key')
    });
    res.status(201).json({ success: true, paymentIntent: pi });
  } catch (error) { handleError(error, res); }
});

router.get('/payment-intents/:id', auth, async (req, res) => {
  try {
    const pi = await money.getPaymentIntent(req.params.id);
    if (!pi) return res.status(404).json({ success: false, code: 'not_found', message: 'Payment intent not found' });
    res.json({ success: true, paymentIntent: pi });
  } catch (error) { handleError(error, res); }
});

// ─── Webhook (Stripe) ─────────────────────────────────────────────────────────
router.post('/webhooks/stripe', async (req, res) => {
  const sig = req.get('stripe-signature');
  let event;
  try {
    event = stripe.verifyWebhook(req.rawBody, sig);
  } catch (error) {
    return res.status(400).json({ success: false, code: 'invalid_signature', message: error.message });
  }
  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        await money.updatePaymentIntentStatus(pi.id, 'succeeded');
        // Hold funds in escrow for the rental if present
        if (pi.metadata && pi.metadata.rentalId) {
          await money.createEscrowHold({
            rentalId: pi.metadata.rentalId,
            paymentIntentId: pi.id,
            amountMinor: pi.amount,
            currency: (pi.currency || 'usd').toUpperCase()
          });
        }
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        await money.updatePaymentIntentStatus(pi.id, 'failed');
        break;
      }
      case 'account.updated': {
        // providers refresh on next /stripe-account/refresh call.
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook handling error:', error);
    res.status(500).json({ success: false, code: 'webhook_error', message: error.message });
  }
});

// ─── Escrow ───────────────────────────────────────────────────────────────────
router.get('/escrow/:rentalId', auth, async (req, res) => {
  try {
    if (!isUuid(req.params.rentalId)) return res.status(400).json({ success: false, code: 'invalid_id', message: 'Invalid rental id' });
    const hold = await money.getEscrowHold(req.params.rentalId);
    res.json({ success: true, hold });
  } catch (error) { handleError(error, res); }
});

router.post('/escrow/:rentalId/release', auth, providerAuth, async (req, res) => {
  try {
    if (!isUuid(req.params.rentalId)) return res.status(400).json({ success: false, code: 'invalid_id', message: 'Invalid rental id' });
    const result = await money.releaseEscrow(req.params.rentalId, req.user.id);
    res.json({ success: true, result });
  } catch (error) { handleError(error, res); }
});

router.post('/escrow/:rentalId/refund', auth, renterAuth, async (req, res) => {
  try {
    if (!isUuid(req.params.rentalId)) return res.status(400).json({ success: false, code: 'invalid_id', message: 'Invalid rental id' });
    const amountMinor = req.body?.amount ? Math.round(Number(req.body.amount) * 100) : null;
    const result = await money.refundEscrow(req.params.rentalId, req.user.id, { amountMinor });
    res.json({ success: true, result });
  } catch (error) { handleError(error, res); }
});

// ─── Payouts ──────────────────────────────────────────────────────────────────
router.get('/payouts', auth, providerAuth, async (req, res) => {
  try {
    const payouts = await money.listPayouts(req.user.id);
    res.json({ success: true, payouts });
  } catch (error) { handleError(error, res); }
});

router.post('/payouts/schedule', auth, providerAuth, async (req, res) => {
  try {
    const { amount, currency = 'USD', rentalIds = [], delayDays } = req.body || {};
    const amountMinor = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) return res.status(400).json({ success: false, code: 'invalid_amount', message: 'amount must be positive' });
    const payout = await money.schedulePayout({ providerId: req.user.id, amountMinor, currency, rentalIds, delayDays });
    res.status(201).json({ success: true, payout });
  } catch (error) { handleError(error, res); }
});

// ─── Refunds (renter) ─────────────────────────────────────────────────────────
router.post('/refunds', auth, renterAuth, async (req, res) => {
  try {
    const { paymentIntentId, rentalId, amount, currency = 'USD', reason, idempotencyKey } = req.body || {};
    if (!paymentIntentId) return res.status(400).json({ success: false, code: 'invalid_input', message: 'paymentIntentId is required' });
    const amountMinor = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) return res.status(400).json({ success: false, code: 'invalid_amount', message: 'amount must be positive' });
    const record = await money.createRefundRecord({ paymentIntentId, rentalId, amountMinor, currency, reason, idempotencyKey: idempotencyKey || req.get('Idempotency-Key') });
    // If Stripe configured, issue the refund upstream too.
    if (stripe.isStripeConfigured()) {
      try {
        const sr = await stripe.createRefund({ paymentIntentId, amountMinor, reason: reason === 'duplicate' ? 'duplicate' : 'requested_by_customer', idempotencyKey: idempotencyKey || req.get('Idempotency-Key') });
        await money.updateRefundStatus(record.id, 'succeeded', sr.id);
      } catch {
        await money.updateRefundStatus(record.id, 'failed');
      }
    }
    res.status(201).json({ success: true, refund: record });
  } catch (error) { handleError(error, res); }
});

// ─── Invoices ─────────────────────────────────────────────────────────────────
router.get('/invoices', auth, async (req, res) => {
  try {
    const invoices = await money.listInvoices(req.user.id);
    res.json({ success: true, invoices });
  } catch (error) { handleError(error, res); }
});

router.post('/invoices', auth, async (req, res) => {
  try {
    const { rentalId, orderId, amount, currency = 'USD', pdfUrl } = req.body || {};
    const amountMinor = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountMinor) || amountMinor < 0) return res.status(400).json({ success: false, code: 'invalid_amount', message: 'amount must be >= 0' });
    const invoice = await money.createInvoice({ userId: req.user.id, rentalId, orderId, amountMinor, currency, pdfUrl });
    res.status(201).json({ success: true, invoice });
  } catch (error) { handleError(error, res); }
});

// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => {
  if (error instanceof money.MoneyUnavailable || error instanceof money.MoneyError) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message, ...(error.extra || {}) });
  }
  if (error && error.code === 'stripe_unavailable') {
    return res.status(503).json({ success: false, code: 'stripe_unavailable', message: error.message });
  }
  console.error('Money route error:', error);
  return res.status(500).json({ success: false, code: 'server_error', message: 'Server error' });
});

module.exports = router;
