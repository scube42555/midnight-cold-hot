// Run on the HOT machine. Watches the cold wallet's unshielded address using its public key only,
// then writes a snapshot of the wallet's coins for the cold machine. No secret key is involved.
import { NETWORK, hotEndpoints, walletConfig } from './config.js';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { UnshieldedAddress, UnshieldedWallet, type PublicKey } from '@midnightntwrk/wallet-sdk';
import { NIGHT } from './txinfo.js';

console.log(`Network: ${NETWORK}`);
const publicFile = process.argv[2] ?? 'cold-public.json';
const outFile = process.argv[3] ?? 'cold-unshielded.snapshot.json';
const timeoutMinutes = Number(process.env.WATCH_TIMEOUT_MINUTES ?? '10');

const pub = JSON.parse(readFileSync(publicFile, 'utf8')) as Record<string, unknown>;
if (pub.network !== NETWORK) throw new Error(`${publicFile} is for network "${String(pub.network)}", expected "${NETWORK}".`);
if (pub.sdk !== 2) {
  throw new Error(`${publicFile} was written for wallet SDK 1.x (no "sdk": 2). Run cold-export-public again with this version.`);
}
if (typeof pub.address !== 'string') throw new Error(`${publicFile}: "address" must be a string.`);
if (typeof pub.publicKey !== 'object' || pub.publicKey === null) throw new Error(`${publicFile}: "publicKey" must be an object.`);

// The object the cold machine wrote, handed back as it is. SDK2-UNVERIFIED: that it survives the JSON round trip.
const coldPublicKey = pub.publicKey as unknown as PublicKey;

const config = walletConfig(hotEndpoints());
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
console.log(`NIGHT (STAR):    ${state.balances[night] ?? 0n}`);
for (const [token, balance] of Object.entries(state.balances as Record<string, bigint>)) {
  if (token !== night) console.log(`Token ${token}: ${balance}`);
}
console.log(`Wrote ${outFile}. Copy it to the cold machine.`);
await watcher.stop();
process.exit(0);
