// Keeps credentials out of anything printed. The SDK's node connection logs lines such as
//   disconnected from wss://rpc.midnight-preprod.blockfrost.io/?project_id=<token>
// from inside a library, so redaction hooks the output streams instead of trying to wrap each message.
// It replaces `project_id=<anything>` and, if set, the value of BLOCKFROST_PROJECT_ID wherever it appears.
const PATTERN = /(project_id=)[A-Za-z0-9_.~%-]+/gi;

export const redact = (text: string): string => {
  let out = text.replace(PATTERN, '$1<redacted>');
  const token = process.env.BLOCKFROST_PROJECT_ID?.trim();
  if (token && token.length >= 8) out = out.split(token).join('<redacted>');
  return out;
};

const wrap = (stream: NodeJS.WriteStream): void => {
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === 'string') {
      chunk = redact(chunk);
    } else if (chunk instanceof Uint8Array && Buffer.from(chunk).includes('project_id=')) {
      chunk = Buffer.from(redact(Buffer.from(chunk).toString('utf8')));
    }
    return original(chunk, ...rest);
  }) as typeof stream.write;
};

wrap(process.stdout);
wrap(process.stderr);
