import { expect, mock, test } from 'claude-code/testing'

import { flushDeferredPrompts } from './dashboard'
import type { Snapshot } from '../types/index'
import {
  PER_TURN_MAX,
  addAgent,
  addTurnUsage,
  attributeTurn,
  attributeTool,
  setContextBreakdown,
  emptySnapshot,
  markOverruns,
  parseTaskNotification,
  runCommand,
  setAgentStatus,
  setMeasure,
  setPlan,
  type CommandDeps,
} from './dashboard-model'

const base = (): Snapshot => emptySnapshot({ id: 's1', cwd: '/w', startedAt: 0 })

function fakeDeps(start: Snapshot) {
  let snap = start
  const calls = { submitted: [] as string[] }
  let ids = 0
  const d: CommandDeps = {
    now: () => 1000,
    newId: () => `t${++ids}`,
    get: () => snap,
    put: s => {
      snap = s
    },
    submit: async text => {
      calls.submitted.push(text)
    },
  }
  return { d, calls, snap: () => snap }
}

test('addAgent marks its step running; done ends the step, over stays over', () => {
  let s = setPlan(base(), 'T', [{ title: 'a', minutes: 1 }, { title: 'b', minutes: 1 }])
  s = addAgent(s, { id: 'a1', description: 'x', type: 'executor', startedAt: 10, step: 1 })
  expect(s.agents[0]!.status).toBe('running')
  expect(s.plan!.steps[0]!.status).toBe('running')
  expect(s.plan!.steps[0]!.agentId).toBe('a1')
  s = setAgentStatus(s, 'a1', 'done', 50)
  expect(s.agents[0]!.status).toBe('done')
  expect(s.agents[0]!.endedAt).toBe(50)
  expect(s.plan!.steps[0]!.status).toBe('done')

  // Step 2 runs past its minute: over. A failed agent leaves it over; a finished one closes it done.
  let o = addAgent(s, { id: 'a2', description: 'y', type: 'executor', startedAt: 60, step: 2 })
  o = markOverruns(o, 60 + 61_000)
  expect(o.plan!.steps[1]!.status).toBe('over')
  expect(setAgentStatus(o, 'a2', 'failed', 99).plan!.steps[1]!.status).toBe('over')
  expect(setAgentStatus(o, 'a2', 'done', 99).plan!.steps[1]!.status).toBe('done')
})

test('a stopped agent stays stopped when its turn ends', () => {
  let s = addAgent(base(), { id: 'a1', description: 'x', type: 't', startedAt: 0 })
  s = setAgentStatus(s, 'a1', 'stopped', 5)
  s = setAgentStatus(s, 'a1', 'done', 6)
  expect(s.agents[0]!.status).toBe('stopped')
})

test('parseTaskNotification reads the real notification format', () => {
  const text = `<task-notification>
  <task-id> bx7k2a9 </task-id>
  <tool-use-id>toolu_01</tool-use-id>
  <output-file>/tmp/x.output</output-file>
  <status>completed</status>
  <summary>Background command "npm test" completed (exit code 0)</summary>
</task-notification>
Read the output file to retrieve the result.`
  expect(parseTaskNotification(text)).toEqual({ id: 'bx7k2a9', status: 'done', exitCode: 0 })
  expect(parseTaskNotification('<task-notification><task-id>b1</task-id><status>failed</status><summary>x</summary></task-notification>')!.status).toBe('failed')
  expect(parseTaskNotification('<task-notification><task-id>b1</task-id><status>killed</status></task-notification>')!.status).toBe('stopped')
  expect(parseTaskNotification('<task-notification><task-id>b1</task-id><status>completed</status><summary>failed with exit code 2</summary></task-notification>')).toEqual({ id: 'b1', status: 'failed', exitCode: 2 })
  expect(parseTaskNotification('no tags here')).toBe(null)
})

