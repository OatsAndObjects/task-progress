import { expect, test } from 'claude-code/testing'

import { buildUsageRows, barOf, colorOf, compact } from './pane-usage'

const snap = (usage: any) => ({ usage }) as any
const base = { fiveHour: null, weekly: null }

test('bars and colour thresholds', () => {
  expect(barOf(34)).toBe('▰▰▰▱▱▱▱▱▱▱')
  expect(barOf(100)).toBe('▰▰▰▰▰▰▰▰▰▰')
  expect([colorOf(69), colorOf(70), colorOf(89), colorOf(90)]).toEqual([undefined, 'yellow', 'yellow', 'red'])
})

test('limit rows with reset', () => {
  const now = Date.parse('2026-11-20T10:00:00Z')
  const rows = buildUsageRows(snap({ fiveHour: { percent: 34, resetsAt: '2026-11-20T12:40:00Z' }, weekly: { percent: 92, resetsAt: '2026-11-25T00:00:00Z' } }), now)
  expect(rows[0].text).toBe('Usage')
  expect(rows[1].text).toBe('5h  ▰▰▰▱▱▱▱▱▱▱ 34% · resets 2:40')
  expect(rows[1].color).toBeUndefined()
  expect(rows[2].text).toMatch(/^7d {2}▰{9}▱ 92% · resets [A-Z][a-z]{2}$/)
  expect(rows[2].color).toBe('red')
})

test('top agents sorted, max five, k/M', () => {
  const byAgent = [10, 41000, 2_500_000, 5, 900, 7000, 3000].map((tokens, i) => ({ label: `a${i}`, tokens }))
  const rows = buildUsageRows(snap({ ...base, breakdown: { byAgent, byCube: [], byModel: [], context: [] } }), 0)
  expect(rows.map(r => r.text)).toEqual(['Usage', 'Top agents', 'a2 · 2.5M', 'a1 · 41k', 'a5 · 7k', 'a6 · 3k', 'a4 · 900'])
  expect(compact(1000)).toBe('1k')
})

test('empty', () => {
  expect(buildUsageRows(null, 0)).toEqual([])
  expect(buildUsageRows(snap({ ...base }), 0)).toEqual([])
})
