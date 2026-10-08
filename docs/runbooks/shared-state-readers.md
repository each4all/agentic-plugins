# Runbook — installing the shared-state readers (ADR-0067 RR)

This is the owner's procedure for
[ADR-0067](../adr/0067-autopilot-worktree-lanes-and-proposals.md) Decision 4,
item 1: the release of runtime and attention that reads workflow records from
the shared state root (macro subtask RR). It covers the collision check that
comes before the install, and what changes after it.

## What changes

From this release on, runtime's workflow readers in a checkout read the
**read set** (Decision 1(a)): the default state root, where git placed the
main worktree, then the checkout's own homes when they differ. These readers
are the entry brief (`runtime:context entry-brief`, and the SessionStart line
attention relays), `runtime:dashboard` and `runtime:doctor`. They read
`workflows/` and `peer-runs/` of the engineer, founder, designer and
orchestrator homes.

- **From a linked worktree** they see a workflow stored under the main
  worktree as well as one in the worktree's own home. Its pointer is spelled
  relative to the state root it was found under
  (`.agentic-plugins/state/<plugin>/workflows/<file>`), never absolute or with
  `..`. Resolve it in the read set: under the main worktree first, then in the
  checkout.
- **In the main worktree, or in a repository with no linked worktree,** the
  two locations are one, and nothing changes.
- **Per checkout, as before (W9):** each home's `last-session-handoff.json`
  and its markers, runtime's session capture and entry capture, and
  `.agentic-plugins/runs/`. Attention's Stop relay reads only its own
  checkout's handoff slot, as it always has, and the line its SessionStart
  hook relays comes from runtime: RR changes no attention behaviour, so the
  attention version installed before RR serves it.
- **Nothing is created or moved.** Where records are created changes later
  (SR, then the cutover's shared-creation switch).

A branch key or workflow id held by two files in one read set is
**ambiguity**, and so is one pointer spelling naming a different file under
each root, a spelling reached through a symlinked home included. The entry
brief then reports the workflow source `indeterminate` and leads with
nothing; the dashboard and doctor report the namespace's storage
`ambiguous`, naming both files. A macro's branch key is its
`git_baseline.branch`, its integration branch. A `workflows/` directory in
the read set that exists but cannot be listed degrades the entry brief as
well, and the dashboard and doctor report that ledger `blocked`, as they do
an unlistable `peer-runs/` directory.

## Before installing: the collision check

Run it before the release is installed on either host, and before a
directory marketplace checkout is updated to a commit that contains it. On a
machine whose Claude Code marketplace is a directory at a checkout of this
repository, updating that checkout *is* the install (Decision 4, item 3).

1. **Run the check from a checkout that has the release commit and is not
   the marketplace checkout.** It reads every checkout of the repository and
   writes nothing:

   ```sh
   node <checkout with the release>/scripts/check-state-collisions.mjs --repo <any checkout of the repository>
   ```

   When no such checkout exists, make a temporary one and remove it after:

   ```sh
   git -C <any checkout> worktree add --detach <tmp dir> <release commit>
   node <tmp dir>/scripts/check-state-collisions.mjs --repo <tmp dir>
   git -C <any checkout> worktree remove <tmp dir>
   ```

2. **Read the result.** Exit 0 prints `no collision`. Exit 1 lists each
   collision: the checkout whose readers would see it, the namespace, the key
   (`branch`, `workflow_id`, or `pointer`: one relative path naming a
   different file under each root) and its value, and each file with its
   location (`default-state-root` or `checkout`). It also lists each
   `unreadable` workflow file, whose branch could not be read, and each
   `workflows/` directory that could not be listed: the readers degrade on
   them as on a pair, so repair or archive them too. Exit 2 is a usage error
   or a failed `git worktree list`.
3. **Resolve each collision**, keeping one file of each pair: finish the other
   workflow, finalize or abort its macro (`/orchestrator:finalize`,
   `/orchestrator:abort`), or archive it (`/engineer:resume`, which offers
   the archive). Move nothing between checkouts by hand: that is the
   cutover's job, with its manifest (Decision 4, item 4).
4. **Run the check again** until it exits 0, then install the release on both
   hosts, or update the marketplace checkout.

A collision left in place does not corrupt anything: the readers in that
checkout report it and stop leading until one file is gone. Writers do not
read the read set before SR.

## Rolling back

Reinstall the previous runtime and attention, or return the marketplace
checkout to its previous commit. The readers wrote nothing, so there is
nothing else to undo.
