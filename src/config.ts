import './redact.js'; // first: from here on, anything printed has credentials removed
import { NoOpTransactionHistoryStorage, ProtocolVersion, createKeystore } from '@midnightntwrk/wallet-sdk';

// Every script imports this module first, so the network is set before any key or address is derived.
// Choose the network with MIDNIGHT_NETWORK: undeployed | preview | preprod | mainnet (default: preprod).
export const NETWORKS = ['undeployed', 'preview', 'preprod', 'mainnet'] as const;
export type NetworkName = (typeof NETWORKS)[number];

const requested = process.env.MIDNIGHT_NETWORK ?? 'preprod';
if (!(NETWORKS as readonly string[]).includes(requested)) {
  throw new Error(`MIDNIGHT_NETWORK must be one of: ${NETWORKS.join(', ')} (got "${requested}").`);
}
export const NETWORK = requested as NetworkName;

if (NETWORK === 'mainnet' && process.env.ALLOW_MAINNET !== '1') {
  throw new Error(
    'Mainnet moves real funds and these scripts are untested. Set ALLOW_MAINNET=1 only after the full test plan has passed on preprod.',
  );
}

/**
 * The network ID in the SDK's own type. Wallet SDK 2 has no global network ID (Midnight.js 5 removed setNetworkId):
 * it is passed explicitly to the wallet config, the keystore and the address codecs.
 * Verified (11 Nov 2026): the plain network name is accepted as the SDK's NetworkId.
 */
export type SdkNetworkId = Parameters<typeof createKeystore>[1];
export const NETWORK_ID = NETWORK as unknown as SdkNetworkId;

/**
 * Extra DUST the wallet declares on top of the ledger's price, as in the docs' Node.js guide (0.3 DUST). A DUST spend
 * gets no refund, so the sponsor pays all of it on every transaction. It is a safety margin; see the README before changing it.
 */
export const ADDITIONAL_FEE_OVERHEAD = 300_000_000_000_000n;

export type Endpoints = {
  indexerHttpUrl: string;
  indexerWsUrl: string;
  node: string;
  proofServer: string;
};

/** An environment override. Unset AND empty both mean "use the default": `??` alone lets an empty string through. */
const override = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

/** Parse a URL, or fail naming the setting. The value is never shown, because it can contain a token. */
const asUrl = (setting: string, value: string): URL => {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${setting} is not a valid URL (the value is not shown: it may contain a token). Unset it to use the default.`);
  }
};

const withToken = (url: string, projectId: string): string =>
  `${url}${url.includes('?') ? '&' : '?'}project_id=${encodeURIComponent(projectId)}`;

/** Preprod and mainnet are served by Blockfrost, which needs a project token for that network. */
const blockfrost = (net: 'preprod' | 'mainnet'): Omit<Endpoints, 'proofServer'> => {
  const projectId = process.env.BLOCKFROST_PROJECT_ID?.trim();
  if (!projectId) throw new Error(`BLOCKFROST_PROJECT_ID is not set. ${net} needs a Blockfrost Midnight ${net} project token.`);
  if (!projectId.startsWith(`night${net}`)) {
    throw new Error(`BLOCKFROST_PROJECT_ID does not look like a Midnight ${net} project ID (those start with "night${net}").`);
  }
  return {
    indexerHttpUrl: withToken(`https://midnight-${net}.blockfrost.io/api/v0`, projectId),
    indexerWsUrl: withToken(`wss://midnight-${net}.blockfrost.io/api/v0/ws`, projectId),
    node: withToken(`https://rpc.midnight-${net}.blockfrost.io`, projectId),
  };
};

