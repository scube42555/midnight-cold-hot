// Show a small file as QR codes for another machine's camera to read.
//
// Usage: node dist/qr-send.js <kind> <file> [--html out.html] [--mqr out.mqr] [--term] [--chunk N] [--fps N]
//   kind    "snapshot" (hot to cold) or "tx" (cold to hot); any 1 to 12 lowercase letters works
//   --html  write a self-contained page that cycles through the codes (best for scanning: large codes)
//   --mqr   write the frames as text, for testing without a camera (decode with qr-decode)
//   --term  show the codes in this terminal (the default when neither --html nor --mqr is given)
//   --chunk characters of data per code, 100 to 1000 (default 300; smaller codes scan more easily)
import { readFileSync, writeFileSync } from 'node:fs';
import qrcode from 'qrcode-generator';
import { DEFAULT_CHUNK_CHARS, encodeFrames, sha256hex } from './mqr.js';
import { type Matrix, senderPage, svgOf, termOf } from './qr-render.js';

const args = process.argv.slice(2);
const takeFlag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value.`);
  args.splice(i, 2);
  return value;
};
const takeSwitch = (name: string): boolean => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

const htmlOut = takeFlag('--html');
const mqrOut = takeFlag('--mqr');
const chunk = Number(takeFlag('--chunk') ?? DEFAULT_CHUNK_CHARS);
const fps = Number(takeFlag('--fps') ?? '2');
const wantTerm = takeSwitch('--term') || (htmlOut === undefined && mqrOut === undefined);
const [kind, file] = args;
if (!kind || !file || args.length !== 2) {
  throw new Error('Usage: node dist/qr-send.js <kind> <file> [--html out.html] [--mqr out.mqr] [--term] [--chunk N] [--fps N]');
}
if (!Number.isFinite(fps) || fps <= 0 || fps > 10) throw new Error('--fps must be between 0 and 10.');

const payload = readFileSync(file);
const { frames, session, hash, compressedBytes } = encodeFrames(kind, payload, chunk);

const matrixOf = (text: string): Matrix => {
  const qr = qrcode(0, 'M'); // type 0 picks the smallest version that fits; M is medium error correction
  qr.addData(text);
  qr.make();
  const n: number = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => Boolean(qr.isDark(r, c))));
};
const matrices = frames.map(matrixOf);

console.error(`File:     ${file} (${payload.length} bytes, compressed to ${compressedBytes})`);
console.error(`SHA-256:  ${sha256hex(payload).slice(0, 16)}...  (qr-decode prints the same value; compare them)`);
console.error(`Transfer: kind=${kind} session=${session} frames=${frames.length} hash=${hash.slice(0, 8)}`);

if (mqrOut) {
  writeFileSync(mqrOut, `${frames.join('\n')}\n`);
  console.error(`Wrote ${mqrOut}`);
}
if (htmlOut) {
  const label = `${file}, ${payload.length} bytes, SHA-256 ${sha256hex(payload).slice(0, 16)}`;
  writeFileSync(htmlOut, senderPage(matrices.map(svgOf), { kind, session, label }));
  console.error(`Wrote ${htmlOut}. Open it in a browser, make it full screen, and scan it with the receiver.`);
}

if (wantTerm) {
  const rows = Math.ceil((matrices[0].length + 8) / 2);
  console.error(`Each code needs a terminal of about ${matrices[0].length + 8} columns by ${rows + 2} rows. Ctrl+C to stop.`);
  const restore = () => process.stdout.write('\x1b[0m\x1b[?25h\n');
  process.on('SIGINT', () => {
    restore();
    process.exit(0);
  });
  process.stdout.write('\x1b[?25l\x1b[2J');
  let i = 0;
  const tick = () => {
    process.stdout.write(`\x1b[H${termOf(matrices[i])}\n\x1b[0mFrame ${i + 1} of ${frames.length}\x1b[K\n`);
    i = (i + 1) % frames.length;
  };
  tick();
  setInterval(tick, Math.round(1000 / fps));
}
