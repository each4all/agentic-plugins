---
description: Produce the artifact — plan, code, brief, interface, prompt, spec — engineer's composition verb
argument-hint: --profile=plan|code | (or natural-language composition target)
---

# Engineer · Compose

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. The peer ensemble
runs automatically per
`core/skills/_shared/references/ensemble-protocol.md` (Plan-verify point
type — applies to both `plan` and `code` profiles per the section's
generalized intro). Never ask the user whether to invoke the peer.
When the companions plugin or peer CLI is unavailable, the ensemble
degrades silently to local-only.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ENGINEER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

The orchestrator's autopilot driver reads this runbook to check that the
installed engineer honors `AGENTIC_ENGINEER_ROOT`: it looks for the
`${AGENTIC_ENGINEER_ROOT:-…}` spelling the blocks used before they were
generated, which now read the variable with `printenv`. Keep this sentence
while any orchestrator release an owner may still run, or roll back to,
probes for that spelling: first ship a probe that accepts the generated
form, then drop the sentence.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

<!-- pipeline:begin compose-phase-0 -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — the persona's workflows are anchored to a branch.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — ${PERSONA} workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to a branch first: git switch <branch>" >&2
  exit 1
fi
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT")"
FIND_RC=$?
if [ "$FIND_RC" -ne 0 ]; then
  echo "✗ find-active failed (exit $FIND_RC); its error is above." >&2
  exit "$FIND_RC"
fi
# ADR-0063 D4 — prints nothing in interactive mode. Under an autopilot run it
# prints the rules this command then follows
# (core/skills/_shared/references/autopilot-mode.md), and refuses when an owner
# gate is set on the workflow; interactively it prints a pending gate for the
# user. It runs before any write, so a refusal leaves the workflow as it was.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" autopilot-preflight \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" || exit $?
```
<!-- pipeline:end compose-phase-0 -->

Empty `$ACTIVE` → bootstrap with verb=compose:

<!-- pipeline:begin compose-bootstrap -->
In the block, replace the profile placeholder with the profile the arguments
name; `AGENTIC_PROFILE` takes its place when it is set.

The request reaches `state.mjs` as a file, never in the block: in shell
source a quote, `$`, backtick or line break of it would be read as code
(ADR-0059, amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `request.txt` in that
   directory holding a one-line scrubbed user request, ending with one newline.
   Nothing deletes it.

Then run the block with `TEXT_DIR` set to that directory; a request file left
unwritten stops it before any write. When `AGENTIC_TOPIC` is set (a dispatched
run), the block writes it to a file of its own and records that instead, and
steps 1–2 are not needed.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='compose'
DEFAULT_PROFILE='plan'
GIT_BRANCH="$(git branch --show-current)"
GIT_HEAD="$(git rev-parse HEAD)"
STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
# ADR-0019 §1+§3 — when /orchestrator:next dispatches this command,
# it sets AGENTIC_PARENT_WORKFLOW + AGENTIC_ORIGINATING_SUBTASK so
# the create-time bootstrap records the immutable parent linkage.
# Both must be set together (or both absent for direct invocation).
# ADR-0067 Decision 3 — it also sets AGENTIC_PARENT_WORKFLOW_PATH, the
# macro file's absolute path, recorded beside them; an older orchestrator
# sets none. The path is valid only with both ids.
# ADR-0067 Decision 4, item 5 — and AGENTIC_DISPATCH_SELECTION, the selection
# its Phase 1 made (JSON: subtask, branch, verb, profile, topic), recorded
# beside them for every later binding to compare; also valid only with both.
PARENT_ARGS=()
if [ -n "${AGENTIC_PARENT_WORKFLOW:-}" ] || [ -n "${AGENTIC_ORIGINATING_SUBTASK:-}" ]; then
  if [ -z "${AGENTIC_PARENT_WORKFLOW:-}" ] || [ -z "${AGENTIC_ORIGINATING_SUBTASK:-}" ]; then
    echo "✗ AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK must be set together (ADR-0019 §3 immutable parent-child linkage). This usually indicates a dispatcher bug — /orchestrator:next must export both env vars or neither. If you set them manually, set both or neither." >&2
    exit 1
  fi
  PARENT_ARGS=(--parent-workflow "$AGENTIC_PARENT_WORKFLOW" --originating-subtask "$AGENTIC_ORIGINATING_SUBTASK")
  if [ -n "${AGENTIC_PARENT_WORKFLOW_PATH:-}" ]; then
    PARENT_ARGS+=(--parent-workflow-path "$AGENTIC_PARENT_WORKFLOW_PATH")
  fi
  if [ -n "${AGENTIC_DISPATCH_SELECTION:-}" ]; then
    PARENT_ARGS+=(--dispatch-selection "$AGENTIC_DISPATCH_SELECTION")
  fi
elif [ -n "${AGENTIC_PARENT_WORKFLOW_PATH:-}" ]; then
  echo "✗ AGENTIC_PARENT_WORKFLOW_PATH is set without AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK (ADR-0067 Decision 3: the macro path is valid only with both ids). This usually indicates a dispatcher bug, or a variable left over from another session; unset it, or set all three." >&2
  exit 1
elif [ -n "${AGENTIC_DISPATCH_SELECTION:-}" ]; then
  echo "✗ AGENTIC_DISPATCH_SELECTION is set without AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK (ADR-0067 Decision 4, item 5: the dispatch selection is valid only with both ids). This usually indicates a dispatcher bug, or a variable left over from another session; unset it, or set all three." >&2
  exit 1
fi
# The request, as a file (ADR-0059, amendment of 2026-10-10): the one the
# agent wrote, or the AGENTIC_TOPIC a dispatcher exports, which is program data
# the block writes to a private directory of its own, so no text flag is
# inline and a dispatched run needs no file of the agent's.
REQUEST_FILE="$TEXT_DIR/request.txt"
if [ -n "${AGENTIC_TOPIC:-}" ]; then
  REQUEST_FILE="$(mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX")/topic.txt" || exit 1
  printf '%s\n' "$AGENTIC_TOPIC" > "$REQUEST_FILE" || exit 1
fi
grep -q '[^[:space:]]' "$REQUEST_FILE" 2>/dev/null || { echo "✗ request.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb 'compose' --host "${AGENTIC_HOST:-claude}" --persona 'engineer' \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --profile "${AGENTIC_PROFILE:-<profile from the arguments above — default ${DEFAULT_PROFILE}>}" \
  --original-request-file "$REQUEST_FILE" \
  --current-phase phase-0-bootstrap \
  --next-action "Run ${VERB} skill" \
  "${PARENT_ARGS[@]}")" || exit $?
```
<!-- pipeline:end compose-bootstrap -->

