# Session dashboard (web)

Opened from Claude Code with `/tp-dashboard web` (the command is `/tp-dashboard` because
Claude Code reserves `/dashboard`); `/tp-dashboard web stop` stops this server.

A localhost page for the task-progress mod: progress, plan, agents, background shells,
files changed, tool log, a task board and a "Message Claude" box.

- `server.js` — plain Node (>= 18), no dependencies. The mod starts it as a child process.
- `index.html` — the page, one self-contained file (inline CSS + JS, no CDN).

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
{"type":"command","id":"<uuid>","action":"task.update","status":"done","args":{"id":"t1","status":"done"}}
{"type":"error","message":"..."}          // only when it cannot start, then it exits
```

`id` is always the **command id** — echo it back in `/api/result`. Several actions carry
their own target `id` (agent, shell, task), so the full arguments are under `args`
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
| GET | `/api/events` | browser | SSE: `event: snapshot` on connect (if any) and on each update; `: hb` comment every 15 s |
| POST | `/api/command` | browser | `{action, ...args}`; validated, printed to stdout, held until the mod answers; replies `{ok,message}`; 504 after 10 s |
| POST | `/api/result` | mod | `{id, ok, message}`; resolves the held command (404 if the id is unknown or timed out) |

Actions and their arguments:

| action | args |
|---|---|
| `agent.stop` | `id` |
| `shell.stop` | `id` |
| `step.set` | `k` (integer or string), `status` (pending, running, done, skipped, over) |
| `items.clearFinished` | none (the page sends it from both the Agents and Shells cards; clear both) |
| `task.add` | `title`, `notes?`, `priority?` (low, med, high) |
| `task.update` | `id` and at least one of `title`, `notes`, `status` (todo, doing, blocked, done), `priority`; unknown fields are rejected |
| `task.delete` | `id` |
| `task.send` | `id` |
| `prompt.send` | `text` |
| `orchestrate.set` | `on` (boolean) |

Any other field is dropped before the line is printed.

## Try it by hand

```
node web/server.js --port 7377 --token abc123
curl -s -X POST -H "X-TP-Token: abc123" -H "Content-Type: application/json" \
  --data @snapshot.json http://127.0.0.1:7377/api/snapshot
# open http://127.0.0.1:7377/?t=abc123
```

Commands from the page wait for `/api/result`, so without the mod each one times out after 10 s.
