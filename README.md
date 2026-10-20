# GTV Cortes IA

Aplicação web que analisa vídeos de podcast (horizontal) e gera automaticamente sugestões de cortes verticais **9:16** prontos para Instagram Reels, YouTube Shorts e TikTok.

## O que a ferramenta faz

1. **Upload** de vídeo horizontal (MP4/MOV/MKV, até 8 GB).
2. **Análise do conteúdo inteiro**:
   - Energia de áudio (RMS por janelas) para achar trechos animados;
   - Detecção de rosto do convidado (TinyFaceDetector) nos trechos promissores.
3. **Sugestão de cortes de 30 a 90 segundos** com pontuação (áudio + presença do rosto).
4. **Renderização 9:16 (1080×1920)** com:
   - Rastreamento de rosto quadro a quadro;
   - Enquadramento fluido (suavização de movimento, cabeça com respiro, sem cortar a pessoa);
   - Fallback para enquadramento central quando não há rosto estável.
5. **Prévia**, ajuste de início/fim com sliders, re-renderização.
6. **Download individual** (MP4) ou **em lote** (ZIP).

## Requisitos

- Node.js 18+ (testado no Node 24)
- Windows, Linux ou macOS
- Sem necessidade de instalar FFmpeg ou Python: os binários de FFmpeg/ffprobe vêm via npm

## Como rodar

```bash
npm install        # instala backend + frontend + face-api (com patch automático)
npm run build      # builda o React (client/dist)
npm start          # sobe o servidor de produção em http://localhost:3000
```

Desenvolvimento (com hot reload no React):

```bash
npm run dev        # API em :3000 + Vite em :5173
```

Teste automatizado do pipeline (gera vídeos sintéticos e valida análise + render + rastreamento):

```bash
npm run test:pipeline
```

## Arquitetura

```
server/
  index.js              # Express: upload, análise, clips, jobs, downloads (zip), SPA
  services/
    video.js            # ffprobe/ffmpeg, extração de frames e PCM, progresso
    audioEnergy.js      # janelas RMS, detecção de fala, scoring e seleção de candidatos
    face.js             # TinyFaceDetector (@vladmandic/face-api, pesos embutidos no npm)
    tracker.js           # rastreamento de rosto, suavização e expressões de crop
    analyze.js           # orquestra áudio + rosto → sugestões de corte
    render.js            # crop animado 9:16 + escala 1080×1920 + x264/aac
    jobs.js              # fila sequencial de jobs com progresso
client/                  # React + Vite (upload, progresso, cortes, ajustes, downloads)
scripts/
  test-pipeline.mjs      # teste ponta a ponta
  patch-faceapi.mjs      # patch pós-install do bundle ESM do face-api (Node 24)
data/                    # uploads, renders e temporários (gitignored)
```

## Como funciona o enquadramento 9:16

1. No trecho do corte, frames são extraídos a 4 fps e o rosto é detectado em cada frame.
2. O centro do rosto é interpolado nos frames sem detecção e suavizado (média móvel ~1,5 s).
3. A janela de crop tem altura constante (sem "pumping" de zoom), grande o suficiente para caber a cabeça + ombros.
4. O centro do crop segue o rosto suavizado; as posições viram uma expressão de `crop` piecewise-linear aplicada pelo FFmpeg em tempo de render.
5. Sem rosto estável (< 25% dos frames): crop central 9:16.

## API principal

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/upload` | Upload do vídeo (multipart `video`) |
| POST | `/api/videos/:id/analyze` | Inicia análise (retorna `jobId`) |
| GET | `/api/videos/:id` | Status + sugestões + cortes |
| PATCH | `/api/clips/:id` | Ajusta `start`/`end` do corte |
| POST | `/api/clips/:id/render` | Renderiza 1 corte |
| POST | `/api/clips/render-batch` | Renderiza vários (`{clipIds: []}`) |
| GET | `/api/clips/:id/download` | Download do MP4 |
| POST | `/api/videos/:id/download-batch` | Download ZIP dos renderizados |
| GET | `/api/jobs/:id` | Progresso do job |

## Observações

- A análise e o render usam CPU; para vídeos longos (1h+), a análise de rosto roda só nos trechos promissores de áudio para ser mais rápida.
- Os vídeos processados ficam em `data/` — apague a pasta quando quiser liberar espaço.
- O `postinstall` aplica um patch mínimo no bundle ESM do `@vladmandic/face-api` (necessário no Node 20+).
