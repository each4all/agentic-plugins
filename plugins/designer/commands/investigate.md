---
description: Scan references, competitor UX, design systems, and heuristic/accessibility standards; read the frontend; produce a durable cited design brief — the designer persona's evidence-gathering verb
argument-hint: --profile=design-brief | (or natural-language design/UX topic)
---

# Designer · Investigate

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go
— use the host's task-tracking tools when the session exposes them,
and keep an inline checklist when it does not. The peer ensemble runs automatically per
`core/skills/investigate/references/design-brief-ensemble.md` (reference-scan
point type) — never ask the user whether to invoke the peer, and never
direct them to run companion CLIs manually. When the companions plugin or
peer CLI is unavailable, the ensemble degrades silently to local-only.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_DESIGNER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

> **designer is not an orchestrator dispatch target** (ADR-0042 Non-Goal
> 2): unlike the engineer commands, this command does NOT read
> `AGENTIC_PARENT_WORKFLOW` / `AGENTIC_ORIGINATING_SUBTASK`, and designer
> `state.mjs create` does not accept parent-linkage flags. designer
> workflows are user-invoked and branch-anchored only.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

Determine workflow state via the host-shared canonical I/O module:

<!-- pipeline:begin investigate-phase-0 -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_DESIGNER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'designer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='designer'
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
# ADR-0066 Decision 3 — prints nothing interactively. When AGENTIC_AUTOPILOT
# names a run it prints one line: the variable is ignored, this persona is no
# autopilot dispatch target. When an owner gate is set on the workflow it
# prints the gate and how the owner resolves it, to put to the user before
# this command continues. It runs before any write.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" autopilot-preflight \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" || exit $?
```
<!-- pipeline:end investigate-phase-0 -->

designer anchors to the frontend/design project git repository
(ADR-0042: design briefs and flow/wireframe specs are version-controlled
deliverables that feed frontend code). If `git rev-parse` fails, refuse
with manual-init guidance (git init, or cd into your frontend/design
project repo). `find-active` exits 1 on a per-branch duplicate (corruption
or an external mutation); the block surfaces the diagnostic and aborts.

Empty `$ACTIVE` → bootstrap a new workflow with verb=investigate:

<!-- pipeline:begin investigate-bootstrap -->
In the block, replace the profile placeholder with the profile the arguments
name, and `<the original request described above>` with a
one-line genericized design/UX topic; `AGENTIC_PROFILE` and `AGENTIC_TOPIC` take their
places when they are set.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_DESIGNER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'designer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='investigate'
DEFAULT_PROFILE='design-brief'
GIT_BRANCH="$(git branch --show-current)"
GIT_HEAD="$(git rev-parse HEAD)"
STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb 'investigate' --host "${AGENTIC_HOST:-claude}" --persona 'designer' \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --profile "${AGENTIC_PROFILE:-<profile from the arguments above — default ${DEFAULT_PROFILE}>}" \
  --original-request "${AGENTIC_TOPIC:-<the original request described above>}" \
  --current-phase phase-0-bootstrap \
  --next-action "Run ${VERB} skill")" || exit $?
```
<!-- pipeline:end investigate-bootstrap -->

`state.mjs create` enforces the directory-level lock + single-active
invariant per ADR-0011 §3, and writes only persona `designer`
(canonical-home guard).

Non-empty `$ACTIVE` → append-on-resume:

<!-- pipeline:begin investigate-resume -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_DESIGNER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'designer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='investigate'
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb 'investigate' \
  --profile "<profile or empty>" \
  --phase-label "Phase 0: Resume into ${VERB}" \
  --phase-note "Resumed from prior verb. Profile=<...>." \
  --current-phase phase-0-resume \
  --clear-next-step true \
  --next-action "Run ${VERB} skill" --event resumed || exit $?
