// Collapses repetitive SDK log lines (Wallet.Sync, API-WS) that the connection layer emits.
// No SDK imports. Called from redact.ts after redaction; unrecognised lines pass through unchanged.
//
// Cold mode: suppress each block; emit one "[offline, expected]" line per new event with a running count.
// Hot mode: one short line per distinct event; recurring events show "(N times)" instead of repeating.
// Verbose (LOG_VERBOSE=1): pass everything through unchanged.

export type FilterMode = 'cold' | 'hot' | 'verbose';

/** True if a log line opens an SDK WebSocket connection error. */
export const isNoisyLine = (line: string): boolean => /^(Wallet\.Sync|API-WS)/.test(line);

/**
 * True if a line is a continuation of a noise block (stack trace, error object dump).
 * Node.js prints an Error as: the message line, then "    at ..." stack lines, then the
 * error's own properties as an inline object ("  _tag: 'Wallet.Sync'" etc.).
 * This matches those trailing lines without matching our own indented output such as
 * "  NIGHT  (...): ..." or "  Token  (...): ..." which start with an uppercase letter.
 */
const isNoisyContinuation = (line: string): boolean =>
  /^ {4}at /.test(line) ||          // stack trace (4-space indent + "at ")
  /^ {2}[a-z_$'"]/.test(line) ||    // error-object property (2-space + lowercase/underscore/quote)
  line === '{' || line === '}';      // lone braces from the object dump

/**
 * Returns a stateful filter function. Each call processes one stream chunk (possibly multiple lines)
 * and returns the filtered text. State persists across calls so bursts spanning multiple writes are merged.
 */
export function makeLogFilter(mode: FilterMode): (chunk: string) => string {
  if (mode === 'verbose') return (chunk) => chunk;

  let lastWasNoisy = false; // was the last processed line a noisy one?
  let eventCount = 0;       // number of distinct events (each new burst after a non-noisy line)

  return function filter(chunk: string): string {
    const parts = chunk.split('\n');
    const out: string[] = [];

    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      // The last element is '' when the chunk ends with \n — preserve it to keep newlines intact.
      if (i === parts.length - 1 && line === '') {
        out.push('');
        break;
      }

      if (isNoisyLine(line)) {
        if (!lastWasNoisy) {
          eventCount++;
          if (mode === 'cold') {
            out.push(`[offline, expected: SDK connection error (${eventCount} so far; details suppressed)]`);
          } else {
            out.push(
              eventCount === 1
                ? 'Wallet.Sync: connection dropped, SDK reconnecting'
                : `Wallet.Sync: connection dropped (${eventCount} times)`,
            );
          }
        }
        // consecutive noisy lines in the same burst: suppress silently
        lastWasNoisy = true;
      } else if (lastWasNoisy && isNoisyContinuation(line)) {
        // stack trace or error-object dump following the noisy line: suppress silently
      } else {
        lastWasNoisy = false;
        out.push(line);
      }
    }

    return out.join('\n');
  };
}
