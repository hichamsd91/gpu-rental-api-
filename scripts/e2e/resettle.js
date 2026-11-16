// E2E: settlement crash repair.
//
// Simulates the worst money bug: the process dies between flipping a rental to
// 'ended' and moving the money. The repair pass must complete the settlement
// EXACTLY ONCE — one refund, one provider credit, no platform fee — and a
// second sweep must move nothing.
//
// Prerequisites: the local API on :5000 started with
//   RENTAL_ENFORCER_INTERVAL_SEC=3600
// so the background sweep cannot race this script (the per-rental lock is
// in-process only). Run from the server directory:
//   node scripts/e2e/resettle.js
const path = require('path');
const { call } = require('./lib');
const {
  sbGet, sbPatch, walletOf, ensureWallet, provision, loadFixtures
} = require('./fixtures');

const SERVER_ROOT = path.resolve(__dirname, '../..');
require(path.join(SERVER_ROOT, 'node_modules/dotenv')).config({ path: path.join(SERVER_ROOT, '.env') });
process.chdir(SERVER_ROOT);

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.001;

(async () => {
  // Reuse the pair from escrow.js when it exists, otherwise make one.
  const state = loadFixtures() || (await provision());
  const { providerId, renterId, listingId, renterToken } = state;

  // Start from a known renter balance.
  await ensureWallet(renterId, 10);

  // Heal anything a previous failed run left behind (stray active session or a
  // listing still marked rented) so this scenario starts clean.
  const strays = await sbGet(`rentals?listing_id=eq.${listingId}&status=eq.active&select=id`);
  for (const stray of strays) {
    await call('POST', `/rentals/${stray.id}/end`, { token: renterToken, body: {} });
  }
  await sbPatch('gpu_listings', `id=eq.${listingId}`, { status: 'active' });

  const providerBefore = Number((await walletOf(providerId)).balance) || 0;

  const created = await call('POST', '/rentals', {
    token: renterToken,
    body: { listingId, plannedDurationMinutes: 60 }
  });
  const rental = created.body && created.body.rental;
  check('rental created', created.status === 201 && !!rental, `${created.status}`);

  const started = await call('POST', `/rentals/${rental.id}/start`, { token: renterToken, body: {} });
  check('rental started (escrow debited)', started.status === 200, `${started.status}`);
  check('renter charged the full quote (10 -> 7.5)', near((await walletOf(renterId)).balance, 7.5),
    `balance=${(await walletOf(renterId)).balance}`);

  // ── Simulate the crash: the row is closed, no money step ran ────────────
  await sbPatch('rentals', `id=eq.${rental.id}`, {
    status: 'ended',
    end_time: new Date().toISOString(),
    actual_duration_minutes: 30,
    actual_cost: 1.25,
    end_reason: 'renter_ended'
  });
  const rowsAtCrash = await sbGet(`transactions?related_id=eq.${rental.id}&select=type,description`);
  check('crash state: only the escrow row exists', rowsAtCrash.length === 1,
    `rows=${rowsAtCrash.map((r) => r.type).join(',')}`);
  check('crash state: wallet still short of the refund', near((await walletOf(renterId)).balance, 7.5));

  // ── The repair pass ────────────────────────────────────────────────────
  const enforcer = require(path.join(SERVER_ROOT, 'src/jobs/rentalEnforcer'));
  const { RentalService } = require(path.join(SERVER_ROOT, 'src/services/supabaseService'));

  const gaps = await RentalService.findSettlementGaps(50);
  check('gap detected for the crashed rental', gaps.some((g) => g.id === rental.id),
    `gaps=${gaps.length}`);

  // Three callers at once (request handler + enforcer + admin repair): the
  // per-rental lock must let exactly one of them move money.
  await Promise.all([
    RentalService.settleRental(rental.id, 'renter_ended'),
    enforcer.sweep(),
    RentalService.settleRental(rental.id, 'renter_ended')
  ]);

  const renterAfter = Number((await walletOf(renterId)).balance);
  const providerAfter = Number((await walletOf(providerId)).balance);
  check('unused time refunded once (7.5 -> 8.75)', near(renterAfter, 8.75), `balance=${renterAfter}`);
  check('provider paid the actual cost once (0% commission)',
    near(providerAfter - providerBefore, 1.25), `delta=${(providerAfter - providerBefore).toFixed(3)}`);

  const rowsAfter = await sbGet(`transactions?related_id=eq.${rental.id}&select=type,description,amount`);
  const earningRows = rowsAfter.filter((r) => String(r.description || '').startsWith('Rental earnings'));
  const refundRows = rowsAfter.filter((r) => String(r.description || '').startsWith('Unused session time refunded'));
  check('exactly one provider earning row', earningRows.length === 1, `count=${earningRows.length}`);
  check('exactly one refund row', refundRows.length === 1, `count=${refundRows.length}`);
  check('no platform fee row (0% commission)',
    !rowsAfter.some((r) => r.type === 'platform_fee'));

  // ── Idempotency: another sweep must move nothing ────────────────────────
  await enforcer.sweep();
  check('second sweep is a no-op for wallets',
    near((await walletOf(renterId)).balance, renterAfter) &&
    near((await walletOf(providerId)).balance, providerAfter));

  const stillGaps = await RentalService.findSettlementGaps(50);
  check('repaired rental is no longer a gap', !stillGaps.some((g) => g.id === rental.id));

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
