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

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > max) {
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
      if (size > max) {
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
const TICKET_TYPE = ['feature', 'bug', 'task'];
const TICKET_STATUS = ['todo', 'doing', 'review', 'blocked', 'done'];
const isTicketKey = (v) => typeof v === 'string' && (/^TP-\d{1,6}$/.test(v) || /^[A-Za-z0-9_.:-]{1,64}$/.test(v));

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

// COMMANDS: the ONE allowlist for POST /api/command. Each validator returns { args } with only
// whitelisted keys, or { error }. Later cubes add 'session.prompt', 'session.stop', 'perm.answer',
// 'ticket.*' and 'file.*' here (one entry each, same validator style). Nothing outside this table runs.
const COMMANDS = {
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
  // ---- tickets (Board screen); key is TP-n or a legacy task id ----
  'ticket.create': (a) => {
    if (!isText(a.title, 200)) return { error: 'title required (max 200 chars)' };
    if (!TICKET_TYPE.includes(a.type)) return { error: 'type must be one of ' + TICKET_TYPE.join(', ') };
    if (!PRIORITY.includes(a.priority)) return { error: 'priority must be one of ' + PRIORITY.join(', ') };
    const out = { type: a.type, priority: a.priority, title: a.title.trim() };
    if (a.description !== undefined && a.description !== null) {
      if (!isStr(a.description, 10000)) return { error: 'description must be text (max 10000 chars)' };
      out.description = a.description;
    }
    if (a.checks !== undefined && a.checks !== null) {
      if (!Array.isArray(a.checks) || a.checks.length > 50 || !a.checks.every((x) => isStr(x, 300))) return { error: 'checks must be up to 50 texts (max 300 chars each)' };
      out.checks = a.checks;
    }
    if (a.assignee !== undefined && a.assignee !== null && a.assignee !== '') {
      if (!isText(a.assignee, 60)) return { error: 'assignee must be text (max 60 chars)' };
      out.assignee = a.assignee.trim();
    }
    return { args: out };
  },
  'ticket.move': (a) => {
    if (!isTicketKey(a.key)) return { error: 'key required' };
    if (!TICKET_STATUS.includes(a.status)) return { error: 'status must be one of ' + TICKET_STATUS.join(', ') };
    return { args: { key: a.key, status: a.status } };
  },
  'ticket.check': (a) => {
    if (!isTicketKey(a.key)) return { error: 'key required' };
    if (!Number.isInteger(a.index) || a.index < 0 || a.index >= 50) return { error: 'index must be 0 to 49' };
    if (typeof a.done !== 'boolean') return { error: 'done must be true or false' };
    return { args: { key: a.key, index: a.index, done: a.done } };
  },
  'ticket.comment': (a) => {
    if (!isTicketKey(a.key)) return { error: 'key required' };
    return isText(a.text, 4000) ? { args: { key: a.key, text: a.text } } : { error: 'text required (max 4000 chars)' };
  },
  'ticket.assign': (a) => {
    if (!isTicketKey(a.key)) return { error: 'key required' };
    if (a.assignee === undefined || a.assignee === null || a.assignee === '') return { args: { key: a.key, assignee: '' } };
    return isText(a.assignee, 60) ? { args: { key: a.key, assignee: a.assignee.trim() } } : { error: 'assignee must be text (max 60 chars)' };
  },
  'ticket.update': (a) => {
    if (!isTicketKey(a.key)) return { error: 'key required' };
    const out = { key: a.key };
    if (a.title !== undefined) {
      if (!isText(a.title, 200)) return { error: 'title must be non-empty (max 200 chars)' };
      out.title = a.title.trim();
    }
    if (a.description !== undefined) {
      if (!isStr(a.description, 10000)) return { error: 'description must be text (max 10000 chars)' };
      out.description = a.description;
    }
    if (a.type !== undefined) {
      if (!TICKET_TYPE.includes(a.type)) return { error: 'type must be one of ' + TICKET_TYPE.join(', ') };
      out.type = a.type;
    }
    if (a.priority !== undefined) {
      if (!PRIORITY.includes(a.priority)) return { error: 'priority must be one of ' + PRIORITY.join(', ') };
      out.priority = a.priority;
    }
    return Object.keys(out).length === 1 ? { error: 'nothing to update' } : { args: out };
  },
  'ticket.delete': (a) => (isTicketKey(a.key) ? { args: { key: a.key } } : { error: 'key required' }),
  'prompt.send': (a) => (isText(a.text, 20000) ? { args: { text: a.text } } : { error: 'text required (max 20000 chars)' }),
  'orchestrate.set': (a) => (typeof a.on === 'boolean' ? { args: { on: a.on } } : { error: 'on must be true or false' }),

  // ---- session: a prompt typed on the web, and Stop for the running turn ----
  'session.prompt': (a) => (isText(a.text, 20000) ? { args: { text: a.text } } : { error: 'text required (max 20000 chars)' }),
  'session.stop': () => ({ args: {} }),
  'perm.answer': (a) => {
    if (typeof a.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(a.id)) return { error: 'id required (max 64 safe chars)' };
    if (!['allow', 'allowAlways', 'deny'].includes(a.decision)) return { error: 'decision must be allow, allowAlways or deny' };
    return { args: { id: a.id, decision: a.decision } };
  },

  // ---- files (read / diff / open in an editor); the mod confines paths to the session cwd ----
  'file.read': (a) => (isText(a.path, 1024) ? { args: { path: a.path } } : { error: 'path required (max 1024 chars)' }),
  'file.diff': (a) => (isText(a.path, 1024) ? { args: { path: a.path } } : { error: 'path required (max 1024 chars)' }),
  'file.open': (a) => {
    if (!isText(a.path, 1024)) return { error: 'path required (max 1024 chars)' };
    if (a.editor !== 'vscode' && a.editor !== 'studio') return { error: 'editor must be vscode or studio' };
    const out = { path: a.path, editor: a.editor };
    if (a.line !== undefined && a.line !== null && a.line !== '') {
      if (!Number.isInteger(a.line) || a.line < 1 || a.line > 10000000) return { error: 'line must be a positive whole number' };
      out.line = a.line;
    }
    return { args: out };
  },

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

// ---------- live event stream (v2) ----------
// Ring buffer of the last EVENT_MAX events; seq is monotonically increasing and never reused.
const EVENT_MAX = 2000;
const EVENT_BATCH_MAX = 500;
const events = [];
let nextSeq = 1;
const streamClients = new Set();

const EVENT_MAX_BYTES = 64 * 1024; // one event
const RING_MAX_BYTES = 32 * 1024 * 1024; // whole ring
const CLIENT_BACKLOG_MAX = 2 * 1024 * 1024; // a stream client this far behind is dropped (EventSource replays)
const eventSizes = []; // bytes per ring entry, parallel to `events`
let ringBytes = 0;

function writeTo(set, res, frame) {
  try {
    res.write(frame);
    if (set === streamClients && res.writableLength > CLIENT_BACKLOG_MAX) {
      set.delete(res);
      res.destroy(); // end() would wait for the backlog; EventSource reconnects and replays
    }
  } catch {
    set.delete(res);
  }
}

function eventFrame(ev) {
  return `id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
}

function addEvents(list) {
  const added = [];
  for (const raw of list) {
    const ev = { ...raw, seq: nextSeq++ };
    if (typeof ev.ts !== 'number') ev.ts = Date.now();
    const size = Buffer.byteLength(JSON.stringify(ev));
    events.push(ev);
    eventSizes.push(size);
    ringBytes += size;
    added.push(ev);
  }
  let drop = events.length > EVENT_MAX ? events.length - EVENT_MAX : 0;
  let bytes = ringBytes;
  for (let i = 0; i < drop; i++) bytes -= eventSizes[i];
  while (bytes > RING_MAX_BYTES && drop < events.length - 1) bytes -= eventSizes[drop++];
  if (drop > 0) {
    events.splice(0, drop);
    for (const n of eventSizes.splice(0, drop)) ringBytes -= n;
  }
  for (const res of [...streamClients]) for (const ev of added) if (streamClients.has(res)) writeTo(streamClients, res, eventFrame(ev));
  return added;
}

// ---------- SSE ----------
function broadcastSnapshot() {
  const frame = `event: snapshot\ndata: ${latestSnapshot}\n\n`;
  for (const res of streamClients) writeTo(streamClients, res, frame);
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
  for (const res of streamClients) writeTo(streamClients, res, `: hb ${Date.now()}\n\n`);
}, HEARTBEAT_MS);
heartbeat.unref();

// POST /api/events: body is one event object or an array of them. Token already checked.
async function handleEvents(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, e.status || 400, { ok: false, message: e.message });
  }
  const list = Array.isArray(body) ? body : [body];
  if (!list.length || list.length > EVENT_BATCH_MAX) {
    return sendJson(res, 400, { ok: false, message: `send 1-${EVENT_BATCH_MAX} events` });
  }
  if (!list.every((e) => e && typeof e === 'object' && !Array.isArray(e))) {
    return sendJson(res, 400, { ok: false, message: 'each event must be a JSON object' });
  }
  const fit = list.filter((e) => Buffer.byteLength(JSON.stringify(e)) <= EVENT_MAX_BYTES);
  const dropped = list.length - fit.length;
  if (!fit.length) return sendJson(res, 400, { ok: false, message: `event too large (max ${EVENT_MAX_BYTES} bytes)`, dropped });
  const added = addEvents(fit);
  return sendJson(res, 200, { ok: true, seq: added[added.length - 1].seq, dropped });
}

// GET /api/stream?t=<token>[&since=<seq>]: Server-Sent Events. Token already checked (query param allowed).
function handleStream(req, res, url) {
  const sinceRaw = req.headers['last-event-id'] || url.searchParams.get('since') || '';
  let since = /^\d+$/.test(String(sinceRaw)) ? parseInt(sinceRaw, 10) : 0;
  if (since >= nextSeq) since = 0; // client saw a previous server run (seq restarted): replay everything
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  if (latestSnapshot) res.write(`event: snapshot\ndata: ${latestSnapshot}\n\n`);
  for (const ev of events) if (ev.seq > since) res.write(eventFrame(ev));
  streamClients.add(res);
  res.on('error', () => streamClients.delete(res));
  req.on('close', () => streamClients.delete(res));
}

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

    case 'GET /api/clients':
      return sendJson(res, 200, { ok: true, pages: streamClients.size });

    case 'GET /api/stream':
      return handleStream(req, res, url);

    case 'POST /api/events':
      return handleEvents(req, res);

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
      return sendJson(res, 200, { ok: true, clients: sseClients.size + streamClients.size });
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
      const validate = typeof action === 'string' && Object.prototype.hasOwnProperty.call(COMMANDS, action) ? COMMANDS[action] : null;
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
        body = await readBody(req, 4 * 1024 * 1024); // file.read data can be ~1 MB once escaped
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
      const reply = { ok: body.ok === true, message };
      if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) reply.data = body.data;
      sendJson(entry.res, 200, reply);
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
  for (const res of streamClients) {
    try {
      res.end();
    } catch {}
  }
  streamClients.clear();
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
