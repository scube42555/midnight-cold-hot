# Migrating to ledger 9 (wallet SDK 2.0.0)

**Status (10 November 2026):** the code targets wallet SDK 2.0.0. Measured on Preprod: address derivation, `hot-watch`, and an offline facade
settling on ledger 9 (details below). **`cold-transfer` and `sponsor-submit` are written but have never been built or run**, and every result
marked "verified" in `README.md` section 4 for tests T1 to T23 was verified on SDK 1.2.0 and ledger 8, before the upgrade.

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

### First real build (wallet SDK 2.0.0 installed)

`npm run build` reported **one** error, in `hot-watch.ts`: the standalone `UnshieldedWallet` requires a `forks` schedule that the
facade fills in for itself. Fixed by passing `DefaultForkSchedule` (marked `SDK2-UNVERIFIED`). Everything else type-checked against
the real SDK 2: `config`, `keys`, `wallet` (facade `init`, `start(seeds)`, `startWithSeed`), `cold-export-public` and `sponsor-register`
(including the async signer). Type-checking does not prove it works at run time; the runs below do.

If `DefaultForkSchedule` is not exported or is not a plain value, find it with:

```bash
grep -rn "DefaultForkSchedule" node_modules/@midnightntwrk/wallet-sdk-facade/dist --include=*.d.ts | head
grep -rn "ForkSchedule" node_modules/@midnightntwrk/wallet-sdk-abstractions/dist --include=*.d.ts | head
```

### Results so far (reported)

- **Address check: passed.** Same phrase, same address on SDK 2 as on SDK 1.2. `deriveAndWipe` did not trip, so the SDK copies the seed.
- **`hot-watch`: passed.** It ran to completion, which it only does after a full sync and an address match. So the public key survives
  the JSON round trip (it is still three strings: `publicKey`, `addressHex`, `address`), and the standalone unshielded wallet synced
  against Preprod's ledger 9 chain through Blockfrost.
- **The snapshot format is almost unchanged.** SDK 2 adds two top-level members, `"version": "v1"` and `"writtenBy": "v1"`. The rest
  (`publicKey`, `state.availableUtxos` with `utxo` and `meta`, `pendingUtxos`, `protocolVersion`, `appliedId`, `networkId`) is the same
  as 1.x. `snapshot.ts` accepts it unchanged; it now also records the envelope and the protocol version, and `hot-watch` prints them.
  No secrets are in it (the public key still hashes to the address).

### What the first facts file (the type definitions) showed

- **The unshielded wallet's changelog is not needed.** The npm package ships no `CHANGELOG.md`, and the real snapshot already shows the format.
- **`facade.adoptTransaction(bytes, stage)` exists** (stages `'Unproven'`, `'Unbound'`, `'Finalized'`). Its own example is
  `adoptTransaction(Buffer.from(txHex, 'hex'), 'Unbound')`, so hex bytes remain the way a transaction travels. Only the current protocol
  epoch is accepted: a transaction built on the other side of a fork boundary throws `WalletTransactionUnwrapError`.
- **`start()` cannot skip the sync.** `FacadeStartOptions` has one member, `manualSync`, which is for the DUST wallet and refused while
  it is below `forks.v9`. So the cold machine will start background sync with no network. Whether `transferTransaction` then still works
  can only be shown by a run with the network off.
- **The default lifecycle service polls the indexer** (`start()` begins polling), so the cold machine has to stub it. `InitParams` takes
  `provingService` (a `VersionedProvingService`), `submissionService`, `transactionLifecycleService`, `fetchBlockData` and
  `validationService`; the last two default to indexer-backed versions and will also need to be stubbed or left unreachable on cold.
- **`DefaultForkSchedule`** is documented as built from `V9NativeForkSchedule`, "the schedule of a chain born on ledger-v9". Whether that
  matches a chain upgraded in place (Preprod) is what the protocol-version question below turns on.
