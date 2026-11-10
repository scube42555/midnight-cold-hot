// Run on the COLD machine. Writes the cold wallet's unshielded PUBLIC key to cold-public.json.
// Nothing secret is written. Copy that file to the hot machine.
//
// Wallet SDK 2: the whole PublicKey object is written as the SDK gives it (its fields and tags are not assumed), together
// with the network and the address as text. The hot machine hands the object straight back to the SDK.
import { NETWORK } from './config.js';
import { writeFileSync } from 'node:fs';
import { PublicKey } from '@midnightntwrk/wallet-sdk';
import { deriveAndWipe, readSeed } from './keys.js';

console.log(`Network: ${NETWORK}`);
const keys = deriveAndWipe(readSeed('COLD'));

const keystore = keys.unshieldedKeystore;
const address = keystore.getBech32Address().asString();
// JSON cannot hold a bigint or raw bytes: if the SDK's PublicKey has either, this throws and the format must change.
const out = { sdk: 2, network: NETWORK, address, publicKey: PublicKey.fromKeyStore(keystore) };

writeFileSync('cold-public.json', JSON.stringify(out, null, 2));
console.log(`Wrote cold-public.json for ${address}`);
console.log('Compare this address with the one you already know for this wallet BEFORE funding it.');
process.exit(0);
