// Approval cubes: the pure parts. A task is broken into atomic cubes; the user
// approves (or changes) each one before it runs. Nothing here touches `$`.
import type { Cube, CubeBoard, CubeMessage, CubeReview, CubeStatus, DashboardCommand, DashboardCommandResult, FlowStep, ReviewFinding, ReviewQuiz, ReviewVerdict, Snapshot, SnapshotPlanStep } from '../types/index'

export const CUBE_MAX = 40
export const CUBE_MAX_MINUTES = 10
export const FLOW_MIN = 2
export const FLOW_MAX = 6
export const ACTION_MAX = 200
const TITLE_MAX = 80
const NOTE_MAX = 2000
const CUBE_STATUSES: readonly CubeStatus[] = ['proposed', 'approved', 'queued', 'running', 'reviewing', 'done', 'failed', 'skipped', 'rejected', 'revising']
/** A dependency in one of these states lets its dependents run ('reviewing' does not: the PR review gates 'done'). */
const SATISFIED: readonly CubeStatus[] = ['done', 'skipped']
/** Cubes the user may approve. */
const APPROVABLE: readonly CubeStatus[] = ['proposed', 'failed', 'rejected', 'revising']
/** Cubes that are finished or out of the run. */
const CLOSED: readonly CubeStatus[] = ['done', 'skipped', 'rejected', 'failed']

