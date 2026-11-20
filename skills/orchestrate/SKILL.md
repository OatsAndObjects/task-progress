---
name: orchestrate
description: "Orchestrator protocol for the main session: check inputs, plan with time budgets, dispatch Sonnet executors in parallel, review reports. Use at the start of any multi-step task while orchestrator mode is on."
---

# Orchestrator protocol

You (the main, strongest model) plan and review. Sonnet executors (`task-progress:executor`) do the work. Orchestrator mode is toggled with `/tp-orchestrate on|off|status`; when it is off, ignore this skill.

## 1. Input check (before anything else)
For every new user prompt call `TaskInputs` first. Predict what the task will need from the user: choices, credentials, paths, scope, deadlines, anything you would otherwise guess. Pass `inputs: [{question, why}]` and `asked: false`. Empty list when nothing is needed. If the result says to ask, ask them all in ONE `AskUserQuestion`, then call `TaskInputs` again with `asked: true`. Edit, Write, Bash, PowerShell, NotebookEdit and Agent are refused until this is done. Reading and searching are allowed so you can look around first.

## 2. Plan
Break the task into steps. For each: a self-contained executor brief, a time budget in minutes (be realistic, add slack), and its dependencies. Call `TaskPlan` with `{task, steps:[{title, minutes}]}`; it also draws the progress bar.

## 3. Dispatch
Every dispatch, of any agent type, starts with the line `[budget: <N>m step: <k>]` (add `cubes: <ids>` for cubes), then the full brief: goal, files, constraints, how to verify. End every brief by asking the agent to finish with the fixed report: `Status / What changed / How verified / Blockers`. The agent sees nothing of this conversation. Run independent steps in parallel, at most 3 at once. An Agent call without the budget tag is refused.

| Work | subagent_type | Notes |
|---|---|---|
| Code, commands, tests | `task-progress:executor` | Sonnet; one step each |
| Research | `feature-dev:code-explorer` | Only when you do not already know the files |
| Design | `feature-dev:code-architect` | Only when you do not already know the files |
| Simplify, after code changes | `code-simplifier:code-simplifier` | Pass `model: "sonnet"`; the gate refuses other models |
| Review | see Combined review | One combined review at the end |

If a plugin agent type is unavailable, fall back to `task-progress:executor`.

## 4. Review
Do not edit code or run builds yourself. Read each agent report (Status, What changed, How verified, Blockers). Update the bar with `TaskProgress` (step count, label). Re-plan when a step is partial or blocked.

## Time budgets are enforced
At 80% of its budget an executor is told to wrap up. At 100% every tool call it makes is refused and it must report. If a step came back partial because of time, you decide: re-dispatch the remainder with a fresh `[budget: ...]` (more minutes, narrower brief), or change the plan. The band shows each running executor's countdown and shows overrun in red.

## Approval cubes
For any task needing more than one action, call `TaskPlan` with `cubes` instead of `steps`.

**Ask the approach first.** Before `TaskPlan` with cubes, call `AskUserQuestion` once with a question whose `header` is "Approach": state the problem briefly and offer 2-3 ways to solve it (a trade-off each, one marked "(Recommended)"). It may be the same call as the `TaskInputs` questions. `TaskPlan` with cubes is refused until this was asked for the current user prompt (steps-only plans are not gated).

**Describe every cube.** Besides the atomic fields, each cube needs `summary` (1-2 plain sentences: what and why), `problem` (1-6 points: exactly what problem it solves), `steps` (1-8 plain-words steps you will take, in order) and `code` (1-10 `{file, change}`: the code that will be touched, file as a path optionally with " › function", change in plain words). A plan or split cube missing any of them is refused with the cube id and field named. `flow` stays the function-level call graph. `CubeRevise` may patch these fields; a field in the patch replaces the old one.

Each cube is atomic: Each cube is atomic: one action (one sentence), 2-6 ordered `flow` steps, a verifiable `doneWhen`, at most 10 minutes, and `after` listing only real dependencies so independent cubes can run in parallel. The call is rejected, with the cube to split named, if a cube is not atomic, references an unknown id, forms a cycle, or there are more than 40.

Break every cube down to functions: each flow step is `{file, fn, does, calls?}` and names the file and function, what it does, and which function it calls next (`calls`, as `file:fn`); non-code steps use file `shell` (or `browser`, `terminal`) and the command as `fn`. A step missing file, fn or does is refused.

Then STOP and wait. The user approves, changes or rejects each cube in the Cubes pane (`/tp-cubes`); each approval arrives as a prompt telling you which cube to run. Never dispatch an unapproved cube: tag every dispatch `[budget: <N>m step: <k> cubes: <ids>]`; while the gate is on (`/tp-cubes on|off|status`) an untagged or unapproved dispatch is refused. When the user asks for a change you get a prompt; call `CubeRevise` (split the cube if it is not atomic), then wait again. Cube questions arrive as `[cube question <id> ...]` prompts: answer with `CubeAnswer` only and change nothing (no CubeRevise, approval or dispatch).

### Combined review
A cube whose executor finished goes to `reviewing`; this no longer blocks its dependents. Once every cube is built, the plugin sends one review prompt. Follow it:
1. If code changed, dispatch `code-simplifier:code-simplifier` with `model: "sonnet"` first.
2. Then, in parallel, a `task-progress:executor` that runs Skill `task-progress:pr-reviewer` and a `feature-dev:code-reviewer`, over all changed files. Tag both `[budget: <N>m step: <k> review: <ids>]` (the `review:` tag, never `cubes:`). They return the verdict, P0-P3 findings with file:line, an understanding summary and 3 quiz questions.
3. Call `CubeReview` once with `ids` (all reviewed cube ids). APPROVE marks them done. REQUEST_CHANGES reopens only the cubes whose files carry P0/P1 findings: dispatch fix executors for those, then review again. NEEDS_INVESTIGATION: look into it first.
Dependents may start while a cube is in review, so a REQUEST_CHANGES fix to an earlier cube can affect later cubes that are already built: re-check those after the fix.
A `[cube review ...]` prompt from the Cubes pane asks for this review; call `CubeReview` only (no approval or revision).

## Token budget
Keep briefs specific (paths, line ranges) so agents do not search. Keep reports short. Use cubes only for real multi-action work.
