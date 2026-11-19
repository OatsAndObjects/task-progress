'use strict';
// Sample data for ?demo=1. Shapes follow types/index.d.ts Snapshot; extras (usage.breakdown/topTools/sparkline) are the v2 additions the screens build against.
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
    { id: 'c1', title: 'Add the event stream', action: 'Server streams session events over SSE.', status: 'done', after: [], minutes: 6, version: 1, startedAt: now - 40 * MIN, endedAt: now - 30 * MIN, agentId: 'a1', details: 'Adds a Server-Sent Events endpoint so the dashboard can update live without polling. It keeps a list of connected clients and writes each new event to all of them. It only touches the web server file. Risk: a client that disconnects without notice must be dropped, or writes pile up.', doneWhen: 'curl /api/events prints a ready event',
      flow: flow([['web/server.js', 'handleEvents', 'opens the SSE response', 'web/server.js:broadcast'], ['web/server.js', 'broadcast', 'writes one event to every client']]),
      review: { status: 'passed', verdict: 'APPROVE', at: now - 28 * MIN, summary: 'Clean change, covered by a test.', understanding: 'Adds an SSE endpoint and a broadcast helper.', findings: [], quiz: [{ q: 'Which header marks SSE?', options: ['text/event-stream', 'text/plain'], answer: 0 }] } },
    { id: 'c2', title: 'Command endpoint', action: 'Accept session commands from the page.', status: 'done', after: ['c1'], minutes: 5, version: 1, startedAt: now - 29 * MIN, endedAt: now - 22 * MIN, agentId: 'a2', details: 'Adds the endpoint the page uses to send commands such as approve or ask. It checks the access token, validates the action name, then hands the action to the plugin. This is what lets the browser replace the terminal prompts. Risk: a bad token check would let any local page send commands.', doneWhen: 'POST /api/command returns ok',
      flow: flow([['web/server.js', 'handleCommand', 'checks the token and action'], ['hooks/dashboard-model.ts', 'runCommand', 'applies the action']]),
      review: { status: 'passed', verdict: 'APPROVE', at: now - 20 * MIN, summary: 'Looks right.', findings: [{ severity: 'P3', file: 'web/server.js', line: 301, summary: 'Message text could be shorter.' }], quiz: [] } },
    { id: 'c3', title: 'Sample data mode', action: 'Let every screen render without a backend.', status: 'reviewing', after: ['c2'], minutes: 8, version: 2, startedAt: now - 15 * MIN, agentId: 'a3', details: 'Lets every screen render sample data when opened with ?demo=1, so the dashboard can be shown without a running session. It never calls the server; commands show a toast instead. It touches the demo file and two small spots in the core script. Risk: sample data can drift from the real shape and hide bugs.', doneWhen: '/v2/?demo=1 shows the shell with no console errors',
      summary: 'Open the dashboard with ?demo=1 and every screen fills with sample data, no running session needed.',
      problem: ['The dashboard cannot be shown or tested without a live session.', 'Screens need realistic data in the same shape as the real snapshot.'],
      steps: ['Add a sample snapshot file.', 'Make the boot code load it when the address has ?demo=1.', 'Turn commands into toasts so nothing reaches the server.'],
      code: [{ file: 'web/app/demo.js › TP.demo.state', change: 'New: the sample snapshot every screen reads.' }, { file: 'web/app/core.js › TP.boot', change: 'Load the sample instead of polling when demo mode is on.' }, { file: 'web/app/core.js › TP.send', change: 'Show a toast instead of posting the command.' }],
      flow: flow([['web/app/demo.js', 'TP.demo.state', 'holds the sample snapshot'], ['web/app/core.js', 'TP.boot', 'loads the sample in demo mode', 'web/app/demo.js:TP.demo.play'], ['web/app/core.js', 'TP.send', 'toasts instead of posting']]),
      review: review,
      thread: [{ role: 'user', text: 'Does demo mode touch the real server?', at: now - 12 * MIN }, { role: 'claude', text: 'No. It never fetches; every command is a toast.', at: now - 11 * MIN }] },
    { id: 'c4', title: 'Session screen', action: 'Build the chat and activity screen.', status: 'running', after: ['c3'], minutes: 9, version: 1, startedAt: now - 3 * MIN, agentId: 'a4', details: 'Builds the Session screen: the chat transcript, the live activity list and the message box. New events are appended as they arrive instead of redrawing the page. It touches only the session screen file and the shared send helper. Risk: long transcripts could slow scrolling if every event redraws.', doneWhen: 'Screenshot matches the mockup',
      summary: 'A Session screen that shows the chat, live activity and a message box.',
      problem: ['Redrawing the whole page for every event makes long chats stutter.'],
      steps: ['Draw the transcript once.', 'Append each new event as it arrives.', 'Send typed messages through the shared helper.'],
      code: [{ file: 'web/app/session.js › render', change: 'New: draws the transcript and message box.' }, { file: 'web/app/session.js › onEvent', change: 'New: appends one event without a redraw.' }],
      flow: flow([['web/app/session.js', 'render', 'draws the transcript'], ['web/app/session.js', 'onEvent', 'appends live events'], ['web/app/core.js', 'TP.send', 'sends the typed message']]) },
    { id: 'c5', title: 'Board screen', action: 'Build the ticket board.', status: 'approved', after: ['c3'], minutes: 7, version: 1, details: 'Builds the ticket board with columns for each status. Opening a ticket shows a drawer with its details. This is read-mostly and does not change how tickets are stored. Risk: dragging between columns needs care on touch screens.', doneWhen: 'Tickets drag between columns',
      summary: 'A ticket board with one column per status and a drawer for ticket details.',
      problem: ['Tickets are only a flat list today, so progress is hard to see.'],
      steps: ['Group tickets by status into columns.', 'Open a drawer when a ticket is tapped.'],
      code: [{ file: 'web/app/board.js › render', change: 'New: draws the columns.' }, { file: 'web/app/board.js › openTicket', change: 'New: shows the ticket drawer.' }],
      flow: flow([['web/app/board.js', 'render', 'draws the columns'], ['web/app/board.js', 'openTicket', 'shows the ticket drawer']]) },
    { id: 'c6', title: 'Usage screen', action: 'Build the usage meters and breakdown.', status: 'proposed', after: ['c4', 'c5'], minutes: 6, version: 1, note: '', details: 'Builds the Usage screen with meters for each limit and a small trend line. It reads the numbers already in the session snapshot and adds no new data source. It also runs the plugin tests at the end. Risk: missing numbers must show a dash, not zero.', doneWhen: 'Meters and sparkline render',
      flow: flow([['web/app/usage.js', 'render', 'draws meters and sparkline'], ['terminal', 'claude plugin test', 'runs the plugin tests']]) }
  ];
  var perTurn = [12, 18, 15, 30, 44, 38, 52, 61, 49, 70, 66, 80].map(function (n) { return n * 1000; });
  var state = {
    session: { id: 'demo-session', cwd: 'C:\\Users\\you\\project', startedAt: now - 50 * MIN, model: 'Sonnet 5.5' },
    orchestrate: true,
    progress: { task: 'Dashboard v2', step: 3, totalSteps: 6, label: 'Building the session screen', done: false },
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
  TP.demo = {
    state: state,
    play: function () {}
  };
})();
