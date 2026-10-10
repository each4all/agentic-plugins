---
name: plan
description: "Macro orchestration verb — produce a multi-deliverable plan (plan.subtasks[]) for a feature, verify the plan via a Plan-verify opposite-host peer ensemble, and persist to the active orchestrator workflow file. Use when the user faces a feature that spans multiple PRs / branches / engineer workflows. Trigger phrases include 'macro plan', 'multi-deliverable', 'orchestrate', 'plan a multi-PR feature', 'break this into subtasks', 'orchestrator plan', '매크로 계획', '여러 PR로 나눌'."
---

# Plan (orchestrator capability)

The orchestrator plugin's macro composition verb (per ADR-0018 §sub-decision-1). Plan produces a list of deliverables (`plan.subtasks[]`) from a feature description, verifies the plan via a Plan-verify opposite-host peer ensemble, and persists the result to the active orchestrator workflow file.

This is the **macro layer** complement to `engineer:compose`. The two verbs share the Plan-verify ensemble pattern but differ in scope:

| Verb | Scope | Output |
|------|-------|--------|
| `engineer:compose --profile=plan` | Single deliverable | A task list within one workflow |
| **`orchestrator:plan` (this skill)** | **Multi-deliverable feature** | **`plan.subtasks[]` — a list of deliverables, each later driven by its own engineer workflow through `/orchestrator:next`** |

**Core principle**: a macro plan precedes per-deliverable composition. When a feature can be cleanly executed in one engineer workflow, use `engineer:compose`; when it spans 2+ deliverables with dependencies, run `orchestrator:plan` first to set the macro contract, then drive each deliverable through engineer with `/orchestrator:next`.

---

## When auto-activated (without command)

Lightweight in-context macro planning — no peer ensemble dispatch, no workflow file write.

### Step 1: Decompose the feature

For a feature description, propose 2-N subtasks where each subtask is independently completable in one engineer workflow. Each subtask captures:

```
### Subtask [id]: [label]
- **Verb**: [canonical 6-verb: investigate | frame | decide | compose | critique | refine] (REQUIRED — ADR-0019 §2)
- **Branch**: [git branch name; must pass git ref-format — no spaces, no leading '.', no '..', no '~ ^ : ? * [ \\', no trailing '/' or '.lock'; branch values MUST be unique across subtasks AND MUST NOT have a parent/child path-prefix relationship (e.g., `feat/api` and `feat/api/db` cannot coexist — pick siblings like `feat/api/db` + `feat/api/auth` instead)] (REQUIRED — ADR-0019 §1)
- **Profile**: [sub-discipline argument passed to engineer, e.g., backend / architecture / ui — optional]
- **Topic**: [one-line objective passed as engineer's original_request — optional]
- **Description**: [1-2 sentences explaining what this deliverable accomplishes]
- **Dependencies**: [subtask ids that must complete before this one can start]
- **Status**: pending | blocked | in_progress | completed | deferred | abandoned (initial: pending or blocked depending on dependencies; deferred / abandoned are terminal-partial states set by /orchestrator:finalize / /orchestrator:abort respectively)
```

The id is a short token unique within the plan (e.g., `PR1`, `PR2`, or thematic short names like `schema-reader` / `schema-writer`).

**Verb selection guidance** — pick the verb that matches the subtask's terminal cognitive activity. If the subtask gathers evidence → `investigate`. If it composes a concrete artifact → `compose`. If it evaluates an existing artifact → `critique`. Engineer's resume mechanism handles upstream verbs (e.g., a `compose` subtask may run investigate first inside the same engineer workflow). When the verb is ambiguous, default to `compose` for build-style deliverables and `investigate` for research-style ones.

### Step 2: Order by dependencies

Identify the dependency graph. If a subtask depends on others, mark its initial status as `blocked` and list its predecessors in `blocked_by`.

**Shared numbers** (ADR-0067 Decision 8, item 2): subtasks with no path between them may run side by side, in lanes. Pre-assign in their topics any number two of them could both take — an ADR number, a port, a section number — so neither picks the same one; the topics are part of the plan the owner approves.

### Step 3: Present and confirm

Follow the Presentation Mode Protocol (`../_shared/references/presentation-protocol.md`) before presenting. The full subtask list IS one decision item — present it as a macro plan, ask the user to confirm the decomposition + dependency graph before any work proceeds. Once a plan is written to a macro workflow, that confirmation is recorded with `orchestrator:approve` (`/orchestrator:approve` on Claude, `$orchestrator:approve` on Codex), which binds the approval to the plan's hash (ADR-0063 D6).

---

## When invoked by command (`/orchestrator:plan` Claude command or `$orchestrator:plan` Codex skill mention)

Full macro composition with Plan-verify opposite-host peer ensemble + state-write.

### Step 1: Establish the active workflow

Phase 0 of `commands/plan.md` resolves the active orchestrator workflow on the current git branch (per ADR-0018 §sub-2 — branch is the workflow context). If none exists, create one via `state.mjs create --verb plan ...`.

