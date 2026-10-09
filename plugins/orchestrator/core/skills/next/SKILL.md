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

- optional leading `<subtask-id>`;
- optional `--workflow=<macro-id>`.

Reject `--workflow` values that are not basename-shaped. Do not allow
`/`, `\`, `..`, leading `.`, or NUL.

---

## Phase 1 - Resolve macro and subtask

Resolve the macro workflow:

1. If `--workflow=<id>` is supplied, run `state.mjs resolve-workflow
   --repo-root "$REPO_ROOT" --workflow-id "<id>"`: it prints the macro file
   in the orchestrator workflow homes of this checkout's read set (the
   default state root first, ADR-0067 Decision 4, item 2), and exits
   non-zero when no root holds it (3) or two files do (1); stop then.
2. Otherwise run `state.mjs find-active --repo-root "$REPO_ROOT"`.
3. If no active macro exists for the current branch, run
   `state.mjs find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH"`.

Resolve the subtask:

- explicit id -> `state.mjs read-subtask`;
- no id -> `state.mjs next-ready`.

Reject dispatch when the selected subtask is `completed`, `deferred`,
`abandoned`, `blocked`, or `pending` with incomplete `blocked_by`
predecessors. `in_progress` is allowed only as the idempotent
reattach path.

Take the dependency facts from the state CLI, not from the status alone
(ADR-0062 §Decision 5): `state.mjs subtask-readiness --workflow-path
"$MACRO_PATH" --subtask-id "$SUBTASK_ID"` returns `waiting_on` (the
predecessors not yet completed) and `stale_blocked` (marked `blocked` with
nothing left to wait on — a file written before the shared unblock pass;
repair it with `state.mjs subtask-update --status=pending`). When
`next-ready` finds nothing, its `readiness` array carries the same facts
for every open subtask; report them per subtask. An `in_progress` subtask
whose engineer workflow has committed stays `in_progress` until its work
lands: once its pull request has merged, record it with
`$orchestrator:done <id>`.

Then apply the plan-approval gate (ADR-0063 D4 rule 3, owner decision D3),
for an explicit id as well as for the automatic pick, because
`subtask-readiness` reports no approval:

```bash
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

Before switching branches:

1. Require a clean worktree.
2. Resolve the engineer plugin with
   `scripts/discover-engineer.mjs discover`.
3. Run `scripts/discover-engineer.mjs preflight --root "$ENGINEER_PLUGIN_ROOT"`.
4. Ask engineer `state.mjs find-active --repo-root "$REPO_ROOT" --branch "$SUBTASK_BRANCH"`.

If an engineer workflow already exists on the subtask branch, it must
match both `parent_workflow == <macro id>` and
`originating_subtask == <subtask id>`. Otherwise stop; do not reuse an
unrelated engineer workflow. These checks only read: a refusal leaves
nothing behind.

Then join the run locks (ADR-0067 Decision 4, item 5). An autopilot run
holds this checkout's worktree lock and its macro's lock while it works;
this command takes part in both as an **admission**, which a run or another
session holding either refuses, naming the holder:

```bash
ADMISSION="$(node "<orchestrator-plugin-root>/scripts/state.mjs" admission join \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --command next --host codex)" || exit 1
```

Carry the id it prints into every later block as `ADMISSION`, as you carry
`MACRO_PATH` (it is empty for a worker of the run that holds the locks).
From here every exit releases it until Phase 4 has run:

```bash
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
given it a predecessor not yet completed). If any changed, release and stop. Set `SUBTASK_STATUS`, `SUBTASK_EXISTING_ENG_WF_ID`,
`SUBTASK_BRANCH`, `SUBTASK_VERB`, `SUBTASK_PROFILE` and `SUBTASK_TOPIC` to the
selected subtask's `status`, `engineer_workflow_id`, `branch`, `verb`,
`profile` and `topic` as Phase 1 read them (empty when absent), and
`EXISTING_ENG_PATH` to what the ownership check's `find-active` printed:

```bash
release_admission() {
  node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
}
trap 'release_admission' EXIT
node "<orchestrator-plugin-root>/scripts/state.mjs" admission check \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION" || exit 1
[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ] \
  || { echo "✗ The working tree changed after the clean check; nothing was switched." >&2; exit 1; }
NOW_ENG_PATH="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" --branch "$SUBTASK_BRANCH")" || exit 1
[ "$NOW_ENG_PATH" = "$EXISTING_ENG_PATH" ] \
  || { echo "✗ The engineer workflow on '$SUBTASK_BRANCH' changed after the ownership check; nothing was switched." >&2; exit 1; }
SUBTASK_CHANGES="$(node "<orchestrator-plugin-root>/scripts/state.mjs" read-subtask \
  --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d),a=process.argv.slice(1),out=[];for(let i=0;i<a.length;i+=2){const now=String(s[a[i]]||"").replace(/\n+$/,"");if(now!==a[i+1])out.push(a[i]+" was "+JSON.stringify(a[i+1])+", now "+JSON.stringify(now))}process.stdout.write(out.join("; "))})' -- \
  status "$SUBTASK_STATUS" engineer_workflow_id "$SUBTASK_EXISTING_ENG_WF_ID" \
  branch "$SUBTASK_BRANCH" verb "$SUBTASK_VERB" profile "$SUBTASK_PROFILE" topic "$SUBTASK_TOPIC")" || exit 1
[ -z "$SUBTASK_CHANGES" ] \
  || { echo "✗ Subtask $SUBTASK_ID changed after its selection ($SUBTASK_CHANGES); nothing was switched." >&2; exit 1; }
if [ "$SUBTASK_STATUS" = "pending" ]; then
  WAITING_NOW="$(node "<orchestrator-plugin-root>/scripts/state.mjs" subtask-readiness \
    --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).waiting_on.join(", ")))')" || exit 1
  [ -z "$WAITING_NOW" ] \
    || { echo "✗ Subtask $SUBTASK_ID now waits on: $WAITING_NOW (the plan changed after its selection); nothing was switched." >&2; exit 1; }
fi
INTEGRATION_BRANCH="$(node "<orchestrator-plugin-root>/scripts/state.mjs" read --workflow-path "$MACRO_PATH" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).git_baseline.branch||"")}catch{}})')"
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
Phase 0 plus verb body with this prelude in the same shell session:

```bash
ORCH_PLUGIN_ROOT="<orchestrator-plugin-root>"
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
guessing. Re-emit the check with the exports at the top of every engineer
block you run in another shell call. Whatever the engineer runbook's
outcome (finished, stopped at a gate, or a block exited non-zero), go on to
Phase 4: the engineer's exits cannot release this command's admission.

---

## Phase 4 - Post-create writeback

After engineer Phase 0 creates or reattaches a workflow, find the
active engineer workflow on the subtask branch and write it back, checking
the admission first and releasing it on every exit, the writeback's failure
and a missing workflow included. The block finds the workflow itself, so it
runs in a fresh shell call; set `SUBTASK_BRANCH`, `SUBTASK_VERB`,
`SUBTASK_PROFILE` and `SUBTASK_TOPIC` as Phase 2's switching block had them.
The writeback binds the child only to the subtask it was dispatched for: under
the macro's file lock it refuses the write when a plan revision since Phase 1
changed the subtask's branch, verb, profile or topic, or when the subtask is no
longer the one the child records it was dispatched for (a child re-attached
from an earlier dispatch included; the admission keeps out a run and the other
commands that join, not `$orchestrator:plan`):

```bash
release_admission() {
  node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
}
trap 'release_admission' EXIT
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
