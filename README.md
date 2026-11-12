# task-progress

A Claude Code plugin (v0.4.0) that shows an estimated progress bar for the current task in a band above the prompt.

- `TaskProgress` tool: the model reports task name, estimated total steps, steps done and a label; the band renders the bar.
- `/progress` command: shows the current progress as plain text; `/progress clear` clears it.

## Install (local directory marketplace)

Place this folder inside a directory that you add as a local marketplace, then install the plugin from it:

    /plugin marketplace add <path-to-marketplace-directory>
    /plugin install task-progress@<marketplace-name>

Plugin manifest: `.claude-plugin/plugin.json`. Hook module: `hooks/register.tsx`.