/** What the model (or the user) gives for one cube. */
export type CubeSpec = {
  id: string
  title: string
  action: string
  flow: FlowStep[]
  after: string[]
  doneWhen: string
  files?: string[]
  minutes: number
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const strList = (v: unknown) => (Array.isArray(v) ? v.map(x => str(x)).filter(x => x !== '') : [])
const FLOW_FILE_MAX = 200
const FLOW_FN_MAX = 120
const FLOW_DOES_MAX = 200
const FLOW_CALLS_MAX = 240
const FLOW_EXAMPLE = '{"file":"hooks/register.tsx","fn":"onPromptSubmit","does":"resets the input gate","calls":"hooks/dashboard.tsx:onPromptSubmit"}'

/** One flow item from tool input. A bare string (boards stored before 0.10) keeps its text in `does` only. */
export function normalizeFlowStep(v: any): FlowStep {
  if (typeof v === 'string') return { file: '', fn: '', does: v.trim().slice(0, FLOW_DOES_MAX) }
  const calls = str(v?.calls).slice(0, FLOW_CALLS_MAX)
  return {
    file: str(v?.file).slice(0, FLOW_FILE_MAX),
    fn: str(v?.fn).slice(0, FLOW_FN_MAX),
    does: str(v?.does).slice(0, FLOW_DOES_MAX),
    ...(calls ? { calls } : {}),
  }
}
const flowList = (v: unknown): FlowStep[] => (Array.isArray(v) ? v.map(normalizeFlowStep) : [])

/** Normalizes a stored board for display: string flow items become `{file:'',fn:'',does}`. */
export function normalizeBoardFlow(board: CubeBoard): CubeBoard {
  if (!board.cubes.some(c => c.flow.some(f => typeof f === 'string'))) return board
  return { ...board, cubes: board.cubes.map(c => ({ ...c, flow: c.flow.map(f => (typeof f === 'string' ? normalizeFlowStep(f) : f)) })) }
}

/** `register.tsx › onPromptSubmit()` or `$ claude plugin test`; the legacy string form is just its text. */
export function flowLabel(f: FlowStep): string {
  if (!f.file && !f.fn) return f.does
  if (['shell', 'browser', 'terminal'].includes(f.file)) return `$ ${f.fn}`
  const base = f.file.split(/[\/]/).pop() || f.file
  return `${base} › ${f.fn}${/[()]/.test(f.fn) ? '' : '()'}`
}

const idList = (v: unknown) => [...new Set(strList(v).map(x => x.toLowerCase()))]

/** Raw tool / command input to a CubeSpec. Missing fields stay empty for the atomic check to name. */
export function normalizeCube(raw: any, fallbackId = ''): CubeSpec {
  const action = str(raw?.action)
  const title = str(raw?.title) || action.slice(0, TITLE_MAX)
  const files = strList(raw?.files)
  const minutes = Number(raw?.minutes)
  return {
    id: (str(raw?.id) || fallbackId).toLowerCase(),
    title: title.slice(0, TITLE_MAX),
    action,
    flow: flowList(raw?.flow),
    after: idList(raw?.after),
    doneWhen: str(raw?.doneWhen),
    ...(files.length > 0 ? { files } : {}),
    minutes: Number.isFinite(minutes) ? minutes : NaN,
  }
}

/** Why a cube is not atomic, or null when it is. */
export function checkAtomic(c: CubeSpec, checkFlowItems = true): string | null {
  const name = c.id ? `Cube ${c.id}` : 'A cube'
  if (!c.id) return 'A cube has no id: give every cube an id like "c1".'
  if (!/^[a-z0-9_-]{1,20}$/.test(c.id)) return `${name}: id must be 1-20 letters, digits, "-" or "_".`
  if (!c.action) return `${name} has no action: state the single thing it does in one sentence.`
  if (c.action.length > ACTION_MAX)
    return `${name} is not atomic: its action is ${c.action.length} characters (max ${ACTION_MAX}). An action that long does more than one thing; split ${c.id} into smaller cubes.`
  if (c.flow.length < FLOW_MIN) return `Give cube ${c.id} at least ${FLOW_MIN} flow steps (2-${FLOW_MAX} ordered micro-steps).`
  if (c.flow.length > FLOW_MAX)
    return `${name} is not atomic: its flow has ${c.flow.length} steps (max ${FLOW_MAX}). Split ${c.id} into smaller cubes.`
  for (let i = 0; checkFlowItems && i < c.flow.length; i++) {
    const f = c.flow[i]!
    if (!f.file || !f.fn || !f.does)
      return `${name}: flow[${i}] needs file, fn and does — e.g. ${FLOW_EXAMPLE}. Non-code steps use file "shell" and the command as fn.`
  }
  if (!c.doneWhen) return `${name} has no doneWhen: give a check that proves it is done (a test, a command, a visible result).`
  if (!(c.minutes > 0)) return `${name} needs minutes: a number from 0.5 to ${CUBE_MAX_MINUTES}.`
  if (c.minutes > CUBE_MAX_MINUTES)
    return `${name} is not atomic: ${c.minutes} minutes is over the ${CUBE_MAX_MINUTES}-minute limit. Split ${c.id} into smaller cubes.`
  return null
}

/** Duplicate ids, too many cubes, unknown `after` ids or a cycle; null when the graph is sound. */
export function checkGraph(cubes: { id: string; after: string[] }[]): string | null {
  if (cubes.length > CUBE_MAX) return `${cubes.length} cubes is too many (max ${CUBE_MAX}): group the work into fewer, still atomic, cubes or plan the task in phases.`
  const ids = new Set<string>()
  for (const c of cubes) {
    if (ids.has(c.id)) return `Duplicate cube id ${c.id}: every cube needs its own id.`
    ids.add(c.id)
  }
  for (const c of cubes) {
    for (const a of c.after) {
      if (a === c.id) return `Cube ${c.id} lists itself in "after".`
      if (!ids.has(a)) return `Cube ${c.id} depends on unknown cube ${a}: fix its "after".`
    }
  }
  // Depth-first search for a cycle; names it when found.
  const byId = new Map(cubes.map(c => [c.id, c]))
  const mark = new Map<string, 1 | 2>()
  const path: string[] = []
  const visit = (id: string): string | null => {
    if (mark.get(id) === 2) return null
    if (mark.get(id) === 1) {
      const loop = [...path.slice(path.indexOf(id)), id]
      return `Cubes form a cycle: ${loop.join(' -> ')}. Remove one of these "after" links.`
    }
    mark.set(id, 1)
    path.push(id)
    for (const a of byId.get(id)?.after ?? []) {
      const r = visit(a)
      if (r) return r
    }
    path.pop()
    mark.set(id, 2)
    return null
  }
  for (const c of cubes) {
    const r = visit(c.id)
    if (r) return r
  }
  return null
}

/** Cube ids grouped by dependency depth: lane 0 has no deps; each lane keeps input order. Assumes no cycle. */
export function computeLanes(cubes: { id: string; after: string[] }[]): string[][] {
  const byId = new Map(cubes.map(c => [c.id, c]))
  const depth = new Map<string, number>()
  const depthOf = (id: string, seen: Set<string>): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return 0
    seen.add(id)
    const deps = (byId.get(id)?.after ?? []).filter(a => byId.has(a))
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(a => depthOf(a, seen)))
    depth.set(id, d)
    return d
  }
  const lanes: string[][] = []
  for (const c of cubes) {
    const d = depthOf(c.id, new Set())
    while (lanes.length <= d) lanes.push([])
    lanes[d]!.push(c.id)
  }
  return lanes
}

/** Cubes in a topological order: lane by lane. */
export function topoOrder(board: Pick<CubeBoard, 'cubes' | 'lanes'>): Cube[] {
  const byId = new Map(board.cubes.map(c => [c.id, c]))
  return board.lanes.flat().map(id => byId.get(id)!).filter(Boolean)
}

/** The 1-based plan step of a cube, as in `[budget: Nm step: k cubes: id]`. */
export function stepOf(board: CubeBoard, id: string): number {
  return topoOrder(board).findIndex(c => c.id === id) + 1
}

export function withLanes(board: CubeBoard): CubeBoard {
  return { ...board, lanes: computeLanes(board.cubes) }
}

/** Every spec atomic and the graph sound, or the first reason it is not. */
export function validateSpecs(specs: CubeSpec[]): string | null {
  for (const s of specs) {
    const r = checkAtomic(s)
    if (r) return r
  }
  return checkGraph(specs)
}

function toCube(s: CubeSpec, editedBy?: 'user' | 'claude', version = 1): Cube {
  return { ...s, status: 'proposed', version, ...(editedBy ? { editedBy } : {}) }
}

