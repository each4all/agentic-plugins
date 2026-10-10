---
description: Sequence the engineer single-deliverable lifecycle (Phase 0 continuity through Phase 7 commit) end-to-end using the six canonical verb skills
argument-hint: <feature description> [--base-branch <ref>]
---

# Engineer · Start

$ARGUMENTS

`/engineer:start` is a **lifecycle macro command** (ADR-0020 §Sub-
decision 1): neither a verb nor a verb-level sugar alias. Sequences
Phase 0 continuity → Phase 1 brainstorm → Phase 2 explore → Phase 3
plan-verify → Phase 4 implement → Phase 5 review → Phase 6 resolve
→ Phase 7 commit through the six engineer verb skills.

**Cognitive runbook lives in
`${CLAUDE_PLUGIN_ROOT}/core/skills/start/SKILL.md`** per ADR-0021 (macro-
skill category). This command file owns the Claude-host bootstrap
(Phase 0 below) and the `state.mjs` writes at each phase boundary;
for each Phase 1–7 below, follow the matching `§ Phase N` section
of SKILL.md for the cognitive description, user-approval gates, and
ensemble dispatch points.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ENGINEER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

**Quality-first defaults**: optimize for
`best-results-over-token-minimization`, not token saving. Default peer breadth
is the documented phase-boundary ensemble; model/effort defaults are
host-native or explicit `runtime:settings` values and must not be downshifted
for token saving without a user constraint; review depth follows the workflow
phase, including Phase 5 `parallel-review` and re-review after refine until
findings converge or a design-level issue is surfaced.

---

## Phase 0 — Bootstrap (continuity, redundancy probe, clean-baseline gate)

Engineer workflows are anchored to a branch (ADR-0018 §sub-2):
`/engineer:start` refuses a detached HEAD rather than bootstrap a workflow
that cannot be found again by branch. `find-active` runs first, so the resume
and typed-conflict paths short-circuit without the redundancy probe, which
only matters when this branch is about to receive a new workflow (ADR-0020
§Implementation Guide step 1).

<!-- pipeline:begin start-phase-0 -->
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
<!-- pipeline:end start-phase-0 -->

Empty `$ACTIVE` → **redundancy probe, clean-baseline gate, then bootstrap**
with `workflow_type=start`:

<!-- pipeline:begin start-bootstrap -->
The arguments above are the feature description, with an optional
`--base-branch <ref>` anywhere in it (ADR-0059 Decision 7;
`scripts/start-args.mjs`). Empty arguments are refused (exit 2), so the
workflow's `original_request` has substance; `<ref>` is the redundancy
probe's base, `origin/main` when it is omitted. They reach the extractor
through an args file, never through the shell (ADR-0059): typed text spliced
into a command line is cut at `;`, expanded at `$(…)` and redirected at `>`,
and the damage can exit zero. Before each of the two blocks below:

1. Create a private directory for the file, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `args.json` in that
   directory holding `{"agentic_args": 1, "text": "…"}`, with `text` set to
   the arguments above exactly as typed, as a JSON string (`""` when there
   are none).

Then run the block with `ARGS_DIR` set to that directory. The extractor takes
the text as the description and removes one `--base-branch <ref>` wherever it
sits; a second `--base-branch`, the `--base-branch=<ref>` spelling, or a
missing ref is refused. Nothing else in the description is quoted, expanded
or split. It removes the args file and its directory once it has read them,
so the second block needs a new one.

The redundancy probe (ADR-0020 §Sub-decision 7) asks whether this branch
already holds overlapping work: recent commits and open pull requests against
the base. It writes nothing, and a failed probe never blocks the start.

