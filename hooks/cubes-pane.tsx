// The terminal side panel for approval cubes. The row builder is pure (no `$`);
// the render and open helpers are the only parts that touch the engine.
import type { Cube, CubeBoard } from '../types/index'
import { buttonsFor, runPaneAction } from './cubes-pane-actions'
import { buildAgentRows, trunc, type AgentRow } from './pane-agents'
import { buildUsageRows } from './pane-usage'
import { forgetToolClock, sceneRows, toolSinceOf, FAIL_MS, SLOT_W, MASCOT_COLOR } from './anim-frames'

export const PANE_ID = 'tp-cubes'
export const PANE_TITLE = 'Cubes'
/** Body columns asked for while docked beside the transcript. */
export const PANE_COLUMNS = 44
const TITLE_MAX = 36
/** Text columns beside the 13-col mascot slot (44 - 13 = 31). */
const TEXT_W = PANE_COLUMNS - SLOT_W

export type AgentLine = {
  /** The 13-col slot: a mascot line, or the glyph / blanks for a one-line row. */
  slot: string
  mascot: boolean
  text: string
  /** Right-aligned-after-text time chip; counts toward the width. */
  time?: string
  over?: boolean
  dim?: boolean
}

/** One Agents-section entry as lines. Animating agents (live, or done inside the done window) are 3 lines:
 *  mascot slot + text (line 1 empty, line 2 name · tag, line 3 tool · time). Others are one line plus a detail line,
 *  with text aligned to the mascot rows' text column. Every line fits PANE_COLUMNS. */
export function buildAgentBlock(a: AgentRow, anim: 'run' | 'done' | 'fail' | null, frame: number, i: number, t: { now?: number; doneAt?: number } = {}): AgentLine[] {
  const nameTag = (n: number) => {
    const tag = a.tag ? ` · ${a.tag}` : ''
    const room = Math.max(1, n - tag.length)
    return trunc(a.name, room) + tag
  }
  const clip = (t: string) => trunc(t, TEXT_W)
  if (anim) {
    const now = t.now ?? 0
    const slots = sceneRows({
      tick: frame,
      seed: i * 3,
      now,
      tool: a.tool,
      startedAt: t.now !== undefined ? a.startedAt : undefined,
      toolSince: t.now !== undefined && a.startedAt !== undefined && anim === 'run' ? toolSinceOf(a.id, a.tool, now, a.startedAt) : undefined,
      doneAt: anim === 'done' ? (t.doneAt ?? now) : undefined,
      failedAt: anim === 'fail' ? (a.endedAt ?? now) : undefined,
    })
    const timeChip = a.time ? ` · ${a.time}` : ''
    return [
      { slot: slots[0]!, mascot: true, text: '' },
      { slot: slots[1]!, mascot: true, text: clip(nameTag(TEXT_W)), dim: anim === 'done' || anim === 'fail' },
      { slot: slots[2]!, mascot: true, text: trunc(a.detail ?? '', Math.max(0, TEXT_W - timeChip.length)), time: timeChip || undefined, over: a.over, dim: true },
    ]
  }
  const timeChip = a.time ? ` · ${a.time}` : ''
  const out: AgentLine[] = [
    { slot: a.glyph.padEnd(SLOT_W), mascot: false, text: clip(nameTag(Math.max(1, TEXT_W - timeChip.length))), time: timeChip || undefined, over: a.over, dim: a.state !== 'running' },
  ]
  if (a.detail) out.push({ slot: ' '.repeat(SLOT_W), mascot: false, text: trunc(a.detail, TEXT_W), dim: true })
  return out
}
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
  /** Trimmed summary (legacy `details` when no summary). */
  summary?: string
  /** Details are open: sections hold the content. */
  open?: boolean
  /** True when the cube has any section content to open. */
  hasDetails?: boolean
  sections?: Array<{ title: string; items: string[]; numbered?: boolean }>
  /** footer: how many cubes Approve all would approve. */
  count?: number
}


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
function sectionsOf(cb: Cube): Array<{ title: string; items: string[]; numbered?: boolean }> {
  const out: Array<{ title: string; items: string[]; numbered?: boolean }> = []
  if (cb.problem?.length) out.push({ title: 'Problem', items: cb.problem })
  if (cb.steps?.length) out.push({ title: 'Steps', items: cb.steps, numbered: true })
  if (cb.code?.length) out.push({ title: 'Code touched', items: cb.code.map(c => `${c.file} › ${c.change}`) })
  const rv = cb.review
  if (rv && (rv.verdict || rv.summary)) {
    const one = (rv.summary ?? '').replace(/\s+/g, ' ').trim()
    out.push({ title: 'Review', items: [[rv.verdict, one].filter(Boolean).join(' · ')] })
  }
  return out
}

