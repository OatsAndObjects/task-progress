---
name: orchestrate
description: Orchestrator protocol for the main session: check inputs, plan with time budgets, dispatch Sonnet executors in parallel, review reports. Use at the start of any multi-step task while orchestrator mode is on.
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
