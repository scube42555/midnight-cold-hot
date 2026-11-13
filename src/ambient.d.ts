// qrcode-generator is plain JavaScript; treat it as untyped so the build does not depend on its typings.
declare module 'qrcode-generator';

// Made by scripts/build-cold-page.mjs: the ledger 9 WebAssembly module, inlined in the page and started without a fetch.
declare module 'virtual:ledger-v9' {
  export const loadLedger: () => Promise<typeof import('@midnightntwrk/wallet-sdk/ledger/v9')>;
}
