import { expect, test } from 'claude-code/testing'

import { emptySnapshot } from './dashboard-model'
import { loadTickets, snapshotTickets, ticketCommand, ticketPrompt } from './dash-tickets'

function fake(initial: any[] = [], counter = 0) {
  let snap: any = { ...emptySnapshot({ id: 's', cwd: '/w', startedAt: 0 }), tickets: initial }
  let n = counter
  const submitted: string[] = []
  const saved: any[] = []
  let t = 1000
  const d: any = {
    now: () => ++t,
    get: () => snap,
    put: (s: any) => {
      snap = s
    },
    counter: () => n,
    stored: async () => (saved.length ? saved[saved.length - 1] : null),
    save: async (st: any) => {
      n = st.counter
      saved.push(st)
    },
    submit: async (text: string) => {
      submitted.push(text)
    },
  }
  return { d, submitted, saved, snap: () => snap }
}
const run = (f: ReturnType<typeof fake>, cmd: any) => ticketCommand(cmd, f.d)

test('create gives TP-1 then TP-2 and persists the counter', async () => {
  const f = fake()
  const a: any = await run(f, { action: 'ticket.create', type: 'bug', priority: 'high', title: ' One ', description: 'd', checks: ['a', 'b'] })
  expect(a.ok).toBe(true)
  expect(a.data.key).toBe('TP-1')
  const b: any = await run(f, { action: 'ticket.create', type: 'feature', priority: 'low', title: 'Two' })
  expect(b.data.key).toBe('TP-2')
  expect(f.snap().tickets[0].title).toBe('One')
  expect(f.snap().tickets[0].checks).toEqual([{ text: 'a', done: false }, { text: 'b', done: false }])
  expect(f.saved[1].counter).toBe(2)
  expect((await run(f, { action: 'ticket.create', title: '' }))!.ok).toBe(false)
  // delete then create never reuses a key
  await run(f, { action: 'ticket.delete', key: 'TP-2' })
  expect(((await run(f, { action: 'ticket.create', title: 'Three' })) as any).data.key).toBe('TP-3')
})

test('move validates status and logs activity', async () => {
  const f = fake()
  await run(f, { action: 'ticket.create', title: 'x' })
  expect((await run(f, { action: 'ticket.move', key: 'TP-1', status: 'weird' }))!.ok).toBe(false)
  expect((await run(f, { action: 'ticket.move', key: 'TP-1', status: 'review' }))!.ok).toBe(true)
  expect(f.snap().tickets[0].status).toBe('review')
  expect(f.snap().tickets[0].activity.at(-1).text).toContain('review')
  expect((await run(f, { action: 'ticket.move', key: 'TP-9', status: 'done' }))!.ok).toBe(false)
})

test('comment and check toggle', async () => {
  const f = fake()
  await run(f, { action: 'ticket.create', title: 'x', checks: ['one'] })
  expect((await run(f, { action: 'ticket.comment', key: 'TP-1', text: '  hi ' }))!.ok).toBe(true)
  expect(f.snap().tickets[0].activity.at(-1)).toMatchObject({ who: 'you', text: 'hi' })
  expect((await run(f, { action: 'ticket.comment', key: 'TP-1', text: '' }))!.ok).toBe(false)
  await run(f, { action: 'ticket.check', key: 'TP-1', index: 0, done: true })
  expect(f.snap().tickets[0].checks[0].done).toBe(true)
  await run(f, { action: 'ticket.check', key: 'TP-1', index: 0, done: false })
  expect(f.snap().tickets[0].checks[0].done).toBe(false)
  expect((await run(f, { action: 'ticket.check', key: 'TP-1', index: 5, done: true }))!.ok).toBe(false)
})

test('assign to claude submits exactly once', async () => {
  const f = fake()
  await run(f, { action: 'ticket.create', type: 'bug', priority: 'high', title: 'Crash', description: 'It crashes', checks: ['no crash'] })
  expect(f.submitted.length).toBe(0)
  await run(f, { action: 'ticket.assign', key: 'TP-1', assignee: 'claude' })
  expect(f.submitted.length).toBe(1)
  expect(f.submitted[0]).toBe('Ticket TP-1 (bug, high): Crash\n\nIt crashes\n\nAcceptance checks:\n- [ ] no crash\n\nWhen done, move it to review.')
  expect(f.snap().tickets[0].activity.some((a: any) => a.text === 'Sent to Claude')).toBe(true)
  await run(f, { action: 'ticket.assign', key: 'TP-1', assignee: 'claude' })
  await run(f, { action: 'ticket.update', key: 'TP-1', title: 'Crash 2' })
  await run(f, { action: 'ticket.comment', key: 'TP-1', text: 'c' })
  expect(f.submitted.length).toBe(1)
  // creating with assignee claude also submits once
  await run(f, { action: 'ticket.create', title: 'Direct', assignee: 'claude' })
  expect(f.submitted.length).toBe(2)
  expect(ticketPrompt(f.snap().tickets[1])).toContain('Ticket TP-2 (task, med): Direct')
})

