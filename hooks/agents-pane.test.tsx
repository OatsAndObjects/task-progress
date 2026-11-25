import { expect, mock, test } from 'claude-code/testing'

import { onAgentsPaneClose } from './agents-pane'

const PANE = {
  plugin: 'task-progress',
  component: 'Pane',
  requestId: 'tp-agents',
  surface: 'terminal',
  props: { bodyColumns: 44 },
} as const

function setup($: any, on: any) {
  const clock = mock.clock(on, { now: 5_000_000 })
  const opens: any[] = []
  const closes: any[] = []
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text, context: e.context }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', (_: any, e: any) => {
    opens.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: any, e: any) => {
    closes.push(e)
    return { value: undefined }
  })
  on('turn.complete', (_: any, e: any) => ({ text: String(e.answer ?? '') }))
  let nextId = 0
  on('agent.spawn', () => ({ model: 'sonnet', agentId: `a${++nextId}` }))
  const dispatch = (step: number) =>
    $.agent.spawn({ prompt: `[budget: 4m step: ${step}]\ndo the step`, description: `task ${step}`, subagentType: 'task-progress:executor' })
  const texts = async () => {
    const ui = await $.ui.mount(PANE)
    const t: string[] = (await ui.findAll({ type: 'Text' })).map((x: any) => x.text)
    await ui.unmount()
    return t
  }
  const start = () => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const finish = (id: string) => $.turn.complete({ agentId: id, reason: 'answer', answer: 'x' } as any)
  return { clock, opens, closes, dispatch, texts, start, finish }
}

const mine = (xs: any[]) => xs.filter(x => x.id === 'tp-agents')

test('the pane draws art plus one row per running agent', async ($, on) => {
  const { dispatch, texts, start } = setup($, on)
  await start()
  await dispatch(1)
  await dispatch(2)
  const t = await texts()
  expect(t.some(x => x.includes('step 1'))).toBe(true)
  expect(t.some(x => x.includes('step 2'))).toBe(true)
  expect(t.some(x => x.includes('No agents running'))).toBe(false)
  expect(t.length).toBeGreaterThan(4) // art lines, then the two agent rows
})

test('runs remember their role: each type shows its own creature name', async ($, on) => {
  const { texts, start } = setup($, on)
  await start()
  await $.agent.spawn({ prompt: '[budget: 4m step: 1]\nx', description: 'a', subagentType: 'task-progress:executor' })
  await $.agent.spawn({ prompt: '[budget: 4m step: 2]\nx', description: 'b', subagentType: 'feature-dev:code-explorer' })
  await $.agent.spawn({ prompt: '[budget: 4m step: 3 review: c1]\nx', description: 'c', subagentType: 'task-progress:executor' })
  const t = (await texts()).join('|')
  expect(t).toContain('Builder')
  expect(t).toContain('Scout')
  expect(t).toContain('Reviewer')
})

test('idle pane says so', async ($, on) => {
  const { texts, start } = setup($, on)
  await start()
  expect(await texts()).toEqual(['No agents running'])
})

test('/tp-agents toggles the pane open and closed', async ($, on) => {
  const { opens, closes, start } = setup($, on)
  await start()
  const a = await $.command.run({ command: 'tp-agents' })
  expect(String(a.text)).toContain('open')
  expect(mine(opens).length).toBe(1)
  expect(mine(opens)[0].title).toBe('Agents')
  expect(mine(opens)[0].focus).toBeUndefined()
  const b = await $.command.run({ command: 'tp-agents' })
  expect(String(b.text)).toContain('closed')
  expect(mine(closes).length).toBe(1)
})

test('first spawn opens the pane; it closes after the 3 s done window, but only when auto-opened', async ($, on) => {
  const { clock, opens, closes, dispatch, start, finish } = setup($, on)
  await start()
  await dispatch(1)
  await dispatch(2)
  expect(mine(opens).length).toBe(1) // 0 -> 1 only, not on the second agent
  await finish('a1')
  await finish('a2')
  await clock.advance(2_500)
  expect(mine(closes).length).toBe(0) // done art still showing
  await clock.advance(1_000)
  expect(mine(closes).length).toBe(1)
})

test('a pane the person opened stays open after the run', async ($, on) => {
  const { clock, closes, dispatch, start, finish, texts } = setup($, on)
  await start()
  await $.command.run({ command: 'tp-agents' })
  await dispatch(1)
  await finish('a1')
  await clock.advance(4_000)
  expect(mine(closes).length).toBe(0)
  expect(await texts()).toEqual(['No agents running'])
})

test('after the person closes it, a new run does not reopen it', async ($, on) => {
  const { clock, opens, dispatch, start, finish } = setup($, on)
  await start()
  await dispatch(1)
  expect(mine(opens).length).toBe(1)
  await $.command.run({ command: 'tp-agents' }) // person toggles it shut mid-run
  await finish('a1')
  await clock.advance(4_000)
  await dispatch(2)
  expect(mine(opens).length).toBe(1)
  await $.command.run({ command: 'tp-agents' }) // asking again clears it
  expect(mine(opens).length).toBe(2)
})

test('a person close event is remembered, another origin is not', async () => {
  const store: Record<string, unknown> = {}
  const fake = { state: { set: async (r: any, v: unknown) => void (store[r.key] = v) } }
  const next = async (e: any) => e
  await onAgentsPaneClose(fake, { id: 'tp-agents', origin: { kind: 'plugin' } }, next)
  expect(store.agentsPaneClosed).toBeUndefined()
  await onAgentsPaneClose(fake, { id: 'tp-agents', origin: { kind: 'person' } }, next)
  expect(store.agentsPaneClosed).toBe(true)
})
