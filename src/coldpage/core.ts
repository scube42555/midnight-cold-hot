// What the cold page does, without the page: read the inputs, plan the transfer, build and sign it, then check the result.
// It builds the transaction with the ledger 9 package directly, the same calls the wallet SDK makes for an unshielded
// transfer with payFees: false (cold-transfer.ts is the reference; tests-sdk/ compares the two). There is no wallet, no
// sync and no network code here. The ledger is passed in (`L`), so nothing in this file imports the SDK at run time.
import { bech32m } from '@scure/base';
import type * as LedgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import { fromHex, toHex } from '../hex.js';
import { LEDGER9_PROTOCOL_VERSION, assertLedger9, assertSnapshotFor, inspectSnapshot, type SnapshotInfo } from '../snapshot.js';
import { NIGHT, readTransaction, type TxDetails } from '../txinfo.js';

export type Ledger = typeof LedgerV9;

export const NETWORKS = ['undeployed', 'preview', 'preprod', 'mainnet'] as const;
export type NetworkName = (typeof NETWORKS)[number];
export const isNetwork = (v: string): v is NetworkName => (NETWORKS as readonly string[]).includes(v);

// ---------- Addresses ----------
// An unshielded address is 32 bytes in Bech32m under "mn_addr_<network>"; mainnet has no network part. This is the
// SDK's UnshieldedAddress codec written out, so the page needs neither the SDK's address package nor Node's Buffer.

const ADDRESS_BYTES = 32;
const addressPrefix = (network: NetworkName): string => (network === 'mainnet' ? 'mn_addr' : `mn_addr_${network}`);

export const encodeAddress = (network: NetworkName, addressHex: string): string => {
  const data = fromHex(addressHex);
  if (data.length !== ADDRESS_BYTES) throw new Error('An unshielded address is 32 bytes.');
  return bech32m.encode(addressPrefix(network), bech32m.toWords(data), false);
};

/** The address as lowercase hex. Refuses another network's address, another kind of address, and a damaged one. */
export const decodeAddress = (network: NetworkName, text: string): string => {
  const trimmed = text.trim();
  let decoded: { prefix: string; bytes: Uint8Array };
  try {
    decoded = bech32m.decodeToBytes(trimmed, false);
  } catch {
    throw new Error('The recipient is not a valid Midnight address (wrong characters or checksum). Check every character.');
  }
  const [mn, type, net = 'mainnet', ...rest] = decoded.prefix.split('_');
  if (mn !== 'mn' || rest.length > 0) throw new Error('The recipient is not a Midnight address (it does not start with "mn_").');
  if (type !== 'addr') {
    throw new Error(`The recipient is a "${type}" address. Only unshielded addresses (mn_addr...) can receive this transfer.`);
  }
  if (net !== network) throw new Error(`The recipient is a ${net} address, but this page is set to ${network}.`);
  if (decoded.bytes.length !== ADDRESS_BYTES) throw new Error('The recipient address has the wrong length.');
  return toHex(decoded.bytes);
};

// ---------- Text inputs ----------

/**
 * A positive whole number in the token's smallest unit. Plain digits, or commas as proper thousands separators:
 * "1,2" is refused, not read as 12. The same rule as cold-transfer.
 */
export const parseAmount = (text: string): bigint => {
  const t = text.trim();
  if (!/^[1-9][0-9]{0,2}(,[0-9]{3})*$/.test(t) && !/^[1-9][0-9]*$/.test(t)) {
    throw new Error(
      'The amount must be a positive whole number in the token\'s smallest unit: digits only or with commas as thousands separators, e.g. "1000000" or "1,000,000".',
    );
  }
  return BigInt(t.replace(/,/g, ''));
};

export const MAX_TTL_MINUTES = 7 * 24 * 60;

/** Whole minutes from 1 to a week. The chain may refuse a long one; the limit here only stops typing mistakes. */
export const parseTtlMinutes = (text: string): number => {
  const t = text.trim();
  if (!/^[1-9][0-9]{0,4}$/.test(t) || Number(t) > MAX_TTL_MINUTES) {
    throw new Error(`The validity must be a whole number of minutes from 1 to ${MAX_TTL_MINUTES}.`);
  }
  return Number(t);
};

export const parseTokenType = (text: string): string => {
  const t = text.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error('A token type is 64 hex characters.');
  return t;
};

// ---------- Keys ----------

export type ColdKeys = {
  /** The unshielded signing key, hex. Never shown, written or sent anywhere. */
  secretHex: string;
  publicKey: LedgerV9.SignatureVerifyingKey;
  addressHex: string;
  address: string;
};

/** From the unshielded wallet seed (WalletSeeds.fromMasterSeed(...).unshielded) to the key the ledger signs with. */
export const keysFromUnshieldedSeed = (L: Ledger, unshieldedSeed: Uint8Array, network: NetworkName): ColdKeys => {
  if (unshieldedSeed.length !== 32) throw new Error('The unshielded seed must be 32 bytes.');
  const secretHex = toHex(unshieldedSeed);
  const publicKey = L.signatureVerifyingKey({ tag: 'schnorr', value: secretHex });
  const addressHex = L.addressFromKey(publicKey);
  return { secretHex, publicKey, addressHex, address: encodeAddress(network, addressHex) };
};

