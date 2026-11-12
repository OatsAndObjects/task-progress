import { expect, mock, test } from 'claude-code/testing'

import { bar, barPosition, buildBar, formatElapsed, formatEta, formatReply, formatStatus, gradient, segmentCount, segmentWidth } from './register'

const TOOL = 'mcp__task-progress__TaskProgress'
const BAND = {
  plugin: 'task-progress',
  component: 'AbovePrompt',
  requestId: 'band',
  surface: 'terminal',
  props: { hasSurvey: false, bodyColumns: 100 },
} as const

function setup($: any, on: any, startAt = 1_000_000) {
  const clock = mock.clock(on, { now: startAt })
  // Nothing sits beneath the plugin: this hook stands for the engine's own (empty) band.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('tool.call', () => ({ result: {} }))
  let frameWrites = 0
  on('state.set', (_: any, e: any, next: any) => {
    if (e.key === 'frame') frameWrites += 1
    return next(e)
  })
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: TOOL, ...input })
  /** Every Text of the band: row 1 is the texts before the first bar run, row 2 the runs. */
  const band = async () => {
    const ui = await $.ui.mount(BAND)
    const texts: { text: string; color?: string }[] = (await ui.findAll({ type: 'Text' })).map((t: any) => ({
      text: t.text,
      color: t.props.color,
    }))
    await ui.unmount()
    const at = texts.findIndex(t => t.text.startsWith('━'))
    const barRuns = at < 0 ? [] : texts.slice(at)
    return {
      all: texts.map(t => t.text).join(''),
      row1: (at < 0 ? texts : texts.slice(0, at)).map(t => t.text).join(''),
      row2: barRuns.map(t => t.text).join(''),
      runs: barRuns,
    }
  }
  return { clock, call, band, frames: () => frameWrites }
}

test('bar, percent and ETA formatting', async () => {
  expect(bar(0)).toBe('░░░░░░░░░░░░░░')
  expect(bar(100)).toBe('▓▓▓▓▓▓▓▓▓▓▓▓▓▓')
  expect(bar(43)).toBe('▓▓▓▓▓▓░░░░░░░░')
  expect(formatEta(42_000)).toBe('~42s')
  expect(formatEta(120_000)).toBe('~2m')
  expect(formatEta(3_900_000)).toBe('~1h 5m')
  expect(formatElapsed(125_000)).toBe('2m 5s')
  const p = { task: 'Fix login bug', totalSteps: 7, step: 3, label: 'running tests', startedAt: 0, lastStepAt: 0, prevStep: 0, prevFill: 0, isDone: false, finishedAt: 0 }
  expect(formatStatus(p, 90_000)).toBe('▓▓▓▓▓▓░░░░░░░░ 43% · Fix login bug · 3/7 · running tests · ~2m left')
  expect(formatStatus({ ...p, step: 0 }, 5000)).toContain('estimating…')
})

test('segment count and widths, with more than 12 steps mapped onto 12', () => {
  expect(segmentCount(7)).toBe(7)
  expect(segmentCount(30)).toBe(12)
  expect(segmentWidth(7)).toBe(5) // (42 - 6) / 7
  expect(segmentWidth(12)).toBe(2) // (42 - 11) / 12 = 2
  expect(segmentWidth(1)).toBe(42)
  const cells = buildBar(7, 0, 0, false)
  expect(cells.map(c => c.ch).join('')).toBe(Array(7).fill('━━━━━').join(' '))
  expect(buildBar(30, 0, 0, false).map(c => c.ch).join('')).toBe(Array(12).fill('━━').join(' '))
  // 15 of 30 steps is 6 of the 12 segments.
  const p = { task: 't', totalSteps: 30, step: 15, label: '', startedAt: 0, lastStepAt: 0, prevStep: 15, prevFill: 0, isDone: false, finishedAt: 0 }
  expect(Math.abs(barPosition({ ...p, lastStepAt: 0 }, 0, 0) - 6)).toBeLessThan(1e-9)
})

