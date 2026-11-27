# ADR-0068 history: Autopilot lanes that keep going

This file is the record: amendments, implementation notes, the cases each
slice left to its implementation, the slices' amendment cascades and
superseded text of [ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
each as it was written. The ADR states the current decision (ADR-0070).

## Left to the implementation

The guarantees above are the decision; how they are met is the
implementation's, proved by its tests. Each case below must be tested; most
are defects the reviews of this slice found in earlier, more detailed
drafts.

**`impl-lane-gate`** (Decision 1):
- The kept park's record (fields, file, a fingerprint version) and where it
  is written relative to the step's `finished` event
  (`scheduler.mjs:773`, `:797`), or how a relaunch rebuilds it from the
  durable failure record. Test: kill the driver between a failed step's end
  and the park; the relaunch does not dispatch the lane.
- The moment the park's fingerprint is taken: after the step's peer runs are
  settled, or compared without them, as the no-progress check already
  compares (`withoutPeers`, `policy.mjs:1208-1211`).
- A fingerprint version change between runs. Test: a kept park whose
  version differs stays parked; a release compared across versions parks
  its lane for a new hold and release.
- The per-lane entry point into reconciliation's preparation and rows,
  planned from the whole macro's facts.
- `claimProblem` returning every problem with its subtask; scoping each
  `decideLanesStep` halt by cause; the run's-footing checks run-wide in
  `createLane` and at a prepared dispatch as in the preparation. Test: a
  baseline fetch failing inside a creation drains, and keeps no park.
- The wake sources and their digest (the holds lock's own directory, and
  the driver's own records, must not wake the run on its own activity); a
  bare release that ends a kept park wakes the live run. Test: a bare
  release between the run's last consumption and its end is not lost; the
  next run judges the lane afresh.
- A lane whose gate the owner is resolving: the poll may wake between the
  resolution's clear and its `finish-verb`. Test: the driver does not spawn
  a worker into a lane with a persona operation open.
- `halt.json`'s lane-state vocabulary (the entries already carry a
  free-text `state`, `scheduler.mjs:450`, which it replaces), a park the
  owner resolved while the run lived (in `lanes.jsonl` only), and the
  `status` columns.

**`impl-hold`** (Decision 2):
- The records' schemas, file names (a subtask id admits `.`,
  `policy.mjs:60`, so each record kind has its own subdirectory), atomic
  writes, the holds lock (the run locks' `acquireLock`,
  `run-locks.mjs:323-375`, with a short retry) and an order between it and
  the worktree and workflow locks that cannot deadlock.
- The handoff's order (re-read the record, judge the lane's lock entries
  and open operations, write the fence, recheck as an admission rechecks,
  `run-locks.mjs:542-555`, acknowledge), and every crash point in it. Tests:
  a release between acknowledgement and fence; a retried handoff that finds
  its own fence; a handoff beside an admission that writes between its two
  looks; the ack file discarded after the handoff.
- The fence entry: an admission entry, named as a session's
  (`run-locks.mjs:89-90`, any other name is not read as an entry,
  `run-locks.mjs:241`), live until removed (`run-locks.mjs:250-254`), whose
  `admission release` and `describeAdmission` print `release` instead
  (`run-locks.mjs:496-507`).
- *Live* and *busy*: a run is live while its driver lives; a lane is busy
  while a worker or worker group its run recorded for that subtask lives
  (`holderAlive`, `run-locks.mjs:190-201`). Every task that touches a lane
  records the subtask it acts for, whatever checkout it runs in
  (`scheduler.mjs:398-415`, `:555`, `:815-820`); a surviving group that
  names none makes every lane of its run busy.
- A run's end: last handoffs, `halt.json`, and the removal of its lock
  entries in an order that lets a `hold` after it find no live run and none
  of its entries (today the reverse order of taking, `driver.mjs:547-550`).
  The end of a run whose holds directory or lock cannot be read.
- How the persona keeps its open operations visible: an operation id
  carried from its first write to its last (a dispatched engineer
  continuing `next`'s dispatch); operations that overlap before the macro
  has a holds directory, each tracked until its own last write; an
  operation that met no directory registering before its work; a commit's
  archive and parent writeback as its continuation; the wire encoding of
  the new field, which older readers must accept (`state.mjs:1895`,
  `:1932`). Tests: two operations overlapping before the directory appears;
  a cleared verb's delayed `finish-verb` beside a later verb; a commit
  whose archive gates fail; a worker that died mid-verb under an older
  driver, then the directory created.
- The inventory of every command that writes a macro's child (Decision 2,
  item 7), each classified. Test: the Stop orphan sweep fired from another
  lane's session in a held lane.
- `/orchestrator:next`'s check and the mark it holds until its engineer's
  first write; the path that ends before the engineer took it over.
- The content digest: `git write-tree` through a temporary index (seeded
  from a copy of the real one), recursion into checked-out submodules, an
  uninitialized submodule by its commit, and the workflow's frontmatter
  parsed without the snapshot fields (`state.mjs:2862-2870`; the snapshot
  re-serializes it, `state.mjs:2847`; the Stop hook snapshots at every turn
  end, `stop-archive.mjs:153-165`, and the PreCompact hook before a
  compaction, `persona-pipeline/files/adapters/claude/hooks/pre-compact.mjs:38-43`).
  Test: a `release` typed in the lane's own session does not mismatch.
- Release identity and consumption: a release id consumed once, a crash
  between consumption and the end of the kept park, a new hold keeping an
  uncompared release, and a discard that loses a rejection.
- Discard, orphaning, retirement and their crash points; `done` beside a
  released record (test: a lane held, committed, released, then recorded
  done with no run live completes, never parks); abort and finalize beside
  holds.
- The rollout token, `run.json`'s capability, and repair of a fence an
  older orchestrator removed.
- The prototype of Decision 2, item 10.

## Amendments

Each place below keeps its text and gets a dated note (2026-10-19) that
points here. The notes took effect when this ADR was accepted (2026-10-20).
- **ADR-0063:** Status; R2 ("Nothing starts after the halt"; with lanes a
  lane halt parks its lane); D4's halt table (the scope of each reason with
  lanes) and its Lanes (W2) paragraph (a lane halt parks its lane; the
  run-wide list drains); D6's `next_step` (every persona operation of a
  macro's child stays visible to a release); D8's macro-scoped files (the
  holds directory beside the lock) and its halt signal (when the run ends;
  `halt.json` lane states); the S3+S4 note on `finish-verb` (non-terminal in
  a held or parked lane, or while a run of the macro is live).
- **ADR-0067:** Status; Decision 4, item 5 (admission unchanged; a hold's
  entry in the lane's worktree lock); Decision 5's Creation and Removal (not
  for a held subtask), and its Reconciliation (also run mid-run for one
  parked lane; holds and kept parks read first at a run's start) and its
  rows (a held subtask is passed by); Decision 6's lanes capability floor (a
  token for the hold-aware engineer, recorded in `run.json`), Drain (W2)
  (lane halts park), Throttle (a lane resumed after a park or a hold is
  gated as a new lane) and Forced resume (another lane's persisting halt
  parks that lane; a forced step on a held lane is refused); Out of scope,
  interactive lanes (the takeover is taken up here, record-based messages
  at step boundaries by slices 2 and 4; `--parallel` stays out).

Not amended: ADR-0062 (landing), ADR-0019 (dispatch linkage), the companion
contract.

## Later slices

Slices 2 to 4 add their decisions to this ADR and use two seams from this
slice: the wake sources (Decision 1, item 6) and the hold records (Decision
2). Each adds its own Consequences and Alternatives under its own heading.
- **Slice 2:** stall detection, and the driver's event file that the main
  session watches with the Monitor tool. Slice 2 decides their parameters.
  *2026-10-19:* Decisions 3 and 4 below.
- **Slice 3:** the verification step the driver runs without an LLM, and
  one heavy-work lock shared with the mutation harness and interactive
  sessions. *2026-10-20:* Decisions 5 and 6 below.
- **Slice 4:** main-to-lane instructions read at the next step boundary, and
  rebinding a dispatched subtask after an owner-approved instruction change
  (C147). *2026-10-20:* Decisions 7 and 8 below.

## Left to the implementation (slice 2)

As for slice 1: the guarantees above are the decision, each case below must
be tested, and each new test must be shown to bite by a mutation that it
kills. The parsers, the sampler's organization and the file lock are the
implementation's.

**`impl-events`** (Decision 4):
- The writer: the file's lock, the torn-line rule, how the next `seq` is
  chosen so that no identity repeats (a seq the writer used, its write
  failed or not, and every parseable line of its run), a failed write
  counted in `run.json`, `run-ended` at most once. Tests: a driver killed
  mid-line, then a cleanup: the cleanup's `run-ended` takes a new identity,
  and a torn line holding complete JSON is not duplicated; a write that
  failed before any byte landed, then a success: no identity repeats; a
  cleanup retried after it wrote `run-ended` writes no second one; a dead
  run's cleanup finishing after the next run began, its line among the new
  run's.
- Each kind written once, where its record is written (a park beside its
  `lanes.jsonl` line, a `commit-finished` beside its landing report), with
  the documented fields only, pointing at records that exist when it is
  written (a mid-run `halt` at `run.json`, a completed run's `run-ended` at
  `run.json`, a halted one's at `halt.json`). Tests: no field carries text
  from a worker report, a peer or a halt's `detail`; a launch refused at its
  locks writes no line and is never reported missing its terminal event.
- The reader: replay after a cursor, follow across a relaunch, interleaved
  runs, a partial last line held, a gap, an unparsable line, a missing
  terminal event (a failed last write, a dead uncleaned run, a verb-chain
  run, whose startup cleans no dead runs, `driver.mjs:662`), a cursor `R:0`
  of a run with no line yet, a file not yet created, a cursor naming a
  `seq` not on file, a file that cannot be read, a backlog over the volume
  bound. Tests: replay from a recorded position across a relaunch neither
  loses nor repeats an event; a re-arm from a `reader-summary`'s cursor
  neither repeats nor skips; a run whose every write failed, then the next
  run's lines: a watch armed at its `R:0` reports its terminal missing and
  delivers the next run's lines; `R:0` and a missing file wait, and a `seq` not
  on file exits non-zero with a `reader-error` line; a backlog folds only
  `stall` lines.
- The recipe's pattern tested against every kind marked terminal and every
  `reader-` kind; the path printed at start; `--notify-local` unchanged.

**`impl-stall`** (Decision 3):
- The stream clock: heartbeats and hook events excluded, every other event
  counted, the wait's facts kept (the step's prompt owes an answer before
  any event arrives).
- The process probe for each platform (fixture tables and `/proc` trees),
  identity by pid and start time, sticky membership, growth per identity,
  the worker process excluded. Tests: pid reuse; a descendant reparented
  after its parent exits; a short process seen once, and one never seen; a
  process that exits between the listing and its read; a macOS table read
  under a non-C locale; a line that does not parse.
- Unknown: a failed, slow, coarse or late sample, a live member that cannot
  be read, a suspend. Tests: a missing sample never yields `stalled`; a
  suspend longer than an interval between two samples an interval apart on
  the monotonic clock is `unknown`, and a shorter one changes no verdict; a
  backward or sub-interval wall-clock step within a window
  changes no verdict, and a larger forward step turns it `unknown`, never
  `stalled`.
- The watch's end. Test: a worker that ignores an idle close of stdin is
  judged until it exits.
- Log-only: the `stall` lines, the `finished` summary, the events, and the
  step never stopped; the step clock and every halt unchanged. Tests: the
  measured shapes as fakes (a mutation run and a Codex wait, quiet but busy;
  a foreground wait on nothing with heartbeats; a background sleep; a
  polling loop of short processes; a missing sample).
- `--stall-detector on` as a documented option, off by default, with the
  abort, its charge, the halt detail, the scope of item 8 and the
  emergency-cap default behind it. Tests: with it on, a stalled step ends
  `worker-failed` and parks its lane, a stalled `done` drains, and an
  `unknown` one runs to its cap.

## Amendments (slice 2)

Each place below keeps its text and gets a dated note (2026-10-19) that
points here. The notes took effect when this ADR was accepted (2026-10-20).
- **ADR-0063:** Status; D1's Bounded property (the stall rule, then the
  emergency cap, bound a step once the owner switches the detector on);
  D4's proceed rule 6 (a step's own bound is the same); D5's session hosting
  (the stall abort beside the timeout, outranking a close on a finished
  report as every abort does, with the detector stopping at that close);
  D8's halt signal (the event file beside
  terminal output, `halt.json` and `--notify-local`); Q5 (the event file is
  no plugin notification).
- **ADR-0067:** Status; Decision 6's Budgets (the reservation's
  `timeoutSec` is the emergency cap once the detector is on); Decision 8,
  item 5 (the event file's lines carry no proposal text; a halted run's
  `run-ended` points at the halt record that does).

## Left to the implementation (slice 3)

As for slices 1 and 2: the guarantees above are the decision, each case
below must be tested, and each new test must be shown to bite by a mutation
that it kills.

**`verify-record-cli`** (Decision 5, items 2, 5 to 7, 10, 11):
- The request's and the results' fields and encodings, the outcomes and
  which of them are evidence, when each is written, the bounds (failing test
  names, log paths), the identity of "the same checks" (the commands as the
  declaration resolves them, the driver's additions included), and the wire
  form of the new kind. Tests: a request whose argument is not a path in the
  tree, or not in its alphabet, or begins with `-`, is refused at the write;
  `finish-verb --next-step-kind verify` outside a run that offers
  verification is refused, and a persona that is not offered verification
  never writes it; results of another request or tree are never read as this
  one's; recording results changes the lane child's fingerprint; a verb
  that replaces the request leaves the old results unread.
- The orchestrator's explicit refusal of `verify`, in the policy and in the
  interactive commands that read a child's next step, and its dead-run
  cleanup accounting a batch as no step and no cost. Test: an orchestrator
  of this release cleaning up after a newer driver's batch.

**`verify-select`** (Decision 5, item 4):
- The rules and their spellings, the test discovery they read, the import
  graph, the pipeline map between sources and generated copies, renames and
  deletions, the whole-suite fallback, and the declaration's mappings.
  Tests: the C150 change selects
  `tests/plugin-shape/test-engineer-autopilot-runbooks.mjs` through a path it
  builds, with the comment that names the source removed; a change to a
  persona's `persona.json` selects the tests that read it through
  `tests/persona-pipeline/_personas.mjs`, though another test names it; a
  test that imports a helper naming the file is selected; a file no rule
  matches selects the whole suite; an untracked file, a renamed file by both
  paths, a deleted file by its old path, a generated copy for its source and
  the reverse; the worker's checks are kept. The backtest set and its
  replay.

**`impl-heavy-lock`** (Decision 6):
- One protocol shared by the harness, the wrapper and the driver: the
  record, its creation, the proof and how it passes, release, stale
  judgment and the reap guard, and where its code lives so that the driver
  needs nothing from this repository's `scripts/`. Tests: an older harness
  and a new holder exclude each other; `npm run mutate` under a holder runs
  without waiting on it, and a process with a wrong proof waits; SIGKILL to a
  holder: no holder of this release starts while a process of its ownership
  runs, and the window an older harness has (its supervisor's delay) is
  measured and stated; an orderly end with a descendant that left the group:
  the descendant's survival is measured and stated, for an older harness and
  for this release; a holder's release while a joined process still runs is
  refused, and a joined acquirer's cancellation leaves the holder's other
  processes running; the wrapper refuses a command declared as locking itself, and an
  older harness started through a script under the wrapper waits naming its
  holder; a record that does not parse is reaped, and a holder on another
  host never is; a driver started under the wrapper refuses to start.
- The wrapper's signals, exit code and waiting report.

**`verify-exec`** (Decision 5, items 1, 3, 6 to 10; Decision 6, items 5 and 7):
- Reading the declaration from the baseline commit; the capability probe and
  the offer in `run.json`; the order of a batch's checks (the worker's and
  the driver's additions, no mutation check before the tests); the batch
  queue across lanes; the environment scrub; the check's record as a worker
  group of its lane; timeouts, `stop` and the driver's signal; the digest
  before and after; the step ledger line and `status`; the owner's explicit
  rerun. Tests:
  - the declaration: a worker that edits it in its lane widens nothing; a
    check whose command is not declared is refused, never run;
  - order and stops: a batch runs its checks in the stated order and stops
    at the first that does not pass, the rest not run; a request below
    `HIGH` halts `low-confidence` and runs nothing;
  - offer: a persona without the capability, or a repository without a
    declaration, is not offered verification, and its workers check in
    their steps;
  - binding and recovery: a driver killed after a check ended and before its
    result reruns that check; a batch cut short resumes from its first check
    that did not pass, the one interrupted included; a driver killed after a recorded failure resumes the
    verb and runs no later check; a tree edited during a batch gives no
    evidence; a passing batch dispatches `on_pass` on its unchanged tree
    without a `no-progress` halt and without counting a step; a tree
    changed after a passing batch and before `on_pass` resumes the verb; an
    edit under a hold followed by a release reruns the request on the edited
    tree; a relaunch with a changed declaration reruns the request whole;
  - repeats: a request repeated on an unchanged tree after a pass or a
    failure halts `no-progress` and runs nothing; one repeated after a batch
    whose first check passed and second timed out runs whole; the owner's
    explicit rerun reruns an answered request once;
  - processes: the scrubbed environment lacks the admission token and the
    autopilot flag; a driver killed while a check runs, and while it waits
    for the lock, leaves the lane busy for the handoff, `stop`, dead-run
    cleanup and admission until the group ends; a check group that outlives
    SIGKILL halts the run with its locks kept;
  - bounds: each of the 4-hour, 6-hour and 8-hour bounds ends what it bounds
    with no evidence; a batch is not judged by the stall detector; a check
    that locks itself and waits inside its command ends at its own timeout;
  - capacity and drain: a batch charges no cost and holds no worker slot;
    batches of two lanes run one at a time in request order; a hold arriving
    between two checks stops the batch before the second, and one arriving
    during the driver's lock wait ends the wait; a hold's handoff waits for a
    running check, while a queued request in a held lane neither blocks the
    handoff nor keeps the run from ending; the last permitted worker step
    recording `verify`, and a budget exhausted while a request is queued:
    nothing starts, and the request survives for the relaunch;
  - records: a batch adds no event kind, and no failing test name or log
    text reaches the main session or the event file; a run that does not
    offer verification halts run-wide on a `verify` child, and a relaunch
    that offers it goes on with no release; no holder of the heavy-work lock
    waits on a run lock.

**`verify-runbooks`** (Decision 5, item 1): the persona runbooks hand long
checks to `verify` when the run offers it, and read the results when they
resume. Tests: under a run that offers verification, no runbook block runs
the whole suite or a mutation run in a step.

## Amendments (slice 3)

Each place below keeps its text and gets a dated note (2026-10-20) that
points here. The notes took effect when this ADR was accepted (2026-10-20).
- **ADR-0063:** Status; D1's effect domain (the driver runs declared checks
  as argv arrays in the lane, child-only); D3's step model (a verification
  step runs no `claude` process); D4's `no-progress` trigger (a repeated
  request on an unchanged tree after all its checks passed or one failed; a batch's results count as
  progress for the step it dispatches); D5's worker contract (in a run that offers
  verification, a worker hands long checks to the driver and never waits for
  the heavy-work lock in its step); D8's Lock bullet (the heavy-work lock
  beside the run locks, and its order with them).
- **ADR-0067:** Status; Decision 6's opening (`--lanes N` counts workers; the
  driver runs verification batches one at a time beside them), its claim that
  the cap bounds "a full test run each" (the heavy-work lock serializes those
  runs), its Locks bullet (the heavy-work lock), §Out of scope (the
  heavy-job lock is taken up here), and cascade item 7c (its Lock text is
  ADR-0063 D8's, which carries the note).

## Left to the implementation (slice 4)

As for slices 1 to 3: the guarantees above are the decision, each case below
must be tested, and each new test must be shown to bite by a mutation that it
kills.

**`impl-instruct`** (Decision 7):
- The record: its location beside the holds and its lock, id and revision,
  where the note is kept and its bounds (size, encoding), its states and
  their transitions, and the wake source's digest; the command and its
  refusals; the application as one persona operation through `append`,
  carrying the instruction's id so that a crash between the child's write
  and the acknowledgement is recognized; the event kind, `lanes.jsonl`,
  `status`, `halt.json` and `run.json`; retirement by `/orchestrator:done`
  and the macro's end. Tests:
  - to an idle lane, and to a parked lane (applied within the poll, the lane
    reconsidered); to a lane mid-step: applied after the step, surviving its
    `finish-verb`; to a subtask before its dispatch: the note reaches the
    child after the dispatch step, and a next step is refused;
  - beside verification: a started batch keeps the lane between its checks
    and while it waits for the heavy-work lock, its results stay, and the
    instruction's step replaces `on_pass`; a queued request, and what is
    left of a batch a hold cut short, is replaced by a step and runs under a
    note alone;
  - a held lane: applied after the release's comparison, never before it;
    the `instruct` command with no run live leaves a released lane whose
    release awaits its comparison as it is, and the next run compares the
    release before it applies the instruction;
  - an interrupted commit: the instruction's step is not taken, the commit
    runs again, and its archive drops the instruction (its gate supersedes
    the step);
  - a forced step: refused beside a pending instruction with a step, taken
    beside one with a note only; an instruction written while a live run
    carries an untaken forced step for the lane applied after that step;
    an instruction written after a gate's resolution applied as any;
  - gates: a next step for a gated child refused at the write; a gate set
    after an instruction drops its step, keeps its note, and the lane parks
    on the gate; a gate set and resolved before the boundary: the step
    still dropped and the resolution's step followed, a verification
    request at that boundary included;
  - several pending at one boundary: every note in order, the last step
    wins; a revision of a superseded revision refused; a withdrawal; an
    applied instruction not revised; the driver dies after applying one
    and before spawning its step, a second is written, and the relaunch
    applies it: `status` shows the first one's step never ran;
  - drops: the child archives first, the branch changes, `done` completes
    the subtask; none applied to another child;
  - refusals: a malformed step; a caller that is a worker; a forced step
    beside a pending instruction that carries a next step; a draining run
    applies nothing; a crash
    between the child's write and the acknowledgement applies once;
  - a serial run, and the `instruct` command applying at a boundary with no
    run live (no event written); a persona whose operations are not
    visible: nothing applied, in every mode.

**`impl-rebind`** (Decision 8):
- Where the rebinding is kept (item 7), its fields, the approval's display
  and its binding to what it showed, the admission every approval that
  changes the plan joins, the note, the record of what the child was last
  told and how a delivery the approval did not finish is completed (item
  4), the comparison in every binding path, the audit in the macro's body,
  and refusal messages that name an approval's absent or stale rebinding.
  Tests:
  - an unfinished delivery: of a return to the dispatched fields (the
    ordinary comparison would accept it, so the child's next step waits for
    the note); after a delivered change, an approval of another subtask
    leaves that child bound and told; a completion that changes no plan
    field delivers only at a boundary;
  - a child that recorded no verb, profile or topic: a change of those
    fields neither refused nor rebound, and shown so at the approval;
  - C147 reproduced: an in-progress subtask's topic revised and approved,
    the work landed, `/orchestrator:done` accepted; and for an archived
    child, with the approval given after its commit;
  - an unapproved revision, a stale approval (a `plan-set` after it) and a
    child the approval did not name refused `dispatch-changed`;
  - repeated approved revisions: only the latest binds; A to B to C delivers
    each change; A to B and back to A needs no rebinding but delivers the
    return to A;
  - a changed branch, verb or id refused at every binding that compares it
    (a verb only where the child recorded one), and shown so at the
    approval;
  - the approval refused beside a live run, beside an admitted interactive
    `/orchestrator:next` whose subtask is not yet recorded in progress, and
    while a persona operation is open in the lane, the subtask is held, or
    its release waits for its comparison; a `plan-set` and an approval
    between two looks: the approval refused, the run halts
    `plan-unapproved` and drains; an approval from an older orchestrator on
    the other host, stated as the narrowing it is;
  - a child whose state changes between the display and the approval refuses
    the approval; a crash between the macro's record and the child's note
    leaves the child unbound until it is told;
  - a child last told other words, with no note pending, is not stepped by a
    serial run or a run with lanes, and the detail names the binding writes'
    way out; approving the plan as it stands tells it, and the next run
    steps it; so for the child a run selects for a subtask that records no
    owner, with the owner's record first while several workflows claim it,
    and a recorded owner is asked before the selected child;
  - the engineer's terminal note, a re-attach by `/orchestrator:next` and
    the owner's explicit `subtask-update --expect-dispatch` honor a
    rebinding; the rebinding is recorded in the macro's body;
  - a macro file holding a rebinding stays readable by the release before
    this one, or that release is shown to be required on both hosts first.

**Handed on from slice 3.** Where the instructions tell sessions to use the
heavy-work wrapper (Decision 6, item 4) is guidance, not an instruction in
Decision 7's sense: it goes with the wrapper to `impl-heavy-lock`, which
states it in the repository's guidance (AGENTS.md, §Build / test / CI) and the
persona runbooks that run a suite outside `verify`.

## Amendments (slice 4)

Each place below keeps its text and gets a dated note (2026-10-20) that
points here. The notes took effect when this ADR was accepted (2026-10-20).
- **ADR-0063:** Status; the S6 note (an approval that changes the plan
  joins the run locks, and records the rebindings of in-progress
  subtasks); and the S8 note's forced-step rules (an instruction shares the
  grammar, without the dispatch, and the reach, except over an interrupted
  commit; a forced step beside a pending instruction with a step is
  refused).
