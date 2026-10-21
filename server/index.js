import express from 'express';
import cors from 'cors';
import multer from 'multer';
import archiver from 'archiver';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { probe, fileExists } from './services/video.js';
import { initFaceDetector } from './services/face.js';
import { analyzeVideo } from './services/analyze.js';
import { renderClip } from './services/render.js';
import { createJob, enqueue, getJob } from './services/jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const OUTPUTS = path.join(DATA, 'outputs');
const TMP = path.join(DATA, 'tmp');
const CLIENT_DIST = path.join(ROOT, 'client', 'dist');

for (const d of [DATA, UPLOADS, OUTPUTS, TMP]) {
  fs.mkdirSync(d, { recursive: true });
}

// limpa temporários de execuções anteriores (frames, filtros, legendas)
try {
  for (const entry of fs.readdirSync(TMP)) {
    fs.rmSync(path.join(TMP, entry), { recursive: true, force: true });
  }
} catch {}

function freeDiskBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Infinity;
  }
}

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(cors());
app.use(express.json());

const videos = new Map();
const clips = new Map();

function publicVideo(v) {
  const j = v.jobId ? getJob(v.jobId) : null;
  return {
    id: v.id,
    name: v.name,
    meta: v.meta,
    createdAt: v.createdAt,
    status: v.status,
    analyzing: !!v.analyzing,
    job: j
      ? { id: j.id, status: j.status, progress: j.progress, message: j.message, error: j.error }
      : null,
    analysis: v.analysis,
    clips: [...clips.values()]
      .filter((c) => c.videoId === v.id)
      .sort((a, b) => (b.viralPct || 0) - (a.viralPct || 0))
      .map(publicClip),
  };
}

function publicClip(c) {
  return {
    id: c.id,
    videoId: c.videoId,
    title: c.title || null,
    start: c.start,
    end: c.end,
    score: c.score,
    viralPct: c.viralPct ?? null,
    keywords: c.keywords || [],
    transcriptExcerpt: c.transcriptExcerpt || '',
    reason: c.reason,
    faceCoverage: c.faceCoverage,
    captions: c.captions !== false,
    progressBar: c.progressBar !== false,
    status: c.status,
    progress: c.progress,
    error: c.error,
    render: c.render
      ? { faceTracked: c.render.faceTracked, faceCoverage: c.render.faceCoverage, width: c.render.width, height: c.render.height, framing: c.render.framing, captions: c.render.captions, progressBar: c.render.progressBar }
      : null,
    hasFile: c.file ? fs.existsSync(c.file) : false,
  };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, file, cb) => {
      const id = randomUUID();
      const ext = path.extname(file.originalname || '').toLowerCase() || '.mp4';
      cb(null, `${id}${ext}`);
    },
  }),
});

app.post('/api/upload', (req, res, next) => {
  const size = Number(req.headers['content-length'] || 0);
  const free = freeDiskBytes(UPLOADS);
  // margem de 1 GB para análise/render
  if (size && free !== Infinity && free < size + 1024 * 1024 * 1024) {
    return res.status(507).json({
      error:
        `Espaço em disco insuficiente no servidor. Livre: ${(free / 1024 ** 3).toFixed(1)} GB, ` +
        `necessário: ${((size + 1024 ** 3) / 1024 ** 3).toFixed(1)} GB. ` +
        'Apague vídeos antigos em data/uploads e tente novamente.',
    });
  }
  next();
}, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    const meta = await probe(req.file.path);
    const st = await fsp.stat(req.file.path);
    const video = {
      id: path.parse(req.file.filename).name,
      name: req.file.originalname,
      path: req.file.path,
      mtimeMs: st.mtimeMs,
      meta,
      createdAt: Date.now(),
      status: 'ready',
      analysis: null,
      transcript: null,
    };
    videos.set(video.id, video);
    res.json(publicVideo(video));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/videos', (req, res) => {
  res.json([...videos.values()].map(publicVideo));
});

app.get('/api/videos/:id', (req, res) => {
  const v = videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  res.json(publicVideo(v));
});

app.get('/api/videos/:id/file', (req, res) => {
  const v = videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  res.sendFile(v.path);
});

