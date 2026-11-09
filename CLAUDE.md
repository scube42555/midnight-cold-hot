# CLAUDE.md

Guidance for working on this project. `README.md` is the user-facing manual and the record of what has been tested; read it
before changing behaviour. This file covers how the code is organised, the rules that must not be broken, and what has
already been learned the hard way.

## What this is

Scripts for sending **unshielded** NIGHT (or another unshielded token) from a wallet whose seed lives only on an **offline
"cold" machine**, using an **online "hot" machine** only to sync, pay the fee, and submit. Built on the Midnight Wallet SDK
(`@midnightntwrk/wallet-sdk` 1.2.0), TypeScript, Node 22, ES modules.

The flow: the hot machine watches the cold address using its **public key only** and saves a snapshot of its coins. The
snapshot goes to the cold machine, which builds, signs and finalizes the transfer **itself, offline** (`payFees: false`),
and writes `tx.hex`. A separate **sponsor wallet** on the hot machine adds DUST for the fee and submits. Data crosses the
air gap by USB or by QR codes (frames shown on one screen, read by the other machine's camera).

Not supported, and not a bug: **shielded transfers**. A shielded wallet cannot be watched without its secret keys, so it
cannot be split this way. Do not add shielded support without a design that keeps those keys off the hot machine.

## Layout

| Path | Role |
|---|---|
| `src/config.ts` | Network selection (`MIDNIGHT_NETWORK`), endpoints, wallet config. **First import must stay `./redact.js`.** |
| `src/keys.ts` | Reads secrets from the environment, derives keys. Per-role variables: `COLD_*`, `SPONSOR_*`. |
| `src/cold-export-public.ts` | Cold: writes `cold-public.json` (public key fields only). |
| `src/hot-watch.ts` | Hot: watch-only unshielded wallet, writes the snapshot. No secrets involved. |
| `src/cold-transfer.ts` | Cold, offline: builds, signs, finalizes, writes `tx.hex`. Stubs for proving, submission, pending service. |
| `src/sponsor-register.ts` | Hot: one-time DUST registration for the sponsor wallet. |
| `src/sponsor-submit.ts` | Hot: shows the plan and fee, asks for `SUBMIT`, adds DUST, submits. |
| `src/wallet.ts` | Sponsor wallet helpers (hot only). Never import it from a cold script. |
| `src/snapshot.ts`, `crosscheck.ts`, `txinfo.ts`, `timefmt.ts`, `redact.ts`, `hex.ts`, `mqr.ts`, `qr-render.ts` | **Pure modules, no SDK imports.** Keep them that way: it is what makes them testable without the SDK. |
| `src/qr-send.ts`, `qr-decode.ts` | QR transfer: send a file as frames, rebuild it from received frames. |
| `receiver/receiver.template.html` | Browser QR receiver. `npm run build` inlines jsQR into `dist/receiver.html`. |
| `tools/qr_scan.py` | Python/OpenCV QR scanner for machines (Tails) whose browser cannot use the camera. |
| `scripts/build-receiver.mjs` | Build-time only. Never needed on the cold machine. |

## Commands

```bash
npm ci                    # exact versions from the lockfile
npm run build             # tsc, then dist/receiver.html. THE SCRIPTS RUN FROM dist/, NOT src/
npm run cold:export-public | hot:watch | cold:transfer | hot:sponsor-register | hot:sponsor-submit | keygen
node dist/qr-send.js <kind> <file> [--html out.html] [--mqr out.mqr] [--term] [--chunk N]
node dist/qr-decode.js <input.mqr> <output file>
```

After editing anything in `src/`, run `npm run build` before running a script. A stale `dist/` is the most common cause of
"my change did nothing".

Configuration is by environment variable: `MIDNIGHT_NETWORK` (`undeployed|preview|preprod|mainnet`, default `preprod`),
`BLOCKFROST_PROJECT_ID` (preprod and mainnet), `ALLOW_MAINNET=1`, `PROOF_SERVER_URL`, `INDEXER_HTTP_URL`, `INDEXER_WS_URL`,
`NODE_URL`, `COLD_PUBLIC_FILE`, `SNAPSHOT_FILE`, `TTL_MINUTES`, `WATCH_TIMEOUT_MINUTES`, `NO_BEEP`, `BEEP_CMD`, and the secrets
`COLD_MNEMONIC`, `COLD_PASSPHRASE`, `COLD_SEED`, `SPONSOR_MNEMONIC`, `SPONSOR_PASSPHRASE`, `SPONSOR_SEED`.

## Rules that must not be broken

**Secrets**
- Never print, log, write to a file, or commit a seed, mnemonic, passphrase, secret key, or Blockfrost token. Secrets come
  from the environment and are deleted from `process.env` after reading; seed buffers are zeroed (`seed.fill(0)`).
- Never ask for, accept, or paste a real recovery phrase while working on this code. Use throwaway wallets from `npm run keygen`
  on a test network. A phrase that has touched an online machine must never hold real funds.
- `src/redact.ts` hooks `stdout`/`stderr` to remove `project_id=...` and the token from all output, including lines the SDK's
  own libraries print. Keep `import './redact.js'` as the first import of `config.ts`, and do not print endpoint URLs.

**The cold machine is offline and holds the seed**
- `cold-transfer.ts` must never contact the network: it replaces the proving, submission and pending-transaction services with
  stubs, uses `coldEndpoints()` (unreachable placeholders), and **never calls `facade.start()`**.
- Cold scripts must not import `wallet.ts` or anything that needs a live indexer or node.
- Production dependencies are copied to the cold machine, and everything in `node_modules` can read the seed. Add
  dependencies only when necessary, pin exact versions, and prefer zero-dependency, pure-JS packages. Avoid adding native
  add-ons on the cold side. `find node_modules -name '*.node'` currently lists the optional prebuilt `msgpackr-extract` files;
  whether to keep them is the owner's decision (excluding them with `npm ci --omit=optional` is untested), so do not change it
  silently.
- The hot machine must never receive the cold seed, passphrase, or any secret key. It gets only `cold-public.json` and sends
  nothing secret back.

**Anything that crosses the air gap is untrusted input**
- Validate before parsing: `tx.hex` must be plain hex; snapshots go through `inspectSnapshot`; QR frames match a strict
  regex, all frames must share one session, the SHA-256 must match, and decompression has a hard size cap.
- Network and wallet cross-checks are deliberate; do not weaken them. `cold-transfer` refuses a snapshot for another network
  or address, or one holding less than the amount. Hot scripts stop early if `cold-public.json` names another network.
  Mainnet needs `ALLOW_MAINNET=1` and these scripts are untested there.
- The amount for `cold-transfer` is digits only, in the smallest unit (1 NIGHT = 1,000,000 STAR). No commas, no decimals.

## Things already learned (do not rediscover)

- `signRecipe`'s callback is **synchronous** (`(data: Uint8Array) => Signature`). Signing cannot be delegated to a remote
  machine through this API, which is why the cold machine builds and signs the whole transaction itself.
- `finalizeRecipe` always calls `provingService.prove`. An unshielded transfer with `payFees: false` needs no proofs, so the
  cold stub passes a provider that rejects if asked; "stub not called" is the expected result.
- The unshielded wallet can start from a public key alone (`startWithPublicKey`) and restore from a snapshot. `WalletFacade`
  cannot be watch-only: it needs all three wallets and `start(shieldedSecretKeys, dustSecretKey)`.
- A snapshot is JSON: `publicKey{publicKey,addressHex,address}`, `state{availableUtxos,pendingUtxos}`, `protocolVersion`,
  `appliedId`, `networkId`. It holds no secrets. It is a photo of the coins at one moment: **stale after any spend**, so take a
  fresh one before every transfer. A wallet can report "synced" with zero coins at the very start; `hot-watch` waits for coins.
- **Midnight-hosted Preprod and mainnet endpoints were retired (Sep and Oct 2026).** Preprod and mainnet go through Blockfrost
  (`BLOCKFROST_PROJECT_ID`, prefixes `nightpreprod` / `nightmainnet`). `preview` is Midnight-hosted. Blockfrost "fully synced"
  can lag a few minutes on an idle subscription, and WebSocket `CloseEvent` errors during sync are reconnected automatically.
- **DUST fee.** The sponsor's balancing transaction declares `additionalFeeOverhead` (0.3 DUST, `ADDITIONAL_FEE_OVERHEAD`) plus
  the ledger's price. A DUST spend has no refund, so the sponsor pays all of it. Block explorers show only the price (1 SPECK),
  never the overhead. 1 DUST = 10^15 SPECK. A full wallet regenerates the fee in seconds, so its balance may not visibly move.
  `sponsor-submit` balances **before** asking for confirmation so the fee is known; a "no" calls `wallet.revert`.
- The plan shown by `sponsor-submit` puts the recipient output in a "fallible" part of the transaction: the SDK's default,
  not a problem. Change always returns to the sender; there is no change-address option.
- A BIP-39 passphrase ("25th word") is supported via `COLD_PASSPHRASE`/`SPONSOR_PASSPHRASE`. A wrong passphrase silently gives
  a different, empty wallet, so the address must be compared before funding.
- **QR frame format `MQR1`** exists in three implementations that must agree: `src/mqr.ts`, the receiver page, and
  `tools/qr_scan.py` (same regex, same `MAX_FRAMES = 9999`, because index and total are at most four digits). Change all three
  together. Frames need a full sender pass per missed frame; large transfers should be split.
- On Tails the browser would not give `receiver.html` camera access; use `tools/qr_scan.py` there. Its OpenCV and NumPy wheels
  must match Tails' Python version (`pip download ... --python-version` with a matching ABI tag), OpenCV pinned `>=4.8,<5`.
- Wrong-network and wrong-wallet mistakes are the easiest to make. Every script prints `Network: ...` first; keep that.

## Conventions

- TypeScript strict, ES modules with `NodeNext`: relative imports need the `.js` extension.
- Comments say **why**, not what. Error messages say what to do next.
- Scripts that handle money show the user what will happen and require an explicit typed confirmation (`SEND`, `SUBMIT`).
- New behaviour gets an entry in `README.md`: the test table (section 4), "Verified and still unverified" (section 6), and any
  new environment variable. Mark things **verified only if someone ran them on a real network**; code that passed tests against
  fake data is "not yet run".
- The cold bundle is built from `dist/`, production `node_modules`, `package.json` and the README (README section 5). Files
  needed only to build (`src/`, `scripts/`, `receiver/`, dev dependencies) do not go to the cold machine.

## Testing

There is **no test runner in this repository yet**. Tests so far were run ad hoc outside it, against fake transactions and a
real snapshot, and cover the pure modules: frame format and hostile frames (`mqr`), snapshot and `cold-public.json` checks,
transaction reading and the plan layout (`txinfo`), time formatting, redaction, and passphrase entry. The Python scanner was
tested with OpenCV on generated, degraded QR images and a simulated camera. The SDK-dependent scripts (`cold-transfer`,
`hot-watch`, `sponsor-*`) are checked by `tsc` and by the manual test plan in `README.md`; there is no way to run them
without the SDK and a network. If you add tests, put them in `tests/`, keep them SDK-free, and add a `test` npm script.

Typecheck with `npx tsc --noEmit`. Never "verify" a script by running it with a real seed.

## Midnight references

- Wallet SDK: https://docs.midnight.network/sdks/official/wallet-developer-guide and `.../build-a-wallet`
- Node.js wallet: https://docs.midnight.network/guides/node-server-wallet
- DUST: `.../guides/dust-sponsorship` and `.../guides/manage-dust` (fee formula: sum of `vFee` over DUST spends)
- Networks and endpoints: `.../guides/networks-and-environments`
- Proof server: `.../guides/local-proving` (always run it locally; it sees secret keys inside proof requests)
- Ledger API (intents, unshielded offers): `.../api-reference/ledger/`

Documentation changes; when a claim about the SDK matters, re-read the page instead of trusting this file.