```
<!-- pipeline:end investigate-resume -->

---

## Phase 1 — Execute investigate

Follow the investigate skill's "When invoked by command" mode at
`${CLAUDE_PLUGIN_ROOT}/core/skills/investigate/SKILL.md`. The skill performs:

- **Step 1**: Build the Design Task Profile (Persona=designer,
  Skill-profile=design-brief, Profile=general (L4 archetype), Surface,
  Users, Stage, Platform, Evidence-confidence — canonically defined in the
  shared `_shared/references/orchestration.md` Dynamic Orchestration
  reference, restated inline in the skill), then confirm topic + platform +
  stage, draft 1–7 sub-questions, define scope, run the existing-directory
  check, and pass the privacy gate.
- **Step 2**: No subagent spawning — the orchestrator runs WebSearch +
  WebFetch directly per-sub-question (using the 5 source-type tiers in
  `core/skills/investigate/references/design-brief-spec.md`) AND reads the local
  frontend code for the surface in scope.
- **Step 3**: Dispatch the reference-scan peer ensemble per
  `core/skills/investigate/references/design-brief-ensemble.md` via
  `${CLAUDE_PLUGIN_ROOT}/scripts/peer-runner.mjs run`. The peer runs in the
  background; the orchestrator continues its own per-sub-question web
  search + frontend read in parallel.
- **Step 4**: Collect both sources, classify findings per AGREED /
  LOCAL-ONLY / PEER-ONLY / CONFLICT; apply the bidirectional Independence
  Rule (Path A locally verify + cite with tier/as-of/platform tags, Path B
  move to Open Questions); remap citation numbers to local capture order.
- **Step 5**: Run the Audit Checklist
  (`core/skills/investigate/references/design-brief-spec.md`) and save the brief
  per `core/skills/investigate/references/output-file-rules.md` (per-topic
  directory under the resolved output root, fixed filename
  `design_brief.md`).

### Privacy gate (before any external call)

<!-- pipeline:begin investigate-privacy-gate -->
PRIVACY GATE: proprietary UI, unreleased features/flows, customer data visible in screenshots, and secret-bearing frontend code
pass an explicit privacy gate before BOTH web search AND peer-host dispatch.
Genericize or remove proprietary content from the topic and sub-questions before WebSearch / WebFetch or peer dispatch; only the genericized form leaves the local host. If the topic cannot be genericized without losing the question, run local-only or abort at scoping. The pre-genericization value MUST never leave the local host.
See `core/skills/investigate/references/design-brief-spec.md` § Privacy Gate.
<!-- pipeline:end investigate-privacy-gate -->

<!-- pipeline:begin investigate-privacy-no-image -->
No dispatch passes `--image`: the companion peer path has no image channel, so
an image never reaches the peer as bytes.
<!-- pipeline:end investigate-privacy-no-image -->

**Screenshots are sensitive by default** — a raw screenshot of a real UI is
never sent to web search or the peer; describe it in genericized terms
(host-direct vision critique of a screenshot is a same-host `designer:critique`
capability, not this reference-scan flow). Frontend code is redacted of secrets
before any external send.

### Ensemble dispatch — concrete invocation

Build the reference-scan prompt per
`core/skills/investigate/references/design-brief-ensemble.md` § Prompt
Construction (it carries the genericized topic, confirmed sub-questions,
scope, platform, and the `<citation_contract>` + `<privacy_contract>` XML
blocks) and spawn the peer in the background:

<!-- pipeline:begin investigate-dispatch -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_DESIGNER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'designer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ENSEMBLE_TYPE='reference-scan'
PROMPT_FILE="$(mktemp -t 'designer'-'investigate'-prompt.XXXXXX).xml"
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
  --workflow-path "$ACTIVE" --phase 'investigate' \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
```
<!-- pipeline:end investigate-dispatch -->

`--prompt-file` keeps user-controlled material (topic, sub-questions) out
of shell parsing and process argv per `companions/contract.md` § 2.2. Use
`run_in_background: true` on the Bash tool; collect output once the
orchestrator's local per-sub-question web search + frontend read completes.

