// Fixture provisioning shared by the money scenarios.
//
// One provider + one renter on the local database, both marked verified, a
// device and a private listing so the renter never sees fixture rows in the
// catalog. Idempotent: a second run reuses the same accounts.
const fs = require('fs');
const path = require('path');
const { call, ensureUser } = require('./lib');

const SERVER_ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(__dirname, '.fixtures.json');

const readEnv = () => {
  const env = {};
  for (const line of fs.readFileSync(path.join(SERVER_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
};

const env = readEnv();
const SB = env.SUPABASE_URL;
const KEY = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) throw new Error('SUPABASE_URL / service key missing in server/.env');
const svc = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

const sbGet = async (q) => (await fetch(`${SB}/rest/v1/${q}`, { headers: svc })).json();
const sbPatch = async (table, q, body) => (await fetch(`${SB}/rest/v1/${table}?${q}`, {
  method: 'PATCH', headers: { ...svc, Prefer: 'return=representation' }, body: JSON.stringify(body)
})).json();
const sbPost = async (table, body) => (await fetch(`${SB}/rest/v1/${table}`, {
  method: 'POST', headers: { ...svc, Prefer: 'return=representation' }, body: JSON.stringify(body)
})).json();

const walletOf = async (userId) => {
  const rows = await sbGet(`wallets?user_id=eq.${userId}&select=*`);
  return rows[0] || null;
};

const ensureWallet = async (userId, balance) => {
  const existing = await walletOf(userId);
  if (!existing) return (await sbPost('wallets', [{ user_id: userId, balance }]))[0];
  return (await sbPatch('wallets', `user_id=eq.${userId}`, { balance }))[0];
};

/**
 * Create (or reuse) the fixture pair, a device and a listing.
 * @returns {Promise<{providerId:string, renterId:string, providerToken:string,
 *          renterToken:string, deviceId:string, listingId:string,
 *          email:{provider:string, renter:string}}>}
 */
async function provision() {
  const provider = await ensureUser('provider');
  const renter = await ensureUser('renter');
  const providerId = provider.user ? provider.user.id : provider.id;
  const renterId = renter.user ? renter.user.id : renter.id;
  const providerToken = provider.token;
  const renterToken = renter.token;

  await sbPatch('profiles', `id=eq.${providerId}`, { is_verified: true });
  await sbPatch('profiles', `id=eq.${renterId}`, { is_verified: true });

  const deviceRes = await call('POST', '/devices/register', {
    token: providerToken,
    body: {
      name: 'Escrow fixture workstation', hostname: 'escrow-fixture-01',
      osName: 'Ubuntu', osVersion: '24.04', cpuModel: 'Ryzen 9 7950X',
      cpuCores: 16, ramGb: 64, storageGb: 2048, networkInfo: '1 Gbps'
    }
  });
  const deviceId = deviceRes.body && deviceRes.body.device && deviceRes.body.device.id;
  if (!deviceId) throw new Error('device failed: ' + JSON.stringify(deviceRes.body));

  const listingRes = await call('POST', '/listings', {
    token: providerToken,
    body: {
      deviceId, gpuId: 'c6cafceb-3d63-4841-892f-04d227e91667',
      gpuName: 'RTX 4090 (escrow fixture)', gpuBrand: 'NVIDIA', vramGb: 24,
      cpuModel: 'Ryzen 9 7950X', cpuCores: 16, ramGb: 64, storageGb: 2048,
      osName: 'Ubuntu 24.04', pricePerHour: 2.5, minRentalMinutes: 30, maxRentalHours: 12,
      isPublic: false, locationCountry: 'MA', locationCity: 'Casablanca',
      networkSpeedMbps: 1000, allowRemoteDesktop: true, allowFileTransfer: true,
      description: 'Escrow E2E fixture.', tags: ['fixture', 'escrow']
    }
  });
  const listingId = listingRes.body && listingRes.body.listing && listingRes.body.listing.id;
  if (!listingId) throw new Error('listing failed: ' + JSON.stringify(listingRes.body));

  return {
    providerId, renterId, providerToken, renterToken, deviceId, listingId,
    email: { provider: provider.email, renter: renter.email }
  };
}

const saveFixtures = (data) => fs.writeFileSync(FIXTURES, JSON.stringify(data, null, 2));

const loadFixtures = () => (fs.existsSync(FIXTURES) ? JSON.parse(fs.readFileSync(FIXTURES, 'utf8')) : null);

module.exports = {
  FIXTURES,
  sbGet,
  sbPatch,
  sbPost,
  walletOf,
  ensureWallet,
  provision,
  saveFixtures,
  loadFixtures
};
