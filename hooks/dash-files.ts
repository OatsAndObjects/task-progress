// Dashboard file commands: file.read, file.diff, file.open. Every path is confined to the
// session's working directory (lexically AND after symlinks are resolved).

export const FILE_CAP = 500 * 1024
const ENGINE_READ_MAX = 4 * 1024 * 1024
const MARKER = '\n\n[… truncated at 500 KB]'

export type FileResult = { ok: boolean; message: string; data?: Record<string, unknown> }

export type FileDeps = {
  cwd: string
  isWindows: boolean
  env: { localAppData?: string; programFiles?: string; os?: string; neutralDir: string } // neutralDir: a directory never inside the project
  stat: (path: string) => Promise<{ kind: string; size: number; realPath?: string }>
  readBytes: (path: string) => Promise<string> // base64
  exists: (path: string) => Promise<boolean>
  run: (argv: string[], init?: { cwd?: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  sleep: (ms: number) => Promise<void>
  /** Bare name -> resolved absolute path (or null), kept per session. */
  exeCache?: Map<string, string | null>
}

const fail = (message: string): FileResult => ({ ok: false, message })

const slash = (p: string) => p.replace(/\\/g, '/')
const trimEnd = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)
const isAbs = (p: string) => /^[A-Za-z]:\//.test(p) || p.startsWith('/')

/** Folds `.` and `..` out of a slash path; null when `..` climbs above the root. */
function fold(p: string): string | null {
  const m = /^([A-Za-z]:)?(\/)?(.*)$/.exec(p)!
  const root = (m[1] ?? '') + (m[2] ?? '')
  const out: string[] = []
  for (const s of m[3].split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(s)
  }
  return root + out.join('/')
}

const key = (p: string, ci: boolean) => (ci ? p.toLowerCase() : p)
const inside = (child: string, root: string, ci: boolean) => {
  const c = key(child, ci)
  const r = key(trimEnd(root), ci)
  return c === r || c.startsWith(r.endsWith('/') ? r : r + '/')
}

/**
 * Resolves a path from the page to an absolute slash path under cwd, or an error.
 * Lexical check first (no `..` escape, no absolute path elsewhere, no UNC/device paths),
 * then the real path (symlinks followed) must still be under the real cwd.
 */
export async function resolveInCwd(d: FileDeps, input: unknown): Promise<{ abs: string; rel: string } | { error: string }> {
  if (typeof input !== 'string' || !input.trim() || input.length > 1024 || input.includes('\0')) return { error: 'path required' }
  const raw = slash(input.trim())
  if (raw.replace(/^[A-Za-z]:/, '').includes(':')) return { error: 'path is outside the project' } // alternate data streams
  if (raw.startsWith('//') || /^[A-Za-z]:(?!\/)/.test(raw)) return { error: 'path is outside the project' }
  const ci = d.isWindows
  const cwd = fold(trimEnd(slash(d.cwd)))
  if (!cwd) return { error: 'bad working directory' }
  const folded = fold(isAbs(raw) ? raw : cwd + '/' + raw)
  if (!folded || !inside(folded, cwd, ci)) return { error: 'path is outside the project' }
  const joined = cwd + folded.slice(cwd.length) // spell the cwd part exactly as the session does
  let st: { kind: string; size: number; realPath?: string }
  try {
    st = await d.stat(joined)
  } catch {
    return { error: 'file not found' }
  }
  const realCwd = (await d.stat(cwd).catch(() => undefined))?.realPath
  const real = st.realPath ? trimEnd(slash(st.realPath)) : undefined
  if (!real || !realCwd || !inside(real, trimEnd(slash(realCwd)), ci)) return { error: 'path is outside the project' }
  if (st.kind !== 'file') return { error: 'not a file' }
  const rel = joined.length > cwd.length ? joined.slice(cwd.length + 1) : ''
  return { abs: joined, rel }
}

function b64bytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function capText(text: string): { text: string; truncated: boolean } {
  // 500 KB of UTF-8, measured in bytes
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= FILE_CAP) return { text, truncated: false }
  return { text: new TextDecoder().decode(bytes.slice(0, FILE_CAP)).replace(/\uFFFD$/, '') + MARKER, truncated: true }
}

