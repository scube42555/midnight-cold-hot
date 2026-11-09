// Turn received frames back into the original file.
//
// Usage: node dist/qr-decode.js <input.mqr> <output file> [--max-bytes N]
// The input is the text file the receiver page saves (one frame per line).
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_MAX_OUTPUT_BYTES, decodeMqrText, sha256hex } from './mqr.js';

const args = process.argv.slice(2);
let maxBytes = DEFAULT_MAX_OUTPUT_BYTES;
const mb = args.indexOf('--max-bytes');
if (mb >= 0) {
  maxBytes = Number(args[mb + 1]);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('--max-bytes needs a positive whole number.');
  args.splice(mb, 2);
}
const [input, output] = args;
if (!input || !output || args.length !== 2) {
  throw new Error('Usage: node dist/qr-decode.js <input.mqr> <output file> [--max-bytes N]');
}

const { kind, session, payload } = decodeMqrText(readFileSync(input, 'utf8'), maxBytes);

// Check that the content looks like what its label says before anything else reads it.
if (kind === 'tx') {
  if (!/^(?:[0-9a-f]{2})+$/i.test(payload.toString('utf8').trim())) throw new Error('A "tx" transfer must contain a hex string.');
} else if (kind === 'snapshot') {
  const parsed: unknown = JSON.parse(payload.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('A "snapshot" must be a JSON object.');
} else {
  console.warn(`Note: kind "${kind}" has no content check.`);
}

writeFileSync(output, payload, { mode: 0o600 });
console.log(`Decoded ${payload.length} bytes (kind=${kind}, session=${session}) to ${output}`);
console.log(`SHA-256: ${sha256hex(payload).slice(0, 16)}...  (compare with what the sender printed)`);
