import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import ffmpegPath from 'ffmpeg-static';
import { probe, run } from '../server/services/video.js';
import { initFaceDetector, faceDetectorReady, detectFacesInJpeg } from '../server/services/face.js';
import { analyzeVideo } from '../server/services/analyze.js';
import { renderClip } from '../server/services/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'data', 'tmp-test');
const OUT = path.join(ROOT, 'data', 'outputs-test');

let failures = 0;
function check(name, cond, extra = '') {
  const mark = cond ? 'OK ' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${mark}] ${name}${extra ? ` — ${extra}` : ''}`);
}

function makeJob(label) {
  return {
    progress: 0,
    message: label,
    _last: 0,
    setProgress(p) {
      this.progress = p;
      const pct = Math.round(p * 100);
      if (pct >= this._last + 20) {
        this._last = pct;
        console.log(`    ${label}: ${pct}% (${this.message})`);
      }
    },
  };
}

const jobProxy = (label) =>
  new Proxy(makeJob(label), {
    set(t, k, v) {
      t[k] = v;
      if (k === 'progress') t.setProgress(v);
      return true;
    },
  });

async function genSynthetic(outFile) {
  const vol = "if(lt(t,15),0.03,if(lt(t,35),0.9,if(lt(t,55),0.03,if(lt(t,80),0.75,0.05))))";
  await run(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=95',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=95,volume=\'' + vol + '\':eval=frame',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
    '-c:a', 'aac', '-shortest',
    outFile,
  ]);
}

async function downloadFaceImage() {
  const img = path.join(TMP, 'face.jpg');
  const res = await fetch('https://randomuser.me/api/portraits/men/32.jpg');
  if (!res.ok) throw new Error(`download face image HTTP ${res.status}`);
  await fsp.writeFile(img, Buffer.from(await res.arrayBuffer()));
  return img;
}

async function genFaceVideo(outFile, img) {
  await run(ffmpegPath, [
    '-f', 'lavfi', '-i', 'color=c=0x223344:s=1280x720:d=40:rate=30',
    '-i', img,
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=40,volume=0.8',
    '-filter_complex',
    "[1:v]scale=420:420[fg];[0:v][fg]overlay=x='(main_w-w)*t/40':y=150:eval=frame[outv]",
    '-map', '[outv]', '-map', '2:a',
    '-t', '40',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    outFile,
  ]);
}

async function main() {
  await fsp.rm(TMP, { recursive: true, force: true });
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(TMP, { recursive: true });
  await fsp.mkdir(OUT, { recursive: true });

  console.log('== GTV Cortes IA — teste de pipeline ==\n');

  await initFaceDetector();
  check('TinyFaceDetector carregado', faceDetectorReady());

  console.log('\n-- 1) Vídeo sintético (energia de áudio variável, sem rosto) --');
  const synth = path.join(TMP, 'synth.mp4');
  await genSynthetic(synth);
  const meta1 = await probe(synth);
  check('probe detecta 1280x720', meta1.width === 1280 && meta1.height === 720);
  check('probe detecta duração ~95s', Math.abs(meta1.duration - 95) < 3, `${meta1.duration.toFixed(1)}s`);
  check('probe detecta áudio', meta1.hasAudio);

  const video1 = { id: 'synth', name: 'synth.mp4', path: synth, meta: meta1 };
  const job1 = jobProxy('análise synth');
  const result1 = await analyzeVideo(video1, job1, TMP);
  check('análise retorna sugestões', result1.suggestions.length > 0, `${result1.suggestions.length} cortes`);
  const durationsOk = result1.suggestions.every(
    (s) => s.end - s.start >= 29 && s.end - s.start <= 91
  );
  check('sugestões entre 30 e 90s', durationsOk);
  check(
    'sugestões têm título',
    result1.suggestions.every((s) => typeof s.title === 'string' && s.title.length > 3)
  );
  check(
    'sugestões têm viralPct (5-98)',
    result1.suggestions.every((s) => Number.isFinite(s.viralPct) && s.viralPct >= 5 && s.viralPct <= 98),
    `ex.: ${result1.suggestions[0]?.viralPct}%`
  );
  const best = result1.suggestions[0];
  console.log(`    melhor corte: ${best.start.toFixed(1)}s → ${best.end.toFixed(1)}s (score ${best.score})`);
  const loudZone = result1.suggestions.some((s) => s.start < 35 && s.end > 15);
  check('há corte cobrindo a zona de áudio alto (15-35s)', loudZone, `melhor: ${best.start}s-${best.end}s`);

  const clip1 = {
    id: 'clip-synth',
    videoId: 'synth',
    start: best.start,
    end: Math.min(best.end, best.start + 45),
  };
  const renderJob1 = jobProxy('render synth');
  const out1 = await renderClip({ video: video1, clip: clip1, outDir: OUT, tmpDir: TMP, job: renderJob1 });
  const outMeta1 = await probe(out1.file);
  check('render synth gera 1080x1920', outMeta1.width === 1080 && outMeta1.height === 1920, `${outMeta1.width}x${outMeta1.height}`);
  check('render synth mantém áudio', outMeta1.hasAudio);
  const outDur = Math.abs(outMeta1.duration - (clip1.end - clip1.start));
  check('duração do corte correta', outDur < 1.5, `${outMeta1.duration.toFixed(1)}s`);

  console.log('\n-- 2) Detecção de rosto em imagem real --');
  const faceImg = await downloadFaceImage();
  const buf = await readFile(faceImg);
  const det = await detectFacesInJpeg(buf);
  check('TinyFaceDetector detecta rosto na foto', det.faces.length > 0, `${det.faces.length} rosto(s)`);

  console.log('\n-- 3) Vídeo com rosto em movimento (tracking + crop) --');
  const faceVid = path.join(TMP, 'facevid.mp4');
  await genFaceVideo(faceVid, faceImg);
  const meta2 = await probe(faceVid);
  const video2 = { id: 'facevid', name: 'facevid.mp4', path: faceVid, meta: meta2 };
  const job2 = jobProxy('análise face');
  const result2 = await analyzeVideo(video2, job2, TMP);
  check('análise face detecta rosto', result2.suggestions.some((s) => s.faceCoverage > 0.4),
    `maior cobertura: ${Math.max(...result2.suggestions.map((s) => s.faceCoverage), 0)}`);

  const best2 = [...result2.suggestions].sort((a, b) => b.faceCoverage - a.faceCoverage)[0];
  const clip2 = { id: 'clip-face', videoId: 'facevid', start: best2.start, end: Math.min(best2.end, best2.start + 30) };
  const renderJob2 = jobProxy('render face');
  const out2 = await renderClip({ video: video2, clip: clip2, outDir: OUT, tmpDir: TMP, job: renderJob2 });
  const outMeta2 = await probe(out2.file);
  check('render face gera 1080x1920', outMeta2.width === 1080 && outMeta2.height === 1920);
  check('render face usa rastreamento de rosto', out2.faceTracked === true, `coverage ${out2.faceCoverage}`);

  console.log(`\n== Resultado: ${failures === 0 ? 'TODOS OS TESTES PASSARAM' : failures + ' FALHA(S)'} ==`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Erro fatal no teste:', e);
  process.exit(1);
});
