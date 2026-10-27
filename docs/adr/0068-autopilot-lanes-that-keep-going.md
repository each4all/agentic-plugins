# ADR-0068: Autopilot lanes that keep going

## Status

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
  [ADR-0063](0063-autopilot-fresh-session-driver.md) and
  [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) at the places
  listed under §Amendments. Each place keeps its text and carries a dated note
  that points here.

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

### Slice 3 (2026-10-20): what the owner decided and measured

<!--
Slice 3 citations are `path:line` at agentic-plugins 1048c8d2, verified
2026-10-20.
-->

Discussion 3, item 1 (2026-10-17): the root of the first problem, legitimate
waits killed by the step clock, is C: machine work that takes hours (mutation
runs, full test runs) leaves the LLM step and runs in the driver, designed
together with the heavy-work lock ADR-0067 left out of scope. Shrinking the
checks inside a step (D) treats the symptom and was not adopted. Discussion
4, items 1 and 2 (2026-10-19):
- **A verification step the driver runs.** A worker makes its edits and
  quick checks and closes its step with the checks to run recorded; the
  driver runs them with no LLM and records the results, and the next LLM
  step reads them. The list is the worker's, plus the tests that read the
  changed files (docket C150).
- **One heavy-work lock.** The driver's verification jobs run one at a time
  by default, under one lock file shared with the mutation harness and
  interactive sessions, extending the harness's lock.

The facts behind them [measured, recorded outside this repository]:
- All 18 `worker-failed` steps discussion 3 counted were workers waiting,
  after a provisional report, on a background full test run, mutation run or
  peer; the three since C127 were cut at 7200 s and 10800 s waiting on 62 and
  51 mutations and a Refine-verify
  (`~/.agentic-plugins/ops/discussion-3/prep.md`).
- Docket C145 (2026-10-16): the landing tests pass alone in 24 s; seven
  failed, at 80 to 127 s, under a load of 40 to 64 while lanes ran full test
  runs at once.
