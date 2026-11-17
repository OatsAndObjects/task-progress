#!/usr/bin/env node
'use strict';
// Session dashboard server for the task-progress mod.
// Plain Node >= 18, no npm dependencies.
//
// stdout carries ONLY JSON lines for the parent (the mod):
//   {"type":"ready","port":N}
//   {"type":"command","id":"...","action":"...",...args}
//   {"type":"error","message":"..."}            (only when it cannot start)
// Everything else is logged to stderr.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- args ----------
function parseArgs(argv) {
  const out = { port: 7377, token: '', idleMs: 35000, startMs: 60000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(0, eq) : a;
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]);
    if (key === '--port') out.port = parseInt(val(), 10);
    else if (key === '--token') out.token = String(val() || '');
    // Hidden, for tests: shorten the idle exits.
    else if (key === '--idle-ms') out.idleMs = parseInt(val(), 10);
    else if (key === '--start-ms') out.startMs = parseInt(val(), 10);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const FIRST_PORT = Number.isInteger(args.port) && args.port > 0 && args.port < 65536 ? args.port : 7377;
const LAST_PORT = FIRST_PORT === 7377 ? 7397 : Math.min(FIRST_PORT + 20, 65535);
const TOKEN = args.token;
const MAX_BODY = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10000;
const HEARTBEAT_MS = 15000;
const INDEX_PATH = path.join(__dirname, 'index.html');
const APP_DIR = path.resolve(__dirname, 'app');
const APP_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
// The mod re-POSTs a snapshot every 10 s. No snapshot for IDLE_MS after the first one,
// or none at all within START_MS of start => the mod is gone, so exit.
const IDLE_MS = Number.isInteger(args.idleMs) && args.idleMs > 0 ? args.idleMs : 35000;
const START_MS = Number.isInteger(args.startMs) && args.startMs > 0 ? args.startMs : 60000;

function log(...parts) {
  process.stderr.write('[tp-web] ' + parts.join(' ') + '\n');
}

function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (e) {
    log('stdout write failed:', e.message);
    shutdown(1);
  }
}

if (!TOKEN || TOKEN.length < 4) {
  emit({ type: 'error', message: 'missing or too short --token' });
  process.exit(2);
}
const TOKEN_BUF = Buffer.from(TOKEN, 'utf8');

// ---------- state ----------
let latestSnapshot = null; // JSON string
const sseClients = new Set();
const pending = new Map(); // id -> { res, timer }
let boundPort = 0;

// ---------- helpers ----------
function tokenOk(given) {
  if (typeof given !== 'string' || !given) return false;
  const b = Buffer.from(given, 'utf8');
  if (b.length !== TOKEN_BUF.length) return false;
  return crypto.timingSafeEqual(b, TOKEN_BUF);
}

function hostOk(host) {
  if (!host || !boundPort) return false;
  const h = String(host).toLowerCase();
  return h === `127.0.0.1:${boundPort}` || h === `localhost:${boundPort}`;
}

function originOk(origin) {
  // Browsers send Origin on POST and on cross-origin requests. Absent = non-browser client (the mod, curl).
  if (!origin) return true;
  const o = String(origin).toLowerCase();
  return o === `http://127.0.0.1:${boundPort}` || o === `http://localhost:${boundPort}`;
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

function send(res, status, body, type) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': type || 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > MAX_BODY) {
      reject(Object.assign(new Error('body too large'), { status: 413 }));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return reject(Object.assign(new Error('empty body'), { status: 400 }));
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', (e) => {
      if (!failed) reject(Object.assign(e, { status: 400 }));
    });
  });
}

// ---------- command validation ----------
const STEP_STATUS = ['pending', 'running', 'done', 'skipped', 'over'];
const TASK_STATUS = ['todo', 'doing', 'blocked', 'done'];
const PRIORITY = ['low', 'med', 'high'];

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isText = (v, max) => isStr(v, max) && v.trim().length > 0;

