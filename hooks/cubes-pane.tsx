// The terminal side panel for approval cubes. The row builder is pure (no `$`);
// the render and open helpers are the only parts that touch the engine.
import type { Cube, CubeBoard } from '../types/index'
import { buttonsFor, runPaneAction } from './cubes-pane-actions'

export const PANE_ID = 'tp-cubes'
export const PANE_TITLE = 'Cubes'
/** Body columns asked for while docked beside the transcript. */
export const PANE_COLUMNS = 44
const TITLE_MAX = 36
const snapRef = { plugin: 'task-progress', key: 'snapshot' } as const

const FINISHED = ['done', 'skipped', 'rejected']

/** Cubes still to be worked or approved: the pane opens by itself while any exist. */
export function hasUnfinished(board: CubeBoard | null | undefined): boolean {
  return !!board && board.cubes.some(c => !FINISHED.includes(c.status))
}

export type CubeRow = {
  kind: 'header' | 'cube' | 'empty' | 'footer'
  /** header / empty / footer text. */
  text?: string
  id?: string
  title?: string
  glyph?: string
  /** Status word, e.g. `waiting for approval` or `approved · starts after c1`. */
  word?: string
  minutes?: number
  after?: string[]
  color?: 'green' | 'yellow' | 'red'
  dim?: boolean
  /** Buttons under a cube row, from buttonsFor (the one rule). Empty for every status but `proposed`. */
  buttons?: Array<'approve' | 'reject'>
  /** footer: how many cubes Approve all would approve. */
  count?: number
}

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function statusOf(cb: Cube, board: CubeBoard): Pick<CubeRow, 'glyph' | 'word' | 'color' | 'dim'> {
  const open = cb.after.filter(id => !['done', 'skipped'].includes(board.cubes.find(x => x.id === id)?.status ?? 'done'))
  switch (cb.status) {
    case 'done':
      return { glyph: '✓', word: 'done', color: 'green', dim: true }
    case 'running':
      return { glyph: '◐', word: 'running', color: 'yellow' }
    case 'reviewing':
      return { glyph: '◐', word: 'in review', color: 'yellow' }
    case 'queued':
      return { glyph: '○', word: open.length ? `approved · starts after ${open.join(', ')}` : 'approved · starting' }
    case 'approved':
      return { glyph: '○', word: 'approved' }
    case 'rejected':
      return { glyph: '✗', word: 'rejected', color: 'red', dim: true }
    case 'failed':
      return { glyph: '✗', word: 'failed', color: 'red' }
    case 'skipped':
      return { glyph: '–', word: 'skipped', dim: true }
    case 'revising':
      return { glyph: '○', word: 'being revised' }
    default:
      return { glyph: '○', word: 'waiting for approval' }
  }
}

/** The board as display rows: a counts header, one row per cube, or an empty state. */
export function buildCubeRows(board: CubeBoard | null | undefined): CubeRow[] {
  if (!board || board.cubes.length === 0) return [{ kind: 'empty', text: 'No cubes yet. A plan with cubes shows up here for approval.' }]
  const n = (f: (c: Cube) => boolean) => board.cubes.filter(f).length
  const done = n(c => c.status === 'done' || c.status === 'skipped')
  const waiting = n(c => c.status === 'proposed')
  const running = n(c => c.status === 'running' || c.status === 'reviewing')
  const header = [`Cubes · ${done}/${board.cubes.length} done`, running ? `${running} running` : '', waiting ? `${waiting} waiting for approval` : '']
    .filter(Boolean)
    .join(' · ')
  const rows: CubeRow[] = [{ kind: 'header', text: header }]
  for (const cb of board.cubes) {
    rows.push({
      kind: 'cube',
      id: cb.id,
      title: trunc(cb.title, TITLE_MAX),
      minutes: cb.minutes,
      after: cb.after,
      buttons: buttonsFor(cb),
      ...statusOf(cb, board),
    })
  }
  if (waiting > 0) rows.push({ kind: 'footer', text: `Approve all (${waiting})`, count: waiting })
  return rows
}

/** Draws the Pane from the stored snapshot. Reading state subscribes, so a board change redraws it. */
export async function renderCubesPane($: any, e: any) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const { value } = await $.state.get(snapRef)
  const rows = buildCubeRows(value?.cubes)
  return (
    <Box flexDirection="column">
      {rows.map((r, i) => {
        if (r.kind === 'header') return <Text key={`h${i}`} bold>{r.text}</Text>
        if (r.kind === 'empty') return <Text key={`e${i}`} dimColor>{r.text}</Text>
        if (r.kind === 'footer') {
          return (
            <Box key={`f${i}`} marginTop={1}>
              <Button key="approve-all" onPress={() => void runPaneAction($, { kind: 'approveAll' })}>{r.text}</Button>
            </Box>
          )
        }
        return (
          <Box key={r.id} flexDirection="column" marginTop={i === 1 ? 1 : 0}>
            <Box>
              <Text color={r.color} dimColor={r.dim}>{r.glyph} </Text>
              <Text bold={!r.dim} dimColor={r.dim}>{r.id} · {r.title}</Text>
            </Box>
            <Text dimColor>{`  ${r.word} · ${r.minutes}m${r.after && r.after.length ? ` · after ${r.after.join(', ')}` : ''}`}</Text>
            {r.buttons && r.buttons.length > 0 ? (
              // Own line under the row: the two buttons plus the indent fit 44 columns.
              <Box marginLeft={2}>
                {r.buttons.map(k => (
                  <Box key={`${k}-${r.id}`} marginRight={1}>
                    <Button key={`${k}-${r.id}`} onPress={() => void runPaneAction($, { kind: k, id: r.id! })}>{k === 'approve' ? 'Approve' : 'Reject'}</Button>
                  </Box>
                ))}
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

/** Opens (or retitles) the pane without the keyboard. An unasked open may answer isPlaced false on a narrow terminal. */
export async function openCubesPane($: any): Promise<void> {
  try {
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS })
  } catch {
    // no surface or a refused open: the pane is best effort
  }
}

const closedRef = { plugin: 'task-progress', key: 'cubesPaneClosed' } as const

/** ui.close for the pane: a person's close is remembered (survives /reload-plugins) until the next new plan. */
export async function onCubesPaneClose($: any, e: any, next: (e: any) => any) {
  if (e?.origin?.kind === 'person') await $.state.set(closedRef, true)
  return next(e)
}