/** A new board from TaskPlan's `cubes`, or the reason the whole plan is rejected. */
export function buildBoard(task: string, raws: unknown[], gate: boolean): { board: CubeBoard } | { error: string } {
  if (raws.length === 0) return { error: 'cubes is empty: give at least one cube.' }
  const specs = raws.map((r, i) => normalizeCube(r, `c${i + 1}`))
  const err = validateSpecs(specs)
  if (err) return { error: err }
  return { board: withLanes({ task, gate, cubes: specs.map(s => toCube(s)), lanes: [] }) }
}

export function depsSatisfied(board: CubeBoard, c: Cube): boolean {
  return c.after.every(a => {
    const d = board.cubes.find(x => x.id === a)
    return !d || SATISFIED.includes(d.status)
  })
}

/** A rejected dependency blocks a cube until the user edits or deletes it. */
export function blockedBy(board: CubeBoard, c: Cube): Cube | null {
  for (const a of c.after) {
    const d = board.cubes.find(x => x.id === a)
    if (d && d.status === 'rejected') return d
  }
  return null
}

/** True when the board still has work that is not finished. */
export function isBoardOpen(board: CubeBoard | null | undefined): boolean {
  return !!board && board.cubes.some(c => !CLOSED.includes(c.status))
}

const spec = (c: Cube): CubeSpec => ({
  id: c.id,
  title: c.title,
  action: c.action,
  flow: c.flow,
  after: c.after,
  doneWhen: c.doneWhen,
  ...(c.files ? { files: c.files } : {}),
  minutes: c.minutes,
})

/** Applies fields from `patch` (only the ones given) to a cube's spec. */
function patched(c: Cube, patch: any): CubeSpec {
  const merged: any = { ...spec(c) }
  for (const k of ['title', 'action', 'flow', 'after', 'doneWhen', 'files', 'minutes']) {
    if (patch?.[k] !== undefined) merged[k] = patch[k]
  }
  merged.id = c.id
  const n = normalizeCube(merged, c.id)
  if (patch?.title === undefined) n.title = c.title
  return n
}

/** An edit of one cube by the user (`cube.update`, `cube.move`) or Claude (CubeRevise without a split). */
export function editCube(board: CubeBoard, id: string, patch: any, by: 'user' | 'claude'): { board: CubeBoard } | { error: string } {
  const c = board.cubes.find(x => x.id === id)
  if (!c) return { error: `no cube ${id}` }
  if (c.status === 'running' || c.status === 'reviewing' || c.status === 'done') return { error: `Cube ${id} is ${c.status}; it can no longer be changed.` }
  const s = patched(c, patch)
  // A legacy cube (string flow items, empty file/fn) stays editable while the edit leaves its flow alone.
  const err = checkAtomic(s, patch?.flow !== undefined) ?? checkGraph(board.cubes.map(x => (x.id === id ? s : x)))
  if (err) return { error: err }
  const isReset = by === 'claude' || c.status === 'approved' || c.status === 'queued'
  const next: Cube = {
    ...c,
    ...s,
    version: c.version + 1,
    editedBy: by,
    status: isReset ? 'proposed' : c.status,
  }
  if (!s.files) delete next.files
  if (by === 'claude') delete next.note
  return { board: withLanes({ ...board, cubes: board.cubes.map(x => (x.id === id ? next : x)) }) }
}

/**
 * CubeRevise: change a cube, or replace it with `splitInto` cubes. Split cubes with no
 * `after` given chain on: the first takes the original's deps, each next one the one
 * before. Dependents of the original then wait on the last split cube.
 */
export function reviseCube(board: CubeBoard, input: any): { board: CubeBoard; message: string } | { error: string } {
  const id = str(input?.id).toLowerCase()
  const c = board.cubes.find(x => x.id === id)
  if (!c) return { error: `no cube ${id || '(id missing)'}` }
  if (c.status === 'running' || c.status === 'reviewing' || c.status === 'done') return { error: `Cube ${id} is ${c.status}; it can no longer be changed.` }
  const split: any[] = Array.isArray(input?.splitInto) ? input.splitInto : []
  if (split.length === 0) {
    const r = editCube(board, id, input, 'claude')
    if ('error' in r) return r
    const v = r.board.cubes.find(x => x.id === id)!.version
    return { board: r.board, message: `cube ${id} revised (v${v})` }
  }
  const specs: CubeSpec[] = []
  split.forEach((raw, i) => {
    const s = normalizeCube(raw, i === 0 ? id : `${id}-${i + 1}`)
    const hasAfter = Array.isArray(raw?.after)
    if (!hasAfter) s.after = i === 0 ? [...c.after] : [specs[i - 1]!.id]
    specs.push(s)
  })
  const last = specs[specs.length - 1]!.id
  const others = board.cubes.filter(x => x.id !== id)
  const clash = specs.find(s => others.some(o => o.id === s.id))
  if (clash) return { error: `Split cube id ${clash.id} is already used by another cube: pick new ids.` }
  for (const s of specs) {
    const r = checkAtomic(s)
    if (r) return { error: r }
  }
  const rewired = others.map(o => (o.after.includes(id) ? { ...o, after: [...new Set(o.after.map(a => (a === id ? last : a)))] } : o))
  const pos = board.cubes.findIndex(x => x.id === id)
  const newCubes = specs.map(s => toCube(s, 'claude', s.id === id ? c.version + 1 : 1))
  const all = [...rewired.slice(0, pos), ...newCubes, ...rewired.slice(pos)]
  const err = checkGraph(all)
  if (err) return { error: err }
  return {
    board: withLanes({ ...board, cubes: all }),
    message: `cube ${id} split into ${specs.map(s => s.id).join(', ')}`,
  }
}

