// The Agents pane: big animated art beside the chat while sub-agents work.
// The frame comes from the pure paneFrame; this file holds the engine-facing parts
// (render, open/close, auto-open rules). Copies the patterns of cubes-pane.tsx.
import type { ExecutorRun, Snapshot } from '../types/index'
import { paneFrame, type AnimAgent } from './anim-frames'

export const AGENTS_PANE_ID = 'tp-agents'
export const AGENTS_PANE_TITLE = 'Agents'
/** Body columns asked for while docked beside the transcript. */
export const AGENTS_PANE_COLUMNS = 44

const closedRef = { plugin: 'task-progress', key: 'agentsPaneClosed' } as const
const openRef = { plugin: 'task-progress', key: 'agentsPaneOpen' } as const
const manualRef = { plugin: 'task-progress', key: 'agentsPaneManual' } as const
const autoRef = { plugin: 'task-progress', key: 'agentsPaneAuto' } as const

/** The running executors as art rows: "step k" plus the dispatch description when the snapshot has it. */
export function toAnimAgents(runs: ExecutorRun[], snap: Snapshot | null | undefined): AnimAgent[] {
  return runs.map((r, i) => {
    const s = snap?.agents?.find(a => a.id === r.id)
    const base = r.step !== null ? `step ${r.step}` : `agent ${i + 1}`
    const task = (s?.description ?? '').replace(/\s+/g, ' ').trim()
    return { id: r.id, label: task ? `${base} · ${task}` : base, startedAt: r.startedAt, budgetMs: r.budgetMs, lastTool: s?.lastTool, type: r.type }
  })
}

/** Draws the Pane. Reading frame/runs/animDoneAt subscribes, so each ticker frame and each run change redraws it. */
export async function renderAgentsPane($: any, e: any, doneMs: number) {
  const { Box, Text } = $.ui.resolve(e)
  const { value: frame = 0 } = await $.state.get({ plugin: 'task-progress', key: 'frame' })
  const { value: runs = [] } = await $.state.get({ plugin: 'task-progress', key: 'runs' })
  const { value: doneAt = 0 } = await $.state.get({ plugin: 'task-progress', key: 'animDoneAt' })
  const { value: snap } = await $.state.get({ plugin: 'task-progress', key: 'snapshot' })
  const now: number = await $.clock.now()
  const width = Math.max(20, Number(e?.props?.bodyColumns) || AGENTS_PANE_COLUMNS)
  const lines = paneFrame(frame, toAnimAgents(runs, snap), now, width, doneAt && now - doneAt < doneMs ? doneAt : null)
  return (
    <Box flexDirection="column">
      {lines.length === 0 ? <Text dimColor>No agents running</Text> : null}
      {lines.map((line, i) => (
        <Box key={`l${i}`}>
          {line.length === 0 ? <Text>{' '}</Text> : null}
          {line.map((sp, j) => (
            <Text key={String(j)} color={sp.color} bold={sp.bold} dimColor={sp.dim}>
              {sp.text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

async function openPane($: any): Promise<boolean> {
  try {
    await $.ui.open({ id: AGENTS_PANE_ID, title: AGENTS_PANE_TITLE, columns: AGENTS_PANE_COLUMNS })
    await $.state.set(openRef, true)
    return true
  } catch {
    return false // no surface or a refused open: best effort
  }
}

async function clearPaneFlags($: any): Promise<void> {
  await $.state.set(openRef, false)
  await $.state.set(autoRef, false)
  await $.state.set(manualRef, false)
}

async function closePane($: any): Promise<void> {
  await clearPaneFlags($)
  try {
    await $.ui.close({ id: AGENTS_PANE_ID })
  } catch {
    // already gone
  }
}

/** Runs went 0 -> 1: open the pane unasked, unless the person closed it. Remembers it was ours to close. */
export async function autoOpenAgentsPane($: any): Promise<void> {
  if ((await $.state.get(closedRef)).value) return
  if ((await $.state.get(openRef)).value) return
  if (await openPane($)) await $.state.set(autoRef, true)
}

/** The done window ended: close the pane only if it was auto-opened and no agent runs again. */
export async function autoCloseAgentsPane($: any): Promise<void> {
  if (!(await $.state.get(autoRef)).value) return
  if (((await $.state.get({ plugin: 'task-progress', key: 'runs' })).value ?? []).length > 0) return
  await closePane($)
}

/** /tp-agents: toggles the pane. A person's open keeps it open when idle; a person's close is remembered. */
export async function toggleAgentsPane($: any): Promise<string> {
  if ((await $.state.get(openRef)).value) {
    await closePane($)
    await $.state.set(closedRef, true)
    return 'Agents pane closed.'
  }
  await $.state.set(closedRef, false)
  if (!(await openPane($))) return 'No panel available here.'
  await $.state.set(manualRef, true)
  await $.state.set(autoRef, false)
  return 'Agents pane open.'
}

/** ui.close for the pane: a person's close is remembered for the session. */
export async function onAgentsPaneClose($: any, e: any, next: (e: any) => any) {
  await clearPaneFlags($)
  if (e?.origin?.kind === 'person') await $.state.set(closedRef, true)
  return next(e)
}
