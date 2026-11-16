// Pure parts of the session dashboard: the snapshot reducers and the command
// runner. Nothing here touches `$`; dashboard.tsx wires them to the engine.
import type {
  AgentEntryStatus,
  DashboardCommand,
  DashboardCommandResult,
  ShellStatus,
  Snapshot,
  SnapshotPlanStep,
  UserTask,
  UserTaskPriority,
  UserTaskStatus,
} from '../types/index'

/** `[budget: 12m step: 2]` in a dispatch prompt; null when there is no (valid) tag. */
export function parseBudget(prompt: unknown): { minutes: number; step: number | null } | null {
  if (typeof prompt !== 'string') return null
  const lower = prompt.toLowerCase()
  const open = lower.indexOf('[budget:')
  if (open < 0) return null
  const close = lower.indexOf(']', open)
  if (close < 0) return null
  const inner = lower.slice(open + '[budget:'.length, close)
  const num = /^\s*(\d+(?:\.\d+)?)\s*m/.exec(inner)
  const minutes = num ? Number(num[1]) : 0
  if (!(minutes > 0)) return null
  const st = /step:\s*(\d+)/.exec(inner)
  return { minutes, step: st ? Number(st[1]) : null }
}

export const TOOL_LOG_MAX = 200
export const FILES_MAX = 300
const DONE_AGENT: readonly AgentEntryStatus[] = ['done', 'failed', 'stopped']
const DONE_SHELL: readonly ShellStatus[] = ['done', 'failed', 'stopped']
const STEP_STATUSES = ['pending', 'running', 'done', 'skipped', 'over'] as const
const TASK_STATUSES: readonly UserTaskStatus[] = ['todo', 'doing', 'blocked', 'done']
const PRIORITIES: readonly UserTaskPriority[] = ['low', 'med', 'high']

export function emptySnapshot(session: Snapshot['session'], orchestrate = true, tasks: UserTask[] = []): Snapshot {
  return { session, orchestrate, progress: null, plan: null, agents: [], shells: [], files: [], toolLog: [], tasks }
}

export function setProgress(s: Snapshot, p: Snapshot['progress']): Snapshot {
  return { ...s, progress: p }
}

export function setPlan(s: Snapshot, task: string, steps: { title: string; minutes: number }[]): Snapshot {
  const planSteps: SnapshotPlanStep[] = steps.map((st, i) => ({ k: i + 1, title: st.title, minutes: st.minutes, status: 'pending' }))
  return { ...s, plan: { task, steps: planSteps } }
}

export function setStep(s: Snapshot, k: number, patch: Partial<SnapshotPlanStep>): Snapshot {
  if (!s.plan || !s.plan.steps.some(st => st.k === k)) return s
  return { ...s, plan: { ...s.plan, steps: s.plan.steps.map(st => (st.k === k ? { ...st, ...patch, k: st.k } : st)) } }
}

export function addAgent(
  s: Snapshot,
  a: { id: string; description: string; type: string; startedAt: number; budgetMin?: number; step?: number },
): Snapshot {
  const agents = s.agents.filter(x => x.id !== a.id)
  agents.push({ ...a, status: 'running' })
  let out: Snapshot = { ...s, agents }
  if (a.step !== undefined) out = setStep(out, a.step, { status: 'running', agentId: a.id, startedAt: a.startedAt, endedAt: undefined })
  return out
}

export function setAgentStatus(s: Snapshot, id: string, status: AgentEntryStatus, now: number): Snapshot {
  const a = s.agents.find(x => x.id === id)
  if (!a || a.status === status) return s
  // A stop the person asked for stays a stop when the agent's turn then ends.
  if (a.status === 'stopped' && status !== 'running') return s
  const isEnd = DONE_AGENT.includes(status)
  let out: Snapshot = {
    ...s,
    agents: s.agents.map(x => (x.id === id ? { ...x, status, ...(isEnd ? { endedAt: x.endedAt ?? now } : {}) } : x)),
  }
  if (a.step !== undefined && isEnd && out.plan) {
    const st = out.plan.steps.find(x => x.k === a.step)
    if (st && st.agentId === id && (st.status === 'running' || st.status === 'over')) {
      out = setStep(out, a.step, { status: status === 'done' ? 'done' : st.status === 'over' ? 'over' : 'pending', endedAt: now })
    }
  }
  return out
}

