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
  - **Slice 2:** stall detection, and the driver's event file watched by the
    main session.
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
- **Slice 3:** the verification step the driver runs without an LLM, and
  one heavy-work lock shared with the mutation harness and interactive
  sessions.
- **Slice 4:** main-to-lane instructions read at the next step boundary, and
  rebinding a dispatched subtask after an owner-approved instruction change
  (C147).

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
