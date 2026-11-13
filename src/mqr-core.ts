// The MQR1 frame format itself: the frame pattern, splitting text into frames and joining frames back.
// No compression, hashing or platform imports here, so the Node scripts (mqr.ts) and the cold page (coldpage/mqr-web.ts)
// share one definition. The receiver page and tools/qr_scan.py still carry their own copy of the pattern: keep them equal.
//
// One frame is one line of plain ASCII text:
//   MQR1:<kind>:<session>:<index>:<total>:<hash>:<data>
//   kind     lowercase label such as "snapshot" or "tx"
//   session  6 hex characters, random per transfer, so frames from two transfers cannot be mixed
//   index    1-based position of this frame; total is the number of frames
//   hash     first 32 hex characters of SHA-256 over the compressed payload
//   data     one slice of the compressed payload, base64url

export const PREFIX = 'MQR1';
export const DEFAULT_CHUNK_CHARS = 300;
export const MAX_FRAMES = 9999; // the frame format stores index and total in at most 4 digits
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const FRAME_RE = /^MQR1:([a-z]{1,12}):([0-9a-f]{6}):(\d{1,4}):(\d{1,4}):([0-9a-f]{32}):([A-Za-z0-9_-]+)$/;

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

/** Checks made before anything is compressed. */
export const checkEncodeArgs = (kind: string, payloadLength: number, chunkChars: number): void => {
  if (!/^[a-z]{1,12}$/.test(kind)) throw new Error('The kind must be 1 to 12 lowercase letters.');
  if (!Number.isInteger(chunkChars) || chunkChars < 100 || chunkChars > 1000) {
    throw new Error('The chunk size must be a whole number from 100 to 1000 characters.');
  }
  if (payloadLength === 0) throw new Error('Nothing to send: the file is empty.');
};

/** Cut the base64url text of a compressed payload into frames. `hash` is the 32-character checksum of that payload. */
export const splitIntoFrames = (kind: string, session: string, hash: string, text: string, chunkChars: number): string[] => {
  const total = Math.ceil(text.length / chunkChars);
  if (total > MAX_FRAMES) {
    throw new Error(
      `Too large: ${total} frames needed, the limit is ${MAX_FRAMES}. Use a larger --chunk (up to 1000) or split the file into parts.`,
    );
  }
  return Array.from(
    { length: total },
    (_, i) => `${PREFIX}:${kind}:${session}:${i + 1}:${total}:${hash}:${text.slice(i * chunkChars, (i + 1) * chunkChars)}`,
  );
};

/**
 * Join frames (in any order, duplicates allowed) back into the base64url text of the compressed payload.
 * The caller must still decode it, compare its SHA-256 with `hash`, and decompress with a size limit.
 */
export const joinFrames = (lines: string[]): { kind: string; session: string; total: number; hash: string; text: string } => {
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
  return { kind: first.kind, session: first.session, total: first.total, hash: first.hash, text };
};
