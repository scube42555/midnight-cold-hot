import './redact.js'; // first: from here on, anything printed has credentials removed
import { getNetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NoOpTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk';

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
setNetworkId(NETWORK);

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
    indexerHttpUrl: process.env.INDEXER_HTTP_URL ?? d.indexerHttpUrl,
    indexerWsUrl: process.env.INDEXER_WS_URL ?? d.indexerWsUrl,
    node: process.env.NODE_URL ?? d.node,
    // The proof server is always local, on every network, because it handles private data. It receives the
    // sponsor's DUST secret key inside each proof request. See the README before pointing this at a LAN host.
    proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
  };
};

/** Cold machine endpoints. The cold script replaces every network service with a stub, so none is contacted. */
export const coldEndpoints = (): Endpoints => ({
  indexerHttpUrl: 'http://127.0.0.1:9/graphql',
  indexerWsUrl: 'ws://127.0.0.1:9/graphql/ws',
  node: 'http://127.0.0.1:9',
  proofServer: 'http://127.0.0.1:9',
});

export const walletConfig = (e: Endpoints) => ({
  networkId: getNetworkId(),
  indexerClientConnection: {
    indexerHttpUrl: e.indexerHttpUrl,
    indexerWsUrl: e.indexerWsUrl,
  },
  provingServerUrl: new URL(e.proofServer),
  relayURL: new URL(e.node.replace(/^http/, 'ws')),
  txHistoryStorage: new NoOpTransactionHistoryStorage(),
  costParameters: {
    additionalFeeOverhead: ADDITIONAL_FEE_OVERHEAD,
    feeBlocksMargin: 5,
  },
});
