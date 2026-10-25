---
description: Record a macro subtask completed once its work has landed — resolves the pull request's merge commit (ADR-0062)
argument-hint: <subtask-id> [--pr=<n>] [--commit=<sha>] [--correct | --no-commit] [--waive-dispatch] [--workflow=<macro-id>] [--integration-branch=<b>] [reason]
---

# Orchestrator · Done

$ARGUMENTS

Record a macro subtask as `completed` once its work has **landed** on the integration branch. This is the step that completes a subtask (ADR-0062 §Decision 2): the engineer's Phase 7 and Stop hook only note the branch commit and keep the subtask `in_progress`, because this repository squash- or rebase-merges every pull request and the branch commit never reaches `main`. Run `/orchestrator:done` after the pull request merges; its successors become dispatchable then.

The recorded `commit` is the pull request's **merge commit** — the squash commit for a squash merge, the last rebased commit for a rebase merge — resolved and verified by `state.mjs resolve-landing` (ADR-0062 §Decision 1).

Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ORCHESTRATOR_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep that opening line when you run a block: a
shell variable does not outlive a Bash call.

**Arguments** reach the block through an args file, never as shell source (ADR-0059, C134(a)): typed into a block, a quote, `$` or backquote in an id or a reason would be read as code, and a heredoc ends at a line of the reason that reads its delimiter. Before the block:

1. Create a private directory for the file, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"
   ```

2. With your file-writing tool (Claude: the Write tool), not the shell, create `args.json` in that directory holding `{"agentic_args": 1, "text": "…"}`, with `text` set to the arguments above exactly as typed, as a JSON string.

Then run the block with that directory in its `ARGS_DIR` line. The block reads the file with `state.mjs command-args --command done` (grammar: `scripts/lib/command-args.mjs`), which removes the file and its directory once read, so each run of the block takes a new args file. The fields it reads:
- `subtask_id` ← the leading word (required).
- `pr` ← the value of `--pr=<n>`: names the pull request when more than one merged the branch.
- `commit` ← the value of `--commit=<sha>`: must equal that pull request's merge commit; without a working `gh` it is verified by ancestry only.
- `correct` ← `--correct`: replace a recorded value deliberately. Needs a reason.
- `no_commit` ← `--no-commit`: the work legitimately landed no commit (for example an investigation closed with evidence only). Needs a reason. Excludes `--pr`, `--commit` and `--correct`.
- `waive_dispatch` ← `--waive-dispatch`: complete the subtask in its recorded owner's name without comparing the dispatch that owner records, because no file of it is left to read it from (Phase 2 says when); or, when that dispatch is read, complete an archived owner the macro's record cannot vouch for (Phase 3b says when). Needs a reason; the macro records the waiver and the reason.
- `workflow_id` ← the value of `--workflow=<id>`.
- `integration_branch` ← the value of `--integration-branch=<b>`; default is the macro's `git_baseline.branch`.
- `reason` ← the free text after the subtask id and the options, byte for byte; a lone `--` before it lets it name one of done's options. The block writes it to a file of its own, which `state.mjs` reads.

The parser refuses, and nothing is written: a missing subtask id, an unknown or repeated option, `--no-commit` with `--pr`, `--commit` or `--correct`, an option after the reason began (unless `--` opened it), and a subtask id or option holding a quote or backslash (a value is written bare, so a branch such as `fix/o'brien` cannot be named here, nor a subtask whose id holds a quote, a backslash or a space, or starts with `-`). The reason takes any text.

**Phases 0–3 are one block, run in one Bash call** (below, after the phases it runs). Each Bash tool call is a fresh shell, so no phase may rely on a variable another call set: the block reads its arguments from the args file at its top.

