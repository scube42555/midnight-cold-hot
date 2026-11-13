// The cold page's controller. Everything that arrives from outside (files, pasted text, camera) is shown with textContent
// only; innerHTML is used for QR codes drawn from our own data and nothing else.
// Bundled into dist/cold-page.html by scripts/build-cold-page.mjs. It never runs under Node.
import jsqrModule from 'jsqr';
import qrcode from 'qrcode-generator';
import { loadLedger } from 'virtual:ledger-v9';
import { toHex } from '../hex.js';
import { DEFAULT_MAX_OUTPUT_BYTES } from '../mqr-core.js';
import type { SnapshotInfo } from '../snapshot.js';
import { localStamp } from '../timefmt.js';
import { NIGHT, amountText, formatNight } from '../txinfo.js';
import {
  type ColdKeys,
  type Ledger,
  type NetworkName,
  type Plan,
  TX_HEX_RE,
  buildTransfer,
  checkSnapshot,
  coldPublicJson,
  decodeAddress,
  encodeAddress,
  isNetwork,
  parseAmount,
  parseTtlMinutes,
  planTransfer,
  verifyBuilt,
  wholeSeconds,
} from './core.js';
import { deriveColdKeys } from './keys.js';
import { type Frame, decodeFramesWeb, encodeFramesWeb, parseFrame } from './mqr-web.js';