test('finished segments take the gradient, the current one is partly filled, the rest is grey', () => {
  expect(gradient(0)).toBe('#a5b4fc')
  expect(gradient(1)).toBe('#0a84ff')
  const cells = buildBar(4, 1.5, 0, false) // 4 segments of 9 cells
  const seg = (i: number) => cells.filter(c => c.ch === '━').slice(i * 9, i * 9 + 9)
  const total = 36
  expect(seg(0).map(c => c.color)).toEqual(Array.from({ length: 9 }, (_, j) => gradient(j / (total - 1))))
  expect(seg(0)[8]!.color).not.toBe(seg(0)[0]!.color)
  // Segment 1 is half filled: five cells deeper blue (the first one shimmers), four grey.
  expect(seg(1).slice(0, 5).map(c => c.color)).toEqual(['#7DD3FC', '#0060DF', '#0060DF', '#0060DF', '#0060DF'])
  expect(seg(1).slice(5).every(c => c.color === '#4B5160')).toBe(true)
  expect(seg(3).every(c => c.color === '#4B5160')).toBe(true)
  // The shimmer sweeps over the filled part only.
  expect(buildBar(4, 1.5, 3, false).filter(c => c.color === '#7DD3FC')).toHaveLength(1)
  // Done: everything is gradient, no shimmer.
  expect(buildBar(4, 4, 0, true).every(c => c.ch === ' ' || c.color.startsWith('#') && c.color !== '#4B5160' && c.color !== '#7DD3FC')).toBe(true)
})

test('idle: nothing is drawn, the engine keeps the band', async ($, on) => {
  const { band } = setup($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await band()).all).toBe('ENGINE')
})

