---
description: Compare 2+ business directions under constraints, recommend one with rationale — founder's decision verb (decisive market/unit-economics axes + regulatory/safety veto gates)
argument-hint: "[--size=<minor|standard|major>] [--preset=<id>] [--weights=<spec>] [--] <business decision question or candidate directions>"
---

# Founder · Decide

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. The peer ensemble
runs automatically (Brainstorm point type) — never ask the user whether
to invoke the peer, and never direct them to run companion CLIs manually.
When the companions plugin or peer CLI is unavailable, the ensemble
degrades silently to local-only.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_FOUNDER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

> **founder is not an orchestrator dispatch target** (ADR-0036 Non-Goal
> 3): this command does NOT read `AGENTIC_PARENT_WORKFLOW` /
> `AGENTIC_ORIGINATING_SUBTASK`, and founder `state.mjs create` does not
> accept parent-linkage flags. founder workflows are user-invoked and
> branch-anchored only.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

<!-- pipeline:begin decide-phase-0 -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='founder'
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
<!-- pipeline:end decide-phase-0 -->

Empty `$ACTIVE` → bootstrap with verb=decide:

<!-- pipeline:begin decide-bootstrap -->
The request reaches `state.mjs` as a file, never in the block: in shell
source a quote, `$`, backtick or line break of it would be read as code
(ADR-0059, amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `request.txt` in that
   directory holding a one-line genericized business decision, ending with one newline.
   Nothing deletes it.

Then run the block with `TEXT_DIR` set to that directory; a request file left
unwritten stops it before any write. When `AGENTIC_TOPIC` is set (a dispatched
run), the block writes it to a file of its own and records that instead, and
steps 1–2 are not needed.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='decide'
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
  --verb 'decide' --host "${AGENTIC_HOST:-claude}" --persona 'founder' \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --original-request-file "$REQUEST_FILE" \
  --current-phase phase-0-bootstrap \
  --next-action "Run ${VERB} skill")" || exit $?
```
<!-- pipeline:end decide-bootstrap -->

Non-empty `$ACTIVE` → append-on-resume:

<!-- pipeline:begin decide-resume -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
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

## Phase 0.5 — Resolve business decision axes from the registry (ADR-0036 SD3 / ADR-0027 §5.6)

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
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
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

- `axes[]` — ordered axis descriptors (id, en/ko labels, question, role,
  `gate`) for the resolved preset. `gate: true` marks a **veto gate**
  (규제노출 / 안전리스크) — a hard fail vetoes the option regardless of the
  decisive axes (see `core/skills/decide/SKILL.md` @decide:recommendation-rule).
- `preset_id` — the active preset id (default | compact).
- `size` / `size_explicit` — the resolved ritual tier (minor | standard |
  major). When `--size` was not passed, `size` defaults to `"standard"`.
- `weights` — `Record<string, number>` from `--weights=<spec>`. Empty `{}`
  is the sentinel for "no `--weights` flag" (uniform 1.0 downstream).
- `weights_explicit` — boolean; `true` iff the user passed `--weights`.

If the file is missing or the JSON is unparseable, fall back to the
in-code default preset (the 6-axis business matrix — market-attractiveness
+ unit-economics decisive, regulatory-exposure + safety-risk gates) — the
registry is a graceful-degradation artifact per ADR-0027 §1.6.

---

## Phase 1 — Execute decide

Follow the decide skill's command-invoked mode at
`${CLAUDE_PLUGIN_ROOT}/core/skills/decide/SKILL.md`. The skill performs 2+
business-direction generation, evidence-based comparison across **the axes
resolved in Phase 0.5** (market / unit-economics /
willingness-to-pay / competitive-intensity, plus the regulatory + safety
veto gates), and recommends a direction with explicit rationale. The user
makes the final call.

Decide is single-mode (no `--profile` argument). Business sub-discipline
context flows through the Business Task Profile per
`core/skills/_shared/references/orchestration.md`.

### Privacy gate (before any external call)

<!-- pipeline:begin decide-privacy-gate -->
PRIVACY GATE: proprietary venture concepts, interview/customer data, and unpublished business material
pass an explicit privacy gate before BOTH web search AND peer-host dispatch.
Genericize before the peer prompt; the pre-genericization value MUST never leave the local host.
See `core/skills/investigate/references/business-brief-spec.md` § Privacy Gate.
<!-- pipeline:end decide-privacy-gate -->

<!-- pipeline:begin decide-privacy-no-image -->
No dispatch passes `--image`: the companion peer path has no image channel, so
an image never reaches the peer as bytes.
<!-- pipeline:end decide-privacy-no-image -->

### Ensemble dispatch (Brainstorm point type)

Build the Brainstorm prompt (independent generation of 2-3 business
directions with tradeoffs across the resolved axes), write it as the
block's `prompt.xml` (the steps below), and dispatch in the background. The prompt template (with the
`<axis_awareness>` business-axis block) + synthesis contract live in
`core/skills/_shared/references/ensemble-protocol.md` §Brainstorm; the shape
mirrors the research-scan dispatch in
`core/skills/investigate/references/business-brief-ensemble.md`:

<!-- pipeline:begin decide-dispatch -->
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
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ENSEMBLE_TYPE='brainstorm'
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
  --workflow-path "$ACTIVE" --phase 'decide' \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
```
<!-- pipeline:end decide-dispatch -->

