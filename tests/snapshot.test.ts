import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectSnapshot, assertSnapshotFor, assertLedger9 } from '../src/snapshot.js';

const ZERO64 = '0'.repeat(64);
const HASH64 = 'a'.repeat(64);

const makeRaw = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    networkId: 'preprod',
    publicKey: { key: ZERO64, addressHex: ZERO64, address: 'mn1test' },
    state: {
      availableUtxos: [
        { utxo: { value: '5000000000', type: ZERO64, intentHash: HASH64, outputNo: 0 } },
      ],
      pendingUtxos: [],
    },
    protocolVersion: '2000000',
    writtenBy: 'v2',
    version: 'v2',
    ...overrides,
  });

test('inspectSnapshot: parses a valid snapshot', () => {
  const info = inspectSnapshot(makeRaw());
  assert.equal(info.network, 'preprod');
  assert.equal(info.address, 'mn1test');
  assert.equal(info.availableCount, 1);
  assert.equal(info.pendingCount, 0);
  assert.equal(info.available.get(ZERO64), 5000000000n);
  assert.equal(info.format, 'v2');
  assert.equal(info.writtenBy, 'v2');
  assert.equal(info.protocolVersion, '2000000');
  assert.equal(info.utxos.length, 1);
  assert.equal(info.utxos[0].intentHash, HASH64);
  assert.equal(info.utxos[0].outputNo, 0);
  assert.equal(info.utxos[0].value, 5000000000n);
});

test('inspectSnapshot: rejects invalid JSON', () => {
  assert.throws(() => inspectSnapshot('not json'), /not valid JSON/);
});

test('inspectSnapshot: rejects missing networkId', () => {
  assert.throws(() => inspectSnapshot(makeRaw({ networkId: undefined })), /networkId/);
});

test('inspectSnapshot: rejects missing publicKey.address', () => {
  assert.throws(() => inspectSnapshot(makeRaw({ publicKey: { key: ZERO64 } })), /address/);
});

test('inspectSnapshot: accepts snapshot with no optional fields', () => {
  const raw = makeRaw({ version: undefined, writtenBy: undefined, protocolVersion: undefined });
  const info = inspectSnapshot(raw);
  assert.equal(info.format, undefined);
  assert.equal(info.writtenBy, undefined);
  assert.equal(info.protocolVersion, undefined);
});

test('assertSnapshotFor: passes when network and address match', () => {
  const info = inspectSnapshot(makeRaw());
  assert.doesNotThrow(() => assertSnapshotFor(info, { network: 'preprod', address: 'mn1test' }));
});

test('assertSnapshotFor: throws on wrong network', () => {
  const info = inspectSnapshot(makeRaw());
  assert.throws(() => assertSnapshotFor(info, { network: 'mainnet' }), /preprod.*mainnet|mainnet.*preprod/i);
});

test('assertSnapshotFor: throws on wrong address', () => {
  const info = inspectSnapshot(makeRaw());
  assert.throws(() => assertSnapshotFor(info, { network: 'preprod', address: 'other' }), /other/);
});

test('assertLedger9: passes on version 2000000', () => {
  const info = inspectSnapshot(makeRaw());
  assert.doesNotThrow(() => assertLedger9(info));
});

test('assertLedger9: throws on version below 2000000', () => {
  const info = inspectSnapshot(makeRaw({ protocolVersion: '1000300' }));
  assert.throws(() => assertLedger9(info), /1000300/);
});

test('assertLedger9: throws on missing protocol version', () => {
  const info = inspectSnapshot(makeRaw({ protocolVersion: undefined }));
  assert.throws(() => assertLedger9(info), /missing/);
});
