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
The request reaches `state.mjs` as a file, never in the block: in shell
source a quote, `$`, backtick or line break of it would be read as code
(ADR-0059, amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   # Step 1: a private text directory, marked so that the step that reads it
   # last releases it (ADR-0059 Decisions 9 and 10).
   ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
   CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
   [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
   MAKE_KIND='text'
   MAKE_PARENT=''
   # ADR-0059 Decision 9: make and mark the directory MAKE_KIND names (text or
   # op; MAKE_PARENT, when set, for an op nested in it); its path is MADE_DIR.
   # The fallbacks of Decision 10, item 4 make it the old way: an older
   # state.mjs, lacking tmpdir-make, and a platform where the make is unsupported
   # with mktemp -d, a nested op in a parent made the old way with mkdir. A fallback's path is
   # checked for what a single-quoted shell literal cannot carry, as the make
   # checks its own. Each status is read in a condition, so errexit changes
   # nothing here.
   MADE_DIR=''
   if grep -q -e "'tmpdir-make'" "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" 2>/dev/null; then
     if [ -n "${MAKE_PARENT:-}" ]; then
       MADE_DIR="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-make --kind op --parent "$MAKE_PARENT")" && MAKE_RC=0 || MAKE_RC=$?
     else
       MADE_DIR="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-make --kind "$MAKE_KIND")" && MAKE_RC=0 || MAKE_RC=$?
     fi
   elif [ -r "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ]; then
     MAKE_RC=old
   else
     echo "✗ Cannot read $CLAUDE_PLUGIN_ROOT/scripts/state.mjs; no directory was made." >&2
     exit 1
   fi
   case "$MAKE_RC" in
     0) ;;
     3|4|old)
       if [ -n "${MAKE_PARENT:-}" ]; then
         MADE_DIR="$MAKE_PARENT/op"
         mkdir -m 700 "$MADE_DIR" || { echo "✗ $MADE_DIR already holds an operation directory, or cannot be made: run from a fresh directory. No directory was made." >&2; exit 1; }
       else
         MADE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentic-$MAKE_KIND.XXXXXX")" || exit 1
         [ "$MAKE_RC" != 3 ] || echo "agentic-dir make: unsupported on this platform; $MADE_DIR was made with mktemp -d and will not be released" >&2
       fi
       node -e 'process.exit(/[\x00-\x1f\x7f\x27]/.test(process.argv[1])?1:0)' "$MADE_DIR" \
         || { echo "✗ The directory made holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one." >&2; exit 1; }
       ;;
     5) echo "✗ TMPDIR (${TMPDIR:-/tmp}) holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one. No directory was made." >&2; exit 1 ;;
     *) exit 1 ;;
   esac
   [ -n "$MADE_DIR" ] || { echo "✗ The make printed no directory; nothing can be written." >&2; exit 1; }
   printf '%s\n' "$MADE_DIR"
   ```

2. With your file-writing tool, not the shell, create `request.txt` in that
   directory holding a one-line genericized business topic, ending with one newline.

Then run the block with `TEXT_DIR` set to that directory; a request file left
unwritten stops it before any write, and the directory is kept for the rerun.
Once `create` has recorded the request, the block releases the directory
(ADR-0059 Decision 10). When `AGENTIC_TOPIC` is set (a dispatched run), the
block writes it to a directory of its own, records that instead and releases
it on each of its exits; steps 1–2 are not needed, and the block releases no
directory its `TEXT_DIR` names. The block sets the repository and branch itself: a
shell variable does not outlive a Bash call.

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
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='founder'
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# The directory this block writes the request in, for itself (ADR-0059
# Decision 10, item 1): released on each of its exits from the variable its
# make printed to; every run makes it afresh.
REQUEST_DIR=''
release_own() {
  OWN_RC=$?
  RELEASE_PATH="$REQUEST_DIR"
  # ADR-0059 Decision 10, item 4: release RELEASE_PATH (nothing when it is
  # empty), cleanup only. On standard error the CLI's own line, or one of these
  # when its result cannot be read; the block's standard output and exit status
  # stay what its own work set, errexit or not.
  if [ -n "${RELEASE_PATH:-}" ]; then
    if grep -q -e "'tmpdir-release'" "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" 2>/dev/null; then
      RELEASE_REPORT="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-release --path "$RELEASE_PATH")" || :
      node -e 'let r=null;try{r=JSON.parse(process.argv[1])}catch{}process.exit(r!==null&&typeof r==="object"&&typeof r.outcome==="string"?0:1)' "$RELEASE_REPORT" 2>/dev/null \
        || echo "agentic-dir release: the result is unknown; the directory may remain at $RELEASE_PATH or at its .removing- path" >&2
    elif [ -r "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ]; then
      echo "agentic-dir release: no tmpdir-release in this state.mjs; the directory is kept at $RELEASE_PATH" >&2
    else
      echo "agentic-dir release: the result is unknown (cannot read $CLAUDE_PLUGIN_ROOT/scripts/state.mjs); the directory may remain at $RELEASE_PATH" >&2
    fi
  fi
  return "$OWN_RC"
}
trap release_own EXIT
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
# The request, as a file (ADR-0059, amendment of 2026-10-10): the one the
# agent wrote, or the AGENTIC_TOPIC a dispatcher exports, which is program data
# the block writes to a private directory of its own, so no text flag is
# inline and a dispatched run needs no file of the agent's.
REQUEST_FILE="$TEXT_DIR/request.txt"
if [ -n "${AGENTIC_TOPIC:-}" ]; then
  MAKE_KIND='text'
  MAKE_PARENT=''
  # ADR-0059 Decision 9: make and mark the directory MAKE_KIND names (text or
  # op; MAKE_PARENT, when set, for an op nested in it); its path is MADE_DIR.
  # The fallbacks of Decision 10, item 4 make it the old way: an older
  # state.mjs, lacking tmpdir-make, and a platform where the make is unsupported
  # with mktemp -d, a nested op in a parent made the old way with mkdir. A fallback's path is
  # checked for what a single-quoted shell literal cannot carry, as the make
  # checks its own. Each status is read in a condition, so errexit changes
  # nothing here.
  MADE_DIR=''
  if grep -q -e "'tmpdir-make'" "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" 2>/dev/null; then
    if [ -n "${MAKE_PARENT:-}" ]; then
      MADE_DIR="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-make --kind op --parent "$MAKE_PARENT")" && MAKE_RC=0 || MAKE_RC=$?
    else
      MADE_DIR="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-make --kind "$MAKE_KIND")" && MAKE_RC=0 || MAKE_RC=$?
    fi
  elif [ -r "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ]; then
    MAKE_RC=old
  else
    echo "✗ Cannot read $CLAUDE_PLUGIN_ROOT/scripts/state.mjs; no directory was made." >&2
    exit 1
  fi
  case "$MAKE_RC" in
    0) ;;
    3|4|old)
      if [ -n "${MAKE_PARENT:-}" ]; then
        MADE_DIR="$MAKE_PARENT/op"
        mkdir -m 700 "$MADE_DIR" || { echo "✗ $MADE_DIR already holds an operation directory, or cannot be made: run from a fresh directory. No directory was made." >&2; exit 1; }
      else
        MADE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentic-$MAKE_KIND.XXXXXX")" || exit 1
        [ "$MAKE_RC" != 3 ] || echo "agentic-dir make: unsupported on this platform; $MADE_DIR was made with mktemp -d and will not be released" >&2
      fi
      node -e 'process.exit(/[\x00-\x1f\x7f\x27]/.test(process.argv[1])?1:0)' "$MADE_DIR" \
        || { echo "✗ The directory made holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one." >&2; exit 1; }
      ;;
    5) echo "✗ TMPDIR (${TMPDIR:-/tmp}) holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one. No directory was made." >&2; exit 1 ;;
    *) exit 1 ;;
  esac
  [ -n "$MADE_DIR" ] || { echo "✗ The make printed no directory; nothing can be written." >&2; exit 1; }
  REQUEST_DIR="$MADE_DIR"
  REQUEST_FILE="$REQUEST_DIR/topic.txt"
  printf '%s\n' "$AGENTIC_TOPIC" > "$REQUEST_FILE" || exit 1
fi
grep -q '[^[:space:]]' "$REQUEST_FILE" 2>/dev/null || { echo "✗ request.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb investigate --workflow-type start \
  --host "${AGENTIC_HOST:-claude}" --persona 'founder' \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --original-request-file "$REQUEST_FILE" \
  --current-phase phase-1-discover \
  --next-action "Run Phase 1 discover+frame+decide composite")" || exit $?
# ADR-0059 Decision 10, item 1 — the request is recorded, so the directory
# the agent wrote it in has no reader left; a dispatched run read none.
if [ -z "$REQUEST_DIR" ]; then
  RELEASE_PATH="$TEXT_DIR"
  # ADR-0059 Decision 10, item 4: release RELEASE_PATH (nothing when it is
  # empty), cleanup only. On standard error the CLI's own line, or one of these
  # when its result cannot be read; the block's standard output and exit status
  # stay what its own work set, errexit or not.
  if [ -n "${RELEASE_PATH:-}" ]; then
    if grep -q -e "'tmpdir-release'" "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" 2>/dev/null; then
      RELEASE_REPORT="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-release --path "$RELEASE_PATH")" || :
      node -e 'let r=null;try{r=JSON.parse(process.argv[1])}catch{}process.exit(r!==null&&typeof r==="object"&&typeof r.outcome==="string"?0:1)' "$RELEASE_REPORT" 2>/dev/null \
        || echo "agentic-dir release: the result is unknown; the directory may remain at $RELEASE_PATH or at its .removing- path" >&2
    elif [ -r "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ]; then
      echo "agentic-dir release: no tmpdir-release in this state.mjs; the directory is kept at $RELEASE_PATH" >&2
    else
      echo "agentic-dir release: the result is unknown (cannot read $CLAUDE_PLUGIN_ROOT/scripts/state.mjs); the directory may remain at $RELEASE_PATH" >&2
    fi
  fi
fi
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
# A fresh shell: the workflow is found again here, never carried from an
# earlier block.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
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
--current-phase <phase> --next-action-file <file> --event updated` and
dispatches
the per-phase peer ensemble per
`core/skills/_shared/references/ensemble-protocol.md` (always-max). Every text
a write carries (a phase note, a next action, a summary, an owner's
decision) reaches `state.mjs` and `peer-runner.mjs` as a file, never the
text in a command (ADR-0059, amendment of 2026-10-10). At each phase, make the
phase's private text directory with this block, and note the path it prints:

```bash
# The phase's private text directory, marked so that the step that reads it
# last releases it (ADR-0059 Decisions 9 and 10).
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
MAKE_KIND='text'
MAKE_PARENT=''
# ADR-0059 Decision 9: make and mark the directory MAKE_KIND names (text or
# op; MAKE_PARENT, when set, for an op nested in it); its path is MADE_DIR.
# The fallbacks of Decision 10, item 4 make it the old way: an older
# state.mjs, lacking tmpdir-make, and a platform where the make is unsupported
# with mktemp -d, a nested op in a parent made the old way with mkdir. A fallback's path is
# checked for what a single-quoted shell literal cannot carry, as the make
# checks its own. Each status is read in a condition, so errexit changes
# nothing here.
MADE_DIR=''
if grep -q -e "'tmpdir-make'" "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" 2>/dev/null; then
  if [ -n "${MAKE_PARENT:-}" ]; then
    MADE_DIR="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-make --kind op --parent "$MAKE_PARENT")" && MAKE_RC=0 || MAKE_RC=$?
  else
    MADE_DIR="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-make --kind "$MAKE_KIND")" && MAKE_RC=0 || MAKE_RC=$?
  fi
elif [ -r "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ]; then
  MAKE_RC=old
else
  echo "✗ Cannot read $CLAUDE_PLUGIN_ROOT/scripts/state.mjs; no directory was made." >&2
  exit 1
fi
case "$MAKE_RC" in
  0) ;;
  3|4|old)
    if [ -n "${MAKE_PARENT:-}" ]; then
      MADE_DIR="$MAKE_PARENT/op"
      mkdir -m 700 "$MADE_DIR" || { echo "✗ $MADE_DIR already holds an operation directory, or cannot be made: run from a fresh directory. No directory was made." >&2; exit 1; }
    else
      MADE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentic-$MAKE_KIND.XXXXXX")" || exit 1
      [ "$MAKE_RC" != 3 ] || echo "agentic-dir make: unsupported on this platform; $MADE_DIR was made with mktemp -d and will not be released" >&2
    fi
    node -e 'process.exit(/[\x00-\x1f\x7f\x27]/.test(process.argv[1])?1:0)' "$MADE_DIR" \
      || { echo "✗ The directory made holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one." >&2; exit 1; }
    ;;
  5) echo "✗ TMPDIR (${TMPDIR:-/tmp}) holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one. No directory was made." >&2; exit 1 ;;
  *) exit 1 ;;
esac
[ -n "$MADE_DIR" ] || { echo "✗ The make printed no directory; nothing can be written." >&2; exit 1; }
printf '%s\n' "$MADE_DIR"
```

