// Compares the cold page's code with the wallet SDK, the way cold-transfer uses it. These tests import the SDK, so they
// live apart from tests/ and run with `npm run test:sdk`. Every key is random and thrown away; every snapshot is made up.
// The wallets start offline and print "Wallet.Sync" errors: expected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { firstValueFrom, timeout } from 'rxjs';
import {
  DustWallet,
  MidnightBech32m,
  ProtocolVersion,
  PublicKey,
  ShieldedWallet,
  UnshieldedAddress,
  UnshieldedWallet,
  WalletFacade,
  generateMnemonicWords,
} from '@midnightntwrk/wallet-sdk';
import * as L from '@midnightntwrk/wallet-sdk/ledger/v9';
import { NETWORK, NETWORK_ID, coldEndpoints, walletConfig } from '../src/config.js';
import { deriveAndWipe, seedFromMnemonic, type WalletKeys } from '../src/keys.js';
import { toHex } from '../src/hex.js';
import { NIGHT, readTransaction } from '../src/txinfo.js';
import {
  type ColdKeys,
  type NetworkName,
  buildTransfer,
  checkSnapshot,
  coldPublicJson,
  decodeAddress,
  encodeAddress,
  keysFromUnshieldedSeed,
  planTransfer,
  verifyBuilt,
} from '../src/coldpage/core.js';
import { deriveColdKeys } from '../src/coldpage/keys.js';

const network = NETWORK as NetworkName;
const TOKEN = 'c0'.repeat(32);

const randomWallet = (): { sdk: WalletKeys; page: ColdKeys } => {
  const sdk = deriveAndWipe(randomBytes(64));
  return { sdk, page: keysFromUnshieldedSeed(L, sdk.seeds.unshielded, network) };
};

/** A snapshot in the shape hot-watch writes, holding made-up coins for this wallet. */
const fakeSnapshot = (keys: ColdKeys, coins: [bigint, string][]): string =>
  JSON.stringify({
    version: 'v2',
    writtenBy: 'v2',
    publicKey: { publicKey: keys.publicKey, addressHex: keys.addressHex, address: keys.address },
    state: {
      availableUtxos: coins.map(([value, type], i) => ({
        utxo: { value: value.toString(), owner: keys.address, type, intentHash: toHex(randomBytes(32)), outputNo: i },
        meta: { ctime: '2026-11-06T22:22:54.000Z', registeredForDustGeneration: false },
      })),
      pendingUtxos: [],
    },
    protocolVersion: '2001100',
    appliedId: '737342',
    networkId: network,
  });

/** The transfer as cold-transfer makes it: offline facade, restored snapshot, payFees: false. */
const sdkTransfer = async (
  keys: WalletKeys,
  snapshot: string,
  to: string,
  tokenType: string,
  amount: bigint,
  ttl: Date,
  alsoAdopt?: Uint8Array,
): Promise<Uint8Array> => {
  const refuse = () => Promise.reject(new Error('requested on the cold machine'));
  const facade = await WalletFacade.init({
    configuration: walletConfig(coldEndpoints()),
    provingService: () =>
      ({
        prove: (t: { prove: (p: unknown, c: unknown) => Promise<unknown> }) =>
          t.prove({ prove: refuse, check: refuse, lookupKey: refuse }, L.CostModel.initialCostModel()),
      }) as never,
    submissionService: () => ({ submitTransaction: refuse, close: () => Promise.resolve() }) as never,
    shielded: (cfg) => ShieldedWallet(cfg).startWithSeed(keys.seeds.shielded),
    unshielded: (cfg) => UnshieldedWallet(cfg).restore(snapshot),
    dust: (cfg) => DustWallet(cfg).startWithSeed(keys.seeds.dust),
  });
  await facade.start(keys.seeds);
  const state = await firstValueFrom(facade.state().pipe(timeout(30_000)));
  assert.equal(state.protocol._tag, 'Settled');
  assert.ok((state.protocol as { version: bigint }).version >= ProtocolVersion.V9NativeForkVersion);
  if (alsoAdopt) {
    // The SDK's own reader accepts the page's bytes as a finalized ledger 9 transaction.
    const adopted = await facade.adoptTransaction(alsoAdopt, 'Finalized');
    assert.ok(adopted.protocolVersion >= ProtocolVersion.V9NativeForkVersion);
  }
  const receiverAddress = MidnightBech32m.parse(to).decode(UnshieldedAddress, NETWORK_ID);
  const recipe = await facade.transferTransaction(
    [{ type: 'unshielded', outputs: [{ type: tokenType as never, receiverAddress, amount }] }],
    { ttl, payFees: false },
  );
  const signed = await facade.signRecipe(recipe, keys.unshieldedKeystore.signDataAsync);
  const finalized = await facade.finalizeRecipe(signed);
  return finalized.serialize();
};

