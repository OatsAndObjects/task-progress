# Session dashboard (web)

Opened from Claude Code with `/tp-dashboard web` (the command is `/tp-dashboard` because
Claude Code reserves `/dashboard`); `/tp-dashboard web stop` stops this server.

A localhost dashboard for the task-progress mod with two screens: Cubes (the plan as
approval cubes: approve, edit, review, ask) and Usage.

- `server.js` — plain Node (>= 18), no dependencies. The mod starts it as a child process.
- `app/` — the page (`index.html`, `core.js`, `cubes.js`, `usage.js`, `demo.js`, `styles.css`), served at `/` (`/v2` redirects there; `?demo=1` shows sample data).

## Start

```
node web/server.js --port 7377 --token <hex>
```

Binds 127.0.0.1 only. If the port is busy it tries the next ones (7378..7397 for the
default port, else up to +20). Its stdin is not watched (the host spawns it with stdin already
closed). It exits when no `POST /api/snapshot` has come for 35 s after the first one (the mod
re-POSTs every 10 s), 60 s after start if none ever came, on SIGTERM/SIGINT, or when writing
to stdout fails (parent gone).
Open `http://127.0.0.1:<port>/?t=<token>`; the page keeps the token in sessionStorage and
removes it from the address bar.

## stdout protocol (server -> mod)

stdout carries only JSON lines; logs go to stderr.

```
{"type":"ready","port":7377}
{"type":"command","id":"<uuid>","action":"cube.approve","args":{"id":"c1"}}
{"type":"error","message":"..."}          // only when it cannot start, then it exits
```

`id` is always the **command id** — echo it back in `/api/result`. Several actions carry
their own target `id` (the cube), so the full arguments are under `args`
(canonical: read the target as `args.id`). The other arguments are also flattened onto the
line for convenience; the target `id` is not, because it would clash.

## HTTP

Every `/api/*` call needs the token: header `X-TP-Token` or `?t=`. Wrong token -> 401.
Host must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard) and a browser
`Origin`, when sent, must be the same origin -> otherwise 403. Bodies are limited to 1 MB (413).

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/` | browser | the page (no token needed; it holds no data) |
| POST | `/api/snapshot` | mod | full Snapshot JSON; kept and pushed to browsers |
| GET | `/api/snapshot` | any | latest snapshot, or `null` |
| GET | `/api/stream` | browser | SSE: `event: snapshot` on connect (if any) and on each update; `: hb` comment every 15 s; slow clients (2 MB backlog) are dropped |
| POST | `/api/command` | browser | `{action, ...args}`; validated, printed to stdout, held until the mod answers; replies `{ok,message}`; 504 after 10 s |
| POST | `/api/result` | mod | `{id, ok, message}`; resolves the held command (404 if the id is unknown or timed out) |

Actions and their arguments:

| action | args |
|---|---|
| `cube.approve` | `id` |
| `cube.approveAll` | none (approves every `proposed` cube) |
| `cube.reject` | `id`, `note?` |
| `cube.update` | `id` and at least one of `title`, `actionText`, `flow`, `after`, `doneWhen`, `files`, `minutes`; unknown fields rejected |
| `cube.requestChange` | `id`, `note` (required) — Claude rewrites the cube and it comes back as `revising` then `proposed` |
| `cube.add` | `title`, `actionText`, `flow`, `doneWhen`, `minutes`, `after?`, `files?` |
| `cube.delete` | `id` |
| `cube.move` | `id`, `after` (the full new list of cube ids it waits for) |
| `cubes.gate` | `on` (boolean) — when on, cubes need approval before they run |

Cube field limits: ids <= 40 chars; `title` <= 300; `actionText` <= 2000 (the cube's sentence; it is `actionText` on the wire because `action` names the command, and Claude Code's cube object still calls it `action`); `doneWhen` <= 1000;
`flow` 2-6 strings of <= 300 chars; `after` / `files` lists of strings; `minutes` a number 1..10.
Strings are trimmed. A cube cannot wait for itself. Whether a cube is "atomic" is the mod's call:
it answers `/api/result` with `{ok:false, message:"not atomic: split it"}` and the page shows
that message inside the edit drawer.

### `cubes` snapshot field

`cubes` is `null` (no plan; the page shows an empty state) or

```
{ task, gate: boolean, cubes: Cube[], lanes: string[][] }   // lanes = cube ids by dependency depth, lane 0 = no deps
Cube = { id, title, action, flow: string[], after: string[], doneWhen, files?: string[], minutes,
         status: proposed|approved|queued|running|done|failed|skipped|rejected|revising,
         note?, editedBy?: 'user'|'claude', version, agentId?, startedAt?, endedAt? }
```

The Cubes section sits above Plan: lanes are columns (stacked with "then" connectors on phones),
dependency arrows are an SVG overlay, clicking a cube highlights its upstream and downstream
chain, and dragging a cube onto another sends `cube.move` (adds that cube to its `after`).

Any other field is dropped before the line is printed.

## Try it by hand

```
node web/server.js --port 7377 --token abc123
curl -s -X POST -H "X-TP-Token: abc123" -H "Content-Type: application/json" \
  --data @snapshot.json http://127.0.0.1:7377/api/snapshot
# open http://127.0.0.1:7377/?t=abc123
```

Commands from the page wait for `/api/result`, so without the mod each one times out after 10 s.
