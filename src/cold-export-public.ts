// Run on the COLD machine. Writes the public fields of the cold wallet's unshielded key to cold-public.json.
// Nothing secret is written. Copy that file to the hot machine.
import { NETWORK } from './config.js';
import { writeFileSync } from 'node:fs';
import { deriveWalletKeys, readSeed } from './keys.js';

console.log(`Network: ${NETWORK}`);
const seed = readSeed('COLD');
const keys = deriveWalletKeys(seed);
seed.fill(0);

const keystore = keys.unshieldedKeystore;
const out = {
  network: NETWORK,
  publicKey: keystore.getPublicKey(),
  addressHex: keystore.getAddress(),
  address: keystore.getBech32Address().asString(),
};

// The hot machine rebuilds a PublicKey from these three fields. They must be plain strings.
for (const [name, value] of Object.entries(out)) {
  if (typeof value !== 'string') {
    throw new Error(`Expected "${name}" to be a string but it is ${typeof value}. The export format needs changing.`);
  }
}

writeFileSync('cold-public.json', JSON.stringify(out, null, 2));
console.log(`Wrote cold-public.json for ${out.address}`);
process.exit(0);
