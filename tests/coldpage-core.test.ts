import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSnapshot,
  decodeAddress,
  encodeAddress,
  parseAmount,
  parseTokenType,
  parseTtlMinutes,
  planTransfer,
  wholeSeconds,
} from '../src/coldpage/core.js';

const NIGHT = '0'.repeat(64);
const TOKEN = 'ab'.repeat(32);
const OWN = '11'.repeat(32);
const RECIPIENT = '22'.repeat(32);
const hash = (n: number): string => n.toString(16).padStart(64, '0');

// ---------- addresses ----------

test('addresses: round trip on every network, mainnet without a network part', () => {
  for (const net of ['undeployed', 'preview', 'preprod', 'mainnet'] as const) {
    const text = encodeAddress(net, OWN);
    assert.ok(text.startsWith(net === 'mainnet' ? 'mn_addr1' : `mn_addr_${net}1`), text);
    assert.equal(decodeAddress(net, text), OWN);
    assert.equal(decodeAddress(net, `  ${text}\n`), OWN);
  }
});

test('addresses: another network, another kind, damage and wrong length are refused', () => {
  const preprod = encodeAddress('preprod', OWN);
  assert.throws(() => decodeAddress('mainnet', preprod), /preprod address, but this page is set to mainnet/);
  assert.throws(() => decodeAddress('preprod', encodeAddress('mainnet', OWN)), /mainnet address, but this page is set to preprod/);
  assert.throws(() => decodeAddress('preprod', encodeAddress('preview', OWN)), /preview address/);
  const flipped = preprod.slice(0, -1) + (preprod.endsWith('q') ? 'p' : 'q');
  assert.throws(() => decodeAddress('preprod', flipped), /not a valid Midnight address/);
  assert.throws(() => decodeAddress('preprod', 'hello'), /not a valid Midnight address/);
  assert.throws(() => decodeAddress('preprod', ''), /not a valid Midnight address/);
  assert.throws(() => encodeAddress('preprod', '11'.repeat(31)), /32 bytes/);
});

// ---------- text inputs ----------

test('parseAmount: digits or proper thousands commas only', () => {
  assert.equal(parseAmount('1000000'), 1_000_000n);
  assert.equal(parseAmount('1,000,000'), 1_000_000n);
  assert.equal(parseAmount(' 42 '), 42n);
  assert.equal(parseAmount('123456789012345678901234567890'), 123456789012345678901234567890n);
  for (const bad of ['', '0', '-1', '1.5', '1,2', '1,0000', ',100', '100,', '01', '1e6', '0x10', '1 000', '１００']) {
    assert.throws(() => parseAmount(bad), /positive whole number/, `"${bad}"`);
  }
});

test('parseTtlMinutes and parseTokenType', () => {
  assert.equal(parseTtlMinutes('120'), 120);
  assert.equal(parseTtlMinutes('10080'), 10080);
  for (const bad of ['', '0', '-5', '1.5', '10081', '999999', 'abc']) assert.throws(() => parseTtlMinutes(bad), /whole number of minutes/);
  assert.equal(parseTokenType(` ${TOKEN.toUpperCase()} `), TOKEN);
  assert.throws(() => parseTokenType('abcd'), /64 hex/);
});

test('wholeSeconds drops the milliseconds', () => {
  assert.equal(wholeSeconds(new Date(1_700_000_000_999)).getTime(), 1_700_000_000_000);
});

// ---------- plan ----------

const coins = (...values: [bigint, string?][]) => ({
  utxos: values.map(([value, type = NIGHT], i) => ({ intentHash: hash(i + 1), outputNo: i, type, value })),
});
const want = (amount: bigint, tokenType = NIGHT) => ({ tokenType, amount, recipientHex: RECIPIENT, ownAddressHex: OWN });

test('planTransfer: smallest coins first, change back to the sender', () => {
  const plan = planTransfer(coins([500n], [80n], [200n]), want(250n));
  assert.deepEqual(plan.inputs.map((c) => c.value), [80n, 200n]);
  assert.equal(plan.change, 30n);
  assert.deepEqual(plan.outputs, [
    { owner: RECIPIENT, type: NIGHT, value: 250n },
    { owner: OWN, type: NIGHT, value: 30n },
  ]);
});

test('planTransfer: an exact amount leaves no change output', () => {
  const plan = planTransfer(coins([80n], [200n]), want(280n));
  assert.equal(plan.inputs.length, 2);
  assert.equal(plan.change, 0n);
  assert.deepEqual(plan.outputs, [{ owner: RECIPIENT, type: NIGHT, value: 280n }]);
});

test('planTransfer: only coins of the requested token are used', () => {
  const plan = planTransfer(coins([10n], [70n, TOKEN], [1000n]), want(50n, TOKEN));
  assert.deepEqual(plan.inputs.map((c) => [c.type, c.value]), [[TOKEN, 70n]]);
  assert.deepEqual(plan.outputs.map((o) => o.type), [TOKEN, TOKEN]);
});

test('planTransfer: inputs always equal outputs', () => {
  for (const amount of [1n, 79n, 80n, 81n, 280n, 779n, 780n]) {
    const plan = planTransfer(coins([500n], [80n], [200n]), want(amount));
    const inSum = plan.inputs.reduce((s, c) => s + c.value, 0n);
    const outSum = plan.outputs.reduce((s, o) => s + o.value, 0n);
    assert.equal(inSum, outSum, `amount ${amount}`);
  }
});

test('planTransfer: more than the snapshot holds, zero and negative are refused', () => {
  assert.throws(() => planTransfer(coins([80n], [200n]), want(281n)), /holds only 280/);
  assert.throws(() => planTransfer(coins([80n]), want(1n, TOKEN)), /holds only 0/);
  assert.throws(() => planTransfer(coins([80n]), want(0n)), /positive/);
  assert.throws(() => planTransfer(coins([80n]), want(-5n)), /positive/);
});

// ---------- snapshot ----------

const ADDRESS = encodeAddress('preprod', OWN);
const snapshot = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 'v2',
    writtenBy: 'v2',
    networkId: 'preprod',
    publicKey: { publicKey: { tag: 'schnorr', value: '33'.repeat(32) }, addressHex: OWN, address: ADDRESS },
    state: { availableUtxos: [{ utxo: { value: '5000', owner: ADDRESS, type: NIGHT, intentHash: hash(1), outputNo: 0 } }], pendingUtxos: [] },
    protocolVersion: '2001100',
    ...overrides,
  });

test('checkSnapshot: accepts a ledger 9 snapshot for this network and wallet', () => {
  const info = checkSnapshot(snapshot(), { network: 'preprod', address: ADDRESS });
  assert.equal(info.available.get(NIGHT), 5000n);
});

test('checkSnapshot: another network, another wallet, ledger 8 and junk are refused', () => {
  const expected = { network: 'preprod', address: ADDRESS } as const;
  assert.throws(() => checkSnapshot(snapshot({ networkId: 'mainnet' }), expected), /for network "mainnet" but this page is set to "preprod"/);
  assert.throws(() => checkSnapshot(snapshot(), { network: 'preprod', address: encodeAddress('preprod', RECIPIENT) }), /not this wallet's address/);
  assert.throws(() => checkSnapshot(snapshot({ protocolVersion: '1000300', writtenBy: 'v1' }), expected), /below 2000000/);
  assert.throws(() => checkSnapshot(snapshot({ protocolVersion: undefined }), expected), /missing/);
  assert.throws(() => checkSnapshot('not json', expected), /not valid JSON/);
  assert.throws(() => checkSnapshot('[]', expected), /Unrecognised snapshot format/);
});
