// Jira-style tickets for the web Board screen: pure model + command handler.
// State lives in the snapshot (tickets, columns); the store keeps { list, counter } so keys are never reused.
import type { DashboardCommand, DashboardCommandResult, Snapshot, Ticket, TicketPriority, TicketStatus, TicketType, UserTask } from '../types/index'

export const TICKET_COLUMNS: TicketStatus[] = ['todo', 'doing', 'review', 'blocked', 'done']
export const TICKET_TYPES: TicketType[] = ['feature', 'bug', 'task']
export const TICKET_PRIORITIES: TicketPriority[] = ['low', 'med', 'high']
export const MAX_TICKETS = 500
export const MAX_ACTIVITY = 200
export const MAX_CHECKS = 50

export type TicketStore = { list: Ticket[]; counter: number }

export type TicketDeps = {
  now: () => number
  get: () => Snapshot
  put: (s: Snapshot) => void
  /** Highest ticket number ever issued. */
  counter: () => number
  /** Persist the list and counter. */
  save: (store: TicketStore) => Promise<void>
  /** Submit a prompt as the user. */
  submit: (text: string) => Promise<void>
}

const fail = (message: string): DashboardCommandResult => ({ ok: false, message })
const ok = (message: string, data?: Record<string, unknown>): DashboardCommandResult => ({ ok: true, message, ...(data ? { data } : {}) })
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Builds the store on load: the stored tickets, or (first time only) the old tasks turned into tickets. */
export function loadTickets(stored: unknown, tasks: UserTask[]): { store: TicketStore; migrated: boolean } {
  const s = stored as Partial<TicketStore> | null | undefined
  if (s && Array.isArray(s.list)) {
    const list = s.list as Ticket[]
    const maxN = list.reduce((m, t) => Math.max(m, Number(String(t.key).slice(3)) || 0), 0)
    return { store: { list, counter: Math.max(Number(s.counter) || 0, maxN) }, migrated: false }
  }
  const list: Ticket[] = [...tasks]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, MAX_TICKETS)
    .map((t, i) => ({
      key: `TP-${i + 1}`,
      type: 'task' as const,
      priority: t.priority,
      title: t.title,
      description: t.notes,
      checks: [],
      assignee: '',
      status: t.status,
      activity: [{ who: 'you' as const, text: 'Migrated from tasks', at: t.createdAt }],
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      legacyId: t.id,
    }))
  return { store: { list, counter: list.length }, migrated: tasks.length > 0 }
}

function findKey(list: Ticket[], k: string): Ticket | undefined {
  return list.find(t => t.key === k) ?? list.find(t => t.legacyId === k)
}

/** The prompt Claude receives for an assigned ticket. */
export function ticketPrompt(t: Ticket): string {
  const checks = t.checks.length ? `\n\nAcceptance checks:\n${t.checks.map(c => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')}` : ''
  const desc = t.description ? `\n\n${t.description}` : ''
  return `Ticket ${t.key} (${t.type}, ${t.priority}): ${t.title}${desc}${checks}\n\nWhen done, move it to review.`
}

function log(t: Ticket, who: 'you' | 'claude', text: string, at: number): Ticket {
  const activity = [...t.activity, { who, text: text.slice(0, 4000), at }].slice(-MAX_ACTIVITY)
  return { ...t, activity, updatedAt: at }
}

function checksArg(v: unknown): { text: string; done: boolean }[] | null {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > MAX_CHECKS) return null
  const out: { text: string; done: boolean }[] = []
  for (const x of v) {
    const text = typeof x === 'string' ? x.trim().slice(0, 300) : typeof (x as any)?.text === 'string' ? (x as any).text.trim().slice(0, 300) : ''
    if (text) out.push({ text, done: false })
  }
  return out
}