**Critical rules** (ADR-0062):
- Never record the subtask branch tip or `git rev-parse HEAD`. A squash or rebase merge leaves both outside the integration branch.
- A completion writeback MUST supply the matching `engineer_workflow_id` (ADR-0019 §4 ownership, unchanged).
- A recorded `commit` or `pr_url` is never replaced, and a recorded `closed_at` is kept, unless `--correct` with a reason; the macro body then records the old value, the new value and the reason.
- `--expect-branch` is always passed, so a plan revision between resolving the landing and writing it is refused.
- The write completes the subtask in its owner's name, so it always compares the dispatch that owner records (`--expect-dispatch`, ADR-0067 Decision 4, item 5). When it cannot be read, done refuses; only `--waive-dispatch` with a reason writes without the comparison, and the macro body records it. The write also binds the owner only while the macro's record of rebindings vouches for what it was told (ADR-0068 Decision 8, item 4); for an archived owner, which no note reaches, `--waive-dispatch` with a reason is the way out, and the macro body records it.
- Only active macros are addressed. An archived macro is a frozen record (ADR-0062 §Decision 7).

---

## Phase 0 — Resolve the macro plan

`--workflow=<id>` names the macro (refused unless basename-shaped, and resolved in the orchestrator workflow homes of this checkout's read set); otherwise `find-active` on the current branch, then `find-macro` for a subtask branch.

## Phase 1 — Read the subtask, check the flags and the reason file

The subtask as the macro records it. A `deferred` or `abandoned` subtask is refused (terminal-partial states are absorbing); a `completed` one, without `--correct`, is a no-op. With `--correct`, `--no-commit` or `--waive-dispatch`, a reason is required. The reason stays in the file the block wrote it to (`REASON_FILE`): the block only checks that it holds text, and Phase 3 hands the file's bytes to `state.mjs`, so the shell never reads the reason as text.

## Phase 2 — Resolve the owning engineer workflow

The write in Phase 3 completes the subtask in its owner's name, so it compares the dispatch that owner records (ADR-0067 Decision 4, item 5: `dispatched_*`, or its `git_baseline` branch when it was created before that record), and is refused under the macro's file lock when the subtask is no longer the one the owner was dispatched for. `state.mjs owner-dispatch` finds the owner and reads that dispatch. It reads every engineer workflow file in the workflow homes **and archive homes** of every root of the repository (by the time the work has merged, the child has normally archived itself) and parses the frontmatter values it needs, never matching serialized text:

- `EXISTING_ENG_WF_ID` set (the normal path after `/orchestrator:next` recorded it, or after the engineer terminal note bound it) → the file of that workflow that claims the subtask. When no file of it is left anywhere in the repository (a lane's home removed, for example), the dispatch cannot be read: done refuses, and only a rerun with `--waive-dispatch` and a reason completes the subtask without the comparison. A file of it that claims another subtask refuses, with no waiver.
- Otherwise → the one workflow whose `parent_workflow == $MACRO_ID` **and** `originating_subtask == $SUBTASK_ID`. None refuses (the subtask was likely never dispatched). More than one refuses rather than guessing: it lists each claimant with a binding line that carries that claimant's dispatch (`subtask-update --engineer-workflow-id=<id> --expect-dispatch=<its dispatch>`), so the owner chosen is bound only while the subtask is the one it was dispatched for; then rerun done.

A home or file that cannot be read (anything but a missing one) also refuses, since it could hide a claimant or the owner's file. `DISPATCH_ARGS` carries the comparison, or the waiver, into Phase 3a or 3b.

## Phase 3a — `--no-commit`: completion without a landed commit

Refused while an engineer workflow for this subtask is still **active**: a child whose branch never moved cannot archive itself, and it would keep the macro's no-active-children gate closed forever. Also refused when a workflow home or file cannot be read (anything but a missing one): the unreadable entry could be that child. The check runs again after the join (ADR-0067 Decision 4, item 5), since a run's step could have dispatched the subtask again before it.

## Phase 3b — Resolve the landing and record it

`resolve-landing` finds the merged pull request and verifies its merge commit (ADR-0062 §Decision 1); a routine refusal (`not_merged` and the rest) writes nothing. Then the block joins the macro's run lock and writes. A write refused with `dispatch-changed` bound and completed nothing: the owner, recorded or found by Phase 2's scan, was dispatched for the subtask as it was before a plan revision. Report it with the child's id and the refusal's `No rebinding applies: …` clause; the user revises the plan back, or dispatches the subtask again, or, when only the subtask's `topic` or `profile` changed, the owner approves the revised plan with `/orchestrator:approve`, which rebinds that child and tells it the change (ADR-0068 Decision 8): this write then accepts it. The clause names why no rebinding applied: the plan is pending approval (a `plan-set` after the approval suspends its rebindings), the approval rebound another child or other words or none, the child has not been told yet (a run tells it at its next boundary, or `state.mjs rebind-deliver`), or the change is to a `branch` or `verb`, which nothing rebinds. A waived write records `Dispatch not compared (--waive-dispatch)` and the reason in the macro body.

Whatever the dispatch comparison found, the write also refuses an owner the macro's record cannot vouch for (`<child> is not bound to subtask …`, ADR-0068 Decision 8, item 4): one a note to which is still pending, one last told other words for the subtask, or, after an approval replaced an unreadable record of rebindings, one whose last words are not known. Report it with the refusal's clause; it names the way out. For an active owner: deliver the note (a run does at the child's next boundary, or `state.mjs rebind-deliver` now), approve the plan as it stands, which tells it, or revise the plan back to the words it was last told. For an archived owner, which no note reaches: revise the plan back, or the user reruns done with `--waive-dispatch` and a reason, which completes it and records `Told check waived (--waive-dispatch)` and the reason in the macro body; the waiver is refused for an active owner, and when the record vouches for the owner (nothing to waive). Do not rerun with it on your own judgment.

`subtask-update` handles ownership, the provenance guard (a different recorded value is refused and names `--correct`), the unblock pass and the auto-terminal pass atomically; surface its JSON envelope. `noop: true` means the record already held these values.

## The block — Phases 0 to 3, in one shell call

One block, run in one Bash call: every value it reads is either a field of its parsed arguments or something it read itself, so it runs as written in a fresh shell (C75), bash or zsh (it uses bash arrays, which a POSIX `sh` such as dash does not have). Each JSON document goes to its parser through `printf`, the parser reads the whole document, and a read's status is checked apart from its parser's (C110).

```bash
ARGS_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# --- Phase 0: the macro plan ---
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
GIT_BRANCH="$(git branch --show-current)"
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD — orchestrator workflows are branch-anchored. Switch to any tracked branch first." >&2
  exit 1
fi

# --- The arguments: the args file, parsed (ADR-0059, C134(a)) ---
# command-args reads the file by done's grammar and removes it: it refuses a
# missing subtask id, an unknown or repeated option, --no-commit with --pr,
# --commit or --correct, and an id or option holding a quote or backslash. Each value
# below is read from what it printed, so no character the user typed is shell
# source. The reason goes from there to a file of its own, which state.mjs
# reads; the shell never holds it.
ARGS_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" command-args \
  --command done --args-file "$ARGS_DIR/args.json")" || exit 1
# Prints the field named by JSON_KEY of the JSON document on stdin, or "" when
# it is absent or null; a document that does not parse fails (C68). The key
# travels in the environment, not as a function argument: before any shell
# sees this file, Claude replaces a dollar sign followed by a digit with the
# command's argument at that index whenever there is one (C67). The document
# goes through printf, not echo, whose zsh builtin expands the backslash
# escapes inside JSON strings.
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
ARG_SUBTASK_ID="$(printf '%s' "$ARGS_JSON" | JSON_KEY=subtask_id node -e "$JSON_FIELD")" || exit 1
ARG_PR="$(printf '%s' "$ARGS_JSON" | JSON_KEY=pr node -e "$JSON_FIELD")" || exit 1
ARG_COMMIT="$(printf '%s' "$ARGS_JSON" | JSON_KEY=commit node -e "$JSON_FIELD")" || exit 1
ARG_WORKFLOW_ID="$(printf '%s' "$ARGS_JSON" | JSON_KEY=workflow_id node -e "$JSON_FIELD")" || exit 1
ARG_INTEGRATION_BRANCH="$(printf '%s' "$ARGS_JSON" | JSON_KEY=integration_branch node -e "$JSON_FIELD")" || exit 1
# The switches read true or false.
CORRECT="$(printf '%s' "$ARGS_JSON" | JSON_KEY=correct node -e "$JSON_FIELD")" || exit 1
NO_COMMIT="$(printf '%s' "$ARGS_JSON" | JSON_KEY=no_commit node -e "$JSON_FIELD")" || exit 1
WAIVE_DISPATCH="$(printf '%s' "$ARGS_JSON" | JSON_KEY=waive_dispatch node -e "$JSON_FIELD")" || exit 1
REASON_FILE="$(mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX")/reason.txt" || exit 1
printf '%s' "$ARGS_JSON" | node -e 'const fs=require("fs");let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>fs.writeFileSync(process.argv[1],JSON.parse(d).reason))' "$REASON_FILE" || exit 1

MACRO_PATH=""
if [ -n "$ARG_WORKFLOW_ID" ]; then
  # Reject path-component overrides — `--workflow=../archive/<id>` would
  # otherwise let the macro path escape `workflows/`.
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
    echo "✗ --workflow=$ARG_WORKFLOW_ID names no single macro file in the orchestrator workflow homes of this checkout's read set (the reason is above; archived macros are not addressed)." >&2
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
      exit "$RC"
    fi
  fi
fi
if [ -z "$MACRO_PATH" ]; then
  echo "✗ No macro workflow references branch '$GIT_BRANCH'. Use --workflow=<id>." >&2
  exit 1
fi
MACRO_ID="$(basename "$MACRO_PATH" .md)"

case "$CLAUDE_PLUGIN_ROOT" in
  *"/.codex/"*) DETECTED_HOST="codex" ;;
  *"/.claude/"*) DETECTED_HOST="claude" ;;
  *) DETECTED_HOST="${AGENTIC_HOST:-claude}" ;;
esac

# --- Phase 1: the subtask, the flags, the reason file ---
SUBTASK_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  read-subtask --workflow-path "$MACRO_PATH" --subtask-id "$ARG_SUBTASK_ID")" || exit 1

SUBTASK_ID="$ARG_SUBTASK_ID"
SUBTASK_BRANCH="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=branch node -e "$JSON_FIELD")" || exit 1
SUBTASK_STATUS="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=status node -e "$JSON_FIELD")" || exit 1
EXISTING_ENG_WF_ID="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=engineer_workflow_id node -e "$JSON_FIELD")" || exit 1
EXISTING_COMMIT="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=commit node -e "$JSON_FIELD")" || exit 1
EXISTING_CLOSED_AT="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=closed_at node -e "$JSON_FIELD")" || exit 1

if [ "$SUBTASK_STATUS" = "deferred" ] || [ "$SUBTASK_STATUS" = "abandoned" ]; then
  echo "✗ Subtask $SUBTASK_ID is $SUBTASK_STATUS — terminal-partial states are absorbing (set by /orchestrator:finalize or /abort)." >&2
  exit 1
fi
if [ "$SUBTASK_STATUS" = "completed" ] && [ "$CORRECT" != true ]; then
  echo "✓ Subtask $SUBTASK_ID is already completed at $EXISTING_CLOSED_AT with commit ${EXISTING_COMMIT:-<none>}. Nothing to do; to change the record, rerun with --correct and a reason." >&2
  exit 0
fi

HAS_REASON=0
if grep -q '[^[:space:]]' "$REASON_FILE"; then HAS_REASON=1; fi
if { [ "$CORRECT" = true ] || [ "$NO_COMMIT" = true ] || [ "$WAIVE_DISPATCH" = true ]; } && [ "$HAS_REASON" -eq 0 ]; then
  echo "✗ --correct, --no-commit and --waive-dispatch need a reason (the free text after the flags)." >&2
  exit 1
fi

# --- Phase 2: the owning engineer workflow and the dispatch it records ---
# ADR-0067 Decision 4, item 5 — the owner and the dispatch it records. Every
# refusal's reason is printed by owner-dispatch; exit 3 alone (the recorded
# owner has no file left) may be waived. With the dispatch read, the waiver is
# of the told check only (ADR-0068 Decision 8, item 4): subtask-update applies
# it to an archived child the macro's record cannot vouch for, and refuses it
# for any other.
OWNER_ARGS=(--repo-root "$REPO_ROOT" --macro-id "$MACRO_ID" --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" --host "$DETECTED_HOST")
[ -n "$EXISTING_ENG_WF_ID" ] && OWNER_ARGS+=(--engineer-workflow-id "$EXISTING_ENG_WF_ID")
# Under set -e an unguarded nonzero exit would end the block before OWNER_RC.
OWNER_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" owner-dispatch "${OWNER_ARGS[@]}")" && OWNER_RC=0 || OWNER_RC=$?
if [ "$OWNER_RC" -eq 0 ]; then
  EXISTING_ENG_WF_ID="$(printf '%s' "$OWNER_JSON" | JSON_KEY=engineer_workflow_id node -e "$JSON_FIELD")" || exit 1
  OWNER_DISPATCH="$(printf '%s' "$OWNER_JSON" | JSON_KEY=dispatch node -e "$JSON_FIELD")" || exit 1
  if [ -z "$EXISTING_ENG_WF_ID" ] || [ -z "$OWNER_DISPATCH" ]; then
    echo "✗ Could not read owner-dispatch's answer for $SUBTASK_ID; refusing to guess." >&2
    exit 1
  fi
  DISPATCH_ARGS=(--expect-dispatch="$OWNER_DISPATCH")
  if [ "$WAIVE_DISPATCH" = true ]; then DISPATCH_ARGS+=(--waive-told); fi
elif [ "$OWNER_RC" -eq 3 ] && [ "$WAIVE_DISPATCH" = true ]; then
  # The recorded owner's file is gone, and the operator completes in its name
  # anyway; subtask-update records the waiver and the reason in the macro.
  DISPATCH_ARGS=(--waive-dispatch)
else
  exit 1
fi

# --- Phase 3a: --no-commit, completion without a landed commit ---
if [ "$NO_COMMIT" = true ]; then
  # Returns non-zero, the reason on stderr, when an engineer workflow of this
  # subtask is active or a home cannot be read. active-child reads every root of
  # the repository (ADR-0067 Decision 1(b)) and parses each frontmatter, as
  # owner-dispatch does.
  no_active_child() {
    ACTIVE_CHILD="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" active-child \
      --repo-root "$REPO_ROOT" --macro-id "$MACRO_ID" --subtask-id "$SUBTASK_ID")" || {
      echo "✗ Could not scan the engineer workflow homes for an active child of $SUBTASK_ID (see the error above); refusing --no-commit." >&2
      return 1
    }
    if [ -n "$ACTIVE_CHILD" ]; then
      echo "✗ An engineer workflow for $SUBTASK_ID is still active: $ACTIVE_CHILD" >&2
      echo "  Archive it first (/engineer:resume archive on its branch), then rerun /orchestrator:done $SUBTASK_ID --no-commit." >&2
      return 1
    fi
  }
  no_active_child || exit 1
  # ADR-0067 Decision 4, item 5 — join the macro's run lock before the write:
  # a refusal names the autopilot run or session holding it, and writes
  # nothing. Every exit from here releases the admission.
  ADMISSION="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" admission join \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --command done \
    --host "$DETECTED_HOST" --session-id "${CLAUDE_CODE_SESSION_ID:-}")" || exit 1
  release_admission() {
    node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" admission release \
      --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
  }
  trap 'release_admission' EXIT
  # A run's step could have dispatched the subtask again before the join.
  no_active_child || exit 1
  # The write completes the subtask in its owner's name: only while the
  # subtask is the one that owner records it was dispatched for, unless the
  # operator waived that check (Phase 2).
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" subtask-update \
    --workflow-path="$MACRO_PATH" --host="$DETECTED_HOST" --subtask-id="$SUBTASK_ID" \
    --status=completed --engineer-workflow-id="$EXISTING_ENG_WF_ID" \
    --closed-at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" --expect-branch="$SUBTASK_BRANCH" \
    "${DISPATCH_ARGS[@]}" --reason-file="$REASON_FILE" --event=updated || exit $?
  exit 0
fi

# --- Phase 3b: resolve the landing and record it ---
if [ -n "$ARG_INTEGRATION_BRANCH" ]; then
  INTEGRATION_BRANCH="$ARG_INTEGRATION_BRANCH"
else
  # The read's status is its own, apart from the parser's: piped, a failed
  # read would leave the branch empty and the fetch below would name none
  # (C110).
  MACRO_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$MACRO_PATH")" || exit 1
  INTEGRATION_BRANCH="$(printf '%s' "$MACRO_JSON" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write((JSON.parse(d).git_baseline||{}).branch||""))')" || exit 1
  if [ -z "$INTEGRATION_BRANCH" ]; then
    echo "✗ The macro records no git_baseline.branch; name the integration branch with --integration-branch." >&2
    exit 1
  fi
fi
if ! git -C "$REPO_ROOT" fetch --quiet origin "$INTEGRATION_BRANCH"; then
  echo "⚠ git fetch origin $INTEGRATION_BRANCH failed; verifying against the last fetched origin/$INTEGRATION_BRANCH." >&2
fi
# The owner may have been recovered by the Phase 2 scan rather than read from
# the macro; pass it so the landing is bound to this attempt's dispatch time.
LANDING_ARGS=(--repo-root "$REPO_ROOT" --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" --integration-branch "$INTEGRATION_BRANCH" --engineer-workflow-id "$EXISTING_ENG_WF_ID")
[ -n "$ARG_PR" ] && LANDING_ARGS+=(--pr "$ARG_PR")
[ -n "$ARG_COMMIT" ] && LANDING_ARGS+=(--commit "$ARG_COMMIT")
LANDING="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" resolve-landing "${LANDING_ARGS[@]}")"
LANDING_RC=$?
if [ "$LANDING_RC" -ne 0 ]; then
  echo "✗ Cannot record $SUBTASK_ID yet — $(printf '%s' "$LANDING" | JSON_KEY=reason node -e "$JSON_FIELD"): $(printf '%s' "$LANDING" | JSON_KEY=detail node -e "$JSON_FIELD")" >&2
  exit 1
fi
COMMIT_SHA="$(printf '%s' "$LANDING" | JSON_KEY=commit node -e "$JSON_FIELD")" || exit 1
PR_URL="$(printf '%s' "$LANDING" | JSON_KEY=pr_url node -e "$JSON_FIELD")" || exit 1
VERIFICATION="$(printf '%s' "$LANDING" | JSON_KEY=verification node -e "$JSON_FIELD")" || exit 1
LANDING_NOTE=""
if [ "$VERIFICATION" = "ancestry-only" ]; then
  # Keep the weaker verification visible in the macro's record.
  LANDING_NOTE="Landing verified by ancestry only: gh was unavailable, so $COMMIT_SHA could not be matched to its pull request."
fi

# ADR-0067 Decision 4, item 5 — join the macro's run lock before the write: a
# routine refusal above (not_merged and the rest) left no entry; this one names
# the autopilot run or session holding the lock, and writes nothing. Every exit
# from here releases the admission. subtask-update checks ownership and
# provenance itself, under the macro's file lock.
ADMISSION="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" admission join \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --command done \
  --host "$DETECTED_HOST" --session-id "${CLAUDE_CODE_SESSION_ID:-}")" || exit 1
release_admission() {
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
}
trap 'release_admission' EXIT

UPDATE_ARGS=(--workflow-path="$MACRO_PATH" --host="$DETECTED_HOST" --subtask-id="$SUBTASK_ID"
  --status=completed --engineer-workflow-id="$EXISTING_ENG_WF_ID" --commit="$COMMIT_SHA"
  --closed-at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" --expect-branch="$SUBTASK_BRANCH" --event=updated)
[ -n "$PR_URL" ] && UPDATE_ARGS+=(--pr-url="$PR_URL")
# The write completes the subtask in its owner's name: only while the subtask
# is the one that owner records it was dispatched for, unless the operator
# waived that check (Phase 2).
UPDATE_ARGS+=("${DISPATCH_ARGS[@]}")
[ "$CORRECT" = true ] && UPDATE_ARGS+=(--correct)
if [ -n "$LANDING_NOTE" ] || [ "$HAS_REASON" -eq 1 ]; then
  # The note reaches state.mjs on stdin: the landing line, then the reason
  # copied byte for byte from REASON_FILE. No temporary file is written.
  {
    if [ -n "$LANDING_NOTE" ]; then printf '%s\n' "$LANDING_NOTE"; fi
    if [ "$HAS_REASON" -eq 1 ]; then cat "$REASON_FILE"; fi
  } | node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" subtask-update "${UPDATE_ARGS[@]}" --reason-file=- || exit $?
else
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" subtask-update "${UPDATE_ARGS[@]}" || exit $?
fi
```

---

## Completion

Report one of:

- `✓ Subtask <id> recorded completed. commit=<sha> (PR <url>) closed_at=<iso>. Auto-terminal=<true|false>.`
- `✓ Subtask <id> recorded completed without a landed commit. Reason: <reason>.`
- `✓ Subtask <id> corrected: <field> <old> -> <new>.`
- `✓ Subtask <id> auto-promoted: macro terminal_marker=true.` (terminal close — the code-emitted footer below surfaces the state-derived next action.)
- `✓ /orchestrator:done was a no-op — subtask <id> already records these values.`
- `✗ Cannot record <id> yet — <reason>: <detail>` (`not_merged`, `no_pr`, `ambiguous`, `base_mismatch`, `commit_mismatch`, `not_reachable`, `gh_unavailable`, `no_integration_ref`).
- `✗ Ownership conflict — engineer_workflow_id mismatch (existing=<X>, supplied=<Y>).`
- `✗ Not recorded — <id> changed after its child was dispatched (dispatch-changed): <what differs>; no rebinding applies: <why>.` Nothing was bound or completed.
- `✗ Not recorded — the recorded owner <X> has no workflow file left, so its dispatch cannot be read.` Repeat that `--waive-dispatch` with a reason completes it without the comparison, and that the macro records both; do not rerun with it on your own judgment.
- `✗ Not recorded — <child> is not bound to subtask <id>: <why>.` The macro's record cannot vouch for what the owner was told; repeat the way out the refusal names. For an archived owner, `--waive-dispatch` with a reason completes it, and the macro records the waiver; do not rerun with it on your own judgment.
- `✗ Not recorded — more than one engineer workflow claims <id>.` Repeat the claimants and their binding lines; the user picks the one that did the work.
- `✗ Not recorded: <holder>.` when the admission join was refused (ADR-0067 Decision 4, item 5) — an autopilot run or another session holds the macro. Repeat the refusal's holder and the command it names; nothing was written.

When subtasks remain (no auto-terminal), `/orchestrator:done` is a
**forward-decision** surface — emit an **Active Next-Action Proposal** instead of
a fixed next command, per
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

Derive from the post-completion macro state: typically
`/orchestrator:next` when this completion unblocked a subtask, or
`/orchestrator:finalize` when only intentionally-deferred work remains. When this
`/done` instead auto-terminalized the macro (its final subtask), it is a terminal
close: the code-emitted footer below surfaces the state-derived next action and
no hand-authored proposal is added.

The runtime completion footer is **code-emitted** on this command's terminal
path (ADR-0039): when this `/done` lands the macro's FINAL subtask, the
`state.mjs subtask-update` auto-terminal pass fires the ADR-0031 macro
session-handoff sidecar, which shells out to the runtime `footer.mjs` and prints
the rendered footer — context state, completion state + state-derived next
action, workflow id/path, artifact pointers, recommended next work, and the
continue-vs-fresh session-handoff — on this command's **stderr**. Do **not**
hand-compose a second footer in that case; surface the one the terminal write
already emitted. The footer is advisory + pointer-only and fail-closed (a
missing/too-old runtime emits nothing, and the SessionStart backstop still
re-surfaces the handoff); it never mutates host session context. When subtasks
remain (no auto-terminal), the macro stays active and no terminal footer is
emitted; report the completion/no-op summary above.

ARCHIVE TIMING — that auto-terminal promotion sets the macro `terminal_marker`,
and on Claude the Stop hook fires at **every turn end**, so the macro archive
gates are **evaluated** at the end of **this** turn, not at session close. By the
time the work has merged, the engineer child has normally archived itself at its
own Stop, so the gates often all pass and the macro file moves this turn. An
engineer child that is still active keeps the no-active-children gate closed and
the macro stays marked for a later Stop. To hold it open, run the full
`state.mjs set-terminal` form (`--workflow-path`, `--host`, `--terminal-phase`
are all required) with `--terminal-marker false` before that Stop fires — that
clears only the marker and does not reopen the subtask. Once the file has moved,
recovery is a fresh `/orchestrator:plan`; an archived macro is outside
`find-active`. On Codex the Stop hook runs only once the operator has trusted the
plugin hooks (`/hooks`), so the evaluation waits for that.
