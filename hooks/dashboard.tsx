// The session dashboard: a collector that keeps a Snapshot in $.state, the
// /tp-dashboard pane, and the bridge to the local web app (web/server.js).
import type {
  DashboardCommand,
  DashboardCommandResult,
  Snapshot,
  SnapshotAgent,
  UserTask,
} from '../types/index'
import {
  addAgent,
  addShell,
  agentStatusOf,
  backgroundIdOf,
  emptySnapshot,
  logTool,
  markOverruns,
  parseBudget,
  parseTaskNotification,
  commandFromLine,
  randomToken,
  runCommand,
  addTurnUsage,
  setAgentStatus,
  setMeasure,
  setPlan,
  setProgress,
  setShellStatus,
  splitLines,
  summarize,
  topFiles,
  touchFile,
  type CommandDeps,
} from './dashboard-model'
import { answerCube, applyReview, finishAndRelease, flowLabel, markRunning, normalizeBoardFlow, reviseCube, withBoard } from './cubes-model'
import type { CubeBoard } from '../types/index'

export const PANE_ID = 'tp-dashboard'
const PANE_TITLE = 'Session dashboard'
const FLUSH_MS = 250
const POLL_MS = 3000
const WEB_PORT = 7377
const READY_TIMEOUT_MS = 8000
const HEARTBEAT_MS = 10000
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'NotebookEdit']
const C_ACCENT = '#0A84FF'
const C_WARN = '#F59E0B'
const C_OVER = '#F87171'
const C_DONE = '#34D399'
const C_DIM = '#4B5160'

const snapRef = { plugin: 'task-progress', key: 'snapshot' } as const
const webRef = { plugin: 'task-progress', key: 'web' } as const

type Web = {
  token: string
  port: number
  url: string
  stream: any
  heartbeat?: { cancel: () => void }
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
const C_CUBE_RUN = '#7DD3FC'
const C_PROPOSED = '#8B93A1'

async function isOrchestrateOn($: any): Promise<boolean> {
  return ((await $.state.get(modeRef)).value ?? 'on') === 'on'
}

async function setOrchestrate($: any, isModeOn: boolean) {
  await $.state.set(modeRef, isModeOn ? 'on' : 'off')
  try {
    await $.ui.invalidate('prompt.section')
  } catch {
    // the protocol text updates with the next new thread
  }
}

const statusColor = (s: string): string | undefined =>
  s === 'running' || s === 'doing'
    ? C_ACCENT
    : s === 'done'
      ? C_DONE
      : s === 'failed' || s === 'over' || s === 'blocked'
        ? C_OVER
        : s === 'stopped' || s === 'idle'
          ? C_WARN
          : undefined

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s
}

const c: DashCtx = { snap: null, flushTimer: undefined, poll: undefined, web: null, starting: null }

