---
description: Sequence a business deliverable end-to-end — investigate → frame → decide → compose → critique → refine with approval gates. Founder's single-deliverable lifecycle macro
argument-hint: <one-line business topic> (single-pass; for a multi-deliverable program use the orchestrator persona)
---

# Founder · Start

$ARGUMENTS

`/founder:start` is the founder plugin's **single-deliverable lifecycle
macro** (ADR-0020/0021, ADR-0036 SD2). It sequences the six founder verbs —
investigate → frame → decide → compose → critique → refine — into one pass
with user-approval gates at the direction (Phase 1) and the plan (Phase 2),
producing a reviewed business planning artifact. It is single-pass; for a
multi-deliverable program use the orchestrator persona.

**Cognitive runbook + the Host-availability matrix live in
`${CLAUDE_PLUGIN_ROOT}/core/skills/start/SKILL.md`** per ADR-0021. This command
file owns the Claude-host Phase 0 bootstrap bash; the per-phase cognitive
description, approval-gate prompts, and the privacy gate delegate to
SKILL.md.

> **founder is not an orchestrator dispatch target** (ADR-0036 Non-Goal 3):
> this command does NOT read `AGENTIC_PARENT_WORKFLOW` /
> `AGENTIC_ORIGINATING_SUBTASK`, and founder `state.mjs create` rejects
> parent-linkage flags at the CLI. `start` sequences founder's own verbs
> in-place; it never transits cross-plugin boundaries.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_FOUNDER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

---

## Phase 0 — Bootstrap (continuity + clean-baseline gate)

<!-- pipeline:begin start-phase-0 -->
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
<!-- pipeline:end start-phase-0 -->

Empty `$ACTIVE` → **clean-baseline gate, then bootstrap** with
`workflow_type=start`:

<!-- pipeline:begin start-bootstrap -->
In the block, replace `<the original request described above>` with a
one-line genericized business topic; `AGENTIC_TOPIC` takes its place when it is set. The
block sets the repository and branch itself: a shell variable does not outlive
a Bash call.

A dirty tree's refusal selects a worktree first (ADR-0067 Decision 8, item 3):
`scripts/discover-runtime.mjs worktree-plan` prints the runtime:worktree
planner's `git worktree add -b <branch> <path> <base>` for this request, to
run before `/founder:start` again inside the new worktree; this checkout's
changes stay where they are. It is the refusal's `selected_next`. Cleaning,
stashing or accepting the tree here stay among the rejected alternatives: right
when the changes are finished or belong to this request, wrong when they are
other work. When no runtime with the planner resolves, or the planner blocks
(an existing branch, an occupied path, an unresolved base), the line names the
reason and `/runtime:worktree plan`.
The request reaches the planner through an args file, never through the
shell: the refusal names the worktree block in the active-workflow section
below, which a new request beside an active workflow uses too; run it with the
request in a new args file.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='founder'
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ACCEPT_CURRENT_TREE=1, exported or set in this block, accepts a dirty tree;
# the flag carries it to the check either way.
case "${ACCEPT_CURRENT_TREE:-}" in 1) ACCEPT_TREE=true ;; *) ACCEPT_TREE=false ;; esac
BASELINE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" check-clean-baseline --repo-root "$REPO_ROOT" --accept-current-tree "$ACCEPT_TREE")"
BASELINE_RC=$?
if [ "$BASELINE_RC" -ne 0 ]; then
  echo "✗ clean-baseline check failed (exit $BASELINE_RC); its error is above." >&2; exit "$BASELINE_RC"
