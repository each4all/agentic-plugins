# Runbook — the shared state root cutover (ADR-0067 SR)

This is the operator's procedure for
[ADR-0067](../adr/0067-autopilot-worktree-lanes-and-proposals.md) Decision 4,
item 4: turning shared creation on once per repository, after first moving
into the default state root every macro that lives in a linked worktree's
own state, with its children. It also covers the rollback, which exists
until lanes first run, and the repairs the writers' refusals point to.

The **default state root** is where git placed the main worktree: the parent
of the git common dir. Before the cutover, every checkout creates records in
its own `.agentic-plugins/state/`, as it always has, and SR's writers already
*find* records in the read set (the default state root, then the checkout).
The cutover changes where records are *created*: from then on, under the
default state root, with a dispatched child beside its macro (Decision 3).

All commands below are orchestrator's state script,
`node <orchestrator>/scripts/state.mjs`, written `state.mjs` here, unless
they name another. Run each in the **main checkout**, the one whose `.git` is
the repository's git dir: the cutover commands refuse anywhere else.

## What moves, what stays

`state.mjs cutover --repo-root <main checkout> --plan` lists it, read-only:

- each macro in a linked worktree's own orchestrator home (`workflows/`);
- every engineer workflow, active and archived, in the own homes of the
  worktrees other than the main one, whose `parent_workflow` is one of those
  macros or a macro already under the default state root;
- the peer-run ledgers each moved workflow names (`ensemble_results`,
  `pending_ensemble`), from its home's `peer-runs/`.

Everything else stays: workflows of no macro, archived macros, and each
checkout's handoff slot and runtime state, which belong to the checkout
(Decision 1(a)). There are no consensus task files to move yet.

Each entry is a pair, `source` → `destination`, with the checkout it came
from. A repository where no linked worktree's own home holds a macro, or a
child of a macro under the default state root, has an empty set: skip steps 3
and 4.

## The cutover

1. **Make the repository quiet.** Every orchestrator Stop hook snapshots
   every macro of its checkout, and a writer still on the old tuple looks
   only where the files were.
   - Stop any autopilot run on the macro: `/orchestrator:autopilot status`,
     then `/orchestrator:autopilot stop`, in the checkout it was launched in.
   - No peer ensemble may be pending on the macro or its children: collect
     or settle each first.
   - Close every Claude Code and Codex session in every checkout of the
     repository.
2. **Install the release tuple on both hosts**: engineer, founder, designer
   and orchestrator at or above the SR release; runtime and attention at or
   above the RR release. Where Claude Code's marketplace is a directory at a
   checkout of this repository, bring that checkout to the release's commit.
   Move the autopilot home's version pins to the tuple. Verify the installed
   versions on both hosts before going on.
3. **Check that the destination can take it.**
   - `state.mjs state-root --repo-root <main checkout>` reports the
     attestation checks (`attestation.ok`) and `default_root_writable`. When
     either fails, the repository has no shared root: stop here.
   - `state.mjs cutover --repo-root <main checkout> --plan` prints the pairs
     and every refusal, and exits 1 when there is one. Resolve each, then plan
     again until it exits 0:
     - `attestation-failed`, `root-unwritable`: as above.
     - `source-legacy-home`: run `runtime:migrate` in that linked worktree.
     - `destination-legacy-home`: run `runtime:migrate` in the main checkout.
     - `pending-ensemble`: collect or settle the run.
     - `branch-key`: two active workflows of one plugin on one branch key
       (below, "Two active workflows on one branch").
     - `name-exists`, `duplicate-destination`: a file is already where one
       would go. Find out which is the record and archive or remove the
       other; never overwrite.
     - `ledger-claimed`: an interrupted prune left a claim; run the peer
       runner's `sweep` in that checkout, which puts it back.
     - `branch-unknown`, `run-id-invalid`: a damaged record; repair it first.
