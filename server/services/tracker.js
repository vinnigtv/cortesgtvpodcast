import { pickMainFace } from './face.js';

export async function detectRange(opts) {
  const { frames, srcW, srcH, detect } = opts;
  const results = [];
  for (const fr of frames) {
    const { width, height, faces } = await detect(fr.buf);
    const sx = srcW / width;
    const sy = srcH / height;
    const main = pickMainFace(faces);
    if (main) {
      results.push({
        t: fr.t,
        face: {
          x1: main.x1 * sx,
          y1: main.y1 * sy,
          x2: main.x2 * sx,
          y2: main.y2 * sy,
          score: main.score,
        },
      });
    } else {
      results.push({ t: fr.t, face: null });
    }
  }
  return results;
}

export function buildTrack(detections, { srcW, srcH, fps }) {
  const n = detections.length;
  if (!n) return null;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const present = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const f = detections[i].face;
    if (f) {
      xs[i] = (f.x1 + f.x2) / 2;
      ys[i] = (f.y1 + f.y2) / 2;
      present[i] = 1;
    }
  }
  const total = present.reduce((a, b) => a + b, 0);
  const coverage = total / n;
  if (coverage < 0.25) return { ok: false, coverage, centers: null };

  const firstIdx = present.indexOf(1);
  let lastIdx = -1;
  for (let i = n - 1; i >= 0; i--) if (present[i]) { lastIdx = i; break; }

  for (let i = 0; i < n; i++) {
    if (present[i]) continue;
    if (i < firstIdx) { xs[i] = xs[firstIdx]; ys[i] = ys[firstIdx]; continue; }
    if (i > lastIdx) { xs[i] = xs[lastIdx]; ys[i] = ys[lastIdx]; continue; }
    let prev = i - 1;
    while (prev >= 0 && !present[prev]) prev--;
    let next = i + 1;
    while (next < n && !present[next]) next++;
    const span = next - prev;
    const w = (i - prev) / span;
    xs[i] = xs[prev] + (xs[next] - xs[prev]) * w;
    ys[i] = ys[prev] + (ys[next] - ys[prev]) * w;
  }

  const win = Math.max(3, Math.round(fps * 0.75));
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let ax = 0, ay = 0, c = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) {
      ax += xs[j];
      ay += ys[j];
      c++;
    }
    sx[i] = ax / c;
    sy[i] = ay / c;
  }

  const faceW = srcW * 0.22;
  const faceH = srcW * 0.28;
  const expandedH = Math.min(srcH, faceH * 1.7);
  const expandedW = Math.min(srcW, faceW * 2.2);
  const aspect = 9 / 16;
  let cropH = Math.max(expandedH, expandedW / aspect);
  cropH = Math.min(cropH, srcH, srcW * aspect);
  const cropW = cropH * aspect;
  const centers = [];
  for (let i = 0; i < n; i++) {
    const maxY = srcH - cropH;
    const maxX = srcW - cropW;
    let cx = sx[i];
    let cy = sy[i] - 0.05 * cropH;
    cx = Math.max(cropW / 2, Math.min(srcW - cropW / 2, cx));
    cy = Math.max(cropH / 2, Math.min(srcH - cropH / 2, cy));
    centers.push({
      x: Math.max(0, Math.min(maxX, cx - cropW / 2)),
      y: Math.max(0, Math.min(maxY, cy - cropH / 2)),
    });
  }
  return {
    ok: true,
    coverage,
    cropW: evenFloor(cropW),
    cropH: evenFloor(cropH),
    centers,
  };
}

function evenFloor(v) {
  const f = Math.floor(v);
  return f % 2 === 0 ? f : f - 1;
}

export function keyframesFromTrack(track, duration, step = 1) {
  const pts = [];
  const n = track.centers.length;
  const span = duration;
  for (let t = 0; t <= span; t += step) {
    const idx = Math.min(n - 1, Math.round((t / span) * (n - 1)));
    pts.push({ t, x: track.centers[idx].x, y: track.centers[idx].y });
  }
  const last = { t: span, ...track.centers[n - 1] };
  pts.push(last);
  return pts;
}

export function simplifyKeyframes(points, { eps = 2.5, maxPoints = 80 } = {}) {
  if (points.length <= 2) return points.slice();
  const build = (threshold) => {
    const out = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      const last = out[out.length - 1];
      if (Math.hypot(points[i].x - last.x, points[i].y - last.y) >= threshold) out.push(points[i]);
    }
    out.push(points[points.length - 1]);
    return out;
  };
  let out = build(eps);
  while (out.length > maxPoints) {
    eps *= 1.6;
    out = build(eps);
  }
  return out;
}

export function piecewiseLinear(points, varName = 't') {
  if (!points.length) return '0';
  if (points.length === 1) return points[0].x.toFixed(2);
  let expr = points[points.length - 1].x.toFixed(2);
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i];
    const b = points[i + 1];
    const dt = (b.t - a.t) || 1;
    const seg = `(${a.x.toFixed(2)}+(${(b.x - a.x).toFixed(3)})*(${varName}-${a.t.toFixed(3)})/${dt.toFixed(3)})`;
    expr = `if(lt(${varName},${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return expr;
}

export function centerCropFallback(srcW, srcH) {
  const aspect = 9 / 16;
  const cropH = Math.min(srcH, srcW * aspect);
  const cropW = evenFloor(cropH * aspect);
  const x = evenFloor((srcW - cropW) / 2);
  const y = evenFloor((srcH - cropH) / 2);
  return { cropW, cropH: evenFloor(cropH), x, y };
}
