---
description: Evaluate a business artifact — venture plan, brief, canvas, strategy — across market/unit-economics/gates, or red-team a venture (pre-mortem). Founder's critique verb
argument-hint: --profile=red-team | (default reviews the artifact on hand)
---

# Founder · Critique

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. The peer ensemble
runs automatically (Review point for default, Adversarial-scan point for
`red-team`) — never ask the user whether to invoke the peer, and never
direct them to run companion CLIs manually. When the companions plugin or
peer CLI is unavailable, the ensemble degrades silently to local-only.

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

<!-- pipeline:begin critique-phase-0 -->
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
   directory holding a one-line genericized review target, ending with one newline.
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
VERB='critique'
DEFAULT_PROFILE='default'
# A fresh shell: nothing is carried from the Phase 0 block.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
GIT_BRANCH="$(git branch --show-current)"
GIT_HEAD="$(git rev-parse HEAD)"
STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
# The request, as a file (ADR-0059, amendment of 2026-10-10): the one the
# agent wrote, or the AGENTIC_TOPIC a dispatcher exports, written here to a
# private directory of its own.
REQUEST_FILE="$TEXT_DIR/request.txt"
if [ -n "${AGENTIC_TOPIC:-}" ]; then
  REQUEST_FILE="$(mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX")/topic.txt" || exit 1
  printf '%s\n' "$AGENTIC_TOPIC" > "$REQUEST_FILE" || exit 1
