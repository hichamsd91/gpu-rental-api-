const express = require('express');
const router = express.Router();
const { UserService, DeviceService, RentalService, TransactionService } = require('../services/supabaseService');
const { adminAuth } = require('../middleware/auth');
const { getSupabaseClient } = require('../config/supabase');

// @desc    Get all users
// @route   GET /api/admin/users
// @access  Private/Admin
router.get('/users', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const client = getSupabaseClient(true);

    const { data, error, count } = await client
      .from('profiles')
      .select('id, email, full_name, role, is_active, is_verified, phone_number, bio, avatar_url, last_login_at, created_at, updated_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;

    res.json({
      success: true,
      users: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Get all devices
// @route   GET /api/admin/devices
// @access  Private/Admin
router.get('/devices', adminAuth, async (req, res) => {
  try {
    const client = getSupabaseClient(true);

    const { data, error } = await client
      .from('devices')
      .select(`
        *,
        profiles!user_id (full_name, email)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, devices: data });
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Get all rentals
// @route   GET /api/admin/rentals
// @access  Private/Admin
router.get('/rentals', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const client = getSupabaseClient(true);

    const { data, error, count } = await client
      .from('rentals')
      .select(`
        *,
        gpu_listings!listing_id (gpu_name, gpu_brand),
        provider:profiles!provider_id (full_name, email),
        renter:profiles!renter_id (full_name, email)
      `, { count: 'exact' })
      .order('start_time', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;

    res.json({
      success: true,
      rentals: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('Get rentals error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Get platform stats
// @route   GET /api/admin/stats
// @access  Private/Admin
router.get('/stats', adminAuth, async (req, res) => {
  try {
    const client = getSupabaseClient(true);

    const [
      { count: totalUsers },
      { count: totalProviders },
      { count: totalRenters },
      { count: totalDevices },
      { count: totalRentals },
      { count: activeRentals },
      { data: revenueData }
    ] = await Promise.all([
      client.from('profiles').select('*', { count: 'exact', head: true }),
      client.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'provider'),
      client.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'renter'),
      client.from('devices').select('*', { count: 'exact', head: true }),
      client.from('rentals').select('*', { count: 'exact', head: true }),
      client.from('rentals').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      client.from('transactions')
        .select('amount')
        .eq('type', 'rental_charge')
        .eq('status', 'completed')
    ]);

    const totalRevenue = revenueData?.reduce((sum, t) => sum + Number(t.amount), 0) || 0;

    res.json({
      success: true,
      stats: {
        totalUsers: totalUsers || 0,
        totalProviders: totalProviders || 0,
        totalRenters: totalRenters || 0,
        totalDevices: totalDevices || 0,
        totalRentals: totalRentals || 0,
        activeRentals: activeRentals || 0,
        totalRevenue
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;