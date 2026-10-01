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

Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ENGINEER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep that opening line when you run a block: a
shell variable does not outlive a Bash call.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — engineer workflows are anchored to a branch;
# detached HEAD has no branch context to anchor to.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — engineer workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
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

- Empty → bootstrap with verb=decide:

  ```bash
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
  # ADR-0019 §1+§3 — when /orchestrator:next dispatches this command,
  # it sets AGENTIC_PARENT_WORKFLOW + AGENTIC_ORIGINATING_SUBTASK so
  # the create-time bootstrap records the immutable parent linkage.
  # Both must be set together (or both absent for direct invocation).
  PARENT_ARGS=()
  if [ -n "${AGENTIC_PARENT_WORKFLOW:-}" ] || [ -n "${AGENTIC_ORIGINATING_SUBTASK:-}" ]; then
    if [ -z "${AGENTIC_PARENT_WORKFLOW:-}" ] || [ -z "${AGENTIC_ORIGINATING_SUBTASK:-}" ]; then
      echo "✗ AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK must be set together (ADR-0019 §3 immutable parent-child linkage). This usually indicates a dispatcher bug — /orchestrator:next must export both env vars or neither. If you set them manually, set both or neither." >&2
      exit 1
    fi
    PARENT_ARGS=(--parent-workflow "$AGENTIC_PARENT_WORKFLOW" --originating-subtask "$AGENTIC_ORIGINATING_SUBTASK")
  fi
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb decide --host "${AGENTIC_HOST:-claude}" --persona engineer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "${AGENTIC_TOPIC:-<one-line scrubbed user request>}" \
    --current-phase phase-0-bootstrap \
    --next-action "Run decide skill" \
    "${PARENT_ARGS[@]}")"
  ```

- Non-empty → append-on-resume:

  ```bash
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb decide \
    --phase-label "Phase 0: Resume into decide" \
    --phase-note "Resumed from prior verb." \
    --current-phase phase-0-resume \
    --clear-next-step true \
    --next-action "Run decide skill" --event resumed || exit $?
  ```

---

## Phase 0.5 — Resolve decision axes from the registry (ADR-0027 §5.6)

Parse the arguments into flags + body and resolve the preset from
`core/skills/decide/references/decision-axes.yml`. The block prints the
resulting `ResolvedDecisionContext` JSON on stdout, and the skill body reads
it from that output. Nothing is written to disk: the context stays in the
session for the duration of the command (ADR-0027 §4.3), and no later Bash
call has to find a file whose path lived only in an earlier call's shell.

The CLI reuses `scripts/lib/decide-args.mjs` internally so the same
§2.3 flag grammar applies: unknown flags, invalid `--size=<tier>`
values, or malformed `--weights=<spec>` (non-numeric weight, negative
weight, exponent notation, uppercase axis-id, duplicate axis-id, empty
spec, whitespace) produce a parser error and exit 2 (we halt).
`--preset=<id>` is shape-validated by the parser but semantically
resolved by the registry per ADR-0027 §1.6 graceful-degradation —
an unknown preset id triggers `context.registry_fallback = true` +
fall-back to the `default` preset (no halt, peer dispatch still
proceeds with `<axis_awareness>` omitted per §4.3). The body —
everything after the flags, byte for byte — is threaded into
`context.body` per §5.6.

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
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# stdout: the ResolvedDecisionContext JSON. stderr: the resolver's warnings
# and diagnostics, shown as they are written.
node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve --args-file "$ARGS_DIR/args.json"
RESOLVE_RC=$?

if [ "$RESOLVE_RC" -eq 2 ]; then
  # Parser error per §2.3(3-4) — halt before the skill body runs so
  # the user can fix the invocation. The diagnostic lines above
  # already identified the offending flag.
  echo "✗ decide-registry rejected the argument list — fix the invocation and rerun." >&2
  exit 1
elif [ "$RESOLVE_RC" -ne 0 ]; then
  echo "✗ decide-registry failed with exit $RESOLVE_RC; see diagnostics above." >&2
  exit 1
