'use strict';
// Sample data for ?demo=1. Shapes follow types/index.d.ts Snapshot; extras (tickets, file content/diff,
// usage.breakdown/topTools/sparkline) are the v2 additions the screens build against.
(function () {
  var now = Date.now(), MIN = 60000;
  function flow(a) { return a.map(function (x) { return { file: x[0], fn: x[1], does: x[2], calls: x[3] }; }); }
  var review = {
    status: 'changes', verdict: 'REQUEST_CHANGES', at: now - 4 * MIN,
    summary: 'The sender works, but a failed POST is swallowed and the demo branch never resolves its promise on a second call.',
    understanding: 'Screens call TP.send(type, payload). In normal mode it POSTs to /api/command with the token; in demo mode it only toasts. TP.emit fans events out to every screen.',
    findings: [
      { severity: 'P1', file: 'web/app/core.js', line: 88, summary: 'TP.send ignores non-200 replies, so the user sees no error.' },
      { severity: 'P2', file: 'web/app/core.js', line: 61, summary: 'TP.events is never trimmed after 2000 entries.' },
      { severity: 'P3', file: 'web/app/demo.js', line: 12, summary: 'Sample ids could collide with real ones.' }
    ],
    quiz: [
      { q: 'Where do screens send commands?', options: ['fetch directly', 'TP.send', 'TP.emit'], answer: 1 },
      { q: 'What does demo mode skip?', options: ['Rendering', 'Token and polling', 'Routing'], answer: 1 }
    ]
  };
  var cubes = [
    { id: 'c1', title: 'Add the event stream', action: 'Server streams session events over SSE.', status: 'done', after: [], minutes: 6, version: 1, startedAt: now - 40 * MIN, endedAt: now - 30 * MIN, agentId: 'a1', doneWhen: 'curl /api/events prints a ready event',
      flow: flow([['web/server.js', 'handleEvents', 'opens the SSE response', 'web/server.js:broadcast'], ['web/server.js', 'broadcast', 'writes one event to every client']]),
      review: { status: 'passed', verdict: 'APPROVE', at: now - 28 * MIN, summary: 'Clean change, covered by a test.', understanding: 'Adds an SSE endpoint and a broadcast helper.', findings: [], quiz: [{ q: 'Which header marks SSE?', options: ['text/event-stream', 'text/plain'], answer: 0 }] } },
    { id: 'c2', title: 'Command endpoint', action: 'Accept session commands from the page.', status: 'done', after: ['c1'], minutes: 5, version: 1, startedAt: now - 29 * MIN, endedAt: now - 22 * MIN, agentId: 'a2', doneWhen: 'POST /api/command returns ok',
      flow: flow([['web/server.js', 'handleCommand', 'checks the token and action'], ['hooks/dashboard-model.ts', 'runCommand', 'applies the action']]),
      review: { status: 'passed', verdict: 'APPROVE', at: now - 20 * MIN, summary: 'Looks right.', findings: [{ severity: 'P3', file: 'web/server.js', line: 301, summary: 'Message text could be shorter.' }], quiz: [] } },
    { id: 'c3', title: 'Sample data mode', action: 'Let every screen render without a backend.', status: 'reviewing', after: ['c2'], minutes: 8, version: 2, startedAt: now - 15 * MIN, agentId: 'a3', doneWhen: '/v2/?demo=1 shows the shell with no console errors',
      flow: flow([['web/app/demo.js', 'TP.demo.state', 'holds the sample snapshot'], ['web/app/core.js', 'TP.boot', 'loads the sample in demo mode', 'web/app/demo.js:TP.demo.play'], ['web/app/core.js', 'TP.send', 'toasts instead of posting']]),
      review: review,
      thread: [{ role: 'user', text: 'Does demo mode touch the real server?', at: now - 12 * MIN }, { role: 'claude', text: 'No. It never fetches; every command is a toast.', at: now - 11 * MIN }] },
    { id: 'c4', title: 'Session screen', action: 'Build the chat and activity screen.', status: 'running', after: ['c3'], minutes: 9, version: 1, startedAt: now - 3 * MIN, agentId: 'a4', doneWhen: 'Screenshot matches the mockup',
      flow: flow([['web/app/session.js', 'render', 'draws the transcript'], ['web/app/session.js', 'onEvent', 'appends live events'], ['web/app/core.js', 'TP.send', 'sends the typed message']]) },
    { id: 'c5', title: 'Board screen', action: 'Build the ticket board.', status: 'approved', after: ['c3'], minutes: 7, version: 1, doneWhen: 'Tickets drag between columns',
      flow: flow([['web/app/board.js', 'render', 'draws the columns'], ['web/app/board.js', 'openTicket', 'shows the ticket drawer']]) },
    { id: 'c6', title: 'Usage screen', action: 'Build the usage meters and breakdown.', status: 'proposed', after: ['c4', 'c5'], minutes: 6, version: 1, note: '', doneWhen: 'Meters and sparkline render',
      flow: flow([['web/app/usage.js', 'render', 'draws meters and sparkline'], ['terminal', 'claude plugin test', 'runs the plugin tests']]) }
  ];
  function tk(key, type, pri, title, desc, checks, who, col, act) {
    return { key: key, type: type, priority: pri, title: title, description: desc, checks: checks.map(function (c) { return { text: c[0], done: !!c[1] }; }), assignee: who, status: col, activity: act, createdAt: now - 3600000, updatedAt: now - 600000 };
  }
  var tickets = [
    tk('TP-1', 'feature', 'high', 'Approve cubes from the browser', 'Approve, edit or reject a cube without the terminal.', [['Approve button', true], ['Edit drawer', false]], 'Claude', 'doing', [{ who: 'You', text: 'created this ticket', at: now - 3600000 }, { who: 'Claude', text: 'started work', at: now - 1800000 }]),
    tk('TP-2', 'bug', 'med', 'Meters stay at 0 after resume', 'The context meter shows 0% until the next turn.', [['Reproduce', true], ['Fix', false]], '', 'todo', [{ who: 'You', text: 'created this ticket', at: now - 7200000 }]),
    tk('TP-3', 'task', 'low', 'Write the README section', 'Document /tp-dashboard web.', [], 'You', 'todo', []),
    tk('TP-4', 'feature', 'high', 'Review screen with quiz', 'Show findings and the understanding quiz.', [['Findings list', true], ['Quiz', true]], 'Claude', 'review', [{ who: 'Claude', text: 'moved to review', at: now - 900000 }]),
    tk('TP-5', 'bug', 'high', 'Token lost on reload', 'The page asks for the token again.', [['Keep in sessionStorage', true]], 'Claude', 'blocked', [{ who: 'Claude', text: 'waiting on server change', at: now - 500000 }]),
    tk('TP-6', 'task', 'med', 'Add the event stream', 'SSE for live events.', [['Server', true], ['Client', true]], 'Claude', 'done', [{ who: 'Claude', text: 'finished', at: now - 2400000 }])
  ];
  var diff = '--- a/web/app/core.js\n+++ b/web/app/core.js\n@@ -80,6 +80,14 @@\n TP.api = function (method, path, body) {\n+TP.send = function (type, payload) {\n+  if (TP.demoMode) { console.info("demo send", type, payload); TP.toast("Demo: " + type); return Promise.resolve({ ok: true }); }\n+  return TP.api("POST", "/api/command", Object.assign({ action: type }, payload || {}));\n+};\n   var opts = { method: method };\n-  return fetch(path);\n+  return fetch(path, opts);\n';
  var files = [
    { path: 'web/app/core.js', op: 'edit', count: 4, lastAt: now - 2 * MIN, content: "TP.send = function (type, payload) {\n  return TP.api('POST', '/api/command', Object.assign({ action: type }, payload || {}));\n};\n", diff: diff },
    { path: 'web/app/demo.js', op: 'write', count: 1, lastAt: now - 5 * MIN, content: "TP.demo = { state: {}, events: [] };\n", diff: '--- /dev/null\n+++ b/web/app/demo.js\n@@ -0,0 +1 @@\n+TP.demo = { state: {}, events: [] };\n' },
    { path: 'web/app/index.html', op: 'edit', count: 2, lastAt: now - 9 * MIN, content: '<script src="demo.js"></script>\n', diff: '--- a/web/app/index.html\n+++ b/web/app/index.html\n@@ -50,2 +50,3 @@\n+<script src="demo.js"></script>\n <script src="core.js"></script>\n' },
    { path: 'hooks/dashboard-model.ts', op: 'edit', count: 1, lastAt: now - 20 * MIN, content: 'export function runCommand() {}\n', diff: '--- a/hooks/dashboard-model.ts\n+++ b/hooks/dashboard-model.ts\n@@ -1 +1,2 @@\n+// sample\n export function runCommand() {}\n' }
  ];
  var perTurn = [12, 18, 15, 30, 44, 38, 52, 61, 49, 70, 66, 80].map(function (n) { return n * 1000; });
  var state = {
    session: { id: 'demo-session', cwd: 'C:\\Users\\you\\project', startedAt: now - 50 * MIN, model: 'Sonnet 5.5' },
    orchestrate: true,
    progress: { task: 'Dashboard v2', step: 3, totalSteps: 6, label: 'Building the session screen', done: false },
    plan: { task: 'Dashboard v2', steps: [
      { k: 1, title: 'Event stream', minutes: 6, status: 'done', agentId: 'a1' },
      { k: 2, title: 'Command endpoint', minutes: 5, status: 'done', agentId: 'a2' },
      { k: 3, title: 'Sample data mode', minutes: 8, status: 'running', agentId: 'a3', startedAt: now - 15 * MIN },
      { k: 4, title: 'Session screen', minutes: 9, status: 'pending' },
      { k: 5, title: 'Board screen', minutes: 7, status: 'pending' },
      { k: 6, title: 'Usage screen', minutes: 6, status: 'pending' }] },
    agents: [
      { id: 'a3', description: 'Sample data mode', type: 'task-progress:executor', status: 'running', startedAt: now - 15 * MIN, budgetMin: 8, step: 3 },
      { id: 'a2', description: 'Command endpoint', type: 'task-progress:executor', status: 'done', startedAt: now - 29 * MIN, endedAt: now - 22 * MIN, budgetMin: 5, step: 2 }],
    shells: [{ id: 's1', command: 'node web/server.js --port 7390', description: 'Dashboard server', status: 'running', startedAt: now - 10 * MIN }],
    files: files,
    toolLog: [
      { at: now - 4 * MIN, tool: 'Read', summary: 'web/app/core.js', ok: true },
      { at: now - 3 * MIN, tool: 'Edit', summary: 'web/app/core.js', ok: true, agentId: 'a3' },
      { at: now - 2 * MIN, tool: 'Bash', summary: 'claude plugin test .', ok: false, agentId: 'a3' }],
    tasks: tickets.map(function (t, i) { return { id: 't' + (i + 1), title: t.title, notes: t.description, status: t.status === 'review' ? 'doing' : t.status, priority: t.priority, createdAt: t.createdAt, updatedAt: t.updatedAt, source: 'user' }; }),
    tickets: tickets,
    columns: ['todo', 'doing', 'review', 'blocked', 'done'],
    cubes: { task: 'Dashboard v2', gate: true, cubes: cubes, lanes: [['c1'], ['c2'], ['c3'], ['c4', 'c5'], ['c6']] },
    usage: {
      context: { tokens: 74000, window: 200000, percent: 37 },
      fiveHour: { percent: 62, resetsAt: new Date(now + 90 * MIN).toISOString() },
      weekly: { percent: 28, resetsAt: new Date(now + 3 * 86400000).toISOString() },
      cost: { usd: 4.82 },
      tokens: { input: 412000, output: 58000, cacheRead: 1900000, cacheWrite: 120000 },
      perTurn: perTurn, sparkline: perTurn, updatedAt: now,
      breakdown: {
        byCube: [{ label: 'c3 Sample data mode', tokens: 91000 }, { label: 'c2 Command endpoint', tokens: 64000 }, { label: 'c1 Event stream', tokens: 52000 }],
        byAgent: [{ label: 'Orchestrator', tokens: 180000 }, { label: 'a3 executor', tokens: 91000 }, { label: 'a2 executor', tokens: 64000 }],
        byModel: [{ label: 'Opus', tokens: 150000 }, { label: 'Sonnet 5.5', tokens: 230000 }],
        context: [{ label: 'System prompt', tokens: 14000 }, { label: 'Conversation', tokens: 41000 }, { label: 'Tool results', tokens: 19000 }]
      },
      topTools: [{ tool: 'Read', target: 'web/app/core.js', tokens: 18000 }, { tool: 'Bash', target: 'claude plugin test .', tokens: 9000 }, { tool: 'Edit', target: 'web/app/demo.js', tokens: 4000 }]
    }
  };
  var ev = [
    { type: 'turn.start' },
    { type: 'user', text: 'Add a sample data mode so we can build the screens.' },
    { type: 'assistant.chunk', text: 'I will add demo.js with a sample snapshot ' },
    { type: 'assistant.chunk', text: 'and a TP.send helper.' },
    { type: 'tool.start', id: 'tu1', tool: 'Read', summary: 'web/app/core.js' },
    { type: 'tool.result', id: 'tu1', ok: true, summary: '212 lines' },
    { type: 'executor', id: 'a3', description: 'Sample data mode', budgetMin: 8, step: 3, status: 'running' },
    { type: 'permission', id: 'p1', tool: 'Bash', input: { command: 'node web/server.js --port 7390' } },
    { type: 'assistant', text: 'The server is up. Checking the page now.' },
    { type: 'waiting', id: 'w1', question: 'Which port should the dashboard use? Answer in the terminal.' },
    { type: 'turn.end', usage: { input: 3200, output: 410 } }
  ];
  TP.demo = {
    state: state,
    events: ev,
    play: function () {
      ev.forEach(function (e, i) { setTimeout(function () { TP.emit(Object.assign({ at: Date.now() }, e)); }, 400 + i * 700); });
    }
  };
})();
