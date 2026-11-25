import { expect, test } from 'claude-code/testing'
import { forgetToolClock, toolSinceOf, ARRIVE_MS, FAIL_MS, SCENE_KEYS, SLEEPY_AFTER_MS, SLOT_W, bandHeader, doneLine, fmtElapsed, glyph, paneFrame, pickScene, sceneForTool, sceneFrame, sceneFrameCount, sceneRows, starfield, verbFor, type AnimAgent, type Line, type SceneKey } from './anim-frames'

const len = (l: Line) => l.reduce((n, s) => n + s.text.length, 0)
const mk = (n: number): AnimAgent[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `agent-${i}`,
    label: `A very long agent label number ${i}`,
    startedAt: 1000 * i,
    lastTool: i === 1 ? 'Edit' : undefined,
    budgetMs: i === 2 ? 60000 : undefined,
  }))

test('every line stays within width', () => {
  for (const n of [0, 1, 3]) for (const width of [40, 100]) for (let tick = 0; tick < 200; tick += 3) {
    const now = 90_000 + tick * 120
    expect(len([glyph(tick, n)])).toBe(1)
    expect(len(bandHeader(tick, mk(n), now, 1000, width))).toBeLessThanOrEqual(width)
    expect(len(doneLine(tick, width))).toBeLessThanOrEqual(width)
    expect(len(doneLine(tick, width, mk(3)))).toBeLessThanOrEqual(width)
    for (const fin of [null, now - 100]) for (const l of paneFrame(tick, mk(n), now, width, fin)) expect(len(l)).toBeLessThanOrEqual(width)
  }
})

test('done art appears within 3s and is gone after', () => {
  expect(paneFrame(5, [], 10_000, 60, 9_000).length).toBeGreaterThanOrEqual(5)
  expect(paneFrame(5, [], 11_900, 60, 9_000).length).toBeGreaterThan(0)
  expect(paneFrame(5, [], 12_001, 60, 9_000)).toEqual([])
  expect(paneFrame(5, [], 10_000, 60, null)).toEqual([])
  expect(paneFrame(5, [], 10_000, 60)).toEqual([])
})

test('pane: a starfield row, then each agent is a 3-line block, text beside the 13-col scene slot', () => {
  const f = paneFrame(7, mk(2).map(a => ({ ...a, type: 'executor' })), 60_000, 44)
  expect(f.length).toBe(7)
  expect(len(f[0]!)).toBe(44)
  for (const blk of [f.slice(1, 4), f.slice(4, 7)]) {
    expect(blk[0]![0]!.text.length).toBe(13)
    expect(blk[0]!.slice(1).map(s => s.text).join('')).toBe('')
    expect(txt(blk[1]!)).toContain('Builder')
    expect(txt(blk[2]!)).toMatch(/left| over|\ds/)
  }
})

const typed = (types: (string | undefined)[]): AnimAgent[] =>
  types.map((type, i) => ({ id: `a${i}`, label: `step ${i + 1}`, startedAt: 0, type }))
const txt = (l: Line) => l.map(s => s.text).join('')

test('different types keep their names but share the one orange mascot', () => {
  const ag = typed(['task-progress:executor', 'feature-dev:code-explorer', 'feature-dev:code-reviewer'])
  const f = paneFrame(0, ag, 5000, 60)
  expect(f.length).toBe(10)
  expect(txt(f[2]!)).toContain('Builder')
  expect(txt(f[5]!)).toContain('Scout')
  expect(txt(f[8]!)).toContain('Reviewer')
  expect(f.slice(1).filter(l => l.length > 1).every(l => l[0]!.color === '#D97757')).toBe(true)
  const h = bandHeader(0, ag, 5000, 0, 60)
  expect(txt(h)).toContain('3 agents working')
})

test('done line is a green check and the crew count, no mascot', () => {
  const l = doneLine(0, 60, typed(['executor', 'feature-dev:code-explorer']))
  expect(l[0]!.text).toBe('✓')
  expect(l[0]!.color).toBe('#7BD88F')
  expect(txt(l)).toContain('done!')
  expect(txt(l)).toContain('2 agents')
})

test('verbFor is stable in a window and changes across windows', () => {
  expect(verbFor('a', 3000)).toBe(verbFor('a', 5999))
  expect(verbFor('a', 3000).endsWith('…')).toBe(true)
  expect(verbFor('a', 3000)).not.toBe(verbFor('a', 6000))
  expect(new Set(['a', 'b', 'c', 'd', 'e'].map(id => verbFor(id, 0))).size).toBeGreaterThan(1)
})

test('fmtElapsed', () => {
  expect(fmtElapsed(8000)).toBe('8s')
  expect(fmtElapsed(0)).toBe('0s')
  expect(fmtElapsed(72_000)).toBe('1m 12s')
  expect(fmtElapsed(65_000)).toBe('1m 5s')
})

test('every agent-pane line fits the width', () => {
  for (const width of [20, 30, 44, 100]) for (let tick = 0; tick < 60; tick += 2) for (const l of paneFrame(tick, mk(3), 90_000, width)) expect(len(l)).toBeLessThanOrEqual(width)
})