export const THREAD_MAX = 50
export const THREAD_TEXT_MAX = 2000

/** Appends one message to a cube's thread; nothing else on the cube changes (version included). */
export function addThreadMessage(board: CubeBoard, id: string, role: 'user' | 'claude', text: string, at: number): CubeBoard {
  const msg: CubeMessage = { role, text: text.slice(0, THREAD_TEXT_MAX), at }
  return {
    ...board,
    cubes: board.cubes.map(c => (c.id === id ? { ...c, thread: [...(c.thread ?? []), msg].slice(-THREAD_MAX) } : c)),
  }
}

/** CubeAnswer: Claude's reply to a cube question. */
export function answerCube(board: CubeBoard, input: any, at: number): { board: CubeBoard; message: string } | { error: string } {
  const id = str(input?.id).toLowerCase()
  if (!board.cubes.some(x => x.id === id)) return { error: `no cube ${id || '(id missing)'}` }
  const answer = str(input?.answer)
  if (!answer) return { error: 'answer is empty: say it in plain words' }
  return { board: addThreadMessage(board, id, 'claude', answer, at), message: `answer posted to ${id}` }
}

/** The prompt that carries a cube question into the session. */
export function askPrompt(c: Cube, text: string): string {
  return (
    `[cube question ${c.id} "${c.title}"] ${text}
` +
    `Answer only (do not change, approve, revise or dispatch this cube): call CubeAnswer with id "${c.id}" and your answer in plain words.`
  )
}

export const REVIEW_TEXT_MAX = 4000
export const REVIEW_FINDINGS_MAX = 50
export const REVIEW_QUIZ_MAX = 10
const VERDICTS: readonly ReviewVerdict[] = ['APPROVE', 'REQUEST_CHANGES', 'NEEDS_INVESTIGATION']
const SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const
const NON_CODE = ['shell', 'browser', 'terminal']

/** Repo files a cube touches: its flow files (code steps only) plus `files`. */
export function reviewFiles(c: Cube): string[] {
  const fromFlow = c.flow.map(f => f.file).filter(f => f && !NON_CODE.includes(f))
  return [...new Set([...fromFlow, ...(c.files ?? [])])]
}

/** CubeReview: stores the pr-reviewer result on a cube and maps the verdict to a review status. */
export function reviewCubeResult(board: CubeBoard, input: any, at: number): { board: CubeBoard; message: string } | { error: string } {
  const id = str(input?.id).toLowerCase()
  const c = board.cubes.find(x => x.id === id)
  if (!c) return { error: `no cube ${id || '(id missing)'}` }
  const verdict = str(input?.verdict).toUpperCase().replace(/[\s-]+/g, '_') as ReviewVerdict
  if (!VERDICTS.includes(verdict)) return { error: `verdict must be one of ${VERDICTS.join(', ')}` }
  const summary = str(input?.summary).slice(0, REVIEW_TEXT_MAX)
  if (!summary) return { error: 'summary is empty: say in plain words what the review found' }
  const understanding = str(input?.understanding).slice(0, REVIEW_TEXT_MAX)
  const findings: ReviewFinding[] = []
  const rawFindings: any[] = Array.isArray(input?.findings) ? input.findings : []
  for (let i = 0; i < rawFindings.length; i++) {
    const f = rawFindings[i]
    const severity = str(f?.severity).toUpperCase()
    if (!(SEVERITIES as readonly string[]).includes(severity)) return { error: `findings[${i}].severity must be P0, P1, P2 or P3` }
    const text = str(f?.summary).slice(0, REVIEW_TEXT_MAX)
    if (!text) return { error: `findings[${i}] needs a summary` }
    const file = str(f?.file)
    const line = Number(f?.line)
    findings.push({
      severity: severity as ReviewFinding['severity'],
      ...(file ? { file: file.slice(0, FLOW_FILE_MAX) } : {}),
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      summary: text,
    })
  }
  const quiz: ReviewQuiz[] = []
  const rawQuiz: any[] = Array.isArray(input?.quiz) ? input.quiz : []
  for (let i = 0; i < rawQuiz.length; i++) {
    const q = rawQuiz[i]
    const options = strList(q?.options)
    const answer = Number(q?.answer)
    if (!str(q?.q) || options.length < 2 || !Number.isInteger(answer) || answer < 0 || answer >= options.length)
      return { error: `quiz[${i}] needs q, at least 2 options and answer as the 0-based index of the right option` }
    quiz.push({ q: str(q.q).slice(0, REVIEW_TEXT_MAX), options: options.map(o => o.slice(0, 500)), answer })
  }
  const status: CubeReview['status'] = verdict === 'APPROVE' ? 'passed' : verdict === 'REQUEST_CHANGES' ? 'changes' : 'investigate'
  const review: CubeReview = {
    status,
    verdict,
    summary,
    ...(understanding ? { understanding } : {}),
    ...(findings.length ? { findings: findings.slice(0, REVIEW_FINDINGS_MAX) } : {}),
    ...(quiz.length ? { quiz: quiz.slice(0, REVIEW_QUIZ_MAX) } : {}),
    at,
  }
  // Changes requested: the cube is not done; it goes back to approved so a fix executor can be dispatched.
  const reopen = status === 'changes' && (c.status === 'done' || c.status === 'failed' || c.status === 'reviewing')
  // APPROVE is what turns a cube that finished its work ('reviewing') into 'done', which releases its dependents.
  const finish = status === 'passed' && c.status === 'reviewing'
  const next = setCube(board, id, { review, ...(reopen ? { status: 'approved' as const } : finish ? { status: 'done' as const } : {}) })
  const blocking = (review.findings ?? []).filter(f => f.severity === 'P0' || f.severity === 'P1').length
  const message =
    status === 'passed'
      ? `review stored for ${id}: APPROVE; ${finish ? 'the cube is done and its dependents are released' : 'the cube is unchanged'}`
      : status === 'changes'
        ? `review stored for ${id}: REQUEST_CHANGES (${blocking} P0/P1 finding${blocking === 1 ? '' : 's'}). The cube is not done: dispatch a task-progress:executor (tag "cubes: ${id}") to fix the P0/P1 findings, then run the review again and call CubeReview.`
        : `review stored for ${id}: NEEDS_INVESTIGATION; look into the open questions; the cube stays in review until a review approves it`
  return { board: next, message }
}

