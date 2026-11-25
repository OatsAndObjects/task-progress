// Agents section of the Cubes pane. Pure: no `$`, no clock (the caller passes `now`).
import type { SnapshotAgent } from '../types/index'

export type AgentRow = {
  id: string
  /** Agent type as stored, e.g. `task-progress:executor` (picks the mascot). */
  type: string
  glyph: '◐' | '✓' | '✗'
  /** Short type, e.g. `executor` (a `plugin:` prefix is dropped). */
  name: string
  /** Cube ids or `step k`, when known. */
  tag?: string
  /** `m:ss left` or `+m:ss over`; running agents with a budget only. */
  time?: string
  over?: boolean
  /** Second line, dimmed: its last tool call, else its description. */
  detail?: string
  state: 'running' | 'done' | 'failed'
  /** Raw last tool summary (picks the mascot scene), and the run's start / end times. */
  tool?: string
  startedAt?: number
  endedAt?: number
}

const DETAIL_MAX = 40
const FINISHED_MAX = 3

const clock = (ms: number) => {
  const s = Math.floor(Math.abs(ms) / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
export const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function buildAgentRows(agents: SnapshotAgent[] | null | undefined, now: number): AgentRow[] {
  const list = agents ?? []
  const make = (a: SnapshotAgent, state: AgentRow['state']): AgentRow => {
    const left = a.budgetMin !== undefined && state === 'running' ? a.startedAt + a.budgetMin * 60000 - now : undefined
    return {
      id: a.id,
      type: a.type,
      glyph: state === 'running' ? '◐' : state === 'done' ? '✓' : '✗',
      name: a.type.split(':').pop() || a.type,
      tag: a.cube ? a.cube.id : a.step !== undefined ? `step ${a.step}` : undefined,
      time: left === undefined ? undefined : left >= 0 ? `${clock(left)} left` : `+${clock(left)} over`,
      over: left !== undefined && left < 0,
      detail: (a.lastTool || a.description) ? trunc((a.lastTool || a.description).replace(/\s+/g, ' ').trim(), DETAIL_MAX) : undefined,
      state,
      tool: a.lastTool,
      startedAt: a.startedAt,
      endedAt: a.endedAt,
    }
  }
  const running = list.filter(a => a.status === 'running').map(a => make(a, 'running'))
  const finished = list
    .filter(a => a.status === 'done' || a.status === 'failed')
    .sort((x, y) => (y.endedAt ?? y.startedAt) - (x.endedAt ?? x.startedAt))
    .slice(0, FINISHED_MAX)
    .map(a => make(a, a.status as 'done' | 'failed'))
  return [...running, ...finished]
}
