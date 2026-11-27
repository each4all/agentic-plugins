# ADR-0059 history: Runbook argument transport — the text reaches the CLI as a written file, and the shell never sees it

This file is the record: amendments, implementation notes and superseded text
of [ADR-0059](../0059-runbook-argument-transport.md), each as it was
written. The ADR states the current decision (ADR-0070). The amendments and
observations dated before this file was opened stay in the ADR, as they were
written there.

## Amendment 2026-11-25 — which directories a runbook may remove, and how (C175)

*Status: Proposed. The first of two slices (subtask `tmpdir-adr` of macro
`macro-plan-20261120T224328Z-9b3901`); the second, `tmpdir-adr-lifecycle`,
decides when a block releases its directory. Implementation (`tmpdir-cli`)
waits for the owner's acceptance of both.*

**Why.** The amendment of 2026-10-10 said a runbook block never deletes the
text file it passes: a headless run can deny `rm`, and one next-action file
feeds two CLIs. Each command therefore leaves its `mktemp -d` directories
under `$TMPDIR`. On 2026-11-06 the owner's macOS machine held 223,067 entries
in `$TMPDIR` after seven days, and its file-event daemon took 22 GB of memory
until a reboot (docket C175). Three causes were found; tests that leaked
their temporary directories and the autopilot run's directories were closed
by ADR-0033 (amendment of 2026-11-10) and ADR-0068 (Decision 5, item 13,
amendment of 2026-11-10), which gives each autopilot step and check a
`TMPDIR` of its own and removes it. The third remains for every session that
is not an autopilot step: a runbook's `agentic-text` and `agentic-op`
directories. After the reboot, `agentic-op` (41) and `agentic-text` (22) were
the two most common prefixes in `$TMPDIR`.

Measured at base `848f45e6` (2026-11-25), by `git grep` over `plugins/` and
`persona-pipeline/`, generated copies included:

- 206 lines make an `agentic-text.XXXXXX` directory and 24 an
  `agentic-op.XXXXXX` directory, in 110 files (73 under `plugins/`:
  designer 20, engineer 22, founder 19, orchestrator 12).
- The files a block writes into such a directory, as the runbooks spell them
  after `$TEXT_DIR/`, `$OP_DIR/` or `$DISPATCH_DIR/`, have more than 40
  names, some of them built from a prefix (`subject-<package>`,
  `body-…`). Beside a prompt, the dispatch block writes
  `prompt.xml.dispatch.json` before it launches the runner, and redirects the
  runner's output to `prompt.xml.run.json` and `prompt.xml.err`.
- The peer consultation (`peer-now`, the persona-pipeline regions
  `peer-now-dispatch` and `skill-peer-now-dispatch`) makes its operation
  directory inside its text directory, `mkdir -m 700 "$TEXT_DIR/op"`. Every
  other entry the runbooks name is a file.
- An operation directory holds `operation.json`, which the persona's
  `state.mjs` writes aside and renames over (`holds.mjs`,
  `writeOperationTransport`), so a write cut short can leave a
  `operation.json.<pid>.<hex>.tmp` beside it. The transport's `state` is
  `opening`, `open` or `closed`.
- Peer snapshots (`<persona>-peer-snapshot-…`) and review captures
  (`review-capture-…`) are made by `mkdtemp` directly under the first of the
  resolved temporary directory and `/tmp` that resolves, lies outside the
  checkout and needs no XML escaping (`peer-snapshot.mjs`, `snapshotBase`);
  no runbook names either as a directory it writes into.

**Decision.** [Decision 9](../0059-runbook-argument-transport.md#decision-9),
as the ADR states it. In short: the directory is made by a CLI, under
`$TMPDIR` with no fallback when it is set, with a marker binding it to its own
basename, device and inode and to its parent's (a top-level directory's root
by real path and identity, the nested `op`'s text directory by identity); the
release takes only the canonical path the make printed, or the `.removing-`
path a release's report gave for it, proves the directory
the user's own, no link, its parent spelled canonically, and named by its
marker, reads the marker and `operation.json` without following a link,
allows files, links and one `op` directory (marked, or empty), and refuses
any operation not `closed` or whose transport does not name this directory's
marker id, judging an absent transport by this directory's file alone (no
operation opened there, a first write that died before its rename, or an
earlier release's unlink); the first write records the marker id only from a
valid marker and, in a directory without one, proceeds as today with no
field, which no release then removes (an empty unmarked `op`, which holds no
transport, still goes with its proven parent); it claims the directory by an exclusive `mkdir` of
`.removing-<name>` and a rename onto that placeholder, checks again, renames
back only from its own claim, removes the marker last after a fresh listing,
never recurses, never removes a top-level directory with no marker, and
reports `removed`, `absent`, `not-owned`, `refused`, `contention`, `error`,
`claimed` or `partial`. The make fails on Windows.

**How the draft changed after plan-verify.** The Codex peer's review (run
`plan-verify-20261125T080832Z-07bc98`, verdict concerns, nine MAJOR and two
MINOR findings) changed the first draft in these respects, each checked
against the code it cited:

- The nested operation directory is now the one slot `op`, made by the CLI
  inside a proven text directory, its marker bound to that parent, released
  only with it. The first draft judged no name and allowed any marked child.
- The marker and `operation.json` are read without following a link, with
  one link and a size bound, and the transport is validated in full;
  reports carry fixed reason codes. The draft would have read through a link
  (`holds.mjs` `readRegular` opens before it looks at the type) and could have
  accepted another directory's `closed` record.
- `opening` and `open` are stated as possibly stale (`state.mjs` keeps
  `opening` before it publishes, and a close's last transport write can fail
  after the workflow closed), left for the second slice to reconcile.
- The release claims the directory before it judges the operation, and
  renames it back on a refusal. Checking first, as the draft did, let a
  first write install `opening` between the check and the rename.
- The make writes its marker aside and renames it in, so a failed make
  leaves no partial marker; an empty marker-less `.removing-` directory, left
  by a kill after the marker's unlink, is removed with `rmdir`, which removes
  no content. The draft promised a retry the marker could not give.
- The path is refused, not normalized, when it holds `.`, `..` or a doubled
  separator, and the marker binds the parent's real path; `TMPDIR` set but
  unusable fails the make instead of falling back to `/tmp`. The draft
  normalized and accepted any of three roots at release time, so a changed
  `TMPDIR` could strand a directory and a fallback could escape a bounded
  root.