/** The prompt that starts a pr-reviewer pass on a cube. */
export function reviewPrompt(c: Cube): string {
  const files = reviewFiles(c)
  return (
    `[cube review ${c.id} "${c.title}"] Run the pr-reviewer skill on this cube's changes (files: ${files.length ? files.join(', ') : 'see the cube diff'}). ` +
    `Dispatch it to a task-progress:executor whose first line is "[budget: <N>m step: <k> review: ${c.id}]" and whose prompt tells it to invoke Skill "pr-reviewer" on those files/diff and return verdict, findings (P0-P3 with file:line), ` +
    `the understanding summary and 3 quiz questions; then call CubeReview with id "${c.id}".`
  )
}

export function setCube(board: CubeBoard, id: string, patch: Partial<Cube>): CubeBoard {
  return { ...board, cubes: board.cubes.map(c => (c.id === id ? { ...c, ...patch, id: c.id } : c)) }
}

/** Queued cubes whose deps are all done turn approved; they are returned to be announced. */
export function releaseReady(board: CubeBoard): { board: CubeBoard; released: Cube[] } {
  const released = board.cubes.filter(c => c.status === 'queued' && depsSatisfied(board, c) && !blockedBy(board, c))
  if (released.length === 0) return { board, released }
  const ids = released.map(c => c.id)
  const next = { ...board, cubes: board.cubes.map(c => (ids.includes(c.id) ? { ...c, status: 'approved' as const } : c)) }
  return { board: next, released: next.cubes.filter(c => ids.includes(c.id)) }
}

/** The flow as one line for prompts: `1) file:fn does -> calls`. */
export function flowText(c: Pick<Cube, 'flow'>): string {
  return c.flow
    .map((f, i) => (!f.file && !f.fn ? `${i + 1}) ${f.does}` : `${i + 1}) ${f.file}:${f.fn} ${f.does}${f.calls ? ` -> ${f.calls}` : ''}`))
    .join(' ')
}

function cubeBrief(board: CubeBoard, c: Cube): string {
  const flow = flowText(c)
  const files = c.files && c.files.length > 0 ? `; files: ${c.files.join(', ')}` : ''
  return `action: ${c.action}; flow: ${flow}; done when: ${c.doneWhen}${files}. Dispatch it with [budget: ${c.minutes}m step: ${stepOf(board, c.id)} cubes: ${c.id}].`
}

/** The prompt that tells the model to run approved cubes. */
export function approvalPrompt(board: CubeBoard, cubes: Cube[]): string {
  if (cubes.length === 1) {
    const c = cubes[0]!
    return `The user approved cube ${c.id} — ${c.title}. Execute it now: ${cubeBrief(board, c)}`
  }
  const lines = cubes.map(c => `- cube ${c.id} — ${c.title}: ${cubeBrief(board, c)}`)
  return [
    `The user approved ${cubes.length} cubes that are ready to run now. They do not depend on each other, so you may run them in parallel (at most 3 at once):`,
    ...lines,
  ].join('\n')
}

export function changePrompt(c: Cube, note: string): string {
  const flow = flowText(c)
  return (
    `The user wants cube ${c.id} changed: ${note}. Current cube: ${c.id} — ${c.title}; action: ${c.action}; flow: ${flow}; ` +
    `after: ${c.after.length ? c.after.join(', ') : 'none'}; done when: ${c.doneWhen}; minutes: ${c.minutes}` +
    `${c.files && c.files.length ? '; files: ' + c.files.join(', ') : ''}. ` +
    `Call CubeRevise for it (split it if it is not atomic). Don't execute anything yet.`
  )
}