If one exists, pass `--require-open` on the resume append and on the post-plan append: a terminal macro is not revised (ADR-0062 §Decision 4), and the flag makes each append refuse a macro whose `terminal_marker` is set under the same lock as the write — a separate check first would race a finalize in another session. Both appends rewrite `current_phase`, which would otherwise leave the marker set with a phase the archive gate rejects. On refusal, stop before writing anything else and tell the user to archive it (`$orchestrator:resume archive`) and plan the new work afresh. `state.mjs plan-set` refuses a terminal macro as well.

Detached HEAD or empty branch is an error — the macro workflow needs a branch context.

### Step 2: Compose the macro plan

Follow the auto-activated Step 1 (Decompose) and Step 2 (Order) above to produce a draft `subtasks[]`.

### Step 3: Plan-verify opposite-host peer ensemble

Launch the peer ensemble per `../_shared/references/ensemble-protocol.md` using the **Plan-verify** ensemble point. The peer receives the orchestrator's draft plan as `<inputs><input name="feature_description">…</input><input name="draft_plan">…</input></inputs>` (the only Independence Rule exception — Plan-verify is the per-protocol exception). The peer returns gaps, ordering issues, risk areas, and edge cases on the macro plan.

Resolve the peer from the current host: Claude invokes Codex; Codex invokes Claude. Ensemble dispatch is via `peer-runner.mjs run --kind ensemble --peer <opposite-host> --workflow-path <path> --phase plan --ensemble-type plan-verify --run-id macro-plan-<iso>-<rand>`. The runner preserves orchestrator's graceful-degradation order: if the opposite-host peer is unavailable, it returns kind `peer_cli_not_found` with no peer-run ledger and no pending entry; caller proceeds with a LOCAL-ONLY plan. If the companion resolves, the runner creates the peer-run ledger, records pending best-effort under the workflow file's per-file lock, and supervises stdout/stderr/envelope capture.

### Step 4: Synthesize

Apply the four base synthesis categories (host-agnostic per ensemble-protocol):

- **AGREED [Both]**: local orchestrator and peer both flagged the same subtask, gap, or ordering issue.
- **LOCAL-ONLY**: only the orchestrator's draft included it.
- **PEER-ONLY**: the peer surfaced it but the orchestrator's draft did not.
- **CONFLICT**: local orchestrator and peer disagree about a subtask boundary, dependency, or risk.

Incorporate valid PEER-ONLY additions. Adjust ordering for valid sequencing issues. Note CONFLICT items for user resolution. Empty `subtasks[]` (zero deliverables) is valid — it represents a deliberate "no work needed" terminal plan.

### Step 5: Persist via setPlan

Once the synthesized plan is ready, write it via `state.mjs plan-set --workflow-path <path> --host <current-host> --subtasks-json-file <tmp.json> --verdict <pass|concerns|conflict> [--run-id <the Plan-verify run id>] [--decision <text>] [--architecture <text>]`, where `<current-host>` is `claude` for `/orchestrator:plan` and `codex` for `$orchestrator:plan`. The CLI reads the JSON file (top-level array of subtask objects matching ADR-0018 §sub-1 + ADR-0019 §2 schema 1.1) and atomically writes the `plan` block under the per-file lock. The same write returns the plan to pending approval (`plan_approval_status=pending`, ADR-0063 D6): any plan write revokes an earlier approval. `--verdict` is the synthesized Plan-verify verdict, the value Step 6 records. With `conflict` the write opens `awaiting_owner_gate=plan-conflict` (pointer `<macro file>#ensemble-synthesis`), otherwise `plan-approval`, so a disputed plan is never approvable, not even between two writes. With `conflict`, `--run-id` names the Plan-verify run the gate records (ADR-0067 Decision 8), and the write retires every consensus task file the macro still has.

Subtask validation runs at the write boundary (schema 1.1):
- `id` non-empty + unique within the plan
- `verb` (REQUIRED) — one of `investigate | frame | decide | compose | critique | refine`
- `branch` (REQUIRED) — must pass git ref-format (no spaces, no leading `.`, no `..`, no `~ ^ : ? * [ \\`, no trailing `/` or `.lock`, no `@{`, not `HEAD`, not `-`-prefixed); branch values MUST be unique across subtasks (dispatch keys engineer workflows by branch); branches MUST NOT have a parent/child path-prefix relationship across subtasks (e.g., `feat/api` and `feat/api/db` cannot coexist — git stores refs as path components, so one ref cannot be both a leaf and a parent directory)
- `blocked_by` references existing ids only and forms a DAG (no unknown id, no cycles — self-reference, mutual `A<->B`, and longer cycles are all rejected with the cycle members named; a cyclic plan can never yield a ready subtask, and the same validator surfaces an already-persisted cyclic plan on read with repair guidance instead of deadlocking `/orchestrator:next`)
- `status` is one of `pending | blocked | in_progress | completed | deferred | abandoned`
- optional fields (`label`, `profile`, `topic`, `engineer_workflow_id`, `commit`, `pr_url`, `closed_at`) are string-or-null

### Step 6: Commit the ensemble result

