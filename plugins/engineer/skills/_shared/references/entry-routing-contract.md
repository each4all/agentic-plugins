# Entry Routing and Decision Contract (engineer)

This contract applies whenever `engineer:start` or an engineer-facing
decision point asks the user whether to continue, split, defer, or change
workflow shape. It exists to keep Claude Code and Codex CLI behavior
equivalent by outcome, state, recovery path, and evidence rather than by
identical syntax.

## Routing Recommendation

Before continuing a non-trivial lifecycle macro, present one routing
recommendation:

| Route | Use when | Command |
|---|---|---|
| `engineer:start` | One coherent deliverable can be carried from idea to commit on the current branch. | `/engineer:start` or `$engineer:start` |
| `orchestrator:plan` | The work naturally splits into 2+ independently completable deliverables, PRs, branches, owners, or dependency edges. | `/orchestrator:plan` or `$orchestrator:plan` |
| `runtime:worktree` | The next slice should be isolated because the current checkout is dirty, long-running, risky, or parallelizable. | `/runtime:worktree plan` or `$runtime:worktree` |
| `runtime:*` | The problem is host readiness, plugin install/update, compatibility drift, context handoff, cutover readiness, or workflow storage. | `/runtime:doctor`, `/runtime:settings`, `/runtime:compat`, `/runtime:context`, `/runtime:cutover` or Codex equivalents |
| Single verb | The user only needs investigation, framing, decision support, composition, critique, or refinement without lifecycle state. | `/engineer:<verb>` or `$engineer:<verb>` |

The recommendation must include the selected route, the rejected
alternatives that were plausible, and the next command to run.

## Decision Prompt Shape

When asking for user approval, present a compact decision table with:

- **Options**: 2-4 concrete choices, not vague categories.
- **Tradeoffs**: scope, speed, risk, evidence quality, and workflow impact.
- **Risks**: what can break or be deferred if the option is chosen.
- **Recommendation**: one preferred route with a practical rationale.
- **Confidence**: high / medium / low, based on available evidence.
- **Evidence pointers**: files, commands, artifacts, PRs, or observed states.
- **Default next command**: the exact command or skill mention that continues.

Do not ask the user to choose from raw implementation details without this
comparison. If evidence is weak, say what evidence would change the
recommendation.

## Standards and Root-Cause Gate

Before recommending a quick implementation or refinement path, state the
quality gate:

- source of truth or standard being followed;
- invariant or root cause that the change is meant to preserve or address;
- verification evidence required before the work can be considered complete;
- rollback, defer, or escalation path if the gate cannot be met.

This gate is not optional. A fast change that does not preserve the
standard/root-cause/evidence line should be routed back to
`engineer:investigate`, `engineer:decide`, or `orchestrator:plan`.

### Routing into `engineer:decide` — decision sizing (ADR-0027 §1.5)

When the route is `engineer:decide`, surface the **decision size** as
part of the route. `engineer:decide` accepts a `--size=<tier>` flag
that simultaneously controls the ritual depth and the axis preset
per ADR-0027 §1.5(2):

- `--size=minor` → `compact` 4-axis preset (essence, foundation,
  practical-fit, **entry-routing-guarantee**). The
  `entry-routing-guarantee` axis is the axis-aware encoding of the
  Standards/Root-Cause gate above and is **hard-gated** for the
  compact preset per ADR-0027 §1.3: if any of the 4 guarantees
  (source-of-truth, root-cause/invariant, verification evidence,
  rollback path) is missing or unmet, lower confidence or route
  back. Use for config flips, small fixes, and other "minor"
  granularity decisions.
- `--size=standard` (or no `--size` flag) → `default` 5-axis preset
  (essence, foundation, standards, best-practice, practical-fit).
  This is the backward-compatible default; the Standards/Root-Cause
  gate above remains the prose-level check.
- `--size=major` → `nine-axis` 9-axis preset (standards,
  recommendation, canonical-precedent, essence, foundation,
  extensibility, maintainability, maturation, practical-fit) +
  auto-enabled **sensitivity** analysis (±20% per-axis weight
  perturbation flip detection). Use for architectural forks and
  decisions whose ritual depth justifies a 9-axis comparison.

`--preset=<id>` overrides the size→preset implication for axis-set
identity but keeps `--size` as the ritual depth (per ADR-0027 §1.5
combined-flag rule). `--weights=<spec>` opts into sensitivity
analysis at any size. The Brainstorm peer ensemble inherits the
same axis frame via the `<axis_awareness>` prompt block per
ADR-0027 §4 — the peer's tradeoff vocabulary aligns with the
orchestrator's resolved preset.

## Quality-First Defaults

Engineer optimizes for result quality, not token minimization, unless the
user explicitly constrains budget, latency, or peer breadth. The default
policy is:

- **Default peer breadth**: run the documented phase-boundary peer ensemble
  when the phase calls for it; do not skip Claude/Codex peer collection merely
  to save tokens.
- **Model/effort defaults**: use host-native defaults or explicit
  `runtime:settings` model/effort configuration. Do not downshift model or
  effort for token saving without a user-supplied constraint.
- **Review depth**: use the deepest review surface implied by the workflow
  phase, including `parallel-review` for Phase 5 and re-review after refine
  until findings converge or a design-level issue is surfaced.
- **User constraints**: when the user requests budget, latency, model, effort,
  or peer limits, treat those as explicit constraints and state the quality
  tradeoff before proceeding.
