import { expect, test } from 'claude-code/testing'

import { newOpenState, openBrowser, openOnce, pickBrowser, type OpenDeps } from './dash-open'

const PF = 'C:\\Program Files'
const PF86 = 'C:\\Program Files (x86)'
function deps(present: string[], extra: Partial<OpenDeps> = {}): OpenDeps & { ran: string[][] } {
  const ran: string[][] = []
  return {
    ran,
    os: 'windows',
    programFiles: PF,
    programFilesX86: PF86,
    localAppData: 'C:\\LocalApp',
    exists: async p => present.includes(p),
    run: async argv => {
      ran.push(argv)
      return { exitCode: 0, stdout: '' }
    },
    ...extra,
  }
}
const CHROME = `${PF}\\Google\\Chrome\\Application\\chrome.exe`
const EDGE = `${PF86}\\Microsoft\\Edge\\Application\\msedge.exe`

test('chrome is chosen first, even when edge is present', async () => {
  const p = await pickBrowser(deps([CHROME, EDGE]), 'http://127.0.0.1:1/')
  expect(p.browser).toBe('chrome')
  expect(p.argv).toContain(CHROME)
})

test('edge when chrome is missing', async () => {
  const p = await pickBrowser(deps([EDGE]), 'http://127.0.0.1:1/')
  expect(p.browser).toBe('edge')
})

test('chrome found through the registry App Paths key', async () => {
  const reg = 'D:\\Chrome\\chrome.exe'
  const d = deps([reg, EDGE], {
    run: async () => ({ exitCode: 0, stdout: `\r\nHKEY\\App Paths\\chrome.exe\r\n    (Default)    REG_SZ    ${reg}\r\n` }),
  })
  expect((await pickBrowser(d, 'u')).argv).toContain(reg)
})

test('default browser when both are missing', async () => {
  const p = await pickBrowser(deps([]), 'http://127.0.0.1:1/')
  expect(p.browser).toBe('default')
  expect(p.argv[0]).toBe('C:\\Windows\\System32\\rundll32.exe')
})

test('mac order', async () => {
  const d = deps(['/Applications/Microsoft Edge.app'], { os: 'mac' })
  expect((await pickBrowser(d, 'u')).browser).toBe('edge')
})

test('an exe path with cmd metacharacters is skipped for the next browser', async () => {
  for (const ch of ['&', '^', '%', '"', '<', '>', '|']) {
    const dir = `C:\\x${ch}y`
    const p = `${dir}\\Google\\Chrome\\Application\\chrome.exe`
    const pick = await pickBrowser(deps([p, EDGE], { programFiles: dir }), 'u')
    expect(pick.browser).toBe('edge')
    expect(pick.argv.includes(p)).toBe(false)
  }
})

test('a launch that exits non-zero or throws falls to the next browser', async () => {
  const ran: string[][] = []
  const d = deps([CHROME, EDGE], {
    run: async argv => {
      ran.push(argv)
      if (argv.includes(CHROME)) return { exitCode: 1, stdout: '' }
      if (argv.includes(EDGE)) throw new Error('boom')
      return { exitCode: 0, stdout: '' }
    },
  })
  expect(await openBrowser(d, 'u')).toBe('default')
  expect(ran.length).toBe(3)
  const allBad = deps([CHROME], { run: async () => ({ exitCode: 1, stdout: '' }) })
  expect(await openBrowser(allBad, 'u')).toBe('failed')
})

test('only one open per session', async () => {
  const d = deps([CHROME])
  const s = newOpenState()
  expect(await openOnce(s, d, 'u')).toBe('chrome')
  expect(await openOnce(s, d, 'u')).toBe('skipped')
  expect(d.ran.filter(a => a.includes('start')).length).toBe(1)
})
