---
description: Compare 2+ approaches under constraints, recommend a direction with rationale — engineer's decision verb
argument-hint: "[--size=<minor|standard|major>] [--preset=<id>] [--weights=<spec>] [--] <decision question or list of options>"
---

# Engineer · Decide

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. The peer ensemble
runs automatically per
`core/skills/_shared/references/ensemble-protocol.md` (Brainstorm point
type) — never ask the user whether to invoke the peer. When the
companions plugin or peer CLI is unavailable, the ensemble degrades
silently to local-only.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ENGINEER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

<!-- pipeline:begin decide-phase-0 -->
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
<!-- pipeline:end decide-phase-0 -->

Empty `$ACTIVE` → bootstrap a new workflow with verb=decide:

<!-- pipeline:begin decide-bootstrap -->
In the block, replace `<the original request described above>` with a
one-line scrubbed user request; `AGENTIC_TOPIC` takes its place when it is set.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='decide'
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
elif [ -n "${AGENTIC_PARENT_WORKFLOW_PATH:-}" ]; then
  echo "✗ AGENTIC_PARENT_WORKFLOW_PATH is set without AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK (ADR-0067 Decision 3: the macro path is valid only with both ids). This usually indicates a dispatcher bug, or a variable left over from another session; unset it, or set all three." >&2
  exit 1
fi
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb 'decide' --host "${AGENTIC_HOST:-claude}" --persona 'engineer' \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --original-request "${AGENTIC_TOPIC:-<the original request described above>}" \
  --current-phase phase-0-bootstrap \
  --next-action "Run ${VERB} skill" \
  "${PARENT_ARGS[@]}")" || exit $?
```
<!-- pipeline:end decide-bootstrap -->

Non-empty `$ACTIVE` → append-on-resume:

<!-- pipeline:begin decide-resume -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='decide'
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb 'decide' \
  --phase-label "Phase 0: Resume into ${VERB}" \
  --phase-note "Resumed from prior verb." \
  --current-phase phase-0-resume \
  --clear-next-step true \
  --next-action "Run ${VERB} skill" --event resumed || exit $?
```
<!-- pipeline:end decide-resume -->

---

## Phase 0.5 — Resolve decision axes from the registry (ADR-0027 §5.6)

<!-- pipeline:begin decide-resolve -->
Parse the arguments into flags + body and resolve the preset from
`core/skills/decide/references/decision-axes.yml`. The block prints the
resulting `ResolvedDecisionContext` JSON on stdout, and the skill body reads
it from that output. Nothing is written to disk: the context stays in the
session for the duration of the command (ADR-0027 §4.3), and no later Bash
call has to find a file whose path lived only in an earlier call's shell.

The CLI reuses `scripts/lib/decide-args.mjs` internally so the same flag
grammar applies: unknown flags, invalid `--size=<tier>` values, or
malformed `--weights=<spec>` (non-numeric/negative/exponent weight,
uppercase or duplicate axis-id, empty spec, whitespace) produce a parser
error and exit 2 (we halt). `--preset=<id>` is passed through by the parser
(not shape-validated there) and semantically resolved by the registry per
ADR-0027 §1.6 graceful-degradation — an unknown preset id triggers
`context.registry_fallback = true` + fall-back to the
`default` preset with a diagnostic (no halt), while an empty one
counts as no `--preset` at all. The body — everything after the flags, byte
for byte — is threaded into `context.body`.

The arguments above reach the resolver through an args file, never
through the shell (ADR-0059): typed text spliced into a command line is cut
at `;`, expanded at `$(…)` and redirected at `>`, and the damage can exit
zero. Before the block below:

1. Create a private directory for the file, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `args.json` in that
   directory holding `{"agentic_args": 1, "text": "…"}`, with `text` set to
   the arguments above exactly as typed, as a JSON string (`""` when there
   are none).

Then run the block with `ARGS_DIR` set to that directory. The resolver reads
leading `--key=value` flags and takes the rest, byte for byte, as the
decision body — a lone `--` ends the flags, and nothing in the body is
quoted, expanded or split. The command removes the args file and its
directory once it has read them.

