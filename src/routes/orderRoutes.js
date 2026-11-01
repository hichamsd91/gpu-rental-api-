/**
 * Orders / cart routes (Phase 3).
 *
 * Every mutation is idempotent: the client sends an `Idempotency-Key` it
 * persisted BEFORE the first attempt, so a dropped connection or a browser
 * refresh cannot create a second order, a second hold or a second payment.
 *
 * Mounted at /api/orders.
 */
const express = require('express');
const router = express.Router();

const orders = require('../services/orderService');
const idempotency = require('../services/idempotencyService');
const { auth, renterAuth } = require('../middleware/auth');
const { isUuid } = require('../middleware/validation');

router.param('id', (req, res, next, id) => {
  if (!isUuid(id)) return res.status(400).json({ message: 'Invalid order id', code: 'invalid_order_id' });
  next();
});

/** Idempotent wrapper: one key = one intent, replayed verbatim on retry. */
const idempotent = (scope, handler) => async (req, res, next) => {
  try {
    const key = req.get('Idempotency-Key') || req.get('idempotency-key') || (req.body && req.body.idempotencyKey);
    const outcome = await idempotency.run({
      userId: req.user.id,
      key,
      scope,
      body: req.body || {},
      handler: () => handler(req)
    });
    if (outcome.replay) res.set('Idempotent-Replay', 'true');
    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    return next(error);
  }
};

// @desc    Create a draft order with server-computed prices (nothing reserved)
// @route   POST /api/orders
// @access  Private/Renter
router.post('/', auth, renterAuth, idempotent('orders.create', async (req) => {
  const order = await orders.createDraft({ renterId: req.user.id, items: req.body ? req.body.items : undefined });
  return { status: 201, body: { success: true, order } };
}));

// @desc    The renter's own orders (newest first)
// @route   GET /api/orders?page=&limit=&status=
// @access  Private/Renter
router.get('/', auth, renterAuth, async (req, res, next) => {
  try {
    const result = await orders.listOrders(req.user.id, {
      page: req.query.page,
      limit: req.query.limit,
      status: req.query.status
    });
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// @desc    One order with its items and the remaining hold time
// @route   GET /api/orders/:id
// @access  Private/Renter (owner only)
router.get('/:id', auth, renterAuth, async (req, res, next) => {
  try {
    const order = await orders.getOrder(req.params.id, req.user.id);
    res.json({ success: true, order });
  } catch (error) {
    next(error);
  }
});

// @desc    Reserve every item for a short window (all-or-none)
// @route   POST /api/orders/:id/reserve   body: { ttlSeconds? }
// @access  Private/Renter (owner only)
router.post('/:id/reserve', auth, renterAuth, idempotent('orders.reserve', async (req) => {
  const order = await orders.reserve({
    orderId: req.params.id,
    renterId: req.user.id,
    ttlSeconds: req.body ? req.body.ttlSeconds : undefined
  });
  return { status: 200, body: { success: true, order } };
}));

// @desc    Convert every hold into a rental (atomic)
// @route   POST /api/orders/:id/pay
// @access  Private/Renter (owner only)
router.post('/:id/pay', auth, renterAuth, idempotent('orders.pay', async (req) => {
  const order = await orders.pay({ orderId: req.params.id, renterId: req.user.id });
  return { status: 200, body: { success: true, order } };
}));

// @desc    Cancel the whole order or selected items (recomputes the total)
// @route   POST /api/orders/:id/cancel   body: { itemIds?: string[] }
// @access  Private/Renter (owner only)
router.post('/:id/cancel', auth, renterAuth, idempotent('orders.cancel', async (req) => {
  const order = await orders.cancel({
    orderId: req.params.id,
    renterId: req.user.id,
    itemIds: req.body ? req.body.itemIds : null
  });
  return { status: 200, body: { success: true, order } };
}));

// Router-scoped error mapping: stable `code` for the app to localize, and a
// 503 (not 500) while migration 013 is pending.
// eslint-disable-next-line no-unused-vars
// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => {
  if (error instanceof orders.OrdersUnavailable || error instanceof idempotency.IdempotencyError) {
    return res.status(error.status || 409).json({
      message: error.message,
      code: error.code,
      ...(error.extra || {})
    });
  }
  if (error instanceof orders.OrderError) {
    return res.status(error.status || 400).json({
      message: error.message,
      code: error.code,
      ...(error.extra || {})
    });
  }
  console.error('Orders route error:', error);
  return res.status(500).json({ message: 'Server error', code: 'server_error' });
});

module.exports = router;
