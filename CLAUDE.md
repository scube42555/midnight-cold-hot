# CLAUDE.md

New session? Read `HANDOVER.md` first (current state, next steps). `README.md` is the user manual and the record of what has been tested.
`MIGRATION-LEDGER9.md` has the SDK 2 findings; read only the sections you need.

## What this is

Scripts that send **unshielded** NIGHT (or another unshielded token) from a wallet whose seed lives only on an **offline "cold" machine**. An **online "hot"
machine** syncs, pays the fee and submits. Midnight wallet SDK **2.0.0** (ledger 9), TypeScript, Node 22, ES modules.

Flow: the hot machine watches the cold address with its **public key only** (`hot-watch`) and writes a snapshot of its coins. The cold machine restores it, builds,
signs and finalizes the transfer **itself, offline** (`payFees: false`) and writes `tx.hex` (`cold-transfer`). A separate **sponsor wallet** adds DUST and submits
(`sponsor-submit`). Files cross the air gap by USB or QR codes. **Shielded transfers are out of scope**: a shielded wallet cannot be watched without its secret
keys. Do not add them without a design that keeps those keys off the hot machine.

## Layout

| Path | Role |
|---|---|
| `src/config.ts` | Network (`MIDNIGHT_NETWORK`), endpoints, wallet config, the chain-version probe. **Its first import must stay `./redact.js`.** |
| `src/keys.ts` | Reads secrets from the environment, derives `WalletSeeds` and the keystore (`deriveAndWipe`). Roles: `COLD_*`, `SPONSOR_*`. |
| `src/cold-export-public.ts`, `cold-transfer.ts`, `probe-cold-era.ts` | Cold machine. `cold-transfer` is offline: stub prover and submission, wallets start from seeds. |
| `src/hot-watch.ts`, `sponsor-register.ts`, `sponsor-submit.ts`, `wallet.ts` | Hot machine. `wallet.ts` (sponsor) must never be imported by a cold script. |
| `src/snapshot.ts`, `txinfo.ts`, `crosscheck.ts`, `timefmt.ts`, `redact.ts`, `hex.ts`, `mqr.ts`, `qr-render.ts` | **Pure modules, no SDK imports.** Keep them that way: it is what makes them testable here. |
| `src/qr-send.ts`, `qr-decode.ts`, `receiver/`, `tools/qr_scan.py` | QR transfer. `scripts/build-receiver.mjs` is build-time only. |
| `.githooks/pre-commit`, `.gitignore`, `.gitmessage`, `CONTRIBUTING.md` | Keep secrets and wallet data out of commits. |

## Commands

`npm ci`, then `npm run build` (tsc and `dist/receiver.html`). **Scripts run from `dist/`, not `src/`:** rebuild after every edit. Typecheck with `npx tsc --noEmit`.
Run scripts with `node dist/<name>.js` or the npm scripts (`cold:export-public`, `hot:watch`, `cold:transfer`, `hot:sponsor-register`, `hot:sponsor-submit`, `probe:cold-era`).
**npm swallows flags:** write `npm run <script> -- --dry-run`. Env: `MIDNIGHT_NETWORK` (default `preprod`), `BLOCKFROST_PROJECT_ID`, `PROOF_SERVER_URL`,
`COLD_MNEMONIC`/`COLD_PASSPHRASE`, `SPONSOR_MNEMONIC`/`SPONSOR_PASSPHRASE`, plus `ASSUME_LEDGER9`, `TTL_MINUTES`, `SNAPSHOT_FILE`, `COLD_PUBLIC_FILE`,
`ALLOW_MAINNET` and others listed in the README.

## Rules that must not be broken

**Secrets.** Never print, log, write or commit a seed, phrase, passphrase, secret key or Blockfrost token. Secrets come from the environment, are deleted from
`process.env` after reading, and the master seed is wiped (`deriveAndWipe`). `redact.ts` strips `project_id=` and the token from all output, including the SDK's own
log lines; do not print endpoint URLs. **Never ask for, accept or run anything with a real recovery phrase.** Use throwaway wallets (`npm run keygen`) on a test
network; the owner runs secret-bearing steps in their own terminal.

**The cold machine is offline and holds the seed.**
- `cold-transfer` must never succeed in reaching a network: every endpoint is an unreachable placeholder, submission is a stub that rejects, and the prover stub
  rejects. Its `facade.start(seeds)` is required by SDK 2 and starts a sync that fails; the `Wallet.Sync` / `API-WS` error lines are expected and harmless.
- Cold scripts must not import `wallet.ts` or need an indexer or node. The hot machine never receives the cold seed, passphrase or any secret key.
- Production dependencies are copied to the cold machine and can read the seed. Add few, pin exact versions, prefer zero-dependency pure JS, avoid native add-ons.
  `msgpackr-extract` native files currently ship; whether to drop them is the owner's decision (`--omit=optional` is untested).

**Everything crossing the air gap is untrusted input.** Validate before parsing: `tx.hex` plain hex; snapshots via `inspectSnapshot`; QR frames strict regex, one
session, SHA-256 check, decompression cap. Do not weaken the cross-checks: `cold-transfer` refuses a snapshot for another network or address, one holding less than
the amount, or one with **protocol version below 2000000** (`assertLedger9`), and stops unless the facade is `Settled` on ledger 9 (a ledger 8 transaction is refused
by the network); hot scripts stop if `cold-public.json` names another network. The amount is digits only, smallest unit (1 NIGHT = 1,000,000 STAR). Mainnet needs
`ALLOW_MAINNET=1` and is untested.