fi
STATUS="$(printf '%s' "$BASELINE" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).status||"")}catch{process.stdout.write("")}})')"
# Fail CLOSED: only an explicit clean/accepted proceeds. A dirty tree, an
# empty status, or any unrecognized value stops the bootstrap — the gate
# must never fail open on a parse error or a non-zero check.
case "$STATUS" in
  clean|accepted) ;;  # proceed
  dirty)
    echo "✗ Working tree not clean — /${PERSONA}:start gates a clean baseline before bootstrapping a deliverable." >&2
    # ADR-0067 Decision 8, item 3 — a worktree first; the request reaches the
    # planner through an args file, never through this block.
    echo "→ Proposed: a new worktree first, which leaves this checkout's changes where they are: run the worktree block (the active-workflow section) with the request in an args file; it prints the git worktree add command." >&2
    echo "  Or resolve it here, then re-run:" >&2
    echo "    • clean:  git restore . ; git clean -fd" >&2
    echo "    • stash:  git stash push --include-untracked  (re-run, then git stash pop)" >&2
    echo "    • accept: set ACCEPT_CURRENT_TREE=1 to acknowledge the dirty tree" >&2
    exit 1;;
  *)
    echo "✗ clean-baseline check returned an unrecognized status ('$STATUS') — refusing to bootstrap (fail-closed)." >&2
    exit 1;;
esac
GIT_HEAD="$(git rev-parse HEAD)"
STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb investigate --workflow-type start \
  --host "${AGENTIC_HOST:-claude}" --persona 'founder' \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --original-request "${AGENTIC_TOPIC:-<the original request described above>}" \
  --current-phase phase-1-discover \
  --next-action "Run Phase 1 discover+frame+decide composite")" || exit $?
```
<!-- pipeline:end start-bootstrap -->

Non-empty `$ACTIVE` → **read `workflow_type` first** — the lifecycle macro
must NOT absorb a single-verb (`verb-chain`) workflow into lifecycle phase
space (state.mjs defaults non-start workflows to `verb-chain` and validates
`start` as a separate discriminator):

<!-- pipeline:begin start-resume -->
When the arguments above are a new request that does not belong to the active
workflow (its `original_request` says what it holds), do not run the first
block below, whichever the workflow's type: a start never takes unrelated work
into a workflow, and the block would resume it. Propose a worktree for the
request instead, with the second block, and leave the active workflow as it is
(ADR-0067 Decision 8, item 3). When the arguments are empty, or continue that
workflow, the ordinary resume is the selection: run the first block.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='founder'
# The read is checked on its own: a read that fails stops the block, whatever
# it printed, before the type is parsed.
WF_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE")" || exit $?
WF_TYPE="$(printf '%s' "$WF_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).workflow_type||"verb-chain")}catch{process.stdout.write("verb-chain")}})')"
# Resuming into the lifecycle clears the next step the last phase recorded, so
# a phase that stops before its own last write leaves none behind (ADR-0063
# D6); the position (verb, phase, next action) is kept. Any other workflow is
# refused, unwritten: the lifecycle never takes a single-verb workflow into
# its phase space (ADR-0020 §Sub-decision 4).
if [ "$WF_TYPE" = start ]; then
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --clear-next-step true --event resumed || exit $?
else
  echo "✗ The active workflow on this branch is workflow_type=${WF_TYPE}, not start: /${PERSONA}:start does not take a single-verb workflow into its lifecycle." >&2
  echo "  Active workflow: $ACTIVE" >&2
  echo "  If this request continues it: continue it with its /${PERSONA}:<verb>, or archive it (/${PERSONA}:resume archive), then re-run /${PERSONA}:start." >&2
  echo "  If it is new work: a worktree first, which leaves this branch and its workflow as they are (the worktree block prints the command); switching this checkout's branch (git switch -c <new>) would carry its changes along." >&2
  exit 1
fi
```

The worktree block, for a new request beside an active workflow and for the
bootstrap's dirty refusal above, takes the arguments above through an args
file, never through the shell:

1. Create a private directory for the file, and note the path it prints:
   `mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`.
2. With your file-writing tool, not the shell, create `args.json` in it
   holding `{"agentic_args": 1, "text": "…"}`, with `text` set to the
   arguments exactly as typed, as a JSON string.