Non-empty `$ACTIVE` → append-on-resume:

<!-- pipeline:begin compose-resume -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='compose'
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb 'compose' \
  --profile "<profile or empty>" \
  --phase-label "Phase 0: Resume into ${VERB}" \
  --phase-note "Resumed from prior verb. Profile=<...>." \
  --current-phase phase-0-resume \
  --clear-next-step true \
  --next-action "Run ${VERB} skill" --event resumed || exit $?
```
<!-- pipeline:end compose-resume -->

---

## Phase 1 — Execute compose

Follow the compose skill's command-invoked mode at
`${CLAUDE_PLUGIN_ROOT}/core/skills/compose/SKILL.md`. Profiles:

- `plan` (default) — produce a TDD task list with dependencies and
  success criteria.
- `code` — write the actual implementation files; run tests where
  applicable.

Profile selection: `--profile=<name>` on the command, else inferred
from the user's intent. Missing profile → `plan`. Unknown profile →
fallback to `plan` with one-line warning.

Core principle: a plan precedes code. Code without a confirmed plan
is speculation; code with a plan is verifiable task-by-task.

For `code` profile in command-mode (`$ACTIVE` bound), the skill's
**Layer 2 commit-manifest recording** step requires
`state.mjs record-composed-file --workflow-path "$ACTIVE" --path <p>
--op create|edit` after each Write/Edit on a tracked path. See
`core/skills/compose/SKILL.md` § Layer 2 commit-manifest recording for the
full pattern (ADR-0028 §Layer-2).

### Ensemble dispatch (Plan-verify point type)

Build the Plan-verify prompt per
`core/skills/_shared/references/ensemble-protocol.md` § Plan-verify (compose
phase), reusing the same template for the `code` profile with the diff or
the list of written files in place of the draft plan:

Run this block **as a host background task** — on Claude, the Bash tool's
`run_in_background` — never with a trailing `&`: the host then tracks the
task and notifies you when the runner exits (ADR-0063 D5; a shell `&` would
detach the runner where neither you nor an autopilot host can wait for it).

<!-- pipeline:begin compose-dispatch -->
The prompt reaches the runner as a file the block never builds: it carries the
artifact and the peer's instructions, and in shell source a quote, `$`,
backtick or line of them would be read as code (ADR-0059, amendment of
2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `prompt.xml` in that
   directory holding the prompt (where this runbook has a privacy gate above,
   it must have passed, and the prompt carries only genericized text).
   Nothing deletes it.

Then run the block with `TEXT_DIR` set to that directory; a prompt left
unwritten stops it before the dispatch.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ENSEMBLE_TYPE='plan-verify'
# The prompt the agent wrote with its file tool: the runner reads it, so no
# line of it is shell source. A prompt left unwritten stops the block here.
PROMPT_FILE="$TEXT_DIR/prompt.xml"
grep -q '[^[:space:]]' "$PROMPT_FILE" 2>/dev/null || { echo "✗ prompt.xml in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was dispatched." >&2; exit 1; }
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="${ENSEMBLE_TYPE}-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# Run this block as a host background task (on Claude, the Bash tool's
# run_in_background), never with a trailing `&`: the host tracks the runner
# and notifies you when it exits, where a shell `&` would detach it from both.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase 'compose' \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
```
<!-- pipeline:end compose-dispatch -->