// jsqr is a CommonJS bundle: depending on the tool that reads it, the function is the module itself or its `default`.
const jsQR: typeof jsqrModule.default = jsqrModule.default ?? (jsqrModule as unknown as typeof jsqrModule.default);

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Page element #${id} is missing.`);
  return e as T;
};
const input = (id: string) => $<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);
const show = (e: HTMLElement, on: boolean): void => {
  e.hidden = !on;
};
const setErr = (id: string, msg: string): void => {
  $(id).textContent = msg;
  show($(id), msg !== '');
};
const unlock = (id: string, on: boolean): void => {
  $(id).classList.toggle('locked', !on);
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const el = (tag: string, text?: string, cls?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const kvRows = (dl: HTMLElement, rows: [string, string][]): void => {
  dl.replaceChildren();
  for (const [k, v] of rows) dl.append(el('dt', k), el('dd', v));
};
const shortType = (type: string): string => `${type.slice(0, 8)}…${type.slice(-8)}`;
const tokenName = (type: string): string => (type === NIGHT ? 'NIGHT' : `token ${shortType(type)}`);

// ---------------------------------------------------------------- state

let L: Ledger | undefined;
let network: NetworkName = 'preprod';
let keys: ColdKeys | undefined;
let snapshot: SnapshotInfo | undefined;
let reviewed: { plan: Plan; ttlMinutes: number; recipient: string } | undefined;
let signedFromThisSnapshot = false;

if (navigator.onLine) show($('online'), true);
window.addEventListener('online', () => show($('online'), true));

loadLedger().then(
  (ledger) => {
    L = ledger;
    show($('loading'), false);
    button('derive').disabled = false;
  },
  (e) => {
    show($('loading'), false);
    $('fatal').textContent = `The ledger module could not start: ${messageOf(e)}. This browser may have WebAssembly turned off (Tor Browser does at the "Safer" and "Safest" levels).`;
    show($('fatal'), true);
  },
);

// ---------------------------------------------------------------- QR display

const svgOf = (text: string): string => {
  const qr = qrcode(0, 'M'); // type 0 picks the smallest version that fits; M is medium error correction
  qr.addData(text, 'Byte');
  qr.make();
  const n: number = qr.getModuleCount();
  const quiet = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const size = n + 2 * quiet;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  );
};

let qrTimers: { box: HTMLElement; timer: number }[] = [];
const stopQr = (box: HTMLElement): void => {
  qrTimers = qrTimers.filter((x) => {
    if (x.box !== box) return true;
    window.clearInterval(x.timer);
    return false;
  });
  box.replaceChildren();
};

/** Show `text` as a cycling sequence of MQR1 QR codes inside `box`, with the frames as text underneath. */
const showQr = (box: HTMLElement, kind: string, text: string, label: string): void => {
  stopQr(box);
  const { frames, session } = encodeFramesWeb(kind, new TextEncoder().encode(text), crypto.getRandomValues(new Uint8Array(3)));
  const svgs = frames.map(svgOf); // our own data only
  const wrap = el('div', undefined, 'qrbox');
  const qr = el('div', undefined, 'qr');
  const meta = el('div', undefined, 'qrmeta');
  const status = el('p');
  const raw = el('pre', frames.join('\n'));
  meta.append(
    status,
    el('p', `${label}: MQR1 kind "${kind}", session ${session}. Receive it on the hot machine with receiver.html or qr_scan.py, then decode with qr-decode.`),
    el('p', 'Frames as text:'),
    raw,
  );
  wrap.append(qr, meta);
  box.append(wrap);
  let i = 0;
  const draw = (): void => {
    qr.innerHTML = svgs[i];
    status.textContent = `Frame ${i + 1} of ${frames.length}`;
  };
  draw();
  if (frames.length > 1) {
    const timer = window.setInterval(() => {
      i = (i + 1) % frames.length;
      draw();
    }, 700);
    qrTimers.push({ box, timer });
  }
};

const downloadLink = (a: HTMLAnchorElement, text: string): void => {
  if (a.href.startsWith('blob:')) URL.revokeObjectURL(a.href);
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
};

// ---------------------------------------------------------------- reset

/** Forget everything from step `n` on: 1 = keys, 2 = snapshot, 3 = the reviewed plan, 5 = the signed transfer only. */
const resetFrom = (n: number): void => {
  if (n <= 1) {
    keys = undefined;
    show($('keysOut'), false);
    $('public').textContent = '';
    stopQr($('publicQrBox'));
    unlock('s2', false);
    button('snapFileBtn').disabled = true;
    button('camBtn').disabled = true;
    button('snapCheck').disabled = true;
    stopCamera();
  }
  if (n <= 2) {
    snapshot = undefined;
    signedFromThisSnapshot = false;
    show($('snapOut'), false);
    $('snapChecks').replaceChildren();
    $('snapKv').replaceChildren();
    $('token').replaceChildren();
    unlock('s3', false);
    button('review').disabled = true;
  }
  if (n <= 3) {
    reviewed = undefined;
    unlock('s4', false);
    $('planWarn').replaceChildren();
    $('planKv').replaceChildren();
    $('planCoins').replaceChildren();
    input('confirm').value = '';
    button('sign').disabled = true;
    setErr('signErr', '');
  }
  unlock('s5', false);
  show($('txOut'), false);
  $('txHex').textContent = '';
  $('txPlan').textContent = '';
  stopQr($('txQrBox'));
};

// ---------------------------------------------------------------- step 1: keys

const readNetwork = (): void => {
  const value = input('network').value;
  if (!isNetwork(value)) throw new Error('Choose a network.');
  network = value;
};

input('network').addEventListener('change', () => {
  show($('mainnetRow'), input('network').value === 'mainnet');
  $<HTMLInputElement>('mainnetOk').checked = false;
  resetFrom(1);
});
for (const id of ['phrase', 'pass']) input(id).addEventListener('input', () => resetFrom(1));
$('mainnetOk').addEventListener('change', () => resetFrom(1));

button('derive').addEventListener('click', () => {
  resetFrom(1);
  setErr('keysErr', '');
  try {
    if (!L) throw new Error('The ledger module has not started yet.');
    readNetwork();
    if (network === 'mainnet' && !$<HTMLInputElement>('mainnetOk').checked) {
      throw new Error('Mainnet moves real funds and this page is untested there. Tick the box above only after the full test plan has passed on preprod.');
    }
    keys = deriveColdKeys(L, input('phrase').value, input('pass').value, network);
  } catch (e) {
    setErr('keysErr', messageOf(e));
    return;
  }
  $('kNetwork').textContent = network;
  $('kAddress').textContent = keys.address;
  const publicFile = coldPublicJson(network, keys);
  $('public').textContent = publicFile;
  downloadLink($<HTMLAnchorElement>('publicDl'), publicFile);
  show($('keysOut'), true);
  unlock('s2', true);
  button('snapFileBtn').disabled = false;
  button('camBtn').disabled = false;
  button('snapCheck').disabled = false;
  if (input('snapText').value.trim()) runSnapshotCheck();
});

button('publicQr').addEventListener('click', () => {
  try {
    showQr($('publicQrBox'), 'pubkey', $('public').textContent ?? '', 'cold-public.json');
  } catch (e) {
    setErr('keysErr', messageOf(e));
  }
});

button('clear').addEventListener('click', () => {
  for (const id of ['phrase', 'pass', 'snapText', 'to', 'amount', 'confirm']) input(id).value = '';
  input('ttl').value = '120';
  $('amountEcho').textContent = '';
  for (const id of ['keysErr', 'snapErr', 'planErr', 'signErr']) setErr(id, '');
  resetFrom(1);
});

// ---------------------------------------------------------------- step 2: snapshot

const MAX_INPUT_BYTES = DEFAULT_MAX_OUTPUT_BYTES;

button('snapFileBtn').addEventListener('click', () => $('snapFile').click());
$<HTMLInputElement>('snapFile').addEventListener('change', () => {
  const f = $<HTMLInputElement>('snapFile').files?.[0];
  $<HTMLInputElement>('snapFile').value = '';
  if (f) void loadSnapshotFile(f);
});

const loadSnapshotFile = async (f: File): Promise<void> => {
  setErr('snapErr', '');
  if (!keys) {
    setErr('snapErr', 'Derive your address in step 1 first, then load the snapshot.');
    return;
  }
  if (f.size > MAX_INPUT_BYTES) {
    setErr('snapErr', 'The file is too large (over 4 MB) to be a snapshot.');
    return;
  }
  stopCamera();
  input('snapText').value = await f.text();
  runSnapshotCheck();
};

input('snapText').addEventListener('input', () => resetFrom(2));
// Pasted text (for example frames put on the clipboard by qr_scan.py --clipboard) is checked straight away.
input('snapText').addEventListener('paste', () =>
  window.setTimeout(() => {
    if (keys && input('snapText').value.trim()) runSnapshotCheck();
  }, 0),
);
button('snapCheck').addEventListener('click', () => runSnapshotCheck());

// Every drop is caught, so a stray drop cannot make the browser leave the page and lose what was entered.
let dragDepth = 0;
const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (hasFiles(e)) {
    e.preventDefault();
    dragDepth++;
    $('s2').classList.add('dropping');
  }
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('s2').classList.remove('dropping');
  }
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('s2').classList.remove('dropping');
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length === 0) return;
  if (files.length > 1) {
    setErr('snapErr', 'Drop one file at a time.');
    return;
  }
  void loadSnapshotFile(files[0]);
  $('s2').scrollIntoView({ block: 'start' });
});

