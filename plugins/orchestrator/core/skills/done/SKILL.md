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

Require a leading `<subtask-id>`.

Parse optional:

- `--pr=<n>` — names the pull request when more than one merged the branch;
- `--commit=<sha>` — must equal that pull request's merge commit;
- `--correct` — replace a recorded value deliberately (needs a reason);
- `--no-commit` — the work landed no commit (needs a reason; excludes
  `--pr`, `--commit` and `--correct`);
- `--waive-dispatch` — complete in the recorded owner's name without
  comparing the dispatch it records, when no file of it is left to read it
  from (Phase 2; needs a reason, and the macro records both). Set
  `WAIVE_DISPATCH=1`;
- `--workflow=<macro-id>`;
- `--integration-branch=<b>` — default is the macro's `git_baseline.branch`;
- the remaining free text is the reason. Write it to a file with your
  file-editing tool and pass that file as `--reason-file`; never splice it
  into a command line or a heredoc (a delimiter line in the text would end
  the heredoc and run what follows).

Reject unsafe `--workflow` values. The workflow id must be basename
shaped.

---

## Phase 1 - Resolve macro and subtask

Resolve the macro using the same order as `next`:

1. explicit `--workflow`;
2. `state.mjs find-active --repo-root "$REPO_ROOT"`;
3. `state.mjs find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH"`.

Then read the subtask:

```bash
node "<orchestrator-plugin-root>/scripts/state.mjs" read-subtask \
  --workflow-path "$MACRO_PATH" \
  --subtask-id "$SUBTASK_ID"
```

If the subtask is already `completed` and `--correct` was not given,
report a no-op. If it is `deferred` or `abandoned`, stop; terminal-partial
states are absorbing and must not be overwritten.

---

## Phase 2 - Resolve engineer workflow id

Phase 4's write completes the subtask in its owner's name, so it compares the
dispatch that owner records (ADR-0067 Decision 4, item 5), and is refused
(`dispatch-changed`) when the subtask is no longer the one the owner was
dispatched for. `state.mjs owner-dispatch` finds the owner and reads that
dispatch: it reads every engineer workflow file in the workflow homes **and
archive homes** of every root of the repository (by the time the work has
merged the child has normally archived itself) and parses the frontmatter
values it needs, never matching serialized text:

- the subtask records an `engineer_workflow_id` → the file of that workflow
  that claims the subtask. When no file of it is left anywhere in the
  repository the dispatch cannot be read, and the command exits 3: stop, unless
  the user gave `--waive-dispatch` with a reason. A file of it that claims
  another subtask exits 1, with no waiver.
- otherwise → the one workflow whose `parent_workflow` is the macro id **and**
  whose `originating_subtask` is the subtask id. None exits 1: this subtask
  was likely never dispatched via `$orchestrator:next` — re-dispatch it with
  `$orchestrator:next <id>` to create the engineer child (the single honest
  recovery for this guard state). Manual completion without a child is **not**
  supported — `subtask-update` requires `--engineer-workflow-id`. More than
  one exits 1 and lists each claimant with a binding line that carries its
  dispatch (`subtask-update --engineer-workflow-id=<id>
  --expect-dispatch=<its dispatch>`); surface them, and let the user pick the
  one that did the work, then rerun.

A home or file that cannot be read (anything but a missing one) also exits 1,
since it could hide a claimant or the owner's file. Do not invent an engineer
workflow id. Run it to read the owner before Phase 3 (Phase 4 runs it again,
after the join, and passes its answer to the write itself):

```bash
SUBTASK_JSON="$(node "<orchestrator-plugin-root>/scripts/state.mjs" read-subtask \
  --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID")" || exit 1
RECORDED_OWNER="$(printf '%s' "$SUBTASK_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.stdout.write(JSON.parse(d).engineer_workflow_id||"")})')" || exit 1
OWNER_ARGS=(--repo-root "$REPO_ROOT" --macro-id "$MACRO_ID" --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" --host codex)
[ -n "$RECORDED_OWNER" ] && OWNER_ARGS+=(--engineer-workflow-id "$RECORDED_OWNER")
node "<orchestrator-plugin-root>/scripts/state.mjs" owner-dispatch "${OWNER_ARGS[@]}"
```

