'use strict';
// Screen: usage (cube c14). Three rings (context, 5-hour, week), tokens, cost, per-turn sparkline, plain hints.
// Leaves <div id="usage-breakdown"></div> at the bottom for cube c17. No commands.
(function () {
  var built = false, lastSig = '';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n) { n = +n || 0; return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)); }
  function clock(t) {
    var d = new Date(t); if (isNaN(d)) return '';
    var time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP]M)/i, function (m, x) { return ' ' + x.toLowerCase(); });
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return time;
    var days = Math.round((d - now) / 86400000);
    if (days < 7 && days >= 0) return d.toLocaleDateString([], { weekday: 'long' }) + ' ' + time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  }
  function inWords(t) {
    var ms = new Date(t) - Date.now(); if (isNaN(ms)) return '';
    if (ms <= 0) return '';
    var m = Math.round(ms / 60000);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
    var d = Math.floor(h / 24); return d + (d === 1 ? ' day' : ' days') + (h % 24 ? ' ' + (h % 24) + ' h' : '');
  }
  function colour(p) { return p >= 90 ? 'var(--danger)' : p >= 75 ? 'var(--warn)' : null; }

  var CSS = [
    '#screen-usage .ugrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:var(--s4)}',
    '#screen-usage .um{display:flex;flex-direction:column;align-items:center;text-align:center;gap:var(--s3);padding:var(--s5) var(--s4)}',
    '#screen-usage .rg{position:relative;width:148px;height:148px;flex:none}',
    '#screen-usage .rg svg{transform:rotate(-90deg);display:block}',
    '#screen-usage .rg b{position:absolute;inset:0;display:grid;place-items:center;font-size:30px;letter-spacing:-.02em}',
    '#screen-usage .um h3{font-size:16px}',
    '#screen-usage .um .big{font-size:22px;font-weight:700;margin-top:4px}',
    '#screen-usage .um p{color:var(--muted);font-size:14px;margin-top:6px;max-width:30ch;margin-inline:auto}',
    '#screen-usage .row2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:var(--s4);margin-top:var(--s4)}',
    '#screen-usage .card h3{font-size:16px}',
    '#screen-usage .tbl{width:100%;border-collapse:collapse;margin-top:var(--s2);font-size:14.5px}',
    '#screen-usage .tbl td{padding:9px 0;border-bottom:1px solid var(--line)}',
    '#screen-usage .tbl tr:last-child td{border-bottom:0}',
    '#screen-usage .tbl td:last-child{text-align:right;font:600 14px var(--mono)}',
    '#screen-usage .tbl i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:10px}',
    '#screen-usage .stack{display:flex;height:12px;border-radius:6px;overflow:hidden;margin:14px 0 6px;gap:2px}',
    '#screen-usage .stack i{display:block}',
    '#screen-usage .cost{font-size:34px;font-weight:700;margin:6px 0}',
    '#screen-usage .hint{margin-top:var(--s4);padding:var(--s3) var(--s4);border-radius:12px;background:var(--accent-soft);font-size:14.5px}',
    '#screen-usage .hint p{margin:2px 0}',
    '#screen-usage .wide{margin-top:var(--s4)}',
    '#screen-usage .spk{width:100%;height:110px;display:block}',
    '#screen-usage .upd{color:var(--faint);font-size:12.5px;margin-top:var(--s2)}',
    '#usage-breakdown{margin-top:var(--s4)}',
    '#usage-breakdown .tabs{display:flex;gap:6px;flex-wrap:wrap;margin:var(--s3) 0}',
    '#usage-breakdown .tabs button{background:var(--surface-3);color:var(--muted);border:0;border-radius:999px;padding:7px 14px;font:inherit;font-size:14px;cursor:pointer}',
    '#usage-breakdown .tabs button.on{background:var(--accent-soft);color:var(--text)}',
    '#usage-breakdown .why{font-size:15px;margin:0 0 var(--s3)}',
    '#usage-breakdown .bk{display:grid;grid-template-columns:minmax(90px,200px) 1fr auto;gap:12px;align-items:center;padding:6px 0;font-size:14px}',
    '#usage-breakdown .bk .l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#usage-breakdown .bk .t{height:10px;border-radius:5px;background:var(--surface-3);overflow:hidden}',
    '#usage-breakdown .bk .t i{display:block;height:100%;border-radius:5px;background:var(--shimmer)}',
    '#usage-breakdown .bk .v{font:600 13px var(--mono);text-align:right;white-space:nowrap}',
    '#usage-breakdown .bk .v span{color:var(--muted);font-weight:400;margin-left:8px}',
    '#usage-breakdown .tool{display:grid;grid-template-columns:70px 1fr auto;gap:12px;padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}',
    '#usage-breakdown .tool:last-child{border-bottom:0}',
    '#usage-breakdown .tool .g{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-family:var(--mono);font-size:13px}',
    '#usage-breakdown .tool .v{font:600 13px var(--mono)}'
  ].join('\n');
  function injectCss() {
    if (document.getElementById('css-usage')) return;
    var s = document.createElement('style'); s.id = 'css-usage'; s.textContent = CSS; document.head.appendChild(s);
  }

  function ring(p, col) {
    var sz = 148, sw = 13, r = (sz - sw) / 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, p || 0));
    return '<svg width="' + sz + '" height="' + sz + '" aria-hidden="true"><circle cx="' + sz / 2 + '" cy="' + sz / 2 + '" r="' + r + '" fill="none" stroke="var(--surface-3)" stroke-width="' + sw + '"/>' +
      '<circle cx="' + sz / 2 + '" cy="' + sz / 2 + '" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="' + sw + '" stroke-linecap="round" stroke-dasharray="' + (c * v / 100).toFixed(1) + ' ' + c.toFixed(1) + '"/></svg>';
  }
  function meter(title, p, col, big, sub) {
    p = Math.max(0, Math.min(100, Math.round(+p || 0)));
    return '<div class="card um"><div class="rg" role="img" aria-label="' + esc(title) + ' ' + p + ' percent">' + ring(p, colour(p) || col) + '<b>' + p + '%</b></div>' +
      '<div><h3>' + esc(title) + '</h3><div class="big">' + esc(big) + '</div><p>' + esc(sub) + '</p></div></div>';
  }
  function spark(vals) {
    var w = 520, h = 90;
    if (!vals || vals.length < 2) return '<p class="muted" style="margin-top:var(--s2)">Not enough turns yet.</p>';
    var mx = Math.max.apply(null, vals) || 1;
    var pts = vals.map(function (v, i) { return (i / (vals.length - 1) * w).toFixed(1) + ',' + (h - 8 - v / mx * (h - 16)).toFixed(1); }).join(' ');
    return '<svg class="spk" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="Tokens per turn"><defs><linearGradient id="usg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#0A84FF" stop-opacity=".35"/><stop offset="1" stop-color="#0A84FF" stop-opacity="0"/></linearGradient></defs>' +
      '<polygon points="0,' + h + ' ' + pts + ' ' + w + ',' + h + '" fill="url(#usg)"/><polyline points="' + pts + '" fill="none" stroke="var(--shimmer)" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>';
  }

  function html(u) {
    var cx = u.context || {}, fh = u.fiveHour || {}, wk = u.weekly || {}, tk = u.tokens || {}, cost = u.cost || {};
    var cp = Math.round(+cx.percent || 0), fp = Math.round(+fh.percent || 0), wp = Math.round(+wk.percent || 0);
    var ctxHint = cp >= 90 ? 'Context is ' + cp + '% full. It will be compacted soon.' : cp >= 70 ? 'Context is ' + cp + '% full. Getting tight.' : 'Context is ' + cp + '% full. Plenty of room.';
    function rs(t) { var w = inWords(t); return w ? 'Resets ' + clock(t) + ', in ' + w + '.' : 'Resets soon.'; }
    var fhSub = fh.resetsAt ? rs(fh.resetsAt) : 'Counts everything you ran in the last 5 hours.';
    var wkSub = wk.resetsAt ? rs(wk.resetsAt) : 'Used ' + wp + '% so far this week.';
    var big = {
      c: cx.tokens != null ? num(cx.tokens) + (+cx.window ? ' of ' + num(cx.window) : '') + ' tokens' : cp + '% used',
      f: fh.resetsAt ? 'resets ' + clock(fh.resetsAt) : fp + '% used',
      w: wk.resetsAt ? 'resets ' + clock(wk.resetsAt) : wp + '% used'
    };
    var total = (+tk.input || 0) + (+tk.output || 0) + (+tk.cacheRead || 0) + (+tk.cacheWrite || 0);
    var rows = [['Input', tk.input, 'var(--shimmer)'], ['Output', tk.output, 'var(--star)'], ['Cache read', tk.cacheRead, 'var(--ok)'], ['Cache write', tk.cacheWrite, 'var(--warn)']];
    var per = u.perTurn && u.perTurn.length ? u.perTurn : (u.sparkline || []);
    var hints = ['<p>' + esc(ctxHint) + '</p>'];
    hints.push('<p>You have used ' + wp + '% of this week' + (wk.resetsAt ? (inWords(wk.resetsAt) ? '. It resets ' + esc(clock(wk.resetsAt)) + ', in ' + esc(inWords(wk.resetsAt)) : '. It resets soon') : '') + '.</p>');
    if (fp >= 75) hints.push('<p>The 5-hour limit is ' + fp + '% used. Slow down or wait for it to reset.</p>');
    return '<div class="ugrid">' +
      meter('Context window', cp, 'var(--shimmer)', big.c, 'Claude ' + (cp < 70 ? 'still has plenty of room in this chat.' : 'is running low on room in this chat.')) +
      meter('5-hour limit', fp, 'var(--star)', big.f, fhSub) +
      meter('Weekly limit', wp, 'var(--shimmer)', big.w, wkSub) + '</div>' +
      '<div class="row2"><div class="card"><h3>Session tokens</h3><div class="big" style="font-size:22px;font-weight:700;margin-top:6px">' + esc(num(total)) + ' total</div>' +
      '<div class="stack">' + rows.map(function (r) { return '<i style="flex:' + Math.max(0.5, +r[1] || 0) + ';background:' + r[2] + '"></i>'; }).join('') + '</div>' +
      '<table class="tbl"><tbody>' + rows.map(function (r) { return '<tr><td><i style="background:' + r[2] + '"></i>' + esc(r[0]) + '</td><td>' + esc(num(r[1])) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      '<div class="card"><h3>Cost this session</h3><div class="cost">' + (cost.usd != null && isFinite(+cost.usd) ? '$' + (+cost.usd).toFixed(2) : 'n/a') + '</div><p class="muted" style="font-size:14px">Estimated from the tokens above at list prices.</p>' +
      (u.updatedAt && !isNaN(new Date(u.updatedAt)) ? '<p class="upd">Updated ' + esc(new Date(u.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + '</p>' : '') + '</div></div>' +
      '<div class="card wide"><h3>Tokens per turn <span class="faint" style="font-weight:400;font-size:13px">last ' + Math.min(20, per.length) + ' turns</span></h3>' + spark(per.slice(-20)) + '</div>' +
      '<div class="hint">' + hints.join('') + '</div>';
  }

  var TABS = [['byCube', 'By cube'], ['byAgent', 'By agent'], ['byModel', 'By model'], ['context', 'Context']];
  var tab = 'byCube', lastBd = '', lastState = null;
  function shares(vals) { // largest-remainder: whole percents summing to exactly 100
    var tot = vals.reduce(function (a, b) { return a + b; }, 0); if (!tot) return vals.map(function () { return 0; });
    var raw = vals.map(function (v) { return v / tot * 100; }), fl = raw.map(Math.floor);
    var left = 100 - fl.reduce(function (a, b) { return a + b; }, 0);
    raw.map(function (r, i) { return [r - fl[i], i]; }).sort(function (a, b) { return b[0] - a[0] || a[1] - b[1]; }).slice(0, left).forEach(function (x) { fl[x[1]]++; });
    return fl;
  }
  function rank(list) {
    var rows = (Array.isArray(list) ? list : []).map(function (r) { return { label: String((r && r.label) || 'Unknown'), tokens: Math.max(0, +(r && r.tokens) || 0) }; }).filter(function (r) { return isFinite(r.tokens) && r.tokens > 0; });
    rows.sort(function (a, b) { return b.tokens - a.tokens; });
    if (rows.length > 9) { var rest = rows.slice(8); rows = rows.slice(0, 8).concat([{ label: 'Other (' + rest.length + ')', tokens: rest.reduce(function (a, r) { return a + r.tokens; }, 0) }]); }
    var p = shares(rows.map(function (r) { return r.tokens; }));
    rows.forEach(function (r, i) { r.pct = p[i]; });
    return rows;
  }
  function explainTop(rows, t) {
    if (!rows.length) return '';
    var r = rows[0], p = r.pct + '%';
    if (t === 'byCube') return 'Most tokens went to ' + r.label + ' (' + p + ').';
    if (t === 'byAgent') return /main/i.test(r.label) ? 'The main session used ' + p + ' of tokens.' : r.label + ' used the most tokens (' + p + ').';
    if (t === 'byModel') return r.label + ' handled ' + p + ' of tokens.';
    return r.label + ' takes up the most context (' + p + ').';
  }
  function renderBreakdown(bd) {
    var rows = rank(bd && bd[tab]);
    var tabs = '<div class="tabs" role="tablist">' + TABS.map(function (x) { return '<button role="tab" data-tab="' + x[0] + '" class="' + (x[0] === tab ? 'on' : '') + '" aria-selected="' + (x[0] === tab) + '">' + x[1] + '</button>'; }).join('') + '</div>';
    var body = rows.length ? '<p class="why">' + esc(explainTop(rows, tab)) + '</p>' + rows.map(function (r) {
      return '<div class="bk"><span class="l" title="' + esc(r.label) + '">' + esc(r.label) + '</span><span class="t"><i style="width:' + (r.pct > 0 ? Math.max(2, r.pct) : 0) + '%"></i></span><span class="v">' + esc(num(r.tokens)) + '<span>' + r.pct + '%</span></span></div>';
    }).join('') : '<p class="muted">Token split appears once Claude has run a few turns.</p>';
    return '<h3>Where tokens went</h3>' + tabs + body;
  }
  function renderTopTools(list) {
    var rows = (Array.isArray(list) ? list : []).map(function (r) { return { tool: String((r && r.tool) || '?'), target: String((r && r.target) || ''), tokens: +(r && r.tokens) || 0 }; }).sort(function (a, b) { return b.tokens - a.tokens; }).slice(0, 10);
    if (!rows.length) return '';
    return '<h3 style="margin-top:var(--s5)">Heaviest tool results</h3>' + rows.map(function (r) {
      return '<div class="tool"><b>' + esc(r.tool) + '</b><span class="g" title="' + esc(r.target) + '">' + esc(r.target) + '</span><span class="v">' + esc(num(r.tokens)) + '</span></div>';
    }).join('');
  }

  TP.screens.usage = {
    render: function (state) {
      injectCss();
      var root = TP.$('screen-usage'); if (!root) return;
      if (!built || !root.querySelector('#usage-main')) {
        root.innerHTML = '<div class="ph"><div><h1>Usage</h1><p>How much room you have left, in plain terms.</p></div></div><div id="usage-main"></div><div id="usage-breakdown"></div>';
        built = true; lastSig = '';
      }
      var u = state && state.usage;
      var host = root.querySelector('#usage-main');
      var out = u ? html(u) : '<div class="card"><h3>No usage yet</h3><p class="muted">Numbers appear after Claude\'s first turn.</p></div>';
      if (out !== lastSig) { lastSig = out; host.innerHTML = out; }
      lastState = state;
      var bh = root.querySelector('#usage-breakdown');
      if (bh && !bh._wired) { bh._wired = true; bh.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-tab]'); if (!b) return; tab = b.getAttribute('data-tab'); TP.screens.usage.render(lastState); }); }
      var bo = '<div class="card">' + renderBreakdown(u && u.breakdown) + renderTopTools(u && u.topTools) + '</div>';
      var cm = state && state.lastContextMap;
      if (cm && cm.text != null) bo += '<div class="card" style="margin-top:var(--s4)"><h3>Context map at finish</h3><p class="muted">' + esc(cm.at && !isNaN(new Date(cm.at)) ? new Date(cm.at).toLocaleString() : '') + (cm.file ? ' · saved to ' + esc(cm.file) : '') + '</p><pre style="white-space:pre-wrap;overflow:auto;max-height:420px;font:13px var(--mono);margin-top:var(--s2)">' + esc(cm.text) + '</pre></div>';
      if (bh && (bo !== lastBd || !bh.firstChild)) { lastBd = bo; bh.innerHTML = bo; }
    }
  };
})();
