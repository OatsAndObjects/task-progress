import { expect, test } from 'claude-code/testing'

import { addThreadMessage, answerCube, checkDescribed, applyReview, buildBoard, checkAtomic, computeLanes, finishAndRelease, flowLabel, gateCheck, missingDescribed, normalizeBoardFlow, normalizeCube, reviewCubeResult, reviseCube, runCubeCommand, topoOrder } from './cubes-model'
import { parseBudget } from './dashboard-model'

const st = (n: string, extra: any = {}) => ({ file: `${n}.ts`, fn: `${n}Fn`, does: `does ${n}`, ...extra })
const FL2 = [st('a'), st('b')]

const ok = (id: string, after: string[] = [], extra: any = {}) => ({
  id,
  title: `t${id}`,
  action: 'Do one thing',
  flow: FL2,
  after,
  doneWhen: 'tests pass',
  summary: 'Does one thing.',
  problem: ['It is broken'],
  steps: ['Edit the file'],
  code: [{ file: 'a.ts › a', change: 'fix it' }],
  minutes: 5,
  ...extra,
})

test('atomic validator names the cube to split', () => {
  expect(checkAtomic(normalizeCube(ok('c1')))).toBeNull()
  expect(checkAtomic(normalizeCube(ok('c1', [], { minutes: 11 })))).toContain('Split c1')
  expect(checkAtomic(normalizeCube(ok('c1', [], { flow: [] })))).toContain('at least 2 flow steps')
  expect(checkAtomic(normalizeCube(ok('c1', [], { flow: [st('one')] })))).toContain('give cube c1 at least'.replace('give','Give'))
  expect(checkAtomic(normalizeCube(ok('c1', [], { flow: [1, 2, 3, 4, 5, 6, 7].map(n => st(String(n))) })))).toContain('7 steps')
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

// ---- runCubeCommand with fake deps ----
function rig(specs: any[], gate = true) {
  const r: any = buildBoard('T', specs, gate)
  let snap: any = { cubes: r.board, plan: null }
  const prompts: string[] = []
  let t = 1000
  const gates: boolean[] = []
  const d: any = {
    now: () => (t += 1),
    get: () => snap,
    put: (x: any) => {
      snap = x
    },
    submit: async (text: string) => {
      prompts.push(text)
    },
    setCubesGate: async (on: boolean) => {
      gates.push(on)
    },
  }
  const st = (id: string) => snap.cubes.cubes.find((c: any) => c.id === id)?.status
  const cube = (id: string) => snap.cubes.cubes.find((c: any) => c.id === id)
  return { d, prompts, st, cube, gates, board: () => snap.cubes }
}
const run = (d: any, action: string, extra: any = {}) => runCubeCommand({ action, ...extra } as any, d)
const pair = () => [ok('c1'), ok('c2', ['c1'])]

test('approve with deps done sends the single-cube prompt', async () => {
  const g = rig(pair())
  const res: any = await run(g.d, 'cube.approve', { id: 'c1' })
  expect(res.ok).toBe(true)
  expect(g.st('c1')).toBe('approved')
  expect(g.prompts.length).toBe(1)
  expect(g.prompts[0]).toContain('approved cube c1')
  expect(g.prompts[0]).toContain('cubes: c1')
})

test('approve with pending deps queues; finishing the dep releases it in one prompt', async () => {
  const g = rig([ok('c1'), ok('c2', ['c1']), ok('c3', ['c1'])])
  expect((await run(g.d, 'cube.approve', { id: 'c2' }))!.ok).toBe(true)
  expect((await run(g.d, 'cube.approve', { id: 'c3' }))!.ok).toBe(true)
  expect(g.st('c2')).toBe('queued')
  // Each queued approval tells Claude once (the bug: nothing was sent).
  expect(g.prompts.length).toBe(2)
  await run(g.d, 'cube.approve', { id: 'c1' })
  expect(g.prompts.length).toBe(3)
  g.d.put({ ...g.d.get(), cubes: { ...g.board(), cubes: g.board().cubes.map((c: any) => (c.id === 'c1' ? { ...c, status: 'running', agentId: 'a1' } : c)) } })
  // The executor finished: c1 waits for its review, but a reviewing dep already releases its dependents.
  const released = await finishAndRelease(g.d, 'a1', true)
  expect(released.map((c: any) => c.id)).toEqual(['c2', 'c3'])
  expect(g.st('c1')).toBe('reviewing')
  expect(g.st('c2')).toBe('approved')
  // c2/c3 are approved (not yet built): no review prompt, only the release prompt.
  expect(g.prompts.length).toBe(4)
  expect(g.prompts[3]).toContain('c2')
  expect(g.prompts.some((p: string) => p.includes('in review'))).toBe(false)
  const r = await applyReview(g.d, { id: 'c1', verdict: 'APPROVE', summary: 'fine' })
  expect(r.ok).toBe(true)
  expect(g.st('c1')).toBe('done')
  expect(g.cube('c1').review.status).toBe('passed')
  expect(g.st('c2')).toBe('approved')
})

test('a multi-id review: tag is accepted when every cube is in review/done/failed', () => {
  const g = rig([ok('c1'), ok('c2'), ok('c3')])
  const b = (s1: string, s2: string) => ({ ...g.board(), cubes: g.board().cubes.map((c: any) => (c.id === 'c1' ? { ...c, status: s1 } : c.id === 'c2' ? { ...c, status: s2 } : c)) })
  expect(gateCheck(b('reviewing', 'reviewing'), undefined, ['c1', 'c2'])).toBeNull()
  expect(gateCheck(b('reviewing', 'done'), undefined, ['c1', 'c2'])).toBeNull()
  expect(gateCheck(b('reviewing', 'running'), undefined, ['c1', 'c2'])).toContain('c2 is running')
  expect(parseBudget('[budget: 5m step: 1 review: c1, c2]')?.review).toEqual(['c1', 'c2'])
})

test('a dependent can run while its dep is reviewing', async () => {
  const g = rig(pair())
  await run(g.d, 'cube.approve', { id: 'c1' })
  await run(g.d, 'cube.approve', { id: 'c2' })
  running(g)
  await finishAndRelease(g.d, 'a1', true)
  expect(g.st('c1')).toBe('reviewing')
  expect(gateCheck(g.board(), ['c2'])).toBeNull()
})

test('CubeReview ids [c1,c2]: APPROVE marks both done; REQUEST_CHANGES reopens only the cube whose file is named', () => {
  const two = (verdict: string, findings?: any[]) => {
    const g = rig([ok('c1', [], { flow: [st('p'), st('q')] }), ok('c2', [], { code: [{ file: 'b.ts › b', change: 'x' }], flow: [st('x'), st('y')] })])
    const board = { ...g.board(), cubes: g.board().cubes.map((c: any) => ({ ...c, status: 'reviewing' })) }
    return reviewCubeResult(board, { ids: ['c1', 'c2'], verdict, summary: 's', findings }, 1) as any
  }
  const a = two('APPROVE')
  expect(a.board.cubes.map((c: any) => c.status)).toEqual(['done', 'done'])
  const r = two('REQUEST_CHANGES', [{ severity: 'P1', summary: 'bug', file: 'b.ts', line: 3 }])
  expect(r.board.cubes.map((c: any) => c.status)).toEqual(['reviewing', 'approved'])
  expect(r.message).toContain('c2: reopened')
  expect(r.message).toContain('c1: kept')
  const all = two('REQUEST_CHANGES', [{ severity: 'P1', summary: 'bug' }])
  expect(all.board.cubes.map((c: any) => c.status)).toEqual(['approved', 'approved'])
  expect(reviewCubeResult(rig([ok('c1')]).board(), { ids: ['c1', 'c9'], verdict: 'APPROVE', summary: 's' }, 1)).toEqual({ error: 'no cube c9' })
})

function running(g: any) {
  g.d.put({ ...g.d.get(), cubes: { ...g.board(), cubes: g.board().cubes.map((c: any) => (c.id === 'c1' ? { ...c, status: 'running', agentId: 'a1' } : c)) } })
}

test('review gates done: REQUEST_CHANGES reopens to approved, NEEDS_INVESTIGATION stays in review', async () => {
  const g = rig(pair())
  await run(g.d, 'cube.approve', { id: 'c1' })
  running(g)
  await finishAndRelease(g.d, 'a1', true)
  expect(g.st('c1')).toBe('reviewing')
  expect(gateCheck(g.board(), ['c1'])).toContain('in review')
  expect((await applyReview(g.d, { id: 'c1', verdict: 'NEEDS_INVESTIGATION', summary: '?' })).ok).toBe(true)
  expect(g.st('c1')).toBe('reviewing')
  expect(((await run(g.d, 'cube.review', { id: 'c1' })) as any).ok).toBe(true)
  await applyReview(g.d, { id: 'c1', verdict: 'REQUEST_CHANGES', summary: 'fix', findings: [{ severity: 'P1', summary: 'bug' }] })
  expect(g.st('c1')).toBe('approved')
  expect(gateCheck(g.board(), ['c1'])).toBeNull()
  expect(g.st('c2')).toBe('proposed')
})

test('cube.markDone forces a cube in review to done and releases dependents', async () => {
  const g = rig(pair())
  await run(g.d, 'cube.approve', { id: 'c1' })
  await run(g.d, 'cube.approve', { id: 'c2' })
  running(g)
  await finishAndRelease(g.d, 'a1', true)
  expect(g.st('c2')).toBe('approved')
  expect(((await run(g.d, 'cube.markDone', { id: 'c1' })) as any).ok).toBe(true)
  expect(g.st('c1')).toBe('done')
  expect(g.st('c2')).toBe('approved')
})

test('gate off: an executor finishing marks the cube done as before', async () => {
  const g = rig(pair(), false)
  await run(g.d, 'cube.approve', { id: 'c1' })
  await run(g.d, 'cube.approve', { id: 'c2' })
  running(g)
  await finishAndRelease(g.d, 'a1', true)
  expect(g.st('c1')).toBe('done')
  expect(g.st('c2')).toBe('approved')
})

test('a legacy cube (string flow) can be edited without a new flow, but a new flow is validated', async () => {
  const g = rig(pair())
  g.d.put({ ...g.d.get(), cubes: normalizeBoardFlow({ ...g.board(), cubes: g.board().cubes.map((c: any) => (c.id === 'c1' ? { ...c, flow: ['read it', 'write it'] } : c)) }) })
  expect(g.cube('c1').flow[0].file).toBe('')
  const good: any = await run(g.d, 'cube.update', { id: 'c1', minutes: 4 })
  expect(good.ok).toBe(true)
  expect(g.cube('c1').minutes).toBe(4)
  const bad: any = await run(g.d, 'cube.update', { id: 'c1', flow: [{ file: '', fn: '', does: 'x' }, st('b')] })
  expect(bad.ok).toBe(false)
})

test('approveAll sends independent cubes together and queues the rest', async () => {
  const g = rig([ok('c1'), ok('c2'), ok('c3', ['c1'])])
  const res: any = await run(g.d, 'cube.approveAll')
  expect(res.ok).toBe(true)
  expect(g.prompts.length).toBe(1)
  expect(g.prompts[0]).toContain('c1')
  expect(g.prompts[0]).toContain('c2')
  expect(g.st('c3')).toBe('queued')
  expect((await run(g.d, 'cube.approveAll'))!.ok).toBe(false)
})

test('reject blocks approval of dependents until fixed', async () => {
  const g = rig(pair())
  expect((await run(g.d, 'cube.reject', { id: 'c1', note: 'no' }))!.ok).toBe(true)
  expect(g.st('c1')).toBe('rejected')
  const res: any = await run(g.d, 'cube.approve', { id: 'c2' })
  expect(res.ok).toBe(false)
  expect(res.message).toContain('rejected')
})

test('update: non-atomic is refused; editing an approved cube returns it to proposed with a new version', async () => {
  const g = rig(pair())
  const bad: any = await run(g.d, 'cube.update', { id: 'c1', minutes: 30 })
  expect(bad.ok).toBe(false)
  expect(g.cube('c1').minutes).toBe(5)
  const bad2: any = await run(g.d, 'cube.update', { id: 'c1', flow: [st('only one')] })
  expect(bad2.ok).toBe(false)
  expect(bad2.message).toContain('at least 2 flow steps')
  await run(g.d, 'cube.approve', { id: 'c1' })
  const v = g.cube('c1').version
  const good: any = await run(g.d, 'cube.update', { id: 'c1', actionText: 'Do it better' })
  expect(good.ok).toBe(true)
  expect(g.st('c1')).toBe('proposed')
  expect(g.cube('c1').version).toBe(v + 1)
  expect(g.cube('c1').action).toBe('Do it better')
  expect(g.cube('c1').editedBy).toBe('user')
})

test('requestChange sets revising and sends the change prompt', async () => {
  const g = rig(pair())
  expect((await run(g.d, 'cube.requestChange', { id: 'c1' }))!.ok).toBe(false)
  const res: any = await run(g.d, 'cube.requestChange', { id: 'c1', note: 'use sqlite' })
  expect(res.ok).toBe(true)
  expect(g.st('c1')).toBe('revising')
  expect(g.prompts[0]).toContain('use sqlite')
  expect(g.prompts[0]).toContain('CubeRevise')
})

test('add numbers the next cube; delete rewires after; move refuses a cycle', async () => {
  const g = rig([ok('c1'), ok('c2', ['c1']), ok('c3', ['c2'])])
  const added: any = await run(g.d, 'cube.add', { title: 'new', actionText: 'Add a thing', flow: FL2, doneWhen: 'ok', minutes: 3, after: ['c3'] })
  expect(added.ok).toBe(true)
  expect(g.cube('c4').after).toEqual(['c3'])
  expect(g.cube('c4').action).toBe('Add a thing')
  expect((await run(g.d, 'cube.add', { title: 'x', flow: FL2, doneWhen: 'ok', minutes: 3 }))!.ok).toBe(false)
  expect((await run(g.d, 'cube.delete', { id: 'c2' }))!.ok).toBe(true)
  expect(g.cube('c2')).toBeUndefined()
  expect(g.cube('c3').after).toEqual([])
  const loop: any = await run(g.d, 'cube.move', { id: 'c3', after: ['c4'] })
  expect(loop.ok).toBe(false)
  expect(loop.message).toContain('cycle')
  expect((await run(g.d, 'cube.move', { id: 'c3', after: 'c1' }))!.ok).toBe(false)
  expect((await run(g.d, 'cube.move', { id: 'c3', after: ['c1'] }))!.ok).toBe(true)
  expect(g.cube('c3').after).toEqual(['c1'])
})

test('cubes.gate switches the gate and unknown actions pass through', async () => {
  const g = rig(pair())
  const res: any = await run(g.d, 'cubes.gate', { on: false })
  expect(res.ok).toBe(true)
  expect(g.gates).toEqual([false])
  expect(g.board().gate).toBe(false)
  expect(await run(g.d, 'items.clearFinished')).toBeNull()
  expect((await run(g.d, 'cube.nope', { id: 'c1' }))!.ok).toBe(false)
})

test('CubeRevise split rewires dependents onto the last piece', () => {
  const r: any = buildBoard('T', [ok('c1'), ok('c2', ['c1']), ok('c3', ['c1'])], true)
  const sp = [ok('c1'), ok('c1-2'), ok('c1-3')].map(({ after: _a, ...x }: any) => x)
  const out: any = reviseCube(r.board, { id: 'c1', splitInto: sp })
  expect(out.error).toBeUndefined()
  const by = (id: string) => out.board.cubes.find((c: any) => c.id === id)
  expect(by('c1-2').after).toEqual(['c1'])
  expect(by('c1-3').after).toEqual(['c1-2'])
  expect(by('c2').after).toEqual(['c1-3'])
  expect(by('c3').after).toEqual(['c1-3'])
  expect(by('c1').editedBy).toBe('claude')
  expect(by('c1').status).toBe('proposed')
  expect(reviseCube(r.board, { id: 'c9' })).toHaveProperty('error')
})

test('dispatch gate: unapproved denied, untagged denied while open, approved allowed', async () => {
  const g = rig(pair())
  expect(gateCheck(g.board(), ['c1'])).toContain('waiting for the user')
  expect(gateCheck(g.board(), [])).toContain('tag')
  expect(gateCheck(g.board(), ['c9'])).toContain('no cube c9')
  await run(g.d, 'cube.approve', { id: 'c1' })
  expect(gateCheck(g.board(), ['c1'])).toBeNull()
  await run(g.d, 'cube.approve', { id: 'c2' })
  expect(gateCheck(g.board(), ['c2'])).toContain('waits for c1')
  expect(gateCheck({ ...g.board(), gate: false }, ['c2'])).toBeNull()
  const done = { ...g.board(), cubes: g.board().cubes.map((c: any) => ({ ...c, status: 'done' })) }
  expect(gateCheck(done, [])).toBeNull()
})

// ---- cube questions (cube.ask / CubeAnswer) ----
test('cube.ask appends a user message, sends the question prompt and changes nothing else', async () => {
  const g = rig(pair())
  await run(g.d, 'cube.approve', { id: 'c1' })
  g.prompts.length = 0
  const before = JSON.stringify({ ...g.cube('c1'), thread: undefined })
  const res: any = await run(g.d, 'cube.ask', { id: 'c1', text: 'why sqlite?' })
  expect(res.ok).toBe(true)
  expect(g.prompts.length).toBe(1)
  expect(g.prompts[0]).toContain('[cube question c1 "tc1"] why sqlite?')
  expect(g.prompts[0]).toContain('CubeAnswer')
  expect(g.prompts[0]).toContain('id "c1"')
  expect(g.cube('c1').thread).toEqual([{ role: 'user', text: 'why sqlite?', at: expect.any(Number) }])
  expect(JSON.stringify({ ...g.cube('c1'), thread: undefined })).toBe(before)
  expect(g.st('c1')).toBe('approved')
})

test('cube.ask works on a running cube; unknown id and empty text are errors', async () => {
  const g = rig(pair())
  g.d.put({ ...g.d.get(), cubes: { ...g.board(), cubes: g.board().cubes.map((c: any) => (c.id === 'c1' ? { ...c, status: 'running' } : c)) } })
  expect((await run(g.d, 'cube.ask', { id: 'c1', text: 'how far along?' }))!.ok).toBe(true)
  const none: any = await run(g.d, 'cube.ask', { id: 'c9', text: 'hi' })
  expect(none.ok).toBe(false)
  expect(none.message).toContain('no cube c9')
  const empty: any = await run(g.d, 'cube.ask', { id: 'c1', text: '   ' })
  expect(empty.ok).toBe(false)
  expect(g.prompts.length).toBe(1)
  expect(g.st('c1')).toBe('running')
})

test('answerCube appends a claude message, leaves the cube as it was, caps the thread', () => {
  const r: any = buildBoard('T', pair(), true)
  const before = JSON.stringify(r.board.cubes[0])
  const out: any = answerCube(r.board, { id: 'C1', answer: 'Because.' }, 77)
  expect(out.message).toBe('answer posted to c1')
  const c = out.board.cubes[0]
  expect(c.thread).toEqual([{ role: 'claude', text: 'Because.', at: 77 }])
  expect(JSON.stringify({ ...c, thread: undefined })).toBe(before)
  expect(c.version).toBe(1)
  expect(answerCube(r.board, { id: 'c9', answer: 'x' }, 1)).toHaveProperty('error')
  expect(answerCube(r.board, { id: 'c1', answer: ' ' }, 1)).toHaveProperty('error')
  let b = r.board
  for (let i = 0; i < 60; i++) b = addThreadMessage(b, 'c1', 'user', 'm' + i, i)
  expect(b.cubes[0].thread.length).toBe(50)
  expect(b.cubes[0].thread[49].text).toBe('m59')
})

// ---- function-level flow ----
test('object flow is accepted and trimmed; calls is optional and kept', () => {
  const c = normalizeCube(ok('c1', [], { flow: [st('a', { calls: ' hooks/x.ts:next ', file: ' hooks/a.ts ' }), st('b')] }))
  expect(checkAtomic(c)).toBeNull()
  expect(c.flow[0]).toEqual({ file: 'hooks/a.ts', fn: 'aFn', does: 'does a', calls: 'hooks/x.ts:next' })
  expect('calls' in c.flow[1]!).toBe(false)
})

test('a flow step missing file, fn or does is rejected with the example', () => {
  for (const bad of [{ file: '' }, { fn: ' ' }, { does: '' }]) {
    const msg = checkAtomic(normalizeCube(ok('c1', [], { flow: [st('a'), st('b', bad), st('c')] })))!
    expect(msg).toContain('flow[1] needs file, fn and does')
    expect(msg).toContain('"fn":"onPromptSubmit"')
    expect(msg).toContain('Cube c1')
  }
  const r: any = buildBoard('T', [ok('c1', [], { flow: ['plain string', 'another'] })], true)
  expect(r.error).toContain('flow[0] needs file, fn and does')
})

test('flow fields are capped', () => {
  const c = normalizeCube(ok('c1', [], { flow: [st('a', { file: 'f'.repeat(300), fn: 'g'.repeat(300), does: 'd'.repeat(300), calls: 'k'.repeat(400) }), st('b')] }))
  expect(c.flow[0]!.file.length).toBe(200)
  expect(c.flow[0]!.fn.length).toBe(120)
  expect(c.flow[0]!.does.length).toBe(200)
  expect(c.flow[0]!.calls!.length).toBe(240)
})

test('stored boards with string flow items load as steps with only does', () => {
  const r: any = buildBoard('T', [ok('c1')], true)
  const old = { ...r.board, cubes: r.board.cubes.map((c: any) => ({ ...c, flow: ['first thing', 'second thing'] })) }
  const norm = normalizeBoardFlow(old)
  expect(norm.cubes[0].flow).toEqual([
    { file: '', fn: '', does: 'first thing' },
    { file: '', fn: '', does: 'second thing' },
  ])
  expect(flowLabel(norm.cubes[0].flow[0])).toBe('first thing')
  expect(flowLabel({ file: 'hooks/register.tsx', fn: 'onPromptSubmit', does: 'x' })).toBe('register.tsx › onPromptSubmit()')
  expect(flowLabel({ file: 'shell', fn: 'claude plugin test', does: 'x' })).toBe('$ claude plugin test')
})

test('CubeRevise accepts object flow and rejects a string flow', () => {
  const r: any = buildBoard('T', pair(), true)
  const good: any = reviseCube(r.board, { id: 'c1', flow: [st('x', { calls: 'y.ts:z' }), st('y')] })
  expect(good.board.cubes[0].flow[0].calls).toBe('y.ts:z')
  const bad: any = reviseCube(r.board, { id: 'c1', flow: ['x', 'y'] })
  expect(bad.error).toContain('flow[0] needs file, fn and does')
  const split: any = reviseCube(r.board, { id: 'c1', splitInto: [ok('c1', [], { flow: ['x', 'y'] })] })
  expect(split.error).toContain('needs file, fn and does')
})

// ---- PR review (cube.review / CubeReview) ----
test('cube.review sends the pr-reviewer prompt and marks the review running', async () => {
  const g = rig([ok('c1', [], { files: ['extra/z.ts'], flow: [st('a', { file: 'hooks/a.ts' }), st('b', { file: 'shell', fn: 'npm test' })] }), ok('c2')])
  await run(g.d, 'cube.approve', { id: 'c1' })
  g.prompts.length = 0
  const res: any = await run(g.d, 'cube.review', { id: 'c1' })
  expect(res.ok).toBe(true)
  expect(g.prompts.length).toBe(1)
  expect(g.prompts[0]).toContain('[cube review c1 "tc1"]')
  expect(g.prompts[0]).toContain('task-progress:pr-reviewer')
  expect(g.prompts[0]).toContain('CubeReview')
  expect(g.prompts[0]).toContain('hooks/a.ts, extra/z.ts')
  expect(g.prompts[0]).not.toContain('shell')
  expect(g.cube('c1').review.status).toBe('running')
  expect(g.st('c1')).toBe('approved')
  expect(((await run(g.d, 'cube.review', { id: 'c9' })) as any).ok).toBe(false)
  expect(((await run(g.d, 'cube.review', { id: 'c2' })) as any).ok).toBe(false)
})

test('reviewCubeResult maps verdicts to statuses and keeps findings and quiz', () => {
  const r: any = buildBoard('T', pair(), true)
  const quiz = [{ q: 'Why?', options: ['a', 'b'], answer: 1 }]
  const ap: any = reviewCubeResult(r.board, { id: 'c1', verdict: 'APPROVE', summary: 'fine', understanding: 'it does x', quiz }, 5)
  expect(ap.board.cubes[0].review).toMatchObject({ status: 'passed', verdict: 'APPROVE', summary: 'fine', understanding: 'it does x', at: 5 })
  expect(ap.board.cubes[0].review.quiz).toEqual(quiz)
  const findings = [{ severity: 'P1', file: 'a.ts', line: 7, summary: 'bug' }, { severity: 'p3', summary: 'nit' }]
  const done = { ...r.board, cubes: r.board.cubes.map((c: any) => (c.id === 'c1' ? { ...c, status: 'done' } : c)) }
  const ch: any = reviewCubeResult(done, { id: 'c1', verdict: 'REQUEST CHANGES', summary: 'fix', findings }, 6)
  expect(ch.board.cubes[0].review.status).toBe('changes')
  expect(ch.board.cubes[0].review.findings).toEqual([{ severity: 'P1', file: 'a.ts', line: 7, summary: 'bug' }, { severity: 'P3', summary: 'nit' }])
  expect(ch.board.cubes[0].status).toBe('approved')
  expect(ch.message).toContain('dispatch a task-progress:executor')
  expect(ch.message).toContain('1 P0/P1')
  const inv: any = reviewCubeResult(r.board, { id: 'c1', verdict: 'NEEDS_INVESTIGATION', summary: '?' }, 7)
  expect(inv.board.cubes[0].review.status).toBe('investigate')
})

test('reviewCubeResult validates input and caps sizes', () => {
  const r: any = buildBoard('T', pair(), true)
  expect(reviewCubeResult(r.board, { id: 'c9', verdict: 'APPROVE', summary: 's' }, 1)).toEqual({ error: 'no cube c9' })
  expect((reviewCubeResult(r.board, { id: 'c1', verdict: 'MAYBE', summary: 's' }, 1) as any).error).toContain('verdict must be')
  expect((reviewCubeResult(r.board, { id: 'c1', verdict: 'APPROVE', summary: ' ' }, 1) as any).error).toContain('summary')
  expect((reviewCubeResult(r.board, { id: 'c1', verdict: 'APPROVE', summary: 's', findings: [{ severity: 'P9', summary: 'x' }] }, 1) as any).error).toContain('findings[0].severity')
  expect((reviewCubeResult(r.board, { id: 'c1', verdict: 'APPROVE', summary: 's', quiz: [{ q: 'q', options: ['a', 'b'], answer: 2 }] }, 1) as any).error).toContain('quiz[0]')
  const many = Array.from({ length: 70 }, (_, i) => ({ severity: 'P2', summary: 'f' + i }))
  const quiz = Array.from({ length: 15 }, () => ({ q: 'q', options: ['a', 'b'], answer: 0 }))
  const big: any = reviewCubeResult(r.board, { id: 'c1', verdict: 'APPROVE', summary: 'x'.repeat(5000), understanding: 'u'.repeat(5000), findings: many, quiz }, 1)
  const rv = big.board.cubes[0].review
  expect(rv.findings.length).toBe(50)
  expect(rv.quiz.length).toBe(10)
  expect(rv.summary.length).toBe(4000)
  expect(rv.understanding.length).toBe(4000)
})

test('parseBudget reads review: ids', () => {
  expect(parseBudget('[budget: 6m step: 2 review: c6] x')).toEqual({ minutes: 6, step: 2, review: ['c6'] })
  expect(parseBudget('[budget: 6m step: 2 review: c1,c2]')).toEqual({ minutes: 6, step: 2, review: ['c1', 'c2'] })
})

test('reviewing deadlock: cubes:/untagged are denied pointing to review:, review: passes, agent finish keeps status', async () => {
  const g = rig(pair())
  await run(g.d, 'cube.approve', { id: 'c1' })
  running(g)
  await finishAndRelease(g.d, 'a1', true)
  expect(g.st('c1')).toBe('reviewing')
  expect(gateCheck(g.board(), ['c1'])).toContain('review:')
  expect(gateCheck(g.board(), undefined)).toContain('tag')
  expect(gateCheck(g.board(), undefined, ['c1'])).toBeNull()
  expect(gateCheck(g.board(), ['c1'], ['c1'])).toContain('not both')
  expect(gateCheck(g.board(), undefined, ['c9'])).toContain('no cube c9')
  // c2 is proposed: not reviewable
  expect(gateCheck(g.board(), undefined, ['c2'])).toContain('not in review')
  // a review agent finishing changes nothing (it was never mapped to the cube)
  await finishAndRelease(g.d, 'review-agent', true)
  expect(g.st('c1')).toBe('reviewing')
  expect((await applyReview(g.d, { id: 'c1', verdict: 'APPROVE', summary: 'fine' })).ok).toBe(true)
  expect(g.st('c1')).toBe('done')
  expect(gateCheck(g.board(), undefined, ['c1'])).toBeNull()
})

test('review: on approved or running cubes is denied', async () => {
  const g = rig(pair())
  await run(g.d, 'cube.approve', { id: 'c1' })
  expect(gateCheck(g.board(), undefined, ['c1'])).toContain('not in review')
  running(g)
  expect(gateCheck(g.board(), undefined, ['c1'])).toContain('not in review')
})

test('cube details: stored, revised, kept, cut, optional', () => {
  const r: any = buildBoard('T', [ok('c1', [], { details: '  Plain words.  ' }), ok('c2')], true)
  expect(r.error).toBeUndefined()
  const by = (b: any, id: string) => b.cubes.find((c: any) => c.id === id)
  expect(by(r.board, 'c1').details).toBe('Plain words.')
  expect(by(r.board, 'c2').details).toBeUndefined()
  expect(checkAtomic(normalizeCube(ok('c2')))).toBeNull()
  const kept: any = reviseCube(r.board, { id: 'c1', title: 'new title' })
  expect(by(kept.board, 'c1').details).toBe('Plain words.')
  const upd: any = reviseCube(r.board, { id: 'c1', details: 'Changed.' })
  expect(by(upd.board, 'c1').details).toBe('Changed.')
  expect(normalizeCube(ok('c1', [], { details: 'x'.repeat(2000) })).details!.length).toBe(1200)
  expect(normalizeCube(ok('c1', [], { details: 5 })).details).toBeUndefined()
  const split: any = reviseCube(r.board, { id: 'c2', splitInto: [ok('c2', [], { details: 'A' }), ok('c2-2', [], { details: 'B' })] })
  expect(by(split.board, 'c2').details).toBe('A')
  expect(by(split.board, 'c2-2').details).toBe('B')
  const cleared: any = reviseCube(r.board, { id: 'c1', details: '' })
  expect(by(cleared.board, 'c1').details).toBeUndefined()
})

test('approveAll: prompt submitted', async () => {
  for (const cmd of [{ action: 'cube.approveAll' }]) {
    const g = rig([ok('c1'), ok('c2'), ok('c3', ['c1'])])
    const res: any = await runCubeCommand(cmd, g.d)
    expect(res.ok).toBe(true)
    expect(g.prompts.length).toBe(1)
    expect(g.prompts[0]).toContain('c1')
    expect(g.prompts[0]).toContain('c2')
    expect(res.message).toBe('c1, c2 sent to Claude; c3 starts after c1')
  }
})

test('approve names what a waiting cube waits for', async () => {
  const g = rig([ok('c1'), ok('c2', ['c1'])])
  const res: any = await run(g.d, 'cube.approve', { id: 'c2' })
  expect(res.message).toBe('cube c2 approved, not started yet: c2 starts after c1')
  expect(g.prompts.length).toBe(1)
})

test('waiting cube is released after the dependency review APPROVE and after markDone', async () => {
  for (const how of ['review', 'markDone']) {
    const g = rig([ok('c1'), ok('c2', ['c1'])])
    await run(g.d, 'cube.approveAll')
    expect(g.prompts.length).toBe(1)
    running(g)
    await finishAndRelease(g.d, 'a1', true)
    // c1 reviewing already releases c2 (announced once, before the review)
    expect(g.st('c2')).toBe('approved')
    expect(g.prompts.some((p: string) => p.includes('approved cube c2'))).toBe(true)
    const before = g.prompts.length
    if (how === 'review') await applyReview(g.d, { id: 'c1', verdict: 'APPROVE', summary: 'fine' })
    else await run(g.d, 'cube.markDone', { id: 'c1' })
    expect(g.st('c1')).toBe('done')
    expect(g.st('c2')).toBe('approved')
    expect(g.prompts.length).toBe(before)
  }
})

test('a release while a turn runs is handed to submit, which queues it for the idle session', async () => {
  const g = rig([ok('c1'), ok('c2', ['c1'])])
  // submit resolves late, as when a turn is running; the release must still be sent exactly once
  let calls = 0
  g.d.submit = async (t: string) => {
    calls++
    await new Promise(r => setTimeout(r, 20))
    g.prompts.push(t)
  }
  await run(g.d, 'cube.approveAll')
  running(g)
  await finishAndRelease(g.d, 'a1', true)
  await applyReview(g.d, { id: 'c1', verdict: 'APPROVE', summary: 'fine' })
  expect(g.st('c2')).toBe('approved')
  expect(g.prompts.filter(p => p.includes('approved cube c2')).length).toBe(1)
  expect(calls).toBe(2)
})

test('describing fields: normalized, capped, empty dropped', () => {
  const n = normalizeCube(
    ok('c1', [], {
      summary: '  ' + 'x'.repeat(400),
      problem: ['  a  ', '', 'b'.repeat(300), '3', '4', '5', '6', '7'],
      steps: Array.from({ length: 12 }, (_, i) => `s${i}`),
      code: [{ file: ' f.ts ', change: ' c ' }, { file: '', change: '' }, ...Array.from({ length: 12 }, (_, i) => ({ file: `f${i}`, change: 'x'.repeat(300) }))],
    }),
  )
  expect(n.summary!.length).toBe(300)
  expect(n.problem!.length).toBe(6)
  expect(n.problem![0]).toBe('a')
  expect(n.problem![1]!.length).toBe(200)
  expect(n.steps!.length).toBe(8)
  expect(n.code!.length).toBe(10)
  expect(n.code![0]).toEqual({ file: 'f.ts', change: 'c' })
  expect(n.code![1]!.change.length).toBe(200)
  const e = normalizeCube(ok('c1', [], { summary: ' ', problem: ['', ' '], steps: [], code: [{ file: '', change: '' }] }))
  for (const k of ['summary', 'problem', 'steps', 'code']) expect(k in e).toBe(false)
  expect(missingDescribed(e)).toEqual(['summary', 'problem', 'steps', 'code'])
  expect(missingDescribed(normalizeCube(ok('c1', [], { code: [{ file: 'a.ts', change: '' }] })))).toEqual(['code'])
  expect(checkDescribed([normalizeCube(ok('c1')), normalizeCube(ok('c2', [], { steps: [] }))])).toContain('cube c2 is missing steps')
  expect(checkDescribed([normalizeCube(ok('c1'))])).toBeNull()
})

test('edit patch replaces a describing field wholesale; no patch keeps it', () => {
  const r: any = buildBoard('T', [ok('c1')], true)
  const kept: any = reviseCube(r.board, { id: 'c1', title: 'new' })
  expect(kept.board.cubes[0].problem).toEqual(['It is broken'])
  expect(kept.board.cubes[0].code).toEqual([{ file: 'a.ts › a', change: 'fix it' }])
  const upd: any = reviseCube(r.board, { id: 'c1', problem: ['p1', 'p2'], summary: 'New one.', code: [{ file: 'z.ts', change: 'zap' }] })
  const c = upd.board.cubes[0]
  expect(c.problem).toEqual(['p1', 'p2'])
  expect(c.summary).toBe('New one.')
  expect(c.code).toEqual([{ file: 'z.ts', change: 'zap' }])
  expect(c.steps).toEqual(['Edit the file'])
  const cleared: any = reviseCube(r.board, { id: 'c1', steps: [] })
  expect('steps' in cleared.board.cubes[0]).toBe(false)
  const split: any = reviseCube(r.board, { id: 'c1', splitInto: [ok('c1', [], { summary: '' }), ok('c1-2')] })
  expect(split.error).toContain('cube c1 is missing summary')
})

// ---- approved cubes queued behind unfinished deps must still tell Claude ----
const runningC1 = (g: any) => g.d.put({ ...g.d.get(), cubes: { ...g.board(), cubes: g.board().cubes.map((c: any) => (c.id === 'c1' ? { ...c, status: 'running', agentId: 'a1' } : c)) } })

test('approveAll with everything queued behind a running cube sends one notice', async () => {
  const g = rig([ok('c1'), ok('c2', ['c1']), ok('c3', ['c1'])])
  await run(g.d, 'cube.approve', { id: 'c1' })
  runningC1(g)
  g.prompts.length = 0
  const res: any = await run(g.d, 'cube.approveAll')
  expect(res.ok).toBe(true)
  expect(g.prompts.length).toBe(1)
  const t = g.prompts[0]
  expect(t).toContain('c2')
  expect(t).toContain('c3')
  expect(t).toContain('queued')
  expect(t).toContain('after c1')
  expect(t).toContain('do not ask the user to approve them again')
  expect(t).not.toContain('Execute it now')
  expect(t).not.toContain('Dispatch it')
})

test('approve of one queued cube sends a notice', async () => {
  const g = rig([ok('c1'), ok('c2', ['c1']), ok('c3', ['c1'])])
  await run(g.d, 'cube.approve', { id: 'c1' })
  runningC1(g)
  g.prompts.length = 0
  await run(g.d, 'cube.approve', { id: 'c2' })
  expect(g.prompts.length).toBe(1)
  expect(g.prompts[0]).toContain('c2')
  expect(g.prompts[0]).toContain('queued')
  expect(g.prompts[0]).toContain('after c1')
  expect(g.prompts[0]).not.toContain('Dispatch it')
})

test('approveAll with a ready cube and a queued one: execute c1, mention c2 queued', async () => {
  const g = rig([ok('c1'), ok('c2', ['c1'])])
  await run(g.d, 'cube.approveAll')
  expect(g.prompts.length).toBe(1)
  expect(g.prompts[0]).toContain('Execute it now')
  expect(g.prompts[0]).toContain('c2')
  expect(g.prompts[0]).toContain('queued')
  expect(g.prompts[0]).toContain('after c1')
})

test('review prompt is sent once, only when all cubes are built, naming every reviewing id', async () => {
  const g = rig([ok('c1'), ok('c2')])
  await run(g.d, 'cube.approve', { id: 'c1' })
  await run(g.d, 'cube.approve', { id: 'c2' })
  const setRun = (id: string, agent: string) =>
    g.d.put({ ...g.d.get(), cubes: { ...g.board(), cubes: g.board().cubes.map((c: any) => (c.id === id ? { ...c, status: 'running', agentId: agent } : c)) } })
  setRun('c1', 'a1')
  setRun('c2', 'a2')
  const before = g.prompts.length
  await finishAndRelease(g.d, 'a1', true)
  expect(g.prompts.length).toBe(before)
  await finishAndRelease(g.d, 'a2', true)
  expect(g.prompts.length).toBe(before + 1)
  const last = g.prompts[g.prompts.length - 1]
  expect(last).toContain('c1, c2')
  expect(last).toContain('ids ["c1", "c2"]')
})

// ---- combined review prompt trigger ----
const setStatus = (g: any, patch: Record<string, any>) =>
  g.d.put({ ...g.d.get(), cubes: { ...g.board(), cubes: g.board().cubes.map((c: any) => (patch[c.id] ? { ...c, ...patch[c.id] } : c)) } })
const reviewPrompts = (g: any) => g.prompts.filter((p: string) => p.includes('are built and in review'))

test('review prompt is sent when the last cube fails while others are reviewing, and only once', async () => {
  const g = rig([ok('c1'), ok('c2')])
  await run(g.d, 'cube.approveAll')
  setStatus(g, { c1: { status: 'running', agentId: 'a1' }, c2: { status: 'running', agentId: 'a2' } })
  await finishAndRelease(g.d, 'a1', true)
  expect(reviewPrompts(g).length).toBe(0)
  await finishAndRelease(g.d, 'a2', false)
  expect(g.st('c1')).toBe('reviewing')
  expect(g.st('c2')).toBe('failed')
  expect(reviewPrompts(g).length).toBe(1)
  expect(reviewPrompts(g)[0]).toContain('c1')
  // same set again (an unrelated agent finishing, a reject that changes nothing for c1): not sent twice
  await finishAndRelease(g.d, 'a2', false)
  await run(g.d, 'cube.reject', { id: 'c2' })
  expect(reviewPrompts(g).length).toBe(1)
})

test('rejecting the last unbuilt cube sends the review prompt for the reviewing ones', async () => {
  const g = rig([ok('c1'), ok('c2')])
  await run(g.d, 'cube.approve', { id: 'c1' })
  setStatus(g, { c1: { status: 'running', agentId: 'a1' } })
  await finishAndRelease(g.d, 'a1', true)
  // c2 is only proposed: not blocking, so the prompt already went once
  expect(reviewPrompts(g).length).toBe(1)
  await run(g.d, 'cube.reject', { id: 'c2' })
  expect(reviewPrompts(g).length).toBe(1)
})

test('multi-id REQUEST_CHANGES with no matching file reopens all listed cubes; matches reopen only those', () => {
  const r: any = buildBoard('T', [ok('c1', [], { files: ['one.ts'] }), ok('c2', [], { files: ['two.ts'] })], true)
  const b = { ...r.board, cubes: r.board.cubes.map((c: any) => ({ ...c, status: 'reviewing', flow: [], code: [] })) }
  const un: any = reviewCubeResult(b, { ids: ['c1', 'c2'], verdict: 'REQUEST_CHANGES', summary: 's', findings: [{ severity: 'P1', summary: 'x', file: 'zzz.ts' }] }, 1)
  expect(un.board.cubes.map((c: any) => c.status)).toEqual(['approved', 'approved'])
  const hit: any = reviewCubeResult(b, { ids: ['c1', 'c2'], verdict: 'REQUEST_CHANGES', summary: 's', findings: [{ severity: 'P1', summary: 'x', file: 'two.ts' }] }, 1)
  expect(hit.board.cubes.map((c: any) => c.status)).toEqual(['reviewing', 'approved'])
})
