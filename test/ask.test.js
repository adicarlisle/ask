'use strict';
const test = require('node:test');
const assert = require('node:assert');
const oracle = require('../oracle');
const { createServer, clean, SESSION_MS } = require('../server');

const model = oracle.load();
const seeded = (seed) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

test('data: 64 hexagrams in King Wen order and a compact vocabulary', () => {
  assert.equal(model.hexagrams.length, 64);
  model.hexagrams.forEach((h, i) => assert.equal(h.glyph.codePointAt(0), 0x4dc0 + i));
  assert.ok(model.size >= 20000, `vocabulary ${model.size}`);
});

test('words: lower case, punctuation trimmed', () => {
  assert.deepEqual(oracle.tokens('  Should I QUIT my job?! '), ['should', 'i', 'quit', 'my', 'job']);
  assert.equal(oracle.ask(model, '?!  ...'), null);
});

test('reading: six hexagrams, weights sum to 1, known words are repeatable', () => {
  const a = oracle.ask(model, 'the army needs discipline and leadership');
  assert.equal(a.reading.length, 6);
  assert.equal(a.reading[0].name, 'The Army');
  assert.ok(Math.abs(a.reading.reduce((s, r) => s + r.weight, 0) - 1) < 1e-9);
  assert.deepEqual(oracle.ask(model, 'the army needs discipline and leadership').reading.map((r) => r.id), a.reading.map((r) => r.id));
  assert.deepEqual(a.unknown, []);
});

test('unknown words get a random meaning, as in AI-CHING', () => {
  const q = 'zxqvbnm wqpfjk';
  const r1 = oracle.ask(model, q, seeded(1));
  const r2 = oracle.ask(model, q, seeded(99));
  assert.deepEqual(r1.unknown, ['zxqvbnm', 'wqpfjk']);
  assert.notDeepEqual(r1.reading.map((r) => r.id), r2.reading.map((r) => r.id));
});

test('server: page, terminal text, limits and headers', async () => {
  const server = createServer(model);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(`${base}/ask`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /<link rel="canonical" href="https:\/\/bigthought.ai\/ask">/);
    assert.doesNotMatch(html, /noindex/);
    assert.match(home.headers.get('content-security-policy'), /script-src 'self';/);
    assert.match(html, /<div class="copy" data-label="[^"]+"><span class="prompt" aria-hidden="true">\$<\/span><code>curl --no-progress-meter -NT\. https:\/\/bigthought.ai\/ask<\/code><span class="copy-hint" aria-hidden="true">/);
    assert.doesNotMatch(html, /<script(?! src="\/ask\/assets\/copy\.js\?v=[0-9a-f]{10}" defer>)/, 'only our own script');
    const css = html.match(/href="(\/ask\/assets\/style\.css\?v=[0-9a-f]{10})"/)[1];
    const cssRes = await fetch(base + css);
    assert.match(cssRes.headers.get('cache-control'), /immutable/, 'versioned files are cached for good');
    assert.equal((await fetch(`${base}/ask/assets/style.css?v=old`)).headers.get('cache-control'), 'no-cache', 'an old version is never cached');
    assert.match(html, /<svg class="i-copy" width="17" height="17"/, 'icons have a size even without the stylesheet');

    const asked = await (await fetch(`${base}/ask?q=${encodeURIComponent('<b>army</b> discipline')}`)).text();
    assert.match(asked, /&lt;b&gt;army&lt;\/b&gt; discipline/);
    assert.doesNotMatch(asked, /<b>army<\/b>/);
    assert.match(asked, /noindex/);

    const curl = await fetch(`${base}/ask?q=army+discipline`, { headers: { 'user-agent': 'curl/8.5.0' } });
    assert.match(curl.headers.get('content-type'), /text\/plain/);
    const t = await curl.text();
    assert.match(t, /Question: army discipline\n\n +hexagram +cosine similarity +weight\n  ䷆ +7 The Army +█+[▏▎▍▌▋▊▉]? +0\.\d\d +\d+%/);
    assert.match(asked, /<rect class="fill" width="\d+(\.\d)?" height="8"/, 'web bars are SVG, no inline styles');
    assert.doesNotMatch(asked, /style="/);
    assert.match(await (await fetch(`${base}/ask?format=text`)).text(), /curl https:\/\/bigthought.ai\/ask -d "should I move abroad"/);

    assert.equal((await fetch(`${base}/ask?q=${'a'.repeat(301)}`)).status, 400);
    // ask once with a plain-text body, as `curl <url> -d "..."` sends it (no + signs)
    const posted = await fetch(`${base}/ask`, { method: 'POST', headers: { 'user-agent': 'curl/8.5.0', 'content-type': 'application/x-www-form-urlencoded' }, body: 'the army needs discipline' });
    assert.match(await posted.text(), /Question: the army needs discipline\n[^]*䷆ +7 The Army/);
    assert.match(await (await fetch(`${base}/ask?format=text`, { method: 'POST', body: 'q=army+discipline' })).text(), /Question: army discipline/);
    assert.equal((await fetch(`${base}/ask`, { method: 'POST', body: 'x'.repeat(2000) })).status, 413);
    assert.equal((await fetch(`${base}/ask`, { method: 'DELETE' })).status, 405);

    // live prompt: questions streamed in a PUT body, answers streamed back
    const live = await fetch(`${base}/ask`, { method: 'PUT', body: 'army discipline\n\nzzqxv\n' + 'x'.repeat(301) + '\nexit\nnot reached\n' });
    const out = await live.text();
    assert.match(out, /^Ask · the I Ching by word vectors/);
    assert.match(out, /ask> \n +hexagram[^]*䷆ +7 The Army[^]*ask> ask> \n/);
    assert.match(out, /Unknown words, given a random meaning: zzqxv/);
    assert.match(out, /Please keep questions under 300 characters\./);
    assert.match(out, /Goodbye\.\n$/);
    assert.doesNotMatch(out, /not reached/);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
});

test('hardening: control characters stripped, live prompts outlive the default request timeout', async () => {
  assert.equal(clean('war\u001b]0;pwned\u0007 \u001b[31mred'), 'war]0;pwned [31mred');
  const server = createServer(model);
  assert.ok(server.requestTimeout > SESSION_MS, 'Node would otherwise cut live prompts off at 5 minutes');
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const t = await (await fetch(`${base}/ask`, { method: 'POST', headers: { 'user-agent': 'curl/8' }, body: 'army\u001b[2J discipline' })).text();
    assert.doesNotMatch(t, /\u001b/);
    const ps = await fetch(`${base}/ask?q=army`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) WindowsPowerShell/5.1' } });
    assert.match(ps.headers.get('content-type'), /text\/plain/);
  } finally {
    server.close();
  }
});

test('live prompt heartbeat is text, never a NUL byte (curl refuses binary output to a terminal)', async () => {
  const { HEARTBEAT } = require('../server');
  assert.ok(!HEARTBEAT.includes('\u0000'));
  const src = require('fs').readFileSync(require.resolve('../server'), 'utf8');
  assert.doesNotMatch(src.replace(/clean = .*$/m, ''), /write\(['"]\\u0000/);
});