Invoke `state.mjs ensemble-commit --workflow-path <path> --run-id <macro-plan-…> --phase plan --ensemble-type plan-verify --verdict pass|concerns|conflict --summary <text>`. The three-step atomic mutation pops the matching pending_ensemble entry, appends the result, and prunes to retention cap 20 — all under one `withFileLock` window.

### Step 7: Present and confirm

Follow the Presentation Mode Protocol before presenting. Present the synthesized plan as one macro decision item. Wait for user approval before reporting completion.

When the verdict was `conflict`, Step 5's write left the plan at `awaiting_owner_gate=plan-conflict` (ADR-0063 D6). `plan-approve` refuses while `plan-conflict` is set. The owner either revises the plan (a new `plan-set`), or decides the conflict, clears the gate with `state.mjs awaiting-owner-clear --gate plan-conflict` (which returns the plan to `plan-approval`), and approves. The owner's approval is recorded with `orchestrator:approve`; do not approve on the owner's behalf.

A `conflict` also proposes a bounded consensus round before the owner decides (ADR-0067 Decision 8). Once Step 6 has recorded the run, write the contested items (each CONFLICT item, both positions and their evidence, prepared as the Plan-verify prompt was) with the file tool to a file, never into a command, since they come from the peer's positions, and pass it to `state.mjs consensus-task --workflow-path <path> --host <claude|codex> --run-id <macro-plan-…> --text-file <file>`, which writes `.agentic-plugins/state/orchestrator/consensus/<macro-id>.<run-id>.md` and prints the round: `/runtime:consensus plan --task-file <its absolute path> --peers claude,codex --max-rounds 2`. That command is the proposal's `next_command`, with "the owner decides now" among its `rejected_alternatives`; the owner runs it, nothing else does. Clearing `plan-conflict`, or a re-plan, retires the file.

### Step 8: Session-level handoff preflight

After the plan is approved, surface the ADR-0031 session-level
continue-vs-fresh preflight per
`core/skills/_shared/references/session-handoff.md`: compute the macro projection
(find-active then find-macro) and pass it to the runtime footer/check, so the
proposal's `next_command` (typically `/orchestrator:next` for a freshly approved
plan) is sized by context-budget risk + archive-gate readiness. The preflight computes identically on Codex; only auto re-injection
of the next-session prompt depends on the stage-appropriate Codex hook gate
(generic `[features].hooks`, default on) + a `/hooks`
trust (operator-attested; not provable non-interactively). On detached HEAD,
report "no active branch context".

---

## Completion

After the plan is approved and the session-level preflight is surfaced, emit an
**Active Next-Action Proposal** instead of a fixed next verb, per
`../_shared/references/session-handoff.md § Active Next-Action Proposal`
(canonical: `entry-routing-contract.md § Active Next-Action Proposal` in the
engineer plugin — cited by name, ADR-0010 §5 copy-not-import). Surface the
canonical six-field template (runtime completion-output contract):

```
- selected_next:         <macro action | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <macro plan / subtask states / phase notes — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: $orchestrator:<command> … — or the wait / owner-decision action>
```

For a freshly written macro plan the typical `selected_next` is the owner's
approval, `/orchestrator:approve` or `$orchestrator:approve` on Codex. Under
ADR-0063's autopilot `orchestrator:next` dispatches only an approved plan (D6),
while an interactive dispatch does not require it and only warns about a plan
pending approval. For an approved plan it is `/orchestrator:next`
(dispatch the first unblocked subtask) or
`$orchestrator:next` on Codex — but a zero-subtask plan or a surfaced CONFLICT
routes to the honest next step (closing the plan, or an owner decision), never a
hardcoded literal.

The proposal takes the first that applies: conflict resolution, then approval
(ADR-0067 Decision 8, item 2). After its six fields, add the line
`state.mjs lane-advice --workflow-path <macro> --repo-root <checkout> --format line`
prints, when it prints one: the subtasks that could run side by side and the
autopilot command that would run them so, or that the state-root cutover comes
first. It is computed each time, display only, and never replaces the
selection. The autopilot it names runs on Claude Code only (ADR-0063 D9); on
Codex the subtasks stay manual, one `$orchestrator:next` per checkout.

## Anti-patterns (do not produce)

- **Macro plan without dependencies recorded**. If subtask B truly depends on A, `blocked_by: ['A']` MUST be set so the future `/orchestrator:next` knows.
- **Subtask granularity matching engineer task granularity**. Each subtask is a *deliverable* (one engineer workflow / one PR), not a single edit. If a subtask is just one file edit, it belongs inside an engineer compose plan, not at the orchestrator macro layer.
- **Skipping the Plan-verify ensemble** in command mode. orchestrator's policy is always-max — opposite-host peer review is the safety net for macro decomposition, where errors compound across multiple PRs.
- **Missing branch suggestion when the subtask is non-trivial**. A `branch` field on each substantial subtask makes the future `/orchestrator:next` git-checkout step unambiguous.
- **Plan that includes implementation steps**. Each subtask describes *what* and *why*, not *how*. The *how* is the engineer workflow's responsibility.
