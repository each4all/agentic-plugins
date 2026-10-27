# The hold takeover (ADR-0068 Decision 2, item 10)

Two tests drive a takeover of a lane end to end:

- `test-hold-takeover-orchestrator.mjs`, the acceptance: the persona half
  against the real orchestrator half (impl-hold, Task 14). See
  [The acceptance against the orchestrator](#the-acceptance-against-the-orchestrator)
  below.
- `test-hold-takeover.mjs`, the prototype: the persona half against a scratch
  orchestrator half, before the persona shipped. The rest of this file up to
  that section describes it.

## The prototype

This is a named artifact of the hold-persona subtask (Task 12 of its plan). It
drives a takeover of a lane end to end before the persona's half of holds
ships. The orchestrator's half (`impl-hold`) ships after it (item 9), and reader
fixtures alone cannot prove a takeover.

- `test-hold-takeover.mjs` is the test. `npm test` discovers it.
- `_scratch-orchestrator.mjs` is a scratch orchestrator half: the smallest
  reader and writer of the shared files (implementation note N1-N3, N6, N7)
  that can drive a takeover. It is **not** `plugins/orchestrator`'s hold
  implementation and ships in no package. `impl-hold` writes that one, with
  its own record layout, locks, crash recovery and commands. The header of the
  scratch file lists what it leaves out: checked-out submodules in the tree
  digest, the lane fingerprint, live-run and worker checks, and crash
  recovery.

### What runs

The persona half is the real engineer scripts. The test runs them through the
generated blocks of the engineer runbooks (`commands/compose.md`,
`critique.md`, `refine.md`, `commit.md`, `checkpoint.md` and `peer-now.md`),
the way an agent runs them:

- each block runs in a fresh `bash`, with its placeholders filled;
- the operation directory is carried as the `OP_DIR` the Phase 0 block
  printed;
- after the release, the driver's next step runs the runbook of the verb the
  scratch half read from the child's `next_step`.

Peer runs go through the real peer runner. Its companion is a fake that answers
when the test opens a barrier, so the test can check the lane while the peer is
still running.

The lane is a git worktree of a main checkout, on its own branch. The holds
live in the main checkout. Every acceptance case runs twice:

- with the workflows in the lane's checkout;
- with the shared-creation switch on (ADR-0067 Decision 1), so that the
  workflows live in the main checkout's state root, as on a machine that has
  run lanes.

No `claude` is spawned. Whether `claude --resume` of a lane's last session
works from the lane stays [unverified] (item 5). The parent writeback of a
commit is a probe in the Stop hook's `noteParent` slot, not the orchestrator's
writer.

### Acceptance

The prototype passes when each of these holds against the scratch half:

1. **A person's verb.**
   - A worker step runs under `AGENTIC_AUTOPILOT`, and its dispatch gave it an
     operation id. The owner holds the subtask while the step is still in its
     verb.
   - The handoff stays pending, naming that operation, until the step's last
     write. The step runs to its end and records its next step.
   - The lane is then held. The person's verb in the lane opens its own
     operation and runs its own ensemble. While the peer is still running,
     the release refuses: the operation is open and the ensemble is pending.
     After the peer ends, the release still refuses until the finalize
     settles the ensemble.
   - The person's interactive `finish-verb` stays open (item 6) and records
     the person's next step.
   - The release records its basis. The session's last Stop snapshot, a
     minute later, rewrites `last_snapshot` but leaves the content digest as it
     was. The comparison is consumed, once.
   - The driver's next step runs the person's recorded verb (refine) through
     that verb's own runbook.
2. **Routes.**
   - When the person's next step is a commit, the driver's commit step commits
     what the person's verb recorded.
   - When the person records an owner decision, the gate is recorded, the
     workflow stays open, and the driver parks the lane.
3. **Rejected.**
   - A hand edit after the release rejects it and parks the lane, and so does
     a persona write (a checkpoint).
   - Putting the tree back gives nothing back. A new hold and release do, and
     consuming them ends the park.
4. **A committed child.** The person's `/engineer:commit` stays an operation
   through its archive and through the parent writeback's slot. Inside that
   slot, the archived child's entry and its record are still there and the
   release refuses. Once the operation ends, the release is compared and the
   lane waits to land.
5. **No child.**
   - An unlinked bootstrap in the held lane is refused (item 5).
   - Hand work in the lane is compared, and the driver dispatches.
6. **A peer run the session started itself** (`/engineer:peer-now`).
   - While the peer runs, the consultation is an open operation and the
     release refuses. It keeps refusing until the consultation's note.
   - The run stays in the ledger, naming no workflow. The resumed worker's
     critique settles its own phase beside it.
7. **A dirty tree in no manifest.**
   - A synthetic file at the runtime's session-capture path, in the lane's
     ignored state root, is outside both digests. (The runtime's capture
     writer does not run.)
   - An unstaged hand edit outside the worker's manifest is compared in. The
     resumed worker's autopilot commit then stops at the staging-set owner
     gate, and the lane parks for the owner.
   - An unstaged hand edit inside a path the worker's manifest names rides
     with the worker's commit. A staged one stops at the gate.
8. **The scratch half's own blockers.** A handoff waits on an operation that
   only the child's entry shows (one begun before activation, which has no
   record). It also waits on the workflow's file lock.

