import { expect, mock, test } from 'claude-code/testing'

import { GATED_TOOLS, answered, budgetDecision, formatCountdown, parseBudget, parseModeArg } from './register'

const INPUTS = 'mcp__task-progress__TaskInputs'
const PLAN = 'mcp__task-progress__TaskPlan'
const PROGRESS = 'mcp__task-progress__TaskProgress'
const BAND = {
  plugin: 'task-progress',
  component: 'AbovePrompt',
  requestId: 'band',
  surface: 'terminal',
  props: { hasSurvey: false, bodyColumns: 100 },
} as const
const MIN = 60_000

const DESC = { summary: 'Does the thing so it works.', problem: ['It is broken'], steps: ['Edit the file'], code: [{ file: 'a.ts › a', change: 'fix it' }] }
const APPROACH = { questions: [{ header: 'Approach', question: 'How?', options: [{ label: 'A (Recommended)' }, { label: 'B' }] }] }

function setup($: any, on: any) {
  const clock = mock.clock(on, { now: 5_000_000 })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text, context: e.context }))
  let nextId = 0
  on('agent.spawn', () => ({ model: 'sonnet', agentId: `a${++nextId}` }))
  const call = (tool: string, input: Record<string, unknown> = {}) => $.tool.call({ tool, ...input })
  const dispatch = (minutes: number | null, step = 1) =>
    $.agent.spawn({
      prompt: (minutes === null ? '' : `[budget: ${minutes}m step: ${step}]\n`) + 'do the step',
      description: 'step',
      subagentType: 'task-progress:executor',
    })
  const bandTexts = async () => {
    const ui = await $.ui.mount(BAND)
    const t: { text: string; color?: string }[] = (await ui.findAll({ type: 'Text' })).map((x: any) => ({ text: x.text, color: x.props.color }))
    await ui.unmount()
    return t
  }
  const start = () => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return { clock, call, dispatch, bandTexts, start }
}

const run = ($: any, args?: string) => $.command.run({ command: 'orchestrate', args })

test('budget tag parsing', () => {
  expect(parseBudget('[budget: 12m step: 2]\nwork')).toEqual({ minutes: 12, step: 2 })
  expect(parseBudget('x [Budget:5m] y')).toEqual({ minutes: 5, step: null })
  expect(parseBudget('[budget: 1.5 min step: 10 extra]')).toEqual({ minutes: 1.5, step: 10 })
  expect(parseBudget('no tag here')).toBeNull()
  expect(parseBudget('[budget: 0m]')).toBeNull()
  expect(parseBudget('[budget: soon]')).toBeNull()
  expect(parseBudget(undefined)).toBeNull()
})

test('budget decisions: allow below 80%, warn from 80%, deny from 100%', () => {
  const b = 10 * MIN
  expect(budgetDecision(0, b).action).toBe('allow')
  expect(budgetDecision(7.9 * MIN, b).action).toBe('allow')
  expect(budgetDecision(8 * MIN, b)).toEqual({ action: 'warn', leftMs: 2 * MIN })
  expect(budgetDecision(9.99 * MIN, b).action).toBe('warn')
  expect(budgetDecision(10 * MIN, b).action).toBe('deny')
  expect(budgetDecision(15 * MIN, b).action).toBe('deny')
  expect(formatCountdown(220_000)).toBe('3:40 left')
  expect(formatCountdown(-20_000)).toBe('+0:20 over')
  expect(parseModeArg('')).toBe('status')
  expect(parseModeArg(' ON ')).toBe('on')
  expect(parseModeArg('maybe')).toBeNull()
})

