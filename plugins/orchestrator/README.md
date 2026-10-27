# orchestrator

Cross-host macro orchestration capability for Claude Code and Codex CLI. **L2 capability plugin** per [ADR-0010](../../docs/adr/0010-plugin-boundary-policy.md) 4-layer composition; **first multi-verb L2 occupant** per [ADR-0018](../../docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md) §sub-decision-1.

## Status

Ships `/orchestrator:plan` (macro plan + Plan-verify opposite-host peer ensemble through the ADR-0023 peer-runner supervisor), `/orchestrator:next` (same-host dispatch into engineer), `/orchestrator:done` (records a subtask completed once its pull request has merged, with the merge commit — [ADR-0062](../../docs/adr/0062-subtask-completion-recorded-at-landing.md)), `/orchestrator:finalize` + `/orchestrator:abort` (macro completion lifecycle), `/orchestrator:approve` (the owner's approval of a macro plan, bound to the plan's hash — [ADR-0063](../../docs/adr/0063-autopilot-fresh-session-driver.md) D6), meta commands `/orchestrator:resume` / `/orchestrator:checkpoint` / `/orchestrator:peer-now`, `/orchestrator:audit` as a follow-up planning alias, `/orchestrator:autopilot` (Claude Code only: drives an approved macro one fresh worker per step and halts at owner judgment — [ADR-0063](../../docs/adr/0063-autopilot-fresh-session-driver.md)), and macro auto-archive A1–A4 on the host Stop event (branch-agnostic per ADR-0019 §5). Schema `'1.2'` (ADR-0063 D6; `'1.1'` files are read and written at `'1.1'`). The cross-plugin invocation contract is [ADR-0019](../../docs/adr/0019-cross-plugin-invocation-contract.md). The cross-host `--peer` dispatch path for `/orchestrator:next` remains trigger-deferred PR-F scope.

## What it is

`orchestrator` is the macro layer. It manages **multi-deliverable workflows** by emitting a list of subtasks (`plan.subtasks[]`), dispatching each ready subtask into a separate `engineer` workflow, and closing or archiving the parent macro when the subtasks reach terminal states. The cognitive workbench (investigate / frame / decide / compose / critique / refine) lives in `plugins/engineer`.

| Layer | Plugin | Responsibility |
|-------|--------|----------------|
| L1 framework | `plugins/companions` | Cross-host bidirectional companion bridges (Claude ↔ Codex) |
| **L2 capability** | **`plugins/orchestrator` (this plugin)** | **Multi-deliverable macro planning, dispatch, completion, and Plan-verify ensemble** |
| L3 persona | `plugins/engineer` | Single-deliverable cognitive verb chain |
| L4 profile | `engineer:<sub-discipline>` | Discipline-specific context (backend, frontend, …) |

## Commands

