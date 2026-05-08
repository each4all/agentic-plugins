# ADR-0018: Stage 3+ architecture — orchestration capability, branch-as-workflow-context, cross-host verification

## Status

Accepted

## Context

Stage 2.5+ ADR-0017 5 sub-decisions are all Implemented (PR2 #46 / PR3
#47 / PR4 #48 / PR5 #49 merged into `main`). With those PRs, the
engineer plugin reaches *self-development sufficient* — six cognitive
verbs + three meta commands (resume / checkpoint / peer-now) +
schema 1.1 frontmatter (latest_checkpoint, ensemble_results,
pending_ensemble, terminal_marker, child_completions) + Stop hook
auto-archive (4-gate) + bidirectional companion ensemble.

However, two stances remain unresolved:

1. **ADR-0011 §Stage 2 Non-Goals (9 items)** were declared but not all
   re-evaluated after PR2-PR5. Some are now sufficiently addressed by
   PR2-PR5 (e.g., `#6` resume/checkpoint/audit separate commands), but
   most still carry the original "deferred" or "out-of-scope" stance
   without an explicit owner ADR.
2. **omcc-dev capability gap** — engineer is *self-development
   sufficient* but not a *feature-superset* of omcc-dev (memory
   `project_engineer_vs_omcc_dev_scope` records this distinction).
   The most visible gap surfaces in multi-deliverable workflows like
   the ADR-0017 5-PR stack itself: omcc-dev's `/start` deliverable
   mode (sharded layout + `plan.deliverables[]`) self-hosts that
   shape; engineer cannot.

A six-item review (chat-driven, 9-axis quality matrix per memory
`feedback_decision_methodology_quality_axes`) addressed both stances:

| # | Item | Source |
|---|------|--------|
| 1 | Multi-deliverable orchestration location | ADR-0011 §Non-Goal #1 |
| 2 | Drift classification precision | ADR-0011 §Non-Goal #2 + ADR-0017 §sub-1 |
| 3 | Multi-active workflows | ADR-0011 §Non-Goal #5 |
| 4 | Phase-machine equivalent (`/start`, `/fix`) | omcc-dev capability gap |
| 5 | `active.md` registry file | ADR-0011 §Non-Goal #7 |
| 6 | Cross-host transition guarantees | ADR-0011 §Non-Goal #3 |

The six items are facets of a single Stage 3+ architecture vision and
are best decided as one cascade rather than six independent ADRs.
This ADR captures that decision.

## Decision

### Architectural shape (ADR-0010 4-layer composition, applied)

```
L1 framework: plugins/companions   (existing — cross-host bidirectional bridges)
L2 capability: plugins/orchestrator (NEW — multi-deliverable macro plan)
L3 persona:   plugins/engineer    (existing — single-deliverable verb chain)
L4 profile:   sub-discipline (engineer:backend / :frontend / :devops / ...)
```

The L2 capability slot — vacated when the Stage-1 `plugins/research`
contract was absorbed into `engineer:investigate`'s `cited-brief`
profile (ADR-0014, ADR-0015) — is occupied by `plugins/orchestrator`.
This is the *first time* the L2 slot has a multi-verb occupant
(`/orchestrator:plan` + `/orchestrator:next` + `/orchestrator:done`
+ meta commands), distinct from the single-verb capability precedent
(ADR-0010 §3 `<capability>:<capability>` rule).

### Sub-decision 1 — Multi-deliverable orchestration → `plugins/orchestrator` L2 plugin (resolves Non-Goals #1, #4)

- **Location**: new L2 capability plugin at `plugins/orchestrator/`.
- **Responsibility**: macro plan + execute + ensemble-verify for
  multi-deliverable workflows. Single Responsibility — orchestration
  *only*. Cognitive activity (single-deliverable thought-process)
  remains engineer's responsibility.
- **engineer relationship**: orchestrator → engineer is a cross-plugin
  invocation, modelled on the companions invocation pattern. The
  orchestrator triggers a deliverable's verb chain inside engineer;
  engineer's verb-chain output flows back to the orchestrator's
  subtask record.
- **Sharded layout (file separation)**: NOT adopted. orchestrator
  uses a single workflow file with a flat `subtasks[]` frontmatter
  array. Per-deliverable phase machines run *inside engineer's
  single-deliverable workflow files*, not as orchestrator shards.
  This preserves single-file simplicity (no lock-order across files)
  while still expressing multi-deliverable orchestration.
- **Workflow file location**:
  `.claude/agentic-orchestrator/workflows/<workflow-id>.md`. The
  same `<repo>/.claude/agentic-<plugin>/` convention engineer uses.

Frontmatter shape (orchestrator workflow):

```yaml
schema: '1.0'                # orchestrator's own schema, distinct from engineer's
workflow_id: macro-<verb>-<iso>-<rand>
workflow_type: macro
git_baseline: { branch, head, status_digest }
current_phase: ...
next_action: ...
plan:
  decision: "<chosen approach + rationale>"
  architecture: "<key invariants>"
  subtasks:
    - id: PR1
      label: schema-1.1-reader
      branch: feat/engineer-schema-1.1
      blocked_by: []
      status: completed | in_progress | pending | blocked
      engineer_workflow_id: <engineer workflow that ran this subtask>
      commit: 67ca92a
      pr_url: https://github.com/.../pull/44
      closed_at: 2026-05-07T...Z
    - id: PR2
      ...
ensemble_results: [...]      # macro-level Plan-verify ensembles
pending_ensemble: [...]
host_history: [...]
```

Commands:

- `/orchestrator:plan <feature description>` — macro plan + Plan-verify
  ensemble (Codex peer). Writes `plan.subtasks[]`.
- `/orchestrator:next` — next unblocked subtask → engineer verb-chain
  invocation (cross-plugin). engineer's workflow_id recorded in
  `subtasks[i].engineer_workflow_id`.
- `/orchestrator:done <subtask-id>` — mark subtask completed.
- `/orchestrator:resume`, `/orchestrator:checkpoint`,
  `/orchestrator:peer-now` — meta commands (reuse engineer's pattern).

Cross-plugin invocation contract: separate ADR (Sub-decision 1
follow-up) when implementation begins.

### Sub-decision 2 — Active workflow context = git branch (resolves Non-Goal #5)

- **Active determination**: `git branch --show-current` ⊕ frontmatter
  `git_baseline.branch` matching. The active workflow is the unique
  workflow file whose `git_baseline.branch` equals the current branch.
- **Multi-workflow files coexist**: many workflow files may live in
  `<repo>/.claude/agentic-<plugin>/workflows/`. At any moment, exactly
  one (or zero) matches the current branch.
- **`state.mjs findActiveWorkflow`**: extends to filter by branch +
  frontmatter match. Both engineer and orchestrator share this rule.
- **Single-active invariant per branch**: ADR-0011 §1 invariant is
  preserved within a branch. Multi-branch repos enjoy *natural
  multi-active* — each branch carries its own workflow.
- **Branch switching**: `git checkout` automatically swaps the active
  workflow context. No archive prompt, no resume command needed for
  the *new* branch — its workflow becomes active by virtue of the
  branch matching.
- **Stash compatibility**: `git stash` temporarily swaps tree without
  changing branch — workflow stays active for the same branch.

This applies symmetrically to engineer and orchestrator workflow
files.

### Sub-decision 3 — Drift classification (resolves Non-Goal #2 + ADR-0017 §sub-1 §Out of scope)

- **2-tier (clean / dirty) retained**. Classification depth is
  proportional to *behavioural branching available*; without an
  auto-reconciliation actor, finer classification is cosmetic noise.
- **Dirty case is enriched** with native git introspection in
  `commands/resume.md` Phase 2:
  - `git log <baseline.head>..HEAD --oneline` — commits since baseline
  - `git diff --stat HEAD` — file-level change footprint
  - `git log --diff-filter=R --name-status <baseline.head>..HEAD` —
    state-referenced renames
  - `git log --diff-filter=D --name-status <baseline.head>..HEAD` —
    state-referenced deletes
  - Explicit user notice: "current plugin does not auto-reconcile;
    review and decide [resume / archive / abort]"
- **4-tier upgrade trigger**: an auto-reconciliation actor lands
  (orchestrator's `/orchestrator:next` deciding *whether* to
  re-dispatch a subtask vs flag it conflicting). Until then, 4-tier
  is deferred per ADR-0017 §sub-1 §Out of scope.

This applies symmetrically to engineer and orchestrator.

### Sub-decision 4 — `active.md` registry stays absent (resolves Non-Goal #7)

- **Source of truth**: filesystem (workflow files) + git (branch).
  Both engineer and orchestrator workflow directories are dir-listed.
- **No manifest file**: ADR-0011 §7 intentional simplification is
  preserved AND reinforced by sub-decision 2 (branch=workflow makes
  active determination a git query, not a manifest lookup).
- **Cache evolution path**: if dir-listing cost ever measurable
  (e.g., hundreds of stale workflow files survive auto-archive),
  introduce a git-ignored `.engineer-state-cache.md` *as cache*
  (not as truth). Source of truth stays filesystem. Trigger pending.

### Sub-decision 5 — Cross-host transition: integration test contract (resolves Non-Goal #3)

- **Sequential transition explicit guarantee**: claude → codex AND
  codex → claude resume on the same workflow file MUST work, with
  `host_history` append-only and `findActiveWorkflow` returning the
  same workflow under both hosts.
- **Test surface**: `tests/cross-host/`
  - `test-claude-to-codex-resume.mjs` — claude-side workflow create
    + verb chain → codex-side resume + verb chain → state coherence
  - `test-codex-to-claude-resume.mjs` — reverse direction
  - `test-stop-archive-cross-host.mjs` — Stop hook `runStopArchive`
    contract identity under both hosts (PR4 test extension)
- **Concurrent operation race (out of scope)**: two hosts editing
  the same workflow file at the same instant is rare enough to
  defer to a future ADR triggered by an actual incident report.
  `withFileLock` is single-process; multi-process / multi-host
  concurrent locking is not yet contracted.
- **CI**: a `cross-host` job slot in `.github/workflows/` matrix.
  Hooks for both hosts are simulated in-process (no real CLI
  required for the contract verification itself).

This applies to engineer + orchestrator + any future L3 persona
plugin.

### ADR-0011 §Stage 2 Non-Goals — cascade after this ADR

| # | Non-Goal (ADR-0011) | Stance after ADR-0018 |
|---|---|---|
| 1 | Sharded workflow layout | **Out of scope** — orchestrator uses single-file flat `subtasks[]`. omcc-dev's sharded layout is a different architectural choice, not adopted (sub-decision 1) |
| 2 | Drift 4-tier classification | **2-tier retained + dirty enrichment** (sub-decision 3). 4-tier deferred to auto-reconciliation trigger |
| 3 | Cross-host transition guarantees | **Sequential guaranteed via test contract** (sub-decision 5). Concurrent transition still deferred |
| 4 | omcc-dev → agentic-engineer migration script | **No change** — clean start preserved (per ADR-0007) |
| 5 | Multi-active workflows | **Resolved via branch=workflow** (sub-decision 2). Plugin-level multi-active still not adopted; multi-branch is the multi-active surface |
| 6 | resume / checkpoint / audit separate commands | **Resolved by ADR-0017 sub-1/sub-2 + ADR-0010 §3 audit alias** (PR2 #46 + PR3 #47 + audit sugar alias) |
| 7 | active.md registry file | **Dir-listing retained + reinforced by sub-decision 2** (sub-decision 4) |
| 8 | Per-step lock-order across files | **Automatically out of scope** — sub-decision 1 keeps single-file. Cross-plugin invocation lock-order is a separate ADR if/when adopted |
| 9 | Plugin-name marketplace aliases | **No change** — host-schema limitation. Deferred to a future Stage 2.5+/3+ ADR if user demand surfaces |

Of the nine, six are now resolved or carry an explicit cascade stance
(#1, #2, #3, #5, #6, #7); two are automatically out of scope (#4, #8);
one remains deferred (#9).

### Architectural one-liner

agentic-plugins Stage 3+: **6 cognitive verbs (engineer)** ×
**multi-deliverable orchestration (orchestrator)** × **git branch =
workflow context** × **cross-host sequential transition (verified)**.

This is omcc-dev's *single-plugin / sharded-layout* model decomposed
along the 4-layer composition axis (per
`project_design_intent` — agentic-plugins is a redesign, not a port).

## Consequences

### Positive

- **ADR-0010 4-layer composition** sees its first concrete
  multi-verb L2 capability occupant. The 4-layer model is no longer a
  spec-only construct.
- **AI macro orchestration value preserved** — Plan-verify ensemble
  remains available at the macro plan layer (orchestrator), not
  pushed to human axis.
- **engineer SRP sharpened**: cognitive workbench only. Existing
  `plugins/engineer` v0.5.0 surface is unchanged by this ADR.
- **git branch + workflow identity unification**: user mental model
  simplifies. `git checkout <branch>` is the primary context-switch
  primitive. No new "switch workflow" UX.
- **Cross-host operations explicitly verified** by test contract,
  not just "works in practice".
- **Multi-deliverable workflows** like ADR-0017's own 5-PR stack
  become self-hostable on agentic-plugins (orchestrator + engineer)
  without omcc-dev dependency. Closes the dogfood gap surfaced in
  memory `project_engineer_vs_omcc_dev_scope`.
- **omcc-dev removal preconditions (ADR-0012)** advance: condition 3
  (Stage 3 cushion) gains a concrete next-PR pipeline.

### Negative

- **New plugin** (`plugins/orchestrator`) means scaffolding cost
  (manifest × 2, commands directory, scripts/, hooks/, tests,
  marketplace catalog entry × 2). Cost is amortised across multiple
  follow-up PRs per the ADR-0017 trigger-driven pattern.
- **Two-plugin install burden**: users running multi-deliverable
  workflows must install both engineer AND orchestrator. Single-
  deliverable users can ignore orchestrator entirely (engineer
  remains self-contained).
- **Cross-plugin invocation contract** must be defined (orchestrator
  → engineer handoff). Likely reuses companions' invocation pattern
  but needs its own ADR when implementation begins.
- **Cross-host integration test** adds CI minutes. Trade-off
  acknowledged; the alternative (test-less guarantee) carries higher
  risk per memory `feedback_decision_methodology_quality_axes`.
- **ADR-0011 amendment vs new ADR**: ADR-0011 §Non-Goals #1 / #5 / #7
  are effectively *resolved differently* than the original
  "Out-of-scope, raise follow-up ADR" wording suggested. Per
  `docs/adr/README.md` §"Amendments vs Supersedes", the resolution
  here is *cascade* (this ADR adds resolution stance to ADR-0011's
  open items) rather than supersede. ADR-0011 itself stays
  Accepted; an Amendment header may be added pointing to this ADR.

### Neutral

- User operational pattern shifts: omcc-dev `/start <feature>` one-
  shot is replaced by `/orchestrator:plan` (macro plan) + repeated
  `/orchestrator:next` (per-deliverable invocation that itself runs
  engineer verb chains). Equivalent capability, different command
  surface.
- Workflow file directories diverge:
  `.claude/agentic-engineer/workflows/` (verb chains) vs
  `.claude/agentic-orchestrator/workflows/` (macro plans). Each
  plugin owns its directory; users see two adjacent dirs after both
  plugins install.
- Existing PR4/PR5 patterns (the ADR-0017 5-PR stack itself) remain
  authored under omcc-dev *until* orchestrator MVP lands. After that,
  similar future work uses orchestrator. The transition is
  one-directional and one-time.

## Alternatives Considered

Each sub-decision was evaluated using the 9-axis quality matrix
(`표준 / 권장 / 정석 / 본질 / 근본 / 확장 / 유지보수 / 고도화 /
실용성`) with workload deliberately excluded from the comparison
axes (per memory `feedback_decision_methodology_quality_axes`). The
chosen options scored ◎ on the largest number of axes with zero ×
votes.

### Sub-decision 1 — Orchestration location

- **A. Adopt sharded layout inside engineer (omcc-dev parity)** —
  rejected. ADR-0010 §6 verb-atomic principle and ADR-0001
  hexagonal core/adapter separation conflict with macro+micro in one
  plugin. Maintenance cost of `continuity-protocol.md`-equivalent
  spec (~60 KB) is also high.
- **B. Engineer-internal flat macro orchestration (`subtasks[]` in
  engineer's frontmatter)** — rejected. Partial SRP violation;
  engineer would carry both cognitive and orchestration
  responsibilities in one plugin. Future migration to L2 forced
  later.
- **D. External-only (GitHub Issue + ADR + git PR + verb chain)** —
  rejected after user push-back ("AI 오케스트레이션을 완전히
  배제할꺼야?"). Pushes AI macro orchestration value to human axis,
  loses Plan-verify ensemble at macro level, weakens framework
  identity (agentic-plugins is *agent collaboration framework*).

### Sub-decision 2 — Multi-active modelling

- **A. engineer + orchestrator both single-active strict** —
  rejected. Branch switch forces archive prompt; no natural
  context-switch UX.
- **B. Engineer single + orchestrator multi (asymmetric)** —
  rejected. Two plugins with different invariants is a modelling
  inconsistency; missed the standardisation that branch=workflow
  offers.
- **C. Both multi-active (omcc-dev parity)** — rejected. workflow_id
  identity overlaps with git branch identity, creating two truth
  systems with drift risk. Re-implements what git already provides.

### Sub-decision 3 — Drift classification

- **A. Adopt 4-tier (clean / compatible / conflicting / rewound)** —
  rejected. Premature optimisation: classification refinement
  without auto-reconciliation actor is cosmetic. Stays pending an
  auto-actor trigger (orchestrator may surface it later).
- **B. 3-tier git-native (clean / advanced / diverged)** — rejected.
  Direct git mental model is the strength, but pure ahead/behind
  classification at plugin level adds little if dirty enrichment is
  already exposed.
- **D. Status quo (no enrichment)** — rejected. Leaves the user with
  ambiguous "dirty" without actionable detail.

### Sub-decision 5 — Cross-host transition

- **B. Best-effort stance, no test** — rejected. Honest but leaves
  agentic-plugins core value (cross-host bidirectional companions,
  cross-host workflow file format) unverified.
- **C. Status quo (ADR-0011 §3 wording unchanged)** — rejected.
  Ambiguous to users.
- **D. Explicit guarantee without verification** — rejected. False
  sense of security; agentic-plugins memory pattern is
  verify-or-leave-honest, not promise-without-verify.

## Implementation Roadmap

This ADR is an *architecture decision*, not an implementation
specification. Each sub-decision ships in its own PR per the
ADR-0017 trigger-driven pattern:

| Sub | Owner PR theme | Acceptance trigger |
|-----|----------------|--------------------|
| 1 | `feat: plugins/orchestrator scaffolding` (likely multi-PR) | First multi-deliverable feature after this ADR merges, or user explicit request to implement orchestrator MVP |
| 2 | `refactor(plugins/engineer): branch=workflow active matching` | Multi-branch operation case surfaces, or batch with sub-decision 1 PR |
| 3 | `feat(plugins/engineer): drift report dirty case enrichment` | First dirty resume report or batch with sub-decision 1 |
| 4 | (no code change; cascade stance only) | This ADR merge |
| 5 | `feat: tests/cross-host/` integration test | Multi-host operation begins or batch with sub-decision 1 |

The cross-plugin invocation contract (orchestrator → engineer) is
itself a sub-ADR; it surfaces when sub-decision 1's first PR begins
implementation.

## References

- ADR-0001 — Hexagonal architecture (core ↔ adapter separation
  motivates orchestrator vs engineer split)
- ADR-0010 — Plugin boundary policy + 4-layer composition + 6
  cognitive verbs (orchestrator occupies L2)
- ADR-0011 — Workflow continuity storage (Stage 2 Non-Goals; cascade
  resolution above)
- ADR-0012 — omcc-dev removal preconditions (this ADR advances
  condition 3)
- ADR-0014 — `plugins/research` deprecation (vacated the L2 slot)
- ADR-0017 — Stage 2.5+ continuity and schema roadmap (PR2-PR5
  precedent for trigger-driven multi-fire pattern)
- omcc-dev `continuity-protocol.md` v2.10.0 — external reference,
  comparison source for the 6-item review