/** Text from any source to the snapshot JSON. MQR1 frames are joined, checked and decompressed first. */
const snapshotTextFrom = (text: string): { json: string; note: string } => {
  if (text.length > 2 * MAX_INPUT_BYTES) throw new Error('The text is too large to be a snapshot.');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length > 0 && lines.every((l) => l.startsWith('MQR1:'))) {
    const d = decodeFramesWeb(lines, MAX_INPUT_BYTES);
    if (d.kind !== 'snapshot') throw new Error(`These frames carry "${d.kind}", not a snapshot. Send it with: qr-send snapshot <file>.`);
    return {
      json: new TextDecoder('utf-8', { fatal: true }).decode(d.payload),
      note: `Joined ${d.total} MQR1 frame(s), session ${d.session}; checksum correct.`,
    };
  }
  return { json: text, note: '' };
};

function runSnapshotCheck(): void {
  resetFrom(2);
  setErr('snapErr', '');
  if (!keys) {
    setErr('snapErr', 'Derive your address in step 1 first.');
    return;
  }
  let info: SnapshotInfo;
  let note: string;
  try {
    const read = snapshotTextFrom(input('snapText').value);
    note = read.note;
    info = checkSnapshot(read.json, { network, address: keys.address });
    if (info.availableCount === 0) throw new Error('The snapshot holds no coins. Take a new one with hot-watch once the wallet is funded.');
  } catch (e) {
    setErr('snapErr', messageOf(e));
    return;
  }
  snapshot = info;

  const checks = $('snapChecks');
  if (note) checks.append(el('li', note, 'info'));
  checks.append(
    el('li', `It is for this network (${info.network}).`, 'ok'),
    el('li', 'It is for this wallet\'s address.', 'ok'),
    el('li', `It is on ledger 9: protocol version ${info.protocolVersion}, written by ${info.writtenBy ?? 'an unknown variant'}.`, 'ok'),
  );
  if (info.pendingCount > 0) {
    checks.append(
      el(
        'li',
        `It lists ${info.pendingCount} pending coin(s): a transaction from this address may be in flight. Take a fresh snapshot once nothing is pending, or this transfer may fail.`,
        'warn',
      ),
    );
  }
  checks.append(
    el('li', 'This page cannot tell how old the snapshot is. If the wallet has spent since it was taken, the network will refuse the transfer.', 'info'),
  );
  const rows: [string, string][] = [['Coins', String(info.availableCount)]];
  for (const [type, balance] of info.available) rows.push([type === NIGHT ? 'NIGHT' : `Token ${type}`, amountText(type, balance)]);
  kvRows($('snapKv'), rows);
  show($('snapOut'), true);

  // NIGHT first, then the other tokens in the snapshot's order.
  const types = [...info.available.keys()].sort((a, b) => (a === NIGHT ? -1 : b === NIGHT ? 1 : 0));
  for (const type of types) {
    const option = el('option', `${tokenName(type)}: ${amountText(type, info.available.get(type) ?? 0n)}`) as HTMLOptionElement;
    option.value = type;
    $('token').append(option);
  }
  updateAmountHint();
  unlock('s3', true);
  button('review').disabled = false;
}

