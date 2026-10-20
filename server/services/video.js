import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const ffprobePath = ffprobeStatic.path || ffprobeStatic;

export function run(cmd, args, { onStdout, onStderr, cwd, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    const outChunks = [];
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => {
      if (binary) outChunks.push(d);
      else out += d;
      onStdout?.(d);
    });
    child.stderr?.on('data', (d) => {
      err += d;
      onStderr?.(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ out: binary ? Buffer.concat(outChunks) : out, err });
      else reject(new Error(`${path.basename(cmd)} saiu com código ${code}\n${err.slice(-2000)}`));
    });
  });
}

export async function ffmpeg(args, opts = {}) {
  return run(ffmpegPath, ['-hide_banner', '-y', ...args], opts);
}

export async function probe(file) {
  const { out } = await run(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  const data = JSON.parse(out);
  const v = (data.streams || []).find((s) => s.codec_type === 'video');
  const a = (data.streams || []).find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('O arquivo não contém uma trilha de vídeo.');
  const [num, den] = (v.r_frame_rate || '30/1').split('/').map(Number);
  const fps = den ? num / den : 30;
  const duration = Number(data.format?.duration || v.duration || 0);
  return {
    width: v.width,
    height: v.height,
    fps,
    duration,
    hasAudio: Boolean(a),
    videoCodec: v.codec_name,
    audioCodec: a?.codec_name || null,
    container: data.format?.format_name,
    sizeBytes: Number(data.format?.size || 0),
  };
}

export function parseProgressChunk(text, buffer, durationSec, onProgress) {
  let acc = buffer + text;
  const lines = acc.split(/\r?\n/);
  acc = lines.pop() || '';
  for (const line of lines) {
    const m = line.match(/^out_time_ms=(\d+)/);
    if (m && durationSec > 0) {
      const t = Number(m[1]) / 1e6;
      onProgress?.(Math.max(0, Math.min(1, t / durationSec)));
    }
  }
  return acc;
}

export async function ffmpegWithProgress(args, durationSec, onProgress) {
  let buf = '';
  await ffmpeg([...args, '-progress', 'pipe:1', '-nostats'], {
    onStdout: (d) => {
      buf = parseProgressChunk(d.toString(), buf, durationSec, onProgress);
    },
  });
}

export async function extractFrames(opts) {
  const { input, start, duration, fps, height, outDir, job } = opts;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const args = [
    '-ss', start.toFixed(3),
    '-i', input,
    '-t', duration.toFixed(3),
    '-vf', `fps=${fps},scale=-2:${height}`,
    '-q:v', '4',
    path.join(outDir, 'f_%05d.jpg'),
  ];
  await ffmpegWithProgress(args, duration, (p) => {
    if (job) job.progressExtra = p;
  });
  const files = (await readdir(outDir)).filter((f) => f.endsWith('.jpg')).sort();
  return files.map((f, i) => ({
    file: path.join(outDir, f),
    t: start + i / fps,
  }));
}

export async function extractPcm(input) {
  const { out } = await run(ffmpegPath, [
    '-hide_banner', '-y',
    '-i', input,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'f32le',
    '-',
  ], { binary: true });
  return out;
}

export async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export { ffmpegPath, ffprobePath };
