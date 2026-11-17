'use strict';
// Screen: review (cube c13). Scope picker, verdict strip, tabs Understanding / Findings / Diff / Quiz.
// Commands: cube.review {id} | session.prompt {text} | file.diff {path} (live only; backend may not exist yet)
// Hash sub-routes (for screenshots): #review/findings | /diff | /diff/split | /quiz
(function () {
  var VERD = { APPROVE: ['ap', 'APPROVE'], REQUEST_CHANGES: ['rc', 'REQUEST CHANGES'], NEEDS_INVESTIGATION: ['ni', 'NEEDS INVESTIGATION'] };
  var TABS = [['u', 'Understanding'], ['f', 'Findings'], ['d', 'Diff'], ['q', 'Quiz']];
  var SEVS = ['P0', 'P1', 'P2', 'P3'];
  var ui = { scope: '', tab: 'u', mode: 'u', note: '', choice: 'changes' };
  var comments = {};   // 'path:line' -> text
  var answers = {};    // cubeId -> {qi: oi}
  var diffCache = {};  // path -> diff text fetched from the server
  var asked = {};      // path -> true once file.diff was requested
  var built = false, lastSig = '', lastHash = null, cur = null, curFiles = [], jump = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ago(t) {
    if (!t) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }

  var CSS = [
    '#screen-review .sev{font:700 11.5px var(--mono);padding:2px 8px;border-radius:6px;display:inline-block}',
    '#screen-review .sev.P0{background:var(--danger);color:#2a0606} #screen-review .sev.P1{background:#FB923C;color:#2a1200} #screen-review .sev.P2{background:var(--warn);color:#2a1a00} #screen-review .sev.P3{background:var(--surface-3);color:var(--muted)}',
    '#screen-review .sevn{font-size:13px;color:var(--muted)}',
    '#screen-review .verdict{display:flex;align-items:center;gap:var(--s3);flex-wrap:wrap;margin-bottom:var(--s4)}',
    '#screen-review .vbig{font-weight:750;font-size:18px;padding:8px 18px;border-radius:12px;background:var(--surface-2);color:var(--muted)}',
    '#screen-review .vbig.rc{background:var(--warn-soft);color:var(--warn)} #screen-review .vbig.ap{background:var(--ok-soft);color:var(--ok)} #screen-review .vbig.ni{background:var(--accent-soft);color:var(--shimmer)}',
    '#screen-review .rgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:var(--s4)}',
    '#screen-review .rgrid .card h4{font-size:15px;margin-bottom:8px}',
    '#screen-review .rgrid .card p,#screen-review .rgrid .card li{color:var(--muted);font-size:14.5px;overflow-wrap:anywhere}',
    '#screen-review .rgrid ul{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px}',
    '#screen-review .flowline{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}',
    '#screen-review .fnode{padding:6px 12px;border-radius:99px;background:var(--surface-3);font:12.5px var(--mono)}',
    '#screen-review .finding{background:var(--surface);border-radius:var(--r);padding:var(--s4);margin-bottom:var(--s3);display:flex;flex-direction:column;gap:10px}',
    '#screen-review .finding .t{display:flex;gap:12px;align-items:center;flex-wrap:wrap}',
    '#screen-review .finding .t b{font-size:16px;overflow-wrap:anywhere}',
    '#screen-review .flink{font:13px var(--mono);color:var(--shimmer);background:none;border:0;padding:0;text-decoration:underline;text-underline-offset:3px;align-self:flex-start;text-align:left;overflow-wrap:anywhere}',
    '#screen-review .fgroup{margin-bottom:var(--s4)} #screen-review .fgroup>h3{font-size:14px;color:var(--muted);margin-bottom:var(--s2);display:flex;gap:10px;align-items:center}',
    '#screen-review .dbar{display:flex;gap:10px;margin-bottom:var(--s3);flex-wrap:wrap;align-items:center}',
    '#screen-review .dbar .tabs{margin:0}',
    '#screen-review .revbar{display:flex;gap:var(--s2);flex-wrap:wrap;justify-content:flex-end;align-items:center}',
    '#screen-review .diff{background:var(--code);border-radius:var(--r);overflow:hidden;margin-bottom:var(--s4)}',
    '#screen-review .dfh{display:flex;align-items:center;gap:var(--s2);padding:12px 16px;background:var(--surface-2);font:600 13px var(--mono);flex-wrap:wrap}',
    '#screen-review .dfh .sp{flex:1} #screen-review .dfh .cnt{font-weight:500;color:var(--faint)}',
    '#screen-review .dscroll{overflow-x:auto}',
    '#screen-review .dl{display:grid;grid-template-columns:48px 48px 1fr;font:12.5px/1.65 var(--mono);min-width:0}',
    '#screen-review .dl:hover{background:rgba(125,211,252,.07)}',
    '#screen-review .dl .n{color:var(--faint);text-align:right;padding-right:10px;user-select:none;cursor:pointer}',
    '#screen-review .dl .n:hover{color:var(--shimmer);background:var(--accent-soft)}',
    '#screen-review .dl .n.has{color:var(--warn)}',
    '#screen-review .dl .c{padding:0 12px;white-space:pre-wrap;word-break:break-all;min-width:0}',
    '#screen-review .dl.add{background:rgba(94,234,180,.1)} #screen-review .dl.del{background:rgba(248,113,113,.1)}',
    '#screen-review .dl.add .c::before{content:"+ ";color:var(--ok)} #screen-review .dl.del .c::before{content:"- ";color:var(--danger)} #screen-review .dl.ctx .c::before{content:"  "}',
    '#screen-review .dl.hl,#screen-review .dfh.hl{outline:2px solid var(--shimmer);outline-offset:-2px;background:var(--accent-soft)}',
    '#screen-review .dl.hunk{background:var(--surface-2);color:var(--faint)} #screen-review .dl.hunk .c::before{content:""}',
    '#screen-review .srow{display:grid;grid-template-columns:1fr 1fr} #screen-review .srow .dl{grid-template-columns:44px 1fr} #screen-review .srow .dl+.dl{border-left:1px solid var(--line)}',
    '#screen-review .dl.nul{background:transparent} #screen-review .dl.nul .c::before{content:""}',
    '#screen-review .cmt{margin:6px 12px 10px 60px;padding:12px;border-radius:10px;background:var(--surface-3);font:14px var(--sans);display:flex;gap:8px;align-items:flex-start}',
    '#screen-review .cmt textarea{flex:1;min-height:44px;resize:vertical}',
    '#screen-review .cmt small{color:var(--faint);font:12px var(--mono);display:block;margin-bottom:4px}',
    '#screen-review .tk-s{color:#C084FC} #screen-review .tk-t{color:#7DD3FC} #screen-review .tk-c{color:var(--faint);font-style:italic} #screen-review .tk-n{color:#FBBF24}',
    '#screen-review .q{background:var(--surface);border-radius:var(--r);padding:var(--s4);margin-bottom:var(--s4)}',
    '#screen-review .q h4{font-size:16px;margin-bottom:var(--s3);line-height:1.45}',
    '#screen-review .opt{display:flex;gap:12px;width:100%;text-align:left;padding:14px 16px;border-radius:12px;border:1.5px solid var(--line);background:transparent;margin-bottom:8px}',
    '#screen-review .opt:hover:not(:disabled){border-color:var(--star);background:var(--surface-2)}',
    '#screen-review .opt:disabled{cursor:default}',
    '#screen-review .opt.right{border-color:var(--ok);background:var(--ok-soft)} #screen-review .opt.wrong{border-color:var(--danger);background:var(--danger-soft)}',
    '#screen-review .opt b{font-family:var(--mono);color:var(--faint)}',
    '#screen-review .why{font-size:14px;color:var(--muted);margin-top:8px}',
    '#screen-review .hint{margin-top:var(--s4);padding:var(--s3) var(--s4);border-radius:12px;background:var(--accent-soft);font-size:14.5px}',
    '#screen-review .emptyc{padding:var(--s5);text-align:center;color:var(--muted);background:var(--surface);border-radius:var(--r)}',
    '#screen-review .emptyc h3{color:var(--text);margin-bottom:6px;font-size:17px}',
    '#screen-review .rsel{max-width:340px;min-width:200px}',
    '@media (max-width:700px){#screen-review .srow{grid-template-columns:1fr}#screen-review .srow .dl+.dl{border-left:0}#screen-review .cmt{margin-left:12px}}'
  ].join('\n');
  function injectCss() {
    if (document.getElementById('css-review')) return;
    var s = document.createElement('style'); s.id = 'css-review'; s.textContent = CSS; document.head.appendChild(s);
  }

  // ---- data ----
  function reviewable(c) { return !!(c.review || c.status === 'reviewing' || c.status === 'review'); }
  function cubeList(state) { return state && state.cubes && Array.isArray(state.cubes.cubes) ? state.cubes.cubes.filter(reviewable) : []; }
  function pickDefault(list) {
    var best = null, bt = -1;
    list.forEach(function (c) { var t = c.review && c.review.at ? c.review.at : 0; if (c.status === 'reviewing') t += 1e13; if (t >= bt) { bt = t; best = c; } });
    return best;
  }
  function samePath(a, b) { return a === b || a.slice(-b.length - 1) === '/' + b || b.slice(-a.length - 1) === '/' + a; }
  function cubeFiles(c, state) {
    var all = state && Array.isArray(state.files) ? state.files : [];
    var want = [];
    if (c) {
      ((c.review && c.review.findings) || []).forEach(function (f) { if (f.file) want.push(f.file); });
      (c.flow || []).forEach(function (s) { if (s.file && s.file.indexOf('/') > -1 || (s.file || '').indexOf('.') > -1) want.push(s.file); });
    }
    var out = all.filter(function (f) { return want.some(function (w) { return samePath(f.path, w); }); });
    if (!out.length) out = all.filter(function (f) { return f.diff || diffCache[f.path]; });
    if (!out.length) out = all.slice();
    return out;
  }
  function diffOf(f) { return f.diff || diffCache[f.path] || ''; }

  // ---- diff parsing ----
  function parseDiff(text) {
    var rows = [], o = 0, n = 0, lines = String(text).replace(/\r/g, '').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    var started = false;
    lines.forEach(function (l) {
      var m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
      if (m) { o = +m[1]; n = +m[2]; started = true; rows.push({ t: 'h', text: l }); return; }
      if (!started) return; // file headers (---/+++/diff/index)
      var c = l.charAt(0), tx = l.slice(1);
      if (c === '+') rows.push({ t: 'a', n: n++, text: tx });
      else if (c === '-') rows.push({ t: 'd', o: o++, text: tx });
      else if (c === '\\') return;
      else rows.push({ t: 'c', o: o++, n: n++, text: c === ' ' ? tx : l });
    });
    return rows;
  }
  function tok(s) {
    var e = esc(s);
    return e.replace(/(\/\/.*$)|(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)|\b(export|function|const|var|let|return|if|else|import|from|new|async|await)\b|\b(\d+)\b/g, function (m, c, st, k, n) {
      return c ? '<span class="tk-c">' + c + '</span>' : st ? '<span class="tk-s">' + st + '</span>' : k ? '<span class="tk-t">' + k + '</span>' : '<span class="tk-n">' + n + '</span>';
    });
  }
  function lineKey(path, r) { return path + ':' + (r.n != null ? r.n : '-' + r.o); }
  function lineLabel(k) { return k.replace(/:-(\d+)$/, ' (removed line $1):').replace(/(\d)$/, '$1'); }

  function cmtHtml(k) {
    if (!(k in comments)) return '';
    var human = k.replace(/:-(\d+)$/, ' (old line $1)');
    return '<div class="cmt" data-ck="' + esc(k) + '"><div style="flex:1"><small>Your comment on ' + esc(human) + '</small><textarea class="field" rows="2" placeholder="Tell Claude what to change here" aria-label="Line comment">' + esc(comments[k]) + '</textarea></div><button class="btn ghost sm" data-a="delc" data-k="' + esc(k) + '">Delete</button></div>';
  }
  function numCell(r, k, which) {
    var v = which === 'o' ? r.o : r.n;
    var has = k in comments;
    return '<span class="n' + (has ? ' has' : '') + '" data-a="cmt" data-k="' + esc(k) + '" title="Comment on this line">' + (v == null ? '' : v) + '</span>';
  }
  function diffFileHtml(f) {
    var d = diffOf(f), rows = d ? parseDiff(d) : null, h;
    var nc = 0; Object.keys(comments).forEach(function (k) { if (k.indexOf(f.path + ':') === 0) nc++; });
    h = '<div class="diff" data-path="' + esc(f.path) + '"><div class="dfh"><span>' + esc(f.path) + '</span><span class="cnt">' + esc(f.op || '') + '</span><span class="sp"></span>' + (nc ? '<span class="chip warn">' + nc + ' comment' + (nc > 1 ? 's' : '') + '</span>' : '') + '</div><div class="dscroll">';
    if (!rows) return h + '<div class="emptyc" style="background:transparent">' + (TP.demoMode || asked[f.path] ? 'No diff recorded for this file.' : 'Loading the diff...') + '</div></div></div>';
    if (!rows.length) return h + '<div class="emptyc" style="background:transparent">The diff has no changed lines.</div></div></div>';
    rows.forEach(function (r) {
      if (r.t === 'h') { h += '<div class="dl hunk"><span class="n"></span><span class="n"></span><span class="c">' + esc(r.text) + '</span></div>'; return; }
      var k = lineKey(f.path, r), cls = r.t === 'a' ? 'add' : r.t === 'd' ? 'del' : 'ctx';
      var attr = ' data-lk="' + esc(k) + '"';
      if (ui.mode === 'u') {
        h += '<div class="dl ' + cls + '"' + attr + '>' + numCell(r, k, 'o') + numCell(r, k, 'n') + '<span class="c">' + tok(r.text) + '</span></div>';
      } else {
        var L = r.t === 'a' ? '<div class="dl nul"><span class="n"></span><span class="c"></span></div>' : '<div class="dl ' + (r.t === 'd' ? 'del' : 'ctx') + '"' + attr + '>' + numCell(r, k, 'o') + '<span class="c">' + tok(r.text) + '</span></div>';
        var R = r.t === 'd' ? '<div class="dl nul"><span class="n"></span><span class="c"></span></div>' : '<div class="dl ' + (r.t === 'a' ? 'add' : 'ctx') + '"' + attr + '>' + numCell(r, k, 'n') + '<span class="c">' + tok(r.text) + '</span></div>';
        h += '<div class="srow">' + L + R + '</div>';
      }
      h += cmtHtml(k);
    });
    return h + '</div></div>';
  }

  // ---- tabs ----
  function tabUnderstanding(c) {
    var r = c.review;
    if (!r) return emptyBox('No review yet', 'Press Run PR review to have Claude explain and judge this cube.');
    var fl = (c.flow || []).map(function (s) { return '<span class="fnode">' + esc(String(s.file || '').split('/').pop() + ' ' + (s.fn || '')) + '</span>'; }).join('<span class="faint">&rarr;</span>');
    var seen = {}, look = [];
    (r.findings || []).forEach(function (f) { if (f.file && !seen[f.file]) { seen[f.file] = 1; look.push(f.file + (f.line ? ':' + f.line : '')); } });
    return '<div class="rgrid"><div class="card"><h4>What it does</h4><p>' + (r.understanding ? esc(r.understanding) : 'No explanation recorded.') + '</p></div>' +
      '<div class="card"><h4>What the review found</h4><p>' + (r.summary ? esc(r.summary) : 'No summary recorded.') + '</p></div>' +
      (fl ? '<div class="card" style="grid-column:1/-1"><h4>How it runs</h4><p>The steps this cube plans, in order.</p><div class="flowline">' + fl + '</div></div>' : '') +
      '<div class="card"><h4>Done when</h4><p>' + esc(c.doneWhen || 'Not stated.') + '</p></div>' +
      '<div class="card"><h4>Where a human should look</h4>' + (look.length ? '<ul>' + look.map(function (x) { return '<li class="mono">' + esc(x) + '</li>'; }).join('') + '</ul>' : '<p>Nothing flagged.</p>') + '</div></div>';
  }
  function emptyBox(t, p) { return '<div class="emptyc"><h3>' + esc(t) + '</h3><p>' + esc(p) + '</p></div>'; }
  function tabFindings(c) {
    var r = c.review;
    if (!r) return emptyBox('No review yet', 'Findings appear here once the review has run.');
    var fs = r.findings || [];
    if (!fs.length) return emptyBox('No findings', 'The review found nothing to fix.');
    return SEVS.map(function (s) {
      var l = fs.filter(function (f) { return f.severity === s; });
      if (!l.length) return '';
      return '<div class="fgroup"><h3><span class="sev ' + s + '">' + s + '</span>' + l.length + ' finding' + (l.length > 1 ? 's' : '') + '</h3>' + l.map(function (f) {
        return '<div class="finding"><div class="t"><span class="sev ' + esc(f.severity) + '">' + esc(f.severity) + '</span><b>' + esc(f.summary) + '</b></div>' +
          (f.file ? '<button class="flink" data-a="jump" data-f="' + esc(f.file) + '" data-l="' + esc(f.line || '') + '">' + esc(f.file) + (f.line ? ':' + esc(f.line) : '') + '</button>' : '') + '</div>';
      }).join('') + '</div>';
    }).join('');
  }
  function tabDiff() {
    var bar = '<div class="dbar"><div class="tabs"><button data-a="mode" data-m="u" class="' + (ui.mode === 'u' ? 'on' : '') + '">Unified</button><button data-a="mode" data-m="s" class="' + (ui.mode === 's' ? 'on' : '') + '">Split</button></div>' +
      '<span class="faint" style="font-size:13.5px">Click a line number to leave a comment.</span><span style="flex:1"></span>' +
      '<div class="revbar"><select class="field" data-a="choice" aria-label="Verdict note"><option value="changes"' + (ui.choice === 'changes' ? ' selected' : '') + '>Verdict: changes needed</option><option value="approve"' + (ui.choice === 'approve' ? ' selected' : '') + '>Verdict: looks good</option><option value="comment"' + (ui.choice === 'comment' ? ' selected' : '') + '>Verdict: comments only</option></select>' +
      '<button class="btn pri" data-a="send">Send review to Claude</button></div></div>' +
      '<input class="field" data-a="note" style="width:100%;margin-bottom:var(--s3)" placeholder="Optional note to Claude with this review" aria-label="Review note" value="' + esc(ui.note) + '">';
    if (!curFiles.length) return bar + emptyBox('No changed files', 'Files Claude changes in this session will show here with their diffs.');
    return bar + curFiles.map(diffFileHtml).join('');
  }
  function tabQuiz(c) {
    var r = c.review, qz = r && r.quiz || [];
    if (!qz.length) return emptyBox('No quiz', r ? 'This review did not include questions.' : 'Run the review to get questions about this change.');
    var a = answers[c.id] || (answers[c.id] = {}), done = Object.keys(a).length, score = 0;
    qz.forEach(function (q, i) { if (a[i] === q.answer) score++; });
    return '<p class="muted" style="margin-bottom:var(--s4);max-width:60ch">' + qz.length + ' question' + (qz.length > 1 ? 's' : '') + ' to check you understand this change before you approve it.</p>' +
      qz.map(function (q, qi) {
        var ans = a[qi], has = ans !== undefined;
        return '<div class="q"><h4>' + (qi + 1) + '. ' + esc(q.q) + '</h4>' + (q.options || []).map(function (o, oi) {
          var s = has ? (oi === q.answer ? 'right' : oi === ans ? 'wrong' : '') : '';
          return '<button class="opt ' + s + '" ' + (has ? 'disabled' : '') + ' data-a="quiz" data-q="' + qi + '" data-o="' + oi + '"><b>' + 'ABCDEFGH'.charAt(oi) + '</b>' + esc(o) + '</button>';
        }).join('') + (has ? '<p class="why">' + (ans === q.answer ? 'Correct.' : 'Not quite. The answer is ' + 'ABCDEFGH'.charAt(q.answer) + '.') + '</p>' : '') + '</div>';
      }).join('') + (done === qz.length ? '<div class="hint">You got ' + score + ' of ' + qz.length + '.' + (score === qz.length ? ' You understand this change.' : ' Read the Understanding tab again before approving.') + '</div>' + '<button class="btn ghost sm" style="margin-top:12px" data-a="qreset">Try again</button>' : '');
  }

  // ---- render ----
  function root() { return TP.$('screen-review'); }
  function build(el) {
    el.innerHTML = '<div class="ph"><div><h1>Review</h1><p>An architecture-aware review: first it explains the change, then it judges it, then it quizzes you.</p></div><span class="sp"></span>' +
      '<select class="field rsel" id="rv-scope" aria-label="Scope"></select>' +
      '<button class="btn pri" id="rv-run"><span data-ic="shield"></span><span id="rv-runlab">Run PR review</span></button></div>' +
      '<div class="verdict" id="rv-verdict"></div>' +
      '<div class="tabs" role="tablist" id="rv-tabs">' + TABS.map(function (t) { return '<button role="tab" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
      '<div id="rv-body"></div>';
    TP.icons(el);
    el.querySelector('#rv-scope').addEventListener('change', function (e) { ui.scope = e.target.value; lastSig = ''; renderAll(TP.state, true); });
    el.querySelector('#rv-run').addEventListener('click', runReview);
    el.querySelector('#rv-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tab]'); if (!b) return; ui.tab = b.dataset.tab; renderAll(TP.state, true);
    });
    var body = el.querySelector('#rv-body');
    body.addEventListener('click', onBodyClick);
    body.addEventListener('input', function (e) {
      var t = e.target;
      if (t.matches('.cmt textarea')) { var ck = t.closest('.cmt').dataset.ck; comments[ck] = t.value; }
      else if (t.dataset.a === 'note') ui.note = t.value;
    });
    body.addEventListener('change', function (e) { if (e.target.dataset.a === 'choice') ui.choice = e.target.value; });
    body.addEventListener('focusout', function (e) {
      var t = e.target;
      if (t.matches && t.matches('.cmt textarea') && !t.value.trim()) {
        var box = t.closest('.cmt'); if (!box) return;
        var ck = box.dataset.ck;
        setTimeout(function () { if (comments[ck] !== undefined && !String(comments[ck]).trim() && document.activeElement !== t) { delete comments[ck]; if (box.parentNode) box.remove(); markNums(); } }, 120);
      }
    });
    built = true;
  }
  function markNums() {
    var el = root(); if (!el) return;
    el.querySelectorAll('.dl .n[data-k]').forEach(function (n) { n.classList.toggle('has', n.dataset.k in comments); });
  }
  function onBodyClick(e) {
    var t = e.target.closest('[data-a]'); if (!t) return;
    var a = t.dataset.a;
    if (a === 'jump') { jump = { f: t.dataset.f, l: t.dataset.l }; ui.tab = 'd'; renderAll(TP.state, true); }
    else if (a === 'mode') { ui.mode = t.dataset.m; renderAll(TP.state, true); }
    else if (a === 'cmt') {
      var k = t.dataset.k;
      if (k in comments && !String(comments[k]).trim()) delete comments[k];
      else if (!(k in comments)) comments[k] = '';
      var keep = k;
      renderAll(TP.state, true);
      var box = root().querySelector('.cmt[data-ck="' + (window.CSS && CSS.escape ? CSS.escape(keep) : keep) + '"] textarea');
      if (box) box.focus();
    }
    else if (a === 'delc') { delete comments[t.dataset.k]; renderAll(TP.state, true); }
    else if (a === 'quiz') { var a2 = answers[cur.id] || (answers[cur.id] = {}); a2[+t.dataset.q] = +t.dataset.o; renderAll(TP.state, true); }
    else if (a === 'qreset') { answers[cur.id] = {}; renderAll(TP.state, true); }
    else if (a === 'send') sendReview();
  }
  function renderVerdict() {
    var v = root().querySelector('#rv-verdict'), r = cur && cur.review;
    if (!cur) { v.innerHTML = ''; return; }
    if (!r) { v.innerHTML = '<span class="vbig">' + (cur.status === 'reviewing' ? 'REVIEW RUNNING' : 'NOT REVIEWED') + '</span><span class="sevn">' + (cur.status === 'reviewing' ? 'The reviewer is working on this cube.' : 'Run the PR review to get a verdict.') + '</span>'; return; }
    var vd = VERD[r.verdict] || ['', String(r.verdict || 'PENDING').replace(/_/g, ' ')], fs = r.findings || [];
    v.innerHTML = '<span class="vbig ' + vd[0] + '">' + esc(vd[1]) + '</span>' + SEVS.map(function (s) {
      var n = fs.filter(function (f) { return f.severity === s; }).length;
      return '<span class="sev ' + s + '" style="' + (n ? '' : 'opacity:.45') + '">' + s + '</span><span class="sevn">' + n + (n === 1 ? ' finding' : n ? ' findings' : '') + '</span>';
    }).join('') + (r.status ? '<span class="chip ' + (r.status === 'passed' ? 'ok' : r.status === 'changes' ? 'warn' : '') + '">' + esc(r.status) + '</span>' : '') + (r.at ? '<span class="chip">Reviewed ' + esc(ago(r.at)) + '</span>' : '');
  }
  function renderAll(state, force) {
    var el = root(); if (!el) return;
    var list = cubeList(state);
    var sel = el.querySelector('#rv-scope');
    var opts = list.map(function (c) { return '<option value="' + esc(c.id) + '">Cube ' + esc(c.id) + ': ' + esc(c.title || '') + '</option>'; }).join('') || '<option value="">No cubes to review</option>';
    if (!list.some(function (c) { return c.id === ui.scope; })) { var d = pickDefault(list); ui.scope = d ? d.id : ''; }
    if (sel.getAttribute('data-sig') !== opts) { sel.innerHTML = opts; sel.setAttribute('data-sig', opts); }
    sel.value = ui.scope;
    cur = list.filter(function (c) { return c.id === ui.scope; })[0] || null;
    curFiles = cur ? cubeFiles(cur, state) : [];
    var sig = JSON.stringify([cur && cur.id, cur && cur.review, cur && cur.status, curFiles.map(function (f) { return [f.path, f.count, f.lastAt, diffOf(f).length]; })]);
    el.querySelector('#rv-run').disabled = !cur || cur.status === 'reviewing';
    el.querySelector('#rv-runlab').textContent = cur && cur.status === 'reviewing' ? 'Review running' : (cur && cur.review ? 'Run PR review again' : 'Run PR review');
    el.querySelectorAll('#rv-tabs [data-tab]').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === ui.tab); b.setAttribute('aria-selected', b.dataset.tab === ui.tab); });
    if (!force && sig === lastSig) { renderVerdictIfChanged(); return; }
    lastSig = sig;
    renderVerdict();
    var body = el.querySelector('#rv-body'), sc = el.scrollTop;
    var ae = document.activeElement;
    if (!force && ae && body.contains(ae) && /^(TEXTAREA|INPUT|SELECT)$/.test(ae.tagName)) return; // never steal typing
    if (!cur) body.innerHTML = emptyBox('Nothing to review', 'Finished cubes waiting for your review will show up here.');
    else body.innerHTML = ui.tab === 'u' ? tabUnderstanding(cur) : ui.tab === 'f' ? tabFindings(cur) : ui.tab === 'd' ? tabDiff() : tabQuiz(cur);
    el.scrollTop = sc;
    if (ui.tab === 'd') fetchDiffs();
    if (jump && ui.tab === 'd') doJump();
  }
  function renderVerdictIfChanged() { renderVerdict(); }
  function doJump() {
    var j = jump; jump = null;
    var blocks = root().querySelectorAll('.diff'), target = null;
    for (var i = 0; i < blocks.length; i++) if (samePath(blocks[i].dataset.path, j.f)) { target = blocks[i]; break; }
    if (!target) return;
    var row = null;
    if (j.l) { var k = target.dataset.path + ':' + j.l; target.querySelectorAll('.dl[data-lk]').forEach(function (r) { if (!row && r.dataset.lk === k) row = r; }); }
    var hl = row || target.querySelector('.dfh');
    setTimeout(function () { hl.scrollIntoView({ block: 'center' }); hl.classList.add('hl'); setTimeout(function () { hl.classList.remove('hl'); }, 2500); }, 30);
  }
  function fetchDiffs() {
    if (TP.demoMode) return;
    curFiles.forEach(function (f) {
      if (diffOf(f) || asked[f.path]) return;
      asked[f.path] = true;
      TP.send('file.diff', { path: f.path }).then(function (r) {
        if (r && r.ok && r.data && typeof r.data.diff === 'string' && r.data.diff) diffCache[f.path] = r.data.diff;
        lastSig = ''; renderAll(TP.state, false);
      }).catch(function () {});
    });
  }

  // ---- commands ----
  function runReview() {
    if (!cur) return;
    var id = cur.id;
    TP.send('cube.review', { id: id }).then(function (r) { if (r && r.ok && !TP.demoMode) TP.toast('Review started for ' + id); });
  }
  function bundle() {
    var keys = Object.keys(comments).filter(function (k) { return String(comments[k]).trim(); });
    var head = { changes: 'Please make these changes.', approve: 'This looks good to me.', comment: 'Here are my comments, no verdict yet.' }[ui.choice];
    var out = ['Review of cube ' + cur.id + (cur.title ? ' (' + cur.title + ')' : '') + '.', head];
    if (ui.note.trim()) out.push('Note: ' + ui.note.trim());
    if (keys.length) {
      out.push('', 'Line comments:');
      keys.forEach(function (k) { out.push('- ' + k.replace(/:-(\d+)$/, ' (old line $1)').replace(/:(\d+)$/, ' line $1') + ': ' + String(comments[k]).trim().replace(/\n+/g, ' ')); });
    }
    return { text: out.join('\n'), n: keys.length };
  }
  function sendReview() {
    if (!cur) return;
    var b = bundle();
    if (!b.n && !ui.note.trim() && ui.choice !== 'approve') { TP.toast('Add a line comment or a note first'); return; }
    if (TP.demoMode) { TP.toast('Demo: review is not sent'); console.info('Demo review prompt', b.text); return; }
    TP.send('session.prompt', { text: b.text }).then(function (r) { if (r && r.ok) TP.toast('Review sent to Claude'); });
  }

  function applyHash() {
    var h = location.hash || '';
    if (h === lastHash) return;
    lastHash = h;
    var p = h.replace(/^#\/?/, '').split('/');
    if (p[0] !== 'review' || !p[1]) return;
    var m = { findings: 'f', understanding: 'u', diff: 'd', quiz: 'q' }[p[1]];
    if (m) ui.tab = m;
    if (p[2] === 'split') ui.mode = 's';
    if (p[2] === 'unified') ui.mode = 'u';
    if (p[3] === 'comment') comments['web/app/core.js:84'] = comments['web/app/core.js:84'] || 'Check the error path here.';
  }

  TP.screens.review = {
    render: function (state) {
      injectCss();
      var el = root(); if (!el) return;
      if (!built || !el.querySelector('#rv-body')) build(el);
      var before = lastHash; applyHash();
      renderAll(state, before !== lastHash);
    }
  };
})();