With the file-writing tool, write each text of the phase's own writes into
it (the phase note, the next action, the settle's summary, an owner's
decision) and pass the `-file` form of its flag. The phase's dispatch is not
one of them: each dispatch, and each pass of a refine that loops, writes its
`prompt.xml` and `subject.json` in a directory of its own, made as the
ensemble protocol's launch step says, where the runner writes its result.
Each attempt's settle (the first rule below) is its dispatch directory's last
reader, so once that settle has succeeded, release the directory with this
block, a run launched or not; a settle that fails keeps it for the retry. A
phase that dispatches more than one ensemble (an investigate, a frame and a
decide in turn) runs it once per attempt, and a looping refine's pass settle
releases each earlier pass's directory itself, so here the refine phase's
last pass only (ADR-0059 Decision 10):

```bash
# The dispatch directory of the ensemble attempt whose settle succeeded.
DISPATCH_TEXT_DIR='<the dispatch directory of the attempt whose settle succeeded>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
case "$DISPATCH_TEXT_DIR" in
  ''|'<'*) echo "✗ DISPATCH_TEXT_DIR is empty or not filled in; nothing was released." >&2; exit 1 ;;
esac
# ADR-0059 Decision 10, item 1 — the attempt's settle succeeded: no block,
# rerun or continuation reads its dispatch directory again.
RELEASE_PATH="$DISPATCH_TEXT_DIR"
# ADR-0059 Decision 10, item 4: release RELEASE_PATH (nothing when it is
# empty), cleanup only. On standard error the CLI's own line, or one of these
# when its result cannot be read; the block's standard output and exit status
# stay what its own work set, errexit or not.
if [ -n "${RELEASE_PATH:-}" ]; then
  if grep -q -e "'tmpdir-release'" "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" 2>/dev/null; then
    RELEASE_REPORT="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-release --path "$RELEASE_PATH")" || :
    node -e 'let r=null;try{r=JSON.parse(process.argv[1])}catch{}process.exit(r!==null&&typeof r==="object"&&typeof r.outcome==="string"?0:1)' "$RELEASE_REPORT" 2>/dev/null \
      || echo "agentic-dir release: the result is unknown; the directory may remain at $RELEASE_PATH or at its .removing- path" >&2
  elif [ -r "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ]; then
    echo "agentic-dir release: no tmpdir-release in this state.mjs; the directory is kept at $RELEASE_PATH" >&2
  else
    echo "agentic-dir release: the result is unknown (cannot read $CLAUDE_PLUGIN_ROOT/scripts/state.mjs); the directory may remain at $RELEASE_PATH" >&2
  fi
fi
```