Use `run_in_background: true` on the Bash tool. `peer-runner.mjs run`
records the matching `pending_ensemble` row before spawning the companion
and writes raw peer output under the hidden peer-run ledger. Synthesize:
merge orchestrator + peer direction sets. PEER-ONLY directions → add.
AGREED → elevate confidence. CONFLICT → present both with evidence and ask
the user.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

---

## Phase 2 — State finalize

<!-- pipeline:begin decide-finalize -->
The phase note this step records — fill in every `<…>`. When no run launched
(the privacy gate kept the verb local-only, so no dispatch ran; a run whose
companion is missing did launch, and settles `failed`), its first heading reads
`### Ensemble skipped: decide (privacy gate)` instead, and the synthesis
is local-only:

```markdown
### Ensemble launched: decide at <iso-utc>

### Ensemble synthesis: decide verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Directions compared

<table or list of directions with tradeoffs across the resolved business axes>

### Recommendation

<chosen direction + rationale + gate verdict (regulatory/safety) + risks>

### Active next-action proposal

(per `core/skills/_shared/references/entry-routing-contract.md` § Active Next-Action Proposal — derived from this artifact, not a fixed table)
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — decisive 시장성/단위경제 (market/unit-economics) + the regulatory/safety gate verdict>
- evidence_pointers:     <phase notes / brief / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or $founder:<verb> for a verb; the owner's save and commit for commit; none for done; the owner's decision otherwise>
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
   Compose the planning artifact for the chosen direction
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
`decide-conflict`, with a bounded consensus round proposed before the
owner decides (ADR-0067 Decision 8). The proposal's `selected_next` is the
owner decision, after a bounded consensus round; its `rejected_alternatives`
include "the owner decides now", with the reason for this case (what the two
positions leave unweighed that a round between the peers would weigh); and its
`next_command` is `/runtime:consensus plan --task-file <the task file> --peers
claude,codex --max-rounds 2`, two rounds at most. In the phase note the task
file is spelled from the state root,
`.agentic-plugins/state/founder/consensus/<workflow id>.<run id>.md`; the
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
saves and commits the artifact; founder runs no commit itself) or `done`,
each closing the workflow `summary-complete`. End instead with an owner gate
when the owner must judge, with the judgment under the gate's heading in the
note:

- `decide-conflict` (the `Ensemble synthesis` heading, anchor
  `ensemble-synthesis`): the decision is left to the owner's selection, a
  CONFLICT remained or a veto gate is unresolved; § Owner selection below
  resolves it. A CONFLICT takes the block's conflict branch, which records
  the gate with the run id; an owner selection or a veto uses the
  owner-decision form, with none.
- `scope-routing` (heading `### Routing recommendation`, anchor
  `routing-recommendation`): the request does not belong in this verb or
  workflow; the owner picks the route, then clears the gate.

The owner-decision form below records the gate with the next step in one
write and leaves the workflow open, not terminal, until the owner resolves it.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
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
  --phase-label 'Phase 1: Decide (synthesized)' \
  --phase-note-file "$TEXT_DIR/note.md" \
  --current-phase phase-2-presented \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --event updated || exit $?

# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,
# launched and failed, completed); a refusal stops the block before the last
# write, so the workflow never closes with an attempt left unsettled.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \
  --repo-root "$REPO_ROOT" --workflow-path "$ACTIVE" \
  --host "${AGENTIC_HOST:-claude}" --phase 'decide' --run-id "$RUN_ID" \
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
    --next-step-kind verb --next-step-verb 'compose' \
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
    --owner-gate 'decide-conflict' --owner-gate-anchor ensemble-synthesis \
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
<!-- pipeline:end decide-finalize -->

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

Decide IS the multi-axis verb — the comparison above already renders the
resolved axes. If a *sub-fork* surfaces mid-decision (e.g. two ways to
structure the same direction), keep the lens bounded to the decisive
business axes (시장성 / 단위경제) + the gates rather than re-running the full
matrix.

---

<!-- pipeline:begin decide-owner-selection -->
## Owner selection (decide-conflict)

The `decide-conflict` gate is resolved by the owner's selection (ADR-0063 Q2,
ported by ADR-0066 Decision 9), in either of two ways:

- **In this session**, right after `✓ Decision pending user input`: the user
  picks one of the directions just shown.
- **Later**, when Phase 0's preflight reports a pending `decide-conflict` gate
  (an earlier session stopped on it): present the directions recorded at the
  gate's pointer, the latest `Ensemble synthesis: decide verdict=conflict`
  note, and ask the user to choose instead of running a new comparison. If
  they want a fresh comparison, clear the gate first and run the phases above
  as usual.

Once they choose, write their selection as a file, never into the block: in
shell source a quote, `$`, backtick or line of it would be read as code
(ADR-0059, amendment of 2026-10-10).

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `resolution.txt` in
   that directory, ending with one newline: `Owner selection: ` with the
   direction the owner chose, and why. Nothing deletes it.

Then run the block with `TEXT_DIR` set to that directory; a selection left
unwritten stops it before any write. Inside a `/founder:start` lifecycle the
block clears the gate and stops there: resume the lifecycle, which continues at
its own phase after decide and makes its one terminal write; elsewhere it ends
the verb:

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='founder'
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
# Inside a /start lifecycle the lifecycle owns its phase order, so the clear
# records no next step (the lifecycle's resume clears one anyway) and names the
# resume as the next action; elsewhere the next step is compose. Either way the
# gate's "Owner: …" next action does not outlive the clear.
if [ "$WF_TYPE" = start ]; then
  NEXT_ACTION="Resume /${PERSONA}:start: the lifecycle continues after decide with the selected direction"
  NEXT_STEP=(--clear-next-step true)
else
  NEXT_ACTION='Compose the planning artifact for the chosen direction'
  NEXT_STEP=(--next-step-kind verb --next-step-verb compose --next-step-confidence HIGH)
fi
# One write records the owner's decision, clears the gate and names the next
# step, so the next step never becomes runnable without the decision behind
# it; the block stops if it fails.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate decide-conflict \
  --resolution-file "$TEXT_DIR/resolution.txt" --next-action "$NEXT_ACTION" \
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
  --next-action 'Compose the planning artifact for the chosen direction' \
  --next-step-kind verb --next-step-verb compose \
  --next-step-confidence HIGH || exit $?
```

`awaiting-owner-clear` records `### Owner gate resolved: decide-conflict at
<iso>` with the pointer it cleared and the resolution, and replaces the gate's
next action. It refuses, writing nothing,
when the gate set on the workflow is not `decide-conflict`.
<!-- pipeline:end decide-owner-selection -->

---

## Completion

Output the comparison and one of:

- `✓ Decision recommended.` + chosen direction.
- `✓ Decision pending user input.` — when CONFLICT remained, or a veto
  gate (regulatory / safety) is unresolved. Surface both options with
  evidence; pause until the user selects. Phase 2 ended with the
  owner-decision form of `finish-verb`, which recorded the `decide-conflict`
  gate: record the selection with the Owner selection step above.

Then emit an **Active Next-Action Proposal** (the inline shape in
`core/skills/decide/SKILL.md` § Completion): typical `selected_next` is
`/founder:compose` to produce the planning artifact for the chosen
direction — or `/founder:investigate` if a decisive evidence gap (or an
unresolved gate) surfaced, or `/founder:frame` if deciding reframed the
opportunity. Do not end with a hardcoded "next: X".

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
(founder's manually-published mapping surfaces `publish-needed` when
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
<!-- pipeline:end decide-completion-footer -->
