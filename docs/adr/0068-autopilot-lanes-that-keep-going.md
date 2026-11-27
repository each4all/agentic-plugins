# ADR-0068: Autopilot lanes that keep going

## Status

Accepted (2026-10-20, owner decision: the owner accepted all four slices
explicitly in the main session). Proposed 2026-10-19. Each "§Status, open
point" in the decisions below marks a narrowing the owner confirmed with that
acceptance; the open points as they were listed for it, and the slices'
review record, are in [the history](history/0068-autopilot-lanes-that-keep-going.md#superseded-text-2026-11-17--the-status-section-before-the-adr-0070-migration).

Amended since by the implementation notes that fixed what each decision left
to its implementation (2026-10-21, 2026-10-25, 2026-10-26, 2026-10-28,
2026-10-29, 2026-10-30, 2026-10-31, 2026-11-01, 2026-11-03), the hold
amendments of 2026-10-27 (impl-hold's critique rounds), and the owner's
decisions C178 (verification policy) and C175 (temporary files and run
retention), both 2026-11-10, and the cascade of ADR-0059 Decisions 9 and 10
into Decision 2, item 12 and Decision 5, item 13 (2026-11-27, the persona
runbooks release their directories); each item an amendment changed carries
its dated marker. Decision 3's stall detector ships log-only: switching it on is the
owner's review, not yet recorded (Decision 3, item 8).

Decision 3, item 6, its clause that both macOS fingerprint readers compare a
start read in UTC (2026-11-22, C141): Proposed, as it rests on ADR-0023 §4's
Proposed amendment of that date.

On its acceptance it amended
[ADR-0063](0063-autopilot-fresh-session-driver.md) and
[ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) at the places the
slices' amendment records in its history list.

## Context

<!--
Citations are `path:line` at agentic-plugins 211283c3, verified 2026-10-19.
Persona scripts are cited at their canonical source under `persona-pipeline/`
(ADR-0066).
-->

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
  `:125-127`). *(2026-11-22, Proposed: both readers would compare a start
  read in the C locale and UTC under C141; Decision 3, item 6, holds its
  status.)*
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
   - **The park's fingerprint is taken after the step's peer runs are
     settled**, or compared without them, as the no-progress check already
     compares (`withoutPeers`), so the step's own peer bookkeeping never
     reads as a change (from this decision's [implementation list](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation)).
   - **A persona operation's bookkeeping is not progress.** It adds no
     `host_history` event and moves no field the lane fingerprint reads
     (`policy.mjs` `childTuple`). *Amended 2026-10-25 (hold-persona): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-25--hold-persona-the-hold-protocol).*
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
     life it comes: one that comes between the run's last consumption and
     its end leaves the next run to judge the lane afresh (from this
     decision's [implementation list](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation)).

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
     its budget reservation) allow. The park digest keeps its own quiet
     interval, which lets a parked lane's change settle before it is judged.
   - Other edits to the working tree alone wake nothing; they are seen at
     the next look some other change wakes, or at the run's end (item 7).
   - Each tick also retries every hold's handoff still pending whose lane
     has no step in flight (Decision 2, item 4), and every release a pass
     left to do, since what blocks them can go away without touching a
     source.
   - The run never wakes itself: the holds lock's own directory, the
     driver's own records and its hold bookkeeping (the handoffs,
     comparisons and exclusion records) are no wake source. Of the hold
     records the tick watches each subtask's owner record by identity, size
     and time, which `hold`, `release` and a discard write, and retirement
     and orphaning change once, each ending a hold; a bare release that
     ends a kept park wakes the live run through the park digest (from this
     decision's [implementation list](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation)
     and Decision 2, item 12). *Amended 2026-10-26 (impl-hold): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half).*
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
   - A lane an open persona operation holds back (Decision 2, item 12) has
     no expiry, yet does not keep the run up: with nothing running and
     nothing able to start, the run waits on it for as long as a step may
     take (`--step-timeout`), then ends, naming each operation and its
     `writer-clear`. *Amended 2026-10-26 (impl-hold, its amendment of
     2026-10-27): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half).*
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
     parked, in plan order (a held lane is held, not parked); `owner-choice`
     naming the subtasks held, with a handoff pending, or with an unreadable
     hold, unless the run awaits landing; `awaiting-landing`, which keeps its
     reason with the held lanes in its `also`; the
     idle halt. The codes are ADR-0063 D4's; no new one is added. `also`
     lists the other open parks. *Amended 2026-10-26 (impl-hold): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half).*
   - Each lane's entry, a subtask held or parked with no lane included,
     gives its state and, for each that waits, its resolution: the gate's
     pointer; for a park, the record change that resolves it or the bare
     `release <subtask-id>`, then the relaunch; for a held lane, its
     `release` command; for a pending handoff, its blocker; for an
     unreadable record, the file. Holds that apply to nothing are listed
     apart and never set the `reason`. The entries' lane states replace the
     free-text `state` they carried. A park the owner resolved while the run
     lived is in `lanes.jsonl` only (from this decision's [implementation list](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation)).
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
     and the order of its transitions are `impl-hold`'s, decided in item 12.
   - None of the records holds the person's prose: what the person wants
     the driver to know goes in the lane's workflow record, as a next step
     or a note (slice 4 adds instructions).
   - The macro's events (`held`, `released`, `consumed`, `rejected`,
     `retired`, `orphaned`, `discarded`) go to the holds directory's
     `events.jsonl` whether a run lives or not; a run writes its own lane
     events to its `lanes.jsonl` (`held`, `passed-by`, and `released` with
     the comparison's verdict), and does not copy the macro's.
     *Amended 2026-10-26 (impl-hold): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half).*

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
     hold that applies (held, pending, or unreadable), a holds directory
     that cannot be read, or a kept park,
     naming each: release it, or run with `--lanes`. Nor beside a release
     awaiting its comparison (released and not compared, or compared equal
     with its park not ended yet): only a run with lanes compares one before
     its lane steps, so the refusal names that relaunch (amendment of
     2026-10-27). Nor beside a rejected release, its park kept or not (a
     crash before the park was written, a discard): only a new hold and
     release give that lane back, so the refusal names them, as the driver's
     gate does (amendment of 2026-10-27, critique round 5).
     *Amended 2026-10-27 (impl-hold, critique round 5: the lane a hold takes, a person's own worktree, the serial run's refusals): [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-10-27--a-holds-lane-and-a-persons-own-worktree-impl-hold-critique-round-5).*
   - `hold` refuses a subtask the plan has closed (`completed`, `deferred`,
     `abandoned`), and a macro that has ended (item 12).
     *Amended 2026-10-26 (impl-hold): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half).*

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
   - The gate refuses a hold that is pending, held or unreadable, a release
     not compared yet or rejected, and, run-wide, a holds directory that
     cannot be read. A hold set between the decision and an admission stops
     that lane only: the wave goes on with the others and the run decides
     again. *Amended 2026-10-26 (impl-hold): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half).*

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
   - A task the scheduler runs for a named lane records the subtask it acts
     for; a look it takes of a worktree not yet among the run's lanes may
     record none, which errs toward busy. The driver keeps its own lane-lock
     entry beside the fence: the handoff leaves that entry out of the rivals
     it judges, and a lane the release gives back is stepped under the same
     entry. A pending handoff whose lane has no step in flight is retried at
     each tick, since what blocks it can go away without touching a hold
     record. A lane's worktree is gone only when its stat says it is absent:
     one that cannot be looked at blocks the handoff, refuses a release, a
     withdrawal and a new hold, and keeps a fence repair, a retirement, an
     orphaning and a macro's end waiting, so no fence in it is passed over
     (amendment of 2026-10-27). *Amended 2026-10-26 (impl-hold): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half).*

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
     unreadable hold, a release no run has compared yet or that was
     rejected, an open persona operation and, with holds on, an engineer
     that is not hold-aware alike (item 12); and a hold set after its check
     waits for its dispatch
     to finish (item 4), so `next` never records a subtask in progress that
     its engineer then refuses. The owner releases the subtask, and the
     driver dispatches it once it is ready.
     *Amended 2026-10-26 (impl-hold): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half).*

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
     file lock held; or another workflow, or one that cannot be read, on the
     branch, or several children linked to the subtask (amendment of
     2026-10-27). Every command that writes a macro's child is either a
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
       give the lane back. A rejected release whose park the records cannot
       take is parked once, its record written again at each pass, never a
       new park.
   - **A release is consumed once.** The lane's later progress is never
     compared with it, and no crash makes it count twice or lose its
     effect. A pending hold (never handed over) is withdrawn by its
     release, with nothing to compare. A release still in force when the
     hold was set (not compared yet, or rejected) comes back with the
     withdrawal, so a rejection is never lost and an uncompared release is
     still compared. A hold whose record, handoff or release was discarded
     (item 8) is not withdrawn: its release, pending or not, is a held
     one's, with the writer checks, the basis and a comparison (amendment of
     2026-10-27).
   - **A bare release** (no `--hold`) ends a parked lane's kept park
     (Decision 1, item 4): with a run live, that run reconsiders the lane;
     with none, the next run judges it afresh. It refuses on a held lane,
     on a lane whose release has not been compared or was rejected, and on
     a subtask neither held nor parked. It refuses too a park it cannot
     read, which it never deletes, and points at `--discard-unreadable`.
   - **Wake-ups.** A live run's tick watches each subtask's owner record,
     which `hold`, `release` and a discard write, and retirement and
     orphaning change; the handoffs, comparisons, exclusion records and the
     holds lock lie elsewhere, so the driver's own bookkeeping wakes
     nothing. A release a pass left to do is retried at each tick. A bare
     release ends a kept park, which the park digest already watches.
     *Amended 2026-10-26 (impl-hold): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half).*

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
     compared again (a lane that changed parks). A discarded release's
     basis cannot be read and whether it was rejected cannot be told, so it
     counts rejected: the lane is compared again only through a new hold and
     release, a rejection is never lost and a lane that changed never steps.
     A discarded handoff goes, so the lane is handed over again. Whether a
     hold whose record, handoff or release was discarded had been handed
     over cannot be told, so its owner record carries
     `compare_on_release: true`, written before the record it depends on
     changes, and its release is compared, never a withdrawal (item 7;
     amendment of 2026-10-27). A holds directory that
     cannot be read is run-wide (Decision 1, item 1), and the persona
     refuses its operations' first writes until it reads again.
   - **Orphaned.** A hold applies to nothing once its subtask leaves the
     plan, its branch differs from the plan's, or the subtask has a
     different lane or child than the hold was set on. The absence of a
     lane or child never orphans a hold: a held subtask whose unused lane
     was removed, or whose child archived, stays held. A hold once orphaned
     or retired never applies again, even when a subtask later reuses the
     id and branch. Only a hold pending, held or released-uncompared is
     marked orphaned, by the plan read under the holds lock (at a run's
     start, before any release is compared); a plan that cannot be read
     never orphans. What an ended hold (retired or orphaned) left, its
     handoff, its release and its fence, goes with it.
     *Amended 2026-10-26 (impl-hold): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half).*
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
     `done` records the subtask completed either way, and the retirement
     is retried later (item 12). A held lane alone does not stop abort or
     finalize: their child pass archives its child through the engineer's
     lifecycle archive.

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
    What the prototype found (`tests/acceptance/hold-takeover/`, run against
    the persona's half and then the orchestrator's): a worker resumes cleanly
    after a person's session, and this ADR needed no correction. Peer runs the
    session started are persona operations while they run (a verb's ensemble
    inside the verb's operation, a consultation its own), so the release waits
    for them and their peers' end; session-capture files lie outside both
    digests where the repository ignores `.agentic-plugins/`; a dirty tree
    recorded in no manifest is part of the release's basis, and the resumed
    worker's commit stops at the staging-set owner gate when the edit lies
    outside its manifest, or commits it with the change when it is unstaged
    inside a path the manifest names. `claude --resume` of a lane's last
    session stays [unverified]. *Amended 2026-10-25 (hold-persona, the
    prototype): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-25--hold-persona-the-hold-protocol).*

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
    Reconciliation reads each subtask's gate before any row acts, and again
    before each later action on a subtask that passed; a subtask it passes by
    is recorded `passed-by` in `lanes.jsonl`, the run takes no lock in it, and
    once given back while the run lives (its release consumed, or its hold
    ended with none) it is reconciled by the per-lane entry point before its
    next step, never created over its worktree. A lane the relaunch passed
    by whose hold ends keeps a park that still stands, which its own
    resolution ends, and a held lane whose kept park the owner released is
    let go, not judged again. A held lane is `held` in
    `halt.json`, `run.json` and the report, with its release (`--hold <id>`,
    or `--discard-unreadable`): held beats parked, since a held lane's kept
    park waits for its release and is no halt. A run whose remaining lanes are
    all held ends on the first of them, an awaiting-landing halt keeping its
    reason with the held lanes in its `also`. At its end the run makes its
    last handoffs, writes `halt.json`, removes its lock entries (its lanes',
    the macro's run lock, then its own worktree lock), then tries each pending
    handoff once more as a command with no live run would, so a hold set
    between its last handoffs and that removal is handed over; one set
    after finds no live run.
    *Amended 2026-10-26 (impl-hold): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half).*

