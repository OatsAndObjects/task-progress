# task-progress

A Claude Code plugin (v1.3.1). It shows an estimated progress bar above the prompt, runs an orchestrator mode with small executors, asks you to approve the plan as cubes, routes work to feature-dev and code-simplifier agents, and has a terminal Cubes pane (agents, cubes, usage).

## Progress bar

- `TaskProgress` tool: the model reports task name, estimated total steps, steps done and a label; the band above the prompt renders the bar.
- `/progress`: shows the current progress as plain text; `/progress clear` clears it.

## Orchestrator mode and executors

On by default; `/tp-orchestrate on | off | status` (the plugin also ships a skill called `orchestrate`, so the engine refuses a bare `/orchestrate`). When off, only the progress bar remains.

- The main session plans and reviews; the `task-progress:executor` agent (Sonnet) executes one step each and ends with a fixed report (status, what changed, how verified, blockers). A short protocol is added to the system prompt; the full text is the `task-progress:orchestrate` skill. `TaskPlan` registers the plan and seeds the progress bar.
- **Time budgets.** Every Agent dispatch must start with `[budget: <N>m step: <k>]`, otherwise it is refused. Below 80% of the budget calls pass; from 80% the executor gets a one-time wrap-up notice; from 100% every tool call is refused (TaskProgress excepted) until it reports. The band shows a countdown per running executor.
- **Input check.** `TaskInputs` records the inputs the task needs. After each new user prompt, Edit, Write, NotebookEdit, Bash, PowerShell and Agent are refused in the main session until it is called. Sub-agents are not gated.
- If another plugin bypasses prompt.compose, the rules are attached to user prompts instead.

## Approval cubes

For a multi-action task, Claude calls `TaskPlan` with `cubes` and stops. Each cube is one small, checkable piece of work; nothing runs until you approve it. Approve, edit and the other actions are done in the Cubes pane (`/tp-cubes`).

**A cube** has an `id` (c1, c2, ...), a `title`, one `action` sentence, a `flow` of 2-6 function-level steps, `after` (cubes that must finish first), `doneWhen` (a check that proves it is done), optional `files`, and `minutes` (at most 10). The cubes form a graph; the progress bar mirrors it, one step per cube.

**Description sections.** Every cube also carries `summary` (one or two plain sentences), `problem` (list of bullets), `steps` (ordered list of plain steps) and `code` (list of `{file, change}`: the file or `file › function` and what changes there). All four are required. The card's expandable body (Details) shows them as Summary, Problem, Steps and Code touched, then Done when, the flow and the review. Older cubes with only `details` show it as the Summary.

**Approach question gate.** `TaskPlan` with cubes is refused until Claude has called `AskUserQuestion` with a question whose header is "Approach" for the current prompt (it offers the ways to do the task and you pick one). The flag resets on every new prompt.

**Flow (details).** Each flow step is `{ file, fn, does, calls? }`: the repo-relative path (or `shell`, `browser`, `terminal`), the function or command, one short sentence, and an optional `file:fn` of the next function it calls (the arrow shown between steps). A step missing `file`, `fn` or `does` is refused.

**Atomic rules.** The plan is refused whole, naming the cube to fix, when a cube has no action, an action over 200 characters, fewer than 2 or more than 6 flow steps, no `doneWhen`, no minutes or more than 10, or when ids repeat, `after` names an unknown cube, there is a cycle, or there are more than 40 cubes.

**What you can do:**

- **Approve**: runs when its dependencies are done; otherwise it is queued and starts by itself once they finish. Cubes that become ready together go to Claude in one prompt.
- **Approve all**, **Edit** (edits must stay atomic), **Ask for a change** (Claude answers with `CubeRevise`, possibly splitting it), **Reject**, **Delete / Add / Move** (moving is refused if it would make a cycle).
- **Ask** a question about a cube: it is sent as `[cube question <id> "<title>"] <text>`; Claude answers with `CubeAnswer` and the answer shows in the cube's thread. Asking never changes the cube.

**Dispatch gate.** While orchestrator mode and the gate are on, an Agent dispatch must tag the cubes it runs, `[budget: 6m step: 2 cubes: c3]`. A dispatch for an unapproved, unknown or still-waiting cube is denied; an untagged dispatch is denied while the board has open work.

**Combined review.** A cube whose executor finished goes to `reviewing` and no longer blocks its dependents. When every cube is built, one review runs: code-simplifier (only if code changed), then `task-progress:pr-reviewer` and `feature-dev:code-reviewer` in parallel (tag `review: <ids>`), then one `CubeReview` with `ids`. REQUEST_CHANGES reopens only cubes whose files carry P0/P1 findings. Dependents may start while a cube is in review, so a REQUEST_CHANGES fix to an earlier cube can affect later cubes that are already built; the orchestrator should re-check those. Escape hatch: `cube.markDone`.

`/tp-cubes on | off | status` turns the gate on or off for new boards and shows the counts.


### Cubes pane

`/tp-cubes` opens it; it also opens by itself when a plan is made and on resume with unfinished cubes. Docked beside the transcript from 110 columns, otherwise above the prompt. It shows:

- **Agents**: running agents, time left, last tool.
- **Cubes**: each with its summary and a Details toggle (problem, steps, code, done when, flow, review); Approve, Reject and Approve all.
- **Usage**: 5-hour and 7-day limits and top agents.

## Auto /context then /clear

When the last cube of a plan finishes, the plugin runs `/context`, saves the output (in `~/.claude/task-progress-context/`), then runs `/clear`. This happens once per plan.

## Install

    claude plugin marketplace add <path or repo>
    claude plugin install task-progress@local-mods

`feature-dev` and `code-simplifier` come along as dependencies from `claude-plugins-official` (add that marketplace first). Session start warns with the install commands if they are missing. `pr-reviewer` is bundled.

Plugin manifest: `.claude-plugin/plugin.json`. Hook module: `hooks/register.tsx`.