/** The deny message for a main-session Agent dispatch, or null when it may go. */
export function gateCheck(board: CubeBoard | null | undefined, tagged: string[] | undefined, review?: string[]): string | null {
  if (!board || !board.gate) return null
  if (review && review.length > 0) {
    if (tagged && tagged.length > 0) return 'A dispatch carries either "cubes:" (executors) or "review:" (a PR review), not both. Dispatch them separately.'
    for (const raw of review) {
      const id = raw.toLowerCase()
      const c = board.cubes.find(x => x.id === id)
      if (!c) return `There is no cube ${id} on the board. Tag "review:" only with existing cubes.`
      if (c.status !== 'reviewing' && c.status !== 'done' && c.status !== 'failed') return `Cube ${id} is ${c.status}, not in review: "review:" is only for a cube whose executor finished (reviewing; done or failed for a re-review). Use "cubes: ${id}" to run it.`
    }
    return null
  }
  const ids = (tagged ?? []).map(x => x.toLowerCase())
  if (ids.length === 0) {
    if (!isBoardOpen(board)) return null
    return 'Approval cubes are on: tag the cubes this dispatch runs in its first line, e.g. "[budget: 6m step: 2 cubes: c3]". Only cubes the user approved may run; wait for the approval prompt.'
  }
  for (const id of ids) {
    const c = board.cubes.find(x => x.id === id)
    if (!c) return `There is no cube ${id} on the board. Tag only existing, approved cubes.`
    if (c.status === 'approved') continue
    if (c.status === 'queued' && depsSatisfied(board, c)) continue
    if (c.status === 'queued') return `Cube ${id} is approved but waits for ${c.after.filter(a => !SATISFIED.includes(board.cubes.find(x => x.id === a)?.status as CubeStatus)).join(', ')} to finish — wait for it.`
    if (c.status === 'running') return `Cube ${id} is already running.`
    if (c.status === 'done') return `Cube ${id} is already done.`
    if (c.status === 'reviewing') return `Cube ${id} is in review: dispatch the review with the first line "[budget: <N>m step: <k> review: ${id}]" (not "cubes:"; Skill "pr-reviewer"), then CubeReview. Only a REQUEST_CHANGES review reopens it for a fix.`
    if (c.status === 'revising') return `Cube ${id} is waiting for your CubeRevise and then the user's approval — wait for it.`
    return `Cube ${id} is waiting for the user's approval — wait for it.`
  }
  return null
}

export function markRunning(board: CubeBoard, ids: string[], agentId: string, now: number): CubeBoard {
  const want = ids.map(x => x.toLowerCase())
  return {
    ...board,
    cubes: board.cubes.map(c => (want.includes(c.id) ? { ...c, status: 'running' as const, agentId, startedAt: now, endedAt: undefined } : c)),
  }
}

/**
 * The running cubes of a finished agent turn: failed when it did not end well; with the gate on they
 * go to 'reviewing' (the PR review makes them done); with the gate off they are done as before.
 */
export function finishAgent(board: CubeBoard, agentId: string, isOk: boolean, now: number): CubeBoard {
  if (!board.cubes.some(c => c.agentId === agentId && c.status === 'running')) return board
  return {
    ...board,
    cubes: board.cubes.map(c =>
      c.agentId === agentId && c.status === 'running' ? { ...c, status: isOk ? (board.gate ? ('reviewing' as const) : ('done' as const)) : ('failed' as const), endedAt: now } : c,
    ),
  }
}

const STEP_OF: Record<CubeStatus, SnapshotPlanStep['status']> = {
  proposed: 'pending',
  approved: 'pending',
  queued: 'pending',
  revising: 'pending',
  running: 'running',
  reviewing: 'running',
  done: 'done',
  failed: 'over',
  skipped: 'skipped',
  rejected: 'skipped',
}

/** The plan section mirrors the cube board: one step per cube, in topological order. */
export function planFromBoard(board: CubeBoard): NonNullable<Snapshot['plan']> {
  return {
    task: board.task,
    steps: topoOrder(board).map((c, i) => ({
      k: i + 1,
      title: `${c.id} · ${c.title}`,
      minutes: c.minutes,
      status: STEP_OF[c.status],
      ...(c.agentId ? { agentId: c.agentId } : {}),
      ...(c.startedAt !== undefined ? { startedAt: c.startedAt } : {}),
      ...(c.endedAt !== undefined ? { endedAt: c.endedAt } : {}),
    })),
  }
}

/** A snapshot with a new board: lanes recomputed, plan mirrored. `null` drops the board. */
export function withBoard(s: Snapshot, board: CubeBoard | null): Snapshot {
  if (!board) return { ...s, cubes: null }
  const b = withLanes(normalizeBoardFlow(board))
  return { ...s, cubes: b, plan: planFromBoard(b) }
}

/** What the cube commands need; a subset of the dashboard's CommandDeps. */
export type CubeDeps = {
  now: () => number
  get: () => Snapshot
  put: (s: Snapshot) => void
  submit: (text: string, opts?: { keepInputCheck?: boolean }) => Promise<void>
  setCubesGate?: (on: boolean) => Promise<void>
}

