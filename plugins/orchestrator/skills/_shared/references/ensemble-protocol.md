# Ensemble Protocol (orchestrator)

Defines how orchestrator (Claude or Codex side) and its peer (the opposite host) operate as a dual-model ensemble for macro orchestration. The orchestrator side launches the peer for independent parallel analysis and synthesizes both perspectives into a unified result.

This protocol is plugin-local — it ships in `plugins/orchestrator/skills/_shared/references/` per ADR-0010 §5 cross-plugin import ban. The base synthesis taxonomy (AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT) is the same vocabulary engineer uses; cross-plugin references to that vocabulary are by **prose only** — no markdown backtick path may cross plugin boundaries (this file does NOT import from `plugins/engineer/skills/_shared/references/ensemble-protocol.md`; it ships its own copy with orchestrator-specific scope).

---

## When This Protocol Applies

Activates at command-defined phase boundaries when Ensemble Affinity warrants it. In the orchestrator MVP (plan-only PR), the only phase boundary that dispatches a peer ensemble is `/orchestrator:plan` Step 3 — the Plan-verify point on the macro plan.

Does NOT apply to:

- Inline skill auto-activation (no command invocation).
- Binary confirmations or progress updates.
- Internal orchestration decisions.

---

## Execution Pattern

Every ensemble point follows three steps: Launch, Collect, Synthesize.

### Step 1: Launch

1. Determine the ensemble point type (Plan-verify in orchestrator MVP).
2. Build the peer prompt per the per-type template below (Plan-verify is the only template shipped in this MVP).
3. Resolve the companion script and dispatch via `plugins/orchestrator/scripts/peer-runner.mjs run`. The graceful-degradation contract: companion missing → the runner returns `kind: 'peer_cli_not_found'` without creating a peer-run ledger or `pending_ensemble` row, and the orchestrator side proceeds with a **LOCAL-ONLY** synthesis. If the companion resolves, the runner creates `.claude/agentic-orchestrator/peer-runs/<run_id>/`, records `pending_ensemble`, supervises the child process, tees stdout/stderr to ledger files, and writes the final JSON envelope to `envelope.json`.

### Step 2: Collect

1. The orchestrator side performs its own analysis in parallel.
2. Read the peer envelope (per `companions/contract.md` §4.2). The dispatch wrapper validates envelope shape + the joint triple `(status, exit_code, error.kind)` per §5.3.
3. If the peer failed, returned malformed output, or was unavailable, proceed with **LOCAL-ONLY** synthesis. Ensemble failure must never block the workflow.

### Step 3: Synthesize

Classify every finding, recommendation, or conclusion from both sources into one of four base categories. The four names are the canonical public vocabulary; renaming or removing any of the four is a breaking change.

#### Base Synthesis Categories (host-agnostic)

| Category    | Condition                                              | Presentation                                           |
|-------------|--------------------------------------------------------|--------------------------------------------------------|
| AGREED      | Both orchestrator and peer reached the same conclusion | Present with elevated confidence. Label: **[Both]**    |
| LOCAL-ONLY  | Orchestrator side found it, peer did not               | Present normally. Label: **[Local]**                   |
| PEER-ONLY   | Peer found it, orchestrator did not                    | Present normally. Label: **[Peer]**                    |
| CONFLICT    | Orchestrator and peer disagree                         | Present both with evidence. Ask user to decide         |

Names are **host-agnostic** (Local / Peer rather than Claude / Codex). The orchestrator can run as either Claude or Codex depending on which side dispatches the ensemble; using host-named labels would create asymmetric semantics under the bidirectional companion model.

The synthesis output replaces the standard single-side output. Follow the Presentation Mode Protocol (`presentation-protocol.md`) for the synthesized result.

---

## State Bookkeeping (mandatory)

Whenever an ensemble point is launched from inside an orchestrator workflow file (`/orchestrator:plan`), the launching command MUST record the in-flight job in the workflow file per `state.mjs` `pending_ensemble` schema.

- `peer-runner.mjs run --kind ensemble` appends `{phase, ensemble_type, run_id, started_at}` to `pending_ensemble` only after companion resolution succeeds.
- The `state.mjs ensemble-commit` CLI subcommand performs the **three-step atomic mutation** at synthesis time: pop the matching pending entry by `run_id`, append the new `ensemble_results` entry, and prune the retention list to `ENSEMBLE_RESULTS_RETENTION_CAP` — all in a single `withFileLock` window via `atomicWrite`.

Stale entries left over by an interrupted session are out of scope for this MVP — `/orchestrator:resume` ships in a follow-up PR alongside the cross-plugin invocation contract; until then, stale `pending_ensemble` entries are inspected by manual `state.mjs read` and pruned by hand if needed.

---

## Result Bookkeeping (mandatory)

After Step 3 Synthesize produces the `verdict` (`pass | concerns | conflict`) and `summary` for an in-scope ensemble point, the launching command MUST persist a summary entry to the workflow file's `ensemble_results` field.

