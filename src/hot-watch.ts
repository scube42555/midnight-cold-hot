// Run on the HOT machine. Watches the cold wallet's unshielded address using its public key only,
// then writes a snapshot of the wallet's coins for the cold machine. No secret key is involved.
import { NETWORK, hotEndpoints, walletConfig } from './config.js';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DefaultForkSchedule, UnshieldedAddress, UnshieldedWallet, type PublicKey } from '@midnightntwrk/wallet-sdk';
import { NIGHT } from './txinfo.js';
import { inspectSnapshot } from './snapshot.js';

console.log(`Network: ${NETWORK}`);
// Usage: node dist/hot-watch.js [--no-probe] [cold-public.json] [snapshot out]
// The watcher starts on the ledger 9 variant (assumeLedger9 in config.ts), so the snapshot is written by it: measured, a watcher
// without the probe wrote "written by v1" at protocol version 1000300, and an offline cold machine restoring that would build ledger 8.
// --no-probe leaves the choice to the SDK (for a chain still on ledger 8).
const cliArgs = process.argv.slice(2);
const wantLedger9 = !cliArgs.includes('--no-probe');
const positional = cliArgs.filter((a) => !a.startsWith('--'));
const publicFile = positional[0] ?? 'cold-public.json';
const outFile = positional[1] ?? 'cold-unshielded.snapshot.json';
const timeoutMinutes = Number(process.env.WATCH_TIMEOUT_MINUTES ?? '10');

const pub = JSON.parse(readFileSync(publicFile, 'utf8')) as Record<string, unknown>;
if (pub.network !== NETWORK) throw new Error(`${publicFile} is for network "${String(pub.network)}", expected "${NETWORK}".`);
if (pub.sdk !== 2) {
  throw new Error(`${publicFile} was written for wallet SDK 1.x (no "sdk": 2). Run cold-export-public again with this version.`);
}
if (typeof pub.address !== 'string') throw new Error(`${publicFile}: "address" must be a string.`);
if (typeof pub.publicKey !== 'object' || pub.publicKey === null) throw new Error(`${publicFile}: "publicKey" must be an object.`);

// The object the cold machine wrote, handed back as it is. Verified (11 Nov 2026): survives the JSON round trip.
const coldPublicKey = pub.publicKey as unknown as PublicKey;

// The standalone unshielded wallet needs the resolved fork schedule that the facade fills in for itself (the compiler asked for
// `forks`). Verified (11 Nov 2026): DefaultForkSchedule is correct; snapshot written by v2 at protocol version 2000000.
const config = { ...walletConfig(hotEndpoints(), { assumeLedger9: wantLedger9 }), forks: DefaultForkSchedule };
console.log(`Chain version:    ${wantLedger9 ? 'assumed to be ledger 9' : 'left to the SDK (--no-probe)'}`);
const watcher = await UnshieldedWallet(config).startWithPublicKey(coldPublicKey); // returns a Promise in SDK 2
await watcher.start();

// A wallet can report "synced" with no coins at the very start, so wait until coins appear
// and nothing from this address is still pending.
const deadline = Date.now() + timeoutMinutes * 60_000;
let state = await watcher.waitForSyncedState();
while (!(state.availableCoins.length > 0 && state.pendingCoins.length === 0)) {
  if (Date.now() > deadline) {
    throw new Error(
      `Timed out after ${timeoutMinutes} minutes: available coins=${state.availableCoins.length}, pending=${state.pendingCoins.length}.`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  state = await watcher.waitForSyncedState();
}

// Check that we are watching the address we meant to watch.
const watched = UnshieldedAddress.codec.encode(config.networkId, state.address).asString();
if (watched !== pub.address) throw new Error(`Watching ${watched}, but ${publicFile} says ${String(pub.address)}.`);

const snapshot = await watcher.serializeState();
writeFileSync(`${outFile}.tmp`, snapshot, { mode: 0o600 });
renameSync(`${outFile}.tmp`, outFile);

console.log(`Address:         ${watched}`);
console.log(`Available coins: ${state.availableCoins.length}`);
const night = NIGHT; // the token type of NIGHT is all zeros
const nightStar = state.balances[night] ?? 0n;
console.log(`NIGHT (STAR):    ${nightStar}`);
for (const [token, balance] of Object.entries(state.balances as Record<string, bigint>)) {
  if (token !== night) console.log(`Token ${token}: ${balance}`);
}
const written = inspectSnapshot(snapshot);
console.log(`Snapshot format:  ${written.format ?? 'none (SDK 1.x)'}, written by ${written.writtenBy ?? 'unknown'}`);
console.log(`Protocol version: ${written.protocolVersion ?? 'not recorded'}  (the wallet's own record; the docs treat >= 2000000 as ledger 9 for the chain. See MIGRATION-LEDGER9.md)`);
console.log(`Wrote ${outFile}. Copy it to the cold machine.`);
await watcher.stop();
process.exit(0);
