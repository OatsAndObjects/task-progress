# task-progress

A Claude Code plugin (v0.5.0) that shows an estimated progress bar for the current task in a band above the prompt.

- `TaskProgress` tool: the model reports task name, estimated total steps, steps done and a label; the band renders the bar.
- `/progress` command: shows the current progress as plain text; `/progress clear` clears it.

## Orchestrator mode (0.5.0)

On by default; `/orchestrate on|off|status`. When off, the plugin behaves like 0.4.0.

**One orchestrator, small executors.** The main session plans and reviews; the `task-progress:executor` agent (Sonnet) executes one step each and ends with a fixed report (status, what changed, how verified, blockers). A short protocol is added to the system prompt while the mode is on; the full text is the `task-progress:orchestrate` skill. `TaskPlan` registers the plan (steps with minutes) and seeds the progress bar.

**Time budgets.** Every Agent dispatch must start with `[budget: <N>m step: <k>]`, otherwise it is refused. Sub-agents are identified by the `agentId` on their tool calls (from `agent.spawn`). Below 80% of the budget calls pass; from 80% the executor gets a one-time wrap-up notice; from 100% every tool call is refused (TaskProgress excepted) until it reports. The band shows a countdown per running executor (`step 2 · 3:40 left`), amber near the end, red when over. The clock ticks only while something is active.

**Input check.** `TaskInputs` records the inputs the task needs from the user. After each new user prompt, Edit, Write, NotebookEdit, Bash, PowerShell and Agent are refused in the main session until it is called (an empty list is fine); unanswered inputs keep the gate shut until the model asks them in one AskUserQuestion and calls it again with `asked: true`. Sub-agents are not gated.

## Install (local directory marketplace)

Place this folder inside a directory that you add as a local marketplace, then install the plugin from it:

    /plugin marketplace add <path-to-marketplace-directory>
    /plugin install task-progress@<marketplace-name>

Plugin manifest: `.claude-plugin/plugin.json`. Hook module: `hooks/register.tsx`.