```bash
ARGS_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# stdout: the ResolvedDecisionContext JSON. stderr: the resolver's warnings
# and diagnostics, shown as they are written.
node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve --args-file "$ARGS_DIR/args.json"
RESOLVE_RC=$?

if [ "$RESOLVE_RC" -eq 2 ]; then
  echo "✗ decide-registry rejected the argument list — fix the invocation and rerun." >&2
  exit 1
elif [ "$RESOLVE_RC" -ne 0 ]; then
  echo "✗ decide-registry failed with exit $RESOLVE_RC; see diagnostics above." >&2
  exit 1
fi
```
<!-- pipeline:end decide-resolve -->

The skill body reads the `ResolvedDecisionContext` Phase 0.5 printed to obtain:

- `axes[]` — ordered axis descriptors (id, en/ko labels, question, role) for the resolved preset
- `preset_id` — the active preset id (default | nine-axis | compact | …)
- `size` / `size_explicit` — the resolved ritual tier (minor | standard | major)
  populated from `--size=<tier>` per ADR-0027 §1.5(2). When `--size` was not
  passed, `size` defaults to `"standard"` and `size_explicit` is `false`. The
  ritual mapping (per-option output depth, comparison-table density,
  recommendation rigor) is documented in `core/skills/decide/SKILL.md` inside the
  five `@decide:*` marker regions (PR4 added `@decide:weighting-sensitivity-output`).
- `weights` — `Record<string, number>` populated from `--weights=<spec>`.
  Empty `{}` is the sentinel for "no `--weights` flag" (treated as
  uniform 1.0 by downstream normalization). When `--weights=…` was passed,
  the map carries the normalized per-axis weights (missing axes filled to
  1.0, unknown axis-ids dropped with diagnostic).
- `weights_explicit` — boolean. `true` iff the user passed `--weights=<spec>`.
  This is the LLM-observable explicit-presence signal (ADR-0027 §5.6 PR4
  amendment) — SKILL.md surfaces gate weighting/sensitivity rendering on
  this field directly rather than inferring from `Object.keys(weights).length`,
  avoiding the object-identity trap peer G3 warded off. At the JS parser
  layer the same signal is also surfaced as a top-level `weightsExplicit`
  field on the parser result (not under `flags`).

If the file is missing or the JSON is unparseable, fall back to the
in-code default preset (5-axis essence + foundation + standards +
best-practice + practical-fit) — the registry is a graceful-degradation
artifact per ADR-0027 §1.6.

---

## Phase 1 — Execute decide

Follow the decide skill's command-invoked mode at
`${CLAUDE_PLUGIN_ROOT}/core/skills/decide/SKILL.md`. The skill performs
2+ option generation, evidence-based comparison across **the axes
resolved in Phase 0.5** (tradeoffs, risks,
scope, fit-with-frame), and recommends a direction with explicit
rationale. The user makes the final call.

Decide is single-mode (no `--profile` argument). Sub-discipline
context flows through the orchestrator-level Task Profile.

### Ensemble dispatch (Brainstorm point type)

Build the Brainstorm prompt per
`core/skills/_shared/references/ensemble-protocol.md` § Brainstorm, write it
to the block's `$PROMPT_FILE`, and dispatch in the background.

ADR-0027 §4 axis-awareness contract — the prompt-builder MUST read the
ResolvedDecisionContext JSON Phase 0.5 printed and decide whether to emit the
`<axis_awareness>` block:

- When `context.registry_fallback === false` AND this dispatch runs in
  command mode (always true on this code path; auto-activated mode never
  reaches a peer-runner dispatch per SKILL.md "## When auto-activated" → "no
  peer ensemble dispatch"), emit the `<axis_awareness>` block populated from
  `context.{preset_id, size, axes, weights, weights_explicit}` per ADR-0027
  §4.2. The `Weights:` line uses `uniform` when `context.weights_explicit ===
  false` (PR4 empty-sentinel signal — avoids the `weights !== {}`
  object-identity trap peer G3 warded off at the JS-API layer) and renders
  explicit weights in document order otherwise.
- When `context.registry_fallback === true` (a §1.6 fallback fired — missing
  file, malformed YAML, unknown preset id, etc.), OMIT the `<axis_awareness>`
  block entirely. The peer falls back to free-form 2-3 approaches per the
  ensemble-protocol.md §Failure Handling rule. Do NOT emit a fallback-filled
  `<axis_awareness>` block (ADR-0027 §4 alternative 1 rejection —
  fallback-default-axes confuse the peer when the user's actual registry was
  broken).
- When the Phase 0.5 output is missing or unparseable (the Phase 0.5
  graceful-degradation path per ADR-0027 §1.6 cascade — the skill body itself
  falls back to the in-code default preset per the Phase 0.5 prose above),
  proceed with the free-form prompt (axis_awareness omitted) and surface a
  one-line diagnostic in the workflow phase note. This is the E1 edge case
  called out by Codex Plan-verify.

This Phase 1 surface is the single emit site for the axis_awareness block on
the Claude side; Codex's SKILL.md path delegates wholly to
ensemble-protocol.md § Brainstorm. Updates to the axis_awareness contract land
in both `ensemble-protocol.md` § Brainstorm and this paragraph in lockstep per
ADR-0027 §4.5.

Run this block **as a host background task** — on Claude, the Bash tool's
`run_in_background` — never with a trailing `&`: the host then tracks the
task and notifies you when the runner exits (ADR-0063 D5; a shell `&` would
detach the runner where neither you nor an autopilot host can wait for it).

<!-- pipeline:begin decide-dispatch -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ENSEMBLE_TYPE='brainstorm'
PROMPT_FILE="$(mktemp -t 'engineer'-'decide'-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="${ENSEMBLE_TYPE}-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the prompt to $PROMPT_FILE (where this runbook has a privacy
#     gate above, it must have passed, and the prompt carries only genericized
#     text) ...
# Run this block as a host background task (on Claude, the Bash tool's
# run_in_background), never with a trailing `&`: the host tracks the runner
# and notifies you when it exits, where a shell `&` would detach it from both.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase 'decide' \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
```
<!-- pipeline:end decide-dispatch -->

The peer-runner records the matching `pending_ensemble` row before
spawning the companion and writes raw peer output under the hidden
peer-run ledger; the background command's stdout is the small runner
JSON result (`envelope_path`, `stdout_path`, `stderr_path`,
`handle_path`). Synthesize: merge orchestrator + peer option sets.
PEER-ONLY approaches → add. AGREED → elevate confidence. CONFLICT →
present both with evidence and ask the user.

---

## Phase 2 — State finalize

<!-- pipeline:begin decide-finalize -->
The phase note this step records — fill in every `<…>`. When no run launched
(the verb ran local-only, so no dispatch ran; a run whose
companion is missing did launch, and settles `failed`), its first heading reads
`### Ensemble skipped: decide (local-only)` instead, and the synthesis
is local-only:

```markdown
### Ensemble launched: decide at <iso-utc>

### Ensemble synthesis: decide verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Options compared

<table or list of options with tradeoffs>

### Recommendation

<chosen direction + rationale + risks>

### Active next-action proposal

(per `core/skills/_shared/references/entry-routing-contract.md` § Active Next-Action Proposal — derived from this artifact, not a fixed table)
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; /engineer:commit for commit or done; the owner-decision action otherwise>
```

Then run the block with the filled-in note in place of its placeholder line,
between the two `PHASE_NOTE` lines. The quoted heredoc hands the note to
`state.mjs` as written: no quote, `$`, backtick or backslash in it is read by
the shell. The first line that reads `PHASE_NOTE` alone ends the note, and
the shell runs every line after it as a command, so when the note itself holds
such a line, replace both `PHASE_NOTE` delimiters with a word no line of the
note consists of.

Set `RUN_ID` to the run id the dispatch generated, empty when no run launched,
and `VERDICT` and `SUMMARY` to the synthesis's verdict and a one-line résumé
of its breakdown. `peer-runner.mjs settle` decides from the run ledger what the
workflow records, not from these values alone: a run that never launched
records nothing; a run that launched and failed, was cancelled or was
abandoned records verdict `failed` with the ledger's `error_kind`; a run that
completed records the synthesis verdict, or `degraded` when its answer was
empty or unreadable. An answer that parses to nothing usable, only structural
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

- `decide-conflict` (the `Ensemble synthesis` heading, anchor
  `ensemble-synthesis`): the decision is left to the owner's selection, a
  CONFLICT remained or a veto gate is unresolved; § Owner selection below
  resolves it.
- `scope-routing` (heading `### Routing recommendation`, anchor
  `routing-recommendation`): the request does not belong in this verb or
  workflow; the owner picks the route, then clears the gate.
- `pr-handling` (heading `### Outward action needed`, anchor `pr-handling`):
  under an autopilot run, the task itself needs a push, a pull request or
  another outward action; interactively the user acts instead.

The owner-decision form below records the gate with the next step in one
write and leaves the workflow open, not terminal, until the owner resolves it.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# The run ledger lives under the repository root, where the dispatch put it.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# Where read takes no -d (dash) it assigns nothing, so clear NOTE first: a
# value the shell inherited must not stand in for the note.
unset NOTE
IFS= read -r -d '' NOTE <<'PHASE_NOTE' || true
<the phase note above, filled in>
PHASE_NOTE
# A shell whose read has no -d (dash) reads nothing: stop before any write.
[ -n "$NOTE" ] || { echo "✗ No phase note was read; nothing was written." >&2; exit 1; }

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label 'Phase 1: Decide (synthesized)' \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action 'Compose the artifact for the chosen direction' \
  --event updated || exit $?

# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,
# launched and failed, completed); a refusal stops the block before the last
# write, so the workflow never closes with an attempt left unsettled.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \
  --repo-root "$REPO_ROOT" --workflow-path "$ACTIVE" \
  --host "${AGENTIC_HOST:-claude}" --phase 'decide' --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" || exit $?

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
  --next-action 'Compose the artifact for the chosen direction' \
  --next-step-kind verb --next-step-verb 'compose' \
  --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
# The owner-decision form, for an owner gate named above this block: it
# records the gate with the next step in one write, and the workflow stays
# open until the owner resolves the gate.
# node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
#   --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
#   --next-action '<Owner: the judgment, in a few words>' \
#   --next-step-kind owner-decision --next-step-confidence "<HIGH|MEDIUM|LOW>" \
#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' || exit $?
```
<!-- pipeline:end decide-finalize -->

---

## Autopilot mode (ADR-0063, Claude only)

When Phase 0's preflight printed the autopilot banner, this command follows
`${CLAUDE_PLUGIN_ROOT}/core/skills/_shared/references/autopilot-mode.md`
(the preflight prints nothing interactively, and none of this applies then):

- **Ceremony gates auto-pass.** No presentation-mode prompt (present in
  batch); proceed with the recommended option instead of asking
  "Recommended: X. Proceed?".
- **A CONFLICT is the owner's.** When the synthesis verdict is `conflict`, do
  not pick a side: end with Phase 2's owner-decision form of `finish-verb`,
  which records the `decide-conflict` gate (anchor `ensemble-synthesis`) with
  the next step (it does so interactively too; there the user selects at once,
  through the Owner selection step).
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

<!-- pipeline:begin decide-owner-selection -->
## Owner selection (decide-conflict)

The `decide-conflict` gate is resolved by the owner's selection (ADR-0063
Q2), in either of two ways:

- **In this session**, right after `✓ Decision pending user input`: the user
  picks one of the directions just shown.
- **Later**, when Phase 0's preflight reports a pending `decide-conflict` gate
  (an autopilot run, or an earlier session, stopped on it): present the
  directions recorded at the gate's pointer, the latest `Ensemble synthesis:
  decide verdict=conflict` note, and ask the user to choose instead of running
  a new comparison. If they want a fresh comparison, clear the gate first and
  run the phases above as usual.

Once they choose, write the resolution in place of its placeholder line
(between the two `OWNER_RESOLUTION` lines; a line reading `OWNER_RESOLUTION`
alone would end it) and run the block. Inside a `/engineer:start` lifecycle the
block clears the gate and stops there: resume the lifecycle, which continues at
its own phase after decide and makes its one terminal write; elsewhere it ends
the verb:

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# A gate met inside a /start lifecycle is resolved there: the lifecycle makes
# the one terminal write. A failed read, or a type that cannot be parsed, stops
# the block (the read is checked on its own: a pipe reports its last command).
WF_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE")" \
  || { echo "✗ Could not read the workflow type; nothing was written." >&2; exit 1; }
WF_TYPE="$(printf '%s' "$WF_JSON" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).workflow_type||"verb-chain")}catch{process.exit(1)}})')" \
  || { echo "✗ Could not read the workflow type; nothing was written." >&2; exit 1; }
# The owner's resolution, from a quoted heredoc: no quote, $, backtick or
# backslash in it is read by the shell. An empty read stops the block.
unset RESOLUTION
IFS= read -r -d '' RESOLUTION <<'OWNER_RESOLUTION' || true
<Owner selection: the direction the owner chose, and why>
OWNER_RESOLUTION
[ -n "$RESOLUTION" ] || { echo "✗ No resolution was read; nothing was written." >&2; exit 1; }
# Inside a /start lifecycle the lifecycle owns its phase order, so the clear
# records no next step (the lifecycle's resume clears one anyway) and names the
# resume as the next action; elsewhere the next step is compose. Either way the
# gate's "Owner: …" next action does not outlive the clear.
if [ "$WF_TYPE" = start ]; then
  NEXT_ACTION="Resume /${PERSONA}:start: the lifecycle continues after decide with the selected direction"
  NEXT_STEP=(--clear-next-step true)
else
  NEXT_ACTION='Compose the artifact for the chosen direction'
  NEXT_STEP=(--next-step-kind verb --next-step-verb compose --next-step-confidence HIGH)
fi
# One write records the owner's decision, clears the gate and names the next
# step, so the next step never becomes runnable without the decision behind
# it; the block stops if it fails.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate decide-conflict \
  --resolution "$RESOLUTION" --next-action "$NEXT_ACTION" \
  "${NEXT_STEP[@]}" || exit $?
if [ "$WF_TYPE" = start ]; then
  echo "→ Gate cleared. Resume the lifecycle with /${PERSONA}:start (\$${PERSONA}:start on Codex); it continues at its phase after decide." >&2
  exit 0
fi
# ARCHIVE TIMING — this finish-verb is a terminal write: on Claude the Stop
# hook fires at EVERY turn end, so the archive gates are evaluated at the end
# of THIS turn (they pass once HEAD has moved). Clearing the marker with
# `--terminal-marker false` works only before that Stop fires and needs
# set-terminal's full flag set. On Codex the Stop hook runs only once the
# operator has trusted the plugin hooks (`/hooks`). Full contract:
# core/skills/_shared/references/session-handoff.md § Archive timing.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --next-action 'Compose the artifact for the chosen direction' \
  --next-step-kind verb --next-step-verb compose \
  --next-step-confidence HIGH || exit $?
```

`awaiting-owner-clear` records `### Owner gate resolved: decide-conflict at
<iso>` with the pointer it cleared and the resolution, and replaces the gate's
next action. It refuses, writing nothing,
when the gate set on the workflow is not `decide-conflict`.
It refuses under an autopilot run too: only the owner resolves an owner gate.
<!-- pipeline:end decide-owner-selection -->

---

## Completion

Output the comparison and one of:

- `✓ Decision recommended.` + chosen direction.
- `✓ Decision pending user input.` — when CONFLICT remained in the
  recommendation. Surface both options with evidence; pause until
  the user selects. Phase 2's owner-decision form has recorded the
  `decide-conflict` gate, so record the selection with the Owner selection
  step above.

Then emit the **Active Next-Action Proposal** the phase note above carries
(per `core/skills/_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal), instead of a fixed next verb.

Typical `selected_next` candidates for decide:
`/engineer:compose` to produce the artifact for the chosen direction —
or `/engineer:investigate` if a decisive evidence gap surfaced, or
`/engineer:frame` if deciding reframed the problem; the routing table is
the fallback only when evidence is genuinely neutral — do not end with a
hardcoded "next: X". When `selected_next` is `engineer:decide`, also name
the decision size (`--size=minor|standard|major`) per the contract.

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```

<!-- pipeline:begin decide-completion-footer -->
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
<!-- pipeline:end decide-completion-footer -->
