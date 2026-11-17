'use strict';
// Screen: session. Chat column (bubbles, tool/executor/permission/waiting cards, composer) + plan panel.
(function () {
  var built = false, root, chat, thread, msg, qbadge, panelEl, stick = true;
  var running = false, cur = null, tools = {}, execs = {}, perms = {}, seen = [];
  var lastState = null, panelOff = false;

  var CSS = '' +
    '#screen-session.on{display:flex;padding:0;overflow:hidden}' +
    '#screen-session .chatcol{flex:1;display:flex;flex-direction:column;min-width:0}' +
    '#screen-session .thread{flex:1;overflow:auto;padding:var(--s5) var(--s4) var(--s4)}' +
    '#screen-session .thread>.in{max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:var(--s4)}' +
    '#screen-session .ub{align-self:flex-end;max-width:78%;background:var(--grad);color:#fff;padding:14px 18px;border-radius:18px 18px 4px 18px;white-space:pre-wrap;word-break:break-word}' +
    '#screen-session .ub .qb{display:inline-block;margin-top:8px;font-size:12px;font-weight:600;background:rgba(0,0,0,.25);padding:2px 10px;border-radius:99px}' +
    '#screen-session .cm{display:flex;gap:var(--s3)}' +
    '#screen-session .av{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:13px;background:var(--surface-3);color:var(--star)}' +
    '#screen-session .av.c{background:var(--grad);color:#fff;font-size:16px}' +
    '#screen-session .av.e{background:var(--ok-soft);color:var(--ok)}' +
    '#screen-session .cm .body{flex:1;min-width:0;word-break:break-word}' +
    '#screen-session .cm p{margin-bottom:10px} #screen-session .cm p:last-child{margin-bottom:0}' +
    '#screen-session .cm code{font:13px var(--mono);background:var(--surface-3);padding:1px 6px;border-radius:6px}' +
    '#screen-session .cm pre{margin:8px 0;padding:14px;border-radius:10px;background:var(--code);font:12.5px/1.6 var(--mono);overflow:auto;white-space:pre-wrap}' +
    '#screen-session .cm pre code{background:none;padding:0}' +
    '#screen-session .cm ul{margin:6px 0 10px;padding-left:22px} #screen-session .cm li{margin:3px 0}' +
    '#screen-session .caret{display:inline-block;width:8px;height:1.05em;background:var(--shimmer);vertical-align:-3px;margin-left:2px;animation:tpbl 1s steps(2) infinite}' +
    '@keyframes tpbl{50%{opacity:0}}' +
    '#screen-session details.tc{background:var(--surface);border-radius:12px;margin:2px 0}' +
    '#screen-session details.tc>summary{list-style:none;display:flex;align-items:center;gap:var(--s2);padding:12px 16px;cursor:pointer;border-radius:12px}' +
    '#screen-session details.tc>summary::-webkit-details-marker{display:none}' +
    '#screen-session details.tc>summary:hover{background:var(--surface-2)}' +
    '#screen-session details.tc .tool{font:600 12px var(--mono);padding:3px 10px;border-radius:8px;background:var(--accent-soft);color:var(--shimmer)}' +
    '#screen-session details.tc .sum{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font-size:14px}' +
    '#screen-session details.tc .chev{display:inline-block;transition:transform .15s;color:var(--faint)}' +
    '#screen-session details[open]>summary .chev{transform:rotate(90deg)}' +
    '#screen-session details.tc.err{box-shadow:inset 3px 0 0 var(--danger)}' +
    '#screen-session details.tc.err .tool{background:var(--danger-soft);color:var(--danger)}' +
    '#screen-session details.tc.run .tool{animation:pl 1.6s infinite}' +
    '#screen-session .io{padding:0 16px 16px}' +
    '#screen-session .io pre{margin:8px 0 0;padding:14px;border-radius:10px;background:var(--code);font:12.5px/1.6 var(--mono);overflow:auto;max-height:220px;white-space:pre-wrap;word-break:break-word}' +
    '#screen-session .io label{font-size:12.5px;color:var(--faint);font-weight:600}' +
    '#screen-session .exec{background:var(--surface);border-radius:var(--r);padding:16px 20px;display:flex;align-items:center;gap:var(--s3);box-shadow:inset 0 3px 0 var(--ok)}' +
    '#screen-session .exec.done{opacity:.8}' +
    '#screen-session .exec .et{flex:1;min-width:0} #screen-session .exec .et b{display:block} #screen-session .exec .et span{font-size:13px;color:var(--muted)}' +
    '#screen-session .ring{position:relative;width:52px;height:52px;flex:none}' +
    '#screen-session .ring svg{transform:rotate(-90deg)} #screen-session .ring b{position:absolute;inset:0;display:grid;place-items:center;font:600 11px var(--mono)}' +
    '#screen-session .ask{background:var(--warn-soft);border-radius:var(--r);padding:var(--s4);display:flex;gap:var(--s3)}' +
    '#screen-session .ask .ic{width:40px;height:40px;border-radius:12px;background:var(--warn);color:#1a1200;display:grid;place-items:center;flex:none;font-weight:800;font-size:20px}' +
    '#screen-session .ask h4{font-size:16px;margin-bottom:4px}' +
    '#screen-session .perm{background:var(--surface);border-radius:var(--r);padding:var(--s4);box-shadow:inset 0 0 0 1.5px var(--shimmer),0 0 40px rgba(10,132,255,.14)}' +
    '#screen-session .perm h4{font-size:16px}' +
    '#screen-session .perm pre{margin:12px 0 16px;padding:14px;border-radius:10px;background:var(--code);font:13px var(--mono);overflow:auto;white-space:pre-wrap;word-break:break-word}' +
    '#screen-session .perm .acts{display:flex;gap:10px;flex-wrap:wrap}' +
    '#screen-session .perm.done{box-shadow:none;opacity:.7}' +
    '#screen-session .composer{padding:var(--s3) var(--s4) var(--s4);background:linear-gradient(0deg,var(--bg-0) 70%,transparent)}' +
    '#screen-session .composer .in{max-width:820px;margin:0 auto;background:var(--surface);border-radius:20px;padding:var(--s3);box-shadow:0 0 0 1px var(--line-2),var(--shadow)}' +
    '#screen-session .composer textarea{width:100%;border:0;background:transparent;resize:none;min-height:56px;max-height:160px;outline:none;padding:6px 8px;font-size:15px}' +
    '#screen-session .cbar{display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap}' +
    '#screen-session .cbar .sp{flex:1}' +
    '#screen-session .panel{width:320px;flex:none;border-left:1px solid var(--line);overflow:auto;padding:var(--s4);background:var(--bg-1);display:flex;flex-direction:column;gap:var(--s4)}' +
    '#screen-session .panel.off{display:none}' +
    '#screen-session .panel h3{font-size:15px;margin-bottom:var(--s2)}' +
    '#screen-session .track{position:relative;display:flex;flex-direction:column;gap:20px;padding-left:6px}' +
    '#screen-session .track::before{content:"";position:absolute;left:14px;top:10px;bottom:10px;width:2px;background:linear-gradient(var(--star),var(--line));opacity:.5}' +
    '#screen-session .tn{position:relative;display:flex;gap:14px;align-items:flex-start;font-size:14px}' +
    '#screen-session .tn i{flex:none;width:18px;height:18px;display:grid;place-items:center;font-style:normal;font-size:15px;color:var(--star);background:var(--bg-1);z-index:1;line-height:1}' +
    '#screen-session .tn.cur i{color:var(--shimmer);animation:pl 1.6s infinite;font-size:19px}' +
    '#screen-session .tn.up i,#screen-session .tn.up{color:var(--faint)}' +
    '#screen-session .mini{display:flex;flex-direction:column;gap:10px}' +
    '#screen-session .mc{background:var(--surface);padding:14px 16px;border-radius:12px;display:block;width:100%}' +
    '#screen-session .mc b{font-size:13.5px;display:block;margin:4px 0 2px}' +
    '#screen-session .mc .muted{font-size:13px}' +
    '@media (max-width:900px){#screen-session .panel{display:none}#screen-session .panel.show{display:flex;position:absolute;right:0;top:0;bottom:0;z-index:5;box-shadow:var(--shadow)}}' +
    '@media (max-width:760px){#screen-session .thread{padding:var(--s3)}#screen-session .composer{padding:var(--s2)}#screen-session .ub{max-width:92%}#screen-session .panel.show{width:min(320px,88vw)}}';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function inline(s) {
    return s.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  }
  // Escape first, then apply a small markdown subset (fences, lists, bold, inline code, paragraphs).
  function md(text) {
    var parts = esc(text).split('```'), out = '';
    parts.forEach(function (seg, i) {
      if (i % 2) { out += '<pre><code>' + seg.replace(/^[\w+-]*\n/, '') + '</code></pre>'; return; }
      var lines = seg.split('\n'), para = [], list = [];
      function flushP() { if (para.length) { out += '<p>' + inline(para.join('<br>')) + '</p>'; para = []; } }
      function flushL() { if (list.length) { out += '<ul>' + list.map(function (l) { return '<li>' + inline(l) + '</li>'; }).join('') + '</ul>'; list = []; } }
      lines.forEach(function (ln) {
        var m = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(ln);
        if (m) { flushP(); list.push(m[1]); }
        else if (!ln.trim()) { flushP(); flushL(); }
        else { flushL(); para.push(ln); }
      });
      flushP(); flushL();
    });
    return out;
  }
  function ts(v) { var t = typeof v === 'number' ? v : Date.parse(v); return isNaN(t) ? 0 : t; }
  function fmt(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  function scroll() { if (stick && thread) thread.scrollTop = thread.scrollHeight; }
  function add(el) { chat.appendChild(el); scroll(); return el; }
  function div(cls, html) { var d = document.createElement('div'); d.className = cls; d.innerHTML = html || ''; return d; }
  function claudeMsg(html) {
    return div('cm', '<div class="av c">&#10022;</div><div class="body">' + (html || '') + '</div>');
  }

  function build() {
    root = TP.$('screen-session');
    if (!document.getElementById('css-session')) {
      var st = document.createElement('style'); st.id = 'css-session'; st.textContent = CSS; document.head.appendChild(st);
    }
    root.innerHTML =
      '<div class="chatcol"><div class="thread" id="ss-thread"><div class="in" id="ss-chat"></div></div>' +
      '<div class="composer"><div class="in">' +
      '<textarea id="ss-msg" placeholder="Tell Claude what to do next. Ctrl+Enter to send." aria-label="Message"></textarea>' +
      '<div class="cbar"><span class="chip warn" id="ss-q" hidden>queued: runs when Claude is idle</span><span class="sp"></span>' +
      '<button class="btn ghost sm" id="ss-tog" type="button">Plan panel</button>' +
      '<button class="btn danger sm" id="ss-stop" type="button">Stop</button>' +
      '<button class="btn pri" id="ss-send" type="button">Send <kbd style="background:rgba(0,0,0,.25);color:#fff">Ctrl Enter</kbd></button>' +
      '</div></div></div></div>' +
      '<aside class="panel" id="ss-panel"></aside>';
    thread = TP.$('ss-thread'); chat = TP.$('ss-chat'); msg = TP.$('ss-msg'); qbadge = TP.$('ss-q'); panelEl = TP.$('ss-panel');
    thread.addEventListener('scroll', function () { stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60; });
    msg.addEventListener('input', badge);
    msg.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
    TP.$('ss-send').addEventListener('click', send);
    TP.$('ss-stop').addEventListener('click', function () { TP.send('session.stop'); });
    TP.$('ss-tog').addEventListener('click', function () {
      if (window.matchMedia('(max-width:900px)').matches) panelEl.classList.toggle('show');
      else { panelOff = !panelOff; panelEl.classList.toggle('off', panelOff); }
    });
    chat.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button[data-d]');
      if (!b) return;
      answer(b.getAttribute('data-id'), b.getAttribute('data-d'));
    });
    built = true;
    if (!TP.events.length) chat.appendChild(div('cm', '<div class="body muted">Nothing here yet. Type a message below, or wait for Claude to start working.</div>'));
    TP.events.forEach(handle);
    scroll();
  }

  function badge() { qbadge.hidden = !(running && msg.value.trim()); }

  function send() {
    var t = msg.value.trim();
    if (!t) return;
    var queued = running;
    var b = div('ub'); b.textContent = t;
    if (queued) b.insertAdjacentHTML('beforeend', '<br><span class="qb">queued: runs when Claude is idle</span>');
    stick = true; clearEmpty(); add(b); cur = null;
    msg.value = ''; badge();
    TP.send('session.prompt', { text: t }).then(function (r) { if (r && !r.ok) b.insertAdjacentHTML('beforeend', '<br><span class="qb">not sent</span>'); });
  }

  function clearEmpty() { var f = chat.firstElementChild; if (f && f.querySelector('.body.muted') && !f.querySelector('.av.c')) chat.removeChild(f); }

  function answer(id, decision) {
    var p = perms[id]; if (!p || p.done) return;
    p.done = true;
    p.el.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    TP.send('perm.answer', { id: id, decision: decision }).then(function (r) {
      var label = { allow: 'Allowed once', allowAlways: 'Always allowed', deny: 'Denied' }[decision];
      p.el.classList.add('done');
      p.el.querySelector('.acts').innerHTML = '<span class="chip ' + (decision === 'deny' ? 'bad' : 'ok') + '">' + (r && r.ok === false ? 'Not sent, answer in the terminal' : label) + '</span>';
    });
  }

  function endStream() {
    if (cur) { var c = cur.el.querySelector('.caret'); if (c) c.remove(); cur = null; }
  }

  function toolHtml(e) {
    var inp = e.input, out = e.output;
    if (inp && typeof inp === 'object') inp = JSON.stringify(inp, null, 2);
    var body = '';
    if (inp) body += '<label>Input</label><pre>' + esc(inp) + '</pre>';
    if (out) body += '<label style="display:block;margin-top:12px">Output</label><pre>' + esc(out) + '</pre>';
    return body || '<label>No details were sent for this call.</label>';
  }

  function ring(el, remain, total, over) {
    var p = total > 0 ? Math.max(0, Math.min(1, remain / total)) : 0, c = 2 * Math.PI * 21;
    el.innerHTML = '<svg width="52" height="52" viewBox="0 0 52 52"><circle cx="26" cy="26" r="21" fill="none" stroke="var(--surface-3)" stroke-width="5"/>' +
      '<circle cx="26" cy="26" r="21" fill="none" stroke="' + (over ? 'var(--danger)' : 'var(--ok)') + '" stroke-width="5" stroke-linecap="round" stroke-dasharray="' + (c * p).toFixed(1) + ' ' + c.toFixed(1) + '"/></svg><b>' + (over ? '+' + fmt(-remain) : fmt(remain)) + '</b>';
  }

  function tickExec(x) {
    var total = x.budgetMin * 60, el = x.el.querySelector('.ring');
    if (x.status !== 'running') { el.innerHTML = '<b>' + (x.status === 'done' ? 'done' : esc(x.status)) + '</b>'; return; }
    var remain = total - (Date.now() - x.start) / 1000;
    ring(el, remain, total, remain < 0);
  }

  function execView(x) {
    var run = x.status === 'running';
    x.el.className = 'exec' + (run ? '' : ' done');
    x.el.querySelector('.et').innerHTML = '<b>Executor' + (x.step ? ', step ' + esc(x.step) : '') + ': ' + esc(x.description) + '</b><span>Budget ' + esc(x.budgetMin) + ':00</span>';
    x.el.querySelector('.chip').className = 'chip ' + (run ? 'blue' : x.status === 'done' ? 'ok' : 'bad');
    x.el.querySelector('.chip').innerHTML = (run ? '<i class="pulse"></i>Running' : esc(x.status));
    tickExec(x);
  }

  function handle(e) {
    if (!e || !e.type || seen.indexOf(e) >= 0) return;
    seen.push(e); if (seen.length > 2500) seen.shift();
    var t = e.type;
    if (t === 'assistant.chunk') {
      clearEmpty();
      if (!cur) { var m = claudeMsg('<span class="txt"></span><span class="caret"></span>'); cur = { el: m, text: '' }; add(m); }
      cur.text += e.text || '';
      cur.el.querySelector('.txt').innerHTML = md(cur.text);
      scroll(); return;
    }
    if (t === 'assistant') {
      clearEmpty();
      if (cur) { cur.text = e.text || cur.text; cur.el.querySelector('.txt').innerHTML = md(cur.text); endStream(); }
      else add(claudeMsg(md(e.text || '')));
      scroll(); return;
    }
    if (t === 'turn.start') { endStream(); running = true; badge(); return; }
    if (t === 'turn.end') { endStream(); running = false; badge(); return; }
    if (t === 'user') {
      endStream(); clearEmpty();
      var b = div('ub'); b.textContent = e.text || ''; add(b); return;
    }
    if (t === 'tool.start') {
      endStream(); clearEmpty();
      var d = document.createElement('details'); d.className = 'tc run';
      d.innerHTML = '<summary><span class="tool">' + esc(e.tool) + '</span><span class="sum">' + esc(e.summary) + '</span><span class="chev">&#9656;</span></summary><div class="io">' + toolHtml(e) + '</div>';
      tools[e.id] = d;
      var wrap = div('cm', '<div class="av c" style="visibility:hidden"></div><div class="body"></div>');
      wrap.querySelector('.body').appendChild(d); add(wrap); return;
    }
    if (t === 'tool.result') {
      var c = tools[e.id]; if (!c) return;
      c.classList.remove('run'); if (e.ok === false) c.classList.add('err');
      if (e.summary) c.querySelector('.sum').textContent = (c.querySelector('.sum').textContent + ' (' + e.summary + ')');
      c.querySelector('.io').innerHTML = toolHtml({ input: e.input, output: e.output || e.summary });
      return;
    }
    if (t === 'executor') {
      endStream(); clearEmpty();
      var x = execs[e.id];
      if (!x) {
        x = execs[e.id] = { el: div('exec', '<span class="ring"></span><div class="et"></div><span class="chip"></span>'), start: ts(e.at) || Date.now() };
        var w = div('cm', '<div class="av e">&#10022;</div><div class="body"></div>'); w.querySelector('.body').appendChild(x.el); add(w);
      }
      x.description = e.description || x.description || e.id; x.budgetMin = e.budgetMin || x.budgetMin || 0;
      x.step = e.step || x.step; x.status = e.status || 'running';
      execView(x); return;
    }
    if (t === 'permission') {
      endStream(); clearEmpty();
      if (perms[e.id]) return;
      var cmd = e.input && (e.input.command || e.input.file_path || JSON.stringify(e.input));
      var p = div('perm', '<h4>Claude wants to run ' + esc(e.tool) + '</h4><p class="muted" style="font-size:14px;margin-top:2px">The tool call is paused until you decide.</p><pre>' + esc(cmd || '') + '</pre>' +
        '<div class="acts"><button class="btn pri" data-id="' + esc(e.id) + '" data-d="allow">Allow once</button><button class="btn" data-id="' + esc(e.id) + '" data-d="allowAlways">Always allow</button><button class="btn danger" data-id="' + esc(e.id) + '" data-d="deny">Deny</button></div>');
      perms[e.id] = { el: p, done: false }; add(p); return;
    }
    if (t === 'permission.answered' && perms[e.id] && !perms[e.id].done) { perms[e.id].done = true; perms[e.id].el.classList.add('done'); perms[e.id].el.querySelector('.acts').innerHTML = '<span class="chip">Answered elsewhere</span>'; return; }
    if (t === 'waiting') {
      endStream(); clearEmpty();
      add(div('ask', '<div class="ic">!</div><div><h4>Waiting in the terminal</h4><p class="muted" style="font-size:14.5px">Claude asked you a question: <b>' + esc(e.question) + '</b><br>This kind of question can only be answered in the terminal window. Switch to it, pick an answer, and this page will carry on by itself.</p></div>'));
      return;
    }
  }

  function renderPanel(st) {
    if (!panelEl) return;
    var plan = st && st.plan, steps = plan && plan.steps || [], pr = st && st.progress;
    var h = '<div><h3>Plan progress</h3>';
    if (steps.length) {
      h += '<div class="track">' + steps.map(function (s) {
        var cls = s.status === 'running' ? 'cur' : (s.status === 'pending' || s.status === 'todo') ? 'up' : '';
        var sub = s.status === 'running' ? '<br><span class="muted" style="font-size:13px">running, step ' + esc(s.k) + ' of ' + steps.length + (s.minutes ? ', ' + esc(s.minutes) + ' min budget' : '') + '</span>' : '';
        return '<div class="tn ' + cls + '"><i>&#10022;</i><span>' + (cls === 'cur' ? '<b>' + esc(s.title) + '</b>' : esc(s.title)) + sub + '</span></div>';
      }).join('') + '</div>';
    } else h += '<p class="muted" style="font-size:14px">' + (pr && pr.task ? esc(pr.task) + ': ' + esc(pr.label || '') : 'No plan yet. When Claude plans work in steps, they show up here.') + '</p>';
    h += '</div>';
    var cl = (st && st.cubes && st.cubes.cubes || []).filter(function (c) { return c.status === 'running' || c.status === 'review'; });
    if (cl.length) {
      h += '<div><h3>Active cubes</h3><div class="mini">' + cl.map(function (c) {
        return '<div class="mc"><span class="chip ' + (c.status === 'running' ? 'blue' : 'warn') + '">' + (c.status === 'review' ? 'in review' : esc(c.status)) + '</span><b>' + esc(c.title) + '</b><span class="muted">' + esc(c.action || '') + '</span></div>';
      }).join('') + '</div></div>';
    }
    panelEl.innerHTML = h;
  }

  setInterval(function () {
    if (!built) return;
    Object.keys(execs).forEach(function (k) { if (execs[k].status === 'running') tickExec(execs[k]); });
  }, 1000);

  TP.screens.session = {
    render: function (state) {
      lastState = state;
      if (!built) build();
      renderPanel(state);
      if (!state || !state.progress) return;
      if (state.progress && !state.progress.done && !running && !TP.events.length) { /* idle until events say otherwise */ }
    },
    onEvent: function (ev) {
      if (!built) { build(); return; }
      handle(ev); badge();
    }
  };
})();