/** One ticket.* command. Returns null when the action is not a ticket command. Never throws. */
export async function ticketCommand(cmd: DashboardCommand, d: TicketDeps): Promise<DashboardCommandResult | null> {
  if (typeof cmd.action !== 'string' || !cmd.action.startsWith('ticket.')) return null
  try {
    const s = d.get()
    const list = s.tickets ?? []
    let counter = d.counter()
    const now = d.now()
    const commit = async (next: Ticket[]) => {
      d.put({ ...s, tickets: next, columns: TICKET_COLUMNS })
      await d.save({ list: next, counter })
    }
    const sendToClaude = async (t: Ticket): Promise<Ticket> => {
      const logged = log(t, 'you', 'Sent to Claude', d.now())
      await d.submit(ticketPrompt(logged))
      return logged
    }
    if (cmd.action === 'ticket.create') {
      const title = str(cmd.title, 200)
      if (!title) return fail('title is required')
      if (list.length >= MAX_TICKETS) return fail('too many tickets')
      const checks = checksArg(cmd.checks)
      if (!checks) return fail('checks must be a list of up to 50 items')
      counter += 1
      let t: Ticket = {
        key: `TP-${counter}`,
        type: TICKET_TYPES.includes(cmd.type as any) ? (cmd.type as TicketType) : 'task',
        priority: TICKET_PRIORITIES.includes(cmd.priority as any) ? (cmd.priority as TicketPriority) : 'med',
        title,
        description: str(cmd.description, 10000),
        checks,
        assignee: str(cmd.assignee, 60),
        status: 'todo',
        activity: [{ who: 'you', text: 'Created', at: now }],
        createdAt: now,
        updatedAt: now,
      }
      if (t.assignee === 'claude') t = await sendToClaude(t)
      await commit([...list, t])
      return ok(`ticket created: ${t.key}`, { key: t.key })
    }
    const key = str(cmd.key ?? cmd.id, 64)
    const t = findKey(list, key)
    if (!t) return fail(`no ticket ${key}`)
    const replace = (nt: Ticket) => list.map(x => (x.key === t.key ? nt : x))
    switch (cmd.action) {
      case 'ticket.update': {
        let n = { ...t }
        const changes: string[] = []
        if (cmd.title !== undefined) {
          const title = str(cmd.title, 200)
          if (!title) return fail('title cannot be empty')
          n.title = title
          changes.push('title')
        }
        if (cmd.description !== undefined) {
          n.description = str(cmd.description, 10000)
          changes.push('description')
        }
        if (cmd.type !== undefined) {
          if (!TICKET_TYPES.includes(cmd.type as any)) return fail(`type must be one of ${TICKET_TYPES.join(', ')}`)
          n.type = cmd.type as TicketType
          changes.push('type')
        }
        if (cmd.priority !== undefined) {
          if (!TICKET_PRIORITIES.includes(cmd.priority as any)) return fail(`priority must be one of ${TICKET_PRIORITIES.join(', ')}`)
          n.priority = cmd.priority as TicketPriority
          changes.push('priority')
        }
        if (!changes.length) return fail('nothing to update')
        n = log(n, 'you', `Updated ${changes.join(', ')}`, now)
        await commit(replace(n))
        return ok(`ticket ${t.key} updated`)
      }
      case 'ticket.move': {
        if (!TICKET_COLUMNS.includes(cmd.status as any)) return fail(`status must be one of ${TICKET_COLUMNS.join(', ')}`)
        const status = cmd.status as TicketStatus
        if (status === t.status) return ok(`ticket ${t.key} already ${status}`)
        await commit(replace(log({ ...t, status }, 'you', `Moved ${t.status} to ${status}`, now)))
        return ok(`ticket ${t.key} moved to ${status}`)
      }
      case 'ticket.comment': {
        const text = str(cmd.text, 4000)
        if (!text) return fail('text is required')
        await commit(replace(log(t, 'you', text, now)))
        return ok(`comment added to ${t.key}`)
      }
      case 'ticket.check': {
        const i = Number(cmd.index)
        if (!Number.isInteger(i) || i < 0 || i >= t.checks.length) return fail('no such check')
        const done = typeof cmd.done === 'boolean' ? cmd.done : !t.checks[i].done
        if (t.checks[i].done === done) return ok('check unchanged')
        const checks = t.checks.map((c, j) => (j === i ? { ...c, done } : c))
        await commit(replace(log({ ...t, checks }, 'you', `${done ? 'Checked' : 'Unchecked'}: ${t.checks[i].text}`, now)))
        return ok(`check ${i} ${done ? 'done' : 'open'}`)
      }
      case 'ticket.assign': {
        const assignee = str(cmd.assignee, 60)
        if (assignee === t.assignee) return ok(`ticket ${t.key} assignee unchanged`)
        let n = log({ ...t, assignee }, 'you', assignee ? `Assigned to ${assignee}` : 'Unassigned', now)
        if (assignee === 'claude') n = await sendToClaude(n)
        await commit(replace(n))
        return ok(`ticket ${t.key} assigned to ${assignee || 'nobody'}`)
      }
      case 'ticket.delete': {
        await commit(list.filter(x => x.key !== t.key))
        return ok(`ticket ${t.key} deleted`)
      }
      default:
        return fail(`unknown action ${cmd.action}`)
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}