/** The file cold-export-public writes: public data only, in the shape hot-watch gives back to the SDK. */
export const coldPublicJson = (network: NetworkName, keys: ColdKeys): string =>
  JSON.stringify(
    {
      sdk: 2,
      network,
      address: keys.address,
      publicKey: { publicKey: keys.publicKey, addressHex: keys.addressHex, address: keys.address },
    },
    null,
    2,
  );

// ---------- Snapshot ----------

/**
 * Read a snapshot that crossed from the hot machine and refuse it unless it is for this network, this wallet and ledger 9.
 * The messages here are worded for the page; the shared assertions run afterwards as well, so the rule stays in one place.
 */
export const checkSnapshot = (text: string, expected: { network: NetworkName; address: string }): SnapshotInfo => {
  const info = inspectSnapshot(text);
  if (info.network !== expected.network) {
    throw new Error(
      `The snapshot is for network "${info.network}" but this page is set to "${expected.network}". Use the snapshot made for this network.`,
    );
  }
  if (info.address !== expected.address) {
    throw new Error(
      `The snapshot is for address ${info.address}, not this wallet's address ${expected.address}. ` +
        'It was made for a different wallet, or the passphrase typed here is different.',
    );
  }
  assertSnapshotFor(info, expected);
  assertLedger9(info);
  return info;
};

export { LEDGER9_PROTOCOL_VERSION };

// ---------- Plan ----------

export type Coin = { intentHash: string; outputNo: number; type: string; value: bigint };
export type Output = { owner: string; type: string; value: bigint };
export type Plan = {
  tokenType: string;
  amount: bigint;
  recipientHex: string;
  ownAddressHex: string;
  inputs: Coin[];
  /** Zero when the chosen coins add up to exactly the amount. */
  change: bigint;
  /** The recipient's output and, if there is change, the output that returns it to the sender. */
  outputs: Output[];
};

/**
 * Choose the coins and work out the change. The same rule as the SDK's balancer: take the smallest coin of the token
 * until the amount is covered, then return the rest to the sender. No fee is counted: the sponsor pays it in DUST.
 */
export const planTransfer = (
  info: Pick<SnapshotInfo, 'utxos'>,
  want: { tokenType: string; amount: bigint; recipientHex: string; ownAddressHex: string },
): Plan => {
  if (want.amount <= 0n) throw new Error('The amount must be positive.');
  const coins = info.utxos.filter((u) => u.type === want.tokenType).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  const available = coins.reduce((sum, c) => sum + c.value, 0n);
  if (want.amount > available) {
    throw new Error(`The snapshot holds only ${available} of this token (type ${want.tokenType}) and ${want.amount} was requested.`);
  }
  const inputs: Coin[] = [];
  let total = 0n;
  for (const coin of coins) {
    if (total >= want.amount) break;
    inputs.push(coin);
    total += coin.value;
  }
  const change = total - want.amount;
  const outputs: Output[] = [{ owner: want.recipientHex, type: want.tokenType, value: want.amount }];
  if (change > 0n) outputs.push({ owner: want.ownAddressHex, type: want.tokenType, value: change });
  return { ...want, inputs, change, outputs };
};

// ---------- Build, sign, finalize ----------

const coinKey = (c: { intentHash: string; outputNo: number }): string => `${c.intentHash.toLowerCase()}:${c.outputNo}`;

/** The intent's TTL is kept to the second, so compare and show the time without milliseconds. */
export const wholeSeconds = (d: Date): Date => new Date(Math.floor(d.getTime() / 1000) * 1000);

/**
 * Build the transfer, sign every input, and finalize it. Returns the bytes for tx.hex.
 * An unshielded transfer needs no proof: the prover given to the ledger rejects, and `proverRequested` reports whether
 * it was ever asked. Nothing here can reach a network.
 */