async function load($: any): Promise<Snapshot> {
  if (c.snap) return c.snap
  const { value } = await $.state.get(snapRef)
  if (value) {
    // Boards stored before function-level flow hold strings; show them as steps with only `does`.
    c.snap = value.cubes ? { ...value, cubes: normalizeBoardFlow(value.cubes) } : value
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
    await $.http.fetch(`http://127.0.0.1:${w.port}/api/snapshot`, {
      method: 'POST',
      headers: { 'X-TP-Token': w.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(c.snap),
    })
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

function put($: any, s: Snapshot) {
  if (s === c.snap) return
  c.snap = s
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
    saveTasks: async (tasks: UserTask[]) => {
      await $.store.set('tasks', tasks)
    },
    stopTask: async (id: string) => {
      const out: any = await $.tool.call({ tool: 'TaskStop', task_id: id })
      if (out?.deny !== undefined) return { ok: false, message: String(out.deny) }
      if (out?.isError) return { ok: false, message: String(out.text ?? 'TaskStop failed') }
      return { ok: true, message: 'stopped' }
    },
    submit: async (text: string, opts?: { keepInputCheck?: boolean }) => {
      const out: any = await $.prompt.submit({ text })
      if (out && typeof out.deny === 'string') throw new Error(out.deny)
      // A prompt the dashboard sends is a new task: the input gate opens again.
      // Cube approvals and change requests continue the current task.
      if (!opts?.keepInputCheck) await $.state.set(checkedRef, false)
    },
    setOrchestrate: (isOn: boolean) => setOrchestrate($, isOn),
    setCubesGate: async (isOn: boolean) => {
      await $.state.set(cubesGateRef, isOn ? 'on' : 'off')
    },
  }
}

/** One command from the pane or the web app. */
async function command($: any, cmd: DashboardCommand): Promise<DashboardCommandResult> {
  await load($)
  return runCommand(cmd, deps($, await $.clock.now()))
}

// ---- web bridge -------------------------------------------------------

async function openBrowser($: any, url: string) {
  try {
    if ((await $.env.get('OS')) === 'Windows_NT') {
      await $.process.run(['cmd', '/c', 'start', '', url])
      return
    }
    try {
      await $.process.run(['open', url])
    } catch {
      await $.process.run(['xdg-open', url])
    }
  } catch {
    // the URL is printed either way
  }
}

async function postResult($: any, w: Web, id: string, r: DashboardCommandResult) {
  try {
    await $.http.fetch(`http://127.0.0.1:${w.port}/api/result`, {
      method: 'POST',
      headers: { 'X-TP-Token': w.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ok: r.ok, message: r.message }),
    })
  } catch {
    // the browser times out on its own
  }
}

function startWeb($: any): Promise<Web | null> {
  if (c.web) return Promise.resolve(c.web)
  if (c.starting) return c.starting
  const token = randomToken()
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
      try {
        stream = $.process.spawn({
          argv: ['node', `${$.plugin.root}/web/server.js`, '--port', String(WEB_PORT), '--token', token],
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
              timer.cancel()
              // A heartbeat: the snapshot again every 10 s, so the server can tell the session lives.
              web.heartbeat = $.clock.every(HEARTBEAT_MS, () => void postSnapshot($))
              await $.state.set(webRef, { port, url: web.url })
              await load($)
              void postSnapshot($)
              settle(web)
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
      web?.heartbeat?.cancel()
      if (c.web && c.web.token === token) c.web = null
      try {
        await $.state.set(webRef, null)
      } catch {
        // a render may be drawing; the next start writes it again
      }
      settle(null)
    })()
  })
  return c.starting
}

async function stopWeb($: any): Promise<boolean> {
  const w = c.web
  if (!w) return false
  c.web = null
  w.heartbeat?.cancel()
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
    description: 'Session dashboard: /tp-dashboard | /tp-dashboard web | /tp-dashboard web stop | /tp-dashboard close',
  })
  const now: number = await $.clock.now()
  let id = ''
  try {
    id = String((await $.session.id()) ?? '')
  } catch {
    // older hosts
  }
  let tasks: UserTask[] = []
  try {
    const stored = await $.store.get('tasks')
    if (Array.isArray(stored)) tasks = stored as UserTask[]
  } catch {
    // nothing stored
  }
  c.snap = emptySnapshot({ id, cwd: String(e.cwd ?? ''), startedAt: now }, await isOrchestrateOn($), tasks)
  await $.state.set(snapRef, c.snap)
  await $.state.set(webRef, c.web ? { port: c.web.port, url: c.web.url } : null)
  syncPoll($)
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

