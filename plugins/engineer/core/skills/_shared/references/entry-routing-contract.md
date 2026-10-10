<!-- pipeline:begin routing-intro -->
# Entry Routing and Decision Contract (engineer)

This contract applies whenever `engineer:start` or any engineer-facing
decision point asks the user whether to continue, split, defer, or change
workflow shape. It exists to keep Claude Code and Codex CLI behavior
equivalent by outcome, state, recovery path, and evidence rather than by
identical syntax.
<!-- pipeline:end routing-intro -->

<!-- pipeline:begin routing-routes -->
## Routing Recommendation

Before continuing a non-trivial lifecycle macro, present one routing
recommendation:

| Route | Use when | Command |
|---|---|---|
| `engineer:start` | One coherent deliverable can be carried from idea to commit on the current branch. | `/engineer:start` or `$engineer:start` |
| `orchestrator:plan` | The work naturally splits into 2+ independently completable deliverables, PRs, branches, owners, or dependency edges. | `/orchestrator:plan` or `$orchestrator:plan` |
| `runtime:worktree` | The next slice should be isolated because the current checkout is dirty, long-running, risky, or parallelizable. A start that a dirty tree or another active workflow blocks selects it first and prints its `git worktree add` command (ADR-0067 Decision 8, item 3); the ordinary resume stays when the request belongs to the active workflow. | `/runtime:worktree plan` or `$runtime:worktree` |
| `runtime:*` | The problem is host readiness, plugin install/update, context handoff, or workflow storage. | `/runtime:doctor`, `/runtime:settings`, `/runtime:context` or Codex equivalents |
| Single verb | The user only needs investigation, framing, decision support, composition, critique, or refinement without lifecycle state. | `/engineer:<verb>` or `$engineer:<verb>` |

The recommendation must include the selected route, the rejected
alternatives that were plausible, and the next command to run.
<!-- pipeline:end routing-routes -->

<!-- pipeline:begin routing-decision-prompt -->
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
<!-- pipeline:end routing-decision-prompt -->

<!-- pipeline:begin routing-proposal -->
## Active Next-Action Proposal (standalone verb completion)

