---
description: Record a macro subtask completed once its work has landed — resolves the pull request's merge commit (ADR-0062)
argument-hint: <subtask-id> [--pr=<n>] [--commit=<sha>] [--correct | --no-commit] [--workflow=<macro-id>] [--integration-branch=<b>] [reason]
---

# Orchestrator · Done

$ARGUMENTS

Record a macro subtask as `completed` once its work has **landed** on the integration branch. This is the step that completes a subtask (ADR-0062 §Decision 2): the engineer's Phase 7 and Stop hook only note the branch commit and keep the subtask `in_progress`, because this repository squash- or rebase-merges every pull request and the branch commit never reaches `main`. Run `/orchestrator:done` after the pull request merges; its successors become dispatchable then.

The recorded `commit` is the pull request's **merge commit** — the squash commit for a squash merge, the last rebased commit for a rebase merge — resolved and verified by `state.mjs resolve-landing` (ADR-0062 §Decision 1).

Plugin root: `$CLAUDE_PLUGIN_ROOT` is the orchestrator plugin's resolved root.

**Argument parsing**: extract from `$ARGUMENTS`:
- `EXPLICIT_SUBTASK_ID` ← the leading positional token (required).
- `EXPLICIT_PR` ← value of `--pr=<n>`: names the pull request when more than one merged the branch.
- `EXPLICIT_COMMIT` ← value of `--commit=<sha>`: must equal that pull request's merge commit; without a working `gh` it is verified by ancestry only.
- `CORRECT` ← `1` when `--correct` is present: replace a recorded value deliberately. Needs a reason.
- `NO_COMMIT` ← `1` when `--no-commit` is present: the work legitimately landed no commit (for example an investigation closed with evidence only). Needs a reason. Excludes `--pr`, `--commit` and `--correct`.
- `EXPLICIT_WORKFLOW_ID` ← value of `--workflow=<id>`.
- `EXPLICIT_INTEGRATION_BRANCH` ← value of `--integration-branch=<b>`; default is the macro's `git_baseline.branch`.
- `REASON` ← the remaining free text, verbatim. It never passes through the shell (ADR-0059): before running the block below, write it to a new file with your file-writing tool (Claude: the Write tool), exactly as given, and set `REASON_FILE` to that file's path at the top of the block. Leave `REASON_FILE` unset when there is no reason. A heredoc is not safe here: a reason that contains the delimiter line ends it and runs what follows.

**Run Phases 0–3 in one Bash invocation.** Each Bash tool call is a fresh shell, so the variables and the note file created in Phase 1 do not survive into a later call. Write `REASON_FILE` (when there is a reason) before that invocation.

**Critical rules** (ADR-0062):
- Never record the subtask branch tip or `git rev-parse HEAD`. A squash or rebase merge leaves both outside the integration branch.
- A completion writeback MUST supply the matching `engineer_workflow_id` (ADR-0019 §4 ownership, unchanged).
- A recorded `commit` or `pr_url` is never replaced, and a recorded `closed_at` is kept, unless `--correct` with a reason; the macro body then records the old value, the new value and the reason.
- `--expect-branch` is always passed, so a plan revision between resolving the landing and writing it is refused.
- Only active macros are addressed. An archived macro is a frozen record (ADR-0062 §Decision 7).

---

## Phase 0 — Resolve the macro plan

