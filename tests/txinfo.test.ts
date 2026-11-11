import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDust, amountText, NIGHT, readTransaction, describePlan } from '../src/txinfo.js';

// --- formatDust ---

test('formatDust: zero', () => {
  assert.equal(formatDust(0n), '0.000000000000000');
});

test('formatDust: one DUST (10^15 SPECK)', () => {
  assert.equal(formatDust(1_000_000_000_000_000n), '1.000000000000000');
});

test('formatDust: 0.3 DUST overhead', () => {
  assert.equal(formatDust(300_000_000_000_000n), '0.300000000000000');
});

test('formatDust: negative', () => {
  assert.equal(formatDust(-1_000_000_000_000_000n), '-1.000000000000000');
});

// --- amountText ---

test('amountText: NIGHT shows STAR and NIGHT', () => {
  const text = amountText(NIGHT, 1_000_000n);
  assert.ok(text.includes('1000000 STAR'));
  assert.ok(text.includes('1.000000 NIGHT'));
});

test('amountText: custom token shows token type', () => {
  const type = 'ab'.repeat(32);
  const text = amountText(type, 500n);
  assert.ok(text.includes('500'));
  assert.ok(text.includes(type));
});

// --- readTransaction ---

const ADDR_HEX = 'aa'.repeat(32);
const helpers = {
  addressOfKey: (_key: unknown) => ADDR_HEX,
  bech32: (hex: string) => `bech32(${hex})`,
};

const makeIntent = (value: bigint, ttl?: Date) => ({
  ttl,
  guaranteedUnshieldedOffer: {
    inputs: [{ owner: 'key', type: NIGHT, value, intentHash: '00'.repeat(32), outputNo: 0 }],
    outputs: [{ owner: ADDR_HEX, type: NIGHT, value }],
  },
});

test('readTransaction: extracts inputs and outputs', () => {
  const tx = { intents: new Map([[0, makeIntent(1_000_000n)]]) };
  const result = readTransaction(tx, helpers);
  assert.equal(result.inputs.length, 1);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.inputs[0].value, 1_000_000n);
  assert.equal(result.contractActions, 0);
});

test('readTransaction: extracts ttl', () => {
  const future = new Date(Date.now() + 60_000);
  const tx = { intents: new Map([[0, makeIntent(1_000_000n, future)]]) };
  const result = readTransaction(tx, helpers);
  assert.equal(result.expires?.getTime(), future.getTime());
});

test('readTransaction: picks the earliest ttl across intents', () => {
  const early = new Date(Date.now() + 30_000);
  const late = new Date(Date.now() + 90_000);
  const tx = {
    intents: new Map([
      [0, makeIntent(1_000_000n, late)],
      [1, makeIntent(1_000_000n, early)],
    ]),
  };
  const result = readTransaction(tx, helpers);
  assert.equal(result.expires?.getTime(), early.getTime());
});

test('readTransaction: empty intents map', () => {
  const result = readTransaction({ intents: new Map() }, helpers);
  assert.equal(result.inputs.length, 0);
  assert.equal(result.outputs.length, 0);
  assert.equal(result.expires, undefined);
});

// --- describePlan ---

test('describePlan: includes From line', () => {
  const details = readTransaction({ intents: new Map([[0, makeIntent(1_000_000n)]]) }, helpers);
  const lines = describePlan(details);
  assert.ok(lines.some((l) => l.startsWith('From:')));
});

test('describePlan: shows "already expired" for past TTL', () => {
  const past = new Date(Date.now() - 60_000);
  const details = readTransaction({ intents: new Map([[0, makeIntent(1_000_000n, past)]]) }, helpers);
  const lines = describePlan(details, undefined, new Date());
  assert.ok(lines.some((l) => l.includes('already expired')));
});

test('describePlan: shows future expiry in minutes', () => {
  const future = new Date(Date.now() + 10 * 60_000);
  const details = readTransaction({ intents: new Map([[0, makeIntent(1_000_000n, future)]]) }, helpers);
  const now = new Date();
  const lines = describePlan(details, undefined, now);
  assert.ok(lines.some((l) => l.includes('Expires:') && l.includes('min')));
});