fi
grep -q '[^[:space:]]' "$REQUEST_FILE" 2>/dev/null || { echo "✗ request.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb 'critique' --host "${AGENTIC_HOST:-claude}" --persona 'founder' \
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
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A fresh shell: the workflow is found again here, never carried from an
# earlier block.
PERSONA='founder'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
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
`${CLAUDE_PLUGIN_ROOT}/core/skills/critique/SKILL.md`. Profiles:

- (default) — multi-perspective review of a specific business artifact
  (the venture plan / brief / canvas / strategy on hand) across
  market-attractiveness, unit-economics, willingness-to-pay,
  competitive-intensity, the regulatory + safety veto gates, execution,
  and evidence quality.
- `red-team` — adversarial **pre-mortem** of an entire venture/strategy,
  with a Risk-class sub-focus (market / unit-economics / competitive /
  regulatory / execution / full).

Profile selection: `--profile=<name>` on the command, else inferred from
the user's intent. Missing profile → default. Unknown profile → fallback
to default with a one-line warning.

Validity is the orchestrator's judgment — judge each finding yourself,
drop the invalid ones, surface valid ones by severity. An unmitigated
veto gate (규제노출 / 안전리스크) is CRITICAL by definition. Do NOT fix here —
critique produces findings; `/founder:refine` applies the changes.

### Privacy gate (before any external call)

<!-- pipeline:begin critique-privacy-gate -->
PRIVACY GATE: proprietary venture concepts, interview/customer data, and unpublished business material
pass an explicit privacy gate before BOTH web search AND peer-host dispatch.
Genericize the artifact before the peer prompt; the pre-genericization value MUST never leave the local host.
See `core/skills/investigate/references/business-brief-spec.md` § Privacy Gate.
<!-- pipeline:end critique-privacy-gate -->

<!-- pipeline:begin critique-privacy-no-image -->
No dispatch passes `--image`: the companion peer path has no image channel, so
an image never reaches the peer as bytes.
<!-- pipeline:end critique-privacy-no-image -->

<!-- pipeline:begin critique-scope-prepare -->
### Review scope (document deliverables, C120)

Before the prompt is built, open this critique in the workflow's review
ledger. The block prints the critique's scope as JSON; keep its `ledger` and
`generation` for the close below (ADR-0063, amendment of 2026-10-14).

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A checkout git cannot read (a broken HEAD) is the script's to judge, and
# it falls back: the block hands it this directory instead of stopping.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || REPO_ROOT="$PWD"
# A fresh shell: the workflow is found again here, never carried from an
# earlier block. A failure (no workflow found, an older state.mjs without the
# subcommand, a workflow it cannot read) is no reason to stop the critique: it
# runs as it always has.
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")"
[ -n "$ACTIVE" ] && node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" critique-scope \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" \
  --profile '<profile, empty for the default>' \
  || echo '{"recorded": false, "mode": "full", "reason": "critique-scope-failed"}'
```

- `recorded: false`: the critique runs as it always has, and the close below
  is skipped. The deliverable is not a document — code, prose mixed with code
  or a file that is not a regular one, a change inside a fenced block
  (Markdown can execute), nothing changed since the workflow's baseline — or
  the ledger cannot vouch for it: a baseline that names no commit, a checkout
  it cannot read (a conflicted merge, HEAD moving, an index entry marked
  assume-unchanged or skip-worktree), a checkout on another
  branch, or the block's own failure (`reason` says which). A ledger an
  earlier critique of this workflow left is moved aside
  (`ledger_moved_aside`), so refine reads no findings this critique did not
  judge; on another branch it is left alone.
- `mode: full`: review the whole deliverable, as always. The first critique
  of a document is full, and so is every critique whose scope the ledger
  cannot vouch for: an operation in progress, HEAD or the baseline moved, a
  path added or removed, an edit after the last refine record, no refine
  recorded, a last critique with another profile, a target the ledger does
  not hold, an unreadable ledger, a critique since the last one that the
  ledger never recorded (`unrecorded-critique`: every `append --verb
  critique`, a lifecycle's critique phase included, notes a critique-run
  marker, an older release the `Phase 0: Resume into critique` heading, and
  the ledger counts them), or the
  tree the last critique reviewed no longer readable (`reason` names the
  first condition that failed). A full critique never leaves a finding open by scope: every
  CRITICAL and MAJOR it finds is refine's work.
- `mode: partial`: a profile other than the default. Review as that profile
  always has; its close judges only what it reports, resolves no finding it
  does not, leaves nothing open by scope, and is never the full critique a
  scoped one starts from. The `targets` are a refine's that no critique
  has judged yet: judge each one the lens covers; one it does not report
  stays open and stays a target.
- `mode: scoped`: build the prompt from the ensemble protocol's § Scoped
  re-check (Scoped review), and give local reviewers the same scope: the
  `passages` (each changed block's text now, and `before` it), the `targets`
  the last refine aimed at, and the other open `findings` with their ids.
  Review whether each target is resolved and whether the changed passages
  introduced a problem. A problem seen outside the passages is still reported,
  marked outside.

Whatever the mode, the JSON also names this critique's convergence `round`
(C176, ADR-0063 amendment of 2026-11-09): a recorded critique's is the
ledger's closed critiques plus one; with no ledger it is the critique cap's
count with this run in it (`rounds`, against `limit`). From round 2, sort each
MAJOR finding by the path it lies on: on a frequent, natural path it is
refine's work as before; on a rare one (a hand-made file, a gap of the same
class as one already recorded, a special layout) it is deferred as a known
limit, its severity kept. A CRITICAL, a recurring finding, a contested one
(a peer conflict) and one a veto gate raised are never deferred. With a ledger
the close below decides each deferral; with none (`recorded: false`, a code
deliverable) the note applies the same rule, listing such a finding under
`### Known limits (deferred)` instead of handing it to refine.
<!-- pipeline:end critique-scope-prepare -->

### Ensemble dispatch (Review point for default; Adversarial-scan point for red-team)

Build the peer prompt per `core/skills/_shared/references/ensemble-protocol.md`
(§Review for the default profile, §Adversarial-scan + the Risk-class
sub-focus text for `red-team`), write it as the block's `prompt.xml`
(the steps below), and dispatch in the background. The peer receives the **genericized** artifact (default)
or venture scope (red-team) and returns findings; the privacy gate must
have passed first. The block dispatches `review`, the default profile's
point type: for `--profile=red-team`, set `ENSEMBLE_TYPE='adversarial-scan'`
in it before running it, and build the prompt from §Adversarial-scan.

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

3. When this ensemble is a review (`plan-verify`, `review`,
   `adversarial-scan`, `refine-verify`), with your file-writing tool create
   `subject.json` in that directory: what you put in the reviewer's subject,
   `{"shown": [...], "covered": [...]}`, each a list of repository-relative
   paths (ADR-0069 Decision 1, item 6). `shown` is every path the prompt shows;
   `covered`, those it shows at the content the working tree holds now. A
   critique of the pending change covers its staged and unstaged hunks' paths
   and the untracked files it embeds; one of the entire branch shows the
   committed `HEAD`, so a path also dirty in the checkout is in `shown` only; a
   refine-verify shows its patch's paths; a scoped pass, its passages' paths,
   a deleted passage's included; an adversarial scan, the files it collected in
   scope; a plan held outside the tree, none, so both lists are empty. A review
   with no such file is unbound, and vouches for nothing it saw.

Then run the block with `TEXT_DIR` set to that directory; a prompt left
unwritten stops it before the dispatch. Keep the directory: the runner writes
its result there, `prompt.xml.run.json`, and the finalize block reads the run's
id from that file (its `DISPATCH_DIR`), never from this block's shell.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ENSEMBLE_TYPE='review'
# A fresh shell: the workflow is found again here, never carried from an
# earlier block.
PERSONA='founder'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch; nothing was dispatched." >&2; exit 1; }
# The prompt the agent wrote with its file tool: the runner reads it, so no
# line of it is shell source. A prompt left unwritten stops the block here.
PROMPT_FILE="$TEXT_DIR/prompt.xml"
grep -q '[^[:space:]]' "$PROMPT_FILE" 2>/dev/null || { echo "✗ prompt.xml in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was dispatched." >&2; exit 1; }
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch, allocated by the
# runner; an allocation that prints nothing stops the block too.
RUN_ID="$(node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" new-run-id --prefix "$ENSEMBLE_TYPE")" || RUN_ID=''
[ -n "$RUN_ID" ] || { echo "✗ peer-runner.mjs new-run-id allocated no run id for $ENSEMBLE_TYPE (its error, if any, is above); nothing was dispatched." >&2; exit 1; }
# The dispatch's own record of the run it launches and the workflow it found,
# written before the launch: the finalize settles that run from it when the
# runner ends without writing its result (R4 F1).
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({run_id:process.argv[2],workflow_path:process.argv[3]})+"\n")' "$PROMPT_FILE.dispatch.json" "$RUN_ID" "$ACTIVE" \
  || { echo "✗ Could not record the dispatch in TEXT_DIR ($TEXT_DIR); nothing was dispatched." >&2; exit 1; }
# ADR-0069 Decision 1, item 6 — the subject the agent wrote, for a review,
# passed only to a peer-runner that names the flag (an older one does not), as
# positional parameters: the block runs in any POSIX shell, which has no arrays.
set --
if [ -f "$TEXT_DIR/subject.json" ] && grep -q -e "'--subject-file'" "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" 2>/dev/null; then
  set -- --subject-file "$TEXT_DIR/subject.json"
