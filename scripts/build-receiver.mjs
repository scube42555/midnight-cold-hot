// Builds dist/receiver.html: one self-contained page with the jsQR decoder inlined.
// Run on a machine with network access (npm install fetches jsqr). Copy the result to the other machines.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const template = readFileSync('receiver/receiver.template.html', 'utf8');
const jsqr = readFileSync('node_modules/jsqr/dist/jsQR.js', 'utf8');
if (/<\/script/i.test(jsqr)) throw new Error('The jsQR source contains a script end tag; cannot inline it.');
if (!template.includes('/*JSQR*/')) throw new Error('Template marker /*JSQR*/ not found.');

mkdirSync('dist', { recursive: true });
writeFileSync('dist/receiver.html', template.replace('/*JSQR*/', () => jsqr));
console.log('Wrote dist/receiver.html');
