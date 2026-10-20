import { pipeline, env } from '@xenova/transformers';
import { parentPort } from 'node:worker_threads';

env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;

const MODEL = process.env.GTV_WHISPER_MODEL || 'Xenova/whisper-tiny';
const CHUNK_SEC = 300;
const OVERLAP_SEC = 2;

let transcriberPromise = null;

function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = pipeline('automatic-speech-recognition', MODEL, {
      quantized: true,
      progress_callback: (p) => {
        if (p.status === 'progress' && p.file) {
          parentPort.postMessage({
            type: 'progress',
            message: `Baixando modelo de transcrição (${Math.round(p.progress || 0)}%)...`,
            progress: null,
          });
        }
      },
    });
  }
  return transcriberPromise;
}

parentPort.on('message', async (msg) => {
  if (msg?.type !== 'transcribe') return;
  const jobId = msg.jobId;
  const send = (m) => parentPort.postMessage({ ...m, jobId });
  try {
    send({ type: 'progress', message: 'Carregando modelo Whisper...', progress: 0.05 });
    const transcriber = await getTranscriber();

    const audio = new Float32Array(msg.audio);
    const sr = 16000;
    const totalSec = audio.length / sr;
    const segments = [];
    let offset = 0;
    let part = 0;
    const parts = Math.max(1, Math.ceil((totalSec - OVERLAP_SEC) / (CHUNK_SEC - OVERLAP_SEC)));

    while (offset < totalSec) {
      const end = Math.min(audio.length, Math.round((offset + CHUNK_SEC) * sr));
      const slice = audio.subarray(Math.round(offset * sr), end);
      if (slice.length < sr * 0.5) break;

      part++;
      send({
        type: 'progress',
        message: `Transcrevendo áudio (parte ${part}/${parts}) — Whisper IA...`,
        progress: 0.1 + 0.85 * ((part - 1) / parts),
      });

      const out = await transcriber(slice, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
        language: 'portuguese',
        task: 'transcribe',
        max_new_tokens: 448,
      });

      for (const c of out.chunks || []) {
        const text = (c.text || '').trim();
        if (!text) continue;
        const start = (c.timestamp?.[0] ?? 0) + offset;
        const endT = (c.timestamp?.[1] ?? start + 2) + offset;
        segments.push({ start: Math.round(start * 100) / 100, end: Math.round(endT * 100) / 100, text });
      }

      offset += CHUNK_SEC - OVERLAP_SEC;
    }

    send({
      type: 'done',
      model: MODEL,
      segments,
      text: segments.map((s) => s.text).join(' ').trim(),
      durationSec: Math.round(totalSec * 100) / 100,
    });
  } catch (e) {
    send({ type: 'error', message: e?.message || String(e) });
  }
});