The four bookkeeping flags (`--workflow-path`, `--phase`,
`--ensemble-type`, `--run-id`) cause `peer-runner.mjs run` to record a
`pending_ensemble` entry under the workflow file's per-file lock BEFORE
spawning the companion (ADR-0017 §sub-decision 4). The runner writes
raw peer output under the hidden peer-run ledger and emits a small JSON
result to `$PROMPT_FILE.run.json` with `envelope_path`, `stdout_path`,
`stderr_path`, and `handle_path`. After synthesis, Phase 2 settles the
attempt with `peer-runner.mjs settle` and the same run id: it reads the
run ledger and, for a completed run, atomically pops the pending entry,
appends the synthesis verdict to `ensemble_results` and prunes to the
retention cap; a run that failed records verdict `failed` (ADR-0066 D2).

Independence exception (per ensemble-protocol.md § Independence
Rule): the peer DOES receive the orchestrator's draft plan as input
for this point type — its job is to find gaps in that specific plan.

Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT
categories. Gaps and ordering issues from the peer go directly into
the artifact's revision.

---

## Phase 2 — State finalize

<!-- pipeline:begin compose-finalize -->
The phase note this step records — fill in every `<…>`. When no run launched
(the verb ran local-only, so no dispatch ran; a run whose
companion is missing did launch, and settles `failed`), its first heading reads
`### Ensemble skipped: compose (local-only)` instead, and the synthesis
is local-only:

```markdown
### Ensemble launched: compose at <iso-utc>

### Ensemble synthesis: compose (profile=<profile>) verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Artifact

<plan: TDD task list, dependencies, success criteria
 OR code: list of changed files with one-line summary each>

### Active next-action proposal

(per `core/skills/_shared/references/entry-routing-contract.md` § Active Next-Action Proposal — derived from this artifact, not a fixed table)
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; /engineer:commit for commit or done; the owner-decision action otherwise>
```

The note, and the two texts the block records with it, reach the scripts as
files, never in the block: in shell source a quote, `$`, backtick or line of
them would be read as code (ADR-0059, amendment of 2026-10-10). Before the
block:

1. Create a private directory for them, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create in that directory
   `note.md`, the phase note above filled in; `summary.txt`, a one-line
   résumé of its breakdown; and `next-action.txt`, the next action the
   `append` and the last write record: the compact form of the proposal
   (selected_next + one-line why + next_command). The typical-case default
   is

   ```text
   Critique the composed artifact
   ```

   Write another when the verb's result selects a different next step, and
   for an owner gate below `Owner: ` and the judgment in a few words. Each
   file holds its text as written and ends with one newline, which the
   scripts remove; nothing deletes the files.

Then run the block with `TEXT_DIR` set to that directory, `RUN_ID` to the run
id the dispatch generated (empty when no run launched), and `VERDICT` to the
synthesis's verdict. A file left unwritten, blank, or not UTF-8 text stops the
block before any write.

