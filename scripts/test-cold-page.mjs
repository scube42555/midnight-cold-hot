// Drives dist/cold-page.html in headless Chromium, the way a person would, and checks what comes out with the Node code.
// Run with `npm run test:page` after `npm run build`. Needs Chromium (set CHROMIUM to its path if it is not `chromium`).
// Every key is random and thrown away, and every snapshot is made up. Nothing here touches a network: the test fails
// if the page requests anything but its own file.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as L from '@midnightntwrk/wallet-sdk/ledger/v9';
import { checkSnapshot, coldPublicJson, decodeAddress, encodeAddress, planTransfer, verifyBuilt } from '../dist/coldpage/core.js';
import { deriveColdKeys } from '../dist/coldpage/keys.js';
import { fromHex, toHex } from '../dist/hex.js';
import { decodeMqrText, encodeFrames } from '../dist/mqr.js';

const NIGHT = '0'.repeat(64);
const TOKEN = 'c0'.repeat(32);
const pageUrl = pathToFileURL(resolve('dist/cold-page.html')).href;

// ---------- a very small DevTools client (Node's built-in WebSocket; no test dependency) ----------

const profile = mkdtempSync(join(tmpdir(), 'cold-page-test-'));
const chromium = spawn(
  process.env.CHROMIUM ?? 'chromium',
  ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--no-sandbox', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const cleanUp = () => {
  chromium.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chromium may still be writing; the folder is in the system's temporary directory
  }
};
process.on('exit', cleanUp);

const wsUrl = await new Promise((ok, fail) => {
  let seen = '';
  const timer = setTimeout(() => fail(new Error(`Chromium did not start:\n${seen}`)), 20_000);
  chromium.stderr.on('data', (chunk) => {
    seen += chunk;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
    if (m) {
      clearTimeout(timer);
      ok(m[1]);
    }
  });
  chromium.on('error', (e) => fail(new Error(`Could not run Chromium (${e.message}). Set CHROMIUM to its path.`)));
});

