// The session dashboard: a collector that keeps a Snapshot in $.state, the
// /tp-dashboard command, and the bridge to the local web app (web/server.js).
import type {
  DashboardCommand,
  DashboardCommandResult,
  Snapshot,
  SnapshotAgent,
} from '../types/index'
import {
  addAgent,
  agentStatusOf,
  emptySnapshot,
  markOverruns,
  parseBudget,
  parseTaskNotification,
  commandFromLine,
  randomToken,
  runCommand,
  addTurnUsage,
  attributeTurn,
  attributeTool,
  setContextBreakdown,
  setAgentStatus,
  setMeasure,
  setPlan,
  setProgress,
  splitLines,
  summarize,
  type CommandDeps,
} from './dashboard-model'
import { newOpenState, openOnce, type OpenDeps } from './dash-open'
import { allCubesDone, answerCube, applyReview, finishAndRelease, flowLabel, markRunning, normalizeBoardFlow, reviseCube, withBoard } from './cubes-model'
import type { CubeBoard } from '../types/index'

const FLUSH_MS = 250
const POLL_MS = 3000
const WEB_PORT = 7377
const READY_TIMEOUT_MS = 8000
const HEARTBEAT_MS = 10000

const snapRef = { plugin: 'task-progress', key: 'snapshot' } as const
const webRef = { plugin: 'task-progress', key: 'web' } as const

type Web = {
  token: string
  port: number
  url: string
  stream: any
}

type DashCtx = {
  snap: Snapshot | null
  flushTimer: { cancel: () => void } | undefined
  poll: { cancel: () => void } | undefined
  web: Web | null
  starting: Promise<Web | null> | null
}

// The orchestrator's own state, shared by reference (state refs are plain literals).
const modeRef = { plugin: 'task-progress', key: 'mode' } as const
const checkedRef = { plugin: 'task-progress', key: 'inputsChecked' } as const
const cubesGateRef = { plugin: 'task-progress', key: 'cubesGate' } as const

async function isOrchestrateOn($: any): Promise<boolean> {
  return ((await $.state.get(modeRef)).value ?? 'on') === 'on'
}

/** Set by register.tsx: runs once each time the web server becomes ready. */
export const webReady: { fn?: ($: any) => void } = {}

let snapTooBigLogged = false
const c: DashCtx = { snap: null, flushTimer: undefined, poll: undefined, web: null, starting: null }

async function load($: any): Promise<Snapshot> {
  if (c.snap) return c.snap
  const { value } = await $.state.get(snapRef)
  if (value) {
    // Boards stored before function-level flow hold strings; show them as steps with only `does`.
    c.snap = value.cubes ? { ...value, cubes: normalizeBoardFlow(value.cubes) } : value
    if (allCubesDone(c.snap!.cubes)) ctx.fired = true // a finished plan from before a reload must not fire again
    return c.snap!
  }
  const now: number = await $.clock.now()
  c.snap = emptySnapshot({ id: '', cwd: '', startedAt: now }, await isOrchestrateOn($))
  return c.snap
}

