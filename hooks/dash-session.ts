// The web Session screen's two commands: session.prompt and session.stop.
// Pure of the engine: every effect comes in through SessionDeps, so tests can fake it.

import type { DashboardCommandResult } from '../types/index'

export const PROMPT_MAX = 20000

export type SessionDeps = {
  /** $.prompt.submit({ text, asUser: true }); throws on a denial. */
  submit: (text: string) => Promise<void>
  /** $.session.turn.abort({ turnId }). */
  abort: (turnId: string) => Promise<void>
  /** Post one event to the web server (best effort). */
  postEvent: (ev: Record<string, unknown>) => Promise<void>
}

/** The main loop's running turn id, cached at turn.start and cleared at its turn.complete. */
export type SessionState = { turnId: string | null }

const STALE_TURN_RE = /not running|no such turn|no running turn|mismatch|unknown turn|not found|no active turn|already (ended|finished|complete)/i

export const newSessionState = (): SessionState => ({ turnId: null })

/** turn.start: only the main loop (no agentId) counts. */
export function onSessionTurnStart(s: SessionState, e: { turnId?: unknown; agentId?: unknown }): void {
  if (e.agentId === undefined && typeof e.turnId === 'string') s.turnId = e.turnId
}

/** turn.complete: clears the cache only when it is the cached turn that ended. */
export function onSessionTurnComplete(s: SessionState, e: { turnId?: unknown; agentId?: unknown }): void {
  if (e.agentId === undefined && (e.turnId === undefined || e.turnId === s.turnId)) s.turnId = null
}

export async function sessionPrompt(s: SessionState, d: SessionDeps, text: unknown): Promise<DashboardCommandResult> {
  if (typeof text !== 'string' || !text.trim() || text.length > PROMPT_MAX) {
    return { ok: false, message: `text required (max ${PROMPT_MAX} chars)` }
  }
  const state = s.turnId ? 'queued' : 'started'
  try {
    await d.submit(text)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  try {
    // fire-and-forget: the event is a nicety and must not delay the reply
    void Promise.resolve(d.postEvent({ type: 'prompt.state', state, text })).catch(() => undefined)
  } catch {
    // never throws into the command
  }
  return { ok: true, message: state === 'queued' ? 'queued behind the running turn' : 'sent', data: { state } }
}

export async function stopTurn(s: SessionState, d: SessionDeps): Promise<DashboardCommandResult> {
  const id = s.turnId
  if (!id) return { ok: false, message: 'Nothing is running' }
  try {
    await d.abort(id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // The turn is already over (or the id is stale): forget it so the next Stop says "Nothing is running".
    if (STALE_TURN_RE.test(message) && s.turnId === id) s.turnId = null
    return { ok: false, message }
  }
  if (s.turnId === id) s.turnId = null
  return { ok: true, message: 'stopped' }
}

/** The one session cache the mod shares (turn hooks and commands run in one module). */
export const sessionState: SessionState = newSessionState()

/** Routes session.* commands; null when the action is not one of them. */
export async function runSessionCommand(
  cmd: { action?: unknown; text?: unknown },
  d: SessionDeps,
  s: SessionState = sessionState,
): Promise<DashboardCommandResult | null> {
  if (cmd.action === 'session.prompt') return sessionPrompt(s, d, cmd.text)
  if (cmd.action === 'session.stop') return stopTurn(s, d)
  return null
}