```bash
ARGS_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
START_ARGS="$(node "$CLAUDE_PLUGIN_ROOT/scripts/start-args.mjs" --args-file "$ARGS_DIR/args.json")" || exit $?
BASE_BRANCH="$(printf '%s' "$START_ARGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).base_branch))')" || exit $?
DIAG="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" diagnose-redundancy \
  --repo-root "$REPO_ROOT" --base-branch "$BASE_BRANCH")"
DIAG_RC=$?
if [ "$DIAG_RC" -ne 0 ]; then
  # The probe is informational: a failed probe never blocks the start.
  echo "⚠ diagnose-redundancy failed (exit $DIAG_RC); its error is above. Proceeding without overlap detection." >&2
  DIAG=''
fi
# One line: the status, then whether git was found and whether the base resolved.
FINDING="$(printf '%s' "$DIAG" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let r={};try{r=JSON.parse(s)||{}}catch{}const sc=r.scanned||{};process.stdout.write([r.status||"",sc.git_present===false?"no-git":"",sc.base_resolution_failed===true?"no-base":""].join(" "))})')"
case "$FINDING" in
  *no-git*) echo "⚠ git is not on PATH — the redundancy probe is blind. Proceeding without overlap detection." ;;
  *no-base*) echo "⚠ Base branch '$BASE_BRANCH' did not resolve — pass --base-branch <ref> if another base applies (e.g. stacked branches). Proceeding without overlap detection." ;;
  redundancy*)
    echo "⚠ Redundancy detected on branch '$GIT_BRANCH' (base=$BASE_BRANCH):"
    printf '%s' "$DIAG" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const r=JSON.parse(s);for(const k of ["scanned","evidence","recommended_action"])console.log(JSON.stringify(r[k],null,2))})'
    echo
    echo "  Options:"
    echo "    - proceed: run the bootstrap block below if the evidence is unrelated"
    echo "    - abort:   stop here; review the evidence (recent commits / open PRs)"
    echo "               and either continue the existing PR or archive it first"
    echo "→ PAUSED: put the evidence to the user and wait for proceed or abort." ;;
esac
```

On a redundancy finding, put the evidence to the user and ask for an
explicit proceed-or-abort decision: `/engineer:start` never archives on
redundancy, which is a user judgment, not a plugin policy. Abort stops here,
with nothing written. A missing git or an unresolved base is informational.

To proceed, or when the probe found nothing, run the bootstrap block with a
new args file (steps 1–2). It runs the clean-baseline gate (ADR-0028
§Layer-1) before `state.mjs create`: the Phase 7 commit stages the paths the
workflow recorded that git shows changed, a signal that holds only when the
baseline was clean. A dirty baseline would let the commit sweep adjacent,
unrelated changes into the workflow's commit, unless the user accepts the
current tree (`ACCEPT_CURRENT_TREE=1`), which stages all of it at Phase 7.
`.agentic-plugins/state/**`, the workflow storage, never counts as dirty.

A dirty tree's refusal selects a worktree first (ADR-0067 Decision 8, item 3):
`scripts/discover-runtime.mjs worktree-plan` prints the runtime:worktree
planner's `git worktree add -b <branch> <path> <base>` for this request, to
run before `/engineer:start` again inside the new worktree; this checkout's
changes stay where they are. It is the refusal's `selected_next`. Cleaning,
stashing or accepting the tree here stay among the rejected alternatives: right
when the changes are finished or belong to this request, wrong when they are
other work. When no runtime with the planner resolves, or the planner blocks
(an existing branch, an occupied path, an unresolved base), the line names the
reason and `/runtime:worktree plan`.
The refusal plans it for the description and base the args file held.