12. **The hold protocol both halves keep.** The persona's half shipped first,
    and the two meet only in files; the fixtures under
    `tests/fixtures/holds-protocol/` hold every reader verdict as data, and
    both halves test against them. *Amended 2026-10-25 (hold-persona) and
    2026-10-26 (impl-hold, with its amendments of 2026-10-27): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-25--hold-persona-the-hold-protocol),
    [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half).*
    - **Records.** Under the macro's holds directory (`<main>` is the
      worktree holding the repository's common git dir), one subdirectory
      per record kind: `holds/` (the owner's record: a 16-hex hold id, the
      subtask, branch, lane or null, child or null, `held`, `released` or
      `retired`, who set it and when, and once set its release, retirement or
      `orphaned`), `handoffs/` (`acked`, with the fence's path, or null for
      a lane with no worktree), `releases/`
      (a release id, the hold id, `uncompared`, `consumed`, `rejected` or
      `withdrawn`, the comparison basis, null for a withdrawal, the kept park
      it ends and whether it ended it),
      `ops/<subtask>/` (open operations, the orchestrator's own exclusion
      records, kind `release`, `compare`, `retire` or `cutover`, with the
      writer's pid and process fingerprint, and the owner's `.cleared` markers,
      created once and never rewritten), `parks/`, `instructions/`
      (Decision 7), `discarded/`, the macro's `events.jsonl` (`held`,
      `released`, `consumed`, `rejected`, `retired`, `orphaned`,
      `discarded`, appended whether a run lives or not), and the holds lock.
      The persona never writes the owner's record nor its handoff. A hold is
      *pending* while its owner record says `held` with no `acked` handoff of
      its hold id, and *held* with one; a release's state is read only beside
      an owner record `released` of its hold id.
      Every record is written whole (a temporary file renamed over it, or an
      exclusive create). Each multi-file change is a sequence of whole-file
      writes, and every state a crash can leave between two of them has one
      recovery, which the next hold-aware command or run performs. Among
      them: a release whose owner record still says `held` is never compared
      (the driver compares only a release whose owner record says `released`
      with its hold id), and a retried release recomputes its basis and
      replaces it; a handoff retry that finds its own fence redoes every
      blocker check before it acks, never acks at once, and withdraws the
      fence when it finds a blocker. A handoff
      or release record of a held hold that cannot be read makes the hold
      unreadable, and nothing withdraws or repairs it until the owner
      discards the record.
    - **The order of the transitions, and the recovery of each state a crash
      leaves** (item 1):

      | Change | Writes, in order | State a crash leaves | Recovery |
      |---|---|---|---|
      | `hold` | owner record `held` (new id), removal of an older handoff and a withdrawn, consumed or rejected release of an older id | owner `held`, older records left | the older records name another hold id and are ignored; the next write of the subtask removes them |
      | handoff | fence entry, recheck, `acked` handoff | fence written, no ack | a retry finds its own fence (its name derives from the hold id) and redoes every blocker check before it acks, never acks at once; a blocker found then withdraws the fence |
      | handoff | — | ack written, fence gone (an older `admission release`) | the next hold-aware command repairs the fence (item 4) |
      | release of a pending hold | `withdrawn` release, owner `released`, fence removal | withdrawn release, owner still `held` | the hold still applies; the retried release finds its own withdrawn release of the hold id and finishes |
      | release of a held hold | own exclusion record, basis, `uncompared` release, owner `released`, fence removal, exclusion record removal | release written, owner still `held` | never compared: the driver compares only a release whose owner record says `released` with its hold id; a retried release recomputes the basis and replaces it |
      | | | owner `released`, fence present | any hold-aware command removes that hold's fence only, never another hold's |
      | | | exclusion record left by a dead writer | the next orchestrator command that finds a `release` or `compare` record whose recorded process is gone removes it; a live one is open |
      | consumption | own exclusion record, digest, release `consumed` (`park_ended: false`), the park's end by `park_record_id`, `park_ended: true`, exclusion record removal | `consumed`, park end pending | the next run finishes it by the recorded park id only (a conditional delete), never a newer park |
      | rejection | own exclusion record, digest, release `rejected`, park `owner-choice` | `rejected`, no park | the rejection alone keeps the lane from stepping; the next run rebuilds the park; a forced `--next` and a `record changed` resumption do not pass it |
      | discard | copy under `discarded/`, then the replacement (a new hold; a release counted rejected; a handoff's removal, so the lane is handed over again; `--discard-unreadable` below) | copy written, replacement pending | the unreadable record still guards the subtask; a retry keeps a new copy and replaces it, never passes the lane unguarded |
      | retirement (`done`) | owner `retired`, release and handoff removal, the kept park's deletion, fence removal | owner `retired`, others left | retired never applies again; any reader removes records of a retired hold id; the retry is idempotent |
      | retirement (macro end) | the macro's terminal write, then the directory's removal | terminal written, directory left | `stop-archive`, `status` and the next run retire the directory of an archived macro too (`/orchestrator:done` does not address an archived macro, so a retirement that waited at done is finished by `status` or the Stop sweep) |
      | `hold` beside a starting run | owner record `held`, then a second look at the live runs | a run that does not honour holds took its locks between the two looks | the second look withdraws the unhanded hold; the serial run's own look after its locks sees any hold published before it |
      | any | — | a handoff or release record of a held hold that cannot be read | the hold is unreadable, not pending: nothing withdraws or repairs it until the owner discards the record |

    - **Turning holds on.** Per macro, by the marker `protocol.json`
      (`agentic-holds-protocol-1`, protocol 1), written before the first hold
      record by `hold`, and by a run with lanes before its first dispatch,
      and only once the hold-aware persona (`hold-persona-1` from `state.mjs
      hold-capability`) is the newest engineer in each host's own install
      cache (`~/.claude/plugins/cache/agentic-plugins/engineer/`, and
      Codex's under `$CODEX_HOME` or `~/.codex`), probed strictly, with no
      environment override and no fallback to the other host, and the
      engineer the launcher pins (`AGENTIC_ENGINEER_ROOT`); otherwise
      holds stay off, the refusal names what to install or which pin to move,
      and lanes run as before (a run whose check fails says so). Completing
      the persona subtask is not enough: a person's session loads its own
      host's engineer. The marker is never removed while the macro
      lives, nor overwritten when it cannot be read. The persona reads it at
      the first and last write of each operation of a macro's child (an
      interactive `finish-verb` in its write, holding the workflow's lock): no
      directory or no marker is inactive, and the persona writes as before;
      the marker of this schema is active; anything else is unreadable, and
      the persona refuses its operations' first writes, naming the path, and
      lets a running one finish. A run with lanes records `capabilities:
      ["holds-1"]` in `run.json` and its lock entry (a serial run records
      none; the orchestrator's `state.mjs hold-capability` prints
      `holds-1`), and the lanes capability
      floor requires the pinned engineer's `hold-persona-1`. A serial run
      looks for holds again after it takes its locks, so a hold published
      between its first look and its locks still stops it; `hold` refuses beside a
      live run that does not honour holds, or whose capabilities cannot be
      read, and looks again for such a run after it publishes, withdrawing
      the unhanded hold when one took its locks in between.
    - **What applies.** An owner's record applies to a child when it reads,
      is `held` (its handoff pending or done), is not orphaned, names the
      child's branch and, when set, the child. A record that cannot be read
      applies; a missing one does not. A kept park is any record in `parks/`
      of the subtask, readable or not. A live run is a macro-lock entry whose
      driver is the process recorded, judged as the run locks judge it (its
      start read in the C locale, a zombie gone, a pid reused by another
      process gone); a lock directory or entry that cannot be read, that is
      no regular file, or that is too fresh to have been written whole
      counts as live, with capabilities unknown.
    - **Persona operations.** An operation runs from a command's first write
      of a macro's child (a bootstrap's create) to its last (a verb's
      `finish-verb`; a commit's parent writeback after its archive; a gate
      resolution's `finish-verb` after its clear). Its id travels between the
      command's blocks in its operation directory (`OP_DIR`,
      `--operation-dir`) and stays on the child while open
      (`persona_operations`, a scalar an older reader carries byte for byte);
      it adds no `host_history` event and moves nothing the lane fingerprint
      reads. Inactive, the first write adds its entry in that write, and
      overlapping operations each keep their own entry; the last write
      removes it in that write, and one with `ext: true` refuses (its marker
      vanished). With holds active, the first write creates its record under
      `ops/<subtask>/` exclusively before it takes the workflow's lock, looks
      again, and refuses, withdrawing the record, beside any other open
      operation (an entry of the child, or a record with no `.cleared`); two
      first writes at once may both refuse, never both proceed; holding the
      workflow's lock, the first write looks at the child's entries once more
      and adds its own with `ext: true`. A last
      write is refused once the owner cleared the operation, or when its entry
      has `ext: true` and its record is gone; else it removes the entry, and
      the record is removed after the workflow's lock is released. An
      operation is open while its entry or its record is there and no
      `.cleared` names it; an entry the owner cleared goes with the lane's
      next first write, and its own last write stays refused. An operation that read inactive
      and meets the marker at its last write was open before activation
      (`ext: false`), and closes as active, refused only when cleared. The
      operation directory is a private directory the first-write block makes
      and prints as `OP_DIR=<path>`, which the agent sets in the finalize
      block as it sets `DISPATCH_DIR`: in a package whose runbooks have
      switched (ADR-0059 Decisions 9 and 10: today the persona plugins), made
      and marked by `state.mjs tmpdir-make --kind op` and released by the
      block that makes the operation's last write, once that write succeeded;
      in one that has not, a `mktemp -d` directory. *Amended 2026-11-27 (the
      persona runbooks release their directories): [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-27--the-persona-runbooks-release-their-directories).* The
      first write keeps `operation.json` in the operation directory (the id,
      kind, macro, subtask, branch and child, and `opening`, `open` or
      `closed`) before it publishes anything, so a first write run again
      continues its operation, and one run again across activation publishes
      its record and marks its entry `ext: true`. A directory file bound to
      another child, branch or kind, one that ended (or whose entry is gone
      from the child), or one that cannot be read is refused, as is a last
      write whose file names another kind than the child's entry. A first
      write reads activation again holding the workflow's lock and refuses, to
      be run again, when it changed since its first read. A directory that is
      gone refuses the last write: it may have been released after that write
      already ran, and then nothing is to be repeated, or lost. Only once the
      workflow's record shows the write did not land can the person run it
      with no directory, on a macro's child leaving the operation open for
      the owner to clear (ADR-0059 Decision 10, item 5); with no directory at
      all a write is as before. *Amended 2026-11-27 (the persona runbooks
      release their directories): [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-27--the-persona-runbooks-release-their-directories).* A bootstrap dispatched by
      `/orchestrator:next` takes the id the dispatch exported
      (`AGENTIC_OPERATION_ID`), and continues a record of that id already
      published when it names the same kind and lane and no other child.
      A crash before the first write, or after the last write's entry removal,
      leaves the operation open for the owner's `writer-clear`. A commit's
      operation (kind `commit`) is its entry on the child; its first write is
      the commit's `beginCommit` (a close's terminal write, for the
      no-changes close). It stays open through its archive and parent writeback, each run
      of a commit opens its own; after the parent note a write of the
      archived file removes the entry (the newest of the kind the owner has
      not cleared), adding no `host_history` event and moving no
      `updated_at`, then the record goes, and a cleared operation's entry
      stays on the archived file. The no-changes close ends its operation in
      its archive. On a host whose Stop hook does not run (Codex before
      `/hooks` trust), the operation stays open until the archive runs. A commit that refuses before its terminal
      write (a post-commit gate, a hook, a subject) has made its last write
      and ends its operation there, and one stopped by an error (a throw, a
      kill) stays open. A
      checkpoint, an autopilot commit's staging-set gate, a gate's clear given
      no operation, `/resume`'s marker and an archive (kind `archive`, which
      `state.mjs archive` makes on either host) are operations of one
      write: admitted as a first write is (one at a time in the lane, none
      while the holds cannot be read) and refused as a last write is (cleared
      by the owner, or its record gone, while it waited for the workflow's
      lock), they leave no entry, and the record goes after the write. An
      archive whose workflow is already gone writes nothing and opens
      nothing. A gate resolution (decide's Owner selection, refine's Owner
      decision) runs from its clear to the `finish-verb` after it: the clear
      continues the operation the verb's Phase 0 opened when the block is
      given its directory, and otherwise opens one (kind `gate`; refine's
      Fix now opens a `verb` operation, which the refine's phases continue to
      their finalize). Inside a `/start` lifecycle no `finish-verb` follows:
      given Phase 0's directory, the clear closes that operation, and given
      none it is an operation of one write. A clear given a directory whose
      operation ended is refused before it writes. A `/peer-now` consultation on a macro's child is its own
      operation (kind `peer`) from before its launch to its note: the
      dispatch opens it with a write of the entry alone (no `host_history`
      event, no `updated_at`), and a refusal stops the launch, so it is refused while
      the person's own verb is open (the verb's own ensemble runs inside the
      verb's operation); a directory that already holds its `op` is refused,
      so a dispatch run again never launches a
      second one. Scripts that print no `hold-capability` open none. The
      note goes only to the workflow the dispatch kept as
      `prompt.xml.workflow`, and closes the operation; a consultation that failed gets no
      note, and its dispatch closes the operation once the runner's own
      result says the run ended (`failed`, `cancelled`, `orphaned`), while a
      runner that left no result (killed, its peer perhaps still running),
      or a dispatch killed before the launch, leaves it open for the owner.
      The Stop sweep leaves alone a child whose lane has an
      operation open, and every child while the holds cannot be read,
      judged again holding the archive's lock; once the owner cleared the
      operation, the next sweep archives it. Inactive, it archives as before
      and ends a commit's operation after the archive.
      `/start` opens none: its resume writes a start workflow only, refusing
      any other before it writes; a start workflow created with parent linkage is
      refused in a macro whose holds are on or cannot be read (one made by
      hand before the macro was marked writes outside any operation, a
      limit of a workflow no command produces).
    - **The writers of a child.** Every lock of a workflow names its writer's
      class, and a persona test fails on a writer left unclassified: an
      operation's step; a plain write (a note or terminal write given no
      operation, a manifest entry, a review ledger, a consensus task, a
      pending peer run, a gate set by hand, the P10 marker, an archive),
      refused while the macro is active, the owner's hold applies and no
      uncleared operation is open on the child, and while the holds cannot be
      read with none open, and while the child's operations are of a later
      version than the persona reads; the Stop and PreCompact snapshot,
      admitted; a settlement of a run the child records, admitted (of any
      other run it is a plain write); a verification batch's result, end or
      pass, admitted; a batch's start or restart, refused while the hold
      applies or the holds cannot be read, whatever operation is open; a
      create, judged once written, a linked one with no operation (an
      earlier runbook, a create by hand) refused in a held lane and
      withdrawn, as an unlinked one is (below); an archive's destination,
      which holds no live workflow. With an operation open on the child a
      plain write is admitted, whoever runs it. A peer launch a held lane would
      refuse stops before the companion is spawned (`peer-runner run`
      records the run `failed`, error kind `held_lane`). The
      orchestrator's lifecycle archive (`detach-archive`, which abort and
      finalize run) is an operation (kind `archive`) from
      its mark to its archive, which ends it: it archives a held lane's
      child, is refused beside another open operation and while the holds
      cannot be read, and a crash between its two writes leaves it open for
      the owner. An archive that ends an operation it names is refused once
      that operation is gone, and never archives on another operation's
      entry. The Stop lifecycle leaves a held lane's child that has no
      operation open (a commit's is open through its archive), as its sweep
      does, and archives it after the release. `cutover --move` and its
      rollback refuse, before they write a manifest and again before they
      move an open manifest's pairs (the rollback before its switch goes
      off), a child, active or archived, whose subtask's hold applies or
      that has a persona operation open, and every child while its macro's
      holds cannot be read; and each child's move, under its own lock,
      judges it again behind an exclusion record (kind `cutover`), so a hold
      or an operation that came after those checks refuses the move.
    - **An unlinked bootstrap** (every designer and founder create, and an
      engineer create with no dispatch linkage to the lane that holds its
      branch) reads each macro whose holds are on, and is refused, naming the
      macro, the subtask and the hold, when an owner's record applies to its
      branch. It reads them before it publishes anything and again once the
      workflow is written, holding its lock, and withdraws the workflow when a
      hold appeared in between. A holds root, macro directory, marker or
      owner's record that cannot be read refuses every unlinked create in the
      repository until it reads again or the owner discards the record; a
      macro with no marker refuses nothing. A linked bootstrap's own macro,
      where it cannot be read, is its operation's to judge.
    - **Locks.** The persona takes no lock in the holds directory: its records
      are exclusive creates and unlinks, published before a write's workflow
      and creation locks are taken and removed after they are released,
      never inside them. An archive takes the creation locks before the
      workflow's lock, and a create takes the creation locks alone; neither
      nests a holds-directory lock. The orchestrator reads a child's open
      operations without its locks. The orchestrator takes the worktree lock, the macro
      lock, the holds lock (with a short retry), then `parks/.lock`, never
      waits on a persona lock while holding one, and judges a workflow lock by
      its presence. No cycle can form.
    - **The comparison's values** (item 7). A release records, and the
      driver's comparison recomputes, four values: the lane's fingerprint as
      a park takes it, peer bookkeeping included, with its version (with no worktree, a look of the main
      checkout with the branch's tip); the tree digest (versioned: every
      non-ignored file, `git add -A` and `git write-tree`, through a
      temporary index copied from the lane's, the lane's real index never
      touched, its
      assume-unchanged and skip-worktree bits cleared and its stat dated so
      content is compared, inherited `GIT_*` variables scrubbed, each
      checked-out submodule recursively and an uninitialized one by its
      gitlink, the lane's autopilot worktree lock left out; a lane with no
      worktree has none, and its fingerprint with the branch's tip, the
      content digest and the child are compared); the child's content digest (the pinned engineer's `state.mjs
      content-digest`, its schema checked, `no child` when there is none: its frontmatter, its forward-compat
      carrier included, without the fields a snapshot writes
      and the verification bookkeeping every write stamps, and its body as
      stored, leading blank lines left out); and the child's id (the one the
      hold names, else the one its handoff found when it acked, active or,
      with none active, the latest archived child linked to the subtask on
      its branch, so a hold set while the dispatch step ran knows its child;
      an archived child found
      again by that id). Equal in all four consumes the release; any
      difference, a fingerprint version included, rejects it. The driver
      takes the basis off the loop, as a task of the lane. Before it takes
      a basis, a release, a comparison, a retirement or a cutover move
      publishes its own exclusive operation record in the lane and looks
      again for any other open operation, which withdraws the record and
      refuses, so it and a persona first write never both proceed; one whose
      process is gone is swept by the next such action of the subtask (a
      macro's end, and a cutover or rollback for each child it moves, sweep
      before their first look), never
      by a read: until then `status`, the handoff and the gates see it open.
      Before the exclusion, `release` also refuses while the child has a
      pending peer ensemble or its workflow file lock is present (judged by
      presence, never waited on). A release, and a comparison beside its record, also refuse
      beside a pending ensemble, the child's workflow lock, another workflow
      or an unreadable one on the branch, or several children linked to the
      subtask (amendment of 2026-10-27). A comparison refused leaves the
      release uncompared and the lane unstepped, retried at each tick, as is
      a release a pass left to do. Consumption ends the kept park
      the release recorded, by its record id only, then reconsiders the lane
      from the child's `next_step`, landing or dispatch; a rejection is final for
      that release, the lane parks `owner-choice`, and no forced `--next`, `record changed` resumption,
      missing park or discard passes it; a new hold and release do.
    - **The fence.** An admission entry in the lane's worktree lock, named as
      a session's so every reader, an older driver included, reads it as live
      until it is removed (its holder `{kind: session, command: hold,
      hold_id, subtask_id, macro_id, checkout}`);
      its admission id derives from the hold id, so a retried handoff finds
      its own fence and no other. `describeAdmission` prints the hold's
      release command for it, and `admission release` refuses it before it
      removes anything; only the
      hold's commands end it. `status` and a run (its handoffs and its pass
      over the releases) repair a held hold's missing
      fence and remove a released, retired or orphaned hold's leftover one, only that hold's, under
      the holds lock, so a handoff between its fence and its ack is never
      judged from outside. A lock entry is read only as a regular file opened
      without blocking, so a FIFO is never waited on and a link to nothing is
      not taken for gone. A lane is busy while a worker or task group of any run
      of the macro lives naming its subtask, or naming none (every lane of
      that run is then busy), or while a dead run left
      a step of it unfinished; what cannot be read is busy. A task the
      scheduler runs for a named lane records the subtask it acts for; a look
      of a worktree not yet among the run's lanes may record none, which errs
      toward busy. A live driver judges its own steps in flight and
      settlements under way, and keeps its own lane-lock entry beside the
      fence: the handoff leaves that entry out of the rivals it judges, and a
      lane the release gives back is stepped under the same entry.
    - **`/orchestrator:next`** (item 5). `state.mjs hold-gate` refuses,
      naming the exit, a subtask whose hold is pending, held or unreadable,
      whose release is uncompared or rejected, or whose lane has a persona
      operation open (the records under `ops/<subtask>/` and the entries of
      every child linked to it on its branch, active or archived), and, with
      holds on and `--engineer-root` given, an engineer that is not hold-aware.
      It runs in Phase 1 and, with the engineer's root, in Phase 3, and
      prints nothing for a macro whose holds are off. Phase 3b, under the
      admission, judges it again under the holds lock, where a bootstrap (no
      engineer workflow on the branch yet) of a macro whose holds are on publishes the dispatch's
      mark (an operation record of kind `verb` with no child,
      `dispatched_by: orchestrator:next`, whose id it first keeps in
      `dispatch-mark.json` with whether the holds were on and whether this is
      a re-attach) and refuses
      beside any other open operation (a macro whose holds are off is judged
      without the lock, so no holds directory is made). A hold set from then
      on stays pending, its handoff seeing the operation open. Phase 4 judges the gate beside its
      mark (which must still be a readable, uncleared dispatch record),
      refuses when holds turned on after Phase 3b judged them off and, the
      holds on, an engineer that is not hold-aware, and
      exports the mark's id (`AGENTIC_OPERATION_ID`, unsetting any other), which the engineer's
      bootstrap continues; only a pass leaves the check file
      (`dispatch-mark.json.checked`, naming the operation ids the subtask's
      children carried then) beside which
      Phase 5 records the subtask in progress, the holds on or off (a
      dispatch whose mark file is gone is not recorded either). Each check
      takes the earlier pass away before any discovery that can fail and
      writes it back only when it passes, so a refusal or an error leaves
      none. The prelude runs again before each later engineer block. Once a check has passed and a
      linked child carries the mark's id (with no mark, a re-attach or a
      dispatch whose holds were off at the switch, an operation the owner
      has not cleared that the pass did not see: the engineer's, begun
      since), the lane is the engineer's and every later prelude passes, a
      hold set since waiting for that operation
      (amendment of 2026-10-27). Every exit after the publication (Phase 3b's
      own refusal and every exit of Phase 5) withdraws
      the mark unless a child linked to the subtask, active or archived, carries
      its id, or one cannot be read: the engineer took it over, and its last
      write removes it. A Phase 5 that finds no mark file says that a
      published mark stays open for the owner to clear; a session that stops between
      Phase 3b and Phase 5 leaves it open for `writer-clear`. A re-attach
      publishes no mark, since the engineer's resume opens an operation of
      its own. Limit: a hold acknowledged between Phase 4's check
      and a re-attached engineer's first write, or the first hold of a macro
      whose holds were off set between Phase 4's check and a bootstrap's
      first write (no mark was published for it to wait for), lets that
      person's verb run in the held lane, as any person's operation may (the
      driver still stays off).
    - **Retirement and the macro's end** (item 8). `/orchestrator:done`'s
      write (`state.mjs subtask-update --status completed`, the same on both
      hosts) retires the subtask's records after it completes the subtask,
      in the order of the table above (a release or handoff that cannot be
      read is left and named, the kept park ended under `parks/.lock`),
      under the holds lock behind an exclusion record of its own in the lane
      (kind `retire`), looking again once it is published so no persona
      operation begins while it retires, reading the plan again under the
      lock so a plan revised since the caller looked (the id reused, a new
      hold set on it) retires nothing, and waiting while an operation is
      open in the lane (the records under `ops/<subtask>/` and the entries of
      every child linked to it, active or archived, an entry-only operation
      begun before the holds turned on included) or a worker of a run lives
      there, the caller's own run excepted (a worker of it records the lane
      done); an exclusion record whose process is gone is swept first. The
      subtask is recorded completed either way, and the hold applies until
      the retirement runs, which
      done's no-op path (`holds-retire --subtask-id`), `status`, the Stop
      hook and a run's start retry it, and a retry also removes a fence a
      crash left after the owner record turned `retired`. A hold record that
      cannot be read is not retired: the owner discards it, and the next of
      those retires it. A write that ends the macro, or finds it ended,
      retires its holds directory: under the holds lock, behind an exclusion
      record in every lane, and after a second look, every hold's fence is
      removed and the directory is renamed aside in one step, then removed,
      waiting while a run of the macro other than the caller's lives, an
      operation is open (child entries included), a lane is busy or a hold's
      owner, handoff or release record cannot be read (its fence and its
      bytes would go with the directory: the owner discards it first).
      `/orchestrator:abort` and `finalize`, on both hosts, run
      `holds-preflight` after their admission and before their first bulk
      status write (an open operation, a busy lane other than the caller's own
      worker, a record or directory that cannot be read or, with holds on, an engineer
      that is not hold-aware stops them, naming each, before anything is
      written; amendment of 2026-10-27; a held lane alone does not, since
      their child pass archives its child through the engineer's lifecycle
      archive), and
      `holds-retire --macro-end` after their terminal write, which refuses a
      macro that has made none. `status` retires the directory of a macro
      that has ended (terminal or archived). The Stop hook, after its loop
      over live macros, reads where each macro with a holds directory is: one
      archived (in an archive home of some root, in no workflow home) has its
      directory retired; one live has its completed subtasks' records retired
      and, ended, its directory; a workflow home that cannot be looked at
      retires nothing. A run's
      start (before any release is compared), `status` and `holds-retire`
      with neither option mark `orphaned {at, why}` on an owner record that
      is pending, held or released-uncompared when, by the plan
      read under the holds lock, its subtask left the plan, the plan's branch
      for it differs, its lane (the worktree holding the branch) differs from
      the one it was held in, or the one child linked to it differs from the
      one it was held on, and the fence goes with it; a lane or child that is
      absent or not known, or a plan
      that cannot be read, never orphans. Each also removes what an ended
      hold (retired or orphaned) left: its handoff, its release and its
      fence. `hold` refuses a closed subtask (`completed`, `deferred`,
      `abandoned`) and
      an ended macro, asking again under the holds lock before it writes
      (amendment of 2026-10-27), and refuses too a subtask not in the plan
      or with no branch, an owner record it cannot read and a hold already
      held; a handoff or release record it cannot read is left as it is, and
      the new hold is unreadable until the owner discards it.
    - **The owner's commands** (items 2 and 7). `hold`, `release` and
      `writer-clear` refuse inside an autopilot worker; `status` does not.
      `hold` activates holds and records the branch, the lane (the worktree its branch is checked
      out in; none when that is the main checkout, so that hold is unfenced;
      with no worktree, none, and a worktree that holds the branch by its
      handoff or its release is taken into the record then: amendment of
      2026-10-27), the child, and a release still in force (uncompared or
      rejected) as `prior`; with no live run it attempts the handoff at once
      (a live run's loop does it at its next settlement boundary).
      It prints the hold id, the handoff's state and what it waits for, the
      lane, the lane's last session from this macro's run ledgers (`claude
      --resume <session>`, the latest step started), the engineer the
      person needs, the release command, and warns that a subtask with no
      lane is unfenced (only "do not dispatch it") and that a lane that does
      not ignore its generated state paths will reject a release a session
      left open writes after.
      `release --hold <id>` names the hold it ends (another id is refused).
      It withdraws a pending hold with nothing to compare, and its `prior`
      comes back with its hold, the new hold's fence removed first, while its
      record still names it (so does `hold`'s own withdrawal beside a blind
      run), so a rejection is never lost and an uncompared release is still
      compared. A held one is refused while a writer may be active (an open
      operation, a pending ensemble, the child's workflow lock, another
      workflow on the branch, several children linked to the subtask), else
      it records the basis behind the
      exclusion, turns the owner record `released`, removes the fence and
      wakes a live run. The bare `release` ends a kept park
      only: it refuses a held lane, a release not compared yet or rejected,
      and a park it cannot read, which it never deletes, and points at
      `--discard-unreadable`. `--discard-unreadable`
      keeps a copy under `discarded/` of each unreadable record (for one
      that is no regular file, or cannot be opened, a line saying so, not its
      bytes) and replaces it so the lane is
      never given back unguarded: an owner's record becomes a new hold
      (`set_by: discard`) on the
      branch and lane the plan names, refused when the plan names none, its
      old fences removed from every worktree of the repository (its lane
      cannot be read, and a plan revision may have moved the subtask; when git
      cannot list them, the record is not replaced, and a retry does it); a
      release becomes rejected; a handoff goes, so the lane is handed over
      again; an unreadable park is deleted
      only while its bytes are the ones copied.
      A hold whose record, handoff or release was discarded carries
      `compare_on_release: true`, written before the handoff or release
      record it depends on changes, so its release, pending or not, is a
      held one's (the writer checks, the basis and a comparison),
      never a withdrawal (amendment of 2026-10-27). A discarded release is
      counted rejected, so the lane is compared again only through a new
      hold and release. `writer-clear` writes the
      operation's `.cleared` exclusively, for an operation known only from a
      child's entry too. `status --macro` works from any checkout and with no
      run history (each hold's state, what its handoff waits for, its open
      operations and its release); with no
      live run it completes handoffs, repairs fences, orphans and retires,
      and retires an ended macro's directory. A
      run writes its own lane events to `lanes.jsonl` (`held`, `passed-by`,
      `released` with the comparison's verdict), and does not copy the
      macro's.
    - **The driver beside a hold** (items 3 and 4). It reads the hold gate on
      entering each path that acts on a lane (a creation, an admission, a
      spawn, a removal, a resumption, a forced `--next`, a reconciliation
      row); a path the gate let in runs to its end (a resumption's park end,
      its reconciliation and its lock), and handoffs run at the
      loop's settlement boundary after it, so a hold set meanwhile stays
      pending until the path is done, and the next path is gated. The gate
      refuses a hold that is pending, held or unreadable, a release not
      compared yet or rejected, and, run-wide, a holds directory that cannot
      be read. The decision leaves a gated subtask out as it leaves out a
      lane with a step in flight, so no step is chosen for it, its done
      included. A hold set between the decision and an admission stops that
      lane only: the wave goes on with the others and the run decides again.
      The spawn holds a lane back while a
      persona operation is open there (the child's entries and the records
      under `ops/<subtask>/`, read fresh, replacing the old quiet period
      after an engineer record written outside the run), so an operation
      that writes nothing for a long while still keeps the worker out, and a
      gate resolution's clear and its `finish-verb` are one operation; the
      park digest's own quiet interval is unchanged. A lane held back says
      which operation, and the owner's `writer-clear` for one whose session
      is gone, once per change, in the output and the lane's report
      (`waits`). An open operation has no expiry: a run with
      nothing else able to start waits on it for as long as a step may take
      (`--step-timeout`), then ends naming each operation and its
      `writer-clear` (amendment of 2026-10-27). A held lane whose kept park
      the owner released is let go, not judged again; a lane the relaunch
      passed by whose hold ends keeps a park that still stands, which its own
      resolution ends; and a rejected release whose park the records cannot
      take is parked once, its record written again at each pass, never a
      new park. A lane state `held` joins `halt.json`, `run.json`, `status`
      and the report. A landing-ready report is a
      look, not an action on the lane, and may still name a held lane's
      branch.
    - **Limits.** The tree digest keeps item 7's "every non-ignored file",
      the lane's worktree lock excepted; in a lane that does not ignore
      `.agentic-plugins/state/` and `.agentic-plugins/runs/`, a session left
      open after the release may write there and have it rejected, which
      `hold` warns of, naming the paths. An ignored file is not in the tree
      digest, so an edit to one is not seen by the comparison, unless it is
      the child's workflow or something the fingerprint reads, which are
      compared apart from git. A hold on a branch the main checkout has is compared in
      the no-worktree form, so an edit left uncommitted there is not seen.
      Every scan of a lane's workflows reads the legacy engineer home
      (`.claude/agentic-engineer`) too and
      counts open a workflow it cannot read, an archived one or one with a
      quoted scalar that does not parse included, naming it. For a hold that
      names no child, the handoff, the release and the comparison look for
      its archived child, and an archived workflow or archive directory that
      cannot be read blocks them; for one that names its child, a place the
      child's archived file may
      be that cannot be looked at blocks them, never read as its absence,
      and every state root is looked in before a copy is accepted: a copy in
      a later root that cannot be looked at, or a second readable copy, blocks
      them too (amendment of 2026-10-27). A
      lane's worktree is gone only when its stat says it is absent (ENOENT):
      one that cannot be looked at blocks the handoff, refuses a release, a
      withdrawal and a new hold, and keeps a fence repair, a retirement, an
      orphaning and a macro's end waiting, so no fence in it is passed over.
      A plan id
      that is no hold key (the plan takes any string, `hold` only
      `[A-Za-z0-9._-]`) is dispatched and retired as with holds off: no hold
      can be kept for it. A
      waiter on the holds lock of a macro whose directory was just retired
      makes the directory again; no hold is written there then, since `hold`
      refuses an ended macro and asks again under the holds lock before any
      write of its record (the macro, the subtask and the holds' activation,
      which a retired directory no longer has), and abort, finalize and done
      have checked the lanes, and the next Stop retires it. A `hold` whose
      activation, taken before that lock, lands after the retirement leaves
      its protocol marker there and nothing else; the hold itself refuses,
      and the next Stop retires the directory. The Stop sweep reads only the
      roots the stopping checkout can list. `/orchestrator:done` does not
      address an archived macro, so a retirement that waited at done for an
      archived macro is finished by `status` or the Stop sweep.
      Rolling the orchestrator back below this release while a hold exists is
      unsupported (item 9).

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
   pinned to C, as the run locks do for their fingerprint
   (`plugins/orchestrator/scripts/lib/run-locks.mjs:102-109`, `:143-149`) and
   the persona's reader does for its own
   (`persona-pipeline/files/scripts/lib/process-identity.mjs:19`, `:76-98`),
   both of which compare a start read in UTC as well (C141). The sample interval
   is 10 s, as measured. *Proposed 2026-11-22 (C141), resting on ADR-0023 §4's Proposed amendment: [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-22--the-persona-reader-pins-its-locale-c141).*

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

11. **How it is read and recorded.** *Amended 2026-10-29 (impl-stall): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-29--impl-stall-decision-3).*
    - **The probe** reads the whole process table at once: each process's
      pid, parent, group, identity, age and CPU time, or a failed read
      (`failed`, `timeout`, `parse`, `coarse`). macOS runs `ps -A -o
      pid=,ppid=,pgid=,etime=,lstart=,time=`
      with `LC_ALL` and `LANG` set to C, its CPU time read with minutes past
      59, and a time with no fraction is coarse; Linux reads
      `/proc/<pid>/stat` after the command name's last `)` (utime and stime
      only, `CLK_TCK` from `getconf` once per process, the age from
      `/proc/uptime`). The identity is the pid with `lstart` (macOS) or
      `starttime` (Linux). A process absent from the listing was not alive
      throughout it, so the listing is a snapshot on both platforms.
      Any line that does not parse fails the whole read; a stat that is gone
      (ENOENT, ESRCH) is an exit, one that cannot be read (EACCES) or is
      malformed is unreadable. The read and `getconf` share one 5 s
      deadline: past it the read is `timeout` and is told to stop (the walk
      at its next process, `ps` and `getconf` killed at the same bound), and
      until it has stopped a new read is `slow` and starts nothing.
    - **Membership.** A worker's members in a known table are its children
      by ppid, every process in its group, every identity a known table
      showed as a member, and their descendants, the worker itself excluded.
      An identity leaves when a table no longer lists it, unless the table
      could not read its pid.
    - **A table that could not read a pid is unknown for every worker,**
      stricter than item 4's "a live member": an unreadable entry carries no
      start time, so no pid can be ruled out of a tree by it, not even one
      the previous table read outside it, whose pid a descendant may have
      reused in between. macOS reads no pid unreadable; on Linux it is a
      stat that fails other than by the process's exit, or does not parse.
    - **The window** sums the intervals that end in it, one straddling its
      start whole, and counts the CPU of a process first seen that started
      inside it; each over-count can only make a window `active`. An interval
      is unknown when either sample is, when it is longer than three
      intervals, when the wall clock moved more than an interval further than
      the monotonic one, or when a member's counter went back. `stalled` is
      decided only at a sample; a stream event or the watch's end turns a
      verdict `active` or `unknown`, never `stalled`.
    - **The sampler** is one per run, ticking every 10 s whatever a read
      takes. The wait's facts: `pending_tasks` is the length of the last
      `background_tasks_changed`; `tool_running` holds while a main-thread
      tool's heartbeats arrive (a heartbeat whose `parent_tool_use_id` is a
      tool a main-thread message asked for; a subagent's tool is the
      subagent's), until its result or 75 s after its last
      heartbeat; `answer_owed` is set by the prompt, a main-thread tool result
      or a task notification, and cleared by the model's main-thread message
      or a result. Every observation judges again, so a stall ended by
      activity is recorded at the activity.
    - **The watch** ends at a close on a finished report (when it fires, not
      when it is armed), at an abort and at the worker's exit (before its
      output closes); an idle close of stdin keeps it. At its end the
      detector closes with a final verdict and its summary. A sample or a
      detector that throws is an unknown sample (`probe-error`); a callback
      that throws is the driver's.
    - **The records.** Each verdict change is a `steps.jsonl` line `{event:
      'stall', seq, lane, at, mode, verdict, quiet_ms, window_cpu_ms,
      unknown_ms, pending_tasks, tool_running, answer_owed, why}`, then a
      `stall` event with the same values but `why`. The line is written
      whole or not at all: a write cut short is taken back (the file
      truncated to its size before it), so the step's `finished` line never
      joins a torn one. The event's fields are the wait's three facts and
      the window's unknown time (Decision 4 item 8's table); `run-started`'s
      `detector` is the run's mode. The `started` line has
      `stall_detector`, the `finished` line `stall: {mode, summary, last}`
      (also on a lane's finished line written as the run stops on an
      error), where the summary is `longest_quiet_ms`,
      `lowest_window_cpu_ms`, `unknown_ms`, `verdict_counts`,
      `answer_owed_max_ms`, `stalled_waits` (up to 20, each `at` and the
      wait) and `stalled_waits_truncated`. A line that cannot be appended is
      counted in `run.json` (`stall_record_failures`, written at once), an
      event the writer refuses as any; neither changes the step. A `stall`
      event waits on no other writer of the event file: written from inside
      the running step, on the event loop every lane shares, it takes the
      lock when it is free and is refused otherwise
      (`STALL_LOCK_WAIT_MS`), the step's line its record. `readRun` lists a
      step's lines in `stalls`, never merging them into the step; the
      dead-run cleanup passes them over. `status` prints the mode, the step
      clock and each step's summary.
    - **Modes.** `--stall-detector log` is the default; `on` aborts a
      `stalled` step with abort reason `stalled`, which the policy halts
      `worker-failed` with the detail naming the quiet time, the window's
      CPU and the wait, charged as a timeout is and scoped by Decision 1;
      with `on` and no
      `--step-timeout` the step clock is 28800 s, and an explicit one wins
      whatever the order. A reader older than this release holds a line to
      its own allow-lists, so it skips as `reader-skipped` a `stall` line
      with the new fields and a `run-started` naming `log` or `on` (it finds
      that run's `run.json` from its open-run record or the checkouts
      instead): re-arm a watch after installing, before the next launch.
      After a rollback the old reader reads this release's lines the same
      way; a cursor naming one of them is no line it delivers, so its arm
      ends with a `reader-error`, and the watch is re-armed from
      `<run-id>:0`.

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
   schema change, and the reader takes a line only with exactly its kind's
   fields (item 8). *Amended 2026-10-28 (impl-events): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-28--impl-events-decision-4).* A step is
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

