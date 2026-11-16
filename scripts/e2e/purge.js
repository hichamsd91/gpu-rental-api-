// Remove the E2E fixtures from the database it was run against.
//
// Deletes the fixture accounts AND everything they own (listings, devices,
// rentals, their ledger rows, wallets) plus the Supabase Auth users, so a test
// run never leaves a fake provider with a payable balance behind.
//
// Run from the server directory:  node scripts/e2e/purge.js
const fs = require('fs');
const path = require('path');
const { sbGet } = require('./fixtures');

const SERVER_ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(__dirname, '.fixtures.json');

const env = {};
for (const line of fs.readFileSync(path.join(SERVER_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const SB = env.SUPABASE_URL;
const KEY = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

const DELETE_EMAILS = ['renter.test@veloxora-test.dev', 'provider.test@veloxora-test.dev'];

const idsFromEnv = () => {
  const state = fs.existsSync(FIXTURES) ? JSON.parse(fs.readFileSync(FIXTURES, 'utf8')) : {};
  return [state.providerId, state.renterId].filter(Boolean);
};

(async () => {
  const targets = new Set(idsFromEnv());
  const found = [];
  for (const email of DELETE_EMAILS) {
    const rows = await sbGet(`profiles?select=id,email&email=eq.${encodeURIComponent(email)}`);
    if (Array.isArray(rows)) found.push(...rows);
    else console.log('lookup failed for', email, JSON.stringify(rows));
  }
  for (const row of found) targets.add(row.id);
  const ids = [...targets];
  console.log(`profiles to purge: ${ids.length}`, JSON.stringify(found));
  if (!ids.length) {
    if (fs.existsSync(FIXTURES)) fs.unlinkSync(FIXTURES);
    console.log('nothing to purge');
    return;
  }

  const inList = `(${ids.join(',')})`;
  const rentals = await sbGet(`rentals?select=id&or=(renter_id.in.${inList},provider_id.in.${inList})`);
  const rentalIds = (rentals || []).map((r) => r.id);
  console.log(`rentals to drop: ${rentalIds.length}`);
  if (rentalIds.length) {
    await fetch(`${SB}/rest/v1/transactions?related_id=in.(${rentalIds.join(',')})`, { method: 'DELETE', headers: svc });
  }
  await fetch(`${SB}/rest/v1/rentals?or=(renter_id.in.${inList},provider_id.in.${inList})`, { method: 'DELETE', headers: svc });
  await fetch(`${SB}/rest/v1/gpu_listings?provider_id=in.${inList}`, { method: 'DELETE', headers: svc });
  await fetch(`${SB}/rest/v1/devices?user_id=in.${inList}`, { method: 'DELETE', headers: svc });
  await fetch(`${SB}/rest/v1/transactions?user_id=in.${inList}`, { method: 'DELETE', headers: svc });
  await fetch(`${SB}/rest/v1/wallets?user_id=in.${inList}`, { method: 'DELETE', headers: svc });
  await fetch(`${SB}/rest/v1/profiles?id=in.${inList}`, { method: 'DELETE', headers: svc });

  // Auth users: otherwise the emails stay taken and the next run cannot sign up.
  for (const id of ids) {
    const res = await fetch(`${SB}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: svc });
    console.log(`auth user ${id}: ${res.status}`);
  }

  if (fs.existsSync(FIXTURES)) fs.unlinkSync(FIXTURES);

  const left = [];
  for (const email of DELETE_EMAILS) {
    const rows = await sbGet(`profiles?select=id,email&email=eq.${encodeURIComponent(email)}`);
    if (Array.isArray(rows)) left.push(...rows);
  }
  console.log(`fixtures left: ${left.length}`);
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
