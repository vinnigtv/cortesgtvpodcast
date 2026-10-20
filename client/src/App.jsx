import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, videoFileUrl } from './api.js';
import UploadPanel from './components/UploadPanel.jsx';
import ClipCard from './components/ClipCard.jsx';

export default function App() {
  const [video, setVideo] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisMsg, setAnalysisMsg] = useState('');
  const [analysisPct, setAnalysisPct] = useState(0);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const pollRef = useRef(null);

  const refresh = useCallback(async (id) => {
    const data = await api.getVideo(id);
    setVideo(data);
    return data;
  }, []);

  const pollWhile = useCallback(
    async (id, stopWhen, onTick) => {
      clearInterval(pollRef.current);
      return new Promise((resolve, reject) => {
        pollRef.current = setInterval(async () => {
          try {
            const data = await refresh(id);
            onTick?.(data);
            if (stopWhen(data)) {
              clearInterval(pollRef.current);
              resolve(data);
            }
          } catch (e) {
            clearInterval(pollRef.current);
            reject(e);
          }
        }, 1200);
      });
    },
    [refresh]
  );

  useEffect(() => () => clearInterval(pollRef.current), []);

  const handleUpload = async (file) => {
    setError(null);
    setUploading(true);
    setUploadPct(0);
    try {
      const data = await api.upload(file, setUploadPct);
      setVideo(data);
      setSelected(new Set());
      await startAnalysis(data.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const startAnalysis = async (id) => {
    setError(null);
    setAnalyzing(true);
    setAnalysisPct(0);
    setAnalysisMsg('Enviando para análise...');
    try {
      const { jobId } = await api.analyze(id);
      const started = Date.now();
      await pollWhile(
        id,
        (data) => data.status === 'analyzed' || Date.now() - started > 30 * 60 * 1000,
        () => {
          setAnalysisPct((p) => Math.min(95, p + 2));
          setAnalysisMsg('Analisando áudio e detectando rostos do convidado...');
        }
      );
      const data = await refresh(id);
      setSelected(new Set(data.clips.map((c) => c.id)));
    } catch (e) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const watchingClips = video?.clips?.some((c) => ['queued', 'rendering'].includes(c.status));

  useEffect(() => {
    if (!video || !watchingClips) return;
    const t = setInterval(() => refresh(video.id).catch(() => {}), 1200);
    return () => clearInterval(t);
  }, [video, watchingClips, refresh]);

  const toggleSelect = (clipId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(clipId)) next.delete(clipId);
      else next.add(clipId);
      return next;
    });
  };

  const handleRenderBatch = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setBatchBusy(true);
    setError(null);
    try {
      await api.renderBatch(ids);
      await refresh(video.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBatchBusy(false);
    }
  };

  const handleDownloadBatch = async () => {
    const ids = video.clips.filter((c) => selected.has(c.id) && c.hasFile).map((c) => c.id);
    if (!ids.length) {
      setError('Selecione cortes já renderizados para baixar em lote.');
      return;
    }
    setBatchBusy(true);
    try {
      const blob = await api.downloadBatch(video.id, ids);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'gtv-cortes.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    } finally {
      setBatchBusy(false);
    }
  };

  const readySelected = video?.clips?.filter((c) => selected.has(c.id) && c.hasFile).length || 0;
  const renderedCount = video?.clips?.filter((c) => c.hasFile).length || 0;

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>
            GTV Cortes <span className="accent">IA</span>
          </h1>
          <p className="tagline">
            Cole um vídeo de podcast e deixe a IA gerar cortes verticais 9:16 com rosto do convidado em quadro.
          </p>
        </div>
        {video && (
          <button className="btn ghost" onClick={() => setVideo(null)}>
            Novo vídeo
          </button>
        )}
      </header>

      {error && (
        <div className="banner error" role="alert">
          {error}
          <button className="banner-close" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {!video && <UploadPanel onUpload={handleUpload} busy={uploading} pct={uploadPct} />}

      {video && (
        <>
          <section className="video-bar">
            <div className="video-meta">
              <strong title={video.name}>{video.name}</strong>
              <span>
                {video.meta.width}×{video.meta.height} · {Math.round(video.meta.duration)}s ·{' '}
                {video.meta.fps.toFixed(1)} fps
              </span>
            </div>
            {analyzing && (
              <div className="analysis">
                <div className="progress">
                  <div className="progress-fill" style={{ width: `${analysisPct}%` }} />
                </div>
                <span>{analysisMsg}</span>
              </div>
            )}
            {!analyzing && video.status !== 'analyzed' && (
              <button className="btn" onClick={() => startAnalysis(video.id)}>
                Analisar vídeo
              </button>
            )}
          </section>

          {video.status === 'analyzed' && (
            <>
              <section className="toolbar">
                <span className="muted">
                  {video.clips.length} sugestões · {renderedCount} renderizados · {selected.size} selecionados
                </span>
                <div className="toolbar-actions">
                  <button className="btn" disabled={!selected.size || batchBusy} onClick={handleRenderBatch}>
                    {batchBusy ? 'Processando...' : `Renderizar selecionados (${selected.size})`}
                  </button>
                  <button className="btn primary" disabled={!readySelected || batchBusy} onClick={handleDownloadBatch}>
                    Baixar em lote ({readySelected})
                  </button>
                </div>
              </section>

              <section className="clips">
                {video.clips.map((clip) => (
                  <ClipCard
                    key={clip.id}
                    clip={clip}
                    duration={video.meta.duration}
                    src={videoFileUrl(video.id)}
                    selected={selected.has(clip.id)}
                    onToggle={() => toggleSelect(clip.id)}
                    onUpdated={() => refresh(video.id)}
                    onError={setError}
                  />
                ))}
              </section>
            </>
          )}
        </>
      )}

      <footer className="footer">
        GTV Cortes IA — análise de áudio + rastreamento de rosto + render 9:16 (FFmpeg)
      </footer>
    </div>
  );
}
