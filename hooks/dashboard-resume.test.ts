import { expect, test } from 'claude-code/testing'

import { dashGetCubes, onSessionStart } from './dashboard'

const board = (status: string): any => ({
  cubes: [{ id: 'c1', title: 't', status, flow: [] }],
})

/** A hand-rolled $ with a shared state map, so a "restart" is a second onSessionStart on the same store. */
function fake(sessionId: string, store: Map<string, any>) {
  return {
    command: { register: async () => ({}) },
    clock: { now: async () => 1000, every: () => ({ cancel() {} }) },
    session: {
      id: async () => sessionId,
      usage: async () => {
        throw new Error('none')
      },
    },
    store: { get: async () => false },
    state: {
      get: async (ref: any) => ({ value: store.get(ref.key) }),
      set: async (ref: any, v: any) => void store.set(ref.key, v),
    },
  } as any
}

async function seed(id: string, status: string) {
  const store = new Map<string, any>()
  await onSessionStart(fake(id, store), { cwd: '/' })
  store.set('snapshot', { ...store.get('snapshot'), cubes: board(status) })
  return store
}

test('same session restarted keeps unfinished cubes', async () => {
  const store = await seed('s1', 'running')
  const $ = fake('s1', store)
  await onSessionStart($, { cwd: '/', source: 'resume' })
  expect((await dashGetCubes($))?.cubes[0].status).toBe('running')
  expect(store.get('snapshot').cubes.cubes[0].id).toBe('c1')
})

test('same session id keeps cubes even without a source', async () => {
  const store = await seed('s1', 'pending')
  const $ = fake('s1', store)
  await onSessionStart($, { cwd: '/' })
  expect((await dashGetCubes($))?.cubes.length).toBe(1)
})

test('a new session id resets the board', async () => {
  const store = await seed('s1', 'running')
  const $ = fake('s2', store)
  await onSessionStart($, { cwd: '/', source: 'startup' })
  expect(await dashGetCubes($)).toBeNull()
  expect(store.get('snapshot').cubes).toBeNull()
})

test('a /clear resets the board even with the same id', async () => {
  const store = await seed('s1', 'running')
  const $ = fake('s1', store)
  await onSessionStart($, { cwd: '/', source: 'clear' })
  expect(await dashGetCubes($)).toBeNull()
})