// Cube board fields. Strings are trimmed; arrays hold strings only.
const isCubeId = (v) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 40;
function strList(v, name, minItems, maxItems, maxLen, check) {
  if (!Array.isArray(v)) return { error: name + ' must be a list of strings' };
  if (v.length < minItems || v.length > maxItems) return { error: `${name} needs ${minItems}-${maxItems} items` };
  const out = [];
  for (const s of v) {
    if (typeof s !== 'string' || !s.trim() || s.trim().length > maxLen) {
      return { error: `each ${name} item must be non-empty text (max ${maxLen} chars)` };
    }
    if (check && !check(s.trim())) return { error: `bad ${name} item` };
    out.push(s.trim());
  }
  return { value: out };
}
function text(name, max) {
  return (v) => (isText(v, max) ? { value: v.trim() } : { error: `${name} must be non-empty text (max ${max} chars)` });
}
// Flow: 2-6 steps {file, fn, does, calls?}; every text is non-empty and capped.
function flowSteps(v) {
  if (!Array.isArray(v) || v.length < 2 || v.length > 6) return { error: 'flow must be 2-6 steps' };
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const f = v[i];
    if (!f || typeof f !== 'object' || Array.isArray(f)) return { error: `flow[${i}] must be an object {file, fn, does}` };
    const step = {};
    for (const [k, max] of [['file', 200], ['fn', 120], ['does', 200]]) {
      if (!isText(f[k], max)) return { error: `flow[${i}].${k} must be non-empty text (max ${max} chars)` };
      step[k] = f[k].trim();
    }
    if (f.calls !== undefined && f.calls !== null && f.calls !== '') {
      if (!isStr(f.calls, 240)) return { error: `flow[${i}].calls must be text (max 240 chars)` };
      if (f.calls.trim()) step.calls = f.calls.trim();
    }
    out.push(step);
  }
  return { value: out };
}
const CUBE_CHECK = {
  title: text('title', 300),
  actionText: text('actionText', 2000),
  doneWhen: text('doneWhen', 1000),
  flow: flowSteps,
  after: (v) => {
    const r = strList(v, 'after', 0, 50, 40);
    return r.error ? r : { value: [...new Set(r.value)] };
  },
  files: (v) => strList(v, 'files', 0, 50, 500),
  minutes: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 10 ? { value: v } : { error: 'minutes must be a number from 1 to 10' }),
};
const CUBE_FIELDS = Object.keys(CUBE_CHECK);

