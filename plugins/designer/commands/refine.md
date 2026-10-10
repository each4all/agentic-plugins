---
description: Apply critique findings or feedback to a design spec or the frontend code + rendered screen, verify it reconciles, then re-critique to convergence — designer's refinement verb
argument-hint: (no profile — refine is single-mode; describe what to apply)
---

# Designer · Refine

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. The peer ensemble runs
automatically (Refine-verify point type) — never ask the user whether to invoke
the peer, and never direct them to run companion CLIs manually. When the
companions plugin or peer CLI is unavailable, the ensemble degrades silently to
local-only.

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

<!-- pipeline:begin refine-phase-0 -->
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
<!-- pipeline:end refine-phase-0 -->

Empty `$ACTIVE` → bootstrap with verb=refine (single-mode — **no `--profile`**):

<!-- pipeline:begin refine-bootstrap -->
The request reaches `state.mjs` as a file, never in the block: in shell
source a quote, `$`, backtick or line break of it would be read as code
(ADR-0059, amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `request.txt` in that
   directory holding a one-line genericized refine target, ending with one newline.
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
VERB='refine'
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
  --verb 'refine' --host "${AGENTIC_HOST:-claude}" --persona 'designer' \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --original-request-file "$REQUEST_FILE" \
  --current-phase phase-0-bootstrap \
  --next-action "Run ${VERB} skill")" || exit $?
```
<!-- pipeline:end refine-bootstrap -->

Non-empty `$ACTIVE` → append-on-resume (refine is single-mode — no `--profile`):

<!-- pipeline:begin refine-resume -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_DESIGNER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'designer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='refine'
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb 'refine' \
  --phase-label "Phase 0: Resume into ${VERB}" \
  --phase-note "Resumed from prior verb." \
  --current-phase phase-0-resume \
  --clear-next-step true \
  --next-action "Run ${VERB} skill" --event resumed || exit $?
```
<!-- pipeline:end refine-resume -->

---

## Phase 1 — Execute refine

Follow the refine skill's command-invoked mode at
`${CLAUDE_PLUGIN_ROOT}/core/skills/refine/SKILL.md`. Refine is **single-mode** (no
`--profile` argument). The L4 design archetype flows through the Design Task
Profile per `core/skills/investigate/SKILL.md` § Design Task Profile (the shared
`core/skills/_shared/references/orchestration.md` reference).

Refine applies critique findings or feedback to the design artifact — a pre-code
design spec (user flow, wireframe spec, CTA copy, IA, component spec) OR a
post-code surface (the frontend code + the rendered screen) — and verifies the
revision holds together. The upstream contract is: `critique` (or `investigate`
for a load-bearing evidence gap) → `decide` (if 2+ viable remediation directions)
→ `refine`. When the remediation involves 2+ viable directions, route through
`/designer:decide` rather than choosing silently.

**Verify means the design still reconciles, not "run tests"**: confirm the
revised elements still carry their accessibility + consistency acceptance
criteria, the revised flow still honors the frame's measurable UX success
metrics, still-unvalidated assumptions keep their `[to be validated]` markers,
and — the load-bearing design gate — the change did **not** open a new
accessibility barrier. A revision that clears a usability/conversion problem by
introducing a candidate WCAG A/AA barrier has moved the veto gate, not cleared
it. The candidate-only accessibility boundary holds (ADR-0042 Non-Goal 6): focus
order, keyboard traversal, and screen-reader behavior need runtime testing and
are reported as unverified, not certified.

<!-- pipeline:extension refine-convergence-loop -->
**The convergence loop (ADR-0042 SD4)**: critique → refine → re-critique until
findings converge. After applying the revision + the Refine-verify ensemble,
re-critique the revised artifact (for a post-code change, re-render + re-read the
screen host-direct — same-host vision). Loop until no new CRITICAL / MAJOR and the
accessibility gate is **not FAIL** — `PASS`, or `CONDITIONAL` with every
remediation named as a blocking precondition. `CONDITIONAL` converges on purpose:
static critique is candidate-level (ADR-0042 Non-Goal 6), so an honest,
well-specified design lands there rather than on `PASS`. See
`${CLAUDE_PLUGIN_ROOT}/core/skills/refine/SKILL.md` @refine:convergence-predicate.

### Privacy gate (before any external call)

