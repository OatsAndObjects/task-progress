---
name: orchestrate
description: "Orchestrator protocol for the main session: check inputs, plan with time budgets, dispatch Sonnet executors in parallel, review reports. Use at the start of any multi-step task while orchestrator mode is on."
---

# Orchestrator protocol

You (the main, strongest model) plan and review. Sonnet executors (`task-progress:executor`) do the work. Orchestrator mode is toggled with `/orchestrate on|off|status`; when it is off, ignore this skill.

## 1. Input check (before anything else)
For every new user prompt call `TaskInputs` first. Predict what the task will need from the user: choices, credentials, paths, scope, deadlines, anything you would otherwise guess. Pass `inputs: [{question, why}]` and `asked: false`. Empty list when nothing is needed. If the result says to ask, ask them all in ONE `AskUserQuestion`, then call `TaskInputs` again with `asked: true`. Edit, Write, Bash, PowerShell, NotebookEdit and Agent are refused until this is done. Reading and searching are allowed so you can look around first.

## 2. Plan
Break the task into steps. For each: a self-contained executor brief, a time budget in minutes (be realistic, add slack), and its dependencies. Call `TaskPlan` with `{task, steps:[{title, minutes}]}`; it also draws the progress bar.

## 3. Dispatch
Send each step to the Agent tool with `subagent_type: "task-progress:executor"`. The prompt must begin with the line `[budget: <N>m step: <k>]`, then the full brief: goal, files, constraints, how to verify, what to report. The executor sees nothing of this conversation. Run independent steps in parallel, at most 3 at once. An Agent call without the budget tag is refused.

## 4. Review
Do not edit code or run builds yourself. Read each executor report (Status, What changed, How verified, Blockers). Update the bar with `TaskProgress` (step count, label). Re-plan when a step is partial or blocked.

## Time budgets are enforced
At 80% of its budget an executor is told to wrap up. At 100% every tool call it makes is refused and it must report. If a step came back partial because of time, you decide: re-dispatch the remainder with a fresh `[budget: ...]` (more minutes, narrower brief), or change the plan. The band shows each running executor's countdown and shows overrun in red.

## Approval cubes
For any task needing more than one action, call `TaskPlan` with `cubes` instead of `steps`.

**Ask the approach first.** Before `TaskPlan` with cubes, call `AskUserQuestion` once with a question whose `header` is "Approach": state the problem briefly and offer 2-3 ways to solve it (a trade-off each, one marked "(Recommended)"). It may be the same call as the `TaskInputs` questions. `TaskPlan` with cubes is refused until this was asked for the current user prompt (steps-only plans are not gated).

**Describe every cube.** Besides the atomic fields, each cube needs `summary` (1-2 plain sentences: what and why), `problem` (1-6 points: exactly what problem it solves), `steps` (1-8 plain-words steps you will take, in order) and `code` (1-10 `{file, change}`: the code that will be touched, file as a path optionally with " › function", change in plain words). A plan or split cube missing any of them is refused with the cube id and field named. `flow` stays the function-level call graph. `CubeRevise` may patch these fields; a field in the patch replaces the old one.

Each cube is atomic: Each cube is atomic: one action (one sentence), 2-6 ordered `flow` steps, a verifiable `doneWhen`, at most 10 minutes, and `after` listing only real dependencies so independent cubes can run in parallel. The call is rejected, with the cube to split named, if a cube is not atomic, references an unknown id, forms a cycle, or there are more than 40.

Break every cube down to functions: each flow step is `{file, fn, does, calls?}` and names the file and function, what it does, and which function it calls next (`calls`, as `file:fn`); non-code steps use file `shell` (or `browser`, `terminal`) and the command as `fn`. A step missing file, fn or does is refused.

Then STOP and wait. The user approves, changes or rejects each cube on the dashboard (`/tp-dashboard`, or `/tp-dashboard web`); each approval arrives as a prompt telling you which cube to run. Never dispatch an unapproved cube: tag every dispatch `[budget: <N>m step: <k> cubes: <ids>]`; while the gate is on (`/tp-cubes on|off|status`) an untagged or unapproved dispatch is refused. When the user asks for a change you get a prompt; call `CubeRevise` (split the cube if it is not atomic), then wait again. Cube questions arrive as `[cube question <id> ...]` prompts: answer with `CubeAnswer` only and change nothing (no CubeRevise, approval or dispatch).

### PR review of every cube
Every cube ends with a PR review. After a cube's executor reports, dispatch a review executor (`task-progress:executor`) whose first line is `[budget: <N>m step: <k> review: <id>]` (the `review:` tag, never `cubes:`: the gate refuses `cubes:` for a cube in review and a review agent never changes the cube's status; only `CubeReview` does) whose prompt tells it to invoke Skill `pr-reviewer` on that cube's changed files (the files in its flow and `files`) and return the verdict, findings (P0-P3 with file:line), the understanding summary and 3 quiz questions. Then call `CubeReview` with the cube id. APPROVE: the cube may be marked done. REQUEST_CHANGES: the cube stays open; dispatch a fix executor for the P0/P1 findings, then review again. NEEDS_INVESTIGATION: look into it first. A `[cube review <id> ...]` prompt from the dashboard asks for exactly this review; do it and call `CubeReview` only (no approval or revision).