- Docket C150 (2026-10-18, PR #974): a refine changed the finalize order in
  the pipeline's region `persona-pipeline/regions/verb-finalize.md` and the
  runbooks generated from it, and the targeted tests its step ran missed
  `tests/plugin-shape/test-engineer-autopilot-runbooks.mjs`. That test reads
  each generated runbook through a path it builds, the plugin root joined to
  `commands/${verb}.md`
  (`tests/plugin-shape/test-engineer-autopilot-runbooks.mjs:29-31`, `:55`);
  of the generated runbooks it spells out only `commands/decide.md` and
  `commands/refine.md`, relative to the plugin (`:173`, `:200`), and the
  region only in a comment (`:43`). Seven tests failed in CI.

**What the code does today:**
- **Long checks run inside the step.** The worker runs the test suite, the
  mutation harness and its peers itself, and its step waits for them under
  the step's wall clock (Decision 3).
- **One lock, the harness's.** `scripts/mutation-harness.mjs` takes
  `<git-common-dir>/mutation-harness.lock`, which every worktree of a
  repository shares (`:820-843`). Its record is written whole and
  hard-linked into place (`:908-918`); its holder is judged by pid, host and
  a start time spelled independently of locale and clock (`:855-906`); a
  stale lock is reaped under a guard, one reaper at a time (`:980-1034`); and
  waiters poll every 2 s, in no order (`:1040-1083`). On a signal it stops
  its test runs before it releases (`:1124-1141`). It acquires
  unconditionally (`:1157`), so a process that holds the lock and runs the
  harness waits on itself. Nothing else takes a lock: two lanes' test suites
  run at once (ADR-0067 §Out of scope).
- **A step's cost.** A spawned step that reported no cost is charged its
  whole reservation
  (`plugins/orchestrator/adapters/claude/autopilot/budget.mjs:70-81`).
- **The next step's kinds are closed in both packages:** `verb`, `commit`,
  `owner-decision`, `done`
  (`plugins/orchestrator/adapters/claude/autopilot/policy.mjs:24`;
  `persona-pipeline/files/scripts/state.mjs:253`). The persona's parser
  validates the kind on every read (`state.mjs:1965`, `:2163-2165`), so an
  older reader refuses a workflow file holding a new kind; an unknown key, by
  contrast, is carried (`:1932-1942`). The driver stops on a kind outside its
  enum with `owner-choice` (`policy.mjs:362-365`).
- **The driver reads a child through the persona's CLI**
  (`plugins/orchestrator/adapters/claude/autopilot/observe.mjs:348-349`) and
  checks the persona's surfaces with source probes before a run
  (`plugins/orchestrator/adapters/claude/autopilot/roots.mjs:101-123`).

### Slice 4 (2026-10-20): what the owner decided and measured

<!--
Slice 4 citations are `path:line` at agentic-plugins a739c10d, verified
2026-10-20.
-->

Discussion 3, item 3 (2026-10-17): the parallel work the owner wants is the
main session's, which sets up several lanes and must talk with each, as a
team lead does with its members. Communication at step boundaries, through
records: lane to main (Decision 4), main to lane (the next step to take),
lane to lane (a shared note). Instructions in the middle of a step stay out
of autopilot (item 2). Discussion 4, items 5 and 7 (2026-10-19): the main
session instructs a lane without stopping the run, a note and a next step in
the lane's record that the driver reads at its next boundary; lane-to-lane
notes are deferred; and docket C147 is in scope.

The facts behind them [measured, recorded outside this repository]:
- **Docket C147 (2026-10-18, run 467d51, lane orch-shell).** An owner
  decision changed what an in-progress subtask was to do. The new
  instructions reached the child through a gate resolution, and the
  subtask's `topic` was revised with `plan-set` and approved again. After
  the pull request (#968) landed, `/orchestrator:done` refused
  `dispatch-changed` and the run halted `owner-choice`. The recovery put the
  topic back to the words of the dispatch and approved the plan again. The
  rule kept since: changed instructions for an in-progress subtask go into a
  gate resolution, and a topic is revised only before its subtask is
  dispatched.
- **Notes by hand.** In this macro the owner's session appends an operator
  note to a lane's child with a script: it polls the run's `steps.jsonl`
  until the subtask's dispatch step has finished, then runs the persona's
  `append` with the note in a file. Slices 2 and 3 were written under such a
  note. Nothing orders that write with the driver's next spawn in the lane,
  and the note has no record of its own.

**What the code does today:**
- **The owner's only word to a running lane is a gate resolution.** A forced
  step needs a relaunch, and its grammar admits no text, "so the owner cannot
  hand a worker free text through the driver either"
  (`plugins/orchestrator/adapters/claude/autopilot/policy.mjs:118-150`).
- **A verb's last write replaces the next step.** The persona's `append` and
  `finish-verb` replace all three next-step keys at once
  (`persona-pipeline/files/scripts/state.mjs:2710-2722`; `finish-verb` at
  `:4253`), and the free-text flags, the phase note and the next action
  among them, have a file form (`:5147`). The driver follows the child's
  recorded next step (`policy.mjs:358-374`).
- **Every binding compares the child's dispatch.** A child records the
  selection `/orchestrator:next` dispatched it for: macro, subtask, branch,
  verb, profile, topic (`plugins/orchestrator/scripts/state.mjs:4075-4083`).
  `/orchestrator:next`'s writeback, the engineer's terminal note and
  `/orchestrator:done`'s write compare it with the subtask under the
  macro's lock, and refuse `dispatch-changed` on any difference in a field
  the child recorded; one it did not record (an older child) is skipped
  (`:4117-4144`, `:4359-4362`, `:4684-4687`). Done's owner scan reads the
  dispatch it passes to that write (`:5323-5345`, `owner-dispatch` at
  `:6039`), and when several children claim the subtask it prints, for the
  owner to choose, a `subtask-update --expect-dispatch` binding per claimant,
  which compares the same way (`:6095-6107`). The driver's own linkage check
  compares parent, subtask, branch and id, not the verb, profile or topic
  (`plugins/orchestrator/adapters/claude/autopilot/observe.mjs:261`). The
  approval plays no part in any of them. `--waive-dispatch` skips the
  comparison when the operator gives a reason and names the owner
  (`:4215-4231`); that it is for a record that cannot be read is the rule
  its comment states (`:4058-4062`) and done follows.
- **A revision of an in-progress subtask is free; its approval is not.**
  `plan-set` keeps a completed subtask as recorded (`:3365-3394`) but lets
  any other subtask change, and resets the approval (`:3514`, `:3594-3600`).
  The plan hash covers `id`, `label`, `branch`, `blocked_by`, `verb`,
  `profile` and `topic` (`:337`); `plan-approve` is refused under autopilot
  (`:3940`) and binds the hash the owner was shown (`:3964-3969`). It joins
  no admission (ADR-0067 Decision 4, item 5).
- **The driver reads the approval's status and hash, not which approval.**
  Each decision checks that the plan is approved and its hash matches
  (`policy.mjs:476-483`, `:759-764`; `scheduler.mjs:593-595`), so a revision
  approved between two looks is never seen as one.
- **An older orchestrator refuses a block-style key it does not know** in a
  macro file; it carries only unknown scalar keys
  (`plugins/orchestrator/scripts/state.mjs:1570-1572`, `:1987-1994`).

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
     ([ADR-0062](0062-subtask-completion-recorded-at-landing.md) Decision 2,
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

### Later slices

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

### Decision 5. A verification step the driver runs (slice 3, 2026-10-20)

It applies to every run, serial or with lanes, of a macro or a verb chain,
on Claude (ADR-0063 D9), once the driver offers it (item 11).

1. **The shape.** A verb's step makes its edits and the quick checks it
   judges to take minutes, and then, instead of waiting for long checks,
   ends with the next step `verify`: a request naming the checks to run and
   the step that follows them. The driver runs the checks with no LLM,
   records each result in the workflow, and dispatches the step that
   follows, which reads them. In a run that offers verification, a worker
   runs no mutation run and not the whole test suite in its step, and never
   waits there for the heavy-work lock (Decision 6): a wait on a lock is
   quiet and idle, which Decision 3 would judge stalled.

2. **The request** is machine data, written with the verb's last write
   through the persona's CLI. It names an ordered list of checks, each a
   *kind* from the repository's declaration (item 3) with arguments that are
   data (test file paths, mutation spec paths, case ids), each checked
   against the tested tree or its alphabet; the step that follows a batch
   that passed (`on_pass`, a next step as today); and a confidence, to which
   ADR-0063 D4's rules apply: below `HIGH` it halts `low-confidence` before
   anything runs. No argument is a shell word, and no text a peer, a person
   or the model wrote becomes one: a check never runs peer or user text.

3. **The allow-list is the repository's declaration, read from the run's
   baseline.** A file committed to the repository declares each check kind:
   its command, the arguments it takes, a timeout of at most 4 hours, whether
   the command takes the heavy-work lock itself, and the changed paths that
   add it (item 4). The driver reads it from the commit the run started from,
   never from a lane's tree, so a worker cannot widen it in its own step. For
   this repository it lists `npm test -- <files>`, `npm run mutate -- <spec>
   --only <ids>`, `npm run sync:persona-pipeline`, `npm run mutate:static [--
   <specs>]` and `npm run lint:plugin-shape`. A repository without the file
   offers no verification, and its workers check in their steps as today.

4. **The driver adds checks, and over-selects.** Before a batch, the driver
   adds every test that may read a changed file, and each declared check
   whose paths a changed file matches (here: `sync:persona-pipeline` for a
   pipeline source or a copy generated from one, `mutate:static` for a file a
   mutation spec anchors, `lint:plugin-shape` for a file under `plugins/`). It
   adds; it never drops a check the worker asked for. Its guarantees:
   - **Every change counts:** against the lane's fork point from the
     integration branch (a verb chain: the commit its run started from),
     committed or not, tracked or untracked, added, modified, deleted or
     renamed. A deleted or renamed file counts by its old path too, and a
     persona-pipeline source as every copy generated from it, and the
     reverse.
   - **It over-selects, through imports.** A test is selected when it, or a
     module it imports directly or through others, may read the file: names
     it by any spelling the rules know, a directory a path is built from
     included (the C150 case), or imports it. The rules are `verify-select`'s.
   - **No match never means no relevant tests.** A changed file that no test
     matches selects the whole suite.
   - **A match is not proof of coverage.** A test can read a file by a path
     no rule sees (a test that reads each `persona.json` through
     `tests/persona-pipeline/_personas.mjs:38-47` names none of them), and a
     match by an unrelated test cancels the fallback. The declaration may
     therefore map paths to further tests or to the whole suite, and the
     driver adds those too.
   - **Its acceptance is a backtest, not a proof.** On the C150 change the
     selection holds `tests/plugin-shape/test-engineer-autopilot-runbooks.mjs`,
     and on a recorded set of this repository's past pull requests every test
     that failed on a pull request's first CI run is selected by that pull
     request's diff. A miss widens the rules or the declaration's mappings
     (§Status, open point).

5. **Binding.** A request and its results are bound to the workflow attempt
   (the engineer workflow, and the run and step that recorded the request)
   and to the tested tree: the lane's checkout, uncommitted and untracked
   changes included, as the tree part of Decision 2's content digest (item 7)
   sees it when the batch starts and again when it ends. A result is evidence
   for that tree only, and a batch whose tree differs at its end has no
   evidence. The comparison sees what that digest sees, at those two moments:
   an edit undone before the end, or a change to an ignored file, goes unseen
   (§Status, open point).

6. **Results, and the step that follows.** Each check's result is recorded
   in the workflow through the persona's CLI, holding what the owner named
   (exit, duration, failing tests, a pointer to its log in the run
   directory); its form and timing are `verify-record-cli`'s. A result is *evidence* about its tree only when the check
   ran to its end on that tree and passed or failed. Any other end is no
   evidence: a timeout, a check that could not start or was refused, one
   stopped by `stop`, a hold, a drain or the driver's end, one never reached,
   and every check of a batch whose tree changed. The batch stops at the
   first check that does not pass: a mutation run on a failing tree is no
   evidence, and the harness refuses one whose control is not green anyway.
   Then:
   - every check passed on the tested tree, still the lane's: the driver
     dispatches `on_pass`;
   - a batch stopped by `stop`, a hold, a drain or the driver's end:
     nothing follows it; the request stays, and runs when it is next taken up
     (item 7);
   - any other end: the driver resumes the requesting verb, which reads the
     results from the workflow.

   A result is never a halt by itself, and no decision of the driver depends
   on a failure's detail. The failing tests' names and the logs reach the
   next worker of the lane, never the main session or the event file
   (Decision 4, item 2).

7. **Recovery and repeats.** A request is answered only by its own results,
   for the lane's tree:
   - a check that ended before its result was recorded (the driver died) has
     no result and runs again; a result is never assumed;
   - only a batch cut short (by `stop`, a hold, a drain or the driver's end)
     is taken up again (a relaunch, a release, the next look); a batch that
     ended, at a failure or at a check with no evidence of its own (a
     timeout, a check that could not start or was refused), resumes the
     verb even when the driver died before doing so, and runs nothing more;
   - a batch taken up again on the tree its results are for goes on from its
     first check that did not pass; on another tree (a person's edits under a
     hold, Decision 2), or when a relaunch's newer declaration resolves it to
     other commands, it runs again whole, and old results never take
     `on_pass`;
   - a verb that records the same checks again on an unchanged tree, after
     a batch in which they all passed or one failed, halts its lane
     `no-progress` at once, and nothing runs (item 10); after a batch that
     ended with no failure but a check with no evidence, they run again
     whole. A flaky test is rerun only after a change, or by the owner's
     explicit rerun, whose form is `verify-exec`'s (today's forced steps,
     Decision 1, item 8, name no verification);
   - a verb run in the lane, a person's in a held lane included, replaces the
     request, as its Phase 0 clears any next step.

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

8. **How a check runs.** The driver's effect domain grows by one effect,
   amending ADR-0063 D1: it runs a declared check
   - as an argv array built from the declaration and the request's checked
     arguments, never a shell string;
   - in the lane's checkout (in a serial run, the driven checkout), with the
     environment a worker gets, minus the run's admission token and autopilot
     flag, so that a check cannot act as a worker of the run;
   - in a process group of its own, which only the driver kills (ADR-0035 §4,
     the child-only rule): at its timeout, at `stop`, or at the driver's own
     signal, SIGTERM and then SIGKILL, as a worker (ADR-0063 D5);
   - under the heavy-work lock (Decision 6).

   **A check is a worker group of its lane** wherever a rule asks whether one
   still lives: the hold's handoff (Decision 2, item 4), `stop`, the cleanup
   of a run whose driver died, and an admission. This covers the check's
   process group and the wrapper the driver started for it. A driver killed
   while a check runs or waits for the lock leaves the lane busy until that
   group ends. A check group that outlives SIGKILL is not a result: as for a
   worker group, it is a run-wide halt (Decision 1, item 1), and the run's
   locks are kept while it lives.

   A check runs the lane's own code, its tests and scripts, with the reach a
   worker's shell already has: the permission posture binds a worker's tool
   calls, not the processes a test starts, today as here. The orchestrator
   adapter executes it; runtime's ceiling is unchanged.

9. **Bounds and budgets.**
   - **No LLM cost.** A batch takes no cost reservation, is charged nothing,
     and is not a step of `--max-steps`. Time bounds it: each check its
     declared timeout, a batch 6 hours of running checks, the driver's wait
     for the heavy-work lock 8 hours; a check cut by either batch bound gives
     no evidence. Every loop through verification passes through an LLM
     step, which is counted and charged as today.
   - **A command that locks itself waits inside its own timeout.** The
     driver runs it without the wrapper (Decision 6, item 3), so its wait for
     the lock is the command's: the driver cannot see it, the check counts as
     running, and a wait that eats its timeout ends it with no evidence
     (§Status, open point).
   - **Not judged by the stall detector.** A batch has no stream, and a quiet
     test is not a stall; its bounds bound it (Decision 3, item 10).
   - **One batch at a time.** The driver runs its batches one at a time
     across its lanes, in the order their requests were recorded. A lane
     whose batch waits or runs holds no worker capacity (`--lanes N` counts
     workers), so the other lanes' workers run meanwhile.
   - **Only a running check is in flight.** The driver reads holds and the
     drain before each check (Decision 2, item 3), so a hold or a draining run
     (an exhausted budget among its causes, though a batch charges nothing)
     ends the driver's wait for the lock and stops a running batch before its
     next check, never during one. A running check is in flight: the run does
     not end before it (Decision 1, item 7), and a hold's handoff waits for it
     as for a worker step (Decision 2, item 4). A request not running is not
     in flight: it stays recorded, and starts again only when its lane is
     neither held nor parked and the run is not draining.

10. **Where it appears.**
    - **Policy.** `verify` is a next-step kind in both packages and a step
      kind of the driver. A child whose next step is `verify` yields a
      verification step when the run offers verification, and halts
      `owner-choice` naming what is missing when it does not. That cause is
      the run's own footing, not the lane's, so the halt is run-wide
      (Decision 1, item 1), and a relaunch that offers verification goes on
      with no release.
    - **Progress.** ADR-0063 D4's gates apply to the step a batch dispatches
      as to any step. A batch's recorded results count as a change of the
      lane's child, so a passing batch's `on_pass` is not refused
      `no-progress` on a tree left unchanged by design; a batch itself is
      judged by its results, never by `no-progress`. The repeat of item 7 is
      a new trigger of the `no-progress` code, amending ADR-0063 D4's table;
      the codes are unchanged.
    - **Records.** A batch is a step of the run's step ledger, of kind
      `verify` and with no cost. The event file gains no kind: a batch's end
      is a step's end, which Decision 4 does not publish (item 3), and a
      failed check is no halt.
    - **Status** shows a lane verifying, or waiting for the lock with its
      holder when the driver itself waits.

11. **Rollout.** Older readers refuse a workflow that holds the new kind
    (§Context), so it is written only where its readers know it:
    - **First the persona's CLI, with the orchestrator refusing.** The
      persona accepts `verify` and records requests and results, but writes
      `verify` only in a step of a run that offers verification, never
      interactively, where no driver will run it. The orchestrator released
      beside it names `verify` and refuses it explicitly, as a kind its
      driver does not run yet, not as an unknown enum, and its cleanup of a
      dead run accounts a batch as no step and no cost
      (`plugins/orchestrator/adapters/claude/autopilot/dead-runs.mjs:361-377`
      counts every unaccounted step today).
    - **Then the driver.** It offers verification only when the installed
      persona's CLI has the capability (a source probe beside today's,
      `roots.mjs:101-123`) and the repository has a declaration; it records
      the offer in `run.json` and tells each worker in its environment and
      rules.
    - **Then the runbooks** hand long checks to `verify` when the run offers
      it.

    The new kind is a new value, so ADR-0067 Decision 4, item 3 applies
    unchanged: it is written only once its readers are installed on both
    hosts. The driver's probe sees its own host's persona only; the other
    host's install is the owner's, as for every value under that rule. A
    persona older than the kind, on a host that skipped it, refuses a
    workflow file while it holds `verify`, from its worker's last write
    until the batch's next step, a drain and a relaunch included (§Status,
    open point).

### Decision 6. One heavy-work lock (slice 3, 2026-10-20)

1. **One lock per repository.** It is the mutation harness's lock file,
   `<git-common-dir>/mutation-harness.lock`, shared by every worktree of the
   repository and kept compatible with every harness copy that takes it
   (from `7badfe23` on), on an older branch included, so that they honor it;
   the name is historical. Its holders are the mutation harness and the
   wrapper (item 4), which a person, a session or the driver runs. The
   driver runs a check whose command does not take the lock itself through
   the wrapper, so every holder is a process that runs its heavy work as its
   own children, and a driver that dies leaves a holder that still ends its
   work and releases. It has one holder at a time: more slots are a later
   decision, since older harness copies honor only the one file.

2. **What it guarantees.**
   - Among cooperating holders, at most one heavy job of the repository runs
     at a time, whichever worktree, lane or session starts it.
   - **Ownership ends only after the holder's process group has stopped.** A
     holder releases only once the command it ran, and that command's
     process group, have exited; on a signal it stops them first, as the
     harness does today. A holder killed outright has its children stopped
     by a supervisor, as the harness's are today, and a reader of this
     release judges a lock stale only once no process of its ownership
     runs. A process that leaves its holder's process group (a daemon, a
     detached child) is outside this guarantee for every holder (§Status,
     open point).
   - **Narrower with older harness copies.** As a holder, an older harness
     stops only its test run's process group before it releases
     (`scripts/mutation-harness.mjs:378`), so a descendant that left that
     group outlives even an orderly end. As a reader, it judges a holder by
     the recorded process alone (`:898-905`), and its supervisor stops the
     test runs only after it sees its holder die (`:253-263`). So against an
     older copy, exclusion holds while the holder lives; after its end, an
     older copy may start beside a descendant that outlived it, and after a
     kill beside the holder's last children (§Status, open point).

