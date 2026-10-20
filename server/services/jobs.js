import { randomUUID } from 'node:crypto';

export const jobs = new Map();

let chain = Promise.resolve();

export function createJob(type, meta = {}) {
  const job = {
    id: randomUUID(),
    type,
    status: 'queued',
    progress: 0,
    message: 'Na fila...',
    error: null,
    result: null,
    meta,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function enqueue(job, fn) {
  chain = chain.then(async () => {
    if (job.status !== 'queued') return;
    job.status = 'running';
    job.message = 'Iniciando...';
    try {
      job.result = await fn(job);
      job.status = 'done';
      job.progress = 1;
      job.message = 'Concluído';
    } catch (e) {
      job.status = 'error';
      job.error = e?.message || String(e);
      job.message = `Falhou: ${job.error}`;
      console.error(`[job ${job.id}]`, e);
    }
  });
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}
