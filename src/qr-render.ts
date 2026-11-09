// Turns QR module matrices into something you can look at. No QR maths here, so no dependency.
export type Matrix = boolean[][];

const QUIET = 4; // blank border, in modules, required for reliable scanning

/** One QR code as an inline SVG: black modules on a white square. */
export const svgOf = (m: Matrix): string => {
  const n = m.length;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (m[r][c]) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
  }
  const size = n + 2 * QUIET;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  );
};

/** One QR code for a terminal: two module rows per text row, black on white regardless of theme. */
export const termOf = (m: Matrix): string => {
  const n = m.length;
  const size = n + 2 * QUIET;
  const dark = (r: number, c: number): boolean =>
    r >= QUIET && r < n + QUIET && c >= QUIET && c < n + QUIET ? m[r - QUIET][c - QUIET] : false;
  const rows: string[] = [];
  for (let r = 0; r < size; r += 2) {
    let line = '';
    for (let c = 0; c < size; c++) {
      const fg = dark(r, c) ? 30 : 97;
      const bg = dark(r + 1, c) ? 40 : 107;
      line += `\x1b[${fg};${bg}m\u2580`;
    }
    rows.push(`${line}\x1b[0m`);
  }
  return rows.join('\n');
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A self-contained page that cycles through the frames. It needs no network and no library. */
export const senderPage = (svgs: string[], meta: { kind: string; session: string; label: string }): string => {
  const data = JSON.stringify(svgs).replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QR sender: ${escapeHtml(meta.kind)} ${escapeHtml(meta.session)}</title>
<style>
:root { color-scheme: light; }
body { margin: 0; background: #fff; color: #111; font: 16px system-ui, sans-serif; text-align: center; }
#qr { width: min(92vw, 80vh); margin: 8px auto 0; }
#qr svg { width: 100%; height: auto; display: block; }
.controls { display: flex; flex-wrap: wrap; gap: 8px 16px; justify-content: center; align-items: center; padding: 8px; }
button { font: inherit; padding: 6px 14px; }
</style></head><body>
<div id="qr"></div>
<p id="label"></p>
<div class="controls">
<button id="play" type="button">Pause</button>
<button id="prev" type="button">Previous</button>
<button id="next" type="button">Next</button>
<label>Frame time <input id="speed" type="range" min="200" max="2000" step="100" value="600"> <span id="ms">600</span> ms</label>
</div>
<p>${escapeHtml(meta.label)}</p>
<script>
const FRAMES = ${data};
let i = 0, playing = true, ms = 600, timer = null;
const $ = (id) => document.getElementById(id);
function show() {
  $('qr').innerHTML = FRAMES[i];
  $('label').textContent = 'Frame ' + (i + 1) + ' of ' + FRAMES.length;
}
function schedule() {
  clearTimeout(timer);
  if (playing) timer = setTimeout(() => { i = (i + 1) % FRAMES.length; show(); schedule(); }, ms);
}
$('play').onclick = () => { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; schedule(); };
$('prev').onclick = () => { i = (i - 1 + FRAMES.length) % FRAMES.length; show(); schedule(); };
$('next').onclick = () => { i = (i + 1) % FRAMES.length; show(); schedule(); };
$('speed').oninput = (e) => { ms = Number(e.target.value); $('ms').textContent = String(ms); schedule(); };
show(); schedule();
</script></body></html>
`;
};
