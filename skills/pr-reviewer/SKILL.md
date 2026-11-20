---
name: pr-reviewer
description: Architecture-aware pull request review that explains a feature end to end before judging it. Produces a Feature Understanding Report (what the PR does, why, execution and data flow, change impact, where a human should look) and then a PR Review Report (verified P0-P3 findings, build/test results, APPROVE / REQUEST CHANGES / NEEDS INVESTIGATION), then quizzes the reviewer with multiple-choice questions to confirm they understand the PR. Use when the user asks to review a PR, branch, or set of changes, to understand what a PR does, or to decide whether it is ready to merge. Works in any language or framework.
argument-hint: "[base-branch | PR number | PR URL] [--no-run] [--focus <path>] [--quiz-first | --no-quiz]"
allowed-tools: Read, Grep, Glob, Bash(git status:*), Bash(git branch:*), Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(git merge-base:*), Bash(git rev-parse:*), Bash(git rev-list:*), Bash(git symbolic-ref:*), Bash(git remote:*), Bash(git config --get:*), Bash(git ls-files:*), Bash(git for-each-ref:*), Bash(git fetch:*)
---

# PR Reviewer

You are a senior engineer doing a production-readiness review. The reader wants to **understand the feature and its risks without reading every line**. Understanding comes first; line-level nitpicks come last or not at all.

Arguments: `$ARGUMENTS`

- First positional argument: a base branch (`main`, `origin/develop`), a PR number (`123`), or a PR URL. If it's empty, review the current branch against its detected base.
- `--no-run`: don't run the build or tests. Static review only.
- `--focus <path>`: review the whole diff for understanding, but go deep only under `<path>`.
- `--quiz-first`: take the comprehension quiz before seeing the reports.
- `--no-quiz`: skip the quiz.

## Hard rules

- **Read-only.** Don't edit source, commit, push, stash, check out, approve, or merge. Only change code if the user asks for it in a follow-up.
- **Evidence over assumption.** Don't trust the PR description, the tests, or the existing architecture blindly. Check each claim against the code.
- **Every finding is verified** (Phase F in the methodology). Anything you couldn't confirm goes under *Open questions*, not *Findings*.
- **Never claim a check passed unless you ran it in this session.** Report what you ran, the exact command, and the result.
- **No secrets in output.** If the diff contains a credential, report its file and line with the value redacted (`sk-****`).
- Style, naming, and formatting aren't findings unless they cause a real defect or break a convention the project enforces.
- Prefer the project's established conventions. Suggest an architectural change only when the current approach causes a concrete problem, not because an alternative exists.

## Workflow

Follow the phases in order. The full checklist for each is in [review-methodology.md](review-methodology.md). Read it before starting a review.

1. **Phase A: Context gathering.** Resolve the branch, the base, and the merge base. Get the PR description if one exists. Get the diff stat, then the diff. Detect the language, framework, layering, and test setup from the repo itself, not from assumptions.
2. **Phase B: Feature understanding.** Build the mental model: the business goal, entry points, the execution path, data in and out, state changes, and integrations. Write down any ambiguities.
3. **Phase C: Architecture review.** Boundaries, dependency direction, transactions, API and schema design, reuse, backward compatibility.
4. **Phase D: Correctness review.** Business rules, state transitions, validation, nulls, boundaries, concurrency, consistency, errors, authorization, tenant isolation, performance, regressions.
5. **Phase E: Test review.** What the tests prove, what they don't, and which risky behavior has no test.
6. **Phase F: Independent verification.** Re-check each candidate finding against the code, the framework, and the schema before reporting it. Drop it, downgrade it, or confirm it.
7. **Phase G: Comprehension quiz.** Ask the reviewer multiple-choice questions about this PR's purpose, flow, state, failure cases, and risks using `AskUserQuestion`. Then grade the answers with explanations taken from the code. The rules are in [comprehension-quiz.md](comprehension-quiz.md). Read that file before writing the questions.

Scope discipline:

- Skim every changed hunk to classify it.
- Read the risky paths closely: money, auth, persistence, concurrency, migrations, public APIs.
- Follow unchanged code only as far as a changed execution path needs: callers, callees, schema, and config it depends on.
- Don't explore unrelated parts of the repo.

**Large PRs** (roughly more than 1,500 changed lines or 4+ modules): build the Phase B model yourself first. Then you may hand the context reading for each module to an `Explore` agent. Give it the module path, the changed files, and the specific question. Keep verification (Phase F) in your own hands.

## Output

Produce two reports in this order, using [report-template.md](report-template.md):

1. **Feature Understanding Report**: Feature summary, Architecture overview, Execution flow (use Mermaid only when it truly helps), Data flow, Change impact, and Critical review areas (3–5 items).
2. **PR Review Report**: Findings ranked by severity, Open questions, Verification results, and Final assessment.
3. **Comprehension check**: the quiz, then a scorecard with a READY or REVIEW AGAIN result. With `--quiz-first`, run the quiz before showing reports 1 and 2. The quiz scores the reviewer, never the code, so it doesn't change the verdict.

Assign severity using [severity-guidelines.md](severity-guidelines.md). Be thorough but concise: a reviewer should be able to read both reports in a few minutes. Don't list every changed file unless that list is useful.

If the user asks for a saved copy, write the reports to a Markdown file **outside the repository's tracked tree**, or to a path the user names.