/** Running steps whose agent has outlived the step's minutes turn `over`. */
export function markOverruns(s: Snapshot, now: number): Snapshot {
  if (!s.plan) return s
  let out = s
  for (const st of s.plan.steps) {
    if (st.status === 'running' && st.startedAt !== undefined && now - st.startedAt > st.minutes * 60000) {
      out = setStep(out, st.k, { status: 'over' })
    }
  }
  return out
}

export function addShell(s: Snapshot, sh: { id: string; command: string; description: string; startedAt: number }): Snapshot {
  return { ...s, shells: [...s.shells.filter(x => x.id !== sh.id), { ...sh, status: 'running' }] }
}

export function setShellStatus(s: Snapshot, id: string, status: ShellStatus, now: number, exitCode?: number): Snapshot {
  const sh = s.shells.find(x => x.id === id)
  if (!sh) return s
  if (sh.status === 'stopped' && status !== 'stopped') return s
  return {
    ...s,
    shells: s.shells.map(x =>
      x.id === id
        ? { ...x, status, ...(DONE_SHELL.includes(status) ? { endedAt: x.endedAt ?? now } : {}), ...(exitCode !== undefined ? { exitCode } : {}) }
        : x,
    ),
  }
}

export function touchFile(s: Snapshot, path: string, op: 'edit' | 'write', now: number): Snapshot {
  const old = s.files.find(f => f.path === path)
  const files = s.files.filter(f => f.path !== path)
  files.push({ path, op, count: (old?.count ?? 0) + 1, lastAt: now })
  return { ...s, files: files.slice(-FILES_MAX) }
}

export function logTool(s: Snapshot, entry: Snapshot['toolLog'][number]): Snapshot {
  return { ...s, toolLog: [...s.toolLog, entry].slice(-TOOL_LOG_MAX) }
}

export function clearFinished(s: Snapshot, keepLog = 20): Snapshot {
  return {
    ...s,
    agents: s.agents.filter(a => !DONE_AGENT.includes(a.status)),
    shells: s.shells.filter(x => !DONE_SHELL.includes(x.status)),
    toolLog: s.toolLog.slice(-keepLog),
  }
}

/** Files by most recent change first. */
export function topFiles(s: Snapshot, n = 15): Snapshot['files'] {
  return [...s.files].sort((a, b) => b.lastAt - a.lastAt).slice(0, n)
}

/** `$.agent.list()` status words mapped onto the dashboard's. */
export function agentStatusOf(word: string): AgentEntryStatus {
  if (word === 'completed') return 'done'
  if (word === 'failed') return 'failed'
  if (word === 'killed') return 'stopped'
  if (word === 'idle' || word === 'waiting') return 'idle'
  return 'running'
}

/** A background task's notification text: its id, how it ended, and the exit code if stated. */
export function parseTaskNotification(text: string): { id: string; status: ShellStatus; exitCode?: number } | null {
  const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/i.exec(text)?.[1]
  if (!id) return null
  const word = (/<status>\s*([^<\s]+)\s*<\/status>/i.exec(text)?.[1] ?? '').toLowerCase()
  const code = /exit code[:\s]+(-?\d+)/i.exec(text)
  const exitCode = code ? Number(code[1]) : undefined
  let status: ShellStatus = 'done'
  if (word === 'failed' || word === 'error') status = 'failed'
  else if (word === 'killed' || word === 'stopped' || word === 'cancelled') status = 'stopped'
  else if (exitCode !== undefined && exitCode !== 0) status = 'failed'
  return { id, status, ...(exitCode !== undefined ? { exitCode } : {}) }
}