async function postSnapshot($: any) {
  const w = c.web
  if (!w || !c.snap) return
  try {
    const res: any = await $.http.fetch(`http://127.0.0.1:${w.port}/api/snapshot`, {
      method: 'POST',
      headers: { 'X-TP-Token': w.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(c.snap),
    })
    if (res && res.status === 413 && !snapTooBigLogged) {
      snapTooBigLogged = true
      console.error('task-progress: dashboard snapshot rejected as too large (413)')
    }
  } catch {
    // the server may be gone; its exit clears the bridge
  }
}

async function flush($: any) {
  if (!c.snap) return
  await $.state.set(snapRef, c.snap)
  void postSnapshot($)
}

function schedule($: any) {
  if (c.flushTimer) return
  c.flushTimer = $.clock.after(FLUSH_MS, () => {
    c.flushTimer = undefined
    void flush($)
  })
}

// Once per plan: the last cube turning done runs /context, saves it, then /clear.
const ctx = { fired: false, pending: false }
const CTX_DELAY_MS = 1500

/** A timer (not a hook the turn waits on) fires it, so $.command.run is not rejected; the run queues until the session is idle. */
async function runContextThenClear($: any) {
  if (!ctx.pending) return
  ctx.pending = false
  try {
    const r: any = await $.command.run({ command: 'context' })
    const text = String(r?.text ?? '')
    const at: number = await $.clock.now()
    let file = ''
    try {
      const home = String((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '')
      const path = `${home}/.claude/task-progress-context/context-${new Date(at).toISOString().replace(/:/g, '-')}.txt`
      await $.fs.write(path, text)
      file = path
    } catch {
      // keep the text on the snapshot even when the file cannot be written
    }
    await mutate($, s => ({ ...s, lastContextMap: { at, text, file } }))
    await flush($)
    await $.command.run({ command: 'clear' })
  } catch (err) {
    try {
      $.ui.toast(`task-progress: context map / clear failed: ${err instanceof Error ? err.message : String(err)}`)
    } catch {
      // no toast available
    }
  }
}

function put($: any, s: Snapshot) {
  if (s === c.snap) return
  const was = allCubesDone(c.snap?.cubes)
  c.snap = s
  if (!was && allCubesDone(s.cubes) && !ctx.fired) {
    ctx.fired = true
    ctx.pending = true
    $.clock.after(CTX_DELAY_MS, () => void runContextThenClear($))
  }
  schedule($)
  syncPoll($)
}

async function mutate($: any, fn: (s: Snapshot) => Snapshot) {
  const s = await load($)
  put($, fn(s))
}

// $.agent.list() runs on a slow timer only while an agent is running.
function syncPoll($: any) {
  const isActive = !!c.snap && c.snap.agents.some(a => a.status === 'running' || a.status === 'idle')
  if (isActive && !c.poll) {
    c.poll = $.clock.every(POLL_MS, () => void pollAgents($))
  } else if (!isActive && c.poll) {
    c.poll.cancel()
    c.poll = undefined
  }
}

async function pollAgents($: any) {
  if (!c.snap) return
  const now: number = await $.clock.now()
  let s = markOverruns(c.snap, now)
  try {
    const list: { id: string; status: string }[] = (await $.agent.list()) ?? []
    for (const a of list) s = setAgentStatus(s, a.id, agentStatusOf(a.status), now)
  } catch {
    // the list is a refinement; turn.complete and notifications still land
  }
  put($, s)
}

function deps($: any, nowMs: number): CommandDeps {
  return {
    now: () => nowMs,
    newId: () => 't' + randomToken().slice(0, 10),
    get: () => c.snap!,
    put: s => put($, s),
    submit: async (text: string, opts?: { keepInputCheck?: boolean }) => {
      const out: any = await $.prompt.submit({ text })
      if (out && typeof out.deny === 'string') throw new Error(out.deny)
      // A prompt the dashboard sends is a new task: the input gate opens again.
      // Cube approvals and change requests continue the current task.
      if (!opts?.keepInputCheck) await $.state.set(checkedRef, false)
    },
    setCubesGate: async (isOn: boolean) => {
      await $.state.set(cubesGateRef, isOn ? 'on' : 'off')
    },
  }
}

/** One command from the web app. */
export async function command($: any, cmd: DashboardCommand): Promise<DashboardCommandResult> {
  await load($)
  return runCommand(cmd, deps($, await $.clock.now()))
}

// ---- web bridge -------------------------------------------------------

const openState = newOpenState()
const marksRef = { plugin: 'task-progress', key: 'webMarks' } as const

/** True when this session already opened the dashboard (survives /reload-plugins, which resets module variables). */
async function openedThisSession($: any): Promise<boolean> {
  try {
    const id = String((await $.session.id()) ?? '')
    const { value } = await $.state.get(marksRef)
    return Boolean(value && value.opened && value.sessionId === id)
  } catch {
    return false
  }
}

async function markOpened($: any): Promise<void> {
  try {
    const id = String((await $.session.id()) ?? '')
    await $.state.set(marksRef, { sessionId: id, opened: true })
  } catch {
    // the module flag still holds
  }
}

async function openDeps($: any): Promise<OpenDeps> {
  const osName = String((await $.env.get('OS')) ?? '')
  const isWin = osName === 'Windows_NT'
  let os: OpenDeps['os'] = isWin ? 'windows' : 'linux'
  if (!isWin) {
    try {
      const r = await $.process.run(['uname'])
      if (String(r.stdout).trim() === 'Darwin') os = 'mac'
    } catch {
      // keep linux
    }
  }
  return {
    os,
    programFiles: String((await $.env.get('ProgramFiles')) ?? ''),
    programFilesX86: String((await $.env.get('ProgramFiles(x86)')) ?? ''),
    localAppData: String((await $.env.get('LOCALAPPDATA')) ?? ''),
    exists: async (p: string) => {
      try {
        return Boolean(await $.fs.exists(p))
      } catch {
        return false
      }
    },
    run: async (argv: string[]) => {
      const r = await $.process.run(argv, { cwd: String((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '') || undefined })
      return { exitCode: Number(r.exitCode), stdout: String(r.stdout ?? '') }
    },
  }
}

async function openBrowser($: any, url: string) {
  try {
    await openOnce({ opened: false }, await openDeps($), url)
  } catch {
    // the URL is printed either way
  }
}

// Session start: the web dashboard is OFF by default. It starts (and opens once per session)
// only when the user turned it on with `/tp-dashboard auto on`.
export async function autoStartWeb($: any) {
  try {
    if ((await $.store.get('autoOpen')) !== true) return
    if (c.web || c.starting || openState.opened) return
    const already = await openedThisSession($)
    if (already) openState.opened = true
    const w = await startWeb($)
    if (!w || already) return
    await markOpened($)
    await openOnce(openState, await openDeps($), w.url)
  } catch {
    // best effort
  }
}

async function postResult($: any, w: Web, id: string, r: DashboardCommandResult) {
  try {
    await $.http.fetch(`http://127.0.0.1:${w.port}/api/result`, {
      method: 'POST',
      headers: { 'X-TP-Token': w.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ok: r.ok, message: r.message, data: r.data }),
    })
  } catch {
    // the browser times out on its own
  }
}

const webSessionRef = { plugin: 'task-progress', key: 'webSession' } as const

/** One token and a preferred port for the whole Claude Code session; $.state survives /reload-plugins. Never throws. */
export async function sessionWeb($: any): Promise<{ sessionId: string; token: string; port: number }> {
  let sessionId = ''
  try {
    sessionId = String((await $.session.id()) ?? '')
    const { value } = await $.state.get(webSessionRef)
    if (value && value.sessionId === sessionId && value.token && Number(value.port) > 0) {
      return { sessionId, token: String(value.token), port: Number(value.port) }
    }
  } catch {
    // fall through to a fresh record
  }
  const fresh = { sessionId, token: randomToken(), port: WEB_PORT }
  try {
    await $.state.set(webSessionRef, fresh)
  } catch {
    // kept only for this start
  }
  return fresh
}

// ---- restart after the server exits ------------------------------------

const webHeartbeatRef = { plugin: 'task-progress', key: 'webHeartbeat' } as const
const webLastExitRef = { plugin: 'task-progress', key: 'webLastExit' } as const
const webStoppedRef = { plugin: 'task-progress', key: 'webStopped' } as const
const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]
const RESTART_MAX = 5
const RESTART_WINDOW_MS = 60_000
const restart = { attempt: 0, times: [] as number[], timer: null as any }

// Backoff goes back to 1 s once a server reaches 'ready' (it bound a port).
// The 5-in-60-s cap is kept, so a server that starts and dies at once still gives up.
export function resetRestartBackoff(): void {
  restart.attempt = 0
}

// A manual start gives the cap a clean slate.
export function resetRestarts(): void {
  restart.attempt = 0
  restart.times = []
  try {
    restart.timer?.cancel?.()
  } catch {
    // already gone
  }
  restart.timer = null
}

async function stoppedByUser($: any): Promise<boolean> {
  try {
    const { value } = await $.state.get(webStoppedRef)
    return value != null && value === (await $.session.id())
  } catch {
    return false
  }
}


// ---- heartbeat: a chain of single `after` timers (a refused `every` period ends it for good) ----
const hb: { timer: { cancel: () => void } | null; lastTickAt: number; armedAt: number; gen: number } = {
  timer: null,
  lastTickAt: 0,
  armedAt: 0,
  gen: 0,
}

function cancelHeartbeat(): void {
  hb.gen++
  try {
    hb.timer?.cancel()
  } catch {
    // already gone
  }
  hb.timer = null
}

export async function armHeartbeat($: any): Promise<void> {
  cancelHeartbeat()
  const gen = hb.gen
  hb.armedAt = Number(await $.clock.now())
  if (gen !== hb.gen) return
  hb.timer = $.clock.after(HEARTBEAT_MS, async () => {
    if (gen !== hb.gen) return
    hb.timer = null
    if (!c.web) return
    try {
      hb.lastTickAt = Number(await $.clock.now())
    } catch {
      // keep the old stamp
    }
    void postSnapshot($)
    await armHeartbeat($)
  })
}

/** A watchdog, called from frequent hooks: a dropped timer is noticed, counted, and replaced. Never throws. */
export async function kickHeartbeat($: any): Promise<void> {
  try {
    if (!c.web) return
    const now = Number(await $.clock.now())
    const stale = hb.timer !== null && now - Math.max(hb.lastTickAt, hb.armedAt) > HEARTBEAT_MS * 2
    if (hb.timer !== null && !stale) return
    if (stale) {
      try {
        const { value } = await $.state.get(webHeartbeatRef)
        await $.state.set(webHeartbeatRef, { missedTicks: Number(value?.missedTicks ?? 0) + 1, lastMissAt: now })
      } catch {
        // evidence is best effort
      }
    }
    void postSnapshot($)
    await armHeartbeat($)
  } catch {
    // a watchdog must never break a hook
  }
}

// Start the server again after it exited. One timer at a time; gives up past the cap.
export async function scheduleRestart($: any): Promise<void> {
  if (restart.timer) return
  if (await stoppedByUser($)) return
  if (restart.timer) return
  const now = Number(await $.clock.now())
  restart.times = restart.times.filter(t => now - t < RESTART_WINDOW_MS)
  if (restart.times.length >= RESTART_MAX) {
    try {
      $.ui.toast('task-progress: dashboard server keeps stopping; run /tp-dashboard web to retry')
    } catch {
      // best effort
    }
    return
  }
  restart.times.push(now)
  const delay = RESTART_DELAYS_MS[Math.min(restart.attempt, RESTART_DELAYS_MS.length - 1)]
  restart.attempt++
  restart.timer = $.clock.after(delay, async () => {
    restart.timer = null
    try {
      if (c.web || (await stoppedByUser($))) return
      await startWeb($)
    } catch {
      // the next exit schedules again
    }
  })
}

export function startWeb($: any): Promise<Web | null> {
  if (c.web) return Promise.resolve(c.web)
  if (c.starting) return c.starting
  c.starting = new Promise<Web | null>(resolve => {
    let isSettled = false
    const settle = (w: Web | null) => {
      if (isSettled) return
      isSettled = true
      c.starting = null
      resolve(w)
    }
    const timer = $.clock.after(READY_TIMEOUT_MS, () => settle(null))
    void (async () => {
      let stream: any
      let web: Web | null = null
      let token = ''
      try {
        const sw = await sessionWeb($)
        token = sw.token
        stream = $.process.spawn({
          argv: ['node', `${$.plugin.root}/web/server.js`, '--port', String(sw.port), '--token', token],
        })
        let buf = ''
        for await (const chunk of stream) {
          if (chunk.stream !== 'stdout') {
            $.ui.log(`task-progress web: ${chunk.text}`, { to: 'debug' })
            continue
          }
          const { lines, rest } = splitLines(buf, chunk.text)
          buf = rest
          for (const line of lines) {
            let msg: any
            try {
              msg = JSON.parse(line)
            } catch {
              continue
            }
            if (msg?.type === 'ready' && !web && Number(msg.port) > 0) {
              const port = Number(msg.port)
              web = { token, port, url: `http://127.0.0.1:${port}/?t=${token}`, stream }
              c.web = web
              resetRestartBackoff()
              timer.cancel()
              // A heartbeat: the snapshot again every 10 s, so the server can tell the session lives.
              await armHeartbeat($)
              await $.state.set(webRef, { port, url: web.url })
              try {
                await $.state.set(webSessionRef, { sessionId: sw.sessionId, token, port })
              } catch {
                // the next start asks for the old port
              }
              await load($)
              void postSnapshot($)
              settle(web)
            } else if (msg?.type === 'exit') {
              const reason = String(msg.reason ?? 'unknown')
              try {
                await $.state.set(webLastExitRef, { reason, at: Number(msg.at) || Date.now() })
              } catch {
                // best effort
              }
              $.ui.log(`task-progress web stopped: ${reason}`, { to: 'debug' })
            } else if (msg?.type === 'command' && web) {
              // The command's own id goes back with the result; the target id is args.id.
              const { commandId, cmd } = commandFromLine(msg)
              const w = web
              void command($, cmd).then(r => postResult($, w, commandId, r))
            }
          }
        }
      } catch (err) {
        $.ui.log(`task-progress web failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
      }
      // The child exited (or could not start).
      timer.cancel()
      cancelHeartbeat()
      if (c.web && c.web.token === token) c.web = null
      try {
        await $.state.set(webRef, null)
      } catch {
        // a render may be drawing; the next start writes it again
      }
      settle(null)
      void scheduleRestart($)
    })()
  })
  return c.starting
}

async function stopWeb($: any): Promise<boolean> {
  const w = c.web
  if (!w) return false
  c.web = null
  cancelHeartbeat()
  try {
    await w.stream?.return?.()
  } catch {
    // already gone
  }
  await $.state.set(webRef, null)
  return true
}

// ---- hooks --------------------------------------------------------------

export async function onSessionStart($: any, e: any) {
  await $.command.register({
    name: 'tp-dashboard',
    description: 'Session dashboard (web): /tp-dashboard web | /tp-dashboard web stop | /tp-dashboard auto on|off',
  })
  const now: number = await $.clock.now()
  let id = ''
  try {
    id = String((await $.session.id()) ?? '')
  } catch {
    // older hosts
  }
  c.snap = emptySnapshot({ id, cwd: String(e.cwd ?? ''), startedAt: now }, await isOrchestrateOn($))
  // Resuming the same session (claude --continue / --resume) keeps the stored board, unfinished cubes
  // included, so register.tsx can reopen the cubes pane. Same id or source resume/compact keeps it;
  // /clear and a brand-new session id reset it.
  const source = String(e.source ?? '')
  try {
    const stored: any = (await $.state.get(snapRef)).value
    const sameSession = id !== '' && stored?.session?.id === id
    if (stored?.cubes && source !== 'clear' && (sameSession || source === 'resume' || source === 'compact')) {
      c.snap = { ...c.snap, cubes: normalizeBoardFlow(stored.cubes) }
      ctx.fired = allCubesDone(c.snap.cubes) // a finished plan must not fire again
    }
  } catch {
    // unreadable store: start empty
  }
  await $.state.set(snapRef, c.snap)
  await $.state.set(webRef, c.web ? { port: c.web.port, url: c.web.url } : null)
  syncPoll($)
  void autoStartWeb($)
  try {
    const u = await $.session.usage()
    await mutate($, s => setMeasure(s, u, now))
  } catch {
    // best effort: session.measure fills it later
  }
}

// session.measure: context, 5-hour and weekly limits, cost.
export async function dashUsage($: any, e: any) {
  const now: number = await $.clock.now()
  await mutate($, s => setMeasure(s, e, now))
}

// Every tool call: the biggest tool results (usage screen).
export async function onToolCall($: any, e: any, out: any) {
  void kickHeartbeat($)
  {
    const now: number = await $.clock.now()
    const tool = String(e.tool)
    const isOk = out?.deny === undefined && out?.isError !== true
    await mutate($, s => {
      let n = s
      if (isOk && tool === 'TaskStop') {
        const id = String(e.task_id ?? e.shell_id ?? '')
        if (id) n = setAgentStatus(n, id, 'stopped', now)
      }
      try {
        const text = typeof out?.text === 'string' ? out.text : typeof out?.result === 'string' ? out.result : out?.result != null ? JSON.stringify(out.result) : ''
        if (isOk && text) n = attributeTool(n, { tool, target: summarize(tool, e), chars: text.length })
      } catch {
        // bookkeeping must not break the call
      }
      return n
    })
  }
}

export async function onAgentSpawn($: any, e: any, out: any) {
  const id: string | undefined = out?.agentId
  if (out?.deny === undefined && id) {
    const b = parseBudget(e.prompt)
    const now: number = await $.clock.now()
    const a: Omit<SnapshotAgent, 'status'> = {
      id,
      description: String(e.description ?? ''),
      type: String(e.subagentType ?? ''),
      startedAt: now,
      ...(b ? { budgetMin: b.minutes } : {}),
      ...(b && b.step !== null ? { step: b.step } : {}),
      ...(b?.cubes?.[0]
        ? { cube: { id: b.cubes[0], kind: 'build' as const } }
        : b?.review?.[0]
          ? { cube: { id: b.review[0], kind: 'review' as const } }
          : {}),
    }
    await mutate($, s => addAgent(s, a))
    if (b?.cubes && b.cubes.length > 0) {
      const ids = b.cubes
      await mutate($, s => (s.cubes ? withBoard(s, markRunning(s.cubes, ids, id, now)) : s))
    }
  }
}

export async function onTurnComplete($: any, e: any) {
  void kickHeartbeat($)
  if (e.usage) {
    const at: number = await $.clock.now()
    await mutate($, s => attributeTurn(addTurnUsage(s, e.usage, at), { agentId: e.agentId, model: e.usage?.model, usage: e.usage }))
    if (!e.agentId) try {
      // optional engine API; skipped when the engine lacks it
      const m = await $.session.usage({ breakdown: 'summary' })
      await mutate($, s => setContextBreakdown(s, m))
    } catch {
      // not available
    }
  }
  const id = e.agentId as string | undefined
  if (id) {
    const now: number = await $.clock.now()
    await mutate($, s => setAgentStatus(s, id, 'done', now))
    // Its cubes are done (failed when the turn did not end with an answer); ready queued cubes go.
    const isOk = e.reason === undefined || e.reason === 'answer'
    try {
      await finishAndRelease(deps($, now), id, isOk)
    } catch (err) {
      $.ui.log(`task-progress cubes: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    }
  }
}

// Background agents end with a task notification.
export async function onPromptSubmit($: any, e: any) {
  void kickHeartbeat($)
  if (e.origin?.kind === 'task-notification' && typeof e.text === 'string') {
    const n = parseTaskNotification(e.text)
    if (n) {
      const now: number = await $.clock.now()
      await mutate($, s => {
        return s.agents.some(a => a.id === n.id) ? setAgentStatus(s, n.id, n.status, now) : s
      })
    }
  }
}

async function lastStopLine($: any): Promise<string> {
  try {
    const { value } = await $.state.get(webLastExitRef)
    if (!value?.reason) return ''
    return `\nlast stop: ${value.reason} at ${new Date(Number(value.at) || Date.now()).toLocaleTimeString('en-GB')}`
  } catch {
    return ''
  }
}

export function registerDashboard(on: any): void {
  on('command.run', { command: 'tp-dashboard' }, async ($: any, e: any) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'web') {
      try {
        await $.state.set(webStoppedRef, null)
      } catch {
        // best effort
      }
      resetRestarts()
      const w = await startWeb($)
      if (!w) return { text: 'Dashboard web server did not start (is node on PATH and web/server.js present?).' }
      void openBrowser($, w.url)
      return { text: `Dashboard web: ${w.url}${await lastStopLine($)}` }
    }
    if (arg === 'auto on' || arg === 'auto off') {
      await $.store.set('autoOpen', arg === 'auto on')
      return { text: `Dashboard auto-open ${arg === 'auto on' ? 'on' : 'off'}.` }
    }
    if (arg === 'web stop') {
      try {
        await $.state.set(webStoppedRef, await $.session.id())
      } catch {
        // best effort
      }
      return { text: ((await stopWeb($)) ? 'Dashboard web server stopped.' : 'Dashboard web server is not running.') + (await lastStopLine($)) }
    }
    let auto = false
    try {
      auto = (await $.store.get('autoOpen')) === true
    } catch {
      // best effort
    }
    return {
      text:
        'Usage: /tp-dashboard web  ·  /tp-dashboard web stop  ·  /tp-dashboard auto on|off' +
        `\nauto-open: ${auto ? 'on (turn off: /tp-dashboard auto off)' : 'off (turn on: /tp-dashboard auto on)'}` +
        (await lastStopLine($)),
    }
  })
}

export async function dashProgress($: any, p: Snapshot['progress']) {
  await mutate($, s => setProgress(s, p))
}

export async function dashPlan($: any, task: string, steps: { title: string; minutes: number }[]) {
  await mutate($, s => setPlan(s, task, steps))
}

export async function dashMode($: any, isOn: boolean) {
  await mutate($, s => ({ ...s, orchestrate: isOn }))
}

// ---- approval cubes (the orchestrator side in register.tsx calls these) ----

export async function dashGetCubes($: any): Promise<CubeBoard | null> {
  return (await load($)).cubes ?? null
}

export async function dashCubesGate($: any): Promise<boolean> {
  return ((await $.state.get(cubesGateRef)).value ?? 'on') === 'on'
}

/** A new board (or null to drop it). */
export async function dashSetCubes($: any, board: CubeBoard | null) {
  ctx.fired = false // a new plan gets its own context map
  ctx.pending = false
  await mutate($, s => withBoard(s, board))
  await flush($)
}

/** CubeRevise from the model. */
export async function dashReviseCube($: any, input: any): Promise<{ ok: boolean; message: string }> {
  const s = await load($)
  if (!s.cubes) return { ok: false, message: 'no cube board: plan the task with TaskPlan cubes first' }
  const r = reviseCube(s.cubes, input)
  if ('error' in r) return { ok: false, message: r.error }
  put($, withBoard(c.snap ?? s, r.board))
  await flush($)
  return { ok: true, message: r.message }
}

/** CubeAnswer from the model: adds Claude's answer to the cube's thread. */
export async function dashAnswerCube($: any, input: any): Promise<{ ok: boolean; message: string }> {
  const s = await load($)
  if (!s.cubes) return { ok: false, message: 'no cube board' }
  const r = answerCube(s.cubes, input, await $.clock.now())
  if ('error' in r) return { ok: false, message: r.error }
  put($, withBoard(c.snap ?? s, r.board))
  await flush($)
  return { ok: true, message: r.message }
}

/** CubeReview from the model: stores the pr-reviewer result on the cube. */
export async function dashReviewCube($: any, input: any): Promise<{ ok: boolean; message: string }> {
  const s = await load($)
  if (!s.cubes) return { ok: false, message: 'no cube board' }
  const r = await applyReview(deps($, await $.clock.now()), input)
  await flush($)
  return r
}

/** /tp-cubes on | off: the gate for the current board and new ones. */
export async function dashSetCubesGate($: any, isOn: boolean) {
  await $.state.set(cubesGateRef, isOn ? 'on' : 'off')
  await mutate($, s => (s.cubes ? withBoard(s, { ...s.cubes, gate: isOn }) : s))
}
