// Sponsor wallet helpers (hot machine). Adapted from the docs' Node.js wallet guide.
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import {
  WalletFacade,
  ShieldedWallet,
  DustWallet,
  UnshieldedWallet,
  PublicKey,
} from '@midnightntwrk/wallet-sdk';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { type FinalizedTransaction } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { hotEndpoints, walletConfig } from './config.js';
import { type WalletKeys } from './keys.js';

export type SavedWalletState = { shielded: string; unshielded: string; dust: string };

export const walletStateFile = (keys: WalletKeys): string =>
  `wallet-state-${keys.unshieldedKeystore.getBech32Address()}.json`;

export const loadWalletState = async (file: string): Promise<SavedWalletState | undefined> =>
  existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as SavedWalletState) : undefined;

export const saveWalletState = async (wallet: WalletFacade, file: string): Promise<void> => {
  const snapshot: SavedWalletState = {
    shielded: await wallet.shielded.serializeState(),
    unshielded: await wallet.unshielded.serializeState(),
    dust: await wallet.dust.serializeState(),
  };
  await writeFile(`${file}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
};

/** Start the sponsor wallet from its keys, resuming from a snapshot when one is passed. */
export const buildWallet = async (keys: WalletKeys, saved?: SavedWalletState): Promise<WalletFacade> => {
  const { shieldedSecretKeys, dustSecretKey, unshieldedKeystore } = keys;

  const wallet = await WalletFacade.init({
    configuration: walletConfig(hotEndpoints()),
    shielded: (cfg) =>
      saved
        ? ShieldedWallet(cfg).restore(saved.shielded)
        : ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (cfg) =>
      saved
        ? UnshieldedWallet(cfg).restore(saved.unshielded)
        : UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg) =>
      saved
        ? DustWallet(cfg).restore(saved.dust)
        : DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);
  return wallet;
};

/** Submit a finalized transaction, trying again if the connection to the node drops. */
export const submitWithRetry = async (
  wallet: WalletFacade,
  tx: FinalizedTransaction,
  attempts = 3,
): Promise<string> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await wallet.submitTransaction(tx);
    } catch (err) {
      if (attempt >= attempts) throw err;
      console.warn(`Submission attempt ${attempt} failed, trying again`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
};
