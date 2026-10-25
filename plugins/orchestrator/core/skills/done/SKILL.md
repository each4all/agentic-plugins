---
name: done
description: "Records an orchestrator macro subtask as completed once its work has landed, with the pull request's merge commit. Codex skill mirror for /orchestrator:done (ADR-0062)."
---

# Done (orchestrator completion skill)

`done` marks one macro subtask `completed` once its work has **landed**
on the integration branch, recording the pull request's merge commit
(ADR-0062). It is the step that completes a subtask: the engineer's
Phase 7 and Stop hook only note the branch commit and keep the subtask
`in_progress`, because this repository squash- or rebase-merges every
pull request and the branch commit never reaches `main`. Run it after the
pull request merges; successors become dispatchable then.

This is the Codex skill mirror of `commands/done.md`. Preserve that
command file as the canonical Claude runbook.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| Resolve macro via `find-active` / `find-macro` | Yes | Yes |
| Read subtask via `state.mjs read-subtask` | Yes | Yes |
| Fallback engineer child scan | Yes | Yes |
| Resolve the landing via `state.mjs resolve-landing` | Yes | Yes (needs an authenticated `gh`; otherwise `--commit`, ancestry-only) |
| `state.mjs subtask-update --status completed` | `--host claude` | `--host codex` |
| Engineer terminal note (`subtask-engineer-terminal`, not a completion) | Yes on Claude engineer Phase 7 / Stop | Yes after the bundled hooks load (generic `[features].hooks`) + `/hooks` review/trust |

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:done <subtask-id> [--pr=<n>] [--commit=<sha>] [--correct \| --no-commit] [--waive-dispatch] [--workflow=<macro-id>] [--integration-branch=<b>] [reason]` | `$orchestrator:done` with the same arguments |
| Canonical command runbook | `commands/done.md` | `commands/done.md` is the behavioral source |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | For a mentioned `orchestrator` skill, the plugin directory that contains it: Codex injects a mentioned skill with its absolute path (`<path>…/core/skills/<skill>/SKILL.md</path>`), and dropping `/core/skills/<skill>/SKILL.md` from it leaves the root, which holds `.codex-plugin/plugin.json`. If that path is no longer in context, for example after compaction, a new mention of the skill supplies it again. With the default Codex home and the `agentic-plugins` marketplace added from Git, the root is `~/.codex/plugins/cache/agentic-plugins/orchestrator/<version>`, the versioned copy Codex loads skills from, and `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/orchestrator` is the marketplace checkout, which tracks the repository's `main` branch, not that copy. |
| Host flag | `--host claude` | `--host codex` |

---

## Phase 0 - Argument intake

The arguments reach the block through an args file, never as shell source
(ADR-0059, C134(a)): typed into a command, a quote, `$` or backquote in an id
or a reason would be read as code, and a heredoc ends at a line of the reason
that reads its delimiter. Create a private directory for it
(`mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`, noting the path it
prints), write `args.json` in it with your file-editing tool, holding
`{"agentic_args": 1, "text": "…"}` with `text` set to the arguments exactly
as typed, as a JSON string, and put that path in the block's `ARGS_DIR` line.
The block reads it with `state.mjs command-args --command done` (grammar:
`scripts/lib/command-args.mjs`), as `commands/done.md` does, which removes the
file and its directory once read. The fields:

- `subtask_id`, the leading `<subtask-id>` (required);
- `pr`, from `--pr=<n>` — names the pull request when more than one merged
  the branch;
- `commit`, from `--commit=<sha>` — must equal that pull request's merge
  commit;
- `correct`, from `--correct` — replace a recorded value deliberately (needs
  a reason);
- `no_commit`, from `--no-commit` — the work landed no commit (needs a
  reason; excludes `--pr`, `--commit` and `--correct`);
- `waive_dispatch`, from `--waive-dispatch` — complete in the recorded
  owner's name without comparing the dispatch it records, when no file of it
  is left to read it from (Phase 2), or, with that dispatch read, complete an
  archived owner the macro's record cannot vouch for (Phase 3; needs a
  reason, and the macro records both);
- `workflow_id`, from `--workflow=<macro-id>`;
- `integration_branch`, from `--integration-branch=<b>` — default is the
  macro's `git_baseline.branch`;
- `reason`, the free text after the subtask id and the options, byte for
  byte (a lone `--` before it lets it name one of done's options). The block
  writes it to a file of its own, which `state.mjs` reads.

The parser refuses, and nothing is written: a missing subtask id, an unknown
or repeated option, `--no-commit` with `--pr`, `--commit` or `--correct`,
an option after the reason began (unless `--` opened it), and a subtask id
or option holding a quote or backslash (a value is written bare, so a subtask
whose id holds a quote, a backslash or a space, or starts with `-`, cannot be
named here). The reason takes any text.

**Phases 1–3 are one block, run in one shell call** (below, after the phases
it runs), as `commands/done.md` runs them. Each shell call is a fresh shell:
the block reads its arguments from the args file at its top. A refusal is
answered by running the whole block again with other arguments, in a new args
file (`--waive-dispatch` after exit 3, a binding line after an ambiguity,
`--correct`), never by running part of it.

---

## Phase 1 - Resolve macro and subtask

`--workflow=<id>` names the macro (refused unless basename-shaped, and
resolved in the orchestrator workflow homes of this checkout's read set);
otherwise `find-active` on the current branch, then `find-macro` for a
subtask branch. Then the subtask as the macro records it. A `deferred` or
`abandoned` subtask is refused (terminal-partial states are absorbing); a
`completed` one, without `--correct`, is a no-op and the block ends there.
With `--correct`, `--no-commit` or `--waive-dispatch`, a reason is
required. The reason stays in the file the block wrote it to (`REASON_FILE`):
the block only checks that it holds text, and Phase 3 hands the file's bytes
to `state.mjs`, so the shell never reads the reason as text.

---

## Phase 2 - Resolve engineer workflow id

The write in Phase 3 completes the subtask in its owner's name, so it compares
the dispatch that owner records (ADR-0067 Decision 4, item 5), and is refused
(`dispatch-changed`) under the macro's file lock when the subtask is no longer
the one the owner was dispatched for. `state.mjs owner-dispatch` finds the
owner and reads that dispatch: it reads every engineer workflow file in the
workflow homes **and archive homes** of every root of the repository (by the
time the work has merged the child has normally archived itself) and parses
the frontmatter values it needs, never matching serialized text:

- the subtask records an `engineer_workflow_id` → the file of that workflow
  that claims the subtask. When no file of it is left anywhere in the
  repository the dispatch cannot be read, and the command exits 3: the block
  refuses, and only a rerun with `--waive-dispatch` and a reason completes the
  subtask without the comparison. A file of it that claims another subtask
  refuses, with no waiver.
- otherwise → the one workflow whose `parent_workflow` is the macro id **and**
  whose `originating_subtask` is the subtask id. None refuses: this subtask
  was likely never dispatched via `$orchestrator:next` — re-dispatch it with
  `$orchestrator:next <id>` to create the engineer child (the single honest
  recovery for this guard state). Manual completion without a child is **not**
  supported — `subtask-update` requires `--engineer-workflow-id`. More than
  one refuses and lists each claimant with a binding line that carries its
  dispatch (`subtask-update --engineer-workflow-id=<id>
  --expect-dispatch=<its dispatch>`); surface them, and let the user pick the
  one that did the work, then rerun the block.

A home or file that cannot be read (anything but a missing one) also refuses,
since it could hide a claimant or the owner's file. Do not invent an engineer
workflow id. `DISPATCH_ARGS` carries the comparison, or the waiver, into
Phase 3.

---

## Phase 3 - Record the completion

With `--no-commit`: refused while an engineer workflow for the subtask is
still **active** (it could never archive and would keep the macro's
no-active-children gate closed), and refused when a workflow home or file
cannot be read (anything but a missing one), since the unreadable entry could
be that child. The check runs again after the join (ADR-0067 Decision 4, item
5), since a run's step could have dispatched the subtask again before it.

Otherwise `resolve-landing` finds the merged pull request whose head is the
subtask branch and that was opened after the owner Phase 2 found was
dispatched, checks its base is the integration branch, and verifies its merge
commit is reachable from `refs/remotes/origin/<integration>`. On `{ok: false}`
the block reports its `reason` and `detail` and stops (`not_merged`, `no_pr`,
`ambiguous`, `base_mismatch`, `commit_mismatch`, `not_reachable`,
`gh_unavailable`, `no_integration_ref`). With `verification: "ancestry-only"`
(no working `gh`), the block adds that fact to the reason it records. Never
record the subtask branch tip or `HEAD`.

The checks above only read: a routine refusal (`not_merged`, an active child)
leaves nothing behind. Before the write, the block joins the macro's run lock
(ADR-0067 Decision 4, item 5): an autopilot run or another session holding it
refuses, naming the holder, and nothing is written. Every exit from the join
on releases the admission, the write's failure included; `subtask-update`
checks ownership and provenance itself, under the macro's file lock.

## The block — Phases 1 to 3, in one shell call

One block, run in one shell call: every value it reads is either a field of
its parsed arguments or something it read itself, so it runs as written in a
fresh shell (C75), bash or zsh (it uses bash arrays, which a POSIX `sh` such
as dash does not have). The one file it writes is the reason's. Each JSON
document goes to its parser through `printf`, the parser reads the whole
document, and a read's status is checked apart from its parser's (C110).

```bash
ARGS_DIR='<directory from mktemp>'
# --- Phase 1: the macro plan ---
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
ARGS_JSON="$(node "<orchestrator-plugin-root>/scripts/state.mjs" command-args \
  --command done --args-file "$ARGS_DIR/args.json")" || exit 1
