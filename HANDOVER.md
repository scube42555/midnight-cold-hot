# Handover (11 November 2026)

Start here in a new session, then read `CLAUDE.md`. Read `MIGRATION-LEDGER9.md` only for the sections "Experiment results", "Stage 2" and "Run order"; the rest is history.

**What this is:** scripts that move unshielded NIGHT from an offline "cold" wallet via an online sponsor wallet that pays the DUST fee. Midnight wallet SDK **2.0.0**, ledger 9, Preprod. TypeScript, Node 22.

## Verified on Preprod (reported by the owner)

- The same phrase gives the same addresses on SDK 2 as on SDK 1.2.
- `hot-watch` syncs and writes a snapshot: `format v2, written by v2, protocol version 2000000`.
- An **offline** facade starts and settles on ledger 9 (`probe-cold-era`).
- `cold-transfer` offline, end to end: 4 s, protocol version 2000000, `tx.hex` of 760 bytes, **proof stub not called**.
- `sponsor-submit` decodes that `tx.hex` as ledger 9 and shows the plan correctly (coins, change, balance after).
- **Sponsor first sync on SDK 2: ~9.5 h on Preprod.** Protocol phase after: `{"_tag":"Settled","version":"2000000"}`, 5000 DUST. Shielded and DUST wallets crossed to ledger 9 on their own.
- **Full end-to-end flow on SDK 2 (11 Nov 2026):** `hot-watch` → `cold-transfer` offline → `sponsor-submit --dry-run` → `sponsor-submit`. Transaction accepted on-chain:
  `00ecd050673404bf3a25b187265858ccfa3b880df279d86c9259bb567ca74b6407`  
  tx hash `0x7df566e3aed4abe1dab1226fea1a075f72a2037cc77e38dde060cadec10f8ce4`
- **QR transfer both directions:** hot→cold snapshot via `receiver.html` on ArchLinux dev machine and `qr_scan.py` on TailsOS; cold→hot `tx.hex` via `qr-send` HTML page on cold and `receiver.html` on ArchLinux hot machine.

## Not yet verified

- BIP-39 passphrase on a wallet created elsewhere (compare address before funding — section 3 of the README).
- Custom tokens (`--token`).
- Networks other than Preprod.
- T6, T8, T9, T10, T13, T14, T16, T17–T23 (stale snapshot, sponsor failure modes, network cross-checks — see the test table).

All `SDK2-UNVERIFIED` comments have been cleared. `keys.ts:73` verified programmatically: `@scure/bip32` hashes the seed on entry and never retains the original buffer, so the wipe is safe.

## Rules that bit us

- **npm swallows `--dry-run`:** write `npm run x -- --dry-run`, or `node dist/x.js --dry-run`.
- **A `tx.hex` can expire during a long first sync.** The first sync took ~9.5 h and the initial `tx.hex` was refused with a blank error (most likely expired). The code now checks the TTL after the sync and prints "tx.hex expired; run cold-transfer again" instead of a blank message. Take a fresh snapshot and build a new `tx.hex` after the sponsor is synced.
- **The chain-version probe (`assumeLedger9`) is for cold and the unshielded wallet only.** On a shielded or DUST wallet syncing from genesis it fails with "Could not deserialize ledger event".
- A snapshot must come from `hot-watch` of this version (protocol version >= 2000000), or `cold-transfer` refuses it.
- `hot-watch` and the sponsor use Blockfrost; the token is never printed (output is redacted).
- Throwaway wallets only. Never run a script with a real recovery phrase from an AI session.

## Environment per step

| Step | Needs |
|---|---|
| `hot-watch` | `BLOCKFROST_PROJECT_ID` |
| `sponsor-register`, `sponsor-submit` | `BLOCKFROST_PROJECT_ID`, `SPONSOR_MNEMONIC` (+ `SPONSOR_PASSPHRASE`), `PROOF_SERVER_URL` if not local |
| `cold-transfer`, `probe-cold-era` | `COLD_MNEMONIC` (+ `COLD_PASSPHRASE`); no network, no token |

Enter secrets with `read -rs NAME` on its own line, then `export NAME`, then `echo "${#NAME}"` (length only).

## Next steps (from this session)

- `npm run build` and `npm test` are both clean.
- Full flow verified. For further testing: T9 (stale snapshot), T10 (snapshot with tx in flight), T13 (sponsor failure modes — especially reserved DUST after expiry), passphrase test (T16-ish).
- No `SDK2-UNVERIFIED` lines remain. All cleared.
- `LOG_VERBOSE=1` shows full Wallet.Sync / API-WS blocks (normally suppressed to one line per event).