3. **Nested acquisition: authenticated inherited ownership.** A holder's
   descendants can join its ownership by a proof they inherit, and the
   lock's record keeps nothing from which another process could make it. A
   joined acquirer waits for nothing and releases nothing, its processes
   count as the holder's, and its cancellation stops its own processes only.
   Only the holder releases, after every process of its ownership has
   stopped. Any other acquirer waits, and a proof that matches no live
   holder is ignored. So the harness of this release, which acquires
   unconditionally, runs under a holder without waiting on it. The proof
   keeps an unrelated process from joining by accident; it does not stop a
   process of the same user that reads the holder's environment. How the
   proof passes and is checked is `impl-heavy-lock`'s.
   - **One boundary for a command that locks itself.** The driver runs a
     check whose command takes the lock itself (the declaration says so,
     Decision 5, item 3) without the wrapper, so a harness too old to know
     the proof, in a lane cut before it, still runs; its wait is inside the
     check (Decision 5, item 9).
   - **Unsupported nesting.** An older harness under a holder, started
     through the wrapper or a script, cannot join and would wait on its own
     holder. The wrapper refuses a command the declaration marks as locking
     itself, and an indirect older harness waits, naming the holder it waits
     on, until it is stopped (§Status, open point).
   - **A driver under a holder refuses to start.** A driver started inside a
     holder's ownership (its launcher, or the shell it runs in, run under the
     wrapper) would pass the proof to every check and worker, and every
     lane's heavy work would join that one holder and run at once. It
     refuses to start, naming the holder (§Status, open point).

