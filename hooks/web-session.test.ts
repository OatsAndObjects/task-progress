import { expect, test } from 'claude-code/testing'
import { startWeb, resetRestarts, kickHeartbeat, autoStartWeb } from './dashboard'

// A hand-rolled $ : a child that prints one ready line and then exits when told to.
function fake(sessionId: string, store: Map<string, any>, argvs: string[][], port: number, extra = '') {
  const exits: Array<() => void> = []
  const $: any = {
    plugin: { root: '/p' },
    session: { id: async () => sessionId },
    state: {
      get: async (r: any) => ({ value: store.get(r.key) ?? null }),
      set: async (r: any, v: any) => void store.set(r.key, v),
    },
    clock: { after: () => ({ cancel() {} }), every: () => ({ cancel() {} }), now: async () => 1 },
    ui: { log() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    process: {
      spawn: ({ argv }: any) => {
        argvs.push(argv)
        return (async function* () {
          yield { stream: 'stdout', text: JSON.stringify({ type: 'ready', port }) + '\n' }
          if (extra) yield { stream: 'stdout', text: extra }
          await new Promise<void>(r => exits.push(r))
        })()
      },
    },
  }
  return { $, exit: () => exits.splice(0).forEach(f => f()) }
}

test('same session: restart reuses the token and asks for the bound port; new session gets a new token', async () => {
  resetRestarts()
  const store = new Map<string, any>()
  const argvs: string[][] = []
  const a = fake('s1', store, argvs, 7380)
  const w1 = await startWeb(a.$)
  expect(w1?.port).toBe(7380)
  a.exit()
  await new Promise(r => setTimeout(r, 20))
  const b = fake('s1', store, argvs, 7380)
  await startWeb(b.$)
  const arg = (v: string[], k: string) => v[v.indexOf(k) + 1]
  expect(arg(argvs[0], '--port')).toBe('7377')
  expect(arg(argvs[1], '--port')).toBe('7380')
  expect(arg(argvs[1], '--token')).toBe(arg(argvs[0], '--token'))
  b.exit()
  await new Promise(r => setTimeout(r, 20))
  const d = fake('s2', store, argvs, 7377)
  await startWeb(d.$)
  expect(arg(argvs[2], '--token')).not.toBe(arg(argvs[0], '--token'))
  expect(arg(argvs[2], '--port')).toBe('7377')
  d.exit()
})

test('session start: no stored autoOpen -> no spawn; autoOpen false -> no spawn; true -> spawns', async () => {
  resetRestarts()
  const withStore = (v: any) => {
    const argvs: string[][] = []
    const f = fake('auto1', new Map(), argvs, 7390)
    f.$.store = { get: async () => v, set: async () => {} }
    return { f, argvs }
  }
  for (const v of [undefined, null, false]) {
    const { f, argvs } = withStore(v)
    await autoStartWeb(f.$)
    await new Promise(r => setTimeout(r, 20))
    expect(argvs.length).toBe(0)
  }
  const on = withStore(true)
  await autoStartWeb(on.f.$)
  await new Promise(r => setTimeout(r, 20))
  expect(on.argvs.length).toBe(1)
  on.f.exit()
})

// Restart: the clock keeps its `after` callbacks so a test fires them by hand.
function fakeClocked(store: Map<string, any>, argvs: string[][], afters: Array<{ ms: number; fn: () => any }>, toasts: string[], nowRef: { t: number }) {
  const f = fake('s1', store, argvs, 7381)
  f.$.clock.after = (ms: number, fn: () => any) => {
    afters.push({ ms, fn })
    return { cancel() {} }
  }
  f.$.clock.now = async () => nowRef.t
  f.$.ui.toast = (m: string) => void toasts.push(m)
  return f
}
const tick = () => new Promise(r => setTimeout(r, 20))
// the timers that are restarts (not the 15 s ready timeout)
const restarts = (a: Array<{ ms: number; fn: () => any }>) => a.filter(x => x.ms <= 16000 && x.ms !== 15000)

test('child exits: after the backoff a new spawn happens with the same token', async () => {
  resetRestarts()
  const store = new Map<string, any>()
  const argvs: string[][] = []
  const afters: Array<{ ms: number; fn: () => any }> = []
  const f = fakeClocked(store, argvs, afters, [], { t: 1 })
  await startWeb(f.$)
  f.exit()
  await tick()
  const r = afters.filter(x => x.ms === 1000)
  expect(r.length).toBe(1)
  expect(argvs.length).toBe(1)
  await r[0].fn()
  expect(argvs.length).toBe(2)
  expect(argvs[1][argvs[1].indexOf('--token') + 1]).toBe(argvs[0][argvs[0].indexOf('--token') + 1])
  f.exit()
  await tick()
})

test('web stop: no new spawn', async () => {
  resetRestarts()
  const store = new Map<string, any>()
  const argvs: string[][] = []
  const afters: Array<{ ms: number; fn: () => any }> = []
  const f = fakeClocked(store, argvs, afters, [], { t: 1 })
  await startWeb(f.$)
  store.set('webStopped', 's1')
  f.exit()
  await tick()
  expect(afters.filter(x => x.ms === 1000).length).toBe(0)
  expect(argvs.length).toBe(1)
})

test('6 exits inside 60 s: the 6th does not respawn and the toast fires', async () => {
  resetRestarts()
  const store = new Map<string, any>()
  const argvs: string[][] = []
  const afters: Array<{ ms: number; fn: () => any }> = []
  const toasts: string[] = []
  const f = fakeClocked(store, argvs, afters, toasts, { t: 10_000_000 })
  await startWeb(f.$)
  for (let i = 0; i < 5; i++) {
    f.exit()
    await tick()
    const pending = afters.filter(x => x.ms <= 16000 && x.ms >= 1000)
    await pending[pending.length - 1].fn()
    await tick()
  }
  expect(argvs.length).toBe(6)
  f.exit()
  await tick()
  expect(argvs.length).toBe(6)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('/tp-dashboard web')
})

test('exit line from the child is saved as webLastExit', async () => {
  resetRestarts()
  const store = new Map<string, any>()
  const f = fake('s1', store, [], 7382, JSON.stringify({ type: 'exit', reason: 'idle', at: 1234 }) + '\n')
  await startWeb(f.$)
  await tick()
  expect(store.get('webLastExit')).toEqual({ reason: 'idle', at: 1234 })
  f.exit()
  await tick()
})

// Heartbeat: a chain of `after` timers; fetch calls are counted as posts.
function hbSetup(nowRef: { t: number }) {
  const store = new Map<string, any>()
  const afters: Array<{ ms: number; fn: () => any; cancelled: boolean }> = []
  const f = fake('s1', store, [], 7383)
  f.$.clock.after = (ms: number, fn: () => any) => {
    const rec = { ms, fn, cancelled: false }
    afters.push(rec)
    return { cancel() { rec.cancelled = true } }
  }
  f.$.clock.now = async () => nowRef.t
  let posts = 0
  f.$.http = { fetch: async () => (posts++, { status: 200 }) }
  const beats = () => afters.filter(x => x.ms === 10000 && !x.cancelled)
  return { f, store, afters, beats, posts: () => posts }
}

test('heartbeat: a tick posts and re-arms', async () => {
  resetRestarts()
  const nowRef = { t: 1000 }
  const h = hbSetup(nowRef)
  await startWeb(h.f.$)
  await tick()
  expect(h.beats().length).toBe(1)
  const before = h.posts()
  nowRef.t += 10000
  await h.beats()[0].fn()
  await tick()
  expect(h.posts()).toBe(before + 1)
  expect(h.beats().length).toBe(2)
  h.f.exit()
  await tick()
})

test('heartbeat: a dropped after is noticed by kickHeartbeat, which posts, re-arms and counts a miss', async () => {
  resetRestarts()
  const nowRef = { t: 1000 }
  const h = hbSetup(nowRef)
  await startWeb(h.f.$)
  await tick()
  await kickHeartbeat(h.f.$) // fresh: nothing happens
  expect(h.beats().length).toBe(1)
  const before = h.posts()
  nowRef.t += 60000 // the after never fired
  await kickHeartbeat(h.f.$)
  await tick()
  expect(h.posts()).toBe(before + 1)
  expect(h.beats().length).toBe(1) // old one cancelled, one new
  expect(h.afters.filter(x => x.ms === 10000).length).toBe(2)
  expect(h.store.get('webHeartbeat').missedTicks).toBe(1)
  expect(h.store.get('webHeartbeat').lastMissAt).toBe(nowRef.t)
  h.f.exit()
  await tick()
})

test('heartbeat: stopping web cancels the chain', async () => {
  resetRestarts()
  const nowRef = { t: 1000 }
  const h = hbSetup(nowRef)
  await startWeb(h.f.$)
  await tick()
  expect(h.beats().length).toBe(1)
  h.f.exit() // child ends: chain cancelled
  await tick()
  expect(h.beats().length).toBe(0)
})