test('runCommand: prompt.send, unknown action', async () => {
  const f = fakeDeps(base())
  expect((await runCommand({ action: 'prompt.send', text: 'hello' }, f.d)).ok).toBe(true)
  expect(f.calls.submitted).toEqual(['hello'])
  expect((await runCommand({ action: 'prompt.send', text: '  ' }, f.d)).ok).toBe(false)
  expect(await runCommand({ action: 'nope' }, f.d)).toEqual({ ok: false, message: 'unknown action: nope' })
})

test('runCommand never throws when a dependency fails', async () => {
  const f = fakeDeps(base())
  f.d.submit = async () => {
    throw new Error('denied')
  }
  expect(await runCommand({ action: 'prompt.send', text: 'x' }, f.d)).toEqual({ ok: false, message: 'denied' })
})

test('session.measure fills snapshot.usage', () => {
  const s = setMeasure(
    base(),
    {
      context: { tokens: 50000, window: 200000, percent: 25 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 40, resetsAt: 'a' },
        { kind: 'seven_day', percentUsed: 10, resetsAt: 'b' },
      ],
      cost: { usd: 1.5 },
    },
    5,
  )
  expect(s.usage?.context).toEqual({ tokens: 50000, window: 200000, percent: 25 })
  expect(s.usage?.fiveHour).toEqual({ percent: 40, resetsAt: 'a' })
  expect(s.usage?.weekly).toEqual({ percent: 10, resetsAt: 'b' })
  expect(s.usage?.cost).toEqual({ usd: 1.5 })
})

test('missing or NaN percentUsed gives a null window, never NaN', () => {
  const s = setMeasure(
    base(),
    { context: { window: 10, percent: NaN }, rateLimits: [{ kind: 'five_hour' }, { kind: 'seven_day', percentUsed: NaN }], cost: { usd: NaN } },
    1,
  )
  expect(s.usage?.fiveHour).toBeNull()
  expect(s.usage?.weekly).toBeNull()
  expect(s.usage?.context.percent).toBeNull()
  expect(s.usage?.cost).toBeNull()
  expect(JSON.stringify(s)).not.toContain('NaN')
})

test('empty rateLimits give null windows', () => {
  const s = setMeasure(base(), { context: { window: 1000 }, rateLimits: [] }, 1)
  expect(s.usage?.fiveHour).toBeNull()
  expect(s.usage?.weekly).toBeNull()
  expect(s.usage?.cost).toBeNull()
})