4. **The wrapper for interactive sessions.** `agentic-autopilot heavy --
   <command> [args...]` takes the lock, runs the command as its child, and
   releases once the command and its process group have stopped; while it
   waits it names the holder, as the harness does. A person or a session
   uses it for a whole test suite or anything else heavy; nothing forces it,
   since the lock is cooperative, and the harness needs none (item 3). Where
   the instructions tell sessions to use it is slice 4's.

5. **Queueing and fairness.** Within one driver, batches run in the order
   their requests were recorded (Decision 5, item 9). Between processes
   there is no queue: waiters poll, as the harness's do, and the first to
   find the lock free takes it. A waiter reports the holder and how long it
   has waited; the driver's own waits show in `status` and its records. A
   waiter can lose the race again and again; nothing bounds that but the
   holders' own bounds and, for the driver, its 8-hour wait (§Status, open
   point).

6. **Stale holders** are judged as the harness judges them today, and by a
   reader of this release also by whether a process of its ownership runs
   (item 2). A holder on another host is never judged stale from here, and
   stays until it releases or a person removes it. The judgment and the
   reap are `impl-heavy-lock`'s.

7. **Order with the run locks.** The driver waits for the heavy-work lock
   while it holds its run locks, directly or through a check that locks
   itself. No holder of the heavy-work lock waits for a run lock: an
   admission refuses rather than waits (ADR-0067 Decision 4, item 5), and
   the harness and the wrapper take none. So the order cannot deadlock.

8. **What it does not cover:** a worker's quick checks in its step; a
   process started without the wrapper; a process that left its holder's
   process group; another clone of the repository (another git common dir)
   or another machine; CI; a peer's own commands; the driver's git
   operations; and load from outside the repository. It bounds the overlap
   of heavy jobs among cooperating holders, which made the C145 load, not
   the machine's load.

### Left to the implementation (slice 3)

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

### Amendments (slice 3)

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

### Decision 7. Instructions from the main session, read at a lane's next step boundary (slice 4, 2026-10-20)

It applies to every run of a macro, serial or with lanes, on Claude (ADR-0063
D9). A verb chain's run has no lanes to instruct, and takes no instructions.

1. **What an instruction is.** The owner's message to one subtask's lane: a
   *note*, and at most one *next step* in the forced-step grammar without its
   dispatch, `/engineer:<verb>` or `/engineer:commit` (ADR-0063, S8 note).
   - **A record of its own,** in the macro's records directory beside the
     holds (Decision 2, item 1), never a field of the child. A worker's step
     that ends after it is written replaces the child's next step with its
     `finish-verb`; the instruction is untouched by that write and is applied
     after it.
   - **The note is carried, never read.** The driver reads only the step. The
     note reaches the lane's child as a phase note its next worker reads, and
     nothing else: not the event file, `halt.json` or `status`, which show
     its id, and never a shell (ADR-0059; Decision 4, item 2).
   - **Not a plan change.** It changes no field of the plan and needs no
     approval: it tells the child. A change to what the subtask is, its
     topic, is a plan revision (Decision 8). A dispatch is never an
     instruction's step, since dispatch follows readiness.

