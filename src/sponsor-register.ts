// Run on the HOT machine. Registers the sponsor wallet's NIGHT for DUST generation (one-time setup).
// Fund the sponsor's unshielded address from the Preprod faucet first.
import { NETWORK } from './config.js';
import { checkColdPublicNetwork } from './crosscheck.js';
import * as Rx from 'rxjs';
import { NIGHT } from './txinfo.js';
import { deriveAndWipe, readSeed } from './keys.js';
import { buildWallet, loadWalletState, saveWalletState, submitWithRetry, walletStateFile } from './wallet.js';

checkColdPublicNetwork(NETWORK);
console.log(`Network: ${NETWORK}`);

const keys = deriveAndWipe(readSeed('SPONSOR'));
const { unshieldedKeystore } = keys;
const stateFile = walletStateFile(keys);

const wallet = await buildWallet(keys, await loadWalletState(stateFile));
let state = await wallet.waitForSyncedState();
console.log(`Sponsor address: ${unshieldedKeystore.getBech32Address()}`);
console.log(`NIGHT (STAR):    ${state.unshielded.balances[NIGHT] ?? 0n}`);

const unregistered = state.unshielded.availableCoins.filter((coin) => coin.meta?.registeredForDustGeneration !== true);
if (unregistered.length > 0) {
  const { fee } = await wallet.estimateRegistration(unregistered);
  await wallet.waitForGeneratedDust(unregistered, fee);
  const recipe = await wallet.registerNightUtxosForDustGeneration(
    unregistered,
    unshieldedKeystore.getPublicKey(), // SDK2-UNVERIFIED: this argument may now be a tagged key object or PublicKey.fromKeyStore(...)
    unshieldedKeystore.signDataAsync, // signers are asynchronous (SignSegment) in SDK 2
  );
  await submitWithRetry(wallet, await wallet.finalizeRecipe(recipe));
  console.log(`Registered ${unregistered.length} NIGHT UTXO(s) for DUST generation`);
} else {
  console.log('No unregistered NIGHT found (fund this address first, or it is already registered).');
}

console.log('Waiting for a DUST balance. This can take a while on a public network; Ctrl+C is safe.');
state = await Rx.firstValueFrom(
  wallet.state().pipe(
    Rx.filter((s) => s.isSynced),
    Rx.filter((s) => s.dust.balance(new Date()) > 0n),
  ),
);
console.log(`DUST (SPECK): ${state.dust.balance(new Date())}`);

await saveWalletState(wallet, stateFile);
await wallet.stop();
process.exit(0);