test('update validates; bounded activity', async () => {
  const f = fake()
  await run(f, { action: 'ticket.create', title: 'x' })
  expect((await run(f, { action: 'ticket.update', key: 'TP-1' }))!.ok).toBe(false)
  expect((await run(f, { action: 'ticket.update', key: 'TP-1', priority: 'urgent' }))!.ok).toBe(false)
  expect((await run(f, { action: 'ticket.update', key: 'TP-1', type: 'bug', priority: 'low' }))!.ok).toBe(true)
  for (let i = 0; i < 250; i++) await run(f, { action: 'ticket.comment', key: 'TP-1', text: 'c' + i })
  expect(f.saved.at(-1).list[0].activity.length).toBe(200)
  expect(f.snap().tickets[0].activity.length).toBe(20)
  expect(await run(f, { action: 'task.add' })).toBe(null)
})

test('old tasks migrate once and a task id finds its ticket', async () => {
  const tasks: any[] = [
    { id: 'tb', title: 'B', notes: 'nb', status: 'doing', priority: 'high', createdAt: 2, updatedAt: 3, source: 'user' },
    { id: 'ta', title: 'A', notes: 'na', status: 'todo', priority: 'low', createdAt: 1, updatedAt: 1, source: 'user' },
  ]
  const first = loadTickets(undefined, tasks)
  expect(first.migrated).toBe(true)
  expect(first.store.list.map(t => [t.key, t.title, t.type, t.description, t.status, t.priority])).toEqual([
    ['TP-1', 'A', 'task', 'na', 'todo', 'low'],
    ['TP-2', 'B', 'task', 'nb', 'doing', 'high'],
  ])
  expect(first.store.counter).toBe(2)
  // second load with the stored tickets does not migrate again, even though tasks still exist
  const second = loadTickets(first.store, tasks)
  expect(second.migrated).toBe(false)
  expect(second.store.list.length).toBe(2)
  const f = fake(first.store.list, 2)
  expect((await run(f, { action: 'ticket.move', key: 'tb', status: 'done' }))!.ok).toBe(true)
  expect(f.snap().tickets[1].status).toBe('done')
})

test('after a reload the counter is rebuilt from the list and never reused', async () => {
  const mk = (n: number): any => ({ key: `TP-${n}`, type: 'task', priority: 'med', title: 't', description: '', checks: [], assignee: '', status: 'todo', activity: [], createdAt: 1, updatedAt: 1 })
  const f = fake([mk(1), mk(2), mk(3)], 0)
  expect(((await run(f, { action: 'ticket.create', title: 'a' })) as any).data.key).toBe('TP-4')
  await run(f, { action: 'ticket.delete', key: 'TP-4' })
  expect(((await run(f, { action: 'ticket.create', title: 'b' })) as any).data.key).toBe('TP-5')
})

test('concurrent creates are serialized', async () => {
  const f = fake()
  const [a, b]: any[] = await Promise.all([run(f, { action: 'ticket.create', title: 'a' }), run(f, { action: 'ticket.create', title: 'b' })])
  expect([a.data.key, b.data.key]).toEqual(['TP-1', 'TP-2'])
  expect(f.snap().tickets.length).toBe(2)
})

test('snapshot tickets stay under 1 MB', () => {
  const list: any[] = Array.from({ length: 500 }, (_, i) => ({
    key: `TP-${i + 1}`, type: 'task', priority: 'med', title: 't', description: 'd'.repeat(10000), checks: [], assignee: '',
    status: i % 2 ? 'done' : 'todo', createdAt: 1, updatedAt: 1,
    activity: Array.from({ length: 200 }, () => ({ who: 'you', text: 'x'.repeat(4000), at: 1 })),
  }))
  expect(JSON.stringify(snapshotTickets(list)).length).toBeLessThan(1_000_000)
})
