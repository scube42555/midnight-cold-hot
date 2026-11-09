// Reads who sends and who receives from a finalized transaction, so the hot machine can show it before submitting.
// The ledger exposes a transaction's unshielded inputs and outputs through its intents (see the ledger API:
// Intent.guaranteedUnshieldedOffer and fallibleUnshieldedOffer, each with inputs and outputs).
// Address conversion is passed in, so this module has no SDK dependency and can be tested on its own.
import { localStamp } from './timefmt.js';

export type Helpers = {
  /** A spender's public key (SignatureVerifyingKey) to its address as hex. */
  addressOfKey: (key: string) => string;
  /** An address as hex to its text form for the current network. */
  bech32: (addressHex: string) => string;
};

type Coin = { owner: string; type: string; value: bigint; intentHash?: string; outputNo?: number };
type Offer = { inputs: readonly Coin[]; outputs: readonly Coin[] };
type IntentLike = {
  guaranteedUnshieldedOffer?: Offer;
  fallibleUnshieldedOffer?: Offer;
  actions?: unknown;
  ttl?: unknown;
};
export type TxLike = { intents?: ReadonlyMap<number, IntentLike> };

export type Line = {
  section: 'guaranteed' | 'fallible';
  address: string;
  type: string;
  value: bigint;
  /** Inputs only: which coin is being spent. */
  intentHash?: string;
  outputNo?: number;
};
export type TxDetails = { inputs: Line[]; outputs: Line[]; contractActions: number; expires?: Date };

export const NIGHT = '0'.repeat(64);

export const readTransaction = (tx: TxLike, h: Helpers): TxDetails => {
  const inputs: Line[] = [];
  const outputs: Line[] = [];
  let contractActions = 0;
  let expires: Date | undefined;

  const entries = tx.intents ? [...tx.intents.entries()] : [];
  for (const [, intent] of entries) {
    if (Array.isArray(intent.actions)) contractActions += intent.actions.length;
    if (intent.ttl instanceof Date && !Number.isNaN(intent.ttl.getTime())) {
      if (!expires || intent.ttl.getTime() < expires.getTime()) expires = intent.ttl;
    }
    const offers: ['guaranteed' | 'fallible', Offer | undefined][] = [
      ['guaranteed', intent.guaranteedUnshieldedOffer],
      ['fallible', intent.fallibleUnshieldedOffer],
    ];
    for (const [section, offer] of offers) {
      if (!offer) continue;
      for (const i of offer.inputs) {
        inputs.push({
          section,
          address: h.bech32(h.addressOfKey(i.owner)),
          type: i.type,
          value: i.value,
          intentHash: typeof i.intentHash === 'string' ? i.intentHash.toLowerCase().replace(/^0x/, '') : undefined,
          outputNo: typeof i.outputNo === 'number' ? i.outputNo : undefined,
        });
      }
      for (const o of offer.outputs) {
        outputs.push({ section, address: h.bech32(o.owner), type: o.type, value: o.value });
      }
    }
  }
  return { inputs, outputs, contractActions, expires };
};

const night = (v: bigint): string => `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0')}`;

export const amountText = (type: string, value: bigint): string =>
  type === NIGHT ? `${value} STAR (${night(value)} NIGHT)` : `${value} of token ${type}`;

// ---------- DUST fee ----------

type FeeTx = { intents?: ReadonlyMap<number, { dustActions?: { spends?: readonly { vFee: bigint }[] } }> };

/**
 * The fee a transaction declares: the sum of vFee over every DUST spend in every intent.
 * This is the formula in the Manage DUST guide. The wallet takes this whole amount from its DUST and gets none back;
 * the fee the ledger actually requires is lower by at least the wallet's additionalFeeOverhead.
 */
export const declaredDustFee = (tx: FeeTx): bigint => {
  let total = 0n;
  const entries = tx.intents ? [...tx.intents.entries()] : [];
  for (const [, intent] of entries) {
    for (const spend of intent.dustActions?.spends ?? []) total += spend.vFee;
  }
  return total;
};

/** DUST is counted in SPECK: one DUST is 10^15 SPECK. */
export const formatDust = (speck: bigint): string => {
  if (speck < 0n) return `-${formatDust(-speck)}`;
  return `${speck / 10n ** 15n}.${(speck % 10n ** 15n).toString().padStart(15, '0')}`;
};

// ---------- The plan shown before you confirm ----------

export type SnapshotLike = {
  address: string;
  available: ReadonlyMap<string, bigint>;
  utxos: readonly { intentHash: string; outputNo: number; type: string; value: bigint }[];
};

const add = (m: Map<string, bigint>, key: string, value: bigint): void => {
  m.set(key, (m.get(key) ?? 0n) + value);
};
const shortCoin = (hash: string | undefined, outputNo: number | undefined): string =>
  hash === undefined ? '(id unknown)' : `${hash.slice(0, 8)}...:${outputNo ?? '?'}`;
const KEPT_COINS_SHOWN = 10;

/**
 * Everything to print about the transaction, in reading order: From (with the wallet's balance), the UTXOs, To, Change,
 * the balance after, warnings and the expiry.
 *
 * The balance and the UTXO list come from the snapshot file, and only when it matches: it must be for the sender,
 * and every coin the transaction spends must be in it (otherwise it is stale). Without a usable snapshot the
 * coins are listed from the transaction itself and no balance is shown. The fee is paid in DUST, so the NIGHT total
 * falls only by what is sent to others.
 */
