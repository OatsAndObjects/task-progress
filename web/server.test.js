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

test('session.prompt validates text (max 20000); session.stop takes nothing', async () => {
  const s = await start(7415);
  try {
    assert.equal((await post(s, '/api/command', { action: 'session.prompt' })).status, 400);
    assert.equal((await post(s, '/api/command', { action: 'session.prompt', text: '   ' })).status, 400);
    assert.equal((await post(s, '/api/command', { action: 'session.prompt', text: 'x'.repeat(20001) })).status, 400);
    const pending = post(s, '/api/command', { action: 'session.prompt', text: 'hello' });
    await new Promise((r) => setTimeout(r, 300));
    const cmd = s.lines.map((l) => JSON.parse(l)).find((o) => o.type === 'command' && o.action === 'session.prompt');
    assert.deepEqual(cmd.args, { text: 'hello' });
    await post(s, '/api/result', { id: cmd.id, ok: true, message: 'sent', data: { state: 'queued' } });
    const reply = await (await pending).json();
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.data, { state: 'queued' });
    const stop = post(s, '/api/command', { action: 'session.stop' });
    await new Promise((r) => setTimeout(r, 300));
    const sc = s.lines.map((l) => JSON.parse(l)).find((o) => o.type === 'command' && o.action === 'session.stop');
    assert.ok(sc);
    await post(s, '/api/result', { id: sc.id, ok: false, message: 'Nothing is running' });
    assert.equal((await (await stop).json()).ok, false);
  } finally {
    s.proc.kill();
  }
});

test('an event over 64 KB is rejected; oversize array items are dropped and counted', async () => {
  const s = await start(7430);
  try {
    const big = { type: 'x', text: 'a'.repeat(70 * 1024) };
    const r1 = await post(s, '/api/events', big);
    assert.equal(r1.status, 400);
    const r2 = await post(s, '/api/events', [{ type: 'ok' }, big, { type: 'ok2' }]);
    assert.equal(r2.status, 200);
    const j = await r2.json();
    assert.equal(j.dropped, 1);
    const st = await readStream(s, `t=${TOKEN}`, (t) => seqs(t).length >= 2);
    assert.deepEqual(seqs(st.text), [1, 2]);
  } finally {
    s.proc.kill();
  }
});

test('ring is capped at about 32 MB: oldest events are evicted', async () => {
  const s = await start(7431);
  try {
    const ev = { type: 'x', text: 'a'.repeat(60 * 1024) };
    for (let i = 0; i < 60; i++) assert.equal((await post(s, '/api/events', Array(10).fill(ev))).status, 200); // 600 x 60 KB = 36 MB
    const st = await readStream(s, `t=${TOKEN}`, (t) => /id: 600\n/.test(t));
    const ids = seqs(st.text);
    assert.equal(ids[ids.length - 1], 600);
    assert.ok(ids[0] > 1, 'oldest events dropped, first seq ' + ids[0]);
    assert.ok(ids.length < 600 && ids.length > 400);
  } finally {
    s.proc.kill();
  }
});

test('a stream client that stops reading is dropped once its backlog passes 2 MB', async () => {
  const http = require('node:http');
  const s = await start(7432);
  try {
    let bytes = 0;
    let resp;
    const closed = new Promise((resolve) => {
      const rq = http.get(`${s.base}/api/stream?t=${TOKEN}`, (res) => {
        resp = res;
        res.pause(); // not reading yet
        res.on('data', (c) => (bytes += c.length));
        res.on('close', () => resolve(true));
      });
      rq.on('error', () => resolve(true));
    });
    await new Promise((r) => setTimeout(r, 300));
    const ev = { type: 'x', text: 'a'.repeat(60 * 1024) };
    for (let i = 0; i < 60; i++) await post(s, '/api/events', Array(10).fill(ev)); // 36 MB offered
    resp.resume();
    assert.equal(await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 5000))]), true);
    assert.ok(bytes < 30 * 1024 * 1024, 'client was cut off early, got ' + bytes);
  } finally {
    s.proc.kill();
  }
});
