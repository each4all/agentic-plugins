# ADR-0068: Autopilot lanes that keep going

## Status

Proposed (2026-10-19).
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
  - **Slice 3:** the driver-run verification step, and one lock for heavy
    work.
  - **Slice 4:** main-to-lane instructions read at the next step boundary,
    and rebinding a dispatched subtask after an owner-approved instruction
    change (docket C147).
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
    hold or a kept park (Decision 2, item 2);
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
- **On acceptance** it amends
  [ADR-0063](0063-autopilot-fresh-session-driver.md) and
  [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) at the places
  listed under §Amendments. Each place keeps its text and carries a dated note
  that points here; until acceptance the note announces the proposal and
  changes nothing.

<!--
Citations are `path:line` at agentic-plugins 211283c3, verified 2026-10-19.
Persona scripts are cited at their canonical source under `persona-pipeline/`
(ADR-0066).
-->

## Context

### What the owner decided

Discussion 3, item 3 (2026-10-17), the proposal form (C):
- An owner gate stops only its own lane. The other lanes keep running, and
  the driver picks the lane up again once the decision is recorded.
- Version drift, an exhausted budget and an invalidated approval, a decision
  that changes the plan included, still drain the whole run.
- The owner can take a stopped lane over in a session of their own, in that
  lane's folder, and autopilot resumes from the next step once they close
  it. This needs a mark that keeps the driver off a lane a person is
  working. Whether the driver can resume after such a session was left
  unverified, to be prototyped during the design.
- `/orchestrator:next --parallel` (W1's second stage) is not built.

Discussion 4, item 4 (2026-10-19): the takeover is an explicit
`hold <lane>` / `release <lane>`. While a lane is held the driver does not
touch it, the other lanes go on, and after the release it resumes from the
recorded next step.

The measured cost of today's drain, from the owner's record: in run
`6f6884` the lane `persona-shell` sat idle 8 h 19 m behind another lane's
gate, and in run `8e0400` the lane `orch-shell` 86 m.

### What the code does today

- **Any lane halt drains the run.** `decideLanesStep` returns a subtask's
  halt in `laneHalts`, documented "each drains the run"
  (`plugins/orchestrator/adapters/claude/autopilot/policy.mjs:736-737`);
  the scheduler's `halted` puts the run in `draining` on the first halt of
  any kind (`plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs:453-468`).
  A lane's creation that fails is that lane's halt, and it drains
  (`scheduler.mjs:35-37`).
- **The run-wide halts come first.** Before any lane, `decideLanesStep`
  checks the macro lookup, next-ready, the plan approval, a gate on the
  macro, a terminal macro still active, and the macro-wide claim check
  (`policy.mjs:742-745`, `policy.mjs:756-777`); an archived macro is judged
  by the serial `decide()` (`policy.mjs:748`, its halts at
  `policy.mjs:485-501`). Version drift is checked by the scheduler before
  each decision (`scheduler.mjs:1024-1025`).
- **A worker group that outlives SIGKILL** is checked before anything else
  about a step: "the run cannot go on beside what is left"
  (`policy.mjs:1129-1133`).
- **The run ends when it drains or idles.** A draining run waits for its
  steps in flight, takes one last look, and ends `halted`
  (`scheduler.mjs:991-1008`); a run where nothing runs and nothing can start
  ends `halted` with the decision's idle halt (`scheduler.mjs:1044`). The
  driver writes `halt.json` and exits 2 (ADR-0063 D8). An unexpected error
  is recorded and exits 1 (`driver.mjs:899-904`).
- **The loop wakes on four things only:** a step's end, a rate-limit event
  that changes the throttle, the throttle's reset, a signal
  (`scheduler.mjs:373-385`). A gate the owner clears while other lanes run
  wakes nothing by itself: it is seen only at a look one of those four
  wakes.
- **A step that wrote nothing is judged again on an unchanged record.** A
  spawn error and a step that failed are `worker-failed`
  (`policy.mjs:1136-1154`); a worker that exits with no step report is
  `owner-choice` (`policy.mjs:1153`). The scheduler records the step's
  `finished` event (`scheduler.mjs:773`) before it handles the halt
  (`scheduler.mjs:797`). Under today's drain the run ends there; a lane
  halt that did not end the run would be decided again at the next turn
  from the same record, and a relaunch decides it again too.
- **The per-lane fingerprint** hashes the lane's branch, HEAD and porcelain
  status, its subtask's progress fields and a tuple of its child's fields
  (`policy.mjs:192-214`). It tells progress, not every write: editing a file
  that is already modified changes none of them. Its tuple has changed
  between releases.
- **The relaunch** repeats the run's `--macro` and `--lanes`
  (`plugins/orchestrator/adapters/claude/autopilot/ledger.mjs:86`,
  `plugins/orchestrator/adapters/claude/autopilot/driver.mjs:340-347`). A
  serial run reconciles no lanes and refuses to start only beside a lane
  worktree still holding work (`lanes.mjs:946-965`).
- **Nothing marks a lane as a person's.** A session's admission is
  macro-wide: `admission join` refuses beside any live entry that is not
  the holding run's worker (`plugins/orchestrator/scripts/lib/run-locks.mjs:529-532`),
  so it blocks the whole run or is refused by it. A relaunch adopts an
  in-progress lane (ADR-0067 Decision 5, row 6;
  `plugins/orchestrator/adapters/claude/autopilot/lanes.mjs:542`) whether or
  not a person was working in it.
- **An interactive verb ends terminal.** Outside autopilot, and with no
  owner gate, `finish-verb` sets the terminal marker
  (`persona-pipeline/files/scripts/state.mjs:4288-4306`). Resolving a gate
  ends this way too: the decide selection and the refine Defer run
  `awaiting-owner-clear` and then an interactive `finish-verb`
  (`persona-pipeline/regions/decide-owner-selection.md:86-105`,
  `persona-pipeline/regions/refine-owner-decision.md:137-156`). The Stop
  hook archives the workflow only when its gates pass, a moved HEAD among
  them (`persona-pipeline/files/scripts/stop-archive.mjs:79-90`). Otherwise
  the child stays live and terminal, and the driver follows its recorded
  next step (`policy.mjs:358-374`); archived, it is judged by the
  archived-child rules, which lead to landing (`policy.mjs:377-403`). Which
  of the two a person's session leads to depends on whether they moved
  HEAD.
- **Several commands write a macro's child outside a verb**, the Stop
  hook's branch-agnostic orphan sweep among them, which archives terminal
  children from whichever session's Stop fires
  (`persona-pipeline/files/adapters/claude/hooks/stop.mjs:81-88`,
  `stop-archive.mjs:336`). The workflow file's lock covers single writes
  (`state.mjs:888-900`), not an operation's length.

### Host facts used here

From the macro's preparation notes (2026-10-19, Claude Code 2.1.303). They
are documented, not measured in this repository, and marked [unverified]
where a decision depends on them:
- `claude --resume <session-id>` works from any folder, and refuses a
  session another running process has open.
- SIGTERM leaves a worker's turn unfinished; SIGINT ends it cleanly.
- No host interface tells another process whether an interactive session is
  still going to write.

### Slice 2 (2026-10-19): what the owner decided and measured

<!--
Slice 2 citations are `path:line` at agentic-plugins 90afa503, verified
2026-10-19.
-->

Discussion 3, item 1 (2026-10-17): a step's wall clock kills legitimate
waits (18 cases, no real stall among them), and catches a real stall hours
late. The root of the second is B, a stall judged from output and CPU
activity with a long emergency cap; the rule's numbers come from
measurement. The record of that measurement is outside this repository
(`~/.agentic-plugins/ops/discussion-3/b-measure.md`, 2026-10-17, macOS,
Claude Code 2.1.302, codex-cli 0.163.0). What it found [measured]:
- **Stream silence alone cannot tell.** Over 391 worker streams, the longest
  gap without an assistant or user event was p50 4.7 min, p90 18 min, p99
  64.6 min, at most 115.9 min, each one a worker waiting on a background
  task (a full test run, a mutation run) after its provisional report. Three
  steps the wall clock cut were silent 64.1, 69.7 and 69.1 minutes, the last
  one a legitimate wait that resumed.
- **A foreground tool is never silent:** while it runs the stream carries a
  `tool_progress` heartbeat every 30 s, whatever the tool does. A heartbeat
  says the tool still runs, not that anything progresses.
- **The worker's own `claude` process uses 0 to 0.6 s of CPU per 10 s doing
  nothing.** Its descendants are what tell: a Codex peer wait of 507 s used
  at least 0.1 s in any 60 s window and 1.5 s in any 300 s window (its
  longest run of zero samples 40 s), about 3 s per 600 s by linear
  extrapolation [inferred]; a background test run at least 6 s per
  120 s; a foreground or background wait on nothing 0.0 s; an endless polling
  loop of short processes 0.1 s per 300 s while starting a new process every
  10 s, so counting new processes as activity would never catch it.
- **The peer ledger is no signal:** its `stdout.log` is written once, at the
  end.
- **The rule recommended:** stalled after 10 minutes with no stream event
  other than heartbeats and hooks *and* under 1 s of CPU growth summed over
  the live descendants other than `claude` itself; an emergency cap of about
  8 hours; new process counts ignored; shipped first in a mode that only
  records its verdicts. Its margins: the slowest legitimate activity measured
  is about 3 times the threshold (Codex, two runs only), a stall at least 5
  times under it.

Discussion 3, item 2 and discussion 4, item 3 (2026-10-19): the driver
writes events (a halt, a lane's gate, a commit finished, a worker failed…)
as JSON lines to a file, and the main session watches the file with the
Monitor tool, re-armed every 30 minutes. On 2026-10-19 two lines appended to
a file reached a watching session while it ran other commands [measured,
outside this repository]. A session-to-session message is not usable from a
node driver (its socket format is undocumented), and `--notify-local` stays.

**What the code does today:**
- **One wall clock per step.** The worker host arms
  `setTimeout(() => abort('timeout'), stepTimeoutSec * 1000)`
  (`plugins/orchestrator/adapters/claude/autopilot/worker.mjs:455`); an abort
  sends SIGTERM to the worker's process group and SIGKILL 5 s later
  (`worker.mjs:388-402`). The default is 3600 s (`driver.mjs:74`), settable
  with `--step-timeout` up to the timer's limit (`cli.mjs:72`, `:160`;
  `worker.mjs:229-231`), and the budget reserves it with each step
  (`budget.mjs:54-58`). A timeout halts `worker-failed`
  (`policy.mjs:1136`).
- **No activity signal.** The host reads the stream for background tasks,
  results, denials, PreCompact and rate limits (`worker.mjs:458-502`); it
  keeps no event times, reads no process table, and samples no CPU.
- **Worker processes.** The worker is spawned detached, so its pid leads its
  own process group (`worker.mjs:345-347`); a peer run leaves that group
  (ADR-0063 D5, amendment of 2026-10-13) but stays a descendant by parent
  pid while its runner waits.
- **One macOS process reader is locale-dependent today.** The persona's
  process identity reads `ps -o lstart=` as text in the caller's locale
  (`persona-pipeline/files/scripts/lib/process-identity.mjs:34-44`; docket
  C141, recorded outside this repository); the run locks' fingerprint
  already pins `LC_ALL=C` (`plugins/orchestrator/scripts/lib/run-locks.mjs:100-106`,
  `:125-127`).
- **The run's records** are its run directory (`run.json`, `steps.jsonl`,
  `lanes.jsonl`, `landing.jsonl`, `halt.json`, the worker streams) in the
  launching checkout, and the macro-scoped files under the main worktree
  (`plugins/orchestrator/adapters/claude/autopilot/ledger.mjs:5-41`).
  `appendLine` already ends a torn last line before it appends
  (`ledger.mjs:115-142`). A dead run's cleanup records its halt
  `interrupted` (`dead-runs.mjs:391-407`).
