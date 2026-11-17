import type { Register } from 'claude-code'

import {
  dashAnswerCube,
  dashReviewCube,
  dashCubesGate,
  dashGetCubes,
  dashMode,
  dashReviseCube,
  dashSetCubes,
  dashUsage,
  dashSetCubesGate,
  dashPlan,
  dashProgress,
  onAgentSpawn,
  onPromptSubmit,
  onSessionStart,
  onToolCall,
  onTurnComplete,
  registerDashboard,
  webTarget,
} from './dashboard'
import { registerPerm } from './dash-perm'
import { mirrorToolStart,mirrorTurnEnd, registerMirror } from './dash-mirror'
import { parseBudget } from './dashboard-model'
import { buildBoard, gateCheck, topoOrder } from './cubes-model'
import type { ExecutorRun, PendingRun, TaskPlanRecord, TaskProgressRecord } from '../types/index'

const PLUGIN = 'task-progress'
export { parseBudget }
const TOOL = 'mcp__task-progress__TaskProgress'
const PLAN_TOOL = 'mcp__task-progress__TaskPlan'
const INPUTS_TOOL = 'mcp__task-progress__TaskInputs'
const CUBE_TOOL = 'mcp__task-progress__CubeRevise'
const ANSWER_TOOL = 'mcp__task-progress__CubeAnswer'
const REVIEW_TOOL = 'mcp__task-progress__CubeReview'
const OWN_TOOLS: readonly string[] = [TOOL, PLAN_TOOL, INPUTS_TOOL, CUBE_TOOL, ANSWER_TOOL, REVIEW_TOOL]
/** Tools that change state; the main session may not use them before TaskInputs. */
export const GATED_TOOLS: readonly string[] = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'Agent']
/** Share of the budget after which an executor is told to wrap up. */
export const WARN_AT = 0.8
const MAX_PARALLEL = 3
const C_WARN = '#F59E0B'
const C_OVER = '#F87171'
const BAR_CELLS = 14
const CLEAR_AFTER_MS = 8000
const TICK_MS = 120
const ANIM_MS = 600
const BAR_WIDTH = 42
const MAX_SEGMENTS = 12
const SPARKLES = ['✦', '✧', '✶', '✧']
const C_FROM = '#A5B4FC'
const C_TO = '#0A84FF'
const C_CURRENT = '#0060DF'
const C_SHIMMER = '#7DD3FC'
const C_UPCOMING = '#4B5160'

const PROMPT = [
  'Task progress bar: when the user assigns a task that will take more than ~2 steps,',
  'call TaskProgress first with your estimate of totalSteps and step 0.',
  'After each meaningful step, call it again with the new step count and a short label;',
  'revise totalSteps if your estimate changes. When finished, call it with done: true.',
  'Skip it for quick questions and one-step answers.',
  "Keep calls brief; don't mention the bar in replies.",
].join(' ')

const ORCH_PROMPT = [
  'Orchestrator mode (task-progress): you plan and delegate; Sonnet executors do the work.',
  '1) For every new user prompt call TaskInputs first (empty inputs if nothing is needed); if it lists questions, ask them in ONE AskUserQuestion before anything else.',
  '2) Break the task into steps and call TaskPlan (task, steps with minutes).',
  `3) Dispatch each step with Agent subagent_type "task-progress:executor" and a self-contained prompt whose first line is "[budget: <N>m step: <k>]"; at most ${MAX_PARALLEL} in parallel.`,
  '4) Do not edit code or run builds yourself; review reports, re-plan, update TaskProgress. If an executor ran out of time, re-dispatch the rest with a new budget.',
  'Multi-action tasks: TaskPlan `cubes` (id,title,action,flow 2-6 steps {file,fn,does,calls?} down to functions (non-code: file "shell", fn the command),after,doneWhen,minutes<=10), then STOP: the user approves each cube. Never dispatch an unapproved cube; tag "cubes: <ids>". Changes: CubeRevise.',
  'Each cube ends with a review: after its executor reports, dispatch one (tag "review: <id>", not cubes:) running Skill "pr-reviewer" on its changed files, then CubeReview; fix P0/P1 before done.',
  'Full protocol: skill task-progress:orchestrate. Executor agents ignore this section.',
].join(' ')

const FLOW_STEP_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Repo-relative path, or "shell" / "browser" / "terminal" for non-code steps.' },
    fn: { type: 'string', description: 'Function, method or component; for non-code steps the command or tool, e.g. "claude plugin test".' },
    does: { type: 'string', description: 'One short sentence (max 200 characters).' },
    calls: { type: 'string', description: 'Optional "file:fn" of the next function it calls.' },
  },
  required: ['file', 'fn', 'does'],
}

