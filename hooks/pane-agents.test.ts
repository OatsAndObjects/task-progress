import { expect, test } from 'claude-code/testing'

import { buildAgentRows } from './pane-agents'

const ag = (id: string, status: string, extra: any = {}) => ({ id, description: `work ${id}`, type: 'task-progress:executor', status, startedAt: 0, ...extra }) as any

test('running: short type, tag, time left', () => {
  const [r] = buildAgentRows([ag('a', 'running', { budgetMin: 5, cube: { id: 'c9', kind: 'build' } })], 90_000)
  expect([r.glyph, r.name, r.tag, r.time, r.over]).toEqual(['◐', 'executor', 'c9', '3:30 left', false])
})

test('overrun and step tag', () => {
  const [r] = buildAgentRows([ag('a', 'running', { budgetMin: 1, step: 4 })], 75_000)
  expect([r.tag, r.time, r.over]).toEqual(['step 4', '+0:15 over', true])
})

test('finished: running first, newest three, detail truncated', () => {
  const rows = buildAgentRows(
    [ag('d1', 'done', { endedAt: 1 }), ag('d2', 'failed', { endedAt: 5 }), ag('d3', 'done', { endedAt: 3 }), ag('d4', 'done', { endedAt: 4 }), ag('r', 'running', { description: 'x'.repeat(80) })],
    10,
  )
  expect(rows.map(r => r.glyph)).toEqual(['◐', '✗', '✓', '✓'])
  expect(rows[0].detail!.length).toBe(40)
  expect(rows[0].time).toBeUndefined()
})

test('empty: no rows', () => {
  expect(buildAgentRows([], 0)).toEqual([])
  expect(buildAgentRows(null, 0)).toEqual([])
  expect(buildAgentRows([ag('i', 'idle'), ag('s', 'stopped')], 0)).toEqual([])
})

test('detail prefers lastTool over description', () => {
  const [a, b] = buildAgentRows([ag('a', 'running', { lastTool: 'Edit hooks/x.ts' }), ag('b', 'running')], 0)
  expect(a.detail).toBe('Edit hooks/x.ts')
  expect(b.detail).toBe('work b')
})
