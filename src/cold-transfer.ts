// Run on the COLD machine, offline. Builds, signs and finalizes an unshielded transfer and writes it as a hex file.
// The fee is paid later by the hot machine's sponsor wallet (payFees: false).
//
// Usage: node dist/cold-transfer.js <recipient address> <amount> [snapshot] [out] [--token <64 hex>]
// Without --token the transfer is NIGHT and the amount is in STAR (1 NIGHT = 1,000,000 STAR).
// With --token the amount is in that token's smallest unit, exactly as the snapshot counts it.
//
// Wallet SDK 2. Measured on the probe: an offline facade starts (the wallets log connection errors and carry on), and with the
// chain-version probe and a snapshot written by hot-watch it settles on ledger 9. Everything else here follows the facade's type
// definitions; verified end to end on Preprod, 11 Nov 2026.
import { NETWORK, NETWORK_ID, coldEndpoints, walletConfig } from './config.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { firstValueFrom, timeout } from 'rxjs';
import {
  DustWallet,
  MidnightBech32m,
  ProtocolVersion,
  ShieldedWallet,
  UnshieldedAddress,
  UnshieldedWallet,
  WalletFacade,
} from '@midnightntwrk/wallet-sdk';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import { deriveAndWipe, readSeed } from './keys.js';
import { toHex } from './hex.js';
import { assertLedger9, assertSnapshotFor, inspectSnapshot } from './snapshot.js';
import { NIGHT, formatNight } from './txinfo.js';
import { elapsed, localStamp } from './timefmt.js';

const startedAt = Date.now();
let tokenType: string = NIGHT;
const argv = process.argv.slice(2);
const tokenFlag = argv.indexOf('--token');
if (tokenFlag >= 0) {
  const value = argv[tokenFlag + 1];
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) throw new Error('--token needs a 64-character hex token type.');
  tokenType = value.toLowerCase();
  argv.splice(tokenFlag, 2);
}
const isNight = tokenType === NIGHT;

const [to, amountText, snapshotPath = 'cold-unshielded.snapshot.json', outPath = 'tx.hex'] = argv;
if (!to || !amountText) {
  throw new Error('Usage: node dist/cold-transfer.js <recipient> <amount in STAR> [snapshot] [out] [--token <64 hex>]\n  Amount is in the token\'s smallest unit (STAR for NIGHT; 1 NIGHT = 1,000,000 STAR). Digits only or comma-separated: "1000000" or "1,000,000".');
}
// Accept plain digits or thousands-separated digits (e.g. "1000000" or "1,000,000").
// Commas must appear as proper thousands separators; "1,2" is rejected, not silently treated as 12.
const amountNoCommas = amountText.replace(/,/g, '');
if (!/^[1-9][0-9]{0,2}(,[0-9]{3})*$/.test(amountText) && !/^[1-9][0-9]*$/.test(amountText)) {
  throw new Error("The amount must be a positive whole number in the token's smallest unit: digits only or with commas as thousands separators, e.g. \"1000000\" or \"1,000,000\".");
}
const amount = BigInt(amountNoCommas);
const ttlMinutes = Number(process.env.TTL_MINUTES ?? '120');
if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new Error('TTL_MINUTES must be a positive number.');

// The snapshot must be for this network and already on ledger 9. Checked first, before any key is touched.
const snapshot = readFileSync(snapshotPath, 'utf8');
const info = inspectSnapshot(snapshot);
assertSnapshotFor(info, { network: NETWORK });
assertLedger9(info);

// Decoding rejects an address from another network or another address type.
const receiverAddress = MidnightBech32m.parse(to).decode(UnshieldedAddress, NETWORK_ID);

const keys = deriveAndWipe(readSeed('COLD'));
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

// ---- Stubs: the cold machine must never prove remotely or submit. ----
let proverRequested = false;
const refuse = (what: string) => () => {
  proverRequested = true;
  return Promise.reject(new Error(`${what} requested on the cold machine`));
};
// Proves a transaction that needs no proofs. If a proof is ever needed, fail instead of reaching a server.
// Ledger 9's proving provider has three methods, not two: the first run died with "expected proving provider property 'lookupKey' to be
// a function". Any of the three being called sets proverRequested and rejects.
// Verified (11 Nov 2026): CostModel.initialCostModel() accepted; stub not called for an unshielded transfer.
const coldProving = {
  prove: (transaction: unknown, protocolVersion: bigint) => {
    if (protocolVersion < ProtocolVersion.V9NativeForkVersion) {
      throw new Error(`The cold wallet is acting at protocol version ${protocolVersion}, below ledger 9. A ledger 8 transaction would be refused.`);
    }
    return (transaction as { prove: (provider: unknown, costModel: unknown) => Promise<unknown> }).prove(
      { prove: refuse('Proof'), check: refuse('Proof check'), lookupKey: refuse('Proving key lookup') },
      ledgerV9.CostModel.initialCostModel(),
    );
  },
} as never;
const coldSubmission = {
  submitTransaction: () => Promise.reject(new Error('Submission is disabled on the cold machine')),
  close: () => Promise.resolve(),
} as never;