# Prints the field named by JSON_KEY of the JSON document on stdin, or "" when
# it is absent or null; a document that does not parse fails (C68). The
# document goes through printf, not echo, whose zsh builtin expands the
# backslash escapes inside JSON strings.
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
  if ! MACRO_PATH="$(node "<orchestrator-plugin-root>/scripts/state.mjs" \
    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$ARG_WORKFLOW_ID")"; then
    echo "✗ --workflow=$ARG_WORKFLOW_ID names no single macro file in the orchestrator workflow homes of this checkout's read set (the reason is above; archived macros are not addressed)." >&2
    exit 1
  fi
else
  MACRO_PATH="$(node "<orchestrator-plugin-root>/scripts/state.mjs" \
    find-active --repo-root "$REPO_ROOT")"
  RC=$?
  if [ "$RC" -ne 0 ]; then
    exit "$RC"
  fi
  if [ -z "$MACRO_PATH" ]; then
    MACRO_PATH="$(node "<orchestrator-plugin-root>/scripts/state.mjs" \
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

# --- Phase 1: the subtask, the flags, the reason file ---
SUBTASK_JSON="$(node "<orchestrator-plugin-root>/scripts/state.mjs" \
  read-subtask --workflow-path "$MACRO_PATH" --subtask-id "$ARG_SUBTASK_ID")" || exit 1

