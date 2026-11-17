'use strict';
// node --test web/server.files.test.js : file.* validators + result data pass-through.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TOKEN = '0123456789abcdef0123456789abcdef';
const H = { 'X-TP-Token': TOKEN, 'Content-Type': 'application/json' };

test('file.* validators and result data pass-through', async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', '7430', '--token', TOKEN], { stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = [];
  let buf = '';
  let ready;
  const got = new Promise((r) => (ready = r));
  proc.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(l);
      try { if (JSON.parse(l).type === 'ready') ready(JSON.parse(l).port); } catch {}
    }
  });
  const base = `http://127.0.0.1:${await got}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/command', { action: 'file.read' })).status, 400);
    assert.equal((await post('/api/command', { action: 'file.read', path: 'x'.repeat(1025) })).status, 400);
    assert.equal((await post('/api/command', { action: 'file.diff', path: 5 })).status, 400);
    assert.equal((await post('/api/command', { action: 'file.open', path: 'a.js', editor: 'vim' })).status, 400);
    assert.equal((await post('/api/command', { action: 'file.open', path: 'a.js', editor: 'vscode', line: 0 })).status, 400);
    assert.equal((await post('/api/command', { action: 'file.open', path: 'a.js', editor: 'vscode', line: 1.5 })).status, 400);
    const pending = post('/api/command', { action: 'file.open', path: 'src\\a.js', editor: 'studio', line: 7, junk: 1 });
    await new Promise((r) => setTimeout(r, 300));
    const cmd = lines.map((l) => JSON.parse(l)).find((o) => o.type === 'command' && o.action === 'file.open');
    assert.deepEqual(cmd.args, { path: 'src\\a.js', editor: 'studio', line: 7 });
    await post('/api/result', { id: cmd.id, ok: true, message: 'ok', data: { content: 'hi' } });
    assert.deepEqual(await (await pending).json(), { ok: true, message: 'ok', data: { content: 'hi' } });
  } finally {
    proc.kill();
  }
});