const CUBE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'c1, c2, ...' },
    title: { type: 'string' },
    action: { type: 'string', description: 'One sentence: the single thing this cube does (max ~200 characters).' },
    flow: { type: 'array', items: FLOW_STEP_SCHEMA, minItems: 2, maxItems: 6, description: '2-6 ordered function-level steps inside the cube: each names the file and function, what it does, and which function it calls next.' },
    after: { type: 'array', items: { type: 'string' }, description: 'Ids of cubes that must be done first.' },
    doneWhen: { type: 'string', description: 'A verifiable check that proves the cube is done.' },
    files: { type: 'array', items: { type: 'string' } },
    minutes: { type: 'number', minimum: 0.5, maximum: 10 },
  },
  required: ['id', 'title', 'action', 'flow', 'doneWhen', 'minutes'],
}

const progressRef = { plugin: 'task-progress', key: 'progress' } as const
const hiddenRef = { plugin: 'task-progress', key: 'hidden' } as const
const frameRef = { plugin: 'task-progress', key: 'frame' } as const
const modeRef = { plugin: 'task-progress', key: 'mode' } as const
const checkedRef = { plugin: 'task-progress', key: 'inputsChecked' } as const
const planRef = { plugin: 'task-progress', key: 'plan' } as const
const runsRef = { plugin: 'task-progress', key: 'runs' } as const
const pendingRef = { plugin: 'task-progress', key: 'pending' } as const

export function bar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS)))
  return '▓'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
}