SUBTASK_ID="$ARG_SUBTASK_ID"
SUBTASK_BRANCH="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=branch node -e "$JSON_FIELD")" || exit 1
SUBTASK_STATUS="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=status node -e "$JSON_FIELD")" || exit 1
EXISTING_ENG_WF_ID="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=engineer_workflow_id node -e "$JSON_FIELD")" || exit 1
EXISTING_COMMIT="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=commit node -e "$JSON_FIELD")" || exit 1
EXISTING_CLOSED_AT="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=closed_at node -e "$JSON_FIELD")" || exit 1

if [ "$SUBTASK_STATUS" = "deferred" ] || [ "$SUBTASK_STATUS" = "abandoned" ]; then
  echo "✗ Subtask $SUBTASK_ID is $SUBTASK_STATUS — terminal-partial states are absorbing (set by \$orchestrator:finalize or \$orchestrator:abort)." >&2
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
OWNER_ARGS=(--repo-root "$REPO_ROOT" --macro-id "$MACRO_ID" --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" --host codex)
[ -n "$EXISTING_ENG_WF_ID" ] && OWNER_ARGS+=(--engineer-workflow-id "$EXISTING_ENG_WF_ID")
# Under set -e an unguarded nonzero exit would end the block before OWNER_RC.
OWNER_JSON="$(node "<orchestrator-plugin-root>/scripts/state.mjs" owner-dispatch "${OWNER_ARGS[@]}")" && OWNER_RC=0 || OWNER_RC=$?
if [ "$OWNER_RC" -eq 0 ]; then
  EXISTING_ENG_WF_ID="$(printf '%s' "$OWNER_JSON" | JSON_KEY=engineer_workflow_id node -e "$JSON_FIELD")" || exit 1
  OWNER_DISPATCH="$(printf '%s' "$OWNER_JSON" | JSON_KEY=dispatch node -e "$JSON_FIELD")" || exit 1
  if [ -z "$EXISTING_ENG_WF_ID" ] || [ -z "$OWNER_DISPATCH" ]; then
    echo "✗ Could not read owner-dispatch's answer for $SUBTASK_ID; refusing to guess." >&2
    exit 1
  fi
  DISPATCH_ARGS=(--expect-dispatch "$OWNER_DISPATCH")
  if [ "$WAIVE_DISPATCH" = true ]; then DISPATCH_ARGS+=(--waive-told); fi
elif [ "$OWNER_RC" -eq 3 ] && [ "$WAIVE_DISPATCH" = true ]; then
  # The recorded owner's file is gone, and the operator completes in its name
  # anyway; subtask-update records the waiver and the reason in the macro.
  DISPATCH_ARGS=(--waive-dispatch)
else
  exit 1
fi

# --- Phase 3, --no-commit: completion without a landed commit ---
if [ "$NO_COMMIT" = true ]; then
  # Returns non-zero, the reason on stderr, when an engineer workflow of this
  # subtask is active or a home cannot be read. active-child reads every root of
  # the repository (ADR-0067 Decision 1(b)) and parses each frontmatter, as
  # owner-dispatch does.
  no_active_child() {
    ACTIVE_CHILD="$(node "<orchestrator-plugin-root>/scripts/state.mjs" active-child \
      --repo-root "$REPO_ROOT" --macro-id "$MACRO_ID" --subtask-id "$SUBTASK_ID")" || {
      echo "✗ Could not scan the engineer workflow homes for an active child of $SUBTASK_ID (see the error above); refusing --no-commit." >&2
      return 1
    }
    if [ -n "$ACTIVE_CHILD" ]; then
      echo "✗ An engineer workflow for $SUBTASK_ID is still active: $ACTIVE_CHILD" >&2
      echo "  Archive it first (\$engineer:resume archive on its branch), then rerun \$orchestrator:done $SUBTASK_ID --no-commit." >&2
      return 1
    fi
  }
  no_active_child || exit 1
  # ADR-0067 Decision 4, item 5 — join the macro's run lock before the write:
  # a refusal names the autopilot run or session holding it, and writes
  # nothing. Every exit from here releases the admission.
  ADMISSION="$(node "<orchestrator-plugin-root>/scripts/state.mjs" admission join \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --command done --host codex)" || exit 1
  release_admission() {
    node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \
      --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
  }
  trap 'release_admission' EXIT
  # A run's step could have dispatched the subtask again before the join.
  no_active_child || exit 1
  # The write completes the subtask in its owner's name: only while the
  # subtask is the one that owner records it was dispatched for, unless the
  # operator waived that check (Phase 2).
  node "<orchestrator-plugin-root>/scripts/state.mjs" subtask-update \
    --workflow-path "$MACRO_PATH" --host codex --subtask-id "$SUBTASK_ID" \
    --status completed --engineer-workflow-id "$EXISTING_ENG_WF_ID" \
    --closed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --expect-branch "$SUBTASK_BRANCH" \
    "${DISPATCH_ARGS[@]}" --reason-file "$REASON_FILE" --event updated || exit $?
  exit 0
fi

# --- Phase 3: resolve the landing and record it ---
if [ -n "$ARG_INTEGRATION_BRANCH" ]; then
  INTEGRATION_BRANCH="$ARG_INTEGRATION_BRANCH"
else
  # The read's status is its own, apart from the parser's: piped, a failed
  # read would leave the branch empty and the fetch below would name none
  # (C110).
  MACRO_JSON="$(node "<orchestrator-plugin-root>/scripts/state.mjs" read --workflow-path "$MACRO_PATH")" || exit 1
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
LANDING="$(node "<orchestrator-plugin-root>/scripts/state.mjs" resolve-landing "${LANDING_ARGS[@]}")"
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
ADMISSION="$(node "<orchestrator-plugin-root>/scripts/state.mjs" admission join \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --command done --host codex)" || exit 1
release_admission() {
  node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
}
trap 'release_admission' EXIT

UPDATE_ARGS=(--workflow-path "$MACRO_PATH" --host codex --subtask-id "$SUBTASK_ID"
  --status completed --engineer-workflow-id "$EXISTING_ENG_WF_ID" --commit "$COMMIT_SHA"
  --closed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --expect-branch "$SUBTASK_BRANCH" --event updated)
[ -n "$PR_URL" ] && UPDATE_ARGS+=(--pr-url "$PR_URL")
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
  } | node "<orchestrator-plugin-root>/scripts/state.mjs" subtask-update "${UPDATE_ARGS[@]}" --reason-file - || exit $?