// ---------------------------------------------------------------- camera (optional)

let stream: MediaStream | undefined;
let scanTimer: number | undefined;
let collect: { first: Frame; lines: Map<number, string> } | undefined;
button('camBtn').addEventListener('click', () => void startCamera());
button('camStop').addEventListener('click', () => stopCamera());

async function startCamera(): Promise<void> {
  setErr('snapErr', '');
  if (!navigator.mediaDevices?.getUserMedia) {
    setErr('snapErr', 'This browser cannot use a camera here. Use tools/qr_scan.py and load the .mqr file instead.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    setErr('snapErr', `The camera could not start (${e instanceof Error ? e.name : String(e)}). Use tools/qr_scan.py and load the .mqr file instead.`);
    return;
  }
  collect = undefined;
  const video = $<HTMLVideoElement>('video');
  video.srcObject = stream;
  await video.play();
  show($('camBox'), true);
  show($('camStop'), true);
  show($('camBtn'), false);
  $('camStatus').textContent = 'Scanning… point the camera at the hot machine\'s QR codes.';
  const canvas = $<HTMLCanvasElement>('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  scanTimer = window.setInterval(() => {
    if (video.readyState < 2) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
    if (code?.data) acceptFrame(code.data);
  }, 150);
}

function acceptFrame(text: string): void {
  if (text.length > 4000) return;
  const f = parseFrame(text);
  if (!f) return;
  if (!collect) collect = { first: f, lines: new Map() };
  const first = collect.first;
  if (f.session !== first.session || f.kind !== first.kind || f.total !== first.total || f.hash !== first.hash) return; // locked on the first transfer seen
  collect.lines.set(f.index, text.trim());
  $('camStatus').textContent = `Transfer ${first.session} (${first.kind}): ${collect.lines.size} of ${first.total} frames.`;
  if (collect.lines.size === first.total) {
    const lines = Array.from({ length: first.total }, (_, i) => collect!.lines.get(i + 1)!);
    stopCamera();
    input('snapText').value = `${lines.join('\n')}\n`;
    runSnapshotCheck();
  }
}