```bash
ARGS_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
START_ARGS="$(node "$CLAUDE_PLUGIN_ROOT/scripts/start-args.mjs" --args-file "$ARGS_DIR/args.json")" || exit $?
# A command substitution drops trailing newlines; the sentinel keeps them.
FEATURE="$(printf '%s' "$START_ARGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).feature))'; printf x)"; FEATURE="${FEATURE%x}"
[ -n "$FEATURE" ] || { echo "✗ No feature description was read; nothing was written." >&2; exit 2; }
BASE_BRANCH="$(printf '%s' "$START_ARGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).base_branch))')" || exit $?
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
    printf '%s' "$BASELINE" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(s).categories,null,2)))' >&2
    # ADR-0067 Decision 8, item 3 — a worktree first: the runtime planner's
    # command for this request, read-only.
    node "$CLAUDE_PLUGIN_ROOT/scripts/discover-runtime.mjs" worktree-plan --repo-root "$REPO_ROOT" \
      --task "$FEATURE" --base "$BASE_BRANCH" --host "${AGENTIC_HOST:-claude}" --format text >&2
    echo "  Or resolve it here, then re-run:" >&2
    echo "    • clean:  git restore . ; git clean -fd" >&2
    echo "    • stash:  git stash push --include-untracked  (re-run, then git stash pop)" >&2
    echo "    • accept: set ACCEPT_CURRENT_TREE=1 to sweep the current tree into the workflow's commit (Phase 7 stages all of it)" >&2
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
  --host "${AGENTIC_HOST:-claude}" --persona 'engineer' \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --original-request "$FEATURE" \
  --current-phase phase-1-discover \
  --next-action "Run Phase 1 discover+frame+decide composite")" || exit $?
```
<!-- pipeline:end start-bootstrap -->

Non-empty `$ACTIVE` → **read `workflow_type` first** (ADR-0020 §Sub-decision
4): the lifecycle macro never absorbs a single-verb (`verb-chain`) workflow
into its phase space, and never archives one either:

<!-- pipeline:begin start-resume -->
When the arguments above are a new request that does not belong to the active
workflow (its `original_request` says what it holds), do not run the first
block below, whichever the workflow's type: a start never takes unrelated work
into a workflow, and the block would resume it. Propose a worktree for the
request instead, with the second block, and leave the active workflow as it is
(ADR-0067 Decision 8, item 3). When the arguments are empty, or continue that
workflow, the ordinary resume is the selection: run the first block.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='engineer'
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

The worktree block, for a new request beside an active workflow, takes the
arguments above through an args file, never through the shell:

1. Create a private directory for the file, and note the path it prints:
   `mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`.
2. With your file-writing tool, not the shell, create `args.json` in it
   holding `{"agentic_args": 1, "text": "…"}`, with `text` set to the
   arguments exactly as typed, as a JSON string.

Then run the block with `ARGS_DIR` set to that directory. It prints the
runtime:worktree planner's `git worktree add` command for the request,
from the `--base-branch <ref>` in it when there is one,
or why there is none, and writes nothing; the args file is removed once read.

```bash
ARGS_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
node "$CLAUDE_PLUGIN_ROOT/scripts/discover-runtime.mjs" worktree-plan --repo-root "$REPO_ROOT" \
  --args-file "$ARGS_DIR/args.json" --host "${AGENTIC_HOST:-claude}" --format text
```
<!-- pipeline:end start-resume -->

- `workflow_type == start` → **resume into start**: report the active
  workflow's `verb` / `current_phase` / `next_action` and continue the
  lifecycle from where it stopped (do not re-bootstrap). An owner gate
  Phase 0 reported is put to the user first; once resolved, clear it with
  the phase the lifecycle continues at (§ Phase boundaries).
- `workflow_type != start` (a `verb-chain` workflow, or a legacy one
  without the field) → **typed conflict**: the block stopped without
  writing. The user clears the workflow deliberately — continue it with its
  `/engineer:<verb>`, let it commit (`/engineer:commit`) or archive it
  (`/engineer:resume archive <id>`), or switch branch — then re-runs
  `/engineer:start`.

<!-- pipeline:begin start-initial-verb -->
The initial `verb` is `investigate` (Phase 1a); rotate the `verb` field at
each phase boundary via `state.mjs append --verb <verb>` so SessionStart
re-injection sees the active cognitive activity (SKILL.md § intra-document
execution model).
<!-- pipeline:end start-initial-verb -->

---

## Phase 0d — Entry routing and decision contract