<!-- pipeline:begin refine-privacy-gate -->
PRIVACY GATE: proprietary UI, unreleased features/flows, customer data visible in screenshots, and secret-bearing frontend code
pass an explicit privacy gate before BOTH web search AND peer-host dispatch.
Genericize the revision before the peer prompt; the pre-genericization value MUST never leave the local host.
See `core/skills/investigate/references/design-brief-spec.md` § Privacy Gate.
<!-- pipeline:end refine-privacy-gate -->

<!-- pipeline:begin refine-privacy-no-image -->
No dispatch passes `--image`: the companion peer path has no image channel, so
an image never reaches the peer as bytes.
<!-- pipeline:end refine-privacy-no-image -->

**Screenshots are sensitive by default** and are never sent to the peer as inline
image bytes — the peer path is code/text-based, or a **verified-local absolute
file path** the peer reads on its own host (the `plugins/image` critique-dispatch
precedent); `codex-companion` has no `--image` flag, so vision-grounded
re-critique stays same-host. When confidentiality is unclear, ask the user, or run
local-only.

### Ensemble dispatch (Refine-verify point type)

Build the Refine-verify prompt (the peer receives the **genericized** before→after
of the changed elements — spec text and/or frontend code, or a verified-local
screenshot path, **never image bytes** — and verifies the revision resolves the
finding without introducing a new inconsistency or a new accessibility barrier),
write it as the block's `prompt.xml` (the steps below), and dispatch in the
background. The privacy gate must have passed first. The prompt template + synthesis contract land in
`core/skills/_shared/references/ensemble-protocol.md` § Refine-verify; the
dispatch shape mirrors the reference-scan dispatch in
`core/skills/investigate/references/design-brief-ensemble.md`:

<!-- pipeline:begin refine-dispatch -->
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
ENSEMBLE_TYPE='refine-verify'
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
  --workflow-path "$ACTIVE" --phase 'refine' \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
```
<!-- pipeline:end refine-dispatch -->

Use `run_in_background: true` on the Bash tool. Note the dispatch above never
passes `--image` — the peer path has no image channel. The peer supplies the
code/text verification (does the revision resolve the finding, does any element
now contradict the change, did the change open a new candidate a11y barrier); the
vision-grounded re-critique of the re-rendered screen is the same-host model's
responsibility, and no inline image bytes ever reach the peer. Synthesize per
AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT. A peer-flagged regression (a new
inconsistency or a new accessibility barrier) pauses the refine for user
direction. Loop apply → verify → re-critique until findings converge.

<!-- pipeline:extension refine-convergence-bound -->
**Bounded convergence (no unbounded loop).** Run at most a bounded number of
apply → verify → re-critique passes (default 2, hard cap 3). If findings still do
not converge — each pass exposes a fresh CRITICAL / MAJOR, or the peer keeps
flagging a regression — STOP looping: set `CONVERGED=no`, PAUSE, and route to the
owner (a genuine 2+-direction remediation fork → `/designer:decide`; a
load-bearing unverified claim → `/designer:investigate`; otherwise present the
residual findings for an owner decision). Do not loop indefinitely.

**Post-code re-render is host-provided, not designer-run.** designer does not run
the frontend build. The vision re-critique of a post-code change reads the
re-rendered screen the user / frontend engineer supplies after rebuilding. If that
screen is unavailable, or the edit broke the render, the vision-grounded
re-critique CANNOT run: report the peer code/text verification only, flag the
visual re-critique **UNVERIFIED**, set `CONVERGED=no`, and do NOT claim full
convergence — a code/text-only pass is not a substitute for the visual re-critique
on a post-code change.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

---

<!-- pipeline:begin refine-finalize-heading -->
## Phase 2 — State finalize
<!-- pipeline:end refine-finalize-heading -->

<!-- pipeline:begin refine-finalize-convergent -->
The phase note this step records — fill in every `<…>`. When no run launched
(the privacy gate kept the verb local-only, so no dispatch ran; a run whose
companion is missing did launch, and settles `failed`), its first heading reads
`### Ensemble skipped: refine (privacy gate)` instead, and the synthesis
is local-only:

```markdown
### Ensemble launched: refine at <iso-utc>

### Ensemble synthesis: refine verdict=<resolved|concerns|regression|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Refinement summary

- Applied: <N findings / 1 revision>
- Verified: <downstream elements reconcile; accessibility gate exposure
  unchanged; measurable success metrics intact; [to be validated] markers intact>
- Render status (post-code only): <re-rendered screen read host-direct | re-render unavailable / broke — vision re-critique UNVERIFIED | N/A (pre-code)>
- Re-critique: <converged — no new CRITICAL/MAJOR + accessibility gate not FAIL (PASS, or CONDITIONAL with named preconditions) | NOT converged — new findings / regression / gate FAIL / vision UNVERIFIED>
- Convergence: <CONVERGED | PAUSED — bounded passes exhausted / regression / render unavailable → routed to owner decision | /designer:decide | /designer:investigate>
- Deferred: <items not addressed and why>

### Active next-action proposal

(per `core/skills/_shared/references/entry-routing-contract.md` § Active Next-Action Proposal — derived from this artifact, not a fixed table)
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — the design reconciles + the accessibility gate verdict>
- evidence_pointers:     <revised elements / criteria refs / artifact path — pointers only>
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
   <compact selected_next + why + next_command — e.g. Re-critique the revised artifact to confirm convergence (/designer:critique), or proceed to commit when converged and the gate is not FAIL>
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

This verb closes only once it converged (`terminal_requires_convergence`).
Set `CONVERGED` in the block to `yes` only when the re-critique converged by
the convergence rule above; anything else, an unset value included, reads as
not converged. Converged, the last write is `finish-verb`. Not converged, the
last write is an `append` that records the next step resolving the flagged
item (`refine`, `decide` or `investigate`) and turns off a terminal marker an
earlier verb left, so the workflow stays open and the Stop hook cannot
archive it. Write `next-action.txt` for that case: the flagged item, and the
next step that resolves it.

The last write, `finish-verb`, records the proposal's next step in closed-enum
form: `--next-step-kind` `verb` (with `--next-step-verb`), `commit` (the owner
saves and commits the artifact; designer runs no commit itself) or `done`,
each closing the workflow `summary-complete`. End instead with an owner gate
when the owner must judge, with the judgment under the gate's heading in the
note:

- `recurring-finding` (heading `### Recurring finding`, anchor
  `recurring-finding`): a finding an earlier refine pass on this workflow
  already addressed survives verification again; fixing it again is the
  owner's call, and § Owner decision below resolves it.
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
  --phase-label 'Phase 1: Refine (synthesized)' \
  --phase-note-file "$TEXT_DIR/note.md" \
  --current-phase phase-2-presented \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --event updated || exit $?

# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,
# launched and failed, completed); a refusal stops the block before the last
# write, so the workflow never closes with an attempt left unsettled.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \
  --repo-root "$REPO_ROOT" --workflow-path "$ACTIVE" \
  --host "${AGENTIC_HOST:-claude}" --phase 'refine' --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" || exit $?

# FAIL-CLOSED: shell state does not survive between Bash calls, so an unset
# CONVERGED reads as not converged, never as success. Assign it here, from
# the re-critique verdict.
CONVERGED="<yes|no — from the re-critique verdict; unset means no>"
if [ "${CONVERGED:-no}" = "yes" ]; then
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
    --next-step-kind verb --next-step-verb 'critique' \
    --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
else
  # Not converged: the workflow stays open, with the next step that resolves
  # the flagged item, and a terminal marker an earlier verb left turned off.
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --current-phase phase-2-presented \
    --next-action-file "$TEXT_DIR/next-action.txt" \
    --next-step-kind verb --next-step-verb "<refine|decide|investigate>" \
    --next-step-confidence "<HIGH|MEDIUM|LOW>" \
    --clear-terminal-marker true --event updated || exit $?
  echo "→ PAUSED (not converged): the workflow stays open, not terminal. Resolve the flagged item, then run the next step recorded above." >&2
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
<!-- pipeline:end refine-finalize-convergent -->

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If refine surfaces a **genuine 2+-branch decision point** — two viable
remediation directions, or two ways to close the same gap — surface a **compact
multi-axis lens** across the decisive design axes (사용성 Usability + the archetype
axis) + the accessibility gate, reading `core/skills/decide/references/decision-axes.yml`
(the `scripts/decide-registry.mjs resolve --size=minor` resolver gives the compact
rendering of `balanced`). Bounded: only at a genuine 2+-branch point, never the
full matrix for a trivial reversible fix. A weightier fork routes to
`/designer:decide`.

