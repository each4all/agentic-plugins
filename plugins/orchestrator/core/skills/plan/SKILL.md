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

**Split a document that carries many decisions** (C120): an ADR, or another document subtask, whose topic would settle more than two decisions is proposed as a chain of slices of one or two decisions each, linked by `blocked_by`. The advice is the planner's, never a `plan-set` refusal: a large document still validates. Each slice's topic states:

- what it owns: the decisions it settles, by name, and the sections it writes;
- what it claims: the ADR number, pre-assigned in every slice's topic (the first slice creates the file, later slices amend it under a dated heading, never by rewriting a decision an earlier slice settled);
- what it leaves to the next slice.

Each slice is one engineer workflow, one critique-refine loop and one landing round (a pull request, review and merge), so a chain of N slices costs N landing rounds. That cost buys convergence: a document deliverable is critiqued in full once and then re-checked only where a refine changed it (ADR-0063, amendment of 2026-10-14), and the fewer decisions a document carries, the fewer findings a full critique can raise against text no refine touched. Keep one subtask when the decisions cannot be read apart (one decides the other's terms) and say so in its description.

### Step 3: Present and confirm

Follow the Presentation Mode Protocol (`../_shared/references/presentation-protocol.md`) before presenting. The full subtask list IS one decision item — present it as a macro plan, ask the user to confirm the decomposition + dependency graph before any work proceeds. Once a plan is written to a macro workflow, that confirmation is recorded with `orchestrator:approve` (`/orchestrator:approve` on Claude, `$orchestrator:approve` on Codex), which binds the approval to the plan's hash (ADR-0063 D6).

---

## When invoked by command (`/orchestrator:plan` Claude command or `$orchestrator:plan` Codex skill mention)

Full macro composition with Plan-verify opposite-host peer ensemble + state-write.

**Text you write travels as files** (ADR-0059, amendment of 2026-10-10). The feature description, the Plan-verify prompt, the subtasks, the decision, the architecture, the phase note and the ensemble summary are text you write, and the note and summary carry the peer's sentences: a backtick or `$(…)` spliced into a command line runs as a command. Create a private directory once (`mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`, noting the path it prints), write each value there with your file-editing tool, never with the shell, ending the file with one newline, and pass the file's path: `--original-request-file`, `--prompt-file`, `--subtasks-json-file`, `--decision-file`, `--architecture-file`, `--phase-note-file`, `--summary-file`. `state.mjs` reads each file itself, removes its final newline, and refuses an empty or missing one before it writes. Nothing deletes the files.

### Step 1: Establish the active workflow

Phase 0 of `commands/plan.md` resolves the active orchestrator workflow on the current git branch (per ADR-0018 §sub-2 — branch is the workflow context). If none exists, create one via `state.mjs create --verb plan ... --original-request-file <file>`, the file holding the feature description on one line, scrubbed of secrets. Then write the macro's path (the one `create` printed, or `find-active` found) to `macro-path` in the text directory with your file-editing tool, one line: every later step writes to that macro, and Step 6 reads it there instead of finding the macro again, so a branch switched meanwhile cannot point it at another one.

If one exists, pass `--require-open` on the resume append and on the post-plan append: a terminal macro is not revised (ADR-0062 §Decision 4), and the flag makes each append refuse a macro whose `terminal_marker` is set under the same lock as the write — a separate check first would race a finalize in another session. Both appends rewrite `current_phase`, which would otherwise leave the marker set with a phase the archive gate rejects. On refusal, stop before writing anything else and tell the user to archive it (`$orchestrator:resume archive`) and plan the new work afresh. `state.mjs plan-set` refuses a terminal macro as well.

Detached HEAD or empty branch is an error — the macro workflow needs a branch context.

### Step 2: Compose the macro plan

Follow the auto-activated Step 1 (Decompose) and Step 2 (Order) above to produce a draft `subtasks[]`.

### Step 3: Plan-verify opposite-host peer ensemble

Launch the peer ensemble per `../_shared/references/ensemble-protocol.md` using the **Plan-verify** ensemble point. The peer receives the orchestrator's draft plan as `<inputs><input name="feature_description">…</input><input name="draft_plan">…</input></inputs>` (the only Independence Rule exception — Plan-verify is the per-protocol exception). The peer returns gaps, ordering issues, risk areas, and edge cases on the macro plan.

Resolve the peer from the current host: Claude invokes Codex; Codex invokes Claude. Ensemble dispatch is via `peer-runner.mjs run --kind ensemble --peer <opposite-host> --prompt-file <the prompt file you wrote> --workflow-path <path> --phase plan --ensemble-type plan-verify --run-id <the id in run-id>`, the run id the runner allocated (C119, C26), never one you write: `node "<plugin-root>/scripts/peer-runner.mjs" new-run-id --prefix macro-plan > "<text directory>/run-id"` prints it to `run-id` (an allocation that fails leaves the file empty, and you dispatch nothing), and the dispatch reads it there with `--run-id "$(cat "<text directory>/run-id")"`. The runner preserves orchestrator's graceful-degradation order: if the opposite-host peer is unavailable, it returns kind `peer_cli_not_found` with no peer-run ledger and no pending entry; caller proceeds with a LOCAL-ONLY plan. If the companion resolves, the runner creates the peer-run ledger, records pending best-effort under the workflow file's per-file lock, and supervises stdout/stderr/envelope capture. A codex peer runs in a snapshot of HEAD plus the working tree and the index (C96), never the checkout, made after the pending entry and removed when the run ends; a snapshot that cannot be made ends the run `failed` with `error_kind: snapshot_failed` and no peer run (`../_shared/references/ensemble-protocol.md` § Step 1 and § Step 2). Before you dispatch, allocate the run id into `run-id` in the text directory as above, and write the macro's path you pass to `--workflow-path` to `run-macro` beside it with your file-editing tool, one line: Step 5 and Step 6 read them there, in shell calls of their own, and Step 6 records a run only for the macro `run-macro` names. Do both for every dispatch, an earlier run's included, and empty `run-id` first when the dispatch does not reach the runner: a run id left from an earlier dispatch is not this one's.

### Step 4: Synthesize

Apply the four base synthesis categories (host-agnostic per ensemble-protocol):

- **AGREED [Both]**: local orchestrator and peer both flagged the same subtask, gap, or ordering issue.
- **LOCAL-ONLY**: only the orchestrator's draft included it.
- **PEER-ONLY**: the peer surfaced it but the orchestrator's draft did not.
- **CONFLICT**: local orchestrator and peer disagree about a subtask boundary, dependency, or risk.

Incorporate valid PEER-ONLY additions. Adjust ordering for valid sequencing issues. Note CONFLICT items for user resolution. Empty `subtasks[]` (zero deliverables) is valid — it represents a deliberate "no work needed" terminal plan.

### Step 5: Persist via setPlan

Once the synthesized plan is ready, write it via `state.mjs plan-set --workflow-path <path> --host <current-host> --subtasks-json-file <subtasks file> --verdict <pass|concerns|conflict> [--run-id <the Plan-verify run id>] [--decision-file <file>] [--architecture-file <file>]`, where `<current-host>` is `claude` for `/orchestrator:plan` and `codex` for `$orchestrator:plan`, and the decision and architecture files each hold one line you wrote. The CLI reads the JSON file (top-level array of subtask objects matching ADR-0018 §sub-1 + ADR-0019 §2 schema 1.1) and atomically writes the `plan` block under the per-file lock. The same write returns the plan to pending approval (`plan_approval_status=pending`, ADR-0063 D6): any plan write revokes an earlier approval. `--verdict` is the synthesized Plan-verify verdict, the value Step 6 records. With `conflict` the write opens `awaiting_owner_gate=plan-conflict` (pointer `<macro file>#ensemble-synthesis`), otherwise `plan-approval`, so a disputed plan is never approvable, not even between two writes. With `conflict`, `--run-id` names the Plan-verify run the gate records (ADR-0067 Decision 8), the one in `run-id`, dispatched for the macro `run-macro` names (this one), and the write retires every consensus task file the macro still has.

Subtask validation runs at the write boundary (schema 1.1):
- `id` non-empty + unique within the plan
- `verb` (REQUIRED) — one of `investigate | frame | decide | compose | critique | refine`
- `branch` (REQUIRED) — must pass git ref-format (no spaces, no leading `.`, no `..`, no `~ ^ : ? * [ \\`, no trailing `/` or `.lock`, no `@{`, not `HEAD`, not `-`-prefixed); branch values MUST be unique across subtasks (dispatch keys engineer workflows by branch); branches MUST NOT have a parent/child path-prefix relationship across subtasks (e.g., `feat/api` and `feat/api/db` cannot coexist — git stores refs as path components, so one ref cannot be both a leaf and a parent directory)
- `blocked_by` references existing ids only and forms a DAG (no unknown id, no cycles — self-reference, mutual `A<->B`, and longer cycles are all rejected with the cycle members named; a cyclic plan can never yield a ready subtask, and the same validator surfaces an already-persisted cyclic plan on read with repair guidance instead of deadlocking `/orchestrator:next`)
- `status` is one of `pending | blocked | in_progress | completed | deferred | abandoned`
- optional fields (`label`, `profile`, `topic`, `engineer_workflow_id`, `commit`, `pr_url`, `closed_at`) are string-or-null

### Step 6: Commit the ensemble result

Record the phase note, then commit the ensemble result, and on a conflict write the consensus task file. Write the files first, in the text directory: `note.md`, the phase note (`--phase-note-file <note file>`) shaped as `commands/plan.md` Phase 2 shows it; `summary.txt`, a one-line résumé of the synthesis (`--summary-file <summary file>`); and on a conflict `contested.md`, each CONFLICT item, both positions and their evidence, prepared as the Plan-verify prompt was, since the consensus peers read it (they come from the peer's positions, so never put them into a command). Put the synthesized verdict (`pass`, `concerns` or `conflict`) in the block's `VERDICT` line. When the run launched and did not complete (`status` is `failed`, `cancelled` or `orphaned`, whatever its `error_kind`, `snapshot_failed` included), the plan is LOCAL-ONLY, `VERDICT` stays the local synthesis's that Step 5 recorded, and you also set the block's `ENSEMBLE_VERDICT` line to `failed` and name the `error_kind` in `summary.txt`, so the ensemble result records the run as failed; a run that found no peer never launched, and leaves it empty. Put the directory in the block's `TEXT_DIR` line, and run the block, `<plugin-root>` being the orchestrator plugin root (`../checkpoint/SKILL.md` § Command resolution). The block reads the macro from `macro-path` (Step 1) and the run id from `run-id`.

The block checks every input before it writes anything, as `commands/plan.md` Phase 2 does (C132): the two verdicts, the run id (in the form the macro's records of a run take: letters, digits, `_` and `-`, opening with a letter or digit, which `peer-runner.mjs new-run-id` allocates) and `run-macro`, which must name the macro Step 1 wrote to `macro-path`, `note.md` and `summary.txt` with `state.mjs`'s own reader (missing, empty, a newline alone, a NUL byte, not UTF-8 are refused), and on a conflict `contested.md` as `consensus-task` reads it, and the macro's frontmatter (a terminal macro is refused; so is a verdict other than `conflict` for a run whose `plan-conflict` gate Step 5 set, whether the gate is still set or the owner has cleared it, a `conflict` for a run the macro records neither gate nor clear for, and a verdict other than the one a result already recorded for the run carries, since `ensemble-commit` keeps the first one). A refusal there writes nothing. A block that stops at one of the writes that follow is rerun as it is, after the cause is fixed, and each write then happens once: the append is keyed by the run (`--run-id`), and the macro's `phase_note_run_ids` makes an append keyed by a run it lists write nothing; `ensemble-commit` keeps a result already recorded for the run id; and `consensus-task` writes the same task file again while the run's `plan-conflict` gate is set. Once the owner has cleared that gate, the macro records the run as `plan_conflict_cleared_run_id` and no round is proposed for it, also when Step 5 run again has gated the run since (`consensus-task` refuses the run too, so a clear between the block's read and the task write stops the block, and its rerun finds the record). Each is decided from the macro's frontmatter, never from a note's text. `ensemble-commit` is a three-step atomic mutation: it pops the matching pending_ensemble entry, appends the result, and prunes to retention cap 20 — all under one `withFileLock` window.

```bash
TEXT_DIR='<directory from mktemp>'
VERDICT='<pass|concerns|conflict>'
# The verdict the ensemble result records: VERDICT's when this stays empty,
# failed for a run that launched and did not complete.
ENSEMBLE_VERDICT=''
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# The macro Step 1 found, not the one this branch names now.
ACTIVE="$(cat "$TEXT_DIR/macro-path")" || { echo "✗ Write the macro's path to $TEXT_DIR/macro-path first (Step 1); nothing was written." >&2; exit 1; }
[ -f "$ACTIVE" ] || { echo "✗ $TEXT_DIR/macro-path names no macro file (\"$ACTIVE\"); nothing was written." >&2; exit 1; }
# Every input, before any write (C132).
case "$VERDICT" in
  pass|concerns|conflict) ;;
  *) echo "✗ VERDICT is \"$VERDICT\", not pass, concerns or conflict; nothing was written." >&2; exit 1;;
esac
case "${ENSEMBLE_VERDICT:-$VERDICT}" in
  "$VERDICT") ;;
  failed)
    if [ "$VERDICT" = conflict ]; then
      echo "✗ A run that did not complete gave no peer positions to conflict with; nothing was written." >&2
      exit 1
    fi;;
  *) echo "✗ ENSEMBLE_VERDICT is \"$ENSEMBLE_VERDICT\": leave it empty, or set it to failed; nothing was written." >&2; exit 1;;
esac
RUN_ID="$(cat "$TEXT_DIR/run-id")" || { echo "✗ Write the Plan-verify run id to $TEXT_DIR/run-id first; nothing was written." >&2; exit 1; }
[ -n "$RUN_ID" ] || { echo "✗ $TEXT_DIR/run-id is empty; nothing was written." >&2; exit 1; }
RUN_MACRO="$(cat "$TEXT_DIR/run-macro")" || { echo "✗ Write the macro's path you dispatched the run for to $TEXT_DIR/run-macro first (Step 3); nothing was written." >&2; exit 1; }
[ "$RUN_MACRO" = "$ACTIVE" ] || { echo "✗ Run $RUN_ID was dispatched for $RUN_MACRO, not for $ACTIVE: dispatch a Plan-verify run for this macro; nothing was written." >&2; exit 1; }
# A run id the macro's records of a run cannot take (the keyed append's form,
# which the gate and the task file's name take too: opening with a letter or
# digit, so no command reads it as an option) is refused here, before the note
# and the result are written.
STATE_MJS="<plugin-root>/scripts/state.mjs" node --input-type=module -e 'const { pathToFileURL } = await import("node:url"); const { isSafeConsensusRunId } = await import(pathToFileURL(process.env.STATE_MJS).href); process.exitCode = isSafeConsensusRunId(process.argv[1]) ? 0 : 1' -- "$RUN_ID" \
  || { echo "✗ $TEXT_DIR/run-id holds \"$RUN_ID\", not a run id the macro can record (letters, digits, _ and -, opening with a letter or digit); nothing was written." >&2; exit 1; }
# Both text files, read by state.mjs's own reader. (The path to state.mjs goes
# by the environment: as the first argument it would make the import run
# state.mjs as a command.)
STATE_MJS="<plugin-root>/scripts/state.mjs" node --input-type=module -e 'const { pathToFileURL } = await import("node:url"); const { readTextArgumentFile } = await import(pathToFileURL(process.env.STATE_MJS).href); const pairs = process.argv.slice(1); try { for (let i = 0; i < pairs.length; i += 2) readTextArgumentFile(pairs[i + 1], pairs[i]); } catch (err) { process.stderr.write(`✗ ${err.message}: write it with your file-writing tool first; nothing was written.\n`); process.exitCode = 1; }' \
  -- --phase-note-file "$TEXT_DIR/note.md" --summary-file "$TEXT_DIR/summary.txt" || exit 1
CONTESTED_FILE="$TEXT_DIR/contested.md"
if [ "$VERDICT" = conflict ]; then
  node -e 'let t;try{t=require("fs").readFileSync(process.argv[1],"utf8")}catch{process.exit(1)}process.exit(t.trim()===""?1:0)' "$CONTESTED_FILE" \
    || { echo "✗ $CONTESTED_FILE is missing or blank: write the contested items there first; nothing was written." >&2; exit 1; }
fi
# The macro, read before any write, as commands/plan.md Phase 2 reads it: a
# terminal macro is refused, and the verdict is held to the macro's records of
# the run (C132): Step 5's plan-conflict gate for it, or the owner's clear of
# that gate (plan_conflict_cleared_run_id), each of which says the run's
# verdict is conflict, and a result already recorded for the run. The read is
# checked apart from the parser (C110). It prints cleared once the owner has
# cleared the run's gate, also when Step 5 run again gated it since
# (consensus-task refuses a cleared run, so the record decides), gated while
# the gate names this run, open for a run with no gate.
MACRO_JSON="$(node "<plugin-root>/scripts/state.mjs" read --workflow-path "$ACTIVE")" || { echo "✗ Could not read $ACTIVE; nothing was written." >&2; exit 1; }
RUN_GATE="$(printf '%s' "$MACRO_JSON" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const [file,id,verdict,recorded]=process.argv.slice(1);const m=JSON.parse(d);const stop=(why)=>{process.stderr.write(`✗ ${why}; nothing was written.\n`);process.exit(1)};if(m.terminal_marker===true)stop(`${file} is terminal: a terminal macro is not revised (ADR-0062 §Decision 4)`);const cleared=m.plan_conflict_cleared_run_id===id;const gated=!cleared&&m.awaiting_owner_gate==="plan-conflict"&&m.awaiting_owner_run_id===id;if(verdict!=="conflict"&&gated)stop(`plan-set recorded the plan-conflict gate for run ${id}, but VERDICT is ${verdict}: run plan-set with the verdict ${verdict} first`);if(verdict!=="conflict"&&cleared)stop(`the owner cleared the plan-conflict gate plan-set recorded for run ${id}, but VERDICT is ${verdict}: the run keeps the verdict conflict; dispatch a new Plan-verify run for another verdict`);if(verdict==="conflict"&&!gated&&!cleared)stop(`no plan-conflict gate names run ${id}, and the owner cleared none for it: plan-set recorded another verdict; run plan-set with the verdict conflict first`);const prior=(Array.isArray(m.ensemble_results)?m.ensemble_results:[]).find((e)=>e&&e.run_id===id);if(prior&&prior.verdict!==recorded)stop(`the ensemble result of run ${id} is already recorded with the verdict ${prior.verdict}, not ${recorded}, and a recorded result is kept: dispatch a new Plan-verify run for another verdict`);process.stdout.write(gated?"gated":cleared?"cleared":"open")})' -- "$ACTIVE" "$RUN_ID" "$VERDICT" "${ENSEMBLE_VERDICT:-$VERDICT}")" || exit 1
# Keyed by the run (C132): the write that adds the note lists the run in
# phase_note_run_ids, and an append keyed by a listed run writes nothing, so a
# rerun after a failure past the append records the note once.
node "<plugin-root>/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host <claude|codex> \
  --phase-label "Phase 1: Plan (synthesized)" \
  --phase-note-file "$TEXT_DIR/note.md" \
  --current-phase phase-2-presented \
  --next-action 'Await approval of the macro plan by the owner ($orchestrator:approve); then $orchestrator:next dispatches the first ready subtask' \
  --event updated --require-open --run-id "$RUN_ID" || exit 1
node "<plugin-root>/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --run-id "$RUN_ID" \
  --phase plan --ensemble-type plan-verify \
  --verdict "${ENSEMBLE_VERDICT:-$VERDICT}" --summary-file "$TEXT_DIR/summary.txt" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || exit 1
# The round only while the plan-conflict gate names the run: a gate the owner
# has cleared, which the macro records, leaves no conflict to propose a round
# for.
if [ "$VERDICT" = conflict ]; then
  if [ "$RUN_GATE" = gated ]; then
    PROPOSED="$(node "<plugin-root>/scripts/state.mjs" consensus-task \
      --workflow-path "$ACTIVE" --host <claude|codex> --run-id "$RUN_ID" \
      --text-file "$CONTESTED_FILE")" || exit $?
    echo "→ Proposed, for the owner to run before deciding: $PROPOSED" >&2
  else
    echo "→ The owner has cleared the plan-conflict gate of run $RUN_ID (plan_conflict_cleared_run_id): its conflict is decided, and no consensus round is proposed." >&2
  fi
fi
```

### Step 7: Present and confirm

Follow the Presentation Mode Protocol before presenting. Present the synthesized plan as one macro decision item. Wait for user approval before reporting completion.

When the verdict was `conflict`, Step 5's write left the plan at `awaiting_owner_gate=plan-conflict` (ADR-0063 D6). `plan-approve` refuses while `plan-conflict` is set. The owner either revises the plan (a new `plan-set`), or decides the conflict, clears the gate with `state.mjs awaiting-owner-clear --gate plan-conflict` (which returns the plan to `plan-approval`), and approves. The owner's approval is recorded with `orchestrator:approve`; do not approve on the owner's behalf.

A `conflict` also proposes a bounded consensus round before the owner decides (ADR-0067 Decision 8). Step 6's block, once it has recorded the run, passes `contested.md` to `state.mjs consensus-task --workflow-path <path> --host <claude|codex> --run-id <macro-plan-…> --text-file <file>`, which writes `.agentic-plugins/state/orchestrator/consensus/<macro-id>.<run-id>.md` and prints the round: `/runtime:consensus plan --task-file <its absolute path> --peers claude,codex --max-rounds 2`. That command is the proposal's `next_command`, with "the owner decides now" among its `rejected_alternatives`; the owner runs it, nothing else does. Clearing `plan-conflict`, or a re-plan, retires the file.

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
