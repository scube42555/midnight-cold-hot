import { Buffer } from 'node:buffer';
import { HDWallet, Roles, createKeystore, validateMnemonic } from '@midnightntwrk/wallet-sdk';
import { mnemonicToSeedSync } from '@scure/bip39';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

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
  if (hex) {
    if (passphrase) throw new Error(`${passphraseName} only applies to ${mnemonicName}, not to ${seedName}.`);
    return seedFromHex(hex.trim());
  }
  throw new Error(`Set ${mnemonicName} (and ${passphraseName} if it has one) or ${seedName}.`);
};

/** Derive the three key sets the wallet needs from one seed (as in the docs' Node.js guide). */
export const deriveWalletKeys = (seed: Uint8Array) => {
  const hd = HDWallet.fromSeed(seed);
  if (hd.type !== 'seedOk') throw new Error('Invalid seed');
  const result = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hd.hdWallet.clear();

  return {
    shieldedSecretKeys: ledger.ZswapSecretKeys.fromSeed(result.keys[Roles.Zswap]),
    dustSecretKey: ledger.DustSecretKey.fromSeed(result.keys[Roles.Dust]),
    unshieldedKeystore: createKeystore(result.keys[Roles.NightExternal], getNetworkId()),
  };
};

export type WalletKeys = ReturnType<typeof deriveWalletKeys>;
