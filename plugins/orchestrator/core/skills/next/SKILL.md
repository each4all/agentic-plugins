---
name: next
description: "Dispatches the next ready orchestrator macro subtask into the engineer plugin with parent-linkage preserved. Codex skill mirror for /orchestrator:next; same-host dispatch only, cross-host --peer remains deferred."
---

# Next (orchestrator dispatch skill)

`next` dispatches one ready macro subtask into `plugins/engineer` and
records the immutable parent linkage the engineer needs to note its
terminal commit on the macro (Phase 7 and the Stop hook; ADR-0062 — the
subtask completes later, when `$orchestrator:done` records the merge):

- `AGENTIC_PARENT_WORKFLOW=<macro id>`
- `AGENTIC_PARENT_WORKFLOW_PATH=<macro file, absolute>` (ADR-0067
  Decision 3: the engineer records it and its writeback tries it first)
- `AGENTIC_ORIGINATING_SUBTASK=<subtask id>`
- `AGENTIC_DISPATCH_SELECTION=<JSON: subtask, branch, verb, profile, topic>`
  (ADR-0067 Decision 4, item 5: the engineer records it, and every later
  binding of the child to the subtask compares it)
- `AGENTIC_HOST=<claude|codex>`

This is the Codex skill mirror of `commands/next.md`. Preserve that
command file as the canonical line-by-line Claude runbook; this skill
spells out the same operational boundary for `$orchestrator:next`.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| Resolve macro via `state.mjs find-active` / `find-macro` | Yes | Yes |
| Select ready subtask via `read-subtask` / `next-ready` | Yes | Yes |
| Plan-approval gate via `state.mjs approval-gate` | Yes | Yes |
| Switch/create subtask branch | Yes, explicit git action | Yes, explicit git action |
| Discover and preflight `engineer` | Yes | Yes |
| Same-host engineer dispatch with AGENTIC parent-linkage | Yes | Yes |
| Cross-host `--peer` dispatch | Deferred PR-F scope | Deferred PR-F scope |

