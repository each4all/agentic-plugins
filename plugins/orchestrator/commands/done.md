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

**Argument parsing**: extract from `$ARGUMENTS`:
- `EXPLICIT_SUBTASK_ID` ← the leading positional token (required).
- `EXPLICIT_PR` ← value of `--pr=<n>`: names the pull request when more than one merged the branch.
- `EXPLICIT_COMMIT` ← value of `--commit=<sha>`: must equal that pull request's merge commit; without a working `gh` it is verified by ancestry only.
- `CORRECT` ← `1` when `--correct` is present: replace a recorded value deliberately. Needs a reason.
- `NO_COMMIT` ← `1` when `--no-commit` is present: the work legitimately landed no commit (for example an investigation closed with evidence only). Needs a reason. Excludes `--pr`, `--commit` and `--correct`.
- `WAIVE_DISPATCH` ← `1` when `--waive-dispatch` is present: complete the subtask in its recorded owner's name without comparing the dispatch that owner records, because no file of it is left to read it from (Phase 2 says when). Needs a reason; the macro records the waiver and the reason.
- `EXPLICIT_WORKFLOW_ID` ← value of `--workflow=<id>`.
- `EXPLICIT_INTEGRATION_BRANCH` ← value of `--integration-branch=<b>`; default is the macro's `git_baseline.branch`.
- `REASON` ← the remaining free text, verbatim. It never passes through the shell (ADR-0059): before running the block below, write it to a new file with your file-writing tool (Claude: the Write tool), exactly as given, and set `REASON_FILE` to that file's path at the top of the block. Leave `REASON_FILE` unset when there is no reason. A heredoc is not safe here: a reason that contains the delimiter line ends it and runs what follows.

**Run Phases 0–3 in one Bash invocation.** Each Bash tool call is a fresh shell, so the variables set in Phase 1 do not survive into a later call. Write `REASON_FILE` (when there is a reason) before that invocation.

**Critical rules** (ADR-0062):
- Never record the subtask branch tip or `git rev-parse HEAD`. A squash or rebase merge leaves both outside the integration branch.
- A completion writeback MUST supply the matching `engineer_workflow_id` (ADR-0019 §4 ownership, unchanged).
- A recorded `commit` or `pr_url` is never replaced, and a recorded `closed_at` is kept, unless `--correct` with a reason; the macro body then records the old value, the new value and the reason.
- `--expect-branch` is always passed, so a plan revision between resolving the landing and writing it is refused.
- The write completes the subtask in its owner's name, so it always compares the dispatch that owner records (`--expect-dispatch`, ADR-0067 Decision 4, item 5). When it cannot be read, done refuses; only `--waive-dispatch` with a reason writes without the comparison, and the macro body records it.
- Only active macros are addressed. An archived macro is a frozen record (ADR-0062 §Decision 7).

---

## Phase 0 — Resolve the macro plan

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD — orchestrator workflows are branch-anchored. Switch to any tracked branch first." >&2
  exit 1
fi

if [ -z "${EXPLICIT_SUBTASK_ID:-}" ]; then
  echo "✗ /orchestrator:done requires a <subtask-id> argument." >&2
  exit 1
fi

