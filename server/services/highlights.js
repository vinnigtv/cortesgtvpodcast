import { computeSpeechStats, windowScore } from './audioEnergy.js';

const STOPWORDS = new Set([
  'que', 'para', 'com', 'uma', 'dos', 'das', 'mas', 'por', 'porque', 'quando', 'muito',
  'mais', 'isso', 'esse', 'essa', 'este', 'esta', 'aqui', 'então', 'assim', 'talvez',
  'sobre', 'entre', 'depois', 'antes', 'cada', 'tudo', 'todos', 'toda', 'todos',
  'aí', 'é', 'eu', 'ele', 'ela', 'eles', 'elas', 'você', 'voce', 'nós', 'nos',
  'meu', 'minha', 'seu', 'sua', 'nosso', 'essa', 'disse', 'falar', 'falando',
  'the', 'and', 'you', 'that', 'have', 'for', 'not', 'with', 'this', 'but',
]);

const HOOKS = [
  'ninguém', 'ngm', 'nunca', 'sempre', 'segredo', 'verdade', 'mentira', 'errado',
  'erro', 'milhões', 'milhão', 'dinheiro', 'sucesso', 'fracasso', 'crise', 'medo',
  'coragem', 'incrível', 'inacreditável', 'absurdo', 'polêmica', 'polêmico',
  'cancelamento', 'processo', 'prisão', 'traição', 'traído', 'amor', 'despedida',
  'morreu', 'morte', 'salvou', 'mudou', 'a verdade', 'o problema', 'todo mundo',
  'ninguém fala', 'vou contar', 'fala sério', 'sinceramente', 'honestamente',
  'aí não', 'imagina', 'cara', 'mano', 'véi', 'puta que pariu', 'puta que pariu',
  'meu deus', 'santo deus', 'que porra', 'do nada', 'de repente', 'aconteceu',
  'história real', 'contar uma', 'vem cá', 'olha só', 'presta atenção',
  'a maior', 'o maior', 'o melhor', 'o pior', 'emergência', 'urgente',
  'explica', 'explicar', 'descobri', 'descoberta', 'reviravolta', 'escândalo',
  'denúncia', 'acusou', 'acusação', 'brigou', 'briga', 'chorou', 'chorar',
  'risadas', 'morri de rir', 'muito bom', 'melhor momento', 'o que houve',
];

const STORY_MARKERS = [
  'aí', 'então', 'um dia', 'eu lembro', 'quando eu', 'quando a gente',
  'naquele dia', 'de repente', 'do nada', 'a história', 'eu tava', 'eu estava',
  'a gente foi', 'a gente falou', 'me contou', 'ninguém sabia',
];

const EMOTIONAL = [
  'amor', 'ódio', 'raiva', 'medo', 'triste', 'feliz', 'ansiedade', 'ansioso',
  'depressão', 'terapia', 'crise', 'panico', 'pânico', 'euforia', 'nostalgia',
  'saudade', 'surrpreso', 'chocado', 'emocionado', 'orgulho', 'vergonha',
];

