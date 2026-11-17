import { expect, test } from 'claude-code/testing'

import { newSessionState, onSessionTurnComplete, onSessionTurnStart, runSessionCommand, stopTurn } from './dash-session'

function fake() {
  const calls = { submit: [] as string[], abort: [] as string[], events: [] as Record<string, unknown>[] }
  let fail: string | null = null
  return {
    calls,
    failWith(m: string) {
      fail = m
    },
    submit: async (t: string) => {
      if (fail) throw new Error(fail)
      calls.submit.push(t)
    },
    abort: async (id: string) => {
      calls.abort.push(id)
    },
    postEvent: async (e: Record<string, unknown>) => {
      calls.events.push(e)
    },
  }
}

test('session.prompt submits the text as the user and says started when idle', async () => {
  const s = newSessionState()
  const d = fake()
  const r = await runSessionCommand({ action: 'session.prompt', text: 'do it' }, d, s)
  expect(d.calls.submit).toEqual(['do it'])
  expect(r).toEqual({ ok: true, message: 'sent', data: { state: 'started' } })
  expect(d.calls.events).toEqual([{ type: 'prompt.state', state: 'started', text: 'do it' }])
})

test('session.prompt while a turn runs is queued', async () => {
  const s = newSessionState()
  onSessionTurnStart(s, { turnId: 't1' })
  const d = fake()
  const r = await runSessionCommand({ action: 'session.prompt', text: 'later' }, d, s)
  expect(r?.data).toEqual({ state: 'queued' })
  expect(d.calls.events).toEqual([{ type: 'prompt.state', state: 'queued', text: 'later' }])
})

test('session.prompt rejects empty and over-long text, and reports a denial', async () => {
  const s = newSessionState()
  const d = fake()
  expect((await runSessionCommand({ action: 'session.prompt', text: ' ' }, d, s))?.ok).toBe(false)
  expect((await runSessionCommand({ action: 'session.prompt', text: 'x'.repeat(20001) }, d, s))?.ok).toBe(false)
  expect(d.calls.submit).toEqual([])
  d.failWith('denied')
  expect(await runSessionCommand({ action: 'session.prompt', text: 'hi' }, d, s)).toEqual({ ok: false, message: 'denied' })
})

test('stop aborts only the cached running turn id', async () => {
  const s = newSessionState()
  onSessionTurnStart(s, { turnId: 'sub', agentId: 'a1' }) // a sub-agent turn is not cached
  const d = fake()
  expect((await stopTurn(s, d)).ok).toBe(false)
  onSessionTurnStart(s, { turnId: 't2' })
  const r = await runSessionCommand({ action: 'session.stop' }, d, s)
  expect(d.calls.abort).toEqual(['t2'])
  expect(r?.ok).toBe(true)
})

test('stop with no turn is not ok, and a stale id after complete is not aborted', async () => {
  const s = newSessionState()
  const d = fake()
  const none = await stopTurn(s, d)
  expect(none).toEqual({ ok: false, message: 'Nothing is running' })
  onSessionTurnStart(s, { turnId: 't3' })
  onSessionTurnComplete(s, { turnId: 'other' }) // another turn ending does not clear it
  expect(s.turnId).toBe('t3')
  onSessionTurnComplete(s, { turnId: 't3' })
  expect((await stopTurn(s, d)).ok).toBe(false)
  expect(d.calls.abort).toEqual([])
})

test('non-session actions fall through', async () => {
  expect(await runSessionCommand({ action: 'cube.approve' }, fake(), newSessionState())).toBeNull()
})

test('stop clears the cached turn id when abort says the turn is not running', async () => {
  const s = newSessionState()
  onSessionTurnStart(s, { turnId: 't9' })
  const d = { ...fake(), abort: async () => { throw new Error('turn t9 is not running') } }
  expect((await stopTurn(s, d)).ok).toBe(false)
  expect(s.turnId).toBeNull()
  // an unrelated failure keeps the id so Stop can be retried
  onSessionTurnStart(s, { turnId: 't10' })
  const e = { ...fake(), abort: async () => { throw new Error('network down') } }
  expect((await stopTurn(s, e)).ok).toBe(false)
  expect(s.turnId).toBe('t10')
})

test('session.prompt does not wait for the prompt.state event', async () => {
  const s = newSessionState()
  const d = { ...fake(), postEvent: () => new Promise<void>(() => undefined) }
  const r = await Promise.race([runSessionCommand({ action: 'session.prompt', text: 'go' }, d, s), new Promise(res => setTimeout(() => res('hung'), 200))])
  expect((r as any).ok).toBe(true)
  const t = { ...fake(), postEvent: async () => { throw new Error('x') } }
  expect((await runSessionCommand({ action: 'session.prompt', text: 'go' }, t, s))?.ok).toBe(true)
})
