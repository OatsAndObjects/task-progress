# Review Methodology

The detailed checklist for each phase. Use the commands below as starting points. Every command here is read-only and works the same in bash and PowerShell.

---

## Phase A: Context gathering

### A1. Resolve what is being reviewed

| Argument | What to review |
|---|---|
| none | `HEAD` of the current branch against its detected base |
| a branch name (`main`, `origin/develop`) | `HEAD` against that branch |
| PR number or URL | that PR's head commit against its base (see below) |

```
git rev-parse --abbrev-ref HEAD          # current branch
git status --short                       # uncommitted work?
git remote -v                            # is there a remote?
```

**PR number or URL.** If `gh` is installed and authenticated, use it:

```
gh pr view <n> --json number,title,body,baseRefName,headRefName,headRefOid,files,commits
```

Without `gh`, on a GitHub remote, use git directly:

```
git fetch origin pull/<n>/head
```

That leaves the PR head in `FETCH_HEAD`. Review `FETCH_HEAD` **without checking it out**. Read the PR's files with `git show <sha>:<path>`, not from the working tree. Without `gh` there's no PR description, so say so in the report.

**Detecting the base when none is given.** Try these in order:

1. `gh pr view --json baseRefName`, if there's an open PR for this branch.
2. **Nearest long-lived ancestor.** List the branches with `git for-each-ref --format="%(refname:short)" refs/heads refs/remotes`. Leave out the current branch and its own remote copy. A branch counts as *long-lived* when its name, or any `/`-separated part of it, is `main`, `master`, `develop`, `dev`, `debug`, `staging`, `trunk`, or starts with `release`. So `erp/debug` and `origin/release-2.1` both count. For each long-lived branch, run `git rev-list --count <candidate>..HEAD`. The candidate with the **fewest** commits ahead (greater than 0) is the base. Prefer the remote copy (`origin/x`) when it's ahead of the local one.
3. `git symbolic-ref refs/remotes/origin/HEAD`, the remote's default branch. Use it as a tiebreaker or last resort, not as the first choice: teams often branch from something other than the default branch.

Edge cases:

- **A non-long-lived branch is strictly nearer.** This may be a stacked PR. Use the long-lived base, but mention the nearer branch.
- **The best candidate has 0 commits ahead.** The branch is already fully contained in it (merged or empty). Say so and ask the user what to compare against. Don't fall back to a more distant branch silently.

Always state the base you chose and how you found it. If two candidates are about equally plausible, ask the user instead of guessing.

**Freshness.** If a remote exists, run `git fetch origin <base>` so you compare against the current base. If the fetch fails (offline or auth), continue with local refs and record that in Verification results.

### A2. Compute the change set

```
git merge-base <base> HEAD                    # the actual fork point
git log --oneline <merge-base>..HEAD          # commits in the PR
git diff --stat <base>...HEAD                 # size and shape first
git diff <base>...HEAD -- <paths>             # then the content, module by module
```

Use **three dots** so only this branch's changes show up, not everything that has landed on the base since. If there are uncommitted changes, review them separately with `git diff HEAD` and label them as *not part of the PR*.

The commit messages are part of the context. They often explain *why* a change was made.

### A3. Learn the project before judging it

Detect, don't assume. Read only what you need:

- **Language and build:** manifests such as `package.json`, `pyproject.toml`, `build.gradle(.kts)`, `pom.xml`, `go.mod`, `Cargo.toml`, `*.csproj`, `Gemfile`, `composer.json`.
- **Conventions:** `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `README`, ADRs or `docs/architecture*`, lint and format configs.
- **Layering:** look at how one *existing* feature similar to this PR is structured end to end (route → handler → service → repository → schema). That's the yardstick for "follows the existing architecture."
- **Data:** the migrations folder and ORM entities or models touched by the PR, plus the tables they reference.
- **Test setup:** the test directories, the test runner config, and the CI config (`.github/workflows`, `.gitlab-ci.yml`, `Jenkinsfile`, and so on). CI shows the real build and test commands.

### A4. Requirements

Use, in order: the PR description, linked issues the user gives you, commit messages, and code comments or docs added in the PR. If none of these states the requirements, infer them from the code and **label them as inferred**.

---

## Phase B: Feature understanding

Answer these before looking for bugs:

- **Business objective:** what user or business problem this solves.
- **Functional requirements and acceptance criteria:** stated or inferred.
- **Entry points:** HTTP routes, UI actions, jobs or cron, message consumers, CLI commands, webhooks, migrations.
- **Main execution paths:** the happy path plus the important alternative and error paths, traced from entry point to final persisted state.
- **Data:** the inputs (and where they're validated), the outputs, what's read, what's written, and where it's stored.
- **State changes:** entities whose status or lifecycle changes, and what triggers each transition.
- **Dependencies and integrations:** new libraries, external APIs, queues, caches, file storage.
- **Existing behavior affected:** shared code paths, changed signatures, changed defaults, changed schemas.
- **Ambiguities:** places where the intended behavior isn't clear. List them explicitly. Don't resolve them silently.

---

## Phase C: Architecture review

| Area | Question to ask |
|---|---|
| Module boundaries | Does the code live in the module that owns this responsibility? |
| Responsibilities | Is business logic leaking into controllers, views, or repositories, or the reverse? |
| Dependency direction | Do lower layers or core modules now depend on higher layers or feature modules? Any new cycles? |
| Data flow | Is there a single source of truth? Is data duplicated or derived inconsistently? |
| API design | Consistent with existing endpoints (naming, status codes, error shape, pagination, versioning)? |
| Database design | Constraints, indexes for new query paths, nullability, defaults, migration safety on existing rows |
| Transactions | Are multi-write operations atomic? Any external calls inside a DB transaction? Correct isolation? |
| Reuse | Did it reimplement something that already exists (a validator, money or date util, permission check)? |
| Complexity | Abstractions with only one use, speculative generality, configuration nobody needs |
| Coupling | Hidden coupling through shared mutable state, globals, or string-keyed lookups |
| Backward compatibility | API and contract changes, serialized formats, removed fields, migration rollback, old clients (mobile) |

---

## Phase D: Correctness review

Go through the list, but spend your time where the PR's risk actually is:

- **Business rules:** totals, rounding, currency and units, sign conventions, date and timezone boundaries, fiscal periods.
- **State transitions:** illegal transitions allowed, terminal states re-opened, steps skipped.
- **Validation:** missing server-side checks, trusting client-provided IDs, prices, or roles.
- **Nullability and optionals:** unhandled empty results, optional fields that are now required.
- **Boundaries:** empty collections, a single element, max sizes, off-by-one, pagination edges.
- **Concurrency:** check-then-act races, lost updates, double submission, non-idempotent retries, missing locks or version columns.
- **Data consistency:** partial writes on failure, caches not invalidated, denormalized fields drifting.
- **Error handling:** swallowed exceptions, wrong status codes, errors that leak internals, retries without backoff.
- **Transactions:** rollback behavior on failure, self-invocation bypassing proxies, long transactions.
- **Resource lifecycle:** unclosed streams, connections, and files; listeners and subscriptions never removed; temp files left behind.
- **Security:**
  - Authentication present on new entry points.
  - **Authorization checked on the resource, not just the route** (insecure direct object reference, IDOR).
  - Injection (SQL, command, template, path).
  - SSRF, unsafe deserialization, file upload handling.
  - Secrets in code or logs.
- **Tenant isolation:** every query and write scoped to the tenant, organization, or user; background jobs carry the tenant context.
- **Performance:** N+1 queries, unbounded queries or loads, missing indexes on new filters, heavy work on the request path, payload size.
- **Regression risk:** shared functions whose behavior changed for existing callers. Find those callers with Grep.

---

## Phase E: Test review

- Map each important behavior from Phase B to the tests that cover it: unit, integration, API, database, UI.
- Check that tests **assert outcomes**, not just that something ran. Watch for mocks that make the test tautological.
- Check the failure and edge cases: invalid input, permission denied, concurrent access, empty data, migration on existing data.
- Check regression coverage for existing behavior the PR changes.
- List the **important behavior with no test**. That list matters more than the coverage percentage.

**Running checks** (skip if `--no-run`):

- Find the real commands in the CI config or the project docs.
- Prefer a targeted run: the affected module or test files. Fall back to the full suite only if it's reasonably fast.
- Run only commands that are local and self-contained. **Never** run anything that deploys, publishes, migrates a shared or remote database, sends messages, or needs production credentials.
- Record the exact command, the exit status, and pass/fail counts.
- If a command can't run (missing toolchain, needs services), record it as *not performed* and say why.
- A passing suite doesn't prove correctness. It only proves the tested paths.

---

## Phase F: Independent verification

For every candidate finding:

1. Open the exact code location. Read the surrounding function and its callers.
2. State the precise conditions (input, state, timing) under which the issue occurs.
3. Check whether something already prevents it: a framework default, a DB constraint, middleware, validation elsewhere, a unique index, an ORM behavior. Check framework semantics when unsure; don't guess.
4. Assign a status:
   - **Confirmed:** the code path demonstrably produces the issue.
   - **Likely:** strong evidence, but it depends on runtime config or data you can't see.
   - **Speculative:** plausible, unverified. Goes to *Open questions*, not *Findings*.
5. State the real consequence: wrong data, a crash, a leak, slowness, or a confusing UX. Size it honestly.
6. Propose the **smallest appropriate fix** that matches the project's patterns.
7. Merge duplicates. One root cause is one finding, listing every affected location.
