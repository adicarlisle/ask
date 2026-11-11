// Ask: an I Ching oracle made of word vectors, at bigthought.ai/ask.
// The web page works without JavaScript, and the same URL answers terminals in plain text:
//   curl https://bigthought.ai/ask -d "should I move abroad"
// and as a live prompt, curl alone (it streams what you type; the server answers each line):
//   curl --no-progress-meter -NT. https://bigthought.ai/ask
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const oracle = require('./oracle');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://bigthought.ai').replace(/\/$/, '');
const BASE = '/ask';
const MAX_Q = 300;
// Static files are linked with a content hash (?v=...), so an update is always fetched fresh
// and the files themselves can be cached for good.
const ASSETS = Object.fromEntries([['style.css', 'text/css'], ['copy.js', 'text/javascript']].map(([name, type]) => {
  const body = fs.readFileSync(path.join(__dirname, 'public', name));
  return [name, { body, type, v: crypto.createHash('sha256').update(body).digest('hex').slice(0, 10) }];
}));
const asset = (name) => `${BASE}/assets/${name}?v=${ASSETS[name].v}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (w) => `${Math.round(w * 100)}%`;
const sim = (x) => x.toFixed(2);
// Cosine similarity as a bar of block characters, 0 to 1 over `width` cells (eighths for the tail).
function bar(x, width = 20) {
  const eighths = Math.round(Math.max(0, Math.min(1, x)) * width * 8);
  const full = Math.floor(eighths / 8), part = eighths % 8;
  return ('█'.repeat(full) + (part ? '▏▎▍▌▋▊▉'[part - 1] : '')).padEnd(width, ' ');
}
// The same bar for the web page: SVG geometry attributes, so no inline styles (the CSP forbids them).
const svgBar = (x) => `<svg class="bar" width="100%" height="8" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="8" rx="2"/><rect class="fill" width="${(Math.max(0, Math.min(1, x)) * 100).toFixed(1)}" height="8" rx="2"/></svg>`;
const SESSION_MS = 15 * 60 * 1000; // a live prompt ends after 15 minutes,
const IDLE_MS = 3 * 60 * 1000;     // or 3 minutes without a question,
const MAX_QUESTIONS = 100;         // or after 100 questions.
const MAX_SESSIONS = 200;          // live prompts open at once, across everyone
const HEARTBEAT_MS = Number(process.env.ASK_HEARTBEAT_MS || 20 * 1000); // some networks drop a connection silent for ~60 s
// The heartbeat is ESC[0m ("reset text style"): invisible in terminals and plain text to curl.
// (A NUL byte made curl stop with "Binary output can mess up your terminal".)
const HEARTBEAT = '\u001b[0m';
const POST_MS = 10 * 1000;         // an ask-once body must arrive within 10 seconds
const TERMINAL = /^(curl|wget|httpie|xh|libcurl)\b|PowerShell/i;
// Control characters (terminal escape codes, etc.) never go back to a terminal or a page.
const clean = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
let liveSessions = 0;

const HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN', // the launcher at / shows apps in a frame
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
};

function text(result) {
  const out = [`Ask · the I Ching by word vectors · ${PUBLIC_URL}${BASE}`, ''];
  if (!result) {
    out.push('Ask a question:', `  curl ${PUBLIC_URL}${BASE} -d "should I move abroad"`, '', 'Or open a live prompt:', `  curl --no-progress-meter -NT. ${PUBLIC_URL}${BASE}`, '');
    return out.join('\n');
  }
  out.push(`Question: ${result.question}`, '', reading(result));
  return out.join('\n');
}

function reading(result) {
  const out = [];
  out.push(`      ${'hexagram'.padEnd(28)} ${'cosine similarity'.padEnd(26)} weight`);
  for (const r of result.reading) {
    out.push(`  ${r.glyph}  ${String(r.id).padStart(2)} ${r.name.padEnd(25)} ${bar(r.similarity)} ${sim(r.similarity)}  ${pct(r.weight).padStart(4)}   ${r.keywords.slice(0, 3).join(', ')}`);
  }
  out.push('');
  if (result.unknown.length) out.push(`Unknown words, given a random meaning: ${result.unknown.join(', ')}`);
  out.push('Cosine similarity between GloVe word vectors, not a consciousness. Interpret it how you like.', '');
  return out.join('\n');
}

// The live prompt: `curl --no-progress-meter -NT. <url>` sends stdin as a streaming PUT body; each line is a question.
function repl(req, res, model) {
  res.on('error', () => {});
  req.on('error', () => {});
  if (liveSessions >= MAX_SESSIONS) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60', ...HEADERS });
    return res.end('Ask is busy right now. Try again in a minute, or ask once:\n  curl ' + PUBLIC_URL + BASE + ' -d "your question"\n');
  }
  liveSessions++;
  let counted = true;
  const release = () => { if (counted) { counted = false; liveSessions--; } };
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', ...HEADERS });
  let buffer = '', asked = 0, done = false;
  const write = (s) => { if (!done) res.write(s); };
  const end = (msg) => { if (done) return; write(msg); done = true; clearTimeout(life); clearTimeout(idle); clearInterval(beat); res.end(); req.destroy(); };
  const life = setTimeout(() => end('\nSession over (15 minutes). Run the command again to keep asking.\n'), SESSION_MS);
  let idle = setTimeout(() => end('\nNo question for 3 minutes; goodbye.\n'), IDLE_MS);
  write(`${text(null).split('\n')[0]}\nType a question and press Enter. "exit" or Ctrl+C to leave.\n\nask> `);
  // Keep the connection alive while they think, with a byte sequence terminals don't display.
  const beat = setInterval(() => write(HEARTBEAT), HEARTBEAT_MS);
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    clearTimeout(idle);
    idle = setTimeout(() => end('\nNo question for 3 minutes; goodbye.\n'), IDLE_MS);
    buffer += chunk;
    if (buffer.length > 4 * MAX_Q && !buffer.includes('\n')) return end(`\nPlease keep questions under ${MAX_Q} characters.\n`);
    let nl;
    while (!done && (nl = buffer.indexOf('\n')) >= 0) {
      const line = clean(buffer.slice(0, nl)).trim();
      buffer = buffer.slice(nl + 1);
      if (/^(exit|quit|bye)$/i.test(line)) return end('Goodbye.\n');
      if (!line) { write('ask> '); continue; }
      if (line.length > MAX_Q) { write(`Please keep questions under ${MAX_Q} characters.\n\nask> `); continue; }
      const result = oracle.ask(model, line);
      write(result ? `\n${reading(result)}\nask> ` : 'Please ask with words.\n\nask> ');
      if (++asked >= MAX_QUESTIONS) return end(`\nThat's ${MAX_QUESTIONS} questions. Run the command again to keep asking.\n`);
    }
    if (buffer.length > 4 * MAX_Q) end(`\nPlease keep questions under ${MAX_Q} characters.\n`);
  });
  req.on('end', () => end('\n'));
  res.on('close', () => { done = true; clearTimeout(life); clearTimeout(idle); clearInterval(beat); release(); });
}

