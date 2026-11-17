'use strict';
// Task Progress dashboard v2: core. Namespace, token, routing, polling, shortcuts.
// Screen contract: TP.screens.X = { render(state), onEvent(ev)? }. render runs on every state change and when
// the screen is shown; onEvent gets live session events (TP.events holds the last 2000 for replay).
// Screens send commands ONLY through TP.send(type, payload); they never fetch directly.
var TP = window.TP = { screens: {}, state: null, token: '', current: '', events: [], demoMode: /[?&]demo=1/.test(location.search) };

TP.SCREENS = ['session', 'board', 'cubes', 'review', 'files', 'usage'];
TP.ICONS = {
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5L16 9.5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'
};

TP.$ = function (id) { return document.getElementById(id); };

TP.icons = function (root) {
  (root || document).querySelectorAll('[data-ic]').forEach(function (el) {
    var p = TP.ICONS[el.getAttribute('data-ic')];
    if (p && !el.firstChild) el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + p + '</svg>';
  });
};

TP.toast = function (msg) {
  var t = TP.$('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('on');
  clearTimeout(TP._tt); TP._tt = setTimeout(function () { t.classList.remove('on'); }, 2600);
};

TP.banner = function (msg) {
  var b = TP.$('banner'); b.textContent = msg || ''; b.classList.toggle('show', !!msg);
};

// ---- token: ?t= is read once, kept in sessionStorage, stripped from the URL ----
TP.initToken = function () {
  var KEY = 'tp-token', params = new URLSearchParams(location.search), t = params.get('t');
  if (t) {
    TP.token = t;
    try { sessionStorage.setItem(KEY, t); } catch (e) {}
    params.delete('t');
    var q = params.toString();
    try { history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash); } catch (e) {}
  } else {
    try { TP.token = sessionStorage.getItem(KEY) || ''; } catch (e) { TP.token = ''; }
  }
};