---

<!-- pipeline:begin refine-owner-decision-convergent -->
## Owner decision (recurring-finding)

The `recurring-finding` gate is resolved by the owner's decision (ADR-0063 Q2,
ported by ADR-0066 Decision 9), in either of two ways:

- **In this session**, right after the refine stopped on it.
- **Later**, when Phase 0's preflight reports a pending `recurring-finding`
  gate (an earlier session stopped on it): present the finding recorded at the
  gate's pointer, the latest `Recurring finding` note.

Ask the owner: fix it now, or defer it. The clear records the owner's decision
(`--resolution-file`, the file below) and the next step it implies in one
write, so the
next step never becomes runnable without the decision behind it, and a failure
never leaves the gate's `owner-decision` behind; the same write replaces the
gate's next action. Inside a `/designer:start` lifecycle both blocks clear
the gate and stop there: resume the lifecycle, which fixes the finding in its
refine phase or continues at its terminal step, and makes its one terminal
write.

The owner's decision reaches `state.mjs` as a file, never in a block: in
shell source a quote, `$`, backtick or line of it would be read as code
(ADR-0059, amendment of 2026-10-10). Before either block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `resolution.txt` in
   that directory, ending with one newline: for Fix now, `Owner decision: fix
   the finding now` with what the owner added; for Defer, `Owner decision:
   defer the finding` with the reason and where it is tracked. Nothing
   deletes it.

Then run the block with `TEXT_DIR` set to that directory; a resolution left
unwritten stops it before any write.

This refine closes only once it converged (`terminal_requires_convergence`),
and deferring a finding does not make it converge. In the Defer block, set
`CONVERGED` to `yes` only when the re-critique, with the finding deferred,
converged by the convergence rule above; anything else, an unset value
included, reads as not converged. Converged, the Defer block clears the gate
with `commit` next and ends the verb. Not converged, it clears the gate with
the next step that resolves what is still open (`refine`, `decide` or
`investigate`) and makes no terminal write: the gate's write turned the
terminal marker off, so the workflow stays open and the Stop hook cannot
archive it. For that case also write `next-action.txt` beside the resolution:
what the next step resolves, in a few words.

**Fix now.** Clear the gate with this refine as the next step, then run the
phases above on that finding, as usual (inside a `/designer:start`
lifecycle, resume the lifecycle instead):

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_DESIGNER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'designer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='designer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# A gate met inside a /start lifecycle is resolved there: the lifecycle's
# refine phase runs the fix, and the lifecycle makes the one terminal write,
# which this refine's own phases would make otherwise. A failed read, or a type
# that cannot be parsed, stops the block (the read is checked on its own: a
# pipe reports its last command).
WF_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE")" \
  || { echo "✗ Could not read the workflow type; nothing was written." >&2; exit 1; }
WF_TYPE="$(printf '%s' "$WF_JSON" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).workflow_type||"verb-chain")}catch{process.exit(1)}})')" \
  || { echo "✗ Could not read the workflow type; nothing was written." >&2; exit 1; }
