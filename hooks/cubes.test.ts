import { expect, test } from 'claude-code/testing'

import { buildBoard, checkAtomic, computeLanes, gateCheck, normalizeCube, topoOrder } from './cubes-model'
import { parseBudget } from './dashboard-model'

const ok = (id: string, after: string[] = [], extra: any = {}) => ({
  id,
  title: `t${id}`,
  action: 'Do one thing',
  flow: ['a', 'b'],
  after,
  doneWhen: 'tests pass',
  minutes: 5,
  ...extra,
})

test('atomic validator names the cube to split', () => {
  expect(checkAtomic(normalizeCube(ok('c1')))).toBeNull()
  expect(checkAtomic(normalizeCube(ok('c1', [], { minutes: 11 })))).toContain('Split c1')
  expect(checkAtomic(normalizeCube(ok('c1', [], { flow: [] })))).toContain('no flow')
  expect(checkAtomic(normalizeCube(ok('c1', [], { flow: ['1', '2', '3', '4', '5', '6', '7'] })))).toContain('7 steps')
  expect(checkAtomic(normalizeCube(ok('c1', [], { doneWhen: '  ' })))).toContain('doneWhen')
  expect(checkAtomic(normalizeCube(ok('c1', [], { action: '' })))).toContain('no action')
  expect(checkAtomic(normalizeCube(ok('c1', [], { action: 'x'.repeat(201) })))).toContain('not atomic')
})

test('graph errors reject the whole plan', () => {
  const err = (cubes: any[]) => {
    const r: any = buildBoard('T', cubes, true)
    return r.error as string | undefined
  }
  expect(err([ok('c1', ['c9'])])).toContain('unknown cube c9')
  expect(err([ok('c1'), ok('c1')])).toContain('Duplicate')
  expect(err([ok('c1', ['c2']), ok('c2', ['c1'])])).toContain('cycle')
  expect(err(Array.from({ length: 41 }, (_, i) => ok(`c${i + 1}`)))).toContain('too many')
  expect(err([ok('c1'), ok('c2', ['c1'])])).toBeUndefined()
})

test('lanes group by depth and topological order follows them', () => {
  const cubes = [ok('c1'), ok('c2', ['c1']), ok('c3'), ok('c4', ['c2', 'c3'])]
  expect(computeLanes(cubes.map(c => ({ id: c.id, after: c.after })))).toEqual([['c1', 'c3'], ['c2'], ['c4']])
  const r: any = buildBoard('T', cubes, true)
  expect(topoOrder(r.board).map((c: any) => c.id)).toEqual(['c1', 'c3', 'c2', 'c4'])
})

test('gate and cube tag parsing', () => {
  expect(parseBudget('[budget: 6m step: 2 cubes: c3,c4]\nx')).toEqual({ minutes: 6, step: 2, cubes: ['c3', 'c4'] })
  expect(parseBudget('[budget: 6m step: 2]')).toEqual({ minutes: 6, step: 2 })
  const r: any = buildBoard('T', [ok('c1'), ok('c2', ['c1'])], true)
  expect(gateCheck(r.board, ['c1'])).toContain('waiting for the user')
  expect(gateCheck(r.board, [])).toContain('tag')
  expect(gateCheck(null, [])).toBeNull()
})