- **ADR-0067:** Status; Decision 4, item 5 (`/orchestrator:approve` stays
  available, but an approval that changes the plan is an admission; the
  dispatch comparison accepts a rebinding under the current approval);
  Decision 6's Forced resume (refused beside a pending instruction with a
  step); §Out of scope, interactive lanes (main-to-lane messages are taken
  up; lane-to-lane notes stay out).

## Implementation note 2026-10-21 — verify-record-cli (Decision 5, item 7)

Written in place as a dated note at the end of Decision 5, item 7, where its
text still stands as the decision; recorded here as it read at the
migration (2026-11-17).

Note (2026-10-21, `verify-record-cli`): the rules above bind the batches
the driver's own ledger records. A record it does not hold (another
writer's batch, open or ended, a result, an end or a carried result) is no
evidence and is never taken up: the driver sets the request's whole record
aside in one write, `verify-batch-restart`, admitted only over the record
it read, and runs the request again whole. A restart is a set-aside, not a
take-up, so it never follows a batch the driver's ledger holds as passed or
failed. Each write a step makes under an autopilot run binds its attempt
to the handoff that write leaves (the next step, the phase, the active
verb, the terminal marker, the owner gate, the pending peer runs, the
request and its results) and to that handoff's generation, a count every
write of this release that changes the handoff moves on by one, in the one
function that turns a workflow record into its text. A later write of that
step is taken only while the record still holds that handoff at that
generation: any change since, by any writer (the driver's batch start,
restart or pass, an owner's or interactive session's write, a later step's
write that sets no next step, a writer that does not know the mark), makes
it stale, even a change undone since. Every write of a workflow is held to
the mark at its file lock, the one point every writer passes, whether or
not it changes the handoff and whatever it writes (a next step, a
checkpoint, a manifest entry, a snapshot, a marker, an archive, the review
ledger), so an earlier step or run is stale outright and no writer is
listed; a write beside the workflow (its review ledger, a consensus task
file, a move of either) moves the mark on as a write of the workflow would,
before it lands, so a failure or a kill between the two leaves the newer
step's mark, and a move of the ledger is made only while the lock is still
the step's; a workflow created under a run is admitted against the marks
of the workflows archived on its branch (each from a regular file opened
without blocking, as the workflows home's reader reads it, so a FIFO
there refuses the creation; a record whose first read opens an LF
frontmatter is read up to the close delimiter the parser takes, never a
line that merely opens with `---`, its body never read whole, and its
mark sought there (a frontmatter that never closes is read whole); one
whose first read opens none, a CRLF record or a note, is read whole from a
descriptor of its own and judged on that read alone, and while that read
still opens no LF frontmatter, a mark at any line start in it counts, with
its branch unknown, so the parse refuses it; a line starts after a newline
only, as the parser splits lines, never after a U+2028 or U+2029 a request
holds. Two limits of records the tool did not write are documented, not
fixed (the owner's ruling of 2026-10-25 on uncommon cases): such a
non-LF record holding a mark refuses every creation under a run, on every
branch, until it is removed or rewritten as the LF workflow file; a
record in UTF-16 is read as holding no mark; and a record edited to name
two branches is exempted by the first, which the parser does not keep),
so a
stale step recreates nothing a newer step archived, nor the step a mark
names once the handoff it left changed, and records the
creating step's mark in the same write, which commits only while the
creation still holds every creation lock it took (the repository's and
the written home's, with shared creation on and another home written),
checked at the commit as the lock token is; and an
archive moves the mark on in the active file before it publishes the
destination, and each of those two writes commits only while the source's
lock and bytes are still the ones the archive read, checked at the commit
as the lock token is, so one whose source lock was reclaimed, or whose
file changed since it read it, overwrites nothing, archives nothing and
deletes nothing (a reclaim between that check and the rename is the
window every locked write has). A
step's attempt is its run and its number: the driver numbers
every step it starts (`AGENTIC_AUTOPILOT_STEP`, its sequence number for the
step), whether or not the run offers verification, which also takes
`AGENTIC_AUTOPILOT_VERIFY`. A step starts at its first write, every verb's
Phase 0, so a step started after an owner's change of the handoff (a gate
cleared while the run is live) writes, and only the step before it is
stale; a note alone is outside the handoff and stales no step. A newer run's first write records its run in the mark, whether or
not it changes the handoff (the persona's `lib/verify.mjs` header). One
limit remains while the hosts run mixed releases, an earlier release: a
writer from a release before `verify-record-cli` moves no generation, so
an A to B and back to A in which such a writer takes part is not seen, and
the step's late write then lands on the state it left; and a driver from
such a release numbers no step, so its steps order runs only, and the
delayed write of one of its steps is not told from its run's next step
(one such step writes nothing beside a numbered step of its own run). The
limit ends once both hosts run this release. A workflow an interactive verb left with the terminal marker,
resumed into a non-terminal phase, records a request: the phase says
whether it is terminal, and the request turns the marker off.

## Implementation note 2026-10-25 — hold-persona (the hold protocol)

Decision 2, item 9 ships the persona's half of the holds before the
orchestrator's (`impl-hold`). The two halves meet only in files, so this note
fixes the files both read and write, and the order of their writes, before
either ships. It adds no guarantee: each rule below implements one of
Decision 2's, and a case it does not settle goes to the owner, not into this
note. The fixtures under `tests/fixtures/holds-protocol/` hold every reader
verdict below as data, and both halves test against them.

**N1. The directory.** `<main>/.agentic-plugins/runs/autopilot/holds/<macro-id>/`
(item 1), where `<main>` is the worktree holding the repository's common git
dir, as the run locks find it. One subdirectory per record kind, since a
subtask id admits `.`:

| Path | Written by | Read by the persona |
|---|---|---|
| `protocol.json` | the hold-aware orchestrator, once, before its first hold record and before a run of the macro honours holds | yes: activation (N2) |
| `holds/<subtask>.json` | `hold`, `release`, retirement and orphaning (`impl-hold`) | yes: whether a hold applies (N3) |
| `handoffs/<subtask>.json`, `releases/<subtask>.json` | the orchestrator (`impl-hold`) | no |
| `ops/<subtask>/<operation-id>.json` | the persona: published and removed (N4) | yes |
| `ops/<subtask>/<operation-id>.cleared` | `writer-clear` (`impl-hold`), created once, never rewritten | yes |
| `parks/<subtask>.json` | the driver (`parks.mjs`, `impl-lane-gate`) | yes: a kept park (N3) |

Every record is written whole (a temporary file renamed over it, or an
exclusive create) and parsed as JSON; the orchestrator's kinds keep their
own locks (`impl-hold`).

**N2. Activation.** The holds directory exists once `impl-lane-gate` keeps a
park, so its existence says nothing about holds. `protocol.json`
(`{"schema": "agentic-holds-protocol-1", "protocol": 1, "written_by", "at"}`)
says a hold-aware orchestrator runs for the macro. The persona reads it at
the first and the last write of each operation of a macro's child, and an
interactive `finish-verb` reads it holding the workflow's lock, in its write:

- no holds directory, or no `protocol.json` in it: **inactive** — the
  persona writes as today and refuses nothing (item 9);
- `protocol.json` of this schema and `protocol` 1: **active**;
- anything else — a directory or marker that cannot be read, a marker that
  is a directory, a FIFO or a dangling link, one that does not parse, another
  schema, a `protocol` above 1: **unreadable** — the persona refuses its
  operations' first writes, naming the path (item 8), and lets a running
  operation finish.

The marker is never removed while the macro lives; the macro's end retires
the directory whole (item 8, `impl-hold`).

**N3. What the persona reads of a hold.** The owner's record
(`{"schema": "agentic-hold-1", "hold_id", "subtask_id", "branch", "lane",
"child", "state", "set_by", "set_at"}` plus, once orphaned, `"orphaned":
{"at", "why"}`; `state` is `held`, `released` or `retired`) **applies** to a
child when it is readable, its `state` is `held` whether its handoff is
pending or done, it carries no `orphaned`, its `branch` is the child's, and
its `child`, when set, is the child's workflow id. A record that cannot be
read applies (item 8); a missing one does not. The persona never writes the
owner's record nor its handoff. A **kept park** is any record in `parks/`
of the subtask, readable or not (Decision 1, item 3). A **live run** of the
macro is an entry `h-*.json` of its macro lock whose driver process is the
one recorded, judged as the run locks judge it (the process's start in the C
locale, a zombie is gone, a pid reused by another process is gone); a lock
directory or an entry that cannot be read, or that is no regular file, counts
as live.

**N4. Persona operations.** An operation runs from a command's first write
of a macro's child (its create, for a bootstrap) to its last (a verb's
`finish-verb`; a commit's parent writeback after its archive; a gate
resolution's `finish-verb` after its clear). It has an id
(`op-<yyyymmddThhmmssZ>-<8 hex>`) carried between the command's shell blocks
in a program-written transport file, and kept on the child while open:
`persona_operations`, one JSON document `{"v": 1, "ops": [{"id", "kind",
"opened_at", "ext"}]}` in a double-quoted scalar at the tail of the
frontmatter, so an older reader carries it byte for byte. `ext` says whether
the operation published an external record at its first write.

| Point | Inactive | Active |
|---|---|---|
| first write | the entry joins the child's list in that write; overlapping operations each keep their own entry | the record `ops/<subtask>/<id>.json` is created exclusively, **before** the write takes the workflow's lock; then the lane is looked at again, and another open operation (an entry of the child, or a record under `ops/<subtask>/` with no `.cleared` beside it, other than its own, whoever opened it) withdraws the record and refuses, naming it; holding the workflow's lock, the write looks at the child's entries once more and adds its own with `ext: true`. Two first writes at once may both refuse; neither proceeds beside the other |
| a later write | carries the entry | carries the entry |
| last write | removes the entry in that write; one with `ext: true` refuses (its marker vanished) | refused when `<id>.cleared` exists, or when `ext` is true and the record is gone; else the write removes the entry, then the record is removed, **after** the workflow's lock is released |

Crash points: a crash before the first write leaves a record no child names
(the operation is open: the owner clears it, item 7); a crash after the last
write's entry removal and before the record's removal leaves the record
open, the same way. A cleared record beats an open entry: the orchestrator
counts an operation open while its entry or its record is there and no
`.cleared` names it. An operation that read inactive and met the marker at
its last write was open before activation (`ext: false`); it closes as
active, refused only when cleared. An entry the owner cleared goes with the
lane's next first write, and its own last write stays refused.

The transport is the command's **operation directory**, a private directory
its first-write block makes (`mktemp -d`) and prints as `OP_DIR=<path>`, which
the agent sets in the finalize block as it sets `DISPATCH_DIR`; `state.mjs`
takes it as `--operation-dir` (`create`, `append --open-operation <kind>` at
a first write; `finish-verb`, `set-terminal`, `append --close-operation true`
at a last). The first write keeps `operation.json` there (the id, kind,
macro, subtask, branch and child, and `opening`, `open` or `closed`) before
it publishes anything, so a first write run again continues its operation,
and one run again across activation publishes its record and marks its entry
`ext: true`. A file bound to another child, branch or kind (a bootstrap's,
once its create landed, names its child), one that ended (or whose entry is
gone from the child: it ended, or was cleared), or one that cannot be read
is refused, as is a last write whose file names another kind than the
child's entry. A first write reads activation again holding the workflow's
lock and refuses, to be run again, when it changed since its first read. A
directory that is gone refuses the last write, which the
person can run with no directory, leaving the operation open for the owner
to clear. With no directory a write is as before, so a runbook and scripts of
different releases meet safely: an earlier `state.mjs` ignores the flags, and
an earlier runbook passes none. A bootstrap dispatched by
`/orchestrator:next` takes the id the dispatch exported
(`AGENTIC_OPERATION_ID`), and continues a record of that id already
published when it names the same kind and lane and no other child. Operation bookkeeping adds no
`host_history` event and moves no field the lane fingerprint reads, so it is
not progress (`policy.mjs` `childTuple`).

The other operations:

- **A commit** (`/engineer:commit`, `/engineer:start`'s Phase 7) keeps its id
  as its entry on the child (kind `commit`), since Phase 7 runs as one program
  and the Stop hook that ends it has no directory of the command's. Its first
  write is the commit's `beginCommit` (a close's terminal write, for the
  no-changes close), and each run of the commit opens its own operation, so a
  second commit beside a running one, or beside one a crash left open, is
  refused until that one ends or the owner clears it (item 7). It stays open
  through the terminal write; the Stop hook's archive carries the entry, and
  after the parent note a write of the archived file removes it (the newest
  entry of the kind the owner has not cleared), adding no `host_history` event
  and moving no `updated_at`, then the record goes. A cleared operation's
  entry stays on the archived file. A commit that refuses before its terminal
  write (a post-commit gate, a hook, a subject) has made its last write, so it
  ends its operation there; one stopped by an error (a throw, a kill) cannot
  tell what it left and stays open until the owner clears it, as item 7 says.
  The no-changes close ends its operation in its archive. On a host whose Stop
  hook does not run (Codex before `/hooks` trust), the operation stays open
  until the archive runs.
- **The staging-set gate** an autopilot commit records, **a checkpoint**, and a
  gate's **clear** given no operation are operations of one write: admitted as
  a first write is (one at a time in the lane, none while the holds cannot be
  read) and refused as a last write is (cleared by the owner, or its record
  gone, while it waited for the workflow's lock), they leave no entry, and the
  record goes after the write.
- **A gate resolution** (decide's Owner selection, refine's Owner decision)
  runs from its clear to the `finish-verb` after it: the clear continues the
  operation the verb's Phase 0 opened when the block is given its directory,
  and otherwise opens one (kind `gate`; refine's Fix now opens a `verb`
  operation, which the refine's phases continue to their finalize) in a
  directory the block makes. Inside a `/start` lifecycle no `finish-verb`
  follows: given Phase 0's directory, the clear closes that operation, and
  given none it is an operation of one write. A clear given a directory whose
  operation ended is refused before it writes.
- **`/resume`** writes a macro's child once: its marker is an operation of one
  write (`append --once-operation resume`), and so is its archive (kind
  `archive`): `state.mjs archive` makes one on either host. An archive whose
  workflow is already gone writes nothing and opens nothing.
- **A consultation** (`/peer-now`) on a macro's child runs from before its
  launch to its `[Peer]` note (kind `peer`): its run names no workflow, so the
  lane sees it only as an operation. The dispatch opens it in the operation
  directory `op` beside its prompt with a write of the entry alone (`state.mjs
  operation --open-operation peer`: no `host_history` event, no `updated_at`),
  and a refusal stops the launch. A directory that holds `op` already
  dispatched a consultation and is refused, so a dispatch run again never
  launches a second run under the first one's operation. The note goes only to
  the workflow the dispatch kept as `prompt.xml.workflow` (none, for a
  standalone consultation) and closes the operation (`append
  --close-operation true`). A consultation that failed gets no note: its
  dispatch closes the operation (`state.mjs operation --close-operation true`)
  once the runner's own result says the run ended (`failed`, `cancelled`,
  `orphaned`); a runner that left no result (killed, its peer perhaps still
  running) leaves it open for the owner, as does a dispatch killed before the
  launch. Scripts that print no `hold-capability` (an earlier release run
  beside a later runbook) open none. A limit: in a lane a hold-aware
  orchestrator runs, a person's `/peer-now` on the child while their own
  verb's operation is open is refused as a second operation (one at a time,
  above), and nothing is launched. They consult after the verb's
  `finish-verb`; the verb's own ensemble runs inside its operation.
  Letting the consultation share the verb's operation would need a point
  where the note hands it back, which this note does not design.
- **The Stop hook's sweep**, which archives a terminal child of a branch no
  worktree has checked out, leaves alone a child whose lane has an operation
  open (an entry of the child, or a record with no `.cleared`, as the
  orchestrator counts it), and every child while the holds cannot be read,
  judged again holding the archive's lock; once the owner cleared the
  operation, the next sweep archives it. Inactive, it archives as before and
  ends a commit's operation after the archive.
- **`/start`** writes no macro's child, so it opens no operation: its
  bootstrap carries no dispatch linkage, and its resume writes a start
  workflow only, refusing any other before it writes. In a held lane its
  bootstrap is refused, as every unlinked one is (below). A lifecycle is
  never a dispatched child (ADR-0020 Sub-decision 6), so a create of a start
  workflow with parent linkage, which no runbook makes, is refused in a macro
  a hold-aware orchestrator runs for or whose marker cannot be read; one made
  by hand before the macro was marked writes outside any operation, a limit
  of a workflow no command produces.

**The writer inventory** (item 7). Every lock of a workflow names its
writer's class (`state.mjs` `LANE_WRITERS`), and a persona test holds every
lock site, every `state.mjs` subcommand and every script's imports from
`state.mjs` to a class, so a writer added later fails it until it is
classified:

- `operation`: a step of an operation above, which judges it.
- `plain`, every other write of the workflow (a phase note or a terminal write
  given no operation, a manifest entry, a review ledger, a consensus task, a
  pending peer run, an owner gate set by hand, the P10 marker, an archive):
  holding the workflow's lock, it is
  refused when the macro is active, the subtask's owner hold applies (N3) and
  no operation the owner has not cleared is open on the child; refused too
  while the holds cannot be read with none open, and while the child's
  operations are of a later version than the persona reads. With an operation
  open on the child it is admitted, whoever runs it: the persona cannot tell
  that operation's command from another beside it, and the release excludes
  the operation's whole length either way.
- `snapshot`: the Stop and PreCompact snapshot, admitted (item 7).
- `settlement`: `peer-runner settle` or `ensemble-commit` of a run the child
  records pending or settled, admitted: a step running when the hold was set
  settles (item 4), and the handoff waits for it. Of any other run it is
  `plain`.
- `machine`: a result, end or pass of the driver's verification batch,
  admitted (item 4).
- `job`: a batch's start or restart, refused while the subtask's hold applies
  or the holds cannot be read, whatever operation is open: no machine job
  starts in a held lane (item 3). `impl-hold`'s driver reads that refusal as
  the hold it reads before the job.
- `create`: a bootstrap, judged once written: a linked one with no operation
  (an earlier runbook, a create by hand) is refused in a held lane and
  withdrawn, as an unlinked one is (below).
- `destination`: an archive's destination, which holds no live workflow.

The orchestrator's lifecycle archive (`detach-archive`, which `/orchestrator:abort`
and `finalize` run) is an operation (kind `archive`) from its mark to its
archive, which ends it: it archives a held lane's child as item 8 says, is
refused beside another open operation and while the holds cannot be read, and
a crash between its two writes leaves it open for the owner. The Stop
lifecycle leaves a held lane's child that has no operation open (a commit's is
open through its archive), as its sweep does, and archives it after the
release.