| Command | Status | Description |
|---------|--------|-------------|
| `/orchestrator:plan <feature>` | ✅ shipping | Build a macro plan: produce `plan.subtasks[]` proposals via a Plan-verify opposite-host peer ensemble, persist to `<repo>/.agentic-plugins/state/orchestrator/workflows/<workflow_id>.md` for new repos, and present for approval. |
| `/orchestrator:next [<subtask-id>] [--workflow=<macro-id>]` | ✅ shipping (same-host) | Dispatch the next ready subtask into `plugins/engineer`. Branch precondition + ownership check + parent-linkage env vars per ADR-0019 §1+§3. The child records the selection the dispatch made (subtask, branch, verb, profile, topic); every binding of a child to its subtask (this writeback, the engineer's terminal note, `/orchestrator:done`'s owner scan) compares it under the macro's file lock and refuses a subtask revised since (ADR-0067 Decision 4, item 5). Plan-approval gate (ADR-0063 D4): under an autopilot run a plan not approved at its current hash is refused (`plan-unapproved`); interactive dispatch warns in one line about a plan pending approval or changed since it was approved. Cross-host `--peer` remains trigger-deferred PR-F scope. |
| `/orchestrator:done <subtask-id> [--pr=<n>] [--commit=<sha>] [--correct \| --no-commit] [--waive-dispatch] [--workflow=<macro-id>] [reason]` | ✅ shipping | Record subtask completion after its pull request merges (ADR-0062): resolves the merge commit bound to this attempt, verifies it against the integration branch, and unblocks successors. The engineer's Phase 7 and Stop hook only note the branch commit. `--correct` replaces a recorded value with an audit line; `--no-commit` completes work that landed no commit. The write compares the dispatch its owner records and refuses when that cannot be read; `--waive-dispatch`, with a reason, completes without the comparison when the owner's workflow file is gone, and the macro records it. |
| `/orchestrator:finalize [--workflow=<macro-id>]` | ✅ shipping | Close the macro plan with all non-terminal subtasks → `deferred` + macro `current_phase: 'finalized'` + `terminal_marker: true`. Three-step §5 ritual: bulk subtask transition → active-children detach pass (NO parent lock; routes terminal engineer children through `stop-archive`, mid-flight via `detach-archive`) → terminal markers. |
| `/orchestrator:abort [--workflow=<macro-id>]` | ✅ shipping | Same ritual as `/finalize`, but subtask transition → `abandoned` and `current_phase: 'aborted'`. Use when work cannot continue. |
| `/orchestrator:approve [--workflow=<macro-id>]` | ✅ shipping | Show the plan's subtasks and hash, then record the owner's approval of exactly that plan: `plan_approval_status: approved`, `plan_approval_approved_at`, `plan_approval_plan_hash` (ADR-0063 D6). Any later `plan-set` returns the plan to pending approval. Refused while the Plan-verify ensemble's `plan-conflict` gate is set, and under an autopilot run. |
| `/orchestrator:resume [archive [<workflow-id>]]` | ✅ shipping | Inspect the active macro workflow, classify git drift as clean/dirty, append a resume marker, or archive stale macro workflow files. |
| `/orchestrator:checkpoint <summary>` | ✅ shipping | Write `latest_checkpoint: {at, summary}` on the active macro workflow. Claude SessionStart re-injects it after compact (`matcher: "compact"`, so not on an arbitrary new session and not on `claude --continue`); Codex does the same once the bundled hooks load (generic `[features].hooks`) and are reviewed/trusted in `/hooks`. |
| `/orchestrator:peer-now --peer <claude\|codex> (...)` | ✅ shipping | Raw side-channel peer consultation through `peer-runner.mjs --kind peer-now`; optionally appends a `[Peer]` note and stays out of `ensemble_results`. |
| `/orchestrator:audit <findings>` | ✅ shipping | Audit follow-up alias that canonicalizes to `/orchestrator:plan Audit follow-up: ...`; state remains `verb=plan`, `workflow_id=macro-plan-...`. |
| `/orchestrator:autopilot [preview\|start [--execute]\|status\|stop\|release <subtask> [--hold <id>\|--discard-unreadable]\|hold <subtask>\|writer-clear <subtask> --operation <id>] [options]` | ✅ shipping (Claude Code only) | Drive an approved macro without relaying commands between sessions (ADR-0063): each step runs as one command in a fresh `claude -p` worker, decided from closed-enum state only, and the run halts at owner judgment (an unapproved plan, an owner gate, a next step below HIGH confidence, a subtask waiting for its pull request to merge, a step that changed nothing). Dry-run by default; `start --execute` runs it and asks for the model plan first. `hold` takes a lane over for a person while the other lanes go on (ADR-0068 Decision 2). See [Autopilot](#autopilot-claude-code-only) and [Holds](#holds). |

## Autopilot (Claude Code only)

`/orchestrator:autopilot` is the owner-launched driver of ADR-0063. It lives in
`adapters/claude/autopilot/` because everything it relies on is Claude Code host
truth — stream-json session hosting, `--permission-prompts none`, hook events and
per-message usage in the stream (D9). **There is no Codex skill for it: on Codex
the steps stay manual**, and the host-neutral state it reads (`next_step_*`,
`awaiting_owner_*`, `plan_approval_*`) serves a person driving Codex just the same.

- **One step, one fresh worker.** `/orchestrator:next`, `/engineer:<verb>`,
  `/engineer:commit`, `/orchestrator:done` (or `--no-commit` after a close
  without a commit) and `/orchestrator:finalize`, each in its own `claude -p`
  process with `AGENTIC_AUTOPILOT` set. The driver is stateless: a relaunch
  continues from the state a halt left.
- **Landing stays the owner's** (ADR-0062, owner decision D23). Workers never push or
  open a pull request — the denylist forbids it, and network pushes fail at the git
  level in every worker. Each commit is reported while the run goes on
  (ADR-0067 Decision 7): a `◆ landing-ready` line, a ledger record and a line in
  the main worktree's `.agentic-plugins/runs/autopilot/landing/<macro-id>.jsonl`,
  with the branch, its commit, the push and pull-request commands, a read-only
  `git merge-tree` overlap check against the integration branch and the other
  waiting branches (run in a scratch repository, so no merge driver or
  attribute of the checkout applies), and an advisory merge order. A branch is
  ready only when it contains the integration branch's tip as the run fetched it,
  so its CI checks the tree that lands; one behind it (another lane landed) is
  reported `◆ landing-sync` with the commands that merge the tip in and push, and
  one whose freshness is unknown `◆ landing-unknown`; every record's `ready`
  field, not its `landing-ready` event name, says which. A branch is reported again
  when its commit, the tip or its readiness changes. At an `awaiting-landing` halt
  the run lists each branch the same way; after the merge, a relaunch records the
  landing and goes on. Every end lists what still waits as it ended (per lane, in
  an `awaiting-landing` halt, and in a serial run's halt for any reason),
  `unknown` when the run could not confirm it (a failed look, an interrupt, an
  error), and not a branch that landed as the run ended.
- **Halts** print the reason and its pointer, write
  `.agentic-plugins/runs/autopilot/<run-id>/halt.json` and exit 2;
  `--notify-local` adds one local macOS notification. There is no plugin notification.
  A halt on a conflict gate carries `proposals[]`: the bounded consensus round
  (`/runtime:consensus plan --task-file <file> --peers claude,codex --max-rounds 2`)
  proposed before the owner decides, display only (ADR-0067 Decision 8).
- **Locks, stop and peers.** A run holds its macro's lock, under the main worktree, and
  the lock of each checkout it drives. A worker group in flight may have an entry of its
  own in the macro lock (ADR-0067 Decision 6), so a driver that died while any group runs
  still holds the macro. `status` lists the worker groups a run's entries record, and
  `stop` on a dead driver empties every group it can prove is the run's before it reports.
  `stop` reports a run stopped (exit 0) only once nothing of it runs: it reads the run's
  entries again while it waits, so a group left by a driver that died as it was stopped
  is emptied too, and it exits 1 while any part of the run still runs.
  After a killed or failed step, the driver cancels only the peer runs that step left
  pending on its own subtask's engineer workflows. A step whose worker's last report
  says it is finished (`waiting_on_background: false`) ends then, even with background
  tasks pending: its process group is torn down, its `finished` line names the tasks it
  abandoned, and the peer runs it left pending on the same workflows are cancelled and
  settled from their ledgers (`peer-runner settle`), or the step halts for the owner
  with the command to run (ADR-0063 D5, amendment of 2026-10-13).
- **A dead run is cleaned up.** Each run keeps a record in the main worktree's
  `.agentic-plugins/runs/autopilot/open/<run-id>.json` from before its first step until
  it ends with every worker group empty, unless a step's peers are unaccounted for: the
  look after the step could not read the macro, its readiness or the step's workflow, or
  after a failed step could not list its peers, or a peer's cancellation did not go
  through. The run, serial or with lanes, then keeps the record however it ends, and that
  step's `finished` line records `peers_unaccounted: true`, so the cleanup below also
  attributes a pending peer that names no run to it. Once nothing of a dead driver's run is left
  running, `stop`, or the next run of the macro before its first step, cancels the pending
  peer runs whose handle names that run, counts its unfinished step's whole budget as
  spent, records it halted (`interrupted`) unless it had already ended (a run that
  halted or completed keeps its status and reason), and removes the record. A pending peer that
  names no run is reported, never cancelled: peer-runner does not record the run yet, so
  until it does, `stop` and the next run print the command that cancels such a peer. A
  record whose ledger is gone, whose peer could not be cancelled, or one of whose peer-run
  homes cannot be read (anything but its absence), is kept and reported for the owner.
- **Lanes (`--lanes N`).** `adapters/claude/autopilot/lanes.mjs` holds ADR-0067
  Decision 5's lane layer: a lane is a locked git worktree at
  `<parent>/<repo>-lanes/<macro-id>/<subtask-id>`, named from the main worktree, created
  from a freshly fetched baseline, removed only once its subtask is done and only when
  clean and provably the run's (read again from git and the lane where each step of the
  removal acts), and reconciled at a run's start. With `--lanes N` (2 or more; the
  owner's default is 2) `scheduler.mjs` runs up to N subtasks at once, each in its lane,
  with the done and finalize steps in the driver's checkout (Decision 6): each step reserves
  its budget before it spawns, a new lane starts only while the rate limit's five-hour
  window is open (below 0.85, and before the first rate-limit event only while no worker
  runs), and a lane step is judged by its lane's own fingerprint and gates. A halt in one
  lane parks that lane only ([ADR-0068](../../docs/adr/0068-autopilot-lanes-that-keep-going.md)
  Decision 1): the other lanes go on. `parks.mjs` keeps each park with the lane's
  fingerprint in the macro's holds directory (`<main>/.agentic-plugins/runs/autopilot/holds/<macro-id>/parks/`),
  and a marker before each lane step's spawn, so neither a relaunch nor a crash retries a
  step that wrote nothing on its unchanged record; every 30 s a tick reads a cheap digest
  of what resolves a park, and a lane whose record changed (and stayed so for one interval)
  or that the owner released (`release <subtask> --macro <id>`) is picked up again, its
  rows reconciled first (a lane the owner holds, or whose release was rejected, is not
  picked up by a change of its record: its release, or a new hold and release, gives it
  back), and no worker spawns into a lane while a persona operation is
  open there (the child's operation entries and the macro's operation records, read
  fresh; ADR-0068 Decision 2, item 7). The park records' lock is
  `run-locks.mjs`'s, so a live writer is never taken over. A
  run-wide halt — version drift, an exhausted budget, a revoked approval, a macro gate, a
  halt that names no lane, the baseline or rollback fence, the driver's own steps, a group
  that outlived SIGKILL — drains the run: steps in flight finish and are recorded, nothing
  new starts. The run ends, exit 2, on a drain or once every remaining lane waits (parked,
  held, waiting to land, or behind those), with `halt.json` naming the first open park,
  or the first held lane when only held lanes are left, and listing the others, one
  entry per lane with its state and resolution (a held lane's release command). A
  release after the run has ended starts nothing: relaunch. SIGINT, SIGTERM
  and SIGHUP (a closed terminal) abort every worker instead. The work the scheduler runs in a child process while workers
  run (`offloop.mjs`: a look, a lane's creation and removal, a baseline fetch, the
  landing-ready report, a peer cancellation) is held as a worker is: each task's process
  group is on the macro lock and its checkout's lock before it starts, and is emptied before
  its answer, so a dead driver's task keeps the lock until it ends or `stop` empties it. On
  an interrupt a look, a fetch and the landing report in flight are killed at once; a
  lane's creation or removal, or a peer cancellation, already under way gets 15 s to finish;
  then no lane is created or removed, and an interrupted run keeps its lanes. A lane the run
  created and no step used is removed when its admission gives way, and before the run ends.
  `--lane <subtask> --next "<step>"` forces one lane's first step. Lanes need shared
  creation on, the default state root, and the macro there; `preview --lanes 2` shows the
  reconciliation and the first wave. Absent or 1, the run is serial, and it refuses to
  start while a lane of the macro holds a subtask that is not completed, the macro
  keeps a park, or a hold of it applies ([Holds](#holds)).
- **Bounds.** Steps, total cost, and each step's budget and wall clock
  (`--max-steps`, `--max-cost`, `--step-budget`, `--step-timeout`); a halt or `stop`
  ends a run too. The run itself has no clock, so a step started late gets its whole
  timeout. A step's peak context is recorded in the ledger, never a halt; a PreCompact
  event in a worker still aborts its step. A run started inside a Claude session runs as
  a background task, which the host stops after two hours, possibly leaving no halt
  record and its workers at work: check `status`, then `stop` what remains, and relaunch.
  Longer runs belong in a terminal through the optional launcher — `preview` prints the
  command that installs `adapters/claude/autopilot/launcher.template.mjs` as
  `~/.agentic-plugins/bin/agentic-autopilot`.
- **Requirements.** The repository ignores `.agentic-plugins/{runs,state,tmp,cache}/`;
  engineer carries ADR-0063 S3+S4 (0.24.0) and orchestrator S6 (0.16.0); the plugin
  code a worker loads must not live inside the repository the run drives (on a
  directory marketplace, drive a separate worktree), and it must be the version the
  run pinned. Launch from the home worktree (below). Holds need more (below).

### Holds

`hold` gives one lane to a person while the run's other lanes go on
([ADR-0068](../../docs/adr/0068-autopilot-lanes-that-keep-going.md) Decision 2; the
records, locks and crash recovery are its implementation note of 2026-10-26, I1-I14).
Holds are a lanes feature: a serial run does not start beside one, and `hold` refuses
beside a live run that does not honour them (`stop` it first).

```bash
agentic-autopilot hold <subtask> --macro <id>                 # take the lane
agentic-autopilot status --macro <id>                         # wait until its hold line says held
claude --resume <session>                                     # in the lane, as hold printed it
agentic-autopilot release <subtask> --macro <id> --hold <hold id>   # give it back
```

- **Hold.** The driver leaves the subtask alone: no dispatch, adoption,
  reconciliation, step (its done included) or removal; a landing-ready report may still
  name its branch. The hold is *pending* until nothing of the lane is in flight and no
  persona operation is open there (a step already running finishes first, never
  aborted), then *held*, with a fence in the lane's worktree lock that an older driver
  reads as a session's admission. Start only once the hold's own line in `status --macro`
  says `held`: the run's lane table shows a lane `held` from the moment the hold is set,
  its handoff pending included. `hold` prints the
  hold id, the lane, its last session, the engineer the person needs and the release
  command; it warns when the subtask has no lane yet (nothing fences it) and when the
  lane does not ignore `.agentic-plugins/{state,runs}/` (a session left open after the
  release would reject it).
- **Work.** Work the lane's active child (the engineer workflow the dispatch linked to
  the subtask) with the hold-aware engineer, whose verbs keep their operations visible
  to the release, and record the next step the run should take (`finish-verb`, a
  commit, an owner decision). The engineer refuses to begin a workflow with no dispatch
  linkage in a held lane: with no active child, work by hand (a commit, a push), or
  release the lane for the driver.
- **Release.** Stop editing and close the session first: `release --hold` refuses while
  a persona operation is open, a peer ensemble is pending or the child's workflow is
  locked, then records the lane's fingerprint, tree digest and the child's content
  digest. The run compares them once before the lane steps: equal gives the lane back
  (its kept park ends) and the run continues from the child's record; a change made
  after the release and still there at the comparison rejects it, and the lane parks
  until a new hold and release. An edit after the comparison is not seen. A pending
  hold is withdrawn with nothing to compare; one set over a release not compared yet
  or rejected puts that release back, so a rejection is never lost. Worked in a
  worktree of your own (not the run's lane)? Commit there and remove it (`git worktree
  remove <path>`) before the release, which refuses while it has the branch: the run
  steps the subtask only in its own lane. A subtask not dispatched yet is dispatched
  on its branch at the baseline's tip, or at the tip its consumed release recorded
  when that tip contains `origin/<baseline>`: rebase your work onto it before the
  release. A recorded tip that does not contain it halts the lane, naming a new hold,
  the rebase and a release; no halt advises discarding commits the baseline lacks
  ([ADR-0062](../../docs/adr/0062-subtask-completion-recorded-at-landing.md)
  Decision 2, amendment of 2026-10-27).
- **Repairs.** `writer-clear <subtask> --macro <id> --operation <op id>` is the owner's
  word that an operation's session is gone; a run that waits on an open operation names
  it and this command. `release --discard-unreadable` keeps the
  text of a record that cannot be read (only a line saying why, for one that is no
  regular file) and replaces it without giving the lane back unguarded: a discarded
  release counts as rejected, so the lane needs a new hold and release, and a hold whose
  record, handoff or release was discarded is released with a comparison, never withdrawn.
  A bare `release` ends a kept park only; it never deletes one it cannot
  read. `status --macro <id>` works from any checkout with or without a run, and with
  no live run completes a pending handoff and repairs a fence.
- **Exits.** `/orchestrator:done` records the subtask completed and then retires its
  hold; while an operation is open, a process lives in the lane or a record cannot be
  read, the retirement waits and the hold still applies, and a later done, `status`,
  the Stop hook or the next run retries it. `abort` and `finalize`
  stop beside an open operation, a busy lane or a hold record that cannot be read, and
  retire the macro's holds after their
  terminal write; a hold whose subtask left the plan, or whose branch, lane or child
  changed, is orphaned. `/orchestrator:next` refuses a held subtask, and a rebinding
  (Decision 8) waits for it.
- **Requirements.** Holds turn on for a macro only once the hold-aware engineer
  (`state.mjs hold-capability` prints `hold-persona-1`) is installed in both hosts'
  caches and pinned by the launcher (`AGENTIC_ENGINEER_ROOT`); the refusal names what to
  install or move. A run with lanes records `holds-1` in `run.json`.
- **Limits.** Rolling the orchestrator back below the release that added holds while a
  hold exists is unsupported: a hold on a subtask with no lane has no fence an older
  driver would respect. An edit to an ignored file is outside the tree digest, so the
  comparison does not see it unless it is the child's workflow or the run's own record
  of the lane, which are compared apart from git. A hold on a subtask whose branch the
  main checkout has (a hand dispatch) is unfenced, and an edit left uncommitted there
  is not compared.
  Whether `claude --resume` of a lane's last session works from the lane is
  unverified; the acceptance (`tests/acceptance/hold-takeover/`) pins the session id
  and working directory `hold` prints.

### The home worktree

`preview` and `start` judge two launch triggers separately ([ADR-0067](../../docs/adr/0067-autopilot-worktree-lanes-and-proposals.md)
Decision 8, item 4) and propose a concrete setup for each, as a `→ Proposed` line in
the text and a `{kind: "worktree", command, pointer}` entry in `preview --json`'s
`proposals`:

- **Launched on the main checkout.** A serial run switches that checkout's branch at
  each dispatch; with lanes, done and finalize run there, and work in it halts the
  run. The proposal is the home worktree: `git worktree add -b autopilot/home
  <parent>/<repo>-autopilot <base>` (from the macro's baseline as last fetched, or the
  local branch without an `origin`; an existing home worktree is reused, found at that
  path whatever branch a run left it on, or by its `autopilot/home` branch elsewhere),
  then the start command in it with `AGENTIC_{ORCHESTRATOR,ENGINEER,RUNTIME}_ROOT`
  pinned to the newest release in the Claude Code install cache that carries the file
  each plugin's resolver checks, and `--macro` naming the macro found here (the home,
  on `autopilot/home`, finds none by its branch; with none found, the proposal asks
  for `--macro <id>` and names no command). The run on the main
  checkout still starts; the proposal is for the next launch. A macro the home
  worktree could not read (one in a linked worktree's own home) needs the state-root
  cutover first, and the proposal says so instead.
- **Plugin roots inside the repository.** The refusal stays, and so does the check of
  the plugins each worker loads; the proposal pins every root to its installed cache
  release, or, for a plugin with no install, to the same directory in a detached
  snapshot worktree (`git worktree add --detach <parent>/<repo>-plugins-snapshot
  <HEAD>`) that no run drives and no one updates. The pins move the scripts the
  runbooks run, not the commands and hooks a worker loads: on a directory marketplace
  in the driven checkout those come from that checkout, the first step still halts, and
  the run must be driven from another checkout, the home worktree when this is the main
  one. `start`'s refusal prints both triggers' proposals, as `preview` does.

Nothing is run for you: each proposal is display only.

### The heavy-work lock

One heavy job runs at a time per repository, whichever worktree, lane or session
starts it ([ADR-0068](../../docs/adr/0068-autopilot-lanes-that-keep-going.md) Decision 6).
The lock is the mutation harness's file, `<git-common-dir>/mutation-harness.lock`,
which every harness copy honors; its code is `scripts/lib/heavy-lock.mjs`. Its holders
are the mutation harness and the wrapper:

```bash
agentic-autopilot heavy [--purpose <text>] [--repo <dir>] [--declaration-ref <rev>] -- <command> [args...]
```

(or `node adapters/claude/autopilot/cli.mjs heavy -- …`). It takes the lock, runs the
command in a process group of its own, and releases the lock once the command and its
group have stopped. While it waits it names the holder and repeats the line every 5
minutes. It runs on any host and inside an autopilot step: the lock is host-neutral.

- **Nesting.** A wrapper holder hands its command a proof
  (`AGENTIC_HEAVY_LOCK_PROOF`, with `AGENTIC_HEAVY_LOCK_VIA`); a harness or wrapper
  started under it joins its lock and waits for nothing, so `heavy -- npm run mutate …`
  does not deadlock. Only the holder releases, after every group of its ownership has
  ended. Test runs and autopilot workers never inherit the proof, and `start --execute`
  refuses to run inside a holder. A command the repository's committed check
  declaration (`.agentic-plugins/verify-checks.json`) marks as `locks_itself` is
  refused: an older harness under a holder would wait on its own holder.
- **Exit status.** The command's own; 128+n for signal n, whether it ended the command
  or stopped the wrapper; 125 for the wrapper's own failure or refusal; 126 when the
  command cannot be executed; 127 when it is not found.
- **Signals.** SIGINT, SIGTERM or SIGHUP while waiting cancels the wait, and nothing
  runs. While the command runs, the signal goes to its group, SIGKILL follows 5 s
  later, and the wrapper waits until the group is gone before it releases. SIGKILL to
  the wrapper leaves the group to its supervisor, which kills it, and the lock to the
  next acquirer, which waits until no group of it runs. These hold for the wrapper's
  own pid, which is what `node adapters/claude/autopilot/cli.mjs heavy` runs as. The
  `agentic-autopilot` launcher in front of it is a separate process, a file copied at
  install that an upgrade does not replace, and it forwards SIGINT and SIGTERM only:
  a SIGHUP or SIGKILL sent to the launcher's pid alone ends the launcher, while the
  wrapper runs its command to the end and then releases. A terminal hangup or Ctrl-C
  reaches the wrapper directly, as both are in the terminal's foreground group; for
  Ctrl-C the launcher forwards a second SIGINT, which the wrapper notes.
- **What it does not cover:** a worker's quick checks in its step; a process started
  without the wrapper; a process that leaves its holder's process group (a daemon, a
  detached child); another clone or machine; CI; a peer's own commands; the driver's
  git operations; load from outside the repository. Against a harness copy from before
  this release, exclusion holds while the holder lives; that copy judges a holder by
  its pid alone, so after a holder's death it may start beside the holder's last
  children.
- **A known limit.** A process group counts as ended only when the system says it is
  gone, never from a look at the process list, which can miss a running member. So a
  group whose processes have all exited but are not yet reaped (zombies) still holds
  the lock: under a parent that never reaps them, such as a PID 1 with no init in a
  container started without one, the lock is kept until that parent reaps them or
  exits. On macOS launchd reaps orphans, and on Linux an init does.

## Workflow file shape

`<repo>/.agentic-plugins/state/orchestrator/workflows/<workflow_id>.md` with frontmatter `schema: '1.2'` (ADR-0063 D6; a `'1.1'` file keeps its schema when written). Existing legacy `.claude/agentic-orchestrator/` state remains readable/writable until explicit migration; legacy schema `'1.0'` files are still readable but mutations are refused with archive/re-plan diagnostic. `workflow_id` format `macro-<verb>-<iso>-<rand>`. `workflow_type: macro`. The `plan` block carries `decision`, `architecture`, and `subtasks: [{id, verb, branch, blocked_by, status, label?, profile?, topic?, engineer_workflow_id?, commit?, pr_url?, closed_at?}]` per ADR-0018 §sub-decision-1 + ADR-0019 §2 spec. `verb` ∈ {investigate, frame, decide, compose, critique, refine}; `branch` must pass git ref-format and have no parent/child path-prefix relationship across subtasks. Optional top-level `terminal_marker: boolean` per ADR-0019 §5 (set by `/orchestrator:finalize` / `/orchestrator:abort` or auto-set when all subtasks reach terminal status). Optional `latest_checkpoint: {at, summary}` is written by `/orchestrator:checkpoint` for macro workflow continuity. Optional flat scalars (ADR-0063 D6, absent = null) record the plan's approval: `plan_approval_status` (`pending | approved`), with `plan_approval_approved_at` and `plan_approval_plan_hash` (sha256 over the subtasks' id, label, branch, blocked_by, verb, profile and topic — `state.mjs plan-hash`) exactly when approved; and `awaiting_owner_gate` (`plan-approval | plan-conflict`), `awaiting_owner_since` and `awaiting_owner_pointer`, all or none, set exactly while the plan is pending. `plan-set` returns the plan to pending, at `plan-conflict` when its Plan-verify verdict (`--verdict`) is `conflict` and at `plan-approval` otherwise; `awaiting-owner-clear --gate plan-conflict` returns it to `plan-approval`; `plan-approve` approves. `next-ready` reports `approval: {status, hash_ok}` on every output.

Per [ADR-0018 §sub-decision-2](../../docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md), the **active workflow** is the one whose `git_baseline.branch` equals the current branch. `git checkout` is the primary context-switch primitive; no extra "switch workflow" UX. This applies symmetrically to engineer and orchestrator.

In a repository with linked worktrees, `<repo>` is the checkout's **read set** ([ADR-0067](../../docs/adr/0067-autopilot-worktree-lanes-and-proposals.md) Decision 1): the default state root, where git placed the main worktree, then the checkout's own home when it differs. A record under the default state root is found from every checkout of the repository, one in a linked worktree's own home only from that worktree; a branch key or workflow id that two files hold in one read set is reported by the readers and refused by the writers, never chosen. New records go to the checkout's own home until the operator's cutover turns shared creation on, and to the default state root from then on (`AGENTIC_STATE_BASE` may name the checkout instead, Decision 2). The cutover, its verification and its rollback are `state.mjs cutover` and `state.mjs shared-creation`, run in the main checkout as [`docs/runbooks/state-root-cutover.md`](../../docs/runbooks/state-root-cutover.md) describes. `/orchestrator:next`, `/orchestrator:done`, `/orchestrator:finalize`, `/orchestrator:abort` and `/orchestrator:resume`'s archive join the macro's run lock as an admission before they act (`state.mjs admission join | check | release`, Decision 4, item 5), so a session and an autopilot run never act on one macro at once.

## Peer-run operational state

`scripts/dispatch-peer.mjs` remains the compatibility wrapper for raw callers and tests. `/orchestrator:plan` uses `scripts/peer-runner.mjs run --kind ensemble` for managed Plan-verify dispatch. The runner stores operational state under:

```text
<repo>/.agentic-plugins/state/orchestrator/peer-runs/<run_id>/
  handle.json
  stdout.log
  stderr.log
  envelope.json
  prompt.xml   # only when --retain-prompt is supplied
```

Orchestrator keeps its graceful-degradation rule: the runner resolves the companion before creating this ledger or recording `pending_ensemble`. If the opposite-host companion is unavailable, it returns `peer_cli_not_found` and `/orchestrator:plan` proceeds with a LOCAL-ONLY synthesis. If the companion resolves, the runner records the pending row, supervises the child process, supports `status` / `cancel` / `sweep`, and enforces terminal ledger retention. `/orchestrator:peer-now` also uses the runner, but with `--kind peer-now`; it creates operational ledger state and remains excluded from `pending_ensemble` / `ensemble_results`.

## Hooks

Claude Code hooks declared in `hooks/hooks.json`:

- `SessionStart` (matcher `compact`): re-inject the active workflow snapshot
- `PreCompact`: write a snapshot before compaction
- `Stop`: macro auto-archive — iterate every non-archived macro under `workflows/` (branch-agnostic, per ADR-0019 §5), snapshot each, evaluate the four hard gates (A1 `terminal_marker` / A2 macro terminal_phase whitelist `{commit-complete, finalized, aborted}` / A3 `all_subtasks_terminal` / A4 `no_active_engineer_children`), and atomically move passing macros into `archive/`. The non-conventional commit subject gate emits a soft warning but does not block archive.

Codex CLI exposes host-level hooks and plugin-bundled hooks. The
orchestrator Codex manifest points at
`./adapters/codex/hooks/hooks.json`, so the plugin management surface can show
host-specific lifecycle commands without routing through Claude adapter paths.
Automatic Codex execution still depends on the plugin being enabled with
generic `[features].hooks` (default on) plus Codex hook review/trust in the
active host session. The Codex-side `Stop`
script under `adapters/codex/hooks/stop.mjs` remains a manual fallback invoked
from `/orchestrator:finalize` and `/orchestrator:abort` Phase 4 tails (or by
the user manually) when plugin hooks are disabled or not yet trusted.

## Schema vs engineer

`orchestrator` and `engineer` are **separate plugins with separate schemas**:

| Plugin | schema | Workflow dir | workflow_id format |
|--------|--------|---------------|--------------------|
| `engineer` | `'1.4'` | `.agentic-plugins/state/engineer/workflows/` (`.claude/agentic-engineer/workflows/` legacy) | `<verb>-<iso>-<rand>` |
| `orchestrator` (this) | `'1.2'` (ADR-0063 D6; `'1.0'` legacy read-only) | `.agentic-plugins/state/orchestrator/workflows/` (`.claude/agentic-orchestrator/workflows/` legacy) | `macro-<verb>-<iso>-<rand>` |

Both schema lines are `1.y` strings, and each plugin reads any `1.y`, so namespace separation is preserved by structural validation, not by the version: orchestrator requires `workflow_type: macro` + `plan.subtasks[]`; engineer files lack those fields and fail at the per-field gates. orchestrator's `state.mjs` rejects engineer schema-1 / 2 (numeric) cleanly. Legacy 1.0 orchestrator files are readable but mutations are refused with an archive/re-plan diagnostic per ADR-0019 PR-B.

## Install

```sh
# Claude Code
claude /plugin install orchestrator@agentic-plugins

# Codex CLI
codex plugin marketplace add each4all/agentic-plugins
```

Required peers:
- `companions` (L1) — for the Plan-verify opposite-host peer ensemble inside `/orchestrator:plan`.
- `engineer` (L3) — runtime peer for `/orchestrator:next` dispatch (the runbook spawns engineer's `state.mjs` CLI). Discovery is automatic per ADR-0019 §1, with ADR-0061 §Decision 3's candidates: the `AGENTIC_ENGINEER_ROOT` override, then the versioned install cache of the host orchestrator runs from, then the other host's cache only when that host has no engineer installed (the fallback is reported on stderr), then the monorepo sibling only when orchestrator itself runs from a checkout. The Codex marketplace clone is never a candidate. Install engineer before `/orchestrator:next` invocations or set `AGENTIC_ENGINEER_ROOT=<path>` to override.

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `PEER_RUN_CANCEL_GRACE_MS` | Grace period used by `scripts/peer-runner.mjs cancel` between TERM and KILL. | `10000` |
| `PEER_RUN_STALE_GRACE_MS` | Age threshold used by `scripts/peer-runner.mjs sweep` before a dead, no-envelope non-terminal run is marked `orphaned`. | `60000` |
| `PEER_RUN_RETENTION_TTL_DAYS` | Terminal peer-run ledger TTL used by `scripts/peer-runner.mjs sweep --apply`. | `14` |
| `PEER_RUN_RETENTION_CAP` | Maximum terminal peer-run ledger directories retained per repo by `scripts/peer-runner.mjs sweep --apply`. Non-terminal runs are preserved. | `200` |
| `AGENTIC_HEAVY_LOCK_POLL_MS` | How often `autopilot heavy` polls the heavy-work lock while it waits (10 ms up to the default; a test seam). | `2000` |
| `AGENTIC_HEAVY_LOCK_REPORT_MS` | How often `autopilot heavy` repeats a waiting line (10 ms up to the default; a test seam). | `300000` |

## License

[MIT](../../LICENSE).
