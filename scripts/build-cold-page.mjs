// Builds dist/cold-page.html: one self-contained page for the offline machine, with the ledger 9 WebAssembly module,
// its JavaScript glue, the page code and its few libraries all inlined. The page loads nothing and can reach nothing.
// Build-time only (esbuild is a devDependency); the result is what goes to the cold machine.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The ledger package exports only its entry points, so find its folder the way Node would from the SDK that depends
// on it: the nearest node_modules above the SDK that holds it.
const findLedgerDir = () => {
  let dir = dirname(fileURLToPath(import.meta.resolve('@midnightntwrk/wallet-sdk')));
  for (;;) {
    const candidate = join(dir, 'node_modules', '@midnightntwrk', 'ledger-v9');
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find @midnightntwrk/ledger-v9. Run npm ci first.');
    dir = parent;
  }
};
const ledgerDir = findLedgerDir();
const ledgerVersion = JSON.parse(readFileSync(join(ledgerDir, 'package.json'), 'utf8')).version;
const glue = join(ledgerDir, 'midnight_ledger_wasm_v9_bg.js');
const wasmFile = join(ledgerDir, 'midnight_ledger_wasm_v9_bg.wasm');
const GLUE_MODULE = './midnight_ledger_wasm_v9_bg.js';

// The modules the WebAssembly binary imports from: the glue, and small "snippet" files. Read the list from the binary
// itself, so a ledger upgrade that changes it fails here and not in the browser.
const wasmBytes = readFileSync(wasmFile);
const wanted = [...new Set(WebAssembly.Module.imports(new WebAssembly.Module(wasmBytes)).map((i) => i.module))];
const snippetsRoot = join(ledgerDir, 'snippets');
const snippetFiles = new Map();
for (const dir of readdirSync(snippetsRoot)) {
  for (const file of readdirSync(join(snippetsRoot, dir))) snippetFiles.set(`./snippets/${dir}/${file}`, join(snippetsRoot, dir, file));
}
for (const name of wanted) {
  if (name !== GLUE_MODULE && !snippetFiles.has(name)) throw new Error(`The ledger WebAssembly module imports "${name}", which this build does not know how to provide.`);
}

// What the published browser entry does with a bundler's WebAssembly support, written out: instantiate from the inlined
// bytes (no fetch), hand the exports to the glue, run the start function.
const loaderSource = [
  `import * as glue from ${JSON.stringify(glue)};`,
  `import wasmBytes from ${JSON.stringify(wasmFile)};`,
  `const imports = { ${JSON.stringify(GLUE_MODULE)}: glue };`,
  ...wanted
    .filter((name) => name !== GLUE_MODULE)
    .map((name, i) => `import * as snippet${i} from ${JSON.stringify(snippetFiles.get(name))}; imports[${JSON.stringify(name)}] = snippet${i};`),
  'export const loadLedger = async () => {',
  '  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);',
  '  glue.__wbg_set_wasm(instance.exports);',
  '  instance.exports.__wbindgen_start();',
  '  return glue;',
  '};',
].join('\n');

const ledgerPlugin = {
  name: 'ledger-v9-inline',
  setup(b) {
    b.onResolve({ filter: /^virtual:ledger-v9$/ }, () => ({ path: 'ledger-v9', namespace: 'ledger-loader' }));
    b.onLoad({ filter: /.*/, namespace: 'ledger-loader' }, () => ({ contents: loaderSource, resolveDir: ledgerDir, loader: 'js' }));
    // The snippets import the package's own entry as "#self" to reach its classes; in the page that is the glue.
    b.onResolve({ filter: /^#self$/ }, () => ({ path: glue }));
  },
};

const result = await build({
  entryPoints: ['src/coldpage/ui.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  loader: { '.wasm': 'binary' },
  plugins: [ledgerPlugin],
  minify: false, // the page is read by people; the size is the WebAssembly module either way
  legalComments: 'inline',
  charset: 'ascii',
  write: false,
  metafile: true,
  logLevel: 'warning',
});
const bundle = result.outputFiles[0].text;

// The bundle goes inside a <script> element: nothing in it may end the element or open an HTML comment.
if (/<\/script/i.test(bundle)) throw new Error('The bundle contains a script end tag; cannot inline it.');
if (bundle.includes('<!--')) throw new Error('The bundle contains "<!--"; cannot inline it safely.');

const template = readFileSync('cold-page/cold-page.template.html', 'utf8');
if (template.split('/*BUNDLE*/').length !== 2) throw new Error('Template marker /*BUNDLE*/ must appear exactly once.');
const page = template.replace('/*BUNDLE*/', () => bundle);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/cold-page.html', page);

// Which packages ended up in the page: everything listed here runs next to the recovery phrase.
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*node_modules\/)/.exec(input);
  if (m) packages.add(m[1]);
}
const bytes = Buffer.from(page);
console.log(`Wrote dist/cold-page.html (${bytes.length} bytes; ledger-v9 ${ledgerVersion}, WebAssembly ${wasmBytes.length} bytes)`);
console.log(`Packages inlined: ${[...packages].sort().join(', ')}`);
console.log(`sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
