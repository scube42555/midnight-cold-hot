// Sponsor wallet helpers (hot machine). Wallet SDK 2.x: wallets and the facade start from seeds, and the transaction
// methods take no secret keys. Shapes follow the wallet-sdk-facade 5.0.0 migration guide ("Migrating from 4.x").
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import {
  WalletFacade,
  ShieldedWallet,
  DustWallet,
  UnshieldedWallet,
  PublicKey,
} from '@midnightntwrk/wallet-sdk';
import { hotEndpoints, walletConfig } from './config.js';
import { type WalletKeys } from './keys.js';

export type SavedWalletState = { shielded: string; unshielded: string; dust: string };

/** What finalizeRecipe returns. Taken from the SDK so it does not depend on a type name. */
export type FinalizedTx = Awaited<ReturnType<WalletFacade['finalizeRecipe']>>;

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

/**
 * Start the sponsor wallet from its seeds, resuming from a snapshot when one is passed.
 * SDK2-UNVERIFIED: that restore() accepts a snapshot written by this SDK version (delete wallet-state-*.json from SDK 1.x).
 * The lifecycle store (transactionLifecycleService.serializeState) is not saved: a fresh one per run is enough here.
 */
export const buildWallet = async (keys: WalletKeys, saved?: SavedWalletState): Promise<WalletFacade> => {
  const { seeds, unshieldedKeystore } = keys;

  const wallet = await WalletFacade.init({
    configuration: walletConfig(hotEndpoints()),
    shielded: (cfg) => (saved ? ShieldedWallet(cfg).restore(saved.shielded) : ShieldedWallet(cfg).startWithSeed(seeds.shielded)),
    unshielded: (cfg) =>
      saved
        ? UnshieldedWallet(cfg).restore(saved.unshielded)
        : UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg) => (saved ? DustWallet(cfg).restore(saved.dust) : DustWallet(cfg).startWithSeed(seeds.dust)),
  });
  await wallet.start(seeds); // 4.x: wallet.start(shieldedSecretKeys, dustSecretKey)
  return wallet;
};

/** Submit a finalized transaction, trying again if the connection to the node drops. */
export const submitWithRetry = async (wallet: WalletFacade, tx: FinalizedTx, attempts = 3): Promise<string> => {
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