export const describePlan = (d: TxDetails, snap?: SnapshotLike, now: Date = new Date()): string[] => {
  const lines: string[] = [];
  const senders = [...new Set(d.inputs.map((i) => i.address))];
  const spent = new Map<string, bigint>();
  const sent = new Map<string, bigint>();
  for (const i of d.inputs) add(spent, i.type, i.value);
  for (const o of d.outputs) if (!senders.includes(o.address)) add(sent, o.type, o.value);

  // Can the snapshot be trusted for balances?
  let usable: SnapshotLike | undefined;
  let problem: string | undefined;
  if (!snap) {
    problem = 'no snapshot file was found, so the wallet balance and its other coins are not shown.';
  } else if (senders.length !== 1 || senders[0] !== snap.address) {
    problem = `WARNING:  the snapshot file is for ${snap.address}, not for the sender; no balance shown.`;
  } else {
    const missing = d.inputs.filter(
      (i) => i.intentHash === undefined || !snap.utxos.some((u) => u.intentHash === i.intentHash && u.outputNo === i.outputNo),
    );
    if (missing.length > 0) {
      problem = `WARNING:  ${missing.length} coin(s) this transaction spends are not in the snapshot file. It is stale or for another wallet; no balance shown.`;
    } else {
      usable = snap;
    }
  }

  // From: the address, with the wallet's balance to the right
  const fromAddress = senders.length > 0 ? senders.join(', ') : '(no unshielded inputs)';
  const balanceText = (balances: ReadonlyMap<string, bigint>): string =>
    [...spent.keys()].map((type) => amountText(type, balances.get(type) ?? 0n)).join('; ');
  lines.push(
    usable
      ? `From:     ${fromAddress}  ${balanceText(usable.available)}  (wallet balance before, from the snapshot file)`
      : `From:     ${fromAddress}  (wallet balance unknown)`,
  );

  // UTXOs
  const spentKeys = new Set(d.inputs.map((i) => `${i.intentHash}:${i.outputNo}`));
  if (usable) {
    const isSpent = (u: { intentHash: string; outputNo: number }): boolean => spentKeys.has(`${u.intentHash}:${u.outputNo}`);
    const spentRows = usable.utxos.filter(isSpent);
    const keptRows = usable.utxos.filter((u) => !isSpent(u));
    lines.push(
      `UTXOs:    ${usable.utxos.length} coin(s) in the From wallet (snapshot file); ${spentRows.length} spent by this transaction:`,
    );
    for (const u of spentRows) lines.push(`            [spent]  ${amountText(u.type, u.value)}  ${shortCoin(u.intentHash, u.outputNo)}`);
    for (const u of keptRows.slice(0, KEPT_COINS_SHOWN)) {
      lines.push(`            [kept]   ${amountText(u.type, u.value)}  ${shortCoin(u.intentHash, u.outputNo)}`);
    }
    if (keptRows.length > KEPT_COINS_SHOWN) lines.push(`            ... and ${keptRows.length - KEPT_COINS_SHOWN} more kept coin(s) not shown`);
  } else {
    lines.push(`UTXOs:    this transaction spends ${d.inputs.length} coin(s) (the rest of the From wallet is unknown):`);
    for (const i of d.inputs) lines.push(`            [spent]  ${amountText(i.type, i.value)}  ${shortCoin(i.intentHash, i.outputNo)}`);
  }
  if (problem) lines.push(problem.startsWith('WARNING') ? problem : `Note:     ${problem}`);

  // To and Change
  const toOthers = d.outputs.filter((o) => !senders.includes(o.address));
  const change = d.outputs.filter((o) => senders.includes(o.address));
  if (toOthers.length === 0 && d.outputs.length > 0) lines.push('To:       (only back to the From address)');
  for (const o of toOthers) lines.push(`To:       ${o.address}  ${amountText(o.type, o.value)}`);
  for (const o of change) lines.push(`Change:   ${o.address}  ${amountText(o.type, o.value)}  (returns to the From address)`);

  if (usable) {
    const after = new Map<string, bigint>();
    for (const type of spent.keys()) after.set(type, (usable.available.get(type) ?? 0n) - (sent.get(type) ?? 0n));
    lines.push(`After:    ${balanceText(after)}  (wallet balance after, from the snapshot file; the fee is paid in DUST)`);
  }

  // A plain transfer pays its fee in DUST, so inputs and outputs of every token must balance exactly.
  const diff = new Map<string, bigint>();
  for (const i of d.inputs) add(diff, i.type, i.value);
  for (const o of d.outputs) add(diff, o.type, -o.value);
  for (const [type, value] of diff) {
    if (value !== 0n) {
      lines.push(`WARNING:  inputs and outputs of ${type === NIGHT ? 'NIGHT' : `token ${type}`} differ by ${value}; a plain transfer should balance.`);
    }
  }
  if (d.contractActions > 0) lines.push(`WARNING:  the transaction contains ${d.contractActions} contract action(s).`);
  if (d.outputs.some((o) => o.section === 'fallible')) {
    lines.push('Note:     the transfer sits in the transaction\'s "fallible" part, where the SDK puts it by default. If that part failed,');
    lines.push('          the fee would still be taken but the transfer would not happen. See the README ("fallible").');
  }
  if (d.expires) {
    const minutes = Math.round((d.expires.getTime() - now.getTime()) / 60_000);
    lines.push(`Expires:  ${localStamp(d.expires)}  (${minutes > 0 ? `in ${minutes} min` : 'already expired'})`);
  }
  lines.push('(Only unshielded inputs and outputs are listed. The fee is paid in DUST by this sponsor wallet.)');
  return lines;
};