// Every tool call: the log; edits; background shells.
export async function onToolCall($: any, e: any, out: any) {
  {
    const now: number = await $.clock.now()
    const tool = String(e.tool)
    const isOk = out?.deny === undefined && out?.isError !== true
    const agentId: string | undefined = e.agentId
    await mutate($, s => {
      let n = logTool(s, { at: now, tool, summary: summarize(tool, e), ...(agentId ? { agentId } : {}), ok: isOk })
      if (isOk && (EDIT_TOOLS.includes(tool) || tool === 'Write')) {
        const path = String(e.file_path ?? e.notebook_path ?? '')
        if (path) n = touchFile(n, path, tool === 'Write' ? 'write' : 'edit', now)
      }
      if (isOk && (tool === 'Bash' || tool === 'PowerShell') && e.run_in_background === true) {
        const id = backgroundIdOf(out?.result, out?.text)
        if (id) n = addShell(n, { id, command: String(e.command ?? ''), description: String(e.description ?? ''), startedAt: now })
      }
      if (isOk && tool === 'TaskStop') {
        const id = String(e.task_id ?? e.shell_id ?? '')
        if (id) n = setShellStatus(setAgentStatus(n, id, 'stopped', now), id, 'stopped', now)
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
    }
    await mutate($, s => addAgent(s, a))
    if (b?.cubes && b.cubes.length > 0) {
      const ids = b.cubes
      await mutate($, s => (s.cubes ? withBoard(s, markRunning(s.cubes, ids, id, now)) : s))
    }
  }
}

export async function onTurnComplete($: any, e: any) {
  if (e.usage) {
    const at: number = await $.clock.now()
    await mutate($, s => addTurnUsage(s, e.usage, at))
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

// Background shells (and agents) end with a task notification.
export async function onPromptSubmit($: any, e: any) {
  if (e.origin?.kind === 'task-notification' && typeof e.text === 'string') {
    const n = parseTaskNotification(e.text)
    if (n) {
      const now: number = await $.clock.now()
      await mutate($, s => {
        let x = setShellStatus(s, n.id, n.status, now, n.exitCode)
        if (s.agents.some(a => a.id === n.id)) x = setAgentStatus(x, n.id, n.status, now)
        return x
      })
    }
  }
}

export function registerDashboard(on: any): void {
  on('command.run', { command: 'tp-dashboard' }, async ($: any, e: any) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === '' || arg === 'open') {
      await load($)
      await flush($)
      const r: any = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
      return { text: r?.isPlaced === false ? `Dashboard pane opened but not shown: ${r.reason}` : 'Dashboard opened.' }
    }
    if (arg === 'close') {
      await $.ui.close({ id: PANE_ID })
      return { text: 'Dashboard closed.' }
    }
    if (arg === 'web') {
      const w = await startWeb($)
      if (!w) return { text: 'Dashboard web server did not start (is node on PATH and web/server.js present?).' }
      void openBrowser($, w.url)
      return { text: `Dashboard web: ${w.url}` }
    }
    if (arg === 'web stop') {
      return { text: (await stopWeb($)) ? 'Dashboard web server stopped.' : 'Dashboard web server is not running.' }
    }
    return { text: 'Usage: /tp-dashboard  ·  /tp-dashboard web  ·  /tp-dashboard web stop  ·  /tp-dashboard close' }
  })

  // ---- the pane -------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($: any, e: any) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s: Snapshot | null | undefined = (await $.state.get(snapRef)).value
    const { value: web } = await $.state.get(webRef)
    const now: number = await $.clock.now()
    const width = Math.max(30, Number(e.props?.bodyColumns ?? e.viewport?.columns ?? 80))
    const run = (cmd: DashboardCommand) => () => {
      void command($, cmd).then(r => {
        if (!r.ok) $.ui.toast(r.message)
      })
    }
    if (!s) return <Text dimColor>No session data yet.</Text>

    const inner = width - 4
    const section = (glyph: string, title: string, extra: string | undefined, body: any[], key: string) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={C_DIM} paddingX={1}>
        <Box>
          <Text bold color={C_ACCENT}>{`${glyph} ${title}`}</Text>
          {extra ? <Text dimColor>{'  ' + extra}</Text> : null}
        </Box>
        {body}
      </Box>
    )
    const none = (t = 'none') => <Text key="none" dimColor>{t}</Text>
    const glyphOf = (st: string) =>
      st === 'done'
        ? '✓'
        : st === 'running' || st === 'doing'
          ? '◐'
          : st === 'failed' || st === 'blocked' || st === 'over'
            ? '✗'
            : st === 'stopped' || st === 'idle'
              ? '◌'
              : st === 'skipped'
                ? '–'
                : '○'
    const glyphColor = (st: string) => statusColor(st) ?? C_DIM
    // A 10-cell countdown of the budget used: blue, amber after 80%, red over.
    const miniBar = (used: number, budget: number) => {
      const f = budget > 0 ? used / budget : 0
      const n = Math.min(10, Math.round(f * 10))
      return <Text color={f >= 1 ? C_OVER : f >= 0.8 ? C_WARN : C_ACCENT}>{'▰'.repeat(n) + '▱'.repeat(10 - n)}</Text>
    }

    const steps = s.plan?.steps ?? []
    const agents = s.agents
    const shells = s.shells
    const files = topFiles(s, 15)
    const log = s.toolLog.slice(-10).reverse()
    const tasks = s.tasks.filter(t => t.status !== 'done')
    const hasFinished = agents.some(a => a.status !== 'running' && a.status !== 'idle') || shells.some(x => x.status !== 'running')
    const pr = s.progress
    const nameW = Math.max(10, width - 44)
    // The header bar: one ━ segment per step (at most 12), lit up to the step reached.
    const segs = pr ? Math.max(1, Math.min(12, pr.totalSteps)) : 0
    const segW = pr ? Math.max(2, Math.floor((Math.min(48, inner - 4) - (segs - 1)) / segs)) : 0
    const lit = pr ? (pr.done ? segs : Math.min(segs, (pr.step * segs) / Math.max(1, pr.totalSteps))) : 0
    const barCells: { ch: string; color: string | undefined }[] = []
    for (let i = 0; i < segs; i++) {
      if (i > 0) barCells.push({ ch: ' ', color: undefined })
      const n = Math.max(0, Math.min(1, lit - i))
      for (let j = 0; j < segW; j++) {
        const total = segs * segW
        const t = total > 1 ? (i * segW + j) / (total - 1) : 0
        const isLit = n >= 1 || j < Math.round(n * segW)
        const g = [0xa5, 0xb4, 0xfc].map((v, k) => Math.round(v + ([0x0a, 0x84, 0xff][k]! - v) * t).toString(16).padStart(2, '0'))
        barCells.push({ ch: '━', color: isLit ? '#' + g.join('') : C_DIM })
      }
    }

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between" paddingX={1}>
          <Box>
            <Text bold color={C_CUBE_RUN}>{'✦ '}</Text>
            <Text bold>{pr ? cut(pr.task, width - 34) : 'No task'}</Text>
          </Box>
          <Text dimColor>{`${pr ? `${pr.step}/${pr.totalSteps}${pr.done ? ' · done' : ''}  ·  ` : ''}orchestrator ${s.orchestrate ? 'on' : 'off'}`}</Text>
        </Box>
        {pr ? (
          <Box paddingX={1}>
            {barCells.map((cl, i) => (
              <Text key={`bar-${i}`} color={cl.color}>{cl.ch}</Text>
            ))}
          </Box>
        ) : null}
        {web ? (
          <Box paddingX={1}>
            <Text dimColor>{cut('web: ' + web.url, inner)}</Text>
          </Box>
        ) : null}

        {s.cubes
          ? section(
              '⬢',
              'Cubes',
              `${s.cubes.cubes.filter(x => x.status === 'proposed').length} waiting · gate ${s.cubes.gate ? 'on' : 'off'}`,
              [
                s.cubes.cubes.some(x => x.status === 'proposed') ? (
                  <Box key="cubes-actions">
                    <Button key="cubes-approve-all" label="Approve all" onPress={run({ action: 'cube.approveAll' })} />
                  </Box>
                ) : null,
                <Box key="cubes-lanes" flexDirection="row" flexWrap="wrap">
                  {s.cubes.lanes.map((lane, li) => {
                    const laneW = Math.max(24, Math.floor(inner / Math.max(1, Math.min(3, s.cubes!.lanes.length))) - 1)
                    return (
                      <Box key={`lane-${li}`} flexDirection="column" width={laneW} marginRight={1}>
                        <Text dimColor>{li === 0 ? 'lane 1 · start' : `lane ${li + 1}`}</Text>
                        {lane.map(id => {
                          const cb = s.cubes!.cubes.find(x => x.id === id)
                          if (!cb) return null
                          const col = cubeColor(cb.status)
                          const flow = cb.flow.length > 2 ? [...cb.flow.slice(0, 2), null] : cb.flow
                          const rv = cb.review
                          const sev = (n: string) => (rv?.findings ?? []).filter(x => x.severity === n).length
                          const blockers = [sev('P0') ? `P0×${sev('P0')}` : '', sev('P1') ? `P1×${sev('P1')}` : ''].filter(Boolean).join(' ')
                          const isOpen = cb.status === 'proposed' || cb.status === 'failed' || cb.status === 'rejected' || cb.status === 'revising'
                          const canChange = cb.status !== 'running' && cb.status !== 'reviewing' && cb.status !== 'done'
                          const g = cb.status === 'approved' || cb.status === 'queued' || cb.status === 'proposed' ? 'pending' : cb.status === 'rejected' ? 'failed' : cb.status === 'reviewing' ? 'doing' : cb.status
                          return (
                            <Box key={`cube-${cb.id}`} flexDirection="column" borderStyle="round" borderColor={col} paddingX={1}>
                              <Box>
                                <Text bold color={col}>{cb.id + ' '}</Text>
                                <Text>{cut(cb.title, Math.max(8, laneW - 18))}</Text>
                                <Text dimColor>{`  ${cb.minutes}m`}</Text>
                                {cb.thread && cb.thread.length > 0 ? <Text dimColor>{`  💬 ${cb.thread.length}`}</Text> : null}
                              </Box>
                              <Text color={col}>{`${glyphOf(g)} ${cb.status === 'reviewing' ? 'in review' : cb.status}${cb.after.length ? ' · after ' + cb.after.join(',') : ''}`}</Text>
                              {flow.map((f, i) =>
                                f === null ? (
                                  <Text key={`cube-${cb.id}-f${i}`} dimColor>{`… +${cb.flow.length - 2} more`}</Text>
                                ) : (
                                  <Box key={`cube-${cb.id}-f${i}`} flexDirection="column">
                                    <Text dimColor>{cut(`${i + 1} ${flowLabel(f)}${f.file || f.fn ? '  ' + f.does : ''}`, laneW - 4)}</Text>
                                    {f.calls ? <Text dimColor>{cut(`  → ${f.calls.split('/').pop()}`, laneW - 4)}</Text> : null}
                                  </Box>
                                ),
                              )}
                              {rv ? (
                                <Text color={rv.status === 'passed' ? C_DONE : rv.status === 'running' ? C_CUBE_RUN : rv.status === 'changes' ? C_OVER : C_WARN}>
                                  {cut(
                                    rv.status === 'running'
                                      ? 'review ◐ running'
                                      : rv.status === 'passed'
                                        ? 'review ✓ APPROVE'
                                        : `review ${rv.status === 'changes' ? '✗ REQUEST CHANGES' : '? NEEDS INVESTIGATION'}${blockers ? ` · ${blockers}` : ''}`,
                                    laneW - 4,
                                  )}
                                </Text>
                              ) : null}
                              {cb.note ? <Text color={C_WARN}>{cut('note: ' + cb.note, laneW - 4)}</Text> : null}
                              {canChange ? (
                                <Box>
                                  {isOpen ? <Button key={`cube-ok-${cb.id}`} label="Approve" onPress={run({ action: 'cube.approve', id: cb.id })} /> : null}
                                  <Button
                                    key={`cube-chg-${cb.id}`}
                                    label="Change"
                                    dimColor
                                    onPress={run({ action: 'cube.requestChange', id: cb.id, note: 'Changed from the pane — ask the user what to change' })}
                                  />
                                  {cb.status !== 'rejected' ? (
                                    <Button key={`cube-rej-${cb.id}`} label="Reject" dimColor onPress={run({ action: 'cube.reject', id: cb.id })} />
                                  ) : null}
                                </Box>
                              ) : null}
                            </Box>
                          )
                        })}
                      </Box>
                    )
                  })}
                </Box>,
              ],
              'sec-cubes',
            )
          : null}

        {section(
          '◆',
          'Plan',
          s.plan ? cut(s.plan.task, inner - 8) : 'none',
          steps.map(st => {
            const used = st.startedAt !== undefined ? ((st.endedAt ?? now) - st.startedAt) / 60000 : 0
            const isOpen = st.status !== 'done' && st.status !== 'skipped'
            return (
              <Box key={`step-${st.k}`}>
                <Text color={glyphColor(st.status)}>{`${glyphOf(st.status)} `}</Text>
                <Text dimColor>{`${String(st.k).padStart(2)}. `}</Text>
                <Text>{cut(st.title, Math.max(10, width - 30)).padEnd(Math.min(nameW, 40))}</Text>
                <Text dimColor>{` ${used.toFixed(1)}/${st.minutes}m `}</Text>
                {isOpen ? <Button key={`step-done-${st.k}`} label="done" dimColor onPress={run({ action: 'step.set', k: st.k, status: 'done' })} /> : null}
                {isOpen ? <Button key={`step-skip-${st.k}`} label="skip" dimColor onPress={run({ action: 'step.set', k: st.k, status: 'skipped' })} /> : null}
              </Box>
            )
          }),
          'sec-plan',
        )}

        {section(
          '◷',
          'Executors',
          `${agents.filter(a => a.status === 'running').length} running`,
          [
            agents.length === 0 ? none() : null,
            ...agents.map(a => {
              const usedMin = ((a.endedAt ?? now) - a.startedAt) / 60000
              return (
                <Box key={`agent-${a.id}`}>
                  <Text color={glyphColor(a.status)}>{`${glyphOf(a.status)} `}</Text>
                  <Text>{cut(a.description || a.type || a.id, nameW).padEnd(Math.min(nameW, 36))}</Text>
                  <Text dimColor>{` ${a.step !== undefined ? 's' + a.step : '  '} `}</Text>
                  {a.budgetMin ? miniBar(usedMin, a.budgetMin) : <Text dimColor>{'··········'}</Text>}
                  <Text dimColor>{` ${ago((a.endedAt ?? now) - a.startedAt)}${a.budgetMin ? '/' + a.budgetMin + 'm' : ''} `}</Text>
                  {a.status === 'running' || a.status === 'idle' ? (
                    <Button key={`agent-stop-${a.id}`} label="stop" onPress={run({ action: 'agent.stop', id: a.id })} />
                  ) : null}
                </Box>
              )
            }),
          ],
          'sec-agents',
        )}

        {section(
          '▣',
          'Background shells',
          undefined,
          [
            shells.length === 0 ? none() : null,
            ...shells.map(x => (
              <Box key={`shell-${x.id}`}>
                <Text color={glyphColor(x.status)}>{`${glyphOf(x.status)} `}</Text>
                <Text>{cut(x.description || x.command, Math.max(10, width - 30))}</Text>
                <Text dimColor>{`  ${ago((x.endedAt ?? now) - x.startedAt)}${x.exitCode !== undefined ? ' · exit ' + x.exitCode : ''} `}</Text>
                {x.status === 'running' ? <Button key={`shell-stop-${x.id}`} label="stop" onPress={run({ action: 'shell.stop', id: x.id })} /> : null}
              </Box>
            )),
            hasFinished ? (
              <Box key="clear-box">
                <Button key="clear-finished" label="clear finished" dimColor onPress={run({ action: 'items.clearFinished' })} />
              </Box>
            ) : null,
          ],
          'sec-shells',
        )}

        {section(
          '✎',
          'Files changed',
          String(s.files.length),
          [
            files.length === 0 ? none() : null,
            ...files.map(f => (
              <Box key={`file-${f.path}`}>
                <Text color={f.op === 'write' ? C_DONE : C_WARN}>{`${f.op === 'write' ? 'W' : 'E'} `}</Text>
                <Text dimColor>{`×${String(f.count).padEnd(3)} `}</Text>
                <Text>{cut(f.path, inner - 8)}</Text>
              </Box>
            )),
          ],
          'sec-files',
        )}

        {section(
          '▤',
          'Tools',
          `last ${log.length}, newest first`,
          log.map((t, i) => {
            const name = t.tool.replace(/^mcp__[^_]+__/, '')
            return (
              <Box key={`log-${i}`}>
                <Text dimColor>{`${ago(now - t.at).padStart(4)} `}</Text>
                <Text color={t.ok ? C_CUBE_RUN : C_OVER}>{`${t.ok ? '·' : '✗'} ${cut(name, 14).padEnd(14)}`}</Text>
                <Text dimColor>{cut(` ${t.summary}${t.agentId ? ' [' + t.agentId.slice(0, 6) + ']' : ''}`, Math.max(10, inner - 24))}</Text>
              </Box>
            )
          }),
          'sec-tools',
        )}

        {section(
          '▦',
          'Tasks',
          `${tasks.length} open`,
          [
            tasks.length === 0 ? none('none (add them in the web app: /tp-dashboard web)') : null,
            ...tasks.map(t => (
              <Box key={`task-${t.id}`}>
                <Text color={glyphColor(t.status)}>{`${glyphOf(t.status)} `}</Text>
                <Text color={t.priority === 'high' ? C_OVER : t.priority === 'low' ? C_DIM : C_WARN}>{`${t.priority.padEnd(4)} `}</Text>
                <Text>{cut(t.title, Math.max(10, width - 34))} </Text>
                <Button key={`task-done-${t.id}`} label="done" dimColor onPress={run({ action: 'task.update', id: t.id, status: 'done' })} />
                <Button key={`task-send-${t.id}`} label="send" onPress={run({ action: 'task.send', id: t.id })} />
              </Box>
            )),
          ],
          'sec-tasks',
        )}
      </Box>
    )
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

export function cubeColor(status: string): string {
  if (status === 'approved' || status === 'queued') return C_ACCENT
  if (status === 'running') return C_CUBE_RUN
  if (status === 'reviewing') return C_WARN
  if (status === 'done') return C_DONE
  if (status === 'failed' || status === 'rejected') return C_OVER
  if (status === 'revising') return C_WARN
  return C_PROPOSED
}