Once the phase's last write has succeeded (its settle, its append, and an
owner gate's set or clear), release the phase's text directory with this
block; a write that fails keeps it for the retry:

```bash
TEXT_DIR='<the text directory of the phase>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
case "$TEXT_DIR" in
  ''|'<'*) echo "✗ TEXT_DIR is empty or not filled in; nothing was released." >&2; exit 1 ;;
esac
# ADR-0059 Decision 10, item 1 — the phase's last write succeeded: no block,
# rerun or continuation reads its text directory again.
RELEASE_PATH="$TEXT_DIR"
# ADR-0059 Decision 10, item 4: release RELEASE_PATH (nothing when it is
# empty), cleanup only. On standard error the CLI's own line, or one of these
# when its result cannot be read; the block's standard output and exit status
# stay what its own work set, errexit or not.
if [ -n "${RELEASE_PATH:-}" ]; then
  if grep -q -e "'tmpdir-release'" "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" 2>/dev/null; then
    RELEASE_REPORT="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-release --path "$RELEASE_PATH")" || :
    node -e 'let r=null;try{r=JSON.parse(process.argv[1])}catch{}process.exit(r!==null&&typeof r==="object"&&typeof r.outcome==="string"?0:1)' "$RELEASE_REPORT" 2>/dev/null \
      || echo "agentic-dir release: the result is unknown; the directory may remain at $RELEASE_PATH or at its .removing- path" >&2
  elif [ -r "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ]; then
    echo "agentic-dir release: no tmpdir-release in this state.mjs; the directory is kept at $RELEASE_PATH" >&2
  else
    echo "agentic-dir release: the result is unknown (cannot read $CLAUDE_PLUGIN_ROOT/scripts/state.mjs); the directory may remain at $RELEASE_PATH" >&2
  fi
fi
```