fi
```

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
`core/skills/_shared/references/ensemble-protocol.md` § Brainstorm and
dispatch in background:

Run this block **as a host background task** — on Claude, the Bash tool's
`run_in_background` — never with a trailing `&`: the host then tracks the
task and notifies you when the runner exits (ADR-0063 D5; a shell `&` would
detach the runner where neither you nor an autopilot host can wait for it).

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PROMPT_FILE="$(mktemp -t engineer-decide-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="brainstorm-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"

# LLM-authored Brainstorm prompt — write to $PROMPT_FILE per the
# template at core/skills/_shared/references/ensemble-protocol.md § Brainstorm.
#
# ADR-0027 §4 axis-awareness contract — the prompt-builder MUST read
# the ResolvedDecisionContext JSON Phase 0.5 printed and decide whether to
# emit the `<axis_awareness>` block:
#
#   - When `context.registry_fallback === false` AND this dispatch runs
#     in command mode (always true on this code path; auto-activated
#     mode never reaches a peer-runner dispatch per SKILL.md
#     "## When auto-activated" → "no peer ensemble dispatch"),
#     emit the `<axis_awareness>` block populated from
#     `context.{preset_id, size, axes, weights, weights_explicit}` per
#     ADR-0027 §4.2. The `Weights:` line uses `uniform` when
#     `context.weights_explicit === false` (PR4 empty-sentinel signal —
#     avoids the `weights !== {}` object-identity trap peer G3 warded
#     off at the JS-API layer) and renders explicit weights in document
#     order otherwise.
#
#   - When `context.registry_fallback === true` (a §1.6 fallback fired —
#     missing file, malformed YAML, unknown preset id, etc.), OMIT the
#     `<axis_awareness>` block entirely. The peer falls back to free-form
#     2-3 approaches per the ensemble-protocol.md §Failure Handling rule.
#     Do NOT emit a fallback-filled `<axis_awareness>` block (ADR-0027 §4
#     alternative 1 rejection — fallback-default-axes confuse the peer
#     when the user's actual registry was broken).
#
#   - When the Phase 0.5 output is missing or unparseable (the
#     Phase 0.5 graceful-degradation path per ADR-0027 §1.6 cascade —
#     the skill body itself falls back to the in-code default preset
#     per commands/decide.md Phase 0.5 prose), proceed with the
#     free-form prompt (axis_awareness omitted) and surface a one-line
#     diagnostic in the workflow phase note. This is the E1 edge case
#     called out by Codex Plan-verify.
#
# This `commands/decide.md` Phase 1 surface is the single emit site for
# the axis_awareness block on the Claude side; Codex's SKILL.md path
# delegates wholly to ensemble-protocol.md § Brainstorm. Updates to the
# axis_awareness contract land in both `ensemble-protocol.md` § Brainstorm
# and this comment in lockstep per ADR-0027 §4.5.

node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase decide \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type brainstorm --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
```

The peer-runner records the matching `pending_ensemble` row before
spawning the companion and writes raw peer output under the hidden
peer-run ledger; the background command's stdout is the small runner
JSON result (`envelope_path`, `stdout_path`, `stderr_path`,
`handle_path`). Synthesize: merge orchestrator + peer option sets.
PEER-ONLY approaches → add. AGREED → elevate confidence. CONFLICT →
present both with evidence and ask the user.

---

## Phase 2 — State finalize

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
NOTE="### Ensemble launched: decide at <iso-utc>

### Ensemble synthesis: decide verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Options compared

<table or list of options with tradeoffs>

### Recommendation

<chosen direction + rationale + risks>

### Active next-action proposal

(per core/skills/_shared/references/entry-routing-contract.md
 § Active Next-Action Proposal — derived from this decision, not a fixed table)
- selected_next:         <verb | commit | owner decision | done>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or \$engineer:<verb> for a verb; /engineer:commit for commit or done; the owner-decision action otherwise>
"