function stopCamera(): void {
  if (scanTimer !== undefined) window.clearInterval(scanTimer);
  scanTimer = undefined;
  stream?.getTracks().forEach((t) => t.stop());
  stream = undefined;
  show($('camBox'), false);
  show($('camStop'), false);
  show($('camBtn'), true);
}

// ---------------------------------------------------------------- step 3: the transfer

function updateAmountHint(): void {
  const type = input('token').value;
  $('amountHint').textContent = type === NIGHT ? '(in STAR, the smallest unit: 1 NIGHT = 1,000,000 STAR)' : '(in that token\'s smallest unit; its decimals are not known here)';
  let echo = '';
  try {
    const amount = parseAmount(input('amount').value);
    echo = type === NIGHT ? `= ${formatNight(amount)} NIGHT` : `= ${amount} smallest units`;
  } catch {
    // not a number yet: say nothing until Review
  }
  $('amountEcho').textContent = echo;
}

for (const id of ['to', 'amount', 'ttl']) {
  input(id).addEventListener('input', () => {
    resetFrom(3);
    updateAmountHint();
  });
}
input('token').addEventListener('change', () => {
  resetFrom(3);
  updateAmountHint();
});

button('review').addEventListener('click', () => {
  resetFrom(3);
  setErr('planErr', '');
  if (!keys || !snapshot) {
    setErr('planErr', 'Derive your address and load a snapshot first.');
    return;
  }
  let plan: Plan;
  let ttlMinutes: number;
  let recipient: string;
  try {
    const recipientHex = decodeAddress(network, input('to').value);
    recipient = encodeAddress(network, recipientHex);
    const amount = parseAmount(input('amount').value);
    ttlMinutes = parseTtlMinutes(input('ttl').value);
    const tokenType = input('token').value;
    if (!snapshot.available.has(tokenType)) throw new Error('Choose a token the snapshot holds.');
    plan = planTransfer(snapshot, { tokenType, amount, recipientHex, ownAddressHex: keys.addressHex });
  } catch (e) {
    setErr('planErr', messageOf(e));
    return;
  }
  reviewed = { plan, ttlMinutes, recipient };

  const warn = $('planWarn');
  if (plan.recipientHex === keys.addressHex) warn.append(el('div', 'The recipient is this wallet\'s own address: the transfer sends to yourself.', 'banner warn'));
  if (snapshot.pendingCount > 0) warn.append(el('div', `The snapshot lists ${snapshot.pendingCount} pending coin(s); this transfer may fail.`, 'banner warn'));
  if (signedFromThisSnapshot) {
    warn.append(el('div', 'A transfer was already signed from this snapshot on this page. They spend the same coins, so the network will accept only one of them.', 'banner warn'));
  }
  const available = snapshot.available.get(plan.tokenType) ?? 0n;
  kvRows($('planKv'), [
    ['Network', network],
    ['From', keys.address],
    ['To', recipient],
    ['Token', plan.tokenType === NIGHT ? 'NIGHT' : `custom token ${plan.tokenType}`],
    ['Amount', amountText(plan.tokenType, plan.amount)],
    ['Change', plan.change > 0n ? `${amountText(plan.tokenType, plan.change)} (returns to the From address)` : 'none'],
    ['Balance before', `${amountText(plan.tokenType, available)} (from the snapshot)`],
    ['Balance after', amountText(plan.tokenType, available - plan.amount)],
    ['Valid for', `${ttlMinutes} minutes after you sign`],
    ['Fee', 'paid in DUST by the hot machine\'s sponsor wallet'],
  ]);
  const table = el('table');
  const head = el('tr');
  for (const h of ['Coin spent', 'Value']) head.append(el('th', h));
  table.append(head);
  for (const c of plan.inputs) {
    const tr = el('tr');
    tr.append(el('td', `${c.intentHash}:${c.outputNo}`, 'mono'), el('td', amountText(c.type, c.value), 'mono'));
    table.append(tr);
  }
  $('planCoins').append(table);
  unlock('s4', true);
  button('sign').disabled = false;
  $('s4').scrollIntoView({ block: 'start' });
});

