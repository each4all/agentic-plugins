# `/orchestrator:autopilot`: what a run does, by what you see

`commands/autopilot.md` holds what a session does to preview, start, watch and
report a run. This file holds what the run and each subcommand do in detail.
Showing or reporting the CLI's output as printed needs none of it: read a
section when the owner asks what the state its heading names means or what
resolves it, or before you advise on one.
Claude Code only (ADR-0063 D9).

| What you see, or are asked | Section |
|---|---|
| A halt (exit 2), `halt.json`, a conflict gate's proposal | § Halts |
| `◆ landing-ready`, `◆ landing-sync`, `◆ landing-unknown`, a branch waiting to land | § Landing |
| A run with `--lanes`: a lane parked, picked up again, or left when the run ended | § Lanes |
| A step that ended with next step `verify`, or `--next verify` | § Verification |
| `stop`, or a run whose driver died | § stop |
| `release`, `hold`, `writer-clear` | § Holds, releases and writer-clear |
| `instruct` | § instruct |
| `status --macro <id>` | § status |
| A `stall` line, or a choice of `--stall-detector` | § The stall detector |

---

## Halts

Each step (`/orchestrator:next`, `/engineer:<verb>`, `/engineer:commit`,
`/orchestrator:done`, `/orchestrator:finalize`) runs as one command in a fresh
`claude -p` worker, so every step starts from durable state and no context
carries over. The driver decides the next step from that state alone (closed
enums: `next_step`, `awaiting_owner`, `plan_approval`, next-ready, the landing
check) and **halts** wherever the owner has to judge: a plan that is not
approved, an owner gate, a next step below HIGH confidence, a subtask waiting
for its pull request to merge (`awaiting-landing`), a step that changed
nothing. A halt prints the reason, writes `halt.json` in the run's ledger
(`.agentic-plugins/runs/autopilot/<run-id>/`) and exits 2; there is no plugin
notification (`--notify-local` adds one local macOS notification). A halt on
a conflict gate (`decide-conflict`, `peer-conflict`, or `plan-conflict` under
`plan-unapproved`) carries its proposal in `halt.json`'s `proposals`: the
bounded consensus round to run before the owner decides, with its task file
(ADR-0067 Decision 8). The driver never runs it.

---

## Landing

The driver never pushes, opens or merges a pull request. Landing is the
owner's. Once a subtask is committed, the run reports it and goes on with any
other ready subtask (ADR-0067 Decision 7): a `◆ landing-ready` line (or one
of the two below), a record in the run's ledger, and a line appended to
`.agentic-plugins/runs/autopilot/landing/<macro-id>.jsonl` under the main
worktree, which a watcher can tail across relaunches. Each names the branch,
its commit, the push and pull-request commands, a read-only overlap check
(`git merge-tree`) against the integration branch and every other branch
waiting to land, and an advisory merge order. The check runs in a scratch
repository that borrows only the objects, so no merge driver, config or
attribute of the checkout applies: its answer is git's own merge of the two
commits. Each also says whether the branch is ready to land: only when it
contains the integration branch's tip as the run fetched it, so the CI its push
runs checks the tree that lands. A branch behind it, another lane's landing for
instance, is reported `◆ landing-sync` with the commands that merge the tip in
and push; one whose freshness could not be told (a failed fetch, a shallow
clone) is `◆ landing-unknown`, and neither is ready. Every record keeps the
event name `landing-ready`: read its `ready` field to tell. A branch is reported
again when its commit, the tip or its readiness changes, not while what it
reports stays the latest record, and a commit that no run reported is reported
when the next run starts. However a run with lanes ends, it lists each lane
still waiting with its readiness in its lane report and in `status`:
`unknown` when its last look failed or could not read it, or when the run ended
without that look (interrupted, or stopped by an error). A serial run's halt
lists each waiting branch the same way, whatever its reason, and an
`awaiting-landing` halt does too: what waits as the run ended, so a branch that
landed meanwhile is not listed. After the merge, relaunch, and it records the
landing with `/orchestrator:done` and goes on (ADR-0062, D3a).

---

## Lanes

With `--lanes N` (2 or more; the owner's default is 2, and a larger N
spends the rate limit faster) the run drives up to N subtasks at once, each in
its own git worktree beside the repository, with `/orchestrator:done` and
`/orchestrator:finalize` in the checkout the run starts from (ADR-0067
Decision 6). Run it from a checkout no one works in: work there halts the run
at its next done. A new lane waits while the rate limit's five-hour window is
at 0.85 or more, or refused. Lanes need shared creation on
(`docs/runbooks/state-root-cutover.md`); `preview --lanes 2` shows the lanes it
would reconcile and the first steps. A halt prints the relaunch command with
the run's `--macro` and `--lanes`. With more than one subtask in progress,
`--next` needs `--lane <subtask>` before it (one pair per lane).

