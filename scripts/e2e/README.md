# Money E2E scenarios (local only)

Unit tests prove the code does what it says; these scripts prove the **money
moved correctly** through the real API and the real database. They are the
evidence behind the escrow and settlement decisions, and they should be run
after any change that touches money.

| script | what it proves |
|---|---|
| `escrow.js` | 410 on the retired free tier · 402 when the wallet is short · the full quote is charged at start (escrow) · unused time is refunded at end · the provider gets the actual cost **in full** (no `platform_fee` row) · a provider cannot end a session at will (400) and the renter is compensated when they do |
| `resettle.js` | a session that "crashed" mid-settlement (row closed, no money steps) is repaired **exactly once**, even when three callers race; a second sweep moves nothing |
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
   node scripts/e2e/purge.js      # always clean up afterwards
   ```

Exit code is `0` only when every check passed.

## Rules

- **Never point these at production.** They create accounts and move real
  ledger rows in whatever database `server/.env` points at.
- Fixtures live on `@veloxora-test.dev` and their listing is private, so they
  never appear in the public catalog — but a leftover fixture is still noise,
  so run `purge.js`.
- `E2E_BASE` overrides the API origin (default `http://127.0.0.1:5000/api`).
