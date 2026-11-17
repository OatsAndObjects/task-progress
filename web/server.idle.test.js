'use strict';
// Idle rule: heartbeats (snapshot POSTs) keep the server up with no tab open; it exits when they stop.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TOKEN = '0123456789abcdef0123456789abcdef';
const SERVER = path.join(__dirname, 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('server stays up on heartbeats with no tab, exits when they stop', async () => {
  const proc = spawn(process.execPath, [SERVER, '--port', '0', '--token', TOKEN, '--idle-ms', '700'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let exited = false;
  proc.on('exit', () => (exited = true));
  const port = await new Promise((resolve) => {
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += String(d);
      for (const l of buf.split('\n')) {
        try {
          const o = JSON.parse(l);
          if (o.type === 'ready') resolve(o.port);
        } catch {}
      }
    });
  });
  const beat = () => fetch(`http://127.0.0.1:${port}/api/snapshot`, { method: 'POST', headers: { 'X-TP-Token': TOKEN, 'Content-Type': 'application/json' }, body: '{}' });
  for (let i = 0; i < 5; i++) {
    await beat();
    await sleep(300);
  }
  assert.equal(exited, false, 'alive on heartbeats, no tab');
  await sleep(1500);
  assert.equal(exited, true, 'exits once heartbeats stop');
});
