import type { Register } from 'claude-code'

import type { TaskProgressRecord } from '../types/index'

const PLUGIN = 'task-progress'
const TOOL = 'mcp__task-progress__TaskProgress'
const BAR_CELLS = 14
const CLEAR_AFTER_MS = 8000
const TICK_MS = 120
const ANIM_MS = 600
const BAR_WIDTH = 42
const MAX_SEGMENTS = 12
const SPARKLES = ['✦', '✧', '✶', '✧']
const C_FROM = '#A5B4FC'
const C_TO = '#0A84FF'
const C_CURRENT = '#0060DF'
const C_SHIMMER = '#7DD3FC'
const C_UPCOMING = '#4B5160'

const PROMPT = [
  'Task progress bar: when the user assigns a task that will take more than ~2 steps,',
  'call TaskProgress first with your estimate of totalSteps and step 0.',
  'After each meaningful step, call it again with the new step count and a short label;',
  'revise totalSteps if your estimate changes. When finished, call it with done: true.',
  'Skip it for quick questions and one-step answers.',
  "Keep calls brief; don't mention the bar in replies.",
].join(' ')

const progressRef = { plugin: 'task-progress', key: 'progress' } as const
const hiddenRef = { plugin: 'task-progress', key: 'hidden' } as const
const frameRef = { plugin: 'task-progress', key: 'frame' } as const

export function bar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS)))
  return '▓'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
}

