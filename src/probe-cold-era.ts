// A PROBE, not part of the transfer flow. Run it on a dev machine with a THROWAWAY seed.
//
// Question it answers: when the cold machine builds its wallet offline from a snapshot, which ledger will the facade act at,
// ledger 8 or ledger 9? A ledger 8 transaction is refused by a ledger 9 chain, so this decides whether the cold design works.
// It builds the facade the way cold-transfer will (restoring the unshielded snapshot, fresh shielded and DUST wallets), points
// every endpoint at an address nothing listens on (so it behaves like an offline machine), and prints what the SDK decided.
// Nothing is signed, built or sent.
//
// Usage: COLD_MNEMONIC=... node dist/probe-cold-era.js [snapshot file] [--no-probe]
//   --no-probe  leaves the wallets without a chain-version probe, to reproduce the ledger 8 result.
// Result so far: without it the offline facade settles at protocol version 0 (ledger 8). The other documented route, forks.v9 = the
// minimum supported version, is refused by the SDK at build time ("ProtocolMismatch: sinceVersion is prior to previously registered version").
//
// Verified (11 Nov 2026): state.protocol shape confirmed; offline facade settled at version 2000000.
import { NETWORK, coldEndpoints, walletConfig } from './config.js';
import { readFileSync } from 'node:fs';
import { firstValueFrom, timeout } from 'rxjs';
import { DustWallet, ShieldedWallet, UnshieldedWallet, WalletFacade } from '@midnightntwrk/wallet-sdk';
import { deriveAndWipe, readSeed } from './keys.js';
import { inspectSnapshot } from './snapshot.js';

const args = process.argv.slice(2);
const wantLedger9 = !args.includes('--no-probe');
const file = args.find((a) => !a.startsWith('--')) ?? 'cold-unshielded.snapshot.json';
const show = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
const describe = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

console.log(`Network: ${NETWORK}`);
const snapshot = readFileSync(file, 'utf8');
const info = inspectSnapshot(snapshot);
console.log(`Snapshot:        format ${info.format ?? 'none'}, written by ${info.writtenBy ?? 'unknown'}, protocol version ${info.protocolVersion ?? 'not recorded'}`);
console.log(`Chain version:   ${wantLedger9 ? 'assumed to be ledger 9' : 'left to the SDK (--no-probe)'}`);

const keys = deriveAndWipe(readSeed('COLD'));
const config = walletConfig(coldEndpoints(), { assumeLedger9: wantLedger9 });

let facade: WalletFacade;
try {
  facade = await WalletFacade.init({
    configuration: config,
    shielded: (cfg) => ShieldedWallet(cfg).startWithSeed(keys.seeds.shielded),
    unshielded: (cfg) => UnshieldedWallet(cfg).restore(snapshot),
    dust: (cfg) => DustWallet(cfg).startWithSeed(keys.seeds.dust),
  });
  await facade.start(keys.seeds);
} catch (err) {
  console.log(`FAILED to build or start: ${describe(err)}`);
  process.exit(1);
}

await new Promise((resolve) => setTimeout(resolve, 5_000)); // let the wallets settle, with nothing to sync from
try {
  const state = await firstValueFrom(facade.state().pipe(timeout(15_000)));
  // activeProtocolVersion belongs to FacadeState, not to the facade. Read by name so a wrong guess about its shape cannot stop the build.
  console.log(`activeProtocolVersion: ${String(Reflect.get(state, 'activeProtocolVersion'))}`);
  console.log(`protocol phase:        ${show(state.protocol)}`);
} catch (err) {
  console.log(`facade.state() did not emit within 15 s (${describe(err)}). That alone is informative: something waits on the network.`);
}
console.log('');
console.log('Reading it: a version below 2000000, or a "Crossing" phase that never settles, means the cold facade would build ledger 8.');
process.exit(0);