test('turn token totals accumulate and survive a measure', () => {
  let s = addTurnUsage(base(), { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, 1)
  s = addTurnUsage(s, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 2)
  s = setMeasure(s, { context: { window: 10 }, rateLimits: [] }, 3)
  expect(s.usage?.tokens).toEqual({ input: 11, output: 22, cacheRead: 3, cacheWrite: 4 })
  expect(s.usage?.perTurn).toEqual([10, 30])
})

test('perTurn is capped at 40', () => {
  let s = base()
  for (let i = 0; i < 55; i++) s = addTurnUsage(s, { input_tokens: i, output_tokens: 0 }, i)
  expect(s.usage?.perTurn.length).toBe(PER_TURN_MAX)
  expect(s.usage?.perTurn[39]).toBe(54)
})

test('attribution splits main vs executors, cube build vs review, model', () => {
  let s = addAgent(base(), { id: 'a1', description: 'build c3', type: 'x', startedAt: 1, cube: { id: 'c3', kind: 'build' } })
  s = addAgent(s, { id: 'a2', description: 'review c3', type: 'x', startedAt: 1, cube: { id: 'c3', kind: 'review' } })
  const turns: [string | undefined, string, number][] = [[undefined, 'opus', 10], ['a1', 'sonnet', 20], ['a2', 'sonnet', 5], ['a1', 'sonnet', 1]]
  for (const [agentId, model, n] of turns) {
    const usage = { input_tokens: n, output_tokens: 0 }
    s = attributeTurn(addTurnUsage(s, usage, 1), { agentId, model, usage })
  }
  const b = s.usage!.breakdown!
  expect(b.byAgent).toEqual([{ label: 'main', tokens: 10 }, { label: 'build c3', tokens: 21 }, { label: 'review c3', tokens: 5 }])
  expect(b.byCube).toEqual([{ label: 'main', tokens: 10 }, { label: 'c3 build', tokens: 21 }, { label: 'c3 review', tokens: 5 }])
  expect(b.byModel).toEqual([{ label: 'opus', tokens: 10 }, { label: 'sonnet', tokens: 26 }])
  const total = s.usage!.perTurn.reduce((a, x) => a + x, 0)
  expect(b.byAgent.reduce((a, x) => a + x.tokens, 0)).toBe(total)
  expect(attributeTurn(base(), null as any)).toBeTruthy()
})

test('top tools capped at 20 and sorted; context breakdown maps or is skipped', () => {
  let s = base()
  for (let i = 1; i <= 30; i++) s = attributeTool(s, { tool: 'Read', target: 'f' + i, chars: i * 400 })
  const t = s.usage!.topTools!
  expect(t.length).toBe(20)
  expect(t[0]).toEqual({ tool: 'Read', target: 'f30', tokens: 3000 })
  expect(t.map(x => x.tokens)).toEqual([...t.map(x => x.tokens)].sort((a, b) => b - a))
  expect(setContextBreakdown(s, { nothing: 1 })).toBe(s)
  const categories = [
    { name: 'System prompt', tokens: 5, color: 'a', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 90, color: 'b', isDeferred: false, kind: 'used' },
    { name: 'Deferred tools', tokens: 7, color: 'c', isDeferred: true, kind: 'deferred' },
    { name: 'Free space', tokens: 800, color: 'd', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33, color: 'e', isDeferred: false, kind: 'buffer' },
  ]
  const c = setContextBreakdown(s, { context: { totalTokens: 100, maxTokens: 1000, percentage: 10, breakdown: { categories } } })
  expect(c.usage!.breakdown!.context).toEqual([{ label: 'System prompt', tokens: 5 }, { label: 'Messages', tokens: 90 }])
  expect(setContextBreakdown(s, { context: { totalTokens: 1, maxTokens: 2 } })).toBe(s)
})

test('byModel from usage.model, cap 40 incl other, non-main without cube is unattributed', () => {
  let s = base()
  for (let i = 0; i < 50; i++) {
    const usage = { input_tokens: 1, output_tokens: 0, model: 'm' + i }
    s = attributeTurn(s, { model: usage.model, usage })
  }
  const m = s.usage!.breakdown!.byModel
  expect(m.length).toBe(40)
  expect(m[39]).toEqual({ label: 'other', tokens: 11 })
  const u = { input_tokens: 2, output_tokens: 0 }
  s = attributeTurn(s, { agentId: 'abcdef123456', model: 'x', usage: u })
  expect(s.usage!.breakdown!.byCube).toContainEqual({ label: 'unattributed', tokens: 2 })
  expect(s.usage!.breakdown!.byAgent).toContainEqual({ label: 'abcdef12', tokens: 2 })
})

test('flushDeferredPrompts restores the prompts when submit fails, and clears them when it works', async () => {
  const store: Record<string, any> = { deferredPrompts: ['a', 'b'] }
  let fail = true
  const sent: string[] = []
  const $: any = {
    state: { get: async (r: any) => ({ value: store[r.key] }), set: async (r: any, v: any) => { store[r.key] = v } },
    prompt: { submit: async (p: any) => { if (fail) throw new Error('refused'); sent.push(p.text) } },
    ui: { log: () => {} },
  }
  await flushDeferredPrompts($)
  expect(store.deferredPrompts).toEqual(['a', 'b'])
  fail = false
  await flushDeferredPrompts($)
  expect(store.deferredPrompts).toEqual([])
  expect(sent).toEqual(['a\nb'])
})
