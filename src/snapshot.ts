// Reads the snapshot that hot-watch writes, so the cold machine can check it before using it.
// The snapshot is untrusted input (it crossed from the hot machine), so everything is validated.
// No SDK imports: this is plain JSON handling.

export type SnapshotInfo = {
  network: string;
  address: string;
  /** Total value of the available UTXOs, per token type (lowercase 64-hex). NIGHT is all zeros. */
  available: Map<string, bigint>;
  availableCount: number;
  pendingCount: number;
  /** SDK 2 wraps the snapshot with `version` and `writtenBy`; SDK 1.x snapshots have neither. */
  format?: string;
  writtenBy?: string;
  /** The wallet's own record. For an idle address it can be older than the chain's current protocol version. */
  protocolVersion?: string;
  /** Each available coin's identifiers, so a transaction's inputs can be matched against the snapshot. */
  utxos: { intentHash: string; outputNo: number; type: string; value: bigint }[];
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function need(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`Unrecognised snapshot format: ${what}.`);
}

export const inspectSnapshot = (text: string): SnapshotInfo => {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error('The snapshot is not valid JSON.');
  }
  need(isRecord(root), 'expected a JSON object');
  need(typeof root.networkId === 'string', 'networkId is missing');
  need(isRecord(root.publicKey) && typeof root.publicKey.address === 'string', 'publicKey.address is missing');
  need(
    isRecord(root.state) && Array.isArray(root.state.availableUtxos) && Array.isArray(root.state.pendingUtxos),
    'state.availableUtxos or state.pendingUtxos is missing',
  );

  const available = new Map<string, bigint>();
  const utxos: SnapshotInfo['utxos'] = [];
  for (const item of root.state.availableUtxos as unknown[]) {
    need(isRecord(item) && isRecord(item.utxo), 'an available UTXO entry');
    const { value, type, intentHash, outputNo } = item.utxo;
    need(typeof value === 'string' && /^[0-9]+$/.test(value), 'a UTXO value');
    need(typeof type === 'string' && /^[0-9a-f]{64}$/i.test(type), 'a UTXO token type');
    need(typeof intentHash === 'string' && /^[0-9a-f]{64}$/i.test(intentHash), 'a UTXO intentHash');
    need(typeof outputNo === 'number' && Number.isInteger(outputNo) && outputNo >= 0, 'a UTXO outputNo');
    const key = type.toLowerCase();
    available.set(key, (available.get(key) ?? 0n) + BigInt(value));
    utxos.push({ intentHash: intentHash.toLowerCase(), outputNo, type: key, value: BigInt(value) });
  }

  return {
    network: root.networkId,
    address: root.publicKey.address,
    available,
    availableCount: (root.state.availableUtxos as unknown[]).length,
    pendingCount: (root.state.pendingUtxos as unknown[]).length,
    format: typeof root.version === 'string' ? root.version : undefined,
    writtenBy: typeof root.writtenBy === 'string' ? root.writtenBy : undefined,
    protocolVersion: typeof root.protocolVersion === 'string' ? root.protocolVersion : undefined,
    utxos,
  };
};

/** Refuse a snapshot made for another network or, when an address is given, for another wallet. */
export const assertSnapshotFor = (info: SnapshotInfo, expected: { network: string; address?: string }): void => {
  if (info.network !== expected.network) {
    throw new Error(
      `The snapshot is for network "${info.network}" but this run is set to "${expected.network}" (MIDNIGHT_NETWORK). ` +
        'Stopping: use the snapshot made for this network, or set MIDNIGHT_NETWORK to match it.',
    );
  }
  if (expected.address !== undefined && info.address !== expected.address) {
    throw new Error(
      `The snapshot is for address ${info.address}, not this wallet's address ${expected.address}. ` +
        'Stopping: it was made for a different wallet (or a different passphrase).',
    );
  }
};

/** The protocol version a 2.x node reports, from which wallets read the chain as ledger 9. */
export const LEDGER9_PROTOCOL_VERSION = 2_000_000n;

/**
 * Refuse a snapshot that the cold machine could only turn into a ledger 8 transaction. A wallet restored from a snapshot goes
 * "into whichever variant wrote it", and an offline machine has no way to cross to ledger 9 by itself, so the snapshot must already
 * be on ledger 9. Measured: a snapshot written without the chain-version probe said protocol version 1000300, written by v1.
 */
export const assertLedger9 = (info: SnapshotInfo): void => {
  const version = info.protocolVersion !== undefined && /^[0-9]+$/.test(info.protocolVersion) ? BigInt(info.protocolVersion) : undefined;
  if (version === undefined || version < LEDGER9_PROTOCOL_VERSION) {
    throw new Error(
      `The snapshot's protocol version is ${info.protocolVersion ?? 'missing'}, below ${LEDGER9_PROTOCOL_VERSION} (ledger 9), written by ${info.writtenBy ?? 'an unknown variant'}. ` +
        'An offline wallet restored from it would build ledger 8 transactions, which the network refuses. ' +
        'Take a new snapshot with hot-watch from this version of the scripts.',
    );
  }
};
