---
description: Review a design spec or a rendered screen across the usability / accessibility / conversion / consistency lenses, with accessibility as a veto gate — designer's critique verb
argument-hint: --profile=usability|a11y|conversion|consistency | (default = all four active lenses)
---

# Designer · Critique

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. The peer ensemble runs
automatically (Review point type) — never ask the user whether to invoke the
peer, and never direct them to run companion CLIs manually. When the companions
plugin or peer CLI is unavailable, the ensemble degrades silently to local-only.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_DESIGNER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

> **designer is not an orchestrator dispatch target** (ADR-0042 Non-Goal
> 2): this command does NOT read `AGENTIC_PARENT_WORKFLOW` /
> `AGENTIC_ORIGINATING_SUBTASK`, and designer `state.mjs create` does not
> accept parent-linkage flags. designer workflows are user-invoked and
> branch-anchored only.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

<!-- pipeline:begin critique-phase-0 -->
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
<!-- pipeline:end critique-phase-0 -->

Empty `$ACTIVE` → bootstrap with verb=critique:

<!-- pipeline:begin critique-bootstrap -->
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
   directory holding a one-line genericized critique target, ending with one newline.
   Nothing deletes it.

Then run the block with `TEXT_DIR` set to that directory; a request file left
unwritten stops it before any write. When `AGENTIC_TOPIC` is set (a dispatched
run), the block writes it to a file of its own and records that instead, and
steps 1–2 are not needed.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_DESIGNER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'designer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='critique'
DEFAULT_PROFILE='all'
GIT_BRANCH="$(git branch --show-current)"
GIT_HEAD="$(git rev-parse HEAD)"
STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
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
  --verb 'critique' --host "${AGENTIC_HOST:-claude}" --persona 'designer' \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --profile "${AGENTIC_PROFILE:-<profile from the arguments above — default ${DEFAULT_PROFILE}>}" \
  --original-request-file "$REQUEST_FILE" \
  --current-phase phase-0-bootstrap \
  --next-action "Run ${VERB} skill")" || exit $?
```
<!-- pipeline:end critique-bootstrap -->

Non-empty `$ACTIVE` → append-on-resume:

<!-- pipeline:begin critique-resume -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_DESIGNER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'designer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='critique'
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb 'critique' \
  --profile "<profile or empty>" \
  --phase-label "Phase 0: Resume into ${VERB}" \
  --phase-note "Resumed from prior verb. Profile=<...>." \
  --current-phase phase-0-resume \
  --clear-next-step true \
  --next-action "Run ${VERB} skill" --event resumed || exit $?
```
<!-- pipeline:end critique-resume -->

---

## Phase 1 — Execute critique

Follow the critique skill's command-invoked mode at
`${CLAUDE_PLUGIN_ROOT}/core/skills/critique/SKILL.md`. The lenses (each holds the
artifact to `core/skills/critique/references/quality-criteria.md`):

- `usability` — Nielsen's 10 usability heuristics.
- `a11y` — WCAG 2.1/2.2 A/AA **candidate** checks (the `a11y` flag is an alias
  for the `accessibility` axis; the veto gate).
- `conversion` — CTA clarity, value legibility, funnel friction, honest persuasion.
- `consistency` — design-system + platform + internal-pattern conformance.

Profile selection: `--profile=<lens>` focuses one lens; missing profile runs
**all four active lenses**. An unknown profile, or one of the three
defined-but-inactive lenses (`desirability` / `content-clarity` / `feasibility`),
falls back to the full active set with a one-line warning. The accessibility gate
is evaluated even under a narrowed profile.

<!-- pipeline:extension critique-dual-input -->
**Dual input (ADR-0042 SD4)**: critique accepts a **pre-code** design spec
(text; e.g. a `/designer:compose` artifact) and/or a **post-code** rendered
screen (a screenshot) + the frontend code that produced it. Vision is
**host-direct**: on the active host the model reads the screenshot directly
(Claude natively; Codex CLI via `codex exec --image <file>`), so a screenshot
critique run **on the active host is cross-host symmetric** — vision-grounded
critique is a **same-host** capability. Read the frontend source so
accessibility / consistency findings are grounded in markup, not only pixels.