MACRO_PATH=""
if [ -n "${EXPLICIT_WORKFLOW_ID:-}" ]; then
  # Reject path-component overrides — `--workflow=../archive/<id>` would
  # otherwise let the macro path escape `workflows/`.
  case "$EXPLICIT_WORKFLOW_ID" in
    # No NUL case: a shell variable cannot hold NUL, and bash expands $'\0'
    # to an empty string, which made the pattern match every id.
    */*|*\\*|..|.*)
      echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID invalid — must be a basename-shaped workflow id (no '/', '\\\\', '..', or leading '.')." >&2
      exit 1;;
  esac
  # ADR-0067 Decision 4, item 2 — the macro file in the orchestrator workflow
  # homes of this checkout's read set, the default state root's first. Two
  # files holding the id are an error, named on stderr, never a choice.
  if ! MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$EXPLICIT_WORKFLOW_ID")"; then
    echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID names no single macro file in the orchestrator workflow homes of this checkout's read set (the reason is above; archived macros are not addressed)." >&2
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
```

---

## Phase 1 — Read the subtask, check the flags, write the reason file

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
SUBTASK_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  read-subtask --workflow-path "$MACRO_PATH" --subtask-id "$EXPLICIT_SUBTASK_ID")" || exit 1

SUBTASK_ID="$EXPLICIT_SUBTASK_ID"
# Prints the field named by JSON_KEY of the JSON document on stdin, or "" when
# it is absent or null. The key travels in the environment, not as a function
# argument: before any shell sees this file, Claude replaces a dollar sign
# followed by a digit with the command's argument at that index whenever there
# is one (C67). The document goes through printf, not echo, whose zsh builtin
# expands the backslash escapes inside JSON strings.
JSON_FIELD='let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))}catch{}})'
SUBTASK_BRANCH="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=branch node -e "$JSON_FIELD")"
SUBTASK_STATUS="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=status node -e "$JSON_FIELD")"
EXISTING_ENG_WF_ID="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=engineer_workflow_id node -e "$JSON_FIELD")"
EXISTING_COMMIT="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=commit node -e "$JSON_FIELD")"
EXISTING_CLOSED_AT="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=closed_at node -e "$JSON_FIELD")"

if [ "${NO_COMMIT:-}" = "1" ] && { [ -n "${EXPLICIT_COMMIT:-}" ] || [ -n "${EXPLICIT_PR:-}" ] || [ "${CORRECT:-}" = "1" ]; }; then
  echo "✗ --no-commit excludes --commit, --pr and --correct." >&2
  exit 1
fi
if [ "$SUBTASK_STATUS" = "deferred" ] || [ "$SUBTASK_STATUS" = "abandoned" ]; then
  echo "✗ Subtask $SUBTASK_ID is $SUBTASK_STATUS — terminal-partial states are absorbing (set by /orchestrator:finalize or /abort)." >&2
  exit 1
fi
if [ "$SUBTASK_STATUS" = "completed" ] && [ "${CORRECT:-}" != "1" ]; then
  echo "✓ Subtask $SUBTASK_ID is already completed at $EXISTING_CLOSED_AT with commit ${EXISTING_COMMIT:-<none>}. Nothing to do; to change the record, rerun with --correct and a reason." >&2
  exit 0
fi
```

When `CORRECT=1`, `NO_COMMIT=1` or `WAIVE_DISPATCH=1`, a reason is required. The reason stays in `REASON_FILE`: the runbook only checks that it holds text, and Phase 3 hands the file's bytes to `state.mjs`, so the shell never reads the reason as text:

```bash
if [ -n "${REASON_FILE:-}" ] && [ ! -f "$REASON_FILE" ]; then
  echo "✗ REASON_FILE=$REASON_FILE does not exist; write the reason with your file-writing tool first." >&2
  exit 1
fi
HAS_REASON=0
if [ -n "${REASON_FILE:-}" ] && grep -q '[^[:space:]]' "$REASON_FILE"; then HAS_REASON=1; fi
if { [ "${CORRECT:-}" = "1" ] || [ "${NO_COMMIT:-}" = "1" ] || [ "${WAIVE_DISPATCH:-}" = "1" ]; } && [ "$HAS_REASON" -eq 0 ]; then
  echo "✗ --correct, --no-commit and --waive-dispatch need a reason (the free text after the flags)." >&2
  exit 1
fi
```

---

## Phase 2 — Resolve the owning engineer workflow

The write in Phase 3 completes the subtask in its owner's name, so it compares the dispatch that owner records (ADR-0067 Decision 4, item 5: `dispatched_*`, or its `git_baseline` branch when it was created before that record), and is refused under the macro's file lock when the subtask is no longer the one the owner was dispatched for. `state.mjs owner-dispatch` finds the owner and reads that dispatch. It reads every engineer workflow file in the workflow homes **and archive homes** of every root of the repository (by the time the work has merged, the child has normally archived itself) and parses the frontmatter values it needs, never matching serialized text:

- `EXISTING_ENG_WF_ID` set (the normal path after `/orchestrator:next` recorded it, or after the engineer terminal note bound it) → the file of that workflow that claims the subtask. When no file of it is left anywhere in the repository (a lane's home removed, for example), the dispatch cannot be read: done refuses, and only a rerun with `--waive-dispatch` and a reason completes the subtask without the comparison. A file of it that claims another subtask refuses, with no waiver.
- Otherwise → the one workflow whose `parent_workflow == $MACRO_ID` **and** `originating_subtask == $SUBTASK_ID`. None refuses (the subtask was likely never dispatched). More than one refuses rather than guessing: it lists each claimant with a binding line that carries that claimant's dispatch (`subtask-update --engineer-workflow-id=<id> --expect-dispatch=<its dispatch>`), so the owner chosen is bound only while the subtask is the one it was dispatched for; then rerun done.

A home or file that cannot be read (anything but a missing one) also refuses, since it could hide a claimant or the owner's file. `DISPATCH_ARGS` carries the comparison, or the waiver, into Phase 3a or 3b:

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# ADR-0067 Decision 4, item 5 — the owner and the dispatch it records. Every
# refusal's reason is printed by owner-dispatch; exit 3 alone (the recorded
# owner has no file left) may be waived.
OWNER_ARGS=(--repo-root "$REPO_ROOT" --macro-id "$MACRO_ID" --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" --host "$DETECTED_HOST")
[ -n "$EXISTING_ENG_WF_ID" ] && OWNER_ARGS+=(--engineer-workflow-id "$EXISTING_ENG_WF_ID")
# Under set -e an unguarded nonzero exit would end the block before OWNER_RC.
OWNER_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" owner-dispatch "${OWNER_ARGS[@]}")" && OWNER_RC=0 || OWNER_RC=$?
if [ "$OWNER_RC" -eq 0 ]; then
  if [ "${WAIVE_DISPATCH:-}" = "1" ]; then
    echo "✗ --waive-dispatch applies only when the owner's dispatch cannot be read; it was read, and the write compares it. Rerun without --waive-dispatch." >&2
    exit 1
  fi
  EXISTING_ENG_WF_ID="$(printf '%s' "$OWNER_JSON" | JSON_KEY=engineer_workflow_id node -e "$JSON_FIELD")"
  OWNER_DISPATCH="$(printf '%s' "$OWNER_JSON" | JSON_KEY=dispatch node -e "$JSON_FIELD")"
  if [ -z "$EXISTING_ENG_WF_ID" ] || [ -z "$OWNER_DISPATCH" ]; then
    echo "✗ Could not read owner-dispatch's answer for $SUBTASK_ID; refusing to guess." >&2
    exit 1
  fi
  DISPATCH_ARGS=(--expect-dispatch="$OWNER_DISPATCH")
elif [ "$OWNER_RC" -eq 3 ] && [ "${WAIVE_DISPATCH:-}" = "1" ]; then
  # The recorded owner's file is gone, and the operator completes in its name
  # anyway; subtask-update records the waiver and the reason in the macro.
  DISPATCH_ARGS=(--waive-dispatch)
else
  exit 1
fi
```

---

## Phase 3a — `--no-commit`: completion without a landed commit

Refused while an engineer workflow for this subtask is still **active**: a child whose branch never moved cannot archive itself, and it would keep the macro's no-active-children gate closed forever. Also refused when a workflow home or file cannot be read (anything but a missing one): the unreadable entry could be that child.

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
if [ "${NO_COMMIT:-}" = "1" ]; then
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
```

---

## Phase 3b — Resolve the landing and record it

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
INTEGRATION_BRANCH="${EXPLICIT_INTEGRATION_BRANCH:-$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$MACRO_PATH" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).git_baseline.branch||"")}catch{}})')}"
if ! git -C "$REPO_ROOT" fetch --quiet origin "$INTEGRATION_BRANCH"; then
  echo "⚠ git fetch origin $INTEGRATION_BRANCH failed; verifying against the last fetched origin/$INTEGRATION_BRANCH." >&2
fi
# The owner may have been recovered by the Phase 2 scan rather than read from
# the macro; pass it so the landing is bound to this attempt's dispatch time.
LANDING_ARGS=(--repo-root "$REPO_ROOT" --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" --integration-branch "$INTEGRATION_BRANCH" --engineer-workflow-id "$EXISTING_ENG_WF_ID")
[ -n "${EXPLICIT_PR:-}" ] && LANDING_ARGS+=(--pr "$EXPLICIT_PR")
[ -n "${EXPLICIT_COMMIT:-}" ] && LANDING_ARGS+=(--commit "$EXPLICIT_COMMIT")
LANDING="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" resolve-landing "${LANDING_ARGS[@]}")"
LANDING_RC=$?
if [ "$LANDING_RC" -ne 0 ]; then
  echo "✗ Cannot record $SUBTASK_ID yet — $(printf '%s' "$LANDING" | JSON_KEY=reason node -e "$JSON_FIELD"): $(printf '%s' "$LANDING" | JSON_KEY=detail node -e "$JSON_FIELD")" >&2
  exit 1
fi
COMMIT_SHA="$(printf '%s' "$LANDING" | JSON_KEY=commit node -e "$JSON_FIELD")"
PR_URL="$(printf '%s' "$LANDING" | JSON_KEY=pr_url node -e "$JSON_FIELD")"
LANDING_NOTE=""
if [ "$(printf '%s' "$LANDING" | JSON_KEY=verification node -e "$JSON_FIELD")" = "ancestry-only" ]; then
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
[ "${CORRECT:-}" = "1" ] && UPDATE_ARGS+=(--correct)
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

A write refused with `dispatch-changed` bound and completed nothing: the owner, recorded or found by Phase 2's scan, was dispatched for the subtask as it was before a plan revision. Report it with the child's id; the user revises the plan back, or dispatches the subtask again. A waived write records `Dispatch not compared (--waive-dispatch)` and the reason in the macro body.

`subtask-update` handles ownership, the provenance guard (a different recorded value is refused and names `--correct`), the unblock pass and the auto-terminal pass atomically; surface its JSON envelope. `noop: true` means the record already held these values.

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
- `✗ Not recorded — <id> changed after its child was dispatched (dispatch-changed): <what differs>.` Nothing was bound or completed.
- `✗ Not recorded — the recorded owner <X> has no workflow file left, so its dispatch cannot be read.` Repeat that `--waive-dispatch` with a reason completes it without the comparison, and that the macro records both; do not rerun with it on your own judgment.
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