fi
# Run this block as a host background task (on Claude, the Bash tool's
# run_in_background), never with a trailing `&`: the host tracks the runner
# and notifies you when it exits, where a shell `&` would detach it from both.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase 'critique' \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \
  "$@" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
```
<!-- pipeline:end critique-dispatch -->

Use `run_in_background: true` on the Bash tool. `peer-runner.mjs run`
records the matching `pending_ensemble` row before spawning the companion
and writes raw peer output under the hidden peer-run ledger. Synthesize
per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT; deduplicate by
section/claim and take the higher severity on a duplicate.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

<!-- pipeline:begin critique-scope-close -->
### Review ledger close (document deliverables, C120)

When `critique-scope` recorded this critique (`recorded: true`), close it
after the synthesis and before Phase 2, whatever the verdict. Write the
findings with your file-writing tool, not the shell, as `findings.json` in a
new `mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"` directory:

```json
{"findings": [
  {"id": "G1-F2", "verdict": "resolved"},
  {"id": "NEW", "severity": "MAJOR", "location": "docs/x.md:12-14",
   "text": "what is wrong and why", "scope": "outside"}
]}
```

Every synthesized finding is there: a new one as `NEW` with its severity
(CRITICAL, MAJOR, MINOR or SUGGESTION), its location as `path:line` or
`path:start-end` in the current text, the path as the artifact set spells
it, its text, and in a scoped critique `scope` `in` or `outside` the passages
(a location in a passage is in, whatever the mark, and a finding with no
location, or one on a path the artifact set does not hold, counts in); a ledger
finding judged again by its id, with `verdict` `resolved` or `unresolved`. In a scoped critique every
target needs one verdict: a target with none, or with two, stays open.
From round 2 (C176), a MAJOR on a rare path carries `defer`, its known limit
in one line (`"defer": "only a hand-made file reaches it"`); a finding a peer
contested carries `conflict: true`, and one a veto gate raised `veto: true`,
which stay on it for every later critique.

```bash
TEXT_DIR='<directory holding findings.json>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A checkout git cannot read (a broken HEAD) is the script's to judge, and
# it falls back: the block hands it this directory instead of stopping.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || REPO_ROOT="$PWD"
# A fresh shell: the workflow is found again here, never carried from an
# earlier block. A refusal, or no workflow found, records nothing and is no
# reason to stop the critique: the fallback below says so, and the bullets say
# what follows.
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")"
[ -n "$ACTIVE" ] && node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" critique-close \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" \
  --ledger '<ledger from critique-scope>' \
  --generation '<generation from critique-scope>' \
  --findings-file "$TEXT_DIR/findings.json" \
  || echo '{"closed": false, "reason": "critique-close-refused"}'
```

It prints the disposition, which Phase 2 follows:

- The note's `### Findings` gives each finding its ledger id, and a
  `### Critique scope` section states the mode, its reason and the
  generation. Findings in `left_open` go under `### Left open`: new findings
  other than CRITICAL that a scoped critique saw outside the passages, the
  owner's to weigh when the work lands, never refine's.
- `deferred_now` are the findings this close deferred: they go under
  `### Known limits (deferred)`, each with its id, severity and known limit,
  and are no refine work. `deferral_refused` names each deferral asked for
  and refused, with its reason (`round`, `critical`, `not-major`,
  `recurring`, `veto`, `conflict` or `ambiguous`): that finding stays open,
  refine's work. A later critique that does not report a deferred finding
  leaves it deferred; one that reports it with no `defer` opens it again.
- `converged: true` (no CRITICAL or MAJOR open in the ledger) puts the
  proposal on the commit route only when nothing else this runbook names
  stands in the way: a `conflict` verdict still ends on its gate first, and a
  persona's own conditions (a veto, a gate verdict, a required re-render)
  still hold. Otherwise refine's work is `carry`, every CRITICAL and MAJOR
  open in the ledger, targeted before or not.
- `closed: false`: the close refused (its error is above) and recorded
  nothing. It refuses when the checkout no longer holds the tree the critique
  reviewed, or the ledger was replaced since the critique opened: run
  `critique-scope` again and review what is there now. A
  finding id the ledger does not hold, or a malformed finding, refuses too;
  fix the file and run the block again. A critique left unclosed counts as a
  full one the ledger did not record: every CRITICAL and MAJOR it found is
  refine's work, nothing is left open by scope, and it never converges by
  the ledger. Until a later critique closes, the ledger vouches for nothing:
  `review-status` reads no ledger, `refine-record` records nothing, and the
  next critique is full.
<!-- pipeline:end critique-scope-close -->

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

Gate verdict: 규제노출 <PASS|COND|FAIL> · 안전리스크 <PASS|COND|FAIL>
<CRITICAL / MAJOR / MINOR / SUGGESTION findings by section/claim;
 'Looks Strong' observations at the end>

### Active next-action proposal

