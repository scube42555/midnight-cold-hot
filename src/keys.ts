import { Buffer } from 'node:buffer';
import { WalletSeeds, createKeystore, validateMnemonic } from '@midnightntwrk/wallet-sdk';
import { mnemonicToSeedSync } from '@scure/bip39';
import { NETWORK_ID } from './config.js';

/**
 * Turn a BIP-39 recovery phrase into the 64-byte seed the HD wallet expects.
 * The optional passphrase is the "25th word". It is case-sensitive and every character counts,
 * including spaces. A wrong passphrase does not fail: it silently gives a different, empty wallet.
 */
export const seedFromMnemonic = (phrase: string, passphrase = ''): Uint8Array => {
  const mnemonic = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(mnemonic)) throw new Error('Not a valid BIP-39 recovery phrase.');
  return mnemonicToSeedSync(mnemonic, passphrase);
};

/** Decode a hex seed, rejecting anything Buffer.from would silently truncate. */
export const seedFromHex = (hex: string): Uint8Array => {
  if (!/^(?:[0-9a-fA-F]{2}){16,64}$/.test(hex)) throw new Error('A hex seed must be 32 to 128 hex characters.');
  return Buffer.from(hex, 'hex');
};

/**
 * Read a wallet secret from the environment, then remove it from the environment.
 * COLD uses COLD_MNEMONIC (and optionally COLD_PASSPHRASE) or COLD_SEED.
 * SPONSOR uses SPONSOR_MNEMONIC (and optionally SPONSOR_PASSPHRASE) or SPONSOR_SEED.
 * Use different names so the two wallets cannot be mixed up.
 * The passphrase is used exactly as given, never trimmed. It only applies to a recovery phrase, not a hex seed.
 */
export const readSeed = (role: 'COLD' | 'SPONSOR'): Uint8Array => {
  const mnemonicName = `${role}_MNEMONIC`;
  const seedName = `${role}_SEED`;
  const passphraseName = `${role}_PASSPHRASE`;
  const mnemonic = process.env[mnemonicName];
  const hex = process.env[seedName];
  const passphrase = process.env[passphraseName];
  delete process.env[mnemonicName];
  delete process.env[seedName];
  delete process.env[passphraseName];

  if (mnemonic) return seedFromMnemonic(mnemonic, passphrase ?? '');
  if (mnemonic === '' && !hex) {
    // Present but empty is a different mistake from not set at all, and it is easy to make with `read -rs`.
    throw new Error(
      `${mnemonicName} is set but empty. With \`read -rs\`, the line was empty or the paste went to another command. ` +
        `Check the length (never the value) with: echo "\${#${mnemonicName}}"`,
    );
  }
  if (hex) {
    if (passphrase) throw new Error(`${passphraseName} only applies to ${mnemonicName}, not to ${seedName}.`);
    return seedFromHex(hex.trim());
  }
  throw new Error(`Set ${mnemonicName} (and ${passphraseName} if it has one) or ${seedName}.`);
};

/**
 * Wallet SDK 2: one master seed gives three wallet seeds (shielded, unshielded, DUST) and the facade and every wallet start
 * from them; no transaction method takes a secret key any more. Only the unshielded keystore is created here, for signing.
 * Verified (11 Nov 2026): same addresses as the 1.x derivation from the same seed.
 * Compare the address `cold-export-public` prints with the one you already know before funding anything.
 */
export const deriveWalletKeys = (masterSeed: Uint8Array) => {
  const seeds = WalletSeeds.fromMasterSeed(masterSeed);
  const unshieldedKeystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, NETWORK_ID);
  return { seeds, unshieldedKeystore };
};

export type WalletKeys = ReturnType<typeof deriveWalletKeys>;

/**
 * Derive the keys, then wipe the master seed from memory. A wallet that kept a reference to the seed buffer instead of a
 * copy would silently change when it is wiped, so check that the address is the same afterwards and stop if it is not.
 * Verified (11 Nov 2026): `@scure/bip32`'s `HDKey.fromMasterSeed` hashes the seed via HMAC-SHA512 and stores only the
 * derived privateKey and chainCode — the original buffer is never retained. Zeroing it leaves the derived keys intact.
 */
export const deriveAndWipe = (masterSeed: Uint8Array): WalletKeys => {
  const keys = deriveWalletKeys(masterSeed);
  const before = keys.unshieldedKeystore.getBech32Address().asString();
  masterSeed.fill(0);
  if (keys.unshieldedKeystore.getBech32Address().asString() !== before) {
    throw new Error('Wiping the master seed changed the derived keys: the SDK keeps a reference to the buffer. Do not wipe it.');
  }
  return keys;
};
