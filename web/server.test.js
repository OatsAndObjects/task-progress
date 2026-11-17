'use strict';
// Server tests: node --test web/server.test.js   (plain Node >= 18, no dependencies).
// Not run by `claude plugin test` (hooks modules cannot import node:child_process).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TOKEN = '0123456789abcdef0123456789abcdef';
const SERVER = path.join(__dirname, 'server.js');

async function start(port) {
  const proc = spawn(process.execPath, [SERVER, '--port', String(port), '--token', TOKEN], { stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = [];
  let ready;
  const got = new Promise((r) => (ready = r));
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(l);
      try {
        const o = JSON.parse(l);
        if (o.type === 'ready') ready(o.port);
      } catch {}
    }
  });
  const p = await got;
  return { proc, base: `http://127.0.0.1:${p}`, lines };
}

const H = { 'X-TP-Token': TOKEN, 'Content-Type': 'application/json' };
const post = (s, p, body, headers = H) => fetch(s.base + p, { method: 'POST', headers, body: JSON.stringify(body) });

// Read the SSE stream until until(text) is true (or 3 s), then abort.
async function readStream(s, qs, until, headers = {}) {
  const ac = new AbortController();
  const r = await fetch(`${s.base}/api/stream?${qs}`, { signal: ac.signal, headers });
  let text = '';
  if (r.status === 200) {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    const timer = setTimeout(() => ac.abort(), 3000);
    try {
      while (!until(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
    } catch {}
    clearTimeout(timer);
    ac.abort();
  }
  return { status: r.status, text };
}
const seqs = (t) => [...t.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));

test('token required on POST /api/events and GET /api/stream', async () => {
  const s = await start(7411);
  try {
    assert.equal((await post(s, '/api/events', { type: 'x' }, { 'Content-Type': 'application/json' })).status, 401);
    assert.equal((await fetch(`${s.base}/api/stream`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/stream?t=wrong`)).status, 401);
    assert.equal((await post(s, '/api/events', 'nope')).status, 400);
    assert.equal((await post(s, '/api/events', [1])).status, 400);
  } finally {
    s.proc.kill();
  }
});

test('ring buffer keeps the newest 2000 events; seq keeps counting', async () => {
  const s = await start(7412);
  try {
    const batch = Array.from({ length: 2001 }, (_, i) => ({ type: 'n', i }));
    // 500 per request is the batch cap
    for (let i = 0; i < batch.length; i += 500) assert.equal((await post(s, '/api/events', batch.slice(i, i + 500))).status, 200);
    const all = await readStream(s, `t=${TOKEN}`, (t) => seqs(t).length >= 2000);
    const ids = seqs(all.text);
    assert.equal(ids.length, 2000);
    assert.equal(ids[0], 2); // event 1 dropped
    assert.equal(ids[ids.length - 1], 2001);
  } finally {
    s.proc.kill();
  }
});

test('stream replays after ?since / Last-Event-ID, pushes live events and snapshots', async () => {
  const s = await start(7413);
  try {
    for (let i = 0; i < 5; i++) await post(s, '/api/events', { type: 'e', i });
    await post(s, '/api/snapshot', { hello: 'snap' });
    const a = await readStream(s, `t=${TOKEN}&since=3`, (t) => seqs(t).length >= 2);
    assert.deepEqual(seqs(a.text), [4, 5]);
    assert.match(a.text, /event: snapshot/);
    const b = await readStream(s, `t=${TOKEN}`, (t) => seqs(t).length >= 1, { 'Last-Event-ID': '4' });
    assert.deepEqual(seqs(b.text), [5]);
    // a seq from a previous server run (higher than anything here) replays everything
    const c = await readStream(s, `t=${TOKEN}&since=999`, (t) => seqs(t).length >= 5);
    assert.deepEqual(seqs(c.text), [1, 2, 3, 4, 5]);
    const live = readStream(s, `t=${TOKEN}&since=5`, (t) => seqs(t).length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    await post(s, '/api/events', { type: 'live' });
    const l = await live;
    assert.deepEqual(seqs(l.text), [6]);
    assert.match(l.text, /"type":"live"/);
  } finally {
    s.proc.kill();
  }
});

test('COMMANDS table rejects unknown actions and keeps existing validation', async () => {
  const s = await start(7414);
  try {
    const bad = await post(s, '/api/command', { action: 'nope.nothing' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).message, 'unknown action');
    assert.equal((await post(s, '/api/command', { action: 'constructor' })).status, 400);
    assert.equal((await post(s, '/api/command', { action: 'cube.approve' })).status, 400);
    assert.equal((await post(s, '/api/command', { action: 'orchestrate.set', on: 'yes' })).status, 400);
    const pending = post(s, '/api/command', { action: 'cube.approve', id: ' c1 ' });
    await new Promise((r) => setTimeout(r, 300));
    const cmd = s.lines.map((l) => JSON.parse(l)).find((o) => o.type === 'command');
    assert.equal(cmd.action, 'cube.approve');
    assert.deepEqual(cmd.args, { id: 'c1' });
    await post(s, '/api/result', { id: cmd.id, ok: true, message: 'done' });
    assert.equal((await (await pending).json()).ok, true);
  } finally {
    s.proc.kill();
  }
});
