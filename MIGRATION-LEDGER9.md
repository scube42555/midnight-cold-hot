# Migrating to ledger 9 (wallet SDK 2.0.0)

**Status: this project is not usable on Preprod until it is migrated.** It targets wallet SDK 1.2.0 and builds ledger 8
transactions. Preprod runs ledger 9 since 9 November 2026 (block 3,348,434), and the docs say a wallet on SDK 1.x cannot
transact after the upgrade. Everything marked "verified" in `README.md` was verified on SDK 1.2.0 and ledger 8, **before**
the upgrade. Nothing here has been tried against SDK 2.

Sources, all read on 9 November 2026:
[Ledger 9 upgrade](https://docs.midnight.network/relnotes/ledger-9),
[Wallet SDK 2.0.0 release notes](https://docs.midnight.network/relnotes/wallet/wallet-sdk-2-0-0),
and the [Node.js wallet guide](https://docs.midnight.network/guides/node-server-wallet), which still shows ledger 8 code and
says so. The detailed migration guide is in the `wallet-sdk-facade` 5.0.0 release notes on GitHub, which I could not read.

One search result still showed an older copy of the SDK 2.0.0 page saying "for Preprod, keep using wallet SDK 1.2.0".
The live pages (updated 9 November) say Preprod needs 2.0.0. Confirm against the live page before relying on either.

## What the docs say changed

| Change | Source |
|---|---|
| Preprod upgraded in place to ledger 9 on 9 Nov 2026; the network ID stays `preprod`; endpoints unchanged | Ledger 9 page |
| Wallet SDK **2.0.0** is required (facade 5.0.0, shielded 4.0.0, unshielded-wallet 4.0.0, dust-wallet 5.0.0). Indexer 4.4.101, proof server **9.0.0**, node 2.1.101 | Ledger 9 page, SDK notes |
| A transaction built in the ledger 8 format and not yet included at the upgrade cannot be decoded; rebuild it | Ledger 9 page |
| The upgrade cleared DUST registrations on Preprod that are not backed by cNIGHT, so Preprod wallets must **register for DUST again** (nothing is lost: DUST is credited from when the NIGHT was created, up to the cap) | Ledger 9 page |
| `facade.start(WalletSeeds.fromMasterSeed(masterSeed))` replaces `facade.start(shieldedSecretKeys, dustSecretKey)` | SDK notes |
| Transaction-building methods no longer take a `secretKeys` argument | SDK notes |
| Transactions are `WalletTransaction` handles that carry their protocol version; a mismatch throws `ProtocolVersionMismatchError`. Read bytes with `adoptTransaction`; ledger objects come from `@midnightntwrk/wallet-sdk/ledger/v8` or `/ledger/v9` | SDK notes, facade release |
| Signers are **asynchronous** (`SignSegment`), and keys and signatures are tagged `{ tag, value }` objects | SDK notes |
| `FacadeState.lifecycle` and `facade.transactionLifecycleService` replace `FacadeState.pending` and the pending-transactions service | SDK notes |
| `startWithPublicKey` (unshielded) and `startWithSeed` return a **Promise**; shielded `startWithSecretKeys` and dust `startWithSecretKey` are replaced by `startWithKeys({ v8, v9 })` | wallet-sdk 2.0.0 release |
| A stopped facade drops its key material; transacting after `stop()` fails with `MissingStartAuxError` | facade 5.0.0 release |
| `waitForSyncedState()` also waits for an indexer-liveness check against a node's finalized head | SDK notes |
| An unreadable snapshot is refused with `SnapshotRestoreError` | facade release candidates |
| New fee floor `min_block_price` = 10, so fees rise slightly; do not hard-code fee amounts | Ledger 9 page |
| Provers are configured per ledger version: `provers: { v8?, v9 }` or one `provingServerUrl` for both | SDK notes |
| `ledger-v8` now comes from `@midnightntwrk/ledger-v8` (new scope); the wallet rejects objects from `@midnight-ntwrk/ledger-v8` | SDK notes |
| Midnight.js 5 removes `setNetworkId()` (it needs `providers.config: { networkId, ttlSeconds }`) | Ledger 9 page |
| Known network issue: a fee paid with exactly **one** DUST spend can be rejected (`OutsideTimeToDismiss`) in contract calls; no fix yet | Ledger 9 page |

## Do these now, before any code

1. **Stop using the current scripts against Preprod.** They will fail, and a failed run can leave state behind.
2. **Treat everything built before the upgrade as dead:** any `tx.hex` that was not submitted, `cold-unshielded.snapshot.json`
   files, and `wallet-state-*.json` files. Delete the wallet state: it was written by SDK 1.x against a ledger 8 chain.
3. **The cold bundle on your Tails machine is obsolete** for Preprod. It will need rebuilding, a new sha256 on paper, and a new tag.
4. **The sponsor's DUST is gone** until it registers again (its tNIGHT is not backed by cNIGHT). Registration will run through the
   migrated `sponsor-register`.
5. **Update the local proof server to 9.0.0** (your sponsor's DUST proofs go through it). The README and the earlier notes name 8.1.3.
6. Mainnet is untouched: these scripts were never run there and still refuse without `ALLOW_MAINNET=1`.

## What each file needs

Known means the docs state it. Unknown means I need the SDK 2 type signatures first (next section).

| File | Needed change | Confidence |
|---|---|---|
| `package.json` | `@midnightntwrk/wallet-sdk` 2.0.0. Drop `@midnight-ntwrk/midnight-js-network-id` and `-protocol` if nothing needs them; ledger objects now come from `@midnightntwrk/wallet-sdk/ledger/v9`. Keep `@scure/bip39`, `rxjs`, `qrcode-generator`. Pin exact versions, and check `npm ls --omit=dev` for new native add-ons | Known |
| `config.ts` | `setNetworkId` and `getNetworkId` come from a package whose role changes (Midnight.js 5 removes `setNetworkId`). The network ID must be passed explicitly into the wallet config, the keystore and every address codec. Add `provers` or `provingServerUrl` for the per-version provers | Partly |
| `keys.ts` | Derive three seeds and `WalletSeeds` instead of three key objects. `createKeystore` and the keystore API may now return tagged `{ tag, value }` keys and signatures. Keep passphrase handling and the env-deletion behaviour | Unknown |
| `wallet.ts` (sponsor) | `startWithKeys({ v8, v9 })`, awaited `startWithPublicKey`, `facade.start(seeds)`, `transactionLifecycleService` instead of the pending service, async signers, `submitTransaction` types | Partly |
| `cold-transfer.ts` | Replace `startWithSecretKeys`/`startWithSecretKey`; the cold stubs (`pendingTransactionsService`, proving, submission) change shape; signing is async; `finalized.serialize()` becomes whatever serializes a `WalletTransaction`. **See the design risk below** | Unknown |
| `cold-export-public.ts`, `hot-watch.ts` | The public key may now be a tagged object, not a string. Its "must be plain strings" check will fail loudly if so, then the export format and the rebuild of `PublicKey` change. `startWithPublicKey` is awaited | Unknown |
| `sponsor-submit.ts`, `sponsor-register.ts` | Read the transaction with `adoptTransaction` instead of `ledger.Transaction.deserialize`; async signers; no `secretKeys` in `balanceFinalizedTransaction`; `registerNightUtxosForDustGeneration` signing callback | Unknown |
| `snapshot.ts` | The unshielded snapshot format may have changed (`protocolVersion`, optional new members). The strict validation can reject a new snapshot, and a post-upgrade snapshot will carry a ledger 9 protocol version. Inspect a real SDK 2 snapshot before changing it | Unknown |
| `txinfo.ts` | Reads `tx.intents` from a ledger transaction. It must be given the inner ledger transaction of a `WalletTransaction` | Unknown |
| `mqr.ts`, `qr-*`, `tools/qr_scan.py`, `receiver`, `hex.ts`, `redact.ts`, `crosscheck.ts`, `timefmt.ts`, `beep.ts` | No change expected: they move bytes and text and do not touch the SDK | Known |
| `README.md`, `CLAUDE.md`, `CONTRIBUTING.md` | Reset "verified" to the SDK 1.2.0 / ledger 8 era, update versions (proof server 9.0.0, SDK 2.0.0), fee text (floor 10), the preview faucet link (the ledger 9 page gives https://faucet.preview.midnight.network/), and the cold bundle steps | Known |

## The biggest design risk: the cold machine and `start()`

The cold design relies on never calling `facade.start()`, because that begins background sync, and the cold machine has no
network. In SDK 1.2 you could build and sign a transfer without it, passing the secret keys to `transferTransaction`.

In SDK 2 **no transaction-building method takes secret keys**, and a facade whose key material was dropped fails with
`MissingStartAuxError`. That suggests the key material must be supplied at start, which would mean calling `start` (and
beginning a sync that cannot reach an indexer) on the cold machine. Possible outcomes:

- `start` offers an option to skip sync (a new export named `FacadeStartOptions` exists; I do not know what it holds). Best case.
- `start` begins sync, the connection errors are only logged and retried (as the `Wallet.Sync: [object CloseEvent]` lines were),
  and `transferTransaction` still works from restored state. Acceptable, but test it with the network off.
- `transferTransaction` waits for sync or for the protocol "Crossing" to settle, and never returns offline. That breaks the
  design. The fallback would be to give the cold side a different shape, and that needs a design discussion with you first.

Resolve this **before** writing the rest. Also unknown: whether a snapshot restore alone puts an offline wallet on ledger 9
("a wallet restored from a snapshot crosses too"), which is what the cold machine needs in order to build ledger 9 transactions.

Async signing is a change in your favour: the old reason the cold machine had to build and sign everything itself (a
synchronous callback) is gone. The current design is still the safer one, and nothing needs to change in its shape for that.

## Stage 1: done in the code, not yet run against SDK 2

Written from the `wallet-sdk-facade` 5.0.0 migration guide (the "Migrating from 4.x" section of its CHANGELOG). Everything that
guide does not spell out is marked `SDK2-UNVERIFIED` in a comment: `grep -rn SDK2-UNVERIFIED src` lists every assumption.

| File | What changed |
|---|---|
| `package.json` | `@midnightntwrk/wallet-sdk` **2.0.0**. `@midnight-ntwrk/midnight-js-network-id` and `-protocol` removed. `cold:transfer` and `hot:sponsor-submit` print a "not migrated" message |
| `tsconfig.json` | `src/cold-transfer.ts` and `src/sponsor-submit.ts` are **excluded from the build** until stage 2 |
| `config.ts` | No `setNetworkId` / `getNetworkId`. `NETWORK_ID` is passed explicitly into the wallet config |
| `keys.ts` | `WalletSeeds.fromMasterSeed` and `createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, networkId)`. New `deriveAndWipe`: wipes the master seed, then checks the address did not change, which catches an SDK that keeps a reference to the buffer instead of copying it |
| `wallet.ts` | `startWithSeed`, awaited `startWithPublicKey`, `facade.start(seeds)`, no dust parameters, no ledger import |
| `cold-export-public.ts` | Writes `{ sdk: 2, network, address, publicKey: <the SDK's whole PublicKey object> }`. It no longer assumes the public key is made of three strings |
| `hot-watch.ts` | Reads that format, refuses an old one (no `"sdk": 2`), and awaits `startWithPublicKey` |
| `sponsor-register.ts` | `deriveAndWipe`, `signDataAsync`, NIGHT token type from `txinfo` |

**Not changed:** `snapshot.ts`, `txinfo.ts`, `crosscheck.ts`, `mqr.ts`, the QR tools and the scanner. They are pure and do not touch the
SDK, but `snapshot.ts` and `txinfo.ts` may need changes once a real SDK 2 snapshot and transaction are seen.

### What was tested here, and what was not

Tested with stand-ins for the SDK (it cannot be installed where this was written): `config.ts` (all four networks, the
token-prefix check, the mainnet guard), the passphrase and seed handling in `keys.ts`, and `deriveAndWipe` against an SDK that
copies the seed and one that keeps a view of it. **Not tested:** anything that calls the real SDK 2. The first
`npm install && npm run build` is the first real type check.

### Run these first, in this order

1. `npm install` and `npm run build`. Send me the compiler errors; they will point at the wrong guesses.
2. **The address check (most important).** With a throwaway phrase you already used on SDK 1.2 (for example the cold wallet
   whose address you know), run `npm run cold:export-public` and compare the address with the old one. If they differ,
   `WalletSeeds.fromMasterSeed` derives a different wallet from the same seed, and funds would be at the old address: stop
   and tell me.
3. `hot-watch` against Preprod with that `cold-public.json`: does `startWithPublicKey` accept the object after the JSON round trip?
4. `sponsor-register` for the sponsor (re-registration is required after the upgrade). Needs the proof server on 9.0.0.

## Stage 2: what is blocking `cold-transfer` and `sponsor-submit`

I need the facade's `InitParams` and the transaction handle types before writing them:

- **`WalletFacade.init` parameters** for the proving, submission and lifecycle services. The cold machine stubs these three,
  and the pending-transactions stub is replaced by `transactionLifecycleService`, whose interface I have not seen.
- **How a finalized transaction becomes bytes and back.** `finalizeRecipe` now returns a `WalletTransaction` handle that carries its
  protocol version. `tx.hex` needs a serialize step on the cold side and `adoptTransaction` (or `WalletTransaction.adopt`) on the hot
  side. Their signatures are unknown.
- **The cold machine's `start()` question** (below). It cannot be answered by reading; it needs a run with the network off.
- **The unshielded snapshot format.** `snapshot.ts` validates a strict shape. A real SDK 2 snapshot shows whether it still fits.

Commands for the second batch (same scratch folder as below):

```bash
cd ~/sdk2-probe/node_modules/@midnightntwrk
grep -rn "InitParams" wallet-sdk-facade/dist --include=*.d.ts | head
grep -rn "provingService\|submissionService\|provers\|transactionLifecycleService" wallet-sdk-facade/dist --include=*.d.ts | head -30
grep -rn "TransactionLifecycleService" wallet-sdk-facade/dist wallet-sdk-capabilities/dist --include=*.d.ts | head -20
grep -rn "adoptTransaction\|WalletTransaction\|activeProtocolVersion" wallet-sdk-facade/dist wallet-sdk-abstractions/dist --include=*.d.ts | head -40
grep -n "finalizeRecipe\|transferTransaction\|balanceFinalizedTransaction\|signRecipe\|submitTransaction\|revert" wallet-sdk-facade/dist/index.d.ts | head -30
grep -rn "FacadeStartOptions\|FacadeStartMaterial\|StartMaterial" wallet-sdk-facade/dist --include=*.d.ts | head
sed -n 1,120p wallet-sdk-unshielded-wallet/CHANGELOG.md
```

If a path does not exist, `ls` the package and adjust. A snapshot from a real SDK 2 `hot-watch` run (stage 1, step 3) answers the
snapshot question, so run that first.

## Setting up the SDK 2 probe folder (done: the facade changelog came from here)

In a scratch folder, install SDK 2 and read what it ships. Do not touch the project or any real seed:

```bash
mkdir ~/sdk2-probe && cd ~/sdk2-probe && npm init -y >/dev/null
npm install --save-exact @midnightntwrk/wallet-sdk@2.0.0
cd node_modules/@midnightntwrk
ls
```

The migration guide is normally the changelog that ships inside each package. Paste these (they may be long; the
"Migrating from 4.x" parts are what I need):

```bash
sed -n 1,200p wallet-sdk-facade/CHANGELOG.md
sed -n 1,120p wallet-sdk-unshielded-wallet/CHANGELOG.md
```

Then the signatures that matter for this project:

```bash
grep -rn "start(\|FacadeStartOptions\|WalletSeeds\|StartMaterial\|startWithKeys" wallet-sdk-facade/dist --include=*.d.ts | head -40
grep -rn "transferTransaction\|balanceFinalizedTransaction\|signRecipe\|finalizeRecipe\|submitTransaction\|revert\|adoptTransaction\|WalletTransaction\|SignSegment" wallet-sdk-facade/dist --include=*.d.ts | head -60
grep -rn "startWithPublicKey\|serializeState\|restore(" wallet-sdk-unshielded-wallet/dist --include=*.d.ts | head -20
grep -rn "createKeystore\|PublicKey\|signData\|getBech32Address" wallet-sdk-unshielded-wallet/dist --include=*.d.ts | head -30
grep -rn "transactionLifecycleService\|TransactionLifecycleService" wallet-sdk-facade/dist --include=*.d.ts | head -20
```

If a path does not exist, `ls` the package and adjust. If you would rather paste the GitHub release notes for
`@midnightntwrk/wallet-sdk-facade@5.0.0` and `@midnightntwrk/wallet-sdk-unshielded-wallet@4.0.0` (section "Migrating from 4.x"), that works too.

## Order of work

1. Settle the cold `start()` question above, in the scratch folder, with a throwaway seed, ideally with the network off.
2. Pin SDK 2.0.0; fix `config.ts`, `keys.ts` and `wallet.ts`; get `npm run build` clean.
3. Hot side first: `hot-watch`, then `sponsor-register`, then `sponsor-submit --dry-run` (needs the proof server on 9.0.0).
4. Cold side: `cold-export-public`, `cold-transfer`, then the snapshot checks.
5. Re-run the README test plan on Preprod, starting with T1 to T5, with throwaway wallets. Mark results as ledger 9 only after they pass.
6. Rebuild the cold bundle, hash it, write the hash on paper, tag it (`CONTRIBUTING.md`).

Make each of these its own commit, with `Verified:` stating what ran, and `Touches-cold: yes` where it applies.