- **The only push signal** is `--notify-local`: one macOS notification when
  the run ends (`driver.mjs:368-375`, `:628`).

**The Monitor tool** (Claude Code, its tool description, read 2026-10-19):
each stdout line of its command is an event delivered to the session; a
monitor expires after its `timeout_ms`, 5 minutes by default and 30 at most,
with one notice; a monitor that emits too many events is stopped; and its
filter must match every terminal state, since silence looks like "still
running".

## Decision

### Decision 1. An owner gate stops only its lane

Serial runs (`--lanes` absent or 1) keep the drain as written, and do not
start beside a hold or a kept park (Decision 2, item 2). With lanes:

1. **Two scopes of halt.** The scope is set by the halt's cause, never by
   its code or by where it is met. A *run-wide* halt drains the run as today
   (ADR-0067 Decision 6, Drain). The run-wide causes are a closed list, and
   the list wins over the code a halt carries:
   - `version-drift`; `budget`;
   - `plan-unapproved`: the approval is missing, pending, or no longer
     matches the plan. A decision that changes the plan revokes the
     approval, so it lands here, wherever it is found, a lane's admission
     included (`scheduler.mjs:593-595`);
   - a gate on the macro (`awaiting_owner` on the macro file);
   - **a halt that names no lane of the plan:** the macro-level halts (the
     macro or next-ready cannot be read, a terminal macro still active, an
     archived macro's halts), the aggregate halts (every subtask terminal
     but not all completed, `policy.mjs:814-817`; finalize run with the
     macro still active, `policy.mjs:818-819`), the unsafe ready-id halt
     (it carries no `subtaskId`, `policy.mjs:801-803`), and a claim problem
     that names no subtask of the plan (the claiming workflows cannot be
     listed, a workflow claims an id the plan does not hold,
     `policy.mjs:439`, `:443`). A halt with no lane has nothing to park;
   - **the run's footing, wherever it is met:** the baseline cannot be
     fetched or the rollback fence cannot be recorded, in reconciliation's
     preparation (`lanes.mjs:795-796`, `:808-809`), in a lane's creation
     (`lanes.mjs:731-732`, `:744-749`) or at a prepared lane's dispatch
     (`scheduler.mjs:604-608`) alike. These concern the main repository and
     its remote, not a lane, and are transient as often as not, so they stay
     out of the kept parks (item 3); the relaunch the owner makes for them
     is their resolution;
   - the halts of a step outside every lane (finalize, and a done once its
     worker started), and of a check on the driver's own checkout, since
     every lane's done runs there. A done whose worker could not spawn
     (`scheduler.mjs:656-662`) ran nothing in that checkout: it parks its
     subtask's lane, waiting to land;
   - a worker group that outlived SIGKILL, in any lane, although its code is
     the lane's `worker-failed` (`policy.mjs:1131-1132`): nothing more may
     start beside a process the run cannot stop;
   - the holds directory cannot be read (Decision 2, item 8).

   `interrupted` still aborts instead of draining. Every other halt arises
   in a lane and is a *lane* halt: `awaiting-owner:<gate>` (each lane gate,
   `recurring-finding` included), `owner-decision`, `low-confidence`, a
   lane's `owner-choice` (a reconciliation row, a branch mismatch, a
   prepared lane whose baseline moved, a claim problem that names this
   subtask, a step with no report), `worker-failed`, `no-progress`,
   `permission-denied`, `compaction-imminent`, a lane's `dirty-tree`, any
   other failed lane creation, and a done that could not spawn.

   Today `claimProblem` returns only the first problem, as a bare string,
   and the decision returns it run-wide before any lane
   (`policy.mjs:438-453`, `:775-776`). The implementation returns every
   problem with the subtask it names, so that a problem on a plan subtask
   (a claim on a subtask not in progress, or that is not its active child,
   `policy.mjs:445`, `:449`) parks that lane.

2. **A lane halt parks its lane.** The lane starts no new step. The rest of
   the run goes on: other lanes step, and new lanes start as the cap and the
   throttle allow.
   - The driver records `parked` in `lanes.jsonl`, with the reason, the
     detail, the pointer, and the lane's fingerprint. It prints
     `■ lane <id>: <reason> — <detail>` and `  other lanes continue`.
   - A parked lane is left out of the decision as a lane with a step in
     flight is: out of readiness, out of the per-subtask checks, out of the
     macro-wide claim check. It holds no capacity, as a lane waiting to land
     holds none.

3. **Every park is kept until it is resolved.** The driver keeps each lane
   park, with its fingerprint, in the macro's records beside the holds
   (Decision 2, item 1), not only in the run. Guarantees:
   - **A park is never lost to a relaunch.** A later run, serial or with
     lanes, finds the kept park before it acts on the lane. A run with lanes
     parks the lane again at once while its fingerprint is unchanged, with
     the same resolution in `halt.json`; a serial run does not start
     (Decision 2, item 2). So a relaunch the owner makes for one lane's gate
     retries nothing in another, whatever the park's reason.
   - **A park is never lost to a crash.** No crash between a failed step's
     end and the park's record lets a relaunch dispatch the lane on its
     unchanged record.
   - **A fingerprint never counts as changed because the code changed.** A
     kept fingerprint taken by another version of the fingerprint (an
     upgrade between runs, a pin that lags on the host running `release`)
     keeps the lane parked; the owner's release resolves it.
   - The kept park ends when the lane is reconsidered (item 4), when a
     relaunch forces a step on the lane (item 8), when `/orchestrator:done`
     records the subtask completed, and when the macro ends.
   - A cause that lies outside the fingerprint (a claim problem in another
     workflow, a stray worktree elsewhere) keeps the lane parked until the
     owner releases it; `halt.json` says so.

