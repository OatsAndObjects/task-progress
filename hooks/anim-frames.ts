// Pure animation frames for the task-progress band and pane. No clock, no I/O: time comes in as arguments.
export interface AnimAgent { id: string; label: string; startedAt: number; lastTool?: string; budgetMs?: number; type?: string }
export type Span = { text: string; color?: string; bold?: boolean; dim?: boolean }
export type Line = Span[]

const ORANGE = '#D97757'
const SOFT_TEAL = '#9CCFD8'

const VERBS = [
  'Pondering', 'Brewing', 'Conjuring', 'Noodling', 'Tinkering', 'Percolating', 'Simmering', 'Ruminating',
  'Cogitating', 'Marinating', 'Untangling', 'Spelunking', 'Whittling', 'Daydreaming', 'Fermenting', 'Puzzling',
  'Concocting', 'Meandering', 'Rummaging', 'Weaving', 'Polishing', 'Sleuthing', 'Doodling', 'Churning',
  'Forging', 'Mulling',
]

function hash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h
}

export function verbFor(agentId: string, now: number): string {
  const win = Math.floor(now / 3000)
  return VERBS[(hash(agentId) + win * 5) % VERBS.length] + '…'
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

// ---- helpers ----
const textLen = (l: Line) => l.reduce((n, s) => n + s.text.length, 0)

function clipLine(l: Line, width: number): Line {
  const out: Line = []
  let left = Math.max(0, width)
  for (const s of l) {
    if (left <= 0) break
    out.push(s.text.length <= left ? s : { ...s, text: s.text.slice(0, left) })
    left -= s.text.length
  }
  return out
}

function centre(l: Line, width: number): Line {
  const pad = Math.max(0, Math.floor((width - textLen(l)) / 2))
  return clipLine(pad ? [{ text: ' '.repeat(pad) }, ...l] : l, width)
}

function trunc(s: string, n: number): string {
  if (n <= 0) return ''
  if (s.length <= n) return s
  return n === 1 ? s.slice(0, 1) : s.slice(0, n - 1) + '…'
}

// ---- mascot: the literal Claude Code creature (orange, 3 lines, 9 columns). No invented faces. ----
// The body strings below never change. All creativity is motion and effects around it, inside a fixed slot.
export const MASCOT_COLOR = ORANGE
export const HEAD = '▐▛███▜▌'
const BODY_TOP = ' ▐▛███▜▌ '
const BODY_MID = '▝▜█████▛▘'
const BODY_LEGS = '  ▘▘ ▝▝  '
/** The fixed slot a mascot and its effects live in: 13 columns by 3 lines. */
export const SLOT_W = 13
export const SLOT_ROWS = 3
const BODY_W = 9
/** Ticks per scene frame (the one frame ticker drives everything; sleepy just advances slower). */
const EVERY = 2
const SLEEPY_EVERY = 5
/** How long an agent has been quiet before it dozes off. */
export const SLEEPY_AFTER_MS = 20_000
/** How long the arrival slide lasts after a run starts. */
export const ARRIVE_MS = 1500
/** How long the failed shake and ! last. */
export const FAIL_MS = 1500
// Arrival, celebration and failure frames come from the time since their start (no new clock: `now` is passed in).
const CELEBRATE_FRAME_MS = 250
const ARRIVE_FRAME_MS = 250
const FAIL_FRAME_MS = 250

export type SceneKey = 'typing' | 'terminal' | 'searching' | 'thinking' | 'fetching' | 'sleepy' | 'arrives' | 'celebrate' | 'fail'

type Fx = [row: number, col: number, ch: string]
type FrameSpec = { x: number; hop?: boolean; fx?: Fx[] }

/** Every scene: frame count and a builder from the frame index. Effects use only single-width chars, never ▖▗▘▝░ or block chars. */
const SCENES: Record<SceneKey, { frames: number; build: (i: number) => FrameSpec }> = {
  // Edit / Write: the mascot bobs; sparks ' . ˙ fly off to the right.
  typing: {
    frames: 8,
    build: i => {
      const bob = i % 4 === 1 || i % 4 === 2
      const sparks: Fx[][] = [
        [[1, 10, "'"]],
        [[0, 11, '.'], [1, 10, '˙']],
        [[0, 12, "'"], [1, 11, '.']],
        [[1, 12, '˙']],
        [[2, 10, '.'], [1, 11, "'"]],
        [[2, 11, '˙'], [0, 11, "'"], [1, 12, '.']],
        [[0, 12, '.'], [2, 12, "'"]],
        [[1, 10, '˙']],
      ]
      return { x: 1, hop: bob, fx: sparks[i] }
    },
  },
  // Bash: a tiny "> _" cursor blinks beside it while it leans/shifts.
  terminal: {
    frames: 8,
    build: i => {
      const xs = [0, 0, 1, 1, 1, 0, 0, 1]
      const cursor: Fx[] = i % 2 === 0 ? [[1, 10, '>'], [1, 12, '_']] : [[1, 10, '>']]
      const prompt: Fx[] = i % 4 >= 2 ? [[0, 11, '-'], [2, 11, '-']] : []
      return { x: xs[i]!, fx: [...cursor, ...prompt] }
    },
  },
  // Read / Grep / Glob: walks left and right scanning, thought bubbles rise on the right edge.
  searching: {
    frames: 12,
    build: i => {
      const xs = [0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3]
      const bubble: Fx[][] = [
        [[2, 12, '·']],
        [[1, 12, '∘']],
        [[0, 12, '○']],
        [[0, 12, '?']],
      ]
      const eye: Fx[] = xs[i]! >= 1 && i % 4 === 0 ? [[1, 0, '°']] : []
      return { x: xs[i]!, fx: [...bubble[i % 4]!, ...eye] }
    },
  },
  // Agent / Task / thinking / no tool yet: still; thought dots rise beside the head.
  thinking: {
    frames: 8,
    build: i => {
      const all: Fx[] = [[2, 10, '·'], [1, 11, '∘'], [0, 12, '○']]
      const shown: Fx[] = i < 4 ? all.slice(0, i) : i < 7 ? all.slice(i - 3) : [[0, 12, '?']]
      return { x: 1, fx: shown }
    },
  },
  // WebFetch / WebSearch: tiny ~ waves travel toward it from the right.
  fetching: {
    frames: 8,
    build: i => {
      const fx: Fx[] = [
        [1, 12 - (i % 4), '~'],
        [1, 12 - ((i + 2) % 4), '~'],
        [i % 2 === 0 ? 0 : 2, 12 - ((i + 1) % 4), '˙'],
      ]
      return { x: 0, fx }
    },
  },
  // Idle too long: z Z drift up and to the right. Slower tempo (see SLEEPY_EVERY).
  sleepy: {
    frames: 8,
    build: i => {
      const z: Fx[][] = [
        [[2, 10, 'z']],
        [[2, 10, 'z'], [1, 11, 'z']],
        [[1, 11, 'z'], [0, 11, 'Z']],
        [[1, 11, 'Z'], [0, 12, 'Z']],
        [[0, 12, 'Z']],
        [],
        [[2, 10, 'z']],
        [[1, 10, 'z']],
      ]
      return { x: 1, fx: z[i] }
    },
  },
  // First ~1.5 s: slides in from the left edge of the slot, overshoots, settles; speed lines trail behind.
  arrives: {
    frames: 6,
    build: i => {
      const xs = [0, 1, 2, 3, 2, 1]
      const x = xs[i]!
      const trail: Fx[] = i >= 1 && i <= 3 ? [[1, x - 1, '-'], [0, x - 1, '_'], [2, x - 1, '-']] : []
      const puff: Fx[] = i === 5 ? [[2, 12, '.'], [2, 11, '˙']] : []
      return { x, fx: [...trail, ...puff] }
    },
  },
  // Done: two jumps (legs line blank in the air) with ✻ ✦ ⋆ confetti bursting outward, then lands in a dust puff.
  celebrate: {
    frames: 12,
    build: i => {
      const air = [false, true, true, true, true, false, false, true, true, true, false, false]
      const fx: Fx[][] = [
        [],
        [[1, 1, '✦'], [1, 11, '✦']],
        [[0, 0, '✻'], [0, 12, '✻'], [1, 1, '⋆'], [1, 11, '⋆']],
        [[0, 0, '✻'], [0, 12, '✻'], [1, 0, '✦'], [1, 12, '✦'], [2, 1, '⋆'], [2, 11, '⋆']],
        [[0, 1, '⋆'], [0, 11, '⋆'], [1, 0, '✻'], [1, 12, '✻'], [2, 0, '·'], [2, 12, '·']],
        [[2, 1, '.'], [2, 11, '.'], [0, 0, '✦'], [0, 12, '✦'], [1, 1, '·'], [1, 11, '·']],
        [[2, 1, '˙'], [2, 11, '˙']],
        [[1, 1, '⋆'], [1, 11, '⋆']],
        [[0, 0, '✻'], [0, 12, '✻'], [1, 0, '✦'], [1, 12, '✦']],
        [[0, 1, '✦'], [0, 11, '✦'], [1, 0, '⋆'], [1, 12, '⋆'], [2, 0, '·'], [2, 12, '·']],
        [[2, 1, '.'], [2, 11, '.'], [1, 0, '·'], [1, 12, '·']],
        [[2, 1, '˙'], [2, 11, '˙']],
      ]
      return { x: 2, hop: air[i], fx: fx[i] }
    },
  },
  // Failed: a short shake (shift ±1), then a lone !.
  fail: {
    frames: 6,
    build: i => {
      const xs = [1, 2, 0, 2, 1, 1]
      return { x: xs[i]!, fx: i < 4 ? [] : i === 4 ? [[0, 11, '!']] : [[0, 11, '!'], [1, 11, '!']] }
    },
  },
}

export const SCENE_KEYS = Object.keys(SCENES) as SceneKey[]
export const sceneFrameCount = (k: SceneKey): number => SCENES[k].frames

/** One scene frame: exactly SLOT_ROWS strings of SLOT_W columns. The mascot lines are the exact art; effects go in free cells only. */
export function sceneFrame(key: SceneKey, index: number): string[] {
  const sc = SCENES[key]
  const spec = sc.build(((Math.floor(index) % sc.frames) + sc.frames) % sc.frames)
  const x = Math.max(0, Math.min(SLOT_W - BODY_W, spec.x))
  const cv: string[][] = Array.from({ length: SLOT_ROWS }, () => Array(SLOT_W).fill(' '))
  // A hop leaves the legs line blank: the head stays on line 1, the body on line 2.
  const lines = [BODY_TOP, BODY_MID, spec.hop ? '' : BODY_LEGS]
  lines.forEach((l, r) => {
    for (let c = 0; c < l.length; c++) if (l[c] !== ' ') cv[r]![x + c] = l[c]!
  })
  for (const [r, c, ch] of spec.fx ?? []) {
    if (r >= 0 && r < SLOT_ROWS && c >= 0 && c < SLOT_W && cv[r]![c] === ' ') cv[r]![c] = ch
  }
  return cv.map(row => row.join(''))
}

/** The first word of a tool summary ("Edit hooks/x.ts" -> "edit"). */
const toolWord = (t?: string): string => (t ?? '').trim().split(/[\s:(]/)[0]!.toLowerCase()

/** Which scene a tool maps to. */
export function sceneForTool(tool?: string): SceneKey {
  switch (toolWord(tool)) {
    case 'edit': case 'write': case 'multiedit': case 'notebookedit': return 'typing'
    case 'bash': case 'powershell': case 'bashoutput': return 'terminal'
    case 'read': case 'grep': case 'glob': case 'ls': return 'searching'
    case 'webfetch': case 'websearch': return 'fetching'
    default: return 'thinking' // Agent, Task, thinking, no tool yet
  }
}

export interface SceneInput {
  tick: number
  seed?: number
  now: number
  tool?: string
  startedAt?: number
  /** When the last tool changed; quiet longer than SLEEPY_AFTER_MS makes it doze. */
  toolSince?: number
  doneAt?: number
  failedAt?: number
}

/** failed > done > arrival > sleepy > tool. */
export function pickScene(i: SceneInput): SceneKey {
  if (i.failedAt != null) return 'fail'
  if (i.doneAt != null) return 'celebrate'
  if (i.startedAt != null && i.now - i.startedAt >= 0 && i.now - i.startedAt < ARRIVE_MS) return 'arrives'
  const quietSince = i.toolSince ?? i.startedAt
  if (quietSince != null && i.now - quietSince > SLEEPY_AFTER_MS) return 'sleepy'
  return sceneForTool(i.tool)
}

/** The 3 slot lines for an agent right now. Seeds keep several agents out of lockstep. */
export function sceneRows(i: SceneInput): string[] {
  const key = pickScene(i)
  const seed = Math.floor(i.seed ?? 0)
  const t = Math.floor(i.tick)
  if (key === 'celebrate') return sceneFrame(key, Math.floor((i.now - (i.doneAt ?? i.now)) / CELEBRATE_FRAME_MS))
  if (key === 'fail') return sceneFrame(key, Math.min(SCENES.fail.frames - 1, Math.floor((i.now - (i.failedAt ?? i.now)) / FAIL_FRAME_MS)))
  if (key === 'arrives') return sceneFrame(key, Math.floor((i.now - (i.startedAt ?? i.now)) / ARRIVE_FRAME_MS))
  const every = key === 'sleepy' ? SLEEPY_EVERY : EVERY
  return sceneFrame(key, Math.floor(t / every) + seed)
}

// Remembers when each agent's last tool changed, so a long quiet spell can be told from the tool alone.
const toolClock = new Map<string, { tool: string; at: number }>()
const TOOL_CLOCK_MAX = 200
/** Forget an agent's tool clock once it finishes or fails. */
export function forgetToolClock(id: string) {
  toolClock.delete(id)
}
export function toolSinceOf(id: string, tool: string | undefined, now: number, startedAt: number): number {
  const t = tool ?? ''
  const rec = toolClock.get(id)
  if (!rec) {
    if (toolClock.size >= TOOL_CLOCK_MAX) toolClock.delete(toolClock.keys().next().value as string)
    toolClock.set(id, { tool: t, at: startedAt })
    return startedAt
  }
  if (rec.tool !== t) {
    toolClock.set(id, { tool: t, at: now })
    return now
  }
  return rec.at
}

// One-column band marker: a twinkling star (no mascot in the band).
const TWINKLE = ['✦', '✧', '✦', '·', '⋆', '✦']
export function glyph(tick = 0, seed = 0): Span {
  const i = (Math.floor(tick / 2) + Math.floor(seed)) % TWINKLE.length
  return { text: TWINKLE[(i + TWINKLE.length) % TWINKLE.length]!, color: ORANGE, bold: true }
}

// Band header: a twinkling star, the count and elapsed time.
export function bandHeader(tick: number, agents: { id: string; type?: string }[], now: number, firstStart: number, width: number): Line {
  const count = agents.length
  return clipLine([glyph(tick), { text: ` ${count} agent${count === 1 ? '' : 's'} working · ${fmtElapsed(now - firstStart)}`, color: ORANGE }], width)
}

// Done line: a green check and the crew count.
export function doneLine(tick: number, width: number, crew?: { id: string; type?: string }[]): Line {
  const up = Math.floor(tick / 2) % 2 === 0
  const n = crew && crew.length > 0 ? crew.length : 0
  return clipLine([{ text: '✓', color: '#7BD88F', bold: true }, { text: (up ? ' done!' : ' done ') + (n > 0 ? ` · ${n} agent${n === 1 ? '' : 's'}` : ''), color: ORANGE }], width)
}

function doneArt(tick: number, now: number, finishedAt: number): Line[] {
  const rows = sceneRows({ tick, now, doneAt: finishedAt })
  return [
    ...rows.map((r): Line => [{ text: r, color: ORANGE, bold: true }]),
    [],
    [{ text: 'All done!', color: ORANGE, bold: true }],
  ]
}

// ---- pane ----
// Each running agent is 3 lines: the 13-col scene slot, then text (line 1 empty, line 2 name · label, line 3 tool · time).
function agentBlock(tick: number, a: AnimAgent, i: number, now: number, width: number): Line[] {
  const el = now - a.startedAt
  const slots = sceneRows({
    tick,
    seed: i * 3 + (hash(a.id) % 5),
    now,
    tool: a.lastTool,
    startedAt: a.startedAt,
    toolSince: toolSinceOf(a.id, a.lastTool, now, a.startedAt),
  })
  const room = Math.max(0, width - SLOT_W)
  const cr = creatureFor(a.type, a.id)
  const what = a.lastTool ? a.lastTool : verbFor(a.id, now)
  const left = a.budgetMs && a.budgetMs > 0 ? a.budgetMs - el : null
  const time = left === null ? fmtElapsed(el) : left >= 0 ? `${fmtElapsed(left)} left` : `+${fmtElapsed(-left)} over`
  const tail = ` · ${time}`
  const t3 = trunc(what, Math.max(0, room - tail.length)) + tail
  const row = (n: number, text: string, extra: Partial<Span> = {}): Line =>
    clipLine([{ text: slots[n]!, color: ORANGE, bold: true }, { text: trunc(text, room), ...extra }], width)
  return [row(0, ''), row(1, `${cr.name} · ${a.label}`, { bold: true }), row(2, t3, { dim: true })]
}

/** One ambient row for the whole pane: a sparse twinkling starfield. Exactly `width` columns. */
export function starfield(tick: number, width: number): Line {
  const marks = ['✦', '⋆', '·', '˙', '✧']
  let s = ''
  for (let c = 0; c < width; c++) {
    const k = (c * 7 + Math.floor(tick / 3) * 5) % 13
    s += k < 2 ? marks[(c + Math.floor(tick / 2)) % marks.length] : ' '
  }
  return [{ text: s, color: '#8F5E45', dim: true }]
}

export function paneFrame(tick: number, agents: AnimAgent[], now: number, width: number, finishedAt?: number | null): Line[] {
  if (agents.length === 0) {
    if (finishedAt == null || now < finishedAt || now - finishedAt > 3000) return []
    return doneArt(tick, now, finishedAt).map(l => centre(l, width))
  }
  return [starfield(tick, width), ...agents.flatMap((a, i) => agentBlock(tick, a, i, now, width))]
}

// ---- crew: the mascot's roles. The same exact creature; only the name differs. ----
export interface Creature {
  key: string
  name: string
  color: string
}

export const CREW: Creature[] = [
  { key: 'builder', name: 'Builder', color: ORANGE },
  { key: 'scout', name: 'Scout', color: ORANGE },
  { key: 'architect', name: 'Architect', color: ORANGE },
  { key: 'reviewer', name: 'Reviewer', color: ORANGE },
  { key: 'simplifier', name: 'Simplifier', color: ORANGE },
  { key: 'sprite', name: 'Sprite', color: ORANGE },
]

export function creatureFor(type: string | undefined, agentId: string): Creature {
  const by = (k: string) => CREW.find(c => c.key === k)!
  const t = (type ?? '').toLowerCase()
  if (t === 'executor' || t.endsWith(':executor')) return by('builder')
  if (t.endsWith('code-explorer')) return by('scout')
  if (t.endsWith('code-architect')) return by('architect')
  if (t.endsWith('code-reviewer') || t === 'review' || t.includes('pr-review')) return by('reviewer')
  if (t.endsWith('code-simplifier')) return by('simplifier')
  return CREW[hash(agentId) % CREW.length]!
}

// ---- bar walker: a twinkling star on the progress bar (no mascot); the mood shows in the 2-column tail and its colour ----
export type Mood = 'working' | 'thinking' | 'waiting' | 'over' | 'done'

const STAR = ['✦', '✧', '✦', '⋆']

// Every mood is 3 columns (1 star + 2 suffix), so the bar never jitters.
export function walker(tick: number, mood: Mood): Span[] {
  const t = Math.floor(tick)
  const star = Math.floor(t / 2) % STAR.length
  const body = (text = STAR[star]!, color = ORANGE): Span => ({ text, color, bold: true })
  const tail = (text: string, color = ORANGE, dim = false): Span => ({ text: text.padEnd(2).slice(0, 2), color, dim })
  switch (mood) {
    case 'working':
      return [body(), tail(Math.floor(t / 2) % 2 === 0 ? '' : ' ·')]
    case 'thinking':
      return [body(), tail(Math.floor(t / 4) % 2 === 0 ? ' ?' : ' ·')]
    case 'waiting':
      return [body('✧', SOFT_TEAL), tail([' z', ' Z', ' z', '  '][Math.floor(t / 4) % 4]!, SOFT_TEAL)]
    case 'over':
      return [body(STAR[star]!, SOFT_TEAL), tail(Math.floor(t / 3) % 2 === 0 ? ' ˙' : ' ,', SOFT_TEAL)]
    case 'done':
      return [body('✓', '#7BD88F'), tail(Math.floor(t / 3) % 2 === 0 ? ' ✦' : ' ⋆', '#7BD88F')]
  }
}

// ---- sparkle trail: exactly `len` columns, brightest next to the walker, fading to dim ----
export function trail(tick: number, len: number): Span[] {
  const n = Math.max(0, Math.floor(len))
  const marks = ['˚', '·', '✻', '·']
  const out: Span[] = []
  const fade = ['#D97757', '#B8704F', '#8F5E45', '#6B4F42']
  for (let i = 0; i < n; i++) {
    const on = (i + Math.floor(tick / 2)) % 3 !== 0
    const level = Math.min(fade.length - 1, Math.floor((i * fade.length) / Math.max(1, n)))
    const text = on ? marks[(i * 3 + Math.floor(tick / 3)) % marks.length] : ' '
    out.push({ text, color: fade[level], dim: level >= 2 })
  }
  return out
}
