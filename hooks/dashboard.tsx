// The session snapshot: a collector that keeps a Snapshot in $.state for the Cubes pane.
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
  summarize,
  type CommandDeps,
} from './dashboard-model'
import { allCubesDone, answerCube, applyReview, finishAndRelease, flowLabel, markRunning, normalizeBoardFlow, reviseCube, withBoard } from './cubes-model'
import type { CubeBoard } from '../types/index'

const FLUSH_MS = 250
const POLL_MS = 3000

const snapRef = { plugin: 'task-progress', key: 'snapshot' } as const

type DashCtx = {
  snap: Snapshot | null
  flushTimer: { cancel: () => void } | undefined
  poll: { cancel: () => void } | undefined
}

// The orchestrator's own state, shared by reference (state refs are plain literals).
const modeRef = { plugin: 'task-progress', key: 'mode' } as const
const checkedRef = { plugin: 'task-progress', key: 'inputsChecked' } as const
const cubesGateRef = { plugin: 'task-progress', key: 'cubesGate' } as const
const deferredRef = { plugin: 'task-progress', key: 'deferredPrompts' } as const

async function isOrchestrateOn($: any): Promise<boolean> {
  return ((await $.state.get(modeRef)).value ?? 'on') === 'on'
}

const c: DashCtx = { snap: null, flushTimer: undefined, poll: undefined }

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

async function flush($: any) {
  if (!c.snap) return
  await $.state.set(snapRef, c.snap)
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
  // The snapshot is unchanged between polls, so tick a key the Cubes pane reads to redraw its countdown.
  if (s.agents.some(a => a.status === 'running')) await $.state.set({ plugin: 'task-progress', key: 'paneTick' }, now)
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

/** One command from the Cubes pane. */
export async function command($: any, cmd: DashboardCommand): Promise<DashboardCommandResult> {
  await load($)
  return runCommand(cmd, deps($, await $.clock.now()))
}

// ---- hooks --------------------------------------------------------------

export async function onSessionStart($: any, e: any) {
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

// Every tool call: the biggest tool results (usage screen).
export async function onToolCall($: any, e: any, out: any) {
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
      if (e.agentId) {
        const last = `${tool} ${summarize(tool, e)}`.trim().slice(0, 80)
        const id = String(e.agentId)
        if (n.agents.some(a => a.id === id)) n = { ...n, agents: n.agents.map(a => (a.id === id ? { ...a, lastTool: last } : a)) }
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
  if (!e.agentId) await flushDeferredPrompts($)
  if (e.usage) {
    const at: number = await $.clock.now()
    await mutate($, s => attributeTurn(addTurnUsage(s, e.usage, at), { agentId: e.agentId, model: e.usage?.model, usage: e.usage }))
    if (!e.agentId) try {
      // optional engine API; skipped when the engine lacks it
      const m = await $.session.usage({ breakdown: 'summary' })
      await mutate($, s => setContextBreakdown(s, m))
      // refresh the limits too, in case session.measure did not fire
      const u = await $.session.usage()
      await mutate($, s => setMeasure(s, u, at))
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
  // prompt.submit is refused inside a tool call: queue the prompts and send them on turn.complete.
  const d = deps($, await $.clock.now())
  const queued: string[] = []
  d.submit = async (text: string) => {
    queued.push(text)
  }
  const r = await applyReview(d, input)
  if (queued.length > 0) {
    const prev: string[] = (await $.state.get(deferredRef)).value ?? []
    await $.state.set(deferredRef, [...prev, ...queued])
  }
  await flush($)
  return r
}

/** Sends the prompts a tool call had to defer; called from turn.complete. */
export async function flushDeferredPrompts($: any) {
  const list: string[] = (await $.state.get(deferredRef)).value ?? []
  if (list.length === 0) return
  await $.state.set(deferredRef, [])
  try {
    await $.prompt.submit({ text: list.join('\n') })
  } catch (err) {
    // Not sent: put them back, ahead of anything deferred meanwhile.
    const now: string[] = (await $.state.get(deferredRef)).value ?? []
    await $.state.set(deferredRef, [...list, ...now])
    $.ui.log(`task-progress deferred prompt: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

/** /tp-cubes on | off: the gate for the current board and new ones. */
export async function dashSetCubesGate($: any, isOn: boolean) {
  await $.state.set(cubesGateRef, isOn ? 'on' : 'off')
  await mutate($, s => (s.cubes ? withBoard(s, { ...s.cubes, gate: isOn }) : s))
}
