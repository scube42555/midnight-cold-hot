import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decodeMqrText, encodeFrames, parseFrame } from '../src/mqr.js';
import { decodeFramesWeb, encodeFramesWeb } from '../src/coldpage/mqr-web.js';

const session = (): Uint8Array => randomBytes(3);
// Text that compresses, followed by bytes that do not, so several frames are needed.
const sample = (): Uint8Array => Buffer.concat([Buffer.from(JSON.stringify({ a: 'x'.repeat(500), b: [1, 2, 3] })), randomBytes(900)]);

test('node: frames round trip', () => {
  const payload = sample();
  const { frames } = encodeFrames('snapshot', payload);
  assert.ok(frames.length > 1);
  const back = decodeMqrText(frames.join('\n'));
  assert.equal(back.kind, 'snapshot');
  assert.deepEqual(new Uint8Array(back.payload), new Uint8Array(payload));
});

test('frames made by Node are read by the page code', () => {
  const payload = sample();
  const { frames, session: s } = encodeFrames('snapshot', payload);
  const back = decodeFramesWeb(frames);
  assert.equal(back.kind, 'snapshot');
  assert.equal(back.session, s);
  assert.equal(back.total, frames.length);
  assert.deepEqual(back.payload, new Uint8Array(payload));
});

test('frames made by the page code are read by Node', () => {
  const payload = sample();
  const { frames } = encodeFramesWeb('tx', payload, session());
  for (const f of frames) assert.ok(parseFrame(f), 'every frame matches the shared pattern');
  const back = decodeMqrText(`${frames.join('\r\n')}\n`);
  assert.equal(back.kind, 'tx');
  assert.deepEqual(new Uint8Array(back.payload), new Uint8Array(payload));
});

test('page code: any order, duplicates allowed', () => {
  const payload = sample();
  const { frames } = encodeFramesWeb('tx', payload, session(), 100);
  const shuffled = [...frames].reverse().concat(frames[0], '', '  ');
  assert.deepEqual(decodeFramesWeb(shuffled).payload, new Uint8Array(payload));
});

test('page code: refuses missing, mixed, damaged and malformed frames', () => {
  const a = encodeFramesWeb('tx', sample(), session(), 100).frames;
  const b = encodeFramesWeb('tx', sample(), session(), 100).frames;
  assert.throws(() => decodeFramesWeb(a.slice(1)), /Missing frame/);
  assert.throws(() => decodeFramesWeb([a[0], b[1]]), /different transfers/);
  assert.throws(() => decodeFramesWeb([]), /No frames/);
  assert.throws(() => decodeFramesWeb(['MQR1:tx:zzzzzz:1:1:00:AA']), /not a valid frame/);
  assert.throws(() => decodeFramesWeb(['hello']), /not a valid frame/);
  // Change one character of the data in the first frame: same length, so only the checksum can notice.
  const parts = a[0].split(':');
  parts[6] = (parts[6][0] === 'A' ? 'B' : 'A') + parts[6].slice(1);
  assert.throws(() => decodeFramesWeb([parts.join(':'), ...a.slice(1)]), /Checksum mismatch/);
});

test('page code: decompression stops at the size limit', () => {
  const big = new Uint8Array(200_000); // zeros: a few hundred bytes compressed
  const { frames } = encodeFramesWeb('snapshot', big, session(), 1000);
  assert.ok(frames.length <= 2);
  assert.throws(() => decodeFramesWeb(frames, 100_000), /Could not decompress/);
  assert.equal(decodeFramesWeb(frames, 200_000).payload.length, 200_000);
});

test('page code: the same argument checks as Node', () => {
  assert.throws(() => encodeFramesWeb('TX', sample(), session()), /lowercase/);
  assert.throws(() => encodeFramesWeb('tx', new Uint8Array(0), session()), /empty/);
  assert.throws(() => encodeFramesWeb('tx', sample(), session(), 50), /chunk size/);
  assert.throws(() => encodeFramesWeb('tx', sample(), new Uint8Array(2)), /3 random bytes/);
});