const defaultEndpoints = (net: NetworkName): Omit<Endpoints, 'proofServer'> => {
  switch (net) {
    case 'undeployed':
      return {
        indexerHttpUrl: 'http://localhost:8088/api/v4/graphql',
        indexerWsUrl: 'ws://localhost:8088/api/v4/graphql/ws',
        node: 'http://localhost:9944',
      };
    case 'preview': // Midnight-hosted, no token
      return {
        indexerHttpUrl: 'https://indexer.preview.midnight.network/api/v4/graphql',
        indexerWsUrl: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
        node: 'https://rpc.preview.midnight.network',
      };
    case 'preprod':
    case 'mainnet':
      return blockfrost(net);
  }
};

/**
 * Hot machine endpoints, from the docs' environment reference. Override any of them with
 * INDEXER_HTTP_URL, INDEXER_WS_URL, NODE_URL or PROOF_SERVER_URL. The URLs on preprod and mainnet
 * contain your Blockfrost token: never print or log them.
 */
export const hotEndpoints = (): Endpoints => {
  const d = defaultEndpoints(NETWORK);
  return {
    indexerHttpUrl: override('INDEXER_HTTP_URL') ?? d.indexerHttpUrl,
    indexerWsUrl: override('INDEXER_WS_URL') ?? d.indexerWsUrl,
    node: override('NODE_URL') ?? d.node,
    // The proof server is always local, on every network, because it handles private data. It receives the
    // sponsor's DUST secret key inside each proof request. See the README before pointing this at a LAN host.
    proofServer: override('PROOF_SERVER_URL') ?? 'http://127.0.0.1:6300',
  };
};

/** Cold machine endpoints. The cold script replaces every network service with a stub, so none is contacted. */
export const coldEndpoints = (): Endpoints => ({
  indexerHttpUrl: 'http://127.0.0.1:9/graphql',
  indexerWsUrl: 'ws://127.0.0.1:9/graphql/ws',
  node: 'http://127.0.0.1:9',
  proofServer: 'http://127.0.0.1:9',
});

/**
 * A chain-version probe that answers without asking anyone: the chain is on ledger 9 (the protocol version a 2.x node reports).
 * It is ON by default: every public network now runs ledger 9, and without it an idle address or an offline machine stays on the
 * ledger 8 variant (measured: an offline facade settled at protocol version 0 and a snapshot was written by the v1 variant).
 * Turn it off with ASSUME_LEDGER9=0, for a chain still on ledger 8.
 * The docs say a wallet with no probe starts on the ledger 8 variant and only learns otherwise from a message addressed to it, so an
 * idle address, or an offline machine, stays on ledger 8 and builds transactions the chain refuses. With a probe it "starts at the
 * variant that owns the version the chain reports".
 * Only correct while the network really is on ledger 9. Verified (11 Nov 2026): the shape is correct — a function returning a
 * promise of the protocol version. The offline facade settled at 2000000 and cold-transfer produced a valid ledger 9 transaction.
 */
export const assumeLedger9 = async () => ProtocolVersion.V9NativeForkVersion;

const assumeByDefault = process.env.ASSUME_LEDGER9 !== '0';

export const walletConfig = (e: Endpoints, options: { assumeLedger9?: boolean } = {}) => ({
  networkId: NETWORK_ID,
  indexerClientConnection: {
    indexerHttpUrl: (asUrl('INDEXER_HTTP_URL', e.indexerHttpUrl), e.indexerHttpUrl),
    indexerWsUrl: (asUrl('INDEXER_WS_URL', e.indexerWsUrl), e.indexerWsUrl),
  },
  provingServerUrl: asUrl('PROOF_SERVER_URL', e.proofServer),
  relayURL: asUrl('NODE_URL', e.node.replace(/^http/, 'ws')),
  txHistoryStorage: new NoOpTransactionHistoryStorage(),
  costParameters: {
    additionalFeeOverhead: ADDITIONAL_FEE_OVERHEAD,
    feeBlocksMargin: 5,
  },
  ...((options.assumeLedger9 ?? assumeByDefault) ? { chainVersionProbe: assumeLedger9 } : {}),
});