Findings are severity-rated **CRITICAL / MAJOR / MINOR / SUGGESTION**; an
unmitigated accessibility veto gate FAIL is CRITICAL by definition. The gate is
candidate-level only (ADR-0042 Non-Goal 6): focus order, keyboard traversal, and
screen-reader behavior need runtime testing and are reported as unverified, not
certified.

### Privacy gate (before any external call)

<!-- pipeline:begin critique-privacy-gate -->
PRIVACY GATE: proprietary UI, unreleased features/flows, customer data visible in screenshots, and secret-bearing frontend code
pass an explicit privacy gate before BOTH web search AND peer-host dispatch.
Genericize the artifact before the peer prompt; the pre-genericization value MUST never leave the local host.
See `core/skills/investigate/references/design-brief-spec.md` § Privacy Gate.
<!-- pipeline:end critique-privacy-gate -->

<!-- pipeline:begin critique-privacy-no-image -->
No dispatch passes `--image`: the companion peer path has no image channel, so
an image never reaches the peer as bytes.
<!-- pipeline:end critique-privacy-no-image -->

**Screenshots are sensitive by default** and are never sent to the peer as inline
image bytes — the peer path is code/text-based, or a **verified-local absolute
file path** the peer reads on its own host (the `plugins/image` critique-dispatch
precedent); `codex-companion` has no `--image` flag, so vision-grounded critique
stays same-host. When confidentiality is unclear, ask the user, or run local-only.

### Ensemble dispatch (Review point type)

Build the Review prompt (the peer receives the genericized artifact — spec text
and/or frontend code, or a verified-local screenshot path, **never image bytes**
— and returns an independent code/text critique across the lenses: usability
signals, candidate a11y from markup, conversion/funnel logic, design-system
consistency), write it as the block's `prompt.xml` (the steps below), and
dispatch in the background. The prompt
template + synthesis contract land in
`core/skills/_shared/references/ensemble-protocol.md` § Review; the dispatch
shape mirrors the reference-scan dispatch in
`core/skills/investigate/references/design-brief-ensemble.md`:

<!-- pipeline:begin critique-dispatch -->
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
ROOT_OVERRIDE="$(printenv 'AGENTIC_DESIGNER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'designer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ENSEMBLE_TYPE='review'
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
  --workflow-path "$ACTIVE" --phase 'critique' \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
```
<!-- pipeline:end critique-dispatch -->

Use `run_in_background: true` on the Bash tool. Note the dispatch above never
passes `--image` — the peer path has no image channel. The peer supplies the
code/text perspective; by default it receives no screenshot, so vision-grounded
findings (contrast as-rendered, visual hierarchy, spacing) are the same-host
model's responsibility, and no inline image bytes ever reach the peer. Synthesize
per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT; an unmitigated accessibility gate
FAIL is CRITICAL regardless of which side found it.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

---

<!-- pipeline:begin critique-finalize-heading -->
## Phase 2 — State finalize
<!-- pipeline:end critique-finalize-heading -->

<!-- pipeline:begin critique-finalize -->
The phase note this step records — fill in every `<…>`. When no run launched
(the privacy gate kept the verb local-only, so no dispatch ran; a run whose
companion is missing did launch, and settles `failed`), its first heading reads
`### Ensemble skipped: critique (profile=<profile>) (privacy gate)` instead, and the synthesis
is local-only:

```markdown
### Ensemble launched: critique (profile=<profile>) at <iso-utc>

### Ensemble synthesis: critique (profile=<profile>) verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Review report

Gate verdict: 접근성 Accessibility [PASS/CONDITIONAL/FAIL] (candidate-level; focus-order / keyboard / screen-reader unverified — runtime)

<severity-grouped findings: CRITICAL / MAJOR / MINOR / SUGGESTION, each
 [element/region] [lens] — [finding + failure signal + criteria ref]; plus Looks Strong>

### Active next-action proposal

(per `core/skills/_shared/references/entry-routing-contract.md` § Active Next-Action Proposal — derived from this artifact, not a fixed table)
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — the decisive findings + the accessibility gate verdict>
- evidence_pointers:     <finding sections / criteria refs / artifact path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or $designer:<verb> for a verb; the owner's save and commit for commit; none for done; the owner's decision otherwise>
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
   <compact selected_next + why + next_command — e.g. Address CRITICAL/MAJOR findings (/designer:refine), or proceed to commit when nothing blocks and the gate is not FAIL>
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
  peer-conflict --resolution-file <the ruling's file>` and the next step,
  the ruling written with the file-writing tool.
- `scope-routing` (heading `### Routing recommendation`, anchor
  `routing-recommendation`): the request does not belong in this verb or
  workflow; the owner picks the route, then clears the gate.

The owner-decision form below records the gate with the next step in one
write and leaves the workflow open, not terminal, until the owner resolves it.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_DESIGNER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'designer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
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
  --phase-label 'Phase 1: Critique (synthesized)' \
  --phase-note-file "$TEXT_DIR/note.md" \
  --current-phase phase-2-presented \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --event updated || exit $?

# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,
# launched and failed, completed); a refusal stops the block before the last
# write, so the workflow never closes with an attempt left unsettled.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \
  --repo-root "$REPO_ROOT" --workflow-path "$ACTIVE" \
  --host "${AGENTIC_HOST:-claude}" --phase 'critique' --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" || exit $?

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
    --next-action-file "$TEXT_DIR/next-action.txt" \
    --next-step-kind verb --next-step-verb 'refine' \
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
#   --next-action-file "$TEXT_DIR/next-action.txt" \
#   --next-step-kind owner-decision --next-step-confidence "<HIGH|MEDIUM|LOW>" \
#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' || exit $?
```
<!-- pipeline:end critique-finalize -->

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If a critique surfaces a **genuine 2+-branch decision point** — two viable
remediation directions, or two defensible severity reads of the same finding —
surface a **compact multi-axis lens** across the decisive design axes (사용성
Usability + the archetype axis) + the accessibility gate, reading
`core/skills/decide/references/decision-axes.yml` (the
`scripts/decide-registry.mjs resolve --size=minor` resolver gives the compact
rendering of `balanced`). Bounded: only at a genuine 2+-branch point, never the
full matrix for a trivial reversible fix. A weightier fork routes to
`/designer:decide`.

---

## Completion

Output the severity-grouped report (leading with the gate verdict) and one of:

- `✓ Critique complete.` + count by severity.
- `✓ Critique complete (no significant findings).` — when no CRITICAL or MAJOR
  surfaced and the accessibility gate is not FAIL (`PASS`, or `CONDITIONAL` with
  its remediations named); the design is in good shape.

Then emit an **Active Next-Action Proposal** (the inline shape in
`core/skills/critique/SKILL.md` § Completion): typical `selected_next` is
`/designer:refine` to address the selected findings (CRITICAL + MAJOR by default;
the user picks which MINOR / SUGGESTION to include) — or `/designer:decide` when
a finding opens a genuine 2+-direction fork, or `/designer:investigate` when a
load-bearing accessibility / convention claim needs evidence. Do not end with a
hardcoded "next: X".

ADR-0042 is `Accepted` — the full designer surface (the six verbs, the
`/designer:start` lifecycle macro, and the `resume` / `checkpoint` /
`peer-now` meta skills) ships, so every `next_command` is runnable. The critique report is the durable
handoff. See `core/skills/critique/SKILL.md` § Completion.

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```

<!-- pipeline:begin critique-completion-footer -->
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
<!-- pipeline:end critique-completion-footer -->
