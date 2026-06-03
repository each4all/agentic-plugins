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

## Active Next-Action Proposal (standalone verb completion)

This contract applies not only to `engineer:start` lifecycle entry but
to **every standalone verb completion** (`/engineer:<verb>` or
`$engineer:<verb>` invoked without the lifecycle macro). A verb MUST NOT
end with a fixed lifecycle-table literal (e.g. always "next:
`/engineer:decide`"). It MUST instead emit an evidence-based proposal
derived from the verb's actual result and the current workflow state:

- **selected_next**: the recommended next step — a verb, `commit`, or
  `owner decision`. Chosen from the verb's result, not from a fixed
  table.
- **rejected_alternatives**: 1-2 plausible next steps that were
  considered, each with a one-line why-not.
- **rationale**: why `selected_next` is best, grounded in the decisive
  quality axes (본질 essence / 근본 foundation) and the
  Standards/Root-Cause Gate result below.
- **evidence_pointers**: workflow phase notes, files, or artifact
  pointers that support the recommendation (pointers only — never raw
  peer output or full comparison dumps).
- **confidence**: HIGH / MEDIUM / LOW, based on available evidence.
- **next_command**: the exact next step, matching `selected_next` — for
  a verb, the `/engineer:<verb> …` (Claude) or `$engineer:<verb>` (Codex)
  mention; for `commit`, committing the verified change (the
  `/engineer:start` lifecycle reaches this at Phase 7; otherwise a
  direct user-approved commit); for `owner decision`, surfacing the
  decision to the owner rather than a command to run.

The default verb sequence (Routing Recommendation table above) remains
the **fallback** when evidence is genuinely neutral — but a fixed
literal is no longer the default output. When a verb surfaces 2+ viable
next branches, surface the compact multi-axis lens per the decision
sizing below (sized to the decision's weight, not the full 9-axis
matrix for a trivial reversible step).

Anti-pattern (explicitly forbidden): **static lifecycle table** —
ending a verb with a hardcoded "next: X" instead of reasoning about the
best next action given the current result and state.

The durable `state.mjs --next-action` write SHOULD carry the compact
form (selected_next + one-line rationale + next_command); the fuller
proposal (alternatives + evidence + confidence) belongs in the
completion output and the phase note.

## Session-Level Continue-vs-Fresh Preflight (ADR-0031)

The Active Next-Action Proposal above answers *"what is the next step?"* at
**verb-completion** granularity. This section adds its **session-level**
counterpart: before a layer pulls the user toward substantial next work, it
answers *"should that work continue in the current session, or hand off to a
fresh one?"* — and, when a fresh session is warranted, prepares the handoff
(reports archive-gate readiness and emits a concrete next-session start
prompt). It does not replace the verb-level proposal; it sizes the session
around it.

Composition follows the **projection (inversion-of-control) model** of
ADR-0031 §Decision: the owning plugin computes its own workflow state and
passes a bounded projection *into* the runtime seam; the runtime layer (L1)
**extends** its existing `buildHandoffGuidance` composition (`context.mjs`) to
fold the projection in, and never shell-reads, imports, or discovers engineer
(L3) / orchestrator (L2) state. Dependency direction stays L2/L3 → L1
(ADR-0010); the rejected shell-read alternative is ADR-0031 Approach A.

> **Single source.** This section is the canonical contract for the **firing
> rules, the three inputs, the projection schema, and the decision policy**.
> `plugins/runtime/docs/footer-contract.md` owns only the **footer rendering**
> of the result; its session-level extension (added by the `runtime-seam`
> subtask) MUST reference this section for the schema and policy rather than
> restate them — a second definition would drift.

### When it fires

The preflight is surfaced **before a layer guides the user toward substantial
next work** — where *substantial* means a fresh lifecycle, a verb that will
itself dispatch a peer ensemble or write workflow state, or a dispatch into
another plugin; never a trivial reversible step or a pure read. The firing
points are:

- **`engineer:start` Phase 0** — before sequencing a fresh lifecycle.
- **Standalone verb completion** — alongside (not inside) the Active
  Next-Action Proposal, when `selected_next` implies substantial work.
- **Orchestrator macro surfaces** — `orchestrator:next` dispatch completion and
  `orchestrator:plan` / `finalize` / `abort` completion: the macro-level
  equivalents of verb completion (ADR-0031 governs orchestrator wiring too).
- **Context risk yellow/red** — whenever the caller-supplied context-budget
  risk (input (a) below) is yellow or red, the preflight fires regardless of
  the other inputs: continuing a near-full session is the case the handoff
  exists to catch.

**Detached HEAD is the explicit non-firing case.** With no branch to anchor a
workflow to (ADR-0018 §sub-2), the **owning surface** (not the runtime) emits a
one-line *"no active branch context"* report in place of the preflight and does
**not** auto-recommend a fresh session. It reports; it does not default to
fresh.

### The three inputs (and their honest availability)

The decision composes exactly three inputs. Each names its source and its
availability limit:

| Input | Source | Availability |
|---|---|---|
| (a) Context-budget risk | Caller-supplied risk level (green / yellow / red) | **Caller-supplied, not host-measured** — the runtime budget check takes `--risk` or `--token-budget` metrics from the caller (`context.mjs`; ADR-0031 §7). The preflight cannot read true token usage and cannot tell whether a supplied risk has gone stale mid-session. When risk is **absent it defaults to `yellow`** (the conservative default `captureContext` already uses), which *fires* the preflight rather than silently assuming green. |
| (b) Workflow projection | The owning plugin's bounded projection (schema below), computed by engineer / orchestrator from their **own** state | Present only when an active workflow exists on the branch **and** its state reads unambiguously. Absent (no workflow, or fail-closed on ambiguous/corrupt state) → the preflight degrades to inputs (a) + (c). |
| (c) Routing recommendation | The Routing Recommendation table above, resolved by the owning surface | **Always available** — a pure function of the work shape. It travels *inside* the projection (field `routing_recommendation`) when one exists, and is passed to the seam as a standalone field when (b) is absent, so (c) is never lost when there is no active workflow. |

### The bounded projection schema (input (b))

engineer and orchestrator each read their **own** workflow state (their own
`state.mjs read` / `find-active`; orchestrator macros resolve via `find-macro`,
never `find-active` on a subtask branch) and emit a bounded projection. The
seam consumes it as a single `--workflow-projection-file` JSON object
(mirroring the existing `--subtasks-json-file` and `$AGENTIC_DECIDE_CONTEXT_FILE`
file-passing patterns), never as per-field flags. The exact CLI flag and the
footer rendering are the `runtime-seam` subtask's to define against this
schema; this contract fixes the **fields, their semantics, and the fail-closed
rule**. The projection carries **only** these fields, and only **generic
semantic** values:

| Field | Meaning | Notes |
|---|---|---|
| `workflow_kind` | `engineer` \| `orchestrator` | The owning layer — the only discriminator the runtime sees. |
| `workflow_id` | The active workflow id | Pointer only. |
| `workflow_path` | Path to the workflow file | Pointer only; the runtime does not read it. |
| `phase` | Current phase label | Generic string, for the prompt. |
| `next_action` | The workflow's recorded next action | Generic string. |
| `checkpoint` | Latest checkpoint summary | Optional; omitted when none. |
| `archive_gate` | `ready_to_archive` \| `blocked` \| `not_terminal` | Generic readiness state; mapping below. |
| `routing_recommendation` | The input-(c) route | Same value as (c); carried here when a workflow exists. |

**Computing `archive_gate`.** The owning surface first gathers the pure
evaluator's inputs — engineer probes the git HEAD (`headSha`), orchestrator
runs its child scan (`noActiveEngineerChildren`) — then calls its **pure**
evaluator (`evaluateStopArchive` / `evaluateMacroStopArchive`, each in its
plugin's `stop-archive.mjs`; never the side-effecting Stop runner) and collapses
the `{shouldArchive, gateFailures}` verdict to one generic value:

- `ready_to_archive` — `shouldArchive === true` (`gateFailures` empty).
- `not_terminal` — `gateFailures` contains `terminal_marker` (the workflow has
  not been marked terminal yet; work in progress).
- `blocked` — `shouldArchive === false` **without** a `terminal_marker` failure:
  terminal-marked but another gate is unmet (engineer `head_moved` /
  `no_active_children`; orchestrator `all_subtasks_terminal` /
  `no_active_engineer_children` / `macro_terminal_phase`) — archivable *soon*
  but awaiting a commit or active children. If the gate **cannot be computed**
  (HEAD probe or child scan fails), the surface reports `blocked`
  conservatively, carrying the reason, rather than guessing readiness.

**Fail-closed.** If the owning plugin's state read is ambiguous or corrupt
(canonical+legacy duplicates, or `find-macro` matching two macros for one
subtask branch — both already fail closed in the state managers), the surface
**omits the projection entirely** (degrading to (a)+(c)) and surfaces the
reason; it never emits a half-trusted projection. The seam likewise treats a
malformed projection (invalid JSON, missing required field, unknown
`workflow_kind` / `archive_gate`, empty pointer, or out-of-repo `workflow_path`)
as **absent + reported**, never interpreted.

The seam treats every field as opaque: it renders them, it does not re-derive
engineer / orchestrator semantics from them. A future plugin (e.g. a `designer`
persona) passes the same shape without the runtime learning its schema.

### Decision policy (continue-vs-fresh)

The seam maps (context-risk × `archive_gate`) to `recommended_session`. The
policy is quality-first: it never fragments an in-progress unit while budget is
green, and it hands off once context is genuinely at risk.

| context-risk ↓ \ archive_gate → | `ready_to_archive` | `blocked` / `not_terminal` | absent (no projection) |
|---|---|---|---|
| **green** | `current_or_resumed` | `current_or_resumed` | `current_or_resumed` |
| **yellow** | `fresh_or_resumed` (clean seam) | `current_or_resumed` (+ risk caution) | `current_or_resumed` (+ risk caution) |
| **red** | `fresh_or_resumed` | `fresh_or_resumed` (+ resume command) | `fresh_or_resumed` |

The routing recommendation (c) does **not** flip the binary decision; it shapes
the **content** of the next-session prompt (what to start or resume). That is
how routing "breaks ties": the same `recommended_session`, a routing-specific
`next_command`.

### The output: continue-vs-fresh

The extended `buildHandoffGuidance` (`context.mjs`) emits:

- **`recommended_session`**: `current_or_resumed` (continue here) vs
  `fresh_or_resumed` (hand off), per the policy table above.
- **archive-gate report**: the projection's `archive_gate` surfaced verbatim —
  a **report** that the workflow is or is not ready to archive, never an
  archive action; omitted when (b) is absent.
- **next-session prompt / command**: when `fresh_or_resumed`, a concrete start
  prompt + command (the resume command for an active workflow, or the
  routing-table command for new work). Only this **prompt/command string** is
  persisted, through the **existing** `runtime:context` artifact's next-session
  field — the projection itself is ephemeral and is never written to a second
  state-like artifact.

### Boundaries (carried from ADR-0024 / ADR-0031)

- **The runtime is non-mutating.** The preflight emits a prompt, a command,
  and an archive-gate **report**. It never marks a workflow terminal, never
  archives, and never mutates / compacts / switches / starts host session
  context.
- **Archive readiness is gate-driven and side-effect-free.** `archive_gate`
  comes from the owning plugin's **pure** evaluator, not the Stop runner — the
  real archive still happens only via the Stop hook after a real commit,
  preserving the ADR-0017 auto-archive invariants.
- **One projection per surface.** A completing surface projects **its own**
  workflow only: an engineer verb on a macro subtask branch projects the
  engineer workflow; macro projection happens at the orchestrator surfaces. The
  two are never merged, so an engineer subtask branch referenced by a macro
  yields exactly one projection (the engineer one) at engineer completion.
- **No new surface.** This is a section added to an existing contract; the
  runtime composition extends the existing `footer.mjs` / `context.mjs`
  caller-supplied-fields design. No new plugin, verb, skill category, or
  reference file (ADR-0029).

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

### Surfacing the multi-axis lens from a non-decide verb (ADR-0029 §2)

The size→preset mapping above is not exclusive to `engineer:decide`.
When a **non-decide verb** (`investigate` / `frame` / `compose` /
`critique` / `refine`) reaches a genuine 2+-branch decision point —
two viable root-cause hypotheses, two implementation designs, two
remediation directions, or a non-neutral Active Next-Action
`selected_next` with 2+ candidates — it surfaces a **compact
multi-axis lens** inline instead of listing the branches flat. This is
the same forward pull the decisive axes give `decide`, made reachable
wherever a real branch appears (the Active Next-Action Proposal section
above already calls for it; this subsection is the mechanism).

Resolve the sized axis set from the **shared registry** — the single
axis source of truth — rather than hand-authoring a second axis list:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve --size=<minor|standard|major>
# stdout: ResolvedDecisionContext JSON. Read axes[] (id, en/ko labels,
# question, role); compare the 2+ branches across the resolved DECISIVE
# axes (본질 essence / 근본 foundation) plus the size-appropriate
# supporting axes, and let the decisive axes drive the recommendation.
```

Bounding rules — the lens is deliberately not emitted on every
invocation:

- **Only at a genuine 2+-branch point.** A single obvious path emits no
  lens; the verb proceeds and the Active Next-Action Proposal alone
  carries the forward routing.
- **Sized to the branch — default minor.** An incidental in-verb branch
  uses `--size=minor` (the 4-axis `compact` preset). Escalate to
  `--size=standard` (5-axis) or `--size=major` (9-axis) only when the
  branch's architectural weight justifies it. Never apply the full
  9-axis matrix to a trivial reversible step.
- **The registry is the single axis source.** Read the axes from
  `decide-registry.mjs`; do not duplicate an axis list in the verb or
  this contract. When the resolver CLI is not reachable — e.g. Codex
  auto-activated skill mode, the registry-resolution asymmetry deferred
  under ADR-0013 — keep the decisive axes 본질/근본 (essence/foundation,
  universal to every preset) and read the `compact` preset's supporting
  axes from the decision-sizing subsection above or `decision-axes.yml`
  directly; the YAML stays the single source.
- **Pointer-only in state.** Record the lens outcome as a compact
  decisive-axis verdict + pointers, never the full comparison dump
  (ADR-0024 boundary).

If the inline lens reveals the branch genuinely needs the full ritual
(peer ensemble, sensitivity perturbation), the proposal's
`selected_next` should route to `engineer:decide --size=<tier>` rather
than resolving it inline — the inline lens is a compact aid, not a
replacement for the `decide` verb's ensemble.

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
