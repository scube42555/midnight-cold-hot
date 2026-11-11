---
name: project-state
description: Midnight cold/hot SDK 2 verification status and next steps as of 11 Nov 2026
metadata:
  type: project
---

Full end-to-end flow verified on Preprod, SDK 2.0.0, 11 November 2026: `hot-watch` → `cold-transfer` → `sponsor-submit` → submit. Transaction on-chain: `00ecd050673404bf3a25b187265858ccfa3b880df279d86c9259bb567ca74b6407`.

**Why:** SDK 2 migration complete; all SDK2-UNVERIFIED lines cleared except `keys.ts:73` (seed wiping, defensive only).

**How to apply:** don't restart from HANDOVER's "not yet verified" list for the sponsor sync — that's done. Next priorities: T9 (stale snapshot), T13 (sponsor failure modes), T16 (BIP-39 passphrase test), custom tokens.

Key facts from this run:
- Sponsor first sync: ~9.5 h on Preprod.
- An earlier `tx.hex` expired during the sync → TTL check added in `sponsor-submit.ts` (before AND after sync).
- QR transfer: both directions verified on ArchLinux dev machine (`receiver.html`); Python scanner on TailsOS for hot→cold.
- `LOG_VERBOSE=1` shows full Wallet.Sync/API-WS blocks (otherwise suppressed to one line per event).
- `npm test` runs 38 SDK-free tests (logfilter, snapshot, txinfo) in `dist-test/`.