Before Phase 1, present an **Entry routing recommendation** using
`core/skills/_shared/references/entry-routing-contract.md`. This is a
user-facing contract, not a hidden classifier. The recommendation must
name the selected route and the plausible alternatives:

- continue with `/engineer:start` / `$engineer:start` for one coherent
  deliverable on the current branch;
- switch to `/orchestrator:plan` / `$orchestrator:plan` for 2+
  independently completable deliverables, PRs, branches, owners, or
  dependency edges;
- run `/runtime:worktree plan` / `$runtime:worktree` when isolation or
  parallelization is likely because the checkout is dirty, risky,
  long-running, or suitable for parallel branches;
- run `/runtime:doctor`, `/runtime:settings`, or `/runtime:context`
  when the task is runtime readiness, install/update, or handoff;
- use a single `/engineer:<verb>` / `$engineer:<verb>` when the user
  only needs investigate/frame/decide/compose/critique/refine without
  lifecycle state.

Whenever `/engineer:start` asks the user to proceed, abort, approve a
direction, approve a plan, or switch to another route, use this
decision prompt shape: **Options**, **Tradeoffs**, **Risks**,
**Recommendation**, **Confidence**, **Evidence pointers**, and the
**Default next command**.

Surface the **ADR-0031 session-level continue-vs-fresh preflight here**, at
Phase 0 before sequencing the lifecycle, per
`core/skills/_shared/references/session-handoff.md`: compute the engineer workflow
projection for the current branch and pass it — or, when no active workflow
exists, the standalone routing — to the runtime seam, so the routing
recommendation above is sized by context-budget risk + archive-gate readiness.
On detached HEAD the Phase 0 guard stops the command before any write
(workflows are anchored to a branch); do not auto-recommend a fresh session.

Before recommending a quick implementation/refinement path, state the
standards and root-cause quality gate: the source of truth or standard,
the invariant or root cause, the required verification evidence, and the
rollback/defer/escalation path. If that gate cannot be met, route back
to `engineer:investigate`, `engineer:decide`, or `orchestrator:plan`
instead of patching symptoms.

When the recommended route is `engineer:decide`, also surface the
**decision size** per ADR-0027 §1.5: `--size=minor` → `compact`
4-axis preset with the `entry-routing-guarantee` hard-gate;
`--size=standard` → `default` 5-axis (backward-compatible);
`--size=major` → `nine-axis` 9-axis preset + auto-enabled
sensitivity. The full sizing taxonomy lives in
`core/skills/_shared/references/entry-routing-contract.md` §"Routing into
`engineer:decide` — decision sizing".

---

## Phase boundaries (Phases 1–6)

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

---

## Phase 1 — Brainstorm composite (investigate → frame → decide)

Composite of three verbs per ADR-0020 §Sub-decision 2; rotate the
workflow's `verb` field at each sub-phase entry so SessionStart
re-injection sees the active cognitive activity (intra-document
execution, no recursive slash dispatch):

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# Sub-phase 1a — Investigate (option generation)
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb investigate \
  --current-phase phase-1-brainstorm-investigate \
  --next-action "Generate option candidates and gather supporting evidence" \
  --event updated

# Sub-phase 1b — Frame (5-perspective model)
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb frame \
  --current-phase phase-1-brainstorm-frame \
  --next-action "Frame options across 5 perspectives" \
  --event updated

# Sub-phase 1c — Decide (recommend + user approval)
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb decide \
  --current-phase phase-1-brainstorm-decide \
  --next-action "Recommend direction and obtain user approval" \
  --event updated
```

**Do not proceed to Phase 2 until the user approves a direction.**

---

## Phase 2 — Explore codebase (investigate --profile=analysis)

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb investigate --profile analysis \
  --current-phase phase-2-explore \
  --next-action "Map current codebase state and integration points" \
  --event updated
```

---