- **Method signatures:** `submitTransaction(tx: FinalizedTx)`, `balanceFinalizedTransaction(tx: FinalizedTx, options)`,
  `finalizeRecipe(recipe): Promise<FinalizedTx>`, `signRecipe(recipe, signSegment: SignSegment)`, `transferTransaction(outputs, options)`,
  `revert(txOrRecipe, reason?)`. The facade also documents a table of which calls may wait during a protocol crossing.

Still missing, and why: the `WalletTransaction` class body (is it itself serializable? how is the inner ledger transaction read for
`txinfo`?), the crossing table, the whole lifecycle interface, the fork schedule comments, and `restore()` on the unshielded wallet.
Second batch (writes `~/sdk2-facts2.txt`):

```bash
cd ~/cardano/midnight/dev/midnight-cold-hot/node_modules/@midnightntwrk && {
F=wallet-sdk-facade/dist/index.d.ts
echo "== 1. WalletTransaction class: serialize, unwrap, wire =="; sed -n 95,230p wallet-sdk-abstractions/dist/WalletTransaction.d.ts
echo; echo "== 2. facade: protocol state (Settled / Crossing) =="; sed -n 236,275p $F
echo; echo "== 3. facade: DefaultForkSchedule and configuration =="; sed -n 470,520p $F
echo; echo "== 4. facade: adoptTransaction and the method table (which calls wait) =="; sed -n 655,760p $F
echo; echo "== 5. facade: submit, balance and transfer options, finalize, sign =="; sed -n 790,830p $F; sed -n 855,935p $F
echo; echo "== 6. facade: revert and start =="; sed -n 995,1045p $F
echo; echo "== 7. lifecycle service, whole interface =="; sed -n 241,340p wallet-sdk-capabilities/dist/transactionLifecycle/lifecycleService.d.ts
echo; echo "== 8. protocol versions and fork schedules =="; sed -n 40,95p wallet-sdk-abstractions/dist/ProtocolVersion.d.ts
echo; echo "== 9. unshielded wallet: configuration, chain version probe, restore =="; sed -n 40,100p wallet-sdk-unshielded-wallet/dist/UnshieldedWallet.d.ts; sed -n 185,200p wallet-sdk-unshielded-wallet/dist/UnshieldedWallet.d.ts; sed -n 120,155p wallet-sdk-unshielded-wallet/dist/UnshieldedWalletAPI.d.ts
grep -n "restore\|startWithPublicKey\|serializeState" wallet-sdk-unshielded-wallet/dist/*.d.ts | head -12
echo; echo "== 10. recipe, proving and submission types =="
grep -rnE -A14 "(type|interface) (BalancingRecipe|VersionedProvingService|SubmissionService)( |<|=)" wallet-sdk-*/dist --include=*.d.ts | head -100
} > ~/sdk2-facts2.txt 2>&1; wc -l ~/sdk2-facts2.txt
```

### What the second facts file showed

**Transactions.**
- `WalletTransaction` is a sealed handle with a `protocolVersion` and a `stage` (`'Unproven'`, `'Unbound'`, `'Finalized'`). It has
  `serialize()` returning bytes, so `tx.hex` can stay as it is: `toHex(finalized.serialize())` on the cold side.
- The inner ledger transaction is **deliberately unreachable** (a `#private` field). The only supported read is
  `WalletTransaction.unwrapWithin(handle, range)`. For the plan display, `sponsor-submit` should instead decode the same bytes with
  `@midnightntwrk/wallet-sdk/ledger/v9` and read `intents` as before.
- `facade.adoptTransaction(bytes, stage)` stamps the handle with **the facade's own current version** and refuses bytes written by the other
  ledger version (`WireFormatError`). So a ledger 8 transaction from the cold machine would be refused by a ledger 9 sponsor, safely.
- `WalletTransaction.toWire(handle)` writes a JSON-safe envelope carrying the version and stage: an option if a richer file than raw hex is wanted.