# The owner's resolution, from the file the agent wrote with its file tool:
# state.mjs reads it itself, so no line of it is shell source. A file left
# unwritten stops the block before any write.
grep -q '[^[:space:]]' "$TEXT_DIR/resolution.txt" 2>/dev/null || { echo "✗ resolution.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
if [ "$WF_TYPE" = start ]; then
  NEXT_ACTION="Resume /${PERSONA}:start: its refine phase fixes the recurring finding"
else
  NEXT_ACTION='Fix the recurring finding in this refine, then re-critique'
fi
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate recurring-finding \
  --resolution-file "$TEXT_DIR/resolution.txt" --next-action "$NEXT_ACTION" \
  --next-step-kind verb --next-step-verb refine --next-step-confidence HIGH || exit $?
if [ "$WF_TYPE" = start ]; then
  echo "→ Gate cleared. Resume the lifecycle with /${PERSONA}:start (\$${PERSONA}:start on Codex); its refine phase fixes the finding." >&2
  exit 0
fi
```

**Defer.** Clear the gate with the deferral and `commit` as the next step (the
owner saves and commits the artifact; designer runs no commit itself), then
end the verb:

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_DESIGNER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'designer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='designer'
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
# The owner's resolution, from the file the agent wrote with its file tool:
# state.mjs reads it itself, so no line of it is shell source. A file left
# unwritten stops the block before any write.
grep -q '[^[:space:]]' "$TEXT_DIR/resolution.txt" 2>/dev/null || { echo "✗ resolution.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
if [ "$WF_TYPE" = start ]; then
  NEXT_ACTION="Resume /${PERSONA}:start: the finding is deferred, and the lifecycle continues at its terminal step"
else
  NEXT_ACTION='The recurring finding is deferred; the owner saves and commits the refined artifact'
fi
# FAIL-CLOSED: shell state does not survive between Bash calls, so an unset
# CONVERGED reads as not converged, never as success. Assign it here, from
# the re-critique verdict with the finding deferred.
CONVERGED="<yes|no — from the re-critique verdict with the finding deferred; unset means no>"
if [ "${CONVERGED:-no}" = "yes" ]; then
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate recurring-finding \
    --resolution-file "$TEXT_DIR/resolution.txt" --next-action "$NEXT_ACTION" \
    --next-step-kind commit --next-step-confidence HIGH || exit $?
  if [ "$WF_TYPE" = start ]; then
    echo "→ Gate cleared. Resume the lifecycle with /${PERSONA}:start (\$${PERSONA}:start on Codex); it continues at its terminal step." >&2
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
    --next-action 'The recurring finding is deferred; the owner saves and commits the refined artifact' \
    --next-step-kind commit --next-step-confidence HIGH || exit $?
else
  # Not converged: the gate is cleared with the next step that resolves what
  # is still open, and no terminal write is made. Its action is a file the
  # agent wrote too; one left unwritten stops the block before the clear.
  grep -q '[^[:space:]]' "$TEXT_DIR/next-action.txt" 2>/dev/null || { echo "✗ next-action.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate recurring-finding \
    --resolution-file "$TEXT_DIR/resolution.txt" --next-action-file "$TEXT_DIR/next-action.txt" \
    --next-step-kind verb --next-step-verb "<refine|decide|investigate>" \
    --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
  echo "→ PAUSED (not converged): the gate is cleared and the workflow stays open, not terminal. Run the next step recorded above (inside a /${PERSONA}:start lifecycle, resume it with /${PERSONA}:start)." >&2
fi
```

`awaiting-owner-clear` records `### Owner gate resolved: recurring-finding at
<iso>` with the pointer it cleared and the resolution, and replaces the gate's
next action. It refuses, writing
nothing, when the gate set on the workflow is not `recurring-finding`.
<!-- pipeline:end refine-owner-decision-convergent -->

---

## Completion

Output the refinement summary (applied / verified / re-critique / deferred) and
one of:

- `✓ Refinement complete.` + the artifact revised and reconciled (re-critique
  converged, accessibility gate not FAIL — state which: `PASS`, or `CONDITIONAL`
  plus the preconditions now binding on the artifact).
- `✓ Refine paused.` — when the peer or the consistency re-critique surfaced a new
  inconsistency or a new accessibility barrier, the bounded passes were exhausted
  without convergence, or a post-code re-render could not be re-critiqued. The
  workflow is left ACTIVE (not marked terminal), with the next step recorded;
  resolve the flagged item, then re-run `/designer:refine` or route to
  `/designer:decide`.
- `✓ Refine stopped for the owner (recurring finding).` — a finding an
  earlier refine pass already addressed survived verification again. Phase 2
  ended with the owner-decision form of `finish-verb`, which recorded the
  `recurring-finding` gate: record the owner's decision with the Owner
  decision step above.

Then emit an **Active Next-Action Proposal** (the inline shape in
`core/skills/refine/SKILL.md` § Completion): typical `selected_next` is
`/designer:critique` to re-critique the revised artifact and confirm convergence
— or "the design is sound, proceed" when the change was small and reconciles. Do
not end with a hardcoded "next: X".

ADR-0042 is `Accepted` — the full designer surface (the six verbs, the
`/designer:start` lifecycle macro, and the `resume` / `checkpoint` /
`peer-now` meta skills) ships, so every `next_command` is runnable. The refinement summary is the durable
handoff. See `core/skills/refine/SKILL.md` § Completion.

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```

<!-- pipeline:begin refine-completion-footer -->
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
<!-- pipeline:end refine-completion-footer -->