A pending peer run that a held lane refuses stops its launch before the
companion is spawned (`peer-runner run` records the run `failed`, error kind
`held_lane`; `dispatch-peer` returns kind `held_lane`), so no peer runs
whose settlement the lane would refuse. An archive that ends an operation it
names (the lifecycle archive's) is refused once that operation is gone, and
never archives on another operation's entry. Outside the persona, the
orchestrator's `cutover --move` moves a child's workflow under its own lock:
it is `impl-hold`'s to hold to this rule (`laneWriterRefusal` is the
persona's reading of it).

**An unlinked bootstrap** (item 5) is a create with no dispatch linkage to
the lane that holds its branch: every create of designer and founder, and an
engineer's with none or another lane's. It reads each macro under `holds/`
that a hold-aware orchestrator runs for (N2), and is refused, naming the
macro, the subtask and the hold, when an owner's record of it applies to the
branch (N3; there is no child to compare). It reads them before it publishes
anything, and again once the workflow is written, holding the workflow's
lock: a hold that appeared between the two reads withdraws the workflow, so a
hold that misses it was set after it was there to be seen. A holds root, a
macro's directory, marker or owner's record that cannot be read may hold the
branch, so it refuses every unlinked create in the repository until it reads
again or the owner discards the record (item 8); a macro with no marker
refuses nothing. A linked bootstrap's own macro, where it cannot be read, is
its operation's to judge (N4). How the orchestrator reads a workflow begun on
a lane's branch before its hold is `impl-hold`'s.

**N5. Locks.** The persona takes no lock in the holds directory: its records
are exclusive creates and unlinks, published before a write's workflow and
creation locks are taken and removed after they are released, never inside
them. The orchestrator reads a child's open operations without its locks and
judges a held workflow lock by its presence, never by taking it (item 7). It
takes its own locks in the order worktree lock, macro lock (as the driver
does, `driver.mjs:661-662`), then a holds-directory lock, then `parks/.lock`,
and waits on no persona lock while it holds one. An archive takes the
creation locks before the workflow's lock (`state.mjs:5596-5606`), and a
create takes the creation locks alone; neither nests a holds-directory lock.
No cycle can form.

**N6. The content digest.** `state.mjs content-digest --workflow-path <p>`
prints `{"schema": "agentic-workflow-content-digest-1", "digest"}`: a sha256
of the parsed frontmatter without the fields a snapshot writes (`updated_at`,
`last_snapshot`, `host_history` entries whose event is `snapshot`, and the
`verify_handoff` and `verify_attempt` bookkeeping every write of the workflow
stamps, a snapshot's included), its
forward-compat carrier included, and of the body as stored, its leading blank
lines left out (every write adds one, `state.mjs` `assembleWorkflowFile`). A
snapshot, whatever re-serializes, leaves it unchanged; any other change moves it. The
tree's digest and the comparison are `impl-hold`'s.

**N7. Release transitions** are `impl-hold`'s and are frozen here only as
the states the persona's refusals assume: a release names one `hold_id`; a
pending hold's release withdraws it with nothing to compare; a held one's
release records the comparison basis and waits; the driver's comparison
consumes it (equal) or rejects it (different), each once; a new hold after a
rejection starts again. The table is
`tests/fixtures/holds-protocol/release-transitions.json`.

**N8. The capability token.** The persona prints
`{"capability": "hold-persona-1", "protocol": 1}` for `state.mjs
hold-capability`, and its scripts carry the token `hold-persona-1`, which the
driver's lanes capability floor reads (item 9).

**N9. The takeover prototype (item 10).** `tests/acceptance/hold-takeover/`
drives a takeover end to end before the persona's half ships. The persona
side is the persona's real scripts, run through the generated blocks of its
runbooks, with the operation directory carried as their `OP_DIR`. After the
release, the driver's next step runs the runbook of the verb the child
recorded. The other side is a scratch orchestrator half beside the test. It is
not `impl-hold`'s and ships in no package, and its file lists what it leaves
out. Each acceptance case runs with shared creation off and on (ADR-0067
Decision 1), and the README states the acceptance. The persona needed no
change.

For item 10's [unverified] list, it found:

- **Peer runs the session started itself** are operations while they run.
  The test checks this with the peer held running behind a barrier.
  - A verb's ensemble runs inside the verb's operation, and stays pending on
    the child until the verb's finalize settles it.
  - A consultation is its own operation (N4) until its note.
  - The release waits for both, after the peer has ended too. Afterwards a
    consultation's run stays in the ledger, naming no workflow; an ensemble's
    is settled on the child. The resumed worker's verb settles its own phase
    beside them.
- **Session-capture files** are written in the lane's checkout under
  `.agentic-plugins/state/runtime/session-capture/`. They are outside the
  content digest, and outside the tree digest where the repository ignores
  `.agentic-plugins/`. This was measured with a synthetic file at that path;
  the runtime's writer did not run.
- **A dirty tree recorded in no manifest** is part of the release's basis, so
  the comparison consumes it.
  - When the hand edit is outside the worker's manifest, the resumed worker's
    autopilot commit stops at the staging-set owner gate (Phase 7's rule for
    changes outside the manifest), and the lane parks for the owner.
  - An unstaged hand edit inside a path the worker's manifest names, in a
    workflow begun on a clean tree, is committed with the worker's change,
    since Phase 7 stages whole manifest paths. A staged one stops at the gate.

One point is left to `impl-hold` and the owner, and nothing here decides it.
Suppose a repository does not ignore `.agentic-plugins/`. The session's state
in the lane's checkout is then made of non-ignored files: its session capture
always, and the persona's records too when shared creation is off. The
release tells the person to close the session first, but nothing checks it. A
session left open after the release writes there, for instance the Stop
snapshot. The content digest leaves that snapshot out (N6), but the tree
digest does not, so the release is rejected though nobody edited. The test's
last case measures this for the snapshot. Leaving the state root out of the
tree digest would depart from item 7's "every non-ignored file".

## Implementation note 2026-10-26 — impl-hold (the orchestrator's half)

The orchestrator's half of Decision 2, on the protocol the note above fixed.
It adds no guarantee. This head fixes the records and the persisted
intermediate states of every multi-file change before the code that writes
them: per-file atomic writes are no transaction, so each change is a sequence
of whole-file writes, and each state a crash can leave between two of them
has one recovery, which the next hold-aware command or run performs.

**I1. The records** (beside N1's, all under the macro's holds directory):

| Path | Schema | Fields |
|---|---|---|
| `holds/<subtask>.json` | `agentic-hold-1` (N3) | `hold_id` (16 hex), `subtask_id`, `branch`, `lane` (worktree path or null), `child` (workflow id or null), `state` (`held`, `released`, `retired`), `set_by`, `set_at`, and once set `released_at`, `retired_at`, `orphaned {at, why}` |
| `handoffs/<subtask>.json` | `agentic-hold-handoff-1` | `hold_id`, `subtask_id`, `state` (`acked`), `fence` (the fence entry's path, or null for a lane with no worktree), `at` |
| `releases/<subtask>.json` | `agentic-hold-release-1` | `release_id` (16 hex), `hold_id`, `subtask_id`, `state` (`uncompared`, `consumed`, `rejected`, `withdrawn`), `basis {fingerprint_version, fingerprint, tree_digest, content_digest, child}` (null for a withdrawal), `park_record_id` (the kept park the release ends, or null), `park_ended` (bool), `released_at`, `compared_at` |
| `ops/<subtask>/<id>.json` | `agentic-persona-op-1` (N4) | also the orchestrator's own exclusion records, kind `release`, `compare`, `retire` or `cutover` (I10), with the writer's `pid` and `fingerprint` |
| `discarded/<kind>-<subtask>-<stamp>.json` | the bytes discarded | a copy kept by `release --discard-unreadable` |
| `events.jsonl` | one line per event | `held`, `released`, `consumed`, `rejected`, `retired`, `orphaned`, `discarded`, appended whether a run lives or not; a run's `lanes.jsonl` has its own lane events (I12) |
| `.lock` | a run-locks lock | the holds lock |

The fixture states map onto them: *pending* is an owner record `held` with no
`acked` handoff of its hold id; *held* one with it; *released-uncompared*,
*consumed*, *rejected* and *withdrawn* an owner record `released` with a
release of its hold id in that state; *retired* and *orphaned* the owner
record's own fields.

**I2. Lock order.** Worktree lock, macro lock, holds lock (`.lock`), then
`parks/.lock` (N5). The holds lock is taken with a short retry and never held
while waiting on a persona lock; a workflow lock is judged by its presence.

**I3. Crash states and their recovery.**

| Change | Writes, in order | State a crash leaves | Recovery |
|---|---|---|---|
| `hold` | owner record `held` (new id), removal of an older handoff and a withdrawn, consumed or rejected release of an older id | owner `held`, older records left | the older records name another hold id and are ignored; the next write of the subtask removes them |
| handoff | fence entry, recheck, `acked` handoff | fence written, no ack | a retry finds its own fence (its name derives from the hold id) and redoes every blocker check before it acks, never acks at once; a blocker found then withdraws the fence |
| handoff | — | ack written, fence gone (an older `admission release`) | the next hold-aware command repairs the fence (Decision 2, item 4) |
| release of a pending hold | `withdrawn` release, owner `released`, fence removal | withdrawn release, owner still `held` | the hold still applies; the retried release finds its own withdrawn release of the hold id and finishes |
| release of a held hold | own exclusion record, basis, `uncompared` release, owner `released`, fence removal, exclusion record removal | release written, owner still `held` | never compared: the driver compares only a release whose owner record says `released` with its hold id; a retried release recomputes the basis and replaces it |
| | | owner `released`, fence present | any hold-aware command removes that hold's fence only, never another hold's |
| | | exclusion record left by a dead writer | the next orchestrator command that finds a `release` or `compare` record whose recorded process is gone removes it; a live one is open |
| consumption | own exclusion record, digest, release `consumed` (`park_ended: false`), the park's end by `park_record_id`, `park_ended: true`, exclusion record removal | `consumed`, park end pending | the next run finishes it by the recorded park id only (a conditional delete), never a newer park |
| rejection | own exclusion record, digest, release `rejected`, park `owner-choice` | `rejected`, no park | the rejection alone keeps the lane from stepping; the next run rebuilds the park; a forced `--next` and a `record changed` resumption do not pass it |
| discard | copy under `discarded/`, then the replacement (a new hold; a release counted rejected; a handoff's removal, so the lane is handed over again; I12) | copy written, replacement pending | the unreadable record still guards the subtask; a retry keeps a new copy and replaces it, never passes the lane unguarded |
| retirement (`done`) | owner `retired`, release and handoff removal, the kept park's deletion, fence removal | owner `retired`, others left | retired never applies again; any reader removes records of a retired hold id; the retry is idempotent |
| retirement (macro end) | the macro's terminal write, then the directory's removal | terminal written, directory left | `stop-archive`, `done`, `status` and the next run retire the directory of an archived macro too |
| `hold` beside a starting run | owner record `held`, then a second look at the live runs | a run that does not honour holds took its locks between the two looks | the second look withdraws the unhanded hold; the serial run's own look after its locks sees any hold published before it |
| any | — | a handoff or release record of a held hold that cannot be read | the hold is unreadable, not pending: nothing withdraws or repairs it until the owner discards the record |

**I4. What the comparison leaves out.** The lane's worktree lock
(`.agentic-plugins/runs/autopilot/worktree.lock/`) is the orchestrator's
bookkeeping, not the lane's content: a release removes its own fence after it
records the basis, so the tree digest leaves the lock out even where the lane
does not ignore its runs. The temporary index is dated a second after the
epoch, so git compares every file's content rather than trusting a stat an
edit of the same size, or one whose times were put back, would leave alike.

**I5. A relaunch and a run's end.** Reconciliation reads each subtask's gate
before any row acts, and again before each later action on a subtask that
passed (the same `holdGate` the run reads before its own actions); a subtask
it passes by stays passed by for that reconciliation: a gated subtask's lane gets no pre-pass item, no removal check, no
row and no halt; it is reported and recorded `passed-by` in `lanes.jsonl`,
and the run takes no lock in it. A passed-by lane given back while the run
lives, its release consumed or its hold ended without one, is reconciled by
the per-lane entry point before its next step, never created over its
worktree. A lane the owner holds is `held` in `halt.json`, `run.json` and the
report (held beats parked: a held lane's kept park waits for its release, and
is no halt), with its release (`--hold <id>`, or `--discard-unreadable`); a
run whose lanes left are all held ends on the first of them, an
awaiting-landing halt keeping its reason with the held lanes in its `also`.
At the end the run makes its last handoffs, writes `halt.json`, removes its
lock entries (its lanes', then the macro's run lock, which `liveRuns` reads,
then the driver's own worktree lock), then tries each pending handoff once more as a
command with no live run would, so a hold set between its last handoffs and
its entries' removal is handed over; one set after finds no live run.

**I6. `/orchestrator:next` (item 5).** `state.mjs hold-gate` refuses, naming
the exit, a subtask whose hold is pending, held or cannot be read, whose
release no run has compared yet or was rejected, or whose lane has a persona
operation open (the records under `ops/<subtask>/` and the entries of every
child linked to it on its branch, active or archived, the rule retirement, a
close and a rebinding read the lane by); with the holds on and `--engineer-root`
given, an engineer that is not hold-aware. It runs in Phase 1 and, with the
engineer's root, in Phase 3, and prints nothing for a macro whose holds are
off. Phase 3b, under the admission, judges the gate again under the holds lock
(a macro whose holds are off is judged without it, so no holds directory is
made) and, for a bootstrap (no engineer workflow on the branch yet) of a macro
whose holds are on, publishes the dispatch's mark: an operation record of kind
`verb`, no child, `dispatched_by: orchestrator:next`, whose id it first keeps
in the text directory (`dispatch-mark.json`, with whether the holds were on and
whether this is a re-attach); then it looks again for any other open
operation, which withdraws the mark and refuses. A hold set from then on stays
pending, its handoff seeing the operation open. Phase 4 judges the gate once
more beside its own mark (which must still be a readable, uncleared dispatch
record), refuses when the holds turned on after Phase 3b judged them off (no
mark is there for a hold to wait for) and, the holds on, an engineer that is
not hold-aware (holds may have turned on after Phase 3 passed it), and exports
the mark's id as `AGENTIC_OPERATION_ID` (unsetting any other), which the
engineer's bootstrap continues (N4). A pass leaves `dispatch-mark.json.checked`,
naming the operation ids the subtask's children carried then; each check
takes the earlier pass away before it judges and writes it back only when it
passes, so a refusal or an error leaves none, and Phase 5 records the subtask in
progress only beside it, the holds on or off (a dispatch whose mark file is
gone is not recorded either). The prelude runs again before each later
engineer block: once a check has passed and a linked child carries the mark's
id (with no mark, a re-attach or a dispatch whose holds were off at the
switch, an operation the owner has not cleared that the pass did not see: the
engineer's, begun since), the lane is the engineer's and the check passes, a
hold set since waiting for that operation (amendment of 2026-10-27: a
dispatch whose holds were off was refused by every later prelude once a hold
turned them on, though its engineer held the lane). Every exit after the publication, Phase 3b's own refusal and every
exit of Phase 5, withdraws the mark unless a child linked to the subtask,
active or archived, carries its id (or one cannot be read): the engineer took
it over, and its last write removes it. A Phase 5 that finds no mark file
says that a published mark stays open for the owner to clear. A re-attach publishes no mark, since the
engineer's resume opens an operation of its own, which the mark would refuse.
Limits: a hold acknowledged between Phase 4's check and a re-attached
engineer's first write lets that person's verb run in the held lane, as any
person's operation may (the driver still stays off); so does the first hold of
a macro whose holds were off, set between Phase 4's check and an engineer
bootstrap's first write, since no mark was published for it to wait for. Both
windows span the agent's steps between the prelude and that write. A session that stops between Phase 3b and Phase 5 leaves the
mark open, like its admission, until the owner clears it (`writer-clear`).

**I7. Every hold's exit (item 8).** *Retirement.* `/orchestrator:done`'s write
(`state.mjs subtask-update --status completed`, the same on both hosts)
retires the subtask's records after it completes the subtask, in I3's order:
the owner record `retired`, its release and handoff removed (one that cannot
be read is left and named), its kept park ended under `parks/.lock`, its
fences removed. It runs under the holds lock and behind an exclusion record of
its own in the lane (kind `retire`, I10), looking again once the record is
published, so no persona operation begins while it retires; it reads the plan
again under the lock, so a plan revised since the caller looked (the id
reused, a new hold set on it) retires nothing. It waits while a persona
operation is open in the lane (the records under `ops/<subtask>/`, and the
entries of every child linked to it, active or archived, an entry-only
operation begun before the holds turned on included) or a worker of a run
lives there, the caller's own run excepted (a worker of it records the lane
done); an exclusion record whose process is gone is swept first. The subtask
is recorded completed either way, and the hold applies until the retirement
runs, which done's no-op path (`holds-retire --subtask-id`), `status`, the
Stop hook and a run's start retry. A retry also removes a fence a crash left
after the owner record turned `retired`. A hold record that cannot be read is
not retired: the owner discards it, and the next of those retires it. A write
that ends the macro, or finds it ended, retires the macro's holds directory
too. *A macro's end.* Under the holds lock, behind an exclusion record in every
lane, and after a second look, every hold's fence is removed and the
directory is renamed aside in one step, then removed; it waits while a run of
the macro other than the caller's lives, an operation is open (child entries
included), a lane is busy, or a hold's owner, handoff or release record cannot
be read (its fence and its bytes would go with the directory: the owner
discards it first). `/orchestrator:abort` and `finalize`, on both hosts, run
`holds-preflight` after their admission and before their first bulk status
write: an open operation, a busy lane, a record or directory that cannot be
read, or (the holds on) an engineer that is not hold-aware stops them, naming
each, before anything is written (under an autopilot run, its own worker, the
caller, is not a busy lane, as in retirement: amendment of 2026-10-27); a held
lane alone does not, since their
child pass archives its child through the engineer's lifecycle archive (N4).
After their terminal write they run `holds-retire --macro-end`, which refuses a
macro that has made none. `status` retires the directory of a macro that has
ended (terminal or archived). The Stop hook, after its loop over live macros,
reads where each macro with a holds directory is: one archived (in an archive
home of some root, in no workflow home) has its directory retired; one live has
its completed subtasks' records retired and, ended, its directory; a workflow
home that cannot be looked at retires nothing. *Orphaning.* A run's start
(before any release is compared), `status` and `holds-retire` with neither
option mark `orphaned {at, why}` on an owner record that is pending, held or
released-uncompared when, by the plan read under the holds lock, its subtask
left the plan, the plan's branch for it differs, its lane (the worktree holding
the branch) differs from the one it was held in, or the one child linked to it
differs from the one it was held on; a lane or child that is absent or not
known, or a plan that cannot be read, never orphans, and the fence goes with
it. Each also removes what an ended hold (retired or orphaned) left: its
handoff, its release and its fence. `hold` refuses a subtask the plan has
closed (`completed`, `deferred`, `abandoned`) and a macro that has ended.
*The orchestrator's writers of a child.* `cutover --move` and its rollback
refuse, before they write a manifest and again before they move an open
manifest's pairs (the rollback before its switch goes off), a child, active or
archived (a commit's operation is open through its archive), whose subtask's
hold applies or that has a persona operation open, and any child while its
macro's holds cannot be read; and each child's move, under its own lock,
judges it again behind an exclusion record (kind `cutover`), so a hold or an
operation that came after those checks refuses the move. Limits: a waiter on
the holds lock of a macro whose directory was just retired makes the directory
again; no hold is written there then, since `hold` refuses an ended macro, and
asks again under the holds lock before any write of its record (the macro,
the subtask and the holds' activation, which a retired directory no longer
has: amendment of 2026-10-27), and abort, finalize and done have checked the
lanes, and the next Stop retires it. A `hold` whose activation, taken before
that lock, lands after the retirement leaves its protocol marker there and
nothing else; the hold itself refuses, and the next Stop retires the
directory. The Stop sweep reads only the roots the stopping checkout can list.
`/orchestrator:done` does not address an archived macro, so a retirement that
waited at done for an archived macro is finished by `status` or the Stop
sweep.

**I8. A rebinding beside a hold (Decision 8, item 3).** impl-rebind's interim
reader, which refused any entry of the macro's holds directory but `parks/`,
whatever subtask it named, is replaced at both of its entry points, the
approval (`plan-approve`, when it records or changes a rebinding or a note)
and the delivery (`rebind-deliver`: an approval's own, one run by hand, and a
run's at the child's boundary), by `rebindRefusals` (hold-ops.mjs). It reads
the subtask's own records only. It refuses a hold that is pending, held or
cannot be read (naming its release command, or `--discard-unreadable`), a
release of it awaiting its comparison (whose content digest the note would
change; a run compares it), a holds marker that cannot be read, and a persona
operation open in its lane: the records under `ops/<subtask>/`, the entries of
every child linked to it on the plan's branch, active or archived, and the
entries of the child files the rebinding found, read directly, so a child in
the legacy workflow home counts too; `writer-clear` is the way out for one
whose session is gone, and a cleared operation does not refuse whichever side
names it. A retired, consumed, rejected, withdrawn or orphaned hold, a kept
park and another subtask's records permit. The operation check runs whether
the macro's holds are on or not: the persona writes its entries either way,
the visibility Decision 8, item 7 waited for. A plan id that is no hold key
(the plan takes any string) has nothing to read, since no hold record is kept
for it and the persona opens no operation for it. The reader is read-only (no
lock, no repair, no directory made), since the approval calls it holding the
macro's file lock. An approval refuses only for a subtask whose rebinding it
records anew or changes, or that it tells. A rebinding the readable record
already holds with every field the same (child, the child's state, the words
from and to, the fields changed) is carried: no note follows it and nothing a
release's comparison reads of it changes, so an approval of another
subtask's change proceeds beside its hold. The record is taken as it reads,
its stamp current or not, since re-recording what it holds changes nothing.
A rebinding whose child archived since is recorded anew, and so refused
beside a hold: the release's fingerprint reads the child's state. Limit: the
check is a look, not an exclusion. A persona operation that begins between
it and the note's append meets the note mid-step, as before the holds.

**I9. The fence, a live run and a busy lane (items 2 and 4).** The fence is
an admission entry in the lane's worktree lock
(`.agentic-plugins/runs/autopilot/worktree.lock/`), named as a session's so
every reader, an older driver included, reads it as an entry and judges it
live until it is removed. Its holder is `{kind: session, command: hold,
hold_id, subtask_id, macro_id, checkout}`, and its admission id is derived
from the hold id (run-locks.mjs `fenceAdmissionId`), so a retried handoff
finds its own fence and no other. `describeAdmission` prints the hold's
release command for it, and `admission release` refuses it before it removes
anything: only the hold's own commands end it. A lock entry is read only as a
regular file, opened without blocking, so a FIFO is never waited on and a link
to nothing is not taken for gone. *Repair.* A held hold whose fence is
missing (an older orchestrator's `admission release`) gets it back, and a
released, retired or orphaned hold's leftover fence is removed, only that
hold's, by `status` and by a run (its handoffs and its pass over the
releases), under the holds lock, so a handoff between its fence and its ack is never judged from
outside. *Live.* A run is live while its driver lives (`liveRuns`, from the
macro's run lock): a lock or entry that cannot be read, or one too fresh to
have been written whole, counts as live, with capabilities unknown. *Busy.*
Seen from outside a driver (`laneBusy`), a lane is busy while a worker or
task group of any run of the macro lives and names its subtask, or names
none (every lane of that run is then busy), or while a run whose driver died
left a step of the lane unfinished in its ledger; what cannot be read is
busy. A task the scheduler runs for a named lane records the subtask it
acts for; a look it takes of a worktree not yet among the run's lanes may
record none, which errs toward busy. A live driver judges its own steps in
flight and settlements under way. The driver keeps its own lane-lock entry
beside the fence: the handoff leaves that entry out of the rivals it judges,
and a lane the release gives back is stepped under the same entry.

**I10. The release's basis and the comparison (item 7).** A release records,
and the driver's comparison recomputes, four values: the lane's fingerprint
as a park takes it (policy.mjs `parkFingerprint`, peer bookkeeping included,
with its `fingerprint_version`; with no worktree, a look of the main checkout
with the branch's tip), the tree digest, the child's content digest, and the
id of the child those were read from (the one the hold names, else the one
its handoff found when it acked, active or, with none active, the latest
archived child linked to the subtask on its branch, so a hold set while the
dispatch step ran knows its child; the comparison finds it again by that id once it has
archived). Equal in all four consumes the release; any difference rejects
it, and a fingerprint version that differs is a difference. *Tree digest*
(lane-digest.mjs, versioned `1:`): `git add -A` and `git write-tree` through a
temporary index copied from the lane's, its assume-unchanged and
skip-worktree bits cleared, every inherited `GIT_*` variable scrubbed; each
checked-out submodule through its own index, recursively, and an
uninitialized one by its gitlink. The lane's autopilot worktree lock is left
out (I4). The lane's real index is never touched. A lane with no worktree has
no tree digest (`no worktree`): its fingerprint (with the branch's tip), the
content digest and the child are compared.
*Content digest*: the pinned engineer's `state.mjs content-digest` (N6), its
schema checked; `no child` when there is none. The driver takes the basis
off the loop, as a task of the lane. *The exclusion* (the persona's two looks
from the orchestrator's side): before it takes a basis, a release, a
comparison, a retirement or a move of a child publishes its own exclusive
operation record under `ops/<subtask>/` (persona `orchestrator`, kind
`release`, `compare`, `retire` or `cutover`, with its process's pid and
fingerprint), so a persona operation's first write refuses beside it, then
looks again for any other open operation, which withdraws the record and
refuses. A comparison first refuses on what would refuse the release (the
writer checks: another workflow on the branch, one that cannot be read, the
child's pending peers or workflow lock, an open operation) and, beside its
record, looks at the branch again (amendment of 2026-10-27: it judged only the
open operations, so a workflow begun on a released lane's branch had the
release consumed beside it). The record goes when it is done, and one whose process is gone is
swept (I3) by the next release, comparison, retirement or move of the
subtask (`sweepDeadExclusions`; a macro's end, and a cutover or rollback for
each child it moves, sweep before their first look, which would count it
open), not by a read: until then `status`, the
handoff and the gates see it open. A persona first write racing a digest
and the digest never both proceed: one side refuses, or both do. *Before the exclusion*, `release` also refuses while
the child has a pending peer ensemble or its workflow file lock is present
(judged by presence, never waited on). A comparison the exclusion refuses
leaves the release uncompared and the lane unstepped; the tick retries it.
*Consumption* ends the kept park the release recorded, by that record id
(`park_record_id`) and only it, then reconsiders the lane from the child's
`next_step`, landing or dispatch. *Rejection* is final for that release:
the lane parks `owner-choice`, and a forced `--next`, a `record changed`
resumption, a missing park and a discard do not pass it; a new hold and
release do. *Wake-ups.* The tick watches each subtask's owner record under
`holds/` by identity, size and time, which `hold`, `release` and a discard
write, and retirement and orphaning change (I7) once, each ending a hold;
the handoffs, comparisons, exclusion records and the holds lock lie
elsewhere, so the driver's bookkeeping wakes nothing. A pending
handoff whose lane has no step in flight, and a release a pass left to do,
are retried at each tick, since what blocks them can go away without
touching a hold record. A bare release ends a kept park, which the park
digest already watches.

**I11. Turning holds on (item 9).** Holds turn on per macro: the marker
`protocol.json` (`agentic-holds-protocol-1`, protocol 1) in its holds
directory, which tells the persona a hold-aware orchestrator runs for it. It
is written before the first hold record, by `hold`, and at the start of a run
with lanes before its first dispatch, and only once the hold-aware persona is
where it would run: each host's newest engineer in its own install cache
(`~/.claude/plugins/cache/agentic-plugins/engineer/`, and Codex's under
`$CODEX_HOME` or `~/.codex`), probed strictly, with no environment override
and no fallback to the other host, and the engineer the launcher pins
(`AGENTIC_ENGINEER_ROOT`); each must print `hold-persona-1` from `state.mjs
hold-capability`. A refusal names what to install or which pin to move; a run
whose check fails keeps holds off and says so, and its lanes run as before.
Completing the persona subtask is not enough: a person's session loads its
own host's engineer. A marker that cannot be read is never overwritten. A run
with lanes records `capabilities: ["holds-1"]` in `run.json` and in its
run-lock entry; a serial run records none. The orchestrator's `state.mjs
hold-capability` prints `holds-1`, and the lanes capability floor
(roots.mjs) requires the pinned engineer's `hold-persona-1`. A serial run
refuses to start while a hold of the macro applies (pending, held or
unreadable), a release awaits its comparison, or the holds cannot be read,
naming each hold's release (a release awaiting its comparison, the relaunch
with lanes), and
looks again after it takes its locks, so a hold published between its first
look and its locks still stops it. `hold` refuses beside a live run that
does not honour holds, or whose capabilities cannot be read, and looks again
after it publishes: a run of that kind that took its locks in between
withdraws the unhanded hold. `next`, `abort` and `finalize` check the
engineer's capability when the macro's holds are on (I6, I7).

**I12. The owner's commands (items 2, 5 and 8).** `agentic-autopilot` (and
`/orchestrator:autopilot`, its arguments through the args file, ADR-0059)
gains `hold`, `release --hold <id>`, `release --discard-unreadable` and
`writer-clear --operation <id>`; `status --macro` reports holds. `hold`,
`release` and `writer-clear` refuse inside an autopilot worker
(`AGENTIC_AUTOPILOT`); `status` does not. `hold` refuses an ended macro, a
subtask not in the plan, closed or with no branch, an owner record it cannot
read and a hold already held (a handoff or release record it cannot read is
left as it is, and the new hold is unreadable until the owner discards it); it activates holds (I11), records the subtask's
branch, lane (the worktree its branch is checked out in; none when that is
the main checkout, where a hand dispatch works and the driver's own lock
lies, so that hold is unfenced; with no worktree, none, and the worktree
that holds the branch by its handoff or its release is taken then into the
owner record, so the fence, the release's basis and the comparison cover it:
amendment of 2026-10-27, which replaced "the one a run would create", a path
a worktree of the person's own orphaned) and child, and, set over a release still in force (not compared yet,
or rejected), that release as `prior`, and, with no live run,
attempts the handoff at once (a live run's loop does it at its next
settlement boundary). It prints the hold id, the handoff's state and what it
waits for, the lane, the lane's last session from this macro's run ledgers
(`claude --resume <session>`, the latest step started), the engineer the
person needs, the release command, and two warnings: a subtask with no lane
is unfenced (only "do not dispatch it"), and a lane that does not ignore its
generated state paths will reject a release a session left open writes after.
`release --hold <id>` names the hold it ends (another id is refused): a pending
hold is withdrawn with nothing to compare, and its `prior` comes back with
its hold, the new hold's fence removed first, while its record still names
it (so does `hold`'s own withdrawal beside a blind run), so a rejection
is never lost and an uncompared release is still compared; a held one is refused while a
writer may be active (an open operation, a pending ensemble, the child's
workflow lock, another workflow on the branch, several children linked to
the subtask), else records
the basis behind the exclusion (I10), turns the owner record `released`,
removes the fence, and wakes a live run. The bare `release` ends a kept park
only: it refuses a held lane, a release not compared yet or rejected, and a
park it cannot read, which it never deletes (that was cli.mjs's bare
release); it points at `--discard-unreadable`. `--discard-unreadable` keeps,
under `discarded/`, the text of each record that cannot be read (for one
that is no regular file, or cannot be opened, a line saying so, not its
bytes), then replaces it so the lane is never given back unguarded: an
owner's record becomes a new hold (`set_by: discard`) on the branch and lane
the plan names, refused when the plan names none, the old record's fences
removed from every worktree of the repository (its lane cannot be read, and a
plan revision may have moved the subtask; when git cannot list them, the record
is not replaced, and a retry does it); a release becomes a
rejected one; a handoff goes, so the lane is handed over again; an
unreadable park is deleted only while its bytes are those copied. Whether a
hold whose record, handoff or release was discarded had been handed over
cannot be told, so its owner record carries `compare_on_release: true`,
written before the handoff or release record it depends on changes, and
its release, pending or not, is a held one's: the writer checks, the basis and
a comparison, never a withdrawal with nothing to compare (amendment of
2026-10-27: a withdrawal could give back a lane its person still edits, or
write over a discarded release's rejection). Item 8's
"compared again" for a discarded release is met this way: its basis cannot
be read, so there is nothing to compare the lane with, and whether it was
rejected cannot be told; counted rejected, the lane is compared again only
through a new hold and release, so a rejection is never lost and a lane
that changed never steps. `writer-clear` writes the
operation's `.cleared` exclusively, also for an operation known only from a
child's entry: the owner's word that its session is gone. `status --macro`
works from any checkout and with no run history: each hold's state, what its
handoff waits for, its open operations and its release; with no live run it
completes pending handoffs, repairs fences, orphans and retires (I7), and
retires an ended macro's directory. The macro's events (`held`, `released`,
`consumed`, `rejected`, `retired`, `orphaned`, `discarded`) are appended to
`events.jsonl` (I1) whether a run lives or not; a run writes its own lane
events to its `lanes.jsonl` (`held`, `passed-by`, and `released` with the
comparison's verdict), and does not copy the macro's.

**I13. The driver beside a hold (items 3, 4 and 11).** The scheduler reads
`holdGate` (hold-ops.mjs) on entering each path that acts on a lane: a
creation, an admission, a spawn, a removal, a resumption, a forced `--next`,
the reconciliation rows (I5). A path the gate
let in runs to its end (a resumption's park end, its reconciliation and its
lock): handoffs run only at the loop's settlement boundary, after it, so a
hold set meanwhile stays pending until the path is done, and the next path
is gated. A landing-ready report (ADR-0067 Decision 7) is a look, not an
action on the lane, and may still name a held lane's branch. The gate
refuses a hold that is pending, held or unreadable, a release not compared
yet or rejected, and, run-wide, a holds directory that cannot be read. The
decision leaves a gated subtask out as it leaves out a lane with a step in
flight, so no step is chosen for it, its done included. A step already in flight when
a hold is set is never aborted: it runs to its end and its settlement, then
the handoff runs at the loop's settlement boundary. The spawn's hold-back on
a lane whose engineer record was written outside the run less than one tick
ago (the old mtime quiet period) is replaced by the open persona operations
(`openOperations`: the child's entries and the records under
`ops/<subtask>/`, read fresh), so an operation that writes nothing for a long
while still keeps the worker out, and a gate resolution's clear and its
`finish-verb` are one operation. The park digest's own quiet interval, which
lets a parked lane's change settle before it is judged, is unchanged. A lane
held back by an open operation says which, and the owner's `writer-clear`
for one whose session is gone, once per change, in the output and the
lane's report (`waits`): an open operation has no expiry. A run with
nothing running and nothing able to start waits on such a lane for as long as
a step may take (`--step-timeout`), then ends, naming each operation and its
`writer-clear`: an operation left open by a worker that was killed never
closes by itself, and a run with every remaining lane waiting still ends
(amendment of 2026-10-27). A hold set
between the decision and an admission stops that lane only: the wave goes on
with the others and the run decides again. A held lane whose kept park the
owner released is let go, not judged again; a lane the relaunch passed by
whose hold ends keeps a park that still stands, which its own resolution
ends; and a rejected release whose park the records cannot take is parked
once, its record written again at each pass, never a new park. A lane
state `held` joins `halt.json`, `run.json`, `status` and the report (I5).

**I14. The open point, limits and hand-offs.** *The open point* (N9's last
paragraph): the tree digest keeps item 7's "every non-ignored file", the
lane's worktree lock excepted (I4). `hold`
warns, naming the paths (lane-digest.mjs `unignoredStatePaths`), when the lane
does not ignore its generated state paths (`.agentic-plugins/state/`,
`.agentic-plugins/runs/`); this repository and the setup the README requires
ignore them, and a lane that does not gets this documented limit, not an
amendment. *Limits.* Rolling the orchestrator back below this release while a
hold exists is unsupported: a hold on a subtask with no lane has no fence an
older driver would respect, and `hold` says so when it sets one. An ignored
file is not in the tree digest, so an edit to one is not seen by the
comparison, unless it is the child's workflow or something the fingerprint
reads, which are compared apart from git. A hand edit made after the
comparison is not seen either (item 7). A hold whose branch the main checkout
has is compared in the no-worktree form (the branch's tip), so an edit the
person leaves uncommitted there is not seen. Every scan of a lane's
workflows reads the legacy engineer home (`.claude/agentic-engineer`) too,
and counts open a workflow it cannot read, an archived one or one with a
quoted scalar that does not parse included, naming it; for a hold that names
no child, the handoff, the release and the comparison look for its archived
child, and an archived workflow or archive directory that cannot be read
blocks them, since it may be that child; for one that names its child, a place
the child's archived file may be that cannot be looked at blocks them, never
read as its absence (amendment of 2026-10-27), and every state root is looked
in before a copy is accepted: a copy in a later root that cannot be looked
at, or a second readable copy, blocks them too (amendment of 2026-10-27, the
refine's fourth pass). A lane's worktree is gone only when its stat says it is
absent (ENOENT): one that cannot be looked at blocks the handoff, refuses a
release, a withdrawal and a new hold, and keeps a fence repair, a retirement,
an orphaning and a macro's end waiting, so no fence in it is passed over. A
dispatch's Phase 4 check takes its earlier pass away before any discovery
that can fail (same amendment). A plan id that is
no hold key (`task:13`: the plan takes any string, `hold` only
`[A-Za-z0-9._-]`) is dispatched and retired as with the holds off: no hold
can be kept for it. The I6, I7 and I8 limits stand. `claude --resume` of a lane's
last session stays [unverified]: the acceptance pins the session id and cwd
`hold` prints. *The prototype* (item 10) is
`tests/acceptance/hold-takeover/`: the persona's prototype against a scratch
half, and `test-hold-takeover-orchestrator.mjs`, the same routes against this
half (a person's verb with its ensemble, a next step recorded, an owner
decision, a commit through its archive and the parent writeback, a rejection
and relaunch, a dirty manifest, a peer consultation, no child, and shared
creation off); its README maps the persona-side cases to the persona tests
that hold them. *Hand-off.* `holdGate` is exported for verify-exec (Decision
5), which is to read it before each machine job's start; verify-exec wires
it, not this release.

## Amendment 2026-10-27 — a hold's lane and a person's own worktree (impl-hold, critique round 5)

Written in place in Decision 2, item 2, during impl-hold's critique rounds,
where its text still stands as the decision; recorded here as it read at the
migration (2026-11-17). The other amendments of that date stand inside
[impl-hold's implementation note](#implementation-note-2026-10-26--impl-hold-the-orchestrators-half)
(I6, I7, I10, I12, I13 and I14), each marked "amendment of 2026-10-27".

   - Both commands work with or without a live run. A hold on a subtask that
     has no lane yet means: do not dispatch it. Its record's `lane` is null,
     never the path a run would create, so a worktree the person makes for
     the branch does not orphan it; a worktree that holds the branch by the
     handoff (a run's lane created meanwhile, or the person's own) is taken
     then, and fenced, and one made after the handoff is taken at the
     release, whose basis covers it (amendment of 2026-10-27).
   - A person's own worktree goes back to the run in one order: commit the
     work there, remove the worktree, then release. A run steps a subtask
     only in its own lane and parks it while another worktree has its branch
     (row 11), and a release whose basis names a worktree the person removes
     afterwards is rejected at the comparison, for the wrong cause. So a
     held hold's release refuses while its lane is a worktree that is not the
     run's lane for the subtask, naming that order, and `hold` says it up
     front; once the worktree is gone the release's basis is the branch's
     tip, which the run compares (amendment of 2026-10-27, critique round 5).
     A run's lane is judged as reconciliation judges it: the worktree locked
     with the run's lock reason for the macro and subtask, wherever it is,
     never by its path. A withdrawal (a pending hold, never handed over) is
     not refused. A dispatched subtask's lane is taken up again (its live
     child, its branch checked out nowhere: row 10). A subtask not dispatched
     yet is dispatched on a branch at the baseline's tip, or at the tip a
     consumed release of its current hold recorded (`branch_tip` in the
     basis) when the baseline is an ancestor of that tip; a recorded tip that
     does not contain the baseline halts the lane, naming a new hold, a rebase
     onto the baseline and a release, and no halt of row 12 or row 4 advises
     discarding a branch that carries commits the baseline lacks
     ([ADR-0062](../0062-subtask-completion-recorded-at-landing.md) Decision 2,
     amendment of 2026-10-27, owner decision, which replaces the limit this
     item recorded at critique round 5). A prepared lane of the run's own
     (row 4) is still dispatched only at the baseline's tip: commits a person
     made there halt it, naming the removal of the lane's worktree alone, and
     row 12 then judges the branch; the admission's refusal of a prepared
     lane names deleting the branch only once it is shown to carry no commit
     the baseline lacks.
   - **Holds are a lanes feature.** A serial run drives one shared checkout,
     the one the person would work in, and its next dispatch switches that
     checkout's branch. So `hold` refuses beside a live serial run (`stop`
     it instead), and a serial run refuses to start while the macro has a
     hold that applies (held, pending, or unreadable) or a kept park,
     naming each: release it, or run with `--lanes`. Nor beside a release
     awaiting its comparison (released and not compared, or compared equal
     with its park not ended yet): only a run with lanes compares one before
     its lane steps, so the refusal names that relaunch (amendment of
     2026-10-27). Nor beside a rejected release, its park kept or not (a
     crash before the park was written, a discard): only a new hold and
     release give that lane back, so the refusal names them, as the driver's
     gate does (amendment of 2026-10-27, critique round 5).

## Implementation note 2026-10-28 — impl-events (Decision 4)

The orchestrator's implementation of Decision 4. It adds no guarantee; it
fixes what the decision left to the implementation (the file's lock, the
next `seq`, the run that took part, the reader's terminal rule) and names
where each event is published.

**E1. The writer** (`adapters/claude/autopilot/events.mjs`). The file's lock is
a file beside it, `<file>.lock`, holding its writer's pid and a token, written
to a file of its own and linked into place (which fails when a lock is
there), so it appears whole or not at all and no live writer's lock is ever
read empty. It is taken for one read and one append and waited for up to 2 s
on a clock that moves (never the run's event clock, which a test may freeze),
the bound checked on every retry, whatever sent it round.
One whose pid is dead, or one that does not read and is older than 2 s, is
taken over, removed only while it still holds what was judged (one that
cannot be removed, its directory not writable, is waited on to the bound,
then the write fails and is counted); one whose
writer lives is never taken, however old (a writer suspended holding it
still holds it), and a writer's release removes the lock only while it holds
its own token. The
writer is synchronous, so a process's lines are in the order of its calls.
Under the lock it reads the file and takes as its run's next `seq` one above
the highest it has chosen, its write landed or not, and above every parseable
line of its run on file, a last line with no newline that holds complete JSON
included; a write refused at the lock chose none. `run-ended` is appended only
when the file holds none of the run, and `lane-released` only when no line
holds its release id, each counted only when it is a line a reader delivers
(E5): a forged one suppresses nothing; a writer that finds one appends nothing for it but ends
a torn last line, so a reader holding that line delivers it. A writer closes at
its run's `run-ended`, written, refused or failed, and the driver writes that
line last: after the last handoffs once its locks are gone (Decision 2, item
4), whose `lane-held` is the run's, and after its final output, but before
its open-run record goes. That output never fails the run: the CLI's printer
keeps a write's error on its stream (`absorbOutputErrors`: an EPIPE from a
reader gone, an EIO from a closed terminal, both reported after the write as
an 'error' event, never thrown) and drops the line, so the driver neither dies
short of its `run-ended` nor exits with another code than the one that line
records. Only an embedding caller's printer that throws can still end the run
`error`, exit 1, before the line. A run that ends before it writes that record (a halt or
an error at its start, after it joined the file) has no last handoffs and
keeps its locks until its `run-ended` is written, so a lock entry names its
live driver until then. A lock entry that cannot be removed never stops that
line: it is printed (on the error path, passed over for the run's own error),
and names a driver judged gone once it exits. The driver's signal handlers
stay until after the line, so a signal while the end is notified (a closed
terminal) interrupts nothing rather than killing the driver short of it. Once
it is written nothing changes the run's outcome: what is left (a lock entry,
the open-run record) is removed under a guard, and a warning that cannot be
printed is dropped. No call throws: a failure is returned and counted.
Between the release of its locks and the removal of its record, a run that
ends cleanly still runs (its last handoffs, its notification, its
`run-ended`): `stop` and `status` take a record whose own process is still
its driver (its pid and fingerprint) for a run ending, never one to clean up
after, so stop waits for it within its bound, whether it signalled the run
or found it past its locks already, and status shows no cleanup pending.

**E2. The fields.** Each kind's own, against an allow-list; anything else, a
value outside its set or text, is refused and counted as a failed write. The
codes come from `codes.mjs` (the halt reasons and owner gates the policy
shares) and `events.mjs` (the rest); ids by alphabet (run, macro, subtask; a
hold's and a release's 16 hex; a commit's 40 or 64 hex). A path field
(`run_dir`, `pointer`, `step_record`) names a record the driver writes, and
nothing else: a checkout, absolute and normalized, with no control, format
(a bidi override) or line-separator character, then its
`.agentic-plugins/runs/autopilot/` tree and under it a run's directory
(`<run-id>`, `run_dir` only), one of its records (`<run-id>/` and `run.json`,
`halt.json`, `steps.jsonl`, `lanes.jsonl` or `landing.jsonl`), the macro's
landing log (`landing/<macro-id>.jsonl`) or a lane's kept park
(`holds/<macro-id>/parks/<subtask-id>.json`). `stall`'s `verdict` is one of
Decision 3's `active`, `stalled`, `unknown`, and its `mode` one of `log`,
`on`; impl-stall adds a code to those sets before it writes it.

| Kind | Fields |
|---|---|
| `run-started` | `lanes`, `detector` (`off` until `impl-stall`), `run_dir`, `pointer` (run.json) |
| `halt` | `reason`, `step` (or null), `pointer` (run.json), `step_record` (steps.jsonl, or null) |
| `lane-parked` | `reason`, `step` (or null), `kept`, `pointer` (the kept park, or lanes.jsonl when the records could not take it) |
| `lane-resumed` | `cause` (`record-changed`, `release`, `hold-ended`, `forced`), `pointer` (lanes.jsonl) |
| `lane-held` | `hold_id`, `pointer` (lanes.jsonl) |
| `lane-released` | `hold_id`, `release_id`, `verdict` (`consumed`, `rejected`), `pointer` (lanes.jsonl) |
| `step-failed` | `step`, `reason` (a halt code, or `error`), `abort` (the worker's kind, or null), `pointer` (steps.jsonl) |
| `commit-finished` | `step`, `commit`, `readiness` (`ready`, `needs-sync`, `unknown`), `pointer` (this run's landing.jsonl when the report appended the line, else the macro's landing log) |
| `stall` | `impl-stall`'s: `step`, `verdict` (`active`, `stalled`, `unknown`), `mode` (`log`, `on`), `waiting`, `quiet_ms`, `window_cpu_ms`, `pointer` |
| `run-ended` | `status` (`completed`, `halted`, `error`), `reason` (or null), `exit`, `pointer` (halt.json for a run that halted, else run.json), `cleanup`, `terminal: true` |

*2026-10-29:* impl-stall fixed the two rows it owned: `run-started`'s
`detector` is the run's mode (`log` or `on`; `off` is still read), and
`stall`'s fields are its S7's, the wait's three facts and the window's
unknown time in place of `waiting`.

`hold-ended` is a cause item 3 does not name: a lane a relaunch passed by whose
hold ended with no release (a pending hold withdrawn, a hold retired or
orphaned) is the run's again, which is neither a release nor a change of its
record; one given back by its consumed release is `release`. Each path that
resumes a lane names its cause code itself: none is read from the lanes.jsonl
wording, which a reword would change silently.

**E3. Where each is published.** run.json records `events: {path,
failed_writes}` right after the locks, before `run-started`: a run that took
part is told by it from a launch refused at its locks, which has none. The
driver holds it in memory only once that write succeeded, so a failed write
leaves the run out of the event file in every later record. The
driver prints `events <path>` and `watch: <command>` then. A serial run
publishes `step-failed` beside a step's `finished` line, and for the step in
flight when the run stops on an error; `commit-finished` once the first
landing report after a commit step that passed holds the subtask's commit (a
report that could not be recorded proves nothing, and the commit waits for the
next); its `halt` once halt.json and run.json record it, before its output;
its `run-ended` as E1 says. A run that stops on an error after its halt was
recorded publishes that halt if a record write threw before its publication, and its
`run-ended` (`error`) points at run.json. A run with lanes publishes a `halt` at each
drain, once run.json records the run draining, and the halt that ends it
(an idle end, a refusal, an interrupt no drain published) from the driver's
finish, once run.json and halt.json record it, never before the end's
handoffs, removals and park changes (a record write of finish that throws
first leaves it to the error path, which publishes it once run.json holds
it, then the `run-ended` `error`); each once by what it says (the owner's
interrupt once, any other once per reason and lane);
`lane-parked`, `lane-resumed` and `lane-held` beside their lanes.jsonl lines;
`lane-released` at the comparison, and at the recovery of a consumption whose
park's end failed after it was recorded, or of a rejection, once per release
id, after the run records the recovery in its own lanes.jsonl (`recovered:
true`); `step-failed` beside a lane's `finished`
line, and for each step in flight, or being settled (its worker ended, its
`finished` line not written), when the run stops on an error; `commit-finished` as a serial run does, from a later look's report when
the lane's own did not fetch. A commit step that failed publishes
`step-failed` only.

**E4. A dead run's cleanup** (`dead-runs.mjs`) appends the `run-ended`
(`cleanup: true`) of a run whose run.json has `events`, after it writes that
run.json, with the status and reason it holds then: a run that recorded its
end and died before its line keeps that end; only one still running or
draining becomes halted `interrupted`. The line points at halt.json only when
halt.json holds that halt (the driver's own, or one the cleanup wrote); a
halt.json a driver wrote before it died recording the end is another halt, so
the line points at run.json. The file is the macro's, or the record's
checkout's for a verb chain. A failed write is counted in that run.json.

**E5. The reader** (`events-reader.mjs`, `agentic-autopilot events`) polls
every 500 ms. The file is append-only for anyone who can write it, so the
writer's allow-lists protect it only once the reader holds each line to them
again (`events.mjs` `eventOfLine`): this schema, an identity, a known kind,
the writer's `at`, macro and subtask ids, exactly its kind's fields with
values in their sets (E2's paths and codes), and `terminal: true` on a
terminal kind only; the writer's dedupe takes the same lines, so a line it
counts is one every reader delivers. The CLI prints a path field only when its
checkout is one of the repository's (`git worktree list`, compared by real
path, listed again for a directory not among them, so a relaunch from a
worktree added since the arm is found), and prints it null otherwise (a
directory named by text, or a checkout removed since): the line is still the
event it is, for its cursor and its run's end, as whether a line is an event
never depends on the checkouts there are now. A line
that fails is a `reader-skipped` with its offset alone: it is never printed,
folded into a summary, taken for a run's end or found as a cursor's line. A
`reader-terminal-missing` repeats a run.json `status` only from the driver's
set. A follow whose stdout fails (Monitor stopped, a pipe's reader gone)
stops: the printer drops every line after it, so polling on would serve
nobody. While the file is idle, each poll also writes no bytes to a stdout
that is a pipe or a socket: where the system checks the reader first (macOS)
that write fails once the reader is gone, and the follow stops then; Linux
takes a write of no bytes as done, so there an idle follow notices a gone
reader only at its next line (E6). `<run-id>:0` starts at the run's first line on file or the first
line whose `at` is at or after the run id's stamp, whichever comes first; with
several cursors it starts at the earliest. A file that shrinks or is replaced
by another while followed is a `reader-error`. A run is reported missing its
terminal event when its run.json has `events`, a fresh read of the file holds
no `run-ended` of it on a complete line (a line still waiting for its newline
does not count, whatever it holds: delivery holds it, so the run is reported
until the newline comes; a read that fails, but for a file not there, tells
nothing), no open-run record
or lock entry of it names a live driver (a run holds its locks before it
writes its record, and one that ends before writing it holds them until its
`run-ended` is on file, E1), and no live process holds its cleanup lock. Its run.json is found from its `run-started` line's `run_dir`,
its open-run record, or the checkouts `git worktree list` names
(`--checkout`: that checkout). The runs watched are the cursors' and every run
with a line on file and no `run-ended` there, before the cursor too, until
their `run-ended`: a re-arm from any one line's cursor keeps every run still
owed its end that has a line on file, and a run whose end write failed while
no reader watched is reported at each arm until its end is on file (a session
drops one already handled by its `run_id`). `reader-armed` names the latest
run by its id's stamp, of those on file and those the cursors name. A gap among
folded `stall` lines is still a `reader-gap` line. The stall budget is 20 per
delivery window (the backlog, or one poll's lines); a line passed on between
bursts flushes the summary and does not reset it.

**E6. Limits.** A commit step's `commit-finished` waits for a report that holds
its commit; a run that ends before one publishes none (the landing log keeps
the observation). Taking over a dead writer's lock is a check, then a
removal: two writers that judge the same dead lock at once could both go on,
and choose one `seq`. A lock is left only when its writer died within the few
milliseconds it holds it, and the writers are one run's driver and a dead
run's cleanup, so this is documented, not guarded. A run with no line on file
(every write it made failed) is watched only while a cursor names it: an arm
whose cursors name it reports it once its driver is gone, and a re-arm from
another run's line does not see it. On Linux an idle `events --follow` whose
pipe reader is gone (`… --follow | head -1`) runs until the file's next line,
which, for a macro whose runs have all ended, may be the next launch: end it
yourself.

## Implementation note 2026-10-29 — impl-stall (Decision 3)

The orchestrator's implementation of Decision 3, log-only as item 7 ships it.
It adds no guarantee; it fixes what the decision left to the implementation
(the probe's sources and parse rules, how a window is summed, the sampler's
cadence, how the wait's facts are read, where the watch ends) and names where
each verdict is recorded.

**S1. The probe** (`adapters/claude/autopilot/procs.mjs`). One read of the
whole table: `{ pid, ppid, pgid, key, ageMs, cpuMs }` per process, or a failed
read (`failed`, `timeout`, `parse`, `coarse`). macOS runs `ps -A -o
pid=,ppid=,pgid=,etime=,lstart=,time=` with `LC_ALL` and `LANG` set to `C`;
the CPU time is `[[dd-]hh:]mm:ss.cc`, minutes past 59 included (`298:41.42`),
with no fraction coarse; any line that does not parse fails the whole read
(under ko_KR or de_DE `lstart` is localized, measured 2026-10-29). Linux reads
`/proc/<pid>/stat` after the command name's last `)`, utime + stime only,
`CLK_TCK` from `getconf` once per process, the age from `/proc/uptime`; a
stat that is gone (ENOENT, ESRCH) is an exit, one that cannot be read
(EACCES) or reads malformed is `unreadable`. A process absent from the listing
was not alive throughout it, so the listing is a snapshot on both platforms.
The identity is the pid with `lstart` (macOS) or `starttime` (Linux). The read
and getconf share one 5 s deadline; a read past it answers `timeout` and is
told to stop (the walk at its next process, `ps` and getconf killed at the
same bound), and until it has, a new read answers `slow` and starts nothing.

**S2. Membership and completeness** (`stall.mjs`). A worker's members in a
known table: its children by ppid, every process in its group, every identity
a known table showed as a member, and their descendants, the worker itself
excluded. An identity leaves when a table no longer lists it, unless the
table could not read its pid. A table that could not read a pid is unknown
for every worker, stricter than item 4's "a live member": an unreadable entry
carries no start time, so no pid can be ruled out of a tree by it, not even
one the previous table read outside it, whose pid a descendant may have
reused in between. macOS reads no pid unreadable; on Linux it is a stat that
fails other than by the process's exit, or does not parse. What the rule cannot see stays as §Consequences says: a descendant that
detached before any sample saw it.

**S3. The window.** Each pair of samples is an interval, its CPU the growth of
the identities the earlier sample held plus the CPU of each identity first
seen that started inside the window (its etime within the window, 1 s slack
for macOS's whole seconds), attributed to the interval it was first seen in
(a scan that missed a young process does not lose it; the over-count can only
make a window `active`); one first seen that is older is a baseline only. The
spawn is the first sample, known and empty. An interval is unknown when either
sample is, when it is longer than three sample intervals, when the wall clock
moved more than an interval further than the monotonic one, or when a
member's counter went back. A window sums the intervals that end inside it,
one straddling its start whole (an over-count that can only make it
`active`); any unknown one makes it unknown, as does no sample for over three
intervals (the unknown time it records is the window's at most). A window's
CPU is known only up to its last sample, so `stalled` is decided at a
sample; a stream event or the watch's end turns a verdict `active` or
`unknown`, never `stalled`. The comparisons are in full precision; the
records round to whole milliseconds.

**S4. The sampler** (`stall-sampler.mjs`). One per run, made at its first step
and stopped at its end, ticking every 10 s whatever a read takes: a read
still running at a tick makes that tick `slow` for every worker and starts no
second one; a read past its deadline is `timeout`, and its late answer is
dropped. Each snapshot goes to the workers registered when its read began,
each judging its own tree. A worker registers at its spawn and unregisters at
the watch's end.

**S5. The wait.** `pending_tasks` is the length of the last
`background_tasks_changed`. `tool_running`: a heartbeat whose
`parent_tool_use_id` is a tool a main-thread message asked for (a subagent's
tool is the subagent's), until its `tool_result` or 75 s after its last
heartbeat. `answer_owed`: set at the spawn (the prompt), at a main-thread tool
result and at a task notification; cleared by a main-thread message of the
model and by a result. Every observation judges again, so a stall ended by
activity is recorded at the activity.

**S6. The watch's end** (`worker.mjs`). The watch ends at the close on a
finished report (when it fires, not when it is armed), at an abort, and at the
worker's exit (before its output closes); an idle close of stdin keeps it.
At its end the detector closes with a final verdict and its summary. A sample
or a detector that throws is an unknown sample (`probe-error`); a callback
that throws is the driver's.

**S7. The records.** Each verdict change is a steps.jsonl line `{event:
'stall', seq, lane, at, mode, verdict, quiet_ms, window_cpu_ms, unknown_ms,
pending_tasks, tool_running, answer_owed, why}`, then a `stall` event with the
same values but `why`. The line is written whole or not at all: a write cut
short is taken back (the file truncated to its size before it), so the
step's `finished` line never joins a torn one. The event's fields, which E2 left as `waiting`, are the
wait's three facts and the window's unknown time: `step`, `verdict`, `mode`,
`quiet_ms`, `window_cpu_ms` (null when unknown), `unknown_ms`,
`pending_tasks`, `tool_running`, `answer_owed`, `pointer`; `run-started`'s
`detector` is the run's mode (`off` is still read, from runs before this
release). The `started` line has `stall_detector`, the `finished` line
`stall: {mode, summary, last}` (also on a lane's finished line written as the
run stops on an error), where the summary is `longest_quiet_ms`,
`lowest_window_cpu_ms`, `unknown_ms`, `verdict_counts`, `answer_owed_max_ms`,
`stalled_waits` (up to 20, each `at` and the wait) and
`stalled_waits_truncated`. A line that cannot be appended is counted in
run.json (`stall_record_failures`, written at once), an event the writer
refuses is counted as any; neither changes the step. A `stall` event waits on
no other writer of the event file: written from inside the running step, on
the event loop every lane shares, it takes the lock when it is free and is
refused otherwise (`STALL_LOCK_WAIT_MS`), the step's line its record. `readRun` lists a step's lines in `stalls`,
never merging them into the step; the dead-run cleanup passes them over.
`status` prints the mode, the step clock and each step's summary.

**S8. Upgrade and rollback.** A reader older than this release holds a line to
its own allow-lists, so it skips as `reader-skipped` a `stall` line with the
new fields and a `run-started` naming `log` or `on` (it finds that run's
run.json from its open-run record or the checkouts instead): re-arm a watch
after installing, before the next launch. After a rollback the old reader
reads the files this release wrote the same way; a cursor naming one of those
lines is no line it delivers, so its arm ends with a `reader-error`, and the
watch is re-armed from `<run-id>:0`.

**S9. The modes.** `--stall-detector log` is the default; `on` aborts a
`stalled` step with abort reason `stalled`, which the policy halts
`worker-failed` with the detail naming the quiet time, the window's CPU and
the wait, charged as a timeout is and scoped by Decision 1; with `on` and no
`--step-timeout`, the step clock is 28800 s (`EMERGENCY_CAP_SEC`), and an
explicit one wins whatever the order. The observation configuration (item
7): `--stall-detector log --step-timeout 10800`, or longer.

## Implementation note 2026-10-30 — verify-exec (Decision 5, the driver's half)

The orchestrator's implementation of Decision 5, items 1, 3 and 6 to 10, and
of Decision 6, items 5 and 7, beside the persona's half (`verify-record-cli`).
It adds no guarantee; it fixes what the decision left to the implementation,
and it replaces the explicit refusal `verify-record-cli` added: a run that
offers verification runs a `verify` child's checks, and one that does not
still halts on it run-wide, its detail naming why.

**V1. The offer** (`adapters/claude/autopilot/verify-run.mjs`
`verifyOfferFor`, `roots.mjs` `verifyCapabilityProblem`). Made once at the
run's start, never a refusal: the pinned engineer carries `verify-record-1`
(`scripts/lib/verify.mjs`) and `verify-batch-restart` (`scripts/state.mjs`),
and the declaration parses at `run.json` `git_baseline.head`, read with
`git --no-replace-objects` and no inherited `GIT_*` variable. `run.json`
records `verify` (`offered`, the baseline and the declaration's digest, or
`why` not); each worker of an offering run gets `AGENTIC_AUTOPILOT_VERIFY`
(the baseline) and a seventh line of its rules. The declaration is the
driver's own copy of the parser (`verify-decl.mjs`), held to the persona's by
a parity corpus (`tests/orchestrator/test-autopilot-verify-decl.mjs`).

**V2. The journal and trust** (`verify-journal.mjs`). One file per engineer
workflow under the main checkout's orchestrator state
(`.agentic-plugins/state/orchestrator/verify-journal/<workflow_id>.jsonl`), so
a run in any checkout reads an earlier run's after its open-run record is
gone. Every persona write the driver makes (start, restart, result, end,
pass) is first a line of it, synced, with the write's exact payload (a line a
write that died left torn is taken back before the next is appended, back to
its start however long it is: a start line can near the persona's results
cap); a start
keeps the requesting verb (the child's `verb`), the selection base and the
checks' digest beside it. A stored batch, result, end or answer is trusted
only when a line holds that payload (canonical JSON) for that request and
batch, a carried result only when a line holds it for the batch and run it
names and it is a pass carried into a batch that continues that one (through
the journal's starts, no restart between), every hop on the destination's
tree and with its checks' digest, as the persona carries; anything else sets the request's whole record aside in one
`verify-batch-restart` over its `results_digest`. An intent the record does
not hold is a write that may not have landed: the write is made again, or,
for a result, the check runs again. A request is run only when its run and
step are a `started` line of that run's `steps.jsonl` for the subtask, in
the driver's checkout, the main one or, failing both, any checkout `git
worktree list` names (a run launched from a linked checkout keeps its ledger
there): a request a worker wrote by hand, naming a step no run took, halts
the lane. The driver's persona writes run with no
`AGENTIC_AUTOPILOT*` variable and no state base: they are an owner's writes to
the attempt mark. The journal tells the driver's writes from a record edited
alone, not from a forger: it lives in state a worker's process can write, so
matching edits to the record and the journal pass (a limit, below).

**V3. What a step does** (`planVerify`, pure). On the record as the persona
holds it, the journal and the lane's tree digest now (Decision 2's):

| The request's latest batch | The step |
|---|---|
| none, and the workflow's last batch the journal ended passed or failed has these checks (the driver's additions included) and this tree | halt the lane `no-progress`, nothing runs (`--next verify` runs it once) |
| none otherwise | a batch |
| open (a driver died) | end it from its trusted results, as `endProblem` takes them: the last failed, `failed`; a timeout, `no-evidence` cause `timeout`; not started or refused, `no-evidence`; all passed, `passed`; none yet, or a check stopped, `cut-short` `driver-end`; another tree `tree-changed`, an unreadable one `tree-unreadable`; then judge again |
| `cut-short` | a batch that continues it (the persona carries the passed results when the tree and the commands are the same) |
| `passed`, on the tree it started on | `verify-pass`: `on_pass` is the next step |
| `passed` on another tree, `failed`, `no-evidence` | the step writes a `resume` line (no persona write), and the policy dispatches the requesting verb from it |

The table is judged before any new batch is prepared, so a batch to end or
follow never waits on a selection or a declaration that would refuse a new
one. The policy (`policy.mjs` `classify`) takes from the journal
(`verifyFacts`) what it cannot compute, and never judges the record itself:
a pending request whose latest batch, as the record names it, has a
`resume` line yields the requesting verb, and only while the record is the
one that line was decided on (the line keeps the digest of the request and
its results, `recordDigest`, which the child's summary carries): the step
writes it only after the whole record passed the trust check, and a record
edited since is the next step's to set aside;
an answered request (`answered_by`) whose next step is still its `on_pass`
yields the requesting verb instead when the lane's tree changed since the
batch passed, or when the journal holds no such pass or cannot be read (P7),
until the next worker's first write clears the next step, and never over the
recovery of a commit the `on_pass` began (that commit kept the answer and
changed the tree): `/engineer:commit` recovers it; these facts are
read whether or not the run offers verification. Below `HIGH` a request halts
`low-confidence`; a run that does not offer verification halts `owner-choice`,
run-wide. A verification step that changes nothing twice on one request
halts its lane `no-progress`.

**V4. A batch** (`startVerify`). The checks are the request's, each resolved
again against the run's declaration and the lane's tree, and the driver's
additions (`verify-select.mjs`, against `git merge-base HEAD
refs/remotes/origin/<integration>`, the local branch when there is no remote
one, the run's baseline when neither reads), placed before the worker's first
check whose kind takes the heavy-work lock itself, else last. Over the
persona's worst-case results size the driver's `test` additions widen to
`test-suite`; still over, or a check that does not resolve, the lane halts
`owner-choice` and nothing is written or run (P15). Each check: an idle
supervisor (heavy-run.mjs's) leads a new process group in the lane's checkout,
with the worker's environment minus `AGENTIC_AUTOPILOT`, its token, step,
offer, state base and any heavy-lock proof; the group is put on the run's
locks as a worker group of its lane (the macro lock and the lane's or driven
checkout's) before the supervisor's go, and a registration that fails kills it
with nothing run; a hold, a drain or the driver's signal that came meanwhile
stops it before the go. A throw while it is supervised kills the group first. The supervisor runs the wrapper (`heavy-entry.mjs`, the
CLI's `heavy` with no driver loaded) with `--status-file` and `--go-file`, or
the command itself when it takes the lock itself. The wrapper, once it holds
the lock and has its command's group registered, idle, writes `ready` with
that group, and starts the command only once the go file exists: the driver
reads the holds and the drain, puts that group too on the run's locks as a
worker group of the lane, reads them again, and only then writes it, so a
hold or a drain that comes while the check waits for the lock, its
acquisition included, stops it with nothing run. A ready line the status
file does not take is no go: the wrapper kills its idle command group and
refuses (125). The declared timeout runs from that go (from the supervisor's
go for a command that locks itself); the whole wait for the go, the lock's
and the ready line's, is bounded at 8 hours and ended by a hold or a drain; the batch has
6 hours of running checks. A stop is SIGTERM to the wrapper's group, which
the wrapper passes to its command's, then SIGKILL to both after 5 s; either
group, or a supervisor that does not exit, still there 5 s later is no
result, and the run halts run-wide with its locks kept, the group's id
carried on the error when the supervision itself threw. Outcomes: the status file's (or the supervisor's) `code` 0
passed, any other code or a signal failed, `error` not-started, `refused`
refused, a stop stopped, a bound timeout (cause `bound`). The failing tests are
the TAP `not ok` and spec `✖` lines of the check's log
(`runs/autopilot/<run>/verify/<batch>/<index>.log`), at most 20 of 200
characters, never cut inside a surrogate pair. A hold, a drain (with lanes, an
exhausted budget too) or the driver's end is read before each check, and
before the batch's start or restart: one that came while the batch was
prepared (the persona read, the tree digest, the selection) starts none, and
the step yields (`stopped`, its cause) with nothing more written, the request
waiting; a start the persona refuses is read again the same way, and a
refusal for a held lane is a hold whatever the read says by then, so a hold
that came between the driver's read and the persona's yields too, withdrawn
or released before the refusal reached the driver or not. An owner's rerun
the step carried stays for the batch that runs. The cause
rides on the step's result, so its settle parks nothing whether or not the
hold is still set by then. A yield the driver's own read saw is the owner's
hold (or a drain), however often holds come and go. A yield that only the
persona's refusal explains (the step's `refusal`), with no hold, drain or
spent budget the run reads at the settle either (a hold withdrawn since, or a
holds marker the persona cannot read), is decided again; with lanes a second such yield in a row on the same request parks the
lane `no-progress`, each lane keeping its own last step that changed nothing,
and a serial run, which honours no hold, halts `owner-choice` on the first: a
batch is no step of `--max-steps`, so nothing else would bound it. Only the
driver's signal stops a running check.
The tree digest is taken as the batch starts and as it ends.

**V5. In the run.** A batch takes a seq and two lines of `steps.jsonl`, kind
`verify`, cost 0; no reservation, no `run.steps` (now the worker steps the
budget counted), no `accounted_seqs`, no event. An exhausted budget starts
none, and the request stays for the relaunch. With lanes (`scheduler.mjs`) the
decision's `verify` steps form the queue each turn, ordered by the request's
`recorded_at`; one batch at a time, outside `room()`; each admitted to its
lane as a worker step is (`launch`): a lane the run does not hold is made for
it, a persona operation open in it holds it back (Decision 1, item 6), an
owner's rebinding due is told before it (Decision 8, item 4), and the plan's
approval and the lane's checkout are read; the throttle of new workers does
not hold it back, and, spawning no worker, it does not make its lane one the
run started: the lane's first worker of the run is still a new lane's, which
the throttle gates; it writes no in-flight marker (a run that dies during
it leaves the batch open, which the next run's step ends from the journal,
where a marker would park the lane); its lane is left out of
the decision while its batch is open; the owner's interrupt is judged before
what the batch returned and after the run's look at the lane, as a worker
step's is, so a Ctrl-C that fails the batch's persona write, or comes during
that look, drains the run and parks no lane (Decision 1, item 1); a hold's handoff waits for it, a queued
request does not; the run does not end before it; its tree digests and
selection run off the loop (`offloop.mjs` `verifyTree`, `verifySelect`).
`status` shows each batch's end and how many checks ran, and `run.json`
`verifying` a lane verifying or waiting for the lock with its holder.

**Limits, documented and not fixed** (the owner's ruling of 2026-10-25 on
uncommon cases): a request whose run was launched from a linked checkout
removed since is unknown, its ledger gone with it, and halts the lane. The
`stop` command stops a batch as the
driver's signal does, recorded cut short by `driver-end`, not `stop`. A tree
digest that cannot be read before a batch halts the lane rather than binding
a batch to it. The owner's explicit rerun reruns a pending request (one
recorded again after a pass or a failure, which the repeat rule would halt),
not an answered one: once `verify-pass` made `on_pass` the next step, the
persona's batch writes refuse the request, so an answered request is rerun by
a verb recording it again and `--next verify`. A worker that orders its own
mutation run before its own tests keeps that order (the persona refuses a
batch whose worker checks are reordered); the harness refuses a mutation whose
control is not green. Preview tells the policy the offer a start would make,
not the journal's facts. The journal is no provenance a worker cannot write
(V2): a worker that edits both its record and the journal to match forges a
pass the driver takes (`passed-before`, then `on_pass`) for checks it never
ran; the trust check catches a record edited alone, the natural failure, not
a deliberate forger with write access to the main checkout's state. Two cases are held by construction, not by a test:
a group that outlives SIGKILL after a throw in the supervision (no test can
make a group unkillable), and a real driver killed while a check runs or
waits for the lock (the check's groups are worker entries of the run's locks,
which every reader judges by those groups).

Tests: `tests/orchestrator/test-autopilot-verify-{decl,run,driver,lanes}.mjs`,
the `--status-file` and `--go-file` cases of `test-heavy-lock-wrapper.mjs`, and the refusal's
updated suite; each new case is bitten by a mutation of
`scripts/mutation-specs/verify-exec.mjs` or `verify-exec-driver.mjs` that
names it in `killed_by`. The owner's rerun is tested end to end, serial
(`--next verify`) and with lanes (`--lane A --next verify`), from the CLI's
parse to the batch; a hold set while a lane's batch is prepared, with the hold
protocol on and withdrawn before the settle (seen by the driver, or told only
by the persona's refusal; and two in a row, each seen by the driver), a rerun that yields to such a hold, lock
contention between two lanes (lane B's worker holding the heavy-work lock
while lane A's batch waits for it), a start refused for a hold the run does
not read (a holds marker the persona cannot read), and a lane whose only step of
the run was a batch meeting a closed throttle, are tested end to end with
lanes; a start refused as a held lane's in a serial run is tested end to end
too; and the step's recovery of a pass whose driver died before
`verify-pass`, on the tree it passed on, on the real persona CLI. The verify
fixtures scrub the inherited `GIT_*` names and
put back the git isolation every autopilot fixture carries (no system or
global config) for their own git and the processes they start, which a probe
of the isolated global file proves; the driver's own reads (the declaration,
the selection base, the tree digest) drop every inherited `GIT_*` name by
design, the isolation's included, and write nothing.

## Implementation note 2026-10-31 — verify-runbooks (Decision 5, item 1: the runbooks)

The persona runbooks' half of Decision 5, item 1, beside `verify-record-cli`
and `verify-exec`. It adds no guarantee; it fixes what the decision left to
the implementation, and only where the persona renders the verify form:
engineer, the one persona with `dispatch_target` on (designer and founder
render none of it, their runbooks unchanged).

**VR1. The check before the first write** (`state.mjs verify-request-check`).
A finalize's first write is the peer run's settle, and its note follows; a
request that `finish-verb` refused after them would leave half a handoff. So
the finalize checks the request first with the last write's own checks: one
function (`bindVerifyRequest`: the offer, the newer-record refusal, the
workflow's state, the tested tree, each check against the declaration at the
offer's commit, and the record a new request becomes, held to its size cap
and to the stored record's own reader, `validateStoredRequest`) serves the
check and the write, so they cannot drift, and the
check refuses with the write's message and writes nothing. It counts every
pending peer run but the one the finalize settles first
(`--settling-run-id`). A refusal by the write itself after the check passed
(a change between the two, the attempt mark) is the window every multi-write
block has.

**VR2. The verify form** (`regions/verb-finalize.md` and its consensus and
convergent variants, inside `dispatch_target`). A `verify-request.json` the
agent wrote in the finalize's text directory selects it: the block checks it
before settle (a conflict verdict takes none, and neither does any other
owner gate, since the driver would run `on_pass` past the judgment: the block
refuses a request beside `OWNER_GATE`, a variable the step sets to the gate it
ends on; decide's owner selection or veto records `decide-conflict` under its
ordinary synthesis heading, so only the variable names it), keeps its sha256 beside
`finalize-run.json` (`finalize-verify.json`, null for the verb form) just
before settle, once every other check has passed (a run they stop keeps none,
so the same text directory may then add a request), so a rerun after a write
takes the same form and the same request and stops before any write when the
file was added, removed or changed since,
and its last write is `finish-verb --next-step-kind verify
--verify-request-file`, with the operation directory, the next action and the
proposal's confidence. Without the file the verb form is unchanged. The form
renders in every engineer verb's finalize, compose, refine and critique
included, since the templates are shared: a verb with no long check simply
writes no request. In the consensus variant it lives in the non-conflict
branch only. A request entry the check cannot read (a dangling link) refuses
rather than reading as the verb form.

`OWNER_GATE` is also what records the gate: set, it selects a third form of
the last write, `finish-verb --next-step-kind owner-decision --owner-gate
"$OWNER_GATE"` with the anchor the gate list names, in place of the verb and
verify forms (in the convergent variant, of the not-converged one too), so the
selection and the write are one edit, not two. Before settle the block refuses
a gate the verb does not end on with that form (refine's `recurring-finding`
and decide's `decide-conflict` belong to those verbs; a conflict gate is the
conflict branch's, through `VERDICT`), a gate beside `VERDICT` `conflict`
(consensus), and a note holding the heading of `recurring-finding`,
`scope-routing` or `pr-handling` (flush or indented by up to three spaces, with
any run of blanks after its `###`, as CommonMark reads a heading) while
`OWNER_GATE` is empty. The commented
owner-decision form stays only in the personas without `dispatch_target`.

**VR3. Results on resume** (`regions/verb-resume*.md`). After its append, a
verb's Phase 0 prints `state.mjs verify-results --current-tree true --format
text`: the request, its latest batch's end and cause, each check's kind and
command, outcome, whether it is evidence and whether it applies to the tree
now, at most five failing tests and the log under the recording run's
directory; nothing with no request, for which no tree is read.
`--current-tree` takes the digest of the
checkout it runs in as the driver takes a batch's (`currentTreeDigest`, a copy
of the orchestrator's `lane-digest.mjs` `treeDigest`, version 1, held equal by
a parity test), so a result `applies` only on the tree it was recorded for. A
read that fails (a record a later release wrote) warns and the verb goes on;
a later release's attempt mark still refuses the append itself, as before.

**VR4. The long-check guidance** (`regions/long-checks.md`, engineer's
compose, refine and critique commands and skills). Quick checks are a few
test files the change touches, minutes of work; long ones are the whole
suite, a broad `npm test`, a test file known to run long and every mutation
run. Under an offering run the step runs only the quick ones, hands the long
ones over with the verify form and never waits for the heavy-work lock;
without the offer, as before; interactively, a long check runs under
`agentic-autopilot heavy --` (a `locks_itself` command directly, and with no
orchestrator installed, directly). Which branch applies the step reads from
Phase 0's preflight banner: under an autopilot run its last sentence says
whether the run offers verification (`autopilot-preflight`, from the offer
`finish-verb` checks). The verify form, which renders in decide, frame and
investigate too, points at § Long checks in compose, refine and critique,
the runbooks that carry it. The skills carry it because
`/engineer:start` runs the skills, not the commands; their "run the test
suite" lines point to it. `autopilot-mode.md` gains § Verification: `verify`
is a request-mediated handoff, not a proposal kind (the closed-enum table is
unchanged), `on_pass` is the step after it, and the repeat rule is the
driver's (`no-progress`, the owner's `--next verify`).

Since 2026-11-11 the three commands render a short form of the guidance
(`regions/long-checks-command.md`): the quick and long sort, each session's
branch in a sentence, and a pointer to the skill's § Long checks, which keeps
the whole text (`regions/long-checks.md`). A command follows its skill, so the
whole text was read twice on every step.

**VR5. The worker's rules** (`worker.mjs` `systemAppend`). Under the offer,
rule 4 keeps peer ensembles as background tasks and sends long checks to
rule 7, which names quick against long and tells a resumed verb to read the
printed results first; without it, both rules are as before.

**VR6. Limits** (the owner's rule of 2026-10-25: a case that needs a
hand-made or exotic arrangement is recorded, not fixed). The gate-heading
check also matches a heading quoted in a fenced example inside the note: it
fails closed (the block stops with nothing written, and its message says
what to do). Interactively, with another owner gate already pending, the
owner-decision form's `finish-verb` refuses after settle and the note
("owner gate … is already set"), so a rerun appends the note twice; the state
stays consistent, autopilot never meets it (its preflight refuses a pending
gate first), and the commented form it replaced refused at the same point.
In the convergent variant, a checked request with `CONVERGED` not `yes`
and no gate is dropped for the not-converged branch: latent, since only
designer renders that variant and it has no `dispatch_target`.

Tests: `tests/persona-pipeline/test-verify-runbooks.mjs` (the engineer
blocks run in bash on a macro's child with the operation Phase 0 opened: the
verify form, the verb form, each refusal before any write, the rerun binding,
the results on resume, the digest parity, and the prose: no instruction to run
the suite outside the guidance), `test-verify-record.mjs` (the check refuses
what `finish-verb` refuses, with its message), the Phase 2 and Phase 0 cases
of `tests/plugin-shape/test-engineer-autopilot-runbooks.mjs` (and, per the
decision, no engineer runbook block runs `npm test` or a mutation run), the
characterization fixture's `VR` differences, and `test-autopilot-worker.mjs`.
The behavioural guarantees are bitten by the mutations of
`scripts/mutation-specs/verify-runbooks.mjs`, each naming the case that kills
it in `killed_by`: the check (K), the verify form, among them a real peer run
settled before the request (F), the results and the digest (R), the guidance
(G) and the worker's rules (W). The plugin-shape cases are position pins of
the same branch, with no mutation of their own. `consensus-proposal.mjs` R3,
`persona-pipeline.mjs` M1 and `verify-record.mjs` Q5 keep their defects on
the anchors the verify branch moved.

## Implementation note 2026-11-01 — impl-instruct (Decision 7)

The orchestrator's implementation of Decision 7, one release of the
orchestrator package (item 9: the persona's existing `append` applies an
instruction, so no persona changes). It adds no guarantee; it fixes what
§Left to the implementation (slice 4) names.

**II1. The record** (`scripts/lib/instructions.mjs`). One file per subtask,
`holds/<macro>/instructions/<subtask>.json` (`agentic-instructions-1`), a
record kind beside the holds, written whole under the holds lock. Its
`entries` keep the lane's instructions in the order written; each has a
16-hex `id`, a `revision` from 1, the `branch` and `child` it was written for
(`null` before the dispatch), its `step` (the forced-step grammar less the
dispatch and the rerun, restated from `policy.mjs` and held equal by test),
the note itself with its sha256 (at most 16 KiB, strict UTF-8, no NUL, read as
the engineer reads `--phase-note-file`: one trailing newline removed), the
child's gate witness at the write (`awaiting_owner_gate`, and the count of
`### Owner gate resolved: <gate> at <iso>` headings outside the owner's
notes an application appended to that child, II10 and II11), and its `state`:
`pending`, `applying` (naming its receipt), `applied`, `superseded` (cause
`later-step` or `gate`), `dropped` (its cause) or `withdrawn`, with the
acknowledgement (when, by what, the application id, the step it replaced).
The transitions are a table, as the holds' are. A revision replaces a pending
entry in its place and is refused unless it names the current revision; an
entry being applied, or ended, is neither revised nor withdrawn. Every reader
answers with a code (`dir`, `file`, `parse`, `schema`), never an excerpt: a
JSON.parse message quotes the text it failed on. The wake source's digest is
the sha256 of every record's name and what the owner writes in it (each
entry's id, revision and whether it is withdrawn; a record the readers
refuse, its bytes), so a run's own reservation, application, rollback or
drop wakes nothing (II14). A record keeps at most 64 entries.

**II2. The application** (`scripts/lib/instruct-apply.mjs`), one transaction
with a durable receipt. Under the holds lock the applier reserves the lane's
pending entries bound to the child (`applying`) and writes a receipt beside
them (the entries, the effective step, the supersessions, the child's next
step it replaces, the child file's sha256, its own pid and fingerprint); it
releases the lock (I2: never held across a persona lock), checks the child's
bytes are still the reserved ones (a write that slipped in rolls the
reservation back, and the next boundary judges the child as it is), runs one
engineer `append` (`--phase-label "Owner instructions <application id>"`, the
notes as one phase note, `--once-operation checkpoint`, and the effective step
at HIGH), reads the child back for the heading, and under the lock finalizes
the entries and the receipt. The next application reconciles a receipt a
crash left `reserved` before anything else: the heading on the child
finalizes it (never written twice), its absence with the applier gone rolls
the entries back to `pending` (never lost), and an applier still alive is
waited for. The ended receipts kept are the last 16. Precedence: an entry
whose witness differs from the child's now has its step superseded (`gate`),
its note still appended; of the rest the last step wins, the earlier ones
superseded (`later-step`). Limit: the window between the byte check and the
engineer's own lock is not closed; a write landing there is a session's, which
opens a persona operation the boundary check sees at the next look, and its
step stands until then only if the engineer orders it after the append.

**II3. Binding and drops.** An entry applies to the child it names. A note
written before the dispatch binds to the first child linked to the subtask on
its branch whose id time is at or after the write's second, active or
archived, and never to a later one (a same-second child created before the
write would bind too: a limit). The lifecycle sweep, before each application,
drops a pending entry whose subtask left the plan (`left-plan`), is completed
(`completed`) or closed (`closed`), changed branch (`branch-changed`), whose
child archived (`child-archived`) or was replaced (`child-replaced`); homes
that cannot all be read, or two active children, drop nothing.
`/orchestrator:done` drops with `completed` (a subtask with only an
instructions record retires it too), and the macro's end drops every pending
one (`macro-ended`) before its holds directory goes, the summary returned to
the caller, which prints it (done, finalize, abort, status).

**II4. The boundary.** `boundaryRefusal`: held or a release uncompared
(`holdGate`), a persona operation open, a peer settlement pending, a
verification batch the child records started and not ended (II13), a commit
begun and unfinished (`phase-7-commit` or terminal). The run adds what only it
knows: a step of the lane in flight, a verification batch started and not
ended (the serial driver and the scheduler keep the lane whose last check left
its batch open), and, for an instruction written after the run took its
forced step, that untaken forced step (one already pending then is applied
before it, II13). The command adds a dead run's
leftovers (`laneBusy`). Before applying, the macro's holds protocol is turned
on (`activateHolds`), so the write is a visible operation in every mode; where
the persona cannot make it visible the instruction stays pending
(`inactive`).

**II5. Who applies.** `state.mjs instruct-apply` (`applyLaneInstructions`)
joins an admission of `instruct` (a new ADMISSION_COMMANDS member): the owner
command with no run live holds the macro lock while its fenced writer (as an
approval's note) writes, so no run starts beside it; a run's worker passes on
the run's own lock. A run starts it idle (`--await-start`) as a worker group
of its locks (`instruct-boundary.mjs`, `rebind-boundary.mjs runHeld`), and the
engineer append runs outside the run's step numbering (`personaEnv`, P9). The
serial driver applies at the top of each turn, before the decision, and decides
from a fresh look; the scheduler applies before its parked lanes are judged
again, nominates a parked lane it changed, and retries a lane its last attempt
left as it was at most once per tick. An application's step carries
`instruction_application` on its `started` ledger line; while the child's next
step is the application's and its bytes are the ones it left, the policy's P7
guard of an answered request is passed over for it, so the instruction's step
replaces `on_pass`.

**II6. Records.** The event kind `instruction` (`action` applied or dropped,
`application_id`, counts, `step_set`, a pointer to `lanes.jsonl` or
`steps.jsonl`); the `instruction` line of `lanes.jsonl` and of the serial
run's step ledger (codes and ids); `halt.json`'s `instructions` (each entry's
id, revision, state, step, cause and application); `status --macro` (states
and outcomes, the note's size only, and for an applied step whether a run's
ledger shows it ran, or a later application replaced it before it ran); and `run.json`'s `instructions-1`, which
every run of this release records. The owner command writes no event.

Tests: `test-instructions-records.mjs` (the record, the grammar held equal to
the forced steps, the note's bounds, the codes, the witness, the digest, the
retirement), `test-instruct-apply.mjs` (the transaction through the real
engineer `append`, the precedence, the crash before and after the write, the
binding and the drops), `test-autopilot-instruct-cli.mjs` (the command, its
refusals, its own application, a held and a released lane, a persona that
cannot make it visible), `test-autopilot-instruct-serial.mjs` (an idle lane,
a lane mid-step, a forced step) and `test-autopilot-instruct-lanes.mjs` (a
parked lane within the poll, the event, a relaunch's `--lane --next`; the
serial file also a run ending after an application and before its step). Each is
bitten by a mutation of `scripts/mutation-specs/impl-instruct.mjs` naming it
in `killed_by`. **II7. What the code review found** (Plan-verify of the code, 2026-11-01),
each fixed and, but for the two named below, pinned by a mutation of group P:
the public application reconciles a crashed receipt before any other exit
(an entry left `applying` was otherwise stuck); the due list adds every
record of a subtask the plan no longer holds, so the sweep drops it
(`left-plan`); the macro's end keeps every instruction's outcome beside the
holds root (`holds/ended/<macro>.instructions.json`), which `status` and
`halt.json` read once the directory is gone, and a run's own retirement
publishes what done dropped; a step's provenance is read from the receipts
and the child (the latest application that set a step, with no `### Phase 0`
heading after its own), so it survives a relaunch and names an owner's
application, in both modes; the boundary takes only a commit phase for an
interrupted commit, as the policy does, never an interactive verb's terminal
end; each note is appended inside a fence longer than any backtick run it
holds, so a fence or a heading in it neither hides nor forges a gate
resolution; and the scheduler applies again after a release's comparison,
before the lane is decided, and passes the P7 guard over for an instructed
step as the serial driver does (both tested since, II8).

**II8. What the slice's critique found** (2026-11-01), each fixed and pinned by
a mutation of group F:
- The serial run's `instruction` line in its step ledger carries the seq of
  the step about to start; `readRun` and the dead-run cleanup now keep it out
  of that step's record (`readRun` lists such lines in `instructions`), so a
  step in flight still reads as started and is settled when its run dies.
- A failed `instruct-apply` command parks the lane once: the scheduler does
  not try it again while the lane stays parked on a record left as it was
  (the owner's change of the record, or the lane's release, tries again), so
  the other lanes are decided.
- An application left pending for a reason that may pass (`waiting`,
  `failed`, `unreadable`; `instruct-boundary.mjs` DEFER_STATES) defers the
  lane's recorded step, and in a serial run its judgment halt: the scheduler
  takes the lane as parked in that decision and tries again at the next
  tick, waiting for it before an idle end; the serial run waits
  (`INSTRUCT_RETRY_MS`) and decides again at the same seq. After the third
  attempt on the same record (`INSTRUCT_DEFER_TRIES`) the lane halts
  `owner-choice` with the reason, the instruction still pending. `inactive`,
  `not-at-boundary` (an interrupted commit runs again) and `no-child` leave
  the lane decided as before.
- The recovery rolls a crash's receipt back only on the positive absence of
  its heading: a persona home or a child copy that cannot be read keeps it
  reserved (`waiting`), and so does an application whose child cannot be read
  back after its append, so a note is never appended twice.
- The P2 scan for a worker's step since an application walks each
  application's own note to its end through its fences, so a `### Phase 0`
  heading the owner quoted is not taken for a worker's; the rest of the child
  is read as before.
- The refine's own verification (peer run
  refine-verify-20261101T102042Z-91591d) found three more, fixed the same way:
  a record that cannot be read was skipped by the due list, which forgot its
  deferral, so the old step ran over it — it is due now (`unreadable`), the
  application is tried, and the lane halts naming the record to repair; the
  recovery took a child not found for absence, and read only the first root's
  copy of a child — it now reads every copy under every root
  (`linkedChildren` `allCopies`), and keeps the receipt reserved when none is
  found; and a later note quoting an application's heading could start the
  scan inside its fence — the scan now starts at the heading's first
  occurrence (its id did not exist before the append) and enters an
  application's note only there. The halt of a deferred lane names its
  release, which a run with lanes needs to give the lane back (a withdrawal
  changes nothing its park's fingerprint reads).
- Tests added: the step ledger read back, a failed command and a deferred
  application with lanes (another lane running, and none), a record that turns
  unreadable in either driver, a deferred application that applies at its
  retry starting one step at the seq it waited at, a deferred application and an interrupted commit in
  a serial run, the receipt beside an unreadable child, a child not found and
  a stale copy under an earlier root, the quoted Phase 0 and the quoted
  application heading,
  the scheduler's application right after a release's comparison, and the P7
  guard passed over for an instructed step in either driver
  (`test-autopilot-verify-driver.mjs`, `test-autopilot-verify-lanes.mjs`).

Not yet tested here (all but the draining run tested since, II9): a lane kept
between its batch's checks and while the
batch waits for the heavy-work lock, a queued request or a
hold-cut batch replaced by a step, and a draining run applying nothing (the
loop's drain block continues before the application pass, so the pass's own
`draining` guard is equivalent and not mutated). Limits: a child file that
vanishes between the listing and its read in the recovery is kept reserved
by a branch no test reaches on demand; the tick's wake for a deferred lane is
not mutated (a mutation leaves a run waiting with no wake, a timeout, not a
verdict).

**II9. What the slice's second critique found** (2026-11-01), each fixed and
pinned by a mutation of group G:
- The scheduler skipped a lane whose attempt applied nothing for a whole tick
  on a record left as it was, whatever the attempt met: a lane at no boundary
  (an operation open) whose boundary opened within the tick was decided with
  its recorded step, which started over the instruction. Now the skip follows
  the attempt's result: `not-at-boundary` is tried at every call (the
  boundary opens at any time), `no-child` and `none` once per loop pass (a
  step's end starts a new one), `inactive` and a deferral once per tick, and a
  failed command not while its lane stays parked on that record. A result
  that stays the same is printed once. That only narrowed the race: an
  operation that closes between the last attempt and the step's start still
  let the step run first (the refine's peer, refine-verify-20261101T143310Z-170659,
  reproduced it, and in a serial run a step ran with the operation open
  throughout). So a `not-at-boundary` result now says whether the lane's own
  step is what the instruction waits for (`step_first`: an interrupted
  commit runs again, a pending settlement is the step's to settle;
  instruct-apply.mjs boundaryState): with it the lane is decided as before;
  without it (an operation open, a hold the writer saw, a child that cannot
  be read) the lane's recorded step waits as a deferred one. A run with lanes
  tries it at every call and parks it, naming the reason, after as long as it
  waits for a lane laneBusy holds back; a serial run counts it as any
  deferral (INSTRUCT_DEFER_TRIES).
- Reads that could not know were taken for "nothing to do", the mirror of
  II8's: a workflow home or file that cannot be read (any persona's, workflows
  or archive: the entries' child may be in it) made every entry unbound, so
  the application read `none`; the lane's own child whose file cannot be read
  read as `no-child`; and worktrees git cannot list narrowed the search to
  the main checkout, where a child in a worktree's state root went unseen.
  Each now answers `waiting` (DEFER_STATES), naming what could not be read,
  and the owner's `instruct` refuses a write while the worktrees cannot be
  listed. An instructions directory that cannot be listed makes every open
  subtask of the plan due, `unreadable`, where it made none due: which lanes
  have one cannot be told. Found by the refine's peer, the same way: a child
  file linked to the subtask that names no workflow id was skipped, so a
  child still active read as gone and the sweep dropped its instruction
  `child-archived` (it is now counted as a file that cannot be read); and an
  entry left `applying` that no reserved receipt names (a record edited by
  hand) read as nothing pending (`none`): the application now waits, naming
  the record to repair.
- Tests added: an unrelated archive file, the lane's own child and the
  worktrees list that cannot be read (`test-autopilot-instruct-cli.mjs`); the
  directory that cannot be listed (`test-instructions-records.mjs`); a lane
  whose boundary opens within the tick (`test-autopilot-instruct-lanes.mjs`);
  and, beside verification (`test-autopilot-verify-lanes.mjs`), an
  instruction written while a started batch waits for the heavy-work lock and
  then between its checks (kept until the batch ends, which runs whole, and
  its step then replaces `on_pass`), a queued request replaced by a step and
  run after a note alone, and what is left of a batch a hold cut short
  replaced by a step and run after a note alone, the instruction applied once
  the release is compared; a lane at no boundary kept from its recorded step,
  and one whose own step comes first decided as before, in a run with lanes
  and a serial one; the id-less child and the orphan `applying` entry. The
  open-batch test writes a second instruction while the batch's checks run,
  which wakes the loop there: without it no turn looked at the lane during
  the checks, and a mutation protecting the batch only while it waits for the
  lock survived (the peer's).

Limits: a lane's batch is kept from the application by the scheduler's
in-flight set (`verifyActive` is in it) as well as by its batch
exclusion; the exclusion's `openBatches` (a batch whose handle ended with
no end recorded) is reached by no test on demand. The verify queue's own
drop of a request the decision no longer gives is not mutated: the batch's
admission reads the child again and starts none for a request no longer
pending, so a mutation of it is equivalent. Severity reads left with the
owner (the window between the byte check and the engineer's lock, receipt
pruning, retirement beside a reserved receipt) stand as II2 and the MINOR
findings of the second critique say. The fail-closed reads are broad: one
unrelated file that cannot be read in any persona home keeps every
instructed lane of the repository waiting, and parks it after the third
attempt naming the file; a narrower proof (an explicitly bound child found
active) would spare those lanes, and is not taken. The queued-request tests
wait a fixed second after B's dispatch ends for the decision that queues it:
on a machine slower than that the instruction applies before the queue, and
the test passes without testing a queued request (the peer confirmed the
queue on this machine).

**II10. What the slice's third critique found** (2026-11-01), fixed and
pinned by the mutations of group N. The gate witness walked fences across
the child's whole body, so one fence a worker's note left unclosed hid every
later `### Owner gate resolved:` heading. An instruction written before a gate
that was set and resolved then kept its step over the owner's resolution: the
precedence item 5 names. The review's peer reproduced this end to end. The
P2 scan (workerStepSince) already read the child by the rule this needs.
That rule now lives in one place, instructions.mjs linesOutsideApplications,
and both scans read by it: the fences of an application's note, which the
orchestrator built, are walked to the note's end, and every other line is
read as it is, so an unclosed fence in a worker's note hides nothing after
it. Since a worker's fences no longer hide what they quote, the witness
counts only the heading's whole shape as awaiting-owner-clear writes it
(`### Owner gate resolved: <gate> at <iso>`). A shorter line opening with the
words is not counted.

The refine's peer (refine-verify-20261101T172448Z-543b20) then found the
same blindness one step over. The scan took a heading for an application on
its shape and its first occurrence in the child, and a worker's closed fence
quoting another lane's application heading is that heading's first
occurrence there. The quote's closing fence then opened a fence, which hid
every later resolution and Phase 0. That was in workerStepSince before this
refine as well. Now a heading is taken for an application only when its id is
one of the lane's own (laneApplicationIds, the receipts of the subtask's
instruction record), and still only at its first occurrence. Every reader
passes those ids. The owner command reads the record for the witness it stores
(and refuses the write while the record cannot be read: whose notes are the
owner's cannot be told). The application reads the ids from the record it
holds under the lock, and instructedStep from the record it read. So the
witness at the write and at the application are read by one rule.

Tests added: a resolution past a worker's unclosed fence, before and after an
application's note, and past a closed quote of another lane's heading
(`test-instructions-records.mjs`, `test-instruct-apply.mjs`); both end to end
through the engineer's append and clear, where the resolution supersedes the
instruction's step (`test-instruct-apply.mjs`); and through the owner command,
an earlier owner note quoting a whole resolution heading that forges none at
the write or at the application (`test-autopilot-instruct-cli.mjs`).

Limits:
- A worker's note that quotes a whole resolution heading at column 0, fenced
  or not, counts as a resolution. When it is written between an
  instruction's write and its application, the instruction's step is
  superseded (cause `gate`), its note is still applied, and the child keeps
  its own step.
- A worker's quoted `### Phase 0` heading is taken for a step by the P2 scan
  in the same way. That costs the instruction its provenance, and while a
  verification request is answered, the policy's P7 guard may then resume the
  requesting verb over the child's recorded step (policy.mjs). This is P2's
  behavior before this note too.
- An application whose receipt was pruned (only the last 16 ended receipts
  are kept) is read as a worker's note: a heading the owner
  quoted in it is then counted as a resolution or a step.

**II11. What the slice's fourth critique found** (2026-11-01), fixed and
pinned by the mutations N3a–N3e. II10's fix took the ids of every receipt in the
lane's record, whatever child a receipt was for. The first-occurrence rule
proves a heading is an application's note only in the child the note was
appended to. In a replacement child (after the lane's first child archived,
or a rebinding) the first `### Owner instructions <id>` of the earlier
child's application can only be a quote, and the quote's closing fence then
opened a fence that hid every later resolution and Phase 0. The review's peer
reproduced both through the real state APIs: refine overwrote the owner's
resolution to commit, and the P2 scan kept a stale provenance past a real
Phase 0. Now laneApplicationIds(record, child) takes only the receipts naming
the child being read (its workflow id), and no child gives no ids. Every
reader already knew the child: the owner command (the linked child's
workflow id), the application (the child it holds), and instructedStep (the
child whose last receipt it reads).

The refine's peer (refine-verify-20261101T213133Z-3cb1da) found the same
over-trust in one more receipt kind: a `rolled-back` receipt was ended on proof
that its child held no such heading (every rollback in instruct-apply.mjs
reads the child whole first), so its heading in the child later is a quote.
Only a receipt that may have written its note now counts, `done` or
`reserved` (a crash's, which the recovery settles); any other state counts as
none.

Tests added: the ids scoped by child and by state, and a witness past a
replacement child's quote of its predecessor's heading and past a quote of a
rolled-back heading (`test-instructions-records.mjs`); end to end, a
replacement child whose worker quotes the earlier child's application
heading, then a gate set and resolved to commit, where the resolution
supersedes the instruction's step, and the same quote before a worker's
Phase 0, which ends the instruction's provenance (`test-instruct-apply.mjs`);
and through the owner command, the same quote and a resolution before the
owner's write, where nothing is superseded because the write and the
application read one witness (`test-autopilot-instruct-cli.mjs`). One
mutation per reader (N3c–N3e) keeps each caller passing the child.

Limits:
- A copy of the child restored from before an application, with the same
  workflow id, that later quotes that application's heading is read as
  holding the note. Restoring a workflow file by hand is outside the run.
- A receipt with no `child` (a hand-edited record; receipts are not
  validated) names no note: its note is then read as a worker's, and a
  heading the owner quoted in it counts as a resolution or a step. That fails
  toward the gate (cause `gate`), as II10's pruning limit does.

**II12. What the slice's fifth critique found** (2026-11-01), fixed and
pinned by the mutations Q1a–Q3c.

- The owner's rerun beside an instruction. Both drivers refused a forced step
  beside a pending instruction with a step only when the forced step was a
  verb or the commit. `--next verify` (`--lane <id> --next verify` with lanes)
  was taken: its batch ran, and the instruction's step then replaced its
  `on_pass`. Item 5 refuses every forced step there, and now both drivers do,
  the dispatch alone excepted (its subtask has no child, so no instruction
  with a step). Tests: a serial run and a run with lanes, each after a
  request parked on an unchanged tree, refuse the rerun naming the
  instruction, and start no check and no worker
  (`test-autopilot-verify-driver.mjs`, `test-autopilot-verify-lanes.mjs`;
  Q2a, Q2b). The refine's peer (refine-verify-20261101T230438Z-e15420) found
  the serial check read every subtask in progress, not the one the forced
  step names: a sibling whose child had archived, awaiting its landing, with
  an instruction left pending until its drop (`child-archived`), refused the
  active child's forced step. The serial run now reads only the subtasks
  whose child is active, as `forcedApplies` does; a run with lanes already
  read the forced pair's lane alone (`test-autopilot-instruct-serial.mjs`;
  Q2c).
- An instruction to a lane mid-step, with lanes. In a run with lanes the
  step in flight (`subtasksInFlight`) is the only thing that keeps an
  application off a lane during its step: no persona operation is open
  between a verb's writes, so the writer's boundary check does not see it.
  The serial test cannot fail there (the serial loop waits on its worker), and
  no lanes test wrote an instruction while a lane's worker ran. One now does:
  the instruction stays pending over several ticks while the step runs, is
  applied after it, and replaces the step the worker's finish-verb wrote
  (`test-autopilot-instruct-lanes.mjs`; Q1a).
- The malformed-step refusals. R1 changed only the dispatch's own code. Now
  one mutation drops the trailing-word check, one the verb list
  (`test-instructions-records.mjs` and `test-autopilot-instruct-cli.mjs`;
  Q3a, Q3b), and one the owner command's refusal of a step the parser
  refused (`test-autopilot-instruct-cli.mjs`; Q3c).

**II13. What the slice's sixth critique found** (2026-11-02), fixed and
pinned by the mutations of group T.

- A batch a dead driver left open. Item 3 keeps a lane from an instruction
  while a batch has started there and not ended, but both drivers knew an
  open batch only from their own run (`openBatches`, `openBatchOf`), which
  starts empty. At a relaunch the application replaced the pending `verify`
  first, the instructed verb ran, and the batch stayed open in the record:
  only the lane's verify step ends it (verify-run.mjs, `end`). Now the
  writer's boundary reads the child's own record (`openBatchOf`: a request
  pending and its latest batch with no `end`, as `planVerify` reads it) and
  answers `not-at-boundary` with `step_first`, in every mode, the owner
  command's included: the run decides the lane as before, and its verify
  step ends the batch (cut short, `driver-end`). Results that cannot be read
  beside a pending request count as open: the verify step judges them. The
  refine's peer (refine-verify-20261102T053552Z-d9e3f8) found the step then
  continued what was left of the batch at once, so the instruction waited
  through another batch, where item 5 has a request not running replaced by
  its step. Now the verify step, once it has ended such a batch, asks the
  driver whether an instruction with a step applies to the lane
  (`yieldsToInstruction`, `pendingInstructionSteps`), and if one does it
  gives the lane back (`none`) rather than continue; the instruction is
  applied at the boundary after it, its step replacing the request. A note
  alone leaves it, and the batch continues; so does the owner's rerun (a
  forced step, which an instruction written since waits for). Tests: the
  boundary on such a record, ended, with no batch and unreadable
  (`test-instruct-apply.mjs`); the step's yield (`test-autopilot-verify-run.mjs`);
  and a relaunch over a dead driver's batch in each driver
  (`test-autopilot-verify-driver.mjs`, `test-autopilot-verify-lanes.mjs`).
  T1a and T1b are one defect, split by driver so that each run's unmutated
  control stays within the harness's default timeout; T1c, T1d and T1e
  remove the yield in the step and in each driver.
- The forced-step refusal read every pending entry with a step, whatever it
  applied to. An entry bound to a child that archived, or that another child
  took the lane from, applies to nothing (item 6) and is dropped at the next
  boundary, yet it refused the relaunch's forced step. Now
  `pendingInstructionSteps` passes over an entry the lifecycle sweep would
  drop (`dropCause`, against the plan, the linked children and the active
  one); an entry being applied, and every entry while the homes or the
  worktrees cannot all be read or two children are active, still refuses.
  The two MINOR findings at the same site are taken with it: a record that
  cannot be read refuses the forced step, naming the record (everywhere else
  such a record counts as possibly holding a step), and every refusing entry
  is named, so one refusal lists every withdrawal it needs. Tests: in each
  driver, a forced step taken beside an entry bound to a child the lane no
  longer has, which is then dropped `child-replaced`, and in a serial run a
  record that cannot be read refusing it (`test-autopilot-instruct-serial.mjs`,
  `test-autopilot-instruct-lanes.mjs`; T2a, T2b).
- The order beside a forced step. Item 3 applies what is pending when no run
  is live "before it acts on the lane", and item 5 delays only an
  instruction written while a live run still carries an untaken forced step.
  The code delayed every pending instruction behind the forced step, those
  pending at the launch included, and II4 said so; a test pinned that order.
  Now each driver reads, as it takes its forced steps and before its refusal,
  what is pending (`launchPending`: each record's pending entries by id and
  revision). Beside its untaken forced step a lane's entries still pending
  from that look (`launchEntries`) are applied before the step, and the
  application reserves those alone (`instruct-apply --only-entries`,
  planApplication's `only`), so an entry written or revised since, before
  the look or between the look and the reservation, stays pending: it waits
  for the forced step, and is applied at the boundary after it, its step
  replacing the one the forced step's finish-verb wrote. Beside a forced step
  every entry pending at the launch is a note (one with a step refuses the
  launch), so the forced step still runs. A serial run's forced step also
  waits while that application is deferred (`waiting`, `failed`,
  `unreadable`), as a lane's recorded step does, up to the attempts' bound. The
  refine's peer found the first version of this checked the launch entries
  outside the reservation (an entry written in between was applied before
  the forced step, and one written before the check held the launch's notes
  back) and let a serial forced step pass a deferred launch note; both are
  fixed as described. Tests: the reservation of the given entries alone
  (`test-instruct-apply.mjs`), the serial test inverted (the note pending at
  the launch is applied at the forced step's seq, before it), a note pending
  at the launch and an instruction written after the launch in a serial run,
  a deferred launch note holding the forced step, and both orders in a run
  with lanes with the later instruction written between the look and the
  reservation (`test-autopilot-instruct-serial.mjs`,
  `test-autopilot-instruct-lanes.mjs`; T3a–T3g). D2, which applied every
  instruction before the forced step, is T3b's defect and is folded into it;
  D1, L2, N2c, N3d, Q1a, Q2a and G4a–G4d are re-anchored on the changed
  lines, and F1a names the inverted test. The verification that followed
  found G4a and G4d surviving: F1's writer refuses an application while the
  child records a batch open, so with the run's own rule gone (it attempts no
  application on a lane whose batch has started) the entries stayed pending
  all the same, and the test, which read only their state, passed. The test
  now also asserts that the run attempts no application on the lane while the
  batch waits for the heavy-work lock or runs its checks; both mutations fail
  that assertion.

**II14. What the slice's seventh critique found** (2026-11-02), fixed and
pinned by the mutations of group T4.

- An owner's write that landed while a pass ran woke nothing. Item 3 says an
  instruction written, revised or withdrawn wakes the loop within the poll.
  A run with lanes read what was due at the start of its pass of
  applications, but took the records as seen at its end, after it had run
  `instruct-apply` for each due lane. A write that landed in between was in
  neither: not applied in that pass, and no change at the next poll. A
  parked lane's digest does not cover the records, so the lane stayed parked
  until something unrelated woke the run. The fix reads the records before
  the pass reads what is due, and takes that as seen at its end
  (`instructionsWatch` in instruct-boundary.mjs). A poll during the pass
  that took a later digest is left as it is. Reading at the start alone
  would make the run's own writes wake it. Each would cost an extra pass,
  and the poll's wake forgets every attempt, so a lane whose application
  failed would be tried again for a receipt the run wrote itself. So the
  digest now covers only what the owner writes (II1): each entry's id,
  revision and withdrawal, and what keeps a record or the directory from
  being read. The serial driver keeps no digest and was not affected.
  Tests: the watch across a pass, with a write during it, a write before it
  and a poll during it, and the digest at the owner's writes and at a run's
  own (`test-instructions-records.mjs`; T4b–T4e). A run with lanes also gets
  a test: a parked lane whose application finds its own step first is tried
  again within the poll after the owner's second note lands during the
  pass's second call, while another lane's step still runs
  (`test-autopilot-instruct-lanes.mjs`; T4a). R10 and L1 are re-anchored on
  the changed lines. A test of the failed-application path does not pin the
  narrowed digest: that path asks for another pass, whose own start reads
  the receipt, so the unit test is T4d's killer. The refine's peer
  (refine-verify-20261102T130640Z-e000a8) found the narrowed digest blind to
  a hand edit the readers refuse that kept every id and revision (a note no
  longer matching its sha256): its corruption and its repair woke nothing.
  Now a record the readers refuse (readInstructions: it does not parse, or
  is no well-formed record of its subtask) is digested by its bytes, as one
  that does not parse was (T4f).

**II15. What the slice's eighth critique found** (2026-11-02), fixed and
pinned by the mutations of group T5.

- A run with lanes could end beside an instruction the owner had just
  written. When nothing runs and nothing can start, the idle end consumes
  every pending release and judges every parked lane again from a fresh
  look before it halts, but it never read the instruction records again.
  A write that landed after the iteration's second pass of applications had
  read what was due, during the decision's look or the end's own looks,
  reached the run only as a wake: the tick's poll took the digest as seen
  and queued one, and an end that does not wait never reads it. The usual
  case is the owner unparking the last parked lane: the run halted on that
  lane's park, the instruction still `pending`, though the command had said
  the live run applies it (the critique's peer, review-20261102T154101Z-d817ca,
  reproduced it with the real command and driver). The record was kept, so
  a relaunch applied it. Now the end asks the records themselves before it
  halts (`instructionsWatch().sincePass()`): whether they changed since the
  last pass read them at its start, whatever a poll took as seen. A change
  forgets every attempt, as the tick's does, and the loop runs again, so the
  instruction is applied before the run ends. Each change is told once, so
  an end that cannot run a pass is asked again only after another write. A
  write in the instant between that read and the halt's record is left to
  the relaunch, which the halt lists it for. The `completed` end needs no
  such read: it ends only on an archived macro, whose instructions are
  dropped. Tests: the watch's answer to the end, with a write the pass read,
  one a poll took as seen, and the answer given once
  (`test-instructions-records.mjs`; T5b–T5d), and a run whose only lane parks
  and whose owner writes during a fresh look of that lane's worktree after
  the park, three ticks long: the instruction is applied and the lane steps
  by it before the run ends (`test-autopilot-instruct-lanes.mjs`; T5a).

**II16. What the slice's ninth critique found** (2026-11-02), fixed and
pinned by the mutations of group T6.

- An instruction could lose to the step it was written to prevent. Both
  drivers apply a lane's instructions in a pass before they look, report
  the landing and decide. A run with lanes then admits the step with a
  check of the lane's hold and the owner's rebinding, but none of its
  instructions. A write that landed after the pass, during the look, the
  report or the admission, met a step decided without it. The costly case is
  the usual one: a lane's critique ends with commit as its recorded step, the
  owner writes `/engineer:refine` to it, and the commit runs, archives the
  child and drops the instruction `child-archived`, its step never run (the
  critique's peer, review-20261102T172202Z-98dbc6, reproduced it with the
  real command and a write during the landing report). The serial driver had
  the same window, from its turn's application to the spawn. Now each driver
  asks, right before a step starts with nothing awaited after it, whether the
  lane's record holds an entry pending, or cannot be read, on a record other
  than the one its last application attempt met (`admissionRecheck` in
  instruct-boundary.mjs). If it does, the step yields: a run with lanes
  decides again (the admission's `refuse(null)`), and a serial run takes the
  turn again at the same seq, its reservation settled. The pass then applies
  the instruction, or defers the lane, before the decision. The record an
  attempt met is read before the attempt: the scheduler's `instructTried`
  key, and in the serial driver the key the turn records for each attempt.
  The serial driver first read it after the attempt returned; the refine's
  peer (refine-verify-20261102T180122Z-9b7e48) reproduced an owner write
  that landed while the applier's process group was torn down, which that
  read took as tried, and the commit ran over it. A lane whose own step comes
  first (an interrupted commit) is therefore not held back by an instruction
  the pass already tried. The admission leaves out a lane the pass leaves
  out: its batch open, or its untaken forced step first. It answers each
  record once, so a lane a pass did not try costs one more turn, never a
  loop. A tick's poll at an owner write forgets every attempt, so after a
  write to one lane another lane's next step may yield once too. The serial
  driver asks the same question in its verification step, after its drift
  check. No permanent test reaches that call, or the removal of a lane a
  yielding admission created; the refine's peer probed both (no batch
  started, the seq kept; the unused lane removed, its marker gone). II17
  adds a test of the verification call. Tests: the admission's answer for no
  record, a record no attempt met (once), the record the attempt met, a
  write since, every entry withdrawn and a record that cannot be read
  (`test-instructions-records.mjs`; T6e, T6f). A run with lanes and a serial
  run each get a test in which A's critique ends with commit and the owner
  writes `/engineer:refine` after the passes: in the second landing report
  after the step's end (the first is the step's own settlement, before the
  passes), and in the serial drift check's root resolution. The instruction
  is applied, A steps by `/engineer:refine`, and no commit runs
  (`test-autopilot-instruct-lanes.mjs`, `test-autopilot-instruct-serial.mjs`;
  T6a, T6c). The lanes test of a lane whose own step comes first, and the
  serial test of an interrupted commit, now also assert that no admission
  yields there (T6b, T6d). A serial run whose owner writes
  `/engineer:refine` after the turn's application of a note has written and
  before it returns applies the refine, and no commit runs
  (`test-autopilot-instruct-serial.mjs`; T6g).

**II17. What the slice's tenth critique found** (2026-11-02), fixed and
pinned by the mutations of group T7.

- An instruction with a step did not replace a verification request whose
  batch was being prepared. Both drivers recheck a lane's instructions at a
  step's admission (II16) and then hand a verification step to
  `startVerify`. Before that writes the batch's start, it awaits the
  workflow's record, the lane's tree digest and the checks' selection, a
  task process. Its only check after those awaits was for a hold, a drain
  or the driver's end. An instruction the owner wrote meanwhile met a batch
  that ran whole, which could take the full suite and mutation runs and
  hold the heavy-work lock, and only then replaced `on_pass`. Item 5 says a
  request not running is replaced by an instruction's step, and item 3 says
  a batch has started only once its start is recorded. The critique's peer
  (review-20261102T211754Z-d36d59) reproduced it with the real command in
  both modes. Now `startVerify` asks the driver's
  `instructionWrittenSince` hook right before the start's write, after the
  stop check, with nothing awaited between them. The hook answers true when
  the lane has an instruction with a step pending, or a record that cannot
  be read (whether it holds one cannot be told, as `pendingInstructionSteps`
  says), on a record the last application attempt did not meet. That is the
  recovery path's `yieldsToInstruction`, which now counts an unreadable
  record too, and it never answers beside the owner's rerun. It uses II16's
  `admissionRecheck`, so it answers each record once. Then the step writes
  nothing more and returns `none` with `instruction: true`, and the next
  pass applies the instruction, whose step replaces the request. An
  instruction a pass leaves pending costs one turn, never a loop. A note
  alone replaces no request, so the batch runs and the note waits for its
  end, as item 5 says. The admission's recheck still applies a note written
  before the admission first. A step that yields this way is not counted
  toward the "changed nothing twice" rule (`no-progress`): each such yield
  takes an owner's write. The refine's peer
  (refine-verify-20261102T215736Z-58ad2d) reproduced the first version
  halting a serial run, and parking a lane, after two writes in a row, the
  first withdrawn before the pass. It also reproduced that first version
  starting the batch beside a record it could not read. Both are fixed
  here. The peer also found a limit: a batch that is open and untrusted
  still comes first. The first preparation yields, and the application
  refuses with `step_first` (the open-batch precedence of item 3). The next
  attempt, on the same record, then runs the restart before the instruction
  applies. Tests: a serial run and a
  run with lanes whose owner writes `/engineer:refine` during the checks'
  selection. No check runs, no batch start is journalled, and the verify
  step ends `none` with no batch. The instruction is applied with
  `replaced_step: verify`, and A steps by `/engineer:refine`
  (`test-autopilot-verify-driver.mjs`, `test-autopilot-verify-lanes-instruct.mjs`;
  T7a, T7b, T7c). A serial run whose owner writes a note while the drift check
  of a verification step resolves the roots yields that step, applies the
  note, then runs the batch (`test-autopilot-verify-driver.mjs`; T7d, the
  verification call II16 left untested). In each mode, a test has two batches
  in a row yield to an instruction, and the lane goes on to its batch and
  commit, with no `no-progress` (T7e, T7f). In each mode, a test damages the
  record during the selection and repairs it before the pass: no batch
  starts until the record is repaired (T7g, T7h). T1d and T1e now anchor on
  the recovery hook alone (`yieldsToInstruction: stepPending`).
- The verification batch after this fix
  (autopilot-20261102T142858Z-309f46-s14-aa57f8) ended T7c with no verdict:
  its run of the whole lanes file passed the harness's 900 s timeout. On
  its own the mutation is caught: the item-5 suite fails it in under four
  minutes, its two critique-10 tests failing as stated, and no test of the
  suite hangs. The lanes file took about eleven minutes in that batch, so
  every case that ran it sat near the timeout. The run with lanes' item-5
  tests (the owner's instruction beside an answered request) are now a file
  of their own, `test-autopilot-verify-lanes-instruct.mjs`, with the helpers
  both files share in `_verify-lanes-helpers.mjs`; the tests moved
  unchanged. The impl-instruct cases that target them (F6d, G4a–G4d, T1b,
  T1e, T7c, T7f, T7h) run that file alone; Q2a, whose rerun test stayed,
  and verify-exec-driver's lanes cases still run
  `test-autopilot-verify-lanes.mjs`. The lanes tests that II8, II9 and II13
  name in `test-autopilot-verify-lanes.mjs` are in the new file now.

## Implementation note 2026-11-03 — C168 (the owner's forced verification step below HIGH)

A fix in the orchestrator package to Decision 5, items 2, 6 and 7, as
verify-exec implemented them. It adds no guarantee and changes no persona
record. Found in Macro 5 on impl-instruct: `classify` (`policy.mjs`) halted
a `verify` next step below HIGH `low-confidence` before the resume rule. So
after the owner forced a MEDIUM request with `--lane X --next verify` the
batch ran, but the next look halted `low-confidence` again, whatever the
batch's end, instead of resuming the requesting verb. Every batch took
another forced step. A pass was not affected: `verify-pass` makes `on_pass`
the next step, which the policy judges on its own confidence. Two decisions,
then what the code does.

**FV1. Scope.** The owner's forced step authorizes running that request's
checks and resuming its requesting verb. The authorization is bound to the
workflow (the journal is per workflow), to the request id, and to the batch
history in the driver's own verification journal. That history is driver
metadata, never the persona's record, which the worker can write. `on_pass`
keeps its own confidence: after a pass, a MEDIUM `on_pass` still halts and a
HIGH one is dispatched. A request below HIGH that the owner has not forced
still halts before anything runs.

**FV2. Lifetime.** The authorization ends when the request is replaced (a new
request has another id), answered (its `on_pass` is the next step), or set
aside (a `verify-batch-restart` of a record the journal does not hold whole).
A replacement request, an instruction's step and another lane never inherit
it. A journal written before this fix marks no batch, so its batches read as
unforced.

**FV3. The mark** (`verify-run.mjs` `runStep`). A batch the owner's forced
step starts, restarts or continues carries `meta.forced: true` on its
journal start, beside the requesting verb, the base and the subtask the start
already kept. The serial driver and the scheduler tell the step it is the
owner's (`job.forced`, from the forced step's `forced`).

**FV4. The authorization** (`verify-journal.mjs` `forcedAuthority`). It
starts at the latest batch the record names and walks back through the
batches the journal started for the request, each continuing the one before,
to a start marked forced. Every hop is the journal's start of that request
and of that subtask. A restart continues nothing, so the walk stops at one
unless the owner's own rerun made it. So a continuation of a forced batch is
covered, whether it continues a dead driver's open batch or one cut short.
The record is the worker's, and it names the batch the walk starts from. So
that batch must be the last one the journal started for the request. A
record put back to an earlier batch then revives nothing, for example one
whose continuation has since passed and been answered (found by the
compose step's Codex peer). A driver that died after journalling a start whose
persona write never landed fails closed the same way: the owner forces the
request again. `verifyFacts` gives the policy the result as `forced`,
beside `resume`, for a pending request.

**FV5. The policy** (`classify`). A `verify` next step below HIGH halts
`low-confidence` unless `forced` names this very request (its id equal to the
child's request id). Otherwise the branch goes on as at HIGH: the resume rule
(a batch that ended failed or with no evidence, the journal's `resume` line
on the record it was decided on), else the verification step, which ends an
open batch, continues one cut short, or answers a pass the driver journalled
before the record took it.

**FV6. The step's own refusal** (`runStep`). Below HIGH, a step that is not
the owner's runs nothing unless the authorization covers the record's latest
batch; it halts `low-confidence`, writing nothing. Every plan such a step
makes is held to the authorization's end, including the plan made after it
ends an open batch, when it reads the record again. A plan that would set
the record aside (`restart`) or start a batch that continues none halts
`low-confidence` too, naming the rerun, because the set-aside ends the
authorization. The guard sits in the step's one planning function, so no
plan escapes it (the peer found the first version checking only the first
plan). This does not weaken the policy's halt; it only bounds a step decided
on facts that a concurrent edit made stale.

**What it does not do.** A forced step that yields before its batch starts (a
hold, a drain, an interrupt) journals nothing, so no authorization exists
yet. A run with lanes gives the forced step back and takes it again within
the run (scheduler, as before). A relaunch halts `low-confidence` again, and
the owner forces it again. The trust limit of the journal (V2) applies
unchanged: a worker that forges journal lines is outside this model.

**Tests.** `tests/orchestrator/test-autopilot-verify-forced.mjs` covers the
journal's walk (a forced batch and its continuations; no mark; a restart;
another request, subtask or batch; a loop), the policy serial and with lanes,
and the step on a real persona record and journal. The step cases are: a
forced MEDIUM batch that fails, or ends with no evidence, and resumes the
verb; one that passes, with a HIGH or a MEDIUM `on_pass`; an interruption
before the start; a dead driver's open batch; a batch cut short, and a
continuation of it cut short in turn, which fails at the next; a crash
between the journal's pass and the record's; a tree changed after the pass;
a record set aside; a record put back after its continuation was answered;
and an edit, made through a wrapped persona CLI once a dead driver's open
batch is ended, that sets the record aside or empties it. `tests/orchestrator/test-autopilot-verify-forced-driver.mjs`
runs the serial driver and the scheduler end to end. The mutation spec
`scripts/mutation-specs/verify-forced.mjs` breaks each piece (F1–F12 against
the step and policy file, G1–G3 end to end). `verify-exec-driver.mjs` D5 now
anchors on the changed condition.

## Amendment 2026-11-10 — verification policy (C178)

**The problem.** Measured over the last two macros, verification took 57 to
71 percent of a step's time, and 65 of 113 batches failed. Workers asked for
the whole suite and broad mutation sets after every refine, and the driver's
selection added every test a change could reach, the large ones included, to
each batch. The whole suite ran many times for trees that changed again
before the commit, and never had to run for the tree that was committed.

**What changes.** Decision 5 keeps its shape: a request, the driver's batch,
the journal, `on_pass`. Six rules are amended or added. Items cite Decision 5.

1. **Intermediate and final requests.** A request whose `on_pass` is a verb
   is *intermediate*; one whose `on_pass` is `commit` or `done` is *final*.
   Nothing new is declared: the driver reads the kind the request already
   holds.

2. **An intermediate batch leaves the large tests out (item 4).** The
   selection (`verify-select.mjs` `selectChecks`, `deferLarge`) removes from
   the test files it adds each test the repository declares large
   (`scripts/data/test-tiers.json`, the tiers of ADR-0033's amendment of
   2026-11-09), read at the selection's base, never from the lane's tree, in
   the form `scripts/lib/suite-tiers.mjs` accepts. A list that is missing,
   does not parse or has another form defers nothing. A change only a
   deferred test matches is matched, so it selects no suite. The suite
   fallback for a change nothing matches, or matched only with uncertainty,
   stays. A large test that itself changed is kept. The worker's own checks
   are never dropped. A new key in the check declaration was rejected: both
   parsers are strict, so a key on `main` before every install knew it would
   end the offer.

3. **A final batch holds the suite once (item 4).** When the declaration has
   a `test-suite` kind, a final batch runs it exactly once: the worker's when
   the request names it, else the driver's, in place of the test files the
   driver would have added. A declaration with no such kind gets no final
   suite, and no gate (rule 4).

4. **The commit gate.** In a run that offers verification over a declaration
   whose `test-suite` kind resolves with no argument, a commit needs the
   suite's evidence: a batch of the workflow that the driver's journal ended
   `passed`, whose checks hold the suite's command, started and ended on the
   lane's tree as it is now, with the run's declaration digest and the lane's
   selection base. The tree digest hashes `HEAD`, so an edit, a regeneration,
   a commit or a rebase since invalidates it. The gate holds every route:
   - *the next step `commit`, or `done` over a tree with a change:* without
     evidence the driver resumes the workflow's last verb, with one fixed
     sentence after its command that tells it to end with the verify form,
     the suite named, `on_pass` commit. A second such resume on the same tree
     halts the lane `no-progress`. `done` over a tree with no change only
     closes the workflow and needs none;
   - *the owner's forced `--next /engineer:commit`:* refused, naming the way
     out (force the verb). With lanes it is judged at each decision, on the
     lane's own tree; the check made as the run starts cannot judge it,
     because no lane is held yet;
   - *the recovery of an interrupted commit:* its own commit moved `HEAD`, so
     the tree digest no longer says anything. The driver records each commit
     step it admits in the journal with the lane's content without `HEAD`
     (`lane-digest.mjs` `contentProjection`) and the tree it was admitted
     on, and takes the commit up again only while the content is still that
     and the suite's evidence still holds for that admitted tree, with the
     run's declaration and the lane's base as they are now. Only the moved
     `HEAD` is let by: a tree that cannot be digested now, another
     declaration or another base is no recovery. It is also taken up when
     the suite's evidence holds for the tree as it is now, as a commit
     admitted anew, and when the lane holds no change at all: the commit
     command then only closes the workflow (a `done` over a clean tree, or
     a commit made, whose archive did not run) and commits nothing. The
     owner's forced commit of a commit begun follows the same three. A
     recovery taken up without evidence for the tree as it is writes no new
     journal line: the first admission's stands, so a second interruption
     is judged as the first. Otherwise the lane halts `owner-choice`, a
     judgment halt the owner's forced verb replaces;
   - *at the admission, with lanes:* the lane is prepared between the
     decision and the start, so the tree is digested again there, and a
     commit decided on another tree is not started: the run decides again.
     A recovery taken up on its admitted content is compared by that
     content. A tree that cannot be read there parks the lane
     `owner-choice`.

   The gate's facts and records are the driver's (`verify-run.mjs`
   `suiteFact`, `noteGateStep`; journal ops `commit` and `final-resume`),
   never the persona's record. A journal that cannot be read, or a tree or a
   base that cannot be read, is no evidence. A run with lanes reads the
   lane's status, content and base in a child process, as it does the tree
   digest (`offloop.mjs` `gateRead`), so its loop goes on supervising the
   workers in flight; a read that fails there fails closed.

5. **A pass is reused once (item 7).** Item 7 halted a request whose checks
   repeated a batch that passed or failed on the same tree. A failure still
   halts. A pass is now evidence for the unchanged tree: when the earlier
   batch passed whole (it continued no batch, replayed none, and the journal
   holds a result for each of its checks) with the same declaration digest
   and selection base, the driver records a batch for the new request whose
   results are that batch's, runs nothing, and answers it. Each replayed
   result's log is a pointer to the source's. A pass that was itself a replay
   is a repeat and halts `no-progress`; a pass that does not qualify runs
   again whole. A replay that a hold or the driver's end cuts short is
   continued by running what is left, and the continuation keeps the replay's
   mark, so its pass is never replayed in turn.

6. **A cap on mutation cases per batch.** One batch runs at most 6 case ids
   over all its checks (`MAX_BATCH_MUTATE_CASES`: the values of every `id`
   slot). This is a cost ceiling, distinct from the six case ids one `mutate`
   check names at most, which sizes that check's timeout (AGENTS.md). The
   persona refuses a request over it before any write (`bindVerifyRequest`);
   the driver refuses a batch over it, its own additions counted, before
   anything runs.

**What the worker is told (item 1).** The runbooks' § Long checks and the
verify form now say: an intermediate request names the test files the change
touches, no suite and no broad mutation set; mutation cases only for gate or
fail-closed code, at most 6; a final request names the suite.

**Limits, documented and not fixed.**

- *The guarantee covers tracked and non-ignored files.* The tree digest does
  not see installed dependencies or anything git ignores. A dependency
  reinstalled between the suite and the commit is not noticed.
- *The window before staging.* An edit made after the gate's last digest and
  before `/engineer:commit` stages is not seen. The P7 guard has the same
  window.
- *A workflow whose commit began under an older driver.* Its journal holds no
  `commit` line, so its recovery under this driver halts `owner-choice`.
- *Mixed versions.* An older persona under this driver has no request-time
  cap: the driver's refusal of the batch is what it meets. New runbooks under
  an older driver keep the old repeat rule: a repeated pass halts
  `no-progress`, and no gate asks for the suite.
- *The preview.* `autopilot preview` does not judge the gate: it shows the
  commit, and the run decides.
- *The resumed verb.* The gate resumes the workflow's last verb, usually a
  critique, which counts as a critique round of ADR-0063's cap.

**Tests.** `tests/orchestrator/test-autopilot-verify-select-tiers.mjs` (rule
2), `test-autopilot-verify-run.mjs` (rules 1, 3, 5 and 6 on a real persona
record and journal), `test-autopilot-verify-gate.mjs` (rule 4: the evidence,
the facts, every route of the policy, the journal lines),
`test-autopilot-verify-lanes.mjs` (rule 4 at the admission: a lane edited
since the decision, a tree that cannot be digested), and
`test-autopilot-verify-mutate-timeout.mjs` (the cap, AGENTS.md and the
runbook sentence held equal).

## Amendment 2026-11-10 — temporary files and run retention (C175)

**The problem.** Measured on the owner's machine: about 7 GB and 650,000
files a day in the temporary directory, and 1.9 GB of autopilot run
directories. A worker step's runbook blocks make `mktemp -d` directories that
nothing deletes (ADR-0059, by design: a block never deletes the file it was
handed), its quick tests leave repositories, a verification check leaves the
suite's and the mutation harness's copies, and every run keeps each step's raw
stream and each check's log for good. An interim wrapper and a cron job on
that machine removed them by age; this amendment replaces both.

**What changes.** Two mechanisms of the driver, both in
`plugins/orchestrator/adapters/claude/autopilot/`. No runbook changes, and
ADR-0059 stands as written: a runbook's directories are bounded by where they
are made, not by a block that deletes them.

1. **A TMPDIR per step and per check (`scratch.mjs`).** A run owns one root,
   `<base>/agentic-ap/<run>/` (`<run>` is the run id without its `autopilot-`
   prefix), made exclusively (mode 0700) before
   the run directory, with a marker (`.scratch.json`: schema, run id, the
   repository's toplevel and common git directory). A worker step runs with
   `TMPDIR=<root>/s<seq>` (its `started` line records `tmp_dir`), a
   verification check with `TMPDIR=<root>/v<seq>-<index>`; each is made
   just before its spawn. The names are short on purpose: a tool that makes a
   unix socket under TMPDIR has about a hundred bytes for its whole path (104
   on macOS, whose per-user TMPDIR takes half of them). `<base>` is the driver's own `TMPDIR`, then `/tmp`:
   the first that resolves, lies outside every worktree of the repository and
   holds no character XML escapes (a peer's prompt names paths under it). With
   no such directory, or a root that cannot be made, the run does not start;
   a step directory that cannot be made fails as a spawn that throws does, and
   a check's is `not-started`. There is no degraded mode: no step or check
   runs with the driver's own TMPDIR. Decision 5's check environment (item 8)
   is otherwise unchanged; a reused pass starts no process and makes none.

2. **Removal, and what defers it.** A step's directory is released once the
   step's peers are settled (after the cancellations and settlements of
   ADR-0063 D5, not at the worker's exit), a check's when the check ends,
   whatever its outcome. Removal runs in the background, one directory at a
   time, never inside a step's critical section, and its failure is counted
   in `run.json` (`scratch.failures`), never a step's or a check's outcome.
   A directory stays while something may still use it:
   - a step directory under which any directory's name holds
     `-peer-snapshot-` stays WHOLE (a surviving peer uses more of it than its
     snapshot) unless each such snapshot's run is proven over by
     `judgeRunEnded`, where no age counts, and `removeOwnedSnapshot` then
     removed it with its registration. No owner record, a run alive or
     unknown, and a removal refused or failed each keep it;
   - a step whose process group outlived SIGKILL, a step whose peers the run
     could not account for (`peers_unaccounted`), and a check whose group
     outlived SIGKILL are held by the run, which keeps its locks or its
     open-run record for the same reason.
   At its end the run waits for the removals in flight, makes one pass over
   its root and removes the root when nothing is left (the marker last, the
   directory without recursion), and `agentic-ap` after it when that is
   empty (`rmdir`, which removes nothing else; a run starting at that moment
   makes it again), so an ended run leaves nothing under the base; `run.json` `scratch` records what stays
   and why, and `removed_at`. A run that ended on an error sweeps nothing:
   its steps in flight are unknown.

3. **The guard.** Nothing is removed that is not proven the run's:
   `scratchTarget` judges the paths alone (an absolute, normalized root named
   for its run under `agentic-ap`; the root itself, or its direct child
   named `s<n>`, `v<n>-<i>` or `.removing-<name>`), and
   `proveScratch` then reads the file system (the root a real directory whose
   real path is itself, so no link lies on the way; a marker naming this run
   and this repository's common git directory; the child a real directory,
   not a link). A directory is renamed `.removing-<name>` before its contents
   go, so a removal a crash interrupted is finished by the next pass without
   judging a half-removed snapshot again.

4. **What a run left (the index, and the sweep).** Each root has an entry in
   `<main>/.agentic-plugins/runs/autopilot/scratch/<run-id>.json` (root,
   repository, the driver's pid and fingerprint), written before the root is
   made and removed only when the root is gone, so a root is found from any
   checkout and a crash strands none (an entry with no root is dropped; an
   EMPTY root with no marker is removed with `rmdir`).
   A run's start, after the dead-run cleanup of ADR-0067 Decision 6 and before
   its own open-run record, sweeps every entry whose run holds no open-run
   record and whose driver is gone (the record read again once the driver is
   known gone, never from an earlier listing), by the same pass and the same
   guard, which proves a directory before anything under it is scanned;
   never its own entry, and never a root while its run's record stays (a
   dead run's cleanup removes the record only once its worker groups are
   empty and its peers cancelled). The sweep never halts a run. SIGTERM ends
   a run through its normal end; a driver that dies leaves its root to this
   sweep; the driver's exit handler removes nothing.

5. **Run retention (`retention.mjs`), owned by the orchestrator.** Not a
   `runtime:retention` family: which records a run's readers need, and which
   logs a workflow cites, are this plugin's to know. Only a run's bulk is
   trimmed, its `worker-<seq>.jsonl` streams and its `verify/` directory
   (ADR-0063 D8 already gave the raw stream a bounded retention); `run.json`,
   `steps.jsonl`, `halt.json`, `landing.jsonl` and `lanes.jsonl` always stay,
   so `status`, a hold's handoff, the event reader's reconciliation, a halt's
   resume and the pairing of a request with its step (`requestKnownIn`) read
   every run as before. `run.json` `retention` records the trim. A run is
   eligible when it has ended (completed, halted, error), is not among the
   checkout's newest 20 ended runs and ended more than 14 days ago; never a
   run with an open-run record, a cleanup lock or an index entry of item 4,
   one `running` or `draining`, or one whose `run.json` does not read. A
   cited run is not trimmed, whatever its age: its worker streams stay with
   its `verify/`. A workflow cites a run by naming it:
   every run id that appears in an active engineer workflow of any state home
   of the repository's checkouts, in one archived within 14 days, or in a
   verification journal of an active workflow or written within 14 days. The
   read is by text and errs toward keeping, and it comes before any file of
   the run is chosen; a source that does not read keeps every run past the
   floors whole (fail closed). One retention runs at a
   time (`retention.lock` beside the open-run records); each run is judged
   again under it just before its files go, and each file is renamed
   `.removing-<name>` first, which a later pass finishes. It runs at each
   run's start, after the sweep of item 4, where a failure is a warning; and
   as `agentic-autopilot retention` (what would go, changing nothing) and
   `retention --execute`, which a worker of a run is refused.

**What it replaces on the owner's machine.** Once the release carrying this
is installed, the interim `agentic-run` wrapper and the `agentic-tmp-clean`
cron job on that machine are the owner's to remove.

**Limits.**

- *A snapshot nothing proves over.* A directory named like a snapshot with no
  owner record that reads (a creation cut short, a test's leftover in a
  worker's step) keeps its step directory until the owner removes it; `run.json`
  and `retention` name it. An age bound was not added: `judgeRunEnded` counts
  no age so that nothing is removed under a peer that may still run.
- *A check's own survivors.* A check's directory is kept only for a group the
  driver knows outlived SIGKILL. A process the check started in a group of
  its own that the check's teardown did not reach loses its directory.
- *Socket paths.* A step's TMPDIR is longer than the driver's by the root's
  and the step's names (about 40 bytes). Where a tool's socket path under it
  runs past the system's limit, start the driver with a shorter `TMPDIR`.
- *A shared `/tmp`.* On a machine whose users share `/tmp` and set no
  `TMPDIR`, the second user's run finds `agentic-ap` owned by another
  while a run of that user has its root there, and does not start. Set
  `TMPDIR`.
- *Other temporary files of the driver.* What the driver itself makes in its
  own TMPDIR (a landing check's scratch, an instruction's text) is outside
  this amendment; each removes its own.
- *A run with no macro that ended on an error* keeps its open-run record
  until `stop` cleans it up, and its root with it.
- *A finalize replayed in a later step.* A step's text and dispatch
  directories are gone with it. The runbooks already cover a directory that
  is gone (a later session, a system that cleared its temporary files): the
  finalize takes the run's ledger directory as `DISPATCH_DIR` and a fresh
  text directory.
- *An operation a step left open.* A step that is cut short between its
  first and its last write leaves its persona operation open on the workflow,
  and its operation directory is gone with the step, so that operation cannot
  be closed by running its last write again. The way out is the one the
  persona's refusal already names, the owner's `writer-clear`.
- *Citations are read once per pass.* A workflow that first names an old,
  uncited run while a retention pass is trimming it is not seen by that pass,
  and a stream or a `verify/` a crash left renamed is finished by the next
  pass whatever cites the run by then, a citation read that fails included. A run is named by the workflow whose step requested its
  checks, so a first citation of a run past both floors is not expected.
- *A state home behind a dangling link.* A `workflows`, `archive` or journal
  directory that is a link whose target is gone reads as absent, as a home
  that was never made does, and cites nothing. Only a hand-made link reaches
  it.

**Tests.** `tests/orchestrator/test-autopilot-scratch.mjs` (the base, the
allocation, the guard's refusals, removal and its crash recovery, a live and
an ended peer snapshot, the sweep of what earlier runs left, and the driver
end to end), `test-autopilot-retention.mjs` (the floors, each run never
trimmed, the citations and their fail-closed read, the lock, an interrupted
pass, the command), `test-autopilot-verify-run.mjs` (a check's directory on
every outcome), and `scripts/mutation-specs/autopilot-scratch.mjs` (the
marker, the layout, the live snapshot, the caller's own root, a cited run
kept whole and the fail-closed citation read).

## Superseded text 2026-11-17 — the Status section before the ADR-0070 migration

The Status section as it stood before the ADR was moved to the
current-decision layout (ADR-0070); its open points of acceptance are the
narrowings the owner confirmed on 2026-10-20.

Accepted (2026-10-20 — the owner accepted all four slices explicitly in the main
session, with every open point of acceptance listed below).
Proposed 2026-10-19.
- Asked for by the owner in discussion 3 (item 3, decided 2026-10-17) and
  discussion 4 (item 4 and the scope of macro 5, decided 2026-10-19). Both
  decision records are outside this repository
  (`~/.agentic-plugins/ops/discussion-3/decisions.md`,
  `~/.agentic-plugins/ops/discussion-4/decisions.md`).
- Written in four slices, one subtask each, of macro
  `macro-plan-20261019T084450Z-b66aaa`. The number was assigned by the
  planner.
  - **Slice 1 (this text):** Decision 1, an owner gate stops only its lane,
    and Decision 2, hold and release.
  - **Slice 2 (2026-10-19, below Decision 2):** Decision 3, stall detection,
    and Decision 4, the driver's event file watched by the main session.
  - **Slice 3 (2026-10-20, below Decision 4):** Decision 5, the
    driver-run verification step, and Decision 6, one lock for heavy work.
  - **Slice 4 (2026-10-20, below Decision 6):** Decision 7, instructions
    from the main session read at a lane's next step boundary, and Decision
    8, rebinding a dispatched subtask after an owner-approved change of its
    instructions (docket C147).
- Slice 1 went through a Codex Plan-verify review and six critique rounds
  on 2026-10-19. Each round found defects in the protocol the last refine
  had added, so the text was condensed to decision level: it states each
  decision with the guarantees it gives and the cases they cover, and leaves
  the mechanism to the implementation subtasks `impl-lane-gate` and
  `impl-hold`, with the cases each must test (§Left to the implementation).
  The designs the reviews ruled out are named there or under §Alternatives
  Considered.
- **Open point of acceptance: the release guarantee is narrower than asked.**
  The owner asked that a release not race a still-active human writer. This
  ADR excludes the persona's own operations for their whole length, but a
  person's hand edits only up to the driver's comparison at release, and
  never edits to an ignored file (Decision 2, item 7): no host interface tells whether an interactive
  session will write again [unverified], and a process or read-only check
  would still leave gaps. The owner accepted this narrowing on 2026-10-19
  (the `recurring-finding` gate of this slice's workflow), and does not
  expect to hand-edit a lane; acceptance of the ADR confirms it.
- **Open point of acceptance: what this ADR adds to, or narrows in, the
  owner's decisions.** The owner decided the scope of a halt and the hold;
  these follow from the design, and acceptance confirms them or sends them
  back:
  - run-wide beyond the owner's list: a halt that names no lane, a worker
    group that outlived SIGKILL, the run's footing (baseline fetch,
    rollback fence) wherever it is met, an unreadable holds directory, and
    the driver's own steps and checkout; `no-progress`,
    `permission-denied`, `compaction-imminent` and `dirty-tree` are lane
    halts (Decision 1, item 1);
  - every park outlives its run while the lane's fingerprint is unchanged,
    and a cause outside the fingerprint needs a bare `release`; a resumed
    lane is a new lane for the throttle (Decision 1, items 3 and 4);
  - an interactive `finish-verb` of a macro's child stays non-terminal
    while its subtask is held or parked, or a run of its macro is live
    (Decision 2, item 6);
  - holds are a lanes feature, and a serial run does not start beside a
    hold, a release awaiting its comparison, or a kept park (Decision 2,
    item 2);
  - a person works a held lane only through its active child; a held lane
    with none, or whose child archived, is worked by hand or released; a
    held subtask is never dispatched by hand (Decision 2, item 5);
  - one persona operation at a time in a lane of a macro; `writer-clear`
    for one stopped by an error; a rejected release stays rejected
    (Decision 2, item 7); a forced step on a held lane is refused
    (Decision 1, item 8);
  - the persona depends on the orchestrator's run directory, gains one
    schema field, and ships first (Decision 2, item 9).
- **Open point of acceptance (slice 2): what Decisions 3 and 4 add to the
  owner's rule.** The owner set the stall rule and the event file; these
  follow from the design or the measurement, and acceptance confirms them or
  sends them back:
  - a descendant's CPU after its last sample, and the CPU of exited
    children, is not counted, as it was not in the measurement, so a polling
    loop of short processes reads as stalled, and a working descendant no
    sample ever saw reads as nothing (Decision 3, item 3);
  - the detector ships log-only and is switched on only by a later owner
    review against stated criteria, one of them a measurement not yet made:
    how long a single model response can go without a stream event
    (Decision 3, items 7 and 8);
  - switched on, the default step wall clock becomes the 8-hour emergency
    cap, and a stalled step ends `worker-failed`, which parks its lane and is
    never retried by itself (Decision 3, items 8 and 9);
  - only the driver, and the cleanup of a run whose driver died, write the
    event file: a hold or release appears when the driver acts on it
    (Decision 4, item 1);
  - narrower than asked, after review: a cleared lane gate has no event of
    its own, and shows only as a `lane-resumed` when a live driver
    reconsiders the lane (Decision 4, item 3); a failed write need not leave
    a `seq` gap, its count in `run.json` tells (items 4 and 5); and `stall`
    lines past the reader's volume bound arrive as counts, every other kind
    line by line (item 6); a forward wall-clock step of more than an
    interval turns a window `unknown`, and a suspend shorter than an
    interval is not detected (Decision 3, item 5).
- **Open point of acceptance (slice 3): what Decisions 5 and 6 add to, or
  narrow in, the owner's decisions.** The owner decided that the driver runs
  long checks and that one lock serializes heavy work; these follow from the
  design, and acceptance confirms them or sends them back:
  - verification is offered only in a repository that commits a declaration
    of its check kinds, read from the run's baseline; elsewhere a worker
    checks in its step as today (Decision 5, items 3 and 11);
  - the changed-file selection over-selects through imports, falls back to
    the whole suite for a file no test matches, but not for a file an
    unrelated test happens to match, relies on the declaration's mappings
    for files tests read by paths no rule sees, and is accepted by a
    backtest on this repository's history, not by proof (Decision 5, item 4);
  - a result binds its tree as the tree part of Decision 2's digest sees it
    at the batch's start and end: an edit undone in between, or to an
    ignored file, is not seen (Decision 5, item 5);
  - only a check that passed or failed on its tree is evidence; a timeout,
    a check that could not start, and one cut by a stop, a hold, a drain or a
    bound are not (Decision 5, item 6);
  - a check that fails stops its batch; a request is answered only by its
    own results; only a batch cut short by a stop, a hold, a drain or the
    driver's end is taken up again, a batch whose every check passed takes
    `on_pass`, and every other end resumes the verb; a
    verb that asks for the same checks again on an unchanged tree after they
    all passed or one failed halts its lane `no-progress` at once, so a
    flaky test is rerun only after a change or by the owner's explicit
    rerun, while after a timeout with no failure they run again (Decision 5,
    items 6, 7 and 10);
  - a check whose command takes the lock itself waits for it inside its own
    timeout, unseen by the driver, and counts as running (Decision 5,
    item 9);
  - a check runs the lane's own code with the reach a worker's shell
    already has, outside the permission posture (Decision 5, item 8);
  - the driver probes only its own host's persona; the other host's reader
    is the owner's install under ADR-0067 Decision 4, item 3, and a host that
    skipped it refuses a workflow file from its worker's last `verify` until
    the batch's next step, a drain and relaunch included (Decision 5,
    item 11);
  - narrower than asked: the lock has one holder until a later decision,
    waiters between processes get no order, and it binds only cooperating
    holders in one repository's worktrees; a process that leaves its
    holder's process group is outside it for every holder (Decision 6,
    items 1, 2, 5 and 8);
  - against an older harness copy, exclusion holds only while the holder
    lives: after its end an older copy may start beside a descendant that
    left the group, and after a kill beside its last children; an older
    harness nested under a holder waits on it rather than joining (Decision
    6, items 2 and 3);
  - the inherited proof prevents accidental joins, not a same-user process
    that reads it, and a driver started under a holder refuses to start
    (Decision 6, item 3).
- **Open point of acceptance (slice 4): what Decisions 7 and 8 add to, or
  narrow in, the owner's decisions.** The owner decided that the main session
  instructs a lane without stopping the run, and asked that an approved
  change of an in-progress subtask's instructions be accepted at landing
  (C147); these follow from the design, and acceptance confirms them or sends
  them back:
  - an instruction is not a plan change and not a step queue: it carries a
    note and at most one next step, in the forced-step grammar with no
    dispatch; several pending at one boundary are applied together, and the
    last next step named wins (Decision 7, items 1 and 4);
  - an instruction never clears an owner gate and never overrides the
    resolution of a gate set after it was written: that gate drops its next
    step, even once resolved, and keeps its note; it never interrupts a
    started verification batch, between its checks included, and its next
    step replaces the step the batch would dispatch (Decision 7, items 3 and
    5);
  - narrower than a forced step: an instruction's step never replaces an
    interrupted commit, which runs again and drops it (Decision 7, item 5);
  - an instruction is bound to the child it was written for, and is dropped,
    never redirected, when that child archives first; it reaches a person's
    interactive session only through a run, or the `instruct` command run
    again at a boundary, and is applied only where the persona's operations
    are visible; an acknowledgement says it was applied, not that its step
    ran; only a driver publishes its outcome as an event (Decision 7,
    items 3, 4, 6, 8 and 9);
  - only `topic` and `profile` can be rebound; a changed branch or verb
    stays refused, as do a child other than the one rebound and any approval
    that is not the current one; a child that recorded no verb, profile or
    topic stays uncompared on them (Decision 8, items 1 and 6);
  - beyond what was asked: every approval that changes the plan becomes an
    admission, refused beside a live run of the macro or any command
    admitted under its locks, so the owner approves after the run has ended
    or been stopped
    (Decision 8, item 3); an approval that rebinds is refused while its lane
    is held, has a release awaiting comparison, or has a persona operation
    open;
  - narrower than asked: the approval-between-two-looks guarantee holds only
    once every host the owner approves from runs the release, and the
    open-operation check only once the persona's operations are visible
    (Decision 8, item 7); a delivery the approval did not finish is
    completed only before a run of the release starts the child's next
    step, not before a person runs it by hand (item 4); a rebinding changes
    which words the child's work answers to, not its recorded next step
    (item 5); a dependency added to
    an in-progress subtask is approved but neither waits for nor rebases
    its work (item 1).
- **On acceptance (2026-10-20)** it amends
  [ADR-0063](../0063-autopilot-fresh-session-driver.md) and
  [ADR-0067](../0067-autopilot-worktree-lanes-and-proposals.md) at the places
  listed under §Amendments. Each place keeps its text and carries a dated note
  that points here.

## Amendment 2026-11-22 — the persona reader pins its locale (C141)

Decision 3, item 6 named the persona's process reader as one whose `ps` start
time follows the caller's locale, and cited the lines of both readers. C141
gave that reader and the run locks' reader, which pinned only the locale, a
second reading under `LC_ALL=C` and `TZ=UTC0`, recorded as the macOS
fingerprint's `pinned` field, which alone each compares (ADR-0023 §4,
amendment of 2026-11-22). The item's sentence and its citations now name
both readers as pinned. The clause stays Proposed while ADR-0023's amendment
is (ADR-0070: text that depends on a Proposed decision stays marked Proposed
at its clause), and the Status section says so. The text it replaced:

> macOS reads `ps` with its locale
> pinned to C, as the run locks already do for their fingerprint
> (`plugins/orchestrator/scripts/lib/run-locks.mjs:100-106`, `:125-127`),
> not the persona's reader, whose `ps` start time follows the caller's
> locale (`persona-pipeline/files/scripts/lib/process-identity.mjs:34-44`,
> docket C141, which stays its own item). The sample interval is 10 s, as
> measured.

## Amendment 2026-11-27 — the persona runbooks release their directories

ADR-0059 Decisions 9 and 10 (Accepted 2026-11-26) made the persona plugins'
runbooks (designer, engineer and founder) make each text and operation
directory marked, through `state.mjs tmpdir-make`, and release it through the
CLI's proof once no reader of it is left. ADR-0059's history recorded that two
sentences here would need a cascade once the runbooks switched; they did on
2026-11-27, and this folds both. The orchestrator's runbooks have not
switched, and keep the old text's case. The status of each decision is
unchanged.

Decision 5, item 13 opened with:

> ADR-0059 stands as written: a
> runbook's directories are bounded by where they are made, not by a block
> that deletes them.

It now keeps the bound (the step's or the check's `TMPDIR`) and states both
cases: a switched package's block also releases its directories, and the bound
holds what a release keeps (a refusal, a rerun, a pause); an unswitched one's
deletes nothing.

Decision 2, item 12, **Persona operations**, read:

> The
> operation directory is a private directory the first-write block makes
> (`mktemp -d`) and prints as `OP_DIR=<path>`, which the agent sets in
> the finalize block as it sets `DISPATCH_DIR`.

It now names the marked make and the release by the block that makes the
operation's last write, once that write succeeded, for a switched package, and
`mktemp -d` for one that has not. A last write run again after that release
meets the gone directory this item already describes, whose refusal text names
the recovery (ADR-0059 Decision 10, item 5).

In the same bullet, the sentence on a gone operation directory read:

> A directory that is
> gone refuses the last write, which the person can run with no
> directory, leaving the operation open for the owner to clear; with no
> directory at all a write is as before.

Once a switched package releases the directory after a successful last write,
that text would send a person to repeat a write that already landed. It now
states the CLI's rule (`closingDirMissing` in the persona `state.mjs`): the
directory may have been released after the write ran, and the write is run
again with no directory only once the workflow's record shows it did not
land.
