import { expect, test } from 'claude-code/testing'

import { addThreadMessage, answerCube, buildBoard, checkAtomic, computeLanes, finishAndRelease, flowLabel, gateCheck, normalizeBoardFlow, normalizeCube, reviewCubeResult, reviseCube, runCubeCommand, topoOrder } from './cubes-model'
import { commandFromLine, parseBudget } from './dashboard-model'

const st = (n: string, extra: any = {}) => ({ file: `${n}.ts`, fn: `${n}Fn`, does: `does ${n}`, ...extra })
const FL2 = [st('a'), st('b')]

const ok = (id: string, after: string[] = [], extra: any = {}) => ({
  id,
  title: `t${id}`,
  action: 'Do one thing',
  flow: FL2,
  after,
  doneWhen: 'tests pass',
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
  expect(g.prompts.length).toBe(0)
  await run(g.d, 'cube.approve', { id: 'c1' })
  expect(g.prompts.length).toBe(1)
  g.d.put({ ...g.d.get(), cubes: { ...g.board(), cubes: g.board().cubes.map((c: any) => (c.id === 'c1' ? { ...c, status: 'running', agentId: 'a1' } : c)) } })
  const released = await finishAndRelease(g.d, 'a1', true)
  expect(released.map(c => c.id)).toEqual(['c2', 'c3'])
  expect(g.prompts.length).toBe(2)
  expect(g.prompts[1]).toContain('c2')
  expect(g.prompts[1]).toContain('c3')
  expect(g.st('c2')).toBe('approved')
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

test('commandFromLine keeps the cube sentence apart from the command action', () => {
  const { cmd } = commandFromLine({ type: 'command', id: 'x1', action: 'cube.update', args: { id: 'c1', actionText: 'Say hi' } })
  expect(cmd.action).toBe('cube.update')
  expect(cmd.id).toBe('c1')
  expect(cmd.actionText).toBe('Say hi')
  const old = commandFromLine({ type: 'command', id: 'x2', action: 'cube.add', args: { action: 'Old style sentence' } })
  expect(old.cmd.action).toBe('cube.add')
  expect(old.cmd.cubeAction).toBe('Old style sentence')
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
  expect(g.prompts[0]).toContain('pr-reviewer')
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
