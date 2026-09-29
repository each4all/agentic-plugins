# ADR-0062: Macro subtask completion is recorded when the work lands

## Status

Accepted (2026-09-27, owner decision). Supersedes in part
[ADR-0019](0019-cross-plugin-invocation-contract.md) §4 (when a subtask
is recorded `completed`, what its `commit` names, and the idempotency of
`/orchestrator:done`) and
[ADR-0028](0028-engineer-phase7-commit-automation.md) §P10 (Phase 7
recording the subtask's completion).

## Context

ADR-0019 §4 records a macro subtask as `completed` when its engineer
workflow reaches its terminal commit. Two writers do it: Phase 7's P10
step (`plugins/engineer/scripts/phase7-commit.mjs`) calls the parent
writeback before `set-terminal`, and the engineer Stop hook
(`plugins/engineer/scripts/stop-archive.mjs`) calls it again after the
archive. Both send `git rev-parse HEAD` of the subtask branch as the
subtask's `commit`. `/orchestrator:done` is the manual backup and
defaults to the tip of the subtask branch.

This repository lands every pull request by squash merge, or by GitHub's
rebase merge when a change has to keep per-package commits (ADR-0016).
Both create new commits on `main`. The branch commit that the writeback
recorded is therefore never an ancestor of `main`, and it disappears
when the merged branch is deleted. Measured on 2026-09-27 over the 30
macro workflows in this checkout (active and archived, canonical and
legacy homes): of 236 completed subtasks that carry a `commit`, 86 name
a commit on `origin/main`, 54 name a commit that exists but is not on
`main`, and 96 name an object this clone no longer has.

Recording completion at the branch commit has a second effect. The
unblock pass runs at the same moment, so a successor becomes
dispatchable before its predecessor's pull request exists. A successor
dispatched then is created from whatever `HEAD` is checked out, which is
the stacked-branch shape the squash merge breaks.

The record is also not stable. ADR-0028 §P10 says the Stop hook's second
writeback is safe because `updateSubtask` performs an `if_match`
compare-and-no-op, and the Stop hook's code comment says the same. No
such parameter exists. `updateSubtask` only refuses a status downgrade
and otherwise merges the payload over the completed record, so a later
writeback from the same owner replaces `commit` and `closed_at`
(docket C14). On subtask C58 of this macro series (PR #823), P10
recorded the branch commit; the commit message was then amended, and
the Stop hook replaced the record with the amended tip about two and a
half minutes later. The pull request was squash-merged as `d1bc9fc`.
Neither recorded commit is on `main`, and a note written after the merge
still cited the first one, so nobody had noticed the replacement.

Two neighbouring defects share the same code. `setPlan` replaces
`plan.subtasks` without the unblock pass that only `updateSubtask` runs,
so a plan revision that satisfies a subtask's `blocked_by` leaves it
`blocked` and `/orchestrator:next` finds nothing to dispatch (docket
C22). And `/orchestrator:plan` rewrites `current_phase` when it resumes
an existing macro and again after `plan-set`; on a macro whose
`terminal_marker` is already set, that leaves the marker true with a
non-terminal phase, which the macro archive gate A2 rejects, so the
macro can neither archive nor be dispatched.

GitHub reports the commit that landed a pull request as its
`mergeCommit`: the squash commit for a squash merge (#823 →
`d1bc9fc`), and the last rebased commit for a rebase merge (#807 →
`8cc0b67`). That gives one definition that holds for both merge modes
used here.

## Decision

### 1. `commit` names the commit that landed

A subtask's `commit` is the commit that landed its work on the
integration branch: the pull request's `mergeCommit`. The integration
branch is the macro's `git_baseline.branch` unless the operator names
another one. Records written before this decision stay as written.

### 2. Completion is recorded when the work lands

- The engineer terminal commit no longer completes the subtask. Phase 7
  and the Stop hook call the orchestrator's `subtask-engineer-terminal`
  command instead. It checks that the subtask exists and is still open,
  binds the engineer workflow as the subtask's owner when no owner was
  recorded (the recovery the old completion write provided), rejects a
  different owner, and appends one note per engineer workflow and branch
  commit. The subtask stays `in_progress`.
- `/orchestrator:done <subtask>` records completion after the merge. It
  resolves the landing through `state.mjs resolve-landing` and writes
  `status: completed`, `commit`, `pr_url` and `closed_at`. The unblock
  pass runs then, so successors become dispatchable only once their
  predecessor has landed.
- The landing is bound to this attempt. `resolve-landing` asks GitHub
  for pull requests whose head is the subtask branch and that were
  created at or after the engineer workflow was dispatched, dated from the
  owner's workflow id (the one `/orchestrator:done` recovers from the
  engineer archive when the macro never recorded it). Without a dispatch
  time it refuses rather than guess. The time applies to a pull request
  named with `--pr` as well. No such pull
  request is refused as `no_pr`, only open ones as `not_merged`, and more
  than one merged as `ambiguous` (the operator names one with `--pr`). The
  merged pull request's base must be the integration branch, and its
  `mergeCommit` must be reachable from the integration branch's
  remote-tracking ref. A `--commit` given by the operator must equal
  that `mergeCommit`. Without a working `gh`, a `--commit` is accepted
  only when it is reachable from the remote-tracking ref, and the record
  notes that only ancestry was verified.
- Work that legitimately lands no commit completes with `--no-commit`
  and a reason. It is refused while an engineer workflow for the subtask
  is still active, because that child would keep the macro's A4 gate
  closed.
- `/orchestrator:next` creates a new subtask branch from the integration
  branch's remote-tracking ref, not from the checked-out `HEAD`.
- No new status value is added. `in_progress` covers both "being worked
  on" and "committed, waiting to land"; the macro note and `next_action`
  say which.

> **Note ([ADR-0063](0063-autopilot-fresh-session-driver.md)):** completion is
> unchanged — `/orchestrator:done` records it after the pull request merges. In
> autopilot mode verbs do not set the terminal marker; only the verb-chain
> commit surface (`/engineer:commit`) does, and a subtask with nothing to commit
> is archived and then completed with `/orchestrator:done --no-commit`. The
> autopilot driver never pushes, opens or merges a pull request: it waits for
> the owner's landing, records it by running `/orchestrator:done` once
> `state.mjs resolve-landing` reports the merge, and halts `awaiting-landing`
> when nothing else can be dispatched (ADR-0063 D3a).

### 3. A recorded value is not replaced silently

- `updateSubtask` refuses to replace a recorded `commit` or `pr_url` and
  keeps a recorded `closed_at`. A value that is absent may be filled, so
  attaching a pull request URL later still works. A call that would
  change nothing writes nothing.
- A deliberate correction passes `--correct` with a reason. The write
  goes through and the macro body records the field, the old value, the
  new value and the reason.
- `subtask-update --expect-branch` refuses the write when the subtask's
  branch changed after the landing was resolved.
- `setPlan` keeps a completed subtask as it is — the work it names (verb,
  branch, topic) as much as the record of its completion: it must stay in
  the plan unchanged, fields the revision omits are carried forward, and
  changing or removing it needs `--correct`.
- The reason for `--correct` or `--no-commit` reaches the runbook as a file
  the agent wrote with its file-writing tool, never as shell text or a
  heredoc (ADR-0059).
- After a non-final completion, `next_action` names the next step (the
  subtask now ready, or the ones still to be recorded) instead of the
  engineer note's `/orchestrator:done` pointer.

### 4. A terminal macro is not revised

`setPlan` refuses when the macro's `terminal_marker` is set, and the
`/orchestrator:plan` runbook's two phase appends pass `append
--require-open`, which refuses under the same lock as the write, so a
finalize in another session cannot slip between a check and the write.
The path forward is to archive the macro and start a new plan. This keeps `/finalize` and
`/abort` decisions intact and avoids reopening a file the Stop hook may
be archiving.

### 5. One unblock pass for both writers

`setPlan` and `updateSubtask` run the same unblock pass: a `blocked`
subtask whose `blocked_by` entries are all `completed` becomes `pending`,
including when a revision empties `blocked_by`. Only `updateSubtask`
performs the auto-terminal promotion. A revision that leaves a non-empty
plan entirely terminal is reported with a pointer to
`/orchestrator:finalize`; an empty plan stays open.

### 6. Version pairing

The orchestrator's engineer preflight requires an engineer that ships
the `subtask-engineer-terminal` writeback, so `/orchestrator:next` does
not dispatch into an engineer that would still complete subtasks at its
branch commit. `/orchestrator:finalize` and `/abort` preflight with
`--purpose lifecycle`, which skips that check: they need only the
engineer's archive commands, and must not stop halfway after their first
step. An engineer that finds no `subtask-engineer-terminal`
command reports that the orchestrator is too old and carries on;
nothing is completed automatically in that case. Until both packages are
updated, the older `/orchestrator:done` must be given the landed commit
with `--commit`.

### 7. Archived macros are frozen

`/orchestrator:done`, `--correct` and the engineer writeback address
active macro workflows only. An archived macro is a historical record
and is not corrected in place; `plan-set`, `subtask-update` and
`subtask-engineer-terminal` refuse a path inside an `archive/` home.

## Consequences

**Positive**

- A subtask's `commit` resolves on `main` and survives branch cleanup.
- A successor is dispatched after its predecessor has landed and starts
  from the landed code.
- An automatic write can no longer replace a recorded value unnoticed; a
  correction leaves an audit line.
- `/orchestrator:next` finds a subtask that a plan revision unblocked.

**Negative**

- Every subtask needs one explicit `/orchestrator:done` after its merge.
  It replaces the merge note operators already wrote by hand.
- The default landing resolution needs an authenticated `gh`; without it
  the operator supplies the commit and gets ancestry-only verification.
- A macro cannot be extended once terminal; new work needs a new macro.
- Runtime surfaces show a committed-but-unmerged subtask as
  `in_progress`, the same as one still being worked on.

**Neutral**

- The orchestrator frontmatter schema, the subtask key set and the status
  vocabulary are unchanged.
- The engineer Stop hook still gates the child's archive on its own
  terminal commit; only what it tells the parent changes.

## Alternatives Considered

- **Keep the branch commit and fix only the documentation.** Leaves
  `commit` unresolvable on `main` for every squash or rebase merge.
- **Record both the branch commit and the landed commit.** Needs a new
  subtask key. The orchestrator validates a closed key set, so an older
  orchestrator on the other host would reject the file until it is
  updated. The branch commit is also lost once the branch is deleted.
- **Keep completion at the branch commit and attach the landed commit
  later.** Successors would still unblock before the merge.
- **A new `awaiting_merge` status.** The honest label, but the runtime
  entry-brief reader fails closed on an unknown status, so runtime would
  have to change and release in step.
- **Freeze the first write.** Makes a wrong first write permanent, and
  the first write is exactly the one that was wrong on C58.
- **Last write wins, with a note.** Keeps automatic writers able to move
  the record.
- **A quoted heredoc for the reason.** A reason containing the
  delimiter line ends the heredoc and runs what follows.
- **Reopen a terminal macro with `--reopen`.** Needs gate re-evaluation
  under the archive lock and a reset of the footer de-duplication, which
  is keyed by workflow id. Archiving and planning anew is simpler and
  keeps terminal states absorbing.
- **Detect the merge automatically at Stop or in `/orchestrator:next`.**
  Puts a network call and `gh` into hooks. It can be added later on top
  of this decision.