// Each validator returns { args } with only whitelisted keys, or { error }.
const ACTIONS = {
  'agent.stop': (a) => (isId(a.id) ? { args: { id: a.id } } : { error: 'id required' }),
  'shell.stop': (a) => (isId(a.id) ? { args: { id: a.id } } : { error: 'id required' }),
  'step.set': (a) => {
    const kOk = (Number.isInteger(a.k) && a.k >= 0) || isId(a.k);
    if (!kOk) return { error: 'k required' };
    if (!STEP_STATUS.includes(a.status)) return { error: 'status must be one of ' + STEP_STATUS.join(', ') };
    return { args: { k: a.k, status: a.status } };
  },
  'items.clearFinished': () => ({ args: {} }),
  'task.add': (a) => {
    if (!isText(a.title, 500)) return { error: 'title required (max 500 chars)' };
    const out = { title: a.title.trim() };
    if (a.notes !== undefined && a.notes !== null && a.notes !== '') {
      if (!isStr(a.notes, 10000)) return { error: 'notes must be text (max 10000 chars)' };
      out.notes = a.notes;
    }
    if (a.priority !== undefined && a.priority !== null) {
      if (!PRIORITY.includes(a.priority)) return { error: 'priority must be one of ' + PRIORITY.join(', ') };
      out.priority = a.priority;
    }
    return { args: out };
  },
  'task.update': (a) => {
    if (!isId(a.id)) return { error: 'id required' };
    const allowed = ['title', 'notes', 'status', 'priority'];
    const unknown = Object.keys(a).filter((k) => k !== 'id' && !allowed.includes(k));
    if (unknown.length) return { error: 'unknown field(s): ' + unknown.join(', ') };
    const out = { id: a.id };
    if (a.title !== undefined) {
      if (!isText(a.title, 500)) return { error: 'title must be non-empty (max 500 chars)' };
      out.title = a.title.trim();
    }
    if (a.notes !== undefined) {
      if (!isStr(a.notes, 10000)) return { error: 'notes must be text (max 10000 chars)' };
      out.notes = a.notes;
    }
    if (a.status !== undefined) {
      if (!TASK_STATUS.includes(a.status)) return { error: 'status must be one of ' + TASK_STATUS.join(', ') };
      out.status = a.status;
    }
    if (a.priority !== undefined) {
      if (!PRIORITY.includes(a.priority)) return { error: 'priority must be one of ' + PRIORITY.join(', ') };
      out.priority = a.priority;
    }
    if (Object.keys(out).length === 1) return { error: 'nothing to update' };
    return { args: out };
  },
  'task.delete': (a) => (isId(a.id) ? { args: { id: a.id } } : { error: 'id required' }),
  'task.send': (a) => (isId(a.id) ? { args: { id: a.id } } : { error: 'id required' }),
  'prompt.send': (a) => (isText(a.text, 20000) ? { args: { text: a.text } } : { error: 'text required (max 20000 chars)' }),
  'orchestrate.set': (a) => (typeof a.on === 'boolean' ? { args: { on: a.on } } : { error: 'on must be true or false' }),

  // ---- cube flow board ----
  'cube.approve': (a) => (isCubeId(a.id) ? { args: { id: a.id.trim() } } : { error: 'id required (max 40 chars)' }),
  'cube.approveAll': () => ({ args: {} }),
  'cube.reject': (a) => {
    if (!isCubeId(a.id)) return { error: 'id required (max 40 chars)' };
    const out = { id: a.id.trim() };
    if (a.note !== undefined && a.note !== null && a.note !== '') {
      if (!isStr(a.note, 2000)) return { error: 'note must be text (max 2000 chars)' };
      if (a.note.trim()) out.note = a.note.trim();
    }
    return { args: out };
  },
  'cube.update': (a) => {
    if (!isCubeId(a.id)) return { error: 'id required (max 40 chars)' };
    const unknown = Object.keys(a).filter((k) => k !== 'id' && !CUBE_FIELDS.includes(k));
    if (unknown.length) return { error: 'unknown field(s): ' + unknown.join(', ') };
    const out = { id: a.id.trim() };
    for (const k of CUBE_FIELDS) {
      if (a[k] === undefined) continue;
      const r = CUBE_CHECK[k](a[k]);
      if (r.error) return r;
      out[k] = r.value;
    }
    if (Object.keys(out).length === 1) return { error: 'nothing to update' };
    if (out.after && out.after.includes(out.id)) return { error: 'a cube cannot wait for itself' };
    return { args: out };
  },
  'cube.requestChange': (a) => {
    if (!isCubeId(a.id)) return { error: 'id required (max 40 chars)' };
    if (!isText(a.note, 2000)) return { error: 'note required (max 2000 chars)' };
    return { args: { id: a.id.trim(), note: a.note.trim() } };
  },
  'cube.ask': (a) => {
    if (!isCubeId(a.id)) return { error: 'id required (max 40 chars)' };
    if (!isText(a.text, 2000)) return { error: 'text required (max 2000 chars)' };
    return { args: { id: a.id.trim(), text: a.text.trim() } };
  },
  'cube.review': (a) => {
    if (!isCubeId(a.id)) return { error: 'id required (max 40 chars)' };
    return { args: { id: a.id.trim() } };
  },
  'cube.markDone': (a) => {
    if (!isCubeId(a.id)) return { error: 'id required (max 40 chars)' };
    return { args: { id: a.id.trim() } };
  },
  'cube.add': (a) => {
    const unknown = Object.keys(a).filter((k) => !CUBE_FIELDS.includes(k));
    if (unknown.length) return { error: 'unknown field(s): ' + unknown.join(', ') };
    for (const k of ['title', 'actionText', 'flow', 'doneWhen', 'minutes']) {
      if (a[k] === undefined || a[k] === null) return { error: k + ' required' };
    }
    const out = {};
    for (const k of CUBE_FIELDS) {
      if (a[k] === undefined) continue;
      const r = CUBE_CHECK[k](a[k]);
      if (r.error) return r;
      out[k] = r.value;
    }
    return { args: out };
  },
  'cube.delete': (a) => (isCubeId(a.id) ? { args: { id: a.id.trim() } } : { error: 'id required (max 40 chars)' }),
  'cube.move': (a) => {
    if (!isCubeId(a.id)) return { error: 'id required (max 40 chars)' };
    const r = CUBE_CHECK.after(a.after);
    if (r.error) return r;
    if (r.value.includes(a.id.trim())) return { error: 'a cube cannot wait for itself' };
    return { args: { id: a.id.trim(), after: r.value } };
  },
  'cubes.gate': (a) => (typeof a.on === 'boolean' ? { args: { on: a.on } } : { error: 'on must be true or false' }),
};