Then run the block with `ARGS_DIR` set to that directory. It prints the
runtime:worktree planner's `git worktree add` command for the request,
or why there is none, and writes nothing; the args file is removed once read.

```bash
ARGS_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
node "$CLAUDE_PLUGIN_ROOT/scripts/discover-runtime.mjs" worktree-plan --repo-root "$REPO_ROOT" \
  --args-file "$ARGS_DIR/args.json" --host "${AGENTIC_HOST:-claude}" --format text
```
<!-- pipeline:end start-resume -->

- `workflow_type == start` → **resume into start**: report the active
  workflow's `verb` / `current_phase` / `next_action` and continue the
  lifecycle from where it stopped (do not re-bootstrap).
- `workflow_type != start` (a `verb-chain` single-verb workflow) →
  **reject**: do NOT mutate it into lifecycle phase space. Tell the user an
  active single-verb workflow exists on this branch; finish or archive it
  first (`/founder:resume` / `/founder:resume archive`), or continue it with
  the matching `/founder:<verb>`, then re-run `/founder:start`.

For a clean/dirty drift report on the active workflow, the user can run
`/founder:resume`.

<!-- pipeline:begin start-initial-verb -->
The initial `verb` is `investigate` (Phase 1a); rotate the `verb` field at
each phase boundary via `state.mjs append --verb <verb>` so SessionStart
re-injection sees the active cognitive activity (SKILL.md § intra-document
execution model).
<!-- pipeline:end start-initial-verb -->

---

## Privacy gate (whole lifecycle)

<!-- pipeline:begin start-privacy-gate -->
PRIVACY GATE: proprietary venture concepts, interview/customer data, and unpublished business material
pass an explicit privacy gate before BOTH web search AND peer-host dispatch.
The lifecycle runs web search (Phase 1 investigate) and dispatches the peer ensemble at every phase boundary (always-max) — genericize before any external call; the pre-genericization value MUST never leave the local host.
See `core/skills/investigate/references/business-brief-spec.md` § Privacy Gate.
<!-- pipeline:end start-privacy-gate -->

---

## Entry routing + Phases 1–4 + terminal

Follow `${CLAUDE_PLUGIN_ROOT}/core/skills/start/SKILL.md` for the cognitive runbook:

1. **Entry routing recommendation** (Options / Tradeoffs / Risks /
   Recommendation / Confidence / Evidence pointers / Default next command):
   `/founder:start` for one deliverable; the orchestrator persona for a
   multi-deliverable program; a single `/founder:<verb>` for one verb.
2. **Phase 1 — discover+frame+decide** (investigate business-brief → frame →
   decide). Rotate `verb`. **APPROVE direction** before Phase 2.
3. **Phase 2 — compose** (plan / canvas / validation-plan). Plan-verify peer
   ensemble (Independence-Rule exception). **APPROVE plan** before Phase 3.
   Surface the multi-deliverable prompt if the plan splits.
4. **Phase 3 — critique** (multi-perspective business review; veto-gate
   findings are CRITICAL).
5. **Phase 4 — refine** to convergence (re-verify internal consistency; loop
   refine + peer re-verify until findings converge).

<!-- pipeline:begin start-phase-boundary -->
Each phase boundary writes state via `state.mjs append --verb <verb>
--current-phase <phase> --next-action <...> --event updated` and dispatches
the per-phase peer ensemble per
`core/skills/_shared/references/ensemble-protocol.md` (always-max).

Inside the lifecycle each verb runs in place, so three rules hold at every
phase (ADR-0066 PC2b):

- **Each ensemble attempt is settled.** After its synthesis note, settle the
  phase's attempt from its run ledger with `peer-runner.mjs settle --phase
  <verb> --run-id <that attempt's run id>` (empty when no run launched), before
  the next phase. A repeated phase (a second refine pass) dispatches under a
  new run id and settles each attempt.
- **No phase closes the workflow.** A verb's own terminal write
  (`finish-verb`) never runs inside the lifecycle; the lifecycle's last step
  below makes its one terminal write.