8. **How it is written and read.** *Amended 2026-10-28 (impl-events): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-28--impl-events-decision-4).*
   - **The writer's lock** is a file beside the event file (`<file>.lock`)
     holding its writer's pid and a token, written to a file of its own and
     linked into place (which fails when a lock is there), so it appears
     whole or not at all and no live writer's lock is ever read empty. It is
     taken for one read and one append and waited for up to 2 s on a
     clock that moves (never the run's event clock), the bound checked on
     every retry, whatever sent it round. A dead writer's lock, or one that
     does not read and is
     older than 2 s, is taken over, removed only while it still holds what
     was judged (one that cannot be removed, its directory not writable, is
     waited on to the bound, then the write fails and is counted); a live
     writer's never is, however old (a writer suspended holding it still
     holds it), and a writer removes
     only a lock holding its own token. The writer is synchronous, so a
     process's lines are in the order of its calls. The next `seq` is one
     above the
     highest its writer chose, its write landed or not, and above every
     parseable line of its run on file, a last line with no newline that
     holds complete JSON included; a write refused at the lock chose none.
     `run-ended` is appended only when the
     file holds none of the run, and `lane-released` only when no line holds
     its release id, each counted only when it is a line a reader delivers,
     so a forged line suppresses nothing. A writer that finds one appends
     nothing for it but ends a torn last line, so a reader holding that line
     delivers it. A writer closes at its run's `run-ended`, written, refused
     or failed.
   - **The run's end.** The driver writes `run-ended` last: after its last
     handoffs once its locks are gone (Decision 2, item 4), whose
     `lane-held` is the run's, and after its final output, but
     before its open-run record goes. Its output never fails the run (a
     write error from a reader gone or a closed terminal is kept on its
     stream, never thrown, and drops the line), so the driver neither dies
     short of its `run-ended` nor exits with another code than the one that
     line records; only an embedding caller's printer that throws can still
     end the run `error`, exit 1, before the line. A
     run that ends before writing that record (a halt or an error at its
     start, after it joined the file) keeps its locks until its
     `run-ended` is written, so a lock entry names its live driver until
     then. A lock entry that cannot be removed never stops that line: it is
     printed (on the error path, passed over for the run's own error), and
     names a driver judged gone once it exits. Its signal handlers stay
     until after the line, so a signal while the end is notified (a closed
     terminal) interrupts nothing. Once the line is written nothing changes
     the run's outcome: what is left (a lock entry, the open-run record) is
     removed under a guard, and a warning that cannot be printed is dropped.
     Between the release of its locks and the removal of its record, a
     run that ends cleanly is still running (its last handoffs, its
     notification, its `run-ended`): `stop` and `status` take a record whose
     own process is still its driver (its pid and fingerprint) for a run
     ending, never one to clean up after, so `stop` waits for it within its
     bound, whether it signalled the run or found it past its locks already,
     and `status` shows no cleanup pending. No call
     throws: a failure is returned and counted.
   - **The fields.** Each kind's own, against an allow-list; any other field,
     a value outside its set, or text is refused and counted as a failed
     write. Ids are checked by alphabet (run, macro, subtask; a hold's and a
     release's 16 hex; a commit's 40 or 64 hex). A path field (`run_dir`,
     `pointer`, `step_record`) names only a record the driver writes, under a
     checkout's `.agentic-plugins/runs/autopilot/` (a run's directory
     `<run-id>`, `run_dir` only; one of its records, `<run-id>/` and
     `run.json`, `halt.json`, `steps.jsonl`, `lanes.jsonl` or
     `landing.jsonl`; the macro's landing log `landing/<macro-id>.jsonl`; a
     lane's kept park `holds/<macro-id>/parks/<subtask-id>.json`), the
     checkout absolute,
     normalized, with no control, format (a bidi override) or
     line-separator character.

     | Kind | Fields |
     |---|---|
     | `run-started` | `lanes`, `detector` (`log` or `on`; `off` is still read, from runs before Decision 3 shipped), `run_dir`, `pointer` (run.json) |
     | `halt` | `reason`, `step` (or null), `pointer` (run.json), `step_record` (steps.jsonl, or null) |
     | `lane-parked` | `reason`, `step` (or null), `kept`, `pointer` (the kept park, or lanes.jsonl when the records could not take it) |
     | `lane-resumed` | `cause` (`record-changed`, `release`, `hold-ended`, `forced`), `pointer` (lanes.jsonl) |
     | `lane-held` | `hold_id`, `pointer` (lanes.jsonl) |
     | `lane-released` | `hold_id`, `release_id`, `verdict` (`consumed`, `rejected`), `pointer` (lanes.jsonl) |
     | `step-failed` | `step`, `reason` (a halt code, or `error`), `abort` (the worker's kind, or null), `pointer` (steps.jsonl) |
     | `commit-finished` | `step`, `commit`, `readiness` (`ready`, `needs-sync`, `unknown`), `pointer` (this run's landing.jsonl when the report appended the line, else the macro's landing log) |
     | `stall` | `step`, `verdict`, `mode`, `quiet_ms`, `window_cpu_ms` (null when unknown), `unknown_ms`, `pending_tasks`, `tool_running`, `answer_owed`, `pointer` |
     | `instruction` | Decision 7's: `action` (`applied`, `dropped`), `application_id`, counts, `step_set`, `pointer` (lanes.jsonl or steps.jsonl) |
     | `run-ended` | `status` (`completed`, `halted`, `error`), `reason` (or null), `exit`, `pointer` (halt.json for a run that halted, else run.json), `cleanup`, `terminal: true` |

     Each path that resumes a lane names its cause itself, never read from
     the `lanes.jsonl` wording: `hold-ended` is a lane a relaunch passed by
     whose hold ended with no release (a pending hold withdrawn, a hold
     retired or orphaned); one given back by its consumed release
     is `release`.
   - **Where each is published.** `run.json` records `events: {path,
     failed_writes}` right after the locks, before `run-started`, which
     tells a run that took part from a launch refused at its locks. The
     driver holds it in memory only once that write succeeded, so a failed
     write leaves the run out of the event file in every later record; the
     driver then prints the path and the watch command. A serial run
     publishes `step-failed` beside a step's `finished` line and for a step
     in flight when it stops on an error; `commit-finished` once the first
     landing report after a commit step that passed holds the subtask's
     commit (a report that could not be recorded proves nothing, and the
     commit waits for the next); its `halt` once `halt.json` and `run.json`
     record it, before its output; its `run-ended` as **The run's end**
     says. A run that stops on an error after its halt was recorded
     publishes that halt if a record write threw before its publication,
     and its `run-ended` (`error`) points at `run.json`. A run with lanes
     publishes a `halt` at each drain, once `run.json` records the run
     draining, and the halt that ends it (an idle end, a refusal, an
     interrupt no drain published) from the driver's finish, once
     `run.json` and `halt.json` record it, never before the end's handoffs,
     removals and park changes (a record write of finish that throws first
     leaves it to the error path, which publishes it once `run.json` holds
     it, then the `run-ended` `error`); each once by what it says (the
     owner's interrupt once, any other once per reason and lane);
     `lane-parked`, `lane-resumed` and `lane-held` beside their
     `lanes.jsonl` lines; `lane-released` at the comparison, and at the
     recovery of a consumption whose park's end failed after it was
     recorded, or of a rejection, once per release id, after the run
     records the recovery in its own `lanes.jsonl` (`recovered: true`);
     `step-failed` beside a lane's `finished` line, and for each step in
     flight, or being settled (its worker ended, its `finished` line not
     written), when the run stops on an error; `commit-finished` as a
     serial run does, from a later look's report when the lane's own did
     not fetch. A commit step that failed publishes `step-failed` only.
   - **A dead run's cleanup** appends the `run-ended` (`cleanup: true`) of a
     run whose `run.json` has `events`, after it writes that `run.json`,
     with the status and reason it holds
     then: a run that recorded its end and died before its line keeps that
     end; only a run still running or draining becomes halted
     `interrupted`. The line points at `halt.json` only when `halt.json`
     holds that halt (the driver's own, or one the cleanup wrote); a
     `halt.json` a driver wrote before it died recording the end is another
     halt, so the line points at `run.json`. The file is the macro's, or the
     record's checkout's for a verb chain. A failed write is counted in that
     `run.json`.
   - **The reader** polls every 500 ms and holds each line to the writer's
     allow-lists again (this schema, an identity, a known kind, the writer's
     `at`, macro and subtask ids, exactly its kind's fields with values in
     their sets, and `terminal: true` on a terminal kind only); a line that fails is a `reader-skipped` with its
     offset alone, never printed, folded, taken for a run's end or found as
     a cursor. A path field is printed only when its checkout is one of the
     repository's (`git worktree list`, compared by real path, listed again
     for a directory not among them, so a relaunch from a worktree added
     since the arm is found), else null (a directory named by text, or a
     checkout removed since): the line is still the event it is, for its
     cursor and its run's end, as whether a line is an event never depends
     on the checkouts there are now. A follow whose stdout fails (Monitor
     stopped, a pipe's reader gone) stops, the printer dropping every line
     after it. While the file is idle, each poll also writes no bytes to a
     stdout that is a pipe or a socket: where the system checks the reader
     first (macOS) that write fails once the reader is gone, and the follow
     stops then (Linux: **Limits**). `<run-id>:0`
     starts at the run's first line on file or the first whose `at` is at or
     after the run id's stamp, whichever comes first; with several cursors
     it starts at the earliest. A file that shrinks or is replaced by
     another while followed is a
     `reader-error`. A `reader-terminal-missing` repeats a `run.json`
     `status` only from the driver's set. A run is missing its terminal
     event when its `run.json` has `events`, a fresh read holds no
     `run-ended` of it on a complete line (a line still waiting for its
     newline does not count, whatever it holds: delivery holds it, so the
     run is reported until the newline comes; a read that fails, but for a
     file not there, tells nothing), no open-run record or lock entry names
     a live driver (a run holds its locks before it writes its record, and
     one that ends before writing it holds them until its `run-ended` is on
     file), and no live process holds its cleanup lock. Its `run.json` is
     found from its `run-started` line's `run_dir`, its open-run record, or
     the checkouts `git worktree list` names (`--checkout`: that checkout).
     A verb-chain run's startup cleans no dead runs, so a dead verb-chain
     run is reported until a cleanup writes its end. The runs
     watched are the cursors' and every run with a line on file and no
     `run-ended` there, before the cursor too, until their `run-ended`: a
     re-arm from any one line's cursor keeps every run still owed its end
     that has a line on file, and a run whose end write failed while no
     reader watched is reported at each arm until its end is on file (a
     session drops one already handled by its `run_id`). `reader-armed`
     names the latest run by its id's stamp, of those on file and those the
     cursors name. A gap among folded `stall` lines is still a `reader-gap`
     line. The stall budget is 20 per delivery window (the
     backlog, or one poll's lines); a line passed on between bursts flushes
     the summary and does not reset it.
   - **Limits.** A commit step's `commit-finished` waits for a report that
     holds its commit, so a run that ends first publishes none (the landing
     log keeps the observation). Taking over a dead writer's lock is a check,
     then a removal: two writers
     that judge the same dead lock at once could both go on and choose one
     `seq`. A lock is left only when its writer died within the few
     milliseconds it holds it, and the writers are one run's driver and a
     dead run's cleanup, so this is documented, not guarded. A run with
     no line on file (every write it made failed) is watched only while a
     cursor names it: an arm whose cursors name it reports it once its
     driver is gone, and a re-arm from another run's line does not see it.
     On Linux, which takes a write of no bytes as done, an
     idle `--follow` whose pipe reader is gone (`… --follow | head -1`) runs
     until the file's next line, which, for a macro whose runs have all
     ended, may be the next launch: end it yourself.

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

   What a worker asks for depends on the step that follows: an intermediate
   request (item 2) names the test files the change touches, no whole suite
   and no broad mutation set, and mutation cases only for gate or fail-closed
   code, at most 6 (item 2); a final request names the suite (item 4). The
   runbooks' § Long checks and the verify form say so. *Amended 2026-11-10 (C178,
   verification policy): [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-10--verification-policy-c178).*
   The persona runbooks say so (engineer, the one persona that renders the
   verify form): a quick check is a few test files the change touches, a long
   one the whole suite, a broad `npm test`, a test file known to run long or
   any mutation run. Under an offering run a step runs only the quick ones,
   hands the long ones over with the verify form and never waits for the
   heavy-work lock, telling from Phase 0's preflight banner whether the run
   offers verification; without the offer, as before; interactively, a long
   check runs under `agentic-autopilot heavy --` (a command that locks itself,
   or one with no orchestrator installed, directly). The worker's appended
   rules say the same. The runbooks' autopilot mode says that `verify` is a
   request-mediated handoff, not a proposal kind (the closed-enum table is
   unchanged), that `on_pass` is the step after it, and that the repeat rule
   is the driver's (`no-progress`, the owner's `--next verify`). *Amended 2026-10-31 (verify-runbooks): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-31--verify-runbooks-decision-5-item-1-the-runbooks).*

2. **The request** is machine data, written with the verb's last write
   through the persona's CLI. It names an ordered list of checks, each a
   *kind* from the repository's declaration (item 3) with arguments that are
   data (test file paths, mutation spec paths, case ids), each checked
   against the tested tree or its alphabet; the step that follows a batch
   that passed (`on_pass`, a next step as today); and a confidence, to which
   ADR-0063 D4's rules apply: below `HIGH` it halts `low-confidence` before
   anything runs. No argument is a shell word, and no text a peer, a person
   or the model wrote becomes one: a check never runs peer or user text. An
   argument that is not a path in the tree, is not in its alphabet or begins
   with `-` is refused at the write. *Amended 2026-10-20 (left to the
   implementation, slice 3): [history](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation-slice-3).*

   A request whose `on_pass` is a verb is *intermediate*, one whose `on_pass`
   is `commit` or `done` *final*, read from the kind the request already
   holds. One batch runs at most 6 mutation case ids over all its checks
   (`MAX_BATCH_MUTATE_CASES`, the values of every `id` slot), a cost ceiling
   distinct from the six case ids one `mutate` check names at most, which
   sizes that check's timeout (AGENTS.md); the persona refuses a request over
   it before any write, and the driver a batch over it, its own additions
   counted, before anything runs. An older persona under this driver has no
   request-time cap: the driver's refusal of the batch is what it meets.
   *Amended 2026-11-10 (C178): [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-10--verification-policy-c178).*

   **The owner's forced step below `HIGH`.** The owner's forced `verify`
   step authorizes running that request's checks and resuming its requesting
   verb. The authorization is bound to the workflow, to the request id, and
   to the batches the driver's own verification journal started for it
   (driver metadata, never the persona's record, which a worker can write): a
   batch the forced step starts, restarts or continues is marked forced, and
   a later look below `HIGH` takes the resume rule for that request (item 6)
   when the journal's walk back from the last batch it started for the
   request, which the record must name, reaches a forced start through
   continuations of that request and subtask. A restart continues nothing,
   so the walk stops at one unless the owner's own rerun made it. A record
   put back to an earlier batch revives nothing, and a driver that died after
   journalling a start whose persona write never landed fails closed the
   same way: the owner forces the request again. Short of the resume rule,
   such a look goes on as at `HIGH`, to the verification step, which ends an
   open batch, continues one cut short, or answers a pass the driver
   journalled before the record took it; a request below `HIGH` that the
   owner has not forced still halts before anything runs. The authorization ends when the request is
   replaced, answered (its `on_pass` the next step) or set aside (a
   `verify-batch-restart` of a record the journal does not hold whole); a
   replacement request, an instruction's step and another lane never inherit
   it, and `on_pass` keeps its own confidence: after a pass, a `MEDIUM`
   `on_pass` still halts and a `HIGH` one is dispatched. A step below `HIGH` that is not
   the owner's runs nothing unless the authorization covers the record's
   latest batch; it halts `low-confidence`, writing nothing. Every plan such a step makes is held to the
   authorization's end, the plan made after it ends an open batch, when it
   reads the record again, included. A plan that would set the record aside or start a batch
   that continues none halts `low-confidence`, naming the rerun. A forced step
   that yields before its batch starts journals nothing, so a relaunch halts
   again, and a journal written before this rule marks no batch. A worker
   that forges journal lines is outside this model (item 14).
   *Amended 2026-11-03 (C168): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-11-03--c168-the-owners-forced-verification-step-below-high).*

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
   - **An intermediate batch leaves the large tests out.** The driver drops
     from the test files it adds each test the repository declares large
     (`scripts/data/test-tiers.json`, ADR-0033's tiers, read at the
     selection's base, never from the lane's tree, in the form
     `scripts/lib/suite-tiers.mjs` accepts); a list that is missing, does not
     parse or has another form defers nothing. A change only a deferred test
     matches is matched, so it selects no suite; the suite fallback for a
     change nothing matches, or matched only with uncertainty, stays. A large
     test that itself changed is kept, and the worker's own checks are never
     dropped.
   - **A final batch holds the suite once.** When the declaration has a
     `test-suite` kind, a final batch runs it exactly once, the worker's when
     the request names it, else the driver's, in place of the test files the
     driver would have added; a declaration with no such kind gets no final
     suite, and no gate (item 12). *Amended 2026-11-10 (C178): [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-10--verification-policy-c178).*

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
   - a verb that records the same checks (the commands as the declaration
     resolves them, the driver's additions included) again on an unchanged tree, after
     a batch in which one failed, halts its lane `no-progress` at once, and
     nothing runs (item 10). After a batch that passed, the pass is reused
     once: when that batch passed whole (it continued no batch, replayed
     none, and the journal holds a result for each of its checks) with the
     same declaration digest and selection base, the driver records a batch
     for the new request whose results are that batch's, each log a pointer
     to the source's, runs nothing and answers it; a pass that was itself a
     replay is a repeat and halts `no-progress`, and a pass that does not
     qualify runs again whole; a replay a hold or the driver's end cuts short
     is continued by running what is left, keeping the replay's mark, so its
     pass is never replayed in turn. After a batch that ended with no failure
     but a check with no evidence, they run again whole. A flaky test is
     rerun only after a change, or by the owner's explicit rerun, whose form
     is `verify-exec`'s: the owner's forced `--next verify` (with lanes,
     `--lane <lane> --next verify`) reruns a pending request once, one
     recorded again after a pass or a failure that the repeat rule would
     halt, not an answered one, which a verb records again before
     `--next verify` (item 14); *Amended 2026-11-10 (C178, a pass reused once): [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-10--verification-policy-c178).*
     *Amended 2026-10-30 (verify-exec): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-30--verify-exec-decision-5-the-drivers-half).*
   - a verb run in the lane, a person's in a held lane included, replaces the
     request, as its Phase 0 clears any next step, and leaves the old
     results unread. *Amended 2026-10-20 (left to the implementation, slice 3): [history](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation-slice-3).*

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
   *Amended 2026-10-21 (verify-record-cli, the note above): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-21--verify-record-cli-decision-5-item-7).*

8. **How a check runs.** The driver's effect domain grows by one effect,
   amending ADR-0063 D1: it runs a declared check
   - as an argv array built from the declaration and the request's checked
     arguments, never a shell string;
   - in the lane's checkout (in a serial run, the driven checkout), with the
     environment a worker gets, minus `AGENTIC_AUTOPILOT` (the run's
     autopilot flag), its admission token, step, offer and state base, and
     any heavy-lock proof, so that a check cannot act as a worker of the run;
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
   locks are kept while it lives. A check's group is on the run's locks
   before the check starts: a registration that fails kills it with nothing
   run, and a throw while it is supervised kills the group first. *Amended
   2026-10-30 (verify-exec): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-30--verify-exec-decision-5-the-drivers-half).*

   A check runs the lane's own code, its tests and scripts, with the reach a
   worker's shell already has: the permission posture binds a worker's tool
   calls, not the processes a test starts, today as here. The orchestrator
   adapter executes it; runtime's ceiling is unchanged.

   Each check runs with a `TMPDIR` of its own under the run's scratch root
   (item 13). *Amended 2026-11-10 (C175): [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-10--temporary-files-and-run-retention-c175).*

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

