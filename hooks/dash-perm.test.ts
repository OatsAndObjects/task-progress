import { expect, test } from 'claude-code/testing'

import { answerPerm, askWebPermission, capInput, pendingCount, PERM_WAIT_MS } from './dash-perm'

function fake(connected = true) {
  const events: Record<string, unknown>[] = []
  let fire: (() => void) | undefined
  let boom = false
  return {
    events,
    fireTimeout: () => fire?.(),
    breakIt: () => {
      boom = true
    },
    deps: {
      connected: async () => connected,
      postEvent: async (ev: Record<string, unknown>) => {
        if (boom) throw new Error('down')
        events.push(ev)
      },
      after: (_ms: number, fn: () => void) => {
        fire = fn
        return { cancel: () => undefined }
      },
      newId: () => 'p1',
    },
  }
}
const tick = () => new Promise<void>(r => setTimeout(r, 0))

test('allow from the page allows and posts resolved', async () => {
  const f = fake()
  const p = askWebPermission('Bash', { command: 'ls' }, f.deps)
  await tick()
  expect(f.events[0]).toMatchObject({ type: 'permission', id: 'p1', tool: 'Bash', input: { command: 'ls' } })
  expect(answerPerm({ id: 'p1', decision: 'allow' }).ok).toBe(true)
  expect((await p).decision).toBe('allow')
  expect(f.events[1]).toEqual({ type: 'permission.resolved', id: 'p1', decision: 'allow', by: 'web' })
})

test('allowAlways is an allow', async () => {
  const f = fake()
  const p = askWebPermission('Bash', { command: 'ls' }, f.deps)
  await tick()
  answerPerm({ id: 'p1', decision: 'allowAlways' })
  expect((await p).decision).toBe('allow')
})

test('deny from the page denies', async () => {
  const f = fake()
  const p = askWebPermission('Bash', { command: 'rm x' }, f.deps)
  await tick()
  answerPerm({ id: 'p1', decision: 'deny' })
  expect((await p).decision).toBe('deny')
})

test('timeout asks in the terminal', async () => {
  const f = fake()
  const p = askWebPermission('Bash', { command: 'ls' }, f.deps)
  await tick()
  f.fireTimeout()
  expect((await p).decision).toBe('ask')
  expect(f.events[1]).toMatchObject({ type: 'permission.resolved', by: 'terminal' })
  expect(pendingCount()).toBe(0)
})

test('no page connected asks and posts nothing', async () => {
  const f = fake(false)
  expect((await askWebPermission('Bash', { command: 'ls' }, f.deps)).decision).toBe('ask')
  expect(f.events).toEqual([])
})

test('an error asks, never allows', async () => {
  const f = fake()
  f.breakIt()
  expect((await askWebPermission('Bash', { command: 'ls' }, f.deps)).decision).toBe('ask')
  expect(pendingCount()).toBe(0)
})

test('stale or bad answers are ignored', () => {
  expect(answerPerm({ id: 'nope', decision: 'allow' }).ok).toBe(false)
  expect(answerPerm({ id: 'bad id!', decision: 'allow' }).ok).toBe(false)
  expect(answerPerm({ id: 'p1', decision: 'maybe' }).ok).toBe(false)
})

test('wait stays inside the 10 s hook budget', () => {
  expect(PERM_WAIT_MS).toBeLessThanOrEqual(8000)
})

test('timeout posts resolved/terminal and a late answer is rejected', async () => {
  const f = fake()
  const p = askWebPermission('Bash', { command: 'ls' }, f.deps)
  await tick()
  f.fireTimeout()
  expect((await p).decision).toBe('ask')
  expect(f.events[1]).toEqual({ type: 'permission.resolved', id: 'p1', decision: 'ask', by: 'terminal' })
  expect(answerPerm({ id: 'p1', decision: 'allow' }).ok).toBe(false)
})

test('abort signal ends the wait as terminal', async () => {
  const f = fake()
  const ac = new AbortController()
  const p = askWebPermission('Bash', { command: 'ls' }, { ...f.deps, signal: ac.signal })
  await tick()
  ac.abort()
  expect((await p).decision).toBe('ask')
  expect(f.events[1]).toMatchObject({ type: 'permission.resolved', by: 'terminal' })
  expect(answerPerm({ id: 'p1', decision: 'deny' }).ok).toBe(false)
})

test('agent, reason and askedBy ride on the event', async () => {
  const f = fake()
  const p = askWebPermission('Bash', { command: 'ls' }, { ...f.deps, extra: { agent: 'a1', reason: 'rule X', askedBy: 'guard' } })
  await tick()
  expect(f.events[0]).toMatchObject({ agent: 'a1', reason: 'rule X', askedBy: 'guard' })
  answerPerm({ id: 'p1', decision: 'allow' })
  await p
})

test('input is truncated', () => {
  const c = capInput({ command: 'x'.repeat(900), content: 'y'.repeat(900) }) as any
  expect(c.command.length).toBeLessThanOrEqual(501)
  expect(c.content.length).toBeLessThanOrEqual(301)
  const big: Record<string, unknown> = {}
  for (let i = 0; i < 40; i++) big['k' + i] = 'z'.repeat(400)
  expect(JSON.stringify(capInput(big)).length).toBeLessThanOrEqual(4096)
})