const ws = new WebSocket(wsUrl);
await new Promise((ok, fail) => {
  ws.onopen = ok;
  ws.onerror = () => fail(new Error('Could not connect to Chromium.'));
});
let nextId = 0;
const waiting = new Map();
const requests = [];
const problems = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined) {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) w.fail(new Error(msg.error.message));
    else w.ok(msg.result);
  } else if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
  else if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push(`log: ${msg.params.entry.text}`);
};
const send = (method, params = {}, sessionId) =>
  new Promise((ok, fail) => {
    const id = ++nextId;
    waiting.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const cdp = (method, params) => send(method, params, sessionId);
await cdp('Network.enable');
await cdp('Runtime.enable');
await cdp('Log.enable');
await cdp('Page.enable');

/** Run an expression in the page and return its value. */
const page = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`In the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const js = (v) => JSON.stringify(v);
const type = (id, value) =>
  page(`(() => { const e = document.getElementById(${js(id)}); e.value = ${js(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const click = (id) => page(`document.getElementById(${js(id)}).click()`);
const text = (id) => page(`document.getElementById(${js(id)}).textContent`);
const visible = (id) => page(`!document.getElementById(${js(id)}).hidden`);
const locked = (id) => page(`document.getElementById(${js(id)}).classList.contains('locked')`);
const until = async (expression, what, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page(expression)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for: ${what}`);
};
/** The error banner's text, or '' when it is hidden. */
const banner = async (id) => ((await visible(id)) ? text(id) : '');

// ---------- test data ----------

const network = 'preprod';
const phrase = generateMnemonic(wordlist, 256);
const passphrase = 'page test Passphrase ';
const own = deriveColdKeys(L, phrase, passphrase, network);
const recipientHex = toHex(randomBytes(32));
const recipient = encodeAddress(network, recipientHex);

const snapshotOf = (keys, coins, overrides = {}) =>
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
    ...overrides,
  });
const coins = [
  [4_998_500_000n, NIGHT],
  [80_000_000n, NIGHT],
  [70n, TOKEN],
  [40n, TOKEN],
];
const snapshot = snapshotOf(own, coins);

const steps = [];
const step = async (name, fn) => {
  await fn();
  steps.push(name);
  console.log(`ok - ${name}`);
};

/** Check a transaction the page produced against a plan worked out here, and return its decoded details. */
const checkTx = (hex, want, ttlMinutes, signedAt) => {
  assert.match(hex, /^(?:[0-9a-f]{2})+$/);
  const bytes = fromHex(hex);
  const tx = L.Transaction.deserialize('signature', 'proof', 'binding', bytes);
  const ttl = [...tx.intents.values()][0].ttl;
  const expected = signedAt + ttlMinutes * 60_000;
  assert.ok(Math.abs(ttl.getTime() - expected) < 60_000, `expiry ${ttl.toISOString()} is ${ttlMinutes} minutes after signing`);
  const info = checkSnapshot(snapshot, { network, address: own.address });
  const plan = planTransfer(info, { ...want, ownAddressHex: own.addressHex });
  return verifyBuilt(L, bytes, { network, keys: own, plan, ttl });
};

// ---------- the run ----------

try {
  await cdp('Page.navigate', { url: pageUrl });
  await until(`document.getElementById('derive') && !document.getElementById('derive').disabled`, 'the ledger module to load');

  await step('loads offline: only its own file is requested, the ledger module starts', async () => {
    assert.deepEqual(requests, [pageUrl]);
    assert.equal(await visible('fatal'), false);
    assert.equal(await locked('s2'), true);
  });

  await step('the page cannot reach a network (its security policy refuses)', async () => {
    const result = await page(`fetch('http://127.0.0.1:9/').then(() => 'reached', (e) => 'refused: ' + e.message)`);
    assert.match(result, /^refused/);
    const socket = await page(`new Promise((ok) => { try { const s = new WebSocket('ws://127.0.0.1:9/'); s.onopen = () => ok('reached'); s.onerror = () => ok('refused'); } catch (e) { ok('refused: ' + e.message); } })`);
    assert.match(socket, /^refused/);
    // Those two attempts were ours, and Chromium logs each refusal: forget them so later checks see only the page's own behaviour.
    problems.length = 0;
    requests.length = 0;
  });

  await step('a wrong phrase is refused', async () => {
    await type('phrase', 'abandon abandon abandon');
    await click('derive');
    assert.match(await banner('keysErr'), /Not a valid BIP-39/);
    assert.equal(await visible('keysOut'), false);
  });

  await step('mainnet needs the box ticked', async () => {
    await type('phrase', phrase);
    await type('network', 'mainnet');
    await click('derive');
    assert.match(await banner('keysErr'), /Mainnet moves real funds/);
    assert.equal(await visible('keysOut'), false);
    await type('network', network);
  });

  await step('derives the same address and cold-public.json as the Node code', async () => {
    await type('phrase', `  ${phrase.toUpperCase()} `);
    await type('pass', passphrase);
    await click('derive');
    assert.equal(await banner('keysErr'), '');
    assert.equal(await text('kAddress'), own.address);
    assert.equal(await text('kNetwork'), network);
    assert.equal(await text('public'), coldPublicJson(network, own));
    assert.equal(await locked('s2'), false);
    // Without the passphrase it is another wallet.
    assert.notEqual(deriveColdKeys(L, phrase, '', network).address, own.address);
  });

  await step('cold-public.json as QR frames decodes in Node (kind pubkey)', async () => {
    await click('publicQr');
    const frames = await page(`document.querySelector('#publicQrBox pre').textContent`);
    const back = decodeMqrText(frames);
    assert.equal(back.kind, 'pubkey');
    assert.equal(back.payload.toString('utf8'), coldPublicJson(network, own));
    assert.ok(await page(`document.querySelector('#publicQrBox svg') !== null`));
  });

  await step('refuses a snapshot for another network, another wallet, ledger 8, or no snapshot at all', async () => {
    const stranger = deriveColdKeys(L, generateMnemonic(wordlist, 256), '', network);
    for (const [bad, pattern] of [
      [snapshotOf(own, coins, { networkId: 'mainnet' }), /for network "mainnet" but this page is set to "preprod"/],
      [snapshotOf(stranger, coins), /not this wallet's address/],
      [snapshotOf(own, coins, { protocolVersion: '1000300', writtenBy: 'v1' }), /below 2000000/],
      [snapshotOf(own, []), /holds no coins/],
      ['{"hello": 1}', /Unrecognised snapshot format/],
      ['<script>alert(1)</script>', /not valid JSON/],
      [encodeFrames('tx', Buffer.from('abcd')).frames.join('\n'), /carry "tx", not a snapshot/],
    ]) {
      await type('snapText', bad);
      await click('snapCheck');
      assert.match(await banner('snapErr'), pattern);
      assert.equal(await locked('s3'), true);
    }
  });

  await step('accepts the snapshot as MQR1 frames made by Node (kind snapshot)', async () => {
    const { frames } = encodeFrames('snapshot', Buffer.from(snapshot));
    assert.ok(frames.length > 1);
    await type('snapText', [...frames].reverse().join('\n'));
    await click('snapCheck');
    assert.equal(await banner('snapErr'), '');
    assert.equal(await locked('s3'), false);
    assert.match(await text('snapChecks'), /ledger 9: protocol version 2001100/);
    assert.match(await text('snapKv'), /5078500000 STAR \(5078\.500000 NIGHT\)/);
    assert.equal(await page(`document.getElementById('token').options.length`), 2);
    assert.equal(await page(`document.getElementById('token').value`), NIGHT);
  });

  await step('accepts the snapshot as plain JSON too', async () => {
    await type('snapText', snapshot);
    await click('snapCheck');
    assert.equal(await banner('snapErr'), '');
    assert.equal(await locked('s3'), false);
  });

  await step('refuses a bad recipient, a bad amount, too much, and a bad validity', async () => {
    const tryPlan = async (to, amount, ttl) => {
      await type('to', to);
      await type('amount', amount);
      await type('ttl', ttl);
      await click('review');
      assert.equal(await locked('s4'), true);
      return banner('planErr');
    };
    assert.match(await tryPlan(encodeAddress('mainnet', recipientHex), '1000000', '120'), /mainnet address, but this page is set to preprod/);
    assert.match(await tryPlan(recipient.slice(0, -1) + (recipient.endsWith('q') ? 'p' : 'q'), '1000000', '120'), /not a valid Midnight address/);
    assert.match(await tryPlan(recipient, '1.5', '120'), /positive whole number/);
    assert.match(await tryPlan(recipient, '1,2', '120'), /positive whole number/);
    assert.match(await tryPlan(recipient, '5078500001', '120'), /holds only 5078500000/);
    assert.match(await tryPlan(recipient, '1000000', '0'), /whole number of minutes/);
  });

  await step('review shows the plan; nothing is signed without SEND', async () => {
    await type('to', recipient);
    await type('amount', '1,000,000');
    await type('ttl', '90');
    assert.equal(await text('amountEcho'), '= 1.000000 NIGHT');
    await click('review');
    assert.equal(await banner('planErr'), '');
    assert.equal(await locked('s4'), false);
    const plan = await text('planKv');
    assert.ok(plan.includes(recipient) && plan.includes(own.address));
    assert.match(plan, /1000000 STAR \(1\.000000 NIGHT\)/);
    assert.match(plan, /79000000 STAR \(79\.000000 NIGHT\) \(returns to the From address\)/);
    assert.match(plan, /90 minutes after you sign/);
    for (const wrong of ['', 'send', 'SIGN', 'SEND!']) {
      await type('confirm', wrong);
      await click('sign');
      assert.match(await banner('signErr'), /Type SEND/);
      assert.equal(await visible('txOut'), false);
    }
  });

  let firstHex;
  await step('SEND signs: the transaction is exactly the plan, checked by the Node code', async () => {
    const signedAt = Date.now();
    await type('confirm', 'SEND');
    await click('sign');
    await until(`!document.getElementById('txOut').hidden || !document.getElementById('signErr').hidden`, 'the signature');
    assert.equal(await banner('signErr'), '');
    firstHex = await text('txHex');
    const details = checkTx(firstHex, { tokenType: NIGHT, amount: 1_000_000n, recipientHex }, 90, signedAt);
    assert.deepEqual(details.inputs.map((i) => [i.section, i.value]), [['fallible', 80_000_000n]]);
    assert.ok(details.outputs.some((o) => o.address === recipient && o.value === 1_000_000n));
    const shown = await text('txPlan');
    assert.ok(shown.includes(`To:       ${recipient}  1000000 STAR (1.000000 NIGHT)`));
    assert.ok(shown.includes(`Change:   ${own.address}  79000000 STAR (79.000000 NIGHT)`));
    assert.equal(await page(`document.getElementById('confirm').value`), '');
  });

  await step('tx.hex as QR frames decodes in Node (kind tx) to the same hex', async () => {
    const frames = await page(`document.querySelector('#txQrBox pre').textContent`);
    const back = decodeMqrText(frames);
    assert.equal(back.kind, 'tx');
    assert.equal(back.payload.toString('utf8'), firstHex);
    assert.match(await page(`document.getElementById('txDl').href`), /^blob:/);
  });

  await step('changing the amount hides the signed transfer; a second one from the same snapshot is flagged', async () => {
    await type('amount', '2000000');
    assert.equal(await visible('txOut'), false);
    assert.equal(await locked('s4'), true);
    assert.equal(await text('txHex'), '');
    await click('review');
    assert.match(await text('planWarn'), /already signed from this snapshot/);
  });

  await step('another token goes in the guaranteed part and spends only that token', async () => {
    await type('token', TOKEN);
    await type('amount', '50');
    await type('ttl', '120');
    await click('review');
    assert.equal(await banner('planErr'), '');
    const signedAt = Date.now();
    await type('confirm', 'SEND');
    await click('sign');
    await until(`!document.getElementById('txOut').hidden || !document.getElementById('signErr').hidden`, 'the signature');
    assert.equal(await banner('signErr'), '');
    const details = checkTx(await text('txHex'), { tokenType: TOKEN, amount: 50n, recipientHex }, 120, signedAt);
    // The ledger orders the inputs by coin, not by value: compare without the order.
    assert.ok(details.inputs.every((i) => i.section === 'guaranteed' && i.type === TOKEN));
    assert.deepEqual(details.inputs.map((i) => i.value).sort(), [40n, 70n]);
    assert.ok(details.outputs.every((o) => o.type === TOKEN));
  });

  await step('sending to your own address is allowed and flagged', async () => {
    await type('token', NIGHT);
    await type('to', own.address);
    await type('amount', '5');
    await click('review');
    assert.match(await text('planWarn'), /sends to yourself/);
  });

  await step('editing the phrase forgets the keys and everything after', async () => {
    await type('pass', 'another');
    assert.equal(await visible('keysOut'), false);
    assert.equal(await locked('s2'), true);
    assert.equal(await locked('s3'), true);
    assert.equal(await text('public'), '');
  });

  await step('Clear everything empties the fields', async () => {
    await click('clear');
    assert.equal(await page(`['phrase', 'pass', 'snapText', 'to', 'amount', 'confirm'].map((id) => document.getElementById(id).value).join('')`), '');
    assert.equal(await locked('s2'), true);
  });

  await step('through all of it: no request, no script error, nothing kept in browser storage', async () => {
    assert.deepEqual(requests, []);
    assert.deepEqual(problems, []);
    assert.equal(await page(`(() => { try { return localStorage.length + sessionStorage.length; } catch { return 0; } })()`), 0);
    assert.equal(await page(`document.cookie`), '');
  });

  console.log(`\n${steps.length} steps passed.`);
} catch (e) {
  console.error(`\nFAILED after ${steps.length} step(s): ${e.stack ?? e}`);
  if (problems.length) console.error(`Page problems:\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
} finally {
  ws.close();
  cleanUp();
}
