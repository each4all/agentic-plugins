# ADR-0020: engineer integrated workflow umbrella — `/engineer:start` lifecycle macro command

## Status

Accepted (4-PR roadmap shipped 2026-05-12 — #69 ADR text, #70 PR 2 schema, #72 PR 3 lifecycle macro, #73 PR 4 manifest)

## Context

[ADR-0019](0019-cross-plugin-invocation-contract.md) PR-A through PR-E
merged (2026-05-11) brought `plugins/engineer` and `plugins/orchestrator`
to surface-level parity with omcc-dev's multi-deliverable workflow
machinery — both plugins now share schema 1.1 parent-linkage,
`/orchestrator:plan` + `/next` + `/done` + `/finalize` + `/abort`,
cross-plugin invocation contract (parent → child only), and Stop hook
A1–A4 auto-archive gates. [ADR-0012](0012-omcc-removal-preconditions.md)
condition 1 (engineer reached omcc-dev parity) is **satisfied** as of
[#68](https://github.com/each4all/agentic-plugins/pull/68).

A capability gap remains, however: agentic-plugins' own development
still uses `omcc-dev:/start` because the **single-deliverable
lifecycle umbrella** has no agentic-plugins-side surface. The engineer
plugin exposes the six canonical cognitive verbs
(`investigate / frame / decide / compose / critique / refine`) and
three meta commands (`resume / checkpoint / peer-now`) plus one sugar
alias (`audit ≡ critique --profile=full-codebase`), but it has no
command that *sequences* those verbs through the canonical 7-phase
lifecycle (Brainstorm → Explore → Plan-Verify → Implement → Review →
Resolve → Commit, with a Phase 0 continuity check). The orchestrator
plugin owns macro multi-deliverable orchestration per
[ADR-0018](0018-stage3-architecture-orchestrator-and-branch-context.md)
§sub-1, intentionally scoped to *deliverable-level* coordination
(N subtasks dispatched as cross-plugin engineer verb invocations);
the *single-deliverable lifecycle* — what omcc-dev's `/start` covers
in its single-pass mode — has no agentic-plugins owner.

Without that umbrella, the user's dogfood workflow for ADR-0020
itself — designing and authoring this ADR — was run on
`/omcc-dev:start`. ADR-0012 Cond 3 (engineer alone is sufficient for
agentic-plugins' continued development) cannot accumulate evidence
while every non-trivial workflow still routes through omcc-dev. The
missing surface is the decisive gap.

This ADR fills the gap. The seven sub-decisions below resolve umbrella
form, phase-to-verb mapping, ensemble dispatch points, resume/checkpoint
integration, continuity protocol relation, orchestrator role split, and
diagnose-first redundancy tooling.

### Pre-ADR brainstorm + 9-axis evaluation

Each sub-decision was evaluated against the 9-axis quality matrix
(`표준 / 권장 / 정석 / 본질 / 근본 / 확장 / 유지보수 / 고도화 /
실용성`) per the user's decision methodology (workload deliberately
excluded — `feedback_decision_methodology_quality_axes` memory item).
A Codex brainstorm ensemble (independent option generation) and a
Codex explore ensemble (codebase architecture mapping) ran in
parallel; the chosen options carried 7+ `◎` votes across the 9 axes
in every case. A Codex plan-verify ensemble surfaced seven critical
adjustments (including this ADR's alignment with the
ADR-0017/ADR-0019 1.1-additive precedent) that are folded into the
sub-decisions below.

## Decision

### Sub-decision 1 — `/engineer:start` (command-only lifecycle macro inside `plugins/engineer`)

A new command `plugins/engineer/commands/start.md` is added. It is
**neither a verb nor a verb-level sugar alias** (cf. ADR-0010 §3) — it
is a lifecycle macro command at the same surface level as the
existing engineer meta commands (`resume / checkpoint / peer-now`).
The six canonical cognitive verbs and `VALID_VERBS` enum remain
unchanged.

`/engineer:start <feature>` sequences seven phases (per Sub-decision 2)
through the engineer verb skills, with phase-boundary Codex ensemble
dispatches (Sub-decision 3) and continuity tracking through the
existing engineer workflow file (Sub-decision 4 + 5).

Rejected alternatives (Alternatives Considered §A, §C):

- **`/orchestrator:start` extension** (orchestrator extends to
  single-deliverable lifecycle as a degenerate 1-subtask case):
  rejected on the *本질* axis. ADR-0012 Cond 3 specifies "engineer
  alone is sufficient"; routing single-deliverable lifecycle through
  orchestrator turns "engineer alone" into "engineer + orchestrator
  alone" and weakens Cond 3's evidential clarity. The 9-axis score
  was 6 `◎` / 3 `◯` vs `/engineer:start`'s 8 `◎` / 1 `◯`.
- **New `plugins/workflow` L2 capability plugin**: rejected on
  ADR-0010 §6 separation triggers. Triggers 1 (2+ consumer plugins),
  2 (distinct cost/quota/auth), and 3 (install-time mental-model
  discontinuity) all fail or are borderline. The plugin would be a
  thin dispatcher with no second consumer, violating premature-
  extraction guidance.

### Sub-decision 2 — Phase ↔ verb composite mapping (explicit chain)

`/engineer:start`'s seven phases map to the six cognitive verbs
through a *composite chain* where some phases invoke multiple verbs
internally:

| Phase | Name | Verb chain |
|---|---|---|
| 0 | Continuity check | (no verb — workflow bootstrap or append-on-resume) |
| 1 | Brainstorm | `investigate` (option generation) → `frame` (5-perspective model) → `decide` (recommend + approve) |
| 2 | Explore | `investigate --profile=analysis` (codebase architecture) |
| 3 | Plan-verify | `compose --profile=plan` (plan artifact) → `critique` (plan-verify ensemble check) |
| 4 | Implement | `compose --profile=code` (per-task RED-GREEN-REFACTOR loop) |
| 5 | Review | `critique --profile=parallel-review` (side-effect + correctness pass) |
| 6 | Resolve | `refine` (iterate until findings converge) |
| 7 | Commit | (no verb — terminal runbook: commit + optional PR) |

Phase 1 brainstorm is the composite case: omcc-dev's brainstorm skill
internally generates alternatives (Investigate), frames them in a
5-perspective comparison (Frame), and recommends a direction (Decide).
The composite preserves that semantic. User-facing UI may shorten to
"Phase 1 brainstorm → decide" when surface granularity is acceptable,
but the ADR text and implementation guide retain the chain.

Rejected alternative: Phase = single primary verb (e.g.,
Phase 1 = `decide` only). Rejected because Phase 1 brainstorm
internally produces three distinct artifact kinds (option list, frame
model, recommendation) and collapsing them flattens omcc-dev parity.

### Sub-decision 3 — Phase-boundary Codex ensemble dispatch (always-max, 5 points)

`/engineer:start` dispatches a Codex ensemble at every phase boundary
that omcc-dev's `/start` dispatches one, using engineer's always-max
ensemble protocol (no per-phase affinity gating):

| Phase | Ensemble type | Scope |
|---|---|---|
| 1 — Brainstorm | `brainstorm` | Codex generates independent alternatives in parallel; Synthesize merges with Claude's option set |
| 2 — Explore | `explore` | Codex provides architecture + integration analysis |
| 3 — Plan-verify | `plan-verify` | Independence Rule exception — Codex receives Claude's draft plan to find gaps |
| 4 — Implement | (none at phase boundary) | Mid-task brainstorm dispatch is allowed when ambiguity surfaces |
| 5 — Review | `review --scope working-tree` | Codex review independent of Claude's parallel-review |
| 6 — Resolve | `review --scope working-tree` | Re-review after fix; fresh `run_id` per loop |
| 7 — Commit | (none) | Terminal runbook |

Each ensemble follows `ensemble-protocol.md` State Bookkeeping (atomic
`pending_ensemble` append on dispatch, atomic
`(remove pending → append ensemble_results → prune)` on
Synthesize). The `MAX_ENSEMBLE_RESULTS_PER_WORKFLOW` retention cap is
honored.

Rejected alternative: minimal dispatch (Phase 1, 3, 5 only). Rejected
because Phase 2 explore and Phase 6 resolve drop independent Codex
perspective that omcc-dev surfaces by default — measurable peer value
lost.

### Sub-decision 4 — Auto-resume on active workflow (engineer 6-verb pattern continuation)

`/engineer:start` Phase 0 mirrors the existing engineer 6-verb command
Phase 0 pattern:

- `state.mjs find-active --repo-root <root>` → empty path → bootstrap
  new workflow (`state.mjs create`).
- Non-empty path → read the frontmatter `workflow_type`:
  - `workflow_type: start` → append-on-resume
    (`state.mjs append --event resumed`), advance to recorded
    `current_phase`.
  - `workflow_type: verb-chain` (or absent, treated as `verb-chain`
    by default) → **surface a typed conflict** rather than appending:
    `/engineer:start` would otherwise mutate a single-verb workflow's
    `current_phase` into the lifecycle macro phase space. The PR 3
    runbook prints the active workflow id + path, the recorded
    `verb` + `current_phase`, and the available termination paths
    (below), then exits non-zero so the user can resolve the
    conflict deliberately.

This preserves ADR-0018 §sub-2 branch=workflow invariant: at most one
active workflow per branch. The existing meta commands `/engineer:resume`
and `/engineer:checkpoint` remain orthogonal and may be invoked
mid-`/engineer:start` by the user without interference.

A user who wants a fresh `/engineer:start` workflow on an already-active
branch (whether the active workflow is `verb-chain` or `start`) must
clear the existing workflow first via one of the existing termination
paths — `/engineer:start` does NOT auto-archive on conflict:

- Switch to a new branch (`git switch -c <new>`); the new branch has
  no active workflow, so `/engineer:start` bootstraps cleanly.
- Let the existing workflow reach `commit-complete` naturally; the
  Stop hook's A1–A4 gate (`stop-archive.mjs:47-92`) auto-archives.
- Manually archive via `/engineer:resume archive <workflow_id>` (the
  archive sub-flow on the existing `/engineer:resume` command per
  ADR-0017 sub-decision 1).

A new `/engineer:abort` command is **out of scope** for this ADR. If
fresh-start UX surfaces a sustained demand, a future ADR may add
`/engineer:abort` symmetric to `/orchestrator:abort` (ADR-0019 PR-E)
— but ADR-0020 does not commit to one.

Rejected alternatives:

- **omcc-dev Phase 0 prompt parity** (resume / start-new / archive
  three-way prompt at re-invocation): rejected because it is
  inconsistent with the engineer 6-verb command pattern (each verb
  auto-resumes silently) and adds prompt cost for the common case.
- **Strict-error on active**: rejected as a regression in UX; auto-
  resume covers the common case better.

### Sub-decision 5 — Continuity schema: `workflow_type` field (1.1-additive)

A new optional frontmatter field is added to engineer's workflow file
schema:

```yaml
workflow_type: verb-chain | start
```

- Default value (on read when absent): `verb-chain`. Existing engineer
  workflows created before this ADR's implementation have no
  `workflow_type` field; the reader treats them as `verb-chain`
  transparently.
- `verb-chain` — single-verb workflows produced by direct verb command
  invocations (e.g., `/engineer:investigate`, `/engineer:critique`).
  This is the historical engineer workflow shape.
- `start` — lifecycle macro workflows produced by `/engineer:start`.

The `verb` frontmatter field retains its existing semantic (the
*primary verb* of the current phase). Under `workflow_type: start`,
`verb` is updated at each phase transition to reflect that phase's
primary verb: `investigate` (Phase 1 brainstorm composite entry), then
`decide` (Phase 1 closing), `investigate` (Phase 2 explore), `compose`
(Phase 3 plan and Phase 4 implement), `critique` (Phase 5 review),
`refine` (Phase 6 resolve). Phase 7 (commit) is a runbook (no verb
update) — `state.mjs set-terminal` writes only `current_phase` +
`terminal_marker` per the existing engineer schema-1.1 contract, so
the workflow file's `verb` field at archive time is whatever Phase 6
last set (typically `refine`). This is intentional: the verb field
represents *the last cognitive activity performed*, not the commit
step, which has no cognitive verb. The `VALID_VERBS` enum is
**unchanged** (six canonical verbs only); no new verb is introduced.
`current_phase` remains free-form per the existing engineer
convention.

**Precedent compliance**: the field is added as **schema-additive**
within the closed schema, following the explicit
[ADR-0017](0017-stage25-continuity-and-schema-roadmap.md) /
[ADR-0019](0019-cross-plugin-invocation-contract.md) §881-889
*1.1-additive* pattern (`terminal_marker`, `child_completions`,
`latest_checkpoint`, `pending_ensemble`, `ensemble_results`,
`parent_workflow`, `originating_subtask`, `parent_detached` — all
added without a `SCHEMA_VERSION` bump). `SCHEMA_VERSION` stays `'1.1'`;
`SUPPORTED_SCHEMA_VERSIONS` stays `new Set([1, '1.1'])`. The PR-2
implementation updates `FRONTMATTER_KEY_ORDER`,
`SCHEMA_1_1_OPTIONAL_KEYS`, `validateSchema11Fields`, and
`createWorkflowUnderLock` in a single coordinated commit (the
closed-schema parser/serializer rejects unknown keys, so the four
touch points MUST update atomically — same constraint as ADR-0019
PR-A).

Archive lifecycle: workflows with `workflow_type: start` reach
`terminal_marker=true` + `current_phase=commit-complete` and are
auto-archived by the Stop hook's existing A1–A4 gate logic
(`plugins/engineer/scripts/stop-archive.mjs:47-92`) without
modification — the field is read transparently as part of the
frontmatter and does not affect gate evaluation.

### Sub-decision 6 — Orchestrator role split: manual escalation only

The boundary between `/engineer:start` and `/orchestrator:plan` is
**user-chosen at entry**, not automatically inferred:

- single-deliverable feature → `/engineer:start <feature>`
- multi-deliverable feature → `/orchestrator:plan <feature>` (existing
  surface per ADR-0018 §sub-1 + ADR-0019 PR-D `/next` dispatch)

If `/engineer:start`'s Phase 3 plan reveals that the feature is in
fact multi-deliverable, the user is prompted: *"This feature reads
as multi-deliverable. `/engineer:start` is single-pass only. Consider
aborting and restarting with `/orchestrator:plan`."* The user may
elect to either (a) abort the engineer workflow and start an
orchestrator workflow afresh, or (b) proceed with `/engineer:start`
in single-pass mode (equivalent to omcc-dev's `/start` single-pass).

No automatic cross-plugin escalation is performed. This honors
[ADR-0019](0019-cross-plugin-invocation-contract.md) §3 (immutable
parent-linkage — `parent_workflow` and `originating_subtask` are set
exactly once at engineer's `state.mjs create`), §430-433 (manual
post-hoc linking of an engineer workflow to an orchestrator subtask
is *not supported*), and §841-846 (orchestrator-owned verb chains
were explicitly rejected). `/engineer:start` is engineer-internal
verb sequencing and does not transit cross-plugin boundaries.

**ADR-0018 §sub-1 Neutral wording cascade**: the existing wording
("omcc-dev `/start <feature>` one-shot is replaced by
`/orchestrator:plan` …") is corrected — *single-deliverable* `/start`
maps to `/engineer:start`; *multi-deliverable* `/start` maps to
`/orchestrator:plan` + `/next` + `/done` + `/finalize`. See the
ADR-0018 amendment in this PR.

### Sub-decision 7 — Diagnose-redundancy helper (engineer-local, state.mjs subcommand)

A new `state.mjs diagnose-redundancy` subcommand is added in PR-3 of
this ADR's implementation roadmap. It is invoked from
`/engineer:start` Phase 0 before bootstrap (or before append-on-resume)
to detect work-overlap with recently-merged or in-flight changes:

- **Probes**: reuses the existing git introspection from
  `plugins/engineer/commands/resume.md:138, :168-198` —
  baseline-existence guard via `git cat-file -e "$BASE_HEAD^{commit}"`,
  then `git log "$BASE_HEAD..HEAD" --oneline`,
  `git diff --stat HEAD`, `--diff-filter=R` (renames), `--diff-filter=D`
  (deletes). Optional `gh pr list --state open` with graceful fallback
  to `git diff base...HEAD` when `gh` is absent.
- **Output**: JSON-ish stdout with two outcomes —
  `{status: "no-redundancy", scanned: {...}}` or
  `{status: "redundancy", evidence: <ref>, recommended_action: archive}`.
- **Caller policy** (PR 3): `/engineer:start` Phase 0 invokes the
  subcommand and surfaces any non-empty result to the user with the
  recommended action; the user decides to proceed or abort.

**Engineer-local scope**: per
[ADR-0019](0019-cross-plugin-invocation-contract.md) §891-898 and
[ADR-0010](0010-plugin-boundary-policy.md) §6 trigger 1 (lines 235-240), the helper
remains engineer-local until a second consumer (e.g., `/designer:start`
in Stage 3) emerges. Premature extraction to a shared module is
explicitly avoided.

This sub-decision tools-up the existing memory entry
`feedback_diagnose_first_redundancy` (manually-followed checklist) as
a machine-checked Phase 0 step.

### Implementation Guide

`/engineer:start <feature>` runbook (PR 3 deliverable):

1. **Phase 0 — continuity** (mirrors engineer 6-verb command Phase 0):
   - Detached-HEAD guard.
   - `state.mjs find-active --repo-root <root>` → empty | path.
   - Empty → `state.mjs diagnose-redundancy` (D7 helper); on
     `no-redundancy`, bootstrap via
     `state.mjs create --workflow-type start --verb investigate
       --current-phase phase-0-bootstrap …`.
   - Non-empty → read frontmatter `workflow_type`. If `start`, append
     (`state.mjs append --event resumed`) and advance to recorded
     `current_phase`. If `verb-chain` (or absent default), exit with
     a typed conflict diagnostic per §Sub-decision 4 — do NOT append.
2. **Phase 1 — brainstorm**: dispatch `omcc-dev:brainstorm`-equivalent
   composite (investigate → frame → decide); Codex `brainstorm`
   ensemble in parallel; user-approval gate.
3. **Phase 2 — explore**: `investigate --profile=analysis`; Codex
   `explore` ensemble.
4. **Phase 3 — plan-verify**: `compose --profile=plan` →
   `critique`; Codex `plan-verify` ensemble (plan as input per
   Independence Rule exception); user-approval gate. **Multi-
   deliverable detection prompt** per Sub-decision 6 fires here if
   the plan groups into 2+ deliverables.
5. **Phase 4 — implement**: `compose --profile=code` loop; mid-task
   brainstorm dispatch on ambiguity.
6. **Phase 5 — review**: `critique --profile=parallel-review`; Codex
   `review --scope working-tree` ensemble.
7. **Phase 6 — resolve**: `refine` loop; Codex `review` re-dispatch
   per resolve iteration.
8. **Phase 7 — commit**: terminal runbook (commit + optional PR);
   atomic write of `terminal_marker=true` + `current_phase=commit-complete`
   via `state.mjs set-terminal`; Stop hook A1–A4 auto-archives.

**Cross-plugin posture** (ADR-0019 cross-references):

- `/engineer:start` runs entirely inside `plugins/engineer` —
  no `/orchestrator:*` invocation. ADR-0019 §841 (orchestrator-owned
  verb chains rejected) is honored: orchestrator does not "own" the
  verb chain inside `/engineer:start`; engineer dispatches its own
  skills.
- `parent_workflow` and `originating_subtask` are **not set** for
  `/engineer:start` workflows in the typical case. They are set only
  when `/orchestrator:next` dispatches an engineer verb command,
  which is a separate code path. `/engineer:start` workflows are
  *root* workflows from engineer's perspective.
- ADR-0019 §430-433 "Later association of a manually-started
  engineer workflow to an orchestrator subtask is not supported"
  applies as written. Multi-deliverable escalation requires
  abort+restart per Sub-decision 6.

**Codex command-schema asymmetry** (`docs/DEVELOPMENT.md:249`,
ADR-0013 reserved): Claude Code supports slash-command auto-trigger
for `/engineer:start`. Codex CLI's plugin-commands integration is
unfinalized (ADR-0013 reserved pending the Codex CLI command-schema
landing). On Codex side, `/engineer:start` is **not yet an invocation
surface** — the Codex plugin manifest exposes only the six verb
skills via `skills: ./skills/`, and `commands/start.md` is a Claude-
slash-command file with no Codex equivalent. Codex users continue to
drive each lifecycle phase manually via the six `$engineer:<verb>`
skill mentions until the ADR-0013 Codex CLI plugin-commands schema
lands (which will let `commands/start.md` be exposed alongside the
skills). PR 3 documents this asymmetry in the engineer README; PR 4
mirrors it in the Codex manifest's `interface.longDescription`. Full
parity awaits ADR-0013.

## Consequences

**Positive**:

- ADR-0012 condition 3 (engineer alone sufficient) gains an
  evidence-accumulation surface. PR 3 (`/engineer:start` landing) is
  the **trigger candidate** that allows accumulated dogfood evidence
  to begin counting toward condition 3 satisfaction. Per ADR-0012's
  immutable-rubric clause (§"Progress tracking layer", lines 97-98),
  condition 3 satisfaction is
  determined by `docs/DEVELOPMENT.md` accumulated evidence
  evaluation, not by this ADR's merge.
- engineer becomes self-contained for single-deliverable workflows
  — `/engineer:investigate / frame / decide / compose / critique /
  refine` plus the new `/engineer:start` cover the full lifecycle.
  Cross-plugin handoff to orchestrator becomes a *deliberate* user
  action (multi-deliverable selection) rather than an implicit
  dependency.
- ADR-0010 4-layer composition is preserved cleanly: engineer
  (L3 persona) owns single-deliverable; orchestrator (L2 capability)
  owns multi-deliverable; companions (L1 primitive) provides
  cross-host bridges; no new plugin sprawl.
- omcc-dev `/start` parity at the surface — agentic-plugins users
  who carried over from omcc receive an equivalent entry command
  inside the engineer namespace, easing dogfood migration.
- Diagnose-redundancy helper formalizes the
  `feedback_diagnose_first_redundancy` memory item as a machine-
  checked gate. The 2026-05-09 archive-after-diagnose incident
  pattern becomes detectable in Phase 0 rather than emerging
  mid-workflow.

**Negative**:

- Engineer command surface grows from 10 to 11. The plugin-shape test
  `tests/plugin-shape/test-engineer-plugin.mjs` hardcodes "10 commands"
  at line 13 (header comment) and line 374 (`describe(...)`); PR 3
  must update both in lockstep with `commands/start.md` addition.
- The `workflow_type` field, although schema-additive, introduces a
  fourth axis of engineer workflow taxonomy (alongside `persona`,
  `verb`, `profile`). Readers must now distinguish single-verb
  workflows (`workflow_type: verb-chain` or absent) from lifecycle
  workflows (`workflow_type: start`) when interpreting `verb`
  field semantics — single-verb `verb` is invariant; lifecycle
  `verb` is per-phase. Documentation update in `commands/resume.md:124`
  (currently displays `workflow_type: <verb>` as a literal label —
  PR 2 corrects this).
- Multi-deliverable detection in `/engineer:start` Phase 3 is
  prompt-only (no automatic escalation). A user who insists on
  proceeding in single-pass mode for a feature that should be
  multi-deliverable risks low-quality context — Phase 3 ensemble
  validates plan quality but cannot enforce deliverable-mode choice.
  Mitigation: clear Phase 3 prompt copy + Phase 5 review explicitly
  flags scope problems.
- The ADR text itself is long (~600 lines) for what is fundamentally
  one new command plus one optional schema field. Seven sub-decisions
  for one feature is a complexity signal that future similar ADRs
  should examine — the 9-axis matrix tooling and the explicit
  cascade-amendment shape are now load-bearing on future workflow-
  umbrella expansions (e.g., a hypothetical `/designer:start` would
  inherit this ADR's shape).

**Neutral**:

- omcc-dev `/start` behavior split across two agentic-plugins
  surfaces (engineer for single-pass, orchestrator for deliverable
  mode) requires a user decision at entry. omcc-dev's automatic
  in-Phase-3 deliverable-mode detection is replaced by manual user
  fork. Trade-off acknowledged: explicit > implicit for cross-
  plugin work-routing.
- engineer's `workflow_type` enum is bounded to two values
  (`verb-chain | start`) by ADR-0020. Future lifecycle macros (e.g.,
  a hypothetical `/engineer:bisect` debug-lifecycle macro) would
  extend this enum, but no such addition is planned in this ADR.
- The Codex command-schema asymmetry (ADR-0013 reserved) makes
  `/engineer:start` Claude-first at PR 3 merge. Codex parity
  surfaces via ADR-0013 when the Codex CLI plugin-commands schema
  lands.

## Alternatives Considered

### A — `/orchestrator:start` extension (single + multi unified)

Approach: extend orchestrator's `/plan` to handle 1-subtask
degenerate case as well as N-subtask plans. `/orchestrator:start
<feature>` would be equivalent to `/orchestrator:plan` for both
cases.

Rejected on the *本질* axis. ADR-0012 Cond 3 specifies "engineer
alone is sufficient"; routing single-deliverable lifecycle through
orchestrator turns Cond 3 into "engineer + orchestrator alone is
sufficient." That weakens the evidential claim — orchestrator
remains a dependency for what should be the simplest lifecycle.
The 9-axis matrix scored 6 `◎` / 3 `◯` (vs `/engineer:start`'s
8 `◎` / 1 `◯`), with the divergence concentrated on *본질*,
*유지보수* (cross-plugin contract overhead per single-deliverable
work), and *실용성* (orchestrator multi-file extension scope is
larger).

ADR-0018 §sub-1 explicitly scopes orchestrator to multi-deliverable
("**multi-deliverable** workflows", §sub-1 first paragraph); folding
single-deliverable in would widen orchestrator's SRP. ADR-0018's
"User operational pattern shifts" wording (Neutral consequences) is
*corrected* in this ADR's cascade — see ADR-0018 amendment in this
PR.

### B — New `plugins/workflow` L2 capability plugin

Approach: a new L2 capability plugin owning lifecycle macros, with
engineer + orchestrator as dispatch targets. `/workflow:start`
delegates to `/engineer:investigate ... /engineer:refine` for
single-deliverable, or to `/orchestrator:plan ... /finalize` for
multi-deliverable.

Rejected on ADR-0010 §6 plugin-separation triggers:

- **Trigger 1** (2+ consumer plugins): fails. Engineer +
  orchestrator are the *producers* of the building blocks; they are
  not consumers of a workflow plugin. The would-be workflow plugin
  has zero consumers other than the user.
- **Trigger 2** (distinct cost/quota/auth): fails. Lifecycle
  orchestration has no separate auth or quota surface.
- **Trigger 3** (install-time mental-model discontinuity):
  borderline. "I want to run a lifecycle workflow" is arguably a
  distinct intent from "I want to compose code" (engineer) or "I
  want to plan a multi-deliverable feature" (orchestrator), but the
  intent overlaps strongly with engineer's workbench shape.

With all three triggers weak or failing, premature extraction is
the dominant risk. The plugin-sprawl cost (manifest × 2,
marketplace catalog × 2, scripts, hooks, tests, CI minutes)
delivers no proportional benefit.

### C — Phase = single primary verb (collapse composite)

Approach: each phase maps to exactly one engineer verb (Sub-
decision 2 alternative). Phase 1 brainstorm → `decide` only;
Phase 3 plan-verify → `compose` only; etc.

Rejected because Phase 1 brainstorm in omcc-dev internally does
investigate (option generation) + frame (5-perspective) + decide
(recommend). Collapsing to "Phase 1 = decide" flattens the
omcc-dev parity that was the brief's stated goal. The composite
chain preserves skill semantic at the cost of a slightly larger
ADR text.

### D — Strict-error or three-way-prompt on active workflow

Approach: at re-invocation of `/engineer:start` on a branch with
an active workflow, either error out with an escape suggestion
(B), or prompt resume/start-new/archive (A).

Rejected because the engineer 6-verb command pattern already
auto-resumes silently on active workflow. Adding a different
pattern for `/engineer:start` introduces UX inconsistency. The
escape paths (new branch, abort, finalize) remain available
without an extra prompt for the common case.

### E — Schema 1.2 minor bump (vs. 1.1-additive)

Approach: bump `SCHEMA_VERSION` from `'1.1'` to `'1.2'` when
adding `workflow_type`.

Rejected during plan-verify by surfacing ADR-0019 §881-889's
explicit precedent decision:

> "Schema version stays at `'1.1'` (additive within the closed
> schema, per ADR-0017 precedent for `terminal_marker`,
> `child_completions`, `latest_checkpoint`, `pending_ensemble`,
> `ensemble_results` — all added without a schema version bump).
> Pre-PR-A reader rejection of post-PR-A files is a one-time
> merge-time coordination, not a permanent forward-compat
> constraint. Bumping to `'1.2'` would require explicit schema-
> version migration logic for no operational benefit."

`workflow_type` is structurally analogous to ADR-0017's optional
fields (additive within the closed schema, no migration logic
needed) and to ADR-0019's `parent_workflow` (additive). Bumping
the schema version would diverge from established practice for
no operational benefit, so the additive path is taken.

### F — SessionStart hook for diagnose-first

Approach: implement D7 as a Claude Code SessionStart hook that
auto-runs diagnose-redundancy whenever a session begins.

Rejected because the hook is host-specific (Codex CLI has no
SessionStart equivalent at the same lifecycle point) and because
`/engineer:start` already has a Phase 0 entry point that is the
natural invocation site. Hook + helper double-coverage adds
complexity without benefit. The shared helper alone is sufficient.

### G — Diagnose-first as standalone documentation rule

Approach: keep the `feedback_diagnose_first_redundancy` pattern in
memory/AGENTS.md only, without code.

Rejected because the pattern has produced two missed-archive
incidents already (memory item dates 2026-05-09). Machine-checked
gating is the structural fix; documentation alone repeats the
manual-checklist failure mode.

## Implementation Roadmap

This ADR ships in 4 trigger-driven PRs:

| PR | Scope | Trigger | Files (approx) |
|---|---|---|---|
| **PR 1 (this PR)** | ADR-0020 + ADR cascade amendments (docs only) | ADR-0020 approval | 7 files: docs/adr/0020 (NEW) + ADR-0010 §3 amendment + ADR-0011 §2 amendment + ADR-0017 sub-2/sub-3 cross-ref + ADR-0018 §sub-1 wording + docs/adr/README.md index + docs/DEVELOPMENT.md Cond 3 row |
| **PR 2** | engineer schema-additive: `workflow_type` field (1.1-additive per ADR-0017/0019 precedent), `commands/resume.md:124` display label correction, `tests/engineer/test-state.mjs` cases, `tests/engineer/test-resume.mjs` update. **Must include the CLI plumbing** in the same PR: `state.mjs` argv parser for `--workflow-type` flag (forwarded into `createWorkflowUnderLock`), help text update, and the CLI-side test coverage for the new flag. Without the CLI plumbing, PR 3's `state.mjs create --workflow-type start` would silently drop the flag (argv parser ignores unknown flags). | PR 1 merged | ~6 files: `plugins/engineer/scripts/state.mjs` (FRONTMATTER_KEY_ORDER + SCHEMA_1_1_OPTIONAL_KEYS + validateSchema11Fields enum + createWorkflowUnderLock default + CLI argv parser + help text) + 2 test files + `commands/resume.md` |
| **PR 3** | `/engineer:start` command + `state.mjs diagnose-redundancy` subcommand + `plugins/engineer/README.md` update + `CHANGELOG.md` + plugin-shape test sync (11 commands) | PR 2 merged. **ADR-0012 Cond 3 trigger candidate** — landing fires the evidence-accumulation start; satisfaction is determined by accumulated `docs/DEVELOPMENT.md` evidence per ADR-0012's immutable rubric (§"Progress tracking layer"). | ~7 files: `commands/start.md` (NEW) + `scripts/state.mjs` (diagnose-redundancy subcommand) + `README.md` + `CHANGELOG.md` + `tests/engineer/test-start-command.mjs` (NEW) + `tests/engineer/test-diagnose-redundancy.mjs` (NEW) + `tests/plugin-shape/test-engineer-plugin.mjs` |
| **PR 4** | Marketplace + manifest descriptions/keywords/commands updates (version field is `release-please`-owned per AGENTS.md §Release process — no manual bump) | PR 3 merged | ~4 files: `.claude-plugin/marketplace.json` (engineer description/keywords) + `.agents/plugins/marketplace.json` + `plugins/engineer/.claude-plugin/plugin.json` (description/keywords/commands) + `plugins/engineer/.codex-plugin/plugin.json` |

The four PRs are sequential by dependency: PR 2's schema-additive must
land before PR 3's `/engineer:start` writes `workflow_type: start`;
PR 3's command must exist before PR 4's manifest references it. PR 1
ships independently as documentation — the future-tense wording in
the ADR-0011 amendment ("workflow_type field *proposed* by ADR-0020")
ensures the docs are consistent at every intermediate state.

PR 3 is the **first PR developable via `/engineer:start` itself** —
the dogfood-cutover point. PR 4 will be authored using the just-
landed `/engineer:start` (true self-development), and any rough edges
surfaced during PR 4 authoring feed back into Cond 3 evidence.

## References

- [ADR-0001](0001-hexagonal-architecture.md) — hexagonal layered
  model (core/adapter/companion). `/engineer:start` lives at the
  core/adapter boundary inside engineer.
- [ADR-0010](0010-plugin-boundary-policy.md) — 4-layer composition
  policy. `/engineer:start` is a command (not a 7th canonical verb,
  not a verb-level alias) inside the engineer L3 persona plugin per
  §3. Amended in this PR.
- [ADR-0011](0011-workflow-continuity-storage.md) — workflow
  continuity storage. `workflow_type` field is added as a §2
  schema-additive extension. Amended in this PR.
- [ADR-0012](0012-omcc-removal-preconditions.md) — omcc removal
  preconditions. Condition 3 trigger candidate fires on PR 3 merge;
  satisfaction is rubric-driven (§"Progress tracking layer") and tracked in
  `docs/DEVELOPMENT.md`. **Not amended** in this PR — rubric stays
  immutable.
- [ADR-0017](0017-stage25-continuity-and-schema-roadmap.md) —
  Stage 2.5+ continuity + schema roadmap. sub-decision 1 (resume)
  and sub-decision 2 (checkpoint) surfaces are referenced for
  compatibility. Cross-ref note in this PR.
- [ADR-0018](0018-stage3-architecture-orchestrator-and-branch-context.md)
  — Stage 3+ architecture. §sub-1 wording about "User operational
  pattern shifts" is corrected to distinguish single-pass
  (`/engineer:start`) from multi-deliverable (`/orchestrator:plan`).
  Amended in this PR.
- [ADR-0019](0019-cross-plugin-invocation-contract.md) — cross-
  plugin invocation contract. §881-889 1.1-additive precedent is
  cited; §841-846 (orchestrator-owned verb chains rejected) and
  §430-433 (no retroactive parent linkage) are honored. **Not
  amended** in this PR — ADR-0020 follows the existing precedent.
- Memory: `feedback_decision_methodology_quality_axes` (9-axis matrix
  methodology); `feedback_diagnose_first_redundancy` (D7 helper
  source); `project_engineer_vs_omcc_dev_scope` (engineer ≠
  feature-superset framing).
