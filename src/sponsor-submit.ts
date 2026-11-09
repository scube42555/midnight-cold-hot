// Run on the HOT machine. Takes the finalized transaction from the cold machine, adds DUST to pay the fee
// from the sponsor wallet, and submits it.
//
// Usage: node dist/sponsor-submit.js [tx.hex] [--dry-run]
// --dry-run balances and finalizes (proving locally) but does not submit.
//
// Before asking you to confirm it shows who sends and receives, the From wallet's balance and coins (from
// cold-unshielded.snapshot.json, or SNAPSHOT_FILE, if present), the sponsor's addresses and DUST balance, and the
// DUST fee. The transaction is balanced first so the fee is known; answering anything but SUBMIT releases the DUST.
// It prints the start and finish time so you can see how long each run takes.
import { ADDITIONAL_FEE_OVERHEAD, NETWORK } from './config.js';
import { checkColdPublicNetwork } from './crosscheck.js';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { deriveWalletKeys, readSeed } from './keys.js';
import { fromHex } from './hex.js';
import { beep } from './beep.js';
import { describePlan, declaredDustFee, formatDust, readTransaction, type TxDetails } from './txinfo.js';
import { inspectSnapshot, type SnapshotInfo } from './snapshot.js';
import { elapsed, localStamp } from './timefmt.js';
import { DustAddress, UnshieldedAddress } from '@midnightntwrk/wallet-sdk';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { buildWallet, loadWalletState, saveWalletState, submitWithRetry, walletStateFile } from './wallet.js';

// Time first, so a run can be timed from its first line to its last, however it ends.
const startedAt = new Date();
console.log(`Started:  ${localStamp(startedAt)}`);
process.on('exit', () => console.log(`Finished: ${localStamp(new Date())}  (total ${elapsed(Date.now() - startedAt.getTime())})`));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const txFile = args.find((a) => !a.startsWith('--')) ?? 'tx.hex';

// Stop before any file is parsed or any network is contacted if cold-public.json is for another network.
checkColdPublicNetwork(NETWORK);
console.log(`Network: ${NETWORK}`);

// Validate before parsing: only a plain hex string is accepted.
const hex = readFileSync(txFile, 'utf8').trim();
if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error(`${txFile} is not a hex string.`);
const userTx = ledger.Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.Binding>(
  'signature',
  'proof',
  'binding',
  fromHex(hex),
);
console.log(`Read ${txFile}: ${hex.length / 2} bytes, deserialized OK.`);

// The From wallet's coins and balance come from the snapshot that hot-watch wrote; skip them if there is none.
let snapshot: SnapshotInfo | undefined;
const snapshotFile = process.env.SNAPSHOT_FILE ?? 'cold-unshielded.snapshot.json';
if (existsSync(snapshotFile)) {
  try {
    snapshot = inspectSnapshot(readFileSync(snapshotFile, 'utf8'));
    if (snapshot.network !== NETWORK) {
      console.warn(`Ignoring ${snapshotFile}: it is for network "${snapshot.network}", not "${NETWORK}".`);
      snapshot = undefined;
    }
  } catch (err) {
    console.warn(`Ignoring ${snapshotFile}: ${(err as Error).message}`);
  }
}

// Show what this transaction does before the slow sync, so you can stop early if it is not what you expect.
// If the contents cannot be read, say so and carry on: the cold machine already showed you what it signed.
try {
  const details: TxDetails = readTransaction(userTx as never, {
    addressOfKey: (key) => ledger.addressFromKey(key),
    bech32: (addressHex) =>
      UnshieldedAddress.codec.encode(getNetworkId(), new UnshieldedAddress(Buffer.from(addressHex, 'hex'))).asString(),
  });
  console.log('');
  for (const line of describePlan(details, snapshot)) console.log(line);
  console.log('');
} catch (err) {
  console.warn(`Could not read the transaction's contents (${(err as Error).message}); the addresses are not shown.`);
}

const seed = readSeed('SPONSOR');
const keys = deriveWalletKeys(seed);
seed.fill(0);
console.log(`Sponsor:  ${keys.unshieldedKeystore.getBech32Address().asString()}`);
const stateFile = walletStateFile(keys);

const saved = await loadWalletState(stateFile);
console.log(saved ? `Resuming sponsor wallet from ${stateFile}.` : `No saved state (${stateFile}): syncing from scratch, which is slow.`);
const wallet = await buildWallet(keys, saved);

// An unsynced sponsor gets error 170 (InvalidDustSpendProof), so wait for a full sync.
const syncStarted = Date.now();
const heartbeat = setInterval(
  () => console.log(`Still syncing the sponsor wallet (${Math.round((Date.now() - syncStarted) / 1000)} s)...`),
  30_000,
);
const synced = await wallet.waitForSyncedState();
clearInterval(heartbeat);
console.log(`Synced in ${elapsed(Date.now() - syncStarted)} (at ${localStamp(new Date())}).`);

