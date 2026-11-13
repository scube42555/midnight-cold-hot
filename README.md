# Midnight cold/hot NIGHT transfer (Preprod test scripts)

Moves unshielded NIGHT out of a wallet whose seed exists only on an offline (cold) machine.
The hot machine syncs, pays the fee with a separate sponsor wallet, and submits.

**Status (11 November 2026): working on Preprod with wallet SDK 2.0.0 (ledger 9). Full end-to-end flow verified.**
Preprod moved from ledger 8 to ledger 9 on 9 November 2026; wallet SDK 1.x can no longer transact there.
The code targets wallet SDK 2.0.0 (see `MIGRATION-LEDGER9.md`). The full transfer flow has been verified
end to end on Preprod: `hot-watch` → `cold-transfer` → `sponsor-submit` → submit, with QR transfer on
both directions (see section 4). `cold-public.json` and the snapshot changed format with the upgrade; the
cold machine refuses a snapshot from before the ledger 9 era. SDK 1.2.0 results are retained in the test table.

Use throwaway wallets and faucet tokens only. A recovery phrase that has appeared on an online machine
must never hold real funds.

## Files

| Script | Runs on | Needs a seed? | What it does |
|---|---|---|---|
| `keygen` | dev machine | no | Prints a new 24-word phrase (throwaway wallets only) |
| `cold-export-public` | cold | `COLD_MNEMONIC` or `COLD_SEED`; `COLD_PASSPHRASE` (optional) | Writes `cold-public.json` (public fields only) |
| `hot-watch` | hot | no | Watches the cold address by public key, writes `cold-unshielded.snapshot.json` |
| `sponsor-register` | hot | `SPONSOR_MNEMONIC` or `SPONSOR_SEED`; `SPONSOR_PASSPHRASE` (optional) | One-time: registers the sponsor's NIGHT for DUST |
| `cold-transfer` | cold | `COLD_MNEMONIC` or `COLD_SEED`; `COLD_PASSPHRASE` (optional) | Builds, signs, finalizes the transfer, writes `tx.hex` |
| `sponsor-submit` | hot | `SPONSOR_MNEMONIC` or `SPONSOR_SEED`; `SPONSOR_PASSPHRASE` (optional) | Adds DUST for the fee and submits `tx.hex` |

The cold and sponsor wallets use different variable names on purpose, so they cannot be mixed up.
The scripts delete the variable from the process environment once they have read it. A BIP-39 passphrase goes in `COLD_PASSPHRASE` or `SPONSOR_PASSPHRASE` (section 3).

## 1. Build (dev machine, online)

Use the same Node major version everywhere. The docs' Node.js guide tested 22.12, 22.18 and 24.15.
Use the exact Node tarball you will copy to the cold machine:

```bash
export PATH="$HOME/node22/bin:$PATH"     # the unpacked official Node 22 linux-x64 tarball
node --version
npm install                               # creates package-lock.json: commit it and keep it pinned
npm run build                             # compiles src/ to dist/; fix any type errors first
npm test                                  # SDK-free unit tests (logfilter, snapshot, txinfo)
```

If `npm run build` reports an error, send me the message. A renamed export or type is the most
likely cause and is a small fix.

## 2. Network and endpoints