12. **The commit gate.** In a run that offers verification over a
    declaration whose `test-suite` kind resolves with no argument, a commit
    needs the suite's evidence: a batch of the workflow that the driver's
    journal ended `passed`, whose checks hold the suite's command, started
    and ended on the lane's tree as it is now, with the run's declaration
    digest and the lane's selection base. The tree digest hashes `HEAD`, so an
    edit, a regeneration, a commit or a rebase since invalidates it. The gate
    holds every route:
    - *the next step `commit`, or `done` over a tree with a change:* without
      evidence the driver resumes the workflow's last verb, with one fixed
      sentence after its command that tells it to end with the verify form,
      the suite named, `on_pass` commit; a second such resume on the same
      tree halts the lane `no-progress`. `done` over a tree with no change
      only closes the workflow and needs none;
    - *the owner's forced `--next /engineer:commit`:* refused, naming the way
      out (force the verb); with lanes it is judged at each decision, on the
      lane's own tree; the check made as the run starts cannot judge it,
      because no lane is held yet;
    - *the recovery of an interrupted commit:* the driver records each commit
      step it admits in the journal with the lane's content without `HEAD`
      and the tree it was admitted on, and takes the commit up again only
      while the content is still that and the suite's evidence still holds
      for that admitted tree, with the run's declaration and the lane's base
      as they are now. Only the moved `HEAD` is let by: a tree that cannot be
      digested now, another declaration or another base is no recovery. It is
      also taken up when the evidence holds for the tree as it is
      now, as a commit admitted anew, and when the lane holds no change at all (the commit command then
      only closes the workflow, a `done` over a clean tree or a commit made
      whose archive did not run, and commits nothing). The owner's forced commit of a commit begun
      follows the same three. A recovery taken up without evidence for the
      tree as it is writes no new journal line: the first admission's stands,
      so a second interruption is judged as the first. Otherwise the lane halts
      `owner-choice`, a judgment halt the owner's forced verb replaces;
    - *at the admission, with lanes:* the tree is digested again there, and
      a commit decided on another tree is not started: the run decides again;
      a recovery is compared by its admitted content; a tree that cannot be
      read parks the lane `owner-choice`.

    The gate's facts and records are the driver's, never the persona's
    record. A journal, a tree or a base that cannot be read is no evidence. A
    run with lanes reads the lane's status, content and base off its loop, and
    a read that fails there fails closed. Limits: the guarantee covers
    tracked and non-ignored files (a dependency reinstalled between the suite
    and the commit is not noticed); an edit after the gate's last digest and
    before `/engineer:commit` stages is not seen (the P7 guard has the same
    window); a workflow whose commit
    began under an older driver halts `owner-choice` at its recovery; new
    runbooks under an older driver keep the old repeat rule (a repeated pass
    halts `no-progress`), and no gate asks
    for the suite; `autopilot preview` does not judge the gate (it shows the
    commit, and the run decides); the resumed
    verb, usually a critique, counts as a critique round of ADR-0063's cap.
    *Amended 2026-11-10 (C178, the commit gate): [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-10--verification-policy-c178).*

