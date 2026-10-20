import { pipeline, env } from '@xenova/transformers';
import { extractPcm } from './video.js';

env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;

const MODEL = process.env.GTV_WHISPER_MODEL || 'Xenova/whisper-tiny';
const CHUNK_SEC = 300;
const OVERLAP_SEC = 2;

let transcriberPromise = null;

async function getTranscriber(job) {
  if (!transcriberPromise) {
    transcriberPromise = pipeline('automatic-speech-recognition', MODEL, {
      quantized: true,
      progress_callback: (p) => {
        if (!job) return;
        if (p.status === 'progress' && p.file) {
          const pct = Math.round(p.progress || 0);
          job.message = `Baixando modelo de transcrição (${pct}%)...`;
        }
      },
    });
  }
  return transcriberPromise;
}

export async function transcribeAudio(videoPath, { job } = {}) {
  job && (job.message = 'Extraindo áudio para transcrição...');
  const pcm = await extractPcm(videoPath);
  const audio = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  const sr = 16000;
  const totalSec = audio.length / sr;

  job && (job.message = 'Carregando modelo Whisper...');
  const transcriber = await getTranscriber(job);

  const segments = [];
  let offset = 0;
  let part = 0;
  const parts = Math.max(1, Math.ceil((totalSec - OVERLAP_SEC) / (CHUNK_SEC - OVERLAP_SEC)));

  while (offset < totalSec) {
    const end = Math.min(audio.length, Math.round((offset + CHUNK_SEC) * sr));
    const slice = audio.subarray(Math.round(offset * sr), end);
    if (slice.length < sr * 0.5) break;

    part++;
    if (job) {
      job.message = `Transcrevendo áudio (parte ${part}/${parts}) — Whisper IA...`;
      job.progress = Math.min(0.35, 0.08 + 0.27 * ((part - 1) / parts));
    }

    const out = await transcriber(slice, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      language: 'portuguese',
      task: 'transcribe',
    });

    for (const c of out.chunks || []) {
      const text = (c.text || '').trim();
      if (!text) continue;
      const start = (c.timestamp?.[0] ?? 0) + offset;
      const endT = (c.timestamp?.[1] ?? start + 2) + offset;
      segments.push({ start: round2(start), end: round2(endT), text });
    }

    offset += CHUNK_SEC - OVERLAP_SEC;
  }

  const text = segments.map((s) => s.text).join(' ').trim();
  return { model: MODEL, segments, text, durationSec: round2(totalSec) };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