export async function fileRead(d: FileDeps, input: unknown): Promise<FileResult> {
  const r = await resolveInCwd(d, input)
  if ('error' in r) return fail(r.error)
  const st = await d.stat(r.abs)
  if (st.size > ENGINE_READ_MAX) return fail('file too large to preview (over 4 MB)')
  let bytes: Uint8Array
  try {
    bytes = b64bytes(await d.readBytes(r.abs))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'could not read file')
  }
  const head = bytes.subarray(0, 8000)
  if (head.includes(0)) return fail('binary file')
  const truncated = bytes.length > FILE_CAP
  let content = new TextDecoder().decode(truncated ? bytes.subarray(0, FILE_CAP) : bytes)
  if (truncated) content = content.replace(/\uFFFD$/, '') + MARKER
  return {
    ok: true,
    message: truncated ? 'truncated at 500 KB' : 'read',
    data: { content, path: r.rel, truncated, size: bytes.length },
  }
}

const WHERE = 'C:\\Windows\\System32\\where.exe'

/**
 * A bare command name as an absolute path, resolved from the neutral directory (never the project),
 * or null. Anything relative, or inside the project directory (case-insensitive), is refused so a
 * planted executable in the repo can never be launched.
 */
export async function resolveExe(d: FileDeps, name: string): Promise<string | null> {
  const ckey = `${d.cwd}|${name}`
  const cached = d.exeCache?.get(ckey)
  if (cached !== undefined) return cached
  let found: string | null = null
  try {
    const argv = d.isWindows ? [WHERE, name] : ['/bin/sh', '-c', 'command -v "$0"', name]
    const r = await d.run(argv, { cwd: d.env.neutralDir, timeoutMs: 10000 })
    if (r.exitCode === 0) {
      const proj = trimEnd(slash(d.cwd))
      let any: string | null = null
      for (const line of r.stdout.split(/\r?\n/)) {
        const p = line.trim()
        if (!p || p.includes('\0')) continue
        const abs = d.isWindows ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/')
        if (!abs) continue
        if (inside(slash(p), proj, d.isWindows)) continue
        // Windows: extensionless shims (VS Code's `code` sh script) are listed first but cannot be launched
        if (d.isWindows && !/\.(exe|cmd|bat|com)$/i.test(p)) continue
        if (!d.isWindows || /\.(exe|com)$/i.test(p)) {
          found = p
          break
        }
        any = any ?? p // a .cmd/.bat: used only when no .exe is listed
      }
      if (found === null) found = any
    }
  } catch {
    found = null
  }
  if (found !== null) d.exeCache?.set(ckey, found)
  return found
}

export async function fileDiff(d: FileDeps, input: unknown): Promise<FileResult> {
  const r = await resolveInCwd(d, input)
  if ('error' in r) return fail(r.error)
  // git runs from the neutral directory (a repo-planted git.exe must not win), pointed at the project with -C.
  const gitExe = await resolveExe(d, 'git')
  if (!gitExe) return fail('git not found')
  const git = (args: string[]) => d.run([gitExe, '-C', d.cwd, ...args], { cwd: d.env.neutralDir, timeoutMs: 15000 })
  try {
    const tracked = await git(['ls-files', '--error-unmatch', '--', r.rel])
    let out: { exitCode: number; stdout: string; stderr: string }
    if (tracked.exitCode === 0) out = await git(['diff', '--no-ext-diff', '--no-textconv', '--', r.rel])
    else out = await git(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', r.rel]) // exit 1 = differences
    if (out.exitCode > 1) return fail(out.stderr.trim() || 'git diff failed')
    const c = capText(out.stdout)
    return { ok: true, message: c.truncated ? 'truncated at 500 KB' : out.stdout ? 'diff' : 'no changes', data: { diff: c.text } }
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'git diff failed')
  }
}

/** The argv for an editor: an args array, the path is never joined into a shell string. */
export function editorArgv(editor: string, exe: string, abs: string, line?: number): string[] {
  const n = Number.isInteger(line) && (line as number) > 0 ? (line as number) : 0
  if (editor === 'vscode') return n ? [exe, '-g', `${abs}:${n}`] : [exe, '-g', abs]
  return n ? [exe, '--line', String(n), abs] : [exe, abs]
}