/** `~42s`, `~3m`, `~1h 5m` (remaining) */
export function formatEta(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `~${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `~${m}m`
  return `~${Math.floor(m / 60)}h ${m % 60}m`
}

/** `42s`, `3m 5s`, `1h 5m` (elapsed) */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function formatStatus(p: TaskProgressRecord, now: number): string {
  if (p.isDone) {
    return `✓ ${p.task} · done in ${formatElapsed((p.finishedAt || now) - p.startedAt)}`
  }
  const percent = Math.round((p.step / p.totalSteps) * 100)
  const parts = [`${bar(percent)} ${percent}%`, p.task, `${p.step}/${p.totalSteps}`]
  if (p.label) parts.push(p.label)
  if (p.step === 0) {
    parts.push('estimating…')
  } else if (p.step < p.totalSteps) {
    const perStep = (now - p.startedAt) / p.step
    parts.push(`${formatEta(perStep * (p.totalSteps - p.step))} left`)
  }
  return parts.join(' · ')
}


export type Cell = { ch: string; color: string }

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

function hexToRgb(h: string): [number, number, number] {
  return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

/** Light lavender-blue to bright blue, t in 0..1 across the whole bar. */
export function gradient(t: number): string {
  const a = hexToRgb(C_FROM)
  const b = hexToRgb(C_TO)
  const x = clamp01(t)
  return '#' + a.map((v, i) => Math.round(v + (b[i]! - v) * x).toString(16).padStart(2, '0')).join('')
}

export function segmentCount(totalSteps: number): number {
  return Math.max(1, Math.min(MAX_SEGMENTS, totalSteps))
}

export function segmentWidth(segments: number): number {
  return Math.max(2, Math.floor((BAR_WIDTH - (segments - 1)) / segments))
}

/**
 * Fill of the bar in segment units (0..segments): 2.5 means two segments full and the
 * third half full. Totals above 12 steps are mapped proportionally onto 12 segments.
 */
export function barPosition(p: TaskProgressRecord, now: number, frame: number): number {
  const n = segmentCount(p.totalSteps)
  if (p.isDone) return n
  const unit = n / p.totalSteps
  const target = p.step * unit
  const sinceStep = now - p.lastStepAt
  if (p.step > p.prevStep && sinceStep < ANIM_MS) {
    // Newly completed step: fill smoothly from where the bar was.
    const from = Math.min(target, (p.prevStep + p.prevFill) * unit)
    const t = clamp01(sinceStep / ANIM_MS)
    return from + (target - from) * (1 - (1 - t) * (1 - t))
  }
  if (p.step >= p.totalSteps) return n
  let frac: number
  if (p.step === 0) {
    frac = 0.1 + 0.4 * (1 + Math.sin(frame * 0.15))
  } else {
    frac = stepFraction(p, now)
  }
  return target + frac * unit
}

/** How far through the current step the bar shows (0..0.9), from the average step time. */
export function stepFraction(
  p: { step: number; totalSteps: number; startedAt: number; lastStepAt: number },
  now: number,
): number {
  if (p.step === 0 || p.step >= p.totalSteps) return 0
  const avg = (p.lastStepAt - p.startedAt) / p.step
  return avg > 0 ? Math.min(0.9, (now - p.lastStepAt) / avg) : 0
}

/** The bar as cells: `━` in segments separated by a space, each cell with its colour. */
export function buildBar(totalSteps: number, pos: number, frame: number, isDone: boolean): Cell[] {
  const n = segmentCount(totalSteps)
  const w = segmentWidth(n)
  const total = n * w
  const cells: Cell[] = []
  const current = isDone ? -1 : Math.min(n - 1, Math.floor(pos))
  for (let i = 0; i < n; i++) {
    if (i > 0) cells.push({ ch: ' ', color: '' })
    const fill = clamp01(pos - i)
    const lit = fill >= 1 ? w : Math.round(fill * w)
    const shimmer = i === current && lit > 0 ? frame % lit : -1
    for (let j = 0; j < w; j++) {
      let color = C_UPCOMING
      if (fill >= 1) color = gradient(total > 1 ? (i * w + j) / (total - 1) : 0)
      else if (j < lit) color = j === shimmer ? C_SHIMMER : C_CURRENT
      cells.push({ ch: '━', color })
    }
  }
  return cells
}

/** `3/7 · ~2m left`, `0/7 · estimating…`, or `done in 2m 5s` */
export function formatMeta(p: TaskProgressRecord, now: number): string {
  if (p.isDone) return `done in ${formatElapsed((p.finishedAt || now) - p.startedAt)}`
  const parts = [`${p.step}/${p.totalSteps}`]
  if (p.step === 0) parts.push('estimating…')
  else if (p.step < p.totalSteps) parts.push(`${formatEta(((now - p.startedAt) / p.step) * (p.totalSteps - p.step))} left`)
  return parts.join(' · ')
}

/** `Fix login bug — step 3 of 7 (43%) · running tests · 4m 10s elapsed · ~2m left` */
export function formatReply(p: TaskProgressRecord | null | undefined, now: number): string {
  if (!p) return 'No task in progress.'
  if (p.isDone) return `✓ ${p.task} — done in ${formatElapsed((p.finishedAt || now) - p.startedAt)}`
  const percent = Math.round((p.step / p.totalSteps) * 100)
  const parts = [`${p.task} — step ${p.step} of ${p.totalSteps} (${percent}%)`]
  if (p.label) parts.push(p.label)
  parts.push(`${formatElapsed(now - p.startedAt)} elapsed`)
  if (p.step === 0) parts.push('estimating…')
  else if (p.step < p.totalSteps) parts.push(`${formatEta(((now - p.startedAt) / p.step) * (p.totalSteps - p.step))} left`)
  return parts.join(' · ')
}

export function sparkle(frame: number, isDone: boolean): string {
  return isDone ? '✓' : SPARKLES[Math.floor(frame / 2) % SPARKLES.length]!
}

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

export const register: Register = on => {
  let clearTimer: { cancel: () => void } | undefined
  let ticker: { cancel: () => void } | undefined
  let frame = 0

  // The frame timer runs only while a task shows (running, or the 8 s done display).
  const stopTicker = () => {
    ticker?.cancel()
    ticker = undefined
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: "Show the current task's progress, or clear the bar",
    })
    await $.tool.register({
      name: 'TaskProgress',
      description:
        'Report estimated progress of the current multi-step task; it is shown as a progress bar above the prompt. Call with step 0 and your totalSteps estimate at the start, again after each meaningful step, and with done: true at the end.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Short name of the task (max 40 characters shown).' },
          totalSteps: { type: 'integer', minimum: 1, description: 'Your estimate of the total number of steps; may be revised.' },
          step: { type: 'integer', minimum: 0, description: 'Steps completed so far.' },
          label: { type: 'string', description: 'What is happening now.' },
          done: { type: 'boolean', description: 'True when the task is finished.' },
        },
        required: ['task', 'totalSteps', 'step'],
      },
    })

    const { value } = await $.state.get(progressRef)
    // A finished task from an earlier session stays hidden; an unfinished one is drawn again.
    await $.state.set(hiddenRef, !value || value.isDone)
    stopTicker()
    if (value && !value.isDone) {
      if (!ticker) {
        ticker = $.clock.every(TICK_MS, () => {
          frame += 1
          void $.state.set(frameRef, frame)
        })
      }
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e, next) => {
    const now = await $.clock.now()
    const { value: prev } = await $.state.get(progressRef)

    const task = (String(e.task ?? '').trim() || 'Task').slice(0, 40)
    const totalSteps = Math.max(1, toInt(e.totalSteps, prev?.totalSteps ?? 1))
    const isDone = e.done === true
    const step = isDone ? totalSteps : Math.min(totalSteps, Math.max(0, toInt(e.step, 0)))
    const label = typeof e.label === 'string' ? e.label.trim() : ''

    const isSame = prev !== null && prev !== undefined && prev.task === task && !prev.isDone
    const next_: TaskProgressRecord = {
      task,
      totalSteps,
      step,
      label,
      startedAt: isSame ? prev.startedAt : now,
      lastStepAt: now,
      prevStep: isSame ? prev.step : 0,
      prevFill: isSame ? stepFraction(prev, now) : 0,
      isDone,
      finishedAt: isDone ? now : 0,
    }
    clearTimer?.cancel()
    clearTimer = undefined
    await $.state.set(hiddenRef, false)
    await $.state.set(progressRef, next_)
    if (!ticker) {
      ticker = $.clock.every(TICK_MS, () => {
        frame += 1
        void $.state.set(frameRef, frame)
      })
    }

    if (isDone) {
      clearTimer = $.clock.after(CLEAR_AFTER_MS, () => {
        clearTimer = undefined
        stopTicker()
        void $.state.set(hiddenRef, true)
      })
    }

    return { result: isDone ? `task done: ${task}` : `progress ${step}/${totalSteps} recorded` }
  })

  // /progress: answered as plain text by the hook itself, so no model turn is started.
  on('command.run', { command: 'progress' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === '') {
      const { value } = await $.state.get(progressRef)
      return { text: formatReply(value, await $.clock.now()) }
    }
    if (arg === 'clear') {
      clearTimer?.cancel()
      clearTimer = undefined
      stopTicker()
      await $.state.set(hiddenRef, true)
      await $.state.set(progressRef, null)
      return { text: 'Progress bar cleared.' }
    }
    return { text: 'Usage: /progress  ·  /progress clear' }
  })

  // The band: one row above the prompt. Reading state while drawing subscribes this
  // instance, so every $.state.set above redraws it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value: progress } = await $.state.get(progressRef)
    const { value: isHidden } = await $.state.get(hiddenRef)
    if (!progress || isHidden) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const { value: frame = 0 } = await $.state.get(frameRef)
    const now = await $.clock.now()
    const pos = barPosition(progress, now, frame)
    const cells = buildBar(progress.totalSteps, pos, frame, progress.isDone)

    // Neighbouring cells of one colour share one Text.
    const runs: { text: string; color: string }[] = []
    for (const c of cells) {
      const last = runs.at(-1)
      if (last && last.color === c.color) last.text += c.ch
      else runs.push({ text: c.ch, color: c.color })
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={progress.isDone ? 'green' : C_TO}>{sparkle(frame, progress.isDone)} </Text>
          <Text bold>{progress.task}</Text>
          {progress.label && !progress.isDone ? <Text> · {progress.label}</Text> : null}
          <Text dimColor>{'   ' + formatMeta(progress, now)}</Text>
        </Box>
        <Box>
          {runs.map((r, i) => (r.color ? <Text key={String(i)} color={r.color}>{r.text}</Text> : <Text key={String(i)}>{r.text}</Text>))}
        </Box>
      </Box>
    )
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    return {
      ...out,
      sections: [...out.sections, { id: `${PLUGIN}:progress-bar`, text: PROMPT, scope: 'session' as const }],
    }
  })
}
