'use strict';
// Screen: cubes. Stage lanes by dependency depth, cube cards, detail drawer with call graph, review and Ask thread.
(function () {
  var CSS = [
    '#screen-cubes .lanes{position:relative;display:flex;gap:72px;width:max-content;min-width:100%;padding-bottom:var(--s4)}',
    '#screen-cubes .lanes svg.deps{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}',
    '#screen-cubes .lane{position:relative;width:360px;display:flex;flex-direction:column;gap:var(--s4)}',
    '#screen-cubes .lane>h3{font-size:15px;color:var(--muted);display:flex;align-items:center;gap:8px}',
    '#screen-cubes .lane>h3 b{color:var(--star)}',
    '#screen-cubes .cube{position:relative;background:var(--surface);border-radius:var(--r);padding:var(--s4);padding-top:calc(var(--s4) + 6px);overflow:hidden;display:flex;flex-direction:column;gap:var(--s3);box-shadow:0 8px 28px rgba(0,0,0,.18);z-index:1}',
    '#screen-cubes .cube::before{content:"";position:absolute;left:0;right:0;top:0;height:6px;background:var(--bc,var(--faint))}',
    '#screen-cubes .cube.proposed,#screen-cubes .cube.rejected{--bc:var(--faint)} #screen-cubes .cube.approved,#screen-cubes .cube.queued{--bc:var(--star)} #screen-cubes .cube.running{--bc:var(--cur)} #screen-cubes .cube.reviewing{--bc:var(--warn)} #screen-cubes .cube.changes{--bc:var(--danger)} #screen-cubes .cube.done{--bc:var(--ok)}',
    '#screen-cubes .cube .h{display:flex;align-items:center;gap:var(--s2)}',
    '#screen-cubes .sp{flex:1}',
    '#screen-cubes .cube h4{font-size:17px;line-height:1.35;overflow-wrap:anywhere}',
    '#screen-cubes .cube .act{color:var(--muted);font-size:14px;overflow-wrap:anywhere}',
    '#screen-cubes .dw,.cdrawer .dw{background:var(--surface-2);border-radius:10px;padding:12px 14px;font-size:13.5px;overflow-wrap:anywhere}',
    '#screen-cubes .dw b,.cdrawer .dw b{display:block;font-size:12px;color:var(--faint);margin-bottom:2px}',
    '.cdrawer .flow{display:flex;flex-direction:column;gap:2px} #screen-cubes .flow{display:flex;flex-direction:column;gap:2px}',
    '#screen-cubes .fn,.cdrawer .fn{display:flex;gap:12px;padding:8px 0;position:relative}',
    '#screen-cubes .fn+.fn::before,.cdrawer .fn+.fn::before{content:"";position:absolute;left:5px;top:-10px;height:14px;width:2px;background:var(--line-2)}',
    '#screen-cubes .fn i,.cdrawer .fn i{flex:none;width:12px;height:12px;border-radius:50%;margin-top:6px;background:var(--fc)}',
    '#screen-cubes .fn .l,.cdrawer .fn .l{min-width:0}',
    '#screen-cubes .fn code,.cdrawer .fn code{font:12.5px var(--mono);word-break:break-all}',
    '#screen-cubes .fn code b,.cdrawer .fn code b{color:var(--fc);font-weight:600}',
    '#screen-cubes .fn .d,.cdrawer .fn .d{font-size:13px;color:var(--muted)}',
    '#screen-cubes .cube .act{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}#screen-cubes .cube.open .act{display:none}',
    '#screen-cubes .tog{flex:none;width:28px;height:28px;border-radius:50%;border:1px solid var(--line-2);background:var(--surface-2);color:var(--muted);font-size:13px;line-height:1;display:inline-flex;align-items:center;justify-content:center;padding:0;transition:transform .2s,background .15s,border-color .15s,color .15s}',
    '#screen-cubes .tog:hover{background:var(--surface-3);border-color:var(--star);color:var(--text)}#screen-cubes .cube.open .tog{transform:rotate(90deg)}',
    '#screen-cubes .desc{display:grid;grid-template-rows:0fr;transition:grid-template-rows .2s ease;margin-top:calc(var(--s3) * -1)}#screen-cubes .cube.open .desc{grid-template-rows:1fr;margin-top:0}',
    '#screen-cubes .descin{overflow:hidden;min-height:0;display:flex;flex-direction:column;gap:var(--s3)}',
    '#screen-cubes .dsec b{display:block;font-size:12px;color:var(--faint);margin-bottom:2px}#screen-cubes .dsec p{font-size:13.5px;color:var(--muted);overflow-wrap:anywhere}',
    '#screen-cubes .dsec h5,.cdrawer .dsec h5{font-size:12px;font-weight:600;color:var(--faint);margin:0 0 4px}',
    '#screen-cubes .dsec ul,#screen-cubes .dsec ol,.cdrawer .dsec ul,.cdrawer .dsec ol{margin:0;padding-left:20px;font-size:13.5px;color:var(--muted);display:flex;flex-direction:column;gap:3px}',
    '#screen-cubes .dsec li,.cdrawer .dsec li{overflow-wrap:anywhere}',
    '#screen-cubes .dsec p,.cdrawer .dsec p{margin:0;font-size:13.5px;color:var(--muted);overflow-wrap:anywhere}',
    '#screen-cubes .ct,.cdrawer .ct{display:flex;flex-direction:column;gap:2px;padding:6px 0;border-top:1px solid var(--line)}#screen-cubes .ct:first-of-type,.cdrawer .ct:first-of-type{border-top:0}',
    '#screen-cubes .ct code,.cdrawer .ct code{font:12.5px var(--mono);overflow-wrap:anywhere;word-break:break-word;color:var(--text)}',
    '#screen-cubes .ct code span,.cdrawer .ct code span{color:var(--faint)}',
    '#screen-cubes .ct .cc,.cdrawer .ct .cc{font-size:13px;color:var(--muted);overflow-wrap:anywhere}',
    '#screen-cubes .rsum{font-size:13.5px;color:var(--muted);overflow-wrap:anywhere}',
    '@media (prefers-reduced-motion:reduce){#screen-cubes .desc,#screen-cubes .tog{transition:none}}',
    '#screen-cubes .more{border:0;background:transparent;color:var(--shimmer);font-weight:600;font-size:13px;padding:6px 0;text-align:left}',
    '#screen-cubes .life,.cdrawer .life{display:flex;gap:4px;align-items:center}',
    '#screen-cubes .life i,.cdrawer .life i{flex:1;height:4px;border-radius:2px;background:var(--surface-3)}',
    '#screen-cubes .life i.on,.cdrawer .life i.on{background:var(--bc)} #screen-cubes .life i.now,.cdrawer .life i.now{background:var(--bc);box-shadow:0 0 8px var(--bc)}',
    '#screen-cubes .lifelab,.cdrawer .lifelab{display:flex;justify-content:space-between;font-size:11.5px;color:var(--faint);margin-top:4px}',
    '#screen-cubes .rev,.cdrawer .rev{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;border-radius:10px;background:var(--surface-2)}',
    '#screen-cubes .sev,.cdrawer .sev{font:700 11.5px var(--mono);padding:2px 8px;border-radius:6px}',
    '.sev.P0{background:var(--danger);color:#2a0606} .sev.P1{background:#FB923C;color:#2a1200} .sev.P2{background:var(--warn);color:#2a1a00} .sev.P3{background:var(--surface-3);color:var(--muted)}',
    '#screen-cubes .sevn,.cdrawer .sevn{font-size:13px;color:var(--muted)}',
    '#screen-cubes .cact{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap}',
    '#screen-cubes .ldeps{font-size:12.5px;color:var(--faint)}',
    '#screen-cubes .cempty{color:var(--muted)}',
    '.cdrawer .fgroup{margin-bottom:var(--s4)}',
    '.cdrawer .fgroup>.gh{font:600 13px var(--mono);margin-bottom:6px;display:flex;align-items:center;gap:8px;color:var(--fc);overflow-wrap:anywhere}',
    '.cdrawer .fgroup>.gh::before{content:"";flex:none;width:12px;height:12px;border-radius:4px;background:var(--fc)}',
    '.cdrawer .thr{display:flex;flex-direction:column;gap:12px;margin-bottom:var(--s3)}',
    '.cdrawer .bub{padding:12px 16px;border-radius:14px;background:var(--surface-2);font-size:14px;max-width:92%;overflow-wrap:anywhere;white-space:pre-wrap}',
    '.cdrawer .bub.me{align-self:flex-end;background:var(--accent-soft)}',
    '.cdrawer .hd{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
    '.cdrawer .fd{padding:10px 0;border-top:1px solid var(--line);font-size:13.5px}',
    '.cdrawer .fd .t{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.cdrawer .q{margin-top:var(--s3)} .cdrawer .q h5{margin:0 0 6px;font-size:14px}',
    '.cdrawer .opt{display:block;width:100%;text-align:left;padding:8px 12px;margin-bottom:6px;border-radius:10px;border:1px solid var(--line-2);background:var(--surface-2);font-size:13.5px}',
    '.cdrawer .opt.right{border-color:var(--ok);background:var(--ok-soft)} .cdrawer .opt.wrong{border-color:var(--danger);background:var(--danger-soft)}',
    '.cdrawer .drow{display:flex;gap:8px;flex-wrap:wrap;margin-top:var(--s3)}',
    '.cdrawer .x{position:absolute;top:14px;right:14px}',
    '.cdrawer{position:fixed}',
    '@media (max-width:640px){#screen-cubes .lanes{gap:48px}#screen-cubes .lane{width:min(320px,82vw)}.cdrawer{padding:var(--s4)}}'
  ].join('\n');

  var SLAB = { proposed: 'Proposed', approved: 'Approved', queued: 'Queued', running: 'Running', reviewing: 'PR review', done: 'Done', failed: 'Failed', skipped: 'Skipped', rejected: 'Rejected', revising: 'Revising' };
  var SCHIP = { proposed: '', approved: 'blue', queued: 'blue', running: 'blue', reviewing: 'warn', done: 'ok', failed: 'bad', skipped: '', rejected: 'bad', revising: 'warn' };
  var LIFE = { proposed: 0, rejected: 0, failed: 0, skipped: 0, revising: 0, approved: 1, queued: 1, running: 2, reviewing: 3, done: 5 };
  var PAL = ['#7DD3FC', '#A5B4FC', '#5EEAB4', '#F59E0B', '#F472B6', '#FB923C', '#C4B5FD', '#86EFAC'];
  var colors = {};
  function loadOpen() {
    try { var o = JSON.parse(localStorage.getItem('tp.cubes.open') || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
  }
  function saveOpen() { try { localStorage.setItem('tp.cubes.open', JSON.stringify(openCards)); } catch (e) {} }
  var openCards = loadOpen(), openId = null, confirming = {}, drawer = null, askText = '', cubesById = {}, qaMap = {};

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function fcol(f) {
    f = String(f || '');
    if (!colors[f]) { var n = 0; for (var i = 0; i < f.length; i++) n = (n * 31 + f.charCodeAt(i)) >>> 0; colors[f] = PAL[n % PAL.length]; }
    return colors[f];
  }
  var lastList = [];
  // The chip text: a queued cube names the cubes it still waits for.
  function chipText(c) {
    var st = status(c);
    if (st !== 'queued') return SLAB[st];
    var w = arr(c.after).filter(function (a) { var d = lastList.filter(function (x) { return x.id === a; })[0]; return d && d.status !== 'done'; });
    return w.length ? 'Approved · starts after ' + w.join(', ') : SLAB[st];
  }
  function status(c) { return SLAB[c.status] ? c.status : 'proposed'; }

  function flowObj(s) {
    if (s && typeof s === 'object') return { file: String(s.file || ''), fn: String(s.fn || ''), does: String(s.does || ''), calls: String(s.calls || '') };
    var t = String(s == null ? '' : s), m = t.match(/^\s*([^\s:()]+?)\s*(?:[:›>]|\s)\s*([\w.$]+)\(?\)?\s*(?:[-–:]\s*(.*))?$/);
    if (m && /[./]/.test(m[1])) return { file: m[1], fn: m[2], does: m[3] || '', calls: '' };
    return { file: '', fn: '', does: t, calls: '' };
  }
  function flowOf(c) { return arr(c.flow).map(flowObj); }

  function cubeList(state) {
    var cs = state && state.cubes;
    if (Array.isArray(cs)) return cs;
    return arr(cs && cs.cubes);
  }

  function depths(list) {
    var by = {}, memo = {};
    list.forEach(function (c) { by[c.id] = c; });
    function d(id, seen) {
      if (memo[id] != null) return memo[id];
      if (!by[id] || seen[id]) return 0;
      seen[id] = 1;
      var m = 0;
      arr(by[id].after).forEach(function (a) { if (by[a]) m = Math.max(m, d(a, seen) + 1); });
      delete seen[id];
      return (memo[id] = m);
    }
    list.forEach(function (c) { d(c.id, {}); });
    return memo;
  }

  function columns(state, list) {
    var lanes = state && state.cubes && state.cubes.lanes, ids = {};
    list.forEach(function (c) { ids[c.id] = c; });
    if (Array.isArray(lanes) && lanes.length) {
      var cols = lanes.map(function (l) { return arr(l).filter(function (id) { return ids[id]; }).map(function (id) { return ids[id]; }); });
      var seen = {};
      cols.forEach(function (c) { c.forEach(function (x) { seen[x.id] = 1; }); });
      var rest = list.filter(function (c) { return !seen[c.id]; });
      if (rest.length) cols.push(rest);
      cols = cols.filter(function (c) { return c.length; });
      if (cols.length) return cols;
    }
    var dm = depths(list), out = [];
    list.forEach(function (c) { var k = dm[c.id] || 0; (out[k] = out[k] || []).push(c); });
    return out.filter(function (x) { return x && x.length; });
  }

  function renderFlow(c, full) {
    var steps = flowOf(c), n = steps.length;
    if (!n) return '';
    var show = full || n <= 3 ? n : 3, h = '<div class="flow">';
    steps.slice(0, show).forEach(function (s) {
      h += '<div class="fn" style="--fc:' + fcol(s.file || '') + '"><i></i><div class="l"><code>' + (s.file ? esc(s.file) + ' &rsaquo; ' : '') + '<b>' + esc(s.fn ? s.fn + '()' : '') + '</b></code>' + (s.does ? '<div class="d">' + esc(s.does) + '</div>' : '') + '</div></div>';
    });
    h += '</div>';
    if (show < n) h += '<button class="more" data-cact="open" data-id="' + esc(c.id) + '">+' + (n - show) + ' more steps</button>';
    return h;
  }

  function lifeHtml(c) {
    var st = status(c), idx = LIFE[st], s = '<div class="life">';
    for (var i = 0; i < 6; i++) s += '<i class="' + (i < idx ? 'on' : (i === idx && st !== 'done' ? 'now' : (i <= idx ? 'on' : ''))) + '"></i>';
    return s + '</div><div class="lifelab"><span>Proposed</span><span>Running</span><span>PR review</span><span>Done</span></div>';
  }

  function sevCounts(r) {
    var n = { P0: 0, P1: 0, P2: 0, P3: 0 };
    arr(r && r.findings).forEach(function (f) { if (n[f.severity] != null) n[f.severity]++; });
    return n;
  }
  function verdictLabel(v) { return String(v || '').replace(/_/g, ' ').toUpperCase(); }
  function revBadge(c) {
    var r = c.review;
    if (!r || (!r.verdict && !r.status)) return '';
    if (!r.verdict) return '<div class="rev"><span class="chip warn">PR review: ' + esc(r.status === 'running' ? 'running' : r.status) + '</span></div>';
    var v = verdictLabel(r.verdict), cl = v === 'APPROVE' ? 'ok' : v === 'REQUEST CHANGES' ? 'warn' : 'blue', n = sevCounts(r);
    return '<div class="rev"><span class="chip ' + cl + '">PR review: ' + esc(v) + '</span>' + ['P0', 'P1', 'P2', 'P3'].map(function (s) {
      return '<span><span class="sev ' + s + '">' + s + '</span> <span class="sevn">' + n[s] + '</span></span>';
    }).join('') + '</div>';
  }

  // Description sections: summary (fallback details/action/title), problem, steps, code touched.
  function strs(x) { return arr(x).map(function (v) { return String(v == null ? '' : v).trim(); }).filter(Boolean); }
  function codeItems(c) {
    return arr(c.code).map(function (x) {
      if (x && typeof x === 'object') return { file: String(x.file || ''), change: String(x.change || '') };
      return { file: String(x == null ? '' : x), change: '' };
    }).filter(function (x) { return x.file || x.change; });
  }
  function shortText(c) { return c.summary || c.action || ''; }
  function descHtml(c) {
    var h = '<div class="dsec"><h5>Summary</h5><p>' + esc(c.summary || c.details || c.action || c.title) + '</p></div>';
    var pr = strs(c.problem), st = strs(c.steps), cd = codeItems(c);
    if (pr.length) h += '<div class="dsec"><h5>Problem</h5><ul>' + pr.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>';
    if (st.length) h += '<div class="dsec"><h5>Steps</h5><ol>' + st.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol></div>';
    if (cd.length) h += '<div class="dsec"><h5>Code touched</h5>' + cd.map(function (x) {
      var parts = x.file.split(' › '), f = parts.shift(), fn = parts.join(' › ');
      return '<div class="ct"><code>' + esc(f) + (fn ? '<span> &rsaquo; ' + esc(fn) + '</span>' : '') + '</code>' + (x.change ? '<div class="cc">' + esc(x.change) + '</div>' : '') + '</div>';
    }).join('') + '</div>';
    return h;
  }

  function cubeCard(c) {
    var st = status(c), id = esc(c.id), prim;
    if (st === 'proposed' || st === 'rejected' || st === 'failed') prim = '<button class="btn pri" data-cact="approve" data-id="' + id + '">Approve</button>';
    else if (st === 'reviewing') prim = '<button class="btn pri" data-cact="open" data-id="' + id + '">Read PR review</button>';
    else prim = '<button class="btn pri" data-cact="open" data-id="' + id + '">Open details</button>';
    var cls = st === 'reviewing' && c.review && /REQUEST/.test(verdictLabel(c.review.verdict)) ? 'changes' : st;
    var isOpen = !!openCards[c.id];
    return '<article class="cube ' + cls + (isOpen ? ' open' : '') + '" id="cube-' + id + '"><div class="h"><span class="cid">' + id + '</span><span class="chip ' + SCHIP[st] + '">' + esc(chipText(c)) + '</span><span class="sp"></span>' +
      (c.minutes ? '<span class="faint" style="font-size:13px">' + esc(c.minutes) + ' min</span>' : '') +
      '<button class="tog" data-cact="toggle" data-id="' + id + '" aria-expanded="' + isOpen + '" aria-label="' + (isOpen ? 'Hide' : 'Show') + ' description">&#9656;</button></div>' +
      '<h4>' + esc(c.title) + '</h4>' + (shortText(c) ? '<p class="act">' + esc(shortText(c)) + '</p>' : '') +
      '<div class="desc"><div class="descin">' + descHtml(c) +
      (c.doneWhen ? '<div class="dw"><b>Done when</b>' + esc(c.doneWhen) + '</div>' : '') +
      renderFlow(c, true) + revBadge(c) + (c.review && c.review.summary ? '<p class="rsum">' + esc(c.review.summary) + '</p>' : '') + '</div></div>' +
      lifeHtml(c) +
      '<div class="cact">' + prim + '<button class="btn" data-cact="ask" data-id="' + id + '">Ask</button></div></article>';
  }

  function drawDeps(root) {
    var svg = root.querySelector('svg.deps'), wr = root.querySelector('.lanes');
    if (!svg || !wr || root.hidden) return;
    var box = wr.getBoundingClientRect(), p = '';
    (root._list || []).forEach(function (c) {
      arr(c.after).forEach(function (a) {
        var s = root.querySelector('#cube-' + CSS_esc(a)), d = root.querySelector('#cube-' + CSS_esc(c.id));
        if (!s || !d) return;
        var sr = s.getBoundingClientRect(), dr = d.getBoundingClientRect();
        if (sr.right > dr.left - 10) return;
        var x1 = sr.right - box.left, y1 = sr.top + 40 - box.top, x2 = dr.left - box.left, y2 = dr.top + 40 - box.top, m = (x2 - x1) / 2;
        p += '<path d="M' + x1 + ' ' + y1 + ' C' + (x1 + m) + ' ' + y1 + ',' + (x2 - m) + ' ' + y2 + ',' + (x2 - 6) + ' ' + y2 + '" fill="none" stroke="var(--star)" stroke-opacity=".55" stroke-width="2" stroke-dasharray="5 5"/>' +
          '<path d="M' + (x2 - 10) + ' ' + (y2 - 5) + ' L' + x2 + ' ' + y2 + ' L' + (x2 - 10) + ' ' + (y2 + 5) + '" fill="none" stroke="var(--star)" stroke-width="2"/>';
      });
    });
    svg.innerHTML = p;
  }
  function CSS_esc(s) { return String(s).replace(/[^\w-]/g, '\\$&'); }

  function ensureCss() {
    if (document.getElementById('css-cubes')) return;
    var st = document.createElement('style'); st.id = 'css-cubes'; st.textContent = CSS; document.head.appendChild(st);
  }

  function renderCubes(state) {
    ensureCss();
    var root = TP.$('screen-cubes'); if (!root) return;
    var list = cubeList(state); lastList = list;
    cubesById = {}; list.forEach(function (c) { cubesById[c.id] = c; });
    root._list = list;
    var cs = state && state.cubes, task = cs && !Array.isArray(cs) && cs.task;
    if (!list.length) {
      root._html = null;
      root.innerHTML = '<div class="ph"><div><h1>Cubes</h1><p>Small steps Claude proposes. Approve one and it runs; a PR review checks it before it counts as done.</p></div></div><div class="card cempty"><h3>No cubes planned</h3><p>When Claude plans work in cubes, you will approve them here.</p></div>';
      refreshDrawer();
      return;
    }
    var proposed = list.filter(function (c) { return status(c) === 'proposed'; }).length;
    var cols = columns(state, list);
    var h = '<div class="ph"><div><h1>Cubes' + (task ? ': ' + esc(task) : '') + '</h1><p>Small steps Claude proposes. Approve one and it runs; a PR review checks it before it counts as done.</p></div><span class="sp"></span>' +
      '<button class="btn" data-cact="approveAll"' + (proposed ? '' : ' disabled') + '>Approve all proposed' + (proposed ? ' (' + proposed + ')' : '') + '</button></div>' +
      '<div style="overflow-x:auto;padding-bottom:8px"><div class="lanes"><svg class="deps"></svg>';
    cols.forEach(function (col, i) {
      h += '<div class="lane"><h3><b>&#10022;</b>Stage ' + (i + 1) + '</h3>' + col.map(cubeCard).join('') + '</div>';
    });
    h += '</div></div>';
    if (root._html !== h) {
      var sc = root.scrollTop, lw = root.querySelector('.lanes') && root.querySelector('.lanes').parentNode, sl = lw ? lw.scrollLeft : 0;
      root._html = h;
      root.innerHTML = h;
      root.scrollTop = sc;
      var lw2 = root.querySelector('.lanes'); if (lw2 && lw2.parentNode) lw2.parentNode.scrollLeft = sl;
      requestAnimationFrame(function () { drawDeps(root); });
    }
    refreshDrawer();
  }

  // ---- detail drawer ----
  function ensureDrawer() {
    if (drawer) return drawer;
    drawer = document.createElement('aside');
    drawer.className = 'drawer cdrawer'; drawer.id = 'drawer-cubes'; drawer.setAttribute('aria-label', 'Cube detail');
    document.body.appendChild(drawer);
    drawer.addEventListener('click', onClick);
    drawer.addEventListener('input', function (e) { if (e.target.id === 'cube-ask') askText = e.target.value; });
    return drawer;
  }

  function drawerHtml(c) {
    var st = status(c), id = esc(c.id), steps = flowOf(c), groups = {}, order = [];
    steps.forEach(function (s) { var k = s.file || 'other'; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(s); });
    var ctx = {}; // style var on drawer root for bc
    var bc = { proposed: 'var(--faint)', rejected: 'var(--faint)', approved: 'var(--star)', queued: 'var(--star)', running: 'var(--cur)', reviewing: 'var(--warn)', done: 'var(--ok)' }[st];
    var h = '<div style="--bc:' + bc + '"><button class="btn ghost sm x" data-cact="close" aria-label="Close">Close</button>' +
      '<div class="hd"><span class="cid">' + id + '</span><span class="chip ' + SCHIP[st] + '">' + esc(chipText(c)) + '</span>' +
      (c.minutes ? '<span class="faint">' + esc(c.minutes) + ' min</span>' : '') + '</div><h2>' + esc(c.title) + '</h2>';
    if (shortText(c)) h += '<p class="muted">' + esc(shortText(c)) + '</p>';
    if (c.summary || c.details || arr(c.problem).length || arr(c.steps).length || codeItems(c).length) h += '<div class="sec" style="display:flex;flex-direction:column;gap:var(--s3)">' + descHtml(c) + '</div>';
    var acts = '';
    if (st === 'proposed' || st === 'rejected' || st === 'failed') acts += '<button class="btn pri sm" data-cact="approve" data-id="' + id + '">Approve</button>';
    if (st === 'reviewing') acts += '<button class="btn pri sm" data-cact="markDone" data-id="' + id + '">Mark done</button>';
    if (st === 'done' || st === 'reviewing') acts += '<button class="btn sm" data-cact="review" data-id="' + id + '">Run review</button>';
    if (st === 'proposed' || st === 'rejected' || st === 'approved') {
      var cf = confirming[c.id];
      if (cf) acts += '<span class="chip bad">' + (cf === 'reject' ? 'Reject' : 'Delete') + ' ' + id + '?</span><button class="btn danger sm" data-cact="yes" data-id="' + id + '">Yes</button><button class="btn sm" data-cact="no" data-id="' + id + '">No</button>';
      else {
        if (st !== 'rejected') acts += '<button class="btn sm" data-cact="rejectAsk" data-id="' + id + '">Reject</button>';
        acts += '<button class="btn danger sm" data-cact="deleteAsk" data-id="' + id + '">Delete</button>';
      }
    }
    if (acts) h += '<div class="drow">' + acts + '</div>';
    if (c.doneWhen) h += '<div class="sec"><div class="dw"><b>Done when</b>' + esc(c.doneWhen) + '</div></div>';
    if (arr(c.after).length) h += '<div class="sec"><h4>Runs after</h4><div class="hd">' + arr(c.after).map(function (a) { return '<span class="cid">' + esc(a) + '</span>'; }).join('') + '</div></div>';
    if (steps.length) {
      h += '<div class="sec"><h4>Call graph</h4>' + order.map(function (f) {
        return '<div class="fgroup" style="--fc:' + fcol(f === 'other' ? '' : f) + '"><div class="gh">' + esc(f) + '</div>' + groups[f].map(function (s) {
          return '<div class="fn" style="--fc:' + fcol(f === 'other' ? '' : f) + '"><i></i><div class="l"><code><b>' + esc(s.fn ? s.fn + '()' : '') + '</b></code>' + (s.calls ? ' <span class="faint" style="font-size:12px">calls ' + esc(s.calls) + '</span>' : '') + (s.does ? '<div class="d">' + esc(s.does) + '</div>' : '') + '</div></div>';
        }).join('') + '</div>';
      }).join('') + '</div>';
    }
    h += '<div class="sec"><h4>Progress</h4>' + lifeHtml(c) + '</div>';
    h += '<div class="sec"><h4>PR review</h4>' + reviewHtml(c) + '</div>';
    var th = arr(c.thread);
    h += '<div class="sec"><h4>Ask about this cube</h4><p class="muted" style="font-size:13.5px;margin-bottom:var(--s3)">Questions only. Asking never changes the cube; use Request change for that.</p>' +
      '<div class="thr">' + (th.length ? th.map(function (m) { return '<div class="bub' + (m.role === 'user' ? ' me' : '') + '">' + esc(m.text) + '</div>'; }).join('') : '<div class="faint" style="font-size:13px">No questions yet.</div>') + '</div>' +
      '<textarea class="field" id="cube-ask" rows="2" placeholder="Ask a question">' + esc(askText) + '</textarea>' +
      '<div class="drow"><button class="btn pri sm" data-cact="sendAsk" data-id="' + id + '">Ask Claude</button><button class="btn sm" data-cact="sendChange" data-id="' + id + '">Request change</button></div></div></div>';
    return h;
  }

  function reviewHtml(c) {
    var r = c.review;
    if (!r || (!r.verdict && !r.summary)) return '<p class="muted" style="font-size:14px">No review yet. It runs automatically when this cube finishes.</p>';
    var h = revBadge(c);
    if (r.summary) h += '<p class="muted" style="font-size:14px;margin-top:var(--s3);overflow-wrap:anywhere">' + esc(r.summary) + '</p>';
    if (r.understanding) h += '<p style="font-size:13.5px;margin-top:var(--s2);overflow-wrap:anywhere"><b>What it does:</b> ' + esc(r.understanding) + '</p>';
    arr(r.findings).forEach(function (f) {
      h += '<div class="fd"><div class="t"><span class="sev ' + esc(f.severity) + '">' + esc(f.severity) + '</span>' + (f.file ? '<span class="mono faint">' + esc(f.file) + (f.line ? ':' + esc(f.line) : '') + '</span>' : '') + '</div><div style="margin-top:4px">' + esc(f.summary) + '</div></div>';
    });
    arr(r.quiz).forEach(function (q, qi) {
      h += '<div class="q"><h5>' + (qi + 1) + '. ' + esc(q.q) + '</h5>' + arr(q.options).map(function (o, oi) {
        var a = qaMap[c.id + ':' + qi], cl = a == null ? '' : (oi === q.answer ? 'right' : (oi === a ? 'wrong' : ''));
        return '<button class="opt ' + cl + '" data-cact="quiz" data-id="' + esc(c.id) + '" data-q="' + qi + '" data-o="' + oi + '"' + (a != null ? ' disabled' : '') + '>' + 'ABCD'.charAt(oi) + '. ' + esc(o) + '</button>';
      }).join('') + '</div>';
    });
    return h;
  }

  function openCube(id, focusAsk) {
    var c = cubesById[id]; if (!c) return;
    openId = id;
    var d = ensureDrawer();
    askText = '';
    d.innerHTML = drawerHtml(c);
    d.classList.add('on'); TP.$('scrim').classList.add('on');
    if (focusAsk) setTimeout(function () { var t = TP.$('cube-ask'); if (t) t.focus(); }, 60);
  }

  function refreshDrawer() {
    if (!drawer || !openId || !drawer.classList.contains('on')) return;
    var c = cubesById[openId];
    if (!c) { drawer.classList.remove('on'); return; }
    var ta = TP.$('cube-ask'), focus = ta && document.activeElement === ta, ss = ta ? ta.selectionStart : 0, se = ta ? ta.selectionEnd : 0, sc = drawer.scrollTop;
    drawer.innerHTML = drawerHtml(c);
    drawer.scrollTop = sc;
    if (focus) { var t2 = TP.$('cube-ask'); if (t2) { t2.focus(); t2.setSelectionRange(ss, se); } }
  }

  function cmd(type, payload) {
    return TP.send(type, payload).then(function (r) { if (r && r.ok && !TP.demoMode) TP.toast(r.message || 'Done'); return r; });
  }

  function onClick(e) {
    var b = e.target.closest('[data-cact]'); if (!b) return;
    var a = b.getAttribute('data-cact'), id = b.getAttribute('data-id');
    if (a === 'toggle') {
      var card = b.closest('.cube'); if (!card) return;
      var on = !card.classList.contains('open');
      card.classList.toggle('open', on);
      b.setAttribute('aria-expanded', String(on)); b.setAttribute('aria-label', (on ? 'Hide' : 'Show') + ' description');
      if (on) openCards[id] = 1; else delete openCards[id];
      saveOpen();
      var root = TP.$('screen-cubes'), done = false, fin = function () { if (done) return; done = true; if (root) drawDeps(root); };
      var dsc = card.querySelector('.desc'); if (dsc) dsc.addEventListener('transitionend', fin, { once: true });
      setTimeout(fin, 260);
      return;
    }
    if (a === 'open') return openCube(id);
    if (a === 'ask') return openCube(id, true);
    if (a === 'close') { TP.closeAll(); return; }
    if (a === 'approve') return cmd('cube.approve', { id: id });
    if (a === 'approveAll') return cmd('cube.approveAll', {});
    if (a === 'markDone') return cmd('cube.markDone', { id: id });
    if (a === 'review') return cmd('cube.review', { id: id });
    if (a === 'rejectAsk' || a === 'deleteAsk') { confirming[id] = a === 'rejectAsk' ? 'reject' : 'delete'; return refreshDrawer(); }
    if (a === 'no') { delete confirming[id]; return refreshDrawer(); }
    if (a === 'yes') { var t = confirming[id]; delete confirming[id]; return cmd(t === 'reject' ? 'cube.reject' : 'cube.delete', { id: id }); }
    if (a === 'quiz') {
      var c = cubesById[id]; if (!c) return;
      qaMap[id + ':' + b.getAttribute('data-q')] = +b.getAttribute('data-o');
      return refreshDrawer();
    }
    if (a === 'sendAsk' || a === 'sendChange') {
      var txt = (askText || '').trim();
      if (!txt) { TP.toast(a === 'sendAsk' ? 'Write your question.' : 'Write what should change.'); return; }
      var p = a === 'sendAsk' ? cmd('cube.ask', { id: id, text: txt }) : cmd('cube.requestChange', { id: id, note: txt });
      p.then(function (r) { if (r && r.ok) { askText = ''; var t3 = TP.$('cube-ask'); if (t3) t3.value = ''; } });
    }
  }

  var wired = false;
  TP.screens.cubes = {
    render: function (state) {
      var root = TP.$('screen-cubes');
      if (root && !wired) { root.addEventListener('click', onClick); window.addEventListener('resize', function () { drawDeps(root); }); wired = true; }
      renderCubes(state || {});
    }
  };
  TP.screens.cubes.renderCubes = renderCubes;
  TP.screens.cubes.renderFlow = renderFlow;
  TP.screens.cubes.openCube = openCube;
})();
