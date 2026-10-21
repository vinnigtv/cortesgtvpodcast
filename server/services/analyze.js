import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { extractPcm, extractFrames } from './video.js';
import { pcmToWindows, computeSpeechStats } from './audioEnergy.js';
import { detectFacesAdaptive } from './face.js';
import { detectRange } from './tracker.js';
import { transcribeAudio } from './transcribe.js';
import {
  buildCandidates,
  selectCandidates,
  contentScore,
  viralPercent,
  makeTitle,
  topKeywords,
} from './highlights.js';

export async function analyzeVideo(video, job, tmpDir) {
  const { path: file, meta } = video;

  job.message = 'Extraindo energia de Ã¡udio...';
  job.progress = 0.03;
  let windows = [];
  if (meta.hasAudio) {
    const pcm = await extractPcm(file);
    windows = pcmToWindows(pcm);
  }

  job.message = 'Transcrevendo e entendendo o conteÃºdo (Whisper IA)...';
  job.progress = 0.08;
  let transcript = null;
  if (meta.hasAudio && meta.duration > 2) {
    if (video.transcript?.videoMtime === video.mtimeMs && video.transcript?.segments?.length) {
      transcript = video.transcript;
    } else {
      transcript = await transcribeAudio(file, { job });
      video.transcript = transcript;
    }
  }

  job.message = 'Pontuando trechos e montando sugestÃµes...';
  job.progress = 0.4;
  const scored = buildCandidates(transcript, windows, { duration: meta.duration });
  const selected = selectCandidates(scored);

  const suggestions = [];
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i];
    const len = c.end - c.start;
    job.message = `Verificando convidado em quadro (corte ${i + 1}/${selected.length})...`;
    job.progress = 0.45 + 0.5 * ((i + 1) / selected.length);

    let faceCoverage = 0;
    const candDir = path.join(tmpDir, `cand_${video.id}_${i}`);
    try {
      const frames = await extractFrames({
        input: file,
        start: c.start,
        duration: Math.min(len, 60),
        fps: 0.5,
        height: 240,
        outDir: candDir,
      });
      const loaded = [];
      for (const fr of frames) loaded.push({ t: fr.t, buf: await readFile(fr.file) });
      const detections = await detectRange({
        frames: loaded,
        srcW: meta.width,
        srcH: meta.height,
        detect: detectFacesAdaptive,
      });
      faceCoverage = detections.filter((d) => d.face).length / (detections.length || 1);
    } catch (e) {
      console.warn(`Falha ao detectar rostos no trecho ${i}:`, e.message);
    } finally {
      await rm(candDir, { recursive: true, force: true }).catch(() => {});
    }

    const fallbackTitle = `Corte em destaque (${Math.round(c.start)}sâ€“${Math.round(c.end)}s)`;
    const title = makeTitle(c.stats, fallbackTitle);
    const viral = viralPercent(c.score, faceCoverage);

    suggestions.push({
      title,
      start: round2(c.start),
      end: round2(c.end),
      score: round2(c.score),
      viralPct: viral,
      audioScore: round2(c.audioScore || 0),
      faceCoverage: round2(faceCoverage),
      keywords: c.stats ? topKeywords(c.stats.words, 5) : [],
      transcriptExcerpt: c.stats?.text ? c.stats.text.slice(0, 280) : '',
      reason: buildReason(c, faceCoverage),
    });
  }

  suggestions.sort((a, b) => (b.viralPct || 0) - (a.viralPct || 0));

  const stats = windows.length ? computeSpeechStats(windows) : null;
  return {
    suggestions,
    keywords: topKeywords(
      (transcript?.segments || []).flatMap((s) => s.text.split(/\s+/)),
      12
    ),
    audio: stats
      ? {
          speechRatio: round2(stats.speechRatio),
          loud: round4(stats.loud),
          noiseFloor: round4(stats.noiseFloor),
        }
      : null,
    transcript: transcript
      ? { model: transcript.model, chars: transcript.text.length, segments: transcript.segments.length }
      : null,
  };
}

function buildReason(c, faceCoverage) {
  const parts = [];
  if (c.stats?.hooks) parts.push(`${c.stats.hooks} gancho(s) de retenÃ§Ã£o`);
  if (c.stats?.questions) parts.push(`${c.stats.questions} pergunta(s)`);
  if (c.stats?.story) parts.push('tom de histÃ³ria');
  if (c.stats?.emotional) parts.push('carga emocional');
  if (c.audioScore > 0.6) parts.push('Ã¡udio animado');
  if (faceCoverage >= 0.5) parts.push('convidado em quadro');
  else if (faceCoverage > 0.15) parts.push('rosto parcial');
  else parts.push('sem rosto estÃ¡vel');
  return parts.length ? parts.join(' Â· ') : 'trecho equilibrado';
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
function round4(v) {
  return Math.round(v * 10000) / 10000;
}