// A command you click to copy: the whole line is the button, and a copy icon appears on hover or
// keyboard focus. copy.js turns it on; without JavaScript, one click selects the whole command.
const COPY_ICON = '<svg class="i-copy" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>'
  + '<svg class="i-done" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const copyBlock = (cmd, label) => `<div class="copy" data-label="${esc(label)}"><span class="prompt" aria-hidden="true">$</span><code>${esc(cmd)}</code><span class="copy-hint" aria-hidden="true"><span class="copy-word">Copy</span>${COPY_ICON}</span><span class="copy-status" aria-live="polite"></span></div>`;

function page(result, q, error) {
  const reading = result ? `
<section class="reading" aria-label="Your reading">
  <p class="question">“${esc(result.question)}”</p>
  <div class="main">
    <span class="glyph" aria-hidden="true">${result.reading[0].glyph}</span>
    <div><p class="name">${result.reading[0].id} · ${esc(result.reading[0].name)}</p>
    <p class="muted">${esc(result.reading[0].keywords.join(', '))}</p>
    <p class="muted">${pct(result.reading[0].weight)} of the reading</p></div>
  </div>
  <table class="sims">
    <caption>Cosine similarity between your question and each hexagram (0 = unrelated, 1 = same direction)</caption>
    <thead><tr><th scope="col">Hexagram</th><th scope="col">Similarity</th><th scope="col" class="num">Weight</th></tr></thead>
    <tbody>${result.reading.map((r, i) => `<tr${i ? '' : ' class="top-row"'}><th scope="row"><span class="glyph-sm" aria-hidden="true">${r.glyph}</span> ${r.id} · ${esc(r.name)}<span class="muted small kw">${esc(r.keywords.slice(0, 3).join(', '))}</span></th><td><span class="simcell">${svgBar(r.similarity)}<span class="num">${sim(r.similarity)}</span></span></td><td class="num">${pct(r.weight)}</td></tr>`).join('')}</tbody>
  </table>
  ${result.unknown.length ? `<p class="muted small">Not in the vocabulary, so given a random meaning (ask again and it may change): ${esc(result.unknown.join(', '))}</p>` : ''}
</section>` : '';
  const title = 'Ask: the I Ching by word vectors';
  const description = 'Ask a question and get an I Ching reading chosen by the meaning of your words, using GloVe word vectors and cosine similarity. Works in the browser or with curl.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${result ? `${esc(result.reading[0].name)} · Ask` : title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${PUBLIC_URL}${BASE}">
${q ? '<meta name="robots" content="noindex">' : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="bigthought.ai">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${PUBLIC_URL}${BASE}">
<meta property="og:image" content="${PUBLIC_URL}/shell/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="${asset('style.css')}">
</head>
<body>
<header class="top"><a class="brand" href="${BASE}">☯ Ask</a><span class="crumb">the I Ching by word vectors</span></header>
<main class="wrap">
<h1>Ask the I Ching</h1>
<form method="get" action="${BASE}" role="search">
  <label for="q">Your question</label>
  <div class="row"><input id="q" name="q" maxlength="${MAX_Q}" value="${esc(q || '')}" placeholder="Should I move abroad?" autocomplete="off" required><button type="submit">Ask</button></div>
</form>
${error ? `<p class="error">${esc(error)}</p>` : ''}
${reading}
<section class="about">
<h2>How it works</h2>
<p>Each word of your question becomes a <a href="https://nlp.stanford.edu/projects/glove/" rel="noopener">GloVe</a> word vector, and those are averaged into one point in 300-dimensional space. Each of the 64 hexagrams is a point too, made from words that describe it. The reading is the six hexagrams closest to your question, by cosine similarity.</p>
<p>Words GloVe doesn't know get a random meaning, like the fall of yarrow sticks or the toss of coins. Read it as an oracle, or as a lesson in how easily chance passes for meaning. Your question isn't stored.</p>
<h2>From a terminal</h2>
<p>Open a live <code>ask&gt;</code> prompt:</p>
${copyBlock(`curl --no-progress-meter -NT. ${PUBLIC_URL}${BASE}`, 'Copy the live prompt command')}
<p>Or ask once:</p>
${copyBlock(`curl ${PUBLIC_URL}${BASE} -d "should I move abroad"`, 'Copy the ask-once command')}
<p class="muted small">Based on <a href="https://github.com/adicarlisle/AI-CHING" rel="noopener">AI-CHING</a>. Part of the <a href="/speak/ai-psychosis">AI psychosis</a> series on Speak.</p>
</section>
</main>
<script src="${asset('copy.js')}" defer></script>
</body>
</html>`;
}

function createServer(model = oracle.load()) {
  const send = (res, status, body, type, extra = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...HEADERS, ...extra });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    if (req.method === 'PUT' && p === BASE) return repl(req, res, model);
    // Ask once with the question as plain text: curl <url> -d "should I move abroad" (no + signs needed).
    if (req.method === 'POST' && p === BASE) return readBody(req, 4 * MAX_Q, (body) => {
      if (body === null) return send(res, 413, `Please keep your question under ${MAX_Q} characters.\n`, 'text/plain; charset=utf-8');
      const q = clean(/^q=/.test(body) ? new URLSearchParams(body).get('q') || '' : body).trim();
      answer(req, res, q, url.searchParams.get('format'));
    });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed\n', 'text/plain', { allow: 'GET, HEAD, POST, PUT' });
    if (p === '/health') return send(res, 200, '{"ok":true}', 'application/json');
    if (p.startsWith(`${BASE}/assets/`)) {
      const a = ASSETS[p.slice(BASE.length + 8)];
      if (!a) return send(res, 404, 'Not found\n', 'text/plain');
      const current = url.searchParams.get('v') === a.v;
      return send(res, 200, a.body, a.type, { 'cache-control': current ? 'public, max-age=31536000, immutable' : 'no-cache' });
    }
    if (p === `${BASE}/`) return send(res, 301, '', 'text/plain', { location: BASE + url.search });
    if (p !== BASE) return send(res, 404, 'Not found\n', 'text/plain');

    answer(req, res, clean(url.searchParams.get('q') || '').trim(), url.searchParams.get('format'));
  });
  // Node ends any request still uploading after 5 minutes by default; live prompts last up to 15
  // (they have their own idle and session limits above). Caddy's read_body_idle is raised to match.
  server.requestTimeout = SESSION_MS + 60 * 1000;

  function answer(req, res, q, fmt) {
    const asText = fmt === 'text' || (fmt !== 'html' && TERMINAL.test(req.headers['user-agent'] || ''));
    let result = null, error = '';
    if (q.length > MAX_Q) error = `Please keep your question under ${MAX_Q} characters.`;
    else if (q) {
      result = oracle.ask(model, q);
      if (!result) error = 'Please ask with words.';
    }
    const status = error ? 400 : 200;
    if (asText) return send(res, status, error ? `${error}\n` : text(result), 'text/plain; charset=utf-8');
    send(res, status, page(result, q, error), 'text/html; charset=utf-8', q ? {} : { 'cache-control': 'no-cache' });
  }
  return server;
}

function readBody(req, limit, done) {
  let body = '', over = false;
  const stop = () => { over = true; done(null); req.resume(); };
  const timer = setTimeout(() => { if (!over) { over = true; req.destroy(); } }, POST_MS);
  req.setEncoding('utf8');
  req.on('error', () => { over = true; clearTimeout(timer); });
  req.on('data', (c) => { if (over) return; body += c; if (body.length > limit) { clearTimeout(timer); stop(); } });
  req.on('end', () => { clearTimeout(timer); if (!over) done(body); });
}

if (require.main === module) {
  createServer().listen(PORT, () => console.log(`Ask on :${PORT}${BASE}`));
}
module.exports = { createServer, text, clean, MAX_SESSIONS, SESSION_MS, HEARTBEAT_MS, HEARTBEAT };