**Facade methods** (all take `ttl` options and no secret keys): `transferTransaction(outputs, { ttl, payFees? })` returns an
`UnprovenTransactionRecipe`; `signRecipe(recipe, signSegment)`; `finalizeRecipe(recipe): FinalizedTx`; `balanceFinalizedTransaction(tx: FinalizedTx,
{ ttl, tokenKindsToBalance? })` (paying with DUST may wait up to two minutes for the DUST trees, then rejects with `Wallet.Sync`);
`submitTransaction(tx: FinalizedTx)`; `revert(txOrRecipe, reason?)`; `calculateTransactionFee(tx)` and `estimateTransactionFee(tx, { ttl?, currentTime? })`
(both return a `bigint`; the second includes the balancing fee). `validateTransaction(tx, { flags, blockData })` is recommended before balancing and
before submitting, with the flags tabled in the docs (for `submitTransaction`: balancing, signatures and limits all `true`).

**Services `InitParams` takes:** `provingService` (`{ prove(transaction, protocolVersion) }`), `submissionService` (`{ submitTransaction, close }`),
`transactionLifecycleService` (`start`, `stop`, `state`, `balanced`, `finalized`, `submitted`, `reverted`, `orphanBeyond`, `included`, `serializeState`),
and `fetchBlockData` and `validationService`, which default to indexer-backed versions.

**The ledger-era question (the important one).** The unshielded wallet registers a **V1 variant (ledger 8)** below `forks.v9` and a **V2 variant
(ledger 9)** from it; a 2.x node reports protocol version `2000000`, a 1.x node a lower value. The docs say:
- A wallet with no chain-version probe **starts on V1** and "learns the version from the first message it sees". "On a chain that has shown this wallet no messages
  at all, an epoch that never gets corrected."
- `restore` goes "into whichever registered variant wrote it". Your snapshot says `"writtenBy": "v1"` and `"protocolVersion": "1000300"`.
- During a crossing the facade "stays bound to the version the laggards are still on".

