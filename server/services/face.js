import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import util from 'node:util';
import jpeg from 'jpeg-js';

util.TextEncoder = globalThis.TextEncoder;
util.TextDecoder = globalThis.TextDecoder;

const faceapi = (await import('@vladmandic/face-api/dist/face-api.esm.js')).default
  || await import('@vladmandic/face-api/dist/face-api.esm.js');

let loaded = false;

async function serveModelDir(dir) {
  const server = http.createServer((req, res) => {
    const name = path.basename((req.url || '').split('?')[0]);
    const file = path.join(dir, name);
    if (!name || !file.startsWith(dir) || !existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    });
    createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

export async function initFaceDetector() {
  if (loaded) return;
  await faceapi.tf.setBackend('cpu');
  await faceapi.tf.ready();
  const modelDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', 'node_modules', '@vladmandic', 'face-api', 'model'
  );
  const server = await serveModelDir(modelDir);
  const base = `http://127.0.0.1:${server.address().port}`;
  await faceapi.nets.tinyFaceDetector.loadFromUri(base);
  loaded = true;
}

export function faceDetectorReady() {
  return loaded;
}

export async function detectFacesInJpeg(buf) {
  if (!loaded) throw new Error('Detector de rosto não inicializado.');
  const { width, height, data } = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const n = width * height;
  const rgb = new Float32Array(n * 3);
  for (let i = 0, j = 0; i < n * 4; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  const tf = faceapi.tf;
  const t = tf.tensor4d(rgb, [1, height, width, 3]);
  try {
    const dets = await faceapi.detectAllFaces(
      t,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.25 })
    );
    return {
      width,
      height,
      faces: dets.map((d) => ({
        x1: d.box.x,
        y1: d.box.y,
        x2: d.box.x + d.box.width,
        y2: d.box.y + d.box.height,
        score: d.score,
      })),
    };
  } finally {
    t.dispose();
  }
}

export function pickMainFace(faces) {
  if (!faces?.length) return null;
  let best = null;
  let bestScore = -1;
  for (const f of faces) {
    const area = Math.max(0, f.x2 - f.x1) * Math.max(0, f.y2 - f.y1);
    const s = area * (0.4 + 0.6 * (f.score || 0));
    if (s > bestScore) {
      bestScore = s;
      best = f;
    }
  }
  return best;
}
