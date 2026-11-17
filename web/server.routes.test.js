'use strict';
// Static routes: v2 at /, v1 at /v1, traversal refused, API still token-gated.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const TOKEN = '0123456789abcdef0123456789abcdef';
const SERVER = path.join(__dirname, 'server.js');
let proc;
let port;

// Raw request so the path is sent exactly as written (fetch would normalize dot segments).
function raw(p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  proc = spawn(process.execPath, [SERVER, '--port', '0', '--token', TOKEN, '--idle-ms', '60000'], { stdio: ['ignore', 'pipe', 'ignore'] });
  port = await new Promise((resolve) => {
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
});
after(() => proc && proc.kill());

test('GET / serves the v2 index', async () => {
  const r = await raw('/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.body, /<script src="core\.js">/);
});

test('v2 root assets are served with right types', async () => {
  const js = await raw('/core.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
  const css = await raw('/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  const idx = (await raw('/')).body;
  for (const m of idx.matchAll(/(?:src|href)="([\w.-]+\.(?:js|css))"/g)) {
    assert.equal((await raw('/' + m[1])).status, 200, m[1]);
  }
});

test('/v2/ still works and /v2 redirects', async () => {
  const r = await raw('/v2/');
  assert.equal(r.status, 200);
  assert.match(r.body, /<script src="core\.js">/);
  assert.equal((await raw('/v2/core.js')).status, 200);
  assert.equal((await raw('/v2')).status, 302);
});

test('/v1 and /v1/ serve the v1 page (self-contained, no relative assets)', async () => {
  for (const p of ['/v1', '/v1/']) {
    const r = await raw(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.notEqual(r.body, (await raw('/')).body);
    assert.doesNotMatch(r.body, /<script[^>]+src="(?!https?:)/);
    assert.doesNotMatch(r.body, /<link[^>]+href="(?!https?:)/);
  }
});

test('path traversal and non-allowlisted files are refused', async () => {
  const bad = [
    '/..%2f..%2fserver.js',
    '/%2e%2e/%2e%2e/hooks/dashboard.tsx',
    '/..\server.js',
    '/app/../server.js',
    '/web/server.js',
    '/v2/..%2fserver.js',
    '/v2/../server.js',
    '/v2/%2e%2e/%2e%2e/hooks/dashboard.tsx',
    '/server.js',
    '/README.md',
    '/v2/README.md',
    '/server.test.js',
    '/package.json',
    '/%00.js',
  ];
  for (const p of bad) {
    const r = await raw(p);
    assert.ok(r.status === 404 || r.status === 400 || r.status === 403, `${p} -> ${r.status}`);
    assert.doesNotMatch(r.body, /createServer|http\.createServer|require\(/, p);
  }
});

test('API routes still require the token', async () => {
  for (const p of ['/api/snapshot', '/api/stream', '/api/events']) {
    const r = await raw(p);
    assert.ok(r.status === 401 || r.status === 403 || r.status === 404 || r.status === 405, `${p} -> ${r.status}`);
  }
  const ok = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { method: 'POST', headers: { 'X-TP-Token': TOKEN, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(ok.status, 200);
  const no = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(no.status, 401);
});