- `contention` and `error` are outcomes of their own, and `partial` tells
  the entries this release unlinked from those it found gone.
- Item 6 hands the second slice the late readers the peer named:
  `/orchestrator:next` reads its text directory in its exit trap, and a
  finalize's `DISPATCH_DIR` may name a peer run's ledger directory.
- The ADR gained its `## History` list, and the Status names the proof and
  the removal as separately Proposed.

**How the draft changed after the first critique.** The critique (run
`review-20261125T081734Z-284c9f`, verdict concerns, ten MAJOR findings, three
of them agreed by both reviewers) changed it in these respects:

- The nested `op` marker binds its parent text directory by device and inode
  only. The draft bound it by real path, which the claim's rename changes, so
  every text directory holding a closed `op` would have been refused.
- The draft's `rmdir` of an empty marker-less `.removing-<form>` directory is
  gone: once the marker is gone there is no root to judge it by, and a name
  and emptiness are not a proof. Such a directory, left by a kill before the
  last `rmdir`, is the second slice's, with the other marker-less
  directories. An empty marker-less `op` inside a claimed text directory
  whose marker holds is still removed, under its parent's proof, and the
  nested make now writes its marker's aside file in the parent so an
  interrupted make leaves `op` empty.
- The claim, and the rename back, first find the target name free; the
  remaining window between check and rename, where `rename(2)` can replace
  an empty directory, is stated, as is Windows' refusal to replace. A check
  that fails after the claim reports its own outcome, and a directory that
  cannot be renamed back is the new outcome `claimed`, not `partial`.
- Concurrent releases: the claim is stated exclusive and finishing not, with
  why the second is safe.
- The proof's limit names what it cannot tell apart: another valid
  directory of the same kind. The second slice carries the path's identity.
- A `closed` transport must have opened no earlier than the directory was
  made. What an absent transport may mean, and that the holds' external
  record is not the release's, are stated.
- Interrupted makes are named and left to the second slice; the parent's
  path is compared as a string with its real path, so a linked ancestor is
  refused; Windows fails the make (Node reports uid 0 there).
- "Every write that names the old path fails" was too strong: an agent's
  file tool recreates missing parents. Item 4 states it, and item 6 gives
  the second slice two more constraints (no writer after a release; an
  operation directory outlives a rerun of its closing write, which reads
  the `closed` record).
- Item 6's rollout rule is marked Proposed, and Decision 9 has an anchor.

**How the draft changed after the first refine-verify.** The Codex peer's
verification (run `refine-verify-20261125T082849Z-809c86`, verdict concerns)
found five of the ten findings resolved and named new defects, each checked
against the code:

- The claim and the rename back make an empty placeholder with an exclusive
  `mkdir` and rename onto it, so the only directory `rename(2)` can replace
  is the release's own; the first fix had only stated the window between an
  `lstat` and the rename. The claim's exclusivity now comes from that
  `mkdir`.
- Only the release that made the claim renames back, and only when the
  claimed directory's own checks still hold; a finisher never renames. The
  first fix let a finisher move an unproved entry, or an emptied directory,
  back to the original name.
- `operation.json` names its directory's device and inode, recorded by the
  first write, in place of the first fix's `opened_at` comparison, whose
  whole-second times (`state.mjs`, `isoUtc`) could neither refuse a record
  from the same second nor be compared with a finer marker time. A
  transport from an older `state.mjs` refuses.
- The second slice's constraint on a closing write's rerun was wrong: with
  the directory gone, the write fails on the missing directory
  (`state.mjs`, the operation-directory check) before it reads any
  transport, and its message advises running with no operation directory.
- An empty `op` with no marker is removed because the parent's proof covers
  its container's entries by type, as it covers files, not because an
  interrupted make is assumed to have left it.
- Item 5 says which outcome an unreadable control file gives (`error`) and
  which a failed check gives, what `claimed` reports when no rename ran, that
  a report's path is the one at its end, and that a failed last `rmdir`
  leaves a directory no release finishes; a recreated original name no
  longer blocks finishing, since the report gives the `.removing-` path.
- The close writes `closed` even when its removal of the external record
  failed (`afterWrite` catches it); item 3 says so. Item 7 says the proof
  sees only the transport file's operation.
- History: the args reader resolves the path again rather than keeping the
  read file's identity; peer snapshots may fall back to `/tmp`.

**How the draft changed after the second refine-verify.** The peer's second
verification (run `refine-verify-20261125T083426Z-6d9e28`, verdict concerns)
found the rerun constraint, the empty `op` rule and the minor findings
resolved; what remained came from releases of one directory running at once:

- A finisher beside the claimer, or a second finisher, could rename back a
  partly emptied directory or `rmdir` a later claim's placeholder. Item 4
  now says only the start is exclusive, and makes one release of a
  directory at a time the caller's precondition, like keeping writers away;
  item 6 hands it to the second slice. A lock to serialize finishers was
  not added: it would be one more entry a kill can strand, for a case only
  two blocks sharing one path produce.
- The transport names the marker's random id in place of the directory's
  device and inode, which the file system reuses: a `closed` record restored
  into a later directory at the same inode passed.
- Item 5 states the precedence of `claimed` after a release's own claim, the
  `error` of a failed placeholder `mkdir`, a placeholder its cleanup could
  not remove, and that a report judging `<name>` gives a `.removing-`
  sibling's path.

