import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractPcm, extractFrames, fileExists } from './video.js';
import { pcmToWindows, pickCandidates, computeSpeechStats } from './audioEnergy.js';
import { detectFacesInJpeg } from './face.js';
import { detectRange } from './tracker.js';

export async function analyzeVideo(video, job, tmpDir) {
  const { path: file, meta } = video;
  job.message = 'Extraindo áudio...';
  job.progress = 0.05;

  let windows = [];
  if (meta.hasAudio) {
    const pcm = await extractPcm(file);
    windows = pcmToWindows(pcm);
  }

  job.message = 'Selecionando trechos promissores...';
  job.progress = 0.15;

  const candidates = pickCandidates(windows, {
    duration: meta.duration,
    count: 8,
  });

  const suggestions = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const len = c.end - c.start;
    job.message = `Analisando rostos no trecho ${i + 1}/${candidates.length}...`;
    job.progress = 0.2 + 0.75 * (i / candidates.length);

    let faceCoverage = 0;
    try {
      const frames = await extractFrames({
        input: file,
        start: c.start,
        duration: len,
        fps: 2,
        height: 360,
        outDir: path.join(tmpDir, `cand_${video.id}_${i}`),
      });
      const loaded = [];
      for (const fr of frames) {
        loaded.push({ t: fr.t, buf: await readFile(fr.file) });
      }
      const detections = await detectRange({
        frames: loaded,
        srcW: meta.width,
        srcH: meta.height,
        detect: detectFacesInJpeg,
      });
      faceCoverage = detections.filter((d) => d.face).length / (detections.length || 1);
    } catch (e) {
      console.warn(`Falha ao detectar rostos no trecho ${i}:`, e.message);
    }

    const faceBonus = Math.min(1, faceCoverage / 0.7) * 0.25;
    const score = Math.min(1, (c.audioScore || 0.5) * 0.9 + faceBonus);
    suggestions.push({
      start: round2(c.start),
      end: round2(c.end),
      score: round2(score),
      audioScore: round2(c.audioScore || 0.5),
      faceCoverage: round2(faceCoverage),
      reason: faceCoverage >= 0.5
        ? 'Áudio animado + rosto do convidado em quadro'
        : faceCoverage >= 0.2
          ? 'Áudio animado, rosto parcialmente visível'
          : 'Áudio animado (sem rosto detectado — enquadramento central)',
    });
  }

  const stats = windows.length ? computeSpeechStats(windows) : null;
  return {
    suggestions,
    audio: stats ? {
      speechRatio: round2(stats.speechRatio),
      loud: round4(stats.loud),
      noiseFloor: round4(stats.noiseFloor),
    } : null,
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
function round4(v) {
  return Math.round(v * 10000) / 10000;
}