Codex can dispatch the same macro state because workflow files are
host-shared. The limitation is host-native slash-command execution:
Codex must follow the engineer command markdown explicitly instead of
assuming a Claude slash command runner exists.

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:next [<subtask-id>] [--workflow=<macro-id>]` | `$orchestrator:next [<subtask-id>] [--workflow=<macro-id>]` |
| Canonical command runbook | `commands/next.md` | `commands/next.md` is the behavioral source |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | For a mentioned `orchestrator` skill, the plugin directory that contains it: Codex injects a mentioned skill with its absolute path (`<path>…/core/skills/<skill>/SKILL.md</path>`), and dropping `/core/skills/<skill>/SKILL.md` from it leaves the root, which holds `.codex-plugin/plugin.json`. If that path is no longer in context, for example after compaction, a new mention of the skill supplies it again. With the default Codex home and the `agentic-plugins` marketplace added from Git, the root is `~/.codex/plugins/cache/agentic-plugins/orchestrator/<version>`, the versioned copy Codex loads skills from, and `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/orchestrator` is the marketplace checkout, which tracks the repository's `main` branch, not that copy. |
| Host flag | `--host claude` | `--host codex` |

---

## Phase 0 - Argument intake

Parse:

- optional leading `<subtask-id>`, as `EXPLICIT_SUBTASK_ID`;
- optional `--workflow=<macro-id>`, as `EXPLICIT_WORKFLOW_ID`.

Phase 1's block reads both, as `commands/next.md` Phase 0 and Phase 1 do, and
refuses a `--workflow` value that is not basename-shaped (`/`, `\`, `..` or a
leading `.`).

No block below relies on a variable an earlier block set: each may run in a
fresh shell call. What a phase finds (the checkout, the macro file, the
selected subtask, the engineer root, the workflow the ownership check saw, the
admission) it writes to a private directory, and every later block reads it
there. A block run again never selects again, so Phases 2 to 4 act on the
subtask Phase 1 selected (ADR-0067 Decision 4, item 5). Create the directory
first (`mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`, noting the path it
prints) and put that path in the `TEXT_DIR` line each block opens with. The
blocks write every file in it themselves; none is written with your
file-editing tool, and nothing deletes them.

---

## Phase 1 - Resolve macro and subtask

Resolve the macro workflow, then the subtask, in one block:

1. With `--workflow=<id>`, `state.mjs resolve-workflow` prints the macro file
   in the orchestrator workflow homes of this checkout's read set (the
   default state root first, ADR-0067 Decision 4, item 2), and exits non-zero
   when no root holds it (3) or two files do (1); the block stops then.
2. Otherwise `state.mjs find-active` on the current branch, then
   `state.mjs find-macro --subtask-branch` for a subtask branch.
3. An explicit id is read with `state.mjs read-subtask`; without one,
   `state.mjs next-ready` picks the first ready subtask, and when there is
   none the block prints its `reason` and, for every open subtask, the
   `readiness` facts it computed, and stops.

The block then rejects dispatch when the selected subtask is `completed`,
`deferred`, `abandoned`, `blocked`, or `pending` with incomplete `blocked_by`
predecessors. `in_progress` is allowed only as the idempotent reattach path.
The dependency facts come from the state CLI, not from the status alone
(ADR-0062 §Decision 5): `state.mjs subtask-readiness` returns `waiting_on`
(the predecessors not yet completed) and `stale_blocked` (marked `blocked`
with nothing left to wait on — a file written before the shared unblock pass;
repair it with `state.mjs subtask-update --status=pending`). An `in_progress`
subtask whose engineer workflow has committed stays `in_progress` until its
work lands: once its pull request has merged, record it with
`$orchestrator:done <id>`.

Every JSON document goes to its parser through `printf`, never `echo` (whose
zsh builtin, and a POSIX sh's, expands the backslash escapes in JSON strings),
the parser reads the whole document before it parses, and a document that
does not parse stops the block (C68):

```bash
TEXT_DIR='<directory from mktemp>'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
GIT_BRANCH="$(git branch --show-current)"
[ -n "$GIT_BRANCH" ] || { echo "✗ Detached HEAD — orchestrator workflows are anchored to a branch (ADR-0018 §sub-2)." >&2; exit 1; }
if [ -n "${EXPLICIT_WORKFLOW_ID:-}" ]; then
  case "$EXPLICIT_WORKFLOW_ID" in
    */*|*\\*|..|.*) echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID is not a basename-shaped workflow id." >&2; exit 1;;
  esac
  MACRO_PATH="$(node "<orchestrator-plugin-root>/scripts/state.mjs" resolve-workflow \
    --repo-root "$REPO_ROOT" --workflow-id "$EXPLICIT_WORKFLOW_ID")" || exit 1
else
  MACRO_PATH="$(node "<orchestrator-plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit 1
  if [ -z "$MACRO_PATH" ]; then
    MACRO_PATH="$(node "<orchestrator-plugin-root>/scripts/state.mjs" find-macro \
      --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH")" || exit 1
  fi
fi
[ -n "$MACRO_PATH" ] || { echo "✗ No macro workflow references branch '$GIT_BRANCH'; name one with --workflow, or plan one with \$orchestrator:plan." >&2; exit 1; }
if [ -n "${EXPLICIT_SUBTASK_ID:-}" ]; then
  SUBTASK_JSON="$(node "<orchestrator-plugin-root>/scripts/state.mjs" read-subtask \
    --workflow-path "$MACRO_PATH" --subtask-id "$EXPLICIT_SUBTASK_ID")" || exit 1
else
  NEXT_OUT="$(node "<orchestrator-plugin-root>/scripts/state.mjs" next-ready --workflow-path "$MACRO_PATH")" || exit 1
  SUBTASK_JSON="$(printf '%s' "$NEXT_OUT" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);if(o.ready)process.stdout.write(JSON.stringify(o.ready))})')" || exit 1
  if [ -z "$SUBTASK_JSON" ]; then
    # ADR-0062 §Decision 5 — the facts next-ready computed, per open subtask.
    printf '%s' "$NEXT_OUT" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);process.stderr.write("✗ No subtask is ready to dispatch ("+(o.reason||"unknown")+").\n");for(const r of o.readiness||[]){let why;if(r.status==="in_progress")why="in progress; once its pull request has merged, record it with $orchestrator:done "+r.id;else if(r.stale_blocked)why="marked blocked, but every predecessor is completed; repair: state.mjs subtask-update --subtask-id="+r.id+" --status=pending";else if(r.waiting_on.length>0)why="waiting on "+r.waiting_on.join(", ");else why=r.status;process.stderr.write("  - "+r.id+": "+why+"\n")}})'
    exit 1
  fi
fi
# For every later block: none selects again.
printf '%s' "$REPO_ROOT" > "$TEXT_DIR/repo-root" || exit 1
printf '%s' "$MACRO_PATH" > "$TEXT_DIR/macro-path" || exit 1
printf '%s' "$SUBTASK_JSON" > "$TEXT_DIR/subtask.json" || exit 1
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
SUBTASK_ID="$(JSON_KEY=id node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_STATUS="$(JSON_KEY=status node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
READINESS="$(node "<orchestrator-plugin-root>/scripts/state.mjs" subtask-readiness \
  --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID")" || exit 1
WAITING_ON="$(printf '%s' "$READINESS" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).waiting_on.join(", ")))')" || exit 1
STALE_BLOCKED="$(printf '%s' "$READINESS" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write(String(JSON.parse(d).stale_blocked)))')" || exit 1
case "$SUBTASK_STATUS" in
  in_progress) ;;
  pending) [ -z "$WAITING_ON" ] || { echo "✗ Subtask $SUBTASK_ID is pending but waits on: $WAITING_ON." >&2; exit 1; } ;;
  blocked)
    if [ "$STALE_BLOCKED" = "true" ]; then
      echo "✗ Subtask $SUBTASK_ID is marked blocked, but every predecessor is completed; repair it with state.mjs subtask-update --status=pending, then rerun." >&2
    else
      echo "✗ Subtask $SUBTASK_ID is blocked — it waits on: $WAITING_ON." >&2
    fi
    exit 1;;
  *) echo "✗ Subtask $SUBTASK_ID is $SUBTASK_STATUS; nothing to dispatch." >&2; exit 1;;
esac
```

Then apply the plan-approval gate (ADR-0063 D4 rule 3, owner decision D3),
for an explicit id as well as for the automatic pick, because
`subtask-readiness` reports no approval:

```bash
TEXT_DIR='<directory from mktemp>'
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
SUBTASK_JSON="$(cat "$TEXT_DIR/subtask.json")" || exit 1
node "<orchestrator-plugin-root>/scripts/state.mjs" approval-gate \
  --workflow-path "$MACRO_PATH" --host codex \
  --subtask-json "$SUBTASK_JSON" >/dev/null || exit 1
```

`$SUBTASK_JSON` is the subtask exactly as `read-subtask` or `next-ready`
returned it, the one you dispatch. The gate decides from the approval facts
`next-ready` reports (`{status, hash_ok}`); never compare plan hashes
yourself. When `AGENTIC_AUTOPILOT` names an autopilot run, a plan that is not
approved at its current hash (pending approval, changed since it was approved,
or never approved) is refused with `✗ plan-unapproved` and a pointer on
stderr, exit 1: stop and surface both lines, because only the owner approves
(`$orchestrator:approve`). A selected subtask that differs from the approved
plan's entry (the plan changed after the selection) is refused the same way;
rerun `$orchestrator:next`.
Interactive dispatch is never refused: surface the one warning line printed
for a plan pending approval or changed since it was approved, and continue. A
macro planned before schema 1.2 has no approval keys and dispatches as before,
with no line. The autopilot driver is Claude-only (ADR-0063 D9); the gate
behaves the same on both hosts.

---

## Phase 2 - Branch and ownership preconditions

Before switching branches, one block checks, and only reads: a refusal leaves
nothing behind.

1. A clean worktree. A dirty one stops here, and its proposal selects a
   worktree first (ADR-0067 Decision 8, item 3): `state.mjs
   worktree-proposal` prints the `git worktree add` command (runtime:worktree's
   path rule) and the `$orchestrator:next` to run inside the new worktree, or
   why none helps (the macro in a linked worktree's own home, or the subtask
   branch checked out here). Commit, stash or revert here stay the rejected
   alternatives. With the subtask branch checked out here and the subtask in
   progress, the changes are its engineer workflow's: the selection is the
   ordinary resume of that workflow on this branch (`$engineer:resume`), not a
   worktree.
2. The engineer plugin, with `scripts/discover-engineer.mjs discover`, and
   its `preflight`.
3. Engineer `state.mjs find-active --branch "$SUBTASK_BRANCH"`. An engineer
   workflow already on the subtask branch must match both
   `parent_workflow == <macro id>` and `originating_subtask == <subtask id>`;
   otherwise stop, and do not reuse an unrelated engineer workflow. A subtask
   that records an `engineer_workflow_id` with no active workflow on its
   branch stops too: its child has usually committed and archived itself, and
   the subtask stays `in_progress` until `$orchestrator:done` records the
   landing.

```bash
TEXT_DIR='<directory from mktemp>'
REPO_ROOT="$(cat "$TEXT_DIR/repo-root")" || exit 1
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
MACRO_ID="$(basename "$MACRO_PATH" .md)"
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
SUBTASK_ID="$(JSON_KEY=id node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_BRANCH="$(JSON_KEY=branch node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_EXISTING_ENG_WF_ID="$(JSON_KEY=engineer_workflow_id node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]; then
  echo "✗ Working tree not clean — \$orchestrator:next does not switch branches over uncommitted changes." >&2
  node "<orchestrator-plugin-root>/scripts/state.mjs" worktree-proposal \
    --workflow-path "$MACRO_PATH" --repo-root "$REPO_ROOT" --subtask-id "$SUBTASK_ID" \
    --host codex --format text >&2 || true
  exit 1
fi
ENGINEER_PLUGIN_ROOT="$(node "<orchestrator-plugin-root>/scripts/discover-engineer.mjs" discover)"
[ -n "$ENGINEER_PLUGIN_ROOT" ] || { echo "✗ engineer plugin not found; install engineer or set AGENTIC_ENGINEER_ROOT." >&2; exit 1; }
node "<orchestrator-plugin-root>/scripts/discover-engineer.mjs" preflight --root "$ENGINEER_PLUGIN_ROOT" || exit 1
EXISTING_ENG_PATH="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" --branch "$SUBTASK_BRANCH")" || exit 1
if [ -n "$SUBTASK_EXISTING_ENG_WF_ID" ] && [ -z "$EXISTING_ENG_PATH" ]; then
  echo "✗ Subtask $SUBTASK_ID records engineer_workflow_id=$SUBTASK_EXISTING_ENG_WF_ID but no active engineer workflow is on '$SUBTASK_BRANCH'; once its pull request has merged, record it with \$orchestrator:done $SUBTASK_ID." >&2
  exit 1
fi
if [ -n "$EXISTING_ENG_PATH" ]; then
  # The read's own status, apart from the parser's (C110).
  EXISTING_ENG_JSON="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$EXISTING_ENG_PATH")" || exit 1
  EXISTING_ENG_PARENT="$(printf '%s' "$EXISTING_ENG_JSON" | JSON_KEY=parent_workflow node -e "$JSON_FIELD")" || exit 1
  EXISTING_ENG_SUBTASK="$(printf '%s' "$EXISTING_ENG_JSON" | JSON_KEY=originating_subtask node -e "$JSON_FIELD")" || exit 1
  if [ "$EXISTING_ENG_PARENT" != "$MACRO_ID" ] || [ "$EXISTING_ENG_SUBTASK" != "$SUBTASK_ID" ]; then
    echo "✗ engineer workflow already active on '$SUBTASK_BRANCH' with another parent linkage (parent_workflow=$EXISTING_ENG_PARENT, originating_subtask=$EXISTING_ENG_SUBTASK): $EXISTING_ENG_PATH" >&2
    exit 1
  fi
  echo "→ Idempotent re-attach: engineer workflow $(basename "$EXISTING_ENG_PATH" .md) already owns this subtask." >&2
fi
printf '%s' "$ENGINEER_PLUGIN_ROOT" > "$TEXT_DIR/engineer-root" || exit 1
printf '%s' "$EXISTING_ENG_PATH" > "$TEXT_DIR/engineer-workflow" || exit 1
```

Then join the run locks (ADR-0067 Decision 4, item 5). An autopilot run
holds this checkout's worktree lock and its macro's lock while it works;
this command takes part in both as an **admission**, which a run or another
session holding either refuses, naming the holder. The id the join prints
(empty for a worker of the run that holds the locks) goes to the text
directory, where every later block reads it:

```bash
TEXT_DIR='<directory from mktemp>'
REPO_ROOT="$(cat "$TEXT_DIR/repo-root")" || exit 1
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
MACRO_ID="$(basename "$MACRO_PATH" .md)"
ADMISSION="$(node "<orchestrator-plugin-root>/scripts/state.mjs" admission join \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --command next --host codex)" || exit 1
printf '%s' "$ADMISSION" > "$TEXT_DIR/admission" || {
  node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
  exit 1
}
```

From here every exit releases it until Phase 4 has run:

```bash
TEXT_DIR='<directory from mktemp>'
REPO_ROOT="$(cat "$TEXT_DIR/repo-root")" || exit 1
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
MACRO_ID="$(basename "$MACRO_PATH" .md)"
ADMISSION="$(cat "$TEXT_DIR/admission")" || exit 1
node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
```

After the join, read again what a run's step could have changed before it,
in the one shell call that switches, after an `admission check`: the worktree
must still be clean, engineer `find-active --branch "$SUBTASK_BRANCH"` must
still return what the ownership check saw, and the selected subtask must
still have the status, engineer workflow id, branch, verb, profile and topic
Phase 1 read (a run's step may have completed it and archived its child, and a
plan revision may have changed what Phase 3 dispatches), and a pending subtask
must still wait on nothing (`subtask-readiness`: a plan revision may have
given it a predecessor not yet completed). If any changed, release and stop.
The block compares the subtask it reads now with the selection Phase 1 wrote,
and each read's status is its own, apart from its parser's (C110):

```bash
TEXT_DIR='<directory from mktemp>'
REPO_ROOT="$(cat "$TEXT_DIR/repo-root")" || exit 1
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
MACRO_ID="$(basename "$MACRO_PATH" .md)"
ADMISSION="$(cat "$TEXT_DIR/admission")" || exit 1
release_admission() {
  node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
}
trap 'release_admission' EXIT
ENGINEER_PLUGIN_ROOT="$(cat "$TEXT_DIR/engineer-root")" || exit 1
EXISTING_ENG_PATH="$(cat "$TEXT_DIR/engineer-workflow")" || exit 1
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
SUBTASK_ID="$(JSON_KEY=id node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_BRANCH="$(JSON_KEY=branch node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
SUBTASK_STATUS="$(JSON_KEY=status node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1
node "<orchestrator-plugin-root>/scripts/state.mjs" admission check \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION" || exit 1
[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ] \
  || { echo "✗ The working tree changed after the clean check; nothing was switched." >&2; exit 1; }
NOW_ENG_PATH="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" --branch "$SUBTASK_BRANCH")" || exit 1
[ "$NOW_ENG_PATH" = "$EXISTING_ENG_PATH" ] \
  || { echo "✗ The engineer workflow on '$SUBTASK_BRANCH' changed after the ownership check; nothing was switched." >&2; exit 1; }
NOW_SUBTASK="$(node "<orchestrator-plugin-root>/scripts/state.mjs" read-subtask \
  --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID")" || exit 1
SUBTASK_CHANGES="$(printf '%s' "$NOW_SUBTASK" \
  | node -e 'const fs=require("fs");let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const now=JSON.parse(d),was=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),out=[];for(const k of ["status","engineer_workflow_id","branch","verb","profile","topic"]){const a=String(was[k]||""),b=String(now[k]||"");if(a!==b)out.push(k+" was "+JSON.stringify(a)+", now "+JSON.stringify(b))}process.stdout.write(out.join("; "))})' \
  "$TEXT_DIR/subtask.json")" || exit 1
[ -z "$SUBTASK_CHANGES" ] \
  || { echo "✗ Subtask $SUBTASK_ID changed after its selection ($SUBTASK_CHANGES); nothing was switched." >&2; exit 1; }
if [ "$SUBTASK_STATUS" = "pending" ]; then
  READINESS_NOW="$(node "<orchestrator-plugin-root>/scripts/state.mjs" subtask-readiness \
    --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID")" || exit 1
  WAITING_NOW="$(printf '%s' "$READINESS_NOW" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).waiting_on.join(", ")))')" || exit 1
  [ -z "$WAITING_NOW" ] \
    || { echo "✗ Subtask $SUBTASK_ID now waits on: $WAITING_NOW (the plan changed after its selection); nothing was switched." >&2; exit 1; }
fi
MACRO_JSON="$(node "<orchestrator-plugin-root>/scripts/state.mjs" read --workflow-path "$MACRO_PATH")" || exit 1
INTEGRATION_BRANCH="$(printf '%s' "$MACRO_JSON" \
  | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write((JSON.parse(d).git_baseline||{}).branch||""))')" || exit 1
[ -n "$INTEGRATION_BRANCH" ] \
  || { echo "✗ The macro records no git_baseline.branch; cannot tell which branch subtasks start from." >&2; exit 1; }
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$SUBTASK_BRANCH"; then
  git -C "$REPO_ROOT" switch "$SUBTASK_BRANCH" || exit $?
elif git -C "$REPO_ROOT" remote get-url origin >/dev/null 2>&1; then
  git -C "$REPO_ROOT" fetch --quiet origin "$INTEGRATION_BRANCH" \
    || echo "⚠ git fetch origin $INTEGRATION_BRANCH failed; branching from the last fetched origin/$INTEGRATION_BRANCH." >&2
  git -C "$REPO_ROOT" show-ref --verify --quiet "refs/remotes/origin/$INTEGRATION_BRANCH" \
    || { echo "✗ refs/remotes/origin/$INTEGRATION_BRANCH does not exist; cannot start $SUBTASK_BRANCH from the integration branch." >&2; exit 1; }
  git -C "$REPO_ROOT" switch --no-track -c "$SUBTASK_BRANCH" "refs/remotes/origin/$INTEGRATION_BRANCH" || exit $?
else
  git -C "$REPO_ROOT" switch -c "$SUBTASK_BRANCH" "refs/heads/$INTEGRATION_BRANCH" || exit $?
fi
# Switched: from here the admission is held until Phase 4 releases it.
trap - EXIT
```

The block switches to the subtask branch, creating it only when absent, and
keeps the admission once the switch has succeeded (`trap - EXIT`); every exit
before that releases it. A new branch starts from the integration branch —
the macro's `git_baseline.branch` — as the remote last reported it, never
from the checked-out `HEAD` (ADR-0062 §Decision 2), and the block stops if
that remote-tracking ref does not exist. Only a repository with no `origin`
remote branches from the local integration branch. After a squash or rebase
merge, the previous subtask's branch is not part of the integration branch,
so a successor built on it would carry obsolete history.

---

## Phase 3 - Invoke engineer with parent-linkage

Do not invoke `core/skills/<verb>/SKILL.md` directly. Do not call engineer
`state.mjs create` directly. Both bypass the engineer command Phase 0
bootstrap and break ADR-0019 writeback.

Read `<engineer-root>/commands/<subtask.verb>.md` and execute its
Phase 0 plus verb body with this prelude in the same shell session. The
prelude reads everything it exports from the text directory:

```bash
TEXT_DIR='<directory from mktemp>'
ORCH_PLUGIN_ROOT="<orchestrator-plugin-root>"
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
# ADR-0067 Decision 4, item 5 — stop before dispatching when this session's
# admission is gone (Phase 4 still runs, and releases what is left of it).
node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" admission check \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION" || exit 1
export CLAUDE_PLUGIN_ROOT="$ENGINEER_PLUGIN_ROOT"
export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"
export AGENTIC_PARENT_WORKFLOW_PATH="$MACRO_PATH"
export AGENTIC_ORIGINATING_SUBTASK="$SUBTASK_ID"
# ADR-0067 Decision 4, item 5 — the selection Phase 1 made, recorded by the
# engineer beside the ids for every later binding to compare.
# Built apart from its export, which would hide the node's failure: a selection
# lost here would create a child without the record.
AGENTIC_DISPATCH_SELECTION="$(node -e 'const [subtask, branch, verb, profile, topic] = process.argv.slice(1); process.stdout.write(JSON.stringify({ subtask, branch, verb, profile, topic }))' -- "$SUBTASK_ID" "$SUBTASK_BRANCH" "$SUBTASK_VERB" "${SUBTASK_PROFILE:-}" "${SUBTASK_TOPIC:-}")" || exit 1
export AGENTIC_DISPATCH_SELECTION
export AGENTIC_HOST="codex"
export AGENTIC_PROFILE="${SUBTASK_PROFILE:-}"
export AGENTIC_TOPIC="${SUBTASK_TOPIC:-}"
```

On Claude the host flag is `claude`; on Codex use `codex`. If the
current checkout is a direct development checkout rather than an
installed cache, prefer the actual invoking host over path-shape
guessing. Re-emit this prelude at the top of every engineer block you run in
another shell call. Whatever the engineer runbook's outcome (finished,
stopped at a gate, or a block exited non-zero), go on to Phase 4: the
engineer's exits cannot release this command's admission.

---

## Phase 4 - Post-create writeback

After engineer Phase 0 creates or reattaches a workflow, find the
active engineer workflow on the subtask branch and write it back, checking
the admission first and releasing it on every exit, the writeback's failure
and a missing workflow included. The block finds the workflow itself and
reads the subtask as Phase 1 selected it, so it runs in a fresh shell call.
The writeback binds the child only to the subtask it was dispatched for: under
the macro's file lock it refuses the write when a plan revision since Phase 1
changed the subtask's branch, verb, profile or topic, or when the subtask is no
longer the one the child records it was dispatched for (a child re-attached
from an earlier dispatch included; the admission keeps out a run and the other
commands that join, not `$orchestrator:plan`):

```bash
TEXT_DIR='<directory from mktemp>'
# What the release needs, before anything else. Should one of them be gone,
# the block cannot release an admission the join may have taken: the next
# join's refusal names it, with the command that releases it.
for CARRIED in repo-root macro-path admission; do
  [ -f "$TEXT_DIR/$CARRIED" ] || { echo "✗ $TEXT_DIR/$CARRIED is missing, so this block cannot release the admission Phase 2 joined, if it joined: the next \$orchestrator:next refusal names it and the command that releases it." >&2; exit 1; }
done
REPO_ROOT="$(cat "$TEXT_DIR/repo-root")" || exit 1
MACRO_PATH="$(cat "$TEXT_DIR/macro-path")" || exit 1
MACRO_ID="$(basename "$MACRO_PATH" .md)"
ADMISSION="$(cat "$TEXT_DIR/admission")" || exit 1
release_admission() {
  node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \
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
ACTIVE_PATH="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" --branch "$SUBTASK_BRANCH" 2>/dev/null)"
[ -n "$ACTIVE_PATH" ] || { echo "✗ no active engineer workflow on $SUBTASK_BRANCH" >&2; exit 1; }
ENGINEER_WF_ID="$(basename "$ACTIVE_PATH" .md)"
# The dispatch the child records (ADR-0067 Decision 4, item 5).
CHILD_DISPATCH="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
  dispatch-selection --workflow-path "$ACTIVE_PATH")" || exit 1
node "<orchestrator-plugin-root>/scripts/state.mjs" admission check \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION" || exit 1
node "<orchestrator-plugin-root>/scripts/state.mjs" subtask-update \
  --workflow-path "$MACRO_PATH" \
  --host codex \
  --subtask-id "$SUBTASK_ID" \
  --status in_progress \
  --engineer-workflow-id "$ENGINEER_WF_ID" \
  --expect-branch="$SUBTASK_BRANCH" --expect-verb="$SUBTASK_VERB" \
  --expect-profile="$SUBTASK_PROFILE" --expect-topic="$SUBTASK_TOPIC" \
  --expect-dispatch="$CHILD_DISPATCH" \
  --event updated
```

Surface the JSON envelope. Respect skipped absorbing-terminal results:
`deferred` and `abandoned` must not be advanced back to
`in_progress`. A refused writeback names the field that changed; the child
stays unrecorded. Report it with the child's workflow id and leave the choice
to the user: archive the child (`$engineer:resume archive <id>` on its
branch) and rerun `$orchestrator:next`, or revise the plan back.

ARCHIVE TIMING — when this update lands the macro's final subtask, the
auto-terminal pass marks the macro terminal without any `set-terminal` call of
its own. On Claude the Stop hook fires at **every turn end**, so the macro archive
gates are **evaluated** at the end of **this** turn, not at session close, and the
file moves then if they all pass. To hold it open, run the full `state.mjs
set-terminal` form (`--workflow-path`, `--host`, `--terminal-phase` all required)
with `--terminal-marker false` before that Stop fires. On Codex the Stop hook runs
only once the operator has trusted the plugin hooks (`/hooks`), so the evaluation
waits. Full contract: `core/skills/_shared/references/session-handoff.md`
§ Archive timing.

---

## Completion

Report the macro id, subtask id, engineer workflow id, and branch, with the
approval gate's warning line when it printed one, then emit an
**Active Next-Action Proposal** (not a fixed next command) per
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

Derive from the post-dispatch macro state (another
`$orchestrator:next` when subtasks remain ready; `$orchestrator:finalize` when
all are terminal; else waiting on the dispatched subtask's commit). Append the
runtime completion footer when available. The footer is advisory and
pointer-only; do not mutate host session context or paste raw peer output into
the main session.

Surface the ADR-0031 session-level continue-vs-fresh preflight per
`core/skills/_shared/references/session-handoff.md`: compute the macro projection
(find-active then find-macro) and pass it to the runtime footer/check. The
preflight computes identically on Codex; only auto re-injection of the
next-session prompt depends on the stage-appropriate Codex hook gate
(generic `[features].hooks`, default on) + a `/hooks` trust
(operator-attested via `runtime:doctor` / `runtime:settings`; not provable
non-interactively). On detached HEAD, report "no active branch context".

---

## Anti-patterns

- Do not bypass engineer command Phase 0.
- Do not split AGENTIC_* exports into a separate shell call.
- Do not dispatch a blocked subtask.
- Do not approve a plan on the owner's behalf to get past `plan-unapproved`.
- Do not treat `--peer` as implemented.
- Do not relax git cleanliness or ownership checks.
