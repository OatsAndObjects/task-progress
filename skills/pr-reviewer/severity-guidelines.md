# Severity Guidelines

Severity measures **production consequence × likelihood**, not how much effort the fix takes or how ugly the code is.

## Levels

### P0: Critical production issue

It will cause serious harm soon after deploy, or it's irreversible.

- Data loss or corruption on a common path, or a migration that destroys or mangles existing rows.
- A security hole: auth bypass, cross-tenant data access, injection on reachable input, a secret committed.
- A crash or outage of a core flow: startup failure, a migration that fails on real data, an unbounded query on a hot path.
- Money or ledger figures computed wrong on the normal path.

### P1: High-impact correctness, security, or data integrity issue

A real defect with significant impact, reachable under realistic conditions.

- Wrong results on a realistic edge case: a boundary date, an empty set, a partial failure.
- A missing authorization check on a specific resource, even when the route itself is authenticated.
- A race or non-idempotent retry that can double-apply writes.
- Non-atomic multi-step writes that can leave inconsistent state.
- A breaking API or contract change with existing consumers (for example, deployed mobile clients).

### P2: Moderate issue or meaningful missing verification

- Error handling that loses information or returns the wrong status, without corrupting data.
- A performance problem that will grow with data (N+1, missing index) but isn't urgent yet.
- **Risky behavior with no test:** a money path, a state machine, or an auth rule left unverified.
- A clear deviation from the project's architecture that will cost real maintenance effort.

### P3: Minor improvement

- Small robustness gaps with low impact, duplicated logic that should reuse an existing helper, misleading names that could cause future bugs.
- Keep P3s few. If you have more than about 5, keep the most useful ones.

## Status (orthogonal to severity)

| Status | Meaning | Where it goes |
|---|---|---|
| Confirmed | The code path demonstrably produces the issue | Findings |
| Likely | Strong evidence; depends on config or data not visible | Findings, marked *Likely* |
| Speculative | Plausible but unverified | Open questions |

A *Likely* issue keeps its severity, but say what would confirm it.

## Not findings

- Formatting, naming taste, import order, comment wording.
- "I would have designed it differently," unless the current design causes a concrete problem.
- Pre-existing issues the PR didn't introduce or make worse. Mention them only if the PR makes them reachable or more severe, and label them as pre-existing.

## Final assessment

| Verdict | When |
|---|---|
| **REQUEST CHANGES** | Any Confirmed or Likely P0 or P1, or several P2s that together make the change unsafe |
| **NEEDS INVESTIGATION** | No confirmed blockers, but an open question could plausibly be P0/P1, or key checks couldn't be run on a high-risk change |
| **APPROVE** | No P0/P1; remaining P2/P3 items can be follow-ups. Say which P2s you'd still want addressed. |

Never approve or merge on the platform. The verdict is a recommendation to the human reviewer.
