import { expect, mock, test } from 'claude-code/testing'

import { bar, barPosition, buildBar, formatElapsed, formatEta, formatReply, bandMood, overlayWalker, confettiRow, formatStatus, gradient, segmentCount, segmentWidth } from './register'

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
    // The bar starts after the meta text (3 leading spaces) and, when done, the confetti row.
    const meta = texts.findIndex(t => t.text.startsWith('   '))
    const at = meta < 0 ? -1 : meta + 1 + (texts[meta + 1] && texts[meta + 1]!.text.length > 10 && !texts[meta + 1]!.text.includes('━') && texts[meta + 1]!.color === '#D97757' ? 1 : 0)
    // Newer engines keep their own band row under the plugin's rows: leave it out of the bar.
    const barRuns = at < 0 ? [] : texts.slice(at).filter(t => t.text !== 'ENGINE')
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
  expect(b.row1).toBe('Fix login bug   0/7 · estimating…')
  expect(b.row2).toHaveLength(41)
  expect(/[✦✧⋆]/.test(b.row2)).toBe(true)
  await clock.advance(90_000)
  await call({ task: 'Fix login bug', totalSteps: 7, step: 3, label: 'running tests' })
  await clock.advance(1_000)
  b = await band()
  expect(b.row1).toMatch(/^Fix login bug · running tests   3\/7 · ~2m left$/)
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
  // A twinkling star (no mascot) walks on the bar, not in the header.
  const w = await band()
  expect(w.row1.startsWith('Ship it')).toBe(true)
  expect(/[✦✧⋆]/.test(w.row2)).toBe(true)
  expect(/[▐▛▜▌▝▘]/.test(w.all)).toBe(false)
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
  expect(b.row1.startsWith('Ship it   done in 2m 5s')).toBe(true)
  expect(b.row1.length).toBeGreaterThan('Ship it   done in 2m 5s'.length) // confetti row
  expect(/✓ [✦⋆]$/.test(b.row2)).toBe(true)
  expect(b.runs.every(r => r.color === undefined || r.color !== '#4B5160')).toBe(true)
  await clock.advance(7_000)
  expect((await band()).row1.startsWith('Ship it   done in 2m 5s')).toBe(true)
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

const rec = (o: Record<string, unknown> = {}) => ({ task: 'T', totalSteps: 4, step: 1, label: '', startedAt: 0, lastStepAt: 10_000, prevStep: 0, prevFill: 0, isDone: false, finishedAt: 0, ...o }) as any
const text = (cells: { ch: string }[]) => cells.map(c => c.ch).join('')

test('bandMood picks each mood', () => {
  expect(bandMood(rec({ isDone: true }), { waitingOnUser: true }, 20_000)).toBe('done')
  expect(bandMood(rec(), { waitingOnUser: true }, 20_000)).toBe('waiting')
  // 10s per step x 4 = 40s ETA; at 50s we are over
  expect(bandMood(rec(), { waitingOnUser: false }, 50_000)).toBe('over')
  // step 0: no ETA, 100s since start -> thinking
  expect(bandMood(rec({ step: 0, lastStepAt: 0 }), { waitingOnUser: false }, 100_000)).toBe('thinking')
  expect(bandMood(rec({ step: 0, lastStepAt: 0 }), { waitingOnUser: false }, 5_000)).toBe('working')
  expect(bandMood(rec(), { waitingOnUser: false }, 20_000)).toBe('working')
  // on pace but quiet for >90s after a step
  expect(bandMood(rec({ totalSteps: 20, step: 10, startedAt: 0, lastStepAt: 600_000 }), { waitingOnUser: false }, 700_000)).toBe('thinking')
})

test('overlayWalker keeps the bar length at every position and size', () => {
  for (const total of [1, 3, 7, 12, 20]) {
    const n = segmentCount(total)
    for (const pos of [0, 0.3, n / 2, n - 0.2, n]) {
      for (const mood of ['working', 'thinking', 'waiting', 'over', 'done'] as const) {
        const base = buildBar(total, pos, 3, mood === 'done')
        const out = overlayWalker(base, pos, total, 3, mood)
        expect(out.length).toBe(base.length)
      }
    }
  }
  const base = buildBar(7, 7, 0, true)
  expect(/✓ [✦⋆]$/.test(text(overlayWalker(base, 7, 7, 0, 'done')))).toBe(true)
  const mid = text(overlayWalker(buildBar(4, 2, 0, false), 2, 4, 0, 'working'))
  expect(/[✦✧⋆]/.test(mid)).toBe(true)
  expect(mid.search(/[✦✧⋆]/)).toBeGreaterThan(0)
  expect(/^[✦✧⋆]/.test(text(overlayWalker(buildBar(4, 0, 0, false), 0, 4, 0, 'working')))).toBe(true)
})

test('confettiRow is exactly the bar width', () => {
  for (const w of [0, 1, 20, 47]) expect(confettiRow(5, w).length).toBe(w)
  expect(confettiRow(0, 30)).not.toBe(confettiRow(3, 30))
})

test('band never shows the mascot: no ▐▛▜▌▝▘ in any frame, only star / dot / check markers', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('tool.call', () => ({ result: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a1' }))
  on('turn.complete', (_: any, e: any) => ({ text: String(e.answer ?? '') }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const lines = async () => {
    const ui = await $.ui.mount(BAND)
    const t: string[] = (await ui.findAll({ type: 'Text' })).map((x: any) => x.text)
    await ui.unmount()
    return t
  }
  const MASCOT = /[▐▛▜▌▝▘]/
  const frameText = async () => (await lines()).join('|')
  await $.tool.call({ tool: TOOL, task: 'Ship it', totalSteps: 3, step: 0 })
  expect(MASCOT.test(await frameText())).toBe(false)
  await $.agent.spawn({ prompt: '[budget: 4m step: 1]\nx', description: 'a', subagentType: 'task-progress:executor' })
  for (let k = 0; k < 40; k++) {
    const f = await frameText()
    expect(MASCOT.test(f)).toBe(false)
    expect(/[✦✧⋆·]/.test(f)).toBe(true)
    await clock.advance(250)
  }
  await $.turn.complete({ agentId: 'a1', reason: 'answer', answer: 'x' } as any)
  for (let k = 0; k < 14; k++) {
    const f = await frameText()
    expect(MASCOT.test(f)).toBe(false) // done window: green check, no heads
    await clock.advance(250)
  }
  expect(MASCOT.test(await frameText())).toBe(false)
})
