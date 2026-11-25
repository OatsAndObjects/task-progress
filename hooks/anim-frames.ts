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

// ---- mascot (Claude Code style block creature) ----
const BODY_TOP = ' ▐▛███▜▌ '
const BODY_MID = '▝▜█████▛▘'
const LEGS_A = '  ▘▘ ▝▝  '

// Band/pane glyph: one tiny creature, eyes blink now and then. Always 5 columns.
export function glyph(tick: number, seed = 0): Span {
  const k = (((Math.floor(tick) + Math.floor(seed)) % 40) + 40) % 40
  return { text: k >= 38 ? '▐███▌' : '▐▛█▜▌', color: ORANGE, bold: true }
}

// Band header: a mini parade of up to 3 running agents' creatures, then the count and elapsed time.
export function bandHeader(tick: number, agents: { id: string; type?: string }[], now: number, firstStart: number, width: number): Line {
  const count = agents.length
  const label = ` ${count} agent${count === 1 ? '' : 's'} working · ${fmtElapsed(now - firstStart)}`
  const parade: Line = []
  agents.slice(0, 3).forEach((a, i) => {
    if (i > 0) parade.push({ text: ' ' })
    parade.push(creatureFrame(creatureFor(a.type, a.id), tick, i * 3))
  })
  if (parade.length === 0) parade.push(glyph(tick))
  return clipLine([...parade, { text: label, color: ORANGE }], width)
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

// One creature's done hop (a hop is a leading space or a trailing one).
export function doneGlyph(tick: number, cr: Creature, i = 0): Span {
  const hop = (Math.floor(tick / 2) + i) % 2 === 0
  const body = cr.move[0].replace('▐', hop ? '▗' : '▐').replace('▌', hop ? '▖' : '▌')
  return { text: (hop ? '' : ' ') + body, color: cr.color, bold: true }
}

// Done line: every creature that ran hops together (each hop is a leading space or a trailing one).
export function doneLine(tick: number, width: number, crew?: { id: string; type?: string }[]): Line {
  const up = Math.floor(tick / 2) % 2 === 0
  const who = crew && crew.length > 0 ? crew.slice(0, 4) : [{ id: 'builder', type: 'executor' }]
  const hoppers = who.map((a, i) => doneGlyph(tick, creatureFor(a.type, a.id), i))
  return clipLine([...hoppers, { text: up ? ' ✻ done!' : ' · done!', color: ORANGE }], width)
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
  const g = creatureFrame(creatureFor(a.type, a.id), tick, i * 3 + (hash(a.id) % 5))
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

// Up to 3 creatures side by side, each hopping over two rows with its name (in its colour) underneath.
function crewArt(tick: number, agents: AnimAgent[], width: number): Line[] {
  const shown = agents.slice(0, 3)
  const colW = Math.max(5, Math.min(14, Math.floor(width / shown.length)))
  const rows: Line[] = [[], [], []]
  shown.forEach((a, i) => {
    const cr = creatureFor(a.type, a.id)
    const sp = creatureFrame(cr, tick, i * 3)
    const up = Math.floor((tick + i * 2) / 3) % 2 === 1
    const cell = (t: string): string => (' '.repeat(Math.max(0, Math.floor((colW - t.length) / 2))) + t).padEnd(colW).slice(0, colW)
    const body = (): Span => ({ ...sp, text: cell(sp.text) })
    rows[0].push(up ? body() : { text: cell('') })
    rows[1].push(up ? { text: cell('') } : body())
    rows[2].push({ text: cell(trunc(cr.name, colW)), color: cr.color, bold: true })
  })
  return rows.map(l => centre(l, width))
}

export function paneFrame(tick: number, agents: AnimAgent[], now: number, width: number, finishedAt?: number | null): Line[] {
  if (agents.length === 0) {
    if (finishedAt == null || now < finishedAt || now - finishedAt > 3000) return []
    return doneArt(tick).map(l => centre(l, width))
  }
  const art = crewArt(tick, agents, width)
  return [...art, [], ...agents.map((a, i) => agentRow(tick, a, i, now, width))]
}

// ---- crew: distinct block creatures, every frame exactly 5 columns ----
export interface Creature {
  key: string
  name: string
  color: string
  move: string[] // signature move cycle, one entry per 2 ticks
  blink: string
}

export const CREW: Creature[] = [
  { key: 'builder', name: 'Builder', color: ORANGE, move: ['▐▛█▜▌', '▐▛█▜▌', '▖▛█▜▌', '▐▛█▜▌', '▐▛█▜▌', '▐▛█▜▗'], blink: '▐███▌' },
  { key: 'scout', name: 'Scout', color: '#5EC4B6', move: ['▐▘█▝▌', '▐▘█▝▌', '▐▖█▖▌', '▐▘█▝▌', '▐▗█▗▌', '▐▘█▝▌'], blink: '▐▄█▄▌' },
  { key: 'architect', name: 'Architect', color: '#6CA8FF', move: ['▐▟█▙▌', '▐▟█▙▌', '▗▟█▙▌', '▐▟█▙▌', '▐▟█▙▖', '▐▟█▙▌'], blink: '▐▟▀▙▌' },
  { key: 'reviewer', name: 'Reviewer', color: '#B392F0', move: ['▐▀█▀▌', '▐▀█▀▌', '▐▀█▀▌', '▐▄█▄▌', '▐▄█▄▌', '▐▀█▀▌'], blink: '▐███▌' },
  { key: 'simplifier', name: 'Simplifier', color: '#7BD88F', move: ['▐▛█▜▌', '▐▛█▝▘', '▐▛█▜▌', '▐▛█▝▘'], blink: '▐███▌' },
  { key: 'sprite', name: 'Sprite', color: '#F28FAD', move: ['▐▛█▜▌', '▗▛█▜▖', '▐▛█▜▌', '▝▛█▜▘'], blink: '▐███▌' },
]

export function creatureFor(type: string | undefined, agentId: string): Creature {
  const by = (k: string) => CREW.find(c => c.key === k)!
  const t = (type ?? '').toLowerCase()
  if (t === 'executor' || t.endsWith(':executor')) return by('builder')
  if (t.endsWith('code-explorer')) return by('scout')
  if (t.endsWith('code-architect')) return by('architect')
  if (t.endsWith('code-reviewer') || t === 'review' || t.includes('pr-review')) return by('reviewer')
  if (t.endsWith('code-simplifier')) return by('simplifier')
  return CREW[hash(agentId) % CREW.length]
}

export function creatureFrame(c: Creature, tick: number, seed = 0): Span {
  const t = Math.floor(tick) + Math.floor(seed)
  const k = ((t % 40) + 40) % 40
  const step = (Math.floor(t / 2) % c.move.length + c.move.length) % c.move.length
  return { text: k >= 38 ? c.blink : c.move[step], color: c.color, bold: true }
}

// ---- bar walker: the orange mascot on the progress bar, driven by mood ----
export type Mood = 'working' | 'thinking' | 'waiting' | 'over' | 'done'

// Every mood is 7 columns (5 body + 2 suffix), so the bar never jitters.

export function walker(tick: number, mood: Mood): Span[] {
  const t = Math.floor(tick)
  const body = (text: string, color = ORANGE): Span => ({ text, color, bold: true })
  const tail = (text: string, color = ORANGE, dim = false): Span => ({ text: text.padEnd(2).slice(0, 2), color, dim })
  switch (mood) {
    case 'working':
      return [body(Math.floor(t / 2) % 2 === 0 ? '▐▛█▜▌' : '▗▛█▜▖'), tail('')]
    case 'thinking': {
      const eyes = ['▐▛█▜▌', '▐▘█▜▌', '▐▛█▝▌', '▐▛█▜▌'][Math.floor(t / 3) % 4]
      return [body(eyes), tail(Math.floor(t / 4) % 2 === 0 ? ' ?' : ' ·')]
    }
    case 'waiting':
      return [body('▐▀█▀▌'), tail([' z', ' Z', ' z', '  '][Math.floor(t / 4) % 4], SOFT_TEAL)]
    case 'over':
      return [body('▐▛█▜▌'), tail(Math.floor(t / 3) % 2 === 0 ? ' ˙' : ' ,', SOFT_TEAL)]
    case 'done':
      return [body('▐▛█▜▌', '#7BD88F'), tail(' ✓', '#7BD88F')]
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