`peer-runner.mjs settle` decides from the run ledger what the workflow
records, not from these values alone: a run that never launched records
nothing; a run that launched and failed, was cancelled or was abandoned
records verdict `failed` with the ledger's `error_kind`; a run that completed
records the synthesis verdict, or `degraded` when its answer was empty or
unreadable. An answer that parses to nothing usable, only structural
shell, reads to `settle` like any other, so set `VERDICT` to `degraded` then.
It refuses, and the block stops before the last write, while a run is still
live (collect it first) or when an empty `RUN_ID` would hide a run that
launched (set it to that run's id).

The last write, `finish-verb`, records the proposal's next step in closed-enum
form: `--next-step-kind` `verb` (with `--next-step-verb`), `commit`
(`/engineer:commit` commits the change, or closes the workflow when there is
none) or `done`, each closing the workflow `summary-complete`.
Under an autopilot run it records the next step only and leaves the terminal
marker for `/engineer:commit`, the only command that closes a workflow
there (`core/skills/_shared/references/autopilot-mode.md`).
End instead with an owner gate when the owner must judge, with the judgment
under the gate's heading in the note:

- `scope-routing` (heading `### Routing recommendation`, anchor
  `routing-recommendation`): the request does not belong in this verb or
  workflow; the owner picks the route, then clears the gate.
- `pr-handling` (heading `### Outward action needed`, anchor `pr-handling`):
  under an autopilot run, the task itself needs a push, a pull request or
  another outward action; interactively the user acts instead.

The owner-decision form below records the gate with the next step in one
write and leaves the workflow open, not terminal, until the owner resolves it.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# The run ledger lives under the repository root, where the dispatch put it.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# The texts the agent wrote with its file tool (ADR-0059, amendment of
# 2026-10-10): each script reads its file itself, so no line of the note is
# shell source. settle reads the summary only after the append has written,
# so each file is first held to every reader's rule: strict UTF-8, no NUL
# byte, and text left once blanks are trimmed (settle's rule). A file a
# script would refuse stops the block before any write.
for TEXT_FILE in note.md summary.txt next-action.txt; do
  node -e 'let t;try{t=new TextDecoder("utf-8",{fatal:true}).decode(require("fs").readFileSync(process.argv[1]))}catch{process.exit(1)}process.exit(t.includes("\0")||t.trim()===""?1:0)' "$TEXT_DIR/$TEXT_FILE" || { echo "✗ $TEXT_FILE in TEXT_DIR ($TEXT_DIR) is missing, blank or not UTF-8 text; write it with the file tool first. Nothing was written." >&2; exit 1; }
done

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label 'Phase 1: Compose (synthesized)' \
  --phase-note-file "$TEXT_DIR/note.md" \
  --current-phase phase-2-presented \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --event updated || exit $?

# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,
# launched and failed, completed); a refusal stops the block before the last
# write, so the workflow never closes with an attempt left unsettled.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \
  --repo-root "$REPO_ROOT" --workflow-path "$ACTIVE" \
  --host "${AGENTIC_HOST:-claude}" --phase 'compose' --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" || exit $?

# ADR-0029 §1 / completion-output contract §2 — set --next-action (the
# append above and this terminal write) to the COMPACT form of the
# proposal above (selected_next + one-line why + next_command) so the
# durable state and the code-emitted completion footer agree with the
# Active Next-Action Proposal. The value shown is the typical-case
# default; override it, and the --next-step-* flags, when the verb's result
# selects a different next step (e.g. commit).
# ADR-0063 D3 — finish-verb is the verb's last write: the ADR-0017
# §sub-decision 5 atomic terminal write (summary-complete + terminal marker)
# with the next step, interactively. Under an autopilot run (ADR-0066
# Decision 3: AGENTIC_AUTOPILOT names a run, on Claude) it writes the next step
# only and leaves the terminal marker for the commit command, which alone
# closes a workflow there.
# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
# archive gates are evaluated at the end of THIS turn, not at session close;
# if a gate fails the workflow stays marked and a later Stop re-evaluates it.
# Clearing the marker with `--terminal-marker false` works only before that
# Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
# --terminal-phase), and does not restore the previous phase or next_action.
# On Codex the Stop hook runs only once the operator has trusted the plugin
# hooks (`/hooks`), so evaluation waits for that. Full contract:
# core/skills/_shared/references/session-handoff.md § Archive timing.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --next-step-kind verb --next-step-verb 'critique' \
  --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
# The owner-decision form, for an owner gate named above this block: it
# records the gate with the next step in one write, and the workflow stays
# open until the owner resolves the gate.
# node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
#   --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
#   --next-action-file "$TEXT_DIR/next-action.txt" \
#   --next-step-kind owner-decision --next-step-confidence "<HIGH|MEDIUM|LOW>" \
#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' || exit $?
```
<!-- pipeline:end compose-finalize -->

---

## Autopilot mode (ADR-0063, Claude only)

When Phase 0's preflight printed the autopilot banner, this command follows
`${CLAUDE_PLUGIN_ROOT}/core/skills/_shared/references/autopilot-mode.md`
(the preflight prints nothing interactively, and none of this applies then):

- **Ceremony gates auto-pass.** No presentation-mode prompt (present in
  batch); proceed with the recommended option instead of asking
  "Recommended: X. Proceed?".
- **Never run `git commit`.** Set `--next-step-kind commit` when the artifact
  is ready; `/engineer:commit` commits it. (The driver also denies `git
  commit` on this step.)
- **The last write is Phase 2's `finish-verb`**, which records the next step
  and leaves the terminal marker unset: under autopilot only
  `/engineer:commit` closes a workflow, and `set-terminal --terminal-marker
  true` is refused.
- **Owner judgments.** Stop with the gate that names the judgment and do not
  decide it yourself: `scope-routing` when the request does not belong in this
  verb or workflow (recorded in either mode), `pr-handling` when the task
  itself needs a push, a pull request or another outward action (autopilot
  only; interactively the user acts). Record the gate with Phase 2's
  `finish-verb --next-step-kind owner-decision --owner-gate <gate>
  --owner-gate-anchor <anchor>` after a phase note under the heading the gate
  table names (`autopilot-mode.md` § Owner gates).
- **Peers.** Collect the ensemble as `ensemble-protocol.md` § Step 2 says:
  wait for the background notification; never sleep-poll. A step report
  taken while you wait is provisional: when the notification re-invokes you,
  finish the verb through `finish-verb`, then report again
  (`autopilot-mode.md` § Peer ensembles).

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If executing this verb surfaces a **genuine 2+-branch decision point**
— two viable implementation designs, or two artifact structures, or a
non-neutral `selected_next` with 2+ candidates in the proposal below —
surface a **compact multi-axis lens** comparing the branches across the
resolved decisive axes (본질/근본 essence/foundation) + supporting axes,
instead of a flat list. Resolve the sized axis set from the shared
`${CLAUDE_PLUGIN_ROOT}/scripts/decide-registry.mjs resolve --size=<minor|standard|major>`
resolver — the single axis source of truth, not a hand-authored list —
per `core/skills/_shared/references/entry-routing-contract.md`
§ "Surfacing the multi-axis lens from a non-decide verb".

Bounded: only at a genuine 2+-branch point (not every invocation),
default `--size=minor` (compact 4-axis), escalating only for weightier
branches — never the full 9-axis matrix for a trivial reversible step.
The full mechanism + the Codex path-resolution fallback live in
the contract subsection cited above.

---

## Completion

Output the artifact (plan or change set) and one of:

- `✓ Plan complete.` + path/anchor to the artifact.
- `✓ Code change complete.` + summary of edited files.
- `✓ Compose paused (gaps surfaced).` — when peer flagged
  significant gaps or ordering issues that warrant user input
  before proceeding.

Then emit the **Active Next-Action Proposal** the phase note above carries
(per `core/skills/_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal), instead of a fixed next verb.