## SDK 2 / ledger 9: what is known

- Wallets and the facade start from seeds (`WalletSeeds.fromMasterSeed`); transaction methods take no secret keys; signers are async (`keystore.signDataAsync`).
  Transactions are `WalletTransaction` handles: `serialize()` gives the bytes for `tx.hex`, `facade.adoptTransaction(bytes, 'Finalized')` reads them back and refuses
  the other ledger's bytes. The inner ledger transaction is hidden: decode the bytes with `@midnightntwrk/wallet-sdk/ledger/v9` to display it.
- **Chain-version probe** (`assumeLedger9`, on by default): without it a wallet stays on the ledger 8 variant (offline facade settled at protocol version 0; a snapshot
  came out `written by v1` at 1000300). **Only for wallets with nothing to sync: the cold machine and the unshielded wallet** (its events are JSON). **Never on a shielded or
  DUST wallet that syncs from genesis**: it fails on the ledger 8 history with "Could not deserialize ledger event". The sponsor sets `assumeLedger9: false` for the facade
  and gives it to the unshielded wallet only. `forks.v9 = MinSupportedVersion` is refused by the SDK. Snapshots must come from `hot-watch` of this version (`written by v2`).
- Ledger 9's proving provider has three methods (`prove`, `check`, `lookupKey`). An unshielded transfer needs no proof: the cold stub is never called.
- `hot-watch` and the sponsor's first sync start from scratch and can take over an hour; state is saved right after the sync, so later runs resume. A snapshot goes stale
  after any spend: take a fresh one before every transfer.
- **DUST fee.** The sponsor declares the ledger price plus `ADDITIONAL_FEE_OVERHEAD` (0.3 DUST) and gets nothing back. Explorers show only the price (1 SPECK). A full wallet
  refills in seconds, so its balance may not visibly move. `sponsor-submit` shows an SDK **estimate** before the prompt, balances only after `SUBMIT`, then reads the declared
  fee from the final bytes. Change always returns to the sender (no change-address option); the recipient output sits in a "fallible" part by default.
- Preprod and mainnet go through Blockfrost; Midnight-hosted endpoints there were retired. Run the proof server locally (9.0.0); it sees secret keys inside proof requests.
- Use `read -rs` for secrets, one step at a time. A wrong passphrase silently gives a different empty wallet: compare the address before funding.
- **QR frame format `MQR1`** exists three times and must agree (`mqr.ts`, the receiver page, `qr_scan.py`; same regex, `MAX_FRAMES = 9999`). On Tails the browser cannot use
  the camera; use `tools/qr_scan.py` (OpenCV `>=4.8,<5`, wheels matching Tails' Python).
- Do not guess SDK 2 signatures silently: read `node_modules/@midnightntwrk/*/dist/*.d.ts` or ask the owner, and mark unavoidable assumptions `SDK2-UNVERIFIED`
  (`grep -rn SDK2-UNVERIFIED src`). Do not call anything working on ledger 9 unless README section 4 shows it passed on Preprod; entries marked SDK 1.2 are history.

## Conventions

- TypeScript strict, `NodeNext`: relative imports need `.js`. Comments say why, not what; error messages say what to do next.
- Scripts that move money show what will happen and require a typed confirmation (`SEND`, `SUBMIT`). Every script shows `Network:` before it acts (`cold-transfer` on its review screen); keep that.
- New behaviour gets a README entry: the test table (section 4), "Verified and still unverified" (section 6), new environment variables. **Verified means run on a real
  network**; code that passed tests on fake data is "not yet run".
- The cold bundle is `dist/`, production `node_modules`, `package.json` and the README (README section 5). Build-only files do not go to the cold machine.

## Version control (full rules in `CONTRIBUTING.md`)

- **Do not commit, push, tag or rewrite history unless asked.** Stage named files, never `git add -A`; read `git status` first. Wallet data (`*.snapshot.json`, `tx.hex`,
  `cold-public.json`, `wallet-state-*.json`, `.env`, `*.mqr`, `received-*`) is never staged and its `.gitignore` entries never loosened.
- **Never bypass `.githooks/pre-commit`** (`--no-verify`, or `allow-secret` to force a commit through). If it blocks, stop and tell the owner what it flagged.
- Commits: `type(scope): summary` plus honest trailers `Verified:` (`not run`, `tsc only`, `unit tests`, `preprod T3-T5`) and `Touches-cold: yes|no`. Cold-side files:
  `cold-*`, `keygen`, `qr-send`, `qr-decode`, `config`, `keys`, `hex`, `mqr`, `qr-render`, `redact`, `snapshot`, `tools/qr_scan.py`, and the production dependencies.
  Dependency changes get their own `build(deps)` commit with the lockfile.

## Testing

There is **no test runner in the repository yet**. The pure modules were tested ad hoc outside it (fake transactions plus real snapshots); the SDK-dependent scripts are
checked by `tsc` and the manual plan in `README.md`. If you add tests, put them in `tests/`, keep them SDK-free, and add an `npm test` script. Never verify a script by
running it with a real seed.

## Midnight docs

`docs.midnight.network`: `sdks/official/wallet-developer-guide`, `guides/node-server-wallet` (still shows ledger 8 code), `guides/manage-dust`, `guides/dust-sponsorship`,
`guides/networks-and-environments`, `guides/local-proving`, `relnotes/ledger-9`, `api-reference/ledger/`. Re-read a page when a claim about the SDK matters.
