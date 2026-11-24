// Pure animation frames for the task-progress band and pane. No clock, no I/O: time comes in as arguments.
export interface AnimAgent { id: string; label: string; startedAt: number; lastTool?: string; budgetMs?: number }
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

// triangle wave 0..max with the given period
function tri(t: number, period: number, max: number): number {
  const p = ((t % period) + period) % period
  const half = period / 2
  return Math.round((p < half ? p / half : (period - p) / half) * max)
}

// ---- mascot (Claude Code style block creature) ----
const BODY_TOP = ' ▐▛███▜▌ '
const BODY_TOP_BLINK = ' ▐█████▌ '
const BODY_MID = '▝▜█████▛▘'
const LEGS_A = '  ▘▘ ▝▝  '
const LEGS_B = '  ▝▝ ▘▘  '

// Band/pane glyph: one tiny creature, eyes blink now and then. Always 5 columns.
export function glyph(tick: number, seed = 0): Span {
  const k = (((Math.floor(tick) + Math.floor(seed)) % 40) + 40) % 40
  return { text: k >= 38 ? '▐███▌' : '▐▛█▜▌', color: ORANGE, bold: true }
}

export function bandHeader(tick: number, count: number, now: number, firstStart: number, width: number): Line {
  const label = ` ${count} agent${count === 1 ? '' : 's'} working · ${fmtElapsed(now - firstStart)}`
  return clipLine([glyph(tick), { text: label, color: ORANGE }], width)
}

function mascotArt(tick: number): Line[] {
  const cycle = tick % 80
  const walking = cycle < 52
  const x = walking ? tri(cycle, 52, 10) : 5
  const blink = tick % 30 >= 28
  const step = Math.floor(tick / 2) % 2 === 0
  const bob = walking && Math.floor(tick / 3) % 2 === 1
  const legs = walking && step ? LEGS_A : walking ? LEGS_B : LEGS_A
  const typed = walking ? '' : '> ' + 'beep boop'.slice(0, Math.floor((cycle - 52) / 2) + 1) + (tick % 4 < 2 ? '_' : ' ')
  const W = 21
  const f = (t: string) => t.padEnd(W).slice(0, W)
  const pad = ' '.repeat(x)
  const body = (r: string): Line => [{ text: f(pad + r), color: ORANGE, bold: true }]
  const top = blink ? BODY_TOP_BLINK : BODY_TOP
  const rows: Line[] = bob
    ? [body(top), body(BODY_MID), body(legs), [{ text: f('') }]]
    : [[{ text: f('') }], body(top), body(BODY_MID), body(legs)]
  return [
    [{ text: f(typed), color: SOFT_TEAL }],
    ...rows,
    [{ text: f(walking ? '' : ' '.repeat(5) + '[=======]'), color: SOFT_TEAL, dim: true }],
    [{ text: '~'.repeat(W), color: SOFT_TEAL, dim: true }],
  ]
}

function doneArt(tick: number): Line[] {
  const up = Math.floor(tick / 2) % 2 === 0
  const W = 21
  const f = (t: string) => t.padEnd(W)
  const body = (r: string): Line => [{ text: f(' '.repeat(6) + r), color: ORANGE, bold: true }]
  const spark = (t: string): Line => [{ text: f(t), color: ORANGE }]
  const legs = up ? '  ▝▝ ▘▘  ' : LEGS_A
  const rows = up ? [body(BODY_TOP), body(BODY_MID), body(legs), spark('')] : [spark(''), body(BODY_TOP), body(BODY_MID), body(legs)]
  return [
    spark(up ? '   ✻     ·     ✻   ' : '   ·     ✻     ·   '),
    spark(up ? '      ·     ✻      ' : '      ✻     ·      '),
    ...rows,
    [{ text: '~'.repeat(W), color: SOFT_TEAL, dim: true }],
    [{ text: 'All done!', color: ORANGE, bold: true }],
  ]
}

export function doneLine(tick: number, width: number): Line {
  const up = Math.floor(tick / 2) % 2 === 0
  return clipLine([{ text: (up ? ' ' : '') + '▐▛█▜▌' + (up ? '' : ' '), color: ORANGE, bold: true }, { text: up ? ' ✻ done!' : ' · done!', color: ORANGE }], width)
}

// ---- pane ----
const BAR_W = 8

function agentRow(tick: number, a: AnimAgent, i: number, now: number, width: number): Line {
  const el = now - a.startedAt
  const frac = Math.max(0, Math.min(1, el / (a.budgetMs && a.budgetMs > 0 ? a.budgetMs : 300000)))
  const filled = Math.round(frac * BAR_W)
  const elTxt = fmtElapsed(el)
  const avail = Math.max(0, width - (5 + 1 + 1 + 1 + BAR_W + 1 + elTxt.length))
  const lw = Math.min(a.label.length, Math.max(3, Math.floor(avail * 0.5)))
  const vw = Math.max(0, avail - lw)
  const what = a.lastTool ? `· ${a.lastTool}` : verbFor(a.id, now)
  const g = glyph(tick, i * 3 + (hash(a.id) % 5))
  return clipLine([
    { ...g, text: g.text.padEnd(5) },
    { text: ' ' + trunc(a.label, lw).padEnd(lw), bold: true },
    { text: ' ' + trunc(what, vw).padEnd(vw), dim: true },
    { text: ' ' },
    { text: '▰'.repeat(filled), color: ORANGE },
    { text: '▱'.repeat(BAR_W - filled), dim: true },
    { text: ' ' + elTxt },
  ], width)
}

export function paneFrame(tick: number, agents: AnimAgent[], now: number, width: number, finishedAt?: number | null): Line[] {
  if (agents.length === 0) {
    if (finishedAt == null || now < finishedAt || now - finishedAt > 3000) return []
    return doneArt(tick).map(l => centre(l, width))
  }
  const art = mascotArt(tick).map(l => centre(l, width))
  return [...art, [], ...agents.map((a, i) => agentRow(tick, a, i, now, width))]
}