test('input gate: denies state-changing tools until TaskInputs, then allows', async ($, on) => {
  const { call, start } = setup($, on)
  await start()
  for (const tool of ['Bash', 'Edit', 'Write', 'PowerShell', 'NotebookEdit']) {
    expect(GATED_TOOLS).toContain(tool)
  }
  const denied = await call('Bash', { command: 'ls' })
  expect(denied.deny).toContain('TaskInputs')
  expect((await call('Edit', { file_path: '/a', old_string: 'a', new_string: 'b' })).deny).toContain('TaskInputs')
  // Read-only and the plugin's own tools stay open.
  expect((await call('Read', { file_path: '/a' })).deny).toBeUndefined()
  expect((await call('Grep', { pattern: 'x' })).deny).toBeUndefined()
  expect((await call(PROGRESS, { task: 'T', totalSteps: 2, step: 0 })).deny).toBeUndefined()
  // Inputs that were not asked yet keep the gate shut and tell the model to ask.
  const need = await call(INPUTS, { inputs: [{ question: 'Which DB?', why: 'schema' }], asked: false })
  expect(String(need.result)).toContain('ONE AskUserQuestion')
  expect((await call('Bash', { command: 'ls' })).deny).toBeDefined()
  // An empty list, or inputs marked asked, opens it.
  await call(INPUTS, { inputs: [], asked: false })
  expect((await call('Bash', { command: 'ls' })).deny).toBeUndefined()
})

test('input gate resets on a new user prompt but not on a slash command', async ($, on) => {
  const { call, start } = setup($, on)
  await start()
  await call(INPUTS, { inputs: [], asked: false })
  expect((await call('Bash', { command: 'ls' })).deny).toBeUndefined()
  await $.prompt.submit({ text: '/orchestrate status', command: { name: 'orchestrate' } })
  expect((await call('Bash', { command: 'ls' })).deny).toBeUndefined()
  await $.prompt.submit({ text: 'now do something else' })
  expect((await call('Bash', { command: 'ls' })).deny).toContain('TaskInputs')
  await call(INPUTS, { inputs: [{ question: 'q', why: 'w' }], asked: true })
  expect((await call('Bash', { command: 'ls' })).deny).toBeUndefined()
})

test('sub-agents are not gated by the input check', async ($, on) => {
  const { call, start } = setup($, on)
  await start()
  expect((await call('Bash', { command: 'ls', agentId: 'someone' })).deny).toBeUndefined()
})

test('dispatch without a budget tag is denied; with one it is allowed', async ($, on) => {
  const { call, start } = setup($, on)
  await start()
  await call(INPUTS, { inputs: [], asked: false })
  const no = await call('Agent', { prompt: 'just do it', description: 'd', subagent_type: 'task-progress:executor' })
  expect(no.deny).toContain('[budget:')
  const yes = await call('Agent', { prompt: '[budget: 6m step: 1]\ngo', description: 'd', subagent_type: 'task-progress:executor' })
  expect(yes.deny).toBeUndefined()
})

// A 2 min budget: the 120 ms ticker runs once per mocked tick, so a 10 min budget (5000 ticks) sometimes exceeded the 5 s test limit.
test('executor time budget: allow, wrap-up notice once at 80%, deny at 100%', async ($, on) => {
  const { clock, call, dispatch, start } = setup($, on)
  await start()
  await dispatch(2, 2)
  expect((await call('Bash', { command: 'ls', agentId: 'a1' })).deny).toBeUndefined()
  await clock.advance(1.4 * MIN)
  const early = await call('Bash', { command: 'ls', agentId: 'a1' })
  expect(early.deny).toBeUndefined()
  expect(early.context).toBeUndefined()
  await clock.advance(0.3 * MIN) // 102 s of 120 s
  const warn = await call('Bash', { command: 'ls', agentId: 'a1' })
  expect(warn.deny).toBeUndefined()
  expect(String(warn.context?.[0])).toContain('wrap up')
  expect(String(warn.context?.[0])).toContain('1 min left')
  const again = await call('Bash', { command: 'ls', agentId: 'a1' })
  expect(again.context).toBeUndefined() // not repeated
  await clock.advance(0.3 * MIN) // over
  const over = await call('Bash', { command: 'ls', agentId: 'a1' })
  expect(over.deny).toBe('Time budget of 2 min exceeded: stop now and return your report to the orchestrator.')
  expect((await call('Read', { file_path: '/x', agentId: 'a1' })).deny).toContain('Time budget')
  // TaskProgress is the one exception, and other agents keep their own clocks.
  expect((await call(PROGRESS, { task: 'T', totalSteps: 1, step: 0, agentId: 'a1' })).deny).toBeUndefined()
  expect((await call('Bash', { command: 'ls', agentId: 'unknown' })).deny).toBeUndefined()
})

