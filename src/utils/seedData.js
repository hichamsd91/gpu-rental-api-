const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getSupabaseClient } = require('../config/supabase');

const client = getSupabaseClient(true);

// Throw loudly on any Supabase error (silent failures caused bugs before)
const must = (res, label) => {
  if (res && res.error) throw new Error(`Seed failed at "${label}": ${res.error.message}`);
  return res;
};

const seedData = async () => {
  console.log('🌱 Starting Supabase seed...');

  // Clear existing data (in correct order due to FK constraints)
  await client.from('rentals').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await client.from('gpu_listings').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await client.from('devices').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await client.from('transactions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await client.from('wallets').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await client.from('gpus').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await client.from('profiles').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  // Create test users
  const passwordHash = await bcrypt.hash('test123', 12);

  const { data: providerUser } = must(await client.from('profiles').insert([{
    id: crypto.randomUUID(),
    email: 'provider@test.com',
    full_name: 'أحمد المؤجر',
    role: 'provider',
    password_hash: passwordHash,
    is_verified: true,
    is_active: true,
  }]).select().single(), 'profiles insert (provider)');

  const { data: renterUser } = must(await client.from('profiles').insert([{
    id: crypto.randomUUID(),
    email: 'renter@test.com',
    full_name: 'محمد المستأجر',
    role: 'renter',
    password_hash: passwordHash,
    is_verified: true,
    is_active: true,
  }]).select().single(), 'profiles insert (renter)');

  const { data: adminUser } = must(await client.from('profiles').insert([{
    id: crypto.randomUUID(),
    email: 'admin@test.com',
    full_name: 'Admin User',
    role: 'admin',
    password_hash: passwordHash,
    is_verified: true,
    is_active: true,
  }]).select().single(), 'profiles insert (admin)');

  // Create GPUs — full 2026 catalog (same list as supabase-complete-schema.sql)
  // NOTE: first 3 entries must stay RTX 4090, RTX 4080 SUPER, RX 7900 XTX —
  // listings below reference gpus[0], gpus[1], gpus[2].
  const gpuData = [
    { name: 'RTX 4090', brand: 'NVIDIA', vram_gb: 24, cuda_cores: 16384, tensor_cores: 512, rt_cores: 128, tdp_watts: 450, architecture: 'Ada Lovelace', is_active: true },
    { name: 'RTX 4080 SUPER', brand: 'NVIDIA', vram_gb: 16, cuda_cores: 10240, tensor_cores: 320, rt_cores: 80, tdp_watts: 320, architecture: 'Ada Lovelace', is_active: true },
    { name: 'RX 7900 XTX', brand: 'AMD', vram_gb: 24, tdp_watts: 355, architecture: 'RDNA 3', is_active: true },
    // NVIDIA Blackwell (RTX 50)
    { name: 'RTX 5090', brand: 'NVIDIA', vram_gb: 32, cuda_cores: 21760, tensor_cores: 680, rt_cores: 170, tdp_watts: 575, architecture: 'Blackwell', is_active: true },
    { name: 'RTX 5080', brand: 'NVIDIA', vram_gb: 16, cuda_cores: 10752, tensor_cores: 336, rt_cores: 84, tdp_watts: 360, architecture: 'Blackwell', is_active: true },
    { name: 'RTX 5070 Ti', brand: 'NVIDIA', vram_gb: 16, cuda_cores: 8960, tensor_cores: 280, rt_cores: 70, tdp_watts: 300, architecture: 'Blackwell', is_active: true },
    { name: 'RTX 5070', brand: 'NVIDIA', vram_gb: 12, cuda_cores: 6144, tensor_cores: 192, rt_cores: 48, tdp_watts: 250, architecture: 'Blackwell', is_active: true },
    { name: 'RTX 5060 Ti', brand: 'NVIDIA', vram_gb: 16, cuda_cores: 4608, tensor_cores: 144, rt_cores: 36, tdp_watts: 180, architecture: 'Blackwell', is_active: true },
    { name: 'RTX 5060', brand: 'NVIDIA', vram_gb: 8, cuda_cores: 3840, tensor_cores: 120, rt_cores: 30, tdp_watts: 145, architecture: 'Blackwell', is_active: true },
    // NVIDIA Ada Lovelace (RTX 40)
    { name: 'RTX 4070 Ti SUPER', brand: 'NVIDIA', vram_gb: 16, cuda_cores: 8448, tensor_cores: 264, rt_cores: 66, tdp_watts: 285, architecture: 'Ada Lovelace', is_active: true },
    { name: 'RTX 4070 SUPER', brand: 'NVIDIA', vram_gb: 12, cuda_cores: 7168, tensor_cores: 224, rt_cores: 56, tdp_watts: 220, architecture: 'Ada Lovelace', is_active: true },
    { name: 'RTX 4070', brand: 'NVIDIA', vram_gb: 12, cuda_cores: 5888, tensor_cores: 184, rt_cores: 46, tdp_watts: 200, architecture: 'Ada Lovelace', is_active: true },
    { name: 'RTX 4060 Ti', brand: 'NVIDIA', vram_gb: 8, cuda_cores: 4352, tensor_cores: 136, rt_cores: 34, tdp_watts: 160, architecture: 'Ada Lovelace', is_active: true },
    { name: 'RTX 4060', brand: 'NVIDIA', vram_gb: 8, cuda_cores: 3072, tensor_cores: 96, rt_cores: 24, tdp_watts: 115, architecture: 'Ada Lovelace', is_active: true },
    // NVIDIA Ampere (RTX 30)
    { name: 'RTX 3090 Ti', brand: 'NVIDIA', vram_gb: 24, cuda_cores: 10752, tensor_cores: 336, rt_cores: 84, tdp_watts: 450, architecture: 'Ampere', is_active: true },
    { name: 'RTX 3090', brand: 'NVIDIA', vram_gb: 24, cuda_cores: 10496, tensor_cores: 328, rt_cores: 82, tdp_watts: 350, architecture: 'Ampere', is_active: true },
    { name: 'RTX 3080', brand: 'NVIDIA', vram_gb: 10, cuda_cores: 8704, tensor_cores: 272, rt_cores: 68, tdp_watts: 320, architecture: 'Ampere', is_active: true },
    { name: 'RTX 3070', brand: 'NVIDIA', vram_gb: 8, cuda_cores: 5888, tensor_cores: 184, rt_cores: 46, tdp_watts: 220, architecture: 'Ampere', is_active: true },
    { name: 'RTX 3060', brand: 'NVIDIA', vram_gb: 12, cuda_cores: 3584, tensor_cores: 112, rt_cores: 28, tdp_watts: 170, architecture: 'Ampere', is_active: true },
    // Older NVIDIA still widely rented
    { name: 'RTX 2080 Ti', brand: 'NVIDIA', vram_gb: 11, cuda_cores: 4352, tdp_watts: 250, architecture: 'Turing', is_active: true },
    { name: 'GTX 1080 Ti', brand: 'NVIDIA', vram_gb: 11, cuda_cores: 3584, tdp_watts: 250, architecture: 'Pascal', is_active: true },
    // NVIDIA professional / workstation
    { name: 'RTX PRO 6000 Blackwell', brand: 'NVIDIA', vram_gb: 96, tdp_watts: 600, architecture: 'Blackwell', is_active: true },
    { name: 'RTX PRO 5000 Blackwell', brand: 'NVIDIA', vram_gb: 48, architecture: 'Blackwell', is_active: true },
    { name: 'RTX 6000 Ada', brand: 'NVIDIA', vram_gb: 48, cuda_cores: 18176, tdp_watts: 300, architecture: 'Ada Lovelace', is_active: true },
    { name: 'RTX 5000 Ada', brand: 'NVIDIA', vram_gb: 32, cuda_cores: 12800, tdp_watts: 250, architecture: 'Ada Lovelace', is_active: true },
    { name: 'A6000', brand: 'NVIDIA', vram_gb: 48, cuda_cores: 10752, tensor_cores: 336, rt_cores: 84, tdp_watts: 300, architecture: 'Ampere', is_active: true },
    // NVIDIA data center
    { name: 'H200', brand: 'NVIDIA', vram_gb: 141, cuda_cores: 16896, tdp_watts: 700, architecture: 'Hopper', is_active: true },
    { name: 'H100 SXM', brand: 'NVIDIA', vram_gb: 80, cuda_cores: 16896, tdp_watts: 700, architecture: 'Hopper', is_active: true },
    { name: 'L40S', brand: 'NVIDIA', vram_gb: 48, cuda_cores: 18176, tdp_watts: 350, architecture: 'Ada Lovelace', is_active: true },
    { name: 'L4', brand: 'NVIDIA', vram_gb: 24, cuda_cores: 7424, tdp_watts: 72, architecture: 'Ada Lovelace', is_active: true },
    { name: 'A100 80GB', brand: 'NVIDIA', vram_gb: 80, cuda_cores: 6912, tensor_cores: 432, tdp_watts: 400, architecture: 'Ampere', is_active: true },
    { name: 'A100 40GB', brand: 'NVIDIA', vram_gb: 40, cuda_cores: 6912, tensor_cores: 432, tdp_watts: 400, architecture: 'Ampere', is_active: true },
    { name: 'V100 32GB', brand: 'NVIDIA', vram_gb: 32, cuda_cores: 5120, tensor_cores: 640, tdp_watts: 300, architecture: 'Volta', is_active: true },
    // AMD Radeon
    { name: 'RX 9070 XT', brand: 'AMD', vram_gb: 16, tdp_watts: 304, architecture: 'RDNA 4', is_active: true },
    { name: 'RX 9070', brand: 'AMD', vram_gb: 16, tdp_watts: 220, architecture: 'RDNA 4', is_active: true },
    { name: 'RX 7900 XT', brand: 'AMD', vram_gb: 20, tdp_watts: 315, architecture: 'RDNA 3', is_active: true },
    { name: 'RX 7800 XT', brand: 'AMD', vram_gb: 16, tdp_watts: 263, architecture: 'RDNA 3', is_active: true },
    { name: 'RX 7600', brand: 'AMD', vram_gb: 8, tdp_watts: 165, architecture: 'RDNA 3', is_active: true },
    { name: 'RX 6800 XT', brand: 'AMD', vram_gb: 16, tdp_watts: 300, architecture: 'RDNA 2', is_active: true },
    { name: 'RX 6700 XT', brand: 'AMD', vram_gb: 12, tdp_watts: 230, architecture: 'RDNA 2', is_active: true },
    { name: 'RX 6600', brand: 'AMD', vram_gb: 8, tdp_watts: 132, architecture: 'RDNA 2', is_active: true },
    // Intel Arc
    { name: 'Arc B580', brand: 'Intel', vram_gb: 12, tdp_watts: 190, architecture: 'Battlemage', is_active: true },
    { name: 'Arc A770', brand: 'Intel', vram_gb: 16, tdp_watts: 225, architecture: 'Alchemist', is_active: true },
    { name: 'Arc A750', brand: 'Intel', vram_gb: 8, tdp_watts: 225, architecture: 'Alchemist', is_active: true },
  ];

  const { data: gpus } = must(
    await client.from('gpus').insert(gpuData.map(g => ({ ...g, id: crypto.randomUUID() }))).select(),
    'gpus insert'
  );

  // Create devices (MUST be before listings — gpu_listings.device_id references devices.id)
  const deviceIds = [crypto.randomUUID(), crypto.randomUUID()];
  const deviceData = [
    {
      id: deviceIds[0],
      user_id: providerUser.id,
      name: 'Workstation Alpha',
      hostname: 'ws-alpha',
      os_name: 'Ubuntu',
      os_version: '22.04 LTS',
      cpu_model: 'Intel Core i9-13900K',
      cpu_cores: 24,
      ram_gb: 64,
      storage_gb: 2000,
      status: 'online',
      agent_version: '1.0.0',
      last_heartbeat_at: new Date().toISOString(),
      gpu_temperature: 65.0,
      gpu_utilization: 45.0,
      vram_used_gb: 8.5,
      vram_total_gb: 24.0,
      power_usage_watts: 320.0,
      auto_start_enabled: true,
      is_trusted: true,
    },
    {
      id: deviceIds[1],
      user_id: providerUser.id,
      name: 'Render Station Beta',
      hostname: 'render-beta',
      os_name: 'Windows 11 Pro',
      os_version: '22H2',
      cpu_model: 'AMD Ryzen 9 7950X',
      cpu_cores: 16,
      ram_gb: 128,
      storage_gb: 4000,
      status: 'online',
      agent_version: '1.0.0',
      last_heartbeat_at: new Date().toISOString(),
      gpu_temperature: 58.0,
      gpu_utilization: 78.0,
      vram_used_gb: 18.2,
      vram_total_gb: 24.0,
      power_usage_watts: 410.0,
      auto_start_enabled: true,
      is_trusted: true,
    },
  ];

  must(await client.from('devices').insert(deviceData), 'devices insert');

  // Create listings
  const listingsData = [
    {
      id: crypto.randomUUID(),
      provider_id: providerUser.id,
      device_id: deviceIds[0],
      gpu_id: gpus[0].id,
      gpu_name: 'RTX 4090',
      gpu_brand: 'NVIDIA',
      vram_gb: 24,
      cpu_model: 'Intel Core i9-13900K',
      cpu_cores: 24,
      ram_gb: 64,
      storage_gb: 2000,
      os_name: 'Ubuntu 22.04 LTS',
      price_per_hour: 2.5,
      tokens_per_hour: 250,
      min_rental_minutes: 30,
      max_rental_hours: 168,
      status: 'active',
      is_public: true,
      location_country: 'United States',
      location_city: 'New York',
      network_speed_mbps: 1000,
      average_rating: 4.8,
      total_rentals: 150,
      total_revenue: 12500,
      allow_remote_desktop: true,
      allow_file_transfer: true,
      allow_custom_software: false,
      description: 'High-performance RTX 4090 workstation optimized for AI/ML training, rendering, and computational workloads. Low latency, high reliability.',
      tags: ['AI/ML', 'Rendering', 'Compute', 'Low Latency'],
    },
    {
      id: crypto.randomUUID(),
      provider_id: providerUser.id,
      device_id: deviceIds[1],
      gpu_id: gpus[1].id,
      gpu_name: 'RTX 4080 SUPER',
      gpu_brand: 'NVIDIA',
      vram_gb: 16,
      cpu_model: 'AMD Ryzen 9 7950X',
      cpu_cores: 16,
      ram_gb: 32,
      storage_gb: 1000,
      os_name: 'Windows 11 Pro',
      price_per_hour: 1.8,
      tokens_per_hour: 180,
      min_rental_minutes: 30,
      max_rental_hours: 120,
      status: 'active',
      is_public: true,
      location_country: 'Germany',
      location_city: 'Berlin',
      network_speed_mbps: 800,
      average_rating: 4.6,
      total_rentals: 89,
      total_revenue: 5600,
      allow_remote_desktop: true,
      allow_file_transfer: true,
      allow_custom_software: true,
      description: 'Powerful RTX 4080 Super for gaming, streaming, and AI workloads.',
      tags: ['Gaming', 'Streaming', 'AI/ML'],
    },
    {
      id: crypto.randomUUID(),
      provider_id: providerUser.id,
      device_id: deviceIds[0],
      gpu_id: gpus[2].id,
      gpu_name: 'RX 7900 XTX',
      gpu_brand: 'AMD',
      vram_gb: 24,
      cpu_model: 'Intel Core i7-13700K',
      cpu_cores: 16,
      ram_gb: 32,
      storage_gb: 1000,
      os_name: 'Ubuntu 22.04 LTS',
      price_per_hour: 1.5,
      tokens_per_hour: 150,
      min_rental_minutes: 30,
      max_rental_hours: 120,
      status: 'active',
      is_public: true,
      location_country: 'Canada',
      location_city: 'Toronto',
      network_speed_mbps: 600,
      average_rating: 4.5,
      total_rentals: 45,
      total_revenue: 2800,
      allow_remote_desktop: true,
      allow_file_transfer: true,
      allow_custom_software: true,
      description: 'AMD RX 7900 XTX with 24GB VRAM, perfect for rendering and compute tasks.',
      tags: ['Rendering', 'Compute', 'AMD'],
    },
  ];

  const { data: listings } = must(
    await client.from('gpu_listings').insert(listingsData).select(),
    'gpu_listings insert'
  );

  // Create wallets
  await client.from('wallets').insert([
    { id: crypto.randomUUID(), user_id: providerUser.id, balance: 12500.50, currency: 'USD', total_earnings: 12500.50, total_spent: 0 },
    { id: crypto.randomUUID(), user_id: renterUser.id, balance: 500.00, currency: 'USD', total_earnings: 0, total_spent: 450.00 },
  ]);

  // Create transactions
  await client.from('transactions').insert([
    { id: crypto.randomUUID(), user_id: providerUser.id, type: 'provider_earning', status: 'completed', amount: 12500.50, currency: 'USD', description: 'Total earnings', completed_at: new Date().toISOString() },
    { id: crypto.randomUUID(), user_id: renterUser.id, type: 'deposit', status: 'completed', amount: 500.00, currency: 'USD', description: 'Wallet deposit', completed_at: new Date().toISOString() },
    { id: crypto.randomUUID(), user_id: renterUser.id, type: 'rental_charge', status: 'completed', amount: 450.00, currency: 'USD', description: 'Rental payment', completed_at: new Date().toISOString() },
  ]);

  // Create rentals
  const now = new Date();
  await client.from('rentals').insert([
    {
      id: crypto.randomUUID(),
      listing_id: listings[0].id,
      provider_id: providerUser.id,
      renter_id: renterUser.id,
      device_id: deviceIds[0],
      start_time: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      planned_duration_minutes: 120,
      actual_duration_minutes: 90,
      actual_cost: 3.75,
      status: 'ended',
      gpu_utilization: 85,
      vram_used: 20,
      cost_so_far: 3.75,
      end_time: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
      end_reason: 'Session completed',
    },
    {
      id: crypto.randomUUID(),
      listing_id: listings[1].id,
      provider_id: providerUser.id,
      renter_id: renterUser.id,
      start_time: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
      planned_duration_minutes: 60,
      status: 'active',
      gpu_utilization: 60,
      vram_used: 10,
      cost_so_far: 0.90,
    },
  ]);

  console.log('✅ Seed data created successfully!');
  console.log('\nTest accounts:');
  console.log('Provider: provider@test.com / test123');
  console.log('Renter: renter@test.com / test123');
  console.log('Admin: admin@test.com / test123');
  console.log('\nGPUs:', gpus.length);
  console.log('Listings:', listings.length);
  console.log('Devices: 2');
  console.log('Rentals: 2');
  console.log('Wallets: 2');
  console.log('Transactions: 3');
  console.log('\n✅ Seeding completed');
  process.exit(0);
};

seedData().catch((error) => {
  console.error('❌ Seeding error:', error);
  process.exit(1);
});