Inside the lifecycle each verb runs in place, so three rules hold at every
phase (ADR-0066 PC2b):

- **Each ensemble attempt is settled.** After its synthesis note, settle the
  phase's attempt from its run ledger with `peer-runner.mjs settle --phase
  <verb> --run-id <that attempt's run id>` (empty when no run launched) and
  its `--summary-file`, before
  the next phase. A repeated phase dispatches under a new run id. A refine
  that loops settles its passes in the refine skill: its pass settle (the
  **Each pass settles its own run** step) settles each earlier pass, launched
  or not, as the loop goes back, so the refine phase settles here the last
  pass's attempt only. Settling an earlier pass here as well would record a
  pass that launched no run twice, under two attempt keys. When no run launched for a phase whose
  ensemble is a review, the empty-id settle also names that review, by the
  type the phase's dispatch would have used (compose's `plan-verify`, or
  `review` where the compose skill picks the Review point type for code;
  critique's `review` or `adversarial-scan`; refine's `refine-verify`), and
  why it never ran: `--ensemble-type <that
  type> --no-run-reason <peer-unavailable|local-only|privacy-gate|owner-skip>
  --attempt-key <the phase's text directory>`, so the workflow records the
  review's attempt with its outcome (`unavailable` or `skipped`) and a rerun
  of that settle records it once (C163 A1a). A dispatch that launched takes
  `--subject-file <file>` (`{"shown": [...], "covered": [...]}`, the paths its
  prompt shows, and those at the content the tree holds now), and so does an
  empty-id settle for what the local reviewers read (ADR-0069 Decision 1). A `peer-runner.mjs` that does not name
  `--no-run-reason` in its usage predates the record: settle without those
  flags then.
- **No phase closes the workflow.** A verb's own terminal write
  (`finish-verb`) never runs inside the lifecycle; the lifecycle's last step
  below makes its one terminal write.
- **An owner gate pauses the lifecycle.** When a phase meets one (a decide
  CONFLICT, a recurring finding, a request that belongs elsewhere), record it
  after the phase note with `state.mjs awaiting-owner-set --gate <gate>
  --anchor <anchor>`, a write that leaves the workflow open, and pause. Once
  the owner decides, clear it with `state.mjs awaiting-owner-clear --gate
  <gate> --resolution-file <the owner's decision> --next-step-kind verb
  --next-step-verb <the next phase's verb> --next-step-confidence HIGH
  --next-action-file <the next phase's action>`, and continue at that phase. The
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