This contract applies not only to `engineer:start` lifecycle entry but
to **every standalone verb completion** (`/engineer:<verb>` or
`$engineer:<verb>` invoked without the lifecycle macro). A verb MUST NOT
end with a fixed lifecycle-table literal (e.g. always "next:
`/engineer:decide`"). It MUST instead emit an evidence-based proposal
derived from the verb's actual result and the current workflow state:

- **selected_next**: the recommended next step — a verb, `commit`,
  `owner decision`, or `done` (the deliverable is complete and produced
  nothing to commit, e.g. an investigation or decision whose output is the
  phase note itself). Chosen from the verb's result, not from a fixed
  table.
- **rejected_alternatives**: 1-2 plausible next steps that were
  considered, each with a one-line why-not.
- **rationale**: why `selected_next` is best, grounded in the verb's
  declared quality gate (the Standards and Root-Cause Gate below names it
  per verb).
- **evidence_pointers**: workflow phase notes, files, or artifact
  pointers that support the recommendation (pointers only — never raw
  peer output or full comparison dumps).
- **confidence**: HIGH / MEDIUM / LOW, based on available evidence.
- **next_command**: the exact next step, matching `selected_next` — for
  a verb, the `/engineer:<verb> …` (Claude) or `$engineer:<verb>` (Codex)
  mention; for `commit`, `/engineer:commit` / `$engineer:commit` (a
  `/engineer:start` lifecycle commits at its Phase 7 instead); for `done`,
  the same command, which closes the workflow without a commit when there is
  nothing to commit; for `owner decision`, surfacing the decision to the
  owner rather than a command to run.

**A conflict verdict (ADR-0067 Decision 8, amending ADR-0029 §3).** When
the synthesis verdict of `/engineer:decide`, `/engineer:critique` or
`/engineer:investigate` is `conflict`, `selected_next` is the owner's
decision after a bounded consensus round, `next_command` is
`/runtime:consensus plan --task-file <the verb's contested-items file>
--peers claude,codex --max-rounds 2`, and "the owner decides now" is among
the `rejected_alternatives`, with the reason for this case. The projection
stays `owner-decision`, with decide's `decide-conflict` gate or the
`peer-conflict` gate of critique and investigate (§ Owner gates). compose,
frame and refine never propose it, and neither does any other verdict.
Nothing runs the round: the owner does, then decides with its result as
evidence.

The default verb sequence (Routing Recommendation table above) remains
the **fallback** when evidence is genuinely neutral — but a fixed
literal is no longer the default output. When a verb surfaces 2+ viable
next branches, surface the compact multi-axis lens per the decision
sizing below (sized to the decision's weight, not the full matrix for a
trivial reversible step).

Anti-pattern (explicitly forbidden): **static lifecycle table** —
ending a verb with a hardcoded "next: X" instead of reasoning about the
best next action given the current result and state.

The durable `state.mjs --next-action` write SHOULD carry the compact
form (selected_next + one-line rationale + next_command); the fuller
proposal (alternatives + evidence + confidence) belongs in the
completion output and the phase note.

**Closed-enum projection: `next_step` (ADR-0063 D6, amending ADR-0029
§3; every persona since ADR-0066 Stage 2).** A verb command's last write,
`state.mjs finish-verb`, also records `selected_next` and `confidence` as
three flat keys. `next_action` stays the free-text form for humans; a machine
consumer reads the closed-enum keys and never parses `next_action`.

| `selected_next` | `next_step_kind` | `next_step_verb` |
|---|---|---|
| a verb | `verb` | that verb |
| `commit` | `commit` | absent |
| `owner decision` | `owner-decision` | absent |
| `done` | `done` | absent |

`next_step_confidence` is the proposal's confidence. A verb's Phase 0 clears
the three keys when it resumes a workflow (`append --clear-next-step true`),
so a verb that stops before its last write leaves no next step behind.
<!-- pipeline:end routing-proposal -->

<!-- pipeline:begin routing-floor -->
**Code-backed floor vs prose-only fields (honest limits).** Of the six
fields, only the compact core survives into durable state (the
`next_action` string) and is therefore **code-emitted** at terminal
completions — the runtime footer renders it as `recommended next work`,
alongside the pointer-shaped evidence it also code-emits (the workflow
path artifact and the `workflow checkpoint` line). `rejected_alternatives`
and the full `rationale` have **no durable home** (ADR-0029 §3 freezes the
`next_action` schema) and thus **zero active triggers** (the ADR-0031
lesson): they render only because the completing surface follows this
contract, and are pinned by shape tests, not by execution. `confidence` had
none either until ADR-0063 D6: it now persists as `next_step_confidence`
beside `selected_next`'s closed-enum form (above). The
canonical six-field template, the completion-flag minimum-content
criteria, and the footer's generic-fallback visibility rules live in the
runtime plugin's `docs/completion-output-contract.md`; every persona
completion surface carries the template as a structure-pinned block
(`tests/plugin-shape/test-completion-output-contract.mjs`).
<!-- pipeline:end routing-floor -->

<!-- pipeline:begin routing-owner-gates -->
### Owner gates

A genuine owner judgment ends a verb with an owner gate instead of a terminal
write. The verb records the judgment in its phase note under the heading the
table names, then its last write is `finish-verb --next-step-kind
owner-decision --owner-gate <gate> --owner-gate-anchor <anchor>`: the gate
and the next step in one write, with the workflow left open. Recording a gate
turns an inherited terminal marker off, the Stop hook never archives a
workflow with a gate pending (on its branch or in the off-branch sweep), and
the session handoff names the gate's resolving surface as the next action.

| gate | set when | heading · anchor | resolved by |
|---|---|---|---|
| `decide-conflict` | `/engineer:decide` leaves the decision to the owner: a CONFLICT remained (recorded with its run id) or a veto gate is unresolved | `Ensemble synthesis` · `ensemble-synthesis` | the owner's selection in `/engineer:decide` (its Owner selection step clears the gate) |
| `peer-conflict` | `/engineer:critique` or `/engineer:investigate`: the synthesis verdict is `conflict` (recorded with its run id) | `Ensemble synthesis` · `ensemble-synthesis` | the owner rules on the contested items, then `awaiting-owner-clear --gate peer-conflict --resolution "<the ruling>"` with the next step |
| `recurring-finding` | `/engineer:refine`: a finding an earlier refine pass on this workflow already addressed survives verification again | `Recurring finding` · `recurring-finding` | the owner's fix-now-or-defer in `/engineer:refine` (its Owner decision step clears the gate) |
| `scope-routing` | a verb concludes the request does not belong in this verb or workflow (another route in the Routing Recommendation fits) | `Routing recommendation` · `routing-recommendation` | the owner picks the route, then `awaiting-owner-clear` with the next step |
| `staging-set` | `/engineer:commit` under autopilot (with `dispatch_target` on, the one path that records it): the staging set needs the owner | `Phase 7 plan` · `phase7-plan` | interactive `/engineer:commit`, which clears it once the owner confirms the set |
| `pr-handling` | under autopilot, the task itself needs an outward action: a push, a pull request, a release or an issue | `Outward action needed` · `pr-handling` | the owner takes or declines the action, then `awaiting-owner-clear` with the next step |

`state.mjs awaiting-owner-clear --gate <gate> --resolution "<the decision>"
--next-step-kind … --next-step-confidence … [--next-step-verb …] --next-action
"<what comes next>"` records the owner's decision, clears the gate, names the
next step and replaces the gate's `Owner: …` next action in one write; it
refuses, writing nothing, when the gate set on the workflow is another one.
Inside a `/engineer:start` lifecycle, decide's Owner selection records no
next step instead (`--clear-next-step true`): the lifecycle owns its phase
order.
Reading a workflow file, `state.mjs` accepts all six gate names (ADR-0066
Decision 7 validates each schema 1.4 key on its own).

**The conflict gates and their consensus task file (ADR-0067 Decision 8).**
`decide-conflict` and `peer-conflict` are the conflict gates. On a synthesis
verdict of `conflict` the verb writes the contested items to
`.agentic-plugins/state/engineer/consensus/<workflow id>.<run id>.md`, in
the workflow's own home (`state.mjs consensus-task`, which refuses unless
`ensemble_results` holds the run with the verdict `conflict`), and records the
gate with that run id, `awaiting_owner_run_id` (`finish-verb
--owner-gate-run-id`, or `awaiting-owner-set --run-id` inside a lifecycle).
The file is current only while the gate names the run, `ensemble_results`
holds that run with the verdict `conflict`, and the file exists
(`state.mjs consensus-proposal`). A gate set without a run id (an owner
selection, a veto) deletes the key; a gate set again over itself that names
another run, or none, and every clear retire the file of the run they
replace, renamed `<workflow id>.<run id>.resolved.md` and kept as evidence.
The proposal selects the owner's decision after a bounded consensus round,
`/runtime:consensus plan --task-file <the file's absolute path> --peers
claude,codex --max-rounds 2`, which the owner runs; nothing runs it
automatically.
<!-- pipeline:end routing-owner-gates -->