2. **Who writes it.** The owner, or the main session acting for them, with
   `agentic-autopilot instruct <subtask-id> --macro <id> --note-file <path>
   [--next <step>]`, also reachable as `/orchestrator:autopilot instruct`,
   with or without a live run. The note goes through a file (ADR-0059); the
   step, a fixed grammar, inline as `--next` takes it.
   - A caller whose `AGENTIC_AUTOPILOT` names a run is refused: a worker
     never instructs a lane, its own included. Lane-to-lane notes are deferred
     (owner, 2026-10-19).
   - It refuses a malformed step, a subtask not in the plan or recorded
     completed, deferred or abandoned, and a subtask whose child has archived
     (committed or closed: the lane's next work is landing).
   - A subtask with no child yet (pending, or in progress before its
     dispatch has created one) takes a note only. The note waits for the
     dispatch and is applied at the first boundary after it; the dispatch
     step runs the first verb, so the note reaches the steps after it.
   - It prints the instruction's id and its state.

3. **Applied at the lane's next step boundary, never mid-step.** A lane is at
   a boundary for an instruction when no worker step of any run is in
   flight in it, no verification batch has started there and not yet ended
   (between two of its checks included, a stricter rule than Decision 5,
   item 9's for a hold or a drain; a batch waiting for the heavy-work lock
   has started), no settlement is pending, no persona operation is open in
   it (Decision 2, item 7), it is not held, and no release of it awaits its
   comparison (Decision 2, item 7). A batch cut short by a stop, a hold or a
   drain has ended: what is left of it is a request not running.
   - **With a run live,** its driver applies the lane's pending instructions
     when it next looks at the lane, before it chooses the lane's next step
     or reconsiders the lane after a park. The instruction records are wake
     sources (Decision 1, item 6, which named this slice), so with lanes an
     instruction to an idle or parked lane is applied within the poll; a
     serial run, which has no timer, applies it at its next look. One to a
     lane mid-step is applied at that step's end. A draining run applies
     none: nothing starts after a halt (ADR-0063 R2).
   - **With no run live,** the next run applies them before it acts on the
     lane, after it has read the holds and kept parks; and the `instruct`
     command applies them itself when it finds the lane at a boundary. A
     person who works a lane between verbs, outside any run, runs it again
     there.
   - **What applying does.** One persona operation on the child: the note
     appended as a phase note that names the instruction, and the next step,
     if any, recorded at `HIGH`, the owner's word, replacing the recorded
     one. The instruction is then acknowledged, with what applied it and the
     next step it replaced. The lane is judged afresh by the usual rules: its
     fingerprint changed, so a parked lane is reconsidered (Decision 1,
     item 4).
   - **Once, whole.** An instruction is applied with its note and its step
     together, or not at all, and no crash applies it twice or loses it.

4. **Several, revised, withdrawn.** A lane's instructions keep the order
   they were written in. All those pending at one boundary are applied
   together, in order: every note is appended, the last next step named
   wins, and the earlier steps are acknowledged as superseded. Instructions
   are not a queue of steps, and an acknowledgement says an instruction was
   applied, not that its step ran: to sequence two, write the second once
   `status` shows the first one's step has run. A pending instruction may be
   revised, keeping its place, by a revision that names the one it replaces
   and is refused when that is no longer current; or withdrawn. An applied
   one is final: write a new one. `status` lists each lane's instructions and
   what became of each.

5. **Precedence.**
   - **Over the child's recorded next step: the instruction.** Its step
     replaces the recorded one, whatever its confidence, and the judgment
     halt it would raise (a low confidence, an owner decision, no next
     step), as a forced step replaces the policy's choice
     (`policy.mjs:533-541`). As for a forced step, every gate, error and
     landing refusal still stands, and the step goes through its own
     prerequisites.
   - **Not over an interrupted commit.** A child whose commit step started
     and did not finish takes no instruction's step: the driver's next step
     there is the commit again, as today, which archives the child or sets a
     gate, so the instruction is dropped (item 6) or its step superseded
     (below). In this an instruction reaches less far than a forced step,
     which today replaces that commit (`policy.mjs:555`, `:790`); this slice
     leaves the forced step as it is.
   - **Under an owner gate: the gate.** An instruction never clears a gate,
     which only its resolution does, with the decision (ADR-0063 D6). A next
     step for a lane whose child has a gate set is refused at the write. A
     gate set on the child after an instruction was written supersedes that
     instruction's step, and keeps superseding it once the gate is
     resolved: at the boundary its note is appended and its step dropped;
     the lane parks on the gate if it is still set, and otherwise follows
     the step the resolution recorded. So a gate's resolution is never
     overridden by an instruction written before the gate was set. One
     written after the resolution is the owner's later word and applies as
     any, once the resolving session's operation has ended (item 3).
   - **Beside a verification request (Decision 5).** An instruction never
     interrupts a batch and never discards a result. A started batch keeps
     the lane until it ends (item 3); there, the results stay recorded, and
     the instruction's step, if it has one, replaces the step the batch
     would have dispatched (`on_pass`, or the requesting verb), which reads
     them. A request not running is replaced by an instruction's step, as a
     verb's Phase 0 replaces it (Decision 5, item 7); a note alone leaves
     it, and the batch runs.
   - **Beside a forced step.** A relaunch's `--lane <id> --next <step>` on a
     lane with a pending instruction that carries a next step is refused,
     naming it: withdraw the instruction, or drop the forced step. An
     instruction written while a live run still carries an untaken forced
     step for the lane waits for that step, or for the run's end: it is
     applied at the boundary after it. So the earlier of the two words is
     never lost to the later by the order the code happens to look in.
   - **In a held lane: after the release.** The instruction waits for the
     release, and is applied once the release's comparison has been consumed
     (Decision 2, item 7), so the comparison sees the lane as the person left
     it and the driver's write comes after it.

6. **When it applies to nothing.** An instruction is bound to its subtask,
   the branch, and the child it was written for (none, for a note waiting
   for its dispatch). It is dropped, never applied to anything else, when
   the subtask leaves the plan or changes branch, when its child archives
   before it is applied (a commit, a close), when a different child takes
   the lane, when `/orchestrator:done` completes the subtask, and when the
   macro ends. A dropped instruction is acknowledged with its cause and
   shown in `status` and `halt.json`, so the owner can write it again for
   what the lane is now. A rebinding (Decision 8) keeps the child, and so
   keeps its instructions.

7. **How it differs from the owner's other words.**

   | | written | carries | applied | resolves |
   |---|---|---|---|---|
   | instruction | any time, a run live or not | a note, at most one next step | at the lane's next boundary, after a step in flight ends | a judgment, and a park by changing its record |
   | `--lane <id> --next <step>` | at a relaunch | a next step, a dispatch included | to the lane's first step of that run | a judgment, and a kept park (Decision 1, item 8) |
   | gate resolution | in a session, for a gate | the decision, a next step | at once, to the child | the gate |

8. **Records.** What a driver does with an instruction (applies, supersedes
   or drops it) is published in the event file under one new kind, by
   Decision 4, item 3's minor schema change, as codes and ids with no text,
   and recorded in `lanes.jsonl`. Owner commands write no events (Decision 4,
   item 1): an instruction the `instruct` command applies with no run live
   shows in its output and in `status` only.

9. **Rollout.** One orchestrator release. An instruction is applied with
   the persona's existing `append`, a phase note from a file and the
   next-step flags (§Context), so no persona schema change is needed. It is
   applied only where the persona's operations are visible (the hold-aware
   persona, Decision 2, item 9), in every mode, serial runs and the command
   included; elsewhere it stays pending. `instruct` beside a live run that
   does not apply instructions warns that the instruction waits for one that
   does. An older driver never reads the records, so a pending instruction
   waits there, applying nothing; a rollback below this release while one is
   pending leaves it unapplied.

### Decision 8. Rebinding a dispatched subtask after an owner-approved change of its instructions (slice 4, 2026-10-20)

The dispatch comparison of ADR-0067 Decision 4, item 5 stays: a child is
bound only to the subtask it was dispatched for. This decision adds one way
for the owner to change that subtask's instructions after the dispatch, so
that its work is accepted at landing (C147).