Typical `selected_next` candidates for compose:
`/engineer:critique` to review the artifact — or, for a completed `plan`
profile, `/engineer:compose --profile=code` to implement it; the routing
table is the fallback only when evidence is genuinely neutral — do not end
with a hardcoded "next: X". When `selected_next` is `engineer:decide`, also
name the decision size (`--size=minor|standard|major`) per the contract.

Always include the workflow path.

<!-- pipeline:begin compose-completion-footer -->
The runtime completion footer is **code-emitted** on this verb's terminal
path (ADR-0039): the terminal write (`state.mjs finish-verb`, which takes
`set-terminal`'s path) fires the ADR-0031 session-handoff sidecar, which
shells out to the runtime `footer.mjs` and prints the rendered footer —
context state, completion state
(`blocked`, with the commit as its unblocking action, when only the commit
remains) + state-derived next action,
workflow id/path, artifact pointers, recommended next work, and the
continue-vs-fresh session-handoff — on that command's **stderr**.
Do **not** hand-compose a second footer; surface the one the terminal
command already emitted. The footer is advisory + pointer-only and
fail-closed (a missing/too-old runtime emits nothing, and the SessionStart
backstop still re-surfaces the handoff); it never mutates host session
context. On a detached HEAD the branch-based preflight reports "no active
branch context" and never recommends a fresh session (ADR-0018 §sub-2); the
path-targeted terminal sidecar renders the footer as on a branch, its
continue-vs-fresh advice included.
Under an autopilot run `finish-verb` makes no terminal write, so no footer is
printed: the driver is the handoff.
Wiring details:
`core/skills/_shared/references/session-handoff.md`.
<!-- pipeline:end compose-completion-footer -->