export function buildCubeRows(board: CubeBoard | null | undefined, openIds: string[] = []): CubeRow[] {
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
      summary: (cb.summary || cb.details || '').trim() || undefined,
      hasDetails: sectionsOf(cb).length > 0,
      open: openIds.includes(cb.id),
      ...(openIds.includes(cb.id) ? { sections: sectionsOf(cb) } : {}),
    })
  }
  if (waiting > 0) rows.push({ kind: 'footer', text: `Approve all (${waiting})`, count: waiting })
  return rows
}

/** Draws the Pane from the stored snapshot. Reading state subscribes, so a board change redraws it. */
export async function renderCubesPane($: any, e: any, doneMs = 3000) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const { value } = await $.state.get(snapRef)
  const { value: openValue } = await $.state.get({ plugin: 'task-progress', key: 'cubesPaneOpen' })
  const openIds: string[] = Array.isArray(openValue) ? openValue : []
  await $.state.get({ plugin: 'task-progress', key: 'paneTick' }) // subscribe: the poll ticks it while an agent runs
  await $.state.get({ plugin: 'task-progress', key: 'animFailAt' }) // subscribe: clearing it redraws the failed row
  // Mascot clock: the same frame ticker, runs and done window the band and Agents pane read (it only ticks while agents run).
  const { value: frame = 0 } = await $.state.get({ plugin: 'task-progress', key: 'frame' })
  const { value: runs = [] } = await $.state.get({ plugin: 'task-progress', key: 'runs' })
  const { value: doneAt = 0 } = await $.state.get({ plugin: 'task-progress', key: 'animDoneAt' })
  const now: number = await $.clock.now()
  const inDone = !!doneAt && now - doneAt >= 0 && now - doneAt < doneMs
  const rows = buildCubeRows(value?.cubes, openIds)
  const agentRows = buildAgentRows(value?.agents, now)
  const usageRows = buildUsageRows(value, now)
  const running = agentRows.filter(a => a.state === 'running').length
  return (
    <Box flexDirection="column">
      {agentRows.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{`Agents · ${running} running`}</Text>
          {agentRows.map((a, i) => {
            const live = a.state === 'running' && Array.isArray(runs) && runs.some((r: any) => r.id === a.id)
            if (a.state !== 'running') forgetToolClock(a.id)
            const hop = a.state === 'done' && inDone && a.endedAt !== undefined && now - a.endedAt >= 0 && now - a.endedAt < doneMs
            const fail = a.state === 'failed' && a.endedAt !== undefined && now - a.endedAt >= 0 && now - a.endedAt < FAIL_MS
            return (
              <Box key={`ag${i}`} flexDirection="column">
                {buildAgentBlock(a, live ? 'run' : hop ? 'done' : fail ? 'fail' : null, frame, i, { now, doneAt }).map((l, j) => (
                  <Box key={`al${j}`}>
                    {l.mascot ? (
                      <Text color={MASCOT_COLOR} bold>{l.slot}</Text>
                    ) : (
                      <Text color={a.state === 'failed' || a.over ? 'red' : a.state === 'running' ? 'yellow' : 'green'} dimColor={a.state !== 'running'}>{l.slot}</Text>
                    )}
                    <Text dimColor={l.dim}>{l.text}</Text>
                    {l.time ? <Text color={l.over ? 'red' : undefined}>{l.time}</Text> : null}
                  </Box>
                ))}
              </Box>
            )
          })}
        </Box>
      ) : null}
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
            {r.summary ? <Text dimColor>{`  ${r.summary}`}</Text> : null}
            {r.hasDetails ? (
              <Box marginLeft={2}>
                <Button key={`details-${r.id}`} onPress={() => void runPaneAction($, { kind: 'toggleDetails', id: r.id! })}>{r.open ? '▾ Hide' : '▸ Details'}</Button>
              </Box>
            ) : null}
            {r.open && r.sections
              ? r.sections.map(sec => (
                  <Box key={`${r.id}-${sec.title}`} flexDirection="column" marginLeft={2}>
                    <Text bold>{sec.title}</Text>
                    {sec.items.map((it, j) => (
                      <Box key={j} marginLeft={2}>
                        <Text>{sec.numbered ? `${j + 1}. ${it}` : sec.title === 'Review' ? it : `- ${it}`}</Text>
                      </Box>
                    ))}
                  </Box>
                ))
              : null}
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
      {usageRows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {usageRows.map((r, i) => (
            <Text key={`u${i}`} bold={r.kind === 'header'} dimColor={r.color === undefined} color={r.color}>{r.kind === 'agent' ? `  ${r.text}` : r.text}</Text>
          ))}
        </Box>
      ) : null}
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