## Phase 3 — Plan-verify (compose --profile=plan + critique)

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb compose --profile plan \
  --current-phase phase-3-plan \
  --next-action "Produce plan artifact" \
  --event updated

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb critique \
  --current-phase phase-3-verify \
  --next-action "Verify plan completeness and feasibility" \
  --event updated
```

Surface the **multi-deliverable detection prompt** if the plan
groups into 2+ deliverables (ADR-0020 §Sub-decision 6); user chooses
abort vs single-pass continuation.

**Do not proceed to Phase 4 until the user approves the plan.**

---

## Phase 4 — Implement (compose --profile=code)

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb compose --profile code \
  --current-phase phase-4-implement \
  --next-action "RED-GREEN-REFACTOR loop per planned task" \
  --event updated
```

---

## Phase 5 — Review (critique --profile=parallel-review)

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb critique --profile parallel-review \
  --current-phase phase-5-review \
  --next-action "Multi-perspective code review + Codex working-tree review" \
  --event updated
```

---

## Phase 6 — Resolve (refine)

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb refine \
  --current-phase phase-6-resolve \
  --next-action "Address findings; converge or escalate same-finding recurrence" \
  --event updated
```

---

## Phase 7 — Commit (ADR-0028 §Layer-3)

<!-- pipeline:begin start-commit -->
The lifecycle's one terminal write is the Phase 7 commit driver,
`phase7-commit.mjs` (ADR-0028 §Layer-3): it computes the staging set from
`commit_manifest` ∩ `git_changes`, splits it per release-please package
(ADR-0016, P8), commits with the subject(s) the user confirmed, runs the
post-commit gates (P11 pending ensemble, no active children, clean after
commit, the P10 parent writeback), and writes `set-terminal` last (P5). No
`finish-verb` runs here.

Phase 7 never commits on its own (P6). It takes two steps, each its own
block: plan mode reads the workflow and git and suggests subjects; present
them to the user with [a]ccept / [e]dit / [c]ancel, and when the plan says
`ask_user` also confirm the staging set and its extras. The user picks one
of: the intersection only (the default, no extra flag); specific extras
opted back in (`--include-extra <path>` for each, PR4 A4); or the whole
working tree (`--accept-current-tree`, all or nothing). Then execute mode
commits with the subject(s) the user confirmed.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# A shell variable does not outlive a Bash call: unless ACTIVE is set, the
# workflow is the one find-active names on this branch.
if [ -z "${ACTIVE:-}" ]; then
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
fi
[ -n "$ACTIVE" ] || { echo "✗ No active workflow on this branch; Phase 7 has nothing to commit." >&2; exit 1; }
# Step 1 — plan mode: read the workflow and git, suggest subjects. It writes
# nothing.
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" \
  --mode plan \
  --workflow-path "$ACTIVE" \
  --repo-root "$REPO_ROOT" \
  --host "${AGENTIC_HOST:-claude}" || exit $?
