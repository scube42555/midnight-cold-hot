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
import { assumeLedger9, hotEndpoints, walletConfig } from './config.js';
import { LEDGER9_PROTOCOL_VERSION } from './snapshot.js';
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

/** The facade's protocol phase as text (it holds bigints, which JSON cannot print). */
export const describePhase = (protocol: unknown): string =>
  JSON.stringify(protocol, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** True once the wallets agree and are acting at ledger 9 or later. */
export const onLedger9 = (protocol: { _tag: string; version?: bigint }): boolean =>
  protocol._tag === 'Settled' && (protocol.version ?? 0n) >= LEDGER9_PROTOCOL_VERSION;

/**
 * Start the sponsor wallet from its seeds, resuming from a snapshot when one is passed.
 *
 * No chain-version probe for the shielded and DUST wallets. The sponsor syncs from the start of the chain, and a wallet told "the chain is on
 * ledger 9" begins on the ledger 9 decoder and cannot read the ledger 8 history ("Could not deserialize ledger event", repeated). They start on
 * ledger 8, read the history, and cross at the upgrade on their own. The unshielded wallet's events are plain JSON, so it can take the probe.
 * Verified (11 Nov 2026): shielded and DUST wallets crossed to ledger 9 on their own (Protocol phase: Settled 2000000).
 * Verified (11 Nov 2026): restore() accepts a snapshot written by this SDK version.
 * The lifecycle store (transactionLifecycleService.serializeState) is not saved: a fresh one per run is enough here.
 */
export const buildWallet = async (keys: WalletKeys, saved?: SavedWalletState): Promise<WalletFacade> => {
  const { seeds, unshieldedKeystore } = keys;

  const wallet = await WalletFacade.init({
    configuration: walletConfig(hotEndpoints(), { assumeLedger9: false }),
    shielded: (cfg) => (saved ? ShieldedWallet(cfg).restore(saved.shielded) : ShieldedWallet(cfg).startWithSeed(seeds.shielded)),
    unshielded: (cfg) =>
      saved
        ? UnshieldedWallet(cfg).restore(saved.unshielded)
        : UnshieldedWallet({ ...cfg, chainVersionProbe: assumeLedger9 }).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
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