<!-- pipeline:begin routing-preflight-intro -->
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
fold the projection in, and never shell-reads, imports, or discovers a
persona's (L3) or the orchestrator's (L2) state. Dependency direction stays
L2/L3 → L1 (ADR-0010); the rejected shell-read alternative is ADR-0031
Approach A.

> **Single source.** This section is the engineer plugin's contract for the
> **firing rules, the three inputs, the projection schema, and the decision
> policy**; `session-handoff.md` (beside this file) holds only the
> engineer-local wiring and cites this section rather than restating it.
> `plugins/runtime/docs/footer-contract.md` owns only the **footer rendering**
> of the result and references the canonical section for the schema and
> policy — a second definition would drift.
<!-- pipeline:end routing-preflight-intro -->

### When it fires

The preflight is surfaced **before a layer guides the user toward substantial
next work** — a fresh lifecycle, a verb that will itself dispatch a peer
ensemble or write workflow state, or a dispatch into another plugin; never a
trivial reversible step or a pure read. engineer surfaces it at these points
(`session-handoff.md` § When it fires has the code-emitted wiring):

- **`/engineer:start` Phase 0** — before sequencing a fresh lifecycle: the
  agent projects the branch's workflow, or passes the standalone routing
  when there is none, to the runtime seam (`../../../../commands/start.md`
  § Phase 0d — Entry routing and decision contract; `../../start/SKILL.md`
  § Session-level handoff preflight (Phase 0, ADR-0031) on Codex).
