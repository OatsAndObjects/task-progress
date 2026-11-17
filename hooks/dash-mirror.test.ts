import { expect, test } from 'claude-code/testing'

import { CHUNK_MS, HISTORY_MAX, OUTPUT_MAX, createMirror, seedEvents, toolSummary, type MirrorEvent } from './dash-mirror'

function rig(opts: { fail?: boolean; on?: boolean } = {}) {
  const sent: MirrorEvent[][] = []
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
  const m = createMirror({
    isOn: () => opts.on !== false,
    send: async evs => {
      if (opts.fail) throw new Error('down')
      sent.push(evs)
    },
    after: (ms, fn) => {
      const t = { ms, fn, cancelled: false }
      timers.push(t)
      return { cancel: () => (t.cancelled = true) }
    },
  })
  const fire = async () => {
    for (const t of timers.splice(0)) if (!t.cancelled) t.fn()
    await new Promise(r => setTimeout(r, 0))
  }
  const types = () => sent.flat().map(e => e.type)
  return { m, sent, timers, fire, types }
}

test('history seed: user, assistant, tool start and result; capped to the last 300 messages', () => {
  const msgs: any[] = [
    { role: 'user', text: 'hi', toolUses: [] },
    { role: 'assistant', text: 'ok', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/x.ts' }, text: 'x'.repeat(10000) }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'x', isError: false }] },
  ]
  const ev = seedEvents(msgs)
  expect(ev.map(e => e.type)).toEqual(['user', 'assistant', 'tool.start', 'tool.result'])
  expect(ev[2]).toMatchObject({ id: 'a', tool: 'Read', summary: '/x.ts' })
  expect((ev[3].output as string).length).toBe(OUTPUT_MAX)
  const many = Array.from({ length: 1000 }, (_, i) => ({ role: 'user', text: `m${i}`, toolUses: [] }))
  const capped = seedEvents(many)
  expect(capped.length).toBe(HISTORY_MAX)
  expect(capped[0].text).toBe('m700')
})

test('chunks inside 150 ms become one assistant.chunk event', async () => {
  const r = rig()
  r.m.chunk('Hel')
  r.m.chunk('lo ')
  r.m.chunk('world')
  expect(r.timers.length).toBe(1)
  expect(r.timers[0].ms).toBe(CHUNK_MS)
  await r.fire()
  expect(r.sent.flat()).toEqual([{ type: 'assistant.chunk', text: 'Hello world' }])
})

test('a turn posts start, user, the final text and end with usage', async () => {
  const r = rig()
  r.m.turnStart('do it')
  r.m.chunk('done')
  r.m.turnEnd({ answer: 'done', usage: { input_tokens: 5, output_tokens: 7 } })
  await r.fire()
  expect(r.types()).toEqual(['turn.start', 'user', 'assistant.chunk', 'assistant', 'turn.end'])
  expect(r.sent.flat().at(-1)).toEqual({ type: 'turn.end', usage: { input: 5, output: 7 } })
})

test('tool start and result; an Agent call also posts executor cards with its budget', async () => {
  const r = rig()
  const done = r.m.toolStart({ tool: 'Agent', tool_use_id: 'u1', description: 'build it', prompt: '[budget: 8m step: 3]\nbody' })
  done({ text: 'finished' })
  await r.fire()
  const ev = r.sent.flat()
  expect(ev.map(e => e.type)).toEqual(['tool.start', 'executor', 'tool.result', 'executor'])
  expect(ev[1]).toEqual({ type: 'executor', id: 'u1', description: 'build it', budgetMin: 8, step: 3, status: 'running' })
  expect(ev[3]).toMatchObject({ status: 'done' })
  expect(toolSummary('Bash', { command: 'a'.repeat(500) }).length).toBe(200)
})

test('a failing POST is swallowed and later posts still go', async () => {
  const r = rig({ fail: true })
  r.m.turnStart('x')
  r.m.chunk('a')
  r.m.turnEnd({})
  await r.fire()
  expect(r.sent.length).toBe(0)
  const off = rig({ on: false })
  off.m.turnStart('x')
  await off.fire()
  expect(off.sent.length).toBe(0)
})