app.delete('/api/videos/:id', async (req, res) => {
  const v = videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  for (const c of clips.values()) {
    if (c.videoId === v.id) {
      if (c.file) await fsp.rm(c.file, { force: true }).catch(() => {});
      clips.delete(c.id);
    }
  }
  await fsp.rm(v.path, { force: true }).catch(() => {});
  videos.delete(v.id);
  res.json({ ok: true });
});

app.post('/api/videos/:id/analyze', (req, res) => {
  const v = videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (v.analyzing) return res.status(409).json({ error: 'Análise já em andamento.' });
  v.analyzing = true;
  const job = createJob('analyze', { videoId: v.id });
  v.jobId = job.id;
  enqueue(job, async (j) => {
    try {
      const result = await analyzeVideo(v, j, TMP);
      for (const c of clips.values()) {
        if (c.videoId === v.id) clips.delete(c.id);
      }
      v.analysis = result;
      v.status = 'analyzed';
      for (const s of result.suggestions) {
        const clip = {
          id: randomUUID(),
          videoId: v.id,
          title: s.title,
          start: s.start,
          end: s.end,
          score: s.score,
          viralPct: s.viralPct,
          keywords: s.keywords,
          transcriptExcerpt: s.transcriptExcerpt,
          reason: s.reason,
          faceCoverage: s.faceCoverage,
          captions: true,
          progressBar: true,
          status: 'suggested',
          progress: 0,
          error: null,
          file: null,
          render: null,
        };
        clips.set(clip.id, clip);
      }
      return result;
    } finally {
      v.analyzing = false;
    }
  });
  res.json({ jobId: job.id });
});

app.patch('/api/clips/:id', (req, res) => {
  const c = clips.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Corte não encontrado.' });
  if (c.status === 'rendering') return res.status(409).json({ error: 'Aguarde o render atual.' });
  const { start, end, title, captions, progressBar } = req.body || {};
  const v = videos.get(c.videoId);
  const max = v?.meta.duration ?? Infinity;
  if (typeof title === 'string') {
    c.title = title.trim().slice(0, 80) || c.title;
  }
  if (typeof captions === 'boolean') c.captions = captions;
  if (typeof progressBar === 'boolean') c.progressBar = progressBar;
  if (start === undefined && end === undefined) {
    return res.json(publicClip(c));
  }
  if (typeof start !== 'number' || typeof end !== 'number') {
    return res.status(400).json({ error: 'start e end devem ser números.' });
  }
  if (start < 0 || end > max + 0.05 || end - start < 5) {
    return res.status(400).json({ error: 'Intervalo inválido (mínimo 5s, dentro do vídeo).' });
  }
  c.start = Math.round(start * 100) / 100;
  c.end = Math.round(end * 100) / 100;
  c.status = c.file ? 'ready' : 'suggested';
  res.json(publicClip(c));
});

function enqueueRender(clipIds, res) {
  const pending = [];
  for (const id of clipIds) {
    const c = clips.get(id);
    if (!c) continue;
    if (c.status === 'rendering') continue;
    c.status = 'queued';
    c.progress = 0;
    c.error = null;
    pending.push(c);
  }
  if (!pending.length) return res.status(400).json({ error: 'Nenhum corte elegível.' });
  for (const c of pending) {
    const job = createJob('render', { clipId: c.id });
    c.jobId = job.id;
    enqueue(job, async (j) => {
      c.status = 'rendering';
      try {
        const result = await renderClip({
          video: videos.get(c.videoId),
          clip: c,
          outDir: OUTPUTS,
          tmpDir: TMP,
          job: {
            set progress(p) { c.progress = p; j.progress = p; },
            get progress() { return c.progress; },
            set message(m) { j.message = m; },
            get message() { return j.message; },
          },
        });
        if (c.file && c.file !== result.file) await fsp.rm(c.file, { force: true }).catch(() => {});
        c.file = result.file;
        c.render = result;
        c.status = 'ready';
        c.progress = 1;
      } catch (e) {
        c.status = 'error';
        c.error = e.message;
        throw e;
      }
    });
  }
  res.json({ clips: pending.map((c) => c.id) });
}

app.post('/api/clips/:id/render', (req, res) => {
  if (!clips.get(req.params.id)) return res.status(404).json({ error: 'Corte não encontrado.' });
  return enqueueRender([req.params.id], res);
});

