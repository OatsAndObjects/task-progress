import { expect, mock, test } from 'claude-code/testing'

import { emptySnapshot } from './dashboard-model'
import { buildCubeRows, hasUnfinished, onCubesPaneClose, renderCubesPane } from './cubes-pane'

const INPUTS = 'mcp__task-progress__TaskInputs'
const PLAN = 'mcp__task-progress__TaskPlan'
const DESC = { summary: 'Does the thing so it works.', problem: ['It is broken'], steps: ['Edit the file'], code: [{ file: 'a.ts › a', change: 'fix it' }] }
const APPROACH = { questions: [{ header: 'Approach', question: 'How?', options: [{ label: 'A (Recommended)' }, { label: 'B' }] }] }
const FLOW = [{ file: 'a.ts', fn: 'a', does: 'a' }, { file: 'b.ts', fn: 'b', does: 'b' }]
const cube = (id: string, status: string, extra: any = {}) => ({ id, title: `title ${id}`, action: 'x', flow: [], after: [], doneWhen: 'ok', minutes: 3, status, version: 1, ...extra })
const board = (cubes: any[]) => ({ task: 'T', gate: true, cubes, lanes: [] }) as any

test('rows: header counts, glyphs and status words', () => {
  const rows = buildCubeRows(
    board([cube('c1', 'done'), cube('c2', 'running'), cube('c3', 'proposed'), cube('c4', 'queued', { after: ['c2'] }), cube('c5', 'rejected'), cube('c6', 'reviewing')]),
  )
  expect(rows[0]).toEqual({ kind: 'header', text: 'Cubes · 1/6 done · 2 running · 1 waiting for approval' })
  const by = (id: string) => rows.find(r => r.id === id)!
  expect([by('c1').glyph, by('c1').word]).toEqual(['✓', 'done'])
  expect([by('c2').glyph, by('c2').word]).toEqual(['◐', 'running'])
  expect([by('c3').glyph, by('c3').word, by('c3').buttons]).toEqual(['○', 'waiting for approval', ['approve', 'reject']])
  expect(by('c4').word).toBe('approved · starts after c2')
  expect(by('c4').after).toEqual(['c2'])
  expect([by('c5').glyph, by('c5').word]).toEqual(['✗', 'rejected'])
  expect(by('c6').word).toBe('in review')
  expect(by('c1').minutes).toBe(3)
})

test('rows: empty state, long titles truncate, unfinished detection', () => {
  expect(buildCubeRows(null)[0].kind).toBe('empty')
  expect(buildCubeRows(board([]))[0].kind).toBe('empty')
  const long = buildCubeRows(board([cube('c1', 'proposed', { title: 'x'.repeat(100) })]))[1]
  expect(long.title!.length).toBeLessThanOrEqual(36)
  expect(hasUnfinished(board([cube('c1', 'done')]))).toBe(false)
  expect(hasUnfinished(board([cube('c1', 'done'), cube('c2', 'queued')]))).toBe(true)
  expect(hasUnfinished(null)).toBe(false)
})

function setup($: any, on: any) {
  mock.clock(on, { now: 5_000_000 })
  const opens: any[] = []
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
  const plan = async () => {
    await $.tool.call({ tool: INPUTS, inputs: [], asked: false })
    await $.tool.call({ tool: 'AskUserQuestion', ...APPROACH })
    return $.tool.call({ tool: PLAN, task: 'T', cubes: [{ ...DESC, id: 'c1', title: 't', action: 'Do one thing', flow: FLOW, doneWhen: 'ok', minutes: 3 }] })
  }
  const start = () => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return { opens, plan, start }
}

test('recording a cube plan opens the pane without taking focus', async ($, on) => {
  const { opens, plan, start } = setup($, on)
  await start()
  const r = await plan()
  expect(String(r.result)).toContain('cube plan recorded')
  const o = opens.filter(x => x.id === 'tp-cubes')
  expect(o.length).toBe(1)
  expect(o[0].title).toBe('Cubes')
  expect(o[0].focus).toBeUndefined()
  expect(o[0].columns).toBe(44)
})

