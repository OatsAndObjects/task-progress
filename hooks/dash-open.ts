// Open the web dashboard in a browser: Chrome first, then Edge, then the system default.
// Pure logic over injected deps so the order can be tested without a machine.

export type OpenDeps = {
  os: 'windows' | 'mac' | 'linux'
  // Windows folders (already read from literal env names); empty when unset.
  programFiles: string
  programFilesX86: string
  localAppData: string
  exists: (path: string) => Promise<boolean>
  run: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>
}

const CMD = 'C:\\Windows\\System32\\cmd.exe'
const REG = 'C:\\Windows\\System32\\reg.exe'
const RUNDLL = 'C:\\Windows\\System32\\rundll32.exe'
const APP_PATHS = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe'

function join(dir: string, rest: string): string {
  return dir ? `${dir.replace(/[\\/]+$/, '')}\\${rest}` : ''
}

export async function findChromeWindows(d: OpenDeps): Promise<string | null> {
  const rel = 'Google\\Chrome\\Application\\chrome.exe'
  for (const base of [d.programFiles, d.programFilesX86, d.localAppData]) {
    const p = join(base, rel)
    if (p && (await d.exists(p))) return p
  }
  try {
    const r = await d.run([REG, 'query', APP_PATHS, '/ve'])
    const m = /REG_SZ\s+(.+?\.exe)\s*$/im.exec(r.stdout ?? '')
    if (r.exitCode === 0 && m && (await d.exists(m[1]!.trim()))) return m[1]!.trim()
  } catch {
    // registry not reachable
  }
  return null
}

export async function findEdgeWindows(d: OpenDeps): Promise<string | null> {
  const rel = 'Microsoft\\Edge\\Application\\msedge.exe'
  for (const base of [d.programFilesX86, d.programFiles]) {
    const p = join(base, rel)
    if (p && (await d.exists(p))) return p
  }
  return null
}

type Browser = 'chrome' | 'edge' | 'default'

// cmd.exe would reinterpret these in an exe path (`start`): such a path is never launched.
const UNSAFE_EXE = /[&^%"<>|]/

// Every way to open `url`, best first, each with the browser's name.
export async function browserCandidates(d: OpenDeps, url: string): Promise<{ browser: Browser; argv: string[] }[]> {
  const out: { browser: Browser; argv: string[] }[] = []
  if (d.os === 'windows') {
    // `start` returns at once, so the browser outlives the 30 s run timeout.
    const chrome = await findChromeWindows(d)
    if (chrome && !UNSAFE_EXE.test(chrome)) out.push({ browser: 'chrome', argv: [CMD, '/c', 'start', '', chrome, url] })
    const edge = await findEdgeWindows(d)
    if (edge && !UNSAFE_EXE.test(edge)) out.push({ browser: 'edge', argv: [CMD, '/c', 'start', '', edge, url] })
    out.push({ browser: 'default', argv: [RUNDLL, 'url.dll,FileProtocolHandler', url] })
    return out
  }
  if (d.os === 'mac') {
    if (await d.exists('/Applications/Google Chrome.app')) out.push({ browser: 'chrome', argv: ['open', '-a', 'Google Chrome', url] })
    if (await d.exists('/Applications/Microsoft Edge.app')) out.push({ browser: 'edge', argv: ['open', '-a', 'Microsoft Edge', url] })
    out.push({ browser: 'default', argv: ['open', url] })
    return out
  }
  const bg = (bin: string) => ['sh', '-c', '"$0" "$1" >/dev/null 2>&1 &', bin, url]
  const has = async (bin: string) => (await d.run(['sh', '-c', `command -v ${bin}`]).catch(() => ({ exitCode: 1, stdout: '' }))).exitCode === 0
  for (const bin of ['google-chrome', 'google-chrome-stable']) {
    if (await has(bin)) out.push({ browser: 'chrome', argv: bg(bin) })
  }
  if (await has('microsoft-edge')) out.push({ browser: 'edge', argv: bg('microsoft-edge') })
  out.push({ browser: 'default', argv: bg('xdg-open') })
  return out
}

// The argv that opens `url` in the best browser, with the browser's name.
export async function pickBrowser(d: OpenDeps, url: string): Promise<{ browser: Browser; argv: string[] }> {
  return (await browserCandidates(d, url))[0]!
}

// Tries each browser in turn; a launch that throws or exits non-zero moves on to the next.
export async function openBrowser(d: OpenDeps, url: string): Promise<Browser | 'failed'> {
  try {
    for (const c of await browserCandidates(d, url)) {
      try {
        const r = await d.run(c.argv)
        if (r && r.exitCode === 0) return c.browser
      } catch {
        // try the next browser
      }
    }
  } catch {
    // fall through
  }
  return 'failed'
}

// Once per session: the first call opens, later ones do nothing.
export function newOpenState(): { opened: boolean } {
  return { opened: false }
}
export async function openOnce(state: { opened: boolean }, d: OpenDeps, url: string): Promise<Browser | 'failed' | 'skipped'> {
  if (state.opened) return 'skipped'
  state.opened = true
  return openBrowser(d, url)
}
