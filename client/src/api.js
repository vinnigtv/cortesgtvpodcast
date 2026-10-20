async function json(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

export const api = {
  async upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText || '{}');
        } catch {
          data = {
            error:
              xhr.status >= 400
                ? `Erro ${xhr.status} no servidor. Verifique o log do terminal (pode ser falta de espaço em disco).`
                : 'Resposta inválida do servidor.',
          };
        }
        if (xhr.status >= 400) reject(new Error(data.error || `Erro ${xhr.status}`));
        else resolve(data);
      };
      xhr.onerror = () => reject(new Error('Falha no upload.'));
      const fd = new FormData();
      fd.append('video', file);
      xhr.send(fd);
    });
  },
  async analyze(videoId) {
    return json(await fetch(`/api/videos/${videoId}/analyze`, { method: 'POST' }));
  },
  async getVideo(videoId) {
    return json(await fetch(`/api/videos/${videoId}`));
  },
  async patchClip(clipId, start, end, title, extra = {}) {
    return json(
      await fetch(`/api/clips/${clipId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start,
          end,
          ...(title !== undefined ? { title } : {}),
          ...extra,
        }),
      })
    );
  },
  async renderClip(clipId) {
    return json(await fetch(`/api/clips/${clipId}/render`, { method: 'POST' }));
  },
  async renderBatch(clipIds) {
    return json(
      await fetch('/api/clips/render-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clipIds }),
      })
    );
  },
  async downloadBatch(videoId, clipIds) {
    const res = await fetch(`/api/videos/${videoId}/download-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipIds }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Erro ${res.status}`);
    }
    return res.blob();
  },
};

export function videoFileUrl(videoId) {
  return `/api/videos/${videoId}/file`;
}

export function clipFileUrl(clipId) {
  return `/api/clips/${clipId}/file?t=${Date.now()}`;
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}
