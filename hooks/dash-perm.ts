// Allow or deny a tool call from the web Session screen. Only used when the engine would
// ask the person in the terminal AND a web page is connected; every failure falls back to
// the normal terminal prompt ('ask'). Never auto-allows on error or timeout.
import { toolSummary } from './dash-mirror'
import type { WebTarget } from './dash-mirror'

// Typings (HookBudget.ms = 10_000): a hook's own time is capped at 10 s per dispatch; only `next(e)`
// and `$` calls stop the clock, and a timer-resolved wait is not a `$` call (clock.sleep even counts
// explicitly). So the wait is capped well inside the budget: 7 s, then the terminal prompt takes over.
export const PERM_WAIT_MS = 7000
export const INPUT_CAP = 4096
export const PERM_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/

export type WebDecision = 'allow' | 'allowAlways' | 'deny'
export type PermVerdict = { decision: 'allow' | 'deny' | 'ask'; reason?: string }

export type PermDeps = {
  /** True when at least one web page is watching the live stream. */
  connected: () => Promise<boolean>
  /** Post one event to the web server; may reject. */
  postEvent: (ev: Record<string, unknown>) => Promise<unknown>
  after: (ms: number, fn: () => void) => { cancel: () => void }
  /** Aborts when the hook is abandoned (next.signal); the wait then ends as a timeout. */
  signal?: AbortSignal
  /** Extra card fields: agent, reason, askedBy. */
  extra?: { agent?: string; reason?: string; askedBy?: string }
  /** Id for a new request (tests pass a fixed one). */
  newId?: () => string
}

type Waiter = (d: WebDecision) => void
const waiting = new Map<string, Waiter>()
let counter = 0

/** Number of requests waiting for an answer (tests). */
export const pendingCount = () => waiting.size

/** perm.answer from the page: resolves the waiting request; unknown or expired ids are ignored. */
export function answerPerm(cmd: { id?: unknown; decision?: unknown }): { ok: boolean; message: string } {
  const id = cmd.id
  const dec = cmd.decision
  if (typeof id !== 'string' || !PERM_ID_RE.test(id)) return { ok: false, message: 'bad id' }
  if (dec !== 'allow' && dec !== 'allowAlways' && dec !== 'deny') return { ok: false, message: 'bad decision' }
  const w = waiting.get(id)
  if (!w) return { ok: false, message: 'no such request (already answered or expired)' }
  waiting.delete(id)
  w(dec)
  return { ok: true, message: 'sent' }
}

const clip = (v: string, n: number) => (v.length > n ? v.slice(0, n) + '…' : v)

/** Input as sent to the page: Bash command <= 500 chars, long content fields <= 300, whole JSON <= 4 KB. */
export function capInput(inp: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(inp)) {
    if (typeof v !== 'string') out[k] = v
    else if (k === 'command') out[k] = clip(v, 500)
    else if (k === 'content' || k === 'new_string' || k === 'old_string') out[k] = clip(v, 300)
    else out[k] = clip(v, 500)
  }
  let json = ''
  try {
    json = JSON.stringify(out)
  } catch {
    return {}
  }
  if (json.length <= INPUT_CAP) return out
  const slim: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(out)) slim[k] = typeof v === 'string' ? clip(v, 100) : undefined
  const j2 = JSON.stringify(slim)
  return j2.length <= INPUT_CAP ? slim : { truncated: clip(j2, 2000) }
}

/**
 * Asks the web page. allow / allowAlways -> allow (a hook's verdict has no remembered-rule
 * option, so "always" is just allow); deny -> deny; timeout or any error -> ask.
 */
export async function askWebPermission(tool: string, input: unknown, d: PermDeps): Promise<PermVerdict> {
  let id = ''
  try {
    if (!(await d.connected())) return { decision: 'ask' }
    id = d.newId ? d.newId() : `p${Date.now().toString(36)}${++counter}`
    const inp = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const answered = new Promise<WebDecision | 'timeout'>(resolve => {
      // Expire first, then resolve: an answer arriving after this is rejected as expired.
      const expire = () => {
        waiting.delete(id)
        resolve('timeout')
      }
      waiting.set(id, resolve)
      try {
        d.after(PERM_WAIT_MS, expire)
        if (d.signal) d.signal.aborted ? expire() : d.signal.addEventListener('abort', expire, { once: true })
      } catch {
        expire()
      }
    })
    const ex = d.extra ?? {}
    const posted: any = await d.postEvent({
      type: 'permission', id, tool, summary: toolSummary(tool, inp), input: capInput(inp),
      ...(ex.agent ? { agent: clip(ex.agent, 120) } : {}),
      ...(ex.reason ? { reason: clip(ex.reason, 300) } : {}),
      ...(ex.askedBy ? { askedBy: clip(ex.askedBy, 120) } : {}),
    })
    if (posted && posted.ok === false) {
      // The page never got the card: do not make the terminal wait for an answer that cannot come.
      waiting.delete(id)
      return { decision: 'ask' }
    }
    const r = await answered
    waiting.delete(id)
    try {
      await d.postEvent({ type: 'permission.resolved', id, decision: r === 'timeout' ? 'ask' : r, by: r === 'timeout' ? 'terminal' : 'web' })
    } catch {
      // the card greys out on its own answer anyway
    }
    if (r === 'timeout') return { decision: 'ask' }
    if (r === 'deny') return { decision: 'deny', reason: 'Denied from the web dashboard' }
    return { decision: 'allow', reason: 'Allowed from the web dashboard' }
  } catch {
    if (id) waiting.delete(id)
    return { decision: 'ask' }
  }
}

/** Registers the plugin's only tool.check hook. */
export function registerPerm(on: any, web: () => WebTarget | null): void {
  on('tool.check', async ($: any, e: any, next: any) => {
    const base = await next(e)
    try {
      if (!base || base.decision !== 'ask') return base
      const w = web()
      if (!w) return base
      const url = (p: string) => `http://127.0.0.1:${w.port}${p}`
      const headers = { 'X-TP-Token': w.token, 'Content-Type': 'application/json' }
      const b = base as any
      const v = await askWebPermission(String(e.tool), e.input, {
        connected: async () => {
          const r = await $.http.fetch(url('/api/clients'), { method: 'GET', headers })
          return r.ok && Number(JSON.parse(String(r.text)).pages) > 0
        },
        postEvent: ev => $.http.fetch(url('/api/events'), { method: 'POST', headers, body: JSON.stringify(ev) }),
        after: (ms, fn) => $.clock.after(ms, fn),
        signal: next.signal,
        extra: {
          agent: e.agentId ? String(e.agentId) : undefined,
          reason: typeof b.reason === 'string' ? b.reason : undefined,
          askedBy: typeof b.plugin === 'string' ? b.plugin : undefined,
        },
      })
      return v.decision === 'ask' ? base : v
    } catch {
      return base
    }
  })
}