const fail = (message: string): DashboardCommandResult => ({ ok: false, message })
const ok = (message: string): DashboardCommandResult => ({ ok: true, message })

/** Puts the board, releases any queued cubes that became ready, and announces them in one prompt. */
async function commit(d: CubeDeps, board: CubeBoard, extra: Cube[] = []): Promise<Cube[]> {
  const r = releaseReady(withLanes(board))
  d.put(withBoard(d.get(), r.board))
  const ready = [...extra, ...r.released.filter(x => !extra.some(e => e.id === x.id))].map(x => r.board.cubes.find(c => c.id === x.id)!)
  if (ready.length > 0) await d.submit(approvalPrompt(r.board, ready), { keepInputCheck: true })
  return ready
}

/**
 * A command's cube fields. The command's own `action` names the command, so the cube's
 * action sentence travels as `actionText` (or `cubeAction`, which commandFromLine sets
 * from `args.action`).
 */
export function cubeFields(cmd: DashboardCommand): Record<string, unknown> {
  const text = cmd.actionText ?? cmd.cubeAction
  const out: Record<string, unknown> = {}
  for (const k of ['title', 'flow', 'after', 'doneWhen', 'files', 'minutes']) if (cmd[k] !== undefined) out[k] = cmd[k]
  if (text !== undefined) out.action = text
  return out
}

/** An agent's turn ended: its running cubes go to review (done when the gate is off, failed on error), and ready queued cubes are released. */
export async function finishAndRelease(d: CubeDeps, agentId: string, isOk: boolean): Promise<Cube[]> {
  const board = d.get().cubes
  if (!board || !board.cubes.some(c => c.agentId === agentId && c.status === 'running')) return []
  const next = finishAgent(board, agentId, isOk, d.now())
  const ready = await commit(d, next)
  const inReview = next.cubes.filter(c => c.agentId === agentId && c.status === 'reviewing')
  if (inReview.length > 0) await d.submit(inReview.map(reviewNotice).join('\n'), { keepInputCheck: true })
  return ready
}

/** The instruction that tells Claude a finished cube waits for its PR review. */
export function reviewNotice(c: Pick<Cube, 'id'>): string {
  return `Cube ${c.id} is in review: dispatch a review executor tagged "[budget: <N>m step: <k> review: ${c.id}]" (Skill "pr-reviewer" on its files), then CubeReview.`
}

/** CubeReview from the model: stores the result; an APPROVE makes the cube done and releases its dependents. */
export async function applyReview(d: CubeDeps, input: any): Promise<{ ok: boolean; message: string }> {
  const board = d.get().cubes
  if (!board) return { ok: false, message: 'no cube board' }
  const r = reviewCubeResult(board, input, d.now())
  if ('error' in r) return { ok: false, message: r.error }
  await commit(d, r.board)
  return { ok: true, message: r.message }
}

/** Approves one cube in `board` (no side effects): approved when its deps are done, else queued. */
function approveOne(board: CubeBoard, id: string): { board: CubeBoard; isReady: boolean } | { error: string } {
  const c = board.cubes.find(x => x.id === id)
  if (!c) return { error: `no cube ${id}` }
  if (c.status === 'approved' || c.status === 'queued') return { error: `cube ${id} is already ${c.status}` }
  if (!APPROVABLE.includes(c.status)) return { error: `cube ${id} is ${c.status}` }
  const blocker = blockedBy(board, c)
  if (blocker) return { error: `Cube ${id} depends on ${blocker.id}, which was rejected: edit ${id}'s dependencies or delete ${blocker.id} first.` }
  const isReady = depsSatisfied(board, c)
  const next = setCube(board, id, { status: isReady ? 'approved' : 'queued' })
  const n = next.cubes.find(x => x.id === id)!
  delete n.note
  return { board: next, isReady }
}

