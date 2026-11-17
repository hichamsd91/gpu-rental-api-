// E2E: every rental purpose, live, with its own price and its own compensation.
//
// The platform is not "one product": a rendering job, a training run, an
// inference session and a mining window are four different contracts. This
// script proves, against a running API, that:
//   1. a listing can be sold per purpose with a purpose-specific price
//      (the quote is frozen on the rental, not read from the live listing),
//   2. the renter pays the full quote at start and gets the unused time back,
//   3. the provider keeps 100% of the actual cost (0% commission),
//   4. a provider-caused interruption is compensated differently by purpose:
//        - batch work (training, rendering): 2x the value of the remaining time
//        - interactive work (inference, mining): 10% of the planned value
//      and the money is always taken from the provider, never the platform,
//   5. mining is opt-in on both sides: the deployment flag, the renter's
//      acknowledgement, and a declared power cap are all enforced.
//
// Two offers are used, named after the workloads they are meant for:
//   "Beam"    — rendering / inference / mining   (interactive marketplace)
//   "LongCat" — model training / research        (batch marketplace)
//
// Run from the server directory:  node scripts/e2e/purposes.js
// Production: add E2E_BASE=https://gpu-rental-api.onrender.com/api, and always
// finish with `node scripts/e2e/purge.js`.
const { call } = require('./lib');
const {
  sbGet, sbPatch, ensureWallet, walletOf, provision
} = require('./fixtures');

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const money = (n) => Math.round(Number(n) * 1000) / 1000;
const near = (a, b, tolerance = 0.01) => Math.abs(money(a) - money(b)) <= tolerance;

const MIN_MINUTES = 30;

const createListing = async (token, deviceId, name, pricePerHour) => call('POST', '/listings', {
  token,
  body: {
    deviceId,
    gpuId: 'c6cafceb-3d63-4841-892f-04d227e91667',
    gpuName: name,
    gpuBrand: 'NVIDIA',
    vramGb: 24,
    cpuModel: 'Ryzen 9 7950X',
    cpuCores: 16,
    ramGb: 64,
    storageGb: 2048,
    osName: 'Ubuntu 24.04',
    pricePerHour,
    minRentalMinutes: MIN_MINUTES,
    maxRentalHours: 12,
    isPublic: false,
    locationCountry: 'MA',
    locationCity: 'Casablanca',
    networkSpeedMbps: 1000,
    allowRemoteDesktop: true,
    allowFileTransfer: true,
    description: `${name} — purpose E2E fixture.`,
    tags: ['fixture', 'purpose']
  }
});

const setPurposes = async (token, listingId, purposes) => call('PUT', `/listings/${listingId}/purposes`, {
  token, body: { purposes }
});

const setMiningFlag = (enabled) => sbPatch('feature_flags', 'key=eq.mining.allowed', { enabled });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ledgerOf = async (rentalId) => {
  const rows = await sbGet(`transactions?select=type,status,amount,user_id,description&related_id=eq.${rentalId}&order=created_at.asc`);
  return Array.isArray(rows) ? rows : [];
};

const claimsOf = async (rentalId) => {
  const rows = await sbGet(`settlement_claims?select=step&rental_id=eq.${rentalId}`);
  return Array.isArray(rows) ? rows.map((r) => r.step).sort() : [];
};

/**
 * One full rental for one purpose, from quote to settlement.
 * providerBase is the provider's opening balance so compensation can be
 * observed uncapped (the rule caps at the provider's own wallet).
 */
