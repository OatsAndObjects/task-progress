// Actions behind the terminal cubes pane buttons. Same commands the web sends.
import type { Cube, DashboardCommand } from '../types/index'
import { command } from './dashboard'

export type PaneAction = { kind: 'approve' | 'reject'; id: string } | { kind: 'approveAll' }

/** The exact command the web app sends (web/app/cubes.js: cmd('cube.approve', { id })). */
export function paneActionToCommand(a: PaneAction): DashboardCommand {
  if (a.kind === 'approveAll') return { action: 'cube.approveAll' } as DashboardCommand
  return { action: a.kind === 'approve' ? 'cube.approve' : 'cube.reject', id: a.id } as DashboardCommand
}

/** Buttons a cube shows: only cubes waiting for approval ('proposed'). */
export function buttonsFor(cube: Pick<Cube, 'status'>): Array<'approve' | 'reject'> {
  return cube.status === 'proposed' ? ['approve', 'reject'] : []
}

/** Run one pane action and toast the result. Never throws. */
export async function runPaneAction($: any, a: PaneAction): Promise<void> {
  let text: string
  try {
    const r = await command($, paneActionToCommand(a))
    text = r.ok
      ? a.kind === 'approveAll' ? 'Approved all' : `${a.kind === 'approve' ? 'Approved' : 'Rejected'} ${a.id}`
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