```bash
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

FIND_ERR="${TMPDIR:-/tmp}/orchestrator-done-find-$$.err"
MACRO_PATH=""
if [ -n "${EXPLICIT_WORKFLOW_ID:-}" ]; then
  # Reject path-component overrides — `--workflow=../archive/<id>` would
  # otherwise let the macro path escape `workflows/`.
  case "$EXPLICIT_WORKFLOW_ID" in
    # No NUL case: a shell variable cannot hold NUL, and bash expands $'\0'
    # to an empty string, which made the pattern match every id.
    */*|*\\*|..|.*)
      echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID invalid — must be a basename-shaped workflow id (no '/', '\\\\', '..', or leading '.')." >&2
      rm -f "$FIND_ERR"
      exit 1;;
  esac
  CANONICAL_MACRO_PATH="$REPO_ROOT/.agentic-plugins/state/orchestrator/workflows/${EXPLICIT_WORKFLOW_ID}.md"
  LEGACY_MACRO_PATH="$REPO_ROOT/.claude/agentic-orchestrator/workflows/${EXPLICIT_WORKFLOW_ID}.md"
  if [ -f "$CANONICAL_MACRO_PATH" ]; then
    MACRO_PATH="$CANONICAL_MACRO_PATH"
  elif [ -f "$LEGACY_MACRO_PATH" ]; then
    MACRO_PATH="$LEGACY_MACRO_PATH"
  else
    echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID not found in canonical or legacy workflow homes (archived macros are not addressed)." >&2
    rm -f "$FIND_ERR"
    exit 1
  fi
else
  MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    find-active --repo-root "$REPO_ROOT" 2>"$FIND_ERR")"
  RC=$?
  if [ "$RC" -ne 0 ]; then
    cat "$FIND_ERR" >&2; rm -f "$FIND_ERR"; exit "$RC"
  fi
  if [ -z "$MACRO_PATH" ]; then
    MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
      find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH" 2>"$FIND_ERR")"
    RC=$?
    if [ "$RC" -ne 0 ]; then
      cat "$FIND_ERR" >&2; rm -f "$FIND_ERR"; exit "$RC"
    fi
  fi
fi
rm -f "$FIND_ERR"
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
SUBTASK_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  read-subtask --workflow-path "$MACRO_PATH" --subtask-id "$EXPLICIT_SUBTASK_ID")" || exit 1

SUBTASK_ID="$EXPLICIT_SUBTASK_ID"
field() { echo "$SUBTASK_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d)[process.argv[1]]??""))}catch{}})' "$1"; }
SUBTASK_BRANCH="$(field branch)"
SUBTASK_STATUS="$(field status)"
EXISTING_ENG_WF_ID="$(field engineer_workflow_id)"
EXISTING_COMMIT="$(field commit)"
EXISTING_CLOSED_AT="$(field closed_at)"

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

When `CORRECT=1` or `NO_COMMIT=1`, a reason is required. The note the macro records is assembled in a file the runbook owns; the reason is copied into it from `REASON_FILE`, never read by the shell as text:

```bash
NOTE_FILE="$(mktemp "${TMPDIR:-/tmp}/orchestrator-done-note.XXXXXX")"
trap 'rm -f "$NOTE_FILE"' EXIT
if [ -n "${REASON_FILE:-}" ]; then
  if [ ! -f "$REASON_FILE" ]; then
    echo "✗ REASON_FILE=$REASON_FILE does not exist; write the reason with your file-writing tool first." >&2
    exit 1
  fi
  cat "$REASON_FILE" > "$NOTE_FILE"
fi
if { [ "${CORRECT:-}" = "1" ] || [ "${NO_COMMIT:-}" = "1" ]; } && ! grep -q '[^[:space:]]' "$NOTE_FILE"; then
  echo "✗ --correct and --no-commit need a reason (the free text after the flags)." >&2
  exit 1
fi
```

---

## Phase 2 — Resolve the owning engineer workflow

- `EXISTING_ENG_WF_ID` set → use it (the normal path after `/orchestrator:next` recorded it, or after the engineer terminal note bound it).
- Otherwise scan the engineer workflow homes **and archive homes** — by the time the work has merged, the child has normally archived itself. **Both** `parent_workflow == $MACRO_ID` and `originating_subtask == $SUBTASK_ID` must match, and more than one distinct match is refused rather than guessed. A home or file that cannot be read (anything but a missing one) also refuses, since it could hide a second claimant:

```bash
if [ -z "$EXISTING_ENG_WF_ID" ]; then
  MATCHES="$(
    env MACRO_ID="$MACRO_ID" SUBTASK_ID="$SUBTASK_ID" REPO_ROOT="$REPO_ROOT" node -e '
      const fs = require("fs"); const path = require("path");
      const { MACRO_ID, SUBTASK_ID, REPO_ROOT } = process.env;
      const homes = [
        [".agentic-plugins", "state", "engineer"], [".claude", "agentic-engineer"],
      ].flatMap((h) => ["workflows", "archive"].map((d) => path.join(REPO_ROOT, ...h, d)));
      const ids = new Set();
      // Only a missing home or file is "nothing there"; any other read error
      // could hide a second claimant, so the scan fails instead of guessing.
      const missing = (e) => e.code === "ENOENT";
      try {
        for (const dir of homes) {
          let names = [];
          try { names = fs.readdirSync(dir); } catch (e) { if (missing(e)) continue; throw e; }
          for (const name of names.filter((n) => n.endsWith(".md"))) {
            let text; try { text = fs.readFileSync(path.join(dir, name), "utf8"); } catch (e) { if (missing(e)) continue; throw e; }
            const fm = (text.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || "";
            if (!fm.includes(`parent_workflow: "${MACRO_ID}"`) || !fm.includes(`originating_subtask: "${SUBTASK_ID}"`)) continue;
            const id = (fm.match(/^workflow_id:\s*"([^"]+)"/m) || [])[1];
            if (id) ids.add(id);
          }
        }
      } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
      process.stdout.write([...ids].join("\n"));
    '
  )" || {
    echo "✗ Could not scan the engineer workflow homes for $SUBTASK_ID's owner (see the error above); refusing to guess." >&2
    exit 1
  }
  if [ -z "$MATCHES" ]; then
    echo "✗ No engineer workflow found with parent_workflow=$MACRO_ID AND originating_subtask=$SUBTASK_ID (active or archived)." >&2
    echo "  This subtask was likely never dispatched — run /orchestrator:next $SUBTASK_ID first." >&2
    exit 1
  fi
  if [ "$(printf '%s\n' "$MATCHES" | wc -l | tr -d ' ')" -gt 1 ]; then
    echo "✗ More than one engineer workflow claims $SUBTASK_ID in $MACRO_ID:" >&2
    printf '%s\n' "$MATCHES" | sed 's/^/  /' >&2
    echo "  Record the owner explicitly with state.mjs subtask-update --engineer-workflow-id=<id> first." >&2
    exit 1
  fi
  EXISTING_ENG_WF_ID="$MATCHES"