const dustBefore = synced.dust.balance(new Date());
console.log(`Sponsor DUST address: ${String(DustAddress.encodePublicKey(getNetworkId(), synced.dust.publicKey))}`);
console.log(`Sponsor DUST balance: ${formatDust(dustBefore)} DUST`);

// The cap and refill rate explain why a small fee can leave no visible dent. This reads internal wallet state,
// so it is optional: if the shape differs it prints nothing.
let refillRate: bigint | undefined; // SPECK per second while below the cap
try {
  const dust = synced.dust as unknown as {
    availableCoins: { dtime?: unknown; maxCap: bigint }[];
    state: { state: { params: { timeToCapSeconds: bigint | number } } };
  };
  const cap = dust.availableCoins.filter((c) => c.dtime === undefined).reduce((t, c) => t + c.maxCap, 0n);
  const timeToCap = BigInt(dust.state.state.params.timeToCapSeconds);
  if (cap > 0n && timeToCap > 0n) {
    refillRate = cap / timeToCap;
    console.log(`Sponsor DUST cap:     ${formatDust(cap)} DUST, regenerating about ${formatDust(refillRate)} DUST per second below the cap.`);
  }
} catch {
  /* cap not available in this version */
}

// Balance first, so the fee is known before you are asked to confirm. Nothing is signed, proved or submitted yet.
// A rejected build locks nothing; a successful one locks the sponsor's DUST until it is used or reverted.
let recipe;
try {
  recipe = await wallet.balanceFinalizedTransaction(
    userTx,
    { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
    { ttl: new Date(Date.now() + 60 * 60 * 1000), tokenKindsToBalance: ['dust'] },
  );
} catch (err) {
  console.error(`Could not add the fee: ${(err as Error).message}`);
  console.error('Nothing was locked or submitted. Check the sponsor has DUST (sponsor-register) and is fully synced.');
  await wallet.stop();
  beep(2);
  process.exit(1);
}

const fee = recipe.type === 'FINALIZED_TRANSACTION' ? declaredDustFee(recipe.balancingTransaction as never) : undefined;
if (fee === undefined) {
  console.log('DUST fee: not known yet (unexpected recipe type).');
} else {
  console.log(`DUST fee: ${formatDust(fee)} DUST declared. The wallet takes all of it from the sponsor's DUST and gets none back.`);
  if (fee >= ADDITIONAL_FEE_OVERHEAD) {
    console.log(`          = ${formatDust(ADDITIONAL_FEE_OVERHEAD)} DUST extra overhead (config.ts) + ${fee - ADDITIONAL_FEE_OVERHEAD} SPECK for the ledger's price and margin.`);
    console.log('          Block explorers show the ledger\'s price (the SPECK part), not the declared amount.');
  }
  console.log(`Sponsor DUST after:   about ${formatDust(dustBefore - fee)} DUST right after the spend.`);
  if (refillRate !== undefined && refillRate > 0n) {
    console.log(`          At the regeneration rate above, the fee is earned back in about ${elapsed(Number((fee * 1000n) / refillRate))}.`);
  }
}
console.log('');

const rl = createInterface({ input: process.stdin, output: process.stdout });
beep(); // the prompt is ready
const reminder = setInterval(beep, 20_000); // keep reminding until you answer
const answer = await rl.question(
  `The sponsor wallet will pay the fee${dryRun ? ' (dry run, no submission)' : ' and submit this transaction'}. Type SUBMIT to continue: `,
);
clearInterval(reminder);
rl.close();
if (answer.trim() !== 'SUBMIT') {
  try {
    await wallet.revert(recipe); // release the DUST that balancing locked
    console.log('Cancelled. The sponsor\'s DUST was released.');
  } catch (err) {
    console.log(`Cancelled. Releasing the DUST failed (${(err as Error).message}); it frees up when the transaction expires.`);
  }
  await wallet.stop();
  process.exit(1);
}

const proveStarted = Date.now();
const signed = await wallet.signRecipe(recipe, (data) => keys.unshieldedKeystore.signData(data));
const finalized = await wallet.finalizeRecipe(signed); // proves the sponsor's DUST spend via the proof server
console.log(`Signed and proved in ${elapsed(Date.now() - proveStarted)}.`);

const declared = declaredDustFee(finalized as never);
console.log(`Declared fee in the final transaction: ${formatDust(declared)} DUST${fee !== undefined && declared !== fee ? ' (differs from the estimate above)' : ''}.`);

if (dryRun) {
  try {
    await wallet.revert(finalized); // a dry run must not leave the sponsor's DUST locked
    console.log('Dry run complete: balanced and finalized, not submitted. The sponsor\'s DUST was released.');
  } catch (err) {
    console.log(`Dry run complete, not submitted. Releasing the DUST failed (${(err as Error).message}); it frees up when the transaction expires.`);
  }
} else {
  const txId = await submitWithRetry(wallet, finalized);
  console.log(`Submitted transaction ${txId}`);
}

await saveWalletState(wallet, stateFile);
await wallet.stop();
beep(2); // finished
process.exit(0);
