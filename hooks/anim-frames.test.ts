import { expect, test } from 'claude-code/testing'
import { bandHeader, doneLine, fmtElapsed, glyph, paneFrame, verbFor, type AnimAgent, type Line } from './anim-frames'

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
    expect(len([glyph(tick, n)])).toBeLessThanOrEqual(5)
    expect(len(bandHeader(tick, mk(n), now, 1000, width))).toBeLessThanOrEqual(width)
    expect(len(doneLine(tick, width))).toBeLessThanOrEqual(width)
    expect(len(doneLine(tick, width, mk(3)))).toBeLessThanOrEqual(width)
    for (const fin of [null, now - 100]) for (const l of paneFrame(tick, mk(n), now, width, fin)) expect(len(l)).toBeLessThanOrEqual(width)
  }
})

test('done art appears within 3s and is gone after', () => {
  expect(paneFrame(5, [], 10_000, 60, 9_000).length).toBeGreaterThanOrEqual(7)
  expect(paneFrame(5, [], 11_900, 60, 9_000).length).toBeGreaterThan(0)
  expect(paneFrame(5, [], 12_001, 60, 9_000)).toEqual([])
  expect(paneFrame(5, [], 10_000, 60, null)).toEqual([])
  expect(paneFrame(5, [], 10_000, 60)).toEqual([])
})

test('pane with agents has crew art, blank line, one row per agent', () => {
  const f = paneFrame(7, mk(2), 60_000, 44)
  expect(f.length).toBe(3 + 1 + 2)
  expect(f[f.length - 3]).toEqual([])
})

const typed = (types: (string | undefined)[]): AnimAgent[] =>
  types.map((type, i) => ({ id: `a${i}`, label: `step ${i + 1}`, startedAt: 0, type }))
const txt = (l: Line) => l.map(s => s.text).join('')

test('different types get different creatures and colours in pane rows and header', () => {
  const ag = typed(['task-progress:executor', 'feature-dev:code-explorer', 'feature-dev:code-reviewer'])
  const f = paneFrame(0, ag, 5000, 60)
  const names = txt(f[2])
  expect(names).toContain('Builder')
  expect(names).toContain('Scout')
  expect(names).toContain('Reviewer')
  expect(new Set(f[2].map(s => s.color).filter(Boolean)).size).toBe(3)
  const rows = f.slice(-3)
  expect(new Set(rows.map(r => r[0].color)).size).toBe(3)
  expect(new Set(rows.map(r => r[0].text)).size).toBe(3)
  const h = bandHeader(0, ag, 5000, 0, 60)
  expect(new Set(h.filter(s => s.text.trim().length === 5).map(s => s.color)).size).toBe(3)
  expect(txt(h)).toContain('3 agents working')
})

test('done line shows every creature that ran', () => {
  const l = doneLine(0, 60, typed(['executor', 'feature-dev:code-explorer']))
  expect(l.filter(s => s.bold).map(s => s.color).length).toBe(2)
  expect(new Set(l.filter(s => s.bold).map(s => s.color)).size).toBe(2)
  expect(txt(l)).toContain('done!')
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

test('mascot art rows keep a fixed width so nothing jitters', () => {
  for (let tick = 0; tick < 200; tick++) {
    const f = paneFrame(tick, mk(1), 60_000, 60)
    const art = f.slice(0, f.length - 2)
    expect(art.length).toBe(3)
    const widths = new Set(art.map(l => l.reduce((n, s) => n + s.text.length, 0)))
    expect(widths.size).toBe(1)
  }
})

import { CREW, creatureFor, creatureFrame, trail, walker, type Mood } from './anim-frames'

test('crew frames are always 5 columns', () => {
  for (const c of CREW) for (let tick = 0; tick <= 200; tick++) for (const seed of [0, 7]) expect(creatureFrame(c, tick, seed).text.length).toBe(5)
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

test('walker moods differ and keep a stable width', () => {
  const moods: Mood[] = ['working', 'thinking', 'waiting', 'over', 'done']
  const texts = new Set<string>()
  for (const m of moods) {
    for (let tick = 0; tick < 60; tick++) expect(walker(tick, m).reduce((n, s) => n + s.text.length, 0)).toBe(7)
    texts.add(walker(0, m).map(s => s.text).join(''))
  }
  expect(texts.size).toBe(5)
})

test('trail is exactly len columns', () => {
  for (const n of [0, 1, 5, 12]) for (let tick = 0; tick < 30; tick++) expect(trail(tick, n).reduce((a, s) => a + s.text.length, 0)).toBe(n)
})
