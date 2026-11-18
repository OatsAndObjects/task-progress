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

test('token required on GET /api/stream; a stream replays the latest snapshot', async () => {
  const s = await start(7411);
  try {
    assert.equal((await fetch(`${s.base}/api/stream`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/stream?t=wrong`)).status, 401);
    await post(s, '/api/snapshot', { hello: 'snap' });
    const a = await readStream(s, `t=${TOKEN}`, (t) => /event: snapshot/.test(t));
    assert.match(a.text, /event: snapshot/);
    assert.equal((await post(s, '/api/events', { type: 'x' })).status, 404);
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
    for (let i = 0; i < 30; i++) await post(s, '/api/snapshot', { text: 'a'.repeat(900 * 1024) }); // 27 MB offered
    resp.resume();
    assert.equal(await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 5000))]), true);
    assert.ok(bytes < 30 * 1024 * 1024, 'client was cut off early, got ' + bytes);
  } finally {
    s.proc.kill();
  }
});

test('cube.approveAll goes through /api/command to stdout, with or without args, and the result returns', async () => {
  const s = await start(7461);
  try {
    for (const body of [{ action: 'cube.approveAll' }, { action: 'cube.approveAll', args: {} }]) {
      const before = s.lines.length;
      const pending = post(s, '/api/command', body);
      await new Promise((r) => setTimeout(r, 300));
      const cmd = s.lines.slice(before).map((l) => JSON.parse(l)).find((o) => o.type === 'command');
      assert.equal(cmd.action, 'cube.approveAll');
      assert.deepEqual(cmd.args, {});
      await post(s, '/api/result', { id: cmd.id, ok: true, message: 'sent' });
      const res = await pending;
      assert.equal(res.status, 200);
      assert.equal((await res.json()).ok, true);
    }
    assert.equal((await post(s, '/api/command', { action: 'cube.approveAll' }, { 'Content-Type': 'application/json' })).status, 401);
  } finally {
    s.proc.kill();
  }
});
