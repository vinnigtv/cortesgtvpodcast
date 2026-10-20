import { Worker } from 'node:worker_threads';
import { extractPcm } from './video.js';

const WORKER_URL = new URL('./transcribe-worker.js', import.meta.url);

let worker = null;
const pending = new Map();
let jobSeq = 0;

function handleWorkerMessage(msg) {
  if (msg?.type === 'progress') {
    const p = pending.get(msg.jobId);
    if (p?.onProgress) p.onProgress(msg);
    return;
  }
  if (msg?.type === 'done' || msg?.type === 'error') {
    const p = pending.get(msg.jobId);
    if (!p) return;
    pending.delete(msg.jobId);
    clearTimeout(p.timer);
    if (msg.type === 'done') p.resolve(msg);
    else {
      resetWorker();
      p.reject(new Error(msg.message || 'Falha na transcrição.'));
    }
  }
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER_URL);
  worker.unref();
  worker.on('message', handleWorkerMessage);
  worker.on('error', (e) => {
    console.error('[transcribe-worker] erro:', e.message);
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Worker de transcrição falhou: ${e.message}`));
    }
    pending.clear();
    worker = null;
  });
  worker.on('exit', (code) => {
    worker = null;
    if (code !== 0 && pending.size) {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`Worker de transcrição saiu inesperadamente (código ${code}).`));
      }
      pending.clear();
    }
  });
  return worker;
}

function resetWorker() {
  const w = worker;
  worker = null;
  if (w) w.terminate().catch(() => {});
}

export async function transcribeAudio(videoPath, { job } = {}) {
  job && (job.message = 'Extraindo áudio para transcrição...');
  const pcm = await extractPcm(videoPath);
  const totalSec = pcm.byteLength / 4 / 16000;
  const audio =
    pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
      ? pcm.buffer
      : pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);

  // safeguard: modelo + inferência em CPU (~5x mais rápido que o real no tiny)
  const timeoutMs = Math.max(10 * 60_000, (totalSec / 2) * 1000 + 5 * 60_000);
  const jobId = ++jobSeq;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(jobId);
      resetWorker();
      reject(
        new Error(
          `Transcrição excedeu o limite de ${Math.round(timeoutMs / 60000)} min.`
        )
      );
    }, timeoutMs);

    pending.set(jobId, {
      resolve,
      reject,
      timer,
      onProgress: (msg) => {
        if (!job) return;
        job.message = msg.message;
        if (msg.progress != null) job.progress = msg.progress;
      },
    });

    ensureWorker().postMessage({ type: 'transcribe', audio, jobId }, [audio]);
  });
}