app.post('/api/clips/render-batch', (req, res) => {
  const ids = Array.isArray(req.body?.clipIds) ? req.body.clipIds : [];
  return enqueueRender(ids, res);
});

app.get('/api/clips/:id', (req, res) => {
  const c = clips.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Corte não encontrado.' });
  res.json(publicClip(c));
});

app.get('/api/clips/:id/srt', (req, res) => {
  const c = clips.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Corte não encontrado.' });
  const v = videos.get(c.videoId);
  const segs = (v?.transcript?.segments || []).filter((s) => s.end > c.start && s.start < c.end);
  if (!segs.length) return res.status(404).json({ error: 'Sem transcrição para gerar legendas.' });
  const srtTime = (sec) => {
    const ms = Math.max(0, Math.round(sec * 1000));
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    const mss = String(ms % 1000).padStart(3, '0');
    return `${h}:${m}:${s},${mss}`;
  };
  const body = segs
    .map((s, i) => {
      const st = Math.max(0, s.start - c.start);
      const en = Math.max(st + 0.3, Math.min(s.end - c.start, c.end - c.start));
      return `${i + 1}\n${srtTime(st)} --> ${srtTime(en)}\n${s.text.trim()}\n`;
    })
    .join('\n');
  res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="corte-${Math.round(c.start)}s-${Math.round(c.end)}s.srt"`);
  res.send(body);
});

app.get('/api/clips/:id/file', (req, res) => {
  const c = clips.get(req.params.id);
  if (!c?.file || !fs.existsSync(c.file)) {
    return res.status(404).json({ error: 'Arquivo do corte ainda não existe. Renderize primeiro.' });
  }
  res.sendFile(c.file);
});

app.get('/api/clips/:id/download', (req, res) => {
  const c = clips.get(req.params.id);
  if (!c?.file || !fs.existsSync(c.file)) {
    return res.status(404).json({ error: 'Arquivo do corte ainda não existe. Renderize primeiro.' });
  }
  const v = videos.get(c.videoId);
  const label = `gtv-cortes-${(v?.name || 'corte').replace(/\.[^.]+$/, '').slice(0, 40)}-${Math.round(c.start)}s-${Math.round(c.end)}s.mp4`;
  res.download(c.file, label);
});

app.post('/api/videos/:id/download-batch', (req, res) => {
  const v = videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  const ids = Array.isArray(req.body?.clipIds) ? req.body.clipIds : null;
  const ready = [...clips.values()].filter(
    (c) => c.videoId === v.id && c.file && fs.existsSync(c.file) && (!ids || ids.includes(c.id))
  );
  if (!ready.length) return res.status(400).json({ error: 'Nenhum corte renderizado para baixar.' });
  const zipName = `gtv-cortes-${(v.name || 'video').replace(/\.[^.]+$/, '').slice(0, 40)}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', (e) => res.destroy(e));
  archive.pipe(res);
  for (const c of ready) {
    archive.file(c.file, {
      name: `corte-${Math.round(c.start)}s-${Math.round(c.end)}s.mp4`,
    });
  }
  archive.finalize();
});

app.get('/api/jobs/:id', (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job não encontrado.' });
  res.json({
    id: j.id,
    type: j.type,
    status: j.status,
    progress: j.progress,
    message: j.message,
    error: j.error,
  });
});

app.use(express.static(CLIENT_DIST));
app.get(/^\/(?!api\/).*/, (req, res) => {
  const index = path.join(CLIENT_DIST, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send('Client não buildado. Rode: npm run build');
});

// erros de API sempre em JSON (evita "Unexpected token '<'" no front)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const isFull = err?.code === 'ENOSPC' || /no space left/i.test(err?.message || '');
  const status = isFull ? 507 : err?.status || 500;
  const message = isFull
    ? 'Sem espaço em disco no servidor. Apague vídeos antigos em data/uploads e tente novamente.'
    : err?.message || 'Erro interno do servidor.';
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
  res.status(status).send(message);
});

app.listen(PORT, async () => {
  console.log(`GTV Cortes IA rodando em http://localhost:${PORT}`);
  initFaceDetector()
    .then(() => console.log('Detector de rosto pronto (TinyFaceDetector).'))
    .catch((e) => console.error('Falha ao carregar detector de rosto:', e.message));
});
