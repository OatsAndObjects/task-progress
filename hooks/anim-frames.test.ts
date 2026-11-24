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
    expect(len(bandHeader(tick, n, now, 1000, width))).toBeLessThanOrEqual(width)
    expect(len(doneLine(tick, width))).toBeLessThanOrEqual(width)
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

test('pane with agents has art, blank line, one row per agent', () => {
  const f = paneFrame(7, mk(2), 60_000, 44)
  expect(f.length).toBeGreaterThanOrEqual(7 + 1 + 2)
  expect(f.length).toBeLessThanOrEqual(9 + 1 + 2)
  expect(f[f.length - 3]).toEqual([])
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
    const widths = new Set(art.map(l => l.reduce((n, s) => n + s.text.length, 0)))
    expect(widths.size).toBe(1)
  }
})