- **Standalone verb and lifecycle completion** — code-emitted: the terminal
  write (`state.mjs finish-verb`) fires the handoff sidecar, and so does the
  Phase 7 driver's commit, which ends `/engineer:start` and
  `/engineer:commit`; the sidecar prints the runtime footer with its
  continue-vs-fresh block, alongside (not inside) the Active Next-Action
  Proposal. Under an autopilot run `finish-verb` makes no terminal write, so
  nothing is printed: the driver is the handoff.
- **The Stop hook backstop** — for the terminal workflow active on the
  checked-out branch, the hook re-fires the sidecar before the auto-archive
  move; the off-branch sweep archives a terminal workflow whose branch is not
  checked out without another sidecar attempt (`session-handoff.md` § Fail-closed
  baseline (ADR-0043 §2)).
- **SessionStart (matcher: compact)** — re-surfaces a pending handoff once.
- **Orchestrator macro surfaces** — `orchestrator:next` dispatch completion and
  `orchestrator:plan` / `finalize` / `abort` completion: the macro-level
  equivalents of verb completion, wired by the orchestrator plugin, whose
  session handoff cites this section (ADR-0031 governs orchestrator wiring
  too).
- **Context risk yellow/red** — agent-instructed, not sensor-driven: whenever
  the caller-supplied context-budget risk (input (a) below) is yellow or red,
  surface the preflight regardless of the other inputs, before the work
  completes (`runtime:context check` with that risk): continuing a near-full
  session is the case the handoff exists to catch.

The sidecar supplies no context risk (it owns no budget sensor), so the footer
applies input (a)'s conservative yellow default below.

<!-- pipeline:begin routing-preflight-inputs -->
**Detached HEAD is the explicit non-firing case.** With no branch to anchor a
workflow to (ADR-0018 §sub-2), the **owning surface** (not the runtime) emits a
one-line *"no active branch context"* report in place of the preflight and does
**not** auto-recommend a fresh session. It reports; it does not default to
fresh. This is the branch-based preflight's rule: the terminal sidecar is
path-targeted, so it projects the exact workflow it was handed without
consulting the branch, and renders normally on a detached HEAD.

### The three inputs (and their honest availability)

The decision composes exactly three inputs. Each names its source and its
availability limit:

| Input | Source | Availability |
|---|---|---|
| (a) Context-budget risk | Caller-supplied risk level (green / yellow / red) | **Caller-supplied, not host-measured** — the runtime budget check takes `--risk` or `--token-budget` metrics from the caller (`context.mjs`; ADR-0031 §7). The preflight cannot read true token usage and cannot tell whether a supplied risk has gone stale mid-session. When risk is **absent it defaults to `yellow`** (the conservative default `captureContext` already uses), which *fires* the preflight rather than silently assuming green. |
| (b) Workflow projection | The owning plugin's bounded projection (schema below), computed by the owning persona (engineer, orchestrator, founder or designer) from its **own** state | Present only when an active workflow exists on the branch **and** its state reads unambiguously. Absent (no workflow, or fail-closed on ambiguous/corrupt state) → the preflight degrades to inputs (a) + (c). |
| (c) Routing recommendation | The Routing Recommendation table above, resolved by the owning surface | **Always available** — a pure function of the work shape. It travels *inside* the projection (field `routing_recommendation`) when one exists, and is passed to the seam as a standalone field when (b) is absent, so (c) is never lost when there is no active workflow. |
<!-- pipeline:end routing-preflight-inputs -->