- The composite identity of an entry is `(phase, ensemble_type, run_id)`.
- Entries record `verdict`, `summary`, `completed_at`, and an optional `codex_session_id`.
- The remove-pending, append-result, and retention-prune steps MUST be a single atomic mutation (one `atomicModifyFile` invocation that performs the three logical edits in order). Splitting the mutation risks a crash window between pending-removal and result-append in which the originating phase has no recoverable trace of the run.
- **Supersede policy**: if a phase is re-executed (Plan Adjustment, retry), the re-run produces a new entry with the same `(phase, ensemble_type)` but a NEW `run_id`. Entries are never overwritten in place; the list grows subject to the retention cap.
- **Sanitize policy** (writer-side, applied in this order before persisting):
  1. The summary travels as a YAML-double-quoted scalar through `state.mjs yamlScalar` (`JSON.stringify`), which natively escapes CR, LF, control chars, and double quotes.
  2. If a caller wants secret-pattern scrubbing on peer output, run `state.mjs scrubSecrets` on the summary before passing it to `--summary`. The orchestrator MVP does NOT do this automatically for ensemble summaries — it is the caller's responsibility when the peer output may quote logs or credentials.

The retention cap (`ENSEMBLE_RESULTS_RETENTION_CAP = 20`) enforces a global write-time limit. Oldest entries by `completed_at` are evicted on overflow.

---

## Independence Rule

The peer must analyze independently. Do not include the orchestrator's in-progress findings, hypotheses, draft conclusions, or intermediate results in the peer prompt.

Both sides receive the same raw context:

- Source code (via the peer's own file access).
- Git state (via the peer's own git access).
- The user's original feature description.

**Single exception**: Plan-verify. The peer receives the orchestrator's draft plan as explicit input, because the task is to find gaps in that specific plan. This exception applies only to the Plan-verify ensemble point and not to any future point types.

---

## Ensemble Point Type — Plan-verify

The orchestrator MVP ships exactly one ensemble point type. Future points (Brainstorm / Explore / Review / Investigate / Audit-scan / Codex-now) ship in follow-up PRs alongside the corresponding command-mode flows.

- **Purpose**: Find gaps in the orchestrator's draft macro plan (`plan.subtasks[]`).
- **Subcommand**: `task` (per `companions/contract.md` §2.2).
- **Independence exception**: receives the orchestrator's draft plan as input.
- **Prompt template**:

  ```xml
  <task>
  Review this macro implementation plan for gaps, missing dependencies, ordering errors, underestimated complexity, and edge cases that the plan does not address.

  The plan is a list of subtasks (deliverables) for a multi-PR feature. Each subtask will later be driven by a separate engineer workflow.
  </task>

  <structured_output_contract>
  Return:
  1. Gaps: missing subtasks or considerations
  2. Ordering issues: subtasks that should come earlier/later, missing blocked_by edges, cycles
  3. Risk areas: subtasks with underestimated scope (likely to overflow a single engineer workflow)
  4. Edge cases: scenarios the plan does not handle (rollback path, partial-completion, dependency change)
  </structured_output_contract>

  <inputs>
    <input name="feature_description">{user's macro feature description}</input>
    <input name="draft_plan">{orchestrator's draft plan.subtasks[] as JSON or formatted text}</input>
  </inputs>

  <grounding_rules>
  Ground every gap or issue in specific subtasks (by id) or codebase evidence. Do not propose subtasks that contradict the macro layer's role (one subtask = one deliverable / one engineer workflow / one PR).

  Schema 1.1 constraints (per ADR-0019 §2): every subtask MUST carry `id` (unique), `verb` (one of investigate / frame / decide / compose / critique / refine), `branch` (git ref-format), `blocked_by` (array of existing ids), and `status` (one of pending / blocked / in_progress / completed / deferred / abandoned). `branch` values must be unique across subtasks AND must not have a parent/child path-prefix relationship (`feat/api` + `feat/api/db` is rejected — git stores refs as path components; pick siblings like `feat/api/db` + `feat/api/auth` instead). Optional fields: `label`, `profile`, `topic`. Any peer-proposed addition or revision MUST satisfy these constraints — `plan-set` rejects plans that don't.
  </grounding_rules>
  ```

- **Synthesis** (per *Base Synthesis Categories* above): incorporate valid gaps into the plan; if the peer found real missing subtasks, add them. If the peer flagged ordering issues, adjust `blocked_by`. Note any peer concerns the orchestrator side disagrees with under CONFLICT.

---

## Failure Handling

### Companion unavailable, not installed, or unauthenticated

- **Detect**: `peer-runner.mjs run` returns `{ ok: false, kind: 'peer_cli_not_found' }`.
- **Action**: log warning, proceed with LOCAL-ONLY results. Synthesis presents the orchestrator's draft plan as a single LOCAL-ONLY decision item.
- **Present**: "Codex ensemble unavailable — macro plan is LOCAL-ONLY. Run `/codex:setup` to configure the Codex peer for the next plan revision."

### Peer timeout, error, or malformed envelope

- **Detect**: peer-runner returns non-zero exit or envelope shape validation fails.
- **Action**: log the error, proceed with LOCAL-ONLY results.
- **Present**: "Codex peer analysis did not complete — macro plan is LOCAL-ONLY for this dispatch."

### Graceful degradation principle

Ensemble failure must never block the workflow. LOCAL-ONLY results are always sufficient to proceed. The peer ensemble adds value when available but is not required.
