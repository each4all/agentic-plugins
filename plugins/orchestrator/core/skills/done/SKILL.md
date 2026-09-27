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
| Entry | `/orchestrator:done <subtask-id> [--pr=<n>] [--commit=<sha>] [--correct \| --no-commit] [--workflow=<macro-id>] [--integration-branch=<b>] [reason]` | `$orchestrator:done` with the same arguments |
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

Prefer the subtask's recorded `engineer_workflow_id`.

If absent, scan the engineer workflow homes **and archive homes** (by the
time the work has merged the child has normally archived itself), and
require both frontmatter keys to match; refuse more than one distinct
match rather than guess. Also refuse when a home or file cannot be read
(anything but a missing one), since it could hide a second claimant:

- `parent_workflow == <macro id>`;
- `originating_subtask == <subtask id>`.

Do not match on only one key. Do not invent an engineer workflow id.
If no child is found, stop: this subtask was likely never dispatched via
`$orchestrator:next` — re-dispatch it with `$orchestrator:next <id>` to create
the engineer child (the single honest recovery for this guard state). Manual
completion without a child is **not** supported — `subtask-update` requires
`--engineer-workflow-id`; reconciling that scenario would need a follow-up ADR
(mirrors `commands/done.md`'s no-child guard).

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
  [--pr "$PR"] [--commit "$COMMIT"]
```

It finds the merged pull request whose head is the subtask branch and that
was opened after the engineer workflow was dispatched, checks its base is
the integration branch, and verifies its merge commit is reachable from
`refs/remotes/origin/<integration>`. On `{ok: false}` report its `reason`
and `detail` and stop (`not_merged`, `no_pr`, `ambiguous`,
`base_mismatch`, `commit_mismatch`, `not_reachable`, `gh_unavailable`,
`no_integration_ref`). With `verification: "ancestry-only"` (no working
`gh`), add that fact to the reason file. Never record the subtask branch
tip or `HEAD`.

---

## Phase 4 - Atomic subtask update

Run:

```bash
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
  --event updated \
  [--correct] [--reason-file "$REASON_FILE"]
```

Omit `--commit` and `--pr-url` for `--no-commit`, and `--pr-url` when the
landing has none. `--expect-branch` refuses the write if a plan revision
moved the subtask after the landing was resolved. A recorded `commit` or
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