<!-- pipeline:begin routing-preflight-projection -->
### The bounded projection schema (input (b))

Each onboarded persona — engineer, orchestrator, founder and designer (the
seam accepts all four kinds, ADR-0043 §1) — reads its **own** workflow state
(its own `state.mjs read` / `find-active`; orchestrator macros resolve via
`find-macro`, never `find-active` on a subtask branch) and emits a bounded
projection. The seam consumes it as a single `--workflow-projection-file` JSON
object (mirroring the existing `--subtasks-json-file` file-passing pattern),
never as per-field flags. This contract fixes the **fields, their semantics,
and the fail-closed rule**; the footer rendering is the runtime's. The
projection carries **only** these fields, and only **generic semantic**
values:

| Field | Meaning | Notes |
|---|---|---|
| `workflow_kind` | `engineer` \| `orchestrator` \| `founder` \| `designer` | The owning layer — the only discriminator the runtime sees (four-persona seam per ADR-0043; a kind outside the enum degrades honestly on the runtime side). |
| `workflow_id` | The active workflow id | Pointer only. |
| `workflow_path` | Path to the workflow file | Pointer only; the runtime does not read it. |
| `phase` | Current phase label | Generic string, for the prompt. |
| `next_action` | The workflow's recorded next action | Generic string. |
| `checkpoint` | Latest checkpoint summary | Optional; omitted when none. |
| `archive_gate` | `ready_to_archive` \| `blocked` \| `not_terminal` | Generic readiness state; mapping below. |
| `routing_recommendation` | The input-(c) route | Same value as (c); carried here when a workflow exists. |

**Computing `archive_gate`.** The owning surface first gathers the pure
evaluator's inputs — a persona probes the git HEAD (`headSha`), the
orchestrator runs its child scan (`noActiveEngineerChildren`) — then calls its
**pure** evaluator (`evaluateStopArchive` / `evaluateMacroStopArchive`, each in
its plugin's `stop-archive.mjs`; never the side-effecting Stop runner) and
collapses the `{shouldArchive, gateFailures}` verdict to one generic value:

- `ready_to_archive` — `shouldArchive === true` (`gateFailures` empty).
- `not_terminal` — `gateFailures` contains `terminal_marker` (the workflow has
  not been marked terminal yet; work in progress).
- `blocked` — `shouldArchive === false` **without** a `terminal_marker` failure:
  terminal-marked but another gate is unmet (a persona's `terminal_phase` /
  `head_moved` / `no_active_children`; the orchestrator's
  `all_subtasks_terminal` / `no_active_engineer_children` /
  `macro_terminal_phase`) — archivable *soon* but awaiting a commit or active
  children. If the gate **cannot be computed** (HEAD probe or child scan
  fails), the surface reports `blocked` conservatively, carrying the reason,
  rather than guessing readiness.

**Fail-closed.** If the owning plugin's state read is ambiguous or corrupt (a
case its state manager already fails closed on), the surface **omits the
projection entirely** (degrading to (a)+(c)) and surfaces the reason; it never
emits a half-trusted projection. The seam likewise treats a malformed
projection (invalid JSON, missing required field, unknown `workflow_kind` /
`archive_gate`, empty pointer, or out-of-repo `workflow_path`) as **absent +
reported**, never interpreted.

The seam treats every field as opaque: it renders them, it does not re-derive
per-persona semantics from them. A future persona passes the same shape once
its kind joins the seam enum (the ADR-0043 onboarding pattern); an unknown
kind degrades honestly without the runtime learning its schema.
<!-- pipeline:end routing-preflight-projection -->