On exit 0 its JSON's `engineer_workflow_id` is the owner: set
`ENGINEER_WF_ID` to it for Phase 3 and Phase 4. On exit 3 with
`--waive-dispatch`, `ENGINEER_WF_ID` is the recorded owner.

---

## Phase 3 - Resolve the landing

With `--no-commit`: refuse while an engineer workflow for the subtask is
still **active** (it could never archive and would keep the macro's
no-active-children gate closed), and refuse when a workflow home or file
cannot be read (anything but a missing one), since the unreadable entry
could be that child; then go to Phase 4 without a commit.

Otherwise `git fetch origin <integration>` and run:

```bash
node "<orchestrator-plugin-root>/scripts/state.mjs" resolve-landing \
  --repo-root "$REPO_ROOT" --workflow-path "$MACRO_PATH" \
  --subtask-id "$SUBTASK_ID" --integration-branch "$INTEGRATION_BRANCH" \
  --engineer-workflow-id "$ENGINEER_WF_ID" [--pr "$PR"] [--commit "$COMMIT"]
```

It finds the merged pull request whose head is the subtask branch and that
was opened after the engineer workflow `ENGINEER_WF_ID` (Phase 2) was
dispatched, checks its base is
the integration branch, and verifies its merge commit is reachable from
`refs/remotes/origin/<integration>`. On `{ok: false}` report its `reason`
and `detail` and stop (`not_merged`, `no_pr`, `ambiguous`,
`base_mismatch`, `commit_mismatch`, `not_reachable`, `gh_unavailable`,
`no_integration_ref`). With `verification: "ancestry-only"` (no working
`gh`), add that fact to the reason file. Never record the subtask branch
tip or `HEAD`.

---

## Phase 4 - Atomic subtask update

The checks above only read: a routine refusal (`not_merged`, an active
child) leaves nothing behind. Before the write, join the macro's run lock
(ADR-0067 Decision 4, item 5): an autopilot run or another session holding
it refuses, naming the holder, and nothing is written. With `--no-commit`
(set `NO_COMMIT=1`; a block with no `COMMIT_SHA` runs it too), the block runs
the active-child check again after the join, since a run's step could have
dispatched the subtask meanwhile. Release the admission on every exit
from the join on, the write's failure included; `subtask-update` checks
ownership and provenance itself. Set `ENGINEER_WF_ID` to the owner Phase 2
printed, the one Phase 3 resolved the landing for: the block reads that owner's
dispatch again after the join and passes it to the write itself, and refuses
when the subtask records another owner by then. Run in one shell call:

```bash
ADMISSION="$(node "<orchestrator-plugin-root>/scripts/state.mjs" admission join \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --command done --host codex)" || exit 1
release_admission() {
  node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
}
trap 'release_admission' EXIT
# --no-commit (NO_COMMIT=1, or no commit to record): the active-child check
# again, after the join. active-child reads every root of the repository and
# parses each frontmatter; only a missing home or file is "no child".
if [ "${NO_COMMIT:-}" = "1" ] || [ -z "${COMMIT_SHA:-}" ]; then
  ACTIVE_CHILD="$(node "<orchestrator-plugin-root>/scripts/state.mjs" active-child \
    --repo-root "$REPO_ROOT" --macro-id "$MACRO_ID" --subtask-id "$SUBTASK_ID")" \
    || { echo "✗ Could not scan the engineer workflow homes for an active child of $SUBTASK_ID; refusing --no-commit." >&2; exit 1; }
  [ -z "$ACTIVE_CHILD" ] || { echo "✗ An engineer workflow for $SUBTASK_ID is still active: $ACTIVE_CHILD" >&2; exit 1; }
fi
# The dispatch of ENGINEER_WF_ID, the owner Phase 2 printed and Phase 3
# resolved the landing for, read again here so the write compares what this
# block read. A subtask that now records another owner (a revision and a new
# dispatch since) refuses: the landing is that owner's. Exit 3 alone (the
# recorded owner has no file left) may be waived, with WAIVE_DISPATCH=1 and a
# reason.
[ -n "${ENGINEER_WF_ID:-}" ] || { echo "✗ ENGINEER_WF_ID is not set: run Phase 2, and set it to the owner it printed." >&2; exit 1; }
JSON_FIELD='let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))}catch{}})'
SUBTASK_JSON="$(node "<orchestrator-plugin-root>/scripts/state.mjs" read-subtask \
  --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID")" || exit 1
RECORDED_OWNER="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=engineer_workflow_id node -e "$JSON_FIELD")"
if [ -n "$RECORDED_OWNER" ] && [ "$RECORDED_OWNER" != "$ENGINEER_WF_ID" ]; then
  echo "✗ $SUBTASK_ID now records owner $RECORDED_OWNER, not $ENGINEER_WF_ID, the owner Phase 3 resolved the landing for; nothing was written. Rerun from Phase 2." >&2
  exit 1
fi
OWNER_ARGS=(--repo-root "$REPO_ROOT" --macro-id "$MACRO_ID" --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID" --host codex --engineer-workflow-id "$ENGINEER_WF_ID")
# Under set -e an unguarded nonzero exit would end the block before OWNER_RC.
OWNER_JSON="$(node "<orchestrator-plugin-root>/scripts/state.mjs" owner-dispatch "${OWNER_ARGS[@]}")" && OWNER_RC=0 || OWNER_RC=$?
if [ "$OWNER_RC" -eq 0 ]; then
  [ "${WAIVE_DISPATCH:-}" != "1" ] || { echo "✗ --waive-dispatch applies only when the owner's dispatch cannot be read; it was read, and the write compares it." >&2; exit 1; }
  OWNER_DISPATCH="$(printf '%s' "$OWNER_JSON" | JSON_KEY=dispatch node -e "$JSON_FIELD")"
  [ -n "$OWNER_DISPATCH" ] || { echo "✗ Could not read owner-dispatch's answer for $SUBTASK_ID." >&2; exit 1; }
  DISPATCH_ARGS=(--expect-dispatch "$OWNER_DISPATCH")
elif [ "$OWNER_RC" -eq 3 ] && [ "${WAIVE_DISPATCH:-}" = "1" ] && [ "$RECORDED_OWNER" = "$ENGINEER_WF_ID" ]; then
  DISPATCH_ARGS=(--waive-dispatch)
else
  exit 1
fi
node "<orchestrator-plugin-root>/scripts/state.mjs" subtask-update \
  --workflow-path "$MACRO_PATH" \
  --host codex \
  --subtask-id "$SUBTASK_ID" \
  --status completed \
  --engineer-workflow-id "$ENGINEER_WF_ID" \
  --commit "$COMMIT_SHA" \
  --pr-url "$PR_URL" \
  --closed-at "$CLOSED_AT" \
  --expect-branch "$SUBTASK_BRANCH" \
  "${DISPATCH_ARGS[@]}" \
  --event updated \
  [--correct] [--reason-file "$REASON_FILE"]
```

Omit `--commit` and `--pr-url` for `--no-commit`, and `--pr-url` when the
landing has none. `--expect-branch` refuses the write if a plan revision
moved the subtask after the landing was resolved. `DISPATCH_ARGS` carries the
owner's dispatch: the write is refused (`dispatch-changed`) when the subtask
is no longer the one that owner was dispatched for, and binds or completes
nothing. With `--waive-dispatch` (exit 3 only) it carries the waiver instead,
which the macro body records with the reason. A recorded `commit` or
`pr_url` is never replaced, and a recorded `closed_at` is kept, unless
`--correct` with a reason; the macro body then records old value, new
value and reason.

Surface the JSON envelope. `subtask-update` owns single-writer
ownership checks, absorbing-completed semantics, unblock propagation,
and macro auto-terminal promotion.

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