When the companion is missing or returns exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`),
record the failure in the workflow body under "### Ensemble degraded:" and
proceed with local-only synthesis per the protocol's *Failure Handling*.

---

## Phase 2 — State finalize

After Phase 1 returns the synthesized brief, append a phase note that
captures (a) the synthesis verdict, (b) ensemble launch + result markers,
and (c) the active next-action proposal. Include the saved brief's
absolute path under a `### Brief saved` heading so future workflow
consumers can locate the artifact (the brief itself stays orthogonal to
the workflow body — referenced by path only, never inlined). Workflow
phase notes MAY carry source-of-discovery labels (`[Both]` / `[Local]` /
`[Peer]`); the saved brief artifact MUST NOT, per
`core/skills/investigate/references/design-brief-spec.md` § Ensemble Label
Policy.

<!-- pipeline:begin investigate-finalize -->
The phase note this step records — fill in every `<…>`. When no run launched
(the privacy gate kept the verb local-only, so no dispatch ran; a run whose
companion is missing did launch, and settles `failed`), its first heading reads
`### Ensemble skipped: reference-scan (privacy gate)` instead, and the synthesis
is local-only:

```markdown
### Ensemble launched: reference-scan at <iso-utc>

### Ensemble synthesis: design-brief verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Brief saved

<absolute path to design_brief.md>

### Active next-action proposal

(per `core/skills/_shared/references/entry-routing-contract.md` § Active Next-Action Proposal — derived from this artifact, not a fixed table)
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + evidence-quality gate>
- evidence_pointers:     <brief path / sub-questions / Open Questions — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or $designer:<verb> for a verb; the owner's save and commit for commit; none for done; the owner's decision otherwise>
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

A synthesis verdict of `conflict` ends this verb on its conflict gate,
`peer-conflict`, with a bounded consensus round proposed before the
owner decides (ADR-0067 Decision 8). The proposal's `selected_next` is the
owner decision, after a bounded consensus round; its `rejected_alternatives`
include "the owner decides now", with the reason for this case (what the two
positions leave unweighed that a round between the peers would weigh); and its
`next_command` is `/runtime:consensus plan --task-file <the task file> --peers
claude,codex --max-rounds 2`, two rounds at most. In the phase note the task
file is spelled from the state root,
`.agentic-plugins/state/designer/consensus/<workflow id>.<run id>.md`; the
completion output gives the command the block prints, with its absolute
path.

The block branches on the verdict the settle recorded for the run, not on
`VERDICT` alone. Recorded `conflict`, with `VERDICT` set to `conflict`, it
writes the contested items to that task file (`consensus-task`), then records
the gate with the run id in the same write as the next step `owner-decision`.
Write the contested items only then, with the file tool, to a new file, and
set `CONTESTED_FILE` to its path: each CONFLICT item with both positions and
their evidence, prepared as the peer prompt was, since the consensus peers
read it. They come from the peers' positions, so never put them in the block:
there the shell would read a line of them as a command. When the recorded
verdict and `VERDICT` disagree (a run recorded `failed`, or a conflict
recorded by an earlier attempt), the block stops before the last write: set
`VERDICT` to the recorded verdict, and `CONTESTED_FILE` too when that is
`conflict`, and run the block again. Its settle does nothing for a run it
already recorded, so the branch that matches runs: on a conflict,
`consensus-task` first, then the gate. Nothing runs the consensus round: the
owner does, then rules, and clearing the gate retires the task file. compose,
frame and refine, and every other verdict, never take this branch.

The last write, `finish-verb`, records the proposal's next step in closed-enum
form: `--next-step-kind` `verb` (with `--next-step-verb`), `commit` (the owner
saves and commits the artifact; designer runs no commit itself) or `done`,
each closing the workflow `summary-complete`. End instead with an owner gate
when the owner must judge, with the judgment under the gate's heading in the
note:

- `peer-conflict` (the `Ensemble synthesis` heading, anchor
  `ensemble-synthesis`): the synthesis verdict is `conflict`; the block's
  conflict branch records it with the run id, and the owner rules on the
  contested items, then clears it with `awaiting-owner-clear --gate
  peer-conflict --resolution "<the ruling>"` and the next step.
- `scope-routing` (heading `### Routing recommendation`, anchor
  `routing-recommendation`): the request does not belong in this verb or
  workflow; the owner picks the route, then clears the gate.