Mutations: group T of `scripts/mutation-specs/hold-persona.mjs`. Each one is a
persona defect that the end-to-end path has to catch.

### Findings

What the prototype found, and where each finding went:

- **The persona half needed no change.** Every acceptance case passed on the
  persona's scripts and runbooks as the earlier units left them.
- **Item 10's unverified list** (recorded in the implementation note, N9):
  - Peer runs the session started itself are operations while they run, and
    they leave nothing that the resumed worker trips on.
  - Session-capture files live in the lane's state root.
  - A dirty tree recorded in no manifest is carried by the comparison. The
    commit's existing staging-set gate then stops it, with one exception:
    unstaged hunks inside a path the worker's manifest names ride with the
    worker's commit.
- **For `impl-hold`: the tree digest and the state root.**
  - Item 7's tree digest covers every non-ignored file.
  - Suppose a repository does not ignore `.agentic-plugins/`, and shared
    creation is off. Then the session's own Stop snapshot after the release
    moves the tree digest. The release is rejected even though nobody edited
    anything (the last case of the test).
  - Leaving the state root out of the tree digest would depart from item 7's
    "every non-ignored file". That is the owner's to decide with `impl-hold`;
    this subtask decides nothing about it.
- **A lesson for the test itself.** Two snapshots taken within the same
  second write the same `last_snapshot`. The first version of case 1 passed
  with `last_snapshot` counted in the content digest, and mutation T2
  survived. The post-release snapshot now runs a minute later, and the test
  asserts that it rewrote the field.

## The acceptance against the orchestrator

`test-hold-takeover-orchestrator.mjs` replaces the scratch half with
`plugins/orchestrator`'s own:

- The owner's `hold`, `status` and `release` run through `agentic-autopilot`
  (`cli.mjs`), from the driver's checkout.
- The driver is the real scheduler with lanes. Its worker is the scripted
  worker the scheduler's own tests use
  (`tests/orchestrator/fixtures/autopilot-scripted-worker.mjs`), through the
  fake `claude`.
- The person's session runs the generated blocks of the released engineer's
  runbooks (`_runbook.mjs`, a copy of the prototype's transport; the
  prototype keeps its own, which mutation group T of `hold-persona.mjs`
  proves). That engineer is installed in both hosts' caches, so holds turn on.
- The driver path runs with shared creation on, since real lanes need it.
  One case runs with it off: the commands and the persona alone, the child
  in the lane's own checkout.

No `claude` is spawned. Whether `claude --resume` of the lane's last session
works stays [unverified]. The test pins the session id and the cwd that `hold`
prints for it: the step's own, from the run ledger, and the lane.

### Acceptance

1. **A person's verb.** The run's step dispatches A in its lane. The owner
   holds A while the step is still running, and the hold stays pending until
   the run hands the lane over after the step ends. The person resumes the
   verb, and its ensemble waits on a barrier. The release refuses while the
   operation is open, naming it and the pending ensemble, and `status` names
   the operation. After the peer ends, the release still names the pending
   ensemble until the finalize settles it. The person's
   `finish-verb` stays open and records refine. The release is taken, and the
   session's last Stop snapshot follows it. The next run consumes the release
   once, and its first step for A is `/engineer:refine`.