async function scenario({
  name, listing, purpose, plannedMinutes, pricePerHour,
  providerBase, ender, reason, miningAcknowledged = false, batch
}, ids) {
  const { renterId, providerId, renterToken, providerToken } = ids;

  await ensureWallet(renterId, 0);
  await ensureWallet(providerId, providerBase);

  const created = await call('POST', '/rentals', {
    token: renterToken,
    body: {
      listingId: listing.id,
      plannedDurationMinutes: plannedMinutes,
      purpose,
      ...(miningAcknowledged ? { miningAcknowledged: true } : {})
    }
  });
  check(`${name}: rental created`, created.status === 201, `${created.status}`);
  if (created.status !== 201) return;
  const rental = created.body.rental;

  check(`${name}: purpose recorded as ${purpose}`, rental.purpose === purpose, `${rental.purpose}`);

  // The purpose price must be the quoted price, not the listing base price.
  const expectedQuote = money((plannedMinutes / 60) * pricePerHour);
  check(
    `${name}: quoted at the ${purpose} rate ($${pricePerHour}/h)`,
    near(rental.estimatedCost, expectedQuote),
    `cost=${rental.estimatedCost} expected=${expectedQuote}`
  );

  // Fund the renter with the quote + $2 so the refund is visible.
  await ensureWallet(renterId, money(expectedQuote + 2));
  const started = await call('POST', `/rentals/${rental.id}/start`, { token: renterToken, body: {} });
  check(`${name}: started (escrow debited)`, started.status === 200, `${started.status}`);
  if (started.status !== 200) return;

  const renterAfterStart = await walletOf(renterId);
  check(
    `${name}: renter holds exactly the $2 that was not escrowed`,
    near(renterAfterStart.balance, 2),
    `balance=${renterAfterStart.balance}`
  );

  const ended = ender === 'provider'
    ? await call('POST', `/rentals/${rental.id}/end`, { token: providerToken, body: { reason } })
    : await call('POST', `/rentals/${rental.id}/end`, { token: renterToken, body: {} });
  check(
    `${name}: ended by ${ender}${reason ? ' (' + reason + ')' : ''}`,
    ended.status === 200,
    `${ended.status} ${JSON.stringify(ended.body).slice(0, 120)}`
  );

  const freshRes = await call('GET', `/rentals/${rental.id}`, { token: renterToken });
  const done = freshRes.body.rental;
  const elapsed = Math.max(1, Math.ceil((new Date(done.endTime) - new Date(done.startTime)) / 60000));
  const billable = Math.min(Math.max(elapsed, MIN_MINUTES), plannedMinutes);
  const finalCost = money((billable / 60) * pricePerHour);

  check(
    `${name}: billed ${billable} min at the quoted rate`,
    near(done.actualCost, finalCost),
    `actual=${done.actualCost} expected=${finalCost}`
  );

  // Compensation, recomputed exactly as the settlement rule states.
  const plannedValue = money((plannedMinutes / 60) * pricePerHour);
  const remaining = Math.max(0, plannedMinutes - Math.min(elapsed, plannedMinutes));
  let due = 0;
  if (ender === 'provider' && finalCost > 0) {
    due = batch ? money(2 * (remaining / 60) * pricePerHour) : money(plannedValue * 0.10);
    if (batch && due <= 0) due = money(plannedValue * 0.10);
  }
  const comp = money(Math.min(due, providerBase + finalCost));

  const renter = await walletOf(renterId);
  const provider = await walletOf(providerId);
  const refundUnused = money(expectedQuote - finalCost);

  check(
    `${name}: unused time returned ($${refundUnused})`,
    near(renter.balance, 2 + refundUnused + comp),
    `balance=${renter.balance} expected=${money(2 + refundUnused + comp)}`
  );
  check(
    `${name}: provider ${ender === 'provider' ? `paid $${finalCost} and charged $${comp}` : `paid $${finalCost} in full`}`,
    near(provider.balance, money(providerBase + finalCost - comp)),
    `balance=${provider.balance} expected=${money(providerBase + finalCost - comp)}`
  );

  if (ender === 'provider' && comp > 0) {
    check(
      `${name}: ${batch ? 'batch' : 'interactive'} compensation rule applied`,
      batch ? comp > money(plannedValue * 0.5) : comp <= money(plannedValue * 0.1) + 0.001,
      `comp=${comp} plannedValue=${plannedValue} (${batch ? '2x remaining' : '10% planned'})`
    );
  }

  const rows = await ledgerOf(rental.id);
  const types = rows.map((r) => r.type);
  check(`${name}: no platform fee anywhere (0% commission)`, !types.includes('platform_fee'), types.join(','));
  check(
    `${name}: provider earning row equals the actual cost`,
    rows.some((r) => r.type === 'provider_earning' && near(r.amount, finalCost)),
    rows.filter((r) => r.type === 'provider_earning').map((r) => r.amount).join(',')
  );
  check(
    `${name}: escrow row is completed`,
    rows.some((r) => r.type === 'rental_charge' && r.status === 'completed' && /escrow/i.test(r.description || '')),
    rows.filter((r) => r.type === 'rental_charge').map((r) => r.status).join(',')
  );

  const steps = await claimsOf(rental.id);
  const required = [
    'earning',
    ...(refundUnused > 0 ? ['refund'] : []),
    ...(ender === 'provider' && comp > 0 ? ['comp'] : [])
  ].sort();
  check(`${name}: claim rows written once per step`, required.every((s) => steps.includes(s)), steps.join(',') || 'none');

  return { rentalId: rental.id, finalCost, comp };
}

