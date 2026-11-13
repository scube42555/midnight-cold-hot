// Moving a small file between two machines as a sequence of QR codes: the Node side.
// The frame format itself (pattern, splitting, joining) is in mqr-core.ts, shared with the cold page.
//
// The receiver collects every frame, checks the hash, then the payload is decompressed with a size limit.
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { DEFAULT_CHUNK_CHARS, DEFAULT_MAX_OUTPUT_BYTES, checkEncodeArgs, joinFrames, splitIntoFrames } from './mqr-core.js';

export { PREFIX, DEFAULT_CHUNK_CHARS, MAX_FRAMES, DEFAULT_MAX_OUTPUT_BYTES, FRAME_RE, parseFrame, type Frame } from './mqr-core.js';

export const sha256hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const encodeFrames = (
  kind: string,
  payload: Uint8Array,
  chunkChars: number = DEFAULT_CHUNK_CHARS,
): { frames: string[]; session: string; hash: string; compressedBytes: number } => {
  checkEncodeArgs(kind, payload.length, chunkChars);

  const compressed = deflateSync(payload, { level: 9 });
  const hash = sha256hex(compressed).slice(0, 32);
  const text = Buffer.from(compressed).toString('base64url');
  const session = randomBytes(3).toString('hex');
  const frames = splitIntoFrames(kind, session, hash, text, chunkChars);
  return { frames, session, hash, compressedBytes: compressed.length };
};

/** Join frames (in any order, duplicates allowed) back into the compressed payload, verifying the hash. */
export const assembleFrames = (lines: string[]): { kind: string; session: string; compressed: Uint8Array } => {
  const first = joinFrames(lines);
  const compressed = Buffer.from(first.text, 'base64url');
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