// ---------- SSE ----------
function broadcastSnapshot() {
  const frame = `event: snapshot\ndata: ${latestSnapshot}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

const heartbeat = setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(`: hb ${Date.now()}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

// ---------- routes ----------
async function handle(req, res) {
  if (!hostOk(req.headers.host)) return sendJson(res, 403, { ok: false, message: 'bad host' });
  if (!originOk(req.headers.origin)) return sendJson(res, 403, { ok: false, message: 'bad origin' });

  const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, message: 'method not allowed' });
    let html;
    try {
      html = fs.readFileSync(INDEX_PATH);
    } catch (e) {
      return send(res, 500, 'index.html missing', 'text/plain; charset=utf-8');
    }
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }

  // ---- dashboard v2: static files from web/app (same token rules as the page: none for static, ?t= used by its API calls) ----
  if (p === '/v2' || p.startsWith('/v2/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, message: 'method not allowed' });
    if (p === '/v2') {
      res.writeHead(302, { ...BASE_HEADERS, Location: '/v2/' + url.search });
      return res.end();
    }
    let rel;
    try {
      rel = decodeURIComponent(p.slice(4));
    } catch {
      return send(res, 400, 'bad path', 'text/plain; charset=utf-8');
    }
    if (rel === '') rel = 'index.html';
    const full = path.resolve(APP_DIR, rel);
    if (rel.includes('\0') || (full !== APP_DIR && !full.startsWith(APP_DIR + path.sep))) {
      return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    }
    const type = APP_TYPES[path.extname(full).toLowerCase()];
    let data;
    try {
      if (!type || !fs.statSync(full).isFile()) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
      data = fs.readFileSync(full);
    } catch {
      return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    }
    const headers = { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': data.length };
    if (type.startsWith('text/html')) {
      headers['Content-Security-Policy'] =
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    }
    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : data);
  }

  if (p === '/favicon.ico') {
    res.writeHead(204, BASE_HEADERS);
    return res.end();
  }

  if (!p.startsWith('/api/')) return sendJson(res, 404, { ok: false, message: 'not found' });

  const given = req.headers['x-tp-token'] || url.searchParams.get('t') || '';
  if (!tokenOk(String(given))) return sendJson(res, 401, { ok: false, message: 'bad token' });

  const route = `${req.method} ${p}`;
  switch (route) {
    case 'GET /api/snapshot':
      return send(res, 200, latestSnapshot || 'null');

    case 'GET /api/events': {
      res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      if (latestSnapshot) res.write(`event: snapshot\ndata: ${latestSnapshot}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    case 'POST /api/snapshot': {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return sendJson(res, e.status || 400, { ok: false, message: e.message });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { ok: false, message: 'snapshot must be a JSON object' });
      }
      latestSnapshot = JSON.stringify(body);
      armIdleTimer(IDLE_MS);
      broadcastSnapshot();
      return sendJson(res, 200, { ok: true, clients: sseClients.size });
    }

    case 'POST /api/command': {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return sendJson(res, e.status || 400, { ok: false, message: e.message });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { ok: false, message: 'command must be a JSON object' });
      }
      const action = body.action;
      const validate = typeof action === 'string' && Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
      if (!validate) return sendJson(res, 400, { ok: false, message: 'unknown action' });
      const rest = { ...body };
      delete rest.action;
      const v = validate(rest);
      if (v.error) return sendJson(res, 400, { ok: false, message: v.error });

      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        sendJson(res, 504, { ok: false, message: 'Claude Code did not answer in time' });
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { res, timer });
      // Several actions carry their own `id` (agent/shell/task id), which would clash with the
      // command id. So: `id` is ALWAYS the command id (echo it in /api/result), the full args
      // live under `args` (canonical, use args.id for the target), and the other args are
      // also flattened for convenience.
      const flat = { ...v.args };
      delete flat.id;
      emit({ type: 'command', id, action, ...flat, args: v.args });
      return;
    }

    case 'POST /api/result': {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return sendJson(res, e.status || 400, { ok: false, message: e.message });
      }
      if (!body || typeof body !== 'object' || !isId(body.id)) {
        return sendJson(res, 400, { ok: false, message: 'id required' });
      }
      const entry = pending.get(body.id);
      if (!entry) return sendJson(res, 404, { ok: false, message: 'no pending command with that id' });
      pending.delete(body.id);
      clearTimeout(entry.timer);
      const message = body.message === undefined || body.message === null ? '' : String(body.message).slice(0, 2000);
      sendJson(entry.res, 200, { ok: body.ok === true, message });
      return sendJson(res, 200, { ok: true });
    }

    default:
      return sendJson(res, 404, { ok: false, message: 'not found' });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('handler error:', e && e.stack ? e.stack : e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, message: 'server error' });
    else res.end();
  });
});
server.keepAliveTimeout = 5000;

// ---------- listen with port fallback ----------
function listen(port) {
  const onError = (err) => {
    server.removeListener('listening', onListening);
    if (err.code === 'EADDRINUSE' && port < LAST_PORT) {
      log(`port ${port} busy, trying ${port + 1}`);
      listen(port + 1);
    } else {
      emit({ type: 'error', message: `cannot listen (${err.code || err.message}) on ports ${FIRST_PORT}-${LAST_PORT}` });
      process.exit(1);
    }
  };
  const onListening = () => {
    server.removeListener('error', onError);
    boundPort = server.address().port;
    log(`listening on http://127.0.0.1:${boundPort}/`);
    emit({ type: 'ready', port: boundPort });
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '127.0.0.1');
}

// ---------- lifecycle ----------
let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { res, timer } of pending.values()) {
    clearTimeout(timer);
    try {
      sendJson(res, 503, { ok: false, message: 'dashboard server stopping' });
    } catch {}
  }
  pending.clear();
  for (const res of sseClients) {
    try {
      res.end();
    } catch {}
  }
  sseClients.clear();
  try {
    server.close();
  } catch {}
  setTimeout(() => process.exit(code || 0), 50).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.stdout.on('error', () => shutdown(1)); // EPIPE: parent gone
// No stdin watch: the host spawns us with stdin already closed. Liveness comes from
// the snapshot POSTs instead (see armIdleTimer).
let idleTimer = null;
function armIdleTimer(ms) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log(`no snapshot for ${ms} ms, exiting`);
    shutdown(0);
  }, ms);
}
armIdleTimer(START_MS);

listen(FIRST_PORT);
