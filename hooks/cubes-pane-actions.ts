// Actions behind the terminal cubes pane buttons. Same commands as the dashboard command bridge.
import type { Cube, DashboardCommand } from '../types/index'
import { command } from './dashboard'

export type PaneAction = { kind: 'approve' | 'reject'; id: string } | { kind: 'approveAll' } | { kind: 'toggleDetails'; id: string }


/** Flip one cube id in the open-details list (pane state, not a cube command). */
export async function toggleDetails($: any, id: string): Promise<void> {
  const { value } = await $.state.get({ plugin: 'task-progress', key: 'cubesPaneOpen' })
  const cur: string[] = Array.isArray(value) ? value : []
  await $.state.set({ plugin: 'task-progress', key: 'cubesPaneOpen' }, cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id])
}

/** The command the Cubes pane sends for an approve or reject button. */
export function paneActionToCommand(a: Exclude<PaneAction, { kind: 'toggleDetails' }>): DashboardCommand {
  if (a.kind === 'approveAll') return { action: 'cube.approveAll' } as DashboardCommand
  return { action: a.kind === 'approve' ? 'cube.approve' : 'cube.reject', id: a.id } as DashboardCommand
}

/** Buttons a cube shows: only cubes waiting for approval ('proposed'). */
export function buttonsFor(cube: Pick<Cube, 'status'>): Array<'approve' | 'reject'> {
  return cube.status === 'proposed' ? ['approve', 'reject'] : []
}

/** Run one pane action and toast the result. Never throws. */
export async function runPaneAction($: any, a: PaneAction): Promise<void> {
  if (a.kind === 'toggleDetails') {
    try {
      await toggleDetails($, a.id)
    } catch {
      // best effort
    }
    return
  }
  let text: string
  try {
    const r = await command($, paneActionToCommand(a))
    text = r.ok
      ? a.kind === 'approveAll' ? String(r.message || 'Approved all') : `${a.kind === 'approve' ? 'Approved' : 'Rejected'} ${a.id}`
      : String(r.message ?? 'Failed')
  } catch (e: any) {
    text = String(e?.message ?? e ?? 'Failed')
  }
  try {
    await $.ui.toast(text)
  } catch {
    // nothing more to do
  }
}