<!-- pipeline:begin routing-preflight-policy -->
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
  routing-table command for new work). The budget check
  (`runtime:context check`) and the completion footer are read-only and
  persist neither; the prompt reaches the **existing** `runtime:context`
  artifact's next-session field only when a surface runs `runtime:context
  capture` with `--next-session-prompt`.

The projection itself is not ephemeral here: at each terminal emit the
engineer sidecar writes it to one per-persona slot,
`.agentic-plugins/state/engineer/last-session-handoff.json`, the guaranteed
channel of the handoff. The footer renders from a per-emit
snapshot of it, never from the shared slot, which is last-writer-wins across
concurrent terminals. An emit that cannot project clears a stale projection
from a prior emit rather than let it be served (`session-handoff.md`
§ Fail-closed baseline (ADR-0043 §2)).
A workflow that still lives in the pre-migration home,
`.claude/agentic-engineer/`, writes its projection to that home's
`last-session-handoff.json` instead, and SessionStart reads both slots,
canonical first.

### Boundaries (carried from ADR-0024 / ADR-0031)

- **The runtime is non-mutating.** The preflight emits a prompt, a command,
  and an archive-gate **report**. It never marks a workflow terminal, never
  archives, and never mutates / compacts / switches / starts host session
  context.
- **Archive readiness is gate-driven and side-effect-free.** `archive_gate`
  comes from the owning plugin's **pure** evaluator, not the Stop runner. The
  automatic archive happens in the persona's Stop hook, preserving the
  ADR-0017 auto-archive invariants: on the checked-out branch once every gate
  passes, HEAD movement past the baseline among them; and in the off-branch
  sweep, which judges a kept branch by its own tip and archives a terminal
  workflow whose branch was deleted with no HEAD-movement gate (a deleted
  branch has no tip to judge).
  The commit command's no-changes close (`phase7-commit.mjs`) archives its
  workflow itself, right after its terminal write: with nothing committed,
  HEAD never moves past the baseline, so the Stop hook would never pass it.
  An owner archives a stale workflow on purpose with `/engineer:resume
  archive`.
- **One projection per surface.** A completing surface projects **its own**
  workflow only; macro projection happens at the orchestrator surfaces. The
  two are never merged.
- **No new surface.** The runtime composition extends the existing
  `footer.mjs` / `context.mjs` caller-supplied-fields design: no new plugin,
  verb or skill category (ADR-0029).
<!-- pipeline:end routing-preflight-policy -->

## Standards and Root-Cause Gate

Before recommending a quick implementation or refinement path, state the
quality gate:

- source of truth or standard being followed;
- invariant or root cause that the change is meant to preserve or address;
- verification evidence required before the work can be considered complete;
- rollback, defer, or escalation path if the gate cannot be met.

Every engineer verb works under this one gate, with the decisive axes 본질
(essence) and 근본 (foundation): each verb runbook's proposal grounds its
rationale in both.

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

<!-- pipeline:begin routing-lens -->
### Surfacing the multi-axis lens from a non-decide verb (ADR-0029 §2)

The size→preset mapping above is not exclusive to `engineer:decide`.
When a **non-decide verb** (`investigate` / `frame` / `compose` /
`critique` / `refine`) reaches a genuine 2+-branch decision point —
two viable readings of the evidence, two artifact structures, two
remediation directions, or a non-neutral Active Next-Action
`selected_next` with 2+ candidates — it surfaces a **compact
multi-axis lens** inline instead of listing the branches flat. This is
the same forward pull the decisive axes give `decide`, made reachable
wherever a real branch appears (the Active Next-Action Proposal section
above already calls for it; this subsection is the mechanism).

Resolve the sized axis set from the engineer plugin's **own registry** —
the single axis source of truth — rather than hand-authoring a second axis
list (`<plugin-root>` is this plugin's installed root):

```bash
node "<plugin-root>/scripts/decide-registry.mjs" resolve --size=<minor|standard|major>
# stdout: ResolvedDecisionContext JSON. Read axes[] (id, en/ko labels,
# question, role, gate); compare the 2+ branches across the resolved
# DECISIVE axes plus the size-appropriate supporting axes, let the decisive
# axes drive the recommendation, and treat a gate axis as a veto.
```

Bounding rules — the lens is deliberately not emitted on every
invocation:

- **Only at a genuine 2+-branch point.** A single obvious path emits no
  lens; the verb proceeds and the Active Next-Action Proposal alone
  carries the forward routing.
- **Sized to the branch — default minor.** An incidental in-verb branch
  uses `--size=minor`. Escalate to `--size=standard` or `--size=major` only
  when the branch's weight justifies it; the decision-sizing subsection
  above says which preset each size resolves to. Never apply the full
  matrix to a trivial reversible step.
- **The registry is the single axis source.** Read the axes from
  `decide-registry.mjs`; do not duplicate an axis list in the verb or
  this contract. Resolving it on Codex takes one extra step: a Codex
  skill mention runs with no plugin-root variable in its environment. The
  names Codex substitutes into hook commands (`${PLUGIN_ROOT}`,
  `${PLUGIN_DATA}`) are not exported to a skill mention's shell: an agent
  shell reports `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `PLUGIN_ROOT`
  and `PLUGIN_DATA` all empty. That is an observation about the shell, not
  a claim about every place Codex may substitute them. So resolve the path
  from the installed plugin root rather than from `$CLAUDE_PLUGIN_ROOT`:
  Codex injects the mentioned skill with its absolute path, and
  `../../checkpoint/SKILL.md` § Claude/Codex command resolution shows how
  to take the root from it without assuming a Codex home, marketplace name
  or version. Three rungs, in order: the root resolves and the CLI runs
  (full fidelity); the root resolves but the CLI does not run (read
  `core/skills/decide/references/decision-axes.yml` under that same root);
  the root cannot be built at all (keep the decisive axes the decisive-axis
  fallback below names, and take the size's supporting axes from the
  decision-sizing subsection above, which is already loaded). The YAML
  stays the single source. What ADR-0013 still owns is the missing Codex
  command file that would run this resolution automatically — not the
  reachability of the script.
