import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(__dirname, '..', 'node_modules', '@vladmandic', 'face-api', 'dist', 'face-api.esm.js');

const BROKEN = 'constructor(){this.util=AR(),this.textEncoder=new this.util.TextEncoder}';
const FIXED = `constructor(){this.util={TextEncoder:globalThis.TextEncoder,TextDecoder:globalThis.TextDecoder,types:{isFloat32Array:function(e){return e instanceof Float32Array},isInt32Array:function(e){return e instanceof Int32Array},isUint8Array:function(e){return e instanceof Uint8Array},isUint8ClampedArray:function(e){return e instanceof Uint8ClampedArray}}},this.textEncoder=new this.util.TextEncoder}`;

if (!existsSync(target)) {
  console.warn('[patch-faceapi] arquivo não encontrado:', target);
  process.exit(0);
}

const src = readFileSync(target, 'utf8');
if (src.includes(FIXED)) {
  console.log('[patch-faceapi] já aplicado.');
  process.exit(0);
}
if (!src.includes(BROKEN)) {
  console.warn('[patch-faceapi] padrão quebrado não encontrado — versão do pacote pode ter mudado.');
  process.exit(0);
}
writeFileSync(target, src.replace(BROKEN, FIXED));
console.log('[patch-faceapi] patch aplicado em face-api.esm.js');
