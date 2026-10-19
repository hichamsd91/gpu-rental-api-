/**
 * Live end-to-end smoke test — boot the REAL API against YOUR live Supabase project and prove, over HTTP:
 *   1. GET /health answers 200 (root-level route; NOT /api/health)
 *   2. full auth lifecycle works end-to-end against the real database
 *   3. deposit returns a clean 503 PAYMENTS_DISABLED while PAYMENTS_ENABLED=false
 *   4. logout + refresh exercise the jti blacklist migration-004 code path (see below)
 *   5. after exit, ONLY this probe's rows are deleted from Supabase again — your data is not touched
 *
 * Run:            node scripts/live-smoke.cjs        (from the server/ directory)
 * Optional port:  SMOKE_PORT=5002 node scripts/live-smoke.cjs   (default 5002 = never collides with :5000)
 * Requires:       a filled-in .env in this directory and network access to its SUPABASE_URL.
 * Nothing here ever prints secret values — only status codes, messages and masked identifiers.
 *
 * NOTE on step 4 (honest signal — verified live on the real project behind .env on 2026-10-19):
 *   while migrations/004_auth_refresh_blacklist.sql has NOT been applied to Supabase yet, logout answers
 *   { success: true, revoked: false } ("Logged out") and refresh keeps working — the server's fail-soft is
 *   intentional so clients are never blocked from local sign-out. Those two checks will report FAIL until 004
 *   has run; afterwards they turn PASS (logout revoked:true / refresh -> 401 "Refresh token has been revoked").
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// This file lives in server/scripts/ — everything below it is resolved relative to THIS directory, so the tool
// works on any machine that owns this repo (no hardcoded absolute paths).
const SERVER_DIR = path.resolve(__dirname, '..');
const PORT = process.env.SMOKE_PORT || '5002'; // non-default port: never collides with an owner-run :5000 instance
const ROOT = `http://127.0.0.1:${PORT}`;
const API = `${ROOT}/api`;

// Minimal .env parser used ONLY for the Supabase REST cleanup at the end (the server itself loads .env via
// dotenv inside src/config/env.js). Values are read in-process and NEVER written to stdout.
function parseDotEnv(file) {
  const out = {};
  // NOTE: .split(/\r?\n/) is REQUIRED — for-of on a bare string iterates per character, not per line.
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line) || /^\s*#/.test(line)) continue;
    const i = line.indexOf('=');
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

async function waitForHealth() {
  for (let i = 0; i < 80; i++) { // up to ~40s for a cold boot incl. DB round-trips
    await new Promise(r => setTimeout(r, 500));
    try { const r = await fetch(`${ROOT}/health`); if (r.status === 200) return true; } catch {}
  }
  return false;
}

const results = [];
function record(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
}
async function asJson(r) { try { return await r.json(); } catch { return {}; } }

(async () => {
  // Guard: don't even attempt to spawn if the env file is absent (clear failure, no confusing boot hang).
  const envPath = path.join(SERVER_DIR, '.env');
  if (!fs.existsSync(envPath)) { console.log('ERROR: no .env found in ' + SERVER_DIR); process.exit(1); }

  console.log(`=== Veloxora LIVE E2E smoke — real server + real Supabase (port ${PORT}) ===\n`);

  // ---------- preflight: is egress to YOUR Supabase project even possible RIGHT NOW? ----------
  // Why: without this, a flaky network line makes register/login look like an app regression (register -> 500,
  // login -> 401) while the API is actually fine. Any HTTP response — including 401/403/404 — proves reachability;
  // only a connection-level failure means "retry later". This runs BEFORE any server boots and before ANY row
  // could be written, so a preflight failure can never leave an orphaned probe account behind.
  const envFileMap = parseDotEnv(envPath);
  const supaUrl = String(envFileMap.SUPABASE_URL || '').replace(/\/$/, '');
  if (!supaUrl) { console.log('ERROR: no SUPABASE_URL in .env — preflight impossible'); process.exit(1); }
  let reachable = false;
  for (let attempt = 1; attempt <= 3 && !reachable; attempt++) {
    try { await fetch(supaUrl, { method: 'GET', signal: AbortSignal.timeout(8000) }); reachable = true; }
    catch { if (attempt < 3) await new Promise(r => setTimeout(r, 1500)); }
  }
  if (!reachable) {
    console.log('ABORTED (no app or DB damage): this machine currently cannot reach your Supabase URL at the network level.');
    console.log('No server was booted and no rows could have been written. Re-run once your connection stabilizes — e.g.: node scripts/live-smoke.cjs');
    process.exit(1);
  }

  // ---------- phase 0: health contract on a live boot ----------
  const phase0 = spawn(process.execPath, [path.join('src', 'server.js')], { cwd: SERVER_DIR, env: { ...process.env, PORT }, stdio: 'inherit' });
  if (!await waitForHealth()) { console.log('FAIL: server did not become healthy on :' + PORT + ' — see boot output above (missing/invalid .env values fail fast by design in production)'); process.exit(1); }
  record('GET /health -> 200', true, 'root-level route, served before all /api/* mounts (server.js registers app.get("/health"))');
  // Kept on purpose: this was the URL docker-compose's healthcheck used before root commit 2a4c448, and a live
  // proof that it returns 404 while /health serves fine — not just reasoning about which prefix exists.
  const oldUrl = await fetch(`${ROOT}/api/health`);
  record('GET /api/health -> 404 (documents why the compose healthcheck must use root-level /health)', oldUrl.status === 404, `HTTP ${oldUrl.status}`);

  phase0.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 350)); // release the port before re-use in phase 1

  // ---------- phase 1: auth lifecycle + payments kill switch against the live database ----------
  const phase1 = spawn(process.execPath, [path.join('src', 'server.js')], { cwd: SERVER_DIR, env: { ...process.env, PORT }, stdio: 'inherit' });
  if (!await waitForHealth()) { console.log('FAIL: server did not re-boot for the auth phase'); process.exit(1); }

  const email = `veloxora.smoke.${Date.now()}@example.com`; // unique per run; deleted in cleanup below
  const password = 'Velox#Smoke91x'; // fixed strong string — this account is destroyed before exit, so no reuse risk to a real identity
  let user_id;
  console.log(`probe account (auto-deleted at the end): ${email}\n`);

  try {
    // 1. register -> fresh token pair (+ profile row in the real DB)
    let r = await fetch(`${API}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, fullName: 'Live Smoke Probe', role: 'renter' }) });
    let respBody = await asJson(r); user_id = respBody.user?.id;
    record('register -> 201 with token pair (real DB write)', r.status === 201 && !!respBody.token && !!respBody.refreshToken, `HTTP ${r.status} role=${respBody.user?.role}`);

    // 2. login -> same response contract as register
    r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    respBody = await asJson(r); user_id ||= respBody.user?.id;
    const accessToken = respBody.token; let refreshToken = respBody.refreshToken;
    record('login -> 200 with token pair', r.status === 200 && !!accessToken && !!refreshToken, `HTTP ${r.status} email=${respBody.user?.email}`);

    // 3. protected route reads the SAME row back from Supabase — the JWT <-> DB identity chain is intact
    r = await fetch(`${API}/auth/me`, { headers: { authorization: `Bearer ${accessToken}` } });
    respBody = await asJson(r);
    record('GET /auth/me -> profile matches', !!respBody?.user && (respBody.user.email === email || respBody.user.id === user_id), `HTTP ${r.status} id=${respBody?.user?.id ? 'found' : JSON.stringify(respBody).slice(0, 80)}`);

    // 4. live DB write path: renter wallet bootstrap (one row; cleaned up below via the probe UUID)
    r = await fetch(`${API}/payments/wallet`, { headers: { authorization: `Bearer ${accessToken}` } });
    const wb = await asJson(r);
    record('GET /payments/wallet -> live Supabase read/write OK', r.status === 200 && wb.success, `HTTP ${r.status} success=${wb.success ? 'true' : JSON.stringify(wb).slice(0, 80)}`);

    // 5. master switch: while PAYMENTS_ENABLED is off, money intake must fail fast and predictably BEFORE any DB write
    r = await fetch(`${API}/payments/deposit`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ amount: 5 }) });
    respBody = await asJson(r);
    record('deposit -> clean 503 PAYMENTS_DISABLED (kill switch live)', r.status === 503 && respBody.code === 'PAYMENTS_DISABLED', `HTTP ${r.status} msg="${respBody.message}"`);

    // 6. logout: persists a jti row to auth_blacklist — only possible once migrations/004_auth_refresh_blacklist.sql
    //    has been executed in the Supabase SQL editor (until then: { success: true, revoked: false } by fail-soft design)
    r = await fetch(`${API}/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
    respBody = await asJson(r);
    record('logout -> 200 with revoked:true (requires migration 004 applied)', r.status === 200 && respBody.revoked === true, `HTTP ${r.status} msg="${respBody.message}"`);

    // 7. the actual revocation proof: a blacklisted jti must be un-refreshable immediately
    r = await fetch(`${API}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
    respBody = await asJson(r);
    record('refresh after logout -> 401 revoked jti (requires migration 004 applied)', r.status === 401, `HTTP ${r.status} msg="${respBody.message}"`);

    // 8. revocation killed the SESSION, not the identity: re-login must still succeed
    r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    respBody = await asJson(r);
    record('re-login after logout -> 200 (per-session revocation)', r.status === 200 && !!respBody.token, `HTTP ${r.status}`);
  } catch (e) {
    console.log('EXCEPTION in phase 1:', e.message);
    record('phase 1 completed without crashing', false, e.message);
  }

  // ---------- cleanup: remove ONLY this probe's rows from Supabase (service role key from .env, values never printed) ----------
  // (supaUrl / envFileMap are the same instances declared in preflight — service-key access only.)
  console.log('\n=== cleanup of the probe account (rows pinned to exactly THIS run only) ===');
  const svcKey = envFileMap.SUPABASE_SERVICE_ROLE_KEY || envFileMap.SUPABASE_SECRET_KEY;
  // One automatic retry on a connection-level failure only: any HTTP response at all proves reachability, so a throwing
  // fetch() is the transient case. This box's egress to the Supabase edge flapped during validation — one more try two
  // seconds later costs nothing and keeps cleanup from depending on a second manual run.
  async function rest(method, ep) {
    if (!supaUrl || !svcKey) return 'no service-role key found in .env — skipping live cleanup (dashboard > Database to remove the row manually)';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const resp = await fetch(supaUrl + '/rest/v1' + ep, { method, headers: { apikey: svcKey, authorization: `Bearer ${svcKey}`, 'content-type': 'application/json', prefer: 'return=minimal&count=exact' } });
        return `HTTP ${resp.status}`;
      } catch (e) {
        if (attempt === 1) { await new Promise(r => setTimeout(r, 2000)); continue; }
        console.log(`  ! transient network error persisted on ${method} — delete manually in the Supabase dashboard (profile email=${email})`);
        return 'error: ' + e.message;
      }
    }
  }
  if (user_id && svcKey) { // child rows FIRST (FK-safe), all pinned to this probe UUID or its unique email — nothing else is ever touched
    console.log(`delete probe wallet row            -> ${await rest('DELETE', `/wallets?user_id=eq.${user_id}`)}`);
    const blStatus = await rest('DELETE', `/auth_blacklist?user_id=eq.${user_id}`);
    console.log(`delete probe auth_blacklist entries-> ${blStatus}${/HTTP 404/.test(blStatus) ? ' (table not present yet — expected before migration 004 runs)' : ''}`);
  } else if (!svcKey) {
    console.log('delete child rows                  -> SKIPPED (no service key in .env)');
  }
  console.log(`delete probe profile row           -> ${await rest('DELETE', `/profiles?email=eq.${encodeURIComponent(email)}`)}`);

  phase1.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 100));

  const failed = results.filter(x => !x.pass);
  // Operator-facing classification: the ONLY pre-migration-004 expectation is "exactly checks 6 and 7 fail" (fail-soft
  // revocation, see NOTE on step 4). Anything else failing means a real problem — state both plainly instead of making
  // the reader diff the FAIL lines against the header notes.
  const degradedOnly = failed.length === 2 &&
    failed.every(x => x.label.startsWith('logout ->') || x.label.startsWith('refresh after logout'));
  console.log('');
  if (failed.length === 0) {
    console.log(`=== RESULT: ${results.length}/${results.length} checks passed — FULL SUCCESS incl. live jti revocation (auth_blacklist is active) ===`);
  } else if (degradedOnly) {
    console.log(`=== RESULT: ${results.length - failed.length}/${results.length} — auth + payments verified LIVE; REVOCATION IS DEGRADED on this database (expected before migration 004) ===`);
    console.log('The two FAIL lines are the designed fail-soft signal, not an app defect.');
    console.log('Next step: run server/migrations/004_auth_refresh_blacklist.sql in the Supabase SQL editor, then re-run this script — expect a full pass of all checks (logout revoked:true / refresh -> 401).');
  } else {
    console.log(`=== RESULT: ${results.length - failed.length}/${results.length} — UNEXPECTED FAILURES above; investigate before deployment ===`);
  }
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL:', e && (e.stack || e.message)); process.exit(1); });