4. **Plan, then move.**

   ```sh
   node <orchestrator>/scripts/state.mjs cutover --repo-root <main checkout> --move
   ```

   It plans again, writes the manifest to
   `.agentic-plugins/runs/cutover/<stamp>.json` under the main worktree, then
   renames each pair and appends its `moved` record. A workflow file moves
   under its own write lock, an archived file or a ledger under the creation
   locks. It only renames: a pair on two filesystems is refused, and nothing
   is ever copied or overwritten. At the end no source path may exist. The
   one case where it does not plan again is a move that was interrupted
   (below).

   Run it again whenever a macro, or a child of one, has come into a linked
   worktree's own home since, before step 5 or after it (a session whose
   `AGENTIC_STATE_BASE` names that checkout, or one still on the old tuple):
   it plans again, moves that set under a manifest of its own, and `--verify`
   reads every manifest. With nothing new it writes no manifest.
5. **Turn shared creation on**, with the versions verified in step 2:

   ```sh
   node <orchestrator>/scripts/state.mjs shared-creation --repo-root <main checkout> --enable \
     --versions '{"claude":{"orchestrator":"<v>","engineer":"<v>",…},"codex":{…}}'
   ```

   It appends the inventory (every workflow id then under the default state
   root) to the cutover's manifest, or writes a manifest holding only the
   inventory when steps 3 and 4 were skipped, and then writes the switch.
6. **Verify**, with the new tuple:

   ```sh
   node <orchestrator>/scripts/state.mjs cutover --repo-root <main checkout> --verify
   ```

   It exits 0 when the switch is on; every moved macro still active resolves
   by its id and by each subtask branch from every checkout, and its plan is
   one `next-ready` works from (not a schema 1.0 plan); every moved macro
   archived since is in the default state root's `archive/` and resolves as
   active from no checkout; no source path of the cutover's manifests has
   come back; and no linked worktree's own home holds an active child of a
   macro under the default state root. It judges from the default state root
   wherever it runs: run it from the main checkout and from the home
   worktree. It reads every cutover manifest not rolled back, so a move whose
   enable was interrupted and rerun (which leaves the inventory in a manifest
   of its own) is still checked. Then run the autopilot preview from the home
   worktree and check that it shows the same subtask states as before.
7. **Relaunch.**

A moved child whose macro moved too keeps a recorded `parent_workflow_path`
that names no file now; its writeback takes the candidate search and finds
the macro under the default state root (Decision 3).

### If the move is interrupted

Run `--move` again. It continues the newest manifest without an inventory
while a pair of it is still at its source, and judges every pair before it
moves any: a pair at its source only is moved, one at its destination only
is recorded as moved. A pair found at both ends (a copy) or at neither (a
loss) is refused and named, and nothing moves until you resolve it by hand:
keep the copy that is the record, or find the lost file. A move interrupted
after its last rename has no pair left at a source: the rerun records in that
manifest each pair it finds at its destination and has no record of, then
plans again.

To go back instead (a permission error that keeps the move from finishing,
for one), roll it back before step 5: the rollback reverses the open
manifest by the same rule with each pair swapped.

## Rollback

Rollback exists only until lanes first run: the driver records its first
lane's creation in the switch file (`lanes_first_run_at`), and from then on
the rollback refuses and problems are repaired forward. Make the repository
quiet first, as in step 1.

1. **Plan:**

   ```sh
   node <orchestrator>/scripts/state.mjs cutover --repo-root <main checkout> --rollback --plan
   ```

   It finds every record under the default state root's homes, active and
   archived, by its workflow id, and where it goes back, into the same kind
   of directory it is in now:
   - a record the cutover moved goes to the checkout the cutover's manifests
     name as its source;
   - a record in the inventory that was not moved stays: it lived in the main
     checkout before;
   - a record in neither was created after the switch: it goes to the
     checkout its `repo_root` names, unless that is the main one.

   A cutover interrupted before step 5 is reversed from its manifest: each
   pair it moved goes back to its source, and a pair it never moved stays.

   Each record takes its ledgers with it. It refuses, and changes nothing,
   when lanes have run (`lanes-have-run`), when a record's checkout is gone
   (`checkout-gone`) or is a lane (`checkout-is-lane`), when a destination
   exists (`name-exists`), when an active macro and a child it still needs
   (an active one, or an archived one that a subtask not yet completed,
   deferred or abandoned names) would end in two checkouts
   (`macro-child-split`: land and record that subtask, or finish or detach the
   child, first), when a record would go into a checkout whose other home of
   that plugin holds state (`destination-two-homes`: run `runtime:migrate`
   in that checkout first), when a ledger a record names is claimed by an
   interrupted prune (`ledger-claimed`: run the peer runner's `sweep` in the
   main checkout, which puts it back), and when an interrupted cutover's pair
   is found at both ends or at neither (`pair-copied`, `pair-lost`: as for a
   rerun of the move).