const MASCOT_LINES = new Set(['', '▐▛███▜▌', '▝▜█████▛▘', '▘▘▝▝'])
// Effects are single-width marks; the mascot's own chars (▐▛█▜▌▝▘) are never in this set.
const EFFECTS = /[✻✦⋆·˙°∘○zZ?!~'`.\-_|/\\>✧,]/g
const bare = (l: string) => l.replace(EFFECTS, '').replace(/ /g, '')

test('every scene frame: 3 lines of 13 cols, mascot lines exact once effects and spaces go', () => {
  for (const k of SCENE_KEYS) {
    expect(sceneFrameCount(k)).toBeGreaterThanOrEqual(6)
    expect(sceneFrameCount(k)).toBeLessThanOrEqual(12)
    for (let f = 0; f < sceneFrameCount(k); f++) {
      const rows = sceneFrame(k, f)
      expect(rows.length).toBe(3)
      for (const r of rows) {
        expect(r.length).toBe(SLOT_W)
        expect(MASCOT_LINES.has(bare(r))).toBe(true)
      }
      expect(bare(rows[0]!)).toBe('▐▛███▜▌')
      expect(bare(rows[1]!)).toBe('▝▜█████▛▘')
    }
  }
})

test('every pane frame line is mascot-only after stripping effects', () => {
  const now = 90_000
  for (const tool of [undefined, 'Edit', 'Bash', 'Grep', 'WebFetch', 'Agent']) for (let tick = 0; tick < 80; tick++) {
    const f = paneFrame(tick, [{ id: 'z', label: 'x', startedAt: 0, lastTool: tool }, { id: 'y', label: 'x', startedAt: now - 3000, lastTool: tool }], now + tick * 250, 44)
    for (const l of f.slice(1)) expect(MASCOT_LINES.has(bare(l[0]!.text))).toBe(true)
  }
})

test('scene selection maps tools, quiet time, start, done and failed', () => {
  const m: Record<string, SceneKey> = { Edit: 'typing', Write: 'typing', MultiEdit: 'typing', Bash: 'terminal', PowerShell: 'terminal', Read: 'searching', Grep: 'searching', Glob: 'searching', WebFetch: 'fetching', WebSearch: 'fetching', Agent: 'thinking', Task: 'thinking' }
  for (const [t, k] of Object.entries(m)) expect(sceneForTool(t)).toBe(k)
  expect(sceneForTool('Edit hooks/x.ts')).toBe('typing')
  expect(sceneForTool(undefined)).toBe('thinking')
  const base = { tick: 0, now: 100_000, startedAt: 0, toolSince: 99_000 }
  expect(pickScene({ ...base, tool: 'Bash' })).toBe('terminal')
  expect(pickScene({ ...base, startedAt: 99_000, tool: 'Bash' })).toBe('arrives')
  expect(pickScene({ ...base, startedAt: 100_000 - ARRIVE_MS + 1, tool: 'Bash' })).toBe('arrives')
  expect(pickScene({ ...base, startedAt: 100_000 - ARRIVE_MS, tool: 'Bash' })).toBe('terminal')
  expect(pickScene({ ...base, toolSince: 100_000 - SLEEPY_AFTER_MS - 1, tool: 'Bash' })).toBe('sleepy')
  expect(pickScene({ ...base, toolSince: 100_000 - SLEEPY_AFTER_MS, tool: 'Bash' })).toBe('terminal')
  expect(pickScene({ ...base, doneAt: 99_000, tool: 'Bash' })).toBe('celebrate')
  expect(pickScene({ ...base, failedAt: 99_000, doneAt: 99_000, tool: 'Bash' })).toBe('fail')
})

test('seeds keep agents out of lockstep; sleepy ticks slower', () => {
  const a = (seed: number, tick: number) => sceneRows({ tick, seed, now: 90_000, tool: 'Read', startedAt: 0, toolSince: 89_000 }).join('\n')
  let differ = 0
  for (let t = 0; t < 40; t += 2) if (a(0, t) !== a(4, t)) differ++
  expect(differ).toBeGreaterThan(10)
  const z = (tick: number) => sceneRows({ tick, now: 90_000, tool: 'Read', startedAt: 0, toolSince: 0 }).join('\n')
  const n = (tick: number) => sceneRows({ tick, now: 90_000, tool: 'Read', startedAt: 0, toolSince: 89_000 }).join('\n')
  const changes = (f: (t: number) => string) => { let c = 0; for (let t = 1; t < 60; t++) if (f(t) !== f(t - 1)) c++; return c }
  expect(changes(z)).toBeLessThan(changes(n))
})

test('done and failed windows end: celebration runs its frames, the shake settles on !', () => {
  const done = new Set<string>()
  for (let ms = 0; ms < 3000; ms += 250) done.add(sceneRows({ tick: 0, now: 50_000 + ms, doneAt: 50_000 }).join('|'))
  expect(done.size).toBeGreaterThanOrEqual(8)
  // Jump: some frame has the legs line blank of mascot chars, and confetti marks show.
  const all = [...done].join('')
  expect(/[✻✦⋆]/.test(all)).toBe(true)
  expect([...Array(sceneFrameCount('celebrate')).keys()].some(f => bare(sceneFrame('celebrate', f)[2]!) === '')).toBe(true)
  const failLast = sceneRows({ tick: 0, now: 10_000 + FAIL_MS + 5000, failedAt: 10_000 })
  expect(failLast.join('')).toContain('!')
  const shifts = new Set([0, 1, 2, 3].map(f => sceneFrame('fail', f)[1]!.indexOf('▝')))
  expect(shifts.size).toBeGreaterThanOrEqual(3)
})

test('hop keeps the head on line 1 and body on line 2; arrival slides in from the left edge', () => {
  const f = (k: SceneKey) => Array.from({ length: sceneFrameCount(k) }, (_, i) => sceneFrame(k, i))
  expect(f('typing').some(r => bare(r[2]!) === '')).toBe(true)
  expect(f('typing').some(r => bare(r[2]!) === '▘▘▝▝')).toBe(true)
  expect(f('arrives')[0]![1]!.indexOf('▝')).toBe(0)
  expect(Math.max(...f('searching').map(r => r[1]!.indexOf('▝')))).toBe(3) // walks 0-3 cols
})

test('starfield row is exactly the width', () => {
  for (const w of [20, 44]) for (let t = 0; t < 30; t++) expect(len(starfield(t, w))).toBe(w)
})

import { CREW, creatureFor, trail, walker, type Mood } from './anim-frames'

test('every crew creature uses the one mascot colour', () => {
  for (const c of CREW) for (let tick = 0; tick <= 100; tick++) expect(c.color).toBe('#D97757')
})

test('creatureFor maps types and is deterministic', () => {
  expect(creatureFor('task-progress:executor', 'x').key).toBe('builder')
  expect(creatureFor('executor', 'x').key).toBe('builder')
  expect(creatureFor('feature-dev:code-explorer', 'x').key).toBe('scout')
  expect(creatureFor('feature-dev:code-architect', 'x').key).toBe('architect')
  expect(creatureFor('feature-dev:code-reviewer', 'x').key).toBe('reviewer')
  expect(creatureFor('review', 'x').key).toBe('reviewer')
  expect(creatureFor('code-simplifier:code-simplifier', 'x').key).toBe('simplifier')
  expect(creatureFor(undefined, 'agent-9').key).toBe(creatureFor(undefined, 'agent-9').key)
})

test('walker moods differ and keep a stable 3-col width (star + 2-col tail), no mascot', () => {
  const moods: Mood[] = ['working', 'thinking', 'waiting', 'over', 'done']
  const texts = new Set<string>()
  for (const m of moods) {
    for (let tick = 0; tick < 60; tick++) {
      expect(walker(tick, m).reduce((n, s) => n + s.text.length, 0)).toBe(3)
      expect(/[▐▛▜▌▝▘]/.test(walker(tick, m).map(x => x.text).join(''))).toBe(false)
    }
    texts.add(walker(0, m).map(s => s.text).join(''))
  }
  expect(texts.size).toBe(5)
})

test('band frames never contain a mascot char', () => {
  const bad = /[▐▛▜▌▝▘]/
  for (let tick = 0; tick < 120; tick++) {
    const strs: string[] = []
    for (const m of ['working', 'thinking', 'waiting', 'over', 'done'] as Mood[]) strs.push(walker(tick, m).map(x => x.text).join(''), trail(tick, 8).map(x => x.text).join(''))
    strs.push(glyph(tick, tick).text, txt(bandHeader(tick, mk(3), 90_000, 0, 80)), txt(doneLine(tick, 80, mk(3))), txt(doneLine(tick, 80)))
    for (const s of strs) expect(bad.test(s)).toBe(false)
  }
})

test('trail is exactly len columns', () => {
  for (const n of [0, 1, 5, 12]) for (let tick = 0; tick < 30; tick++) expect(trail(tick, n).reduce((a, s) => a + s.text.length, 0)).toBe(n)
})

test('toolClock: entry forgotten on finish, so the same id restarts its clock', () => {
  expect(toolSinceOf('tc1', 'Bash', 500, 100)).toBe(100)
  expect(toolSinceOf('tc1', 'Read', 900, 100)).toBe(900)
  forgetToolClock('tc1')
  expect(toolSinceOf('tc1', 'Read', 2000, 1500)).toBe(1500)
})

test('toolClock: capped, oldest dropped', () => {
  for (let i = 0; i < 250; i++) toolSinceOf(`cap${i}`, 'Bash', 5000 + i, 1000 + i)
  expect(toolSinceOf('cap0', 'Bash', 9000, 9000)).toBe(9000) // evicted: restarts
  expect(toolSinceOf('cap249', 'Bash', 9000, 9000)).toBe(1249) // kept
})
