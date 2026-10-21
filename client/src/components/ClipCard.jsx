import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, clipFileUrl, fmtTime } from '../api.js';

export default function ClipCard({ clip, duration, src, selected, onToggle, onUpdated, onError }) {
  const [start, setStart] = useState(clip.start);
  const [end, setEnd] = useState(clip.end);
  const [title, setTitle] = useState(clip.title || '');
  const [captions, setCaptions] = useState(clip.captions !== false);
  const [progressBar, setProgressBar] = useState(clip.progressBar !== false);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [showRendered, setShowRendered] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [renderKey, setRenderKey] = useState(0);
  const videoRef = useRef(null);

  useEffect(() => {
    setStart(clip.start);
    setEnd(clip.end);
    setTitle(clip.title || '');
    setCaptions(clip.captions !== false);
    setProgressBar(clip.progressBar !== false);
  }, [clip.start, clip.end, clip.title, clip.captions, clip.progressBar]);

  useEffect(() => {
    if (['queued', 'rendering'].includes(clip.status) && !rendering) setRendering(true);
    if (!['queued', 'rendering'].includes(clip.status) && rendering) {
      setRendering(false);
      if (clip.status === 'ready') {
        setShowRendered(true);
        setRenderKey((k) => k + 1);
      }
    }
  }, [clip.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(
    () =>
      Math.abs(start - clip.start) > 0.05 ||
      Math.abs(end - clip.end) > 0.05 ||
      (title || '') !== (clip.title || '') ||
      captions !== (clip.captions !== false) ||
      progressBar !== (clip.progressBar !== false),
    [start, end, clip.start, clip.end, title, clip.title, captions, clip.captions, progressBar, clip.progressBar]
  );

  const clampRange = (s, e) => {
    let ns = Math.max(0, Math.min(duration - 5, s));
    let ne = Math.min(duration, Math.max(ns + 5, e));
    return [ns, ne];
  };

  const save = async () => {
    setSaving(true);
    try {
      const [ns, ne] = clampRange(start, end);
      await api.patchClip(clip.id, ns, ne, title, { captions, progressBar });
      onUpdated();
    } catch (e) {
      onError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const render = async () => {
    setRendering(true);
    try {
      if (dirty) {
        const [ns, ne] = clampRange(start, end);
        await api.patchClip(clip.id, ns, ne, title, { captions, progressBar });
      }
      await api.renderClip(clip.id);
      onUpdated();
    } catch (e) {
      setRendering(false);
      onError(e.message);
    }
  };

  const onSeekInput = (isStart, value) => {
    if (isStart) {
      const [ns, ne] = clampRange(Number(value), end);
      setStart(ns);
      setEnd(ne);
    } else {
      const [ns, ne] = clampRange(start, Number(value));
      setStart(ns);
      setEnd(ne);
    }
  };

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.currentTime < start || v.currentTime >= end) {
      v.currentTime = start;
      v.play().catch(() => {});
    }
  };

  const previewSrc = showRendered && clip.hasFile ? `${clipFileUrl(clip.id)}#${renderKey}` : src;

  const viral = clip.viralPct ?? Math.round((clip.score || 0) * 100);
  const viralBand = viral >= 70 ? 'hot' : viral >= 45 ? 'warm' : 'cool';

  return (
    <article className={`clip-card ${selected ? 'selected' : ''}`}>
      <div className="clip-head">
        <label className="check">
          <input type="checkbox" checked={selected} onChange={onToggle} />
        </label>
        <div className={`clip-score ${viralBand}`} title={`Chance de viralizar: ${viral}%`}>
          <span className="clip-score-num">{viral}%</span>
          <span className="clip-score-label">viral</span>
        </div>
        <div className="clip-info">
          <input
            className="clip-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Tema do corte"
            maxLength={80}
          />
          <div className="clip-sub">
            {fmtTime(clip.start)} → {fmtTime(clip.end)} · {Math.round(clip.end - clip.start)}s
            {clip.keywords?.length ? (
              <span className="clip-keywords"> · {clip.keywords.slice(0, 4).join(', ')}</span>
            ) : null}
          </div>
          <div className="clip-reason muted">{clip.reason}</div>
        </div>
        <span className={`badge ${clip.status}`}>{statusLabel(clip.status)}</span>
      </div>

      <div className="clip-body">
        <div className="player-wrap">
          <div className={`player-frame ${showRendered && clip.hasFile ? 'vertical' : ''}`}>
            {showRendered && clip.hasFile ? (
              <video key={renderKey} src={previewSrc} controls playsInline />
            ) : (
              <video
                ref={videoRef}
                src={previewSrc}
                controls
                playsInline
                onTimeUpdate={onTimeUpdate}
              />
            )}
          </div>
        </div>

        <div className="clip-controls">
          {['queued', 'rendering'].includes(clip.status) ? (
            <div className="render-progress">
              <div className="progress">
                <div className="progress-fill" style={{ width: `${Math.round((clip.progress || 0) * 100)}%` }} />
              </div>
              <span>Renderizando... {Math.round((clip.progress || 0) * 100)}%</span>
            </div>
          ) : (
            <>
              <div className="range-row">
                <label>Início</label>
                <input
                  type="range"
                  min={0}
                  max={duration}
                  step={0.5}
                  value={start}
                  onChange={(e) => onSeekInput(true, e.target.value)}
                />
                <span className="time">{fmtTime(start)}</span>
              </div>
              <div className="range-row">
                <label>Fim</label>
                <input
                  type="range"
                  min={0}
                  max={duration}
                  step={0.5}
                  value={end}
                  onChange={(e) => onSeekInput(false, e.target.value)}
                />
                <span className="time">{fmtTime(end)}</span>
              </div>
              <div className="tool-toggles">
                <label className="toggle">
                  <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />
                  <span>Legendas automáticas</span>
                </label>
                <label className="toggle">
                  <input type="checkbox" checked={progressBar} onChange={(e) => setProgressBar(e.target.checked)} />
                  <span>Barra de progresso</span>
                </label>
              </div>
              <div className="clip-actions">
                {dirty && (
                  <button className="btn ghost" disabled={saving} onClick={save}>
                    {saving ? 'Salvando...' : 'Salvar ajustes'}
                  </button>
                )}
                <button className="btn" disabled={rendering} onClick={render}>
                  {clip.hasFile ? 'Re-renderizar 9:16' : 'Renderizar 9:16'}
                </button>
                {clip.hasFile && (
                  <button className="btn ghost" onClick={() => setShowRendered((s) => !s)}>
                    {showRendered ? 'Prévia original' : 'Prévia do corte'}
                  </button>
                )}
                {clip.transcriptExcerpt && (
                  <button className="btn ghost" onClick={() => setShowTranscript((s) => !s)}>
                    {showTranscript ? 'Ocultar transcrição' : 'Ver transcrição'}
                  </button>
                )}
                {clip.transcriptExcerpt && (
                  <a className="btn ghost" href={`/api/clips/${clip.id}/srt`} download>
                    Baixar .srt
                  </a>
                )}
                {clip.hasFile && (
                  <a className="btn primary" href={`/api/clips/${clip.id}/download`}>
                    Baixar MP4
                  </a>
                )}
              </div>
              {showTranscript && clip.transcriptExcerpt && (
                <blockquote className="clip-transcript">“{clip.transcriptExcerpt}…”</blockquote>
              )}
              {clip.render && (
                <div className="muted small">
                  {clip.render.width}×{clip.render.height} ·{' '}
                  {clip.render.framing === 'blur-pad'
                    ? 'quadro inteiro com fundo desfocado'
                    : clip.render.faceTracked
                      ? `rosto rastreado e centralizado (${Math.round(clip.render.faceCoverage * 100)}% dos frames)`
                      : 'sem rosto estável — enquadramento central'}
                  {clip.render.captions ? ' · legendas' : ''}
                  {clip.render.progressBar ? ' · barra de progresso' : ''}
                </div>
              )}
              {clip.error && <div className="clip-error">{clip.error}</div>}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function statusLabel(s) {
  return {
    suggested: 'Sugestão',
    queued: 'Na fila',
    rendering: 'Renderizando',
    ready: 'Pronto',
    error: 'Erro',
  }[s] || s;
}