// ---- API (same endpoints as the v1 page; paths are absolute) ----
TP.api = function (method, path, body) {
  var opts = { method: method, headers: { 'X-TP-Token': TP.token }, cache: 'no-store' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch(path, opts).then(function (r) {
    return r.text().then(function (t) {
      var data = null;
      try { data = t ? JSON.parse(t) : null; } catch (e) {}
      if (r.status === 401) TP.banner('This page has no valid token. Open the dashboard again from Claude Code.');
      return { status: r.status, data: data };
    });
  });
};

// ---- events and commands ----
TP.emit = function (ev) {
  TP.events.push(ev);
  if (TP.events.length > 2000) TP.events.splice(0, TP.events.length - 2000);
  TP.SCREENS.forEach(function (n) {
    var s = TP.screens[n];
    if (s && typeof s.onEvent === 'function') { try { s.onEvent(ev); } catch (e) { console.error('onEvent ' + n, e); } }
  });
};

// Sends {action: type, ...payload} to POST /api/command (same as v1). Resolves { ok, message, status, data }.
TP.send = function (type, payload) {
  if (TP.demoMode) {
    console.info('Demo send', type, payload);
    TP.toast('Demo: ' + type);
    return Promise.resolve({ ok: true, message: 'demo', status: 200, data: null });
  }
  return TP.api('POST', '/api/command', Object.assign({ action: type }, payload || {})).then(function (r) {
    var d = r.data || {}, ok = r.status === 200 && d.ok === true;
    if (!ok) TP.toast(d.message || 'Failed (' + r.status + ')');
    return { ok: ok, message: d.message || '', status: r.status, data: d };
  }).catch(function () { TP.toast('Lost contact with the dashboard server.'); return { ok: false, message: 'network', status: 0, data: null }; });
};

// ---- routing ----
TP.route = function () {
  var name = (location.hash || '').replace(/^#\/?/, '').split('/')[0];
  if (TP.SCREENS.indexOf(name) < 0) name = 'session';
  TP.current = name;
  TP.SCREENS.forEach(function (s) {
    var sec = TP.$('screen-' + s);
    var on = s === name;
    sec.hidden = !on; sec.classList.toggle('on', on);
  });
  document.querySelectorAll('.navb').forEach(function (b) {
    var on = b.getAttribute('data-nav') === name;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  TP.renderCurrent();
};

TP.go = function (name) {
  if (location.hash !== '#' + name) location.hash = '#' + name; else TP.route();
};

TP.renderCurrent = function () {
  var scr = TP.screens[TP.current];
  if (scr && typeof scr.render === 'function') {
    try { scr.render(TP.state); } catch (e) { console.error('render ' + TP.current, e); }
  }
};

// ---- top bar ----
TP.renderTop = function (st) {
  var name = (st && st.progress && st.progress.task) || 'Session';
  TP.$('sess-name').textContent = name;
  TP.$('sess-cwd').textContent = (st && st.session && st.session.cwd) || '';
  var model = st && st.session && st.session.model;
  var mc = TP.$('model-chip'); mc.hidden = !model; if (model) mc.textContent = model;
  var chip = TP.$('status'), txt = TP.$('status-text');
  var busy = !!(st && st.progress && !st.progress.done);
  chip.className = 'chip ' + (!st ? '' : busy ? 'warn' : 'ok');
  txt.textContent = !st ? 'Waiting for Claude' : busy ? 'Working' : 'Idle';
  // Mini meters: state.usage arrives with cube c6. Hidden until then.
  var u = st && st.usage, any = false;
  [['mm-ctx', 'Context', u && u.context], ['mm-5h', '5h', u && u.fiveHour], ['mm-week', 'Week', u && u.weekly]].forEach(function (m) {
    var el = TP.$(m[0]), pct = m[2] && typeof m[2].percent === 'number' ? Math.max(0, Math.min(100, Math.round(m[2].percent))) : null;
    el.hidden = pct === null;
    if (pct === null) return;
    any = true;
    el.firstChild.textContent = m[1] + ' ' + pct + '%';
    el.querySelector('u').style.width = pct + '%';
    el.classList.toggle('hot', pct >= 75);
  });
  TP.$('meters').hidden = !any;
};

// ---- data ----
TP.onState = function (st) {
  TP.state = st;
  TP.renderTop(st);
  TP.renderCurrent();
};

TP.poll = function () {
  TP.api('GET', '/api/snapshot').then(function (r) {
    if (r.status === 200) { TP.banner(''); TP.onState(r.data); }
  }).catch(function () { TP.banner('Lost contact with the dashboard server.'); });
};

// connect(): live mode uses Server-Sent Events (/api/stream). EventSource reconnects by itself and
// resends Last-Event-ID, so the server replays what was missed. Falls back to 2 s polling if
// EventSource is missing or the stream endpoint answers an error (e.g. 404 from an older server).
TP.lastSeq = 0;
TP.startPolling = function () {
  if (TP._polling) return;
  TP._polling = true;
  TP.poll();
  setInterval(TP.poll, 2000);
};
TP.connect = function () {
  if (typeof EventSource === 'undefined') return TP.startPolling();
  var es = new EventSource('/api/stream?t=' + encodeURIComponent(TP.token)), downTimer = null, everOpen = false;
  TP.es = es;
  es.onopen = function () {
    everOpen = true;
    clearTimeout(downTimer); downTimer = null;
    TP.banner('');
  };
  es.addEventListener('snapshot', function (m) {
    try { TP.onState(JSON.parse(m.data)); } catch (e) { console.error('snapshot', e); }
  });
  es.onmessage = function (m) {
    var ev;
    try { ev = JSON.parse(m.data); } catch (e) { return; }
    if (typeof ev.seq === 'number') {
      if (ev.seq < TP.lastSeq) TP.events.length = 0; // server restarted: seq began again, drop the stale replay buffer
      TP.lastSeq = ev.seq;
    }
    // EventSource resends lastSeq as Last-Event-ID
    TP.emit(ev);
  };
  es.onerror = function () {
    // CLOSED = the browser gave up (HTTP error such as 401/404): use polling instead.
    if (es.readyState === 2) {
      clearTimeout(downTimer);
      if (!everOpen) TP.startPolling();
      else TP.banner('Lost contact with the dashboard server.');
      return;
    }
    if (!downTimer) downTimer = setTimeout(function () { TP.banner('Lost contact with the dashboard server. Reconnecting...'); }, 3000);
  };
};

// ---- overlays and shortcuts ----
TP.closeAll = function () {
  document.querySelectorAll('.modal.on,.drawer.on,.pal.on,.pop.on,.scrim.on').forEach(function (e) { e.classList.remove('on'); });
};
TP.openPalette = function () { TP.toast('Search is coming soon'); };      // placeholder
TP.newTicket = function () { TP.toast('New ticket is coming soon'); };    // placeholder

TP.keys = function (e) {
  var tag = (e.target && e.target.tagName || '').toLowerCase();
  var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);
  if (e.key === 'Escape') { TP.closeAll(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); TP.openPalette(); return; }
  if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); TP.newTicket(); }
};

TP.boot = function () {
  if (!TP.demoMode) TP.initToken();
  TP.icons();
  document.querySelectorAll('[data-nav]').forEach(function (b) {
    b.addEventListener('click', function () { TP.go(b.getAttribute('data-nav')); });
  });
  document.querySelectorAll('[data-act]').forEach(function (b) {
    b.addEventListener('click', function () {
      var a = b.getAttribute('data-act');
      if (a === 'palette') TP.openPalette();
      else if (a === 'newTicket') TP.newTicket();
      else if (a === 'stop') TP.send('session.stop');
    });
  });
  TP.$('scrim').addEventListener('click', TP.closeAll);
  document.addEventListener('keydown', TP.keys);
  window.addEventListener('hashchange', TP.route);
  TP.route();
  if (TP.demoMode && TP.demo) {
    document.title = 'Task Progress v2 (demo)';
    TP.onState(TP.demo.state);
    TP.demo.play();
  } else TP.connect();
};
