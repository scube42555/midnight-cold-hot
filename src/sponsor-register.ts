// Run on the HOT machine. Registers the sponsor wallet's NIGHT for DUST generation (one-time setup).
// Fund the sponsor's unshielded address from the Preprod faucet first.
import { NETWORK } from './config.js';
import { checkColdPublicNetwork } from './crosscheck.js';
import * as Rx from 'rxjs';
import { NIGHT } from './txinfo.js';
import { beep } from './beep.js';
import { deriveAndWipe, readSeed } from './keys.js';
import { buildWallet, describePhase, loadWalletState, onLedger9, saveWalletState, submitWithRetry, walletStateFile } from './wallet.js';

checkColdPublicNetwork(NETWORK);
console.log(`Network: ${NETWORK}`);

const keys = deriveAndWipe(readSeed('SPONSOR'));
const { unshieldedKeystore } = keys;
const stateFile = walletStateFile(keys);

const saved = await loadWalletState(stateFile);
const wallet = await buildWallet(keys, saved);
let state = await wallet.waitForSyncedState();
console.log(`Sponsor address: ${unshieldedKeystore.getBech32Address()}`);
const nightStar = state.unshielded.balances[NIGHT] ?? 0n;
console.log(`NIGHT (STAR):    ${nightStar}`);
await saveWalletState(wallet, stateFile); // the sync can take over an hour: keep it even if a later step fails
console.log(`Saved the synced wallet state to ${stateFile}.`);
if (!saved) beep(3); // alert that the long first sync is done
console.log(`Protocol phase:  ${describePhase(state.protocol)}`);
if (!onLedger9(state.protocol)) {
  console.error('The sponsor wallets are not settled on ledger 9, so a registration built now would be a ledger 8 transaction and be refused.');
  console.error('The synced state is saved. If this phase does not reach Settled at 2000000 after a full sync, send me this line.');
  await wallet.stop();
  process.exit(1);
}

const unregistered = state.unshielded.availableCoins.filter((coin) => coin.meta?.registeredForDustGeneration !== true);
if (unregistered.length > 0) {
  const { fee } = await wallet.estimateRegistration(unregistered);
  await wallet.waitForGeneratedDust(unregistered, fee);
  const recipe = await wallet.registerNightUtxosForDustGeneration(
    unregistered,
    unshieldedKeystore.getPublicKey(), // Verified (11 Nov 2026): accepted; sponsor registered for DUST successfully.
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