function norm(t) {
  return (t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function countHits(text, lexicon) {
  const n = norm(text);
  let hits = 0;
  for (const w of lexicon) {
    const nw = norm(w);
    let idx = 0;
    while ((idx = n.indexOf(nw, idx)) !== -1) {
      hits++;
      idx += nw.length;
    }
  }
  return hits;
}

function words(text) {
  return norm(text).split(/[^a-z0-9à-ú]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

export function segmentsInRange(segments, start, end) {
  return segments.filter((s) => s.end > start && s.start < end);
}

export function transcriptStats(segments, start, end) {
  const inRange = segmentsInRange(segments, start, end);
  const text = inRange.map((s) => s.text).join(' ');
  const duration = end - start;
  const chars = text.length;
  const w = words(text);
  const wps = w.length / Math.max(1, duration);
  const questions = (text.match(/\?/g) || []).length;
  const exclamations = (text.match(/!/g) || []).length;
  const hooks = countHits(text, HOOKS);
  const story = countHits(text, STORY_MARKERS);
  const emotional = countHits(text, EMOTIONAL);
  const sentences = inRange
    .flatMap((s) => s.text.split(/(?<=[.!?])\s+/))
    .map((t) => t.trim())
    .filter((t) => t.length > 15);
  return {
    text,
    wordCount: w.length,
    wps,
    questions,
    exclamations,
    hooks,
    story,
    emotional,
    sentences,
    segments: inRange,
    words: w,
  };
}

export function contentScore(stats, energyScore, duration) {
  if (!stats.wordCount) {
    const e = clamp(energyScore ?? 0.45, 0, 1);
    const durBonus = duration <= 60 ? 0.05 : 0;
    return clamp(0.75 * e + durBonus + 0.15, 0, 1);
  }
  const speechDensity = clamp(stats.wps / 2.6, 0, 1);
  const hookScore = clamp(stats.hooks / 5, 0, 1);
  const questionScore = clamp(stats.questions / 3, 0, 1);
  const storyScore = clamp(stats.story / 4, 0, 1);
  const emotionScore = clamp(stats.emotional / 3, 0, 1);
  const exclamScore = clamp(stats.exclamations / 4, 0, 1);
  const durBonus = duration <= 60 ? 0.05 : 0;
  const score =
    0.24 * (energyScore ?? 0.45) +
    0.18 * speechDensity +
    0.2 * hookScore +
    0.12 * questionScore +
    0.1 * storyScore +
    0.08 * emotionScore +
    0.05 * exclamScore +
    durBonus;
  return clamp(score, 0, 1);
}

export function buildCandidates(transcript, windows, { duration, minLen = 30, maxLen = 90 } = {}) {
  const segments = transcript?.segments || [];
  const stats = windows.length ? computeSpeechStats(windows) : null;
  const all = [];
  const seen = new Set();

  const push = (start, end, source) => {
    start = Math.max(0, Math.round(start * 10) / 10);
    end = Math.min(duration, Math.round(end * 10) / 10);
    if (end - start < minLen - 1) return;
    const key = `${Math.round(start / 5)}:${Math.round(end / 5)}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push({ start, end, source });
  };

  if (segments.length) {
    const starts = segments.map((s) => s.start);
    const lengths = [30, 45, 60, 75, 90];
    for (const st of starts) {
      for (const len of lengths) {
        if (st + len <= duration + 0.01) push(st, st + len, 'transcript');
      }
      const last = segments.find((s) => s.start >= st && s.start <= st + maxLen);
      if (last) push(st, last.end + 1.5, 'boundary');
    }
  }

  const step = 12;
  for (const len of [30, 45, 60, 75, 90]) {
    for (let t = 0; t + len <= duration + 0.01; t += step) {
      push(t, t + len, 'sliding');
    }
  }

  const scored = all.map((c) => {
    const tStats = segments.length ? transcriptStats(segments, c.start, c.end) : null;
    const eScore = stats ? windowScore(windows, c.start, c.end, stats) : null;
    return {
      ...c,
      score: contentScore(tStats || { wordCount: 0 }, eScore, c.end - c.start),
      stats: tStats,
      audioScore: eScore ?? 0,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export const MAX_CLIPS = 20;

export function selectCandidates(scored, { minScoreRatio = 0.5, absoluteMin = 0.3, minGap = 6, limit = MAX_CLIPS } = {}) {
  if (!scored.length) return [];
  const top = scored[0].score;
  const threshold = Math.min(top, Math.max(absoluteMin, top * minScoreRatio));
  const picked = [];
  for (const c of scored) {
    if (picked.length >= limit) break;
    if (c.score < threshold) break;
    const overlaps = picked.some(
      (p) => c.start < p.end + minGap && c.end > p.start - minGap
    );
    if (!overlaps) picked.push(c);
  }
  return picked;
}

export function viralPercent(content, faceCoverage) {
  const face = faceCoverage ?? 0.5;
  const combined = clamp(0.82 * content + 0.18 * face, 0, 1);
  const pct = Math.round(Math.pow(combined, 0.72) * 105);
  return clamp(pct, 5, 98);
}

export function makeTitle(stats, fallbackLabel) {
  if (!stats || !stats.words.length) return fallbackLabel;
  const keywords = topKeywords(stats.words, 5).map(cleanKeyword).filter(Boolean);
  if (!keywords.length) return fallbackLabel;
  const topic = keywords.slice(0, 3);
  let title = topic.length > 1 ? `${topic.slice(0, -1).join(', ')} e ${topic.at(-1)}` : topic[0];
  title = title.replace(/^./, (m) => m.toUpperCase());
  return title || fallbackLabel;
}

function cleanKeyword(w) {
  let k = w.replace(/(ções|ção|s|es)$/, (m) => (m === 's' || m === 'es' ? '' : 'ão')).trim();
  if (k.length < 3) k = w;
  return k;
}

export function topKeywords(wordList, limit = 6) {
  const freq = new Map();
  for (const w of wordList) {
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}