4. **Picking a lane up again.** A parked lane is reconsidered when either:
   - its fingerprint differs from the kept one: the owner cleared the gate,
     a next step was recorded, its branch or HEAD moved, its tree was
     cleaned; or
   - the owner releases it (Decision 2, item 7): a hold's release, or a
     *bare release* of a parked lane that is not held, which ends its kept
     park with or without a live run and is never lost, whenever in a run's
     life it comes.

   Reconsidering runs, for that one lane, the part of ADR-0067 Decision 5
   that concerns it (the preparation's items for its path, then its rows),
   planned from the facts of the whole macro, and then judges the lane from
   a fresh look by the usual rules. Today the preparation and the rows run
   only over the whole macro (`planReconciliation`, `lanes.mjs:487`;
   `reconcileLanes`, `lanes.mjs:794`). Lanes with a step in flight are not
   touched. The driver records `resumed` in `lanes.jsonl`. A lane may park
   again at once if the same halt still holds.
   - A lane resumed after a park or a hold is a new lane for the throttle:
     the throttle gates its first step after the resumption, since the
     capacity it left may have gone to other lanes.
   - A claim problem that names this subtask, found while reconsidering,
     parks it again; it does not become run-wide. Its repair,
     `/orchestrator:next <id>`, is refused beside a live run, so the park's
     resolution names `stop`, the re-attach, and the relaunch.
   - To work in a parked lane, hold it first. A person writing in a parked
     lane without a hold changes its fingerprint and may be picked up
     mid-write. Clearing a gate with its resolution command needs no hold,
     and leaves the child non-terminal (Decision 2, item 6), so the driver
     resumes the lane from the recorded next step, with a run live or at the
     next relaunch, never from the landing rules a terminal child would lead
     to.

5. **A failure that writes nothing is never retried on an unchanged
   record.** A failed lane creation, a worker that could not spawn,
   `worker-failed`, `no-progress`, `permission-denied` and a step with no
   report leave the lane's record as it was, so item 4's first case never
   fires by itself. By item 3 the lane stays parked, in this run and the
   next, until the owner changes the record (a note, a next step, a fix that
   moves the branch), releases it, or forces a step (item 8). A creation
   that failed may have left a worktree (`lanes.mjs:756-764`), which is then
   part of the lane's fingerprint.

6. **External changes wake the loop.** For the whole of a run with lanes,
   the scheduler adds a fifth wake-up to the four of
   `scheduler.mjs:373-385`: every 30 s it checks a cheap digest of its wake
   sources and wakes the loop when one changed. The sources cover the hold
   and park records (so the first hold set while every lane runs quietly is
   seen, and a bare release with it), and, while a lane is parked, what the
   owner changes to resolve it: the macro file, the parked lane's child, its
   git HEAD, ref and index (or, with no worktree, its branch in the main
   repository), and, for a lane parked `dirty-tree`, its status.
   - The digest is only a trigger. The look it wakes (off the loop, as every
     look) does the judging, so a change that does not matter costs one
     look. Thirty seconds is the polling interval, not a promise: the lane
     resumes once that look and its own admission (the cap, the throttle,
     its budget reservation) allow.
   - Other edits to the working tree alone wake nothing; they are seen at
     the next look some other change wakes, or at the run's end (item 7).
   - Each tick also retries every hold's handoff still pending (Decision 2,
     item 4), since what blocks one can go away without touching a source.
   - Slice 4 adds the instruction records to the sources. A serial run has
     no timer.

7. **When the run ends.** The run ends when nothing is in flight and nothing
   can start: each remaining lane is parked, held, held with its handoff
   pending, waiting to land, or blocked behind one of those, or the plan is
   done. It does not stay up for the owner: an idle driver would keep the
   macro lock, and with it refuse the owner's own orchestrator commands
   (ADR-0067 Decision 4, item 5), for as long as the owner takes.
   - Before it concludes that nothing can start, the driver consumes every
     pending release and takes each parked lane's fingerprint again,
     reconsidering any that changed, so a lane the owner fixed without
     waking the loop is not left parked.
   - Before it ends, it attempts every handoff still pending. One that
     another holder blocks stays pending at exit, reported with its blocker
     and resolution.
   - A new lane the throttle holds back with a reset to wait for is not
     "nothing can start": the existing throttle wait (ADR-0067 Decision 6,
     Throttle) stays.
   - Exit codes keep their meaning: 0 completed, 2 halted, 1 an error.

8. **Forced resume.** A relaunch's `--lane <id> --next <step>` is the
   explicit resolution of that lane, and ends its kept park. A judgment halt
   that persists in another lane parks that lane only; it no longer drains
   the run while the forced steps finish. A forced step on a held lane is
   refused: release it first.

9. **What `halt.json` and `status` say.**
   - `halt.json` is written at the end, as today. Its `reason` comes from
     the first of: `interrupted`, which wins as it does today
     (`scheduler.mjs:983-989`); a run-wide halt; the first lane still
     parked, in plan order; `owner-choice` naming the subtasks held, with a
     handoff pending, or with an unreadable hold; `awaiting-landing`; the
     idle halt. The codes are ADR-0063 D4's; no new one is added. `also`
     lists the other open parks.
   - Each lane's entry, a subtask held or parked with no lane included,
     gives its state and, for each that waits, its resolution: the gate's
     pointer; for a park, the record change that resolves it or the bare
     `release <subtask-id>`, then the relaunch; for a held lane, its
     `release` command; for a pending handoff, its blocker; for an
     unreadable record, the file. Holds that apply to nothing are listed
     apart and never set the `reason`.
   - While the run lives, `status` shows each lane's state, a parked lane
     with its reason and since when. The relaunch command keeps its form
     (`--macro`, `--lanes`).

### Decision 2. Hold and release

1. **The records.** A hold is a machine record, never prose: one per
   subtask, in the macro's holds directory beside the macro lock under the
   main worktree (`<main>/.agentic-plugins/runs/autopilot/holds/<macro-id>/`,
   ADR-0063 D8), so every run of the macro sees it from any checkout and
   across relaunches. The same directory keeps what the driver and the
   persona record about the hold (its handoff, its release's consumption,
   the persona's open operations) and the kept parks (Decision 1, item 3),
   each record kind apart from the others and under one lock of its own.
   - The owner's record names the subtask, the branch, lane and child it
     was set on, a hold id that a release must name, its state (held,
     released or retired), and who set it and when. Its fields, file layout
     and the order of its transitions are `impl-hold`'s (§Left to the
     implementation).
   - None of the records holds the person's prose: what the person wants
     the driver to know goes in the lane's workflow record, as a next step
     or a note (slice 4 adds instructions).
   - The run ledger repeats the handoffs in `lanes.jsonl` (`held`,
     `released`, `retired`).

2. **Who sets it.** The owner, with
   `agentic-autopilot hold <subtask-id> --macro <id>` and
   `agentic-autopilot release <subtask-id> --macro <id> [--hold <hold_id>]`,
   also reachable as `/orchestrator:autopilot hold` and `release`.
   - A caller whose `AGENTIC_AUTOPILOT` names a run is refused: a worker
     never holds or releases a lane, its own included.
   - The driver never sets or clears a hold. Its own stops are parks
     (Decision 1).
   - Both commands work with or without a live run. A hold on a subtask that
     has no lane yet means: do not dispatch it.
   - **Holds are a lanes feature.** A serial run drives one shared checkout,
     the one the person would work in, and its next dispatch switches that
     checkout's branch. So `hold` refuses beside a live serial run (`stop`
     it instead), and a serial run refuses to start while the macro has a
     hold that applies (held, pending, or unreadable) or a kept park,
     naming each: release it, or run with `--lanes`.
   - `hold` refuses a subtask the plan has recorded completed.

