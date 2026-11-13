// MQR1 frames for the cold page: the same format as mqr.ts, with pure-JavaScript compression and hashing
// (fflate, @noble/hashes) in place of Node's zlib and crypto. Frames made here are read by qr-decode, and the reverse.
import { Unzlib, zlibSync } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64urlnopad } from '@scure/base';
import { toHex } from '../hex.js';
import { DEFAULT_CHUNK_CHARS, DEFAULT_MAX_OUTPUT_BYTES, checkEncodeArgs, joinFrames, splitIntoFrames } from '../mqr-core.js';

export { parseFrame, type Frame } from '../mqr-core.js';

const checksum = (compressed: Uint8Array): string => toHex(sha256(compressed)).slice(0, 32);

/**
 * What qr-send and qr-decode print for a person to compare: the first 16 hex characters of the SHA-256 of the
 * payload itself (the file's bytes, before compression). Not the checksum inside the frames, which covers the compressed form.
 */
export const payloadDigest = (payload: Uint8Array): string => toHex(sha256(payload)).slice(0, 16);

/** `session` is 3 random bytes from the caller, so this module needs no source of randomness of its own. */
export const encodeFramesWeb = (
  kind: string,
  payload: Uint8Array,
  session: Uint8Array,
  chunkChars: number = DEFAULT_CHUNK_CHARS,
): { frames: string[]; session: string; hash: string } => {
  checkEncodeArgs(kind, payload.length, chunkChars);
  if (session.length !== 3) throw new Error('The session must be 3 random bytes.');
  // zlib format (RFC 1950), which is what Node's deflateSync writes and inflateSync reads.
  const compressed = zlibSync(payload, { level: 9 });
  const hash = checksum(compressed);
  const sessionHex = toHex(session);
  return { frames: splitIntoFrames(kind, sessionHex, hash, base64urlnopad.encode(compressed), chunkChars), session: sessionHex, hash };
};

/** Decompress with a hard size limit: the output is counted as it is produced, and the work stops at the limit. */
const inflateCapped = (compressed: Uint8Array, maxBytes: number): Uint8Array => {
  const parts: Uint8Array[] = [];
  let size = 0;
  let ended = false;
  const stream = new Unzlib((chunk, final) => {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`it expands beyond ${maxBytes} bytes`);
    parts.push(chunk);
    if (final) ended = true;
  });
  try {
    stream.push(compressed, true);
  } catch (err) {
    throw new Error(`Could not decompress (damaged data, or larger than ${maxBytes} bytes): ${(err as Error).message}`);
  }
  if (!ended) throw new Error('Could not decompress: the data ends early.');
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Join frames (any order, duplicates allowed), check the checksum, then decompress with a size limit. */
export const decodeFramesWeb = (
  lines: string[],
  maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
): { kind: string; session: string; total: number; payload: Uint8Array } => {
  const joined = joinFrames(lines);
  let compressed: Uint8Array;
  try {
    compressed = base64urlnopad.decode(joined.text);
  } catch {
    throw new Error('Checksum mismatch: the data is damaged.');
  }
  if (checksum(compressed) !== joined.hash) throw new Error('Checksum mismatch: the data is damaged.');
  return { kind: joined.kind, session: joined.session, total: joined.total, payload: inflateCapped(compressed, maxBytes) };
};
