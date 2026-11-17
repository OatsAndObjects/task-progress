import { expect, test } from 'claude-code/testing'

import { FILE_CAP, capText, editorArgv, fileDiff, fileOpen, fileRead, resolveExe, resolveInCwd } from './dash-files'
import type { FileDeps } from './dash-files'

const b64 = (s: string) => btoa(s)
const CODE = 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd'
const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe'
const WHERE_OUT: Record<string, string> = { code: `${CODE}\r\n`, git: `${GIT}\r\n`, studio64: 'C:\\tools\\studio64.exe\r\n' }

function deps(over: Partial<FileDeps> = {}, files: Record<string, string> = {}, links: Record<string, string> = {}): any {
  const calls: string[][] = []
  const cwds: (string | undefined)[] = []
  return {
    cwd: 'C:\\proj\\app',
    isWindows: true,
    env: { localAppData: 'C:\\Users\\u\\AppData\\Local', neutralDir: 'C:\\Users\\u' },
    cwds,
    stat: async (p: string) => {
      if (p === 'C:/proj/app') return { kind: 'dir', size: 0, realPath: 'C:\\proj\\app' }
      if (p in files) return { kind: 'file', size: files[p].length, realPath: (links[p] ?? p).replace(/\//g, '\\') }
      throw new Error('ENOENT')
    },
    readBytes: async (p: string) => b64(files[p]),
    exists: async () => false,
    run: async (argv: string[], init?: any) => {
      if (argv[0].endsWith('where.exe')) return { exitCode: 0, stdout: WHERE_OUT[argv[1]] ?? '', stderr: '' }
      calls.push(argv)
      cwds.push(init?.cwd)
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    sleep: async () => {},
    calls,
    ...over,
  }
}

test('paths outside the working directory are refused', async () => {
  const f = { 'C:/proj/app/a.txt': 'hi', 'C:/proj/other/x.txt': 'no', 'C:/proj/appx/y.txt': 'no' }
  const d = deps({}, f)
  for (const bad of ['../other/x.txt', '..\\other\\x.txt', 'sub/../../other/x.txt', 'C:\\proj\\other\\x.txt', 'C:/proj/other/x.txt', 'C:/proj/appx/y.txt', '/etc/passwd', '\\\\server\\share\\f', 'D:file', 'a.txt:stream', 'C:/proj/app/a.txt:x:$DATA', '', '  ', 'a\u0000b']) {
    const r: any = await resolveInCwd(d, bad)
    expect(r.error).toBeTruthy()
  }
  expect(((await resolveInCwd(d, 'a.txt')) as any).abs).toBe('C:/proj/app/a.txt')
  expect(((await resolveInCwd(d, '.\\a.txt')) as any).rel).toBe('a.txt')
  expect(((await resolveInCwd(d, 'c:\\PROJ\\app\\a.txt')) as any).rel).toBe('a.txt')
  expect(((await resolveInCwd(d, 'x/../a.txt')) as any).abs).toBe('C:/proj/app/a.txt')
})

test('a symlink that leaves the working directory is refused', async () => {
  const d = deps({}, { 'C:/proj/app/link.txt': 'secret' }, { 'C:/proj/app/link.txt': 'C:/secret/real.txt' })
  expect(((await resolveInCwd(d, 'link.txt')) as any).error).toBe('path is outside the project')
  expect((await fileRead(d, 'link.txt')).ok).toBe(false)
})

test('file.read returns text, flags binary, and caps at 500 KB', async () => {
  const d = deps({}, { 'C:/proj/app/a.txt': 'hello', 'C:/proj/app/b.bin': 'ab\u0000cd', 'C:/proj/app/big.txt': 'x'.repeat(FILE_CAP + 10) })
  const a = await fileRead(d, 'a.txt')
  expect(a.ok).toBe(true)
  expect((a.data as any).content).toBe('hello')
  expect((await fileRead(d, 'b.bin')).message).toBe('binary file')
  const big = await fileRead(d, 'big.txt')
  expect(big.ok).toBe(true)
  expect(big.message).toContain('truncated')
  expect((big.data as any).content.startsWith('x'.repeat(FILE_CAP))).toBe(true)
  expect((big.data as any).content.length).toBeLessThan(FILE_CAP + 60)
  expect(capText('y'.repeat(FILE_CAP)).truncated).toBe(false)
  expect(capText('y'.repeat(FILE_CAP + 1)).truncated).toBe(true)
})

test('file.diff diffs tracked files and shows untracked ones as added', async () => {
  const seen: string[][] = []
  const d = deps(
    {
      run: async (argv: string[], init?: any) => {
        if (argv[0].endsWith('where.exe')) return { exitCode: 0, stdout: GIT, stderr: '' }
        seen.push(argv)
        expect(init.cwd).toBe('C:\\Users\\u') // never the project
        if (argv[3] === 'ls-files') return { exitCode: 1, stdout: '', stderr: '' }
        return { exitCode: 1, stdout: 'DIFF', stderr: '' }
      },
    },
    { 'C:/proj/app/t.txt': 'a' },
  )
  const r = await fileDiff(d, 't.txt')
  expect(r.ok).toBe(true)
  expect((r.data as any).diff).toBe('DIFF')
  expect(seen[1]).toEqual([GIT, '-C', 'C:\\proj\\app', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', 't.txt'])
  expect((await fileDiff(d, '../x')).ok).toBe(false)
})

test('editor argv arrays, with and without a line', () => {
  expect(editorArgv('vscode', 'code', 'C:\\p\\a b&c.ts', 12)).toEqual(['code', '-g', 'C:\\p\\a b&c.ts:12'])
  expect(editorArgv('vscode', 'code', 'C:\\p\\a.ts')).toEqual(['code', '-g', 'C:\\p\\a.ts'])
  expect(editorArgv('studio', 'studio64', 'C:\\p\\a.kt', 5)).toEqual(['studio64', '--line', '5', 'C:\\p\\a.kt'])
  expect(editorArgv('studio', 'studio64', 'C:\\p\\a.kt')).toEqual(['studio64', 'C:\\p\\a.kt'])
})

test('file.open validates, confines, and spawns the editor', async () => {
  const d = deps({}, { 'C:/proj/app/a.ts': 'x' })
  expect((await fileOpen(d, 'a.ts', 'vim', 1)).ok).toBe(false)
  expect((await fileOpen(d, 'a.ts', 'vscode', 0)).ok).toBe(false)
  expect((await fileOpen(d, '../a.ts', 'vscode', 1)).ok).toBe(false)
  expect(d.calls.length).toBe(0)
  const r = await fileOpen(d, 'a.ts', 'vscode', 3)
  expect(r.ok).toBe(true)
  expect(d.calls[0]).toEqual(['C:\\Windows\\System32\\cmd.exe', '/d', '/c', CODE, '-g', 'C:\\proj\\app\\a.ts:3'])
  const s = deps({ exists: async (p: string) => p.endsWith('studio64.exe') }, { 'C:/proj/app/a.ts': 'x' })
  expect((await fileOpen(s, 'a.ts', 'studio', 9)).ok).toBe(true)
  expect(s.calls[0]).toEqual(['C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe', '--line', '9', 'C:\\proj\\app\\a.ts'])
})

test('bare editor names resolve through where.exe from the neutral dir; project-dir and relative results are refused', async () => {
  const whereCalls: { argv: string[]; cwd?: string }[] = []
  const mk = (out: string, cache?: Map<string, string | null>) =>
    deps(
      {
        exeCache: cache,
        run: async (argv: string[], init?: any) => {
          if (argv[0] === 'C:\\Windows\\System32\\where.exe') {
            whereCalls.push({ argv, cwd: init?.cwd })
            return { exitCode: 0, stdout: out, stderr: '' }
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      },
      { 'C:/proj/app/a.ts': 'x' },
    )
  // a planted copy inside the project (any case) and a relative hit are skipped; the next absolute one wins
  expect(await resolveExe(mk('C:\\PROJ\\app\\code.exe\r\ncode.cmd\r\n.\\code.bat\r\nC:\\real\\code.exe\r\n'), 'code')).toBe('C:\\real\\code.exe')
  expect(whereCalls[0]).toEqual({ argv: ['C:\\Windows\\System32\\where.exe', 'code'], cwd: 'C:\\Users\\u' })
  expect(await resolveExe(mk('C:\\proj\\app\\sub\\code.exe\r\n'), 'code')).toBeNull()
  expect(await resolveExe(mk('code.exe\r\n'), 'code')).toBeNull()
  // nothing resolvable -> nothing is launched
  const bad = mk('C:\\proj\\app\\code.exe\r\n')
  const launched: string[][] = []
  const run = bad.run
  bad.run = async (argv: string[], init?: any) => {
    if (!argv[0].endsWith('where.exe')) launched.push(argv)
    return run(argv, init)
  }
  expect((await fileOpen(bad, 'a.ts', 'vscode', 1)).ok).toBe(false)
  expect(launched).toEqual([])
  // cached per session
  const cache = new Map<string, string | null>()
  const n = whereCalls.length
  const c = mk('C:\\real\\code.exe\r\n', cache)
  await resolveExe(c, 'code')
  await resolveExe(c, 'code')
  expect(whereCalls.length).toBe(n + 1)
})

test('non-windows bare names use command -v through /bin/sh from the neutral dir', async () => {
  const seen: { argv: string[]; cwd?: string }[] = []
  const d = deps({
    isWindows: false,
    cwd: '/home/u/proj',
    env: { neutralDir: '/tmp' },
    run: async (argv: string[], init?: any) => {
      seen.push({ argv, cwd: init?.cwd })
      return { exitCode: 0, stdout: '/home/u/proj/bin/code\n/usr/bin/code\n', stderr: '' }
    },
  })
  expect(await resolveExe(d, 'code')).toBe('/usr/bin/code')
  expect(seen[0]).toEqual({ argv: ['/bin/sh', '-c', 'command -v "$0"', 'code'], cwd: '/tmp' })
})

test('editors launch from a neutral directory, never the project', async () => {
  const d = deps({}, { 'C:/proj/app/a.ts': 'x' })
  await fileOpen(d, 'a.ts', 'vscode', 3)
  expect(d.cwds[0]).toBe('C:\\Users\\u')
  expect(d.cwds.includes('C:\\proj\\app')).toBe(false)
})

test('where.exe: extensionless shims are skipped and .exe beats .cmd', async () => {
  const mk = (out: string) => deps({ run: async () => ({ exitCode: 0, stdout: out, stderr: '' }) })
  const C = 'C:\\Program Files\\Microsoft VS Code\\bin\\'
  expect(await resolveExe(mk(`${C}code\r\n${C}code.cmd\r\n`), 'code')).toBe(`${C}code.cmd`)
  expect(await resolveExe(mk(`${C}code\r\n${C}code.cmd\r\nC:\\x\\code.exe\r\n`), 'code')).toBe('C:\\x\\code.exe')
  expect(await resolveExe(mk(`${C}code\r\n`), 'code')).toBeNull()
})

test('a .cmd editor goes through cmd.exe /c; metacharacters in the path are refused', async () => {
  const d = deps({}, { 'C:/proj/app/a.ts': 'x' })
  expect((await fileOpen(d, 'a.ts', 'vscode', 3)).ok).toBe(true)
  expect(d.calls[0]).toEqual(['C:\\Windows\\System32\\cmd.exe', '/d', '/c', CODE, '-g', 'C:\\proj\\app\\a.ts:3'])
  const evil = deps({ cwd: 'C:\\proj\\a&b' }, { 'C:/proj/a&b/a.ts': 'x' })
  evil.stat = async (p: string) => (p === 'C:/proj/a&b' ? { kind: 'dir', size: 0, realPath: 'C:\\proj\\a&b' } : { kind: 'file', size: 1, realPath: p.replace(/\//g, '\\') })
  const r = await fileOpen(evil, 'a.ts', 'vscode', 1)
  expect(r.ok).toBe(false)
  expect(evil.calls).toEqual([])
})

test('exe cache is per project and name; misses are not cached', async () => {
  const cache = new Map<string, string | null>()
  let n = 0
  let out = ''
  const run = async () => (n++, { exitCode: 0, stdout: out, stderr: '' })
  await resolveExe(deps({ exeCache: cache, run }), 'code') // miss
  out = 'C:\\real\\code.exe\r\n'
  expect(await resolveExe(deps({ exeCache: cache, run }), 'code')).toBe('C:\\real\\code.exe')
  expect(n).toBe(2)
  await resolveExe(deps({ exeCache: cache, run }), 'code')
  expect(n).toBe(2)
  await resolveExe(deps({ exeCache: cache, run, cwd: 'C:\\other' }), 'code')
  expect(n).toBe(3)
})