3. **The driver leaves a held subtask alone.** It is never dispatched,
   adopted, reconciled, stepped, recorded done, or removed. It is left out
   of readiness, the per-subtask checks and the macro-wide claim check, as a
   lane with a step in flight is, and holds no capacity. Other lanes go on.
   - The hold covers machine work as well as LLM workers: a job the driver
     runs for the lane (slice 3's verification step) does not start while
     the lane is held.
   - From the moment the record says held, the driver begins no new action
     on the lane, whether or not the handoff (item 4) has completed. It
     reads the hold right before each action that would touch the lane: a
     creation, an admission, a spawn, a removal, a reconciliation row, a
     machine job.

4. **The handoff.** A hold is *pending* until the lane is handed over, and
   *held* after. `hold` and `status` print which, with what still blocks
   the handoff. The person starts once the lane shows held. Guarantees:
   - **A step already running is never aborted.** It runs to its end: it
     is verified, settled and recorded, a commit still reports landing-ready
     (ADR-0067 Decision 7), a creation or removal completes. SIGTERM would
     leave the worker's turn unfinished [unverified], and any abort leaves
     pending peers and an unsettled step. An owner who needs the lane at
     once stops the run (`stop`).
   - **Held means nothing else is in the lane.** The lane is handed over
     only when nothing of the lane is in flight (no step, no task, no
     pending settlement), no other command admitted in the lane and no
     persona operation is still open there (a person's, or a run's), no
     worker or worker group of any run still lives in it (a driver killed
     mid-step leaves its worker's lane busy), and no record of a run that
     ended uncleanly names an unfinished step of it (`stop` or a relaunch
     cleans that up first, `driver.mjs:657-666`). Until then the hold stays
     pending, shown with its blocker.
   - **Held means fenced.** A held lane's worktree lock carries an entry for
     the hold, written before the lane shows held, so no run can take that
     lane, an older driver that does not read holds included. Only the
     hold's own commands remove it, and an older orchestrator's
     `admission release` that removed it is repaired by the next hold-aware
     command.
   - **A hold never races a starting or ending run.** Either a run sees the
     hold before it acts on the lane, or `hold` sees the run and leaves the
     handoff to it. The live run's driver completes handoffs, its end
     attempting its last ones; with no run live, `hold` or `status` does.
   - **No crash leaves a lane shown held but unfenced,** or a fence that
     nothing can name: every crash point leaves a state the next handoff
     completes or a sweep of stale entries repairs.

5. **The person's session.** The person works in the lane's worktree from
   any session: `claude` started in the lane's folder (in the foreground,
   or with `--bg` and attached [unverified]), or
   `claude --resume <session-id>` of the lane's last step, which `status`
   shows [unverified: documented to work from any folder, and refused while
   another process has that session open].
   - **Through the lane's active child.** The persona's verbs,
     `/engineer:commit` and the gate resolutions work on the lane's active
     child, which carries the dispatch linkage the driver resumes from;
     they join no admission. A bootstrap with no dispatch linkage in a held
     lane is refused: the driver could not resume a workflow it does not
     know (a bootstrap takes its linkage only from the dispatcher's
     environment, `persona-pipeline/regions/verb-bootstrap.md:32-60`).
   - **No persona verb where there is no active child.** A held lane with no
     child, or whose child has archived (committed and waiting to land,
     `policy.mjs:384-399`), has nothing a verb could continue:
     `/engineer:commit` finds no active workflow
     (`plugins/engineer/commands/commit.md:65-68`), and a verb would
     bootstrap unlinked. Such a lane is worked by hand (a commit, a push)
     or released for the driver: its release returns it to the landing
     rules or to dispatch. This is a narrowing (§Status).
   - The orchestrator commands that join the macro lock (`/orchestrator:next`,
     `done`, `finalize`, `abort`, `resume`) are still refused beside a live
     run (`run-locks.mjs:529-532`).
   - **A held subtask is never dispatched by hand.** `/orchestrator:next`
     refuses it from whatever checkout it runs in, a held, pending or
     unreadable hold, a release no run has compared yet, and an open persona
     operation alike; and a hold set after its check waits for its dispatch
     to finish (item 4), so `next` never records a subtask in progress that
     its engineer then refuses. The owner releases the subtask, and the
     driver dispatches it once it is ready.

6. **A verb does not close a parked or held lane's workflow.** An
   interactive `finish-verb` of a macro's child records the next step and
   leaves the terminal marker unset, as under autopilot, while its subtask
   is held or has a kept park, or a run of its macro is live. With an owner
   gate it records the gate and stays non-terminal, as it already does in
   either mode (`state.mjs:4288-4293`). So a gate the owner resolves while
   other lanes run, or after the run ended with every lane waiting, leaves
   the child at its recorded next step whether or not the person moved
   HEAD, and the driver resumes from it, never from the landing rules
   (Decision 1, item 4). With none of these, `finish-verb` writes terminal
   as today. `/engineer:commit` commits and closes as under autopilot. The
   ceremony gates stay interactive: a person is there.

7. **Release.** `release <subtask-id> --hold <hold_id>` gives a held lane
   back; `status` and `hold` print the id.
   - **A release names the hold it ends,** and never ends a newer one; two
     commands never both act on one record.
   - **It refuses while a writer may still be active in the lane:** a
     persona operation open there (from its first write to its last, a
     commit through its archive and the parent writeback after it), a
     pending peer ensemble or a live peer run of the child, or its workflow
     file lock held. Every command that writes a macro's child is either a
     persona operation under this exclusion or refuses in a held lane: the
     verbs, `/engineer:commit` and its close, a checkpoint, a gate
     resolution across its clear and its `finish-verb`
     (`persona-pipeline/regions/decide-owner-selection.md:86-105`),
     `/engineer:peer-now`, `/engineer:resume`, and the archives (the Stop
     lifecycle, its orphan sweep from another lane's session, the
     orchestrator's lifecycle archive). The Stop hook's snapshot, which
     writes only the fields the comparison below leaves out, is not one.
   - **One persona operation at a time in a lane of a macro**, whoever runs
     it, held or not: so an operation begun before the hold is seen by the
     handoff, and a person's verb in a lane the driver steps fails that step
     (`worker-failed`, naming the operation) instead of writing beside it.
   - **An operation stopped by an error stays open** until the owner, who
     knows its session is gone, runs `agentic-autopilot writer-clear
     <subtask-id> --macro <id> --operation <operation_id>`. That is the
     owner's word: an operation still running after it is no longer
     excluded, though its own last write refuses once it finds itself
     cleared, as an `admission release` of a live session can let a second
     command in today.
   - **The lane is compared before it steps.** The release records the
     lane's fingerprint together with a content digest of its tree (every
     non-ignored file, checked-out submodules included) and of its child's
     workflow, the fields a snapshot writes left out. Before the lane takes
     its next step, the driver compares them again, once:
     - equal: the release is consumed, the lane's kept park ends, and the
       lane is reconsidered (Decision 1, item 4);
     - different: someone wrote after the release; the release is rejected,
       the lane does not step, and it parks `owner-choice` ("the lane
       changed after its release; stop editing, close the session, then
       hold and release it again"). A rejected release is not compared
       again, even if the tree is put back: only a new hold and release
       give the lane back.
   - **A release is consumed once.** The lane's later progress is never
     compared with it, and no crash makes it count twice or lose its
     effect. A pending hold (never handed over) is withdrawn by its
     release, with nothing to compare.
   - **A bare release** (no `--hold`) ends a parked lane's kept park
     (Decision 1, item 4): with a run live, that run reconsiders the lane;
     with none, the next run judges it afresh. It refuses on a held lane,
     on a lane whose release has not been compared or was rejected, and on
     a subtask neither held nor parked.

   **What the release covers, and what it does not** (the owner accepted
   this narrowing on 2026-10-19; an open point of acceptance, §Status):
   persona operations are fully excluded, for their whole length, those
   begun before the macro had a holds directory included. A person's hand
   edits outside any persona operation leave no mark: the content digest
   catches those made before the driver's comparison, but not one made
   after it, nor one to an ignored file. No boundary is added for them (no
   host interface tells another process whether an interactive session will
   write again [unverified], and a check of processes or of a read-only
   checkout would still leave gaps); `release` tells the person to stop
   editing, and to close the session, first, which is printed, not checked.

8. **Every hold has an exit.**
   - **Unreadable.** A missing record means not held. A record the driver
     cannot read holds its subtask, reported with its path; `hold` and
     `release` refuse to overwrite it. The owner discards it
     (`release <subtask-id> --discard-unreadable`), which keeps a copy and
     never gives the lane back unguarded: a discarded owner's record
     becomes a new hold, released and compared as any other, and a
     discarded record of the driver's or the persona's makes the lane be
     compared again (a lane that changed parks). A holds directory that
     cannot be read is run-wide (Decision 1, item 1), and the persona
     refuses its operations' first writes until it reads again.
   - **Orphaned.** A hold applies to nothing once its subtask leaves the
     plan, its branch differs from the plan's, or the subtask has a
     different lane or child than the hold was set on. The absence of a
     lane or child never orphans a hold: a held subtask whose unused lane
     was removed, or whose child archived, stays held. A hold once orphaned
     or retired never applies again, even when a subtask later reuses the
     id and branch.
   - **Retired.** `/orchestrator:done` retires every record of the subtask
     it completes (the hold, a release, a kept park), so a completed lane
     never parks on a release. A macro that ends (completed, aborted,
     finalized or archived) retires all of its records. `/orchestrator:abort`
     and `finalize` check the holds first and stop while a persona
     operation is open or a lane is busy; they archive a held lane's child,
     and retire the holds only after the macro's terminal write, so a stop
     or crash in their cleanup leaves every hold in force. A retirement
     waits while a persona operation is still open in the lane or a process
     of a run lives there; until then the hold applies and is shown waiting.

9. **Rollout.** Holds work only with hold-aware code on both sides.
   - The engineer release ships first: it keeps the persona's operations
     visible (one schema addition, the list of its open operations on the
     child; a read of the orchestrator's run directory at the first and
     last write of each operation of a macro's child) and makes
     `finish-verb` hold-aware. Then the orchestrator release with the
     driver's holds and the commands. Until that orchestrator runs, the
     persona writes as today and refuses nothing.
   - The driver's lanes capability floor (ADR-0067 Decision 6) gains a token
     for the pinned engineer's hold-aware persona, and a run records in
     `run.json` that it honours holds (it records no capabilities today,
     `driver.mjs:504-520`). A run without it refuses to start while a hold
     applies, and `hold` refuses beside such a live run, so no hold is set
     mid-run beside a run whose own steps would write terminal in a held
     lane.
   - The person's session loads its own engineer, which the run cannot
     check: an older one writes terminal and leaves no operation visible.
     `hold` prints the engineer version the person needs.
   - An older driver started later, or a rollback, cannot read the records.
     The worktree-lock entry still fences an existing held lane from it. A
     hold on a subtask with no lane has no such fence: `hold` warns, and
     rolling the orchestrator back below this release while a hold exists
     is unsupported.

10. **The driver resumes from the record**, by the usual rules, after the
    release is consumed:
    - the child's `next_step` (a verb, a commit, or an owner decision, which
      parks the lane again);
    - a committed child: the lane waits to land;
    - no child: dispatch once the subtask is ready.

    [unverified] That a worker spawned after a person's session in the same
    lane resumes cleanly: the session can leave state no step leaves today
    (peer runs it started itself, session-capture notes, a dirty tree
    recorded in no manifest). The `impl-hold` subtask prototypes this before
    hold ships, and this ADR is corrected from what it finds.

11. **Relaunch with a held lane.** Reconciliation (ADR-0067 Decision 5)
    reads the holds and kept parks of the macro before anything else, its
    preparation included. A held subtask's lane, its handoff done or
    pending, is reported as such and passed by: no row acts on it (no lane
    id written, no removal intent finished, no prepared dispatch, no
    adoption, no removal, no new lane, no halt). A pending handoff is
    completed, a pending release is compared before any row acts, orphaned
    or retired holds are retired, and a kept park is applied again while the
    lane's fingerprint is unchanged (Decision 1, item 3). A held lane is not
    a halt, but a run whose remaining lanes are all held or parked ends
    (Decision 1, item 7), and its report gives the `release` command for
    each held lane.

### Left to the implementation

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

### Amendments

Each place below keeps its text and gets a dated note (2026-10-19) that
points here. Until acceptance the notes announce the proposal and change
nothing.
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

### Later slices

Slices 2 to 4 add their decisions to this ADR and use two seams from this
slice: the wake sources (Decision 1, item 6) and the hold records (Decision
2). Each adds its own Consequences and Alternatives under its own heading.
- **Slice 2:** stall detection, and the driver's event file that the main
  session watches with the Monitor tool. Slice 2 decides their parameters.
  *2026-10-19:* Decisions 3 and 4 below.
- **Slice 3:** the verification step the driver runs without an LLM, and
  one heavy-work lock shared with the mutation harness and interactive
  sessions.
- **Slice 4:** main-to-lane instructions read at the next step boundary, and
  rebinding a dispatched subtask after an owner-approved instruction change
  (C147).

### Decision 3. Stall detection replaces the step clock as the normal stop (slice 2, 2026-10-19)

It applies to every worker step, serial or in a lane, whatever its kind. It
ships log-only (item 7); until the owner switches it on (item 8), the step
clock stays exactly as it is.

1. **The rule.** A step is *stalled* when, for the last 10 minutes of its
   life, both hold:
   - its stream carried no event other than `tool_progress` heartbeats and
     hook events (`hook_started`, `hook_response`, which `--include-hook-events`
     adds); every other event counts as activity, a `result`, a task
     notification, a rate-limit event and a retry event the host may emit
     included; and
   - the CPU time its descendants used, summed, grew by under 1 s, every
     sample of that window known (item 4).

   The verdict is one of `active`, `stalled` and `unknown`. A step younger
   than 10 minutes is `active`. The number of new processes is never read:
   it would hide the polling stall the measurement found.

2. **What the verdict records.** Beside the verdict, the quiet time and the
   window's CPU, the facts of what the step waits on, which can hold
   together: how many background tasks are pending, whether a foreground
   tool runs (its heartbeats arriving), and whether an answer of the model is
   owed (after the step's prompt, a tool result or a task notification, with
   no answer since). The detector judges activity, not cause: a stall, a
   network outage and a hung peer look alike to it, and the record says
   which wait it was.

3. **Whose CPU counts.** The descendants of the worker process, by parent
   pid, and every member of the worker's process group, the worker process
   itself excluded (its `claude` uses up to 0.6 s per 10 s doing nothing).
   - **Identity is the pid with its start time,** so a reused pid is a new
     process, never the continuation of one the step had.
   - **Membership sticks.** A process once seen as a member stays one, by
     its identity, until it exits, so a descendant reparented when its parent
     exits (a detached peer, a daemon) is still counted. One that detached
     before any sample saw it is not, and its work counts as nothing: a
     false `stalled` when it is the only thing working (§Consequences).
   - **Growth is per identity, between samples.** A process first seen
     counts the CPU it used since its start when it started inside the
     window. A process that exits keeps what the samples saw of it; the CPU
     it used after its last sample is not seen, and the CPU of exited
     children is never added to their parent (Linux `cutime`/`cstime`, BSD
     `ps -S`). The measurement was taken that way, and adding it could let a
     polling loop of short processes pass as work (§Status, open point).

4. **A missing sample is unknown, never zero.** A sample is unknown for a
   worker when the read fails, times out or prints what cannot be parsed,
   when a live member of that worker's tree cannot be read, when the
   resolution is coarser than 0.1 s, or when the time since the previous
   sample is not known to be short (item 5). A process proven to have exited
   between the listing and its read is an exit, not a gap. A window holding
   an unknown sample is `unknown`: it never yields `stalled`, and the time
   it covers is recorded. Only the emergency cap bounds a step whose samples
   stay unknown.

5. **Clocks.** Windows, intervals and the quiet time are measured on the
   monotonic clock; wall-clock time appears only in the records, so a
   wall-clock change never shortens or lengthens a window. A suspended
   machine must not read as a quiet window, and the monotonic clock may not
   advance during a suspend (Linux's `CLOCK_MONOTONIC` does not; macOS's is
   likely the same [inferred]), so two samples on either side of one can
   look an interval apart. A window is therefore `unknown` when the samples'
   spacing exceeds three intervals on the monotonic clock, or when the wall
   clock moved forward more than an interval further than the monotonic
   clock between two samples (a suspend, or a forward clock step); the time
   is recorded. A wall-clock step backward, or forward by less than an
   interval, changes no verdict; a larger forward step can only turn a
   window `unknown`, never `stalled`. A suspend is detected only through
   those two bounds: one shorter than an interval looks like a small clock
   step and changes no verdict, the window measured on the monotonic clock
   either way (§Status, open point).

6. **How processes are read.** The requirements: a source on each platform
   that gives each process's parent, group, CPU time at 0.1 s or finer, and
   a start time that makes its identity; and output that does not depend on
   the caller's locale or environment. Linux reads `/proc/<pid>/stat` (procps
   `ps` prints whole seconds, too coarse). macOS reads `ps` with its locale
   pinned to C, as the run locks already do for their fingerprint
   (`plugins/orchestrator/scripts/lib/run-locks.mjs:100-106`, `:125-127`),
   not the persona's reader, whose `ps` start time follows the caller's
   locale (`persona-pipeline/files/scripts/lib/process-identity.mjs:34-44`,
   docket C141, which stays its own item). The sample interval is 10 s, as
   measured.

7. **Log-only, which ships first.** The detector records and never acts.
   - Each verdict change is a `stall` line in `steps.jsonl` and an event
     (Decision 4); the step's `finished` line carries a summary: its longest
     quiet stream gap, its lowest known 10-minute CPU window, the time spent
     unknown, the count of each verdict, and the wait at each `stalled`
     verdict. A `stalled` verdict on a step that later shows activity, or
     ends normally, is visible as such, for the review to judge (item 8).
   - The wall clock stays the step's stop, with its default (3600 s) and
     `--step-timeout`. Landing log-only removes no cap and changes no halt.
   - **The observation configuration.** To observe the long quiet waits the
     measurement found (up to 115.9 minutes), observation runs pass
     `--step-timeout 10800` or more; the default cap would cut them at 60
     minutes first. Observed alongside: Codex peer waits the size of a
     Refine-verify, and the longest gap while an answer of the model is owed.

8. **Switching it on is the owner's review.** After observation the owner
   reviews the recorded verdicts and records the decision as a dated
   amendment of this ADR. The review needs:
   - **evidence that it sees:** at least 20 steps whose quiet stream reached
     10 minutes with every CPU window known, 5 of them Codex peer waits of 5
     minutes or more, and the measured stall shapes (a foreground wait on
     nothing, a background sleep, a polling loop) judged `stalled` on the
     owner's machine. A run of `unknown` windows is a probe defect to fix,
     never a pass;
   - **no false positive:** no `stalled` verdict on a step that was doing
     legitimate work the rule did not see (a model answer under way, a
     descendant working unseen), judged by the owner from the step's
     records. A step that later showed activity or completed is not by that
     alone a false positive: a staged stall that completes (a `sleep 900`)
     and a hung retry that recovered were stalled when judged;
   - **the model's gap:** the longest gap observed while an answer of the
     model was owed well under 10 minutes. A single long model response may
     emit no stream event until it is done [unverified]; if the gap comes
     near the threshold, the detector first gains a signal for it
     (partial-message events, which the worker does not request today) and
     is observed again.
   - A false positive sends the numbers back to measurement; it does not
     shorten the review.

   Switched on, with `--stall-detector on` (the default stays `log` until a
   later release changes it, once the review has passed):
   - a `stalled` verdict aborts the step as a timeout does, with abort reason
     `stalled`, the same group teardown and the same charge to its
     reservation (the whole reservation when no cost was reported,
     `budget.mjs:70-81`), and the step halts `worker-failed`, its detail
     naming the stall and the wait. Decision 1 scopes that halt by its
     cause, as any: in a lane it parks the lane, while a stalled `done` or
     `finalize` step, a group that outlives SIGKILL, and an exhausted budget
     stay run-wide. `unknown` never aborts;
   - the default step wall clock becomes the **emergency cap**, 28800 s
     (8 h); an explicit `--step-timeout` still wins. It bounds what the rule
     cannot see: a step busy forever (a loop burning CPU is never stalled)
     and a step whose samples stay unknown.

9. **A network outage** (2026-10-19: the API unreachable, `ENOTFOUND`,
   retries exhausted). The worker owes an answer of the model; no
   descendant runs, so the CPU is 0. While the host retries, any retry event
   it emits counts as activity; once the retries are exhausted the result is
   an error and the step halts `worker-failed` by today's rule, as it did
   that day, the edits in the tree kept. A retry that hangs for 10 minutes
   with no event is a `stalled` verdict, the model's answer owed; switched
   on, it also ends `worker-failed`. Either way the policy is Decision 1's:
   nothing is retried on an unchanged record, each lane the outage reached
   parks, and the run ends once nothing can start. After the network
   returns, the owner resumes with a note and `--lane <id> --next <step>`,
   or a bare release. Several lanes failing within minutes of each other in
   the event file is the hint of a shared cause; the event file is local
   and needs no network to be written or read.

10. **Until the worker exits.** The detector watches the step from its spawn
    to the worker's exit, an idle close of stdin included: a worker that
    ignores that EOF, or hangs shutting down, is quiet and idle, and is
    judged like any. Only a close on a finished report, which has its own
    bounded teardown (ADR-0063 D5, amendment of 2026-10-13), and an abort
    already under way end the watch. A peer run the step left pending stays
    the concern of D5's cleanup. The driver's own jobs without an LLM (slice
    3's verification step) are slice 3's to bound.

### Decision 4. The driver's event file, watched by the main session (slice 2, 2026-10-19)

1. **Where, and who writes.** One append-only file per lock scope, so that
   one run drives what it reports at a time, and each relaunch continues the
   same file:
   - a run of a macro:
     `<main>/.agentic-plugins/runs/autopilot/events/<macro-id>.jsonl`, beside
     the macro's landing log, findable from any checkout of the repository;
   - a run with no macro (a verb chain):
     `<checkout>/.agentic-plugins/runs/autopilot/events.jsonl`, beside its
     worktree lock.

   The writers are the driver of a run once it holds its locks, and the
   cleanup of a run whose driver died (`stop`, or a later run's cleanup),
   which writes that run's `run-ended`. A launch refused at its locks writes
   no event, and the reader never reports it as a run missing its terminal
   event: today it still creates a run directory and ends `halted`
   `owner-choice`, with `halt.json`, `run.json` and exit 2
   (`driver.mjs:502`, `:640-646`), and how the reader tells such a run from
   one that held its locks is `impl-events`'. Appends are
   serialized by a lock of the file, but a dead run's cleanup can finish
   after the next run has begun (a cleanup that is busy does not stop a new
   run, `driver.mjs:657-671`), so lines of two runs can interleave. Owner
   commands write no events: a hold or a release appears when the driver
   acts on it. The driver prints the path, and the command that watches it
   (item 6), when it starts.

2. **One line per event, machine data only.** Each line is a JSON object:
   `schema` (`agentic-autopilot-event/1`), `run_id`, `seq`, `at` (UTC),
   `kind`, `macro_id`, `subtask_id` (or null) and the kind's own fields, each
   a code from a closed set, an id checked against its alphabet, a number, or
   a path the driver resolved itself. There is no free text: no detail
   string, summary, peer output, worker report or user text. The line points
   at the record that holds the rest, as it stands when the line is written:
   a step's line in `steps.jsonl`, a `lanes.jsonl` event, `run.json`, and
   `halt.json` only from the `run-ended` of a run that halted, since the
   driver writes it only then, when the run ends (`driver.mjs:603-605`); a
   run that completed has none, and its `run-ended` points at `run.json`.
   Monitor puts every line into the main session's context, so nothing a
   worker, a peer or a person wrote may reach it this way (the runtime rule
   of no raw peer output in the main session).

3. **The kinds**, a closed list; a later slice adds kinds with a minor
   schema change, and readers ignore fields they do not know. A step is
   referred to by its ledger `step` number, never by the event's `seq`:
   - `run-started` (lanes, detector mode, the ledger's path);
   - `halt`: a run-wide halt, met, with its reason code; the run drains or
     ends. Met mid-run, the halt is recorded only as `run.json`'s `draining`
     status (`scheduler.mjs:453-468`), so the line points at `run.json`, and
     at the step's `steps.jsonl` line when a step met it; the halt's detail
     reaches `halt.json` at the run's end;
   - `lane-parked` (reason code, pointer: an owner gate set, and every other
     lane halt) and `lane-resumed` (cause: its record changed, a release, a
     forced step), Decision 1. A cleared gate has no kind of its own: the
     owner clears it in a session, which knows it then, and the file shows
     it only as `lane-resumed` with cause "its record changed", when a live
     driver reconsiders that lane; a gate cleared in a serial run, or after
     the run ended, shows nothing until the next run acts on the lane
     (§Status, open point);
   - `lane-held` and `lane-released` (consumed or rejected), when the driver
     completes a handoff or compares a release, Decision 2;
   - `step-failed` (step, the halt code, the abort kind when there was one,
     from the worker's closed set: `timeout`, `stalled`, `interrupted`,
     `compaction-imminent`, `provenance`);
   - `commit-finished` (step, the commit, its landing readiness, ADR-0067
     Decision 7);
   - `stall` (step, verdict, mode, the wait's facts, quiet time, window
     CPU), Decision 3;
   - `run-ended` (status, halt reason or none, exit code, the pointer, and
     whether a cleanup wrote it for a driver that died). It is the only kind
     marked `"terminal": true`, at most one per run: a writer appends it
     only when the file holds none for that run, so a driver's end, a
     cleanup, and a cleanup retried after a crash write it once between
     them.

   No line is written per step started or finished, and a `stall` line only
   when a step's verdict changes.

4. **Identity.** An event is `(run_id, seq)`; `seq` counts from 1 within a
   run and only rises. No two lines of a file share an identity, a line
   ended after a writer died mid-line included. A `seq` may be skipped, so a
   gap is not proof of a lost event, and a lost event need not leave a gap:
   the failure count in `run.json` (item 5) is what tells. How a writer
   chooses its next `seq` is `impl-events`'. An event exists once its line
   is complete and parses; a line that never does never had an identity.

5. **Writes.**
   - **Recoverable lines.** Each event is appended as a whole line under the
     file's lock. A writer that dies mid-line leaves a torn last line, which
     the next append ends first (`appendLine`'s rule, `ledger.mjs:115-142`),
     so the events after it parse; the reader reports the torn one.
   - **A failed write never stops the run.** The run's records stay the
     truth, and the event file is a signal: the driver prints a warning and
     counts the failure in `run.json`, which the reader reports (item 6).
     The publication is best effort; the records it points at are not.

6. **The reader, and the Monitor recipe.** `agentic-autopilot events
   (--macro <id> | --checkout <dir>) --after <run-id>:<seq> [--follow]`
   prints, one per line and in file order, every event after that one; with
   `--follow` it then waits for more, across relaunches, since a relaunch
   writes to the same file. It holds a partial last line until its newline
   arrives.
   - **Arming before anything is on file.** `<run-id>:0` means from that
     run's first line, whenever it arrives: a run whose first write failed,
     or that has written nothing yet, is waited for, as is a file not yet
     created. Only a cursor naming a `seq` its run's lines on file do not
     hold is an error. A run that ends with no line on file is reported
     missing its terminal event (below), and the watch goes on with the
     lines of the runs after it.
   - **No loss, no repeats across an expiry or a relaunch.** Re-armed with
     the identity of the last line it delivered (an event's, or a
     `reader-summary`'s last identity covered), the reader neither skips nor
     repeats an event, interleaved runs included: the cursor is an identity,
     not a position in a run's sequence.
   - **No loss, and bounded repeats, across a restart of the main session.**
     The file records what was published, not what the session received, so
     a session that lost its cursor re-arms from `<run-id>:0` of every run of
     the macro it has not seen end, and recognizes by identity what it had
     already handled.
   - **Silence is reconciled.** At each arm, and every 30 s while it
     follows, the reader compares the file with the run's own records. It
     prints on stdout, where Monitor sees it, never only on stderr: a
     `reader-armed` line at each arm (the latest run live or ended, its last
     `seq` on file, its failed writes); a `reader-gap` line for a `seq`
     missing within a run, a hint (item 4); a `reader-skipped` line for a
     line it cannot parse; a `reader-terminal-missing` line, pointing at the
     run's records,
     for a run that has ended or died with no `run-ended` on file (a failed
     last write, a crash before it, a dead run nothing has cleaned yet); and
     a `reader-error` line, then a non-zero exit, when the file cannot be
     read or the cursor is an error (above). A cursor not found is never
     read as "from the start".
   - **Volume is bounded, for `stall` lines only.** Replaying a backlog, or
     a burst while it follows, the reader may fold `stall` lines past a
     fixed number per delivery window into one `reader-summary` line (counts
     by verdict, the last identity covered), which keeps file order: it
     covers only `stall` lines that come before the next line passed on its
     own. Those arrive as counts, not lines, and their records keep them.
     Every other kind, and every
     `reader-` line, is always passed on its own. A monitor stopped early,
     for volume or any other cause, is re-armed as after an expiry.
   - **The recipe**, in `commands/autopilot.md`: Monitor runs the reader
     with `--follow` and `timeout_ms` at Monitor's maximum, 30 minutes; at
     each expiry or early stop the session re-arms it with the cursor of the
     last line it received, or with the `<run-id>:0` the driver printed at
     start when it received none. The reader is the filter, so the recipe
     adds none; a session that narrows it must keep every line with
     `"terminal": true` and every `reader-` line, and the documented pattern
     is tested against the kind list.

7. **Beside the other signals.** Terminal output, `halt.json` and exit code
   2 stay the halt signal (ADR-0063 D8), and `--notify-local` is unchanged.
   The event file is a ledger file in the repository, read by a local
   process: no plugin notification, no egress, no ADR-0047 kind (ADR-0063
   Q5 stands). The driver never truncates or rotates it; its lines are few
   and short, and its retention is left to a later decision.

### Left to the implementation (slice 2)

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

### Amendments (slice 2)

Each place below keeps its text and gets a dated note (2026-10-19) that
points here. Until acceptance the notes announce the proposal and change
nothing.
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

## Consequences

### Slice 1

**Positive**:

- One gate no longer idles every lane: the 8 h 19 m and 86 m idles measured
  in runs `6f6884` and `8e0400` become that one lane's wait.
- The owner answers a gate while the run lives, and the lane continues after
  the next poll and look, with no relaunch; answered after the run ended,
  the lane resumes from the recorded next step at the relaunch.
- A failure is no longer retried against the record that produced it, in
  its run or the next; it waits for a change or an explicit release. A done
  that could not spawn parks only its lane.
- A person can take one lane over without stopping the others, and the
  driver resumes from what they recorded.
- The holds are machine records any run reads, never prose to interpret,
  and a held lane's worktree lock fences it from older drivers too.
- Every hold has an exit: a release is spent once consumed, a completed
  subtask and an ended macro retire their records, and a discarded
  unreadable record holds the lane anew instead of giving it back unchecked.

**Negative**:

- The scheduler gains a state per lane (parked, held, pending hold, pending
  release), kept parks, a timer, a per-lane reconsideration, and more
  final-report cases. A bug there can strand a lane; the `lanes.jsonl` lines
  and `status` make it visible.
- A run with every remaining lane waiting still ends. The owner relaunches
  after answering, as today; the gain is only while other lanes run.
- A park whose cause lies outside the lane's fingerprint stays parked across
  relaunches until the owner releases it.
- The release excludes the persona's operations, not every writer: a hand
  edit made after the driver's comparison, or to an ignored file, is not
  caught. The content digest costs a `git write-tree` per release and per
  comparison, and one more per checked-out submodule [unverified on a large
  tree].
- One persona operation at a time runs in a lane of a macro; one stopped by
  an error stays open until the owner's `writer-clear`, as a stale
  admission entry does today. The persona depends on the orchestrator's run
  directory, takes one more lock per operation of a macro's child, and
  gains a schema field. Holds need both releases, persona first, and a
  rollback past this release while a hold exists is unsupported.
- A held lane gets no new workflow and no dispatch by hand; one with no
  active child is worked by hand only. A serial run does not run beside a
  hold or a kept park.
- A hold's handoff waits for anything still in the lane, so a hold can stay
  pending until the owner clears the blocker; a release rejected for a
  mismatch stays rejected until a new hold and release.
- The mechanism is left to two implementation subtasks with a list of cases
  to test; this ADR is corrected from what they and the prototype find.

**Neutral**:

- Serial runs keep the drain.
- The halt reason codes and the gate enum are unchanged; only the scope of a
  halt changes.
- Exit codes keep their meaning: 0 completed, 2 halted, 1 an error.

### Slice 2

**Positive**:

- Once switched on, a real stall is caught about 10 minutes after it
  begins instead of at the step clock (60 minutes by default, 3 hours as the
  owner runs it), and a legitimate quiet wait is no longer cut at that clock:
  none of the 18 waits discussion 3 counted would have met the clock, and
  whether the rule passes each such wait is what log-only observes.
- Log-only first: the rule is judged on the owner's real runs before it can
  stop anything, and a false positive costs a record line, not a step.
- The main session learns of a park, a halt, a failed step or the run's end
  while it works, without polling status, and across relaunches from one
  file; a re-arm loses and repeats no event, `stall` lines past the volume
  bound arriving as counts.
- Nothing a worker, a peer or a person wrote reaches the main session
  through the event file.

**Negative**:

- The driver samples the process table every 10 s for the run, and keeps a
  per-process table and a stream clock per worker. A probe bug shows as
  `unknown` verdicts, which only the log reveals in log-only mode.
- The rule is measured on few Codex waits (two) and never on a long single
  model response; the switch waits for that measurement, and the step clock
  keeps cutting legitimate waits until then, unless the owner passes a long
  `--step-timeout`.
- A stall that keeps a process burning CPU is caught only by the emergency
  cap, 8 hours.
- The reverse error: a descendant that detached before any sample saw it
  does its work unseen, and if nothing else is active the step reads as
  stalled. Log-only observes how often; switched on, such a step is aborted
  and parks its lane for the owner.
- A stalled step that reported no cost is charged its whole reservation, as
  a timed-out one is today.
- A polling loop of short processes reads as stalled even when what it
  polls for is about to happen: the rule's measured basis ignores exited
  processes.
- The main session's own watch is bounded: Monitor expires every 30 minutes
  and the session re-arms it; a session that does not re-arm misses nothing,
  but hears nothing until it does.
- One more append, and one more file lock, per event; a failed write is a
  count in `run.json` the reader reports, not a stop, and the event it lost
  is not replayed.
- A cleared lane gate is not an event of its own: the session that cleared
  it knows, and the file shows it only when a live driver resumes the lane.

**Neutral**:

- The halt codes are unchanged: a stall ends `worker-failed`, as a timeout
  does. `--notify-local`, `halt.json` and exit codes keep their meaning.
- The event file only adds a signal; every decision still reads the run's
  records.

## Alternatives Considered

### Slice 1

**Keep the drain (today).** Rejected by the measured idles above: a gate in
one lane cost the other lane hours.

**Lane-only gates, but the run stays up for the owner when every lane
waits.** Rejected: an idle driver keeps the macro lock for as long as the
owner takes, and admission then refuses the owner's own `/orchestrator:done`
and `next`. A long-lived idle process also needs its own stop and liveness
story. The relaunch already resumes from the record.

**Scope a halt by its code, or by whether it names a subtask.** Rejected
(Plan-verify, critique): a done names its subtask but runs in the driver's
checkout, which every lane's done shares; a worker group that outlived
SIGKILL leaves a process the run cannot stop; yet a done whose worker could
not spawn ran nothing there, and the owner asked that a spawn failure park
only its lane. Scope follows the cause.

**Parks live only in the run, or only failure parks are kept.** Rejected
(critique): the owner relaunches whenever every lane waits, and a relaunch
made for one lane's gate retried another lane's failure on an unchanged
record; keeping parks by reason code missed a step with no report, and a
gate resolved after the run ended was then archived into the landing path.
Every park is kept with its fingerprint.

**Scope a baseline-fetch failure by where it is met.** Rejected (critique):
the same failure was run-wide in the preparation, a kept park in a lane's
creation, and an in-run park at a prepared dispatch; a network blip during a
creation kept a park nothing but a release could end. It is run-wide
wherever it is met.

**Wake on `fs.watch`.** Rejected: the record files are replaced by rename
(atomic writes), which watchers report differently per platform [unverified:
FSEvents coalesces, inotify watches the old inode], and some homes may sit
on network filesystems. A 30 s stat poll is portable and costs one look per
real change. Slice 2's event file serves the main session, not the driver's
own wake-up.

**Retry a failed lane with backoff.** Rejected: a retry against an unchanged
record repeats the failure, or worse, repeats a partial step. In the
network outage of 2026-10-19 the edits survived and the right resumption was
a note plus a forced next step, which is a record change. Telling a stalled
worker from a slow one is slice 2's stall detection.

**Detect a person's session instead of an explicit hold.** Rejected: no host
interface reports whether an interactive session will write again, and
guessing from processes or session files would hand a lane back while a
person still works in it.

**Hold as a field of the macro subtask.** Rejected: writing the macro needs
an admission, which a live run refuses (ADR-0067 Decision 4, item 5). The
field would also have to be placed against the plan hash, which covers a
fixed list of subtask keys (`plugins/orchestrator/scripts/state.mjs:374-393`):
inside the list, a hold would revoke the approval and drain the run; outside
it, every writer of the macro would have to carry one more progress field.

**Hold as an admission entry in the macro lock.** Rejected: that entry is
macro-wide by design (ADR-0067 Decision 4, item 5) and would stop every lane.
The hold's fence goes in the lane's worktree lock instead, which stops only
that lane.

**Guard the release with the per-lane fingerprint alone.** Rejected
(Plan-verify): it hashes the porcelain status, so editing a file that is
already modified changes nothing it reads. The content digest is added.

**Announce held as soon as no worker of the lane is in flight.** Rejected
(Plan-verify): a lane's creation, an admission that removes an unused lane,
a settlement and a removal run outside the worker's flight, and a command
already admitted or a persona operation already open would share the lane
with the person. The handoff waits for all of them.

**A release as a standing state.** Rejected (Plan-verify): read as a
continuing request it would retry a failure on every turn, and compared on
every relaunch it would reject the driver's own later progress. Each release
is consumed once.

**Release when a next step was recorded after the hold, or exclude only
operations begun under it.** Rejected (critique): a person who held a lane
and ran no verb never records one, `/engineer:commit` keeps the previous
next step while it commits
(`persona-pipeline/files/scripts/state.mjs:4398-4409`), and an operation
begun before the hold was invisible to the handoff; each let a release pass
while a writer still wrote. Every operation of a macro's child is visible,
held or not, and the release waits for all of them.

**Abort the step running when the hold is set.** Rejected: SIGTERM leaves
the turn unfinished, and any abort leaves pending peers and an unsettled
step to clean up. The step ends within its bound; `stop` remains for a
person who cannot wait.

**A hold that expires.** Rejected for the reason ADR-0067 rejects expiring
admission entries: expiry hands the lane back while a person may still be
writing.

**Let the driver hold a lane on failure.** Rejected: a hold is the owner's
statement that a person has the lane. The driver's own stops are parks,
which end with a record change, a release or a forced step.

**End a hold on weaker evidence.** Rejected (critique), each because the
lane went back to the driver unguarded: discarding an unreadable record to
"not held" (no release, no comparison); orphaning a hold when its lane or
child is absent (an unused lane removed while a hold appears, then a new
lane created and the held subtask dispatched); retiring the holds when
abort or finalize begins (a cleanup that stopped left a live macro whose
held lane a relaunch adopted). A discard holds the lane anew, only a
different lane or child orphans a hold, and holds retire after the
terminal write.

**Honour holds in serial runs.** Rejected (critique): a serial run has one
checkout, which the person would share with the driver, and its next
dispatch switches that checkout's branch under them.

**Let a person bootstrap a new workflow in a held lane.** Rejected
(critique): a bootstrap takes its dispatch linkage only from the
dispatcher, so the driver could not resume the person's workflow. A person
works through the active child; a lane with none is worked by hand or
released.

**Specify the handoff and writer protocol in this ADR.** Rejected after six
review rounds (2026-10-19): each refine that added protocol detail (ack
files, fence order, writer-mark fields, crash windows) drew defects in the
new detail, and the ADR doubled in length for two decisions. The ADR states
the guarantees and the cases; `impl-lane-gate` and `impl-hold` build and
test the mechanism (§Left to the implementation).

**Interactive lanes (`/orchestrator:next --parallel`).** Not built, the
owner's decision of 2026-10-17: the takeover covers the need, a person works
a held lane in a session of their own (`claude`, or `claude --bg` and
attached), and team communication between sessions goes through records at
step boundaries (slices 2 and 4).

### Slice 2

**Keep the wall clock alone, longer or shorter (today).** Rejected by the
measurement: legitimate waits ran silent up to 115.9 minutes, so a clock
long enough for them catches a real stall hours late, and one short enough
to catch it kills legitimate waits.

**Judge from stream silence alone.** Rejected [measured]: the p99 silent gap
of a legitimate step was 64.6 minutes, and a foreground stall is never
silent, its heartbeat arriving every 30 s.

**Count heartbeats, new processes, or the peer ledger as activity.**
Rejected [measured]: a heartbeat says only that a tool runs, and arrived
throughout a foreground wait on nothing; an endless polling loop starts a
process every 10 s with almost no CPU; the peer's `stdout.log` is written
once, at the end.

**Count the worker's own `claude` CPU.** Rejected [measured]: it uses up to
0.6 s per 10 s doing nothing, up to 36 s over 10 minutes at that rate
[inferred], far above the threshold.

**Add exited children's CPU to their parent** (`cutime`/`cstime`, `ps -S`).
Rejected: the threshold was measured without it, and a polling loop's short
processes, reaped by its shell, could add up past 1 s per 10 minutes and
hide the stall the rule exists to catch [inferred: their CPU was not
measured].

**Switch it on from the start.** Rejected: the Codex margin rests on two
runs, and a long model response was never measured; a false positive would
kill a paid step. The owner chose log-only first (discussion 3, item 1;
discussion 4).

**Retry a stalled or failed step automatically.** Rejected, as in slice 1:
the record is unchanged, so a retry repeats the failure or a partial step;
an outage's right resumption was a note and a forced next step.

**Read `ps` time and start-time text in the caller's locale.** Rejected: the
persona's macOS process identity already reads differently in a Korean and
a C locale (C141), and a verdict must not depend on who launched the driver.

**Notify the main session by `SendMessage`, Channels or team mode.**
Rejected: the message socket's body format is undocumented, Channels needs
an MCP server and is a research preview, and team members cannot be
headless. A file a local process appends to, watched by Monitor, needs
none of them and was measured to arrive mid-turn.

**Watch `steps.jsonl` and `lanes.jsonl` directly.** Rejected: they live in a
run directory that changes with each relaunch, they hold free text (a
worker's summary in a halt's detail), and a step's start and finish would
flood Monitor.

**One event file per run, or per repository.** Rejected: per run, a
relaunch needs a new watch on a new path; per repository, runs of several
macros would write one file at once, and a session watching one macro would
read every other's events. One file per lock scope has one live run at a
time, a dead run's late cleanup aside, and survives relaunches.

**Byte offsets as the replay cursor.** Rejected: an offset means nothing to
a person, and gives no way to see a lost event. The event's identity can be
read from the line the session last received, and a loss shows in the
failure count the reader reports.

**A cursor file the reader advances, for exactly-once delivery across a
session's restart.** Rejected: the reader cannot see what Monitor delivered,
so a cursor it advances on printing loses the lines a dying session never
received, and one it advances before printing loses the next. A restarted
session replays from each run it has not seen end and recognizes repeats by
identity.

**Stop watching at any close of stdin.** Rejected (Plan-verify): an idle
close has no bounded teardown, so a worker that ignored its EOF would be
held to the 8-hour cap, keeping its reservation and its lane.

**Copy each halt's detail into its event.** Rejected: the detail can carry a
worker's summary or the tail of its stderr, which would enter the main
session's context unfiltered. A `halt` line points at the run's records,
and the `run-ended` of a halted run at `halt.json`.