2. **Routes.**
   - When the person's next step is a commit, the driver's commit step commits
     the person's file with the worker's.
   - When the person records an owner decision, the release is consumed and
     the driver parks the lane on the gate. A file at the runtime's
     session-capture path, in the lane's ignored state root, is written again
     after the release (a synthetic file; the runtime's writer does not run):
     it is outside both digests.
3. **A committed child.** The person's `/engineer:commit` stays an operation,
   and the release refuses it. The engineer's real Stop hook then archives
   the child and calls the orchestrator's writer for the parent's note, which
   the test keeps waiting on the macro's file lock. Inside that slot the
   archived child still carries the commit's operation, and the release
   refuses it. Once the note is written the operation ends, the release is
   compared, and the run halts `awaiting-landing` with the lane
   `waiting-to-land` at the person's commit, no park.
4. **Rejected.** A hand edit after the release rejects it. The lane parks
   owner-choice, and `status` says why. Putting the tree back gives nothing
   back: a relaunch keeps the same rejection, uncompared, and the same park,
   and steps nothing. A new hold and release do give it back.
5. **A dirty tree in no manifest.** A hand edit of a tracked file the
   worker's manifest does not name is compared in. The resumed worker's
   commit then stops at the staging-set gate, and the lane parks.
6. **A peer run the session started itself** (`/engineer:peer-now`). While
   the peer runs, and after it ends until the consultation's note, the
   release refuses, naming the consultation's operation. The run's ledger
   names no workflow. The next run consumes the release and steps the
   child's recorded verb, then its commit, beside that ledger.
7. **No child.** A hold set before the run keeps A from being dispatched,
   and the lane is never created. A bootstrap on A's branch is refused
   (item 5). The release is consumed, and the driver dispatches A.
8. **Shared creation off.** `hold` waits on the dispatched verb's operation.
   `status` completes the handoff once the operation closes. The release
   refuses beside the person's operation, and its basis is the digest of the
   child in the lane's checkout.

Mutations: group T of `scripts/mutation-specs/impl-hold.mjs` (T11 is proved by
`tests/orchestrator/test-autopilot-holds-cli.mjs`, the last-session lookup
across macros).

A test that fails while a run it started is still going stops that run and
waits for it, and waits for every block it left running, before its
directories go. The person's shell blocks make their temporary directories
under the test's own `TMPDIR`.

### What the persona's own tests hold

The prototype's persona-side cases need no orchestrator. Each stays with the
persona test that holds it:

| Case | Test |
|---|---|
| An operation begun before activation (an entry, no record) | `tests/persona-pipeline/test-persona-operation-lifecycle.mjs` ("an entry opened before activation counts open; …") and the prototype's last acceptance case |
| A writer cleared by the owner while it waited | `test-hold-resume-peer-operation.mjs`, `test-hold-gate-operation.mjs` ("cleared by the owner while it waited …") |
| A commit whose archive failed | `test-hold-commit-operation.mjs` ("a commit whose archive gate fails stays open for the next Stop") |
| The Stop orphan sweep beside a held lane | `test-hold-writer-inventory.mjs` ("the orphan sweep from another lane's session leaves a held lane's child") |

### Findings

- **Where the hold meets the dispatch.** The scripted worker creates the
  child directly. It publishes no dispatch mark, so it opens no operation. A
  hold set before that create makes the persona refuse it as a write of a
  held lane's child outside an operation, and the step ends `worker-failed`
  (measured). The real `/orchestrator:next` meets such a hold earlier, at its
  hold gate before the mark. After the mark, the engineer's bootstrap
  continues the mark's operation, and the handoff waits for it.
  `tests/orchestrator/test-next-holds.mjs` holds both. So the cases above set
  the hold once the step has recorded its child's next step, while the step
  is still running. The step then runs to its end, as item 4 says.
- **A branch is not worked ahead of its dispatch here.** A pending
  subtask's branch is taken up at the baseline's tip, or at the tip a
  consumed release of its current hold recorded when that tip contains the
  baseline (ADR-0062 Decision 2, amendment of 2026-10-27; row 12 of
  `judgeSubtask` in `lanes.mjs`). That path is tested in
  `tests/orchestrator/test-autopilot-holds-cli.mjs`, not run here: in the
  no-child case the person leaves no commit on the branch.
