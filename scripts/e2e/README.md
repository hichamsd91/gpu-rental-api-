# Money E2E scenarios (local only)

Unit tests prove the code does what it says; these scripts prove the **money
moved correctly** through the real API and the real database. They are the
evidence behind the escrow and settlement decisions, and they should be run
after any change that touches money.

| script | what it proves |
|---|---|
| `escrow.js` | 410 on the retired free tier · 402 when the wallet is short · the full quote is charged at start (escrow) · unused time is refunded at end · the provider gets the actual cost **in full** (no `platform_fee` row) · a provider cannot end a session at will (400) and the renter is compensated when they do |
| `resettle.js` | a session that "crashed" mid-settlement (row closed, no money steps) is repaired **exactly once**, even when three callers race; a second sweep moves nothing |
| `purposes.js` | every rental purpose end-to-end: a per-purpose price is the quote and the settlement rate (Beam: rendering / inference / mining · LongCat: training / research) · batch interruptions pay **2× the remaining time** while interactive ones pay **10% of the planned value** · mining is opt-in on both sides (deployment flag, listing purpose, renter acknowledgement) and stays off when the flag is off |
| `agent.js` | **delivery**, not just the contract: submits an allowlisted job for a paid session and runs the real `worker-agent` on this machine's GPU — Beam/rendering produces a PNG artifact and LongCat/training verifies a matmul against a CPU reference · checks the job reached `succeeded` with progress 100, heartbeat telemetry landed, a session that ended under the GPU cancels the work, and settlement still pays the provider in full · **49 checks** including artifact integrity: the server re-hashes and signs the bytes, the signed link returns them byte-for-byte with `attachment` headers, and a forged signature is refused (401) |
| `purge.js` | deletes the fixtures and everything they own — listings, devices, rentals, ledger rows, wallets, profiles |

## How to run

1. Start the local API **with the enforcer slowed down**, otherwise the
   background sweep races `resettle.js`:

   ```powershell
   # from server/
   $env:RENTAL_ENFORCER_INTERVAL_SEC='3600'; node src/server.js
   ```

2. In a second shell, from `server/`:

   ```powershell
   node scripts/e2e/escrow.js     # also writes .fixtures.json
   node scripts/e2e/resettle.js   # reuses (or creates) the fixtures
   node scripts/e2e/purposes.js   # every purpose + its own price and compensation
   node scripts/e2e/agent.js      # worker agent executes real GPU jobs (needs pyopencl + a GPU)
   node scripts/e2e/purge.js      # always clean up afterwards
   ```

Exit code is `0` only when every check passed.

## Rules

- These scripts move real ledger rows in whatever database `server/.env` points
  at. Run them against production only with the owner's explicit go-ahead, and
  always finish with `purge.js`.
- `purposes.js` flips the `mining.allowed` feature flag on for ~30 seconds to
  test a mining window, and **restores it in a `finally` block** — if a run is
  killed mid-test, check the flag in the dashboard.
- Fixtures live on `@veloxora-test.dev` and their listings are private, so they
  never appear in the public catalog — but a leftover fixture is still noise,
  so run `purge.js`.
- `agent.js` needs Python with `pyopencl` and a visible GPU; it runs the real
  `worker-agent` from the repository root (`../worker-agent`).
- `E2E_BASE` overrides the API origin (default `http://127.0.0.1:5000/api`).
