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
  randomToken,
  runCommand,
  setAgentStatus,
  setPlan,
  setProgress,
  setShellStatus,
  splitLines,
  summarize,
  topFiles,
  touchFile,
  type CommandDeps,
} from './dashboard-model'

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
    c.snap = value
    return value
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
    submit: async (text: string) => {
      const out: any = await $.prompt.submit({ text })
      if (out && typeof out.deny === 'string') throw new Error(out.deny)
      // A prompt the dashboard sends is a new task: the input gate opens again.
      await $.state.set(checkedRef, false)
    },
    setOrchestrate: (isOn: boolean) => setOrchestrate($, isOn),
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
              const { type: _t, id: commandId, args, ...top } = msg
              const cmd: DashboardCommand = { ...top, ...(args && typeof args === 'object' ? args : {}), action: String(msg.action ?? '') }
              const w = web
              void command($, cmd).then(r => postResult($, w, String(commandId ?? ''), r))
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
  }
}

export async function onTurnComplete($: any, e: any) {
  const id = e.agentId as string | undefined
  if (id) {
    const now: number = await $.clock.now()
    await mutate($, s => setAgentStatus(s, id, 'done', now))
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
    const head = (title: string, extra?: string) => (
      <Box marginTop={1}>
        <Text bold color={C_ACCENT}>{title}</Text>
        {extra ? <Text dimColor>{'  ' + extra}</Text> : null}
      </Box>
    )
    if (!s) return <Text dimColor>No session data yet.</Text>

    const steps = s.plan?.steps ?? []
    const agents = s.agents
    const shells = s.shells
    const files = topFiles(s, 15)
    const log = s.toolLog.slice(-10)
    const tasks = s.tasks.filter(t => t.status !== 'done')
    const hasFinished = agents.some(a => a.status !== 'running' && a.status !== 'idle') || shells.some(x => x.status !== 'running')

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>{s.progress ? cut(s.progress.task, width - 24) : 'No task'}</Text>
          {s.progress ? <Text dimColor>{`  ${s.progress.step}/${s.progress.totalSteps}${s.progress.done ? ' · done' : ''}`}</Text> : null}
          <Text dimColor>{`  · orchestrator ${s.orchestrate ? 'on' : 'off'}`}</Text>
        </Box>
        {web ? <Text dimColor>{cut('web: ' + web.url, width)}</Text> : null}

        {head('Plan', s.plan ? cut(s.plan.task, width - 8) : 'none')}
        {steps.map(st => {
          const used = st.startedAt !== undefined ? ((st.endedAt ?? now) - st.startedAt) / 60000 : 0
          const isOpen = st.status !== 'done' && st.status !== 'skipped'
          return (
            <Box key={`step-${st.k}`}>
              <Text color={statusColor(st.status)}>{`${st.k}. ${st.status.padEnd(7)} `}</Text>
              <Text>{cut(st.title, Math.max(10, width - 40))}</Text>
              <Text dimColor>{`  ${used.toFixed(1)}/${st.minutes}m `}</Text>
              {isOpen ? <Button key={`step-done-${st.k}`} label="done" dimColor onPress={run({ action: 'step.set', k: st.k, status: 'done' })} /> : null}
              {isOpen ? <Button key={`step-skip-${st.k}`} label="skip" dimColor onPress={run({ action: 'step.set', k: st.k, status: 'skipped' })} /> : null}
            </Box>
          )
        })}

        {head('Agents', `${agents.filter(a => a.status === 'running').length} running`)}
        {agents.length === 0 ? <Text dimColor>none</Text> : null}
        {agents.map(a => (
          <Box key={`agent-${a.id}`}>
            <Text color={statusColor(a.status)}>{`${a.status.padEnd(7)} `}</Text>
            <Text>{cut(a.description || a.type || a.id, Math.max(10, width - 36))}</Text>
            <Text dimColor>{`  ${a.step !== undefined ? 'step ' + a.step + ' · ' : ''}${ago((a.endedAt ?? now) - a.startedAt)}${a.budgetMin ? '/' + a.budgetMin + 'm' : ''} `}</Text>
            {a.status === 'running' || a.status === 'idle' ? (
              <Button key={`agent-stop-${a.id}`} label="stop" onPress={run({ action: 'agent.stop', id: a.id })} />
            ) : null}
          </Box>
        ))}

        {head('Background shells')}
        {shells.length === 0 ? <Text dimColor>none</Text> : null}
        {shells.map(x => (
          <Box key={`shell-${x.id}`}>
            <Text color={statusColor(x.status)}>{`${x.status.padEnd(7)} `}</Text>
            <Text>{cut(x.description || x.command, Math.max(10, width - 30))}</Text>
            <Text dimColor>{`  ${ago((x.endedAt ?? now) - x.startedAt)}${x.exitCode !== undefined ? ' · exit ' + x.exitCode : ''} `}</Text>
            {x.status === 'running' ? <Button key={`shell-stop-${x.id}`} label="stop" onPress={run({ action: 'shell.stop', id: x.id })} /> : null}
          </Box>
        ))}
        {hasFinished ? (
          <Box>
            <Button key="clear-finished" label="clear finished" dimColor onPress={run({ action: 'items.clearFinished' })} />
          </Box>
        ) : null}

        {head('Files changed', String(s.files.length))}
        {files.length === 0 ? <Text dimColor>none</Text> : null}
        {files.map(f => (
          <Box key={`file-${f.path}`}>
            <Text dimColor>{`${f.op === 'write' ? 'W' : 'E'} ×${String(f.count).padEnd(3)} `}</Text>
            <Text>{cut(f.path, width - 10)}</Text>
          </Box>
        ))}

        {head('Tool log', `last ${log.length}`)}
        {log.map((t, i) => (
          <Box key={`log-${i}`}>
            <Text color={t.ok ? C_DIM : C_OVER}>{`${ago(now - t.at).padStart(4)} `}</Text>
            <Text>{t.tool.replace(/^mcp__[^_]+__/, '')}</Text>
            <Text dimColor>{cut(` ${t.summary}${t.agentId ? ' [' + t.agentId.slice(0, 6) + ']' : ''}`, Math.max(10, width - 24))}</Text>
          </Box>
        ))}

        {head('Tasks', `${tasks.length} open`)}
        {tasks.length === 0 ? <Text dimColor>none (add them in the web app: /tp-dashboard web)</Text> : null}
        {tasks.map(t => (
          <Box key={`task-${t.id}`}>
            <Text color={t.priority === 'high' ? C_OVER : t.priority === 'low' ? C_DIM : C_WARN}>{`${t.priority.padEnd(4)} `}</Text>
            <Text color={statusColor(t.status)}>{`${t.status.padEnd(7)} `}</Text>
            <Text>{cut(t.title, Math.max(10, width - 34))} </Text>
            <Button key={`task-done-${t.id}`} label="done" dimColor onPress={run({ action: 'task.update', id: t.id, status: 'done' })} />
            <Button key={`task-send-${t.id}`} label="send" onPress={run({ action: 'task.send', id: t.id })} />
          </Box>
        ))}
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
