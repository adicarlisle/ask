// Ask's oracle: AI-CHING's method (github.com/adicarlisle/AI-CHING) on a compact GloVe vocabulary.
// A question's words become GloVe vectors, which are averaged; the six hexagrams whose keyword
// vectors are closest (cosine similarity) are the reading, weighted with a softmax (scores x 2).
// As in AI-CHING, a word GloVe doesn't know gets a random vector (normal, sd 0.1), so questions
// with unknown words can read differently each time. That's the stochastic part, kept on purpose.
'use strict';
const fs = require('fs');
const path = require('path');

const DIM = 300;
const TOP = 6;

function load(dir = path.join(__dirname, 'data')) {
  const words = fs.readFileSync(path.join(dir, 'vocab.txt'), 'utf8').split('\n').filter(Boolean);
  const index = new Map(words.map((w, i) => [w, i]));
  const raw = fs.readFileSync(path.join(dir, 'vectors.i8'));
  const i8 = new Int8Array(raw.buffer, raw.byteOffset, raw.length);
  const sc = fs.readFileSync(path.join(dir, 'scales.f32'));
  const scales = new Float32Array(sc.buffer.slice(sc.byteOffset, sc.byteOffset + sc.length));
  const hexagrams = JSON.parse(fs.readFileSync(path.join(dir, 'hexagrams.json'), 'utf8')).map((h) => {
    const v = Float32Array.from(h.vector);
    return { ...h, vector: undefined, unit: unit(v) };
  });
  return { index, i8, scales, hexagrams, size: words.length };
}

function unit(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return n > 0 ? v.map((x) => x / n) : v;
}

// Box-Muller: one standard normal sample from a uniform source.
function gaussian(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Lower-case words with surrounding punctuation removed ("job?" -> "job").
function tokens(question) {
  return String(question).toLowerCase().split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
}

function ask(model, question, rand = Math.random) {
  const words = tokens(question);
  if (!words.length) return null;
  const mean = new Float32Array(DIM);
  const unknown = [];
  for (const w of words) {
    const row = model.index.get(w);
    if (row === undefined) {
      unknown.push(w);
      for (let d = 0; d < DIM; d++) mean[d] += (gaussian(rand) * 0.1) / words.length;
    } else {
      const s = model.scales[row], off = row * DIM;
      for (let d = 0; d < DIM; d++) mean[d] += (model.i8[off + d] * s) / words.length;
    }
  }
  const q = unit(mean);
  const scored = model.hexagrams.map((h) => {
    let dot = 0;
    for (let d = 0; d < DIM; d++) dot += q[d] * h.unit[d];
    return { id: h.id, name: h.name, glyph: h.glyph, keywords: h.keywords, similarity: dot };
  }).sort((a, b) => b.similarity - a.similarity).slice(0, TOP);
  const exps = scored.map((s) => Math.exp(s.similarity * 2));
  const total = exps.reduce((a, b) => a + b, 0);
  scored.forEach((s, i) => { s.weight = exps[i] / total; });
  return { question: String(question), words, unknown, reading: scored };
}

module.exports = { load, ask, tokens, DIM, TOP };