**After the third refine-verify.** The peer's third verification (run
`refine-verify-20261125T083904Z-fdc7d5`, verdict concerns) found every open
item resolved but a rename back's placeholder cleanup, and raised a backup
restore of a released directory at a reused inode, which passes every check.
The restore is stated as a limit in item 7 rather than fixed: it is a
hand-made state, rare by the owner's rule of 2026-10-25, and what a release
loses there is a copy of a directory the CLI made. The wording fixes it
named (the `.removing-` path a report gives is accepted as input, the
`absent` of a `.removing-` path, a second release that looks up after the
claim, the rename back's leftover placeholder) were made after it, and are
for the next critique to judge.

**How the draft changed after the second critique.** The second critique (run
`review-20261125T084458Z-ac244c`, verdict concerns) reopened none of the first
critique's findings and raised one MAJOR on the path every macro lane takes
during the rollout: item 3 had the first write record the operation
directory's marker id, but never said what that write does in a directory
with no marker, which is every `mktemp -d` directory until the runbooks
switch, so an implementation could have refused every such write. Item 3 now
says the write records the id only from a marker that passes the checks, and
otherwise opens, carries and closes the operation as before with no field,
and that no release removes what such a write wrote: a top-level directory
fails its marker check and a nested `op` holding the field-less transport
fails the operation or entries check, while an empty unmarked `op`, which
holds no transport, still goes with its proven parent. The refine-verify of
this change (run `refine-verify-20261125T085132Z-14bf84`, verdict concerns)
found every finding resolved and only that clause too broad at first, which
was narrowed as above after it. Its MINOR findings were taken
too: item 1 is marked Proposed with the constraints item 6 hands on, item 1
names the marker (an autopilot scratch root's `.scratch.json` is another
file), item 5 gives `removed` and `absent` their shared status 0 and makes a
second release's success conditional on both names being gone, item 6 names
the bullet and the `AGENTS.md` sentence it folds, and this record's summary
and inventory gained the `.removing-` input, the absent-transport branch and
the review-capture directory. Two MAJOR findings on rare paths (an
unreadable or mismatched nested `op` marker after the claim, stated three
ways; a listing failure after unlinks began, read as both `error` and
`partial`) were deferred as known limits under the round-2 rule: each
reading fails closed, and nothing is removed that the proof does not cover.

**Alternatives considered.**

- **The name and the location, as the args reader judges them.** Rejected
  for these directories. The args rule holds because the directory holds
  one file of one known name at a path the reader was just given: after
  the read, whether or not it succeeded, it resolves that path again and
  compares the file there by device and inode with the one it removes. A
  text
  directory holds an open set of files, and its path is what a model
  transcribes from one call to the next: a wrong path that happens to have
  the form, or a user's own directory renamed into it, would lose the files
  in it.
- **A list of the entry names a release may delete.** Rejected. More than 40
  names, some built from a prefix, change with each runbook; a name missing
  from the list would keep the directory, and the list would tie the release
  CLI to every runbook's text. The entry's type is what bounds the harm: an
  unlink never follows a link, so a file or a link is removed by its own
  name only, and a directory is removed only when it is proven in turn.
- **A token the make prints and the release is given back.** Rejected. The
  token would travel between blocks the way the path does, by transcription,
  or sit in the directory it is meant to prove. The marker's device and
  inode bind the proof to the directory without anything to carry.
- **A marker that names only its kind.** Rejected: a marker copied into
  another directory, or written there by an agent's file tool, would prove
  that directory. The device and inode it records are the directory's own.
- **A recursive removal.** Rejected: one level of marked operation directory
  is all a runbook makes, and a recursive removal of a wrong path is the
  failure the proof exists to prevent.
- **Emptying the directory in place, without the rename.** Rejected. A
  writer that still names the path could add a file after the release listed
  the directory, and its `rmdir` would fail with the marker already gone.
  After the rename a writer that opens a file under the old path fails, and
  a removal cut short is found by its name and finished under the same
  proof; a writer that creates missing parents, as an agent's file tool
  does, recreates the old name as a new unmarked directory instead, which is
  why keeping writers away stays the caller's precondition. The parts are borrowed from
  ADR-0068 (Decision 5, item 13) for an autopilot run's scratch: a marker
  made with the directory, the path judged before the file system and a
  `.removing-` rename before the contents go, from its step and check
  directories (which it then removes with what they hold); the marker last
  and no recursion, from its run root (whose index gives it a recovery this
  decision does not have).
- **Leaving it to the autopilot's per-step `TMPDIR`.** Rejected: that bound
  covers autopilot steps and checks only. An interactive session, or a Codex
  session, runs the same runbooks under the user's own `TMPDIR`.

**What it changes elsewhere, at acceptance.** ADR-0068 Decision 5, item 13
opens with "ADR-0059 stands as written: a runbook's directories are bounded
by where they are made, not by a block that deletes them." Under an
autopilot run that bound stays; once both slices are accepted and the
runbooks release their directories, that sentence needs a cascade, and so
does Decision 2, item 7, which says the first-write block makes the
operation directory with `mktemp -d`. Neither is edited here, since this
amendment is Proposed. The `AGENTS.md` paragraph on
writing a runbook block ("Nothing in such a block deletes the file") changes
with the second slice.

**The layout.** ADR-0059 had no history file. This amendment opens one and
states the new decision in the ADR's Decision section with its dated marker
(ADR-0070, Decision 1, item 4). It does not move the ADR's earlier in-file
amendments and observations: ADR-0070 is Proposed, and the ADR-0023 history
opened on 2026-11-22 did the same.

**Not measured.** No CLI was written: whether `lstat` reports a usable owner
and inode on each platform the runbooks run on (Windows under Git Bash in
particular), and how a sandbox treats a rename inside `$TMPDIR`, are for the
implementation to measure (item 6 requires the sandbox measurement before
any runbook switches). Item 2's failed make on a platform without them is
the decision's answer if it does not.

## Amendment 2026-11-26 — when a runbook releases its directories (C175)

*Status: Proposed. The second of two slices (subtask `tmpdir-adr-lifecycle`
of macro `macro-plan-20261120T224328Z-9b3901`); implementation
(`tmpdir-cli`) waits for the owner's acceptance of both.*

**Why.** Decision 9 says how a directory is made and removed, and leaves the
rest to this slice (its item 6). That item asks when a block calls the
release, what a failure keeps, how a release that follows a success is
reported, what a runbook does where the make fails, and what becomes of
directories that no release reaches. Without answers, a runbook either
keeps every directory, which is the C175 growth, or removes one that a later
block still reads.

Measured at base `4c1ff2ef` (2026-11-26), by `git grep` over `plugins/` and
`persona-pipeline/regions/`:

- 205 matching lines in 107 files name an `agentic-text.XXXXXX` directory,
  and 24 matching lines in 13 files an `agentic-op.XXXXXX` directory. These
  are matching lines, not makes: some of them are prose.
- 36 of those files open two or more blocks with a `TEXT_DIR='<…>'` line,
  and 32 of them repeat the same literal, each block a separate shell call
  reading the same directory. `/orchestrator:next` has 10 such blocks in its command and 9 in
  its skill. `/orchestrator:plan` has 5 in its command.
- A persona finalize reads three directories: its own text directory, the
  dispatch's (`DISPATCH_DIR`) and the operation directory (`OP_DIR`). Its
  rerun after a failed later step reads all three again
  (`verb-finalize.md`, "Running the block again"). `DISPATCH_DIR` is empty
  when no run launched and may name a run's ledger directory, so it cannot
  be the release's handle.
- The commit step answers a refused subject or body (exit 9 or 2) by
  rewriting the file in the same directory and running the step again. A
  split that fails halfway is resumed by running the command again.
- In `/orchestrator:next`'s Phase 5, the trap function's result is the
  admission release's alone, and the block keeps the exit status it had
  before the trap ran. The runbook's wrapper around the withdrawal returns
  0 when it cannot parse the subtask (`|| return 0`).
- The last write of an operation, given a directory that is missing, fails
  with "When it is lost, run the write with no operation directory"
  (`state.mjs`, `prepareOperation`). That advice repeats the write.
- A paused `/orchestrator:next` keeps its admission id, its selection and
  its dispatch mark in its text directory, in files that are not
  `operation.json`.

**Decision.** [Decision 10](../0059-runbook-argument-transport.md#decision-10),
as the ADR states it. In short (the summary names each rule's conditions;
where it and Decision 10 differ, Decision 10 governs):

- **One rule of release (item 2).** A directory is released once, at a
  point of a path where every write and read of it on that path, and every
  cleanup the path runs before that point, has completed, and no reader of
  it is left: no later block of the path, no rerun or retry that the
  runbook, its reference or the block's own message directs from that
  state, and no continuation of the command. The rule is kept per
  directory, not per command; work a runbook repeats makes a fresh
  directory each time.
- **Releasing steps (item 1).** The runbook names a releasing step for each
  directory on each path where that rule makes it releasable, and every
  successful end is such a path; none is exempt. A path succeeds when its
  last write completes, an owner gate written by that write included; a
  path that writes nothing and exits 0 succeeds after its last read. The
  release comes after the path's last write and last read, its exit trap
  included; a file the agent would read afterwards is printed by the block
  first, or a last block does only the release. A directory that a later
  block releases reaches that block on a line of its own, apart from the
  paths the block reads. A block that makes and releases a directory in the
  same shell call (the dispatched bootstrap's topic directory,
  `/orchestrator:done`'s reason directory) releases it from the variable
  that captured the make's output, never from a path it reads.
- **Early and non-zero releases (items 1 and 2).** A directory released
  before the command ends meets the same rule there, once its last reader
  has run and no retry reads it: the bootstrap's request directory after
  `create`, a verb's in-run directories, `/start`'s bootstrap and phase
  directories, and `/resume archive`'s resolver directory once it has
  printed the workflow path. A path that ends non-zero releases only where
  no rerun can read the directory, because its block makes it afresh on
  every run (`/orchestrator:done`'s reason directory, released on each of
  its exits), or where its message says that nothing reads it again; a
  switching change that releases on such an end rewrites its message in the
  same change, unless the block makes the directory afresh on every run.
  `/orchestrator:next`'s refusals keep their directories: retention is the
  default while a later run may reuse the directory, and a switching change
  that releases on a refusal rewrites that refusal's message in the same
  change.
- **What a failure keeps (item 3).** Every other path keeps each directory
  that a remaining block, a retry or a continuation still reads: a failed
  block's rerun, a refused commit subject, body or verify request, a
  `review-held` commit, a split or a gate that stopped halfway, a refused
  archive. In an autopilot step, "kept" lasts only as long as the step's
  `TMPDIR`, which ADR-0068, Decision 5, item 13 removes once the step's
  peers are settled, subject to its guards, under which the directory can
  remain.
- **`/orchestrator:next` (items 1 and 3).** Phase 5's trap releases only
  when the writeback and the admission release exited 0 and the withdrawal
  reported one of four dispositions: `withdrawn` (removed now), `gone` (the
  lane's operation registry read `absent`, or read `ok` with no record of
  the id), `unpublished` (the mark file names no operation id) or `carried`
  (a child linked to the subtask holds the id, under that child's
  ownership). `unknown`, `unreadable`, a withdrawal that failed outright and
  a reply the block does not recognize authorize nothing, and the trap sets
  the block's exit status from these results. After a writeback that
  succeeded, recovery is cleanup only, never a rerun of Phase 5. A held
  admission is released by `admission release`. A mark of unresolved
  ownership is never cleared on that ground: once its cause is fixed, the
  withdrawal is run again with the kept mark file and the original lane
  arguments, through its ownership check, until it reports an authorizing
  disposition. The owner's `writer-clear` is only for an operation whose
  session the owner has established is gone, since a clear while it runs
  lifts the child's lane exclusion. This holds on every exit that leaves a
  mark, on both hosts, a failed writeback and an exit before it included;
  where the mark file is gone, the operation is found by its exact id and
  cleared on the same condition. A rerun of Phase 3b publishes a new mark
  only after an authorizing disposition.
- **The report (item 4).** Every release attempt, on whatever end item 2
  allows it, reports on the directory, on standard error, and nothing in
  the report asks for a repeat. `removed` and `absent` print nothing, and
  so does a release that reports `unsupported` (it changes nothing); each
  other outcome prints the directory's disposition; a release that dies or
  prints nothing readable is reported as unknown. The release's own outcome
  never changes the block's exit status.
- **The closing write (item 5).** Given a missing directory, the closing
  write writes nothing, exits non-zero and no longer advises running it
  again: it says that nothing is to be repeated if the directory was
  released after the write, names the open operations, and names
  `writer-clear` for a lost directory only with the condition above.
- **Rollout (item 8).** The CLI ships first, and its measurements come
  before any runbook switches. Each switching change lists every path of
  each directory it makes, with its release or its retention. A static
  check refuses a `mktemp -d` of a text or operation directory, or a raw
  `mkdir` of a nested `op`, outside item 4's fallback branches, holds the
  releasing steps to the list both ways, and holds each release to item
  1's input (the directory's line, or the same block's make variable).
- **Fallbacks (item 4).** A CLI that can be read and lacks the make
  subcommand, or an unsupported platform, falls back to `mktemp -d`, and
  that directory is not released. A CLI that lacks the release subcommand
  skips the release and keeps the directory; a CLI that cannot be read
  stops the block. A legacy parent directory gets a legacy `op` inside it.
  A `TMPDIR` a quoted literal cannot carry stops the block on every branch
  (`unsupported-path`).
- **Abandoned directories (item 6).** No CLI removes a directory by age on
  its own. A listing shows abandoned directories. The owner's `--execute`
  releases marked ones, each through Decision 9's full proof, on the
  owner's stated precondition that no command is running, paused or
  awaiting a retry and no other `--execute` runs; age only narrows the
  candidates, directories holding `next`'s kept files are skipped, and it
  is claim-only: it finishes a `.removing-` path only when the owner names
  that path, on the same precondition.

**How the draft changed after plan-verify.** The Codex peer's review (run
`plan-verify-20261126T025544Z-f84ac3`, verdict concerns, one CRITICAL,
fourteen MAJOR and one MINOR finding) changed the first draft in these
respects. Each was checked against the code it cited:

- **The sweep (CRITICAL).** The first draft swept automatically: each make
  released marked directories that had not been written for 7 days, at most
  8 within 500 ms. That sweep could remove a paused `/orchestrator:next`'s
  text directory while its admission was still held, and the next Phase 5
  would then abort before installing its trap. Age is not a proof that a
  command has ended. The sweep is now the owner's `--execute`, and it is
  claim-only, because two releases of one directory may finish it together
  under Decision 9.
- **Releasing steps.** The first draft named one releasing block per
  directory. The peer traced paths that never reach it: `plan`'s final
  block and its retries, `peer-now`'s standalone and failure paths, the
  Codex `next` skill's writeback in Phase 4, `/engineer:start`'s Phase 7,
  refine's owner-gate paths, and `done`'s reason file. Item 1 now puts a
  releasing step on each successful end, and makes each runbook change
  list those ends.
- **The release handle.** The first draft read the dispatch's directory
  through `DISPATCH_DIR`, which may be empty or a ledger directory. It now
  travels on a line of its own, and the make refuses a path that a quoted
  literal cannot carry.
- **`next`'s cleanup.** The release now waits for the writeback, the
  withdrawal and the admission release, each status captured on its own.
- **Gates.** "Success" now means that the last write completed. A gate the
  last write records is a success, so the commit's staging-set gate and a
  verb's owner-decision form release.
- **ADR-0068.** Item 3 bounds "kept" by the autopilot step's `TMPDIR`, which
  ADR-0068 removes after the step whatever its outcome.
- **The report.** It gives the real disposition (`claimed` and `partial` are
  not "kept"), covers a release that dies, and goes to standard error.
- **The closing write.** Its message no longer reads the workflow's open
  operations as proof of which write ran. The first draft did, and a later
  operation, or a clear before the last write, would have misled it.
- **Fallbacks.** The older-CLI and platform fallbacks gained the legacy
  `op`, the unreadable-CLI stop, and a line on the platform fallback.
- **Replay.** The claim that a missing first read guards against a replay
  was dropped: a refused release leaves the inputs readable.
- **The commit.** Its release waits for the gates after the commit, the
  terminal write and, on the close path, the archive.
- **The count.** The first draft counted `persona-pipeline/files/` too. The
  counts above are over the two roots they name.

**How the decision changed after critique round 1.** The Codex peer's
review (run `review-20261126T030420Z-4d3690`, verdict concerns, five MAJOR
findings) and a local check of every code claim changed it in these
respects:

- **`--execute` and age.** The draft selected every marked directory past
  an age, and finished a named `.removing-` path on age alone, though item 6
  says age does not prove a command ended. Age now only narrows the
  candidates; the owner's precondition is spelled out (nothing running,
  paused or awaiting a retry), directories holding `admission` or
  `dispatch-mark.json` are skipped, and item 7 states what a wrong
  precondition costs.
- **The list of ends.** Item 1 presented its bullets as the paths found,
  but missed decide's owner selection, `/start`'s bootstrap, phase and
  no-commit terminal directories, `/checkpoint` and `/resume`, the in-verb
  directories (scope close, scope record, review settle, routing gates) and
  `done`'s already-completed no-op. It also kept a directory whose last
  reader is the agent, which item 8's static check refuses. The bullets are
  now classes, the missing ends are named, no end is exempt, and item 2
  defines success for a path that writes nothing.
- **`peer-now`.** The persona's response is shown after the note block,
  from the run result in the text directory; the block now prints the
  ledger path before it releases. The orchestrator's `peer-now` has no
  nested `op`, as the bullet now says.
- **`next`'s cleanup.** `dispatch-mark-withdraw` returns 0 for `carried`,
  which also covers a child that could not be read and leaves the mark
  (`hold-ops.mjs`, `withdrawDispatchMark`); an `EXIT` trap that only runs
  commands does not change the block's status. The release now needs the
  withdrawal's disposition read as data, a `carried` from an unreadable
  child refuses it, the trap sets the status, and the mark and the
  admission each have their own recovery action.
- **An unsupported path.** The draft fell back to `mktemp -d` under the same
  `TMPDIR`, whose path the later blocks could not carry either, and item 8's
  static check would have refused the fallback. Such a `TMPDIR` now stops
  the block, and the static check exempts item 4's fallback branches.
- **The count.** 36 files have two or more `TEXT_DIR='` lines; 32 repeat the
  same literal.

**How the refine's verification changed it.** The refine-verify peer
(run `refine-verify-20261126T031445Z-f753c5`, verdict regression) found
that some of the round-1 fixes went too far or not far enough, and the
same refine corrected them:

- `/orchestrator:next`'s refusals before Phase 3b exit 1, so they are no
  success. They now release as a disposal item 3 allows, keeping their exit
  status, because the answer is a new invocation with a fresh directory; a
  refusal inside Phase 3b keeps it.
- Item 3 promised to keep every directory on failure while item 1 releases
  some early. Retention is now per directory: what a remaining block, a
  retry or a continuation still reads. Repeated in-verb work makes a fresh
  directory each time. `AGENTS.md` says the same.
- The withdrawal now reports four dispositions that authorize the release
  (`withdrawn`, `gone`, `unpublished`, `carried`) and one that does not
  (`unknown`). A mark of unknown ownership is not handed to `writer-clear`
  on that word alone, since the child may hold the operation; the admission
  is recovered on its own.
- `/resume`'s read directory and its path that skips the marker, and
  `done`'s no-op path, which runs `holds-retire` and today masks its
  status, are now specified.
- The carryability check now covers every fallback branch, not only the
  make, and the static check also refuses a raw nested `op` `mkdir` outside
  the legacy-parent branch.

**How the decision changed after critique round 2.** The second critique
(one CRITICAL, four MAJOR findings carried) found that the refine's fixes
still left a release where ownership or a reader was unknown. Two of the
findings were the rest of round-1 F4 and F2, so the refine stopped at the
recurring-finding gate; the owner ruled *fix now* on 2026-11-26, and this
change makes these fixes, all within Decision 10:

- **One rule of release (item 2).** Eligibility was defined three ways:
  "only after success" in the heading and item 2, early releases inside a
  run in item 1, and `/orchestrator:next`'s pre-Phase-3b refusals released
  as a "disposal" keyed to a "new invocation" the runbook never names (its
  Phase 2 and Phase 3b refusals both say "Rerun /orchestrator:next", and
  `next.md` says that a block run again reads what earlier phases kept).
  Item 2 now states one rule: a directory is releasable once every read and
  write of it on the path, and the cleanup before the release, completed,
  and no later block, rerun, retry or continuation reads it. A success is
  the ordinary case; the early releases meet the rule before the command
  ends; a non-zero end meets it only when its block makes the directory
  afresh on every run or its message says that nothing reads it again. The
  `next` disposal is withdrawn: every refusal there keeps its directory,
  and a switching change that releases on a refusal rewrites its message
  (item 8). The replay restriction is per directory, not per command.
- **`gone` needs positive absence (item 1).** `readOps` returns
  `unreadable` with an empty list when the lane's operation registry cannot
  be read, and `withdrawDispatchMark` reads that as no record and returns
  `gone` (`plugins/orchestrator/scripts/lib/holds-records.mjs`,
  `lib/hold-ops.mjs`). `gone` now authorizes the release only for a
  registry read `absent`, or read `ok` with no record of the id;
  `unreadable`, a withdrawal that failed outright and a reply the block does
  not recognize authorize nothing.
- **No `writer-clear` while ownership is unresolved (items 3 and 5).** A
  withdrawal that fails outright (`dispatch-mark-withdraw` throws on an
  unreadable mark file, an unresolved state root, a lock failure) fails
  before ownership is established (`plugins/orchestrator/scripts/state.mjs`,
  the dispatch-mark subcommands), and `writer-clear` records the clear
  without checking whether the child still runs. Item 3 had sent that case
  straight to `writer-clear`. Every indeterminate withdrawal is now treated
  as `unknown` is: the directory is kept, the withdrawal is run again once
  its cause is fixed, and `writer-clear` is for an operation whose session
  the owner has established is gone. Item 5's message for a lost operation
  directory carries the same condition.
- **`done`'s release no longer waits on `holds-retire` (item 1).** The
  first refine conditioned the no-op path's release on the call's status,
  but `holds-retire` exits 0 after warning that the retirement is waiting,
  unreadable or failed. The call is no reader of the reason directory, and
  a retirement not finished is retried by a later `done`, `holds-retire`,
  `status`, Stop or run. And `done` makes its reason directory afresh in its
  one block on every run, so no rerun reads an earlier one: the block
  releases it on each exit, after the admission trap's release.
- **`/resume archive` (item 1).** The resolver block reads
  `workflow-id.txt` and prints the workflow path; the archive block, after
  confirmation, is given only the path. The resolver block now releases its
  directory after printing, which covers confirmation and cancellation; a
  refused resolution keeps it for the corrected rerun.
- `AGENTS.md`'s clause now says a path releases once no later block, rerun
  or continuation reads the directory, a successful end as a rule.

The refine's verification (peer run `refine-verify-20261126T033815Z-d3880b`)
judged M2, M4 and M5 resolved and C1 and M3 partial, and found what the same
refine then fixed:

- The ownership rule covered only a writeback that succeeded. Phase 5's
  refusal for a missing `dispatch-mark.json` exits before the writeback and
  sends the owner straight to `writer-clear` (`next.md`, Phase 5). Item 3 now
  holds the rule for every exit that leaves a mark, on both hosts: the
  withdrawal is retried with the original lane arguments, and a mark whose
  file is gone is cleared by its exact id only once its session is shown
  gone; the switching change rewrites that message.
- A rerun of Phase 3b calls the withdrawal of an earlier mark without
  reading its result, then publishes a new mark, which rewrites the mark
  file (`next.md`, Phase 3b; `state.mjs`, `dispatch-mark-publish`). After an
  indeterminate withdrawal that replaces the only record of the old
  operation id. Item 3 now has the block publish only after an authorizing
  disposition.
- Item 8's list and static check named successful ends only. The list now
  covers every path of each directory (its last write, read and cleanup, its
  retry readers, release or retention), early releases and `done`'s non-zero
  releases included, and the check holds the releasing steps to it both
  ways.
- `/orchestrator:next`'s rationale was inexact: the empty-plan and
  all-terminal refusals point to `/orchestrator:plan` and
  `/orchestrator:finalize` rather than to a rerun. The text now says so, and
  that retention is the default while a later run may reuse the directory.
- The reporting summaries (both Status lines, item 4's title) and item 7's
  swap limit still spoke of successful ends and of a directory live until
  its command ends; the archive block was listed among the writes that
  release a text directory. Each is corrected.

Not changed in this refine: the round-2 MINOR findings (code descriptions,
Decision 9 item 6's "outlives the trap", history counts, item 5's scope, the
Codex skill's cleanup block, `/orchestrator:plan`'s block count), which an
autopilot refine does not carry, and the two rare-path MAJOR findings
deferred as known limits (a fallback's check after allocation; item 4's
reporting rules beside Decision 9's one-line contract).

**How the record changed after critique round 3.** The third critique (peer
run `review-20261126T034513Z-3773e3`) judged the round-2 targets resolved in
Decision 10, and found one MAJOR finding open outside it: the "In short"
summary of this section still said that every failure keeps every
directory, named the mark's `writer-clear` as a recovery action with no
condition on ownership, and limited the report to a release after a
success. A reader who took the summary for the decision would have been
advised the clear that round 2's CRITICAL removed. Round 3 was the
critique cap; on 2026-11-26 the owner granted one further round, and this
change makes these fixes:

- The summary now states the current Decision 10: one rule of release per
  directory, the early and the non-zero releases, what a failure keeps, the
  ownership-checked retry of a withdrawal, `writer-clear` only once the
  operation's session is shown gone, a report on every release attempt, and
  the rollout's list of paths.
- Decision 9, item 7 named Decision 10, item 6 for the swap limit; it is
  item 7, and the sentence now carries its dated marker.
- Decision 10, item 4 said the block's exit status stays its primary
  operation's, while item 1 has `/orchestrator:next`'s Phase 5 trap set the
  status from its cleanup results. Item 4 now says its rule is for the
  release's own outcome, which never changes the status the path's work
  set.

The refine's verification (peer run `refine-verify-20261126T040957Z-11ceeb`)
judged the pointer and item 4 resolved and the summary partial: several
bullets still dropped a condition the decision attaches (the cleanup before
the release, retries a reference directs, the evidence behind `gone` and
`carried`, the retry with the kept mark file and lane arguments, the second
`--execute`, the full proof). The same refine added each, scoped the
fallbacks and the report as item 4 does, added the autopilot bound on
"kept", the closing write's non-zero exit and the rollout's CLI-first order
and static check, and said that Decision 10 governs where the summary
differs. The first rejected alternative now rejects an unconditional
release, since `/orchestrator:done`'s fresh reason directory is the
exception item 2 allows.

Still deferred as known limits, unchanged: D1 (a Phase 3b retry after a
reselection can withdraw against another lane, since the mark file stores
no lane identity), D2 (`agentic-autopilot status` lists operations only for
lanes with hold records, so a mark whose file is gone may not be found),
M6 (a fallback's check after allocation) and M7 (item 4's reporting rules
beside Decision 9's one-line contract).

**How the decision changed after critique round 4.** The fourth critique
(peer run `review-20261126T041633Z-9ded19`) judged the round-3 targets
resolved, and found one MAJOR finding on frequent paths: item 1's "What the
release is given" had every releasing block open with one line per
directory it releases, the path the make printed, while two of item 1's own
bullets make and release a directory in the same shell call, the
dispatched bootstrap's topic directory and `/orchestrator:done`'s reason
directory. Neither path exists when its block opens, so every dispatched
persona verb and every `done` would have broken the rule, and item 8's
static check would have enforced it. Round 4 was the cap the owner had
raised; on 2026-11-26 the owner granted one further round, and this change
makes these fixes:

- Item 1's line rule now covers a directory that a later block releases. A
  block that makes and releases a directory in the same shell call releases
  it from the variable that captured the make's output, never from a path
  it reads. Item 8's static check holds each releasing step to that input,
  and the summary above says both.
- The summary keeps three qualifiers it had dropped: ADR-0068's removal of
  an autopilot step's `TMPDIR` is subject to its guards, so the directory
  can remain; retention is the default for `/orchestrator:next`'s refusals,
  and a switching change that releases on one rewrites its message; a
  release that reports `unsupported` prints nothing.

Still deferred as known limits, unchanged: D1, D2, M6 and M7.

**Alternatives considered.**

- **Release in every block's exit trap, failures included.** Rejected as an
  unconditional rule: most reruns the runbooks describe read the directory
  the failed block used. A finalize's later step, a refused commit subject,
  and Phase 3b of `next` after its join was refused are three of them. A
  block that makes its directory afresh on every run (`/orchestrator:done`)
  is the exception item 2 allows.
- **Release in the block that made the directory.** Rejected: 36 files read
  the directory in later shell calls.
- **An automatic sweep by age (the first draft, from the make).** Rejected
  for the CRITICAL finding above. A sweep from a hook was rejected earlier
  for its own reasons: the persona `SessionStart` hook matches `compact`
  only, a Codex hook runs only once trusted, and each persona would sweep
  the same root. A sweep at the autopilot run's start was rejected because
  interactive and Codex sessions start no run. Each of these would also
  meet the CRITICAL finding.
- **Mark a command's directories live, and sweep only those that are not.**
  Not taken. A liveness record is one more file that a kill strands, and it
  would need its own expiry, which is the age guess again.
- **Leave abandoned directories to the operating system.** Not counted on.
  Whether either platform cleans `$TMPDIR`, and when, was not measured.
- **Bind the release to the marker id the make printed (the deferred P2 of
  slice 1).** Rejected, and kept as a limit: the id is carried the way the
  path is. The swap it would catch, another command's directory copied
  whole, carries that command's id along.
- **Keep every operation directory, so that a rerun of a successful last
  write meets its `closed` record.** Rejected: no rerun of a successful
  last write is a recovery, since its writes are done. Keeping every
  operation directory would keep the C175 growth for the most common
  directory kind. The message changes instead.

**What it changes elsewhere, at acceptance.** As slice 1 recorded:

- ADR-0068 Decision 5, item 13 ("bounded by where they are made") needs a
  cascade, and so does ADR-0068 Decision 2, item 7 (the first-write block
  makes the operation directory with `mktemp -d`). Both wait for the
  runbooks to switch.
- The `AGENTS.md` paragraph on writing a runbook block now names the
  Proposed release in one clause. The sentence "Nothing in such a block
  deletes the file" is folded per package as each package switches
  (Decision 10, item 8).
- `verb-finalize.md` and the next-dispatch reference gain the releasing
  steps in the runbook changes, not here.

**Not measured.** No CLI or runbook was changed. These are left to the
implementation:

- the listing's cost on a `$TMPDIR` the size C175 recorded (223,067
  entries);
- whether a modification time read with `lstat` moves when an agent's file
  tool rewrites a file in place, on each platform.

**Accepted 2026-11-26.** The owner accepted Decision 9 (amendment of
2026-11-25) and Decision 10 (this amendment) explicitly, in the main session,
after both landed (#1081, #1084). The acceptance change folds the round-5
review's open items, as the owner ruled at the critique cap:

- **P2.** Decision 9 item 6's second constraint said `/orchestrator:next`'s
  text directory "outlives the trap", while Decision 10 item 1 releases it as
  the trap's last step. It now says the directory outlives every read of it in
  that trap.
- **P1.** Decision 10 item 1 now says that a nested `op` has no line and no
  releasing step of its own; it goes with its parent's release (Decision 9,
  item 3).
- **MINORs.**
  - Item 3 lists the `review-held` commit (exit 10) apart from the refusals
    answered by rewriting a file.
  - Item 1's "last step of its path" now reads "last step on that directory's
    path".
  - Item 7's first limit names the successful ends that still keep a
    directory.
  - `AGENTS.md`'s summary keeps "continuation" and says that the owner lists
    candidates.

The deferred rare-path MAJORs (D1, D2, M6, M7 of this slice; P1, P3, P4, P5,
D1, D2 and the path swap of Decision 9) stay the stated limits. Nothing is
implemented yet: `tmpdir-cli` and the two runbook rollouts follow, under
Decision 10, item 8.

**Implementation note 2026-11-26 (`tmpdir-cli`, the CLI that ships first
under Decision 10, item 8).** `scripts/lib/agentic-dir.mjs` (the
persona-pipeline unit `lib-agentic-dir`, generated into engineer, designer and
founder, and copied into the orchestrator under its COPIED notice) holds the
make, the marker, the release, the listing and the owner's claim-only run.
Each persona's and the orchestrator's `state.mjs` exposes them as
`tmpdir-make`, `tmpdir-release` and `tmpdir-list`; an operation's first write
records `dir_marker_id` only on a fresh open whose directory and marker pass
the release's checks, and a replay keeps the field it finds; a last write
given a missing operation directory refuses for any workflow, with the
message of Decision 10, item 5, which for a workflow that keeps no persona
operation (no macro's child, or a persona with its dispatch target off) adds
its way forward: once the workflow's record shows the write did not land, the
write again with no operation directory, since no operation of it is open to
lose; a nested make whose parent is a legacy text directory, however the
shell spelled it (macOS's `$TMPDIR` ends in `/` under a linked `/var`, so
the legacy parent reads `…/T//agentic-text.X`), exits `parent-legacy` for
item 4's fallback, while a parent that is itself a link (only its ancestors
may be) never does; both CLIs judge their tmpdir words in one shared check
(a bare flag, a value joined to its flag as `--name=value`, which the
persona parser has no form for, an `--execute` other than `true` or
`false`, a stray word),
so they answer every call alike; `dispatch-mark-withdraw --format json`
prints the dispositions of Decision 10, item 1 as one JSON line, and without
it stdout stays empty while stderr names a mark kept as `unknown` or
`unreadable`. No runbook, skill or region calls
the CLI: each package's switch waits for a release carrying it, installed
where the runbooks run, since an installed CLI older than the checkout's prose
would otherwise meet a make it lacks. Decision 9, item 6's measurement, so
far: in a headless Claude autopilot step (Linux, TMPDIR the step's scratch
root), `mkdtemp` gave mode 700 and the step's uid, an exclusive `mkdir` of
the placeholder then a rename onto it succeeded, a second `mkdir` failed
`EEXIST` and a rename onto a non-empty directory `ENOTEMPTY`; the working
tree's CLIs (base `addee03d` plus this change, unreleased) made a text
directory and its nested `op`, released it (`removed`, status 0) and
reported a second release `absent`, through both the engineer's and the
orchestrator's. A Codex peer run from that step, in `workspace-write`
(uid 1000, the TMPDIR it inherited from the step), ran the same round trip
through the engineer's CLI with the same outcomes and statuses. A Codex
session the owner starts directly, with its own TMPDIR, is not measured; the
rollouts wait for a release carrying the CLI, installed where they run. Tests: `tests/persona-pipeline/test-agentic-dir-*.mjs`;
mutation spec `scripts/mutation-specs/agentic-dir.mjs`.

**Implementation note 2026-11-27 (`tmpdir-runbooks-persona`, the persona
plugins' rollout of Decisions 9 and 10).** Every text and operation
directory a designer, engineer or founder runbook, skill or reference makes
comes from one make and goes through one release, each a snippet with one
source (`persona-pipeline/snippets/tmpdir-make.sh`, `tmpdir-release.sh`),
which a region includes by name (`{{> tmpdir-make}}`, `{{> tmpdir-release}}`,
and the `-skill` forms naming `<plugin-root>`). Prose may tell the agent to
make a directory with the CLI, but never to release one: every release is a
block of the runbook, a release-only block where the text had none (a Codex
skill's prose step), and a test refuses any persona text that names the
release outside the snippet. The make takes Decision 10, item 4's fallbacks (an
older `state.mjs` or an unsupported platform with `mktemp -d`, a nested op in
a legacy parent with `mkdir -m 700`); the release is cleanup only, prints at
most one line on standard error and leaves the block's output and status as
they were. A block releases a directory it read only from its own head line
or the variable its make printed to, on its success path after its last exit
and its last use, or from an EXIT trap for a directory every run makes
afresh (always, or on failure for an operation directory a later block
closes); a directory a later block, a rerun or a continuation reads is kept,
and the reason is written beside the path. `persona-pipeline/tmpdir-paths.json`
lists, per region template, each directory, its make, its consumers and every
path with its release or keep; `tests/plugin-shape/test-runbook-cli-contracts.mjs`
holds the rendered regions to it both ways (`tmpdirProblems`,
`tmpdirOrderProblems` in `tests/_runbook-checks.mjs`), and refuses a
`mktemp -d` of a text or operation directory anywhere in a persona's regions or
authored text. Paths keep a directory by design: a failed peer-now
consultation (its `prompt.xml.err` says why), a resume the owner stops after
the drift report, and the rare partial write of an owner-gate block (a clear
that landed before a failed terminal write), whose recovery runs only the
terminal write; the owner lists what is left (`tmpdir-list`). Inside
`/<persona>:start` each dispatch, and each pass of a looping refine, has a
directory of its own: the refine's pass settle releases the earlier passes',
and the phase's release block the phase's text directory and its last
attempt's dispatch directory (critique of 2026-11-27). An
operation directory still open is kept by the release itself (`refused`,
`operation-not-closed`), which the refine Defer's not-converged path relies
on. The region blocks that resolved an owner gate inside a `/start`
lifecycle no longer exit after the clear: they go on to release their
directories, and skip the terminal write instead. Tests: the persona runbook
suites (the happy paths assert each release), `tests/persona-pipeline/test-tmpdir-snippets.mjs`.

## Fold 2026-11-27 — the amendment of 2026-10-10's bullet, for the persona plugins

Decision 9, item 6 and Decision 10, item 8 fold the amendment of 2026-10-10's
bullet on deleting the file for a package once its runbooks switch. The
persona plugins switched (the implementation note of 2026-11-27 above), so the
bullet now states both cases: a switched package's directory is made marked
and released by the runbook through the CLI's proof, and an unswitched one's
(the orchestrator's) stays a `mktemp -d` directory that nothing deletes. No
block deletes the file on its own or runs `rm` in either. The bullet read,
before the fold:

> - The CLI never deletes the file, unlike the args file: one next-action file
>   can feed both `append` and `finish-verb`. A block does not delete it either,
>   since a headless run can deny `rm` (the amendment of 2026-09-29 above). The
>   file lives in a `mktemp -d` directory under `$TMPDIR`.

The matching sentence of `AGENTS.md` was folded in the same change. The
decision's status is unchanged.
