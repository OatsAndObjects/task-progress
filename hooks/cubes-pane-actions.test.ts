import { expect, test } from 'claude-code/testing'
import { paneActionToCommand, buttonsFor, runPaneAction, toggleDetails } from './cubes-pane-actions'
import { emptySnapshot } from './dashboard-model'

test('paneActionToCommand matches what the web sends', () => {
  expect(paneActionToCommand({ kind: 'approve', id: 'c2' })).toEqual({ action: 'cube.approve', id: 'c2' })
  expect(paneActionToCommand({ kind: 'reject', id: 'c2' })).toEqual({ action: 'cube.reject', id: 'c2' })
  expect(paneActionToCommand({ kind: 'approveAll' })).toEqual({ action: 'cube.approveAll' })
})

test('buttonsFor: only proposed cubes show Approve and Reject', () => {
  expect(buttonsFor({ status: 'proposed' })).toEqual(['approve', 'reject'])
  for (const status of ['approved', 'queued', 'running', 'reviewing', 'done', 'failed', 'skipped', 'rejected', 'revising'] as const) {
    expect(buttonsFor({ status })).toEqual([])
  }
})

function fake(store: Map<string, any>, toasts: string[], prompts: string[], sid = 's1') {
  return {
    session: { id: async () => sid },
    state: {
      get: async (r: any) => ({ value: store.get(r.key) ?? null }),
      set: async (r: any, v: any) => void store.set(r.key, v),
    },
    clock: { now: async () => 1, after: () => ({ cancel() {} }), every: () => ({ cancel() {} }) },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    prompt: { submit: async ({ text }: any) => void prompts.push(text) },
    ui: { toast: (t: string) => void toasts.push(t), log() {} },
  } as any
}

test('runPaneAction toasts on success, then on failure, and never throws', async () => {
  const snap: any = emptySnapshot({ id: '', cwd: '', startedAt: 1 }, true)
  const cube = (id: string, after: string[] = []) => ({ id, title: id, action: 'a', flow: [], after, doneWhen: 'd', minutes: 1, status: 'proposed' })
  snap.cubes = { task: 't', gate: true, cubes: [cube('c1'), cube('c2', ['c1'])], lanes: [['c1'], ['c2']] }
  const store = new Map<string, any>([['snapshot', snap]])
  const toasts: string[] = []
  const prompts: string[] = []
  const $ = fake(store, toasts, prompts)
  await runPaneAction($, { kind: 'approve', id: 'c1' })
  expect(toasts).toEqual(['Approved c1'])
  await runPaneAction($, { kind: 'reject', id: 'c9' })
  expect(toasts.length).toBe(2)
  expect(toasts[1]).toContain('c9')
  // The module cache holds the board: c2 waits for c1, and the toast says so (not a fixed "Approved all").
  await runPaneAction($, { kind: 'approveAll' })
  expect(toasts.length).toBe(3)
  expect(toasts[2]).toContain('after c1')
  expect(toasts[2]).not.toBe('Approved all')
  await runPaneAction({ ui: { toast() { throw new Error('x') } } } as any, { kind: 'approveAll' })
})

test('toggleDetails adds then removes the id', async () => {
  const store = new Map<string, any>()
  const $ = fake(store, [], [])
  await toggleDetails($, 'c1')
  await runPaneAction($, { kind: 'toggleDetails', id: 'c2' })
  expect(store.get('cubesPaneOpen')).toEqual(['c1', 'c2'])
  await toggleDetails($, 'c1')
  expect(store.get('cubesPaneOpen')).toEqual(['c2'])
})