/** The background task id a Bash/PowerShell `run_in_background` result names. */
export function backgroundIdOf(result: unknown, text: unknown): string | null {
  const r = result as any
  for (const k of ['backgroundTaskId', 'shellId', 'bash_id', 'task_id']) {
    if (r && typeof r[k] === 'string' && r[k]) return r[k]
  }
  const t = typeof text === 'string' ? text : typeof r === 'string' ? r : ''
  const m = /\bID:?\s*([A-Za-z0-9_-]{4,})/.exec(t)
  return m ? m[1]! : null
}

/** A short line for the tool log. */
export function summarize(tool: string, e: Record<string, unknown>): string {
  const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  let s = ''
  if (tool === 'Bash' || tool === 'PowerShell') s = str('description') || str('command')
  else if (tool === 'Agent') s = str('description')
  else if (tool === 'Grep' || tool === 'Glob') s = str('pattern')
  else s = str('file_path') || str('notebook_path') || str('path') || str('url') || str('query') || str('task') || str('description')
  if (!s) {
    for (const v of Object.values(e)) {
      if (typeof v === 'string' && v && v.length < 200) {
        s = v
        break
      }
    }
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 100 ? s.slice(0, 99) + '…' : s
}

/** What runCommand needs from the engine. Every effect goes through here, so tests can fake it. */
export type CommandDeps = {
  now: () => number
  newId: () => string
  /** Current snapshot. */
  get: () => Snapshot
  /** Replace the snapshot (the caller throttles the write). */
  put: (s: Snapshot) => void
  /** Persist the user's tasks. */
  saveTasks: (tasks: UserTask[]) => Promise<void>
  /** TaskStop on a background agent or shell. */
  stopTask: (id: string) => Promise<{ ok: boolean; message: string }>
  /** Submit a prompt to the main session. */
  submit: (text: string) => Promise<void>
  setOrchestrate: (on: boolean) => Promise<void>
}

const fail = (message: string): DashboardCommandResult => ({ ok: false, message })
const ok = (message: string): DashboardCommandResult => ({ ok: true, message })
const strArg = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** One dashboard command, from the pane or the web bridge. Never throws. */
export async function runCommand(cmd: DashboardCommand, d: CommandDeps): Promise<DashboardCommandResult> {
  try {
    const action = String(cmd?.action ?? '')
    switch (action) {
      case 'agent.stop':
      case 'shell.stop': {
        const id = strArg(cmd.id)
        if (!id) return fail('id is required')
        const isAgent = action === 'agent.stop'
        const s = d.get()
        const list = isAgent ? s.agents : s.shells
        const item = list.find(x => x.id === id)
        if (!item) return fail(`no ${isAgent ? 'agent' : 'shell'} ${id}`)
        if (item.status !== 'running' && item.status !== 'idle') return fail(`${id} is not running`)
        const r = await d.stopTask(id)
        if (!r.ok) return fail(r.message)
        const now = d.now()
        d.put(isAgent ? setAgentStatus(d.get(), id, 'stopped', now) : setShellStatus(d.get(), id, 'stopped', now))
        return ok(`${isAgent ? 'agent' : 'shell'} ${id} stopped`)
      }
      case 'step.set': {
        const k = Number(cmd.k)
        const status = strArg(cmd.status) as SnapshotPlanStep['status']
        if (!STEP_STATUSES.includes(status as any)) return fail(`status must be one of ${STEP_STATUSES.join(', ')}`)
        const s = d.get()
        if (!s.plan || !s.plan.steps.some(x => x.k === k)) return fail(`no step ${cmd.k}`)
        const isEnd = status === 'done' || status === 'skipped'
        d.put(setStep(s, k, { status, ...(isEnd ? { endedAt: d.now() } : {}) }))
        return ok(`step ${k} ${status}`)
      }
      case 'items.clearFinished': {
        d.put(clearFinished(d.get()))
        return ok('finished agents and shells cleared')
      }
      case 'task.add': {
        const title = strArg(cmd.title)
        if (!title) return fail('title is required')
        const priority = PRIORITIES.includes(cmd.priority as any) ? (cmd.priority as UserTaskPriority) : 'med'
        const now = d.now()
        const task: UserTask = {
          id: d.newId(),
          title: title.slice(0, 200),
          notes: strArg(cmd.notes).slice(0, 4000),
          status: 'todo',
          priority,
          createdAt: now,
          updatedAt: now,
          source: cmd.source === 'plan' ? 'plan' : 'user',
        }
        const s = d.get()
        const tasks = [...s.tasks, task]
        d.put({ ...s, tasks })
        await d.saveTasks(tasks)
        return ok(`task added: ${task.id}`)
      }
      case 'task.update': {
        const id = strArg(cmd.id)
        const s = d.get()
        const t = s.tasks.find(x => x.id === id)
        if (!t) return fail(`no task ${id}`)
        const next: UserTask = { ...t, updatedAt: d.now() }
        if (cmd.title !== undefined) {
          const title = strArg(cmd.title)
          if (!title) return fail('title cannot be empty')
          next.title = title.slice(0, 200)
        }
        if (cmd.notes !== undefined) next.notes = strArg(cmd.notes).slice(0, 4000)
        if (cmd.status !== undefined) {
          if (!TASK_STATUSES.includes(cmd.status as any)) return fail(`status must be one of ${TASK_STATUSES.join(', ')}`)
          next.status = cmd.status as UserTaskStatus
        }
        if (cmd.priority !== undefined) {
          if (!PRIORITIES.includes(cmd.priority as any)) return fail(`priority must be one of ${PRIORITIES.join(', ')}`)
          next.priority = cmd.priority as UserTaskPriority
        }
        const tasks = s.tasks.map(x => (x.id === id ? next : x))
        d.put({ ...s, tasks })
        await d.saveTasks(tasks)
        return ok(`task ${id} updated`)
      }
      case 'task.delete': {
        const id = strArg(cmd.id)
        const s = d.get()
        if (!s.tasks.some(x => x.id === id)) return fail(`no task ${id}`)
        const tasks = s.tasks.filter(x => x.id !== id)
        d.put({ ...s, tasks })
        await d.saveTasks(tasks)
        return ok(`task ${id} deleted`)
      }
      case 'task.send': {
        const id = strArg(cmd.id)
        const s = d.get()
        const t = s.tasks.find(x => x.id === id)
        if (!t) return fail(`no task ${id}`)
        await d.submit(`Work on this task: ${t.title}${t.notes ? '\n' + t.notes : ''}`)
        const cur = d.get()
        const tasks = cur.tasks.map(x => (x.id === id ? { ...x, status: 'doing' as const, updatedAt: d.now() } : x))
        d.put({ ...cur, tasks })
        await d.saveTasks(tasks)
        return ok(`task ${id} sent to Claude`)
      }
      case 'prompt.send': {
        const text = strArg(cmd.text)
        if (!text) return fail('text is required')
        await d.submit(text)
        return ok('prompt sent')
      }
      case 'orchestrate.set': {
        const on = cmd.on === true || cmd.on === 'on' || cmd.on === 'true'
        await d.setOrchestrate(on)
        d.put({ ...d.get(), orchestrate: on })
        return ok(`orchestrator mode ${on ? 'on' : 'off'}`)
      }
      default:
        return fail(`unknown action: ${action || '(none)'}`)
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

/**
 * A `command` line from web/server.js: its own `id` is the command id (echoed back in
 * the result); the target id, when the action has one, is `args.id`.
 */
export function commandFromLine(msg: Record<string, unknown>): { commandId: string; cmd: DashboardCommand } {
  const { type: _t, id: commandId, args, ...top } = msg as any
  const cmd: DashboardCommand = { ...top, ...(args && typeof args === 'object' ? args : {}), action: String(msg.action ?? '') }
  return { commandId: String(commandId ?? ''), cmd }
}

/** Splits a stream of text pieces into whole lines; keeps the unfinished tail. */
export function splitLines(buffer: string, piece: string): { lines: string[]; rest: string } {
  const all = (buffer + piece).split(/\r?\n/)
  const rest = all.pop() ?? ''
  return { lines: all.filter(l => l.trim() !== ''), rest }
}

/** 32 random hex characters. */
export function randomToken(): string {
  const c: any = (globalThis as any).crypto
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