window.setInterval(() => {
  $('clock').textContent = localStamp(new Date());
}, 1000);
$('clock').textContent = localStamp(new Date());

// ---------------------------------------------------------------- step 4: sign

input('confirm').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') button('sign').click();
});

button('sign').addEventListener('click', () => void sign());

async function sign(): Promise<void> {
  setErr('signErr', '');
  resetFrom(5);
  if (!L || !keys || !snapshot || !reviewed) {
    setErr('signErr', 'Review the transfer first.');
    return;
  }
  if (input('confirm').value.trim() !== 'SEND') {
    setErr('signErr', 'Type SEND (capital letters) to confirm. Nothing was signed.');
    return;
  }
  const { plan, ttlMinutes } = reviewed;
  const ledger = L;
  const signer = keys;
  const info = snapshot;
  button('sign').disabled = true;
  let hex: string;
  let summary: string[];
  try {
    const ttl = wholeSeconds(new Date(Date.now() + ttlMinutes * 60_000));
    const { bytes, proverRequested } = await buildTransfer(ledger, { network, keys: signer, plan, ttl });
    if (proverRequested) throw new Error('This transaction asked for a proof, which the cold machine cannot make');
    // Decode the bytes that will leave this page and compare them with the plan. What is shown below comes from them.
    const details = verifyBuilt(ledger, bytes, { network, keys: signer, plan, ttl });
    hex = toHex(bytes);
    if (!TX_HEX_RE.test(hex)) throw new Error('The transaction did not turn into a hex string');
    const others = details.outputs.filter((o) => o.address !== signer.address);
    const back = details.outputs.filter((o) => o.address === signer.address);
    const selfSend = plan.recipientHex === signer.addressHex;
    summary = [
      `Network:  ${network}`,
      `From:     ${signer.address}`,
      ...(selfSend ? [`To:       ${signer.address}  ${amountText(plan.tokenType, plan.amount)}  (your own address)`] : []),
      ...others.map((o) => `To:       ${o.address}  ${amountText(o.type, o.value)}`),
      ...(selfSend ? [] : back.map((o) => `Change:   ${o.address}  ${amountText(o.type, o.value)}  (returns to the From address)`)),
      `Spends:   ${details.inputs.length} coin(s) of ${info.availableCount} in the snapshot`,
      `Expires:  ${details.expires ? localStamp(details.expires) : 'unknown'}  (by this machine's clock)`,
      `Size:     ${bytes.length} bytes; no proof was needed`,
      'Fee:      paid in DUST by the hot machine\'s sponsor wallet',
    ];
  } catch (e) {
    setErr('signErr', `${messageOf(e)}. Nothing was shown or saved.`);
    button('sign').disabled = false;
    return;
  }
  input('confirm').value = '';
  signedFromThisSnapshot = true;
  $('txBanner').textContent = 'Signed. The transaction below was decoded again and matches the plan you reviewed.';
  $('txPlan').textContent = summary.join('\n');
  $('txHex').textContent = hex;
  downloadLink($<HTMLAnchorElement>('txDl'), hex);
  show($('txOut'), true);
  unlock('s5', true);
  button('sign').disabled = false;
  try {
    showQr($('txQrBox'), 'tx', hex, 'tx.hex');
  } catch (e) {
    setErr('signErr', messageOf(e));
  }
  $('s5').scrollIntoView({ block: 'start' });
}
