// E2E: the worker agent executes real GPU work for a paid session.
//
// The money scenarios prove the contract; this one proves DELIVERY. It creates
// two purpose-specific offers (Beam for rendering, LongCat for training), rents
// them, submits an allowlisted job through the public API, and then runs the
// real worker agent against the real GPU on this machine. The assertions are on
// the job row the renter reads back: succeeded, progress 100, a result with a
// checksum/artifact, and a settlement that still pays the provider in full.
//
// Run from the server directory:  node scripts/e2e/agent.js
// Production: add E2E_BASE=https://gpu-rental-api.onrender.com/api, and always
// finish with `node scripts/e2e/purge.js`.
//
// Requirements: Python with pyopencl, an NVIDIA GPU, and node on PATH (the agent
// uses the same node binary as this script).
const path = require('path');
const { spawn } = require('child_process');

const { call, EMAIL, PASSWORD } = require('./lib');
const { sbGet, ensureWallet, walletOf, provision } = require('./fixtures');

const AGENT_DIR = path.resolve(__dirname, '../../../worker-agent');
const API_BASE = process.env.E2E_BASE || 'http://127.0.0.1:5000/api';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const money = (n) => Math.round(Number(n) * 1000) / 1000;
const near = (a, b, tolerance = 0.01) => Math.abs(money(a) - money(b)) <= tolerance;

const createListing = (token, deviceId, name, pricePerHour) => call('POST', '/listings', {
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
    minRentalMinutes: 30,
    maxRentalHours: 12,
    isPublic: false,
    locationCountry: 'MA',
    locationCity: 'Casablanca',
    networkSpeedMbps: 1000,
    allowRemoteDesktop: true,
    allowFileTransfer: true,
    description: `${name} — worker-agent E2E fixture.`,
    tags: ['fixture', 'agent']
  }
});

const setPurposes = (token, listingId, purposes) => call('PUT', `/listings/${listingId}/purposes`, {
  token, body: { purposes }
});

/** Runs the real agent once for this device and returns its parsed summary. */
const runAgent = (deviceId) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(AGENT_DIR, 'agent.js'), '--once'], {
    cwd: AGENT_DIR,
    windowsHide: true,
    env: {
      ...process.env,
      VELOXORA_API: API_BASE,
      VELOXORA_EMAIL: EMAIL.provider,
      VELOXORA_PASSWORD: PASSWORD,
      VELOXORA_DEVICE_ID: deviceId
    }
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk.toString(); });
  child.stderr.on('data', (chunk) => { err += chunk.toString(); });
  child.on('error', (error) => resolve({ code: -1, out, err: error.message }));
  child.on('close', (code) => {
    const line = out.split(/\r?\n/).find((row) => row.startsWith('AGENT_RESULT '));
    let summary = null;
    try { summary = line ? JSON.parse(line.slice('AGENT_RESULT '.length)) : null; } catch { summary = null; }
    resolve({ code, out, err, summary });
  });
});

async function scenario({ name, listing, jobBody, expect }, ids) {
  const { renterId, providerId, renterToken, providerToken, deviceId } = ids;
  const pricePerHour = listing.pricePerHour;
  const plannedMinutes = 30;
  const quote = money((plannedMinutes / 60) * pricePerHour);

  await ensureWallet(renterId, 0);
  await ensureWallet(providerId, 5);

  const created = await call('POST', '/rentals', {
    token: renterToken,
    body: { listingId: listing.id, plannedDurationMinutes: plannedMinutes, purpose: expect.purpose }
  });
  check(`${name}: rental created`, created.status === 201, `${created.status}`);
  if (created.status !== 201) return;
  const rental = created.body.rental;

  await ensureWallet(renterId, money(quote + 2));
  const started = await call('POST', `/rentals/${rental.id}/start`, { token: renterToken, body: {} });
  check(`${name}: started`, started.status === 200, `${started.status}`);
  if (started.status !== 200) return;

  const submitted = await call('POST', `/rentals/${rental.id}/job`, { token: renterToken, body: jobBody });
  check(
    `${name}: renter submitted ${jobBody.kind}`,
    submitted.status === 201 && submitted.body.job && submitted.body.job.status === 'queued',
    `${submitted.status} ${JSON.stringify(submitted.body).slice(0, 140)}`
  );
  if (submitted.status !== 201) return;

  const agent = await runAgent(deviceId);
  check(
    `${name}: agent executed the job on the GPU`,
    agent.code === 0 && agent.summary && agent.summary.status === 'succeeded',
    `exit=${agent.code} ${JSON.stringify(agent.summary).slice(0, 160)} ${agent.err.slice(0, 120)}`
  );

  const jobRes = await call('GET', `/rentals/${rental.id}/job`, { token: renterToken });
  const job = jobRes.body && jobRes.body.job;
  check(`${name}: job is succeeded for the renter`, job && job.status === 'succeeded', job && job.status);
  check(`${name}: progress reached 100`, job && job.progress === 100, job && job.progress);
  check(
    `${name}: result carries a checksum`,
    job && job.result && typeof job.result.checksum === 'string' && job.result.checksum.length >= 8,
    job && job.result && job.result.checksum
  );
  check(
    `${name}: result names the GPU`,
    job && job.result && /NVIDIA|RTX|Radeon|Apple/i.test(String(job.result.device)),
    job && job.result && job.result.device
  );
  check(
    `${name}: progress log was streamed`,
    job && typeof job.log === 'string' && /repeat|band/i.test(job.log),
    job && String(job.log || '').slice(0, 80)
  );

  if (expect.verified) {
    check(`${name}: kernel output verified against CPU`, job && job.result && job.result.verified === true,
      job && job.result && job.result.verified);
    check(`${name}: reported compute throughput`, job && job.result && job.result.gflops > 0,
      job && job.result && job.result.gflops);
  }
  if (expect.artifact) {
    check(
      `${name}: a real PNG artifact was produced`,
      job && job.result && job.result.artifact && job.result.artifact.mime === 'image/png' &&
        job.result.artifact.bytes > 0 && job.result.artifact.base64.length > 0,
      job && job.result && job.result.artifact && job.result.artifact.bytes
    );
  }

  // Telemetry from the agent's heartbeat must have landed on the device row.
  const devices = await sbGet(`devices?select=last_heartbeat_at,gpu_temperature,gpu_utilization,vram_total_gb,agent_version&id=eq.${deviceId}`);
  const device = devices && devices[0];
  check(
    `${name}: heartbeat recorded telemetry`,
    Boolean(device && device.last_heartbeat_at && device.vram_total_gb > 0),
    device && JSON.stringify(device).slice(0, 140)
  );

  const ended = await call('POST', `/rentals/${rental.id}/end`, { token: renterToken, body: {} });
  check(`${name}: session ended and settled`, ended.status === 200, `${ended.status}`);

  const fresh = await call('GET', `/rentals/${rental.id}`, { token: renterToken });
  const done = fresh.body && fresh.body.rental;
  check(
    `${name}: billed the minimum window at the purpose rate`,
    done && near(done.actualCost, money((30 / 60) * pricePerHour)),
    done && done.actualCost
  );

  const ledger = await sbGet(`transactions?select=type,amount,status&related_id=eq.${rental.id}`);
  const rows = Array.isArray(ledger) ? ledger : [];
  check(
    `${name}: provider paid in full, no platform fee`,
    rows.some((row) => row.type === 'provider_earning' && near(row.amount, done.actualCost)) &&
      !rows.some((row) => row.type === 'platform_fee'),
    rows.map((row) => row.type).join(',')
  );

  const provider = await walletOf(providerId);
  check(
    `${name}: provider wallet grew by the actual cost`,
    near(provider.balance, money(5 + done.actualCost)),
    provider.balance
  );

  return { rentalId: rental.id, jobId: job && job.rentalId, providerToken };
}

