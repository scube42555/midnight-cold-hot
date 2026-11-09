export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const fromHex = (hex: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('Expected a hex string.');
  return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
};