1. **What can be rebound.** An in-progress subtask's `topic` and `profile`,
   the words of its instructions, for the child its dispatch created.
   - **Not rebindable,** and refused at every binding that compares it, as
     today: a changed `branch` (the child's work is on the old one), `verb`
     (the step the dispatch began with; another start is another dispatch),
     subtask id or macro (another subtask), and a child other than the one
     rebound (a later dispatch of the same subtask).
   - **A child that recorded no verb, profile or topic** (dispatched before
     its record carried them) is compared, as today, only on what it
     recorded (`state.mjs:4127-4128`): a change of those fields neither
     refuses it nor needs a rebinding, and the approval shows it as not
     compared on them.
   - **Needs no rebinding:** `label` and `blocked_by`, which the dispatch
     does not record. A predecessor added to an in-progress subtask does not
     make its work wait or move it onto the predecessor's work: it was
     dispatched on the base it had (ADR-0062 §Decision 2). The approval
     covers the change as any plan change. Starting the subtask again on the
     landed predecessor is a fresh attempt, with the old binding cleared and
     a new branch base, which this decision does not provide.
   - A completed subtask is kept as recorded, as today.

2. **Recorded with the approval.** When the owner approves a plan
   (`/orchestrator:approve`) in which an in-progress subtask's topic or
   profile differs from what its child records, the approval records a
   rebinding of that child, from the dispatch it records to the fields
   approved, as part of that approval. The macro's body keeps each
   rebinding as history.
   - **The approval shows each rebinding before it is given,** with the
     child's state: active with its recorded next step, or archived
     (committed, waiting to land). A change that cannot be rebound (item 1)
     is shown too, with the refusal it will meet and the exits that refusal
     names today (`state.mjs:4138-4144`).
   - **An archived child shows the refusal its writes will meet.** No note
     reaches an archived child, so one last told other words than the
     subtask's (item 4) is refused at every write that binds it, whatever
     the approval rebinds. The approval asks the writes' own check of the
     record it is about to write, and shows such a row refused, with the
     refusal, even when the child matches its dispatch; the macro's body
     records it refused, never rebound. The rebinding is still recorded, for
     the waiver that completes the subtask.
   - **It approves what it showed:** a child whose state or recorded
     dispatch changed between the display and the approval refuses the
     approval, as a plan that changed does (`--expect-hash`).
   - Only the owner rebinds: `plan-approve` stays refused under autopilot.
   - The child's own record is never rewritten. Its dispatch stays the
     selection `/orchestrator:next` made; the macro records the owner's
     rebinding of it, and no persona release is needed.

3. **Only with nothing in flight.** Every approval that changes the approved
   plan, whatever it changes, takes part in the run locks as an admission
   (ADR-0067 Decision 4, item 5): it is refused beside a live run of the
   macro, or beside any command admitted under them (an interactive
   `/orchestrator:next` among them), and no run or dispatch starts while it
   holds them. An approval that records
   or changes a rebinding is also refused while a persona operation is open
   in that subtask's lane, while the subtask is held, and while a release of
   it waits for its comparison (Decision 2, item 7), whose digest the note
   of item 4 would change.
   - **D1's whole-run treatment is kept.** The `plan-set` before the
     approval revoked it, so a live run halts `plan-unapproved` at its next
     look and drains (Decision 1, item 1). The owner approves once that run
     has ended, or after `stop`; the approval never resumes or extends a
     run. A draining run starts nothing, so the refusal costs the owner no
     progress.
   - **No in-flight worker's obsolete instructions become current.** A
     `plan-set` and an approval between two of a run's looks, which today's
     checks pass (§Context), are now refused at the approval, whatever
     subtask they touch: a dispatch under way, its subtask not yet recorded
     in progress, or put back to pending, included. The plan stays pending,
     the run halts at its next look, a worker still in its step under the
     old words finishes under the drain, and its outcome is shown at the
     approval that follows.

4. **Told to an active child.** Each approved change of the words an active
   child was last told (its dispatch, or the last change it was told), a
   return to its dispatch included, reaches the child as a phase note naming
   the fields that changed with their old and new text, the owner's own
   words from the plan. The approval delivers it, at a moment its admission
   (item 3) makes a boundary of the lane. A delivery the approval did not
   finish is completed before a run of this release starts the child's next
   step, never mid-step; a person who runs that step by hand before then
   works under the old words. An archived child has nothing left to run: the
   approval showed it committed (the C147 case). One check answers whether a
   child may work for its subtask under the words it was last told, and both
   places that ask it ask the same one: the writes that bind the child (the
   re-attach, the terminal writeback and `/orchestrator:done`'s completion)
   refuse a child it does not vouch for, and a run's step boundary does not
   step one, whose lane parks or whose serial run halts with the way out the
   writes name. The boundary asks it of the child the step would run: the
   subtask's recorded owner, or, when none is recorded, the child the run
   selected for it. So a run never spends a step under words whose work the
   writeback would refuse. An approval tells only the child it would rebind,
   the recorded owner or the one claimant: when no owner is recorded and
   several workflows claim the subtask, the way out names recording the
   child its owner first. What a child was last told is kept until its own
   row replaces it or its subtask completes: an approval that selects
   another child of the subtask (the owner changed) never drops it, so a
   return to the first child still meets the words its latest note gave
   it. When a child's copies disagree on what it was told, none of them is
   chosen: partial evidence is never read as "never told", nor as told the
   words of either copy. A child with an active copy is told only when every
   active copy holds the note and none is unreadable: a note found only in an
   archived copy never stands for an active one, and an active copy that
   cannot be read is waited for. An active copy that cannot be read makes the
   child unreadable to the approval too, a readable active copy beside it
   included, so the approval keeps the pending note and what the child was
   told. A child archived everywhere is told when every copy holds the note
   and none is unreadable. When only some do, or a copy cannot be read, it is
   told, since that copy may be the one its work answers to, but the told
   entry is marked `contested` and binds no words: the writes that bind it
   refuse whatever the plan says, the note's words included, and the told
   waiver stays the way out. A contested child found active again is restated
   the words in full, and the delivered note clears the mark. An approval
   that drops a pending note some copy of the child holds (its subtask no
   longer in progress, or a row deciding the child that sends it no note)
   records the child told it, contested, so no words bind it until a
   restated note is delivered; an active child the approval finds, a pending
   note to which some copy holds, is restated the words in full. Every file
   that bears the child's workflow id or its name is a copy of it, whatever
   it holds or claims: the archiver's collision-suffixed archive
   (`<id>-<YYYYMMDDTHHMMSSZ>-<6 hex>.md`, suffixed any number of times)
   included, and a file of its id that claims another subtask or macro,
   which keeps any note from being acknowledged and every binding write
   refused until the owner repairs or removes it.
   **More than one file bearing the child refuses it outright.** While more
   than one file bears the child, or the files that may bear it cannot all
   be read, which words its work answers to is not known, so no copy is
   judged: every write that binds it and a run's step boundary refuse it
   ("more than one copy of `<child>` may run"), no note to it is delivered
   or acknowledged, and a pending one is partial evidence, so an approval
   that drops it records the child told it, contested. An approval shows an
   archived child's row refused with the same words. The way out is the
   owner's: repair or remove the extra copies, or, when no file bearing the
   child is in a workflow home, the told waiver. Once one file is left, the
   rules of this item judge it and what the record kept: a child whose
   remaining file was last told other words is refused until a restated
   note is delivered. This replaces widening, round after round, which files
   the copy checks compare: six reviews in a row each found a file they did
   not see. The rules above for copies that disagree, and below for a
   copy that does not hold its told note, stay: they now govern a child one
   file bears, and what the record kept from before a repair; simplifying
   them is left for later. A scan of the copies that fails is partial
   evidence, never "never told", and its refusal says what could not be
   read. A file counts once by its device and inode, so a hard link or a
   symbolic link of it is that file, and a link whose target is gone is
   none; it counts as active when any name of it, a link included, is in a
   workflow home. A run's step boundary asks the same check with no record
   of rebindings too. The count holds only when it is stable: the engineer's
   archiver writes the archive before it removes the workflow file, and the
   scan reads by name, then by workflow id, so a file moving while it runs
   can be met under two names. More than one file found, the scan runs again
   after a moment, up to three times, and the child is refused only when two
   scans in a row find the same files, or they never settle. An archive
   killed between its write and its removal of the workflow file leaves
   both, and one retried after that a second, suffixed archive: those files
   hold the same notes, so the refusal names them and says to keep one (the
   file in a workflow home, when there is one) and remove the others. The
   limits, each an uncommon case under the owner's rule of 2026-10-25
   (fix natural use, document what needs a hand-made file or an unusual
   deployment):
   - copies are found by name and frontmatter among `.md` files, the only
     ones the engineer reads as workflows, so a file renamed by hand to
     another name, under another workflow id, is not seen;
   - with no record of rebindings, a scan error anywhere in the engineer
     homes (an archive holding a malformed value, an entry that is not a
     regular file, a failing `git worktree list`) refuses every binding
     write and the boundary for every macro until the entry is repaired;
     each trigger is a hand-made or broken file;
   - two archived files of the child whose recorded dispatches disagree,
     which takes a hand-edited dispatch, make the claim scan throw, so the
     told waiver reports that no file claims the subtask; this fails closed,
     and the owner repairs the files;
   - a second file appearing between a delivery's last check of the copies
     and its acknowledgement is not seen: the check-to-commit window every
     write has.
   The record names the child, not a copy, so a copy restored or moved
   between homes after a delivery could outlive the evidence: the record's
   evidence is checked against every copy the child may run from at each
   write that binds it, and at a run's step boundary. A told entry vouches
   only while every such copy holds the note it names (every active copy,
   none unreadable; for a child archived everywhere, every copy, none
   unreadable). Otherwise the writes refuse: an archived child keeps the told
   waiver as its way out, and an active one is restated the words in full by
   the next approval and binds once that note is delivered. The note is found
   in each copy by its delivery heading, not by its full body: the told entry
   keeps the words it told, not the words the note quoted before them. How
   the words a child was last told are recorded,
   and how an unfinished delivery is completed, are `impl-rebind`'s (§Left to
   the implementation).

5. **The next step stays the child's.** A rebinding changes which words the
   child's work answers to, not the work: the child's next step is the one
   it recorded, which the approval showed. A verb's worker reads the note;
   a recorded commit commits the work as it stands. The owner replaces that
   step with an instruction (Decision 7) or a forced step at the relaunch.

6. **Honored under the current approval only.** Every write that binds a
   child to its subtask (`/orchestrator:next`'s writeback, a re-attach
   included; the engineer's terminal note; `/orchestrator:done`'s write;
   the owner's explicit binding, `subtask-update --expect-dispatch`, which
   done prints when several children claim the subtask, `state.mjs:6095-6107`)
   compares as today and also accepts a child whose recorded dispatch
   differs from the subtask only in topic or profile, when the macro's
   current approval, approved and matching the plan, holds a rebinding of
   that very child, from the dispatch it records to exactly the subtask's
   current fields, and an active child has been told it (item 4). The
   comparison is the orchestrator's: the persona passes the dispatch it
   records, as today.
   - **A pending or stale approval rebinds nothing.** A `plan-set` after the
     approval suspends its rebindings until the owner approves again.
   - **Repeated revisions.** Each approval derives its rebindings afresh from
     the child's own record, never from an earlier rebinding, so only the
     latest approval's fields bind. A revision back to the dispatched fields
     needs no rebinding, and today's recovery stays valid; the child is
     still told (item 4).
   - **Stays refused, for a child whose dispatch differs from its subtask:**
     no current approval (an unapproved, pending or stale plan); a change
     item 1 does not rebind; a child the approval did not name; an active
     child not yet told. A write whose dispatch matches is compared as
     today, whatever the approval. `--waive-dispatch` keeps its meaning and
     is not a rebinding.

7. **Rollout.** One orchestrator release: the approval's display, its
   admission and its record; the comparison; and the note.
   - **Readers.** An orchestrator older than it refuses a macro file holding
     a block-style key it does not know (§Context), so where the rebinding
     is kept must not break a reader older than this release on either
     host: ADR-0067 Decision 4, item 3 (readers on both hosts first) applies
     to whatever new field it writes. An older orchestrator never honors a
     rebinding: its comparison refuses as today.
   - **Writers.** An older `plan-approve` joins no admission
     (`state.mjs:3932-3943`), so on a host that has not installed this
     release an approval can still pass between two looks of a live run, as
     today. The guarantees of item 3 hold once every host the owner approves
     from runs this release; rolling an approver back below it is
     unsupported.
   - **Operations.** Until the persona's operations are visible (Decision
     2, item 9), the approval cannot see one open in a person's session;
     closing their own sessions first is the owner's.

