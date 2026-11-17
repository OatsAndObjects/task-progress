'use strict';
// node --test web/server.perm.test.js : perm.answer validator and GET /api/clients.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TOKEN = '0123456789abcdef0123456789abcdef';
const H = { 'X-TP-Token': TOKEN, 'Content-Type': 'application/json' };

test('perm.answer validation and page count', async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', '7431', '--token', TOKEN], { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  let ready;
  const got = new Promise((r) => (ready = r));
  proc.stdout.on('data', (d) => {
    buf += String(d);
    for (const l of buf.split('\n')) try { if (JSON.parse(l).type === 'ready') ready(JSON.parse(l).port); } catch {}
  });
  const base = `http://127.0.0.1:${await got}`;
  const cmd = (body) => fetch(base + '/api/command', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const clients = async () => (await (await fetch(base + '/api/clients', { headers: H })).json()).pages;
  try {
    assert.equal((await fetch(base + '/api/clients')).status, 401);
    assert.equal(await clients(), 0);
    for (const bad of [{}, { id: 'a b', decision: 'allow' }, { id: 'x'.repeat(65), decision: 'allow' }, { id: 'p1', decision: 'maybe' }, { id: 'p1' }, { id: 5, decision: 'deny' }]) {
      assert.equal((await cmd({ action: 'perm.answer', ...bad })).status, 400, JSON.stringify(bad));
    }
    const ac = new AbortController();
    const r = await fetch(`${base}/api/stream?t=${TOKEN}`, { signal: ac.signal });
    assert.equal(r.status, 200);
    assert.equal(await clients(), 1);
    ac.abort();
  } finally {
    proc.kill();
  }
});
