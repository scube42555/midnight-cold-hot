import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLogFilter, isNoisyLine } from '../src/logfilter.js';

test('isNoisyLine: matches Wallet.Sync and API-WS', () => {
  assert.ok(isNoisyLine('Wallet.Sync: [object CloseEvent]'));
  assert.ok(isNoisyLine('Wallet.Sync [info]: disconnected'));
  assert.ok(isNoisyLine('API-WS: some message'));
  assert.ok(isNoisyLine('API-WS [1]: reconnecting'));
});

test('isNoisyLine: does not match other lines', () => {
  assert.ok(!isNoisyLine(''));
  assert.ok(!isNoisyLine('Synced in 4 min'));
  assert.ok(!isNoisyLine('  Wallet.Sync: indented'));
  assert.ok(!isNoisyLine('Something Wallet.Sync: mid-line'));
});

test('verbose mode: passes everything through', () => {
  const filter = makeLogFilter('verbose');
  const text = 'Wallet.Sync: [object CloseEvent]\nAPI-WS: message\nnormal\n';
  assert.equal(filter(text), text);
});

test('cold mode: first noisy event emits one summary line', () => {
  const filter = makeLogFilter('cold');
  const out = filter('Wallet.Sync: [object CloseEvent]\n');
  const lines = out.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('[offline, expected'));
  assert.ok(lines[0].includes('1'));
});

test('cold mode: consecutive noisy lines in one burst collapse to one line', () => {
  const filter = makeLogFilter('cold');
  const out = filter('Wallet.Sync: a\nWallet.Sync: b\nWallet.Sync: c\n');
  const lines = out.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1);
});

test('cold mode: non-noisy lines pass through', () => {
  const filter = makeLogFilter('cold');
  const out = filter('normal\nWallet.Sync: error\nnormal again\n');
  assert.ok(out.includes('normal'));
  assert.ok(out.includes('normal again'));
  assert.ok(!out.includes('Wallet.Sync: error'));
});

test('cold mode: each new burst increments the count', () => {
  const filter = makeLogFilter('cold');
  filter('Wallet.Sync: a\n');
  filter('normal\n');
  const out = filter('Wallet.Sync: b\n');
  const lines = out.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('2'));
});

test('cold mode: burst spanning two writes merges correctly', () => {
  const filter = makeLogFilter('cold');
  const out1 = filter('Wallet.Sync: a\n');
  const out2 = filter('Wallet.Sync: b\n'); // same burst (no non-noisy line between)
  const lines = (out1 + out2).split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1); // only one summary
});

test('hot mode: first noisy event emits one short line', () => {
  const filter = makeLogFilter('hot');
  const out = filter('Wallet.Sync: [object CloseEvent]\n');
  const lines = out.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('connection dropped'));
});

test('hot mode: consecutive lines in one burst collapse to one', () => {
  const filter = makeLogFilter('hot');
  const out = filter('Wallet.Sync: a\nWallet.Sync: b\n');
  const lines = out.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1);
});

test('hot mode: second event shows times count', () => {
  const filter = makeLogFilter('hot');
  filter('Wallet.Sync: a\n');
  filter('normal\n');
  const out = filter('Wallet.Sync: b\n');
  const lines = out.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('2'));
});

test('hot mode: non-noisy lines pass through', () => {
  const filter = makeLogFilter('hot');
  const out = filter('Synced in 4 min 45 s\n');
  assert.ok(out.includes('Synced in 4 min 45 s'));
});

// --- stack trace and error object continuation suppression ---

test('cold mode: stack trace after noisy line is suppressed', () => {
  const filter = makeLogFilter('cold');
  const dump = [
    'Wallet.Sync: connection failed',
    '    at Object.foo (/node_modules/sdk/dist/Sync.js:96:261)',
    '    at runMicrotasks (<anonymous>)',
    '    at processTicksAndRejections (node:internal/process/task_queues:96:5) {',
    "  _tag: 'Wallet.Sync'",
    '}',
    '',
  ].join('\n');
  const out = filter(dump);
  const lines = out.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('[offline, expected'));
  assert.ok(!out.includes('    at '));
  assert.ok(!out.includes('_tag'));
});

test('hot mode: stack trace after noisy line is suppressed', () => {
  const filter = makeLogFilter('hot');
  const dump = 'Wallet.Sync: err\n    at foo.js:1:1\n  _tag: \'x\'\n}\n';
  const out = filter(dump);
  assert.ok(!out.includes('    at '));
  assert.ok(!out.includes('_tag'));
});

test('cold mode: indented token listing after clean line passes through', () => {
  // "  NIGHT  (00000000...): ..." starts with 2 spaces + uppercase — must NOT be suppressed
  const filter = makeLogFilter('cold');
  filter('Wallet.Sync: err\n    at foo:1:1\n}\n'); // noise block clears
  filter('Wallets settled at protocol version 2000000 (ledger 9).\n'); // non-noisy resets state
  const out = filter("  NIGHT  (00000000...00000000): 5000000000 STAR (5000.000000 NIGHT)\n");
  assert.ok(out.includes('  NIGHT'));
});

test('trailing newline is preserved', () => {
  const filter = makeLogFilter('cold');
  const out = filter('normal\n');
  assert.equal(out, 'normal\n');
});

test('chunk without trailing newline is handled', () => {
  const filter = makeLogFilter('hot');
  const out = filter('no newline');
  assert.equal(out, 'no newline');
});
