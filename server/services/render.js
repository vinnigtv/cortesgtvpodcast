import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { extractFrames, ffmpegWithProgress, probe } from './video.js';
import { detectFacesInJpeg } from './face.js';
import { detectRange, buildTrack, keyframesFromTrack, simplifyKeyframes, piecewiseLinear, centerCropFallback } from './tracker.js';

export async function renderClip({ video, clip, outDir, tmpDir, job }) {
  const meta = await probe(video.path);
  const duration = clip.end - clip.start;
  if (duration < 1) throw new Error('Duração do corte inválida.');
  if (clip.end > meta.duration + 0.05) throw new Error('O corte vai além do fim do vídeo.');

  job.message = 'Extraindo frames para rastreamento...';
  job.progress = 0.02;

  const frames = await extractFrames({
    input: video.path,
    start: clip.start,
    duration,
    fps: 4,
    height: 360,
    outDir: path.join(tmpDir, `trk_${clip.id}`),
  });

  job.message = 'Rastreando rosto do convidado...';
  job.progress = 0.08;

  const loaded = [];
  for (const fr of frames) loaded.push({ t: fr.t, buf: await readFile(fr.file) });

  const detections = await detectRange({
    frames: loaded,
    srcW: meta.width,
    srcH: meta.height,
    detect: detectFacesInJpeg,
  });

  const track = buildTrack(detections, {
    srcW: meta.width,
    srcH: meta.height,
    fps: 4,
  });

  let crop;
  let xExpr, yExpr;
  if (track?.ok) {
    const pts = keyframesFromTrack(track, duration, 1);
    crop = { cropW: track.cropW, cropH: track.cropH };
    xExpr = piecewiseLinear(simplifyKeyframes(pts.map((p) => ({ t: p.t, x: p.x }))));
    yExpr = piecewiseLinear(simplifyKeyframes(pts.map((p) => ({ t: p.t, x: p.y }))));
  } else {
    crop = centerCropFallback(meta.width, meta.height);
    xExpr = String(crop.x);
    yExpr = String(crop.y);
  }

  const outFile = path.join(outDir, `${clip.id}.mp4`);
  const targetH = 1920;
  const targetW = 1080;

  job.message = 'Renderizando corte vertical 9:16...';
  job.progress = 0.1;

  // filter graph em arquivo: expressões longas de crop estouram o limite de
  // linha de comando do Windows (erro "Failed to configure input pad")
  const filterGraph = `[0:v]crop=${crop.cropW}:${crop.cropH}:'floor(${xExpr}+0.5)':'floor(${yExpr}+0.5)',scale=${targetW}:${targetH}:flags=lanczos,setsar=1[outv]`;
  const filterFile = path.join(tmpDir, `flt_${clip.id}.txt`);
  await writeFile(filterFile, filterGraph, 'utf8');

  const args = [
    '-ss', clip.start.toFixed(3),
    '-i', video.path,
    '-t', duration.toFixed(3),
    '-filter_complex_script', filterFile,
    '-map', '[outv]',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '21',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    outFile,
  ];

  try {
    await ffmpegWithProgress(args, duration, (p) => {
      job.progress = 0.1 + p * 0.9;
      job.message = `Renderizando corte vertical... ${Math.round(p * 100)}%`;
    });
  } finally {
    await rm(filterFile, { force: true }).catch(() => {});
  }

  return {
    file: outFile,
    width: targetW,
    height: targetH,
    faceTracked: Boolean(track?.ok),
    faceCoverage: track ? Math.round(track.coverage * 100) / 100 : 0,
  };
}