- **An owner gate pauses the lifecycle.** When a phase meets one (a decide
  CONFLICT, a recurring finding, a request that belongs elsewhere), record it
  after the phase note with `state.mjs awaiting-owner-set --gate <gate>
  --anchor <anchor>`, a write that leaves the workflow open, and pause. Once
  the owner decides, clear it with `state.mjs awaiting-owner-clear --gate
  <gate> --resolution <the owner's decision> --next-step-kind verb
  --next-step-verb <the next phase's verb> --next-step-confidence HIGH
  --next-action <the next phase's action>`, and continue at that phase. The
  verb's own resolving step (decide's Owner selection, refine's Owner
  decision), run inside the lifecycle, clears the gate and stops instead of
  making the verb's terminal write; resume the lifecycle from it. A
  synthesis verdict of `conflict` in decide, critique or investigate is such a
  gate (ADR-0067 Decision 8): once the settle has recorded it, write the
  contested items with the file tool to a new file, never into a command (they
  come from the peers' positions), and pass that file to
  `state.mjs consensus-task --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --run-id <that run id> --text-file <that file>`,
  which prints the bounded consensus round to propose to the owner; then set
  `decide-conflict` (decide) or `peer-conflict` (critique, investigate) with
  `--anchor ensemble-synthesis --run-id <that run id>`.
<!-- pipeline:end start-phase-boundary -->

<!-- pipeline:begin start-privacy-no-image -->
No dispatch passes `--image`: the companion peer path has no image channel, so
an image never reaches the peer as bytes.
<!-- pipeline:end start-privacy-no-image -->

---

## Terminal — present + save

Present the final business artifact and save it (durable
`business_brief.md` / venture plan / canvas at its
`<root>/YYYY-MM-DD_<topic-slug>/` location). founder does NOT auto-commit —
the user saves the deliverable to their per-venture content repository
(ADR-0036 §SD5). Write terminal state:

<!-- pipeline:begin start-terminal -->
The last write, `finish-verb`, records the lifecycle's next step in
closed-enum form, `--next-step-kind commit`: the owner saves and commits the
deliverable (founder runs no commit itself). It closes the workflow
`summary-complete`, and the code-emitted completion footer follows.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# ADR-0029 §1 / completion-output contract §2 — write the COMPACT form
# (selected_next + one-line why + next_command) into --next-action; the
# code-emitted footer surfaces it verbatim as "recommended next work".
# ADR-0063 D3 — finish-verb is the lifecycle's last write: the ADR-0017
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
  --next-action 'Save/commit the business deliverable; optionally /founder:start the next item' \
  --next-step-kind commit --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
```

The runtime completion footer is **code-emitted** on this terminal write
(ADR-0039): `finish-verb` takes
`set-terminal`'s path, which fires the ADR-0031 session-handoff sidecar; it
shells out to the runtime `footer.mjs` and prints the rendered footer —
context state, completion state (`publish-needed` while only the owner's save
and commit remain) + state-derived next action, workflow id/path, artifact
pointers, recommended next work, and the continue-vs-fresh session handoff —
on this command's **stderr**. The workflow is then terminal, and the Stop hook
archives it once every archive gate passes (here, once the owner's commit
moves HEAD); until then `/founder:start` on this branch finds it and
resumes it, so start the next deliverable after the archive, or on another
branch. Do **not** hand-compose a
second footer; surface the emitted one. It is advisory, pointer-only and
fail-closed (a missing or too-old runtime emits nothing, and the SessionStart
backstop still re-surfaces the handoff); it never mutates host session
context. On a detached HEAD the branch-based preflight reports "no active
branch context" and never recommends a fresh session (ADR-0018 §sub-2); the
path-targeted terminal sidecar renders the footer as on a branch, its
continue-vs-fresh advice included. Wiring details:
`core/skills/_shared/references/session-handoff.md`.
<!-- pipeline:end start-terminal -->

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```