The owner-decision form below records the gate with the next step in one
write and leaves the workflow open, not terminal, until the owner resolves it.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_DESIGNER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'designer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
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
  --phase-label 'Phase 1: Investigate (synthesized)' \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action '<compact selected_next + why + next_command — e.g. Frame the UX problem from this cited brief (/designer:frame)>' \
  --event updated || exit $?

# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,
# launched and failed, completed); a refusal stops the block before the last
# write, so the workflow never closes with an attempt left unsettled.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \
  --repo-root "$REPO_ROOT" --workflow-path "$ACTIVE" \
  --host "${AGENTIC_HOST:-claude}" --phase 'investigate' --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" || exit $?

# ADR-0067 Decision 8 — the verdict the settle above recorded for the run
# (empty when it recorded none). A recorded conflict does not close the
# verb: it writes the contested items as the consensus task file and ends on
# the conflict gate, bound to its run. Any other verdict makes the typical
# last write.
RECORDED="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-verdict \
  --workflow-path "$ACTIVE" --run-id "$RUN_ID")" || exit $?
if [ "$RECORDED" != conflict ] && [ "$VERDICT" != conflict ]; then
  # ADR-0029 §1 / completion-output contract §2 — set --next-action (the
  # append above and this terminal write) to the COMPACT form of the
  # proposal above (selected_next + one-line why + next_command) so the
  # durable state and the code-emitted completion footer agree with the
  # Active Next-Action Proposal. The value shown is the typical-case
  # default; override it, and the --next-step-* flags, when the verb's result
  # selects a different next step (e.g. the owner's save and commit).
  # ADR-0063 D3 — finish-verb is the verb's last write: the ADR-0017
  # §sub-decision 5 atomic terminal write (summary-complete + terminal marker)
  # with the next step. ADR-0066 Decision 3: an inherited AGENTIC_AUTOPILOT
  # changes nothing here.
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
    --next-action '<compact selected_next + why + next_command — e.g. Frame the UX problem from this cited brief (/designer:frame)>' \
    --next-step-kind verb --next-step-verb 'frame' \
    --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
elif [ "$RECORDED" != conflict ] || [ "$VERDICT" != conflict ]; then
  echo "✗ The synthesis verdict is ${VERDICT:-unset}, but run ${RUN_ID:-<none>} is recorded with ${RECORDED:-no verdict}: a consensus round needs both to be conflict. Set VERDICT to the recorded verdict (and CONTESTED_FILE when that is conflict) and run this block again: its settle does nothing for a recorded run, and the matching branch runs, consensus-task first on a conflict. Nothing more was written." >&2
  exit 1
else
  # The contested items, from the file CONTESTED_FILE names, written with the
  # file tool: the shell never reads them, so no line of them runs as a
  # command. No file named stops the block before the gate; consensus-task
  # refuses an empty one.
  [ -n "${CONTESTED_FILE:-}" ] || { echo "✗ CONTESTED_FILE names no file of contested items; the gate was not recorded." >&2; exit 1; }
  # The task file, once the settle above recorded the run with the verdict
  # conflict; it prints the consensus round the proposal selects.
  PROPOSED="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" consensus-task \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --run-id "$RUN_ID" \
    --text-file "$CONTESTED_FILE")" || exit $?
  # The gate, bound to its run, and the next step owner-decision in one
  # write: the workflow stays open until the owner rules.
  # ARCHIVE TIMING — with an owner gate this write is never terminal, so the
  # Stop hook, which fires at EVERY turn end on Claude, leaves the workflow
  # active (it refuses to archive while a gate is pending); the
  # `--terminal-marker false` escape is not needed. On Codex the Stop hook runs
  # only once the plugin hooks are trusted (`/hooks`).
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --next-action "Owner decision, after a bounded consensus round: $PROPOSED" \
    --next-step-kind owner-decision --next-step-confidence "<HIGH|MEDIUM|LOW>" \
    --owner-gate 'peer-conflict' --owner-gate-anchor ensemble-synthesis \
    --owner-gate-run-id "$RUN_ID" || exit $?
  echo "→ Proposed, for the owner to run before deciding: $PROPOSED" >&2
