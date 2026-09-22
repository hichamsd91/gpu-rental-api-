-- Supabase Complete Schema for GPU Rental Platform
-- Run this in Supabase SQL Editor

-- ============================================
-- 1. PROFILES TABLE (Users)
-- ============================================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'renter' CHECK (role IN ('renter', 'provider', 'admin')),
  is_active BOOLEAN DEFAULT true,
  is_verified BOOLEAN DEFAULT false,
  phone_number TEXT,
  bio TEXT,
  avatar_url TEXT,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Service role full access profiles"
  ON profiles FOR ALL
  USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);

-- ============================================
-- 2. GPUS TABLE (GPU Catalog)
-- ============================================
CREATE TABLE IF NOT EXISTS gpus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  brand TEXT NOT NULL CHECK (brand IN ('NVIDIA', 'AMD', 'Intel')),
  vram_gb INTEGER NOT NULL CHECK (vram_gb >= 1),
  cuda_cores INTEGER,
  tensor_cores INTEGER,
  rt_cores INTEGER,
  tdp_watts INTEGER,
  architecture TEXT,
  release_date TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE gpus ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active gpus"
  ON gpus FOR SELECT
  USING (is_active = true);

CREATE POLICY "Service role full access gpus"
  ON gpus FOR ALL
  USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_gpus_brand ON gpus(brand);
CREATE INDEX IF NOT EXISTS idx_gpus_is_active ON gpus(is_active);

-- ============================================
-- 3. DEVICES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hostname TEXT,
  os_name TEXT,
  os_version TEXT,
  cpu_model TEXT,
  cpu_cores INTEGER,
  ram_gb INTEGER,
  storage_gb INTEGER,
  network_info TEXT,
  status TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'busy', 'maintenance')),
  agent_version TEXT,
  last_heartbeat_at TIMESTAMPTZ,
  gpu_temperature NUMERIC,
  gpu_utilization NUMERIC CHECK (gpu_utilization >= 0 AND gpu_utilization <= 100),
  vram_used_gb NUMERIC,
  vram_total_gb NUMERIC,
  power_usage_watts NUMERIC,
  auto_start_enabled BOOLEAN DEFAULT false,
  is_trusted BOOLEAN DEFAULT false,
  device_token TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own devices"
  ON devices FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own devices"
  ON devices FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own devices"
  ON devices FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access devices"
  ON devices FOR ALL
  USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_last_heartbeat ON devices(last_heartbeat_at);

-- ============================================
-- 4. GPU LISTINGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS gpu_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  gpu_id UUID NOT NULL REFERENCES gpus(id) ON DELETE CASCADE,
  gpu_name TEXT NOT NULL,
  gpu_brand TEXT NOT NULL,
  vram_gb INTEGER NOT NULL,
  cpu_model TEXT NOT NULL,
  cpu_cores INTEGER NOT NULL,
  ram_gb INTEGER NOT NULL,
  storage_gb INTEGER NOT NULL,
  os_name TEXT,
  price_per_hour NUMERIC NOT NULL CHECK (price_per_hour >= 0.01),
  price_per_minute NUMERIC,
  min_rental_minutes INTEGER NOT NULL DEFAULT 30 CHECK (min_rental_minutes >= 1),
  max_rental_hours INTEGER NOT NULL DEFAULT 168 CHECK (max_rental_hours >= 1),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'rented', 'maintenance', 'offline')),
  is_public BOOLEAN DEFAULT true,
  location_country TEXT,
  location_city TEXT,
  network_speed_mbps NUMERIC,
  average_rating NUMERIC CHECK (average_rating >= 0 AND average_rating <= 5),
  total_rentals INTEGER DEFAULT 0,
  total_revenue NUMERIC DEFAULT 0,
  allow_remote_desktop BOOLEAN DEFAULT true,
  allow_file_transfer BOOLEAN DEFAULT true,
  allow_custom_software BOOLEAN DEFAULT false,
  description TEXT CHECK (char_length(description) <= 1000),
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE gpu_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active public listings"
  ON gpu_listings FOR SELECT
  USING (status = 'active' AND is_public = true);

CREATE POLICY "Providers can read own listings"
  ON gpu_listings FOR SELECT
  USING (auth.uid() = provider_id);

CREATE POLICY "Providers can insert own listings"
  ON gpu_listings FOR INSERT
  WITH CHECK (auth.uid() = provider_id);

CREATE POLICY "Providers can update own listings"
  ON gpu_listings FOR UPDATE
  USING (auth.uid() = provider_id);

CREATE POLICY "Providers can delete own listings"
  ON gpu_listings FOR DELETE
  USING (auth.uid() = provider_id);

CREATE POLICY "Service role full access listings"
  ON gpu_listings FOR ALL
  USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_listings_status_public ON gpu_listings(status, is_public);
CREATE INDEX IF NOT EXISTS idx_listings_provider ON gpu_listings(provider_id);
CREATE INDEX IF NOT EXISTS idx_listings_price ON gpu_listings(price_per_hour);
CREATE INDEX IF NOT EXISTS idx_listings_rating ON gpu_listings(average_rating DESC);
CREATE INDEX IF NOT EXISTS idx_listings_device ON gpu_listings(device_id);
CREATE INDEX IF NOT EXISTS idx_listings_gpu ON gpu_listings(gpu_id);

