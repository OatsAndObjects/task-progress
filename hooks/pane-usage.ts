// Usage section of the Cubes pane. Pure: no `$`, no clock (the caller passes `now`).
import type { Snapshot } from '../types/index'
import { trunc } from './pane-agents'

export type UsageRow = {
  kind: 'header' | 'limit' | 'sub' | 'agent'
  text: string
  /** limit rows: yellow from 70%, red from 90%. */
  color?: 'yellow' | 'red'
}

const BAR = 10
const TOP_AGENTS = 5
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const barOf = (percent: number): string => {
  const n = Math.max(0, Math.min(BAR, Math.round((percent / 100) * BAR)))
  return '▰'.repeat(n) + '▱'.repeat(BAR - n)
}

export const colorOf = (percent: number): 'yellow' | 'red' | undefined => (percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : undefined)

export const compact = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)))

function resetText(resetsAt: string | null, now: number, long: boolean): string {
  const t = resetsAt ? Date.parse(resetsAt) : NaN
  if (!Number.isFinite(t)) return ''
  if (long) return ` · resets ${DAYS[new Date(t).getDay()]}`
  const m = Math.floor(Math.max(0, t - now) / 60000)
  return ` · resets ${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

export function buildUsageRows(snapshot: Snapshot | null | undefined, now: number): UsageRow[] {
  const u = snapshot?.usage
  if (!u) return []
  const rows: UsageRow[] = []
  const limit = (name: string, l: { percent: number; resetsAt: string | null } | null, long: boolean) => {
    if (!l) return
    const p = Math.round(l.percent)
    rows.push({ kind: 'limit', text: `${name}  ${barOf(l.percent)} ${p}%${resetText(l.resetsAt, now, long)}`, color: colorOf(l.percent) })
  }
  limit('5h', u.fiveHour, false)
  limit('7d', u.weekly, true)
  const agents = [...(u.breakdown?.byAgent ?? [])]
    .filter(a => a.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, TOP_AGENTS)
  if (agents.length > 0) {
    rows.push({ kind: 'sub', text: 'Top agents' })
    for (const a of agents) rows.push({ kind: 'agent', text: `${trunc(a.label, 30)} · ${compact(a.tokens)}` })
  }
  return rows.length > 0 ? [{ kind: 'header', text: 'Usage' }, ...rows] : []
}