fi
# The owner-decision form, for an owner gate named above this block: it
# records the gate with the next step in one write, and the workflow stays
# open until the owner resolves the gate.
# node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
#   --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
#   --next-action '<Owner: the judgment, in a few words>' \
#   --next-step-kind owner-decision --next-step-confidence "<HIGH|MEDIUM|LOW>" \
#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' || exit $?
```
<!-- pipeline:end investigate-finalize -->

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If executing this verb surfaces a **genuine 2+-branch decision point** —
two viable reference patterns, or two competing readings of the same
accessibility / competitor evidence — surface a **compact multi-axis lens**
comparing the branches across the decisive design axes (usability 사용성 +
the context lens the question turns on, with accessibility 접근성 as the
veto gate, per ADR-0042 SD3) + size-appropriate supporting axes, instead
of a flat list. The designer decision registry
(`scripts/decide-registry.mjs` +
`core/skills/decide/references/decision-axes.yml`) is the axis source of truth;
when it is unreachable, read the decisive axes inline as above.
Bounded: only at a genuine 2+-branch point, never a full matrix for a
trivial reversible step.

---

## Completion

Output the synthesized brief summary and one of:

- `✓ Design brief saved.` — audit passed, file written to
  `<resolved-root>/YYYY-MM-DD_<topic-slug>/design_brief.md`. Show the saved
  path, sub-question coverage, source-tier breakdown, overall confidence,
  and any degraded-ensemble note.
- `✗ Design brief aborted at save.` — the user declined at the
  existing-directory gate or final review. No file written; the
  synthesized brief is shown inline only.
- `✗ Design brief aborted at scoping.` — the user declined the topic,
  sub-questions, or privacy gate before dispatch. No web search / peer
  dispatch ran.

For the saved case, emit an **Active Next-Action Proposal** (the inline
shape shown in `core/skills/investigate/SKILL.md` § Completion): typical
`selected_next` candidates are `/designer:frame` (structure a UX problem
model from the brief), `/designer:decide` (choose between surveyed
patterns — name the size `--size=minor|standard|major`), or
`/designer:compose` (draft flows/specs from it). Do not end with a
hardcoded "next: X". The two aborted cases have no forward result, so they
skip the proposal.

ADR-0042 is `Accepted` — the full designer surface (the six verbs, the
`/designer:start` lifecycle macro, and the `resume` / `checkpoint` /
`peer-now` meta skills) ships, so every `next_command` is runnable. The saved brief is the durable
handoff. See
`core/skills/investigate/SKILL.md` § Completion.

Always include the workflow path so the user can inspect or resume:

```
Workflow: <absolute path to workflow .md file>
```

<!-- pipeline:begin investigate-completion-footer -->
The runtime completion footer is **code-emitted** on this verb's terminal
path (ADR-0039): the terminal write (`state.mjs finish-verb`, which takes
`set-terminal`'s path) fires the ADR-0031 session-handoff sidecar, which
shells out to the runtime `footer.mjs` and prints the rendered footer —
context state, completion state
(designer's manually-published mapping surfaces `publish-needed` when
only the owner's save/commit remains) + state-derived next action,
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
Wiring details:
`core/skills/_shared/references/session-handoff.md`.
<!-- pipeline:end investigate-completion-footer -->