13. **Temporary files and run retention.** A runbook's directories are
    bounded by where they are made, the step's or the check's `TMPDIR`
    below. In a package whose runbooks have switched (ADR-0059 Decisions 9
    and 10: today the persona plugins, designer, engineer and founder), a
    block also releases each directory through the CLI's proof once no
    reader of it is left, and the bound holds what a release keeps (a
    refusal, a rerun, a pause); in a package that has not (today the
    orchestrator), no block deletes them. *Amended 2026-11-10 (C175): [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-10--temporary-files-and-run-retention-c175).*
    *Amended 2026-11-27 (the persona runbooks release their directories): [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-27--the-persona-runbooks-release-their-directories).*
    - **A TMPDIR per step and per check.** A run owns one root,
      `<base>/agentic-ap/<run>/` (the run id without its `autopilot-`
      prefix), made exclusively (mode 0700) before the run directory, with a
      marker (`.scratch.json`) naming the run, the repository's toplevel and its common git
      directory. A worker step runs with `TMPDIR=<root>/s<seq>` (its `started`
      line records `tmp_dir`), a check with `TMPDIR=<root>/v<seq>-<index>`,
      each made just before its spawn; the names are short for socket paths.
      `<base>` is the driver's own `TMPDIR`, then `/tmp`: the first that
      resolves, lies outside every worktree of the repository and holds no
      character XML escapes (a peer's prompt names paths under it). With none, or a root that cannot be made, the run
      does not start; a step directory that cannot be made fails as a spawn
      that throws, a check's is `not-started`. There is no degraded mode: no step or check runs with the
      driver's own TMPDIR. A reused pass (item 7) starts no process and makes
      no directory.
    - **Removal, and what defers it.** A step's directory is released once
      its peers are settled (after the cancellations and settlements of
      ADR-0063 D5, not at the worker's exit), a check's when the check ends,
      whatever its outcome; removal runs in the background, one directory at a time, never inside a
      step's critical section, and its failure is counted in `run.json`
      (`scratch.failures`), never an outcome. A step
      directory under which any directory's name holds `-peer-snapshot-`
      stays whole (a surviving peer uses more of it than its snapshot) unless each snapshot's
      run is proven over (no age counts) and the snapshot removed with its
      registration; no owner record, a run alive or unknown, and a removal
      refused or failed each keep it. A step whose group outlived SIGKILL, whose peers the run
      could not account for (`peers_unaccounted`), or a check whose group outlived SIGKILL, keeps
      its directory, held by the run, which keeps its locks or its open-run
      record for the same reason. At its end the run waits for the removals in flight,
      makes one pass over its root, removes the root when nothing is left (the marker last,
      the directory without recursion)
      and `agentic-ap` when empty (`rmdir`, which removes nothing else); `run.json` `scratch` records what stays and
      why, and `removed_at`. A run that ended on an error sweeps nothing: its
      steps in flight are unknown.
    - **The guard.** Nothing is removed that is not proven the run's: the
      paths alone judged first (an absolute, normalized root named for its run under `agentic-ap`,
      or its direct child `s<n>`, `v<n>-<i>` or `.removing-<name>`), then the
      file system (the root a real directory whose real path is itself, so no
      link lies on the way, its
      marker naming this run and this repository's common git directory, the child a real directory, not a link). A
      directory is renamed `.removing-<name>` before its contents go, so an
      interrupted removal is finished by the next pass without judging a
      half-removed snapshot again.
    - **What a run left.** Each root has an index entry under
      `<main>/.agentic-plugins/runs/autopilot/scratch/<run-id>.json` (the
      root, the repository, the driver's pid and fingerprint), written before the
      root is made and removed only when it is gone, so a root is found from
      any checkout and a crash strands none (an entry with no root is
      dropped; an empty root with no marker is removed with `rmdir`). A
      run's start, after the dead-run cleanup of ADR-0067 Decision 6 and before its own open-run record, sweeps every entry
      whose run holds no open-run record and whose driver is gone (the record
      read again once the driver is known gone, never from an earlier
      listing), by the same pass and the same guard, which proves a directory before anything
      under it is scanned; never its own entry, never a root while its run's
      record stays (a dead run's cleanup removes the record only once its
      worker groups are empty and its peers cancelled). The
      sweep never halts a run. SIGTERM ends a run through its normal end; a
      driver that dies leaves its root to this sweep; the driver's exit handler removes nothing.
    - **Run retention**, the orchestrator's (not a `runtime:retention`
      family). Only a run's bulk is trimmed, its `worker-<seq>.jsonl` streams and its
      `verify/` directory; `run.json`, `steps.jsonl`, `halt.json`,
      `landing.jsonl` and `lanes.jsonl` always stay, so every reader of a run
      (`status`, a hold's handoff, the event reader, a halt's resume, the
      pairing of a request with its step) reads it as before; `run.json`
      `retention` records the trim. A run is eligible once
      ended (completed, halted, error), not among the checkout's newest 20 ended runs, and ended more
      than 14 days ago; never one with an open-run record, a cleanup lock or a
      scratch index entry, one running or draining, or one whose `run.json`
      does not read. A run cited (its run id named) by an active engineer workflow of any state
      home of the repository's checkouts, one archived within 14 days, or a verification journal of an
      active workflow or written within 14 days, is kept whole, whatever its
      age; the citation
      read is by text, errs toward keeping and comes before any file of the
      run is chosen, and a source that does not read keeps every
      run past the floors whole. One retention runs at a time (`retention.lock`
      beside the open-run records), judging each run
      again under its lock just before its files go and renaming each file `.removing-<name>` first; a
      stream or a `verify/` a crash left renamed is finished by the next pass,
      whatever cites the run by then, a citation read that fails included. It
      runs at each run's start, after the sweep, a failure a warning, and as `agentic-autopilot
      retention` (what would go, changing nothing) and `retention --execute`, which a worker of a run is
      refused.
    - **What it replaces on the owner's machine.** Once the release carrying
      this is installed, the interim `agentic-run` wrapper and the
      `agentic-tmp-clean` cron job on that machine are the owner's to remove.
    - **Limits.** A snapshot-named directory with no readable owner record
      keeps its step directory until the owner removes it (`run.json` and
      `retention` name it; no age bound, so nothing is removed under a peer
      that may still run); a process a check
      started in a group of its own its teardown did not reach loses its directory; a
      step's TMPDIR is about 40 bytes longer than the driver's (start the
      driver with a shorter `TMPDIR` where a socket path runs past the limit);
      on a shared `/tmp` with no `TMPDIR`, a second user's run finds
      `agentic-ap` owned by another while a run of that user has its root
      there, and does not start (set `TMPDIR`); the driver's own
      temporary files are outside this, each removing its own; a verb chain's run that ended on an
      error keeps its open-run record and its root until `stop`; a finalize replayed in a later step
      finds the step's text and dispatch directories gone, and takes the
      run's ledger directory as `DISPATCH_DIR` and a fresh text directory, as
      the runbooks say for a directory that is gone; a step cut short between
      its first and last write leaves its persona operation open, its
      operation directory gone, for the owner's `writer-clear`;
      citations are read once per pass (a workflow that first names an old,
      uncited run while a pass trims it is not seen by that pass); a state
      home behind a dangling link reads as absent and cites nothing.

14. **How the driver runs it.** *Amended 2026-10-30 (verify-exec): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-30--verify-exec-decision-5-the-drivers-half).*
    - **The offer** is made once at the run's start, never a refusal: the
      pinned engineer carries the verification capabilities (`verify-record-1`
      and `verify-batch-restart`) and the
      declaration parses at `run.json` `git_baseline.head`, read with no
      replace objects and no inherited `GIT_*` variable. `run.json` records
      the offer (the baseline and the declaration's digest), or why not; each worker of an offering run gets
      `AGENTIC_AUTOPILOT_VERIFY` (the baseline) and a rule saying so. The driver's parser of
      the declaration is held to the persona's by a parity corpus.
    - **The journal.** Every persona write the driver makes for verification
      (start, restart, result, end, pass) is first a synced line of a journal
      per engineer workflow under the main checkout's orchestrator state
      (`verify-journal/<workflow_id>.jsonl`, so a run in any checkout reads an
      earlier run's after its open-run record is gone), with
      the write's exact payload; a line a write that died left torn is taken
      back, to its start, before the next is appended. A start keeps the
      requesting verb, the selection base and the checks' digest beside it. A stored batch, result, end or answer is
      trusted only when a journal line holds that payload (canonical JSON) for that request and batch,
      and a carried result only when it is a pass a line holds for the batch
      and run it names, carried into a batch that continues that one through
      the journal's starts with no restart between, every hop on the
      destination's tree and with its checks' digest; anything else sets the request's whole record aside in
      one `verify-batch-restart` over its `results_digest`. An intent the record lacks is a write that may not have landed: it is written again,
      or, for a result, its check run again. A request runs only when its run and step are a
      `started` line of that run's ledger for the subtask, in the driver's
      checkout, the main one or, failing both, any checkout `git worktree
      list` names (a run launched from a linked checkout keeps its ledger
      there); a request no run's
      step wrote halts the lane. The driver's persona writes run with no
      `AGENTIC_AUTOPILOT*` variable and no state base: they are an owner's writes to the
      attempt mark. The journal tells the driver's writes from a record edited
      alone, not from a forger who edits both: it lives in state a worker's
      process can write, so matching edits to the record and the journal
      forge a pass the driver takes (a documented limit).
    - **What a step does,** on the record, the journal and the lane's tree
      digest now:

      | The request's latest batch | The step |
      |---|---|
      | none, and the workflow's last batch the journal ended failed has these checks (the driver's additions included) and this tree | halt the lane `no-progress`, nothing runs (`--next verify` runs it once) |
      | none, and such a batch (these checks, this tree) passed whole and qualifies under item 7 (it continued no batch, replayed none, holds a result for each check, same declaration digest and selection base) | a replayed batch: its results are that batch's, nothing runs, the request is answered |
      | none, and such a batch passed but its pass was itself a replay (a replay's continuation, which keeps its mark, included) | halt the lane `no-progress`, nothing runs |
      | none, and such a batch passed, was no replay, but does not qualify (it continued a batch, or lacks a result) | a batch: the checks run again whole |
      | none otherwise | a batch |
      | open (a driver died) | end it from its trusted results: the last failed, `failed`; a timeout, `no-evidence` cause `timeout`; not started or refused, `no-evidence`; all passed, `passed`; none yet, or a check stopped, `cut-short` `driver-end`; another tree `tree-changed`, an unreadable one `tree-unreadable`; then judge again |
      | `cut-short` | a batch that continues it (the persona carries the passed results when the tree and the commands are the same) |
      | `passed`, on the tree it started on | `verify-pass`: `on_pass` is the next step |
      | `passed` on another tree, `failed`, `no-evidence` | a `resume` line of the journal (no persona write), from which the policy dispatches the requesting verb |

      The table is judged before any new batch is prepared, so a batch to end
      or follow never waits on a selection or a declaration that would refuse
      a new one. The policy takes
      from the journal what it cannot compute, and never judges the record
      itself: a pending request whose latest
      batch, as the record names it, has a `resume` line yields the requesting verb, only while the record
      is the one that line was decided on (the line keeps the digest of the
      request and its results, which the child's summary carries); the step
      writes the line only after the whole record passed the trust check, and
      a record edited since is the next step's to set aside. An answered request whose next
      step is still its `on_pass` yields the requesting verb instead when the
      lane's tree changed since the pass or the journal holds no such pass
      or cannot be read, until the next worker's first write clears the next
      step, and never over
      the recovery of a commit its `on_pass` began (that commit kept the
      answer and changed the tree; `/engineer:commit` recovers it); these facts are read
      whether or not the run offers verification. A verification step that changes nothing
      twice on one request halts its lane `no-progress`.
      *Amended 2026-11-10 (C178, a pass reused once): [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-10--verification-policy-c178).*
    - **A batch.** The checks are the request's, each resolved again against
      the run's declaration and the lane's tree, and the driver's additions
      against the lane's merge base with the integration branch (`git
      merge-base HEAD refs/remotes/origin/<integration>`, the local branch
      when there is no remote one, the run's baseline when neither reads), placed
      before the worker's first check whose kind takes the heavy-work lock itself,
      else last. Over the persona's worst-case results size the driver's `test`
      additions widen to `test-suite`; still over, or a check that does not
      resolve, the lane halts `owner-choice` with nothing written or run. Each
      check runs under an idle supervisor leading a new process group in the lane's
      checkout, put on the run's locks as a worker group of its lane (the
      macro lock and the lane's or driven checkout's) before
      the supervisor's go; a registration that fails kills it with nothing
      run, a hold, a drain or the driver's signal that came meanwhile stops it
      before the go, and a throw while it is supervised kills the group first.
      The supervisor runs the wrapper (with a status file and a go file), or
      the command itself when it takes the lock itself. Through the wrapper, the command starts only once the
      driver, having read the holds and the drain again and registered the
      command's group, writes its go, so a hold or a drain while the check
      waits for the lock, its acquisition included, stops it with nothing run;
      a ready line the status file does not take is no go: the wrapper kills
      its idle command group and refuses (125). Its timeout runs from
      that go (from the supervisor's go for a command that locks itself), and
      the whole wait for it, the lock's and the ready line's, is bounded at 8
      hours and ended by a hold or a drain. A stop is SIGTERM to
      the wrapper's group, which the wrapper passes to its command's, and
      SIGKILL to both after 5 s; either group, or a supervisor that does not
      exit, still there 5 s later is no
      result, and the run halts run-wide with its locks kept, the group's id
      carried on the error when the supervision itself threw. Outcomes: exit 0
      passed, any other code or a signal failed, an error not-started, a
      refusal refused, a stop stopped, a bound timeout (cause `bound`). The failing tests are
      the log's TAP `not ok` and spec `✖` lines (the log at
      `runs/autopilot/<run>/verify/<batch>/<index>.log`), at most 20 of 200
      characters, never cut inside a surrogate pair. A
      hold, a drain (with lanes, an exhausted budget too) or the driver's end is read before each check and before
      the batch's start or restart: one that came while the batch was
      prepared (the persona read, the tree digest, the selection) starts none,
      and the step yields (`stopped`, its cause) with nothing more written,
      the request waiting. A start the persona refuses is read again the same
      way, and a persona refusal for a held lane is
      a hold whatever the driver read by then, withdrawn or released since or
      not. The cause rides on the step's result, so its settle parks nothing
      whether or not the hold is still set by then; a yield the driver's own
      read saw is the owner's hold (or a drain), however often holds come and
      go. A yield only the persona's refusal
      explains, with no hold, drain or spent budget the run reads at the
      settle either, is decided again, and with lanes a second in a row on the same request
      parks the lane `no-progress`, each lane keeping its own last step that
      changed nothing (a serial run, which honours no hold, halts
      `owner-choice` on the first: a batch is no step of `--max-steps`, so
      nothing else would bound it). Only the driver's signal stops a running
      check.
    - **In the run.** A batch takes a seq and two `steps.jsonl` lines (kind
      `verify`, cost 0), no reservation, no worker step (no `run.steps`, no
      `accounted_seqs`) and no event; an
      exhausted budget starts none, and the request stays for the relaunch. With lanes, batches queue by the
      request's `recorded_at`, one at a time outside the worker cap, each
      admitted to its lane as a worker step is (a lane the run does not hold
      is made for it, a persona operation open in it holds it back, Decision
      1, item 6, an owner's rebinding due is told before it, Decision 8, item
      4, and the plan's approval and the lane's checkout are read), but the throttle of new
      workers does not hold it back and it does not make its lane one the run
      started: the lane's first worker of the run is still a new lane's,
      which the throttle gates; it writes no in-flight marker (a run that dies during it
      leaves the batch open, which the next run's step ends from the
      journal, where a marker would park the lane); its lane is left out of
      the decision while its batch is open,
      and the owner's interrupt is judged before what the batch returned and
      after the run's look at the lane, as a worker step's is, so a Ctrl-C
      that fails the batch's persona write, or comes during that look, drains
      the run and parks no lane (Decision 1, item 1). A hold's handoff waits
      for it, a queued request does not; the run does not end before it; its
      tree digests and selection run off the loop. `status` shows each
      batch's end and how many checks ran, and
      `run.json` `verifying` shows a lane verifying, or waiting for the lock
      with its holder.
    - **Limits.** A request whose run was launched from a linked checkout
      removed since is unknown, its ledger gone with it, and halts the lane. `stop` stops a batch as the
      driver's signal does, recorded cut short by
      `driver-end`, not `stop`. A tree digest that cannot be read before a batch halts the
      lane rather than binding a batch to it. The owner's rerun reruns a
      pending request (one the repeat rule would halt), not an answered one:
      once `verify-pass` made `on_pass` the next step, the persona's batch
      writes refuse the request,
      which a verb records again before `--next verify`. A worker that orders
      its own mutation run before its tests keeps that order (the persona
      refuses a batch whose worker checks are reordered). Preview tells the
      policy the offer a start would make, not the journal's facts.

15. **The runbooks' half.** *Amended 2026-10-31 (verify-runbooks): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-31--verify-runbooks-decision-5-item-1-the-runbooks).*
    - A finalize checks a request before its first write with the last
      write's own checks (`state.mjs verify-request-check`, one function for
      both: the offer, the newer-record refusal, the workflow's state, the
      tested tree, each check against the declaration at the offer's commit,
      and the record a new request becomes, held to its size cap and to the
      stored record's own reader), so a request `finish-verb` would refuse stops the block with
      nothing written, with the write's message. It counts every pending peer
      run but the one the finalize settles first (`--settling-run-id`). A
      refusal by the write itself after the check passed (a change between
      the two, the attempt mark) is the window every multi-write block has. A request entry the check cannot read (a dangling
      link) refuses rather than reading as the verb form.
    - **The verify form.** A `verify-request.json` in the finalize's text
      directory selects it; a conflict verdict and any owner gate take none
      (the driver would run `on_pass` past the judgment),
      and the block refuses a request beside `OWNER_GATE`, the variable the
      step sets to the gate it ends on (decide's owner selection or veto
      records `decide-conflict` under its ordinary synthesis heading, so only
      the variable names it). Its sha256 is kept beside `finalize-run.json`
      (`finalize-verify.json`, null for the verb form) just
      before settle, once every other check has passed (a run they stop keeps
      none, so the same text directory may then add a request), so a rerun
      after a write takes the same form and the same request, and stops before any
      write when the file was added, removed or changed since; the last write is `finish-verb --next-step-kind verify
      --verify-request-file`, with the operation directory, the next action
      and the proposal's confidence. Without the file the verb form is
      unchanged. The form renders in every engineer verb's finalize (a verb
      with no long check writes no request), in the consensus variant in the
      non-conflict branch only.
      `OWNER_GATE`, set, selects the owner-decision form of the last write
      with the gate's anchor, in place of the verb and verify forms (in the
      convergent variant, of the not-converged one too); the block refuses before settle a gate the verb does not end
      on with that form (refine's `recurring-finding` and decide's
      `decide-conflict` belong to those verbs; a conflict gate is the
      conflict branch's, through `VERDICT`), a gate beside a conflict verdict, and a note holding the
      heading of `recurring-finding`, `scope-routing` or `pr-handling` (flush
      or indented by up to three spaces, any run of blanks after its `###`) while `OWNER_GATE` is empty (a heading quoted in a fenced
      example fails closed, the block stopping with nothing written). The
      commented owner-decision form stays only in the personas without
      `dispatch_target`.
    - **Results on resume.** A verb's Phase 0 prints the request's results
      (`verify-results --current-tree true`): the request, its latest batch's
      end and cause, each check's kind, command and outcome, whether it is
      evidence and applies to the tree now, at most five failing tests and
      the log; nothing with no request, for which no tree is read. Each
      result applies only on the tree
      it was recorded for, by the driver's own tree digest, held equal by a
      parity test; a read that fails warns and the verb goes on, and a later
      release's attempt mark still refuses the append itself.
    - The long-check guidance is item 1's; since 2026-11-11 the commands
      render a short form of it that points at the skill's § Long checks.
      The verify form, which renders in decide, frame and investigate too,
      points at § Long checks in compose, refine and critique; the skills
      carry it because `/engineer:start` runs the skills. `autopilot-mode.md`
      § Verification says `verify` is a request-mediated handoff, not a
      proposal kind, `on_pass` the step after it, and the repeat rule the
      driver's. Under the offer, the worker's rule 4 keeps peer ensembles as
      background tasks and sends long checks to rule 7, which names quick
      against long and tells a resumed verb to read the printed results
      first; without it, both rules are as before.
    - **Limits.** Interactively, with another owner gate already pending,
      the owner-decision form's `finish-verb` refuses after settle and the
      note, so a rerun appends the note twice (the state stays consistent;
      autopilot's preflight refuses a pending gate first). In the convergent
      variant, a checked request with `CONVERGED` not `yes` and no gate is
      dropped for the not-converged branch (latent: only designer renders
      that variant, with no `dispatch_target`).

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
   decision, since older harness copies honor only the one file. The
   harness, the wrapper and the driver share one protocol (the record, its
   creation, the proof, release, stale judgment and the reap guard), whose
   code lives where the driver needs nothing from this repository's
   `scripts/`. *Amended 2026-10-20 (left to the implementation, slice 3): [history](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation-slice-3).*

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
   The repository's guidance (AGENTS.md, §Build / test / CI) and the persona
   runbooks that run a suite outside `verify` tell sessions to use it: that
   is guidance, not an instruction in Decision 7's sense. *Amended 2026-10-20
   (handed on from slice 3 to `impl-heavy-lock`): [history](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation-slice-4).*

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

10. **How it is implemented.** *Amended 2026-11-01 (impl-instruct): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-11-01--impl-instruct-decision-7).*
    - **The record.** One file per subtask under `instructions/` in the
      holds directory, written whole under the holds lock, at most 64
      entries in the order written. Each entry has an id, a revision, the
      branch and child it was written for (none before the dispatch), its
      step (the forced-step grammar less the dispatch and the rerun, restated
      from `policy.mjs` and held equal by test), the
      note (at most 16 KiB, strict UTF-8, no NUL, read as the engineer reads
      `--phase-note-file`: one trailing newline removed) with its sha256, the
      child's gate witness at the write, and its state (`pending`,
      `applying`, `applied`, `superseded` with cause `later-step` or `gate`,
      `dropped` with its cause, `withdrawn`) with its acknowledgement (when,
      by what, the application id, the step it replaced). The transitions are
      a table, as the holds' are. A
      revision is refused unless it names the current revision; an entry
      being applied or ended is neither revised nor withdrawn. Readers answer
      with a code (`dir`, `file`, `parse`, `schema`), never an excerpt. The
      wake digest covers each record's name and only what the
      owner writes (each entry's id, revision and withdrawal), the bytes of
      a record the readers refuse (it does not parse, or is no well-formed
      record of its subtask), and what keeps the directory from being read,
      so a run's own reservation, application, rollback or drop wakes
      nothing. A run with lanes reads the records before its pass of
      applications reads what is due, and takes that as seen at the pass's
      end, so an owner's write that lands during the pass wakes the next
      poll; a poll during the pass that took a later digest is left as it is.
    - **The application** is one transaction with a durable receipt: reserve
      the lane's due entries under the holds lock and write a receipt (the
      entries, the effective step, the supersessions, the child's next step
      it replaces, the child file's sha256, the applier's pid and
      fingerprint); release the lock, never held across a persona lock;
      check that the child's bytes are the reserved ones, else roll
      back, and the next boundary judges the child as it is; run one
      engineer `append` (the notes as one phase note headed
      `Owner instructions <application id>`, each inside a fence longer than
      any backtick run it holds, the effective step at `HIGH`); read the child
      back; finalize. A crashed receipt is reconciled before anything else:
      the heading on the child finalizes it, never written twice; its
      positive absence with the applier gone rolls the entries back to
      `pending`; an applier still alive is waited for; anything that cannot
      be read keeps it reserved (a persona home, a child copy, or the child
      read back after its append), so a note is never appended twice. The
      recovery reads every copy of the child under every root, and keeps the
      receipt reserved when none is found. The last 16
      ended receipts are kept.
    - **Precedence and the witness.** An entry whose gate witness differs from
      the child's now has its step superseded (`gate`), its note still
      appended; of the rest the last step wins, the earlier ones superseded
      (`later-step`). The witness is the child's
      `awaiting_owner_gate` and its count of whole `### Owner gate resolved:
      <gate> at <iso>` headings, read outside the lane's own application
      notes: a heading is an application's only when its id is a receipt of
      the lane that names that child and may have written its note (`done` or
      `reserved`), and at its first occurrence, so a worker's fence, or its
      quote of another lane's application heading, hides no later resolution
      or Phase 0 (a worker's quote of a whole resolution heading still counts
      as one, a limit below). A shorter line opening with the words is not
      counted. A receipt in any other state (`rolled-back` among them), and
      a reader with no child, give no ids. The owner command reads the
      record for the witness it stores, and the application the record it
      holds under the lock, so the witness at the write and at the
      application are read by one rule. The scan for a worker's step
      since an application reads the child by the same rule. A step's
      provenance is read from the receipts and the child (the latest
      application that set a step, with no `### Phase 0` heading after its
      own), so it survives a relaunch and names an owner's application, in
      both modes.
    - **Binding and drops.** A note written before the dispatch binds to the
      first child linked to the subtask on its branch created at or after the
      write's second, active or archived, and never to a later one. Before
      each application a sweep drops entries whose
      subtask left the plan (`left-plan`), completed (`completed`) or closed
      (`closed`), changed branch (`branch-changed`), or whose
      child archived (`child-archived`) or was replaced (`child-replaced`);
      homes that cannot all be read, or two
      active children, drop nothing. The due list adds every record of a
      subtask the plan no longer holds, so the sweep drops it.
      `/orchestrator:done` drops with `completed` (a subtask with only an
      instructions record retires it too) and the macro's end
      drops every pending one (`macro-ended`) before its holds directory
      goes, the summary returned to the caller, which prints it (done,
      finalize, abort, status). The outcomes are kept beside the holds root
      (`holds/ended/<macro>.instructions.json`), which `status` and
      `halt.json` read once the directory is gone, and a run's own
      retirement publishes what done dropped.
    - **The boundary** (item 3). A commit begun and unfinished (a commit
      phase only, as the policy reads it, never an interactive verb's
      terminal end), a pending
      settlement, and a batch the child records open, a dead driver's
      included, answer `not-at-boundary` with the lane's own step first: the
      lane is decided as before. An operation open, a hold, or a child that
      cannot be read hold the lane's recorded step back as a deferred one: a
      run with lanes tries it at every call and parks it, naming the reason,
      after as long as it waits for a lane `laneBusy` holds back; a serial
      run counts it as any deferral. The run adds what only it knows (a step
      of the lane in flight, a batch it keeps open, an untaken forced step);
      the owner's command adds a dead run's leftovers (`laneBusy`).
      Before applying, the macro's holds are turned on, so the write is a
      visible operation; where it cannot be, the instruction stays pending.
      Results that cannot be read beside a pending request count as an open
      batch. Once the verify step has ended such a batch, it gives the lane
      back (`none`) when an instruction with a step applies to the lane,
      rather than continue the batch; the instruction is applied at the
      boundary after it, its step replacing the request. A note alone leaves
      the batch to continue, and so does the owner's rerun (a forced step,
      which an instruction written since waits for).
    - **Who applies.** `state.mjs instruct-apply`, joining an admission of
      `instruct`: the owner's command with no run live holds the macro lock
      while it writes, so no run starts beside it; a run's worker passes on
      the run's own lock, and a run starts it as a worker group of its locks,
      the engineer `append` outside the run's step numbering. The
      serial driver applies at the top of each turn, before the decision, and
      decides from a fresh look; a run with lanes before
      its parked lanes are judged again, nominating a parked lane it changed,
      and again after a release's
      comparison, before the lane is decided. A run with lanes tries a lane
      again by the last attempt's result: `not-at-boundary` at every call,
      `no-child` and `none` once per loop pass, `inactive` and a deferral once
      per tick, and a failed command not while its lane stays parked on a
      record left as it was (the owner's change of the record, or the lane's
      release, tries again), so the other lanes are decided; a result that
      stays the same is printed once. An application left pending for a
      reason that may pass
      (`waiting`, `failed`, `unreadable`) defers the lane's recorded step,
      and in a serial run its judgment halt, and is tried again: a run with
      lanes takes the lane as parked in that decision, tries again at the
      next tick and waits for it before an idle end; a serial run waits and
      decides again at the same seq. After the third attempt on the same
      record the lane halts `owner-choice` with the reason, naming its
      release, the instruction still pending. `inactive` and `no-child`
      leave the lane decided as before. A read that cannot know (a
      home, a file, a child or the worktree list that cannot be read) answers
      `waiting`, never "nothing to do", and the owner's `instruct` refuses a
      write while the worktrees cannot be listed. An instructions directory
      that cannot be listed makes every open subtask of the plan due,
      `unreadable`: which lanes have one cannot be told. The owner's
      `instruct` also refuses a write while the subtask's record cannot be
      read: whose notes are the owner's cannot be told.
    - **Beside a forced step.** Both drivers refuse every forced step but the
      dispatch beside a pending entry with a step on that lane's active child,
      passing over an entry the sweep would drop; an entry being applied, and
      every entry while the homes or the worktrees cannot all be read or two
      children are active, still refuses; a record that cannot be read
      refuses, and every refusing entry is named. The entries pending at the
      launch are applied before the forced step, and only those; one written
      since waits for the step. Each driver reads what is pending (each
      record's pending entries by id and revision) as it takes its forced
      steps and before its refusal, and the application reserves those
      entries alone, so an entry written or revised since, before the look
      or between the look and the reservation, stays pending and is applied
      at the boundary after the forced step, its step replacing the one the
      forced step's `finish-verb` wrote. Every entry pending at the launch
      beside a forced step is a note (one with a step refuses the launch), so
      the forced step still runs.
    - **No step starts over a newer word.** Right before a step starts, with
      nothing awaited after it, each
      driver asks whether the lane's record holds an entry pending, or cannot
      be read, on a record its last attempt did not meet, and yields if so:
      a run with lanes decides again, and a serial run takes the turn again
      at the same seq, its reservation settled; the pass then applies the
      instruction, or defers the lane, before the decision. The record an
      attempt met is read before the attempt, so a lane whose own step comes
      first is not held back by an instruction the pass already tried. The
      admission leaves out a lane the pass leaves out (its batch open, or its
      untaken forced step first), and answers each record once, so a lane a
      pass did not try costs one more turn, never a loop. The serial driver
      asks the same question in its verification step, after its drift
      check. A
      verification step asks, right before its batch's start is written and
      after the stop check, with nothing awaited between them, only whether
      the lane has an instruction with a step pending or a record that cannot
      be read, on a record the last application attempt did not meet, each
      record answered once; it never asks beside the owner's forced rerun. On
      yes it writes nothing more, and the next pass applies the instruction,
      whose step replaces the request; an instruction a pass leaves pending
      costs one turn, never a loop. A note alone replaces no request: the
      batch runs and the note waits for the batch's end; the admission's
      recheck still applies a note written before the admission first. A run with lanes reads the records again before
      an idle end: whether they changed since the last pass read them at
      its start, whatever a poll took as seen. A change forgets every
      attempt and the loop runs again, so the instruction is applied before
      the run ends; each change is told once, and a write between that read
      and the halt's record is left to the relaunch, which the halt lists it
      for. The `completed` end, on an archived macro, needs no such read.
      Such yields count toward no `no-progress`. An instructed
      step replaces an answered request's `on_pass`: an application's step
      carries `instruction_application` on its `started` ledger line, and
      while the child's next step is the application's and its bytes are the
      ones it left, both drivers pass the policy's P7 guard of an answered
      request (Decision 5) over for it.
    - **Records.** The event kind `instruction` (Decision 4, item 8;
      `action` applied or dropped, the application id, counts, whether a
      step was set, a pointer to `lanes.jsonl` or `steps.jsonl`), the
      `instruction` lines of `lanes.jsonl` and of a serial run's step ledger
      (codes and ids). The serial line carries the seq of the step about to
      start; `readRun` and the dead-run cleanup keep it out of that step's
      record (`readRun` lists such lines in `instructions`), so a step in
      flight still reads as started and is settled when its run dies.
      `halt.json`'s `instructions` (each entry's id, revision, state, step,
      cause and application), `status --macro` (states and outcomes, the
      note's size only, and for an applied step whether a run's ledger shows
      it ran, or a later application replaced it before it ran), and
      `run.json`'s `instructions-1`, which every run of this release
      records. The owner command writes no event.
    - **Limits.** The window between the byte check and the engineer's own
      lock is not closed; a write landing there is a session's, which opens a
      persona operation the boundary check sees at the next look, and its
      step stands until then only if the engineer orders it after the
      append. A same-second child created before a note's write
      would bind it. A worker's note quoting a whole resolution heading at
      column 0, fenced or not, counts as a resolution: written between an
      instruction's write and its application, it supersedes the pending
      step (`gate`), the note is still applied, and the child keeps its own
      step. A worker's quoted `### Phase 0` heading is taken for a step by
      the scan the same way, which costs the instruction its provenance, and
      while a verification request is answered the P7 guard may then resume
      the requesting verb over the child's recorded step. A
      pruned receipt's note, and one with no `child`, are read as a worker's:
      a heading the owner quoted in it counts as a resolution or a step,
      failing toward the gate.
      A copy of the child restored by hand from before an application, with
      the same workflow id, that later quotes that application's heading is
      read as holding its note. One unreadable file in any persona home keeps every
      instructed lane waiting, then parked naming it. A tick's poll at an
      owner write forgets every attempt, so after a write to one lane another
      lane's next step may yield once too. A batch that is open and untrusted
      still comes first: its preparation yields, the application refuses
      with the lane's own step first, and the next attempt, on the same
      record, runs the restart before the instruction applies.

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
   - **What the approval reads of a hold.** The approval (when it records or
     changes a rebinding or a note) and the delivery (an approval's own, one
     run by hand, and a run's at the child's boundary) read the subtask's own
     records only: a hold pending, held or unreadable, a release awaiting its
     comparison (a run compares it), a holds marker that cannot be read, or a persona operation
     open in its lane (the records under `ops/<subtask>/`, the entries of
     every child linked to it on the plan's branch, active or archived, and
     of the child files the rebinding found) refuses, naming the release,
     `--discard-unreadable` or `writer-clear` (for an operation whose session
     is gone); the child files are read
     directly, so a child in the legacy workflow home counts too, and a
     cleared operation does not refuse whichever side names it. A retired,
     consumed, rejected, withdrawn or orphaned hold, a kept park and another
     subtask's records permit. The operation check runs whether the macro's
     holds are on or not. A plan id that is no hold key has nothing to read.
     The reader is read-only (no lock, no repair, no directory made), since
     the approval calls it holding the macro's file lock. An approval
     refuses only for a subtask whose rebinding it records anew or changes,
     or that it tells. A rebinding the readable record already holds with
     every field the same (child, the child's state, the words from and to,
     the fields changed) is carried: no note follows it and nothing a
     release's comparison reads of it changes, so it refuses nothing, and an approval of
     another subtask's change proceeds beside its hold; the record is taken
     as it reads, its stamp current or not. A rebinding whose child archived
     since is recorded anew, and so refused beside a hold: the release's
     fingerprint reads the child's state. The check is a look, not an
     exclusion: a persona operation that begins between it and the note's
     append meets the note mid-step. *Amended 2026-10-26 (impl-hold): [history](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half).*

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
   and how an unfinished delivery is completed, are `impl-rebind`'s (its cases are in [the history](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation-slice-4)).

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
     child not yet told. The refusal (`dispatch-changed`) names the
     approval's absent or stale rebinding (`impl-rebind`'s list, [history](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation-slice-4)).
     A write whose dispatch matches is compared as
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
test the mechanism (§Left to the implementation, now in [the history](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation); the binding outcomes are Decision 1 for `impl-lane-gate` and Decision 2, item 12 for `impl-hold`).

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
`no-progress`. *Amended 2026-11-10 (C178): a repeat after a pass is now
answered once by replaying that pass when it qualifies (Decision 5, item 7);
a repeat after a failure, or after a pass that was itself a replay, still
halts `no-progress`. [history](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-10--verification-policy-c178).*

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