// Offline: the wallets cannot reach an indexer, and say so. That is expected and harmless here.
console.log(`Started: ${localStamp(new Date(startedAt))}`);
console.log('Starting the wallets offline. Lines saying "Wallet.Sync" or "API-WS: disconnected" are the wallets failing to reach an indexer or node: expected.');

// The facade's default lifecycle service is used as it is: the probe showed it works offline. Validation and block-data services are
// the indexer-backed defaults and are not used for an unshielded transfer without a fee.
const facade = await WalletFacade.init({
  configuration: walletConfig(coldEndpoints()),
  provingService: () => coldProving,
  submissionService: () => coldSubmission,
  shielded: (cfg) => ShieldedWallet(cfg).startWithSeed(keys.seeds.shielded),
  unshielded: (cfg) => UnshieldedWallet(cfg).restore(snapshot),
  dust: (cfg) => DustWallet(cfg).startWithSeed(keys.seeds.dust),
});
await facade.start(keys.seeds);

// Stop here, before any prompt, if the wallets are not settled on ledger 9: a transaction built now would be refused.
const state = await firstValueFrom(facade.state().pipe(timeout(30_000)));
const protocol = state.protocol;
if (protocol._tag !== 'Settled' || protocol.version < ProtocolVersion.V9NativeForkVersion) {
  throw new Error(
    `The wallets are not settled on ledger 9 (phase ${JSON.stringify(protocol, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}). ` +
      'A transaction built now could be refused. Take a new snapshot with hot-watch and try again.',
  );
}
console.log(`Wallets settled at protocol version ${String(protocol.version)} (ledger 9).`);

// ---- Review before anything is signed. ----
const expires = new Date(Date.now() + ttlMinutes * 60_000);
console.log('');
console.log(`Network:    ${NETWORK}`);
console.log(`From:       ${ownAddress}`);
console.log(`To:         ${to}`);

// All token balances from the snapshot so you can verify the hex type matches the token you intend to transfer.
console.log('Snapshot token balances:');
for (const [type, bal] of info.available) {
  if (type === NIGHT) {
    console.log(`  NIGHT  (${type.slice(0, 8)}...${type.slice(-8)}): ${bal} STAR (${formatNight(bal)} NIGHT)`);
  } else {
    console.log(`  Token  (${type.slice(0, 8)}...${type.slice(-8)}): ${bal} (smallest units)`);
  }
}

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
console.log(`Expires:    ${localStamp(expires)}  (TTL ${ttlMinutes} minutes)`);
console.log('Fee:        paid by the hot machine\'s sponsor wallet');
console.log('');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('Check the recipient and amount above. Type SEND to sign: ');
rl.close();
if (answer.trim() !== 'SEND') {
  console.log('Cancelled. Nothing was signed.');
  process.exit(1);
}

let stage = 'building the transfer';
let finalized;
try {
  const recipe = await facade.transferTransaction(
    [{ type: 'unshielded', outputs: [{ type: tokenType as never, receiverAddress, amount }] }],
    { ttl: expires, payFees: false },
  );
  stage = 'signing';
  const signed = await facade.signRecipe(recipe, keys.unshieldedKeystore.signDataAsync);
  stage = 'proving and binding (finalizing)';
  finalized = await facade.finalizeRecipe(signed);
} catch (err) {
  console.error(`Failed while ${stage}: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`The proof stub was ${proverRequested ? 'CALLED, so this transaction needs a proof the cold machine cannot make' : 'not called'}. Nothing was written.`);
  process.exit(1);
}

writeFileSync(outPath, toHex(finalized.serialize()), { mode: 0o600 });
console.log(`Wrote ${outPath} (protocol version ${String(finalized.protocolVersion)}). The proof stub was ${proverRequested ? 'CALLED (unexpected)' : 'not called'}.`);
console.log('Copy it to the hot machine and run the sponsor submit step before the expiry time above.');
console.log(`Finished: ${localStamp(new Date())}  (total ${elapsed(Date.now() - startedAt)})`);
process.exit(0);
