---
description: Dispatch the next ready subtask into the engineer plugin (same-host) — ADR-0019 §1+§3 dispatch + parent-linkage
argument-hint: [<subtask-id>] [--workflow=<macro-id>]
---

# Orchestrator · Next

$ARGUMENTS

Dispatch one orchestrator macro subtask into the engineer plugin's command runbook, recording the immutable parent linkage (`AGENTIC_PARENT_WORKFLOW` + `AGENTIC_ORIGINATING_SUBTASK`, and the macro file's path, `AGENTIC_PARENT_WORKFLOW_PATH`, ADR-0067 Decision 3, and the selection Phase 1 made, `AGENTIC_DISPATCH_SELECTION`, which every later binding of the child compares, ADR-0067 Decision 4, item 5) so the engineer can note its terminal commit on the macro and bind ownership (Phase 7 and the Stop hook, ADR-0019 §4 as changed by ADR-0062). The subtask completes when `/orchestrator:done` records the merge. This is the **same-host default**; cross-host (`--peer`) remains trigger-deferred PR-F scope.

Maintain one progress entry per phase across the phases below and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. Each phase is a discrete bash snippet — execute them in order and **abort on any non-zero exit** unless the snippet's commentary explicitly handles the failure. One exception: once Phase 3b has joined the run locks, go on to Phase 5 whatever Phase 4's outcome, since Phase 5 releases the admission (ADR-0067 Decision 4, item 5).

Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ORCHESTRATOR_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep that opening line when you run a block: a
shell variable does not outlive a Bash call.

No block relies on a variable an earlier block set: each one may run in a
fresh shell. What a phase finds — the checkout and the macro file (Phase 0),
the subtask it selected (Phase 1), the engineer root and the workflow its
ownership check saw (Phase 2), the admission it joined (Phase 3b) — it writes
to a private directory, and every later block reads it from there. A block
run again reads what the earlier phases wrote; it never selects again, so the
subtask Phases 3b to 5 act on is the one Phase 1 selected (ADR-0067 Decision
4, item 5). Before Phase 0:

1. Create the directory, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. Put that path in the `TEXT_DIR` line each block opens with. The blocks
   write every file in it themselves; none is written with your
   file-writing tool, and a file missing there means the phase that writes it
   has not run with this directory. Nothing deletes the directory: a headless
   run can deny `rm`, and it is under `$TMPDIR`.

The arguments above reach the blocks through an args file, never as shell
source (ADR-0059, C134(a)): typed into a block, a quote, `$` or backquote in
them would be read as code. Before Phase 0, too:

3. Create a private directory for the args file, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"
   ```

4. With your file-writing tool, not the shell, create `args.json` in that
   directory holding `{"agentic_args": 1, "text": "…"}`, with `text` set to
   the arguments above exactly as typed, as a JSON string (`""` when there
   are none). Put the directory's path in Phase 0's `ARGS_DIR` line.

**Arguments**: Phase 0 parses the args file with `state.mjs command-args
--command next` (grammar: `scripts/lib/command-args.mjs`), which removes the
file and its directory once read, and keeps the fields it prints in the text
directory as `arguments.json`, where every later block reads them:
- `subtask_id` ← the leading word (e.g., `PR1`), or empty if absent.
- `workflow_id` ← the value of `--workflow=<id>`, or empty if absent.

A refused text (an unknown option, a second subtask id, a word holding a quote
or backslash) stops Phase 0 with the reason, and nothing is selected; the
parse removed the args file, so write a new one before running Phase 0 again.
Once Phase 0 has kept `arguments.json`, Phase 0 run again with the same text
directory reads it; a new args file there is parsed too, and refused unless it
names the same arguments: to run with other arguments, start again from step 1
with a new text directory.

**Critical rules** (ADR-0019 §1):
- Do NOT invoke the engineer skill directly (`core/skills/<verb>/SKILL.md`) — bypasses Phase 0 bootstrap and drops the parent linkage the engineer terminal note needs.
- Do NOT call `engineer state.mjs create` directly — bypasses the engineer command's runbook semantics.
- All AGENTIC_* env exports + the engineer command's Phase 0+ snippets MUST run in the **same shell session** (a single Bash tool call). The Bash tool spawns a fresh process per call, so split execution drops the env exports — emit the prelude exports inline at the top of each engineer Phase 0 bash block, OR run the entire engineer Phase 0+verb as one consolidated Bash tool invocation. The CLAUDE_PLUGIN_ROOT rebind also lives in the same block; argv positions use `$ENGINEER_PLUGIN_ROOT` directly (not the rebound `$CLAUDE_PLUGIN_ROOT`).
- Branch precondition order is fixed: clean-check → resolve `subtasks[i].branch` → ownership-check → engineer preflight → join the run locks → switch → invoke → writeback → release. Any reordering breaks the §1 invariants.
- Admission (ADR-0067 Decision 4, item 5): Phase 3b joins the locks an autopilot run takes and writes this session's admission id to the text directory (an empty id for a worker of the run that holds them), where every later block reads it as `ADMISSION`. Each block that switches the branch, dispatches into the checkout or writes the macro checks it first, and every exit after the join releases it.

---

## Phase 0 — Workflow continuity (resolve the macro plan)

ADR-0019 §1 lines 187-213 — orchestrator workflows span multiple branches (macro + N subtask branches). Resolution order: `--workflow=<id>` override → `find-active` on current branch → `find-macro` branch-agnostic scan.

```bash
TEXT_DIR='<directory from step 1>'
ARGS_DIR='<directory from step 3>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
GIT_BRANCH="$(git branch --show-current)"
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — orchestrator workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to the macro branch first: git switch <branch>" >&2
  exit 1
fi
# The arguments, parsed from the args file the agent wrote (ADR-0059, C134(a)):
# command-args reads it by next's grammar and removes it, so its fields are kept
# in the text directory, where Phase 1 and a rerun of this block read them. No
# character the user typed is shell source. A new args file beside kept
# arguments is parsed too, and refused unless it names the same arguments: a
# rerun never selects by other arguments than the kept ones without a word.
if [ ! -f "$TEXT_DIR/arguments.json" ]; then
  ARGS_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" command-args \
    --command next --args-file "$ARGS_DIR/args.json")" || exit 1
  printf '%s' "$ARGS_JSON" > "$TEXT_DIR/arguments.json" || exit 1
elif [ -e "$ARGS_DIR/args.json" ]; then
  ARGS_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" command-args \
    --command next --args-file "$ARGS_DIR/args.json")" || exit 1
  [ "$ARGS_JSON" = "$(cat "$TEXT_DIR/arguments.json")" ] || {
    echo "✗ The args file in ARGS_DIR ($ARGS_DIR) names other arguments than the ones kept in TEXT_DIR ($TEXT_DIR); nothing was selected. To run with these arguments, start again from step 1 with a new text directory." >&2
    exit 1
  }