- **Pointer-only in state.** Record the lens outcome as a compact
  decisive-axis verdict + pointers, never the full comparison dump
  (ADR-0024 boundary).

If the inline lens reveals the branch genuinely needs the full ritual
(peer ensemble, sensitivity perturbation), the proposal's
`selected_next` should route to `engineer:decide --size=<tier>` rather
than resolving it inline — the inline lens is a compact aid, not a
replacement for the `decide` verb's ensemble.
<!-- pipeline:end routing-lens -->

### Decisive-axis fallback

When the registry cannot be read at all (the third rung above), keep
engineer's two decisive axes, **본질 (essence)** and **근본 (foundation)**,
universal to every preset, and take the `compact` preset's supporting axes
from the decision-sizing subsection above.

<!-- pipeline:begin routing-quality -->
## Quality-First Defaults

The engineer persona optimizes for result quality, not token
minimization, unless the user explicitly constrains budget, latency, or peer
breadth. The default policy is:

- **Default peer breadth**: run the documented phase-boundary peer ensemble
  when the phase calls for it; do not skip Claude/Codex peer collection merely
  to save tokens.
- **Model/effort defaults**: use host-native defaults or explicit
  `runtime:settings` model/effort configuration. Do not downshift model or
  effort for token saving without a user-supplied constraint.
- **User constraints**: when the user requests budget, latency, model, effort,
  or peer limits, treat those as explicit constraints and state the quality
  tradeoff before proceeding.
<!-- pipeline:end routing-quality -->

**Review depth** for engineer: use the deepest review surface the workflow
phase implies, including `parallel-review` for `/engineer:start` Phase 5 and
re-review after refine until findings converge or a design-level issue is
surfaced.
