// Mirrors the main conversation to the web dashboard's Session screen: one POST to
// /api/events per batch (the page receives each event through TP.emit). Everything here
// is fire-and-forget; a failing POST never breaks a turn.
import { parseBudget } from './dashboard-model'
import { onSessionTurnStart, sessionState } from './dash-session'

export const CHUNK_MS = 150
export const HISTORY_MAX = 300
export const OUTPUT_MAX = 4096
export const SUMMARY_MAX = 200
const POST_MAX = 500
export const QUEUE_MAX = 50
export const SEND_TIMEOUT_MS = 5000

export type MirrorEvent = { type: string; [k: string]: unknown }
export type WebTarget = { port: number; token: string }

export function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** One line for a tool call: its subject (file, command, pattern), at most 200 characters. */
export function toolSummary(tool: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {}
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  let s =
    tool === 'Bash' || tool === 'PowerShell'
      ? str('command') || str('description')
      : tool === 'Agent'
        ? str('description')
        : tool === 'Grep' || tool === 'Glob'
          ? str('pattern')
          : str('file_path') || str('notebook_path') || str('path') || str('url') || str('query') || str('description')
  if (!s) s = (Object.values(i).find(v => typeof v === 'string' && v) as string | undefined) ?? ''
  return clip(s.replace(/\s+/g, ' ').trim(), SUMMARY_MAX)
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** The history of $.session.messages() as events: last HISTORY_MAX messages, outputs cut to 4 KB. */
export function seedEvents(messages: any[]): MirrorEvent[] {
  const out: MirrorEvent[] = []
  for (const m of (messages ?? []).slice(-HISTORY_MAX)) {
    if (m.role === 'user') {
      if (m.text) out.push({ type: 'user', text: m.text })
      continue
    }
    if (m.text) out.push({ type: 'assistant', text: m.text })
    for (const u of m.toolUses ?? []) {
      const input = (u.input ?? {}) as Record<string, unknown>
      const ev: MirrorEvent = { type: 'tool.start', id: u.tool_use_id, tool: u.tool, summary: toolSummary(u.tool, input) }
      if (textOf(input).length <= OUTPUT_MAX) ev.input = input
      out.push(ev)
      const res: string = u.text ?? textOf(u.result)
      if (res !== '' || u.result !== undefined) {
        out.push({ type: 'tool.result', id: u.tool_use_id, ok: u.isError !== true, summary: clip(res.replace(/\s+/g, ' ').trim(), 100), output: clip(res, OUTPUT_MAX) })
      }
    }
  }
  return out
}

export type MirrorDeps = {
  /** Sends one batch (at most 500 events) to the web server; may reject. */
  send: (events: MirrorEvent[]) => Promise<unknown> | unknown
  /** True when a web server is running; with none, nothing is queued. */
  isOn: () => boolean
  after: (ms: number, fn: () => void) => { cancel: () => void }
  /** Resolves after ms; a send that outlasts SEND_TIMEOUT_MS is given up on (the request itself cannot be cancelled). */
  timeout?: (ms: number) => Promise<void>
}

export function createMirror(d: MirrorDeps) {
  const pending: MirrorEvent[][] = []
  let draining = false
  let streamed = false // any text streamed this turn
  let buf = ''
  let seg = '' // text streamed since the last break, for the final `assistant` event
  let timer: { cancel: () => void } | undefined
  let n = 0

  /** Posts in order, never throws. */
  const post = (ev: MirrorEvent | MirrorEvent[]) => {
    try {
      if (!d.isOn()) return
      const all = Array.isArray(ev) ? ev : [ev]
      for (let i = 0; i < all.length; i += POST_MAX) {
        const part = all.slice(i, i + POST_MAX)
        pending.push(part)
        while (pending.length > QUEUE_MAX) pending.shift() // a hung server must not grow memory
      }
      void drain()
    } catch {
      // never break a turn
    }
  }
  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (pending.length) {
        const part = pending.shift()!
        try {
          const sent = Promise.resolve(d.send(part))
          sent.catch(() => undefined)
          await (d.timeout ? Promise.race([sent, d.timeout(SEND_TIMEOUT_MS)]) : sent)
        } catch {
          // dropped
        }
      }
    } finally {
      draining = false
    }
  }
  const flush = () => {
    timer?.cancel()
    timer = undefined
    if (buf) {
      post({ type: 'assistant.chunk', text: buf })
      buf = ''
    }
  }
  const chunk = (text: string) => {
    if (!text) return
    buf += text
    seg += text
    streamed = true
    if (!timer) {
      try {
        timer = d.after(CHUNK_MS, () => {
          timer = undefined
          flush()
        })
      } catch {
        flush()
      }
    }
  }
  const brk = () => {
    flush()
    seg = ''
  }
  const toolId = (e: any) => String(e?.tool_use_id ?? `t${++n}`)

  return {
    post,
    chunk,
    flush,
    seed(messages: any[]) {
      // history.reset first: after a server restart the page clears before the history arrives (no duplicates)
      post([{ type: 'history.reset' }, ...seedEvents(messages)])
    },
    turnStart(text: string) {
      brk()
      streamed = false
      post({ type: 'turn.start' })
      if (text) post({ type: 'user', text })
    },
    turnEnd(e: any) {
      // A turn that ends on a tool call has no text after it: do not repeat earlier text from e.answer.
      const text = seg || (!streamed && typeof e?.answer === 'string' ? e.answer : '')
      flush()
      if (text) post({ type: 'assistant', text })
      seg = ''
      streamed = false
      post({ type: 'turn.end', usage: { input: Number(e?.usage?.input_tokens ?? 0), output: Number(e?.usage?.output_tokens ?? 0) } })
    },
    /** Posts tool.start (and the executor card of an Agent call); returns the finisher to call with the outcome. */
    toolStart(e: any): (out: any) => void {
      brk()
      const id = toolId(e)
      const tool = String(e.tool)
      const { tool: _t, tool_use_id: _i, agentId: _a, requestMeta: _m, ...input } = e as Record<string, unknown>
      const summary = toolSummary(tool, input)
      const ev: MirrorEvent = { type: 'tool.start', id, tool, summary }
      if (textOf(input).length <= OUTPUT_MAX) ev.input = input
      post(ev)
      const b = tool === 'Agent' ? parseBudget(e.prompt) : null
      const exec = (status: string): MirrorEvent => ({
        type: 'executor',
        id,
        description: String(e.description ?? summary),
        budgetMin: b?.minutes ?? 0,
        step: b?.step ?? null,
        status,
      })
      if (tool === 'Agent') post(exec('running'))
      return (out: any) => {
        const ok = out?.deny === undefined && out?.isError !== true
        const res = typeof out?.text === 'string' ? out.text : textOf(out?.deny ?? out?.result)
        post({ type: 'tool.result', id, ok, summary: clip(res.replace(/\s+/g, ' ').trim(), 100), output: clip(res, OUTPUT_MAX) })
        if (tool === 'Agent') post(exec(ok ? 'done' : 'failed'))
      }
    },
  }
}