fi
ARG_WORKFLOW_ID="$(node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).workflow_id))' < "$TEXT_DIR/arguments.json")" || exit 1
MACRO_PATH=""
if [ -n "$ARG_WORKFLOW_ID" ]; then
  # Reject path-component overrides — `--workflow=../archive/<id>` would
  # otherwise let the macro path escape `workflows/` and target archived
  # or unrelated files (Codex P2 finding; mirrors PR-C's path-traversal
  # guard in parent-writeback.mjs).
  case "$ARG_WORKFLOW_ID" in
    # No NUL case: a shell variable cannot hold NUL, and bash expands $'\0'
    # to an empty string, which made the pattern match every id.
    */*|*\\*|..|.*)
      echo "✗ --workflow=$ARG_WORKFLOW_ID invalid — must be a basename-shaped workflow id (no '/', '\\\\', '..', or leading '.')." >&2
      exit 1;;
  esac
  # ADR-0067 Decision 4, item 2 — the macro file in the orchestrator workflow
  # homes of this checkout's read set, the default state root's first. Two
  # files holding the id are an error, named on stderr, never a choice.
  if ! MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$ARG_WORKFLOW_ID")"; then
    echo "✗ --workflow=$ARG_WORKFLOW_ID names no single macro file in the orchestrator workflow homes of this checkout's read set (the reason is above)." >&2
    echo "  Use \`gh pr list\` or run /orchestrator:plan to start a new macro." >&2
    exit 1
  fi
else
  MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    find-active --repo-root "$REPO_ROOT")"
  RC=$?
  if [ "$RC" -ne 0 ]; then
    exit "$RC"
  fi
  if [ -z "$MACRO_PATH" ]; then
    MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
      find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH")"
    RC=$?
    if [ "$RC" -ne 0 ]; then
      # find-macro exits 1 + ambiguous diagnostic when two macros
      # reference the same subtask branch (ADR-0019 §1 fail-closed).
      exit "$RC"
    fi
  fi
fi
if [ -z "$MACRO_PATH" ]; then
  echo "✗ No macro workflow references branch '$GIT_BRANCH'." >&2
  echo "  Use --workflow=<id> to specify, or run /orchestrator:plan to start one." >&2
  exit 1
fi
# For every later block, each of which may run in a fresh shell.
printf '%s' "$REPO_ROOT" > "$TEXT_DIR/repo-root" || exit 1
printf '%s' "$MACRO_PATH" > "$TEXT_DIR/macro-path" || exit 1
```

---

## Phase 1 — Subtask selection (deterministic — Codex P2 policy)

Three outcomes — explicit id, automatic first-ready, or actionable diagnostic:

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
# The subtask id Phase 0 parsed from the arguments, or empty.
ARG_SUBTASK_ID="$(node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).subtask_id))' < "$TEXT_DIR/arguments.json")" || exit 1
SUBTASK_JSON=""
if [ -n "$ARG_SUBTASK_ID" ]; then
  # Explicit id — read that subtask. PR-C0's absorbing-completed
  # / terminal-partial preconditions reject downgrades downstream;
  # the runbook only validates the id resolves cleanly here.
  SUBTASK_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    read-subtask --workflow-path "$MACRO_PATH" --subtask-id "$ARG_SUBTASK_ID")"
  if [ $? -ne 0 ]; then exit 1; fi
else
  # Automatic — first subtask with status=pending AND every blocked_by
  # predecessor status=completed. next-ready emits a structured JSON
  # diagnostic for the no-candidate cases so we can pick the right
  # recovery message.
  NEXT_OUT="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    next-ready --workflow-path "$MACRO_PATH")"
  if [ $? -ne 0 ]; then exit 1; fi
  # The document goes through printf, not echo, whose zsh builtin (and a POSIX
  # sh's) expands the backslash escapes inside JSON strings; the parse waits for
  # the whole document, which a pipe hands over in chunks; and a document that
  # does not parse fails the block rather than reading as nothing (C68).
  READY="$(printf '%s' "$NEXT_OUT" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);if(o.ready)process.stdout.write(JSON.stringify(o.ready))})')" || exit 1
  if [ -z "$READY" ]; then
    REASON="$(printf '%s' "$NEXT_OUT" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).reason||"unknown"))')" || exit 1
    case "$REASON" in
      empty_plan)
        echo "✗ Macro plan has no subtasks. Run /orchestrator:plan to add some." >&2
        exit 1;;
      all_terminal)
        # Dispatch guard (not a verb completion) — names the single honest
        # recovery for this state per session-handoff.md § Active Next-Action
        # Proposal meta/guard exception: the macro is ready to close.
        echo "✓ All subtasks reached a terminal status — nothing to dispatch. The macro is ready to close via /orchestrator:finalize (terminal close), or the auto-archive Stop hook once terminal_marker is set." >&2
        exit 1;;
      in_progress_or_blocked)
        # ADR-0062 §Decision 5 — print the facts next-ready computed from the
        # plan, not a guess from the status. An in_progress subtask whose
        # engineer workflow has committed stays in_progress until it lands.
        echo "✗ No subtask is ready to dispatch. Open subtasks:" >&2
        printf '%s' "$NEXT_OUT" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);for(const r of o.readiness||[]){let why;if(r.status==="in_progress")why="in progress; once its pull request has merged, record it with /orchestrator:done "+r.id;else if(r.stale_blocked)why="marked blocked, but every predecessor is completed (written before the shared unblock pass); repair: state.mjs subtask-update --subtask-id="+r.id+" --status=pending";else if(r.waiting_on.length>0)why="waiting on "+r.waiting_on.join(", ");else why=r.status;process.stderr.write("  - "+r.id+": "+why+"\n")}})'
        exit 1;;
      *)
        echo "✗ Unexpected next-ready reason: $REASON" >&2
        exit 1;;
    esac
  fi
  SUBTASK_JSON="$READY"
fi
# The selection, which every later phase reads from here (ADR-0067 Decision 4,
# item 5): none selects again.
printf '%s' "$SUBTASK_JSON" > "$TEXT_DIR/subtask.json" || exit 1
# Prints the field named by JSON_KEY of the JSON document on stdin, or "" when
# it is absent or null; a document that does not parse fails (C68). The key
# travels in the environment: before any shell sees this file, Claude replaces
# a dollar sign followed by a digit with the command's argument at that index
# (C67).
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
SUBTASK_ID="$(JSON_KEY=id node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
if [ -z "$SUBTASK_ID" ]; then
  echo "✗ The selected subtask has no id; nothing was selected." >&2
  exit 1
fi
```

Validate the resolved subtask is dispatch-ready (mirrors `next-ready`'s gate so explicit-id selection cannot bypass dependency ordering — Codex P2 finding):

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
SUBTASK_ID="$(JSON_KEY=id node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_STATUS="$(JSON_KEY=status node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
# ADR-0062 §Decision 5 — the dependency facts come from the state CLI, which
# parses the plan properly; they hold for an explicitly chosen subtask even
# when another one is ready.
READINESS="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  subtask-readiness --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID")" || exit 1
WAITING_ON="$(printf '%s' "$READINESS" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).waiting_on.join(", ")))')" || exit 1
STALE_BLOCKED="$(printf '%s' "$READINESS" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write(String(JSON.parse(d).stale_blocked)))')" || exit 1
case "$SUBTASK_STATUS" in
  completed) echo "✗ Subtask $SUBTASK_ID already completed; nothing to dispatch." >&2; exit 1;;
  deferred|abandoned) echo "✗ Subtask $SUBTASK_ID is terminal-partial ($SUBTASK_STATUS) — set by /orchestrator:finalize or /abort. Cannot re-dispatch." >&2; exit 1;;
  in_progress) ;;  # idempotent re-attach path handled in Phase 2 ownership check
  pending)
    # Dispatching before every predecessor has landed would start this work
    # on a base that lacks it.
    if [ -n "$WAITING_ON" ]; then
      echo "✗ Subtask $SUBTASK_ID is pending but waits on: $WAITING_ON." >&2
      echo "  Record each predecessor with /orchestrator:done <id> once its pull request has merged, or pick a different subtask." >&2
      exit 1
    fi
    ;;
  blocked)
    if [ "$STALE_BLOCKED" = "true" ]; then
      echo "✗ Subtask $SUBTASK_ID is marked blocked, but every predecessor is completed — the file was written before the shared unblock pass (ADR-0062 §Decision 5)." >&2
      echo "  Repair: node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" subtask-update --workflow-path \"$MACRO_PATH\" --host <host> --subtask-id $SUBTASK_ID --status=pending, then rerun /orchestrator:next." >&2
    else
      echo "✗ Subtask $SUBTASK_ID is blocked — it waits on: $WAITING_ON." >&2
    fi
    exit 1;;
esac
```

Then apply the plan-approval gate (ADR-0063 D4 rule 3, owner decision D3).
`state.mjs approval-gate` decides from the approval facts `next-ready` reports
(`{status, hash_ok}`), so this runbook never compares plan hashes itself. It
runs for an explicit id as well as for the automatic pick, because
`subtask-readiness` reports no approval. It is given the subtask as selected
above, because that — not the plan the gate reads — is what Phases 4 and 5
dispatch.

- **Autopilot** (`AGENTIC_AUTOPILOT` names a run): a plan that is not approved
  at its current hash — pending approval, changed since it was approved, or
  never approved — is refused with `✗ plan-unapproved` and a pointer to where
  the owner acts, exit 1. Stop there: only the owner approves
  (`/orchestrator:approve`). So is a selected subtask that differs from the
  approved plan's entry (the plan changed after the selection); rerun
  `/orchestrator:next`.
- **Interactive:** never refused. A plan pending approval or changed since it
  was approved gets one warning line, and dispatch continues. A macro planned
  before schema 1.2 has no approval keys and dispatches as before, with no line.

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
SUBTASK_JSON="$(cat "$TEXT_DIR/subtask.json")" || exit 1
# The gate prints its warning or refusal on stderr; the JSON verdict it
# prints on stdout is for scripts, not for this runbook.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" approval-gate \
  --workflow-path "$MACRO_PATH" --host claude \
  --subtask-json "$SUBTASK_JSON" >/dev/null || exit 1
```

Then the hold gate (ADR-0068 Decision 2, item 5): a held subtask is never
dispatched by hand, from whatever checkout this runs in. `state.mjs hold-gate`
refuses a subtask whose hold is pending, held or cannot be read, whose release
no run has compared yet or was rejected, and one with a persona operation open
in its lane, naming the exit (the owner's `agentic-autopilot release`, a run
that compares the release, or `writer-clear` for an operation whose session is
gone). It only reads, and prints nothing for a macro whose holds are not on.
Phase 3b judges it again under the admission.

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(cat "$TEXT_DIR/repo-root")" || exit 1
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
SUBTASK_ID="$(JSON_KEY=id node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_BRANCH="$(JSON_KEY=branch node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" hold-gate \
  --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" \
  --branch "$SUBTASK_BRANCH" --checkout "$REPO_ROOT" || exit 1
```

---

## Phase 2 — Branch precondition (ADR-0019 §1 lines 122-185, fixed order)

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(cat "$TEXT_DIR/repo-root")" || exit 1
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
MACRO_ID="$(basename "$MACRO_PATH" .md)"
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
SUBTASK_ID="$(JSON_KEY=id node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_BRANCH="$(JSON_KEY=branch node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_EXISTING_ENG_WF_ID="$(JSON_KEY=engineer_workflow_id node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
# Step 1: clean-worktree check — BEFORE any git switch.
if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]; then
  echo "✗ Working tree not clean — /orchestrator:next does not switch branches over uncommitted changes." >&2
  echo "  (engineer's Phase 0 status_digest capture is meaningful only on a clean tree.)" >&2
  # ADR-0067 Decision 8, item 3 — a worktree first, from a fixed template,
  # where the new worktree can find the macro; read-only.
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" worktree-proposal \
    --workflow-path "$MACRO_PATH" --repo-root "$REPO_ROOT" --subtask-id "$SUBTASK_ID" \
    --host claude --format text >&2 || true
  echo "  Or, when these changes are this subtask's or are finished: commit, stash, or revert them here, then rerun /orchestrator:next." >&2
  exit 1
fi

# Step 2: resolve engineer plugin root via discover-engineer CLI.
ENGINEER_PLUGIN_ROOT="$(node "$CLAUDE_PLUGIN_ROOT/scripts/discover-engineer.mjs" discover)"  # stderr kept: a cross-host fallback is reported there (ADR-0061)
if [ -z "$ENGINEER_PLUGIN_ROOT" ]; then
  echo "✗ engineer plugin not found (env AGENTIC_ENGINEER_ROOT, Claude cache, Codex cache, sibling fallback all missed)." >&2
  echo "  Install engineer or set AGENTIC_ENGINEER_ROOT=<path> before /orchestrator:next dispatch." >&2
  exit 1
fi

# Step 3: ownership check on the subtask branch — re-attach / mismatch / no-active.
# stderr is left alone, not redirected, so engineer's per-branch
# single-active invariant violations (multiple workflow files on the branch,
# corrupt file) reach the output rather than being swallowed (Codex P2 finding).
EXISTING_ENG_PATH="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" --branch "$SUBTASK_BRANCH")"
RC=$?
if [ "$RC" -ne 0 ]; then
  exit "$RC"
fi

# Recorded engineer_workflow_id missing from active workflows (Codex P2
# finding): if the subtask already references an engineer workflow id
# but find-active returns nothing on this branch, the previously
# recorded child was archived (or moved/deleted). Creating a new
# bootstrap would land an unrelated id, and Phase 5's writeback would
# reject it as ownership mismatch — leaving the user on the subtask
# branch with a stray active engineer workflow. Fail early instead.
if [ -n "$SUBTASK_EXISTING_ENG_WF_ID" ] && [ -z "$EXISTING_ENG_PATH" ]; then
  echo "✗ Subtask $SUBTASK_ID references engineer_workflow_id=$SUBTASK_EXISTING_ENG_WF_ID but no active engineer workflow exists on branch '$SUBTASK_BRANCH'." >&2
  echo "  The recorded child has usually finished its commit and been archived; the subtask stays in_progress until the work lands (ADR-0062)." >&2
  echo "    1. Once its pull request has merged, record it with /orchestrator:done $SUBTASK_ID." >&2
  echo "    2. If you want to dispatch a fresh attempt, clear the engineer_workflow_id field by re-running /orchestrator:plan (full re-plan)." >&2
  exit 1
fi
if [ -n "$EXISTING_ENG_PATH" ]; then
  # The read's own status, apart from the parser's: a pipe would report only
  # the parser's (C110).
  EXISTING_ENG_JSON="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" read \
    --workflow-path "$EXISTING_ENG_PATH")" || exit 1
  EXISTING_ENG_PARENT="$(printf '%s' "$EXISTING_ENG_JSON" | JSON_KEY=parent_workflow node -e "$JSON_FIELD")" || exit 1
  EXISTING_ENG_SUBTASK="$(printf '%s' "$EXISTING_ENG_JSON" | JSON_KEY=originating_subtask node -e "$JSON_FIELD")" || exit 1
  if [ "$EXISTING_ENG_PARENT" = "$MACRO_ID" ] && [ "$EXISTING_ENG_SUBTASK" = "$SUBTASK_ID" ]; then
    echo "→ Idempotent re-attach: engineer workflow $(basename "$EXISTING_ENG_PATH" .md) already owns this subtask. Proceeding with switch + resume." >&2
  else
    echo "✗ engineer workflow already active on branch '$SUBTASK_BRANCH' with a different parent linkage." >&2
    echo "  Existing: parent_workflow=$EXISTING_ENG_PARENT, originating_subtask=$EXISTING_ENG_SUBTASK" >&2
    echo "  Requested: parent_workflow=$MACRO_ID, originating_subtask=$SUBTASK_ID" >&2
    echo "  Either archive the unrelated workflow ($EXISTING_ENG_PATH) or pick a different subtask branch in the macro plan." >&2
    exit 1
  fi
fi
# For Phases 3 to 5: the engineer root, and the workflow the ownership check
# saw on the subtask branch (empty when none), which Phase 3b compares again.
printf '%s' "$ENGINEER_PLUGIN_ROOT" > "$TEXT_DIR/engineer-root" || exit 1
printf '%s' "$EXISTING_ENG_PATH" > "$TEXT_DIR/engineer-workflow" || exit 1
```

Phase 2 only reads: a refusal here leaves nothing behind. The switch is
Phase 3b's, after the engineer preflight and the join.

A dirty tree's refusal selects a worktree first (ADR-0067 Decision 8, item 3):
`state.mjs worktree-proposal` prints the `git worktree add` command for the
subtask's branch at `<parent>/<repo>-<slug>`, runtime:worktree's path, then the
`/orchestrator:next` to run again inside the new worktree. Its proposal is the
refusal's `selected_next`, with commit, stash or revert here among the rejected
alternatives (right when the changes are this subtask's or finished; wrong when
they are other work, which a switch would carry along). When the subtask's
branch is checked out in this very checkout and the subtask is in progress, the
changes are its engineer workflow's: the selection is the ordinary resume of
that workflow on this branch (`/engineer:resume`), and no worktree is
proposed. It proposes none, and says why, where a worktree cannot help
otherwise: the macro is in a linked worktree's own home, which no other
worktree reads (the state-root cutover, `docs/runbooks/state-root-cutover.md`,
makes a second worktree usable), or the subtask's branch is checked out here
for a subtask not yet in progress.

---

## Phase 3 — Engineer plugin minimum-version preflight

Read-only, so it runs before the switch: an engineer install that fails it
leaves the checkout where it was.

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ENGINEER_PLUGIN_ROOT="$(cat "$TEXT_DIR/engineer-root")" || exit 1
node "$CLAUDE_PLUGIN_ROOT/scripts/discover-engineer.mjs" preflight \
  --root "$ENGINEER_PLUGIN_ROOT" || {
  echo "✗ engineer install at $ENGINEER_PLUGIN_ROOT does not satisfy ADR-0019 PR-A minimum (preflight failed; see preceding diagnostic for cause)." >&2
  exit 1
}
# ADR-0068 Decision 2, item 9 — while the macro's holds are on, the engineer
# this dispatches into must be hold-aware: an older one writes terminal and
# leaves no operation a hold would see. Nothing for a macro whose holds are off.
REPO_ROOT="$(cat "$TEXT_DIR/repo-root")" || exit 1
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
SUBTASK_ID="$(JSON_KEY=id node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_BRANCH="$(JSON_KEY=branch node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" hold-gate \
  --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" \
  --branch "$SUBTASK_BRANCH" --checkout "$REPO_ROOT" \
  --engineer-root "$ENGINEER_PLUGIN_ROOT" || exit 1
```

The `preflight` subcommand prints the precise reason on its own stderr — surface it as-is.

---

## Phase 3b — Join the run locks, then switch (ADR-0067 Decision 4, item 5)

An autopilot run holds this checkout's worktree lock and its macro's lock
while it works. This command takes part in both, in the order the driver
takes them, as an **admission**: `admission join` writes one entry under a
random id in each, and refuses, naming the holder, when a run or another
session is there. A worker of the run that holds them passes with no entry and
an empty id. Then the block reads again what a run's step or a plan revision
could have changed before the join (the tree, the subtask branch's engineer
workflow, the selected subtask's status, engineer workflow id, branch, verb,
profile and topic, and for a pending subtask whether it still waits on
nothing) and switches. Every exit from the join until the switch has succeeded releases the
admission.

Before the switch it judges the hold gate again, under the holds lock, and,
for a subtask with no engineer workflow yet and a macro whose holds are on,
publishes the dispatch's **mark** (ADR-0068 Decision 2, item 5; N4): an
operation record of the lane that the engineer's bootstrap continues under the
id Phase 4 exports (`AGENTIC_OPERATION_ID`). A hold the owner sets from here on
waits for the dispatch to finish, so this command never records a subtask in
progress that its engineer then refuses. The block keeps the mark in the text
directory (`dispatch-mark.json`); every exit from its publication on withdraws
a mark no child carries (this block's on a refusal, Phase 5's on every path).
A re-attach publishes none: the engineer's resume opens its own operation,
which the mark would refuse.

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
case "$CLAUDE_PLUGIN_ROOT" in
  *"/.codex/"*) DETECTED_HOST="codex" ;;
  *"/.claude/"*) DETECTED_HOST="claude" ;;
  *) DETECTED_HOST="${AGENTIC_HOST:-claude}" ;;
esac
REPO_ROOT="$(cat "$TEXT_DIR/repo-root")" || exit 1
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
MACRO_ID="$(basename "$MACRO_PATH" .md)"
ENGINEER_PLUGIN_ROOT="$(cat "$TEXT_DIR/engineer-root")" || exit 1
EXISTING_ENG_PATH="$(cat "$TEXT_DIR/engineer-workflow")" || exit 1
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
SUBTASK_ID="$(JSON_KEY=id node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_BRANCH="$(JSON_KEY=branch node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_STATUS="$(JSON_KEY=status node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
# The id this prints is this session's admission, which every later block
# reads from the text directory. A refusal names the holder and writes nothing.
ADMISSION="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" admission join \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --command next \
  --host "$DETECTED_HOST" --session-id "${CLAUDE_CODE_SESSION_ID:-}")" || exit 1
# ADR-0068 Decision 2, item 5 — a dispatch mark kept in the text directory
# goes with every exit that releases the admission, unless the engineer's
# bootstrap took it over.
withdraw_mark() {
  [ -f "$TEXT_DIR/dispatch-mark.json" ] || return 0
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" dispatch-mark-withdraw \
    --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" --branch "$SUBTASK_BRANCH" \
    --checkout "$REPO_ROOT" --mark-file "$TEXT_DIR/dispatch-mark.json"
}
release_admission() {
  withdraw_mark
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
}
trap 'release_admission' EXIT
printf '%s' "$ADMISSION" > "$TEXT_DIR/admission" || exit 1
if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]; then
  echo "✗ The working tree changed after Phase 2's clean check; nothing was switched. Rerun /orchestrator:next." >&2
  exit 1
fi
NOW_ENG_PATH="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" --branch "$SUBTASK_BRANCH")" || exit 1
if [ "$NOW_ENG_PATH" != "$EXISTING_ENG_PATH" ]; then
  echo "✗ The engineer workflow on '$SUBTASK_BRANCH' changed after Phase 2's ownership check (was '${EXISTING_ENG_PATH:-none}', now '${NOW_ENG_PATH:-none}'); nothing was switched. Rerun /orchestrator:next." >&2
  exit 1
fi
# The subtask as Phase 1 selected it, every field Phase 1 read that a later
# phase acts on: a run's step may have completed it, and archived its child, and
# a plan revision may have changed its branch, verb, profile or topic, before
# the join. The read's status is its own, apart from the comparison's (C110).
NOW_SUBTASK="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read-subtask \
  --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID")" || exit 1
SUBTASK_CHANGES="$(printf '%s' "$NOW_SUBTASK" \
  | node -e 'const fs=require("fs");let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const now=JSON.parse(d),was=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),out=[];for(const k of ["status","engineer_workflow_id","branch","verb","profile","topic"]){const a=String(was[k]||""),b=String(now[k]||"");if(a!==b)out.push(k+" was "+JSON.stringify(a)+", now "+JSON.stringify(b))}process.stdout.write(out.join("; "))})' \
  "$TEXT_DIR/subtask.json")" || exit 1
if [ -n "$SUBTASK_CHANGES" ]; then
  echo "✗ Subtask $SUBTASK_ID changed after Phase 1's selection ($SUBTASK_CHANGES); nothing was switched. Rerun /orchestrator:next." >&2
  exit 1
fi
# Phase 1's dependency gate, judged again: a plan revision may have given the
# pending subtask a predecessor not yet completed, with every field above
# unchanged.
if [ "$SUBTASK_STATUS" = "pending" ]; then
  READINESS_NOW="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" subtask-readiness \
    --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID")" || exit 1
  WAITING_NOW="$(printf '%s' "$READINESS_NOW" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).waiting_on.join(", ")))')" || exit 1
  if [ -n "$WAITING_NOW" ]; then
    echo "✗ Subtask $SUBTASK_ID now waits on: $WAITING_NOW (the plan changed after Phase 1's selection); nothing was switched. Record each predecessor with /orchestrator:done <id> once its pull request has merged, then rerun /orchestrator:next." >&2
    exit 1
  fi
fi
# ADR-0068 Decision 2, item 5 — the hold gate again, under the holds lock, and
# the dispatch's mark for a bootstrap; a re-attach gets none. A mark an earlier
# run of this block left goes first.
withdraw_mark
REATTACH=false
if [ -n "$EXISTING_ENG_PATH" ]; then REATTACH=true; fi
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" dispatch-mark-publish \
  --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" --branch "$SUBTASK_BRANCH" \
  --checkout "$REPO_ROOT" --host "$DETECTED_HOST" --reattach "$REATTACH" \
  --mark-file "$TEXT_DIR/dispatch-mark.json" || exit 1

# The switch. The user lands on $SUBTASK_BRANCH whether or not
# we re-attached — engineer's resume keys on `git branch --show-current`.
# A new branch starts from the integration branch (the macro's baseline
# branch) as the remote last reported it, never from the checked-out HEAD:
# after a squash or rebase merge, the previous subtask's branch is not part
# of the integration branch, and a successor built on it would carry
# obsolete history (ADR-0062 §Decision 2).
# --- ADR-0062 branch-base step (extracted by tests) ---
# The read's status is its own, apart from the parser's: piped, a failed read
# would show as a macro with no baseline branch (C110).
MACRO_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$MACRO_PATH")" || exit 1
INTEGRATION_BRANCH="$(printf '%s' "$MACRO_JSON" \
  | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write((JSON.parse(d).git_baseline||{}).branch||""))')" || exit 1
if [ -z "$INTEGRATION_BRANCH" ]; then
  echo "✗ The macro records no git_baseline.branch; cannot tell which branch subtasks start from." >&2
  exit 1
fi
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$SUBTASK_BRANCH"; then
  git -C "$REPO_ROOT" switch "$SUBTASK_BRANCH" || exit $?
elif git -C "$REPO_ROOT" remote get-url origin >/dev/null 2>&1; then
  if ! git -C "$REPO_ROOT" fetch --quiet origin "$INTEGRATION_BRANCH"; then
    echo "⚠ git fetch origin $INTEGRATION_BRANCH failed; branching from the last fetched origin/$INTEGRATION_BRANCH." >&2
  fi
  if ! git -C "$REPO_ROOT" show-ref --verify --quiet "refs/remotes/origin/$INTEGRATION_BRANCH"; then
    echo "✗ refs/remotes/origin/$INTEGRATION_BRANCH does not exist; cannot start $SUBTASK_BRANCH from the integration branch." >&2
    exit 1
  fi
  git -C "$REPO_ROOT" switch --no-track -c "$SUBTASK_BRANCH" "refs/remotes/origin/$INTEGRATION_BRANCH" || exit $?
  echo "→ Created $SUBTASK_BRANCH from origin/$INTEGRATION_BRANCH at $(git -C "$REPO_ROOT" rev-parse --short HEAD)." >&2
else
  # A repository without an origin remote has only the local branch.
  git -C "$REPO_ROOT" switch -c "$SUBTASK_BRANCH" "refs/heads/$INTEGRATION_BRANCH" || exit $?
  echo "→ Created $SUBTASK_BRANCH from local $INTEGRATION_BRANCH (no origin remote)." >&2
fi
# --- end ADR-0062 branch-base step ---
# Switched: from here the admission is held until Phase 5 releases it.
trap - EXIT
```

---

## Phase 4 — Invoke engineer command (single-shell-session contract)

ADR-0019 §1 lines 252-287 — every emitted engineer snippet runs in a subshell with rebound `CLAUDE_PLUGIN_ROOT` and uses `$ENGINEER_PLUGIN_ROOT` directly in argv. Because the Bash tool spawns a fresh process per invocation, the exports MUST live in the **same bash block** as the engineer command's Phase 0 snippets — emit them as the prelude of a single combined Bash tool call.

**Host auto-detection** (Codex P2 finding): the prelude below infers the host from the orchestrator root's path shape (Claude cache lives under `~/.claude/`; Codex cache lives under `~/.codex/`). Direct-checkout development falls back to `claude` (override via `AGENTIC_HOST=codex` env if needed).

Drive the engineer command's runbook from a single Bash tool call that opens with this prelude. It reads everything it exports from the text directory, so it runs as written in any shell. **Save the orchestrator's plugin root BEFORE rebinding** — after the rebind `$CLAUDE_PLUGIN_ROOT` names the engineer's root, and the `admission check` is an orchestrator CLI that MUST be invoked through the orchestrator's `state.mjs`, not engineer's:

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ORCH_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"          # save before the rebind below
case "$ORCH_PLUGIN_ROOT" in
  *"/.codex/"*) DETECTED_HOST="codex" ;;
  *"/.claude/"*) DETECTED_HOST="claude" ;;
  *) DETECTED_HOST="${AGENTIC_HOST:-claude}" ;;
esac
REPO_ROOT="$(cat "$TEXT_DIR/repo-root")" || exit 1
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
MACRO_ID="$(basename "$MACRO_PATH" .md)"
ENGINEER_PLUGIN_ROOT="$(cat "$TEXT_DIR/engineer-root")" || exit 1
ADMISSION="$(cat "$TEXT_DIR/admission")" || exit 1
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
SUBTASK_ID="$(JSON_KEY=id node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_BRANCH="$(JSON_KEY=branch node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_VERB="$(JSON_KEY=verb node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_PROFILE="$(JSON_KEY=profile node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_TOPIC="$(JSON_KEY=topic node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1

# ADR-0067 Decision 4, item 5 — this block dispatches into the checkout: stop
# before it when this session's admission is gone (Phase 5 still runs, and
# releases what is left of it).
node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" admission check \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION" || exit 1
# ADR-0068 Decision 2, item 5 — the hold gate once more, beside the dispatch's
# own mark; then the mark's id for the engineer's bootstrap to continue
# (AGENTIC_OPERATION_ID), none for a re-attach or a macro whose holds are off.
node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" dispatch-mark-check \
  --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" --branch "$SUBTASK_BRANCH" \
  --checkout "$REPO_ROOT" --mark-file "$TEXT_DIR/dispatch-mark.json" \
  --engineer-root "$ENGINEER_PLUGIN_ROOT" || exit 1
DISPATCH_OPERATION_ID="$(JSON_KEY=operation_id node -e "$JSON_FIELD" < "$TEXT_DIR/dispatch-mark.json")" || exit 1
if [ -n "$DISPATCH_OPERATION_ID" ]; then
  export AGENTIC_OPERATION_ID="$DISPATCH_OPERATION_ID"
else
  unset AGENTIC_OPERATION_ID
fi

export CLAUDE_PLUGIN_ROOT="$ENGINEER_PLUGIN_ROOT"
export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"
# ADR-0067 Decision 3 — the macro file's absolute path, which the engineer
# records beside the id and its writeback tries first, so a child whose own
# checkout holds no copy of the macro still reaches it.
export AGENTIC_PARENT_WORKFLOW_PATH="$MACRO_PATH"
export AGENTIC_ORIGINATING_SUBTASK="$SUBTASK_ID"
# ADR-0067 Decision 4, item 5 — the selection Phase 1 made, which the engineer
# records beside the ids: every later binding of the child to this subtask
# (Phase 5, the engineer's terminal note, /orchestrator:done's owner scan)
# compares it under the macro's file lock.
# Built apart from its export, which would hide the node's failure: a selection
# lost here would create a child without the record.
AGENTIC_DISPATCH_SELECTION="$(node -e 'const [subtask, branch, verb, profile, topic] = process.argv.slice(1); process.stdout.write(JSON.stringify({ subtask, branch, verb, profile, topic }))' -- "$SUBTASK_ID" "$SUBTASK_BRANCH" "$SUBTASK_VERB" "${SUBTASK_PROFILE:-}" "${SUBTASK_TOPIC:-}")" || exit 1
export AGENTIC_DISPATCH_SELECTION
export AGENTIC_HOST="$DETECTED_HOST"

# Forward subtask profile/topic to the engineer command via env vars
# (orchestrator-defined contract). engineer's Phase 0 boilerplate reads
# AGENTIC_PROFILE and AGENTIC_TOPIC alongside the four parent-linkage
# vars and forwards them as --profile / --original-request flags to
# state.mjs create. This is the orchestrator-driven equivalent of the
# user typing `--profile=<X>` / a topic argument at the command line —
# the engineer command's argument placeholder is replaced by env vars in
# the dispatched path because the host fills that placeholder from what the
# user typed, not from the caller's environment. (This comment does not
# spell the placeholder: Claude would substitute it here too.)
export AGENTIC_PROFILE="${SUBTASK_PROFILE:-}"
export AGENTIC_TOPIC="${SUBTASK_TOPIC:-}"

# Follow $ENGINEER_PLUGIN_ROOT/commands/$SUBTASK_VERB.md as if the user
# typed `/engineer:$SUBTASK_VERB`. The engineer command's Phase 0
# boilerplate reads all six AGENTIC_* env vars above and forwards
# them to state.mjs create (parent linkage + host + profile + topic).
```

**Important**: the LLM following this runbook MUST read engineer's command markdown and execute its bash snippets in the same Bash tool invocation as the exports above, OR re-emit this prelude — its `TEXT_DIR` line, the `admission check` and the AGENTIC_* exports — at the top of each engineer Phase 0 bash block. The simplest and most robust shape is a single Bash tool call that begins with the prelude and proceeds through engineer's Phase 0+verb body inline. Re-emitted, the prelude's hold check passes once the engineer's own operation holds the lane, whatever hold was set since (ADR-0068 Decision 2, item 5).

Whatever the engineer runbook's outcome — it finished, stopped at a gate, or one of its blocks exited non-zero (a `create` the repository-wide check refused, for one) — go on to Phase 5: the engineer's exits cannot release this command's admission, and Phase 5 releases it on every path.

---

## Phase 5 — Post-create writeback (engineer_workflow_id + status=in_progress)

After engineer's Phase 0 creates the workflow file and the verb skill begins, capture the engineer workflow id and write it back to the macro plan so `/orchestrator:done` and `find-active` can locate the child. The block reads `SUBTASK_ID`, `SUBTASK_BRANCH`, `SUBTASK_VERB`, `SUBTASK_PROFILE` and `SUBTASK_TOPIC` from the selection Phase 1 wrote (the writeback expects the last four unchanged), and the admission from the file Phase 3b wrote. It sets the orchestrator's plugin root itself, as `$ORCH_PLUGIN_ROOT`, and the host: in a fresh Bash call nothing Phase 4 set is left, and in the shell of Phase 4's engineer call `$CLAUDE_PLUGIN_ROOT` names the engineer's root until the opening line sets it back. Without them the check and the release would fail, and the admission would stay in both locks, blocking the macro until someone releases it by hand:

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ORCH_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"
case "$ORCH_PLUGIN_ROOT" in
  *"/.codex/"*) DETECTED_HOST="codex" ;;
  *"/.claude/"*) DETECTED_HOST="claude" ;;
  *) DETECTED_HOST="${AGENTIC_HOST:-claude}" ;;
esac
# What the release needs, before anything else: every exit after these reads
# releases the admission. Should one of them be gone, the block cannot release
# an admission Phase 3b may have joined: the next join's refusal names it, with
# the command that releases it.
for CARRIED in repo-root macro-path admission; do
  [ -f "$TEXT_DIR/$CARRIED" ] || { echo "✗ $TEXT_DIR/$CARRIED is missing, so this block cannot release the admission Phase 3b joined, if it joined: the next /orchestrator:next refusal names it and the command that releases it." >&2; exit 1; }
done
REPO_ROOT="$(cat "$TEXT_DIR/repo-root")" || exit 1
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
MACRO_ID="$(basename "$MACRO_PATH" .md)"
ADMISSION="$(cat "$TEXT_DIR/admission")" || exit 1
# ADR-0067 Decision 4, item 5 — every exit of this block releases the
# admission Phase 3b joined; the writeback, which writes the macro, checks it
# first. From the writeback on, the driver's own claim rules see the subtask.
# ADR-0068 Decision 2, item 5 — and withdraws the dispatch's mark Phase 3b
# kept, unless the engineer's bootstrap took it over (its last write removes
# it then). It reads the subtask itself: an exit may come before the reads
# below.
withdraw_mark() {
  [ -f "$TEXT_DIR/dispatch-mark.json" ] || return 0
  MARK_SUBTASK="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).id||""))' "$TEXT_DIR/subtask.json")" || return 0
  MARK_BRANCH="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).branch||""))' "$TEXT_DIR/subtask.json")" || return 0
  node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" dispatch-mark-withdraw \
    --workflow-path "$MACRO_PATH" --subtask-id "$MARK_SUBTASK" --branch "$MARK_BRANCH" \
    --checkout "$REPO_ROOT" --mark-file "$TEXT_DIR/dispatch-mark.json"
}
release_admission() {
  withdraw_mark
  node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
}
trap 'release_admission' EXIT
ENGINEER_PLUGIN_ROOT="$(cat "$TEXT_DIR/engineer-root")" || exit 1
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
SUBTASK_ID="$(JSON_KEY=id node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_BRANCH="$(JSON_KEY=branch node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_VERB="$(JSON_KEY=verb node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_PROFILE="$(JSON_KEY=profile node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_TOPIC="$(JSON_KEY=topic node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
# ADR-0068 Decision 2, item 5 — only a dispatch whose check before the
# engineer passed is recorded, the holds on or off: a refused one is not (its
# refusal removes any earlier pass), nor one whose switch left no mark to check.
if [ ! -f "$TEXT_DIR/dispatch-mark.json" ]; then
  echo "✗ $TEXT_DIR/dispatch-mark.json is missing, so no check before the engineer passed for this dispatch; subtask $SUBTASK_ID is not recorded in progress. A mark the switch published, if it did, stays open in subtask $SUBTASK_ID's lane until the owner clears it (agentic-autopilot status --macro $MACRO_ID names it; agentic-autopilot writer-clear ends it)." >&2
  exit 1
elif [ ! -f "$TEXT_DIR/dispatch-mark.json.checked" ]; then
  echo "✗ The hold check before the engineer did not pass for this dispatch; subtask $SUBTASK_ID is not recorded in progress. Rerun /orchestrator:next once it is free." >&2
  exit 1
fi
ACTIVE_PATH="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" --branch "$SUBTASK_BRANCH" 2>/dev/null)"
if [ -z "$ACTIVE_PATH" ]; then
  echo "✗ engineer command terminated but no active workflow on $SUBTASK_BRANCH — bootstrap may have failed (check engineer's preceding diagnostics)." >&2
  exit 1
fi
ENGINEER_WF_ID="$(basename "$ACTIVE_PATH" .md)"
# The dispatch the child records (ADR-0067 Decision 4, item 5), for a child
# Phase 4 created and for one re-attached from an earlier dispatch alike.
CHILD_DISPATCH="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
  dispatch-selection --workflow-path "$ACTIVE_PATH")" || exit 1

node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" admission check \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION" || exit 1
# The child is bound only to the subtask it was dispatched for: the write is
# refused, under the macro's file lock, when a plan revision since Phase 1
# changed the subtask's branch, verb, profile or topic, or when the subtask is
# no longer the one the child records it was dispatched for.
node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" subtask-update \
  --workflow-path="$MACRO_PATH" \
  --host="$DETECTED_HOST" \
  --subtask-id="$SUBTASK_ID" \
  --status=in_progress \
  --engineer-workflow-id="$ENGINEER_WF_ID" \
  --expect-branch="$SUBTASK_BRANCH" --expect-verb="$SUBTASK_VERB" \
  --expect-profile="$SUBTASK_PROFILE" --expect-topic="$SUBTASK_TOPIC" \
  --expect-dispatch="$CHILD_DISPATCH" \
  --event=updated
```

Surface the orchestrator JSON envelope. The block ends by withdrawing the dispatch's mark when no child carries it (the engineer's bootstrap refused or never ran) and releasing the admission, whatever the writeback's outcome; a failed `admission check` means the admission was released meanwhile (a run or another session may hold the macro now), and the child stays unrecorded until a later `/orchestrator:next` re-attaches it. PR-C0 handles single-writer ownership rejection, absorbing-completed precondition, and unblock/auto-terminal passes — surface its stderr verbatim on any non-zero exit.

The admission keeps out a run and the other commands that join, not a plan revision (`/orchestrator:plan` stays available, ADR-0067 Decision 4): Phase 3b's re-read catches one made before it, and the writeback's expectations one made since; the child's recorded dispatch also refuses a re-attached child an earlier dispatch made for the subtask as it was then. A refused writeback names the field that changed. The child it would have bound was dispatched for the subtask as Phase 1 read it, so it stays unrecorded: report the refusal and the child's workflow id, and leave the choice to the user (archive the child with `/engineer:resume archive <id>` on its branch and rerun `/orchestrator:next`, or revise the plan back). A change of only the subtask's `topic` or `profile` has a third exit: the owner approves the revised plan with `/orchestrator:approve`, which rebinds the child to the words approved and tells it the change (ADR-0068 Decision 8); the re-attach then binds it. The refusal's `No rebinding applies: …` clause says why it was not rebound: the plan is pending approval or changed since, the approval rebound another child or other words, or the child has not been told yet. Whatever its dispatch, the re-attach also refuses a child the macro's record cannot vouch for (ADR-0068 Decision 8, item 4): one a note to which is still pending (`has not been told the subtask's words yet`), one last told other words for the subtask (`was last told other words`), and, after an approval replaced an unreadable record of rebindings, one whose last words are not known (`what <child> was last told is not known`). Its exits: deliver the note (a run does at the child's next boundary, or `state.mjs rebind-deliver` now); approve the plan as it stands, which tells the child the subtask's words (in full, when it replaced the record and can read the child); or revise the plan back to the words the child was last told. An archived child, which no note reaches, is completed by `/orchestrator:done --waive-dispatch` with a reason, which the macro records. A run asks the same check at the child's step boundary, of the child the step would run (the recorded owner, or, when none is recorded, the child the run selected): it does not step a child the check refuses (its lane parks, or a serial run halts) and names the same exits. An approval tells only the child it would rebind: when the subtask records no owner and several workflows claim it, the refusal names recording the child its owner first (`subtask-update --expect-dispatch`, which `/orchestrator:done` prints).

If the envelope reports `skipped: true` (deferred / abandoned absorbing-terminal state), report it and stop — `/orchestrator:next` should NOT advance a subtask the user has already terminated via `/finalize` / `/abort`.

---

## Completion

Report one of:

- `✓ Subtask <id> dispatched. engineer_workflow_id=<id> on branch <branch>.` (happy path, status=in_progress recorded.)
- `✓ Subtask <id> already in_progress — re-attached to existing engineer workflow <id>.` (idempotent re-attach.)
- `✓ Subtask <id> auto-promoted: engineer Stop hook had already completed it; macro now terminal_marker=true.` (rare race; PR-C0 auto-terminal pass fired.)
- `✗ Not dispatched: <holder>.` when Phase 3b's join was refused — an autopilot run or another session holds this checkout or the macro. Repeat the refusal's holder and the command it names (`/orchestrator:autopilot status` in the run's checkout, or the release command for a session the owner knows is gone); nothing was switched or written.
- `✗ Not dispatched: subtask <id> is held.` when a hold gate refused (Phase 1, 3, 3b or 4): the owner holds the subtask, its release waits for a run's comparison or was rejected, a persona operation is open in its lane, or the macro's holds are on and the engineer is not hold-aware. Repeat the refusal's reason and the exit it names (the owner's `agentic-autopilot release`, a run, `writer-clear`, the engineer release to install); nothing was recorded, and the dispatch's mark is withdrawn.
- `✗ Not recorded: subtask <id> changed after its dispatch (<field>).` when Phase 5's writeback was refused — the plan was revised after Phase 1 read the subtask. Name the child's engineer workflow id, which stays unrecorded, and the choice Phase 5 leaves to the user.
- `✗ Not dispatched: the working tree is not clean.` when Phase 2's first check refused. The proposal below selects the worktree `worktree-proposal` printed (its commands, then the `/orchestrator:next` inside it) and rejects commit, stash or revert here with their reason. When it printed no worktree because the subtask's branch is checked out here with the subtask in progress, select continuing that subtask's engineer workflow on this branch (`/engineer:resume`), and reject commit, stash or revert by hand and a new worktree; when it printed none for another reason, name the reason and select commit, stash or revert.

When the Phase 1 approval gate printed its warning line, repeat that line
under the report. A refused dispatch (`✗ plan-unapproved`) reports the gate's
two lines and nothing was dispatched.

ARCHIVE TIMING — in that auto-promoted case the macro is terminal without any
`set-terminal` call of its own: the Phase 5 `subtask-update` auto-terminal pass
sets the marker. On Claude the Stop hook fires at **every turn end**, so the
macro archive gates are **evaluated** at the end of **this** turn, not at session
close, and the file moves then if they all pass. To hold it open, run the full
`state.mjs set-terminal` form (`--workflow-path`, `--host`, `--terminal-phase`
are all required) with `--terminal-marker false` before that Stop fires. On Codex
the Stop hook runs only once the operator has trusted the plugin hooks
(`/hooks`), so the evaluation waits for that. Full contract:
`core/skills/_shared/references/session-handoff.md` § Archive timing.

Then emit an **Active Next-Action Proposal** instead of a fixed next command, per
`core/skills/_shared/references/session-handoff.md § Active Next-Action Proposal`
(canonical: `entry-routing-contract.md § Active Next-Action Proposal` in the
engineer plugin) — the canonical six-field template (runtime
completion-output contract):

```
- selected_next:         <macro action | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <macro plan / subtask states / phase notes — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /orchestrator:<command> … — or the wait / owner-decision action>
```

Derive from the post-dispatch macro state: when more
subtasks are ready, `selected_next` is typically another `/orchestrator:next`
after the current subtask commits; when all subtasks reach terminal status, it is
`/orchestrator:finalize` (or the auto-archive once macro `terminal_marker` is
set); when the dispatched engineer workflow is still in flight, it is waiting on
that subtask's commit. Reason from the state rather than a hardcoded literal.

Append the runtime completion footer after the dispatch summary. Use the
runtime footer helper when available, or render the same fields manually:
context state, completion state plus state-derived next action, workflow
id/path, artifact pointers, recommended next work, and next-session
action/command or prompt pointer. The footer is advisory
and pointer-only; do not mutate host session context or paste raw peer /
consensus output into the main session.

Before rendering the footer, surface the ADR-0031 session-level
continue-vs-fresh preflight per
`core/skills/_shared/references/session-handoff.md`: compute the orchestrator macro
projection (resolved across branches via find-active then find-macro) and pass
it to the runtime footer/check (`--workflow-projection-file`) so the footer
carries the continue-vs-fresh decision. On detached HEAD, report "no active
branch context" — do not auto-recommend a fresh session.