```

In the execute block, set `APPROVED_SUBJECT` to the subject the user
confirmed. When the plan splits the commit across packages (`shouldSplit`),
pass one `--subject-pkg '<package path>=<subject>'` per package instead of
`--subject`; the body (P1, with the P9 trailer allowlist) is shared by every
per-package commit. Add each extra the user opted in with `--include-extra
<path>`, or `--accept-current-tree` for the whole tree; when the bootstrap
accepted the current tree (`ACCEPT_CURRENT_TREE=1`), pass it again here, so
the driver stages all of `git_changes` rather than the intersection.

ARCHIVE TIMING — decide before running execute mode. The driver writes
`set-terminal` as its last step, and on Claude the Stop hook fires at every
turn end, so the archive gates are evaluated at the end of this turn, not at
session close. If the workflow must stay open past this turn, do not run
execute mode yet: clearing the marker afterwards works only before that Stop
fires and needs set-terminal's full flag set (`--workflow-path`, `--host`,
`--terminal-phase`). Full contract:
`core/skills/_shared/references/session-handoff.md` § Archive timing.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# A shell variable does not outlive a Bash call: unless ACTIVE is set, the
# workflow is the one find-active names on this branch.
if [ -z "${ACTIVE:-}" ]; then
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
fi
[ -n "$ACTIVE" ] || { echo "✗ No active workflow on this branch; Phase 7 has nothing to commit." >&2; exit 1; }
APPROVED_SUBJECT='<the subject the user confirmed>'
# Step 2 — execute mode: commit with the approved subject, run the gates, then
# set-terminal. A failure leaves the workflow open (no terminal marker); the
# driver names the recovery on stderr: refine, then run this start command
# again, which resumes at Phase 7.
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" \
  --mode execute \
  --workflow-path "$ACTIVE" \
  --repo-root "$REPO_ROOT" \
  --host "${AGENTIC_HOST:-claude}" \
  --subject "$APPROVED_SUBJECT" \
  --confirm-non-interactive || exit $?
# On success the driver already ran the P10 parent writeback synchronously
# (for a macro subtask: a note on the macro, not its completion, which
# /orchestrator:done records after the merge, ADR-0062) and then wrote
# set-terminal; the Stop hook evaluates the archive gates (ADR-0017
# §sub-decision 5) and only retries the writeback idempotently, or backstops a
# driver that died between the two writes.
```

The runtime completion footer is **code-emitted** on this terminal path
(ADR-0039): `set-terminal` fires the ADR-0031 session-handoff sidecar, which
shells out to the runtime `footer.mjs` and prints the rendered footer —
context state, completion state + state-derived next action, workflow
id/path, artifact pointers, recommended next work, and the continue-vs-fresh
session handoff — on the commit command's **stderr**. Do **not** hand-compose
a second footer; surface the emitted one. It is advisory, pointer-only and
fail-closed (a missing or too-old runtime emits nothing, and the SessionStart
backstop still re-surfaces the handoff); it never mutates host session
context. On a detached HEAD the branch-based preflight reports "no active
branch context" and never recommends a fresh session (ADR-0018 §sub-2); the
path-targeted terminal sidecar renders the footer as on a branch, its
continue-vs-fresh advice included. Wiring details:
`core/skills/_shared/references/session-handoff.md`.
<!-- pipeline:end start-commit -->

When the deliverable boundary is reached, include PR handling readiness
fields in the footer. Ask the user what to do with PR handling only when
the helper returns `pr_handling.recommendation == "ask-user"`; `defer`
means evidence is incomplete, and `block` means a readiness criterion
failed.

---

## Notes

- ADR-0020 §Sub-decision 1 — `/engineer:start` is a **command**, not a
  7th canonical verb; the six-verb enum (`VALID_VERBS` in `state.mjs`)
  is unchanged.
- ADR-0021 — The canonical lifecycle runbook lives in
  `core/skills/start/SKILL.md` (macro-skill category per ADR-0010 §3
  cascade). This command file owns the Claude-host bootstrap (Phase 0)
  and the state.mjs writes at each phase boundary. The Codex-side
  parity is `$engineer:start` (same SKILL.md content).
- ADR-0018 §sub-2 — branch=workflow invariant; one workflow per branch.
- ADR-0019 — `/engineer:start` is engineer-internal verb sequencing
  and does NOT transit cross-plugin boundaries; `parent_workflow` is
  unset for direct `/engineer:start` invocation.
- ADR-0017 §sub-decision-5 — Stop hook auto-archive gates evaluate
  `terminal_marker`, terminal phase, HEAD movement, and no-active-children
  transparently. `workflow_type` is read transparently and does NOT
  affect gate logic.
- ADR-0066 — Phase 0's blocks, the phase-boundary rules and Phase 7 are
  generated from `persona-pipeline/` (the `start-*` regions, shared with
  founder and designer; the redundancy probe and Phase 7 follow the
  `commit_surface` capability). The phase list, its state writes and the
  entry routing stay authored here.