My reading: your address has seen no event since the upgrade, so its wallet is still on V1, and **an offline cold machine restoring this snapshot would
build ledger 8 transactions**, which Preprod refuses (and the ledger 9 sponsor's `adoptTransaction` would refuse first). The fresh shielded and DUST wallets
start on V1 too. This is a reading of the doc comments, not a measurement.

The docs name two ways to tell a wallet where the chain is:
1. **`chainVersionProbe`** (optional; "an application that would rather ask something else, a cache or a value it already holds, supplies its own"). With one,
   a wallet starts "at the variant that owns the version the chain reports, which on a chain already past the boundary is the ledger-v9 one from the first moment".
2. **`forks`**: "a chain whose boundary is at or below the minimum supported version has never had two epochs", which says the chain was born on ledger 9.

What is not known: whether either works when the wallet is **restored from a V1 snapshot** with no network, and for the fresh shielded and DUST wallets.
`probe-cold-era` tests exactly that (next section) without needing any type I have not seen.

### Probe results (reported): the cold facade is on ledger 8, and the `forks` shortcut is refused

`probe-cold-era`, run on your snapshot with every endpoint unreachable:

| Run | Result |
|---|---|
| Default settings | The facade **started offline**. The `Wallet.Sync: [object ErrorEvent]` lines are the unreachable indexer, logged and non-fatal. `state()` emitted, and it reports `activeProtocolVersion: 0`, phase `Settled`. That is the ledger 8 epoch (below 2000000): **the cold machine would build ledger 8 transactions** |
| `forks.v9` = minimum supported version | **Refused at build:** `ProtocolMismatch: sinceVersion is prior to previously registered version`. The SDK registers a ledger 8 variant at the minimum and a ledger 9 variant at `forks.v9`, and the second must come later. The doc comment about a boundary "at or below the minimum" does not hold at run time |

Two things are good news: an offline facade is viable (it starts, and its state is readable), and the failure mode is the one the docs predicted.

### Experiment results (reported): the chain-version probe works

| Run | Result |
|---|---|
| `hot-watch --assume-ledger9` | `Snapshot format: v2, written by v2`, `Protocol version: 2000000`. So `startWithPublicKey` honours the probe, the guessed shape of `chainVersionProbe` compiled and worked, and the token appears as `<redacted>` in the node's own log line |
| `probe-cold-era` on that snapshot, probe on | The offline facade started, and settled: `activeProtocolVersion: 2000000`, phase `Settled`. The `Wallet.Sync` errors now come from the `v2/` folder (the ledger 9 variant). The fresh shielded and DUST wallets honoured the probe too |

So the cold design survives with one added requirement: **the snapshot must be written by `hot-watch` with the probe**, and the cold facade needs the probe in
its own configuration. Both are now the default (`ASSUME_LEDGER9=0` or `--no-probe` turns it off, for a chain still on ledger 8), and `cold-transfer`
refuses a snapshot below protocol version 2000000.

### Stage 2: written, never built or run

| File | What it does now |
|---|---|
| `cold-transfer.ts` | Refuses a snapshot below 2000000. Builds the facade offline (stub prover and submission; default lifecycle service, which the probe showed works offline), waits for `Settled` on ledger 9 **before any prompt**, then `transferTransaction(outputs, { ttl, payFees: false })`, `signRecipe(recipe, signDataAsync)`, `finalizeRecipe`, and writes `finalized.serialize()` as hex |
| `sponsor-submit.ts` | Decodes `tx.hex` with the ledger 9 package for the plan display; builds the sponsor facade; `adoptTransaction(bytes, 'Finalized')` (refuses a ledger 8 transaction); `validateTransaction` before balancing (catches a tampered file); shows an **estimate** of the DUST fee from `estimateTransactionFee` before the prompt; after `SUBMIT` balances, signs, finalizes, validates again, shows the **declared** fee read from the final bytes, and submits |
| `sponsor-register.ts` | Saves the synced wallet state **right after the sync**, before registering, so a failure at registration no longer costs the sync |
| `config.ts`, `hot-watch.ts` | Probe on by default |

Changed on purpose: the fee is no longer worked out by balancing before the prompt. SDK 2's `estimateTransactionFee` gives an estimate without locking DUST, so
cancelling no longer needs `revert`. Whether that estimate includes the 0.3 DUST overhead is unknown; the declared fee shown after signing is the authority.

**First run of `cold-transfer` (reported, network off):** it started, printed `Wallets settled at protocol version 2000000 (ledger 9)`, showed the review
screen with the right balance, and after `SEND` got through building and signing. It failed at the proving step with `expected proving provider property 'lookupKey'
to be a function`: ledger 9's proving provider has three methods (`prove`, `check`, `lookupKey`), and the stub had two. Fixed; whether the transfer then needs
no proof at all (so none of the three is ever called) is what the next run shows.

**`cold-transfer` fully confirmed (reported):** `Wrote tx.hex (protocol version 2000000). The proof stub was not called.` Total 4 s, offline. The cold machine needs no proof for an
unshielded transfer, and the SDK 2 build, async signing and finalize all work offline once the snapshot is a ledger 9 one.

**First run of `sponsor-submit` (reported):** it decoded `tx.hex` as a ledger 9 transaction and showed the plan correctly (two small coins, 99.999999 and 0.000001 NIGHT,
spent for a 10 NIGHT payment with 90 NIGHT change). Two problems appeared:
1. **A bug in my defaults.** With the probe on for every wallet, the sponsor's fresh shielded wallet ran on the ledger 9 decoder from the start and failed on the
   ledger 8 history: `Wallet.Other: Error while applying sync update ... Could not deserialize ledger event`, repeated. (My explanation from the error text; not
   separately confirmed.) The probe suits wallets with nothing to sync (the cold machine) and the unshielded wallet (plain JSON events). The sponsor now gives the probe to its
   unshielded wallet only, lets shielded and DUST start on ledger 8 and cross by themselves, and checks the phase after the sync (`Settled` at 2000000 or later) before doing anything.
   If an idle sponsor never crosses on its own, that check says so, and a different approach is needed.
2. **`npm run ... --dry-run` swallows the flag.** npm took `--dry-run` for itself, so the script would have submitted for real. The script now stops if npm reports that.

`SDK2-UNVERIFIED` lines to expect compile or run errors on: `ledgerV9.CostModel.initialCostModel()` and `prove(provider, costModel)` on a v9 transaction (cold prover stub);
`ledgerV9.Transaction.deserialize(...)` and its generics, `UnshieldedAddress.codec.encode(NETWORK_ID, ...)` and `DustAddress.encodePublicKey(...)` (display); the options
of `validateTransaction`; the `blockData` field of the recipe.

### Run order for stage 2 (throwaway wallets, small amounts)

1. `npm run build`. Send the compiler errors: they point at the wrong guesses above.
2. `node dist/hot-watch.js` (probe on by default). Check `written by v2` and a protocol version of 2000000. This replaces your old snapshot.
3. `sponsor-register`, if the sponsor still has no DUST. **A run started before this build has no probe**: if that process is still syncing, it may build its
   registration at ledger 8 and fail at the end, losing the sync. If it has only just started, stopping it and restarting with this build is the safer choice;
   the new build saves its state right after the sync.
4. `node dist/cold-transfer.js <address> 1000000`, **with the network off**. The prompt should appear only after it prints `Wallets settled at protocol version 2000000`.
5. Carry `tx.hex` to the hot machine (QR or USB), then `node dist/sponsor-submit.js tx.hex --dry-run`, then without `--dry-run`. With npm the flag needs a lone `--`
   in front of it, or use `node` directly.

**The sponsor's first sync from scratch is the slow part**, and `sponsor-submit` also syncs from scratch whenever there is no `wallet-state-*.json`. Let `sponsor-register`
do the long sync once: the new build saves the state right after it, and later runs resume from it.

Third batch of type definitions, only if the stage 2 build errors need them (writes `~/sdk2-facts3.txt`):

```bash
cd ~/cardano/midnight/dev/midnight-cold-hot/node_modules/@midnightntwrk && {
echo "== 11. chain version probe types =="; ls wallet-sdk-capabilities/dist/chainVersion/ 2>&1; cat wallet-sdk-capabilities/dist/chainVersion/*.d.ts 2>&1 | head -150
echo; echo "== 12. FacadeState =="; grep -n -A45 "export type FacadeState" wallet-sdk-facade/dist/index.d.ts | head -80
echo; echo "== 13. ProtocolVersion constructors and ranges =="; sed -n 1,40p wallet-sdk-abstractions/dist/ProtocolVersion.d.ts; sed -n 95,170p wallet-sdk-abstractions/dist/ProtocolVersion.d.ts
echo; echo "== 14. unshielded restore variants =="; sed -n 100,125p wallet-sdk-unshielded-wallet/dist/UnshieldedWallet.d.ts
echo; echo "== 15. shielded and dust: start, restore, probe =="; grep -n "startWithSeed\|startWithKeys\|restore(" wallet-sdk-shielded/dist/*.d.ts wallet-sdk-dust-wallet/dist/*.d.ts | head -20; grep -rn "chainVersionProbe" wallet-sdk-shielded/dist wallet-sdk-dust-wallet/dist --include=*.d.ts | head -6
echo; echo "== 16. lifecycle implementation, cost model, ledger v9 =="; grep -rn "TransactionLifecycleServiceImpl" wallet-sdk-capabilities/dist --include=*.d.ts | head -6; ls wallet-sdk-capabilities/dist; grep -rn "initialCostModel" ledger-v9 --include=*.d.ts | head -3; grep -rn "static deserialize" ledger-v9 --include=*.d.ts | head -3
echo; echo "== 17. unshielded wallet API (build, sign, balance without the facade) =="; sed -n 155,260p wallet-sdk-unshielded-wallet/dist/UnshieldedWalletAPI.d.ts; grep -n "transferTransaction\|signUnprovenTransaction\|signUnboundTransaction\|balanceFinalizedTransaction\|revertTransaction" wallet-sdk-unshielded-wallet/dist/UnshieldedWalletAPI.d.ts | head
} > ~/sdk2-facts3.txt 2>&1; wc -l ~/sdk2-facts3.txt
```

### Open question raised by the snapshot: `protocolVersion`

**Resolved (see the probe results above): reading 2 was right.** The wallet was on the ledger 8 variant; the probe fixes it. The text below is kept as the record of the question.

The snapshot says `"protocolVersion": "1000300"` (SDK 1.2 wrote `"0"`). The ledger 9 page treats `>= 2000000` as the sign that the
network crossed to ledger 9, and a wallet decides which ledger to use from its protocol version and the `forks` schedule
(`forks.v9`, default 2000000). Two readings, and I cannot tell them apart without the SDK's type definitions or a run:

1. It is the wallet's record of the **last event this address saw**. Your newest coin is from 7 November, before the upgrade, so an
   idle address would keep an older number. Harmless on the hot side.
2. The wallet is **not on ledger 9** yet. Then a cold machine restoring this snapshot offline would build **ledger 8** transactions,
   which Preprod rejects. This is the offline-crossing risk described below, now with a concrete symptom to look for.

How the SDK picks the ledger when it cannot reach a node is exactly what `chainVersionProbe` (an optional member of the unshielded
wallet's configuration) and `forks` are about. To read them:

```bash
cd ~/sdk2-probe/node_modules/@midnightntwrk
grep -rn "chainVersionProbe\|ChainVersionProbe\|ForkSchedule\|Crossing\|Settled\|activeProtocolVersion" wallet-sdk-unshielded-wallet/dist wallet-sdk-facade/dist wallet-sdk-abstractions/dist --include=*.d.ts | head -40
```

### Run these first, in this order

1. `npm install` and `npm run build`. Send me the compiler errors; they will point at the wrong guesses.
2. **The address check (most important). PASSED (reported):** the address from `cold-export-public` on SDK 2 matches the one from
   SDK 1.2 for the same phrase, so `WalletSeeds.fromMasterSeed` derives the same wallet and existing funds stay put. The run also
   passed `deriveAndWipe`, so the SDK copies the seed instead of keeping a reference to it. Still untested here: the public key
   object surviving the JSON round trip (step 3).
3. `hot-watch` against Preprod with that `cold-public.json`: does `startWithPublicKey` accept the object after the JSON round trip? **PASSED (reported).**
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

Commands for the second batch. Run them from anywhere: they `cd` into the project's `node_modules`, and write everything to
`~/sdk2-facts.txt` (public type definitions only, nothing secret). Send that file's contents.

```bash
cd ~/cardano/midnight/dev/midnight-cold-hot/node_modules/@midnightntwrk && {
echo "== 0. packages =="; ls
echo; echo "== 0b. facade files =="; ls wallet-sdk-facade/dist | head -40
echo; echo "== A. facade init parameters (proving, submission, lifecycle services) =="
grep -rnE -A30 "(interface|type) InitParams" wallet-sdk-facade/dist --include=*.d.ts | head -70
echo; echo "== B. lifecycle service interface =="
grep -rnE -A25 "(interface|type) TransactionLifecycleService( |<|=)" wallet-sdk-*/dist --include=*.d.ts | head -70
echo; echo "== C. transaction handles: bytes in and out =="
grep -rnE "adoptTransaction|WalletTransaction" wallet-sdk-facade/dist wallet-sdk-abstractions/dist wallet-sdk-capabilities/dist --include=*.d.ts | head -40
echo; echo "== D. what the facade methods take and return =="
grep -rnE "finalizeRecipe|transferTransaction|balanceFinalizedTransaction|signRecipe|submitTransaction|revert\(" wallet-sdk-facade/dist --include=*.d.ts | head -30
echo; echo "== E. start options =="
grep -rnE -B2 -A12 "FacadeStartOptions|FacadeStartMaterial" wallet-sdk-facade/dist --include=*.d.ts | head -60
echo; echo "== F. chain version, forks, crossing (the protocolVersion question) =="
grep -rnE "chainVersionProbe|ChainVersionProbe|ForkSchedule|activeProtocolVersion|Crossing|Settled" wallet-sdk-unshielded-wallet/dist wallet-sdk-facade/dist wallet-sdk-abstractions/dist --include=*.d.ts | head -40
echo; echo "== G. unshielded wallet changelog =="
sed -n 1,120p wallet-sdk-unshielded-wallet/CHANGELOG.md
} > ~/sdk2-facts.txt 2>&1; wc -l ~/sdk2-facts.txt
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