# ADR-0029 §1 — set --next-action (both writes below) to the compact form
# of the proposal above (selected_next + one-line why + next_command) so the
# durable state and the state-derived completion footer agree with the Active
# Next-Action Proposal. The value shown is the typical-case default; override
# it when the verb's result selects a different next step (e.g. commit).
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Decide (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Compose the artifact for the chosen direction" \
  --event updated || exit $?

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase decide --ensemble-type brainstorm --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || exit $?

# ADR-0063 D3 — the verb's last write, `finish-verb`. Interactive: the
# ADR-0017 §sub-decision 5 atomic terminal write — current_phase
# summary-complete (in the auto-archive whitelist) + terminal_marker=true, so
# the Stop hook can archive once HEAD has moved — plus the next step. Under an
# autopilot run: the next step only; the terminal marker is left for
# /engineer:commit. The --next-step-* flags are the closed-enum form of the
# proposal's selected_next and confidence
# (core/skills/_shared/references/autopilot-mode.md § next_step): kind
# verb|commit|owner-decision|done, and --next-step-verb only with kind verb.
# The values shown are the typical case; set them from the proposal above.
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
  --next-action "Compose the artifact for the chosen direction" \
  --next-step-kind verb --next-step-verb compose \
  --next-step-confidence "<HIGH|MEDIUM|LOW>"
# When the synthesis verdict is conflict, end instead with the owner's
# decision (ADR-0063 D4, D6). This records the decide-conflict gate with the
# next step in one write, in either mode, and leaves the workflow open (not
# terminal) until the owner selects — the Owner selection step below. The
# confidence is the synthesis's, as for any proposal:
# node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
#   --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
#   --next-action "Owner: select a direction (decide conflict)" \
#   --next-step-kind owner-decision --next-step-confidence "<HIGH|MEDIUM|LOW>" \
#   --owner-gate decide-conflict --owner-gate-anchor ensemble-synthesis
```

---

## Autopilot mode (ADR-0063, Claude only)

When Phase 0's preflight printed the autopilot banner, this command follows
`${CLAUDE_PLUGIN_ROOT}/core/skills/_shared/references/autopilot-mode.md`
(the preflight prints nothing interactively, and none of this applies then):

- **Ceremony gates auto-pass.** No presentation-mode prompt (present in
  batch); proceed with the recommended option instead of asking
  "Recommended: X. Proceed?".
- **A CONFLICT is the owner's.** When the synthesis verdict is `conflict`, do
  not pick a side: end with the owner-decision variant of `finish-verb` shown
  in Phase 2, which records the `decide-conflict` gate with the next step (it
  does so interactively too; there the user selects at once, through the Owner
  selection step).
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
  wait for the background notification; never sleep-poll.

---

## Owner selection (decide-conflict)

The `decide-conflict` gate is resolved by the owner's selection (ADR-0063
Q2), in either of two ways:

- **In this session**, right after `✓ Decision pending user input`: the user
  picks one of the options just shown.
- **Later**, when Phase 0's preflight reports a pending `decide-conflict`
  gate (an autopilot run, or an earlier session, stopped on it): present the
  options recorded at the gate's pointer — the latest `Ensemble synthesis:
  decide verdict=conflict` note — and ask the user to choose, instead of
  running a new comparison. If they want a fresh comparison, clear the gate
  first and run the phases above as usual.

Once they choose:

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch." >&2; exit 1; }
# One write records the owner's decision, clears the gate and names the next
# step, so the next step never becomes runnable without the decision behind
# it; the block stops if it fails.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate decide-conflict \
  --resolution "Owner selection: <the direction the owner chose, and why>" \
  --next-step-kind verb --next-step-verb compose --next-step-confidence HIGH || exit $?
# ARCHIVE TIMING — this finish-verb is a terminal write interactively: on
# Claude the Stop hook fires at EVERY turn end, so the archive gates are
# evaluated at the end of THIS turn (they pass once HEAD has moved). Clearing
# the marker with `--terminal-marker false` works only before that Stop fires
# and needs set-terminal's full flag set. On Codex the Stop hook runs only
# once the operator has trusted the plugin hooks (`/hooks`). Full contract:
# core/skills/_shared/references/session-handoff.md § Archive timing.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --next-action "Compose the artifact for the chosen direction" \
  --next-step-kind verb --next-step-verb compose \
  --next-step-confidence HIGH
```

`awaiting-owner-clear` records `### Owner gate resolved: decide-conflict at
<iso>` with the pointer it cleared, and refuses under an autopilot run: only
the owner resolves an owner gate.

---

## Completion

Output the comparison and one of:

- `✓ Decision recommended.` + chosen direction.
- `✓ Decision pending user input.` — when CONFLICT remained in the
  recommendation. Surface both options with evidence; pause until
  the user selects. Phase 2's owner-decision variant has recorded the
  `decide-conflict` gate, so record the selection with the Owner selection
  step below.

Then emit an **Active Next-Action Proposal** instead of a fixed next
verb, per `core/skills/_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal — the canonical six-field template
(runtime completion-output contract):

```
- selected_next:         <verb | commit | owner decision | done>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; /engineer:commit for commit or done; the owner-decision action otherwise>
```

Typical `selected_next` candidates for decide:
`/engineer:compose` to produce the artifact for the chosen direction —
or `/engineer:investigate` if a decisive evidence gap surfaced, or
`/engineer:frame` if deciding reframed the problem; the routing table is
the fallback only when evidence is genuinely neutral — do not end with a
hardcoded "next: X". When `selected_next` is `engineer:decide`, also name
the decision size (`--size=minor|standard|major`) per the contract.

Always include the workflow path.

The runtime completion footer is **code-emitted** on this verb's terminal path
(ADR-0039): the terminal write `state.mjs finish-verb` makes in interactive
mode fires the ADR-0031 session-handoff sidecar,
which shells out to the runtime `footer.mjs` and prints the rendered footer —
context state, completion state + state-derived next action, workflow id/path,
artifact pointers, recommended next work, and the continue-vs-fresh
session-handoff — on that command's **stderr**. Do **not** hand-compose a second
footer here; surface the one the terminal command already emitted. The footer is
advisory + pointer-only and fail-closed (a missing/too-old runtime emits
nothing, and the SessionStart backstop still re-surfaces the handoff); it never
mutates host session context. On detached HEAD the sidecar reports "no active
branch context" and does not auto-recommend a fresh session. Under an
autopilot run `finish-verb` makes no terminal write, so no footer is printed:
the driver is the handoff.
