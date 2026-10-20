import React, { useRef, useState } from 'react';

export default function UploadPanel({ onUpload, busy, pct }) {
  const inputRef = useRef(null);
  const [drag, setDrag] = useState(false);

  const pick = (file) => {
    if (file) onUpload(file);
  };

  return (
    <div
      className={`dropzone ${drag ? 'drag' : ''} ${busy ? 'busy' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        pick(e.dataTransfer.files?.[0]);
      }}
      onClick={() => !busy && inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && !busy && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => pick(e.target.files?.[0])}
      />
      {busy ? (
        <div className="dropzone-busy">
          <div className="progress big">
            <div className="progress-fill" style={{ width: `${Math.round(pct * 100)}%` }} />
          </div>
          <p>Enviando vídeo... {Math.round(pct * 100)}%</p>
        </div>
      ) : (
        <>
          <div className="dropzone-icon">⬆</div>
          <h2>Envie o vídeo do podcast (horizontal)</h2>
          <p className="muted">
            MP4, MOV ou MKV · até 8 GB · a análise encontra os melhores momentos e gera cortes 9:16
          </p>
          <span className="btn primary">Escolher arquivo</span>
        </>
      )}
    </div>
  );
}