### Left to the implementation (slice 4)

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

### Amendments (slice 4)

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

### Slice 3

**Positive**:

- An LLM step no longer waits hours for a test or mutation run: its wall
  clock and its reservation cover its own work. Of the 18 cuts discussion 3
  counted, those on a test or mutation run go; a wait on a peer stays.
- Hours of machine checks cost no LLM money and hold no worker slot, so
  another lane's worker runs while one lane verifies.
- The tests a change can break are chosen by code that over-selects, from
  every changed file, the C150 miss included; a worker's own list is only
  added to.
- Results are records bound to their tree: a check interrupted by a crash,
  or whose result went unrecorded, runs again and is never passed, a change after a result makes it stale, and only a pass or a
  failure counts as evidence.
- Two lanes, a session and the harness, when they take the lock, no longer
  run heavy jobs at once in one repository, short of the detached processes
  and older harness copies of Decision 6, item 2: the C145 load came from
  such overlap.

**Negative**:

- One more step kind, a new next-step kind both packages must ship in
  order, and a repository declaration to keep in step with the scripts it
  names. While a workflow waits for its batch, a persona older than the
  kind, on a host that skipped its install, refuses that file.
- One more LLM step on a failure: the requesting verb resumes to read the
  results, where today's worker read them in the step that ran them. A
  passing batch goes straight to `on_pass`.
- Heavy work is serialized across lanes: with two lanes verifying, one waits
  for the other's batch, and the slowest batch sets the pace.
- A changed file no rule matches runs the whole suite; the backtest bounds
  the misses it knows, not the ones it has not met.
- A failing check stops its batch, so a mutation result arrives one round
  later than a test fix; a flaky test is not rerun by itself, and a verb
  that asks for it again on an unchanged tree parks its lane.
- A check that takes the lock itself waits inside its own timeout, where
  the driver cannot see or bound the wait separately.
- The lock binds only those who take it, and between processes a waiter may
  wait long behind repeated winners; a holder on another host is never
  reaped from here, and stays until it releases or a person removes it.
- A check runs the lane's own code outside the permission posture, as a
  script a worker runs does today.

**Neutral**:

- The halt reason codes and the exit codes are unchanged; a check result is
  never a halt.
- The harness keeps its file, its record and its behavior when it runs
  alone; a run without a declaration behaves as today.

### Slice 4

**Positive**:

- The main session steers a lane while the run goes on: a note and a next
  step reach the lane at its next boundary, ordered with the driver's own
  steps, where the hand-run script raced the next spawn.
- An instruction outlives the step in flight; its outcome is a record, and
  an event when a driver handled it, so the main session learns, without
  reading the lane, whether it was applied, superseded or dropped.
- A parked lane whose judgment the owner can give in one line (a low
  confidence, a failed worker) resumes without a relaunch.
- A topic revised for an in-progress subtask, and approved, is accepted at
  landing: the C147 halt and its recovery by revising back go away, and an
  active child learns the change from its own record.

**Negative**:

- Two more records to keep in step with the plan: instructions beside the
  holds, rebindings with the approval, each with its own states and exits.
- The owner's words now have three forms (an instruction, a forced step, a
  gate resolution) whose precedence must be learned; the refusals name the
  conflicting one.
