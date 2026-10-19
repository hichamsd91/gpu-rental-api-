const express = require('express');
const router = express.Router();
const { TransactionService, WalletService } = require('../services/supabaseService');
const { auth } = require('../middleware/auth');
// Payments are switchable (safe default OFF) until the real gateway is wired.
// Reads/wallet/ledger stay live; only MONEY INTAKE returns a clean 503 while off,
// so clients get one predictable answer instead of rows that never settle.
const { isPaymentsEnabled } = require('../config/env');

const paymentsOffHandler = (res) => res.status(503).json({
  success: false,
  code: 'PAYMENTS_DISABLED',
  message: 'Payments are currently disabled on the platform.'
});

// @desc    Get wallet balance
// @route   GET /api/payments/wallet
// @access  Private
router.get('/wallet', auth, async (req, res) => {
  try {
    const wallet = await WalletService.getOrCreate(req.user.id);
    res.json({ success: true, wallet });
  } catch (error) {
    console.error('Get wallet error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Add funds to wallet
// @route   POST /api/payments/deposit
// @access  Private
router.post('/deposit', auth, async (req, res) => {
  try {
    // Payment intake respects the master switch — clean, predictable 503 off.
    if (!isPaymentsEnabled()) return paymentsOffHandler(res);

    const { paymentMethodId } = req.body || {};
    const amount = Number(req.body?.amount);

    // Until the real gateway lands this only records a PENDING row
    // (no wallet credit) — but keep the input tight anyway
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
      return res.status(400).json({ message: 'Invalid amount' });
    }

    const transaction = await TransactionService.create({
      type: 'deposit',
      status: 'pending',
      amount,
      description: 'Wallet deposit',
      metadata: { paymentMethodId }
    }, req.user.id);

    res.status(201).json({ success: true, transaction });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Get transactions
// @route   GET /api/payments/transactions
// @access  Private
router.get('/transactions', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20, type } = req.query;

    const result = await TransactionService.findByUserId(req.user.id, { type }, { page, limit });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Process payment for rental
// @route   POST /api/payments/process
// @access  Private
router.post('/process', auth, async (req, res) => {
  try {
    // Payment intake respects the master switch — clean, predictable 503 off.
    if (!isPaymentsEnabled()) return paymentsOffHandler(res);

    const { rentalId } = req.body || {};
    const amount = Number(req.body?.amount);

    if (!rentalId) {
      return res.status(400).json({ message: 'rentalId is required' });
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
      return res.status(400).json({ message: 'Invalid amount' });
    }

    const transaction = await TransactionService.create({
      type: 'rental_charge',
      status: 'pending',
      amount,
      relatedId: rentalId,
      description: 'Rental payment'
    }, req.user.id);

    res.status(201).json({ success: true, transaction });
  } catch (error) {
    console.error('Process payment error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;