export const buildTransfer = async (
  L: Ledger,
  args: { network: NetworkName; keys: ColdKeys; plan: Plan; ttl: Date },
): Promise<{ bytes: Uint8Array; proverRequested: boolean }> => {
  const { network, keys, plan, ttl } = args;
  const signingKey: LedgerV9.SigningKey = { tag: 'schnorr', value: keys.secretHex };
  const inputs = plan.inputs.map((c) => ({
    value: c.value,
    type: c.type,
    intentHash: c.intentHash,
    outputNo: c.outputNo,
    owner: keys.publicKey,
  }));
  const offer = L.UnshieldedOffer.new(inputs as never, plan.outputs as never, []);
  const intent = L.Intent.new(ttl);
  // The SDK puts a transfer that pays out NIGHT in the fallible part and any other token in the guaranteed part.
  const fallible = plan.tokenType === NIGHT;
  if (fallible) intent.fallibleUnshieldedOffer = offer;
  else intent.guaranteedUnshieldedOffer = offer;
  const tx = L.Transaction.fromParts(network, undefined, undefined, intent);

  const segments = [...(tx.intents?.keys() ?? [])];
  if (segments.length !== 1) throw new Error(`Expected one intent in the new transaction, found ${segments.length}.`);
  const segment = segments[0];
  const built = tx.intents!.get(segment)!;
  const data = built.signatureData(segment);
  const signature = L.signData(signingKey, data);
  if (!L.verifySignature(keys.publicKey, data, signature)) throw new Error('The new signature does not verify against the wallet\'s own key.');
  const signatures = inputs.map(() => new L.SignatureEnabled(signature));
  if (fallible) built.fallibleUnshieldedOffer = built.fallibleUnshieldedOffer!.addSignatures(signatures);
  else built.guaranteedUnshieldedOffer = built.guaranteedUnshieldedOffer!.addSignatures(signatures);
  tx.intents = tx.intents!.set(segment, built);

  let proverRequested = false;
  const refuse = (what: string) => () => {
    proverRequested = true;
    return Promise.reject(new Error(`${what} requested on the cold machine`));
  };
  const proven = await tx.prove(
    { prove: refuse('Proof'), check: refuse('Proof check'), lookupKey: refuse('Proving key lookup') } as never,
    L.CostModel.initialCostModel(),
  );
  return { bytes: proven.bind().serialize(), proverRequested };
};

// ---------- Check the result ----------

/**
 * Decode the finished bytes and refuse them unless they are exactly the planned transfer: the planned coins and no
 * others, owned and signed by this wallet; the planned outputs and no others; the planned expiry; and nothing else in
 * the transaction (no contract call, no DUST action, no shielded part). Run on the very bytes that leave the page.
 */
export const verifyBuilt = (
  L: Ledger,
  bytes: Uint8Array,
  expected: { network: NetworkName; keys: ColdKeys; plan: Plan; ttl: Date },
): TxDetails => {
  const { keys, plan } = expected;
  const fail = (what: string): never => {
    throw new Error(`The built transaction is not the planned one: ${what}. Nothing was shown or saved; do not use it.`);
  };
  const tx = L.Transaction.deserialize('signature', 'proof', 'binding', bytes);
  if (tx.rewards !== undefined) fail('it claims rewards');
  if (tx.guaranteedOffer !== undefined || (tx.fallibleOffer !== undefined && tx.fallibleOffer.size > 0)) fail('it has a shielded part');
  const intents = [...(tx.intents?.entries() ?? [])];
  if (intents.length !== 1) fail(`it has ${intents.length} intents instead of one`);
  const [segment, intent] = intents[0];
  if (intent.actions.length > 0) fail('it contains a contract action');
  if (intent.dustActions !== undefined) fail('it contains a DUST action');
  if (intent.binding.instance !== 'binding') fail('it is not bound');
  if (intent.ttl.getTime() !== wholeSeconds(expected.ttl).getTime()) fail('its expiry time differs');

  const fallible = plan.tokenType === NIGHT;
  const offer = fallible ? intent.fallibleUnshieldedOffer : intent.guaranteedUnshieldedOffer;
  const other = fallible ? intent.guaranteedUnshieldedOffer : intent.fallibleUnshieldedOffer;
  if (offer === undefined) return fail('the transfer is missing');
  if (other !== undefined) fail('it has a second unshielded part');

  if (offer.inputs.length !== plan.inputs.length) fail('the number of coins spent differs');
  const planned = new Map(plan.inputs.map((c) => [coinKey(c), c]));
  for (const i of offer.inputs) {
    const p = planned.get(coinKey(i));
    if (!p || i.type !== p.type || i.value !== p.value) fail('it spends a coin that was not planned');
    if (i.owner.tag !== keys.publicKey.tag || i.owner.value !== keys.publicKey.value) fail('a coin is spent with another key');
    planned.delete(coinKey(i));
  }
  if (planned.size > 0) fail('a planned coin is not spent');

  const outKey = (o: Output): string => `${o.owner.toLowerCase()}:${o.type.toLowerCase()}:${o.value}`;
  const wanted = plan.outputs.map(outKey).sort();
  const got = offer.outputs.map((o) => outKey(o as Output)).sort();
  if (wanted.length !== got.length || wanted.some((w, i) => w !== got[i])) fail('the outputs differ');

  if (offer.signatures.length !== offer.inputs.length) fail('a signature is missing');
  const data = intent.signatureData(segment);
  for (const s of offer.signatures) {
    if (s.instance !== 'signature' || !L.verifySignature(keys.publicKey, data, s.value)) fail('a signature does not verify');
  }

  return readTransaction(tx as never, {
    addressOfKey: (key) => L.addressFromKey(key as never),
    bech32: (hex) => encodeAddress(expected.network, hex),
  });
};

/** What a hex transaction file must look like before anything parses it. */
export const TX_HEX_RE = /^(?:[0-9a-f]{2})+$/;
