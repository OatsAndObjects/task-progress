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
    if (ms <= 0) return 'now';
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
    '#usage-breakdown{margin-top:var(--s4)}'
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
    p = Math.round(+p || 0);
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
    var fhSub = fh.resetsAt ? 'Resets ' + clock(fh.resetsAt) + ', in ' + inWords(fh.resetsAt) + '.' : 'Counts everything you ran in the last 5 hours.';
    var wkSub = wk.resetsAt ? 'Resets ' + clock(wk.resetsAt) + ', in ' + inWords(wk.resetsAt) + '.' : 'Used ' + wp + '% so far this week.';
    var big = {
      c: cx.tokens != null ? num(cx.tokens) + ' of ' + num(cx.window) + ' tokens' : cp + '% used',
      f: fh.resetsAt ? 'resets ' + clock(fh.resetsAt) : fp + '% used',
      w: wk.resetsAt ? 'resets ' + clock(wk.resetsAt) : wp + '% used'
    };
    var total = (+tk.input || 0) + (+tk.output || 0) + (+tk.cacheRead || 0) + (+tk.cacheWrite || 0);
    var rows = [['Input', tk.input, 'var(--shimmer)'], ['Output', tk.output, 'var(--star)'], ['Cache read', tk.cacheRead, 'var(--ok)'], ['Cache write', tk.cacheWrite, 'var(--warn)']];
    var per = u.perTurn && u.perTurn.length ? u.perTurn : (u.sparkline || []);
    var hints = ['<p>' + esc(ctxHint) + '</p>'];
    hints.push('<p>You have used ' + wp + '% of this week' + (wk.resetsAt ? '. It resets ' + esc(clock(wk.resetsAt)) + ', in ' + esc(inWords(wk.resetsAt)) : '') + '.</p>');
    if (fp >= 75) hints.push('<p>The 5-hour limit is ' + fp + '% used. Slow down or wait for it to reset.</p>');
    return '<div class="ugrid">' +
      meter('Context window', cp, 'var(--shimmer)', big.c, 'Claude ' + (cp < 70 ? 'still has plenty of room in this chat.' : 'is running low on room in this chat.')) +
      meter('5-hour limit', fp, 'var(--star)', big.f, fhSub) +
      meter('Weekly limit', wp, 'var(--shimmer)', big.w, wkSub) + '</div>' +
      '<div class="row2"><div class="card"><h3>Session tokens</h3><div class="big" style="font-size:22px;font-weight:700;margin-top:6px">' + esc(num(total)) + ' total</div>' +
      '<div class="stack">' + rows.map(function (r) { return '<i style="flex:' + Math.max(0.5, +r[1] || 0) + ';background:' + r[2] + '"></i>'; }).join('') + '</div>' +
      '<table class="tbl"><tbody>' + rows.map(function (r) { return '<tr><td><i style="background:' + r[2] + '"></i>' + esc(r[0]) + '</td><td>' + esc(num(r[1])) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      '<div class="card"><h3>Cost this session</h3><div class="cost">' + (cost.usd != null ? '$' + (+cost.usd).toFixed(2) : 'n/a') + '</div><p class="muted" style="font-size:14px">Estimated from the tokens above at list prices.</p>' +
      (u.updatedAt ? '<p class="upd">Updated ' + esc(new Date(u.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + '</p>' : '') + '</div></div>' +
      '<div class="card wide"><h3>Tokens per turn <span class="faint" style="font-weight:400;font-size:13px">last ' + Math.min(20, per.length) + ' turns</span></h3>' + spark(per.slice(-20)) + '</div>' +
      '<div class="hint">' + hints.join('') + '</div>';
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
    }
  };
})();