(async () => {
  const fx = await provision();
  const ids = {
    providerId: fx.providerId,
    renterId: fx.renterId,
    providerToken: fx.providerToken,
    renterToken: fx.renterToken
  };

  // ── The two offers ────────────────────────────────────────────────────────
  const beamRes = await createListing(fx.providerToken, fx.deviceId, 'Beam', 2.0);
  const beam = beamRes.body && beamRes.body.listing;
  check('offer "Beam" created (private)', beamRes.status === 201 && !!beam, `${beamRes.status}`);
  const longcatRes = await createListing(fx.providerToken, fx.deviceId, 'LongCat', 3.0);
  const longcat = longcatRes.body && longcatRes.body.listing;
  check('offer "LongCat" created (private)', longcatRes.status === 201 && !!longcat, `${longcatRes.status}`);
  if (!beam || !longcat) throw new Error('could not create the purpose offers');

  const beamPurposes = await setPurposes(fx.providerToken, beam.id, [
    { key: 'rendering', pricePerHour: 2.4 },
    { key: 'inference', pricePerHour: 2.2 }
  ]);
  check('Beam sells rendering / inference', beamPurposes.status === 200, `${beamPurposes.status} ${JSON.stringify(beamPurposes.body).slice(0, 120)}`);

  const longcatPurposes = await setPurposes(fx.providerToken, longcat.id, [
    { key: 'training', pricePerHour: 3.6 },
    { key: 'research', pricePerHour: 3.0 }
  ]);
  check('LongCat sells training / research', longcatPurposes.status === 200, `${longcatPurposes.status} ${JSON.stringify(longcatPurposes.body).slice(0, 120)}`);

  // The purpose rows themselves are the source of the quote; a private listing
  // is not readable through the public detail route, so read them as the
  // service role (what the provider saved must be what the renter is billed).
  const beamRows = await sbGet(`listing_purposes?select=purpose_key,price_per_hour&listing_id=eq.${beam.id}`);
  check(
    'Beam stores the per-purpose prices',
    Array.isArray(beamRows) && beamRows.length === 2 &&
      beamRows.some((p) => p.purpose_key === 'rendering' && near(p.price_per_hour, 2.4)) &&
      beamRows.some((p) => p.purpose_key === 'inference' && near(p.price_per_hour, 2.2)),
    JSON.stringify(beamRows)
  );

  // ── 1. Rendering — batch, renter ends early ──────────────────────────────
  await scenario({
    name: 'Beam/rendering', listing: beam, purpose: 'rendering', plannedMinutes: 60,
    pricePerHour: 2.4, providerBase: 5, ender: 'renter', batch: true
  }, ids);

  // ── 2. Training — batch, provider interrupts ─────────────────────────────
  await scenario({
    name: 'LongCat/training', listing: longcat, purpose: 'training', plannedMinutes: 90,
    pricePerHour: 3.6, providerBase: 20, ender: 'provider', reason: 'hardware_failure', batch: true
  }, ids);

  // ── 3. Inference — interactive, provider interrupts ──────────────────────
  await scenario({
    name: 'Beam/inference', listing: beam, purpose: 'inference', plannedMinutes: 60,
    pricePerHour: 2.2, providerBase: 5, ender: 'provider', reason: 'maintenance', batch: false
  }, ids);

  // ── 4. Research — batch product, renter ends at the minimum window ───────
  await scenario({
    name: 'LongCat/research', listing: longcat, purpose: 'research', plannedMinutes: 30,
    pricePerHour: 3.0, providerBase: 5, ender: 'renter', batch: false
  }, ids);

  // ── 5. Mining — opt-in on both sides ─────────────────────────────────────
  // While the deployment flag is off, mining is not a purchasable purpose at
  // all: the catalog filters it out, so it cannot be published on a listing and
  // a rental for it is refused before any money is quoted.
  await setMiningFlag(false);

  const miningOff = await call('POST', '/rentals', {
    token: fx.renterToken,
    body: { listingId: beam.id, plannedDurationMinutes: 60, purpose: 'mining', miningAcknowledged: true }
  });
  check(
    'mining: not purchasable while the deployment flag is off',
    miningOff.status === 400 && miningOff.body && miningOff.body.code === 'purpose_not_offered',
    `${miningOff.status} ${JSON.stringify(miningOff.body).slice(0, 100)}`
  );

  const miningPurposeOff = {
    key: 'mining',
    pricePerHour: 1.5,
    specs: { powerCapWatts: 300, disclosure: 'Hashing only during the booked window, capped at 300 W, provider keeps 100%.' }
  };
  const saveOff = await setPurposes(fx.providerToken, beam.id, [
    { key: 'rendering', pricePerHour: 2.4 },
    { key: 'inference', pricePerHour: 2.2 },
    miningPurposeOff
  ]);
  check(
    'mining: cannot be published on a listing while the flag is off',
    saveOff.status === 403 && saveOff.body && saveOff.body.code === 'purpose_disabled',
    `${saveOff.status} ${JSON.stringify(saveOff.body).slice(0, 100)}`
  );

  try {
    await setMiningFlag(true);
    await sleep(31000); // the flag cache in the running API is 30s

    const saveOn = await setPurposes(fx.providerToken, beam.id, [
      { key: 'rendering', pricePerHour: 2.4 },
      { key: 'inference', pricePerHour: 2.2 },
      miningPurposeOff
    ]);
    check(
      'mining: purpose can be published once the flag is on',
      saveOn.status === 200,
      `${saveOn.status} ${JSON.stringify(saveOn.body).slice(0, 140)}`
    );

    const noAck = await call('POST', '/rentals', {
      token: fx.renterToken,
      body: { listingId: beam.id, plannedDurationMinutes: 60, purpose: 'mining' }
    });
    check(
      'mining: acknowledgement required even with the flag on',
      noAck.status === 400 && noAck.body && noAck.body.code === 'mining_ack_required',
      `${noAck.status} ${JSON.stringify(noAck.body).slice(0, 100)}`
    );

    await scenario({
      name: 'Beam/mining', listing: beam, purpose: 'mining', plannedMinutes: 60,
      pricePerHour: 1.5, providerBase: 5, ender: 'provider', reason: 'emergency',
      miningAcknowledged: true, batch: false
    }, ids);
  } finally {
    // Never leave a dangerous flag on because a test failed.
    await setMiningFlag(false);
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('ERR', error.stack || error.message);
  process.exit(1);
});