/** Everything in a transaction except the parts that are random on every signing (signatures and binding). */
const shapeOf = (bytes: Uint8Array): string => {
  const tx = L.Transaction.deserialize('signature', 'proof', 'binding', bytes);
  const parts: unknown[] = [];
  for (const [segment, intent] of tx.intents ?? []) {
    for (const [name, offer] of [
      ['guaranteed', intent.guaranteedUnshieldedOffer],
      ['fallible', intent.fallibleUnshieldedOffer],
    ] as const) {
      if (!offer) continue;
      parts.push({
        segment,
        name,
        ttl: intent.ttl.toISOString(),
        binding: intent.binding.instance,
        actions: intent.actions.length,
        dust: intent.dustActions === undefined ? 'none' : 'present',
        inputs: offer.inputs.map((i) => `${i.intentHash}#${i.outputNo}:${i.type}:${i.value}:${i.owner.tag}:${i.owner.value}`),
        outputs: offer.outputs.map((o) => `${o.owner}:${o.type}:${o.value}`),
        signatures: offer.signatures.length,
      });
    }
  }
  return JSON.stringify(parts, null, 1);
};

// ---------- keys and addresses ----------

test('keys: the page derives the same key, address and cold-public.json as the Node scripts', () => {
  for (const passphrase of ['', 'correct horse  Battery staple ']) {
    const phrase = generateMnemonicWords().join(' ');
    const sdk = deriveAndWipe(seedFromMnemonic(phrase, passphrase));
    const page = deriveColdKeys(L, `  ${phrase.toUpperCase().replace(/ /g, '   ')}\n`, passphrase, network);
    assert.equal(page.address, sdk.unshieldedKeystore.getBech32Address().asString());
    assert.equal(page.addressHex, sdk.unshieldedKeystore.getAddress());
    assert.equal(page.secretHex, toHex(sdk.unshieldedKeystore.getSecretKey()));
    assert.deepEqual(page.publicKey, sdk.unshieldedKeystore.getPublicKey());
    // The file cold-export-public writes, byte for byte.
    const exported = JSON.stringify(
      { sdk: 2, network: NETWORK, address: page.address, publicKey: PublicKey.fromKeyStore(sdk.unshieldedKeystore) },
      null,
      2,
    );
    assert.equal(coldPublicJson(network, page), exported);
  }
  assert.throws(() => deriveColdKeys(L, 'abandon abandon abandon', '', network), /Not a valid BIP-39/);
});

test('keys: a different passphrase gives a different wallet', () => {
  const phrase = generateMnemonicWords().join(' ');
  assert.notEqual(deriveColdKeys(L, phrase, '', network).address, deriveColdKeys(L, phrase, 'x', network).address);
});

test('addresses: the page codec agrees with the SDK codec', () => {
  for (const net of ['undeployed', 'preview', 'preprod', 'mainnet'] as const) {
    const bytes = randomBytes(32);
    const sdkText = UnshieldedAddress.codec.encode(net as never, new UnshieldedAddress(bytes)).asString();
    assert.equal(encodeAddress(net, toHex(bytes)), sdkText);
    assert.equal(decodeAddress(net, sdkText), toHex(bytes));
  }
  // A shielded address is not an unshielded one.
  assert.throws(() => decodeAddress('preprod', 'mn_shield-addr_preprod1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'), /Midnight address/);
});

// ---------- the transfer, page against SDK ----------

const cases: { name: string; coins: [bigint, string][]; tokenType: string; amount: bigint }[] = [
  { name: 'NIGHT with change, one coin', coins: [[80_000_000n, NIGHT], [4_998_500_000n, NIGHT]], tokenType: NIGHT, amount: 1_000_000n },
  { name: 'NIGHT, several coins', coins: [[300n, NIGHT], [100n, NIGHT], [200n, NIGHT], [5000n, NIGHT]], tokenType: NIGHT, amount: 550n },
  { name: 'NIGHT, exact amount, no change', coins: [[700n, NIGHT], [5000n, NIGHT]], tokenType: NIGHT, amount: 700n },
  { name: 'another token (guaranteed part)', coins: [[9000n, NIGHT], [40n, TOKEN], [70n, TOKEN]], tokenType: TOKEN, amount: 50n },
];

