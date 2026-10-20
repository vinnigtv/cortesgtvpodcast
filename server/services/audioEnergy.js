const WINDOW_SEC = 0.5;

export function pcmToWindows(buf) {
  const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const sr = 16000;
  const win = Math.floor(sr * WINDOW_SEC);
  const windows = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    let peak = 0;
    for (let j = i; j < i + win; j++) {
      const s = samples[j];
      sum += s * s;
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
    windows.push({
      t: (i / sr),
      rms: Math.sqrt(sum / win),
      peak,
    });
  }
  return windows;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function computeSpeechStats(windows) {
  const rmsVals = windows.map((w) => w.rms);
  const noiseFloor = percentile(rmsVals, 0.1);
  const loud = percentile(rmsVals, 0.9);
  const threshold = noiseFloor + (loud - noiseFloor) * 0.25;
  let speech = 0;
  for (const w of windows) if (w.rms > threshold) speech++;
  return {
    noiseFloor,
    loud,
    threshold,
    speechRatio: windows.length ? speech / windows.length : 0,
  };
}

export function windowScore(windows, start, end, stats) {
  const inRange = windows.filter((w) => w.t >= start && w.t < end);
  if (!inRange.length) return 0;
  const rms = inRange.map((w) => w.rms);
  const mean = rms.reduce((a, b) => a + b, 0) / rms.length;
  const variance = rms.reduce((a, b) => a + (b - mean) ** 2, 0) / rms.length;
  const top = [...rms].sort((a, b) => b - a).slice(0, Math.max(1, Math.floor(rms.length / 3)));
  const topMean = top.reduce((a, b) => a + b, 0) / top.length;
  let speechCount = 0;
  for (const w of inRange) if (w.rms > stats.threshold) speechCount++;
  const speechRatio = speechCount / inRange.length;
  const norm = stats.loud - stats.noiseFloor || 1e-6;
  const meanScore = Math.min(1, mean / norm);
  const topScore = Math.min(1, topMean / norm);
  const varScore = Math.min(1, Math.sqrt(variance) / norm);
  return 0.35 * meanScore + 0.35 * topScore + 0.15 * varScore + 0.15 * speechRatio;
}

export function pickCandidates(windows, { duration, count = 8, minLen = 30, maxLen = 90 } = {}) {
  if (!windows.length) {
    const segs = [];
    const len = Math.min(maxLen, Math.max(minLen, duration / 4));
    for (let t = 0; t + len <= duration + 0.01 && segs.length < count; t += len + 10) {
      segs.push({ start: t, end: Math.min(duration, t + len), score: 0.5, audioScore: 0.5 });
    }
    return segs;
  }
  const stats = computeSpeechStats(windows);
  const lengths = [30, 45, 60, 75, 90].filter((l) => l >= minLen && l <= maxLen);
  const step = 15;
  const all = [];
  for (const len of lengths) {
    for (let t = 0; t + len <= duration + 0.01; t += step) {
      const end = t + len;
      const score = windowScore(windows, t, end, stats);
      all.push({ start: t, end, audioScore: score });
    }
  }
  all.sort((a, b) => b.audioScore - a.audioScore);
  const picked = [];
  const MIN_GAP = 5;
  for (const c of all) {
    if (picked.length >= count) break;
    const overlaps = picked.some(
      (p) => c.start < p.end + MIN_GAP && c.end > p.start - MIN_GAP
    );
    if (!overlaps) picked.push(c);
  }
  return picked;
}