test('an executor with a different budget is timed on its own', async ($, on) => {
  const { clock, call, dispatch, start } = setup($, on)
  await start()
  await dispatch(2, 1)
  await dispatch(30, 2)
  await clock.advance(3 * MIN)
  expect((await call('Bash', { command: 'ls', agentId: 'a1' })).deny).toContain('2 min')
  expect((await call('Bash', { command: 'ls', agentId: 'a2' })).deny).toBeUndefined()
})

test('an untagged dispatch is not timed', async ($, on) => {
  const { clock, call, dispatch, start } = setup($, on)
  await start()
  await dispatch(null)
  await clock.advance(60 * MIN)
  expect((await call('Bash', { command: 'ls', agentId: 'a1' })).deny).toBeUndefined()
})

test('band shows each executor countdown, warns at 80% and shows overrun in red', async ($, on) => {
  const { clock, dispatch, bandTexts, start } = setup($, on)
  await start()
  await dispatch(4, 2)
  let t = await bandTexts()
  expect(t.map(x => x.text).join('')).toContain('step 2 · 4:00 left')
  await clock.advance(3.5 * MIN)
  t = await bandTexts()
  const warn = t.find(x => x.text.includes('left'))!
  expect(warn.text).toContain('0:30 left')
  expect(warn.color).toBe('#F59E0B')
  await clock.advance(1 * MIN)
  t = await bandTexts()
  const over = t.find(x => x.text.includes('over'))!
  expect(over.text).toContain('+0:30 over')
  expect(over.color).toBe('#F87171')
})

test('the clock ticks only while something is active', async ($, on) => {
  const { clock, dispatch, start } = setup($, on)
  let frames = 0
  on('state.set', (_: any, e: any, next: any) => {
    if (e.key === 'frame') frames += 1
    return next(e)
  })
  await start()
  await clock.advance(2_000)
  expect(frames).toBe(0)
  await dispatch(5, 1)
  await clock.advance(1_000)
  expect(frames).toBeGreaterThan(5)
})

test('TaskPlan stores the plan and seeds the bar with one segment per step', async ($, on) => {
  const { call, bandTexts, start } = setup($, on)
  await start()
  const r = await call(PLAN, {
    task: 'Ship feature',
    steps: [
      { title: 'a', minutes: 5 },
      { title: 'b', minutes: 10 },
      { title: 'c', minutes: 3 },
    ],
  })
  expect(String(r.result)).toContain('3 steps')
  expect(String(r.result)).toContain('[budget:')
  const t = await bandTexts()
  expect(t.map(x => x.text).join('')).toContain('Ship feature')
  expect(t.map(x => x.text).join('')).toContain('0/3')
  const st = (await run($, 'status')).text
  expect(st).toContain('plan: Ship feature, 3 steps')
})