for (const c of cases) {
  test(`transfer: same transaction as the SDK: ${c.name}`, async () => {
    const wallet = randomWallet();
    const recipient = randomWallet().page;
    const snapshot = fakeSnapshot(wallet.page, c.coins);
    const ttl = new Date(Date.now() + 120 * 60_000);

    const info = checkSnapshot(snapshot, { network, address: wallet.page.address });
    const plan = planTransfer(info, {
      tokenType: c.tokenType,
      amount: c.amount,
      recipientHex: decodeAddress(network, recipient.address),
      ownAddressHex: wallet.page.addressHex,
    });
    const built = await buildTransfer(L, { network, keys: wallet.page, plan, ttl });
    assert.equal(built.proverRequested, false);
    const details = verifyBuilt(L, built.bytes, { network, keys: wallet.page, plan, ttl });
    assert.equal(details.contractActions, 0);

    const sdkBytes = await sdkTransfer(wallet.sdk, snapshot, recipient.address, c.tokenType, c.amount, ttl, built.bytes);
    assert.equal(shapeOf(built.bytes), shapeOf(sdkBytes));
    // The byte length is not compared: it moves by a byte or two between identical builds (a random part is stored compactly).
    // The page's own check also accepts the SDK's transaction for the same plan.
    verifyBuilt(L, sdkBytes, { network, keys: wallet.page, plan, ttl });

    // What the hot machine will show about it.
    const shown = readTransaction(L.Transaction.deserialize('signature', 'proof', 'binding', built.bytes) as never, {
      addressOfKey: (key) => L.addressFromKey(key as never),
      bech32: (hex) => encodeAddress(network, hex),
    });
    assert.deepEqual([...new Set(shown.inputs.map((i) => i.address))], [wallet.page.address]);
    assert.ok(shown.outputs.some((o) => o.address === recipient.address && o.value === c.amount && o.type === c.tokenType));
  });
}

// ---------- the page's check of its own result ----------

test('verifyBuilt: refuses a transaction that differs from the plan in any way', async () => {
  const wallet = randomWallet();
  const recipient = randomWallet().page;
  const stranger = randomWallet().page;
  const info = checkSnapshot(fakeSnapshot(wallet.page, [[300n, NIGHT], [5000n, NIGHT]]), { network, address: wallet.page.address });
  const want = { tokenType: NIGHT, amount: 100n, recipientHex: recipient.addressHex, ownAddressHex: wallet.page.addressHex };
  const plan = planTransfer(info, want);
  const ttl = new Date(Date.now() + 60 * 60_000);
  const { bytes } = await buildTransfer(L, { network, keys: wallet.page, plan, ttl });
  verifyBuilt(L, bytes, { network, keys: wallet.page, plan, ttl });

  const refuses = (changed: Partial<Parameters<typeof verifyBuilt>[2]>, pattern: RegExp) =>
    assert.throws(() => verifyBuilt(L, bytes, { network, keys: wallet.page, plan, ttl, ...changed }), pattern);
  refuses({ plan: planTransfer(info, { ...want, amount: 101n }) }, /outputs differ/);
  refuses({ plan: planTransfer(info, { ...want, recipientHex: stranger.addressHex }) }, /outputs differ/);
  refuses({ plan: planTransfer(info, { ...want, amount: 301n }) }, /coins spent differs|not planned/);
  refuses({ plan: { ...plan, inputs: [{ ...plan.inputs[0], outputNo: plan.inputs[0].outputNo + 1 }] } }, /not planned/);
  refuses({ plan: { ...plan, inputs: [{ ...plan.inputs[0], value: plan.inputs[0].value + 1n }] } }, /not planned/);
  refuses({ ttl: new Date(ttl.getTime() + 1000) }, /expiry time differs/);
  refuses({ keys: stranger }, /another key/);
  // A flipped byte in the middle either fails to decode or fails a check; it never passes.
  const damaged = Uint8Array.from(bytes);
  damaged[Math.floor(damaged.length / 2)] ^= 0x01;
  assert.throws(() => verifyBuilt(L, damaged, { network, keys: wallet.page, plan, ttl }));
});

test('buildTransfer: a key that does not own the coins cannot produce a transaction that verifies for the owner', async () => {
  const wallet = randomWallet();
  const thief = randomWallet().page;
  const info = checkSnapshot(fakeSnapshot(wallet.page, [[300n, NIGHT]]), { network, address: wallet.page.address });
  const plan = planTransfer(info, { tokenType: NIGHT, amount: 100n, recipientHex: thief.addressHex, ownAddressHex: wallet.page.addressHex });
  const ttl = new Date(Date.now() + 60 * 60_000);
  const { bytes } = await buildTransfer(L, { network, keys: thief, plan, ttl });
  assert.throws(() => verifyBuilt(L, bytes, { network, keys: wallet.page, plan, ttl }), /another key/);
});