else
  node "<orchestrator-plugin-root>/scripts/state.mjs" subtask-update "${UPDATE_ARGS[@]}" || exit $?
fi
```

`--commit` and `--pr-url` are passed only with a landing, `--pr-url` only when
the landing has one. `--expect-branch` refuses the write if a plan revision
moved the subtask after the landing was resolved. `DISPATCH_ARGS` carries the
owner's dispatch: the write is refused (`dispatch-changed`) when the subtask
is no longer the one that owner was dispatched for, and binds or completes
nothing, unless the macro's current approval rebound that very child to the
subtask's current `topic` and `profile` and an active child has been told
(ADR-0068 Decision 8). The refusal's `No rebinding applies: …` clause names
why it was not: the plan is pending approval, the approval rebound another
child or other words, the child is not told yet (`state.mjs rebind-deliver`),
or the change is to a `branch` or `verb`. The owner's exits: revise the plan
back, dispatch the subtask again, or, for a `topic` or `profile` change,
approve the revised plan (`orchestrator:approve`). Whatever the comparison
found, the write also refuses an owner the macro's record cannot vouch for
(`<child> is not bound to subtask …`, ADR-0068 Decision 8, item 4): a note to
it still pending, other words last told for the subtask, or last words not
known after an approval replaced an unreadable record. The refusal names the
way out: for an active owner, deliver the note (`state.mjs rebind-deliver`),
approve the plan as it stands, or revise it back to the words the owner was
last told; for an archived owner, which no note reaches, revise it back, or
the user reruns with `--waive-dispatch` and a reason, which then carries
`--waive-told`: the write completes it and the macro body records `Told
check waived (--waive-dispatch)` and the reason (refused for an active owner,
or when nothing is refused). With `--waive-dispatch` and exit 3 it carries the waiver instead,
which the macro body records with the reason. A recorded `commit` or
`pr_url` is never replaced, and a recorded `closed_at` is kept, unless
`--correct` with a reason; the macro body then records old value, new
value and reason.

Surface the JSON envelope. `subtask-update` owns single-writer
ownership checks, absorbing-completed semantics, unblock propagation,
and macro auto-terminal promotion; `noop: true` means the record already held
these values.

`updateSubtask` treats `--status=completed`, `--commit`, `--closed-at` and
`--pr-url` alike as completion fields: each requires `--engineer-workflow-id` and
throws without it.

---

## Completion

Report the subtask id, commit, pull request, closed_at timestamp, and
whether the macro auto-promoted to terminal — or the refusal reason when
the work has not landed yet.

When subtasks remain (no auto-terminal), `$orchestrator:done` is a
**forward-decision** surface — emit an **Active Next-Action Proposal** (not a
fixed next command) per
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
- next_command:          <exact next step: $orchestrator:<command> … — or the wait / owner-decision action>
```

