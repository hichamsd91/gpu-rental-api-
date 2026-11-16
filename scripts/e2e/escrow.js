// E2E: escrow at start / settle at end / 0% commission / provider guard.
//
// Proves the money rules the owner decided:
//   1. the free tier is gone (410),
//   2. a session cannot start without the full quote in the wallet (402),
//   3. starting charges the whole quote (escrow), ending refunds the unused part,
//   4. the provider is paid the actual cost in full (no platform_fee row),
//   5. a provider cannot end a session at will (400 without a reason) and the
//      renter is compensated when they legitimately do.
//
// Prerequisites: the local API on :5000, `server/.env` with a service-role key.
// Run from the server directory:  node scripts/e2e/escrow.js
const { call } = require('./lib');
const {
  sbGet, walletOf, ensureWallet, provision, saveFixtures
} = require('./fixtures');

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

(async () => {
  const fx = await provision();
  const { providerId, renterId, providerToken, renterToken, listingId } = fx;

  // Fresh wallets: renter 0 (to prove the 402 gate), provider 0.
  await ensureWallet(renterId, 0);
  await ensureWallet(providerId, 0);

  // 1) Retired free tier
  const free = await call('POST', '/rentals/free', { token: renterToken, body: { listingId } });
  check('free tier retired (410)', free.status === 410 && free.body.code === 'free_sessions_retired', `${free.status}`);

  // 2) Create a paid rental, start without funds -> 402
  const create1 = await call('POST', '/rentals', {
    token: renterToken,
    body: { listingId, plannedDurationMinutes: 60 }
  });
  const rental1 = create1.body && create1.body.rental;
  check('rental created (201)', create1.status === 201 && !!rental1, `${create1.status}`);
  const start0 = await call('POST', `/rentals/${rental1.id}/start`, { token: renterToken, body: {} });
  check('start without funds -> 402', start0.status === 402 && start0.body.code === 'WALLET_INSUFFICIENT',
    `required=${start0.body.required} available=${start0.body.available}`);

  // 3) Fund 10$ and start -> escrow debit happens at start
  await ensureWallet(renterId, 10);
  const start1 = await call('POST', `/rentals/${rental1.id}/start`, { token: renterToken, body: {} });
  check('start funded (200)', start1.status === 200, `${start1.status}`);

  const afterStart = await walletOf(renterId);
  check('renter charged full quote at start (10 -> 7.5)', Math.abs(Number(afterStart.balance) - 7.5) < 0.001,
    `balance=${afterStart.balance}`);
  const holdRows = await sbGet(`transactions?related_id=eq.${rental1.id}&select=*`);
  const hold = (holdRows || []).find((t) => String(t.description || '').startsWith('Session escrow hold'));
  check('escrow hold transaction written', !!hold && Math.abs(Number(hold.amount) - 2.5) < 0.001,
    hold ? `amount=${hold.amount} status=${hold.status}` : 'missing');

  // 4) Renter ends after ~1 min -> 30 min minimum billed, unused refunded
  const end1 = await call('POST', `/rentals/${rental1.id}/end`, { token: renterToken, body: {} });
  check('renter end (200)', end1.status === 200, `${end1.status}`);

  const renterAfter = await walletOf(renterId);
  const providerAfter = await walletOf(providerId);
  // cost = 30 min * 2.5/h = 1.25 ; refund 2.5 - 1.25 = 1.25 ; renter 7.5 + 1.25 = 8.75
  check('unused time refunded (7.5 -> 8.75)', Math.abs(Number(renterAfter.balance) - 8.75) < 0.001,
    `balance=${renterAfter.balance}`);
  check('provider paid actual cost in full (1.25 = 0% commission)',
    Math.abs(Number(providerAfter.balance) - 1.25) < 0.001, `balance=${providerAfter.balance}`);

  const txn1 = await sbGet(`transactions?related_id=eq.${rental1.id}&select=*`);
  const feeRow = (txn1 || []).find((t) => t.type === 'platform_fee');
  check('no platform fee row (0% commission)', !feeRow, feeRow ? `fee=${feeRow.amount}` : 'none');

  // 5) Provider cannot end without a declared reason
  const create2 = await call('POST', '/rentals', {
    token: renterToken,
    body: { listingId, plannedDurationMinutes: 60 }
  });
  const rental2 = create2.body && create2.body.rental;
  const start2 = await call('POST', `/rentals/${rental2.id}/start`, { token: renterToken, body: {} });
  check('second rental started', start2.status === 200, `${start2.status}`);

  const badEnd = await call('POST', `/rentals/${rental2.id}/end`, { token: providerToken, body: {} });
  check('provider end without reason -> 400', badEnd.status === 400 && badEnd.body.code === 'provider_reason_required',
    `${badEnd.status}`);

  const provEnd = await call('POST', `/rentals/${rental2.id}/end`, {
    token: providerToken, body: { reason: 'hardware_failure' }
  });
  check('provider declared end (200)', provEnd.status === 200, `${provEnd.status}`);

  const renter3 = await walletOf(renterId);
  const provider3 = await walletOf(providerId);
  // rental2: escrow 2.5 (8.75 -> 6.25), cost 1.25 -> refund 1.25 (7.5),
  // provider +1.25 (2.5) then compensation 10% of planned value 2.5 = 0.25:
  // provider 2.25, renter 7.75
  check('provider-end compensation credited to renter (7.5 -> 7.75)',
    Math.abs(Number(renter3.balance) - 7.75) < 0.001, `balance=${renter3.balance}`);
  check('provider charged the compensation (2.5 -> 2.25)',
    Math.abs(Number(provider3.balance) - 2.25) < 0.001, `balance=${provider3.balance}`);

  const rentalRow = (await sbGet(`rentals?id=eq.${rental2.id}&select=*`))[0];
  check('end reason recorded', String(rentalRow.end_reason).startsWith('provider_ended'),
    rentalRow.end_reason);

  const listingRow = (await sbGet(`gpu_listings?id=eq.${listingId}&select=status`))[0];
  check('listing released after settlement', listingRow.status === 'active', listingRow.status);

  saveFixtures({ ...fx, rentalId: rental1.id, rentalId2: rental2.id });

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