- An instruction to a lane worked by hand outside any run waits until a run
  or the `instruct` command applies it; interactive persona commands do not
  read it.
- Every approval that changes the plan waits for the macro's run to end
  or be stopped, where today it could be given at any time; a revision
  approved between two looks went unseen.
- A rebinding re-labels the child's work and leaves its next step as
  recorded: a recorded commit commits work written under the old words
  unless the owner replaces the step.

**Neutral**:

- The halt reason codes and exit codes are unchanged, and the dispatch
  comparison keeps its rule for every change that is not a rebinding.
- The persona's schema is unchanged by this slice: it applies notes and next
  steps through its existing `append`.

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

### Slice 3

**Shrink the checks inside the step (D).** Rejected by the owner
(discussion 3, item 1): it treats the symptom, a long wait under the step's
clock, and gives up the checks that caught defects.

**Let the worker wait for its long checks, with a longer clock or stall
detection only.** Rejected: the worker holds its reservation and its lane's
slot while it waits, is charged for the wait when it reports no cost, and a
wait on a lock is quiet and idle, which stall detection would judge stalled.

**Run the checks in a second worker step, `claude` driven.** Rejected: it
pays an LLM to run commands and waits under the same clock, and its report
is text where a check result is an exit code.

**Mark the request with a new field, keeping the next step's kind.**
Rejected: an older driver ignores an unknown field and would run `on_pass`
on unchecked work. An unknown kind is refused explicitly, which is the
safer failure; its cost is the window, until the batch's next step, in
which an older persona refuses the file.

**Read the allow-list from the plugin, or from the lane's tree.** Rejected:
a list fixed in the plugin knows only this repository's scripts, and one
read from the lane lets a worker widen it in its own step. The repository
declares it, and the driver reads it from the run's baseline.

**Let the worker's list stand alone, or let the LLM choose the tests.**
Rejected by C150: a targeted list missed a test that builds its paths, and
seven tests failed in CI. Code adds the tests, and over-selects.

**Select by literal path only, and run nothing more when nothing matches.**
Rejected: the C150 test reads most generated runbooks by a path it builds
from a base, and spells two of them only relative to the plugin; that a
comment in it names their pipeline source is chance. A file no test matches runs the whole suite.

**Answer an identical request from an earlier request's results.**
Rejected after review: a result would then answer a request it is not bound
to, and a cached non-result (a stop, a timeout) would park the lane with no
check run. A request is answered only by its own results, and a repeat on
an unchanged tree after all its checks passed or one failed halts
`no-progress`.

**Run every check of a batch whatever fails.** Rejected: a mutation run on a
failing tree is no evidence and the harness refuses it anyway, and the hours
it takes delay the fix. The batch stops at the first check that does not
pass.

**Rerun a failed check automatically.** Rejected, as every automatic retry
in this ADR: on an unchanged tree it repeats the result, and a flaky test
passing on a retry hides the flake. A change or the owner's forced step
reruns it.

**A new lock file for heavy work, beside the harness's.** Rejected: harness
copies on older branches in other worktrees would take only the old file,
and both would run at once. The harness's file is extended.

**A lock in the run's locks, or per worktree.** Rejected: the run locks are
per macro and per checkout, and heavy work collides across macros,
worktrees and sessions of one repository. The git common dir is the one
place they all share.

**Several slots from the start.** Rejected: older harness copies honor only
the one file, so a second slot would let a new holder run beside an old
harness. One holder until a later decision.

**Pass ownership to a child by an unauthenticated flag.** Rejected: any
process of the user could set it by accident and run beside the holder.
The proof is inherited only by the holder's descendants, and the record
keeps nothing that makes it.

**Scrub an inherited proof from the driver's environment.** Rejected: a
driver started under a holder would then wait on its own parent for every
check. It refuses to start instead.

**Have the driver hold the lock for every check, the harness's included.**
Rejected: a harness that predates the proof would wait on its own holder
until the check's timeout. A command that takes the lock itself is its own
boundary.

**A fair queue between processes (tickets in a directory).** Rejected for
now: it needs every holder to know it, older harness copies do not, and
heavy jobs are few. Waiters report whom they wait for, and the driver's
batches keep their own order.

**Force interactive sessions through the lock.** Rejected: no host
interface intercepts a session's commands, and a lock that refuses a
person's test run would be bypassed. The wrapper is offered, and slice 4
writes the instructions.

### Slice 4

**Write the instruction into the child's next step and notes directly.**
Rejected: the worker in flight replaces the next step with its
`finish-verb`, and a note written mid-step races the driver's next spawn,
which is today's hand-run script. A record of its own, applied at the
boundary, survives the step and is ordered with it.

**Deliver instructions mid-step, to a running worker.** Rejected by the
owner (discussion 3, item 2): it changes a step's outcome outside the
record, and a stuck worker's handling is unverified. The boundary is the
only point at which the lane has one writer.

**Let an instruction carry free text into the worker's prompt.** Rejected:
the driver's step grammar admits no text by design (`policy.mjs:118-150`),
and a prompt is not a record. The note goes into the child's record, where
every later worker of the lane, and the owner, reads it.

**Queue several next steps.** Rejected: a queue decided ahead of the
results it depends on would run steps the lane's state no longer calls for.
The last step named wins; a second is written once the first one's step has
run.

**Let an instruction clear a gate.** Rejected: a gate holds a judgment whose
resolution records the decision (ADR-0063 D6); a next step without that
record would bypass it. A gate supersedes an instruction's step.

**Let an instruction cancel a running verification batch.** Rejected: the
batch is evidence about the lane's tree that the next step needs, and a
stopped batch is no evidence (Decision 5, item 6). The instruction waits
for the batch, and replaces only the step it would dispatch.

**Lane-to-lane notes now.** Deferred by the owner (2026-10-19): no lane
needs another's notes yet, and a note one worker writes for another is peer
text that reaches a worker without the owner.

**Rewrite the child's recorded dispatch at the approval.** Rejected: an
archived child is a record of what was done, and its dispatch is what
`/orchestrator:next` selected; rewriting it would erase which words the work
began under, and needs a persona release. The macro records the rebinding,
and the child keeps its record.

**Waive the comparison for an approved plan.** Rejected: the comparison also
guards a changed branch or verb, and another child of the subtask; an
approval says the owner accepts the plan, not that a given child's work
answers to it. Only the fields of the instructions, for the child shown, are
rebound.

**Honor a rebinding on approval alone, with a live run.** Rejected: a
`plan-set` and an approval between two looks would then accept a worker's
output made under words the owner had already replaced, and the run would
never see the plan change. The approval waits for the run to end, and the
note carries the change to the child.

**Make only an approval that changes an in-progress subtask an admission.**
Rejected after review: a dispatch under way has created its child before it
records the subtask in progress (`commands/next.md`, Phases 4 and 5), and a
revision can put an in-progress subtask back to pending, so such an
approval would still pass between two looks. Every approval that changes
the plan is an admission; a draining run starts nothing, so it costs no
progress.

**Have the driver pin the approval it started under, and drain on any
other.** Rejected: the approval's admission already keeps a revision from
being approved while a run lives, with no new run state, and the approval,
not the driver, is where the owner sees what a rebinding accepts.

**Keep today's rule: revise a topic only before its dispatch.** Rejected by
the owner's scope (discussion 4, item 7): it leaves an approved plan whose
words no longer say what its in-progress subtask is doing, and the gate
resolution that carried the change is not a record the plan can point to.

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
