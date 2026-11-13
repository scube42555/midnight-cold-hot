// From a recovery phrase to the cold wallet's unshielded key, with the SDK's own derivation (WalletSeeds), so the page
// and the Node scripts cannot disagree about the address. The HD package is plain JavaScript (@scure/bip32, @scure/bip39).
import { WalletSeeds, validateMnemonic } from '@midnightntwrk/wallet-sdk/hd';
import { mnemonicToSeedSync } from '@scure/bip39';
import { type ColdKeys, type Ledger, type NetworkName, keysFromUnshieldedSeed } from './core.js';

/**
 * The passphrase is the optional BIP-39 "25th word": used exactly as typed, never trimmed. A wrong one does not fail,
 * it gives a different, empty wallet. The phrase is normalised the same way as keys.ts does it.
 */
export const deriveColdKeys = (L: Ledger, phrase: string, passphrase: string, network: NetworkName): ColdKeys => {
  const mnemonic = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(mnemonic)) throw new Error('Not a valid BIP-39 recovery phrase. Check the spelling and the order of the words.');
  const masterSeed = mnemonicToSeedSync(mnemonic, passphrase);
  try {
    const seeds = WalletSeeds.fromMasterSeed(masterSeed);
    try {
      return keysFromUnshieldedSeed(L, seeds.unshielded, network);
    } finally {
      // Best effort: JavaScript cannot promise the bytes are gone, and the key itself stays in memory as text for signing.
      seeds.shielded.fill(0);
      seeds.unshielded.fill(0);
      seeds.dust.fill(0);
    }
  } finally {
    masterSeed.fill(0);
  }
};

/**
 * Only the address of a wallet, for sending to a wallet whose phrase is at hand but whose address is not. The key that is
 * derived on the way is dropped here and never reaches the caller.
 */
export const deriveAddressOnly = (L: Ledger, phrase: string, passphrase: string, network: NetworkName): string =>
  deriveColdKeys(L, phrase, passphrase, network).address;