test('two rows: title and meta, then the segmented bar', async ($, on) => {
  const { clock, band, call } = setup($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await call({ task: 'Fix login bug', totalSteps: 7, step: 0 })
  let b = await band()
  expect(b.row1).toBe('✦ Fix login bug   0/7 · estimating…')
  expect(b.row2.replace(/ /g, '')).toBe('━'.repeat(35))
  await clock.advance(90_000)
  await call({ task: 'Fix login bug', totalSteps: 7, step: 3, label: 'running tests' })
  await clock.advance(1_000)
  b = await band()
  expect(b.row1).toMatch(/^[✦✧✶] Fix login bug · running tests   3\/7 · ~2m left$/)
  expect(b.row2).toHaveLength(41)
})

test('step is clamped and a new task resets timing', async ($, on) => {
  const { clock, band, call } = setup($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await call({ task: 'A', totalSteps: 4, step: 99 })
  expect((await band()).row1).toContain('4/4')
  await call({ task: 'A', totalSteps: 4, step: -5 })
  expect((await band()).row1).toContain('0/4')
  await clock.advance(60_000)
  await call({ task: 'A', totalSteps: 4, step: 1 })
  expect((await band()).row1).toContain('~3m left')
  await call({ task: 'B', totalSteps: 2, step: 1 })
  await clock.advance(10_000)
  await call({ task: 'B', totalSteps: 2, step: 1 })
  const b = await band()
  expect(b.row1).toContain('B')
  expect(b.row1).toContain('1/2')
  expect(b.row1).toContain('~10s left')
})

test('the frame timer runs while a task shows and stops when idle', async ($, on) => {
  const { clock, band, call, frames } = setup($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  expect(frames()).toBe(0) // idle: nothing redraws in the background
  await call({ task: 'Ship it', totalSteps: 3, step: 0 })
  await clock.advance(1_200)
  expect(frames()).toBeGreaterThanOrEqual(9)
  // The sparkle cycles.
  const seen = new Set<string>()
  for (let i = 0; i < 8; i++) {
    seen.add((await band()).row1[0]!)
    await clock.advance(240)
  }
  expect(seen.size).toBeGreaterThan(1)
  await call({ task: 'Ship it', totalSteps: 3, step: 3, done: true })
  await clock.advance(7_000)
  const during = frames()
  expect(during).toBeGreaterThan(9)
  await clock.advance(1_500) // done display over: hidden, timer cancelled
  const atHide = frames()
  await clock.advance(5_000)
  expect(frames()).toBe(atHide)
})

test('done shows a green check and the gradient bar, then the band hides after 8 seconds', async ($, on) => {
  const { clock, band, call } = setup($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await call({ task: 'Ship it', totalSteps: 3, step: 0 })
  await clock.advance(125_000)
  await call({ task: 'Ship it', totalSteps: 3, step: 3, done: true })
  let b = await band()
  expect(b.row1).toBe('✓ Ship it   done in 2m 5s')
  expect(b.runs.every(r => r.color === undefined || r.color !== '#4B5160')).toBe(true)
  await clock.advance(7_000)
  expect((await band()).row1).toBe('✓ Ship it   done in 2m 5s')
  await clock.advance(1_500)
  expect((await band()).all).toBe('ENGINE')
})

test('a step advance fills the new segment smoothly over about 600 ms', () => {
  // Step 0 -> 1 of 4 at t=10_000, the bar having shown 0.5 of step 0 before the call.
  const rec = { task: 'Fill', totalSteps: 4, step: 1, label: '', startedAt: 0, lastStepAt: 10_000, prevStep: 0, prevFill: 0.5, isDone: false, finishedAt: 0 }
  const at0 = barPosition(rec, 10_000, 0)
  const mid = barPosition(rec, 10_300, 0)
  const full = barPosition(rec, 10_600, 0)
  expect(Math.abs(at0 - 0.5)).toBeLessThan(1e-9)
  expect(at0).toBeLessThan(mid)
  expect(mid).toBeLessThan(full)
  expect(full).toBeGreaterThanOrEqual(1)
  expect(full).toBeLessThan(1.95)
})

test('a finished task from an earlier session stays hidden after session.start', async ($, on) => {
  const { clock, band, call } = setup($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await call({ task: 'X', totalSteps: 1, step: 1, done: true })
  await clock.advance(1_000)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await band()).all).toBe('ENGINE')
})

test('prompt.compose adds the section last, session-scoped', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const last = out.sections.at(-1)
  expect(last?.id).toBe('task-progress:progress-bar')
  expect(last?.scope).toBe('session')
  expect(last?.text).toContain('TaskProgress')
})

const run = ($: any, input: Record<string, unknown>) => $.command.run(input)

test('/progress replies with running, done and none', async ($, on) => {
  const { clock, call } = setup($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await run($, { command: 'progress' })).text).toBe('No task in progress.')
  await call({ task: 'Fix login bug', totalSteps: 7, step: 0 })
  await clock.advance(250_000)
  await call({ task: 'Fix login bug', totalSteps: 7, step: 3, label: 'running tests' })
  const running = (await run($, { command: 'progress' })).text
  expect(running).toBe('Fix login bug — step 3 of 7 (43%) · running tests · 4m 10s elapsed · ~6m left')
  await call({ task: 'Fix login bug', totalSteps: 7, step: 7, done: true })
  expect((await run($, { command: 'progress' })).text).toBe('✓ Fix login bug — done in 4m 10s')
  expect(formatReply(null, 0)).toBe('No task in progress.')
})

test('/progress clear hides the band, resets state and stops the ticker', async ($, on) => {
  const { clock, band, call, frames } = setup($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await call({ task: 'Ship it', totalSteps: 3, step: 1 })
  await clock.advance(500)
  expect(frames()).toBeGreaterThan(0)
  expect((await run($, { command: 'progress', args: 'clear' })).text).toBe('Progress bar cleared.')
  expect((await band()).all).toBe('ENGINE')
  const at = frames()
  await clock.advance(3_000)
  expect(frames()).toBe(at)
  expect((await run($, { command: 'progress' })).text).toBe('No task in progress.')
})

test('/progress with another argument prints the usage line', async ($, on) => {
  setup($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await run($, { command: 'progress', args: 'bogus' })).text).toBe('Usage: /progress  ·  /progress clear')
})
