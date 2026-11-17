'use strict';
// node --test web/server.tickets.test.js : ticket.* validators on POST /api/command.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TOKEN = '0123456789abcdef0123456789abcdef';
const H = { 'X-TP-Token': TOKEN, 'Content-Type': 'application/json' };

test('ticket.* validation', async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', '7441', '--token', TOKEN], { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  let ready;
  const got = new Promise((r) => (ready = r));
  proc.stdout.on('data', (d) => {
    buf += String(d);
    for (const l of buf.split('\n')) try { if (JSON.parse(l).type === 'ready') ready(JSON.parse(l).port); } catch {}
  });
  const base = `http://127.0.0.1:${await got}`;
  const status = async (body) => { try { return (await fetch(base + '/api/command', { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(500) })).status; } catch (e) { return 'pending'; } };
  const good = { type: 'bug', priority: 'high', title: 'T' };
  try {
    const bad = [
      { action: 'ticket.create', ...good, title: '' },
      { action: 'ticket.create', ...good, title: 'x'.repeat(201) },
      { action: 'ticket.create', ...good, type: 'epic' },
      { action: 'ticket.create', ...good, priority: 'urgent' },
      { action: 'ticket.create', ...good, description: 'x'.repeat(10001) },
      { action: 'ticket.create', ...good, checks: Array(51).fill('a') },
      { action: 'ticket.create', ...good, checks: ['x'.repeat(301)] },
      { action: 'ticket.move', key: 'TP-1', status: 'weird' },
      { action: 'ticket.move', key: 'bad key!', status: 'done' },
      { action: 'ticket.check', key: 'TP-1', index: -1, done: true },
      { action: 'ticket.check', key: 'TP-1', index: 0, done: 'yes' },
      { action: 'ticket.comment', key: 'TP-1', text: 'x'.repeat(4001) },
      { action: 'ticket.comment', key: 'TP-1', text: '  ' },
      { action: 'ticket.update', key: 'TP-1' },
      { action: 'ticket.delete' },
    ];
    for (const b of bad) assert.equal(await status(b), 400, JSON.stringify(b).slice(0, 80));
    const okBodies = [
      { action: 'ticket.create', ...good, description: 'd', checks: ['a'], assignee: 'claude' },
      { action: 'ticket.move', key: 'TP-1', status: 'review' },
      { action: 'ticket.check', key: 'TP-1', index: 0, done: true },
      { action: 'ticket.comment', key: 'TP-1', text: 'hi' },
      { action: 'ticket.assign', key: 'TP-1', assignee: '' },
      { action: 'ticket.update', key: 'TP-1', title: 'n' },
      { action: 'ticket.delete', key: 't1abc' },
    ];
    // Valid payloads pass validation; with no mod attached the server answers 503/200, never 400.
    for (const b of okBodies) assert.notEqual(await status(b), 400, JSON.stringify(b).slice(0, 80));
  } finally {
    proc.kill();
  }
});
