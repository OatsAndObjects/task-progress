import { expect, test } from 'claude-code/testing'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'

const TOKEN = '0123456789abcdef0123456789abcdef'
const SERVER = join(import.meta.dir ?? __dirname, '..', 'web', 'server.js')

type Srv = { proc: ChildProcessWithoutNullStreams; base: string; lines: string[] }

async function start(port: number): Promise<Srv> {
  const proc = spawn(process.execPath, [SERVER, '--port', String(port), '--token', TOKEN], { stdio: 'pipe' })
  const lines: string[] = []
  let ready: (p: number) => void = () => {}
  const got = new Promise<number>(r => (ready = r))
  let buf = ''
  proc.stdout.on('data', d => {
    buf += String(d)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i)
      buf = buf.slice(i + 1)
      lines.push(l)
      try {
        const o = JSON.parse(l)
        if (o.type === 'ready') ready(o.port)
      } catch {}
    }
  })
  const p = await got
  return { proc, base: `http://127.0.0.1:${p}`, lines }
}

const H = { 'X-TP-Token': TOKEN, 'Content-Type': 'application/json' }
const post = (s: Srv, path: string, body: unknown, headers: Record<string, string> = H) =>
  fetch(s.base + path, { method: 'POST', headers, body: JSON.stringify(body) })

// Read the SSE stream until `until(text)` is true (or 3 s), then abort.
async function readStream(s: Srv, qs: string, until: (t: string) => boolean, headers: Record<string, string> = {}) {
  const ac = new AbortController()
  const r = await fetch(`${s.base}/api/stream?${qs}`, { signal: ac.signal, headers })
  let text = ''
  if (r.status === 200) {
    const reader = r.body!.getReader()
    const dec = new TextDecoder()
    const timer = setTimeout(() => ac.abort(), 3000)
    try {
      while (!until(text)) {
        const { value, done } = await reader.read()
        if (done) break
        text += dec.decode(value)
      }
    } catch {}
    clearTimeout(timer)
    ac.abort()
  }
  return { status: r.status, text }
}

const seqs = (t: string) => [...t.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]))

test('web server: token required on POST /api/events and GET /api/stream', async () => {
  const s = await start(7411)
  try {
    expect((await post(s, '/api/events', { type: 'x' }, { 'Content-Type': 'application/json' })).status).toBe(401)
    expect((await fetch(`${s.base}/api/stream`)).status).toBe(401)
    expect((await fetch(`${s.base}/api/stream?t=wrong`)).status).toBe(401)
    expect((await post(s, '/api/events', 'nope')).status).toBe(400)
    expect((await post(s, '/api/events', [1])).status).toBe(400)
  } finally {
    s.proc.kill()
  }
})

test('web server: ring buffer keeps the newest 2000 events, seq keeps counting', async () => {
  const s = await start(7412)
  try {
    const batch = Array.from({ length: 2001 }, (_, i) => ({ type: 'n', i }))
    const r = await post(s, '/api/events', batch)
    expect(r.status).toBe(200)
    const all = await readStream(s, `t=${TOKEN}`, t => seqs(t).length >= 2000)
    const ids = seqs(all.text)
    expect(ids.length).toBe(2000)
    expect(ids[0]).toBe(2) // event 1 was dropped
    expect(ids[ids.length - 1]).toBe(2001)
  } finally {
    s.proc.kill()
  }
})

test('web server: stream replays after ?since and Last-Event-ID, pushes live events and snapshots', async () => {
  const s = await start(7413)
  try {
    for (let i = 0; i < 5; i++) await post(s, '/api/events', { type: 'e', i })
    await post(s, '/api/snapshot', { hello: 'snap' })
    const a = await readStream(s, `t=${TOKEN}&since=3`, t => seqs(t).length >= 2)
    expect(seqs(a.text)).toEqual([4, 5])
    expect(a.text).toContain('event: snapshot')
    const b = await readStream(s, `t=${TOKEN}`, t => seqs(t).length >= 1, { 'Last-Event-ID': '4' })
    expect(seqs(b.text)).toEqual([5])
    // a seq from a previous server run (higher than anything here) replays everything
    const c = await readStream(s, `t=${TOKEN}&since=999`, t => seqs(t).length >= 5)
    expect(seqs(c.text)).toEqual([1, 2, 3, 4, 5])
    // live
    const live = readStream(s, `t=${TOKEN}&since=5`, t => seqs(t).length >= 1)
    await new Promise(r => setTimeout(r, 200))
    await post(s, '/api/events', { type: 'live' })
    const l = await live
    expect(seqs(l.text)).toEqual([6])
    expect(l.text).toContain('"type":"live"')
  } finally {
    s.proc.kill()
  }
})

test('web server: COMMANDS table rejects unknown actions and keeps existing validation', async () => {
  const s = await start(7414)
  try {
    const bad = await post(s, '/api/command', { action: 'nope.nothing' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { message: string }).message).toBe('unknown action')
    expect((await post(s, '/api/command', { action: 'constructor' })).status).toBe(400)
    // validation errors come from the existing validators
    expect((await post(s, '/api/command', { action: 'cube.approve' })).status).toBe(400)
    expect((await post(s, '/api/command', { action: 'orchestrate.set', on: 'yes' })).status).toBe(400)
    // a valid command reaches the mod (stdout command line) and times out only because nobody answers
    const pending = post(s, '/api/command', { action: 'cube.approve', id: ' c1 ' }).catch(() => null)
    await new Promise(r => setTimeout(r, 300))
    const cmd = s.lines.map(l => JSON.parse(l)).find(o => o.type === 'command')
    expect(cmd.action).toBe('cube.approve')
    expect(cmd.args).toEqual({ id: 'c1' })
    await post(s, '/api/result', { id: cmd.id, ok: true, message: 'done' })
    expect(((await (await pending)!.json()) as { ok: boolean }).ok).toBe(true)
  } finally {
    s.proc.kill()
  }
})
