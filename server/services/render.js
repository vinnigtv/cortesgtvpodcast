import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { extractFrames, ffmpegWithProgress, probe } from './video.js';
import { detectFacesInJpeg } from './face.js';
import { detectRange, buildTrack, keyframesFromTrack, simplifyKeyframes, piecewiseLinear, centerCropFallback } from './tracker.js';

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/segoeuib.ttf',
  'C:/Windows/Fonts/arialbd.ttf',
  'C:/Windows/Fonts/arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
];

function pickFont() {
  return FONT_CANDIDATES.find((f) => existsSync(f)) || null;
}

// Quebra o texto do trecho em legendas curtas estilo Shorts (máx. 4 palavras),
// distribuindo o tempo de cada segmento do Whisper proporcional ao nº de chars.
export function captionChunks(transcript, clipStart, clipEnd, { maxWords = 4 } = {}) {
  const segs = (transcript?.segments || []).filter(
    (s) => s.end > clipStart && s.start < clipEnd && s.text?.trim()
  );
  const chunks = [];
  for (const seg of segs) {
    const s0 = Math.max(seg.start, clipStart);
    const e0 = Math.min(seg.end, clipEnd);
    if (e0 - s0 < 0.2) continue;
    const words = seg.text.replace(/\s+/g, ' ').trim().split(' ');
    const groups = [];
    for (let i = 0; i < words.length; i += maxWords) {
      groups.push(words.slice(i, i + maxWords).join(' '));
    }
    if (!groups.length) continue;
    const totalChars = groups.reduce((n, g) => n + g.length, 0) || 1;
    let t = s0;
    for (const g of groups) {
      const dur = ((e0 - s0) * g.length) / totalChars;
      chunks.push({ text: g, start: t, end: Math.min(t + dur, e0) });
      t += dur;
    }
  }
  return chunks;
}

function escapeDrawtextPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

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
  let chain = `[0:v]crop=${crop.cropW}:${crop.cropH}:'floor(${xExpr}+0.5)':'floor(${yExpr}+0.5)',scale=${targetW}:${targetH}:flags=lanczos,setsar=1`;

  const captionFiles = [];
  const font = pickFont();
  const wantCaptions = clip.captions !== false && font && video.transcript?.segments?.length;
  if (wantCaptions) {
    const chunks = captionChunks(video.transcript, clip.start, clip.end);
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      const tf = path.join(tmpDir, `cap_${clip.id}_${i}.txt`);
      await writeFile(tf, ch.text, 'utf8');
      captionFiles.push(tf);
      const rel = escapeDrawtextPath(tf);
      const fs0 = (ch.start - clip.start).toFixed(3);
      const fe0 = (ch.end - clip.start).toFixed(3);
      chain +=
        `,drawtext=fontfile='${escapeDrawtextPath(font)}':textfile='${rel}'` +
        `:fontcolor=white:fontsize=${Math.round(targetH * 0.036)}:borderw=4:bordercolor=black` +
        `:x=(w-text_w)/2:y=${Math.round(targetH * 0.76)}:enable='between(t,${fs0},${fe0})'`;
    }
    job.captionCount = chunks.length;
  }

  const wantBar = clip.progressBar !== false;
  if (wantBar) {
    chain += `,drawbox=x=0:y=ih-10:w='iw*min(t/${duration.toFixed(3)}\\,1)':h=10:color=white@0.85:t=fill`;
  }

  chain += '[outv]';
  const filterFile = path.join(tmpDir, `flt_${clip.id}.txt`);
  await writeFile(filterFile, chain, 'utf8');

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
    for (const f of captionFiles) await rm(f, { force: true }).catch(() => {});
  }

  return {
    file: outFile,
    width: targetW,
    height: targetH,
    faceTracked: Boolean(track?.ok),
    faceCoverage: track ? Math.round(track.coverage * 100) / 100 : 0,
    captions: Boolean(wantCaptions),
    progressBar: wantBar,
  };
}