Choose the network with `MIDNIGHT_NETWORK`: `undeployed`, `preview`, `preprod` or `mainnet` (default `preprod`).
Use the same value on the cold and hot machines. The address in `cold-public.json` records the network, and the
scripts cross-check it: `hot-watch`, `sponsor-register` and `sponsor-submit` stop before any network traffic if
`cold-public.json` (in the current folder, or at `COLD_PUBLIC_FILE`) is for another network, and `cold-transfer` stops if
the snapshot's network or address differs. Every script prints the network it is using first, so look at that line. Endpoints come from the docs' environment reference
(https://docs.midnight.network/guides/networks-and-environments).

| Network | Node and indexer | Token | Funding |
|---|---|---|---|
| `undeployed` | local: node `localhost:9944`, indexer `localhost:8088/api/v4/graphql` | none | genesis wallet via `midnight-local-dev` |
| `preview` | Midnight-hosted `rpc.preview.midnight.network` and `indexer.preview.midnight.network` | none | https://faucet.preview.midnight.network/ (Preview was relaunched as a new chain on 7 Nov 2026; old state is gone) |
| `preprod` | Blockfrost `midnight-preprod.blockfrost.io` and `rpc.midnight-preprod.blockfrost.io` | `BLOCKFROST_PROJECT_ID`, starts with `nightpreprod` | https://midnight-tmnight-preprod.nethermind.dev/ |
| `mainnet` | Blockfrost `midnight-mainnet.blockfrost.io` and `rpc.midnight-mainnet.blockfrost.io` | `BLOCKFROST_PROJECT_ID`, starts with `nightmainnet` | none, real NIGHT |

The proof server is `http://127.0.0.1:6300` on every network. The docs say it always runs locally because it
handles private data.

```bash
export MIDNIGHT_NETWORK=preprod
export BLOCKFROST_PROJECT_ID="nightpreprod..."    # the scripts add ?project_id= themselves
```

Override any single endpoint with `INDEXER_HTTP_URL`, `INDEXER_WS_URL`, `NODE_URL` or `PROOF_SERVER_URL`. A variable that is set but empty counts as unset (the default is used); a malformed one stops
the script, naming the setting but not showing its value.

Set `ASSUME_LEDGER9=0` to turn off the chain-version probe and let the SDK detect the ledger version itself. The probe is on by default because without it an offline or idle wallet stays on the ledger 8 variant and builds transactions the network rejects. Only turn it off if you are running against a chain still on ledger 8.
On preprod and mainnet the URLs contain your token, so the scripts never print them. The SDK's own libraries do print
the node URL when a connection drops, so every script also replaces `project_id=...` and your token with `<redacted>`
in anything it prints (`src/redact.ts`). If a token has ever been pasted anywhere (a chat, an issue, a screenshot), revoke
it in the Blockfrost dashboard and create a new one.

**Correction.** An earlier version of these scripts defaulted preprod to `indexer.preprod.midnight.network`
and `rpc.preprod.midnight.network`. Midnight retired those on 9 October 2026 (the indexer now answers HTTP
410), and the mainnet equivalents on 30 September 2026. Preprod and mainnet now go through Blockfrost. If
you set `INDEXER_HTTP_URL`, `INDEXER_WS_URL` or `NODE_URL` to the old values, remove them.

**Saved wallet state from the retired indexer is not portable.** Discard `wallet-state-*.json` and any
snapshot made against the old indexer and sync from genesis. The docs warn that a full preprod sync can take
over an hour.

### Mainnet

Mainnet moves real funds and these scripts are untested, so they refuse to run on it unless you set
`ALLOW_MAINNET=1`. Do that only after the whole test plan has passed on preprod. DUST also works differently
there: most NIGHT is held on Cardano as cNIGHT, and DUST generation is a cross-chain registration that takes
about 12 hours (the cNgD DApp, see the docs). `sponsor-register` is written for registering NIGHT held on
Midnight itself, so it may not apply to a mainnet sponsor wallet.

### Proof server on a LAN host

`PROOF_SERVER_URL=http://docker:6300` works, with this caveat. The proof server has no authentication and no
TLS, and each sponsor DUST proof request contains the sponsor's DUST secret key. Anyone on that LAN who can
sniff or reach the port could read it or use your server. For a throwaway sponsor wallet that is a small risk.
Before using real funds: run the server on the same machine, or tunnel (`ssh -L 6300:127.0.0.1:6300 user@host`,
then use `127.0.0.1`). The cold machine never contacts a proof server.

## 3. Run order

Generate two throwaway phrases on the dev machine (`npm run keygen`, twice). One is cold, one is sponsor.
Enter secrets without leaving them in shell history:

Run these one at a time. Do not paste them together with the next command: `read` takes the next line of input, so a
pasted `npm run ...` line can be swallowed as the phrase, and pressing Enter before the words are in stores an empty value.
Nothing is displayed as you type, because `-s` hides it.

```bash
read -rs COLD_MNEMONIC        # the cursor waits: paste or type the 24 words, then press Enter
export COLD_MNEMONIC
echo "${#COLD_MNEMONIC}"      # the length only, never the words: expect about 150-200, and never 0
```

If a script says `COLD_MNEMONIC is set but empty`, the `read` got an empty line: run the `read` again on its own.

**Passphrase (the "25th word").** If the recovery phrase has a BIP-39 passphrase, enter it the same way, in its own variable:

```bash
read -rs COLD_MNEMONIC;   export COLD_MNEMONIC
IFS= read -rs COLD_PASSPHRASE; export COLD_PASSPHRASE   # IFS= keeps leading and trailing spaces
```

The sponsor wallet uses `SPONSOR_PASSPHRASE`. Four things to know:

- **A wrong passphrase does not fail.** It gives a valid but different, empty wallet. Every character counts: case, spaces and punctuation. The scripts use the passphrase exactly as typed and never trim it.
- **Check the address before funding.** Run `npm run cold:export-public` and compare the printed address with the one in the wallet that created the phrase. If they differ, the passphrase (or the way that wallet applies it) is not what you think. Do not fund an address you have not matched.
- **It only works with a recovery phrase.** `COLD_PASSPHRASE` together with `COLD_SEED` is refused, because a hex seed has no passphrase.
- **Set it on every machine and every run** that needs this wallet. Hot machines never need the cold wallet's phrase or passphrase, only `cold-public.json`.

The scripts delete the passphrase variable from the process environment after reading it, like the other secrets.

1. **Cold:** `npm run cold:export-public`. Copy `cold-public.json` to the hot machine (public data, no secrets). USB or QR both work; for QR see section 7 "Cold to hot: the public key".
2. **Fund the cold address** from the faucet for your network (section 2). On preprod that is
   https://midnight-tmnight-preprod.nethermind.dev/ (5,000 tNIGHT per request, rate limited).
3. **Fund the sponsor address.** Run `npm run hot:sponsor-register` once; it prints the sponsor address,
   registers its NIGHT for DUST, and waits for a DUST balance. DUST builds up over time.
4. **Hot:** `npm run hot:watch`. Copy `cold-unshielded.snapshot.json` to the cold machine.
   Pass `--no-probe` to disable the chain-version probe for this run (equivalent to `ASSUME_LEDGER9=0` but only for `hot-watch`).
   `npm run probe:cold-era` is a diagnostic tool that starts an offline facade and prints which protocol version it settles on; use it to verify the probe is working without doing a real transfer.
5. **Cold:** `node dist/cold-transfer.js <recipient address> <amount in STAR>`
   Enter the amount in STAR (the smallest unit): `1000000` or `1,000,000` for 1 NIGHT; `1500000` for 1.5 NIGHT.
   The script rejects anything else. It first checks that the snapshot is for this network and wallet and holds enough,
   then shows all token balances from the snapshot and what it will sign. Review the recipient and amount, type `SEND`. Copy `tx.hex` to the hot machine.
6. **Hot:** `npm run hot:sponsor-submit -- --dry-run` first (or `node dist/sponsor-submit.js --dry-run`). **With npm, flags go after a lone `--`:**
   `npm run hot:sponsor-submit --dry-run` hands the flag to npm, and the script would submit for real. It now refuses to run if it sees this.
   This can take several minutes; it beeps when it needs you (see section 8). It prints the start time first, and the finish
   time and total at the end, so you can time a run. Before asking you to confirm it shows:

   ```text
   Started:  2026-11-08 16:00:12 UTC-05:00
   Network: preprod
   From:     <sender>  <wallet balance before>  (from the snapshot file)
   UTXOs:    <N> coin(s) in the From wallet (snapshot file); <n> spent by this transaction:
               [spent]  <amount>  <short coin id>
               [kept]   <amount>  <short coin id>
   To:       <recipient>  <amount>
   Change:   <sender>  <amount>  (returns to the From address)
   After:    <wallet balance after>
   Expires:  <local time>  (in <N> min)
   Sponsor:  <sponsor address>
   Synced in 4 min 45 s ...
   Sponsor DUST address / balance / cap
   DUST fee: <fee> DUST declared = overhead + the ledger's price
   Sponsor DUST after: about <balance minus fee>
   ... Type SUBMIT to continue:
   ...
   Finished: 2026-11-08 16:06:41 UTC-05:00  (total 6 min 29 s)
   ```

   Anything other than `SUBMIT` cancels, and the sponsor's DUST that balancing locked is released. It flags anything unusual
   for a plain transfer: inputs and outputs that do not balance, or contract actions. The wallet balance and the coin list use
   `cold-unshielded.snapshot.json` in the current folder (or the file named by `SNAPSHOT_FILE`). They appear only if that file
   is for the sender and holds every coin the transaction spends. A newer snapshot, taken after this transfer was built, does
   not hold those coins, so you get a warning instead; this also tells you a snapshot is stale. They are from the file and not
   live, and the fee is paid in DUST, so only what is sent to others leaves the cold wallet.
   Section 9 explains the UTXOs list, the Change line, "fallible", and the DUST fee.
   `--dry-run` finishes the balancing and proving, then releases the DUST again.

`hot-watch` waits up to 10 minutes for coins to appear after the initial sync; set `WATCH_TIMEOUT_MINUTES` to override. 1 NIGHT = 1,000,000 STAR. For another unshielded token, add `--token <64-hex token type>` and give the
amount in that token's smallest unit (`hot-watch` lists every token type it sees). Take a fresh snapshot (step 4) before every transfer, and make sure no
transaction from the cold address is in flight when you take it.

## 4. Test plan and results

Tests marked **SDK 1** were run on wallet SDK 1.2.0 on Preprod before the ledger 9 upgrade; they should be
re-run on SDK 2 as the opportunity arises. Tests marked **SDK 2** were run on wallet SDK 2.0.0 on Preprod
after the upgrade. "Not yet run" means nobody has run it on that version. Tests marked *new* were added after the first round.

| Test | What it checks | Result |
|---|---|---|
| T1 | Cold and sponsor wallets created, funded from the faucet, sponsor registered for DUST | Passed (SDK 1) |
| T2 | `cold-unshielded.snapshot.json` holds no seed or secret key | Passed (reviewed, see below) |
| T3 | `cold-transfer` with the network on: the proof stub is never called | Passed (SDK 1) |
| T4 | The same with the network off | Passed (SDK 1) |
| T5 | Sponsor adds DUST and submits; the sponsor paid the fee; the transfer landed | Passed (SDK 1); whole flow on SDK 2: see T28 |
| T6 | A shielded output on the cold machine is refused by the stub prover | Not yet run |
| T7 | A tampered `tx.hex` is rejected | Passed |
| T8 | A truncated or non-hex `tx.hex` is rejected before parsing | Not yet run |
| T9 | A stale snapshot (see below) is rejected and loses nothing | Not yet run |
| T10 | A snapshot taken with a transaction in flight | Not yet run |
| T11 | A `tx.hex` submitted after `TTL_MINUTES` has passed is rejected | Passed |
| T12 | Wrong network | Partly: see below. The gaps found were fixed in this version |
| T13 | Sponsor problems: not synced (error 170), stale DUST (196), zero DUST | Not yet run |
| T14 | Submitting the same transaction twice | Not yet run |
| T15 | Wrong recipient | Passed for an address from another network (rejected when decoded). Other address types not tried |
| T16 | A seed typed as a phrase versus as hex gives different wallets | Not yet run |
| T17 *new* | `cold-transfer` refuses a snapshot made for another network | Not yet run |
| T18 *new* | `hot-watch`, `sponsor-register` and `sponsor-submit` refuse a `cold-public.json` for another network, before any sync | Not yet run |
| T19 *new* | `cold-transfer` refuses an amount larger than the snapshot holds | Not yet run |
| T20 *new* | `sponsor-submit` prints From, To and Change that match what `cold-transfer` showed | Not yet run |
| T21 *new* | It shows the sponsor address, DUST balance and DUST fee before the prompt, and a cancelled run releases the DUST (a second run works at once) | Not yet run |
| T22 *new* | A snapshot taken after the transfer was built gives a "not in the snapshot file" warning instead of a balance | Not yet run |
| T23 *new* | No hot script prints your Blockfrost token: run one with it set and search the output (see below) | Not yet run |
| T24 | `hot-watch` writes a ledger 9 snapshot (`written by v2`, protocol version 2000000) | Passed (SDK 2) |
| T25 | An offline facade restored from that snapshot settles on ledger 9 (`probe-cold-era`) | Passed (SDK 2) |
| T26 | Without the chain-version probe the snapshot is `written by v1` at 1000300 and the offline facade settles at protocol version 0 (ledger 8) | Observed (SDK 2): the reason the probe is on by default |
| T27 | `cold-transfer` builds, signs and finalizes a ledger 9 transaction offline, and refuses a snapshot from before ledger 9 | Passed (SDK 2): offline, 4 s, protocol version 2000000, `tx.hex` of 760 bytes, **the proof stub was not called**. The refusal of an old snapshot: not yet run |
| T28 *new* | Sponsor first sync from scratch (~9.5 h on Preprod); then adopts, validates, balances, proves and submits the transaction; full flow end to end | Passed (SDK 2, 11 Nov 2026): transaction `00ecd050673404bf3a25b187265858ccfa3b880df279d86c9259bb567ca74b6407` accepted on-chain (tx hash `0x7df566e3aed4abe1dab1226fea1a075f72a2037cc77e38dde060cadec10f8ce4`). An earlier `tx.hex` expired during the sync; the TTL check added in this session caught that case |
| T29 *new* | QR transfer both directions: snapshot hot→cold via `receiver.html` and Python scanner; `tx.hex` cold→hot via `qr-send` HTML and `receiver.html` | Passed (SDK 2, 11 Nov 2026): `receiver.html` on ArchLinux dev machine (both directions); Python scanner on TailsOS (hot→cold snapshot); `qr-send` HTML page on cold machine (cold→hot) |

**How the new tests are run**

```bash
# T17: use the preprod snapshot but the wrong network. Expect "The snapshot is for network "preprod" but this run is set to ..."
MIDNIGHT_NETWORK=preview node dist/cold-transfer.js <a preview address> 1000000
# T18: with a preprod cold-public.json in the folder. Expect "... is for network "preprod" but MIDNIGHT_NETWORK is "preview""
# and no sync starting
MIDNIGHT_NETWORK=preview npm run hot:sponsor-submit
# T19: ask for far more than the snapshot lists. Expect "The snapshot holds only ... and ... was requested."
node dist/cold-transfer.js <address> 999999999999999
```

T20: run `node dist/sponsor-submit.js tx.hex --dry-run` and compare the From, To and Change addresses and amounts with what
`cold-transfer` showed before you typed `SEND`.

T21: run `sponsor-submit` and answer anything but `SUBMIT`, then run it again straight away. The second run should balance
without a "could not balance dust" error. Compare the DUST balance it printed with the sponsor's balance after a real submit.
T22: after a successful submit, run `hot-watch` for a new snapshot, then `sponsor-submit tx.hex --dry-run`.
T23: `npm run hot:sponsor-submit 2>&1 | grep -c "$BLOCKFROST_PROJECT_ID"` should print `0`, even when the node connection drops.

### T2: what is in a snapshot

A snapshot is one JSON object with five fields: `publicKey` (the key, its address as hex, and its address as text), `state`
(the wallet's available and pending coins), `protocolVersion`, `appliedId` and `networkId`. Each coin lists its value, owner,
token type, the hash of the transaction that created it, and when it was created. In the snapshot you sent, every
64-character hex value is accounted for: the public key, the address, the token type (all zeros means NIGHT) and one
transaction hash. The public key's SHA-256 equals the address, and the text address decodes to the same bytes as the hex
address, so that value is a public key and not a secret one. The snapshot does reveal your coins and their amounts,
which are public on the chain anyway. Keep it private for that reason.

### What "stale snapshot" means

A snapshot is a photo of the wallet's coins at the moment `hot-watch` saved it. It is **stale** once the real wallet has changed:
a coin in it has been spent, or new coins have arrived. For example, your snapshot lists one coin of 4,999.5 NIGHT. After you
send from it, that coin no longer exists, and a new snapshot would show the change coin instead.

Build a second transfer from the old snapshot and `cold-transfer` will happily choose the spent coin, because the cold machine
cannot see the chain. The network then rejects the transaction as a double spend. Nothing is lost, but the attempt is wasted.
New funds are also missing from an old snapshot, so you may be told the balance is too low. The cold machine has no way to tell
how old a snapshot is. The rule is simple: **take a fresh snapshot before every transfer.** T9 tests this.

### T12: what the wrong-network runs showed, and what changed

- `hot-watch` already refused a `cold-public.json` for another network. That worked.
- `cold-transfer` rejected a recipient address from the wrong network. But with an address that passed, it only said the snapshot
  did not mention this wallet's address. It never said the snapshot's network disagreed.
  **Now** it reads the snapshot first and stops with a message naming both networks, before touching any key. It also stops if the
  snapshot is for a different address, or holds less than the amount.
- `sponsor-submit` with the wrong `MIDNIGHT_NETWORK` started syncing a new sponsor wallet from scratch, and only failed later.
  **Now** `sponsor-register` and `sponsor-submit` check `cold-public.json` first and stop before any network traffic. They only
  read it if it exists in the current folder (or at `COLD_PUBLIC_FILE`), because the sponsor wallet is a separate wallet and
  does not need that file. Without it there is nothing to compare, so they cannot catch a wrong network on their own.

I could not find a way for `sponsor-submit` to read the network from `tx.hex` itself. The SDK may expose it, but I have not
confirmed that.

## 5. Building the cold bundle (online machine) and checking it (cold machine)

Everything the cold machine needs travels as one file, `cold-bundle.tar.gz`. Build it on the online machine using the same
Node tarball you will run offline. The examples use `node-v22.23.4-linux-x64.tar.gz`; substitute your own.

**On the online machine**

1. **Verify the Node tarball.** Download `SHASUMS256.txt` from https://nodejs.org/dist/v22.23.4/ into the same folder and check it.
   Also verify the signature with the release keys that nodejs.org lists.

   ```bash
   NODE_TGZ=~/Downloads/node-v22.23.4-linux-x64.tar.gz     # adjust
   PROJECT=~/path/to/midnight-cold-hot                     # adjust
   cd "$(dirname "$NODE_TGZ")"
   grep node-v22.23.4-linux-x64.tar.gz SHASUMS256.txt | sha256sum -c -
   ```

2. **Use that exact Node to build.**

   ```bash
   mkdir -p ~/node22 && tar -xzf "$NODE_TGZ" -C ~/node22
   export PATH="$HOME/node22/node-v22.23.4-linux-x64/bin:$PATH"
   node --version                      # must print v22.23.4
   cd "$PROJECT"
   npm ci                              # all dependencies, including dev, from the lockfile
   npm run build                       # writes dist/ and dist/receiver.html
   ```

3. **Assemble a clean bundle.** It holds only production dependencies, so `typescript` and `jsqr` stay out of the offline machine.

   ```bash
   BUNDLE=~/cold-bundle
   rm -rf "$BUNDLE" && mkdir -p "$BUNDLE/midnight-cold-hot"
   cp "$NODE_TGZ" "$BUNDLE/"
   cp package.json package-lock.json "$BUNDLE/midnight-cold-hot/"
   cp -r dist "$BUNDLE/midnight-cold-hot/"
   cp README.md "$BUNDLE/midnight-cold-hot/"
   cd "$BUNDLE/midnight-cold-hot"
   npm ci --omit=dev --ignore-scripts
   find node_modules \( -name '*.node' -o -name '*.so' \)    # expect no output
   du -sh .
   ```

   `package.json` is required offline because `"type": "module"` in it makes the `dist/*.js` files load as ES modules.
   Native files in the `find` output would need to match the cold CPU and glibc, so look into them before going on.
   If `--ignore-scripts` breaks a package that needs an install script, step 4 will fail and show it.

   The Python QR scanner (`tools/` and `pylibs/`) is added in step 5, just before packing, if you use it.

4. **Test the bundle with no network.** Use a throwaway phrase, on a copy so the bundle stays clean:

   ```bash
   mkdir -p /tmp/ct && tar -xzf "$BUNDLE/node-v22.23.4-linux-x64.tar.gz" -C /tmp/ct
   NODE=/tmp/ct/node-v22.23.4-linux-x64/bin/node
   rm -rf /tmp/ct/test && cp -r "$BUNDLE/midnight-cold-hot" /tmp/ct/test && cd /tmp/ct/test
   COLD_MNEMONIC="$($NODE dist/keygen.js)" unshare -rn $NODE dist/cold-export-public.js
   ```

   `unshare -rn` runs it in a network namespace with no network. If it says "Operation not permitted", use `sudo unshare -n`
   instead, or turn Wi-Fi off. It should print a network and an address and write `cold-public.json` in `/tmp/ct/test`.

5. **Pack and hash.**

   **Optional: include the Python QR scanner.** If you use `tools/qr_scan.py` (section 7b), copy the `tools/` folder and the
   `pylibs/` folder into the bundle before packing. Build `pylibs/` first as described in 7b, for the Python version Tails
   reports (`python3 --version` on the cold machine):

   ```bash
   cp -r "$PROJECT/tools" "$BUNDLE/midnight-cold-hot/"
   cp -r "$PROJECT/pylibs" "$BUNDLE/midnight-cold-hot/"
   ```

   Then pack and hash. The archive includes `tools/` and `pylibs/` if you copied them:

   ```bash
   cd ~ && tar -czf cold-bundle.tar.gz cold-bundle
   sha256sum cold-bundle.tar.gz
   ```

   Write the hash down on paper. A hash file on the same USB stick proves nothing if the stick is tampered with.

6. **Copy `cold-bundle.tar.gz` to a USB stick.** Use one you use only for this, write-protected if it has a switch.

**What goes to the cold machine**

Only `cold-bundle.tar.gz`. It contains:

| In the bundle | Why |
|---|---|
| `node-v22.23.4-linux-x64.tar.gz` | The Node runtime |
| `midnight-cold-hot/package.json` | Needed for ES module loading |
| `midnight-cold-hot/package-lock.json` | Records exact versions |
| `midnight-cold-hot/dist/` | The compiled scripts and `receiver.html` |
| `midnight-cold-hot/node_modules/` | Production dependencies only |
| `midnight-cold-hot/tools/` | `qr_scan.py`, the Python QR scanner. Only if you use it |
| `midnight-cold-hot/pylibs/` | The unzipped OpenCV and NumPy wheels. Only if you use the Python scanner |
| `midnight-cold-hot/README.md` | These instructions, to read on the cold machine |

Leave out `src/`, your dev `node_modules`, `.env`, any `wallet-state-*.json`, snapshots, your Blockfrost token, and
`cold-public.json`. Later the cold machine receives the snapshot (by QR or USB) and sends back `tx.hex`.
Rebuild and re-hash the bundle whenever the code changes.

**On the cold machine (Tails, Offline Mode)**

```bash
cd ~
sha256sum cold-bundle.tar.gz            # must match the number on your paper
tar -xzf cold-bundle.tar.gz && cd cold-bundle
tar -xzf node-v22.23.4-linux-x64.tar.gz
export PATH="$PWD/node-v22.23.4-linux-x64/bin:$PATH"
node --version                          # v22.23.4
cd midnight-cold-hot
node -e "import('@midnight-ntwrk/midnight-js-protocol/ledger').then(() => console.log('ledger loads'))"
# with the Python scanner:
PYTHONPATH=pylibs python3 -c "import cv2, numpy; print(cv2.__version__)"
```

Run everything from your home folder. On Tails it is in RAM, so you copy the bundle again after each reboot unless you use
Persistent Storage. The `ledger loads` line is the check that matters for an older CPU: if it fails, keep the exact error.
Every package in `node_modules` can read your seed on the cold machine, so keep versions pinned and review what you install.
Treat the USB stick as untrusted when it returns from the hot side: the hot scripts validate `tx.hex` as plain hex before
parsing it.

## 6. Verified and still unverified

**Verified on Preprod before the ledger 9 upgrade (SDK 1.2.0, ledger 8):**

- `cold-transfer` builds, signs and finalizes offline with the stub services, and the proof stub is never called for an
  unshielded NIGHT transfer.
- The exported `publicKey`, `addressHex` and `address` are plain strings, and the hot machine can watch the address from them.
- The Blockfrost endpoints work with these scripts on Preprod.
- The whole flow: the public key goes to the hot machine and the sponsor is funded and registered for DUST. The hot machine's
  snapshot reaches the cold machine via Python scanner on Tails. The cold machine builds `tx.hex` and the hot machine submits.
- A tampered `tx.hex` is rejected, and a `tx.hex` submitted after its `TTL_MINUTES` is rejected.

**Verified on Preprod after the ledger 9 upgrade (SDK 2.0.0, ledger 9), 11 November 2026:**

- Sponsor first sync from scratch: ~9.5 h on Preprod. Shielded and DUST wallets crossed to ledger 9 on their own.
  Protocol phase after: `{"_tag":"Settled","version":"2000000"}`, 5000 DUST.
  **Note on protocol versions:** `cold-transfer` will always print "settled at protocol version 2000000" because
  the `assumeLedger9` probe hardcodes `V9NativeForkVersion` (2000000) rather than querying the network. The
  snapshot's `protocolVersion` field records the actual live network version (e.g. `2001100`). Both are ledger 9
  (≥ 2000000); the transaction format is the same; the discrepancy is expected and harmless.
- Full transfer flow end to end: `hot-watch` → `cold-transfer` → `sponsor-submit` → submit.
  Transaction `00ecd050673404bf3a25b187265858ccfa3b880df279d86c9259bb567ca74b6407` confirmed on-chain.
- Sponsor pipeline: `adoptTransaction`, `validateTransaction`, `estimateTransactionFee`, `balanceFinalizedTransaction`,
  `signRecipe`, `finalizeRecipe`, `submitTransaction`.
- `serializeState` / `restore` round-trip: state saved after the first sync and resumed on subsequent runs.
- QR transfer: `receiver.html` on ArchLinux (both directions), Python scanner on TailsOS (hot→cold snapshot).
- All `SDK2-UNVERIFIED` lines now cleared. `keys.ts:59` (same addresses): verified by the working end-to-end run.
  `keys.ts:73` (seed wipe): verified programmatically — `@scure/bip32` hashes the seed via HMAC-SHA512 on entry;
  the original buffer is never stored, so zeroing it has no effect on the derived keys.

**Still unverified:**

- **BIP-39 passphrase** on a wallet created elsewhere. Compare the address `cold-export-public` prints with the
  original wallet's before funding anything (section 3).
- **Custom tokens** (`--token`). The code path exists but nothing has sent one.
- **Networks other than Preprod.** For `undeployed`, `preview` and `mainnet` only the wrong-network refusals were seen.
  Mainnet also needs its own DUST registration path (section 2).
- **T6, T8, T9, T10, T13, T14, T16, T17–T23** (see the test table). Key ones: stale snapshot (T9), sponsor failure
  modes (T13), duplicate submission (T14), network cross-checks (T17–T19).
- **What `sponsor-submit` shows (T20–T22):** the plan display ran on the successful transaction, but T20 (independent
  comparison with `cold-transfer` output) and T22 (stale snapshot warning) were not explicitly checked.
- The sponsor's DUST cap and regeneration rate lines read wallet internals and may not appear if the internal shape changes.
- What 1AM means by "fee 1 DUST" (section 9).
- `qr_scan.py --clipboard`: not yet run on a real machine. Checked with a fake camera and fake clipboard tools (tool
  order, fallbacks, nothing copied on a checksum mismatch); none of `wl-copy`, `xclip`, `xsel` or Tk was available to test for real.

## 7. QR transfer instead of a USB stick

With QR transfer, nothing that has touched the hot machine is ever plugged into the cold machine.
Data crosses the gap through a camera, as text frames that are checked before anything uses them.

**What the checks cover:** each frame must match a strict format, all frames must belong to one
transfer, the SHA-256 must match, decompression is capped (4 MiB by default), and `qr-decode`
checks the content type (`tx` must be hex, `snapshot` must be a JSON object).
**What they don't cover:** the snapshot still goes to the SDK's `restore`, which parses it. A
hostile snapshot should at worst make the transfer fail (see tests T9 and T10), but that parsing
is SDK code I have not audited.

`npm run build` also writes `dist/receiver.html`: one offline page with the QR decoder inlined.
Copy it to both machines. `qr-send` needs only the production dependencies (`qrcode-generator`
has none of its own), so it also works from the cold bundle.

**Cold to hot: the public key**

`cold-public.json` contains only the wallet's public key — no secrets. Copy it to the hot machine by USB or QR. For QR, any 1–12 letter kind label works (the receiver page labels the download with it):

```bash
# cold
node dist/qr-send.js pubkey cold-public.json --html public-key-qr.html
# open public-key-qr.html in the cold browser (or use --term)
# hot: open dist/receiver.html, Start camera, aim at the cold screen, download the file
node dist/qr-decode.js received-pubkey-XXXXXX.mqr cold-public.json
```

**Hot to cold: the snapshot**

```bash
# hot
node dist/qr-send.js snapshot cold-unshielded.snapshot.json --html snapshot-qr.html
# open snapshot-qr.html in a browser, full screen
# cold: open dist/receiver.html in the browser, press Start camera, aim at the hot screen
#       until every square is green, then download the file (received-snapshot-XXXXXX.mqr)
node dist/qr-decode.js received-snapshot-XXXXXX.mqr cold-unshielded.snapshot.json
```

**Cold to hot: the transaction**

```bash
# cold
node dist/qr-send.js tx tx.hex --html tx-qr.html      # open it in the cold browser (or use --term)
# hot: open dist/receiver.html, Start camera, aim at the cold screen, download the file
node dist/qr-decode.js received-tx-XXXXXX.mqr tx.hex
```

`qr-send` prints the first 16 hex characters of the file's SHA-256, and `qr-decode` prints the
same for the file it rebuilt. Compare them by eye; they must match.

**Testing without a camera:** `qr-send ... --mqr frames.mqr`, then `qr-decode frames.mqr out`.
You can also paste the frames into the receiver page's paste box.

**Tips:** frames can arrive in any order and repeats are ignored, so just keep the camera on the
screen until all squares are green. Raise the screen brightness. Use the frame-time slider on the
sender page if frames are missed. `--chunk 200` makes smaller codes (easier in a terminal);
`--chunk 500` makes fewer, denser ones.

**Large files.** One transfer can hold up to 9,999 frames. Each frame carries about 225 bytes of data that cannot
be compressed at `--chunk 300`, or about 750 bytes at `--chunk 1000`, so the ceiling is roughly 2 MB for
random or already-compressed data. The decoder refuses output above 4 MiB unless you pass `--max-bytes`.
Being allowed is not the same as being practical:

- **Time.** At the default 2 frames per second, 8,892 frames is about 74 minutes for one pass of the sender.
- **A missed frame costs a whole pass.** The sender just loops, and the receiver has no way to ask for one frame
  again. With thousands of frames, nearly every pass misses a few.
- **Split big files instead.** Each part is a separate, checked transfer:

```bash
split -b 200K -d file.bin part-                  # creates part-00, part-01, ...
node dist/qr-send.js bin part-00 --html p00.html # send each part; decode each to its own file
cat part-* > file.bin                            # on the receiving machine, in order
sha256sum file.bin                               # must match the sender's file
```

For anything much larger, USB is the better tool.

**Verified (SDK 1):** public key and `tx.hex` cold→hot; snapshot hot→cold via Python scanner on Tails.
**Verified (SDK 2, 11 Nov 2026):** snapshot hot→cold via `receiver.html` on ArchLinux dev machine and Python scanner
on TailsOS; `tx.hex` cold→hot via `qr-send` HTML on cold and `receiver.html` on ArchLinux hot machine.
An offline machine's browser may not give `receiver.html` camera access (for example, Tails does not); use the Python scanner in that case (section 7b). USB still works as a fallback.

## 7b. Python scanner (when the browser cannot use the camera)

`receiver.html` needs the browser to allow camera access, and the offline machine's browser may not (for example, Tails does not allow this). `tools/qr_scan.py` does
the same job from the command line using OpenCV. You only need it on the machine that receives the
snapshot (hot to cold). The cold-to-hot direction can use `receiver.html` in an ordinary browser on the hot machine.

**1. Check the offline machine first**

```bash
python3 --version          # note the major.minor, for example 3.11
ls -l /dev/video*          # a device must be listed; if nothing is, the offline machine cannot see a camera
```

If the device exists but opening it later says "permission denied", check `groups` and who owns `/dev/video0`.

**2. Prepare the libraries on the online machine.** Set `PYVER` to the version from step 1. The ABI tag is derived
from it so the two cannot disagree (a mismatch makes NumPy "not found"):

```bash
PYVER=3.11; ABI=cp${PYVER//./}          # 3.11 -> cp311, 3.9 -> cp39
python3 -m pip download --only-binary=:all: --python-version "$PYVER" --implementation cp \
  --abi "$ABI" --abi abi3 --abi none \
  --platform manylinux_2_28_x86_64 --platform manylinux_2_27_x86_64 --platform manylinux2014_x86_64 \
  "opencv-python>=4.8,<5" numpy -d wheels
mkdir pylibs && for w in wheels/*.whl; do unzip -q "$w" -d pylibs; done
```

`fetch-python-QR-libs.sh` in the repo root automates the above for the current offline machine's platform. The steps inside are specific to that platform; treat it as a reference rather than a universal script if your offline machine differs.

Each backslash must be the last character on its line (no trailing space). If you type the command on one line,
leave the backslashes out. The `<5` keeps OpenCV on the 4.x series this was tested with; OpenCV 5 is untested.
If `python3 --version` on the offline machine reports 3.9, that is probably an old, unsupported Tails release: update Tails first.

A wheel is a zip file, so unzipping it is enough: nothing is installed and no install script runs. Use
`opencv-python-headless` instead of `opencv-python` if you do not need the `--preview` window; it is smaller
and has no GUI dependencies. OpenCV 4.8 or newer matters: it has the better QR detector the script prefers.
Copy `tools/qr_scan.py` and `pylibs/` into your cold bundle.
If the online machine runs the same Python version, check that the libraries load there:

```bash
PYTHONPATH=pylibs python3 -c "import cv2, numpy; print(cv2.__version__, hasattr(cv2, 'QRCodeDetectorAruco'))"
```

**3. On the offline (cold) machine**

```bash
PYTHONPATH=pylibs python3 tools/qr_scan.py --preview
# when it finishes:
node dist/qr-decode.js received-snapshot-XXXXXX.mqr cold-unshielded.snapshot.json
```

Open the sender page on the hot machine (`qr-send ... --html`), make it full screen, turn the brightness up, and hold
that screen so it fills the cold machine's camera view. The `--preview` flag opens a window showing what the camera
sees, which makes it easier to aim and confirm codes are being read. Without it the script prints
"Received N of M frames" for each new frame and "No QR code readable yet" every few seconds when it sees nothing.
Frames can come in any order and repeats are ignored, so keep it steady until it reports all of them.

Options: `--device /dev/video0` (or another index), `--out-dir`, `--timeout SECONDS`, `--preview`, `--clipboard`. If dense
codes are hard to read, make them smaller on the sender (`qr-send ... --chunk 200`) and give the camera more room.

`--clipboard` also puts the frames on the clipboard once the checksum passes, for pages that accept pasted MQR1
text (for example the DUST registration cold page). The `.mqr` file is written either way. It uses `wl-copy`
(Wayland), `xclip` or `xsel` if one is installed; otherwise it opens a small tkinter window that holds the
clipboard until you click *Done* (a Linux clipboard disappears when the program that owns it exits). If none of
these works, it says so and you load the `.mqr` file instead. The frames are not secret, but anything on the
clipboard can be read by other programs in the session.

**Security: this widens what the cold machine parses.** `receiver.html` runs inside a browser sandbox. This script
runs OpenCV's native image and QR code in a normal process. The script itself accepts only text that matches the
exact frame format, but the QR decoding underneath is a large C++ library handling images that the hot machine
controls. A crafted image could in principle exploit a bug in it. If it did, assume the whole offline session is
compromised, including any recovery phrase you type later in that session. Reasonable ways to handle that:

- Run the scanner before you enter any secret in that session, in a terminal where no secret variable is set.
  This helps less than it sounds, because the session is still the same one.
- Use it for test wallets and small amounts, and use USB (sections 3 to 5) for anything you cannot lose.
- Never run it as root, and keep `PYTHONPATH` pointing at libraries you downloaded and checked yourself.

**What was tested.** The frame logic, cross-checked against the Node implementation. OpenCV 4.13 reading generated
dense codes under rotation, blur and noise (the Aruco detector read every 77-module code except one under the heaviest blur
and noise, and the older detector, which the script uses only when Aruco is missing, missed a few in every case). The camera
loop against a simulated webcam, with the output decoded by `qr-decode` to the identical file. **Verified by you:** it works
with a real camera on a TailsOS cold machine (a 2011 CPU), with wheels downloaded for that machine's Python version.

## 8. Audible alerts and progress (`sponsor-register`, `sponsor-submit`)

Both scripts make sounds during long operations so you can step away and return when needed.

**`sponsor-register`**
- **First sync done:** three beeps once `waitForSyncedState` completes on a first-time run (whether or not the protocol check that follows succeeds). Subsequent runs that resume from a saved state do not beep here.

**`sponsor-submit`**
- **First sync done:** three beeps immediately after the wallet state is saved on a first-time run, before any further checks. Lets you know the long sync finished even if the script then exits early (e.g. expired `tx.hex`).
- **Prompt ready:** one beep when the `SUBMIT` prompt appears, then another every 20 seconds until you answer.
- **Finished:** two beeps when the submission (or dry run) completes.

Both scripts print progress while syncing: whether the wallet is resuming from a saved state or syncing from scratch, a "Still syncing..." line every 30 seconds, and "Synced in N s" when done.

| Setting | Effect |
|---|---|
| `NO_BEEP=1` | Turns all beeps off |
| `BEEP_CMD="..."` | Also runs this command at each beep, for when the terminal bell is muted |
| `LOG_VERBOSE=1` | Show the full SDK log output instead of collapsing `Wallet.Sync` / `API-WS` lines. Applies to all scripts, including `cold-transfer`. |

```bash
NO_BEEP=1 npm run hot:sponsor-submit
BEEP_CMD="paplay /usr/share/sounds/freedesktop/stereo/complete.oga" npm run hot:sponsor-submit
LOG_VERBOSE=1 node dist/cold-transfer.js ...    # see the full SDK connection error details
```

`BEEP_CMD` runs through your shell, so only set it yourself, in your own terminal. The beep is the
terminal bell character, so if you hear nothing, check that your terminal's bell is enabled (in GNOME
Terminal, in the profile preferences). The beep is written only when output goes to a terminal.

**Why the script is slow, and what to look at:**

- **No saved state.** The first run syncs the whole chain. Running `sponsor-register` to completion
  saves the state; `sponsor-submit` then resumes from it. If the startup line says "No saved state"
  after a completed register run, the state file name differs between the two scripts; report it.
- **A stale saved state.** Only the gap since the last save needs syncing, so this should be quicker.
- **Blockfrost sync lag.** The docs say that on an idle subscription the indexer reports unshielded sync
  progress less often, backing off to about 4 minutes (up to about 5 with jitter). So the wallet's "fully
  synced" signal can lag a few minutes behind, even with a fresh saved state. Part of the wait may be this,
  and not something to fix.
- **Proving after you type `SUBMIT`.** The sponsor's DUST spend is proved on the proof server. The docs
  say proving can take several minutes in the worst case; a proof server on another machine adds
  network time.

`cold-transfer` does not beep: its prompt appears immediately.

## 9. Reading the `sponsor-submit` output

**UTXOs.** A UTXO is one coin in a wallet, and the wallet's balance is the sum of its coins. The `UTXOs:` list shows the From
wallet's coins (from the snapshot file). `[spent]` marks the coins this transaction uses up and `[kept]` the ones it leaves
alone. The short id is the first eight characters of the transaction that created the coin, then its output number. Without a
usable snapshot only the spent coins are listed, from the transaction itself, and the rest of the wallet is unknown.

**Change.** When a coin is larger than what you send, the rest returns to the sender as a new coin: that is the change.
`cold-transfer` has no option for a different change address. The SDK's `transferTransaction` takes the outputs, the keys, a
`ttl` and `payFees`, and I found no setting for one. The `Change` line only labels the output that goes back to the From address.

**"Fallible".** A Midnight transaction has a guaranteed part, which always applies once the transaction is included, and fallible
parts, which can fail without cancelling the whole transaction. The fee is taken in the guaranteed part. The SDK puts the
recipient's output of a plain transfer in a fallible part by default, which is why you saw `[fallible section]` next to `To:`.
It is now a single note instead of a tag on that line. If that part failed (for example, a coin had already been spent), the
fee would still be taken but the transfer would not happen; I read in the Manage DUST guide that the indexer reports this as a
partial success. Nothing for you to do: it is the normal shape of a transfer from this SDK.

**The DUST fee.** It comes from the sponsor wallet, the only wallet holding DUST. The cold wallet pays nothing in DUST because
it builds with `payFees: false`. Its address is the `Sponsor DUST address` line. Your run:

| Figure | What it is | Value |
|---|---|---|
| Declared fee | What the wallet takes from its DUST. A DUST spend gets no refund | 0.300000000000001 DUST |
| of which overhead | `ADDITIONAL_FEE_OVERHEAD` in `config.ts` | 0.300000000000000 DUST |
| of which price and margin | What the ledger charges, and what block explorers show | 1 SPECK |

One DUST is 10^15 SPECK, so 1 SPECK is far too small to notice. The explorer's "1 SPECK" is the ledger's price. It never sees the
overhead, which is the part the sponsor really pays.

**Why the sponsor's balance did not move.** Your sponsor held exactly 30,000 DUST. My inference is that this is its cap, because
the cap is 5 DUST per registered NIGHT, which would mean 6,000 NIGHT registered. A wallet below its cap regenerates DUST
continuously, at about 0.0496 DUST per second for a 30,000 cap if the fill time is the 604,815 seconds I used. At that rate 0.3
DUST is earned back in about six seconds, so by the time you looked the balance was full again. The script reads the real cap
and rate when it can and prints them, along with the refill time.

**1AM showing "1 DUST".** I cannot see how 1AM computes it. The number equals the explorer's raw 1 SPECK, so my best guess is the
same value shown with the wrong unit. The authority is the transaction itself: the `Declared fee in the final transaction` line
comes from the DUST spends inside it. Because the sponsor refills so fast, even a true 1 DUST would not show in its balance, so
the balance cannot settle this; the declared fee can.

**Lowering the overhead.** Each transfer costs the sponsor the whole 0.3 DUST overhead. You can change
`ADDITIONAL_FEE_OVERHEAD` in `config.ts`. It is a safety margin: if the fee the ledger requires rose above what was declared,
the transaction would be rejected. I have not tested a lower value, and with a full 30,000 DUST that refills in seconds there
is little reason to change it.

**`Wallet.Sync: [object CloseEvent]`.** The WebSocket connection to the indexer dropped while syncing. The SDK reconnects and
carries on, and your run still reached "Synced". It matters only if the sync never finishes.

**Tokens in logs.** Your log contained your Blockfrost token because the node library prints its connection URL when it
disconnects. The scripts now redact it (section 2). Revoke any token that has been posted anywhere.