export async function editorExecutables(d: FileDeps, editor: string): Promise<string[]> {
  if (editor === 'vscode') {
    if (!d.isWindows) return ['code']
    const local = d.env.localAppData
    const pf = d.env.programFiles ?? 'C:\\Program Files'
    const found: string[] = []
    for (const p of [local ? `${local}\\Programs\\Microsoft VS Code\\Code.exe` : '', `${pf}\\Microsoft VS Code\\Code.exe`]) {
      if (p && (await d.exists(p).catch(() => false))) found.push(p)
    }
    return [...found, 'code']
  }
  if (!d.isWindows) return ['studio.sh', 'studio']
  const pf = d.env.programFiles ?? 'C:\\Program Files'
  const found: string[] = []
  for (const p of [`${pf}\\Android\\Android Studio\\bin\\studio64.exe`, 'C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe']) {
    if (!found.includes(p) && (await d.exists(p).catch(() => false))) found.push(p)
  }
  return [...found, 'studio64', 'studio']
}

export async function fileOpen(d: FileDeps, input: unknown, editor: unknown, line: unknown): Promise<FileResult> {
  if (editor !== 'vscode' && editor !== 'studio') return fail('editor must be vscode or studio')
  const n = line === undefined || line === null || line === '' ? undefined : Number(line)
  if (n !== undefined && !(Number.isInteger(n) && n > 0)) return fail('line must be a positive whole number')
  const r = await resolveInCwd(d, input)
  if ('error' in r) return fail(r.error)
  const abs = d.isWindows ? r.abs.replace(/\//g, '\\') : r.abs
  let lastErr = ''
  for (const cand of await editorExecutables(d, editor)) {
    const exe = /[\\/]/.test(cand) ? cand : await resolveExe(d, cand)
    if (!exe) {
      lastErr = `${cand} not found`
      continue
    }
    let argv = editorArgv(editor, exe, abs, n)
    if (d.isWindows && /\.(cmd|bat)$/i.test(exe)) {
      // batch files need cmd.exe; refuse anything cmd would interpret
      if (argv.some(a => /[&^%"<>|]/.test(a))) {
        lastErr = `${cand} path has characters that are unsafe for cmd.exe`
        continue
      }
      argv = ['C:\\Windows\\System32\\cmd.exe', '/d', '/c', ...argv]
    }
    // The launcher may keep running with the editor; success is "started and did not fail fast".
    // cwd is never the project dir: bare names resolve against cwd first on Windows
    const run = d.run(argv, { cwd: d.env.neutralDir, timeoutMs: 600000 }).then(
      x => (x.exitCode === 0 ? '' : x.stderr.trim() || `exit ${x.exitCode}`),
      e => (e instanceof Error ? e.message : String(e)),
    )
    const early = await Promise.race([run, d.sleep(1500).then(() => null)])
    if (early === null || early === '') return { ok: true, message: `opening in ${editor === 'vscode' ? 'VS Code' : 'Android Studio'}` }
    lastErr = early
  }
  return fail(`could not start ${editor === 'vscode' ? 'VS Code' : 'Android Studio'}: ${lastErr || 'not found'}`)
}

export async function runFileCommand(cmd: Record<string, unknown>, d: FileDeps): Promise<FileResult | null> {
  switch (cmd.action) {
    case 'file.read':
      return fileRead(d, cmd.path)
    case 'file.diff':
      return fileDiff(d, cmd.path)
    case 'file.open':
      return fileOpen(d, cmd.path, cmd.editor, cmd.line)
    default:
      return null
  }
}

const exeCache = new Map<string, string | null>()

/** The real deps, from the engine's `$`. */
export async function filesDeps($: any): Promise<FileDeps> {
  // $.env.get needs a literal name, so every variable is read by its own call.
  const os = await $.env.get('OS')
  const localAppData = await $.env.get('LOCALAPPDATA')
  const programFiles = await $.env.get('ProgramFiles')
  const temp = await $.env.get('TEMP')
  const userProfile = await $.env.get('USERPROFILE')
  const home = await $.env.get('HOME')
  const isWindows = os === 'Windows_NT'
  return {
    cwd: await $.session.cwd(),
    isWindows,
    env: { localAppData, programFiles, os, neutralDir: temp || userProfile || home || (isWindows ? 'C:\\Windows' : '/') },
    stat: (p: string) => $.fs.stat(p, { resolve: true }),
    readBytes: async (p: string) => (await $.fs.read(p, { as: 'bytes' })).base64,
    exists: (p: string) => $.fs.exists(p),
    run: (argv: string[], init?: any) => $.process.run(argv, init),
    sleep: (ms: number) => $.clock.sleep(ms),
    exeCache,
  }
}
