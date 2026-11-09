// Run on the COLD machine, offline. Builds, signs and finalizes an unshielded NIGHT transfer and writes it
// as a hex file. The fee is paid later by the hot machine's sponsor wallet (payFees: false).
//
// Usage: node dist/cold-transfer.js <recipient address> <amount> [snapshot] [out] [--token <64 hex>]
// Without --token the transfer is NIGHT and the amount is in STAR (1 NIGHT = 1,000,000 STAR).
// With --token the amount is in that token's smallest unit, exactly as the snapshot counts it.
import { NETWORK, coldEndpoints, walletConfig } from './config.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { NEVER } from 'rxjs';
import {
  WalletFacade,
  ShieldedWallet,
  DustWallet,
  UnshieldedWallet,
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnightntwrk/wallet-sdk';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deriveWalletKeys, readSeed } from './keys.js';
import { toHex } from './hex.js';
import { assertSnapshotFor, inspectSnapshot } from './snapshot.js';

const nightType = ledger.unshieldedToken().raw;
let tokenType: typeof nightType = nightType;
const argv = process.argv.slice(2);
const tokenFlag = argv.indexOf('--token');
if (tokenFlag >= 0) {
  const value = argv[tokenFlag + 1];
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) throw new Error('--token needs a 64-character hex token type.');
  tokenType = value.toLowerCase() as typeof nightType;
  argv.splice(tokenFlag, 2);
}
const isNight = tokenType === nightType;

const [to, amountText, snapshotPath = 'cold-unshielded.snapshot.json', outPath = 'tx.hex'] = argv;
if (!to || !amountText) {
  throw new Error('Usage: node dist/cold-transfer.js <recipient> <amount> [snapshot] [out] [--token <64 hex>]');
}
if (!/^[1-9][0-9]*$/.test(amountText)) throw new Error('The amount must be a positive whole number, digits only.');
const amount = BigInt(amountText);
const ttlMinutes = Number(process.env.TTL_MINUTES ?? '120');
if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new Error('TTL_MINUTES must be a positive number.');

const formatNight = (star: bigint): string =>
  `${star / 1_000_000n}.${(star % 1_000_000n).toString().padStart(6, '0')}`;

// The snapshot must be for the network this run is set to. Checked first, before any key is touched.
const snapshot = readFileSync(snapshotPath, 'utf8');
const info = inspectSnapshot(snapshot);
assertSnapshotFor(info, { network: NETWORK });

// Decoding rejects an address from another network or another address type.
const receiverAddress = MidnightBech32m.parse(to).decode(UnshieldedAddress, getNetworkId());

const seed = readSeed('COLD');
const keys = deriveWalletKeys(seed);
seed.fill(0);
const ownAddress = keys.unshieldedKeystore.getBech32Address().asString();

// The snapshot must also belong to this wallet, and hold enough of the token to be sent.
assertSnapshotFor(info, { network: NETWORK, address: ownAddress });
const available = info.available.get(tokenType) ?? 0n;
if (amount > available) {
  throw new Error(`The snapshot holds only ${available} of this token (type ${tokenType}) and ${amount} was requested.`);
}
if (info.pendingCount > 0) {
  console.warn(`WARNING: the snapshot lists ${info.pendingCount} pending UTXO(s): a transaction from this address may be in flight.`);
  console.warn('Take a fresh snapshot once nothing is pending, or this transfer may fail.');
}

// ---- Stubs: the cold machine must never prove remotely, submit, or contact an indexer. ----
let proverRequested = false;
const refuse = (what: string) => () => {
  proverRequested = true;
  return Promise.reject(new Error(`${what} requested on the cold machine`));
};
const coldProving = {
  // Proves a transaction that needs no proofs. If a proof is ever needed, fail instead of reaching a server.
  prove: (tx: ledger.UnprovenTransaction) =>
    tx.prove({ prove: refuse('Proof'), check: refuse('Proof check') } as never, ledger.CostModel.initialCostModel()),
};
const coldSubmission = {
  submitTransaction: () => Promise.reject(new Error('Submission is disabled on the cold machine')),
  close: () => Promise.resolve(),
} as never;
const coldPending = {
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  state: () => NEVER,
  addPendingTransaction: () => Promise.resolve(),
  clear: () => Promise.resolve(),
} as never;

const facade = await WalletFacade.init({
  configuration: walletConfig(coldEndpoints()),
  provingService: () => coldProving,
  submissionService: () => coldSubmission,
  pendingTransactionsService: () => coldPending,
  shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(keys.shieldedSecretKeys),
  unshielded: (cfg) => UnshieldedWallet(cfg).restore(snapshot),
  dust: (cfg) =>
    DustWallet(cfg).startWithSecretKey(keys.dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
});
// Do not call facade.start(): it starts background sync for all three wallets.

// ---- Review before anything is signed. ----
const expires = new Date(Date.now() + ttlMinutes * 60_000);
console.log('');
console.log(`Network:    ${NETWORK}`);
console.log(`From:       ${ownAddress}`);
console.log(`To:         ${to}`);
console.log(`Token:      ${isNight ? 'NIGHT' : `custom token ${tokenType}`}`);
console.log(
  isNight
    ? `Available:  ${available} STAR (${formatNight(available)} NIGHT) in the snapshot`
    : `Available:  ${available} in the snapshot`,
);
console.log(
  isNight
    ? `Amount:     ${amount} STAR (${formatNight(amount)} NIGHT)`
    : `Amount:     ${amount} (smallest units of that token; its decimals are not known here)`,
);
console.log(`Expires:    ${expires.toISOString()}  (TTL ${ttlMinutes} minutes)`);
console.log('Fee:        paid by the hot machine\'s sponsor wallet');
console.log('');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('Check the recipient and amount above. Type SEND to sign: ');
rl.close();
if (answer.trim() !== 'SEND') {
  console.log('Cancelled. Nothing was signed.');
  process.exit(1);
}

const recipe = await facade.transferTransaction(
  [{ type: 'unshielded', outputs: [{ type: tokenType, receiverAddress, amount }] }],
  { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
  { ttl: expires, payFees: false },
);
const signed = await facade.signRecipe(recipe, (data) => keys.unshieldedKeystore.signData(data));
const finalized = await facade.finalizeRecipe(signed);

writeFileSync(outPath, toHex(finalized.serialize()), { mode: 0o600 });
console.log(`Wrote ${outPath}. The proof stub was ${proverRequested ? 'CALLED (unexpected)' : 'not called'}.`);
console.log('Copy it to the hot machine and run the sponsor submit step before the expiry time above.');
process.exit(0);