-- ============================================
-- 5. RENTALS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS rentals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES gpu_listings(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  renter_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time TIMESTAMPTZ,
  planned_duration_minutes INTEGER NOT NULL CHECK (planned_duration_minutes >= 1),
  estimated_cost NUMERIC CHECK (estimated_cost >= 0),
  actual_duration_minutes INTEGER,
  actual_cost NUMERIC,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'connecting', 'active', 'paused', 'ended', 'failed', 'cancelled')),
  connection_data JSONB,
  end_reason TEXT,
  gpu_utilization NUMERIC CHECK (gpu_utilization >= 0 AND gpu_utilization <= 100),
  vram_used NUMERIC,
  cost_so_far NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rentals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Renters can read own rentals"
  ON rentals FOR SELECT
  USING (auth.uid() = renter_id);

CREATE POLICY "Providers can read own rentals"
  ON rentals FOR SELECT
  USING (auth.uid() = provider_id);

CREATE POLICY "Renters can insert rentals"
  ON rentals FOR INSERT
  WITH CHECK (auth.uid() = renter_id);

CREATE POLICY "Renters/Providers can update own rentals"
  ON rentals FOR UPDATE
  USING (auth.uid() = renter_id OR auth.uid() = provider_id);

CREATE POLICY "Service role full access rentals"
  ON rentals FOR ALL
  USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_rentals_provider ON rentals(provider_id, status);
CREATE INDEX IF NOT EXISTS idx_rentals_renter ON rentals(renter_id, status);
CREATE INDEX IF NOT EXISTS idx_rentals_listing ON rentals(listing_id, status);
CREATE INDEX IF NOT EXISTS idx_rentals_start_time ON rentals(start_time DESC);

-- ============================================
-- 6. TRANSACTIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('deposit', 'rental_charge', 'refund', 'provider_earning', 'platform_fee', 'withdrawal')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  amount NUMERIC NOT NULL,
  currency TEXT DEFAULT 'USD',
  related_id TEXT,
  description TEXT,
  metadata JSONB DEFAULT '{}',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own transactions"
  ON transactions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own transactions"
  ON transactions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access transactions"
  ON transactions FOR ALL
  USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

-- ============================================
-- 7. WALLETS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  balance NUMERIC NOT NULL DEFAULT 0 CHECK (balance >= 0),
  currency TEXT DEFAULT 'USD',
  pending_balance NUMERIC DEFAULT 0 CHECK (pending_balance >= 0),
  total_earnings NUMERIC DEFAULT 0,
  total_spent NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own wallet"
  ON wallets FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access wallets"
  ON wallets FOR ALL
  USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);

-- ============================================
-- 8. UPDATED_AT TRIGGER FUNCTION
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at trigger to all tables
DROP TRIGGER IF EXISTS update_profiles_updated_at ON profiles;
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_gpus_updated_at ON gpus;
CREATE TRIGGER update_gpus_updated_at
  BEFORE UPDATE ON gpus
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_devices_updated_at ON devices;
CREATE TRIGGER update_devices_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_gpu_listings_updated_at ON gpu_listings;
CREATE TRIGGER update_gpu_listings_updated_at
  BEFORE UPDATE ON gpu_listings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_rentals_updated_at ON rentals;
CREATE TRIGGER update_rentals_updated_at
  BEFORE UPDATE ON rentals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_transactions_updated_at ON transactions;
CREATE TRIGGER update_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_wallets_updated_at ON wallets;
CREATE TRIGGER update_wallets_updated_at
  BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 9. GRANT PERMISSIONS
-- ============================================
GRANT SELECT, INSERT, UPDATE ON profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON devices TO authenticated;
GRANT SELECT, INSERT, UPDATE ON gpu_listings TO authenticated;
GRANT SELECT, INSERT, UPDATE ON rentals TO authenticated;
GRANT SELECT, INSERT, UPDATE ON transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON wallets TO authenticated;
GRANT SELECT ON gpus TO authenticated;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- ============================================
-- 10. SEED GPU CATALOG (Optional - run once)
-- ============================================
-- INSERT INTO gpus (name, brand, vram_gb, cuda_cores, tensor_cores, rt_cores, tdp_watts, architecture, release_date) VALUES
-- ('RTX 4090', 'NVIDIA', 24, 16384, 512, 128, 450, 'Ada Lovelace', '2022-10-12'),
-- ('RTX 4080', 'NVIDIA', 16, 9728, 304, 76, 320, 'Ada Lovelace', '2022-11-16'),
-- ('RTX 4070 Ti', 'NVIDIA', 12, 7680, 240, 60, 285, 'Ada Lovelace', '2023-01-05'),
-- ('RTX 3090', 'NVIDIA', 24, 10496, 328, 82, 350, 'Ampere', '2020-09-24'),
-- ('RTX 3080', 'NVIDIA', 10, 8704, 272, 68, 320, 'Ampere', '2020-09-17'),
-- ('RX 7900 XTX', 'AMD', 24, NULL, NULL, NULL, 355, 'RDNA 3', '2022-12-13'),
-- ('RX 7900 XT', 'AMD', 20, NULL, NULL, NULL, 300, 'RDNA 3', '2022-12-13'),
-- ('A100 40GB', 'NVIDIA', 40, 6912, 432, NULL, 400, 'Ampere', '2020-05-14'),
-- ('H100 80GB', 'NVIDIA', 80, 16896, NULL, NULL, 700, 'Hopper', '2022-03-22');