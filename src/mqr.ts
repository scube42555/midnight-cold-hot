// Frame format for moving a small file between two machines as a sequence of QR codes.
//
// One frame is one line of plain ASCII text:
//   MQR1:<kind>:<session>:<index>:<total>:<hash>:<data>
//   kind     lowercase label such as "snapshot" or "tx"
//   session  6 hex characters, random per transfer, so frames from two transfers cannot be mixed
//   index    1-based position of this frame; total is the number of frames
//   hash     first 32 hex characters of SHA-256 over the compressed payload
//   data     one slice of the compressed payload, base64url
//
// The receiver collects every frame, checks the hash, then the payload is decompressed with a size limit.
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const PREFIX = 'MQR1';
export const DEFAULT_CHUNK_CHARS = 300;
export const MAX_FRAMES = 9999; // the frame format stores index and total in at most 4 digits
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const FRAME_RE = /^MQR1:([a-z]{1,12}):([0-9a-f]{6}):(\d{1,4}):(\d{1,4}):([0-9a-f]{32}):([A-Za-z0-9_-]+)$/;

export const sha256hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export type Frame = {
  kind: string;
  session: string;
  index: number;
  total: number;
  hash: string;
  data: string;
};

export const parseFrame = (line: string): Frame | undefined => {
  const m = FRAME_RE.exec(line.trim());
  if (!m) return undefined;
  const index = Number(m[3]);
  const total = Number(m[4]);
  if (total < 1 || total > MAX_FRAMES || index < 1 || index > total) return undefined;
  return { kind: m[1], session: m[2], index, total, hash: m[5], data: m[6] };
};

export const encodeFrames = (
  kind: string,
  payload: Uint8Array,
  chunkChars: number = DEFAULT_CHUNK_CHARS,
): { frames: string[]; session: string; hash: string; compressedBytes: number } => {
  if (!/^[a-z]{1,12}$/.test(kind)) throw new Error('The kind must be 1 to 12 lowercase letters.');
  if (!Number.isInteger(chunkChars) || chunkChars < 100 || chunkChars > 1000) {
    throw new Error('The chunk size must be a whole number from 100 to 1000 characters.');
  }
  if (payload.length === 0) throw new Error('Nothing to send: the file is empty.');

  const compressed = deflateSync(payload, { level: 9 });
  const hash = sha256hex(compressed).slice(0, 32);
  const text = Buffer.from(compressed).toString('base64url');
  const total = Math.ceil(text.length / chunkChars);
  if (total > MAX_FRAMES) throw new Error(
      `Too large: ${total} frames needed, the limit is ${MAX_FRAMES}. Use a larger --chunk (up to 1000) or split the file into parts.`,
    );

  const session = randomBytes(3).toString('hex');
  const frames = Array.from(
    { length: total },
    (_, i) => `${PREFIX}:${kind}:${session}:${i + 1}:${total}:${hash}:${text.slice(i * chunkChars, (i + 1) * chunkChars)}`,
  );
  return { frames, session, hash, compressedBytes: compressed.length };
};

/** Join frames (in any order, duplicates allowed) back into the compressed payload, verifying the hash. */
export const assembleFrames = (lines: string[]): { kind: string; session: string; compressed: Uint8Array } => {
  const wanted = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (wanted.length === 0) throw new Error('No frames found.');

  const frames = wanted.map((line, i) => {
    const frame = parseFrame(line);
    if (!frame) throw new Error(`Line ${i + 1} is not a valid frame.`);
    return frame;
  });

  const first = frames[0];
  const byIndex = new Map<number, string>();
  for (const f of frames) {
    if (f.kind !== first.kind || f.session !== first.session || f.total !== first.total || f.hash !== first.hash) {
      throw new Error('Frames from different transfers are mixed together.');
    }
    const seen = byIndex.get(f.index);
    if (seen !== undefined && seen !== f.data) throw new Error(`Frame ${f.index} appears twice with different contents.`);
    byIndex.set(f.index, f.data);
  }

  const missing: number[] = [];
  for (let i = 1; i <= first.total; i++) if (!byIndex.has(i)) missing.push(i);
  if (missing.length > 0) {
    throw new Error(`Missing frame(s): ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', ...' : ''}`);
  }

  const text = Array.from({ length: first.total }, (_, i) => byIndex.get(i + 1)!).join('');
  const compressed = Buffer.from(text, 'base64url');
  if (sha256hex(compressed).slice(0, 32) !== first.hash) throw new Error('Checksum mismatch: the data is damaged.');
  return { kind: first.kind, session: first.session, compressed };
};

/** Decompress with a hard size limit so a hostile file cannot expand without bound. */
export const inflatePayload = (compressed: Uint8Array, maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES): Buffer => {
  try {
    return inflateSync(compressed, { maxOutputLength: maxBytes });
  } catch (err) {
    throw new Error(`Could not decompress (damaged data, or larger than ${maxBytes} bytes): ${(err as Error).message}`);
  }
};

export const decodeMqrText = (
  text: string,
  maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
): { kind: string; session: string; payload: Buffer } => {
  const { kind, session, compressed } = assembleFrames(text.split(/\r?\n/));
  return { kind, session, payload: inflatePayload(compressed, maxBytes) };
};
