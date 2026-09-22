const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getSupabaseClient } = require('../config/supabase');

const client = getSupabaseClient(true);

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

  const { data: providerUser } = await client.from('profiles').insert([{
    id: crypto.randomUUID(),
    email: 'provider@test.com',
    full_name: 'أحمد المؤجر',
    role: 'provider',
    password_hash: passwordHash,
    is_verified: true,
    is_active: true,
  }]).select().single();

  const { data: renterUser } = await client.from('profiles').insert([{
    id: crypto.randomUUID(),
    email: 'renter@test.com',
    full_name: 'محمد المستأجر',
    role: 'renter',
    password_hash: passwordHash,
    is_verified: true,
    is_active: true,
  }]).select().single();

  const { data: adminUser } = await client.from('profiles').insert([{
    id: crypto.randomUUID(),
    email: 'admin@test.com',
    full_name: 'Admin User',
    role: 'admin',
    password_hash: passwordHash,
    is_verified: true,
    is_active: true,
  }]).select().single();

  // Create GPUs
  const gpuData = [
    { name: 'RTX 4090', brand: 'NVIDIA', vram_gb: 24, cuda_cores: 16384, tensor_cores: 512, rt_cores: 128, tdp_watts: 450, architecture: 'Ada Lovelace', is_active: true },
    { name: 'RTX 4080 Super', brand: 'NVIDIA', vram_gb: 16, cuda_cores: 10240, tensor_cores: 320, rt_cores: 80, tdp_watts: 320, architecture: 'Ada Lovelace', is_active: true },
    { name: 'RX 7900 XTX', brand: 'AMD', vram_gb: 24, tdp_watts: 355, architecture: 'RDNA 3', is_active: true },
    { name: 'RTX 3090', brand: 'NVIDIA', vram_gb: 24, cuda_cores: 10496, tensor_cores: 328, rt_cores: 82, tdp_watts: 350, architecture: 'Ampere', is_active: true },
    { name: 'RTX 3080', brand: 'NVIDIA', vram_gb: 10, cuda_cores: 8704, tensor_cores: 272, rt_cores: 68, tdp_watts: 320, architecture: 'Ampere', is_active: true },
    { name: 'RTX 3070', brand: 'NVIDIA', vram_gb: 8, cuda_cores: 5888, tensor_cores: 184, rt_cores: 46, tdp_watts: 220, architecture: 'Ampere', is_active: true },
  ];

  const { data: gpus } = await client.from('gpus').insert(gpuData.map(g => ({ ...g, id: crypto.randomUUID() }))).select();

  // Create listings
  const listingsData = [
    {
      id: crypto.randomUUID(),
      provider_id: providerUser.id,
      device_id: crypto.randomUUID(),
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
      device_id: crypto.randomUUID(),
      gpu_id: gpus[1].id,
      gpu_name: 'RTX 4080 Super',
      gpu_brand: 'NVIDIA',
      vram_gb: 16,
      cpu_model: 'AMD Ryzen 9 7950X',
      cpu_cores: 16,
      ram_gb: 32,
      storage_gb: 1000,
      os_name: 'Windows 11 Pro',
      price_per_hour: 1.8,
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
      device_id: crypto.randomUUID(),
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

  const { data: listings } = await client.from('gpu_listings').insert(listingsData).select();

  // Create devices
  const deviceData = [
    {
      id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
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

  await client.from('devices').insert(deviceData);

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
      device_id: crypto.randomUUID(),
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