(async () => {
  const fx = await provision();
  const ids = { ...fx };

  const beamRes = await createListing(fx.providerToken, fx.deviceId, 'Beam Agent', 2.4);
  const beam = beamRes.body && beamRes.body.listing;
  check('offer "Beam Agent" created (private)', beamRes.status === 201 && !!beam, `${beamRes.status}`);

  const longcatRes = await createListing(fx.providerToken, fx.deviceId, 'LongCat Agent', 3.6);
  const longcat = longcatRes.body && longcatRes.body.listing;
  check('offer "LongCat Agent" created (private)', longcatRes.status === 201 && !!longcat, `${longcatRes.status}`);

  if (!beam || !longcat) throw new Error('could not create the agent offers');

  const beamPurposes = await setPurposes(fx.providerToken, beam.id, [
    { key: 'rendering', pricePerHour: 2.4 },
    { key: 'inference', pricePerHour: 2.2 }
  ]);
  check('Beam sells rendering / inference', beamPurposes.status === 200, `${beamPurposes.status}`);

  const longcatPurposes = await setPurposes(fx.providerToken, longcat.id, [
    { key: 'training', pricePerHour: 3.6 },
    { key: 'research', pricePerHour: 3.0 }
  ]);
  check('LongCat sells training / research', longcatPurposes.status === 200, `${longcatPurposes.status}`);

  // ── 1. Beam / rendering — a real GPU render with a PNG artifact ───────────
  await scenario({
    name: 'Beam Agent/rendering',
    listing: beam,
    jobBody: { kind: 'render.mandelbrot', params: { width: 320, height: 240, iterations: 60 } },
    expect: { purpose: 'rendering', artifact: true }
  }, ids);

  // ── 2. LongCat / training — GPU compute, verified against a CPU reference ─
  await scenario({
    name: 'LongCat Agent/training',
    listing: longcat,
    jobBody: { kind: 'compute.matmul', params: { size: 1024, repeats: 3 } },
    expect: { purpose: 'training', verified: true }
  }, ids);

  // ── 3. The allowlist holds across purposes ───────────────────────────────
  await ensureWallet(fx.renterId, 0);
  const guard = await call('POST', '/rentals', {
    token: fx.renterToken,
    body: { listingId: beam.id, plannedDurationMinutes: 30, purpose: 'inference' }
  });
  if (guard.status === 201) {
    await ensureWallet(fx.renterId, 5);
    await call('POST', `/rentals/${guard.body.rental.id}/start`, { token: fx.renterToken, body: {} });
    const wrong = await call('POST', `/rentals/${guard.body.rental.id}/job`, {
      token: fx.renterToken,
      body: { kind: 'render.mandelbrot', params: { width: 128, height: 128 } }
    });
    check(
      'an inference session cannot run a rendering job',
      wrong.status === 400 && wrong.body && wrong.body.code === 'job_kind_not_allowed',
      `${wrong.status} ${JSON.stringify(wrong.body).slice(0, 120)}`
    );

    const stranger = await call('POST', `/rentals/${guard.body.rental.id}/job`, {
      token: fx.providerToken,
      body: { kind: 'compute.matmul' }
    });
    check(
      'the provider cannot submit work on the renter\'s behalf',
      stranger.status === 403,
      `${stranger.status}`
    );

    await call('POST', `/rentals/${guard.body.rental.id}/end`, { token: fx.renterToken, body: {} });
  } else {
    check('inference rental for the allowlist check', false, `${guard.status}`);
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('ERR', error.stack || error.message);
  process.exit(1);
});
