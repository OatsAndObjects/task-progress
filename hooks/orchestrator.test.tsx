import { expect, mock, test } from 'claude-code/testing'

import { GATED_TOOLS, budgetDecision, formatCountdown, parseBudget, parseModeArg } from './register'

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

test('executor time budget: allow, wrap-up notice once at 80%, deny at 100%', async ($, on) => {
  const { clock, call, dispatch, start } = setup($, on)
  await start()
  await dispatch(10, 2)
  expect((await call('Bash', { command: 'ls', agentId: 'a1' })).deny).toBeUndefined()
  await clock.advance(7 * MIN)
  const early = await call('Bash', { command: 'ls', agentId: 'a1' })
  expect(early.deny).toBeUndefined()
  expect(early.context).toBeUndefined()
  await clock.advance(1.5 * MIN) // 8.5 of 10 minutes
  const warn = await call('Bash', { command: 'ls', agentId: 'a1' })
  expect(warn.deny).toBeUndefined()
  expect(String(warn.context?.[0])).toContain('wrap up')
  expect(String(warn.context?.[0])).toContain('2 min left')
  const again = await call('Bash', { command: 'ls', agentId: 'a1' })
  expect(again.context).toBeUndefined() // not repeated
  await clock.advance(1.5 * MIN) // over
  const over = await call('Bash', { command: 'ls', agentId: 'a1' })
  expect(over.deny).toBe('Time budget of 10 min exceeded: stop now and return your report to the orchestrator.')
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
  expect(out.sections[1].text.length).toBeLessThan(1100)
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
  const plan = await call(PLAN, {
    task: 'T',
    cubes: [{ id: 'c1', title: 't', action: 'Do one thing', flow: ['a', 'b'], doneWhen: 'ok', minutes: 3 }],
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