type Io = { after: (ms: number, fn: () => void) => { cancel: () => void }; fetch: (url: string, init: any) => Promise<unknown> }
let io: Io | null = null
let active: ReturnType<typeof createMirror> | null = null

/** The engine's `$` cannot be kept, so the mirror keeps only these two calls made through it. */
function remember($: any): void {
  io = {
    after: (ms, fn) => $.clock.after(ms, fn),
    fetch: (url, init) => $.http.fetch(url, init),
  }
}

/** Called from the plugin's own tool.call hook: posts tool.start, returns the finisher for the outcome. */
export function mirrorToolStart($: any, e: any): (out: any) => void {
  try {
    if (!active || e.agentId) return () => undefined
    remember($)
    const done = active.toolStart(e)
    return out => {
      try {
        done(out)
      } catch {
        // never break a call
      }
    }
  } catch {
    return () => undefined
  }
}

/** Called from the plugin's own turn.complete hook. */
export function mirrorTurnEnd($: any, e: any): void {
  try {
    if (!active || e.agentId) return
    remember($)
    active.turnEnd(e)
  } catch {
    // never break a turn
  }
}

/**
 * Registers the mirror's turn.start and turn.step hooks (tool.call and turn.complete are already
 * hooked by register.tsx, which calls mirrorToolStart / mirrorTurnEnd). `web()` is the running web server, if any.
 */
export function registerMirror(on: any, web: () => WebTarget | null): void {
  const mirror = createMirror({
    isOn: () => web() !== null,
    after: (ms, fn) => {
      if (!io) throw new Error('no engine yet')
      return io.after(ms, fn)
    },
    timeout: ms =>
      new Promise<void>(resolve => {
        if (!io) return resolve()
        io.after(ms, resolve)
      }),
    send: async events => {
      const w = web()
      if (!w) return
      await io?.fetch(`http://127.0.0.1:${w.port}/api/events`, {
        method: 'POST',
        headers: { 'X-TP-Token': w.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(events),
      })
    },
  })
  active = mirror

  on('turn.start', async ($: any, e: any, next: any) => {
    remember($)
    onSessionTurnStart(sessionState, e) // the web Stop button aborts this turn id
    if (!e.agentId) mirror.turnStart(String(e.text ?? ''))
    return next(e)
  })

  // Must not delay the engine: every chunk passes straight through; the mirror only buffers text.
  on('turn.step', async function* ($: any, e: any, next: any) {
    remember($)
    const gen = next(e)
    while (true) {
      const r = await gen.next()
      if (r.done) return r.value
      if (!e.agentId && r.value?.kind === 'text') mirror.chunk(String(r.value.text ?? ''))
      yield r.value
    }
  })
}

/** Called when the web server becomes ready: sends the history once. */
export async function seedHistory($: any): Promise<void> {
  try {
    if (!active) return
    remember($)
    active.seed(await $.session.messages())
  } catch {
    // no history available
  }
}