/** `~42s`, `~3m`, `~1h 5m` (remaining) */
export function formatEta(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `~${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `~${m}m`
  return `~${Math.floor(m / 60)}h ${m % 60}m`
}

/** `42s`, `3m 5s`, `1h 5m` (elapsed) */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function formatStatus(p: TaskProgressRecord, now: number): string {
  if (p.isDone) {
    return `✓ ${p.task} · done in ${formatElapsed((p.finishedAt || now) - p.startedAt)}`
  }
  const percent = Math.round((p.step / p.totalSteps) * 100)
  const parts = [`${bar(percent)} ${percent}%`, p.task, `${p.step}/${p.totalSteps}`]
  if (p.label) parts.push(p.label)
  if (p.step === 0) {
    parts.push('estimating…')
  } else if (p.step < p.totalSteps) {
    const perStep = (now - p.startedAt) / p.step
    parts.push(`${formatEta(perStep * (p.totalSteps - p.step))} left`)
  }
  return parts.join(' · ')
}


export type Cell = { ch: string; color: string }

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

function hexToRgb(h: string): [number, number, number] {
  return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

/** Light lavender-blue to bright blue, t in 0..1 across the whole bar. */
export function gradient(t: number): string {
  const a = hexToRgb(C_FROM)
  const b = hexToRgb(C_TO)
  const x = clamp01(t)
  return '#' + a.map((v, i) => Math.round(v + (b[i]! - v) * x).toString(16).padStart(2, '0')).join('')
}

export function segmentCount(totalSteps: number): number {
  return Math.max(1, Math.min(MAX_SEGMENTS, totalSteps))
}

export function segmentWidth(segments: number): number {
  return Math.max(2, Math.floor((BAR_WIDTH - (segments - 1)) / segments))
}

/**
 * Fill of the bar in segment units (0..segments): 2.5 means two segments full and the
 * third half full. Totals above 12 steps are mapped proportionally onto 12 segments.
 */
export function barPosition(p: TaskProgressRecord, now: number, frame: number): number {
  const n = segmentCount(p.totalSteps)
  if (p.isDone) return n
  const unit = n / p.totalSteps
  const target = p.step * unit
  const sinceStep = now - p.lastStepAt
  if (p.step > p.prevStep && sinceStep < ANIM_MS) {
    // Newly completed step: fill smoothly from where the bar was.
    const from = Math.min(target, (p.prevStep + p.prevFill) * unit)
    const t = clamp01(sinceStep / ANIM_MS)
    return from + (target - from) * (1 - (1 - t) * (1 - t))
  }
  if (p.step >= p.totalSteps) return n
  let frac: number
  if (p.step === 0) {
    frac = 0.1 + 0.4 * (1 + Math.sin(frame * 0.15))
  } else {
    frac = stepFraction(p, now)
  }
  return target + frac * unit
}

/** How far through the current step the bar shows (0..0.9), from the average step time. */
export function stepFraction(
  p: { step: number; totalSteps: number; startedAt: number; lastStepAt: number },
  now: number,
): number {
  if (p.step === 0 || p.step >= p.totalSteps) return 0
  const avg = (p.lastStepAt - p.startedAt) / p.step
  return avg > 0 ? Math.min(0.9, (now - p.lastStepAt) / avg) : 0
}

/** The bar as cells: `━` in segments separated by a space, each cell with its colour. */
export function buildBar(totalSteps: number, pos: number, frame: number, isDone: boolean): Cell[] {
  const n = segmentCount(totalSteps)
  const w = segmentWidth(n)
  const total = n * w
  const cells: Cell[] = []
  const current = isDone ? -1 : Math.min(n - 1, Math.floor(pos))
  for (let i = 0; i < n; i++) {
    if (i > 0) cells.push({ ch: ' ', color: '' })
    const fill = clamp01(pos - i)
    const lit = fill >= 1 ? w : Math.round(fill * w)
    const shimmer = i === current && lit > 0 ? frame % lit : -1
    for (let j = 0; j < w; j++) {
      let color = C_UPCOMING
      if (fill >= 1) color = gradient(total > 1 ? (i * w + j) / (total - 1) : 0)
      else if (j < lit) color = j === shimmer ? C_SHIMMER : C_CURRENT
      cells.push({ ch: '━', color })
    }
  }
  return cells
}

/** `3/7 · ~2m left`, `0/7 · estimating…`, or `done in 2m 5s` */
export function formatMeta(p: TaskProgressRecord, now: number): string {
  if (p.isDone) return `done in ${formatElapsed((p.finishedAt || now) - p.startedAt)}`
  const parts = [`${p.step}/${p.totalSteps}`]
  if (p.step === 0) parts.push('estimating…')
  else if (p.step < p.totalSteps) parts.push(`${formatEta(((now - p.startedAt) / p.step) * (p.totalSteps - p.step))} left`)
  return parts.join(' · ')
}

/** `Fix login bug — step 3 of 7 (43%) · running tests · 4m 10s elapsed · ~2m left` */
export function formatReply(p: TaskProgressRecord | null | undefined, now: number): string {
  if (!p) return 'No task in progress.'
  if (p.isDone) return `✓ ${p.task} — done in ${formatElapsed((p.finishedAt || now) - p.startedAt)}`
  const percent = Math.round((p.step / p.totalSteps) * 100)
  const parts = [`${p.task} — step ${p.step} of ${p.totalSteps} (${percent}%)`]
  if (p.label) parts.push(p.label)
  parts.push(`${formatElapsed(now - p.startedAt)} elapsed`)
  if (p.step === 0) parts.push('estimating…')
  else if (p.step < p.totalSteps) parts.push(`${formatEta(((now - p.startedAt) / p.step) * (p.totalSteps - p.step))} left`)
  return parts.join(' · ')
}

export function sparkle(frame: number, isDone: boolean): string {
  return isDone ? '✓' : SPARKLES[Math.floor(frame / 2) % SPARKLES.length]!
}

export type BudgetDecision = { action: 'allow' | 'warn' | 'deny'; leftMs: number }

/** Below 80% of the budget allow, from 80% warn (still allowed), from 100% deny. */
export function budgetDecision(elapsedMs: number, budgetMs: number): BudgetDecision {
  const leftMs = budgetMs - elapsedMs
  if (elapsedMs >= budgetMs) return { action: 'deny', leftMs }
  if (elapsedMs >= budgetMs * WARN_AT) return { action: 'warn', leftMs }
  return { action: 'allow', leftMs }
}

/** `3:40 left`, or `+0:20 over` once the budget is spent. */
export function formatCountdown(leftMs: number): string {
  const s = Math.round(Math.abs(leftMs) / 1000)
  const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  return leftMs >= 0 ? `${t} left` : `+${t} over`
}

export function formatMinutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000))
  return `${m} min`
}

/** `/orchestrate` argument: on, off, status (also empty), else null. */
export function parseModeArg(arg: string): 'on' | 'off' | 'status' | null {
  const a = arg.trim().toLowerCase()
  if (a === '' || a === 'status') return 'status'
  return a === 'on' || a === 'off' ? a : null
}

export function runLabel(r: { step: number | null }, index: number): string {
  return r.step !== null ? `step ${r.step}` : `agent ${index + 1}`
}

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

/** Dashboard bookkeeping never breaks the hook it rides on. */
/** A cube tool must always answer: a throw after the board was stored would leave the call with no result. */
export async function answered(run: () => Promise<string>): Promise<{ result: string }> {
  try {
    return { result: await run() }
  } catch (err) {
    return { result: `the change may already be stored, but finishing it failed: ${String((err as any)?.message ?? err).slice(0, 200)}. Do not repeat the call; check /tp-cubes status.` }
  }
}

async function quiet(p: Promise<unknown> | undefined): Promise<void> {
  try {
    await p
  } catch {
    // best effort
  }
}

type Ctx = {
  clearTimer: { cancel: () => void } | undefined
  ticker: { cancel: () => void } | undefined
  frame: number
  /** Agents that finished before their `agent.spawn` answer came back; bounded. */
  doneIds: string[]
  /** True once our `prompt.compose` hook has run (another plugin may skip it). */
  composeSeen: boolean
  /** True once the rules were attached to a user prompt as a fallback. */
  rulesSent: boolean
}

function startTicker($: any, c: Ctx) {
  if (c.ticker) return
  c.ticker = $.clock.every(TICK_MS, () => {
    c.frame += 1
    void $.state.set(frameRef, c.frame)
  })
}

function stopTicker(c: Ctx) {
  c.ticker?.cancel()
  c.ticker = undefined
}

// The frame timer runs only while a task shows (running, or the 8 s done display)
// or an executor is counting down.
async function releaseTicker($: any, c: Ctx) {
  const { value: progress } = await $.state.get(progressRef)
  const { value: isHidden } = await $.state.get(hiddenRef)
  const { value: runs } = await $.state.get(runsRef)
  const shows = !!progress && !isHidden
  if (!shows && !(runs && runs.length > 0)) stopTicker(c)
}

async function isOn($: any): Promise<boolean> {
  return ((await $.state.get(modeRef)).value ?? 'on') === 'on'
}
async function getRuns($: any): Promise<ExecutorRun[]> {
  return (await $.state.get(runsRef)).value ?? []
}
async function getPending($: any): Promise<PendingRun[]> {
  return (await $.state.get(pendingRef)).value ?? []
}
function same(a: PendingRun, b: PendingRun): boolean {
  return a.startedAt === b.startedAt && a.budgetMs === b.budgetMs && a.step === b.step
}

async function applyProgress(
  $: any,
  c: Ctx,
  a: { task: string; totalSteps: number; step: number; label: string; done: boolean },
) {
  const now: number = await $.clock.now()
  const { value: prev } = await $.state.get(progressRef)
  const isSame = prev !== null && prev !== undefined && prev.task === a.task && !prev.isDone
  const rec: TaskProgressRecord = {
    task: a.task,
    totalSteps: a.totalSteps,
    step: a.step,
    label: a.label,
    startedAt: isSame ? prev.startedAt : now,
    lastStepAt: now,
    prevStep: isSame ? prev.step : 0,
    prevFill: isSame ? stepFraction(prev, now) : 0,
    isDone: a.done,
    finishedAt: a.done ? now : 0,
  }
  c.clearTimer?.cancel()
  c.clearTimer = undefined
  await $.state.set(hiddenRef, false)
  await $.state.set(progressRef, rec)
  await quiet(dashProgress($, { task: a.task, step: a.step, totalSteps: a.totalSteps, label: a.label, done: a.done }))
  startTicker($, c)
  if (a.done) {
    c.clearTimer = $.clock.after(CLEAR_AFTER_MS, () => {
      c.clearTimer = undefined
      void (async () => {
        await $.state.set(hiddenRef, true)
        await releaseTicker($, c)
      })()
    })
  }
}


/**
 * The enforcement rules: input gate and dispatch budget for the main session, time
 * budget for sub-agents. Plugin tools and the plugin's own calls pass. `notice` is
 * the 80% wrap-up line added to an allowed call's result.
 */
async function gateDecision($: any, e: any, isOwnCall: boolean, c: Ctx): Promise<{ deny?: string; notice?: string }> {
  if (OWN_TOOLS.includes(e.tool) || isOwnCall || !(await isOn($))) return {}
  const agentId = e.agentId as string | undefined

  if (!agentId) {
    if (!GATED_TOOLS.includes(e.tool)) return {}
    const { value: isChecked } = await $.state.get(checkedRef)
    if (!isChecked) {
      return {
        deny: `Orchestrator mode: call ${INPUTS_TOOL} first for this user prompt (an empty inputs list is fine if nothing is needed), then ${e.tool}. If it lists questions, ask them in one AskUserQuestion.`,
      }
    }
    if (e.tool === 'Agent' && !parseBudget(e.prompt)) {
      return {
        deny: `Orchestrator mode: plan before dispatching. Call ${PLAN_TOOL}, then start the Agent prompt with the line "[budget: <N>m step: <k>]" (minutes for this step).`,
      }
    }
    if (e.tool === 'Agent') {
      const board = await dashGetCubes($)
      const msg = gateCheck(board, parseBudget(e.prompt)?.cubes, parseBudget(e.prompt)?.review)
      if (msg) return { deny: `Approval cubes: ${msg}` }
    }
    return {}
  }

  // A sub-agent's call. Find its run; the first call of one that spawn could not
  // name yet claims the oldest pending dispatch.
  const now: number = await $.clock.now()
  let runs = await getRuns($)
  let run = runs.find(r => r.id === agentId)
  if (!run) {
    const pend = await getPending($)
    const first = pend[0]
    if (!first) return {}
    run = { id: agentId, ...first }
    runs = [...runs, run]
    await $.state.set(pendingRef, pend.slice(1))
    await $.state.set(runsRef, runs)
    startTicker($, c)
  }
  if (e.tool === 'Agent') return { deny: 'Executors never spawn agents. Do the step yourself and report.' }
  const d = budgetDecision(now - run.startedAt, run.budgetMs)
  if (d.action === 'deny') {
    return { deny: `Time budget of ${formatMinutes(run.budgetMs)} exceeded: stop now and return your report to the orchestrator.` }
  }
  if (d.action === 'warn' && !run.isWarned) {
    await $.state.set(runsRef, runs.map(r => (r.id === agentId ? { ...r, isWarned: true } : r)))
    const mins = Math.max(1, Math.ceil(d.leftMs / 60000))
    return { notice: `~${mins} min left of your ${formatMinutes(run.budgetMs)} budget: wrap up, no new work, prepare your report.` }
  }
  return {}
}

async function orchestrateCommand($: any, e: any) {
  const arg = parseModeArg(e.args ?? '')
  if (arg === null) return { text: 'Usage: /orchestrate on | off | status' }
  if (arg === 'on' || arg === 'off') {
    await $.state.set(modeRef, arg)
    await quiet(dashMode($, arg === 'on'))
    try {
      await $.ui.invalidate('prompt.section')
    } catch {
      // the protocol text updates with the next new thread
    }
    return { text: `Orchestrator mode ${arg}.` }
  }
  const isOrch = await isOn($)
  const runs = await getRuns($)
  const { value: plan } = await $.state.get(planRef)
  const { value: isChecked } = await $.state.get(checkedRef)
  const parts = [`Orchestrator mode ${isOrch ? 'on' : 'off'}`]
  if (isOrch) parts.push(`input check ${isChecked ? 'done' : 'pending'} for this prompt`)
  parts.push(plan ? `plan: ${plan.task}, ${plan.steps.length} steps` : 'no plan')
  parts.push(`${runs.length} executor${runs.length === 1 ? '' : 's'} running`)
  return { text: parts.join(' · ') }
}

export const register: Register = on => {
  const c: Ctx = { clearTimer: undefined, ticker: undefined, frame: 0, doneIds: [], composeSeen: false, rulesSent: false }
  // The session dashboard: /tp-dashboard and its pane. Its collectors ride on the hooks below.
  registerDashboard(on)
  registerMirror(on, webTarget)
  registerPerm(on, webTarget)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: "Show the current task's progress, or clear the bar",
    })
    // The plugin's skill is also named "orchestrate", so the engine refuses a bare /orchestrate
    // (the skill answers it as /task-progress:orchestrate). That refusal used to abort this whole
    // hook and no tool got registered, so each command registers on its own and failures are kept
    // from the tools. /tp-orchestrate always works.
    for (const name of ['orchestrate', 'tp-orchestrate']) {
      try {
        await $.command.register({ name, description: `Orchestrator mode: /${name} on | off | status` })
      } catch {
        // refused (name clash): the other spelling still works
      }
    }
    await $.tool.register({
      name: 'TaskProgress',
      description:
        'Report estimated progress of the current multi-step task; it is shown as a progress bar above the prompt. Call with step 0 and your totalSteps estimate at the start, again after each meaningful step, and with done: true at the end.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Short name of the task (max 40 characters shown).' },
          totalSteps: { type: 'integer', minimum: 1, description: 'Your estimate of the total number of steps; may be revised.' },
          step: { type: 'integer', minimum: 0, description: 'Steps completed so far.' },
          label: { type: 'string', description: 'What is happening now.' },
          done: { type: 'boolean', description: 'True when the task is finished.' },
        },
        required: ['task', 'totalSteps', 'step'],
      },
    })
    await $.tool.register({
      name: 'TaskPlan',
      description:
        'Orchestrator: register the plan before dispatching executors. One entry per step with a time budget in minutes. It also sets the progress bar (one segment per step).',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Short name of the task.' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                minutes: { type: 'number', minimum: 0.5, description: 'Time budget for the executor.' },
                executor: { type: 'string', description: 'Agent type; default task-progress:executor.' },
              },
              required: ['title', 'minutes'],
            },
          },
          cubes: {
            type: 'array',
            items: CUBE_SCHEMA,
            description:
              'Atomic approval cubes; preferred over steps. The user approves each before it runs. Break every cube down to functions: each flow step names the file and function, what it does, and which function it calls next; non-code steps use file "shell" and the command as fn. Every cube ends with a PR review (pr-reviewer skill, then CubeReview).',
          },
        },
        required: ['task'],
      },
    })
    await $.tool.register({
      name: 'CubeRevise',
      description:
        "Answer the user's change request for an approval cube: change its fields, or replace it with atomic cubes via splitInto. The cube goes back to the user for approval.",
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          action: { type: 'string' },
          flow: { type: 'array', items: FLOW_STEP_SCHEMA, description: 'Function-level steps: file, fn, does, optional calls.' },
          after: { type: 'array', items: { type: 'string' } },
          doneWhen: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          minutes: { type: 'number' },
          splitInto: { type: 'array', items: CUBE_SCHEMA },
        },
        required: ['id'],
      },
    })
    await $.tool.register({
      name: 'CubeAnswer',
      description:
        "Answer the user's question about an approval cube (a prompt starting '[cube question <id> ...]'). The answer shows in that cube's thread on the dashboard. It never changes, approves or dispatches the cube.",
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The cube id from the question prompt.' },
          answer: { type: 'string', description: 'Your answer in plain words.' },
        },
        required: ['id', 'answer'],
      },
    })
    await $.tool.register({
      name: 'CubeReview',
      description:
        "Store the PR review of a cube's changes (from the pr-reviewer skill, run by an executor after the cube's executor reported, or when a prompt starts '[cube review <id> ...]'). APPROVE lets the cube be marked done; REQUEST_CHANGES keeps it open: dispatch a fix executor for the P0/P1 findings and review again.",
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The cube id.' },
          verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'NEEDS_INVESTIGATION'] },
          summary: { type: 'string', description: 'The review in plain words.' },
          understanding: { type: 'string', description: 'The Feature Understanding Report summary.' },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
                file: { type: 'string' },
                line: { type: 'number' },
                summary: { type: 'string' },
              },
              required: ['severity', 'summary'],
            },
          },
          quiz: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                q: { type: 'string' },
                options: { type: 'array', items: { type: 'string' } },
                answer: { type: 'number', description: '0-based index of the right option.' },
              },
              required: ['q', 'options', 'answer'],
            },
          },
        },
        required: ['id', 'verdict', 'summary'],
      },
    })
    try {
      await $.command.register({
        name: 'tp-cubes',
        description: 'Approval cubes: /tp-cubes on | off | status',
      })
    } catch {
      // never let a command refusal keep the tools from registering
    }
    await $.tool.register({
      name: 'TaskInputs',
      description:
        'Call first for every new user prompt, before any edit, command or dispatch: list the inputs the task will need from the user (empty list if none). Set asked true once you have asked them.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          inputs: {
            type: 'array',
            items: {
              type: 'object',
              properties: { question: { type: 'string' }, why: { type: 'string' } },
              required: ['question', 'why'],
            },
          },
          asked: { type: 'boolean', description: 'True once the user has been asked and answered.' },
        },
        required: ['inputs', 'asked'],
      },
    })

    const { value } = await $.state.get(progressRef)
    // A finished task from an earlier session stays hidden; an unfinished one is drawn again.
    await $.state.set(hiddenRef, !value || value.isDone)
    // Sub-agents do not outlive a session.
    await $.state.set(runsRef, [])
    await $.state.set(pendingRef, [])
    stopTicker(c)
    if (value && !value.isDone) startTicker($, c)
    await quiet(onSessionStart($, e))
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e, next) => {
    const task = (String(e.task ?? '').trim() || 'Task').slice(0, 40)
    const { value: prev } = await $.state.get(progressRef)
    const totalSteps = Math.max(1, toInt(e.totalSteps, prev?.totalSteps ?? 1))
    const isDone = e.done === true
    const step = isDone ? totalSteps : Math.min(totalSteps, Math.max(0, toInt(e.step, 0)))
    const label = typeof e.label === 'string' ? e.label.trim() : ''
    await applyProgress($, c, { task, totalSteps, step, label, done: isDone })
    return { result: isDone ? `task done: ${task}` : `progress ${step}/${totalSteps} recorded` }
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e, next) => {
    const rawCubes: any[] = Array.isArray(e.cubes) ? e.cubes : []
    if (rawCubes.length > 0) {
      const task = (String(e.task ?? '').trim() || 'Task').slice(0, 40)
      const built = buildBoard(task, rawCubes, await dashCubesGate($))
      if ('error' in built) return { result: `plan not recorded: ${built.error}` }
      const board = built.board
      const steps = topoOrder(board).map(cb => ({ title: `${cb.id} · ${cb.title}`, minutes: cb.minutes }))
      const total = steps.reduce((n, st) => n + st.minutes, 0)
      await $.state.set(planRef, { task, steps, createdAt: await $.clock.now() })
      await quiet(dashSetCubes($, board))
      await applyProgress($, c, { task, totalSteps: steps.length, step: 0, label: `${steps.length} cubes · ~${Math.round(total)} min`, done: false })
      try {
        $.ui.toast(`${steps.length} cubes waiting for approval — /tp-dashboard web`)
      } catch {
        // best effort
      }
      const lanes = board.lanes.map((l, i) => `lane ${i + 1}: ${l.join(', ')}`).join('; ')
      return {
        result:
          `cube plan recorded: ${steps.length} cubes, ~${Math.round(total)} min (${lanes}). STOP now and wait: the user approves cubes on the dashboard ` +
          `and each approval arrives as a prompt. Never dispatch an unapproved cube; tag dispatches "[budget: <N>m step: <k> cubes: <ids>]".` +
          (board.gate ? '' : ' (The approval gate is off.)'),
      }
    }
    const raw: any[] = Array.isArray(e.steps) ? e.steps : []
    const steps = raw
      .map(s => ({
        title: String(s?.title ?? '').trim() || 'Step',
        minutes: Math.max(0.5, Number(s?.minutes) || 1),
        ...(typeof s?.executor === 'string' && s.executor ? { executor: s.executor } : {}),
      }))
      .slice(0, 50)
    if (steps.length === 0) return { result: 'plan not recorded: give at least one step' }
    const task = (String(e.task ?? '').trim() || 'Task').slice(0, 40)
    const plan: TaskPlanRecord = { task, steps, createdAt: await $.clock.now() }
    await $.state.set(planRef, plan)
    await quiet(dashPlan($, task, steps))
    const total = steps.reduce((n, s) => n + s.minutes, 0)
    await applyProgress($, c, { task, totalSteps: steps.length, step: 0, label: `planned · ~${Math.round(total)} min`, done: false })
    const list = steps.map((s, i) => `${i + 1}. ${s.title} (${s.minutes}m)`).join('; ')
    return {
      result:
        `plan recorded: ${steps.length} steps, ~${Math.round(total)} min. ${list}. ` +
        `Dispatch each step to task-progress:executor with the first prompt line "[budget: <N>m step: <k>]" (max ${MAX_PARALLEL} at once).`,
    }
  })

  on('tool.call', { tool: CUBE_TOOL }, async ($, e, next) =>
    answered(async () => {
      const r = await dashReviseCube($, e)
      return r.ok
        ? `${r.message}. It is back with the user as proposed; STOP and wait for the approval prompt.`
        : `cube not revised: ${r.message}`
    }),
  )

  on('tool.call', { tool: ANSWER_TOOL }, async ($, e, next) =>
    answered(async () => {
      const r = await dashAnswerCube($, e)
      return r.ok ? `${r.message}. Nothing else changed; do not act on the cube.` : `answer not posted: ${r.message}`
    }),
  )

  on('tool.call', { tool: REVIEW_TOOL }, async ($, e, next) =>
    answered(async () => {
      const r = await dashReviewCube($, e)
      return r.ok ? `${r.message}.` : `review not stored: ${r.message}`
    }),
  )

  on('command.run', { command: 'tp-cubes' }, async ($, e) => {
    const a = String(e.args ?? '').trim().toLowerCase()
    if (a === 'on' || a === 'off') {
      await dashSetCubesGate($, a === 'on')
      return { text: `Approval cubes ${a}.` }
    }
    if (a === '' || a === 'status') {
      const b = await dashGetCubes($)
      const gate = (await dashCubesGate($)) ? 'on' : 'off'
      if (!b) return { text: `Approval cubes ${gate} · no cube board` }
      const n = (st: string) => b.cubes.filter(x => x.status === st).length
      return { text: `Approval cubes ${gate} · ${b.cubes.length} cubes: ${n('proposed')} waiting, ${n('approved') + n('queued')} approved, ${n('running')} running, ${n('reviewing')} in review, ${n('done')} done` }
    }
    return { text: 'Usage: /tp-cubes on | off | status' }
  })

  on('tool.call', { tool: INPUTS_TOOL }, async ($, e, next) => {
    const inputs: { question?: string; why?: string }[] = Array.isArray(e.inputs) ? e.inputs : []
    const asked = e.asked === true
    if (inputs.length > 0 && !asked) {
      await $.state.set(checkedRef, false)
      const list = inputs.map((i, n) => `${n + 1}. ${i.question ?? ''} (why: ${i.why ?? ''})`).join(' ')
      return {
        result:
          `Ask these now in ONE AskUserQuestion call before doing anything else: ${list} ` +
          'Afterwards call TaskInputs again with asked: true.',
      }
    }
    await $.state.set(checkedRef, true)
    return { result: inputs.length === 0 ? 'input check recorded: nothing needed from the user' : 'input check recorded: user was asked' }
  })

  // A new user prompt reopens the input gate. Slash commands and injected rows do not.
  on('prompt.submit', async ($, e, next) => {
    if (!e.command && !e.isMeta) await $.state.set(checkedRef, false)
    await quiet(onPromptSubmit($, e))
    // Fallback: when another plugin bypasses prompt.compose, the rules ride with the prompt.
    if (!e.command && !e.isMeta && !c.composeSeen) {
      const orch = await isOn($)
      let text: string | null = null
      if (!c.rulesSent) {
        text =
          'task-progress rules (its system-prompt section was bypassed by another plugin, so they ride with the prompt): ' +
          (orch ? ORCH_PROMPT + ' ' : '') +
          PROMPT
        c.rulesSent = true
      } else if (orch) {
        text = 'task-progress orchestrator on: TaskInputs first, then TaskPlan, then executors with "[budget: <N>m step: <k>]".'
      }
      if (text) return next({ ...e, context: [...(e.context ?? []), text] })
    }
    return next(e)
  })

  // Dispatch: remember the budget of each tagged agent, so its tool calls can be timed.
  on('agent.spawn', async ($, e, next) => {
    const b = (await isOn($)) ? parseBudget(e.prompt) : null
    if (!b) {
      const plain: any = await next(e)
      await quiet(onAgentSpawn($, e, plain))
      return plain
    }
    const run: PendingRun = {
      step: b.step,
      startedAt: await $.clock.now(),
      budgetMs: Math.round(b.minutes * 60000),
      isWarned: false,
    }
    await $.state.set(pendingRef, [...(await getPending($)), run])
    const out: any = await next(e)
    const pend = await getPending($)
    const isStillPending = pend.some(p => same(p, run))
    const id: string | undefined = out?.agentId
    if (out?.deny !== undefined || !id) {
      await $.state.set(pendingRef, pend.filter(p => !same(p, run)))
    } else if (isStillPending) {
      await $.state.set(pendingRef, pend.filter(p => !same(p, run)))
      const runs = await getRuns($)
      if (!c.doneIds.includes(id) && !runs.some(r => r.id === id)) {
        await $.state.set(runsRef, [...runs, { id, ...run }])
        startTicker($, c)
      }
    }
    await quiet(onAgentSpawn($, e, out))
    return out
  }).catch(($, e, next) => next(e)) // timing is best effort: a failed hook must not stop a dispatch

  // An agent that finished no longer counts down.
  on('turn.complete', async ($, e, next) => {
    const id = (e as any).agentId as string | undefined
    if (id) {
      c.doneIds.push(id)
      if (c.doneIds.length > 50) c.doneIds.shift()
      const runs = await getRuns($)
      if (runs.some(r => r.id === id)) {
        await $.state.set(runsRef, runs.filter(r => r.id !== id))
        await releaseTicker($, c)
      }
    }
    await quiet(onTurnComplete($, e))
    mirrorTurnEnd($, e)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await quiet(dashUsage($, e))
    return next(e)
  })

  // The enforcement hook: input gate and dispatch budget for the main session, time
  // budget for sub-agents. Plugin tools answer in their own hooks above.
  on('tool.call', async ($, e, next) => {
    const mirrorDone = mirrorToolStart($, e)
    const d = await gateDecision($, e, next.origin?.plugin === PLUGIN, c)
    let out: any
    if (d.deny !== undefined) {
      out = { deny: d.deny }
    } else {
      out = await next(e)
      if (d.notice && out.deny === undefined) out = { ...out, context: [...(out.context ?? []), d.notice] }
    }
    mirrorDone(out)
    await quiet(onToolCall($, e, out))
    return out
  })

  // /progress: answered as plain text by the hook itself, so no model turn is started.
  on('command.run', { command: 'progress' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === '') {
      const { value } = await $.state.get(progressRef)
      return { text: formatReply(value, await $.clock.now()) }
    }
    if (arg === 'clear') {
      c.clearTimer?.cancel()
      c.clearTimer = undefined
      await $.state.set(hiddenRef, true)
      await $.state.set(progressRef, null)
      await quiet(dashProgress($, null))
      await releaseTicker($, c)
      return { text: 'Progress bar cleared.' }
    }
    return { text: 'Usage: /progress  ·  /progress clear' }
  })

  on('command.run', { command: 'orchestrate' }, orchestrateCommand)
  on('command.run', { command: 'tp-orchestrate' }, orchestrateCommand)

  // The band: one row above the prompt. Reading state while drawing subscribes this
  // instance, so every $.state.set above redraws it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value: progress } = await $.state.get(progressRef)
    const { value: isHidden } = await $.state.get(hiddenRef)
    const { value: runs = [] } = await $.state.get(runsRef)
    const showsBar = !!progress && !isHidden
    if (!showsBar && runs.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const { value: frame = 0 } = await $.state.get(frameRef)
    const now = await $.clock.now()

    const agentRow =
      runs.length > 0 ? (
        <Box>
          <Text dimColor>⏱ </Text>
          {runs.map((r, i) => {
            const left = r.startedAt + r.budgetMs - now
            const color = left < 0 ? C_OVER : left < r.budgetMs * (1 - WARN_AT) ? C_WARN : undefined
            return (
              <Text key={r.id} color={color} dimColor={color === undefined}>
                {(i > 0 ? ' · ' : '') + runLabel(r, i) + ' · ' + formatCountdown(left)}
              </Text>
            )
          })}
        </Box>
      ) : null

    if (!progress || !showsBar) return <Box flexDirection="column">{agentRow}</Box>

    const pos = barPosition(progress, now, frame)
    const cells = buildBar(progress.totalSteps, pos, frame, progress.isDone)

    // Neighbouring cells of one colour share one Text.
    const colorRuns: { text: string; color: string }[] = []
    for (const c of cells) {
      const last = colorRuns.at(-1)
      if (last && last.color === c.color) last.text += c.ch
      else colorRuns.push({ text: c.ch, color: c.color })
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={progress.isDone ? 'green' : C_TO}>{sparkle(frame, progress.isDone)} </Text>
          <Text bold>{progress.task}</Text>
          {progress.label && !progress.isDone ? <Text> · {progress.label}</Text> : null}
          <Text dimColor>{'   ' + formatMeta(progress, now)}</Text>
        </Box>
        <Box>
          {colorRuns.map((r, i) => (r.color ? <Text key={String(i)} color={r.color}>{r.text}</Text> : <Text key={String(i)}>{r.text}</Text>))}
        </Box>
        {agentRow}
      </Box>
    )
  })

  on('prompt.compose', async ($, e, next) => {
    c.composeSeen = true
    const out = await next(e)
    const sections = [...out.sections]
    if (await isOn($)) sections.push({ id: `${PLUGIN}:orchestrator`, text: ORCH_PROMPT, scope: 'session' as const })
    sections.push({ id: `${PLUGIN}:progress-bar`, text: PROMPT, scope: 'session' as const })
    return { ...out, sections }
  })
}