**A lane parked.** A halt in one lane (its gate, a judgment, a step
or a creation of that lane that failed) **parks that lane only** (ADR-0068
Decision 1): it starts nothing more, and the other lanes go on. The park is
kept in the macro's records (`.agentic-plugins/runs/autopilot/holds/<macro-id>/parks/`),
so a relaunch parks the lane again at once while its record is unchanged, and a
step that wrote nothing is never retried on that record. The lane is picked up
again, within about a minute while the run lives or at the next relaunch, once
its record changes (the owner clears its gate, records a next step, settles a
pending peer ensemble, commits or moves its branch) or once the owner releases
it with `release <subtask> --macro <id>`, with or without a live run; its lane
is reconciled again first, as at a run's start. A lane the owner holds, or
whose release was rejected, is not picked up by a change of its record: its
`release --hold`, or a new hold and release, gives it back. No worker spawns into a lane
while a persona operation is open there (ADR-0068 Decision 2, item 7): the
child's operation entries and the macro's operation records, read fresh, so a
gate resolution (its clear, then its next step) finishes first, however long
it writes nothing.

**The run ended.** A run-wide halt (version drift, an
exhausted budget, a plan change that revokes the approval, a gate on the macro,
a halt that names no lane, the baseline or the rollback fence, the driver's
own done or finalize, a worker group that outlived SIGKILL) lets the steps in
flight finish, then reports every lane and exits 2. The run also ends, exit 2,
once nothing runs and nothing can start: every remaining lane parked, held,
waiting to land, or behind one of those; `halt.json` names the first lane
still parked (after a run-wide halt), or the first held lane when only held
lanes are left, lists the others under `also`, and gives each lane's state
and what resolves it (a held lane's release command), and `status` shows each
parked lane's reason and since when. A release after the run has ended starts
nothing: relaunch. A serial run does not start beside a kept park: release
it, or run with lanes. Ctrl-C, `stop` or a closed terminal
(SIGINT, SIGTERM, SIGHUP) ends it at once instead: a lane's creation or removal,
or a peer run's cancellation, already under way gets 15 s to finish, the workers
and everything else in flight are stopped, and the lanes are kept for the next
run.

---

## Verification

A run offers verification when the pinned engineer has the record CLI and the
repository's committed `.agentic-plugins/verify-checks.json` parses at the
run's baseline: a step that ends with next step `verify` then has its checks
run by the driver, with no worker and no cost, and `--next verify` reruns a
request once past the repeat rule (ADR-0068 Decision 5; the README's
*Verification batches*). A request below HIGH halts `low-confidence` before
anything runs; the owner's `--next verify` on it authorizes that request's
checks and the resume of its requesting verb, so after a batch that fails or
gives no evidence the verb resumes with no second `--next` (the authorization
ends when the request is replaced, answered or set aside, and a new request, an
instruction or another lane never inherits it), while a pass's `on_pass` keeps
its own confidence (ADR-0068 implementation note 2026-11-03).

---

## stop

`stop` sends SIGTERM to the run driving a macro, which records an
`interrupted` halt. When that run's driver has died, `stop` ends the worker's
processes itself, then cleans up after the run (ADR-0067 Decision 6): it
cancels the pending peer runs that name it, counts its unfinished step as
spent, and records the `interrupted` halt. The next run of the macro does the
same before its first step. What it cannot finish (a peer it could not cancel,
a peer-run home it could not read, a ledger that is gone) it prints, keeps, and
makes `stop` exit 1, as does a run any part of which still runs.

---

## Holds, releases and writer-clear

- `release <subtask> --macro <id>` ends that subtask's kept park (ADR-0068
  Decision 1, item 4): a live run picks the lane up at its next tick, the next
  run judges it afresh. It refuses inside an autopilot worker, a subtask with
  no kept park, and a step a live run has under way. A park whose cause lies
  outside the lane's record (another worktree holds its branch, another session
  holds its lock) waits for this release. A park whose record cannot be read
  is never deleted by it: `release <subtask> --macro <id> --discard-unreadable`
  keeps a copy and ends it. It refuses on a held lane, and on a lane whose
  release the driver has not compared yet or rejected.