test('a person close is remembered, another origin is not; a new plan reopens', async ($, on) => {
  const store: Record<string, unknown> = {}
  const fake = { state: { set: async (r: any, v: unknown) => void (store[r.key] = v) } }
  const next = async (e: any) => e
  await onCubesPaneClose(fake, { id: 'tp-cubes', origin: { kind: 'plugin' } }, next)
  expect(store.cubesPaneClosed).toBeUndefined()
  await onCubesPaneClose(fake, { id: 'tp-cubes', origin: { kind: 'person' } }, next)
  expect(store.cubesPaneClosed).toBe(true)
  const { opens, plan, start } = setup($, on)
  await start()
  await plan()
  await plan()
  expect(opens.length).toBe(2)
})

test('bare /tp-cubes and /tp-cubes panel open the pane', async ($, on) => {
  const { opens, start } = setup($, on)
  await start()
  const r = await $.command.run({ command: 'tp-cubes' })
  expect(opens.filter(x => x.id === 'tp-cubes').length).toBe(1)
  expect(opens[0].focus).toBeUndefined()
  expect(String(r.text)).toContain('panel')
  await $.command.run({ command: 'tp-cubes', args: 'panel' })
  expect(opens.length).toBe(2)
  const st = await $.command.run({ command: 'tp-cubes', args: 'status' })
  expect(String(st.text)).toContain('Approval cubes')
  expect(opens.length).toBe(2)
})

// A fake $ (same shape as cubes-pane-actions.test.ts) with stub components; the pane's tree is walked for Buttons.
function fakeEnv(cubes: any[]) {
  const store = new Map<string, any>([['snapshot', { ...emptySnapshot({ id: '', cwd: '', startedAt: 1 }, true), cubes: { ...board(cubes), lanes: [cubes.map(c => c.id)] } }]])
  const toasts: string[] = []
  const $: any = {
    session: { id: async () => 's1' },
    state: { get: async (r: any) => ({ value: store.get(r.key) ?? null }), set: async (r: any, v: any) => void store.set(r.key, v) },
    clock: { now: async () => 1, after: () => ({ cancel() {} }), every: () => ({ cancel() {} }) },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    prompt: { submit: async () => {} },
    ui: { resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }), toast: (t: string) => void toasts.push(t), log() {} },
  }
  const buttons = async () => {
    const found: any[] = []
    const walk = (n: any) => {
      if (Array.isArray(n)) return n.forEach(walk)
      if (!n || typeof n !== 'object') return
      if (n.type === 'Button') found.push(n)
      walk(n.children)
    }
    walk(await renderCubesPane($, {}))
    return found
  }
  return { $, toasts, buttons }
}
// onPress fires the action without awaiting it, so let it finish.
const settle = () => new Promise(r => setTimeout(r, 50))
const keys = (b: any[]) => b.map(x => x.props.key)

test('pane: proposed cube gets Approve and Reject, other statuses none', async () => {
  const { buttons } = fakeEnv([cube('c1', 'proposed'), cube('c2', 'running'), cube('c3', 'done'), cube('c4', 'revising'), cube('c5', 'queued'), cube('c6', 'failed'), cube('c7', 'rejected')])
  expect(keys(await buttons())).toEqual(['approve-c1', 'reject-c1', 'approve-all'])
})

test('pane: footer shows the waiting count, absent when none wait', async () => {
  const two = await fakeEnv([cube('c1', 'proposed'), cube('c2', 'proposed')]).buttons()
  expect(two.find(x => x.props.key === 'approve-all').props.label).toBe('Approve all (2)')
  expect((await fakeEnv([cube('c1', 'running')]).buttons()).length).toBe(0)
})

// dashboard.tsx keeps its snapshot in a module cache, so all three presses share one env and one test.
test('pane: pressing Approve, Reject and Approve all runs the real commands', async () => {
  const { toasts, buttons } = fakeEnv([cube('c1', 'proposed'), cube('c2', 'proposed'), cube('c3', 'proposed')])
  const b = await buttons()
  const press = async (key: string) => {
    b.find(x => x.props.key === key).onPress({})
    await settle()
  }
  await press('approve-c1')
  expect(toasts.at(-1)).toBe('Approved c1')
  await press('reject-c2')
  expect(toasts.at(-1)).toBe('Rejected c2')
  await press('approve-all')
  expect(toasts.at(-1)).toBe('c3 sent to Claude')
})