/** The `cube.*` and `cubes.*` dashboard commands; null for any other action. */
export async function runCubeCommand(cmd: DashboardCommand, d: CubeDeps): Promise<DashboardCommandResult | null> {
  const action = String(cmd?.action ?? '')
  if (!action.startsWith('cube.') && !action.startsWith('cubes.')) return null
  const s = d.get()
  if (action === 'cubes.gate') {
    const on = cmd.on === true || cmd.on === 'on' || cmd.on === 'true'
    if (d.setCubesGate) await d.setCubesGate(on)
    if (s.cubes) d.put(withBoard(s, { ...s.cubes, gate: on }))
    return ok(`cube approval gate ${on ? 'on' : 'off'}`)
  }
  const board = s.cubes
  if (!board) return fail('no cube board: Claude has not planned this task in cubes')
  const id = str(cmd.id).toLowerCase()
  switch (action) {
    case 'cube.approve': {
      const r = approveOne(board, id)
      if ('error' in r) return fail(r.error)
      const ready = await commit(d, r.board, r.isReady ? [r.board.cubes.find(c => c.id === id)!] : [])
      return ok(ready.some(c => c.id === id) ? `cube ${id} approved and sent to Claude` : `cube ${id} queued: it runs once its dependencies are done`)
    }
    case 'cube.approveAll': {
      let b = board
      const ready: Cube[] = []
      let queued = 0
      for (const c of topoOrder(board)) {
        if (c.status !== 'proposed') continue
        const r = approveOne(b, c.id)
        if ('error' in r) continue
        b = r.board
        if (r.isReady) ready.push(b.cubes.find(x => x.id === c.id)!)
        else queued += 1
      }
      if (ready.length === 0 && queued === 0) return fail('no proposed cubes to approve')
      const sent = await commit(d, b, ready)
      return ok(`${sent.length} cube${sent.length === 1 ? '' : 's'} sent to Claude, ${queued} queued`)
    }
    case 'cube.markDone': {
      // Escape hatch: force a cube done without a review (nothing deadlocks if the review cannot run).
      const c = board.cubes.find(x => x.id === id)
      if (!c) return fail(`no cube ${id}`)
      if (c.status !== 'reviewing' && c.status !== 'failed' && c.status !== 'approved') return fail(`cube ${id} is ${c.status}: only a cube in review, failed or approved can be marked done`)
      await commit(d, setCube(board, id, { status: 'done', endedAt: c.endedAt ?? d.now() }))
      return ok(`cube ${id} marked done without review`)
    }
    case 'cube.reject': {
      const c = board.cubes.find(x => x.id === id)
      if (!c) return fail(`no cube ${id}`)
      if (c.status === 'running' || c.status === 'done') return fail(`cube ${id} is ${c.status}`)
      const note = str(cmd.note).slice(0, NOTE_MAX)
      await commit(d, setCube(board, id, { status: 'rejected', ...(note ? { note } : {}) }))
      return ok(`cube ${id} rejected`)
    }
    case 'cube.update':
    case 'cube.move': {
      const patch = action === 'cube.move' ? { after: cmd.after } : cubeFields(cmd)
      if (action === 'cube.move' && !Array.isArray(cmd.after)) return fail('after must be a list of cube ids')
      const r = editCube(board, id, patch, 'user')
      if ('error' in r) return fail(r.error)
      await commit(d, r.board)
      return ok(`cube ${id} updated`)
    }
    case 'cube.requestChange': {
      const c = board.cubes.find(x => x.id === id)
      if (!c) return fail(`no cube ${id}`)
      if (c.status === 'running' || c.status === 'done') return fail(`cube ${id} is ${c.status}`)
      const note = str(cmd.note).slice(0, NOTE_MAX)
      if (!note) return fail('note is required: say what to change')
      const next = setCube(board, id, { status: 'revising', note })
      d.put(withBoard(d.get(), next))
      await d.submit(changePrompt(next.cubes.find(x => x.id === id)!, note), { keepInputCheck: true })
      return ok(`change request for cube ${id} sent to Claude`)
    }
    case 'cube.ask': {
      const c = board.cubes.find(x => x.id === id)
      if (!c) return fail(`no cube ${id}`)
      const text = str(cmd.text).slice(0, THREAD_TEXT_MAX)
      if (!text) return fail('text is required: ask a question')
      const next = addThreadMessage(board, id, 'user', text, d.now())
      d.put(withBoard(d.get(), next))
      await d.submit(askPrompt(c, text), { keepInputCheck: true })
      return ok(`question for cube ${id} sent to Claude`)
    }
    case 'cube.review': {
      const c = board.cubes.find(x => x.id === id)
      if (!c) return fail(`no cube ${id}`)
      if (c.status === 'running') return fail(`cube ${id} is still running: review it once its executor reports`)
      if (c.status !== 'done' && c.status !== 'reviewing' && c.status !== 'approved' && c.status !== 'failed') return fail(`cube ${id} is ${c.status}: nothing to review yet`)
      const next = setCube(board, id, { review: { status: 'running', at: d.now() } })
      d.put(withBoard(d.get(), next))
      await d.submit(reviewPrompt(c), { keepInputCheck: true })
      return ok(`review of cube ${id} sent to Claude`)
    }
    case 'cube.add': {
      const n = Math.max(0, ...board.cubes.map(c => Number(/^c(\d+)$/.exec(c.id)?.[1] ?? 0))) + 1
      const sp = normalizeCube({ ...cubeFields(cmd), id: `c${n}` })
      const err = checkAtomic(sp) ?? checkGraph([...board.cubes, sp])
      if (err) return fail(err)
      await commit(d, { ...board, cubes: [...board.cubes, toCube(sp, 'user')] })
      return ok(`cube c${n} added`)
    }
    case 'cube.delete': {
      const c = board.cubes.find(x => x.id === id)
      if (!c) return fail(`no cube ${id}`)
      if (c.status === 'running') return fail(`cube ${id} is running`)
      const cubes = board.cubes.filter(x => x.id !== id).map(x => (x.after.includes(id) ? { ...x, after: x.after.filter(a => a !== id) } : x))
      await commit(d, { ...board, cubes })
      return ok(`cube ${id} deleted`)
    }
    default:
      return fail(`unknown action: ${action}`)
  }
}

export function isCubeStatus(v: unknown): v is CubeStatus {
  return CUBE_STATUSES.includes(v as CubeStatus)
}