(per `core/skills/_shared/references/entry-routing-contract.md` § Active Next-Action Proposal — derived from this artifact, not a fixed table)
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + the gate verdict>
- evidence_pointers:     <finding sections / artifact path — pointers only>
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
   Refine the artifact to address the findings
   ```

   Write another when the verb's result selects a different next step, and
   for an owner gate below `Owner: ` and the judgment in a few words. Each
   file holds its text as written and ends with one newline, which the
   scripts remove; nothing deletes the files.

Then run the block with its values set:

- `TEXT_DIR`: that directory, a fresh one for each finalize: the block keeps
  there the run it settles (`finalize-run.json`), and a rerun in it must name
  that same run.
- `DISPATCH_DIR`: the directory the dispatch block ran with; the block reads
  the run's id from the result the runner wrote there, `prompt.xml.run.json`.
  Leave it empty when no run launched (the verb ran local-only, or the
  dispatch's `prompt.xml.err` says why). When a run launched but that
  directory is gone, set it to the run's own ledger directory, the one holding
  the `envelope.json` the synthesis read
  (`.agentic-plugins/state/founder/peer-runs/<run id>`).
  When settle refuses an empty `DISPATCH_DIR` because a run of this phase is
  pending or unsettled, do not settle that run by hand, as its message reads,
  while its answer can be read: collect the run and synthesize it, then set
  `DISPATCH_DIR` to its directory (its ledger directory when that is gone)
  and finalize from a fresh `TEXT_DIR`, since this one keeps the empty id.
  Only with neither directory left is it settled by hand, as the reference
  says.
- `VERDICT`: the synthesis's verdict.
- `CONFIDENCE`: the proposal's confidence (`HIGH`, `MEDIUM` or `LOW`).
- `NO_RUN_REASON`: empty when a run launched. When none did, why:
  `peer-unavailable` (the companion or the peer's CLI was not found, or could
  not run, before any run), `local-only` (the verb ran without a peer by
  design), `privacy-gate` (the prompt could not be made safe to send) or
  `owner-skip` (the owner chose no review). With no run launched, a review
  still says what its local reviewers read: with your file-writing tool create
  `subject.json` in the text directory, as the dispatch's step says
  (`{"shown": [...], "covered": [...]}`); with no such file the attempt covers
  no path.
- `ATTEMPT_TYPE`: the ensemble type the dispatch block ran with, or would have
  run with: its `ENSEMBLE_TYPE`, the default this block names unless the
  dispatch's prose said to set another (critique's adversarial profiles set
  `adversarial-scan`).

`peer-runner.mjs settle`, the block's first write, decides from the run ledger
what the workflow records: a run that launched and failed records `failed`
whatever `VERDICT` says, and a completed run whose answer was empty or
unreadable records `degraded`.
An answer that parses to nothing usable, only structural
shell, reads to `settle` like any other, so set `VERDICT` to `degraded` then.
Every check before settle stops the block with nothing written, and its
message says what to set.

Read `core/skills/_shared/references/verb-finalize.md`, the section named for
what you see, only when the step is not the plain one: the block stopped and
its message does not settle what to do; the dispatch's directory is gone, or
the run is still live; you run the block a second time after it wrote; or you
need the reason a step of the block is as it is. A normal step reads none of
it.

A synthesis verdict of `conflict` ends this verb on its conflict gate,
`peer-conflict`, with a bounded consensus round proposed before the
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

Whenever `VERDICT` is `conflict`, write the contested items before you run
the block, with the file tool, as `contested.md` in the `TEXT_DIR` directory:
each CONFLICT item with both positions and their evidence, prepared as the
peer prompt was, since the consensus peers read it. They come from the peers'
positions, so never put them in the block: there the shell would read a line
of them as a command. With `VERDICT` set to `conflict`, a `contested.md`
missing, blank or not UTF-8 text stops the block before any write. The block
writes them to the task file (`consensus-task`), then appends the note and
records the gate with the run id in the same write as the next step
`owner-decision`. Nothing runs the consensus round: the owner does, then
rules, and clearing the gate retires the task file. When the block stops on a
conflict (the recorded verdict and `VERDICT` disagree, a conflict gate is
pending, or an earlier conflict of this phase has no ruling), its message says
what to set, and the reference's § A conflict says why.

An owner gate named in `OWNER_GATE`, where the block has one, beside `VERDICT`
`conflict` stops the block before any write: the conflict ends on its own
gate.

The last write, `finish-verb`, records the proposal's next step in closed-enum
form: `--next-step-kind` `verb` (with `--next-step-verb`), `commit` (the owner
saves and commits the artifact; founder runs no commit itself) or `done`,
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
DISPATCH_DIR='<the directory the dispatch block ran with; empty when no run launched; the run ledger directory when a run launched and that directory is gone>'
VERDICT='<the synthesis verdict>'
CONFIDENCE='<HIGH|MEDIUM|LOW>'
# Why no run launched (peer-unavailable, local-only, privacy-gate or
# owner-skip); empty when a run launched.
NO_RUN_REASON=''
# The ensemble type the dispatch ran with, or would have (its ENSEMBLE_TYPE).
ATTEMPT_TYPE='review'
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A fresh shell: the workflow and the run are found again here, never carried
# from an earlier block.
PERSONA='founder'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch; nothing was written." >&2; exit 1; }
case "$VERDICT" in
  ''|*'<'*) echo "✗ VERDICT is not set to the synthesis verdict; nothing was written." >&2; exit 1 ;;
esac
# The last write's confidence, checked before settle, the first write.
case "$CONFIDENCE" in
  HIGH|MEDIUM|LOW) ;;
  *) echo "✗ CONFIDENCE is not HIGH, MEDIUM or LOW, the proposal's confidence the last write records; nothing was written." >&2; exit 1 ;;
esac
# C163 A1a — why no run launched, which settle records for a review's attempt.
case "$NO_RUN_REASON" in
  ''|peer-unavailable|local-only|privacy-gate|owner-skip) ;;
  *) echo "✗ NO_RUN_REASON is not peer-unavailable, local-only, privacy-gate or owner-skip (empty when a run launched); nothing was written." >&2; exit 1 ;;
esac
# The runner's grammar for a type: a lowercase letter, then up to 40
# lowercase letters or hyphens, spelled out (a range follows the locale).
case "$ATTEMPT_TYPE" in
  ''|[!abcdefghijklmnopqrstuvwxyz]*|*[!abcdefghijklmnopqrstuvwxyz-]*|??????????????????????????????????????????*) echo "✗ ATTEMPT_TYPE is not an ensemble type (the dispatch's ENSEMBLE_TYPE); nothing was written." >&2; exit 1 ;;
esac
# The run's id, from the result the runner wrote beside the dispatch's prompt
# or, when DISPATCH_DIR is the run's own ledger directory, from its
# handle.json. Exit 5: an empty DISPATCH_DIR, the empty id, no run launched.
# Exit 2: the handle names another workflow. Exit 3: the handle cannot be read
# as the run's. Exit 4: the result is empty or the handle gone, so the
# dispatch's own record decides (its id printed). Exit 1: no result, or no
# well-formed run id.
RUN_ID="$(node -e 'const [d,w]=process.argv.slice(1);if(d==="")process.exit(5);const fs=require("fs"),p=require("path");const good=(v)=>typeof v==="string"&&/^[A-Za-z0-9._:-]+$/.test(v)&&!v.includes("..");const same=(a,b)=>{try{return fs.realpathSync(a)===fs.realpathSync(b)}catch{return p.resolve(a)===p.resolve(b)}};const bound=(h,id)=>{if(h===null||typeof h!=="object"||h.run_id!==id)process.exit(3);if(typeof h.workflow_path!=="string"||!same(h.workflow_path,w))process.exit(2);process.stdout.write(id);process.exit(0)};let t,r,h;try{t=fs.readFileSync(p.join(d,"prompt.xml.run.json"),"utf8")}catch(e){if(!(e&&e.code==="ENOENT"))process.exit(1);try{h=fs.readFileSync(p.join(d,"handle.json"),"utf8")}catch(e){process.exit(e&&(e.code==="ENOENT"||e.code==="ENOTDIR")?1:3)}const id=p.basename(p.resolve(d));if(!good(id))process.exit(1);try{h=JSON.parse(h)}catch{process.exit(3)}bound(h,id)}if(t.trim()==="")process.exit(4);try{r=JSON.parse(t)}catch{process.exit(1)}const id=r&&r.run_id;if(!good(id))process.exit(1);try{h=fs.readFileSync(r.handle_path,"utf8")}catch(e){if(e&&e.code==="ENOENT"){process.stdout.write(id);process.exit(4)}process.exit(3)}try{h=JSON.parse(h)}catch{process.exit(3)}bound(h,id)' "$DISPATCH_DIR" "$ACTIVE")"
RUN_READ=$?
if [ "$RUN_READ" -eq 2 ]; then
  echo "✗ The run in DISPATCH_DIR ($DISPATCH_DIR) is not one of $ACTIVE: its handle names another workflow, or none (a peer-now or manual run, dispatched for no workflow); nothing was written. Finalize on the branch whose workflow the dispatch ran for; a run dispatched for no workflow is not this finalize's to settle." >&2
  exit 1
elif [ "$RUN_READ" -eq 3 ]; then
  echo "✗ The handle of the run in DISPATCH_DIR ($DISPATCH_DIR) cannot be read as that run's, so the run cannot be bound to $ACTIVE; nothing was written." >&2
  exit 1
elif [ "$RUN_READ" -eq 4 ]; then
  # The run the dispatch recorded before the launch (prompt.xml.dispatch.json),
  # for the workflow found above only; a run the result names must be that one.
  RUN_ID="$(node -e 'const [d,w,named]=process.argv.slice(1);const fs=require("fs"),p=require("path");const same=(a,b)=>{try{return fs.realpathSync(a)===fs.realpathSync(b)}catch{return p.resolve(a)===p.resolve(b)}};let m;try{m=JSON.parse(fs.readFileSync(p.join(d,"prompt.xml.dispatch.json"),"utf8"))}catch{process.exit(1)}const id=m&&m.run_id;if(typeof id!=="string"||!/^[A-Za-z0-9._:-]+$/.test(id)||id.includes("..")||(named!==""&&named!==id))process.exit(1);if(typeof m.workflow_path!=="string"||!same(m.workflow_path,w))process.exit(2);process.stdout.write(id)' "$DISPATCH_DIR" "$ACTIVE" "$RUN_ID")"
  case $? in
    0) ;;
    2) echo "✗ The run in DISPATCH_DIR ($DISPATCH_DIR) was dispatched for another workflow than $ACTIVE; nothing was written. Finalize on the branch whose workflow the dispatch ran for." >&2; exit 1 ;;
    *) echo "✗ The runner left no usable result in DISPATCH_DIR ($DISPATCH_DIR), and prompt.xml.dispatch.json there is missing, malformed or names another run; nothing was written. When the run launched, set DISPATCH_DIR to its ledger directory, the one holding the envelope.json the synthesis read, and run this block again; with no ledger directory either, settle the run by hand (peer-runner.mjs settle --run-id), then run this block with DISPATCH_DIR empty from a fresh TEXT_DIR. When the runner refused before any ledger (prompt.xml.err says why), no run launched: leave DISPATCH_DIR empty." >&2; exit 1 ;;
  esac
elif [ "$RUN_READ" -eq 5 ]; then
  # No run launched: the empty id, which settle accepts only when no attempt
  # of this phase is open.
  :
elif [ "$RUN_READ" -ne 0 ]; then
  echo "✗ prompt.xml.run.json in DISPATCH_DIR ($DISPATCH_DIR) is missing or names no well-formed run id, and DISPATCH_DIR is no run ledger directory; nothing was written. Set DISPATCH_DIR to the directory the dispatch block ran with; leave it empty when no run launched (prompt.xml.err there says why), or, when a run launched and that directory is gone, set it to the run's ledger directory, the one holding the envelope.json the synthesis read." >&2
  exit 1
fi
# The run this block settles is kept in TEXT_DIR (finalize-run.json) before
# settle, the empty id too, so a rerun settles the same run. Exit 3: another
# run was kept. Exit 7: the record is malformed, or of another workflow or
# phase.
KEPT_ID="$(node -e 'const [rec,id,w,ph]=process.argv.slice(1);const fs=require("fs"),p=require("path");const good=(v)=>typeof v==="string"&&(v===""||/^[A-Za-z0-9._:-]+$/.test(v)&&!v.includes(".."));const same=(a,b)=>{try{return fs.realpathSync(a)===fs.realpathSync(b)}catch{return p.resolve(a)===p.resolve(b)}};let m,has=true;try{m=JSON.parse(fs.readFileSync(rec,"utf8"))}catch(e){if(!(e&&e.code==="ENOENT"))process.exit(7);has=false}if(has&&(!m||!good(m.run_id)||m.phase!==ph||typeof m.workflow_path!=="string"||!same(m.workflow_path,w)))process.exit(7);if(has&&m.run_id!==id){process.stdout.write(m.run_id);process.exit(3)}if(!has){try{fs.writeFileSync(rec,JSON.stringify({run_id:id,workflow_path:w,phase:ph})+"\n")}catch{process.exit(8)}}process.stdout.write(id);process.exit(0)' "$TEXT_DIR/finalize-run.json" "$RUN_ID" "$ACTIVE" 'critique')"
case $? in
  0) ;;
  3) echo "✗ finalize-run.json in TEXT_DIR ($TEXT_DIR), left by an earlier run of this block, keeps run '$KEPT_ID', not '$RUN_ID'; nothing was written. Use a fresh TEXT_DIR for each finalize." >&2; exit 1 ;;
  7) echo "✗ finalize-run.json in TEXT_DIR ($TEXT_DIR), left by an earlier run of this block, is malformed or names another workflow or phase than this one of $ACTIVE; nothing was written. Use a fresh TEXT_DIR for each finalize." >&2; exit 1 ;;
  8) echo "✗ Could not keep the run in TEXT_DIR ($TEXT_DIR) as finalize-run.json; nothing was written." >&2; exit 1 ;;
  *) echo "✗ Could not check finalize-run.json in TEXT_DIR ($TEXT_DIR); nothing was written." >&2; exit 1 ;;
esac
# The texts the agent wrote with its file tool (ADR-0059, amendment of
# 2026-10-10), each held to every reader's rule before any write: strict
# UTF-8, no NUL byte, and text left once blanks are trimmed.
for TEXT_FILE in note.md summary.txt next-action.txt; do
  node -e 'let t;try{t=new TextDecoder("utf-8",{fatal:true}).decode(require("fs").readFileSync(process.argv[1]))}catch{process.exit(1)}process.exit(t.includes("\0")||t.trim()===""?1:0)' "$TEXT_DIR/$TEXT_FILE" || { echo "✗ $TEXT_FILE in TEXT_DIR ($TEXT_DIR) is missing, blank or not UTF-8 text; write it with the file tool first. Nothing was written." >&2; exit 1; }
done
# The contested items a conflict ends on, from contested.md, held to the same
# rule here: a conflict without them would stop after the settle, before the
# gate.
if [ "$VERDICT" = conflict ]; then
  node -e 'let t;try{t=new TextDecoder("utf-8",{fatal:true}).decode(require("fs").readFileSync(process.argv[1]))}catch{process.exit(1)}process.exit(t.includes("\0")||t.trim()===""?1:0)' "$TEXT_DIR/contested.md" || { echo "✗ contested.md in TEXT_DIR ($TEXT_DIR) is missing, blank or not UTF-8 text; a conflict needs the contested items: write them with the file tool first. Nothing was written." >&2; exit 1; }
fi
# The run id where the later steps of this variant read it: state.mjs's
# parser takes a value opening with "--" as a flag, and a conflict's run id
# names its task file and its gate (state.mjs isSafeConsensusRunId).
case "$RUN_ID" in
  --*) echo "✗ Run id '$RUN_ID' opens with '--', which state.mjs reads as a flag; nothing was written. Settle the run by hand (peer-runner.mjs settle --run-id), then run this block with DISPATCH_DIR empty from a fresh TEXT_DIR." >&2; exit 1 ;;
esac
if [ "$VERDICT" = conflict ] && [ -n "$RUN_ID" ]; then
  node -e 'process.exit(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(process.argv[1])?0:1)' "$RUN_ID" || { echo "✗ VERDICT is conflict, but run id '$RUN_ID' cannot name a consensus task file or a gate (a letter or digit, then letters, digits, _ and -, 128 at most, as the runbook's dispatch makes them); nothing was written. Dispatch the review again with the runbook's dispatch block, settle this run by hand (peer-runner.mjs settle --run-id), and finalize the new run." >&2; exit 1; }
fi
# R4 K2, L1, L2 — the conflict itself holds the phase, from the workflow's
# own record, read before settle: every result this phase recorded, and the
# gate. HOLD is empty, or names what holds the finish: this verb's pending
# conflict gate (gate), a conflict with no ruling (its run id), or one whose
# id could never name a gate (owner). A read that fails, or prints no
# workflow, stops the block too.
WF_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE")" \
  || { echo "✗ Could not read the results recorded on $ACTIVE; nothing was written." >&2; exit 1; }
HOLD="$(printf '%s' "$WF_JSON" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const [w,ph,g,run,v]=process.argv.slice(1);const fs=require("fs"),p=require("path");let o;try{o=JSON.parse(s)}catch{process.exit(1)}if(o===null||typeof o!=="object")process.exit(1);const safe=(id)=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);const named=(id)=>id===""?"(no id)":id;if(o.awaiting_owner_gate===g){const gr=typeof o.awaiting_owner_run_id==="string"?o.awaiting_owner_run_id:"";if(gr===""||run!==gr||v!=="conflict")process.stdout.write("gate "+named(gr));process.exit(0)}const held=(Array.isArray(o.ensemble_results)?o.ensemble_results:[]).filter((e)=>e&&e.phase===ph&&e.verdict==="conflict").map((e)=>typeof e.run_id==="string"?e.run_id:"").filter((id)=>!(safe(id)&&typeof o.workflow_id==="string"&&fs.existsSync(p.join(p.dirname(p.dirname(w)),"consensus",o.workflow_id+"."+id+".resolved.md"))));if(held.length===0||(v==="conflict"&&run!==""&&held.includes(run)))process.exit(0);const owner=held.find((id)=>!safe(id));process.stdout.write(owner===undefined?"conflict "+held[0]:"owner "+named(owner))})' "$ACTIVE" 'critique' 'peer-conflict' "$RUN_ID" "$VERDICT")" \
  || { echo "✗ The read of $ACTIVE printed no workflow; nothing was written." >&2; exit 1; }
HELD_RUN="${HOLD#* }"
case "$HOLD" in
  '') ;;
  'gate (no id)')
    echo "✗ This verb's conflict gate is pending and names no run: until the owner rules on it, no run of this block can finish the verb. The owner resolves the gate first; nothing was written." >&2
    exit 1 ;;
  gate\ *)
    echo "✗ This verb's conflict gate is pending for run $HELD_RUN: until the owner rules on it, only that run, finalized again with VERDICT conflict, can run this block, so VERDICT $VERDICT for run '$RUN_ID' cannot. The owner resolves the gate first; nothing was written." >&2
    exit 1 ;;
  owner\ *)
    echo "✗ Run $HELD_RUN is recorded in this phase with the verdict conflict, and no owner ruling names it: a recorded conflict ends on its gate. Its id cannot name a consensus task file or a gate (a letter or digit, then letters, digits, _ and -, 128 at most), so no run of this block can end it on its gate: the conflict is the owner's to decide, outside this block. Nothing was written." >&2
    exit 1 ;;
  *)
    echo "✗ Run $HELD_RUN is recorded in this phase with the verdict conflict, and no owner ruling names it: a recorded conflict ends on its gate, so only that run, finalized with VERDICT conflict, can finish the verb, not VERDICT $VERDICT for run '$RUN_ID'. Finalize that run first: set DISPATCH_DIR to its directory, or to its ledger directory when that is gone, VERDICT to conflict, write contested.md, and run this block from a fresh TEXT_DIR. Nothing was written." >&2
    exit 1 ;;
esac

# C163 A1a — the review attempt of a run that never launched: its type, why,
# and the key its id derives from, passed only to a peer-runner that names
# these flags, as the positional parameters settle takes last ("$@").
set --
if grep -q -e "'--no-run-reason'" "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" 2>/dev/null; then
  set -- --ensemble-type "$ATTEMPT_TYPE" --no-run-reason "$NO_RUN_REASON" --attempt-key "$TEXT_DIR"
fi
# ADR-0069 Decision 1, item 6 — with no run launched, what the local reviewers
# read, when the agent wrote it (subject.json in TEXT_DIR, as the dispatch's).
if [ -f "$TEXT_DIR/subject.json" ] && grep -q -e "'--subject-file'" "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" 2>/dev/null; then
  set -- "$@" --subject-file "$TEXT_DIR/subject.json"
fi
# ADR-0066 PC2b — settle the ensemble attempt from its ledger: the first write
# and the one judge of the run. Its refusal stops the block before any write.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \
  --repo-root "$REPO_ROOT" --workflow-path "$ACTIVE" \
  --host "${AGENTIC_HOST:-claude}" --phase 'critique' --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" "$@" || exit $?

# ADR-0067 Decision 8 — the verdict the settle above recorded for the run
# (empty when it recorded none), read before the phase note: a mismatch stops
# the block with the settle its only write. A recorded conflict writes the
# contested items as the consensus task file and ends on the conflict gate,
# bound to its run. Any other verdict makes the typical last write.
RECORDED="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-verdict \
  --workflow-path "$ACTIVE" --run-id "$RUN_ID")" || exit $?
if [ "$RECORDED" = conflict ] && [ "$VERDICT" = conflict ]; then
  # The contested items, from contested.md, written with the file tool: the
  # shell never reads them, so no line of them runs as a command. A file
  # missing stops the block before the note; consensus-task refuses an empty
  # one.
  CONTESTED_FILE="$TEXT_DIR/contested.md"
  [ -f "$CONTESTED_FILE" ] || { echo "✗ contested.md in TEXT_DIR ($TEXT_DIR) is missing; the phase note and the gate were not recorded. Write it with the file tool and run this block again." >&2; exit 1; }
  # The task file, once the settle above recorded the run with the verdict
  # conflict; it prints the consensus round the proposal selects. Written
  # again on a later run of the block, it is replaced whole.
  PROPOSED="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" consensus-task \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --run-id "$RUN_ID" \
    --text-file "$CONTESTED_FILE")" \
    || { echo "✗ The consensus task file for run $RUN_ID was not written; the phase note and the gate were not recorded. Run this block again with the same TEXT_DIR and DISPATCH_DIR: its settle records nothing more for the run." >&2; exit 1; }
elif [ "$RECORDED" = conflict ]; then
  echo "✗ Run $RUN_ID is recorded with the verdict conflict (an earlier run of this block settled it), but VERDICT is $VERDICT: a recorded conflict ends on its gate. Set VERDICT to conflict, write contested.md, and run this block again with the same DISPATCH_DIR. The settle aside, nothing was written." >&2
  exit 1
elif [ "$VERDICT" = conflict ] && [ -z "$RUN_ID" ]; then
  echo "✗ VERDICT is conflict, but DISPATCH_DIR names no run, so no conflict is recorded for a consensus round. Set DISPATCH_DIR to the directory the dispatch block ran with, or to the run's ledger directory when that is gone, and run this block again from a fresh TEXT_DIR. Nothing was written." >&2
  exit 1
elif [ "$VERDICT" = conflict ]; then
  echo "✗ VERDICT is conflict, but run $RUN_ID is recorded with ${RECORDED:-no verdict}: a consensus round needs a recorded conflict. Set VERDICT to ${RECORDED:-the recorded verdict}, rewrite the synthesis heading of note.md to that verdict, and run this block again with the same TEXT_DIR and DISPATCH_DIR: its settle records nothing more for the run. The settle aside, nothing was written." >&2
  exit 1
fi

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label 'Phase 1: Critique (synthesized)' \
  --phase-note-file "$TEXT_DIR/note.md" \
  --current-phase phase-2-presented \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --event updated || exit $?

if [ "$RECORDED" != conflict ]; then
  # ADR-0029 §1 / completion-output contract §2 — next-action.txt, which the
  # append above and this terminal write record, holds the COMPACT form of the
  # proposal above. Step 2 shows the typical-case default; write
  # another, and change the --next-step-* flags, when the verb's result
  # selects a different next step (e.g. the owner's save and commit).
  # ADR-0063 D3 — finish-verb is the verb's last write: the ADR-0017
  # §sub-decision 5 atomic terminal write (summary-complete + terminal marker)
  # with the next step. ADR-0066 Decision 3: an inherited AGENTIC_AUTOPILOT
  # changes nothing here.
  # ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
  # archive gates are evaluated at the end of THIS turn, not at session close.
  # Clearing the marker with `--terminal-marker false` works only before that
  # Stop fires. On Codex the Stop hook runs only once the operator has trusted
  # the plugin hooks (`/hooks`), so evaluation waits for that. Full contract:
  # core/skills/_shared/references/session-handoff.md § Archive timing.
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --next-action-file "$TEXT_DIR/next-action.txt" \
    --next-step-kind verb --next-step-verb 'refine' \
    --next-step-confidence "$CONFIDENCE" || exit $?
else
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
    --next-step-kind owner-decision --next-step-confidence "$CONFIDENCE" \
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
#   --next-step-kind owner-decision --next-step-confidence "$CONFIDENCE" \
#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' || exit $?
```
<!-- pipeline:end critique-finalize -->

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If critique surfaces a **genuine 2+-branch decision point** — two viable
remediation directions, or two severity reads of the same finding —
surface a **compact multi-axis lens** across the decisive business axes
(시장성 / 단위경제) + the veto gates, instead of a flat list, reading
`core/skills/decide/references/decision-axes.yml` (the
`scripts/decide-registry.mjs resolve --size=minor` compact 4-axis set).
Bounded: only at a genuine 2+-branch point, never the full matrix for a
trivial reversible step. A weightier fork should route to
`/founder:decide`.

---

## Completion

Output the review report (summary + gate verdict + findings by severity)
and one of:

- `✓ Critique complete.` + the artifact reviewed.
- `✓ Critique paused (veto-grade finding).` — when an unmitigated
  regulatory / safety gate or a fatal flaw warrants user input before
  proceeding.

Then emit an **Active Next-Action Proposal** (the inline shape in
`core/skills/critique/SKILL.md` § Completion): typical `selected_next` is
`/founder:refine` to address selected findings — or `/founder:decide`
when a finding opens a genuine fork, or `/founder:investigate` when a
finding rests on a load-bearing claim that needs evidence. Do not end
with a hardcoded "next: X".

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
<!-- pipeline:end critique-completion-footer -->
