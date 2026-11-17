'use strict';
// Screen: board (cube c11). Kanban columns, filters, drag to move, ticket drawer, new-ticket modal.
// Commands: ticket.move {key,status} | ticket.check {key,index,done} | ticket.comment {key,text}
//           ticket.assign {key,assignee} | ticket.create {type,priority,title,description,checks[],assignee}
(function () {
  var COLS = [['todo', 'To do'], ['doing', 'In progress'], ['review', 'In review'], ['blocked', 'Blocked'], ['done', 'Done']];
  var PRI = { high: 'High', med: 'Medium', low: 'Low' };
  var TYPE_IC = {
    feature: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    bug: '<circle cx="12" cy="13" r="5"/><path d="M12 8V5M7 10L4 8M17 10l3-2M7 15H3M17 15h4M8 19l-2 2M16 19l2 2"/>',
    task: '<path d="M5 12l4.5 4.5L19 7"/>'
  };
  var CHECK_IC = '<path d="M5 12l4.5 4.5L19 7"/>';
  var filt = { q: '', type: '', pri: '', as: '' };
  var moved = {};   // key -> {to, from}: optimistic moves until the state catches up
  var checkOv = {}; // 'KEY:i' -> bool
  var openKey = null, built = false, lastTickets = [], drag = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function svg(p, n) { return '<svg viewBox="0 0 24 24" width="' + (n || 13) + '" height="' + (n || 13) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>'; }
  function colLabel(k) { for (var i = 0; i < COLS.length; i++) if (COLS[i][0] === k) return COLS[i][1]; return k; }

  var CSS = [
    '#screen-board .cols{display:flex;gap:var(--s4);align-items:flex-start;overflow-x:auto;padding-bottom:var(--s4);max-width:100%}',
    '#screen-board .col{flex:0 0 292px;background:var(--bg-1);border-radius:var(--r);padding:var(--s3);min-height:200px;transition:background .15s}',
    '#screen-board .col.over{background:var(--accent-soft)}',
    '#screen-board .col h3{font-size:14px;display:flex;align-items:center;gap:8px;padding:4px 6px 14px;color:var(--muted)}',
    '#screen-board .col h3 em{font-style:normal;background:var(--surface-3);padding:0 9px;border-radius:99px;font-size:12px}',
    '#screen-board .tk{background:var(--surface);border-radius:12px;padding:16px;margin-bottom:12px;cursor:grab;display:flex;flex-direction:column;gap:12px;transition:transform .12s,box-shadow .15s;text-align:left;width:100%;border:0;color:var(--text)}',
    '#screen-board .tk:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(0,0,0,.25)}',
    '#screen-board .tk.dragging{opacity:.45}',
    '#screen-board .tk .r1,#screen-board .tk .r3{display:flex;align-items:center;gap:8px}',
    '#screen-board .tk .key,#tpb-drawer .key{font:600 12px var(--mono);color:var(--muted)}',
    '#screen-board .tk .ti{font-weight:600;line-height:1.4;font-size:15px;overflow-wrap:anywhere}',
    '#screen-board .tk .sp{flex:1}',
    '#screen-board .tkempty{color:var(--faint);font-size:13px;padding:8px 6px}',
    '#screen-board .ty,#tpb-drawer .ty{width:22px;height:22px;border-radius:7px;display:grid;place-items:center;flex:none}',
    '.ty.feature{background:var(--accent-soft);color:var(--shimmer)} .ty.bug{background:var(--danger-soft);color:var(--danger)} .ty.task{background:var(--surface-3);color:var(--muted)}',
    '#screen-board .pr,#tpb-drawer .pr{font-size:12px;font-weight:600} .pr.high{color:var(--danger)} .pr.med{color:var(--warn)} .pr.low{color:var(--faint)}',
    '.tpb-av{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;font-size:12px;font-weight:700;flex:none;background:var(--surface-3);color:var(--text)}',
    '.tpb-av.c{background:var(--grad);color:#fff}',
    '#tpb-modal .acl{display:flex;flex-direction:column;gap:8px} #tpb-modal .acl .row{display:flex;gap:8px;align-items:center} #tpb-modal .acl .field{flex:1}',
    '#tpb-modal .field,#tpb-drawer .field{width:100%}',
    '#tpb-modal .tgl{display:flex;gap:10px;align-items:center;font-size:14px;cursor:pointer}',
    '#tpb-drawer .sec{margin-top:var(--s5)} #tpb-drawer .sec>h4{font-size:14px;color:var(--muted);margin-bottom:var(--s2)}',
    '#tpb-drawer .sec p{overflow-wrap:anywhere;white-space:pre-wrap}',
    '#tpb-drawer .muted{color:var(--muted)}',
    '#tpb-drawer .ac{display:flex;gap:12px;align-items:flex-start;padding:8px 0;cursor:pointer;background:none;border:0;width:100%;text-align:left}',
    '#tpb-drawer .tick{flex:none;width:20px;height:20px;border-radius:6px;border:1.5px solid var(--line-2);display:grid;place-items:center;color:transparent;margin-top:2px}',
    '#tpb-drawer .tick.y{background:var(--ok);border-color:var(--ok);color:#052}',
    '#tpb-drawer .tl>div{padding:8px 0 8px 14px;border-left:2px solid var(--line-2);margin-left:4px;overflow-wrap:anywhere}',
    '#tpb-drawer .tl small{display:block;color:var(--faint);font-size:12px}',
    '#tpb-drawer .asn{display:flex;gap:8px;align-items:center}',
    '#tpb-drawer .note{font-size:12.5px;color:var(--shimmer);margin-top:6px}',
    '#tpb-drawer{z-index:60} #tpb-modal{z-index:60}',
    '@media (max-width:700px){#screen-board .col{flex-basis:262px}#screen-board .filters .field{flex:1 1 140px;min-width:0 !important}#tpb-modal .two{grid-template-columns:1fr}}'
  ].join('\n');

  function injectCss() {
    if (document.getElementById('css-board')) return;
    var s = document.createElement('style'); s.id = 'css-board'; s.textContent = CSS; document.head.appendChild(s);
  }

  // ---- data ----
  function normalize(state) {
    var out = [];
    if (state && Array.isArray(state.tickets)) out = state.tickets.slice();
    else if (state && Array.isArray(state.tasks)) {
      out = state.tasks.map(function (t) {
        return { key: t.id, type: 'task', priority: t.priority || 'med', title: t.title || '', description: t.notes || '', checks: [], assignee: '', status: t.status || 'todo', activity: [] };
      });
    }
    return out.map(function (t) {
      var o = Object.assign({}, t);
      o.checks = (t.checks || []).map(function (c, i) {
        var k = t.key + ':' + i, d = !!c.done;
        if (k in checkOv) { if (checkOv[k] === d) delete checkOv[k]; else d = checkOv[k]; }
        return { text: c.text, done: d };
      });
      var m = moved[t.key];
      if (m) { if (t.status !== m.from) delete moved[t.key]; else o.status = m.to; }
      return o;
    });
  }
  function cols(state) {
    var c = state && Array.isArray(state.columns) && state.columns.length ? state.columns : COLS.map(function (x) { return x[0]; });
    return c;
  }
  function findT(k) { for (var i = 0; i < lastTickets.length; i++) if (lastTickets[i].key === k) return lastTickets[i]; return null; }
  function avatar(a) {
    if (!a) return '<span class="tpb-av" title="Unassigned">?</span>';
    if (a === 'claude') return '<span class="tpb-av c" title="Claude">&#10022;</span>';
    return '<span class="tpb-av" title="' + esc(a) + '">' + esc(String(a).charAt(0).toUpperCase()) + '</span>';
  }
  function tyIc(t) { return '<span class="ty ' + esc(t) + '" title="' + esc(t) + '">' + svg(TYPE_IC[t] || TYPE_IC.task) + '</span>'; }

  // ---- board ----
  function card(t) {
    var n = t.checks.length, d = t.checks.filter(function (c) { return c.done; }).length;
    return '<div class="tk" draggable="true" tabindex="0" role="button" data-key="' + esc(t.key) + '">' +
      '<div class="r1">' + tyIc(t.type) + '<span class="key">' + esc(t.key) + '</span><span class="sp"></span><span class="pr ' + esc(t.priority) + '">' + esc(PRI[t.priority] || t.priority || '') + '</span></div>' +
      '<div class="ti">' + esc(t.title) + '</div>' +
      '<div class="r3">' + (n ? '<div class="bar"><u style="width:' + Math.round(d / n * 100) + '%"></u></div><span class="meta">' + d + '/' + n + '</span>' : '<span class="sp"></span>') + avatar(t.assignee) + '</div></div>';
  }
  function visible(t) {
    var q = filt.q.toLowerCase();
    if (q && (t.title + ' ' + t.key + ' ' + (t.description || '')).toLowerCase().indexOf(q) < 0) return false;
    if (filt.type && t.type !== filt.type) return false;
    if (filt.pri && t.priority !== filt.pri) return false;
    if (filt.as) { var a = t.assignee || ''; if (filt.as === 'none' ? a : a !== filt.as) return false; }
    return true;
  }
  function renderCols(state) {
    var host = document.getElementById('tpb-cols'); if (!host) return;
    var list = lastTickets.filter(visible), keys = cols(state);
    var sx = host.scrollLeft;
    host.innerHTML = keys.map(function (k) {
      var l = list.filter(function (t) { return t.status === k; });
      return '<div class="col" data-col="' + esc(k) + '"><h3>' + esc(colLabel(k)) + '<em>' + l.length + '</em></h3>' +
        (l.length ? l.map(card).join('') : '<div class="tkempty">Nothing here</div>') + '</div>';
    }).join('');
    host.scrollLeft = sx;
  }
  function assignees() {
    var s = {}; lastTickets.forEach(function (t) { if (t.assignee) s[t.assignee] = 1; }); s.claude = 1;
    return Object.keys(s);
  }
  function build(root) {
    root.innerHTML = '<div class="ph"><div><h1>Board</h1><p>Every ticket you hand to Claude. Drag a card to change its stage.</p></div><span class="sp"></span>' +
      '<button class="btn pri" id="tpb-new"><span data-ic="plus"></span>New ticket</button></div>' +
      '<div class="filters"><input class="field" id="tpb-q" placeholder="Search tickets" aria-label="Search tickets" style="min-width:220px">' +
      '<select class="field" id="tpb-a" aria-label="Assignee"></select>' +
      '<select class="field" id="tpb-p" aria-label="Priority"><option value="">Any priority</option><option value="high">High</option><option value="med">Medium</option><option value="low">Low</option></select>' +
      '<select class="field" id="tpb-t" aria-label="Type"><option value="">Any type</option><option value="feature">Feature</option><option value="bug">Bug</option><option value="task">Task</option></select></div>' +
      '<div class="cols" id="tpb-cols"></div>';
    TP.icons(root);
    root.querySelector('#tpb-new').addEventListener('click', function () { TP.newTicket(); });
    var rerender = function () { filt.q = root.querySelector('#tpb-q').value; filt.as = root.querySelector('#tpb-a').value; filt.pri = root.querySelector('#tpb-p').value; filt.type = root.querySelector('#tpb-t').value; renderCols(TP.state); };
    ['#tpb-q', '#tpb-a', '#tpb-p', '#tpb-t'].forEach(function (s) { root.querySelector(s).addEventListener('input', rerender); });
    var cols_ = root.querySelector('#tpb-cols');
    cols_.addEventListener('click', function (e) { var c = e.target.closest('.tk'); if (c) openTicket(c.dataset.key); });
    cols_.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.classList.contains('tk')) openTicket(e.target.dataset.key); });
    cols_.addEventListener('dragstart', function (e) {
      var c = e.target.closest('.tk'); if (!c) return;
      drag = c.dataset.key; c.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', drag); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
    });
    cols_.addEventListener('dragover', function (e) {
      var c = e.target.closest('.col'); if (!c || !drag) return;
      e.preventDefault();
      cols_.querySelectorAll('.col.over').forEach(function (x) { if (x !== c) x.classList.remove('over'); });
      c.classList.add('over');
    });
    cols_.addEventListener('drop', function (e) {
      var c = e.target.closest('.col'); if (!c || !drag) return;
      e.preventDefault(); var k = drag; drag = null; moveTicket(k, c.dataset.col);
    });
    cols_.addEventListener('dragend', function () { drag = null; cols_.querySelectorAll('.over,.dragging').forEach(function (x) { x.classList.remove('over', 'dragging'); }); });
    built = true;
  }
  function syncAssigneeFilter(root) {
    var sel = root.querySelector('#tpb-a'), cur = filt.as;
    var opts = '<option value="">Anyone</option><option value="none">Unassigned</option>' + assignees().map(function (a) { return '<option value="' + esc(a) + '">' + (a === 'claude' ? 'Claude' : esc(a)) + '</option>'; }).join('');
    if (sel.getAttribute('data-sig') !== opts) { sel.innerHTML = opts; sel.setAttribute('data-sig', opts); sel.value = cur; }
  }

  function moveTicket(key, status) {
    var t = findT(key); if (!t || t.status === status) return;
    var from = moved[key] ? moved[key].from : t.status;
    moved[key] = { to: status, from: from };
    t.status = status; renderCols(TP.state);
    if (openKey === key) renderDrawer(true);
    TP.send('ticket.move', { key: key, status: status }).then(function (r) {
      if (!r.ok) { delete moved[key]; var tt = findT(key); if (tt) tt.status = from; renderCols(TP.state); if (openKey === key) renderDrawer(true); }
      else TP.toast(key + ' moved to ' + colLabel(status));
    });
  }

  // ---- overlays ----
  function ensure(id, cls, label) {
    var el = document.getElementById(id);
    if (!el) { el = document.createElement(cls === 'drawer' ? 'aside' : 'div'); el.id = id; el.className = cls; el.setAttribute('aria-label', label); if (cls === 'modal') { el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); } document.body.appendChild(el); }
    return el;
  }
  function closeMine() {
    ['tpb-modal', 'tpb-drawer'].forEach(function (i) { var e = document.getElementById(i); if (e) e.classList.remove('on'); });
    var s = document.getElementById('scrim'); if (s) s.classList.remove('on');
    openKey = null;
  }
  function scrimOn() {
    var s = document.getElementById('scrim');
    if (s) { s.classList.add('on'); if (!s._tpb) { s._tpb = 1; s.addEventListener('click', closeMine); } }
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var d = document.getElementById('tpb-drawer'), m = document.getElementById('tpb-modal');
      if ((d && d.classList.contains('on')) || (m && m.classList.contains('on'))) closeMine();
    }
  });

  function renderDrawer(keepDraft) {
    var t = findT(openKey), el = document.getElementById('tpb-drawer'); if (!t || !el) return;
    var draft = '';
    if (keepDraft) { var c = el.querySelector('#tpb-cm'); if (c) draft = c.value; }
    var asn = assignees();
    if (t.assignee && asn.indexOf(t.assignee) < 0) asn.push(t.assignee);
    var acts = (t.activity || []).slice().reverse();
    el.innerHTML = '<div style="display:flex;align-items:center;gap:10px">' + tyIc(t.type) + '<span class="key">' + esc(t.key) + '</span><span class="pr ' + esc(t.priority) + '" style="margin-left:auto">' + esc(PRI[t.priority] || '') + ' priority</span><button class="btn ghost sm" id="tpb-close" aria-label="Close">Close</button></div>' +
      '<h2>' + esc(t.title) + '</h2>' +
      '<div class="two"><div class="fr"><label for="tpb-st">Status</label><select class="field" id="tpb-st">' + cols(TP.state).map(function (k) { return '<option value="' + esc(k) + '"' + (k === t.status ? ' selected' : '') + '>' + esc(colLabel(k)) + '</option>'; }).join('') + '</select></div>' +
      '<div class="fr"><label for="tpb-as">Assignee</label><select class="field" id="tpb-as"><option value="">Unassigned</option>' + asn.map(function (a) { return '<option value="' + esc(a) + '"' + (a === t.assignee ? ' selected' : '') + '>' + (a === 'claude' ? 'Claude' : esc(a)) + '</option>'; }).join('') + '</select><div class="note" id="tpb-asn" hidden>Claude will receive this ticket as a prompt.</div></div></div>' +
      '<div class="sec"><h4>Description</h4>' + (t.description ? '<p>' + esc(t.description) + '</p>' : '<p class="muted">No description yet.</p>') + '</div>' +
      '<div class="sec"><h4>Acceptance criteria</h4>' + (t.checks.length ? t.checks.map(function (c, i) { return '<button class="ac" data-i="' + i + '"><span class="tick ' + (c.done ? 'y' : '') + '">' + svg(CHECK_IC, 12) + '</span><span>' + esc(c.text) + '</span></button>'; }).join('') : '<p class="muted">No checks.</p>') + '</div>' +
      '<div class="sec"><h4>Activity</h4>' + (acts.length ? '<div class="tl">' + acts.map(function (a) { return '<div><b>' + esc(a.who || '') + '</b> ' + esc(a.text) + '<small>' + esc(a.at ? new Date(a.at).toLocaleString() : '') + '</small></div>'; }).join('') + '</div>' : '<p class="muted">Nothing yet.</p>') + '</div>' +
      '<div class="sec"><h4>Comment</h4><textarea class="field" id="tpb-cm" rows="3" placeholder="Write a comment for this ticket"></textarea><div style="margin-top:12px"><button class="btn pri" id="tpb-send">Add comment</button></div></div>';
    el.querySelector('#tpb-cm').value = draft;
    el.querySelector('#tpb-close').addEventListener('click', closeMine);
    el.querySelector('#tpb-st').addEventListener('change', function (e) { moveTicket(t.key, e.target.value); });
    el.querySelector('#tpb-as').addEventListener('change', function (e) {
      var v = e.target.value; el.querySelector('#tpb-asn').hidden = v !== 'claude';
      t.assignee = v; renderCols(TP.state);
      TP.send('ticket.assign', { key: t.key, assignee: v }).then(function (r) { if (r.ok && v === 'claude') TP.toast(t.key + ' sent to Claude'); });
    });
    el.querySelectorAll('.ac').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = +b.dataset.i, c = t.checks[i], nd = !c.done;
        c.done = nd; checkOv[t.key + ':' + i] = nd; renderDrawer(true); renderCols(TP.state);
        TP.send('ticket.check', { key: t.key, index: i, done: nd }).then(function (r) { if (!r.ok) { c.done = !nd; delete checkOv[t.key + ':' + i]; renderDrawer(true); renderCols(TP.state); } });
      });
    });
    el.querySelector('#tpb-send').addEventListener('click', function () {
      var ta = el.querySelector('#tpb-cm'), text = ta.value.trim(); if (!text) return;
      TP.send('ticket.comment', { key: t.key, text: text }).then(function (r) { if (r.ok) { ta.value = ''; TP.toast('Comment added'); } });
    });
  }
  function openTicket(key) {
    openKey = key;
    var el = ensure('tpb-drawer', 'drawer', 'Ticket detail');
    renderDrawer(false); scrimOn(); el.classList.add('on'); el.scrollTop = 0;
  }

  function createModal() {
    var el = ensure('tpb-modal', 'modal', 'New ticket');
    el.innerHTML = '<h2>New ticket</h2>' +
      '<div class="fr"><label for="tpb-nt">Title</label><input class="field" id="tpb-nt" placeholder="What should be built or fixed?"></div>' +
      '<div class="two"><div class="fr"><label for="tpb-ty">Type</label><select class="field" id="tpb-ty"><option>feature</option><option>bug</option><option>task</option></select></div>' +
      '<div class="fr"><label for="tpb-pr">Priority</label><select class="field" id="tpb-pr"><option>med</option><option>high</option><option>low</option></select></div></div>' +
      '<div class="fr"><label for="tpb-nd">Description</label><textarea class="field" id="tpb-nd" rows="3" placeholder="Give Claude the background"></textarea></div>' +
      '<div class="fr"><span class="lab">Acceptance criteria</span><div class="acl" id="tpb-acl"></div><button class="btn ghost sm" id="tpb-addac" style="align-self:flex-start">+ Add a check</button></div>' +
      '<div class="fr"><label class="tgl"><input type="checkbox" id="tpb-cl"> Assign to Claude (sent to Claude as a prompt)</label></div>' +
      '<div class="mfoot"><button class="btn ghost" id="tpb-cancel">Cancel</button><button class="btn pri" id="tpb-create">Create ticket</button></div>';
    var acl = el.querySelector('#tpb-acl');
    function addRow(v) {
      var r = document.createElement('div'); r.className = 'row';
      r.innerHTML = '<input class="field" placeholder="Something that must be true when done"><button class="btn ghost sm" aria-label="Remove">&times;</button>';
      r.querySelector('input').value = v || '';
      r.querySelector('button').addEventListener('click', function () { r.remove(); });
      acl.appendChild(r); return r;
    }
    addRow();
    el.querySelector('#tpb-addac').addEventListener('click', function () { addRow().querySelector('input').focus(); });
    el.querySelector('#tpb-cancel').addEventListener('click', closeMine);
    el.querySelector('#tpb-create').addEventListener('click', function () {
      var title = el.querySelector('#tpb-nt').value.trim();
      if (!title) { el.querySelector('#tpb-nt').focus(); TP.toast('Give the ticket a title'); return; }
      var checks = [].map.call(acl.querySelectorAll('input'), function (i) { return i.value.trim(); }).filter(Boolean);
      var payload = { type: el.querySelector('#tpb-ty').value, priority: el.querySelector('#tpb-pr').value, title: title, description: el.querySelector('#tpb-nd').value.trim(), checks: checks, assignee: el.querySelector('#tpb-cl').checked ? 'claude' : '' };
      TP.send('ticket.create', payload).then(function (r) { if (r.ok) { closeMine(); TP.toast('Ticket created'); } });
    });
    scrimOn(); el.classList.add('on');
    setTimeout(function () { var i = el.querySelector('#tpb-nt'); if (i) i.focus(); }, 30);
  }
  TP.newTicket = function () { var d = document.getElementById('tpb-drawer'); if (d) d.classList.remove('on'); openKey = null; createModal(); };

  TP.screens.board = {
    render: function (state) {
      injectCss();
      var root = TP.$('screen-board'); if (!root) return;
      if (!built || !document.getElementById('tpb-cols')) build(root);
      lastTickets = normalize(state);
      syncAssigneeFilter(root);
      renderCols(state);
      if (openKey) {
        var ae = document.activeElement, d = document.getElementById('tpb-drawer');
        if (!(d && ae && d.contains(ae) && (ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT'))) renderDrawer(true);
      }
    }
  };
})();
