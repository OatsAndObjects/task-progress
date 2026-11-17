# task-progress

A Claude Code plugin (v0.6.0) that shows an estimated progress bar for the current task in a band above the prompt.

- `TaskProgress` tool: the model reports task name, estimated total steps, steps done and a label; the band renders the bar.
- `/progress` command: shows the current progress as plain text; `/progress clear` clears it.

## Orchestrator mode (0.5.0)

On by default; `/orchestrate on|off|status`. When off, the plugin behaves like 0.4.0.

**One orchestrator, small executors.** The main session plans and reviews; the `task-progress:executor` agent (Sonnet) executes one step each and ends with a fixed report (status, what changed, how verified, blockers). A short protocol is added to the system prompt while the mode is on; the full text is the `task-progress:orchestrate` skill. `TaskPlan` registers the plan (steps with minutes) and seeds the progress bar.

**Time budgets.** Every Agent dispatch must start with `[budget: <N>m step: <k>]`, otherwise it is refused. Sub-agents are identified by the `agentId` on their tool calls (from `agent.spawn`). Below 80% of the budget calls pass; from 80% the executor gets a one-time wrap-up notice; from 100% every tool call is refused (TaskProgress excepted) until it reports. The band shows a countdown per running executor (`step 2 · 3:40 left`), amber near the end, red when over. The clock ticks only while something is active.

**Input check.** `TaskInputs` records the inputs the task needs from the user. After each new user prompt, Edit, Write, NotebookEdit, Bash, PowerShell and Agent are refused in the main session until it is called (an empty list is fine); unanswered inputs keep the gate shut until the model asks them in one AskUserQuestion and calls it again with `asked: true`. Sub-agents are not gated.

## Session dashboard (0.6.0)

The command is `/tp-dashboard` (Claude Code reserves `/dashboard`).

- `/tp-dashboard` opens the dashboard pane beside the chat.
- `/tp-dashboard web` starts the local web app (`web/server.js`, needs `node` on PATH) and prints its URL; the pane shows it too.
- `/tp-dashboard web stop` stops the web server.
- `/tp-dashboard close` closes the pane.

Panels (pane and web app read the same snapshot):

- **Progress**: the current task, step of total and label, and whether orchestrator mode is on.
- **Plan**: the TaskPlan steps with minutes and status (pending, running, done, skipped, over); a step turns over when its executor outlives its minutes.
- **Agents**: dispatched sub-agents with type, step, budget and status; running ones have a stop button (TaskStop).
- **Shells**: background Bash/PowerShell commands, closed by their task notification (done, failed with exit code, stopped); stop button while running.
- **Files**: files changed by Edit/Write/NotebookEdit, newest first, with a change count.
- **Tool log**: the last tool calls (one line each, failed ones marked; up to 200 kept).
- **Tasks**: your own task board (add, edit, status, priority, delete, "send to Claude", which submits it as a prompt and marks it doing), kept across sessions.
- **Message Claude** (web app): submits a prompt to the main session. Finished agents and shells can be cleared.

Security of the web app: it binds 127.0.0.1 only; every `/api/*` call needs a random per-session token (32 hex characters, header `X-TP-Token` or `?t=`, wrong token = 401); the Host header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard) and a browser Origin, when sent, must be the same origin (403 otherwise); bodies are capped at 1 MB and commands are validated against a fixed action list. It exits on its own about 35 s after the mod stops sending snapshots. Details: `web/README.md`.

## Approval cubes (0.7.0)

For a multi-action task, Claude calls `TaskPlan` with `cubes` instead of plain steps and then stops. Each cube is one small, checkable piece of work, and nothing runs until you approve it.

**How a task becomes cubes.** A cube has an `id` (c1, c2, ...), a `title`, one `action` sentence, a `flow` of 2-6 ordered function-level steps (see 0.10.0), `after` (cubes that must finish first), `doneWhen` (a check that proves it is done), optional `files`, and `minutes` (at most 10). The cubes form a graph; the plan section and the progress bar mirror it, one step per cube.

**Atomic rules.** The plan is refused whole, naming the cube to fix, when a cube has no action, an action over 200 characters, fewer than 2 or more than 6 flow steps ("Give cube cX at least 2 flow steps"), no `doneWhen`, no minutes or more than 10, or when ids repeat, `after` names an unknown cube, there is a cycle, or there are more than 40 cubes.

**What you can do** (in the `/tp-dashboard` pane or the web app):

- **Approve**: runs when its dependencies are done; otherwise it is **queued** and starts by itself once they finish. All cubes that become ready at once go to Claude in one prompt.
- **Approve all**: approves every proposed cube; ready ones go out together, the rest queue.
- **Edit**: change any field. An edit to an approved or queued cube sends it back to proposed with a new version. Edits must stay atomic.
- **Ask for a change**: write a note; the cube turns to revising and Claude answers with `CubeRevise` (change fields, or split it with `splitInto`; cubes that waited on it then wait on the last piece). It comes back to you as proposed.
- **Reject**: blocks the cubes that depend on it until you edit or delete it.
- **Delete / Add / Move**: delete rewires `after` of the cubes that waited on it; add makes the next free id; moving (changing `after`) is refused if it would make a cycle. Running and finished cubes cannot be changed.