- `hold <subtask> --macro <id>` holds a lane for a person (ADR-0068 Decision
  2): the driver leaves the subtask alone (no dispatch, adoption,
  reconciliation, step or removal) while other lanes go on. The hold is
  *pending* until nothing of the lane is in flight and no persona operation is
  open there, then *held*, its lane fenced in its worktree lock; start once
  the hold's own line in `status --macro <id>` says held (the run's lane table
  shows the lane held from the moment the hold is set). Work the lane's active
  child: the engineer refuses to begin an unlinked workflow in a held lane. A
  step already running is never aborted: it runs to its end first. `hold`
  prints the hold id, the lane, its last session (`claude --resume <id>`) and
  the engineer the person needs. It refuses beside a live run that does not
  honour holds (a serial run: `stop` it), a completed subtask, an owner record
  it cannot read, and until the hold-aware engineer is installed on both hosts
  and pinned by the launcher.
- `release <subtask> --macro <id> --hold <hold id>` gives a held lane back:
  it refuses while a persona operation is open there, a peer ensemble is
  pending or the child's workflow is locked. Stop editing and close the
  session first: the driver compares the lane once before it steps, and an
  edit after the release still there at the comparison rejects it (the lane
  parks until a new hold and release); one after the comparison is not seen.
  A pending hold is withdrawn, with nothing to compare.
- `writer-clear <subtask> --macro <id> --operation <operation id>` is the
  owner's word that the session of an operation stopped by an error is gone:
  the operation no longer keeps the lane.
- Holds, releases, instructions and writer-clear refuse inside an autopilot
  worker. Rolling the orchestrator back below the release that added holds
  while a hold exists is unsupported: a hold on a subtask with no lane has no
  fence an older driver would respect.

---

## instruct

`instruct <subtask> --macro <id> --note-file <path> [--next "<step>"]` is
the owner's instruction to a lane, with or without a live run (ADR-0068
Decision 7): a note, and at most one next step (`/engineer:<verb>` or
`/engineer:commit`, never a dispatch). The note never crosses as a word of the
command (ADR-0059), and it is never printed. It is applied at the lane's next
step boundary, never mid-step: the note appended to the child as a phase note
naming the instruction, the step recorded at HIGH in place of the child's. A
step in flight runs to its end first, a started verification batch ends first,
a held lane waits for its release's comparison, an owner gate is never cleared
(a gate set after the instruction supersedes its step and keeps its note), and
an interrupted commit runs again. A run with lanes applies it within its poll;
a serial run at its next look; with no run live the command applies it itself
when the lane is at a boundary, and the next run otherwise. Several pending at
one boundary apply together, every note in order, the last step winning.
`--revises <id>:<revision>` replaces a pending one in its place, and
`--withdraw <id>` withdraws it; an applied one is final. It refuses inside
an autopilot worker, a malformed step, a subtask not in the plan or closed,
one whose child has archived, a step before the dispatch (a note waits for
it) and a step for a child whose owner gate is set. It prints the
instruction's id and state, and beside a live run that does not apply
instructions (`instructions-1`) it says the instruction waits for one that
does. A relaunch's `--next` for a lane with a pending instruction that
carries a step is refused, naming it.

---

## status

`status` reads the latest run's ledger. `status --macro <id>` adds the macro's
holds and instructions (each with its state and what became of it, never its
note), from any checkout, with or without a run, with each hold's state, what
blocks its handoff, its open operations and the release command; with no live
run it completes a pending handoff and repairs a fence an older orchestrator
removed.

---

## The stall detector

Every step is judged `active`, `stalled` or `unknown` while it runs
(ADR-0068 Decision 3): stalled when, for its last 10 minutes, its stream
carried nothing but heartbeats and hook events and its descendants used under
1 s of CPU, every 10 s sample of the process table known. A sample that fails,
is slow, coarse or late, or cannot read a process, is unknown, never zero.

- `--stall-detector log`, the default, records and never acts: each verdict
  change is a `stall` line in the run's `steps.jsonl` and a `stall` event,
  and each step's `finished` line carries a summary (its longest quiet gap,
  its lowest known 10-minute CPU window, the time spent unknown, the count of
  each verdict, the longest gap while an answer of the model was owed, and the
  wait at each stalled verdict). The step clock stays the stop: 3600 s, or
  `--step-timeout`.
- **The observation configuration:** `--stall-detector log --step-timeout
  10800` (or more), so the long legitimate quiet waits are observed rather
  than cut at 60 minutes. `status` prints each step's summary.
- `--stall-detector on` is the owner's switch, after the review Decision 3,
  item 8 names (enough judged quiet waits, Codex peer waits among them, no
  false positive, the model's longest owed gap well under 10 minutes): a
  stalled step is aborted as a timed-out one is, halts `worker-failed` with
  a detail naming the stall and the wait, and parks its lane (a stalled
  `done` or `finalize` stays the run's); `unknown` never aborts. With it on,
  the step clock's default is the emergency cap, 28800 s; an explicit
  `--step-timeout` still wins.
