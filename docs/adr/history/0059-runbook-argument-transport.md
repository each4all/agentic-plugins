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
