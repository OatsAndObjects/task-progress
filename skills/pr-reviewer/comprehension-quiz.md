# Comprehension Quiz

Checks whether the human reviewer actually understands the PR before they approve it. The quiz tests **understanding of this specific change**, not general trivia.

## When it runs

| Flag | Behaviour |
|---|---|
| none (default) | Show both reports, then run the quiz |
| `--quiz-first` | Finish the full analysis, but **hold both reports back**. Run the quiz first, then show the reports followed by the scorecard. Use this when the user wants to test what they understood from reading the PR themselves. |
| `--no-quiz` | Skip the quiz |

## Writing the questions

Write **6 questions** by default, or 4 for a PR under about 100 changed lines. Cover these categories, and pick the ones that matter most for this PR:

| Category | What it checks | Example stem |
|---|---|---|
| Purpose | Why the change exists | "What problem does this PR solve for the user?" |
| Execution flow | The order and path of the main operation | "When a client calls `POST /orders/{id}/cancel`, what happens right after the status check passes?" |
| Data & state | What is written, where, and which state transitions | "Which table rows change when a shipment is marked delivered?" |
| Integration | How the change touches existing code | "Which existing caller of `PriceService.quote()` now behaves differently?" |
| Failure & edge cases | Behaviour on bad input, partial failure, or concurrency | "If the payment call times out after the order row is saved, what state is the order left in?" |
| Risk / findings | The most important finding or critical review area | "Why can user A read user B's invoice through the new endpoint?" |
| Verification | What is and isn't proven | "Which behaviour has no test at all?" |

At least half the questions must come from **Execution flow**, **Data & state**, **Failure & edge cases**, or **Risk**. Those are what an approver must get right.

Rules for every question:

- **Grounded:** the correct answer must be verified in the code (Phase F standard). Never quiz on a speculative issue or an open question.
- **Specific to this PR:** name the real endpoints, classes, fields and states. Don't ask generic questions like "what is a transaction?"
- **No leaking:** the question stem and the option descriptions must not give the answer away. Don't put file:line references in options. Save them for the explanation.
- **Plausible distractors:** each wrong option should be a realistic misunderstanding, for example:
  - the behaviour before this PR
  - what a similar existing feature does
  - a step in the wrong order
  - the happy path when the question asks about failure
  - an assumption the PR description makes but the code doesn't honour
- **One clearly correct option.** Use multi-select only for "select all that apply" questions; grade those all-or-nothing.
- **Shuffle** the position of the correct answer. Never label any option "(Recommended)".
- **Option previews** (single-select only): when the question is about code, you may put a short snippet in each option's `preview`, for example "Which of these is the actual guard added in `CancelService`?" Keep each snippet under about 12 lines and taken from or modelled on the real code.

## Asking

Use the `AskUserQuestion` tool. It takes up to 4 questions per call and 2–4 options per question, so ask in rounds, for example 3 + 3. Each `header` is at most 12 characters, for example `Q1 Flow` or `Q4 Failure`.

Don't reveal any answers until every round is done. If the user picks "Other" and types a free answer, grade it on substance: right, partly right, or wrong.

If `AskUserQuestion` isn't available (for example, a non-interactive run), print the questions as numbered text with options A–D. Ask the user to reply in the form `1B 2D 3A ...`, and wait. Don't print the answer key in the same message.

## Grading and scorecard

After the last round, output:

~~~~markdown
## Comprehension check: <score>/<total>

| # | Area | Your answer | Correct | Result |
|---|---|---|---|---|
| 1 | Execution flow | B | B | ✅ |
| 2 | Failure | A | C | ❌ |

**Q2, why C:** <1–3 sentences grounded in the code> (`path/file.ext:line`)
<an explanation for every missed or partly correct question; skip the correct ones>

**Understanding:** READY | REVIEW AGAIN
**Re-read:** <the specific report sections and files to look at, for missed areas only>
~~~~

- **READY** means at least 80% correct **and** every Risk and Failure question correct.
- Anything else is **REVIEW AGAIN**.
- When the result is REVIEW AGAIN, offer a short re-quiz of 2–3 **new** questions on the missed areas only. Never repeat the same question.

The quiz result is about the reviewer, not the code. It never changes the PR verdict (APPROVE / REQUEST CHANGES / NEEDS INVESTIGATION). Report the two side by side.