test('mode off: no gate, no budget tag needed, no timing, no protocol text; on restores it', async ($, on) => {
  const { clock, call, dispatch, start } = setup($, on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
  await start()
  expect((await run($, 'off')).text).toBe('Orchestrator mode off.')
  expect((await run($, 'status')).text).toContain('Orchestrator mode off')
  expect((await call('Bash', { command: 'ls' })).deny).toBeUndefined()
  expect((await call('Agent', { prompt: 'no tag', description: 'd', subagent_type: 'x' })).deny).toBeUndefined()
  await dispatch(1, 1)
  await clock.advance(5 * MIN)
  expect((await call('Bash', { command: 'ls', agentId: 'a1' })).deny).toBeUndefined()
  let out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  expect(out.sections.map((s: any) => s.id)).toEqual(['intro', 'task-progress:progress-bar'])
  expect((await run($, 'on')).text).toBe('Orchestrator mode on.')
  expect((await call('Bash', { command: 'ls' })).deny).toContain('TaskInputs')
  out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  expect(out.sections.map((s: any) => s.id)).toEqual(['intro', 'task-progress:orchestrator', 'task-progress:progress-bar'])
  expect(out.sections[1].text.length).toBeLessThan(1250)
})

test('no compose: first user prompt carries the rules, the next only a reminder', async ($, on) => {
  const { start } = setup($, on)
  await start()
  const first = await $.prompt.submit({ text: 'hello' })
  const ctx1 = (first.context ?? []).join(' ')
  expect(ctx1).toContain('TaskInputs')
  expect(ctx1).toContain('TaskProgress')
  const second = await $.prompt.submit({ text: 'again' })
  const ctx2 = (second.context ?? []).join(' ')
  expect(ctx2).toContain('TaskInputs first')
  expect(ctx2).not.toContain('TaskProgress')
})

test('after compose ran: user prompts get no added context', async ($, on) => {
  const { start } = setup($, on)
  on('prompt.compose', () => ({ sections: [] }))
  await start()
  await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const out = await $.prompt.submit({ text: 'hello' })
  expect(out.context ?? []).toEqual([])
})

test('a slash command prompt gets no added context', async ($, on) => {
  const { start } = setup($, on)
  await start()
  const out = await $.prompt.submit({ text: '/orchestrate status', command: { name: 'orchestrate' } })
  expect(out.context ?? []).toEqual([])
})

test('/orchestrate arguments', async ($, on) => {
  const { start } = setup($, on)
  await start()
  expect((await run($)).text).toContain('Orchestrator mode on')
  expect((await run($, 'status')).text).toContain('0 executors running')
  expect((await run($, ' OFF ')).text).toBe('Orchestrator mode off.')
  expect((await run($, 'bogus')).text).toBe('Usage: /orchestrate on | off | status')
})

test('CubeAnswer passes the input gate; state-changing tools stay gated', async ($, on) => {
  const { call, start } = setup($, on)
  await start()
  await $.prompt.submit({ text: 'a question about a cube step' })
  expect((await call('Bash', { command: 'ls' })).deny).toContain('TaskInputs')
  await call('AskUserQuestion', APPROACH)
  const plan = await call(PLAN, {
    task: 'T',
    cubes: [{ ...DESC, id: 'c1', title: 't', action: 'Do one thing', flow: [{ file: 'a.ts', fn: 'a', does: 'a' }, { file: 'b.ts', fn: 'b', does: 'b' }], doneWhen: 'ok', minutes: 3 }],
  })
  expect(String(plan.result)).toContain('cube plan recorded')
  const ans = await call('mcp__task-progress__CubeAnswer', { id: 'c1', answer: 'It adds the thing.' })
  expect(ans.deny).toBeUndefined()
  expect(String(ans.result)).toContain('answer posted to c1')
  const bad = await call('mcp__task-progress__CubeAnswer', { id: 'zz', answer: 'x' })
  expect(bad.deny).toBeUndefined()
  expect(String(bad.result)).toContain('answer not posted')
  expect((await call('Bash', { command: 'ls' })).deny).toContain('TaskInputs')
})

test('CubeReview passes the input gate, stores the review and is registered', async ($, on) => {
  const { call, start } = setup($, on)
  await start()
  await $.prompt.submit({ text: 'review a cube' })
  expect((await call('Bash', { command: 'ls' })).deny).toContain('TaskInputs')
  await call('AskUserQuestion', APPROACH)
  await call(PLAN, { task: 'T', cubes: [{ ...DESC, id: 'c1', title: 't', action: 'Do one thing', flow: [{ file: 'a.ts', fn: 'a', does: 'a' }, { file: 'b.ts', fn: 'b', does: 'b' }], doneWhen: 'ok', minutes: 3 }] })
  const rev = await call('mcp__task-progress__CubeReview', { id: 'c1', verdict: 'REQUEST_CHANGES', summary: 'one bug', findings: [{ severity: 'P1', file: 'a.ts', line: 3, summary: 'null deref' }] })
  expect(rev.deny).toBeUndefined()
  expect(String(rev.result)).toContain('review stored for c1: REQUEST_CHANGES')
  const bad = await call('mcp__task-progress__CubeReview', { id: 'zz', verdict: 'APPROVE', summary: 'x' })
  expect(bad.deny).toBeUndefined()
  expect(String(bad.result)).toContain('review not stored')
  expect((await call('Bash', { command: 'ls' })).deny).toContain('TaskInputs')
})

test('CubeReview with a long payload, and a failing handler, still return a result', async ($, on) => {
  const { call, start } = setup($, on)
  await start()
  await call(INPUTS, { inputs: [], asked: false })
  await call('AskUserQuestion', APPROACH)
  await call(PLAN, { task: 'T', cubes: [{ ...DESC, id: 'c1', title: 't', action: 'Do one thing', flow: [{ file: 'a.ts', fn: 'a', does: 'a' }, { file: 'b.ts', fn: 'b', does: 'b' }], doneWhen: 'ok', minutes: 3 }] })
  const long = 'x'.repeat(5000)
  const quiz = Array.from({ length: 5 }, (_, i) => ({ q: `q${i} ${long}`, options: ['a', 'b', 'c', 'd'], answer: 1 }))
  const findings = Array.from({ length: 20 }, (_, i) => ({ severity: 'P2', file: 'a.ts', line: i + 1, summary: long }))
  const ok = await call('mcp__task-progress__CubeReview', { id: 'c1', verdict: 'APPROVE', summary: long, understanding: long, findings, quiz })
  expect(String(ok.result)).toContain('review stored for c1')
})

test('a cube tool handler that throws still answers with a result', async () => {
  expect((await answered(async () => 'fine')).result).toBe('fine')
  const r = await answered(async () => {
    throw new Error('boom')
  })
  expect(r.result).toContain('boom')
  expect(r.result).toContain('Do not repeat the call')
})

const ONE_CUBE = { ...DESC, id: 'c1', title: 't', action: 'Do one thing', flow: [{ file: 'a.ts', fn: 'a', does: 'a' }, { file: 'b.ts', fn: 'b', does: 'b' }], doneWhen: 'ok', minutes: 3 }
const TWO_CUBES = [ONE_CUBE, { ...ONE_CUBE, id: 'c2' }]

function ctxSetup($: any, on: any, fail?: string) {
  const s = setup($, on)
  const calls: string[] = []
  const writes: { path: string; text: string }[] = []
  const toasts: string[] = []
  on('command.run', { command: 'context' }, () => {
    calls.push('context')
    if (fail === 'context') throw new Error('nope')
    return { text: 'CONTEXT MAP' }
  })
  on('command.run', { command: 'clear' }, () => {
    calls.push('clear')
    return { text: '' }
  })
  on('env.get', () => ({ value: 'C:/home' }))
  on('fs.write', (_: any, e: any) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.toast', (_: any, e: any) => {
    toasts.push(String(e.text ?? e.message ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('turn.complete', (_: any, e: any) => ({ text: String(e.answer ?? '') }))
  // Gate off: an executor that finishes its cube makes it done at once.
  const finish = async (id: string, n: number) => {
    await $.agent.spawn({ prompt: `[budget: 3m step: ${n} cubes: ${id}]
work`, description: 'step', subagentType: 'task-progress:executor' })
    await $.turn.complete({ agentId: `a${n}`, reason: 'answer', answer: 'done' } as any)
  }
  const plan = async (cubes: any[]) => {
    await s.start()
    await $.command.run({ command: 'tp-cubes', args: 'off' })
    await s.call(INPUTS, { inputs: [], asked: false })
    await s.call('AskUserQuestion', APPROACH)
    await s.call(PLAN, { task: 'T', cubes })
  }
  return { ...s, calls, writes, toasts, finish, plan }
}

test('last cube done: /context then /clear once, context saved; no repeat', async ($, on) => {
  const { clock, calls, writes, finish, plan } = ctxSetup($, on)
  await plan(TWO_CUBES)
  await finish('c1', 1)
  await clock.advance(5000)
  expect(calls).toEqual([])
  await finish('c2', 2)
  await clock.advance(5000)
  expect(calls).toEqual(['context', 'clear'])
  expect(writes.length).toBe(1)
  expect(writes[0].path).toMatch(/context-.*.txt$/)
  expect(writes[0].path).not.toMatch(/Tdd:/)
  expect(writes[0].text).toBe('CONTEXT MAP')
  await $.turn.complete({ agentId: 'a2', reason: 'answer', answer: 'again' } as any)
  await clock.advance(5000)
  expect(calls).toEqual(['context', 'clear'])
})

test('a failing /context does not throw and shows a toast', async ($, on) => {
  const { clock, calls, toasts, finish, plan } = ctxSetup($, on, 'context')
  await plan([ONE_CUBE])
  await finish('c1', 1)
  await clock.advance(5000)
  expect(calls).toEqual(['context'])
  expect(toasts.join(' ')).toContain('failed')
})

test('TaskPlan cubes: refused without the Approach question, then recorded; steps-only is never gated', async ($, on) => {
  const { call, start } = setup($, on)
  await start()
  await call(INPUTS, { inputs: [], asked: false })
  const no = await call(PLAN, { task: 'T', cubes: [ONE_CUBE] })
  expect(String(no.result)).toContain('plan not recorded: Ask the user how to solve this first')
  expect(String(no.result)).toContain('header is "Approach"')
  // a different header does not count
  await call('AskUserQuestion', { questions: [{ header: 'Scope', question: 'x', options: [] }] })
  expect(String((await call(PLAN, { task: 'T', cubes: [ONE_CUBE] })).result)).toContain('Ask the user how')
  // sub-agent calls do not count
  await call('AskUserQuestion', { ...APPROACH, agentId: 'a9' })
  expect(String((await call(PLAN, { task: 'T', cubes: [ONE_CUBE] })).result)).toContain('Ask the user how')
  // steps-only plan is not gated
  expect(String((await call(PLAN, { task: 'T', steps: [{ title: 's', minutes: 1 }] })).result)).toContain('plan recorded')
  // header match is case-insensitive and trimmed
  await call('AskUserQuestion', { questions: [{ header: '  approach ', question: 'x', options: [] }] })
  expect(String((await call(PLAN, { task: 'T', cubes: [ONE_CUBE] })).result)).toContain('cube plan recorded')
})

test('TaskPlan cubes: missing summary/problem/steps/code are refused by cube id', async ($, on) => {
  const { call, start } = setup($, on)
  await start()
  await call(INPUTS, { inputs: [], asked: false })
  await call('AskUserQuestion', APPROACH)
  const bad = await call(PLAN, { task: 'T', cubes: [ONE_CUBE, { ...ONE_CUBE, id: 'c2', summary: '', problem: [], code: undefined }] })
  const msg = String(bad.result)
  expect(msg).toContain('plan not recorded')
  expect(msg).toContain('cube c2 is missing summary, problem, code')
  expect(msg).not.toContain('cube c1 is missing')
  const nosteps = await call(PLAN, { task: 'T', cubes: [{ ...ONE_CUBE, steps: undefined }] })
  expect(String(nosteps.result)).toContain('cube c1 is missing steps')
})

test('a new user prompt resets the Approach flag', async ($, on) => {
  const { call, start } = setup($, on)
  await start()
  await call('AskUserQuestion', APPROACH)
  expect(String((await call(PLAN, { task: 'T', cubes: [ONE_CUBE] })).result)).toContain('cube plan recorded')
  await $.prompt.submit({ text: 'next task' })
  expect(String((await call(PLAN, { task: 'T', cubes: [ONE_CUBE] })).result)).toContain('Ask the user how')
})

test('gate applies with approval cubes off too, and CubeRevise split needs the fields', async ($, on) => {
  const { call, start } = setup($, on)
  await start()
  await $.command.run({ command: 'tp-cubes', args: 'off' })
  expect(String((await call(PLAN, { task: 'T', cubes: [ONE_CUBE] })).result)).toContain('Ask the user how')
  await call('AskUserQuestion', APPROACH)
  await call(PLAN, { task: 'T', cubes: [ONE_CUBE] })
  const sp = await call('mcp__task-progress__CubeRevise', { id: 'c1', splitInto: [{ ...ONE_CUBE, summary: undefined }, { ...ONE_CUBE, id: 'c1b' }] })
  expect(String(sp.result)).toContain('cube c1 is missing summary')
})