Its next action reaches `state.mjs` as a file, never in the block: in shell
source a quote, `$`, backtick or line of it would be read as code (ADR-0059,
amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   # Step 1: a private text directory, marked so that the step that reads it
   # last releases it (ADR-0059 Decisions 9 and 10).
   ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
   CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
   [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
   MAKE_KIND='text'
   MAKE_PARENT=''
   # ADR-0059 Decision 9: make and mark the directory MAKE_KIND names (text or
   # op; MAKE_PARENT, when set, for an op nested in it); its path is MADE_DIR.
   # The fallbacks of Decision 10, item 4 make it the old way: an older
   # state.mjs, lacking tmpdir-make, and a platform where the make is unsupported
   # with mktemp -d, a nested op in a parent made the old way with mkdir. A fallback's path is
   # checked for what a single-quoted shell literal cannot carry, as the make
   # checks its own. Each status is read in a condition, so errexit changes
   # nothing here.
   MADE_DIR=''
   if grep -q -e "'tmpdir-make'" "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" 2>/dev/null; then
     if [ -n "${MAKE_PARENT:-}" ]; then
       MADE_DIR="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-make --kind op --parent "$MAKE_PARENT")" && MAKE_RC=0 || MAKE_RC=$?
     else
       MADE_DIR="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-make --kind "$MAKE_KIND")" && MAKE_RC=0 || MAKE_RC=$?
     fi
   elif [ -r "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ]; then
     MAKE_RC=old
   else
     echo "✗ Cannot read $CLAUDE_PLUGIN_ROOT/scripts/state.mjs; no directory was made." >&2
     exit 1
   fi
   case "$MAKE_RC" in
     0) ;;
     3|4|old)
       if [ -n "${MAKE_PARENT:-}" ]; then
         MADE_DIR="$MAKE_PARENT/op"
         mkdir -m 700 "$MADE_DIR" || { echo "✗ $MADE_DIR already holds an operation directory, or cannot be made: run from a fresh directory. No directory was made." >&2; exit 1; }
       else
         MADE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentic-$MAKE_KIND.XXXXXX")" || exit 1
         [ "$MAKE_RC" != 3 ] || echo "agentic-dir make: unsupported on this platform; $MADE_DIR was made with mktemp -d and will not be released" >&2
       fi
       node -e 'process.exit(/[\x00-\x1f\x7f\x27]/.test(process.argv[1])?1:0)' "$MADE_DIR" \
         || { echo "✗ The directory made holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one." >&2; exit 1; }
       ;;
     5) echo "✗ TMPDIR (${TMPDIR:-/tmp}) holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one. No directory was made." >&2; exit 1 ;;
     *) exit 1 ;;
   esac
   [ -n "$MADE_DIR" ] || { echo "✗ The make printed no directory; nothing can be written." >&2; exit 1; }
   printf '%s\n' "$MADE_DIR"
   ```

2. With your file-writing tool, not the shell, create `next-action.txt` in
   that directory, ending with one newline: the compact form of the proposal
   (selected_next + one-line why + next_command), which the footer surfaces
   verbatim as "recommended next work". The lifecycle's default is

   ```text
   Save/commit the business deliverable; optionally /founder:start the next item
   ```

   The block releases the directory once its last write succeeded; a block
   that stops keeps it for its rerun.

Then run the block with `TEXT_DIR` set to that directory; a next action left
unwritten stops it before any write.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A fresh shell: the workflow is found again here, never carried from an
# earlier block.
PERSONA='founder'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# The next action the agent wrote with its file tool: state.mjs reads it
# itself, so no line of it is shell source. A file left unwritten stops the
# block before any write.
grep -q '[^[:space:]]' "$TEXT_DIR/next-action.txt" 2>/dev/null || { echo "✗ next-action.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
# ADR-0029 §1 / completion-output contract §2 — next-action.txt holds the
# COMPACT form (selected_next + one-line why + next_command), which the write
# records from the file; the code-emitted footer surfaces it verbatim as
# "recommended next work".
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
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --next-step-kind commit --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
# ADR-0059 Decision 10, item 1 — the last write succeeded: no block, rerun or
# continuation reads the directory again.
RELEASE_PATH="$TEXT_DIR"
# ADR-0059 Decision 10, item 4: release RELEASE_PATH (nothing when it is
# empty), cleanup only. On standard error the CLI's own line, or one of these
# when its result cannot be read; the block's standard output and exit status
# stay what its own work set, errexit or not.
if [ -n "${RELEASE_PATH:-}" ]; then
  if grep -q -e "'tmpdir-release'" "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" 2>/dev/null; then
    RELEASE_REPORT="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-release --path "$RELEASE_PATH")" || :
    node -e 'let r=null;try{r=JSON.parse(process.argv[1])}catch{}process.exit(r!==null&&typeof r==="object"&&typeof r.outcome==="string"?0:1)' "$RELEASE_REPORT" 2>/dev/null \
      || echo "agentic-dir release: the result is unknown; the directory may remain at $RELEASE_PATH or at its .removing- path" >&2
  elif [ -r "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ]; then
    echo "agentic-dir release: no tmpdir-release in this state.mjs; the directory is kept at $RELEASE_PATH" >&2
  else
    echo "agentic-dir release: the result is unknown (cannot read $CLAUDE_PLUGIN_ROOT/scripts/state.mjs); the directory may remain at $RELEASE_PATH" >&2
  fi
fi
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