## History

The records behind this decision, in [the history file](history/0068-autopilot-lanes-that-keep-going.md):

- 2026-10-19, record: the cases left to the implementation, slice 1: [Left to the implementation](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation)
- 2026-10-19, record: the slice 1 amendment cascade into ADR-0063 and ADR-0067: [Amendments](history/0068-autopilot-lanes-that-keep-going.md#amendments)
- 2026-10-19, record: the plan of slices 2 to 4: [Later slices](history/0068-autopilot-lanes-that-keep-going.md#later-slices)
- 2026-10-19, record: the cases left to the implementation, slice 2: [Left to the implementation (slice 2)](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation-slice-2)
- 2026-10-19, record: the slice 2 amendment cascade: [Amendments (slice 2)](history/0068-autopilot-lanes-that-keep-going.md#amendments-slice-2)
- 2026-10-20, record: the cases left to the implementation, slice 3: [Left to the implementation (slice 3)](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation-slice-3)
- 2026-10-20, record: the slice 3 amendment cascade: [Amendments (slice 3)](history/0068-autopilot-lanes-that-keep-going.md#amendments-slice-3)
- 2026-10-20, record: the cases left to the implementation, slice 4, and the heavy-work guidance handed on: [Left to the implementation (slice 4)](history/0068-autopilot-lanes-that-keep-going.md#left-to-the-implementation-slice-4)
- 2026-10-20, record: the slice 4 amendment cascade: [Amendments (slice 4)](history/0068-autopilot-lanes-that-keep-going.md#amendments-slice-4)
- 2026-10-21, implementation note: [Implementation note 2026-10-21 — verify-record-cli (Decision 5, item 7)](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-21--verify-record-cli-decision-5-item-7)
- 2026-10-25, implementation note: [Implementation note 2026-10-25 — hold-persona (the hold protocol)](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-25--hold-persona-the-hold-protocol)
- 2026-10-26, implementation note: [Implementation note 2026-10-26 — impl-hold (the orchestrator's half)](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-26--impl-hold-the-orchestrators-half)
- 2026-10-27, amendment: [Amendment 2026-10-27 — a hold's lane and a person's own worktree (impl-hold, critique round 5)](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-10-27--a-holds-lane-and-a-persons-own-worktree-impl-hold-critique-round-5)
- 2026-10-28, implementation note: [Implementation note 2026-10-28 — impl-events (Decision 4)](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-28--impl-events-decision-4)
- 2026-10-29, implementation note: [Implementation note 2026-10-29 — impl-stall (Decision 3)](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-29--impl-stall-decision-3)
- 2026-10-30, implementation note: [Implementation note 2026-10-30 — verify-exec (Decision 5, the driver's half)](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-30--verify-exec-decision-5-the-drivers-half)
- 2026-10-31, implementation note: [Implementation note 2026-10-31 — verify-runbooks (Decision 5, item 1: the runbooks)](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-10-31--verify-runbooks-decision-5-item-1-the-runbooks)
- 2026-11-01, implementation note: [Implementation note 2026-11-01 — impl-instruct (Decision 7)](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-11-01--impl-instruct-decision-7)
- 2026-11-03, implementation note: [Implementation note 2026-11-03 — C168 (the owner's forced verification step below HIGH)](history/0068-autopilot-lanes-that-keep-going.md#implementation-note-2026-11-03--c168-the-owners-forced-verification-step-below-high)
- 2026-11-10, amendment: [Amendment 2026-11-10 — verification policy (C178)](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-10--verification-policy-c178)
- 2026-11-10, amendment: [Amendment 2026-11-10 — temporary files and run retention (C175)](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-10--temporary-files-and-run-retention-c175)
- 2026-11-17, superseded text: [Superseded text 2026-11-17 — the Status section before the ADR-0070 migration](history/0068-autopilot-lanes-that-keep-going.md#superseded-text-2026-11-17--the-status-section-before-the-adr-0070-migration)
- 2026-11-27, amendment: [Amendment 2026-11-27 — the persona runbooks release their directories](history/0068-autopilot-lanes-that-keep-going.md#amendment-2026-11-27--the-persona-runbooks-release-their-directories)
