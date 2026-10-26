# The hold takeover prototype (ADR-0068 Decision 2, item 10)

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

## What runs

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

## Acceptance

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

## Findings

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