Derive from the post-completion macro state (typically
`$orchestrator:next` when this completion unblocked a subtask, or
`$orchestrator:finalize` when only intentionally-deferred work remains).

The runtime completion footer is
**code-emitted** on this verb's terminal path (ADR-0039): when this `/done`
auto-promotes the macro to terminal (its final subtask), the `subtask-update`
sidecar renders the runtime `footer.mjs` on the command's stderr — surface that
one, do not hand-compose a duplicate (a terminal close needs no hand-authored
proposal). When subtasks remain, the macro stays
active and no terminal footer fires. Independently, a real completed subtask
typically leaves an open PR on its branch — surface that PR follow-up if it has
not already been handled (orchestrator computes no PR-readiness recommendation).

ARCHIVE TIMING — that auto-terminal promotion marks the macro terminal, and on
Claude the Stop hook fires at **every turn end**, so the macro archive gates are
**evaluated** at the end of **this** turn, not at session close. By the time the
work has merged, the engineer child has normally archived itself, so the gates
often all pass and the macro moves this turn; a still-active child keeps the
no-active-children gate closed and the macro stays marked for a later Stop. To hold it open, run the full
`state.mjs set-terminal` form (`--workflow-path`, `--host`, `--terminal-phase` all
required) with `--terminal-marker false` before that Stop fires. On Codex the Stop
hook runs only once the operator has trusted the plugin hooks (`/hooks`), so the
evaluation waits. Full contract:
`core/skills/_shared/references/session-handoff.md` § Archive timing.

---

## Anti-patterns

- Do not record the subtask branch tip or current `HEAD`; record the merge commit `resolve-landing` returns.
- Do not override `deferred` or `abandoned`.
- Do not complete without a matching engineer workflow id.
- Do not edit macro frontmatter by hand.
