'use strict';
// Screen: files (cube c14). Folder tree of changed files + preview (code / diff) + "Open in" menu.
// Commands: file.read {path} -> data.content | file.diff {path} -> data.diff
//           file.open {path, editor:'vscode'|'studio', line?}
(function () {
  var sel = null, mode = 'code', built = false, treeSig = '', files = [];
  var collapsed = {};          // folder -> true
  var cache = {};              // 'path|lastAt' -> {content, diff, state:'loading'|'ok'|'na'}
  var popPath = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ago(t) {
    if (!t) return '';
    var s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function norm(p) { return String(p || '').replace(/\\/g, '/'); }

  var CSS = [
    '#screen-files .fgrid{display:grid;grid-template-columns:340px minmax(0,1fr);gap:var(--s4);height:calc(100% - 100px);min-height:420px}',
    '#screen-files .tree{background:var(--surface);border-radius:var(--r);padding:var(--s3);overflow:auto}',
    '#screen-files .fold{font-weight:600;font-size:13px;color:var(--muted);padding:12px 10px 6px;display:flex;gap:8px;align-items:center;width:100%;border:0;background:transparent;text-align:left;border-radius:8px}',
    '#screen-files .fold:hover{color:var(--text)}',
    '#screen-files .fold .car{display:inline-block;transition:transform .12s;font-size:10px;width:10px}',
    '#screen-files .fold.shut .car{transform:rotate(-90deg)}',
    '#screen-files .fold span.t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
    '#screen-files .fi{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:0;background:transparent;border-radius:10px;text-align:left;color:var(--text)}',
    '#screen-files .fi:hover{background:var(--surface-2)} #screen-files .fi.on{background:var(--accent-soft)}',
    '#screen-files .fi .nm{flex:1;min-width:0;font:13.5px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#screen-files .fi small{color:var(--faint);font-size:12px;white-space:nowrap}',
    '#screen-files .badge{font-size:11px;font-weight:700;padding:1px 8px;border-radius:99px;white-space:nowrap}',
    '#screen-files .badge.new{background:var(--ok-soft);color:var(--ok)} #screen-files .badge.edit{background:var(--accent-soft);color:var(--shimmer)}',
    '#screen-files .prev{background:var(--surface);border-radius:var(--r);display:flex;flex-direction:column;min-height:0;overflow:hidden}',
    '#screen-files .ph2{display:flex;align-items:center;gap:var(--s2);padding:var(--s3) var(--s4);flex-wrap:wrap}',
    '#screen-files .ph2 .sp{flex:1}',
    '#screen-files .ph2 b{font:600 14px var(--mono);overflow-wrap:anywhere}',
    '#screen-files .seg{display:inline-flex;background:var(--surface-2);border-radius:99px;padding:3px}',
    '#screen-files .seg button{border:0;background:transparent;color:var(--muted);padding:5px 14px;border-radius:99px;font-size:13px;font-weight:600}',
    '#screen-files .seg button.on{background:var(--accent-soft);color:var(--text)}',
    '#screen-files .code{flex:1;overflow:auto;background:var(--code);padding:var(--s3) 0;font:13px/1.7 var(--mono)}',
    '#screen-files .code div{display:grid;grid-template-columns:56px 1fr;min-width:max-content}',
    '#screen-files .code .n{color:var(--faint);text-align:right;padding-right:14px;user-select:none}',
    '#screen-files .code .c{white-space:pre;padding-right:16px}',
    '#screen-files .code .add{background:rgba(94,234,180,.1)} #screen-files .code .del{background:rgba(248,113,113,.1)}',
    '#screen-files .code .add .c{color:var(--ok)} #screen-files .code .del .c{color:var(--danger)} #screen-files .code .hh .c{color:var(--shimmer)}',
    '#screen-files .none{flex:1;display:grid;place-items:center;text-align:center;color:var(--muted);padding:var(--s5)}',
    '#screen-files .none h3{color:var(--text);margin-bottom:6px}',
    '#tpf-pop{z-index:85}',
    '@media (max-width:900px){#screen-files .fgrid{grid-template-columns:1fr;height:auto}#screen-files .tree{max-height:240px}#screen-files .prev{min-height:360px}}'
  ].join('\n');
  function injectCss() {
    if (document.getElementById('css-files')) return;
    var s = document.createElement('style'); s.id = 'css-files'; s.textContent = CSS; document.head.appendChild(s);
  }

  function build(root) {
    root.innerHTML = '<div class="ph"><div><h1>Files</h1><p>Everything Claude created or changed in this session.</p></div></div>' +
      '<div class="fgrid"><div class="tree" id="tpf-tree"></div><div class="prev" id="tpf-prev"></div></div>';
    root.querySelector('#tpf-tree').addEventListener('click', function (e) {
      var f = e.target.closest('.fold');
      if (f) { var d = f.dataset.dir; collapsed[d] = !collapsed[d]; treeSig = ''; drawTree(); return; }
      var b = e.target.closest('.fi');
      if (b) { sel = b.dataset.path; mode = 'code'; treeSig = ''; drawTree(); drawPrev(true); }
    });
    root.querySelector('#tpf-prev').addEventListener('click', function (e) {
      var t = e.target.closest('[data-a]'); if (!t) return;
      var a = t.dataset.a;
      if (a === 'mode') { mode = t.dataset.m; drawPrev(true); }
      else if (a === 'copy') {
        try { navigator.clipboard.writeText(sel).then(function () { TP.toast('Path copied'); }, function () { TP.toast('Could not copy'); }); } catch (_) { TP.toast('Could not copy'); }
      } else if (a === 'open') { showPop(t, sel); }
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('#tpf-pop') && !e.target.closest('[data-a="open"]')) hidePop(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hidePop(); });
    built = true;
  }

  // ---- Open in menu ----
  function pop() {
    var p = document.getElementById('tpf-pop');
    if (!p) {
      p = document.createElement('div'); p.id = 'tpf-pop'; p.className = 'pop'; p.setAttribute('role', 'menu');
      p.innerHTML = '<button data-e="vscode" role="menuitem">Open in VS Code</button><button data-e="studio" role="menuitem">Open in Android Studio</button><button data-e="here" role="menuitem">View here</button>';
      p.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        var path = popPath; hidePop();
        if (b.dataset.e === 'here') { mode = 'code'; drawPrev(true); return; }
        TP.send('file.open', { path: path, editor: b.dataset.e }).then(function (r) { if (r && r.ok) TP.toast('Opened ' + path.split('/').pop()); });
      });
      document.body.appendChild(p);
    }
    return p;
  }
  function showPop(btn, path) {
    var p = pop(); popPath = path; p.classList.add('on');
    var r = btn.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
    p.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
    p.style.top = (r.bottom + h + 8 > innerHeight ? r.top - h - 6 : r.bottom + 6) + 'px';
    var f = p.querySelector('button'); if (f) f.focus();
  }
  function hidePop() { var p = document.getElementById('tpf-pop'); if (p) p.classList.remove('on'); }

  // ---- tree ----
  function groups() {
    var g = {}, order = [];
    files.forEach(function (f) {
      var p = norm(f.path), i = p.lastIndexOf('/'), d = i > -1 ? p.slice(0, i) : '.';
      if (!g[d]) { g[d] = []; order.push(d); }
      g[d].push(f);
    });
    order.sort();
    return { g: g, order: order };
  }
  function drawTree() {
    var el = document.getElementById('tpf-tree'); if (!el) return;
    var G = groups();
    var sig = JSON.stringify([sel, collapsed, files.map(function (f) { return [f.path, f.op, f.count, ago(f.lastAt)]; })]);
    if (sig === treeSig) return;
    treeSig = sig;
    var st = el.scrollTop;
    el.innerHTML = files.length ? G.order.map(function (d) {
      var shut = !!collapsed[d];
      return '<button class="fold' + (shut ? ' shut' : '') + '" data-dir="' + esc(d) + '" aria-expanded="' + (!shut) + '"><span class="car">&#9660;</span><span class="t">' + esc(d) + '/</span></button>' +
        (shut ? '' : G.g[d].map(function (f) {
          var p = norm(f.path), isNew = f.op === 'write';
          return '<button class="fi' + (p === sel ? ' on' : '') + '" data-path="' + esc(p) + '"><span class="nm" title="' + esc(p) + '">' + esc(p.split('/').pop()) + '</span>' +
            '<span class="badge ' + (isNew ? 'new' : 'edit') + '">' + (isNew ? 'new' : 'edited' + (f.count > 1 ? ' x' + f.count : '')) + '</span><small>' + esc(ago(f.lastAt)) + '</small></button>';
        }).join(''));
    }).join('') : '<div class="none" style="padding:var(--s5)"><div><h3>No files yet</h3><p>Files Claude changes will show up here.</p></div></div>';
    el.scrollTop = st;
  }

  // ---- preview ----
  function find(p) { for (var i = 0; i < files.length; i++) if (norm(files[i].path) === p) return files[i]; return null; }
  function entry(f) {
    var k = norm(f.path) + '|' + (f.lastAt || '');
    if (!cache[k]) {
      cache[k] = { content: f.content != null ? String(f.content) : null, diff: f.diff != null ? String(f.diff) : null, state: f.content != null ? 'ok' : 'loading', diffTried: f.diff != null };
      if (f.content == null && !TP.demoMode) {
        var c = cache[k];
        TP.send('file.read', { path: f.path }).then(function (r) {
          if (r.ok && r.data && r.data.content != null) { c.content = String(r.data.content); c.state = 'ok'; } else c.state = 'na';
          if (r.data && r.data.diff != null && c.diff == null) c.diff = String(r.data.diff);
          if (norm(f.path) === sel) drawPrev(true);
        });
      } else if (f.content == null) c.state = 'na';
    }
    return cache[k];
  }
  function loadDiff(f, c) {
    if (c.diff != null || c.diffTried || TP.demoMode) return;
    c.diffTried = true;
    TP.send('file.diff', { path: f.path }).then(function (r) {
      if (r.ok && r.data && r.data.diff) c.diff = String(r.data.diff);
      if (norm(f.path) === sel) drawPrev(true);
    });
  }
  function codeHtml(text) {
    return '<div class="code" tabindex="0">' + String(text).replace(/\n$/, '').split('\n').map(function (l, i) {
      return '<div><span class="n">' + (i + 1) + '</span><span class="c">' + esc(l) + '</span></div>';
    }).join('') + '</div>';
  }
  function diffHtml(text) {
    var a = 0, b = 0;
    return '<div class="code" tabindex="0">' + String(text).replace(/\n$/, '').split('\n').map(function (l) {
      var cls = '', n = '';
      if (/^(---|\+\+\+)/.test(l)) cls = 'hh';
      else if (l.charAt(0) === '@') { cls = 'hh'; var m = /@@ -(\d+)[^+]*\+(\d+)/.exec(l); if (m) { a = +m[1]; b = +m[2]; } }
      else if (l.charAt(0) === '+') { cls = 'add'; n = b++; }
      else if (l.charAt(0) === '-') { cls = 'del'; n = a++; }
      else { n = b; a++; b++; }
      return '<div class="' + cls + '"><span class="n">' + n + '</span><span class="c">' + esc(l) + '</span></div>';
    }).join('') + '</div>';
  }
  var prevSig = '';
  function drawPrev(force) {
    var el = document.getElementById('tpf-prev'); if (!el) return;
    var f = sel ? find(sel) : null;
    if (!f) { el.innerHTML = '<div class="none"><div><h3>Pick a file</h3><p>Choose a file on the left to see what it looks like now.</p></div></div>'; prevSig = ''; return; }
    var c = entry(f); loadDiff(f, c);
    var hasDiff = !!c.diff; if (mode === 'diff' && !hasDiff) mode = 'code';
    var sig = JSON.stringify([sel, mode, c.state, c.content, c.diff]);
    if (!force && sig === prevSig) return;
    prevSig = sig;
    var body;
    if (mode === 'diff') body = diffHtml(c.diff);
    else if (c.state === 'ok') body = codeHtml(c.content);
    else if (c.state === 'loading') body = '<div class="none"><p>Loading...</p></div>';
    else body = '<div class="none"><div><h3>Preview not available yet</h3><p>You can still open this file in your editor.</p></div></div>';
    var isNew = f.op === 'write';
    var keep = el.querySelector('.code'), st = keep ? keep.scrollTop : 0, sl = keep ? keep.scrollLeft : 0;
    el.innerHTML = '<div class="ph2"><b>' + esc(norm(f.path)) + '</b><span class="badge ' + (isNew ? 'new' : 'edit') + '">' + (isNew ? 'new' : 'edited') + '</span><span class="sp"></span>' +
      (hasDiff ? '<span class="seg" role="group" aria-label="Preview mode"><button data-a="mode" data-m="code" class="' + (mode === 'code' ? 'on' : '') + '">Code</button><button data-a="mode" data-m="diff" class="' + (mode === 'diff' ? 'on' : '') + '">Diff</button></span>' : '') +
      '<button class="btn sm" data-a="copy">Copy path</button><button class="btn sm" data-a="open" aria-haspopup="menu">Open in <span style="opacity:.7">&#9662;</span></button></div>' + body;
    var nc = el.querySelector('.code'); if (nc && keep) { nc.scrollTop = st; nc.scrollLeft = sl; }
  }

  TP.screens.files = {
    render: function (state) {
      injectCss();
      var root = TP.$('screen-files'); if (!root) return;
      if (!built || !document.getElementById('tpf-tree')) { built = false; treeSig = ''; prevSig = ''; build(root); }
      files = (state && Array.isArray(state.files)) ? state.files : [];
      if (!sel || !find(sel)) sel = files.length ? norm(files[0].path) : null;
      drawTree(); drawPrev(false);
    }
  };
})();