2. **Move:** the same command with `--move` instead of `--plan`. It plans
   again, writes its own manifest (`kind: rollback`), turns shared creation
   off, and moves by the cutover's rules and locks. A rerun continues it. At
   the end it marks the cutover manifests it reversed `rolled_back_at`, so a
   later cutover starts afresh.
3. **Reinstall the old tuple** on both hosts. It must not run while any
   record the rollback sends to a linked worktree is still under the default
   state root.

## Two active workflows on one branch

One active workflow per branch key (a macro's is its integration branch,
`git_baseline.branch`) holds across a checkout's read set. When two exist,
the readers in every checkout that sees both report the ambiguity, and the
writers refuse every write to either from those checkouts. RR's collision
check (`scripts/check-state-collisions.mjs`, in
[shared-state-readers.md](shared-state-readers.md)) lists the pairs between
the main checkout and a linked worktree; the cutover plan's `branch-key`
refusal also lists pairs between two linked worktrees and within the set.

The owner decides which of the two to keep. Then, with the repository quiet:

- **To keep the linked worktree's**, archive the main checkout's from the
  main checkout. The main checkout's read set holds only its own home, so the
  write is allowed there:
  `node <engineer>/scripts/state.mjs detach-archive --workflow-path <file> --host claude --repo-root <main checkout>`.
  A macro follows the same read-set rule: `/orchestrator:finalize` or
  `/orchestrator:abort`, run in the main checkout.
- **To keep the main checkout's**, archive the linked worktree's copy by
  renaming it into its own home's `archive/`. Every command refuses that
  copy, from every checkout, while its twin exists (its read set holds both),
  so the rename is done by hand, as archive does it:

  ```sh
  mkdir -p <linked worktree>/.agentic-plugins/state/<plugin>/archive
  mv <linked worktree>/.agentic-plugins/state/<plugin>/workflows/<file> \
     <linked worktree>/.agentic-plugins/state/<plugin>/archive/<file>
  ```
- **Two linked worktrees**: the read set of the main checkout holds neither
  linked home, and that of each linked worktree holds its own copy alone.
  - An engineer workflow: archive the one not kept from the main checkout,
    with the `detach-archive` command of the first case.
  - A macro: run `/orchestrator:finalize --workflow=<id>` or
    `/orchestrator:abort --workflow=<id>` in the linked worktree that holds
    the copy not kept. Only that checkout resolves its id, and the next Stop
    there archives it. From the main checkout the id resolves to nothing, and
    from the other linked worktree every write to it is refused.

Then run the collision check, or `cutover --plan`, again.

## One workflow held by two files

A workflow id held by two files (a copy) refuses every write to either:
`Ambiguous … workflow storage: <name> is held by 2 files`. One of them is a
copy made by hand or by an interrupted move done without the manifest.
Compare the two (`updated_at`, the phase notes) and remove the stale copy;
when the cutover's manifest names the pair, its `--move` rerun reports it as
`pair-copied`, and the destination is the record.

## The shared-creation switch cannot be read

`.agentic-plugins/state/shared-creation.json` under the default state root
that cannot be read or parsed refuses every creation, with a diagnostic,
rather than guess. Restore it as `shared-creation --enable` wrote it:
`schema` `agentic-shared-creation-1.0`, `enabled`, `enabled_at`,
`attested_checkout`, `versions`, `manifest` (the cutover's manifest, under
`.agentic-plugins/runs/cutover/`) and `lanes_first_run_at`. Do not delete it
to get past the refusal: an absent switch is off, and records already
created under the default state root would no longer be where new ones go.