fi
```

---

## Phase 3a — `--no-commit`: completion without a landed commit

Refused while an engineer workflow for this subtask is still **active**: a child whose branch never moved cannot archive itself, and it would keep the macro's no-active-children gate closed forever. Also refused when a workflow home or file cannot be read (anything but a missing one): the unreadable entry could be that child.

```bash
if [ "${NO_COMMIT:-}" = "1" ]; then
  ACTIVE_CHILD="$(
    env MACRO_ID="$MACRO_ID" SUBTASK_ID="$SUBTASK_ID" REPO_ROOT="$REPO_ROOT" node -e '
      const fs = require("fs"); const path = require("path");
      const { MACRO_ID, SUBTASK_ID, REPO_ROOT } = process.env;
      // Only a missing home or file is "no child"; any other read error could
      // hide the active child, so the scan fails instead.
      const missing = (e) => e.code === "ENOENT";
      try {
        for (const dir of [path.join(REPO_ROOT, ".agentic-plugins", "state", "engineer", "workflows"), path.join(REPO_ROOT, ".claude", "agentic-engineer", "workflows")]) {
          let names = []; try { names = fs.readdirSync(dir); } catch (e) { if (missing(e)) continue; throw e; }
          for (const name of names.filter((n) => n.endsWith(".md"))) {
            let text; try { text = fs.readFileSync(path.join(dir, name), "utf8"); } catch (e) { if (missing(e)) continue; throw e; }
            if (text.includes(`parent_workflow: "${MACRO_ID}"`) && text.includes(`originating_subtask: "${SUBTASK_ID}"`)) { process.stdout.write(path.join(dir, name)); process.exit(0); }
          }
        }
      } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
    '
  )" || {
    echo "✗ Could not scan the engineer workflow homes for an active child of $SUBTASK_ID (see the error above); refusing --no-commit." >&2
    exit 1
  }
  if [ -n "$ACTIVE_CHILD" ]; then
    echo "✗ An engineer workflow for $SUBTASK_ID is still active: $ACTIVE_CHILD" >&2
    echo "  Archive it first (/engineer:resume archive on its branch), then rerun /orchestrator:done $SUBTASK_ID --no-commit." >&2
    exit 1
  fi
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" subtask-update \
    --workflow-path="$MACRO_PATH" --host="$DETECTED_HOST" --subtask-id="$SUBTASK_ID" \
    --status=completed --engineer-workflow-id="$EXISTING_ENG_WF_ID" \
    --closed-at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" --expect-branch="$SUBTASK_BRANCH" \
    --reason-file="$NOTE_FILE" --event=updated || exit $?
  exit 0
fi
```

---

## Phase 3b — Resolve the landing and record it

```bash
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
landing() { echo "$LANDING" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d)[process.argv[1]];process.stdout.write(v==null?"":String(v))}catch{}})' "$1"; }
if [ "$LANDING_RC" -ne 0 ]; then
  echo "✗ Cannot record $SUBTASK_ID yet — $(landing reason): $(landing detail)" >&2
  exit 1
fi
COMMIT_SHA="$(landing commit)"
PR_URL="$(landing pr_url)"
if [ "$(landing verification)" = "ancestry-only" ]; then
  # Keep the weaker verification visible in the macro's record.
  { printf 'Landing verified by ancestry only: gh was unavailable, so %s could not be matched to its pull request.\n' "$COMMIT_SHA"; cat "$NOTE_FILE"; } > "$NOTE_FILE.tmp" && mv "$NOTE_FILE.tmp" "$NOTE_FILE"
fi

UPDATE_ARGS=(--workflow-path="$MACRO_PATH" --host="$DETECTED_HOST" --subtask-id="$SUBTASK_ID"
  --status=completed --engineer-workflow-id="$EXISTING_ENG_WF_ID" --commit="$COMMIT_SHA"
  --closed-at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" --expect-branch="$SUBTASK_BRANCH" --event=updated)
[ -n "$PR_URL" ] && UPDATE_ARGS+=(--pr-url="$PR_URL")
[ "${CORRECT:-}" = "1" ] && UPDATE_ARGS+=(--correct)
grep -q '[^[:space:]]' "$NOTE_FILE" && UPDATE_ARGS+=(--reason-file="$NOTE_FILE")
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" subtask-update "${UPDATE_ARGS[@]}" || exit $?
```

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
