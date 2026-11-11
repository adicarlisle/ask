#!/usr/bin/env node
// Builds ASK's word-vector data from GloVe (glove.6B.300d.txt, Stanford NLP, PDDL licence).
// The full file is ~1 GB; ASK keeps:
//   - the 64 hexagram vectors, averaged from full-precision keyword vectors (as AI-CHING does)
//   - the WORDS most frequent words (GloVe lists words by frequency), as int8 with one
//     float32 scale per word, so the whole vocabulary is a few MB and fits a tiny container.
//   node model/build.js /path/to/glove.6B.300d.txt [WORDS]
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const HEXAGRAMS = require('./hexagrams');

const DIM = 300;
const [src, wordsArg] = process.argv.slice(2);
const WORDS = Number(wordsArg || 25000);
if (!src) { console.error('usage: node model/build.js glove.6B.300d.txt [words]'); process.exit(1); }
const OUT = path.join(__dirname, '..', 'data');

(async () => {
  const keywords = new Set(HEXAGRAMS.flatMap(([, , , kw]) => kw));
  const full = new Map(); // keyword -> Float32Array (full precision)
  const vocab = [];
  const i8 = new Int8Array(WORDS * DIM);
  const scales = new Float32Array(WORDS);
  const rl = readline.createInterface({ input: fs.createReadStream(src, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const sp = line.indexOf(' ');
    const word = line.slice(0, sp);
    const needed = vocab.length < WORDS && /^[a-z][a-z'-]*$/.test(word); // plain words only
    if (!needed && !keywords.has(word)) { if (vocab.length >= WORDS && full.size === keywords.size) break; continue; }
    const v = Float32Array.from(line.slice(sp + 1).split(' '), Number);
    if (v.length !== DIM) continue;
    if (keywords.has(word)) full.set(word, v);
    if (needed) {
      const row = vocab.length;
      let max = 0;
      for (const x of v) max = Math.max(max, Math.abs(x));
      const scale = max / 127 || 1;
      scales[row] = scale;
      for (let d = 0; d < DIM; d++) i8[row * DIM + d] = Math.round(v[d] / scale);
      vocab.push(word);
    }
  }
  const missing = [...keywords].filter((k) => !full.has(k));
  if (missing.length) console.warn('keywords not in GloVe (random in AI-CHING, skipped here):', missing.join(' '));

  const hexagrams = HEXAGRAMS.map(([id, name, glyph, kw]) => {
    if (glyph.codePointAt(0) !== 0x4dc0 + id - 1) throw new Error(`glyph for ${id} is out of order`);
    const vecs = kw.map((k) => full.get(k)).filter(Boolean);
    const mean = new Array(DIM).fill(0);
    for (const v of vecs) for (let d = 0; d < DIM; d++) mean[d] += v[d] / vecs.length;
    return { id, name, glyph, keywords: kw, vector: mean.map((x) => Math.round(x * 1e5) / 1e5) };
  });

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'vocab.txt'), vocab.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'vectors.i8'), Buffer.from(i8.buffer, 0, vocab.length * DIM));
  fs.writeFileSync(path.join(OUT, 'scales.f32'), Buffer.from(scales.buffer, 0, vocab.length * 4));
  fs.writeFileSync(path.join(OUT, 'hexagrams.json'), JSON.stringify(hexagrams));
  console.log(`${vocab.length} words x ${DIM}d, ${hexagrams.length} hexagrams -> ${OUT}`);
})();