**Dispatch gate.** While orchestrator mode is on and the gate is on, a main-session Agent dispatch must tag the cubes it runs in its budget line, `[budget: 6m step: 2 cubes: c3]`. A dispatch that tags an unapproved cube, an unknown cube, or a queued cube still waiting on dependencies is denied; an untagged dispatch is denied while the board has open work. Approved cubes pass. With orchestrator mode off nothing is gated.

**`/tp-cubes on | off | status`** turns the gate on or off for new boards and shows the counts (waiting, approved, running, done). In the web API the cube sentence is sent as `actionText` because `action` names the command.

**Slash commands.** The plugin also ships a skill called `orchestrate`, so the engine refuses a bare `/orchestrate` command; use `/tp-orchestrate on | off | status` (or `/task-progress:orchestrate` for the skill).

## Bypassed prompt.compose (0.7.1)

If another plugin bypasses prompt.compose, the rules are attached to user prompts instead (in full on the first prompt, then a one-line reminder while orchestrator mode is on).

## Night-sky restyle (0.8.0)

Night-sky dashboard restyle. Web: starfield, constellation progress, countdown rings, telemetry log, glass kanban, light theme. Pane: bordered sections with glyphs, ▰▱ budget bars.

## Ask about a cube (0.9.0)

On the web dashboard each cube has an **Ask** button ("Questions only - the cube stays as it is") that opens a small chat about that step; it is separate from the change-request button. A question is sent to the session as `[cube question <id> "<title>"] <text>`; Claude answers with the `CubeAnswer` tool (`id`, `answer`) and the answer shows in that cube's thread. Asking never changes, approves, revises or dispatches the cube, and does not bump its version. Threads keep the last 50 messages (2000 characters each); the pane only shows a `💬 n` count.

## Function-level cube flow (0.10.0)

Each flow step is now an object, not a sentence: `{ file, fn, does, calls? }`. `file` is the repo-relative path (or `shell`, `browser`, `terminal` for non-code steps), `fn` the function, method or component (for non-code steps the command or tool, such as `claude plugin test`), `does` one short sentence, and `calls` an optional `file:fn` of the next function it calls. Break every cube down to functions. A step missing `file`, `fn` or `does` is refused with `flow[2] needs file, fn and does - e.g. {...}`; caps are 200, 120, 200 and 240 characters. Boards stored before 0.10.0 with string steps still load and show the text as the step. The pane shows `1 register.tsx > onPromptSubmit()  resets the input gate` and `-> dashboard.tsx:onPromptSubmit`.

## PR review stage (pr-reviewer skill) (0.10.0)

Every cube ends with a PR review. After the cube's executor reports, the orchestrator dispatches an executor that runs the `pr-reviewer` skill on the cube's changed files and calls the new `CubeReview` tool (`id`, `verdict` APPROVE / REQUEST_CHANGES / NEEDS_INVESTIGATION, `summary`, optional `understanding`, `findings` P0-P3 with file and line, `quiz`). The review is kept on the cube (`review.status` running, passed, changes or investigate; at most 50 findings, 10 quiz questions, 4000 characters per text). APPROVE lets the cube be marked done; REQUEST_CHANGES reopens it (done becomes approved) and tells Claude to dispatch a fix executor for the P0/P1 findings and review again. The dashboard command `cube.review {id}` starts a review from the UI: it sets `review.status` to running and sends a `[cube review <id> "<title>"]` prompt. The pane shows `review ✓ APPROVE`, `review ✗ REQUEST CHANGES · P1×2` or `review ◐ running`. `CubeReview` is never blocked by the orchestrator gates.

## Install (local directory marketplace)

Place this folder inside a directory that you add as a local marketplace, then install the plugin from it:

    /plugin marketplace add <path-to-marketplace-directory>
    /plugin install task-progress@<marketplace-name>

Plugin manifest: `.claude-plugin/plugin.json`. Hook module: `hooks/register.tsx`.

## Review gates done (0.10.1)

With the gate on, a cube whose executor finishes goes to `reviewing` (pane glyph `◐`, "in review"), not `done`; dependents keep waiting because only `done` satisfies `after`, and Claude is told `Cube <id> is in review: dispatch a review executor (Skill "pr-reviewer" on its files), then CubeReview.` `CubeReview` APPROVE makes it `done` and releases dependents; REQUEST_CHANGES reopens it to `approved` for a fix; NEEDS_INVESTIGATION leaves it in review. Escape hatch: `cube.markDone {id}` (web button "Mark done") forces a cube in review, failed or approved to done. With the gate off a finished cube is done as before. Editing a legacy cube without a new flow no longer fails. The web dashboard now shows object flow steps, edits them as file/fn/does/calls inputs, shows the review line and a Run review button, and accepts `cube.review`.
