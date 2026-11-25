# ADR-0059: Runbook argument transport — the text reaches the CLI as a written file, and the shell never sees it

## Status

Accepted

Decision 9, which directories a runbook may remove and how (amendment of
2026-11-25, C175): the scope (item 1) Proposed; the proof (items 2 and 3)
Proposed; the removal and its report (items 4 and 5) Proposed; the rollout
rule and its constraints (item 6) Proposed.

<!--
No supersedure. This decides a mechanism the runbooks never had an explicit
contract for. It makes the guard shipped by `27a980d` unnecessary, so the
test pinning that guard must be amended in the same change.

This ADR was rewritten after cross-host review disproved its first
Decision section. The discarded design and the claims that failed are kept
in Alternatives and Consequences rather than deleted — the record of what
was refuted is the part a later reader needs most.
-->

## Context

Plugin command runbooks are markdown containing bash blocks. The host
substitutes the slash-command argument into that markdown **before the
model sees it**, so the user's verbatim text arrives as a literal inside a
shell command line, spliced unquoted:

```bash
set -o noglob
node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve <USER TEXT> \
  > "$CONTEXT_FILE" 2>"$ERR"
set +o noglob
```

A previous change (`27a980d`, shipped as `plugin-engineer` 0.21.8 and
siblings) repaired a zsh-only defect at this site — the globbing guard was
spelled `set -f`, which does not set `noglob` under zsh, so it was inert on
a zsh default shell while passing review in bash. It did not touch the
splice, which is shell-agnostic and is what this ADR decides.

### What the splice costs

The corpus is the 311 `original_request` values recorded in this
repository's own workflow state. The metric is **byte-exact round trip**,
not exit status, because the worst failure exits zero.

| transport | exact | crash | corrupt |
|---|---:|---:|---:|
| **current — unquoted splice** | **105 (33.8%)** | 127 | 79 |
| one double-quoted argument | 271 (87.1%) | 4 | 36 |
| one single-quoted argument | 198 (63.7%) | 70 | 43 |

The corrupt column is the one that matters — those parse, exit zero, and
hand the CLI a truncated topic:

```
topic:  "A 고르자; 아니면 B"
argv:   ["resolve", "A", "고르자"]        ← truncated at the semicolon
stderr: command not found: 아니면
exit:   0                                  ← nothing reports the loss
```

An apostrophe aborts the whole block, and `$(…)` executes. During this
ADR's own investigation a probe that spliced these topics into a shell line
created 16 stray zero-byte files in the repository root, because **49** of
the 311 topics contain `>` and the shell read it as redirection.

Failures are combinatorial, so no character blocklist characterises them:
with the shipped `noglob` guard active, `a (b) c`, `` a `b` c ``, `a; b`
and `a $(id) b` each pass in isolation while `a; b (c)` fails, as does the
real topic `PR3 — 미러(agents/openai.md) 추가; 검증`.

**What the corpus cannot tell us.** These 311 strings are not raw user
input. `state.mjs` records them through `singleLine(scrubSecrets(...))`,
which collapses whitespace runs, replaces line breaks and trims edges, and
they have already passed through model transcription and a successful
workflow creation. The table above is a **replay measurement on those
stored strings** and is sound as such. It is *not* the observed failure
rate of original slash-command requests, and this ADR does not use it as
one.

### Sixteen sites, four packages

`plugins/runtime` 11, `plugins/designer` 2, `plugins/engineer` 2,
`plugins/founder` 1 — with zero occurrences genuinely inside quotes. An
earlier count of fifteen came from a classifier fault: a regex testing
`"[^"]*\$ARGUMENTS[^"]*"` matched **across two separate quoted strings**,
misreading `retention.md`. A character-level quote-state tracker gives
sixteen; the cross-host review reached sixteen independently from
`plugins/engineer/commands/start.md` (`set -- $ARGUMENTS`).

Three further host-substituted placeholders sit *inside* double quotes, in
the `investigate` runbooks of engineer, designer and founder
(`--profile "${AGENTIC_PROFILE:-<profile from $ARGUMENTS>}"`). They are
template defaults rather than argv forwarding, but host text still enters
shell source there, so an acceptance check phrased as "no unquoted
variable" would miss them.

Runtime sites differ in shape: their arguments are subcommands and option
values, and several of those options **do** take prose — `context.md`
documents quoted `--summary`, `--next-action` and `--text`. Their failure
mode on a mangled argv also varies: `doctor` and `settings` exit 2,
`context`, `worktree`, `retention` and `consensus` exit 1. An earlier draft
claimed a blanket "usage line plus exit zero"; that overstated the defect.

### What the host does and does not offer

The persona parsers already accept flags followed by `--` and **one intact
body argument** — verified 4/4 exact on apostrophes, `$(id -un)`,
parentheses/semicolons/brackets and newline-plus-tab, in each of the
engineer, designer and founder libraries. **No body tokenizer is needed.**

The host does not expose the argument text in any environment variable.
It does expose it to hooks: the installed binary (2.1.266, control tokens
`PreToolUse` 107 and `SessionStart` 74 confirming the file) contains
`UserPromptExpansion` 20 and `command_args` 7. The Codex binary (control
tokens `update_plan` 48, `apply_patch` 93, `hooks` 196) contains **zero**
of either; both hosts carry `UserPromptSubmit`, which delivers the raw
prompt rather than parsed arguments. A hook transport is therefore
Claude-only on its clean path — see Decision 6.

## Decision

**1. The user text is written to a file by the model's native file-writing
tool, and never appears in a shell command line.** The runbook instructs
the model to write the argument text into a temporary file and then invoke
the CLI with a path. No shell quoting, expansion, redirection or word
splitting is involved in the capture, because no shell is.

**2. The file is versioned JSON, not raw text.** A JSON string separates
the argument's own trailing newlines from the file's formatting newline,
which raw text cannot do: a raw capture cannot distinguish an empty
argument from a single newline. The reader fails **explicitly** on
malformed encoding rather than falling back to a best guess.

**3. The CLI gains `--args-file`, and nothing else.** It decodes the file,
applies the command's documented grammar to the leading flags, and forwards
`[...flags, "--", body]` to the existing parser with the body as an exact
substring. Because the parsers already accept `--` plus one intact body, no
tokenizer is written and no existing CLI interface changes.

**4. The receiving contract is producer-independent.** `--args-file` names
a format, not a writer. Any producer that emits that format is acceptable,
which is what lets Decision 6 replace the writing step later without
touching a single consumer.

**5. Runtime commands get an explicit, non-evaluating grammar.** Their
arguments are subcommands and option values, and some option values are
prose, so enumerating the options is not sufficient — the grammar must
state how spaces, quotes and escapes inside a value decode. Anything
outside the grammar fails explicitly.

**6. Hook capture is recorded as the future producer, not adopted now.** A
Claude `UserPromptExpansion` hook persisting `command_args` is the only
design that removes model transcription of the payload, and it is a
credible architecture. It is deferred because what is proven is the
*interface*, not the *handoff*: correlating a captured payload with the
later-running runbook across concurrent commands, retries, interrupted
consumption and cleanup is unproven, a shared "latest arguments" file is
insufficient, and Codex would retain Decision 1 regardless. When that
handoff is proven, it replaces the producer and Decision 3 is untouched.
The Codex path then degrades honestly and explicitly, per ADR-0001.

**7. `engineer:start` gets its own extraction rule**, because its grammar
permits `--base-branch` to appear inside the free-text description.

**8. The shipped guard's test is amended, not replaced.**
`set -o noglob` exists to make an unquoted splice survivable; once there is
no splice it protects nothing, and
`tests/plugin-shape/test-runbook-shell-portability.mjs` asserts that a
guard survives — so it would **block this change**. Its guard-presence
assertion is replaced with transport assertions; the rest of its
portability coverage is retained.

<a id="decision-9"></a>
**9. A runbook's text and operation directories are removed through a CLI
that proves it made them.**

Status: Proposed, each of item 1 (the scope), items 2 and 3 (the proof),
items 4 and 5 (the removal and its report) and item 6's rollout rule with
the constraints it hands the second slice on its own; item 7 states the
limits of the Proposed proof. *Amended 2026-11-25 (C175, slice 1): [history](history/0059-runbook-argument-transport.md#amendment-2026-11-25--which-directories-a-runbook-may-remove-and-how-c175).*

1. **Scope.** The directories a runbook or skill block makes for the text an
   agent writes (`agentic-text.<suffix>`, the amendment of 2026-10-10), for a
   command's persona operation (`agentic-op.<suffix>`, ADR-0068 Decision 2,
   item 7), and the one operation directory a peer consultation makes inside
   its text directory (`op`). An args directory (`agentic-args.<suffix>`)
   keeps the reader's removal of the amendment of 2026-09-29. A test's
   temporary trees (`scripts/lib/remove-tree.mjs`), an autopilot run's
   scratch root (ADR-0068 Decision 5, item 13) and a peer run's ledger
   directory keep their own rules; the release refuses each of them, since
   none carries this decision's marker, `.agentic-dir.json` (item 2; the
   scratch root's own marker, `.scratch.json`, is another file and proves
   nothing here).
2. **The CLI makes the directory and marks it.** *Proposed.* Such a
   directory is made by a subcommand of the persona `state.mjs` (generated
   from `persona-pipeline/`) and of the orchestrator's `state.mjs`, not by
   `mktemp -d`; the subcommands' spelling is the implementation's.
   - **Where.** At the top level, directly under `$TMPDIR` when it is set,
     and under `/tmp` only when it is not. A `TMPDIR` that is set but not an
     absolute path to a directory fails the make: there is no fallback, so a
     bounded root such as an autopilot step's is never left for `/tmp`. The
     nested operation directory is made only inside a text directory that
     passes item 3's path, directory and marker checks, and only under the
     name `op`: it is the one directory a text directory may hold.
   - **How.** The directory is created exclusively, mode 0700, named for its
     kind with a random suffix of at least six letters and digits (`op` for
     the nested one). Before the path is printed, the CLI writes the marker
     `.agentic-dir.json` aside and renames it into place, so a marker is
     whole or absent. A top-level directory's aside file is written inside
     that directory; the nested `op`'s is written in its parent text
     directory, so an interrupted make leaves `op` empty and the aside a
     plain file of the parent. The marker holds a schema, the kind (`text`
     or `op`), a random id of at least 128 bits drawn for this directory
     alone, the directory's basename and device and inode, its owner's uid,
     the time it was made, and its parent: for a top-level directory
     the root's real path, device and inode; for `op` the parent text
     directory's device and inode only, which a rename of that parent does
     not change. The CLI prints the path, absolute and canonical, only once
     the marker is in place. When it cannot place the marker it prints no
     path, fails, and removes what it made: its own aside file, then the
     directory when that is empty.
   - **Interrupted makes.** A make killed after its `mkdir` leaves a
     directory with no marker (empty, or holding only the aside file), and
     one killed after the marker but before it printed leaves a marked
     directory whose path no block holds. No release removes either, since
     the release takes only a printed path and never removes a top-level
     directory with no marker; the second slice decides what becomes of
     them (item 6). A nested `op` left empty is removed with its parent
     (item 4).
   - **Platforms.** A platform whose `stat` reports no owner, or an inode of
     zero, fails the make, as the release would refuse what it made. Windows
     is one: Node reports uid 0 for every file there and has no
     `process.geteuid`, so the proof's owner check means nothing, and the
     make fails on `win32` whatever `stat` reports.
3. **The proof.** *Proposed.* The release is given the path the make
   printed, or the `.removing-` path a release's report gave for it, never
   a path a block derived from another. It removes the
   directory only when each check holds, the path's first with no file
   system call:
   - **The path.** Absolute, with no `.` or `..` component, no doubled or
     trailing separator; refused, not normalized, otherwise (a `..` after a
     link would mean one directory to the operating system and another to a
     normalizing string). Its basename has a top-level kind's form, or that
     form behind the `.removing-` prefix of item 4. A nested `op` is never
     released on its own: it goes with its parent.
   - **The directory.** Not a symbolic link (`lstat`), owned by the
     release's effective uid. A top-level directory's parent, as the given
     path spells it, is canonical: that spelling equals, as a string, both
     the parent's real path now and the root real path the marker records,
     and the parent's device and inode are the marker's. A nested `op`'s
     parent is the text directory being judged, whose device and inode its
     marker must name. Comparing real paths alone would
     accept a path through a linked ancestor that resolves to the same
     root; the string comparison refuses it.
   - **The control files.** The marker, and in an operation directory
     `operation.json`, are read without following a link: each must be a
     regular file with one link and at most 64 KiB, opened with no-follow
     and compared with its `lstat` by device and inode. The marker must
     parse as its schema and name this directory's kind, basename (the name
     behind `.removing-` once claimed), device and inode, its parent's
     identity as item 2 records it, and the release's uid. A marker copied
     or written into another directory proves nothing, nor does a directory
     put where the CLI made one.
   - **The entries.** Every other entry is a regular file or a symbolic
     link (a hard link is removed by its own name like any file), or, in a
     text directory, a directory named `op`. That `op` passes the directory
     and control-file checks above with this text directory as its parent,
     and the operation check below, and holds only files and links itself;
     or it is empty and has no marker (item 4, **An empty `op`**). Anything
     else refuses the whole release: another directory, a non-empty `op`
     with no marker (an older runbook's `mkdir -m 700 "$TEXT_DIR/op"` once
     written into included), a directory below `op`, a FIFO, a socket or a
     device.
   - **The operation.** An operation directory, at the top or nested,
     passes only when its `operation.json` is absent, or parses as the full
     transport schema (`holds.mjs`) with `closed` and names this
     directory's marker id. That field is new: the first write reads the
     operation directory's marker, as this item reads it, and records its
     id in the transport when it opens the operation. It records the id
     only from a marker that passes the control-file and marker checks
     above; in a directory with no marker, or one those checks refuse (every
     directory a runbook makes with `mktemp -d` until it switches, item 6),
     the write opens, carries and closes the operation as it does today, with
     no field and no refusal of its own, and no release removes what that
     write wrote: a top-level directory fails the marker check, its marker
     missing or refused, and a nested `op` holding a field-less transport
     fails the operation check, or the entries check when it has no marker
     (only an empty `op` with no marker goes with its proven parent, item 4,
     and it holds no transport). A `closed` record
     copied or restored from another directory's operation does not pass,
     even into a directory whose inode the file system has reused, since
     the id is drawn per directory, not derived from where it lives. A
     transport without the field (written by a `state.mjs` older than this
     decision's implementation, or into a directory with no marker) refuses
     like a stale state below. `opening`, `open` or a malformed file
     refuses the whole release, and one that cannot be read stops it as
     `error` (item 5). Such a state may be stale (a first
     write that failed after it kept `opening`, a close whose last
     transport write did not land); neither the command's exit nor the
     owner's `writer-clear` makes it releasable under this decision.
   - **What an absent transport means.** No transport file in the
     directory: no command opened an operation there (outside a macro's
     lane no command writes one), a first write died before its rename (its
     aside file is then an entry, and it published nothing), or an earlier
     release of this directory unlinked it after the directory passed
     (found only under the `.removing-` name). The release judges this
     directory's file and nothing else: an operation a workflow keeps open
     elsewhere, or one a dispatched bootstrap took over from its
     dispatcher, is not visible here, and its directory not being written
     is the caller's precondition (item 4, **Writers**). The same holds for
     the holds' external record of a `closed` operation: the close tries to
     remove it before it writes `closed`, and writes `closed` even when that
     removal failed; a record left behind so is
     in the holds directory, which no release touches.

   The name, the location, or both never suffice alone: they are what a
   model transcribes from one call to the next. A report names a failed
   check by a fixed reason code, never by a parser's message or a file's
   contents.
4. **The claim, then the removal.** *Proposed.*
   - **Before the claim** the release checks the path, the directory and
     its marker. A failure there changes nothing. Every report that judges
     `<name>` also gives the `.removing-<name>` sibling's path when one is
     there, whatever its outcome, so a directory a late writer's recreated
     `<name>` hides is still found.
   - **The claim.** The release first makes `.removing-<name>` in the same
     parent with an exclusive `mkdir`, mode 0700, then renames the
     directory onto that empty placeholder. `mkdir` fails when anything has
     the name, so of two releases at most one claims, and the other reports
     `contention` and changes nothing. POSIX `rename(2)` replaces an empty
     directory, so the rename replaces only the placeholder this release
     made an instant before; Node offers no rename that refuses to replace,
     and the placeholder is how the claim avoids replacing anyone else's
     directory. A `mkdir` that fails other than because the name is taken
     is `error`, and nothing changed. A rename that fails leaves the
     placeholder, which the release removes with `rmdir` (it made it, and
     it is empty), and reports `contention` when `<name>` is gone, `error`
     otherwise; when that `rmdir` fails too, the report names the
     placeholder left and its error code. A
     release killed between the `mkdir` and the rename leaves an empty
     `.removing-<name>` with no marker: the next release of `<name>`
     reports `contention` naming it, and the second slice treats it with
     the other directories that have no marker (item 6). On Windows a
     rename onto an existing directory fails rather than replaces it,
     though the make fails there anyway (item 2).
   - **What the claim stops.** After the claim the old path names nothing.
     A write that opens a file under it fails, so a first write racing the
     release fails loudly instead of writing into a directory being
     emptied. A writer that creates missing parent directories, as an
     agent's file-writing tool does, instead recreates `<name>` as a new
     directory with no marker: its file lands there, outside the claimed
     directory, and no release removes it. Keeping writers away is the
     caller's precondition (**Writers**, below).
   - **After the claim** the release checks the directory and the marker
     again on the claimed directory, then the entries and the operation.
     When the directory or marker check fails, a control file that cannot
     be read included, the thing at `.removing-<name>` is not proven, and
     it is left where it is, reported `claimed`: after this release's own
     claim, `claimed` takes precedence over `not-owned` and `error`. When only the entries or the operation stop it,
     the release renames the directory back the way it claimed it: an
     exclusive `mkdir` of `<name>`, then the rename onto it. It reports the
     outcome the failed check names (`refused`, or `error` for a read that
     failed) when the directory is back at `<name>`, and `claimed` when it
     is not (`<name>` exists, the `mkdir` or the rename failed; a
     placeholder it made and could not fill is removed with `rmdir` when
     empty, and one that `rmdir` could not remove is named in the report
     with its error code). Only the release that made the claim renames back, and only
     in the same invocation: a release that finishes another's claim never
     renames anything.
   - **The removal.** Each entry but the marker is unlinked (a link's own
     name, never its target), `operation.json` among them, and the nested
     `op` the same way down to its own marker and `rmdir`. Then the
     directory is listed again; only when the marker is its one entry is
     the marker unlinked and the directory removed with `rmdir`. Nothing is
     removed recursively or through a link.
   - **An empty `op`.** The text directory's marker proves the container,
     and every entry of a proven container is removed on that proof by its
     type alone: a file or a link has no marker of its own either. The
     nested `op` needs its own marker only when it holds entries, since
     they are what its marker proves; an `op` that is empty and has no
     marker (an interrupted nested make, a removal killed between `op`'s
     marker and its `rmdir`, or an older runbook's unused `mkdir`) holds
     nothing to prove, and is removed with `rmdir` under its parent's
     proof. A top-level directory has no container that proves it: one
     with no marker is never removed, empty or not, and its name and
     emptiness alone are not a proof.
   - **Finishing.** A release given `<name>` when only `.removing-<name>` is
     there, or given `.removing-<name>`, starts at the checks after the
     claim, under the same proof: a claimed directory is finished only
     while its directory and marker checks hold. A finisher whose checks
     fail leaves the directory where it is, reporting the failed check's
     outcome (`not-owned`, `refused` or `error`) with its `.removing-`
     path. A kill between the marker's unlink and the last `rmdir` leaves
     an empty `.removing-<name>` with no marker, which no release removes
     (item 6). A release given `<name>` when both `<name>` and
     `.removing-<name>` are there judges `<name>` alone (a recreated
     `<name>` with no marker is `not-owned`; a marked one meets
     `contention` at its claim); the claimed directory is reached by its
     `.removing-` path, which the report gives.
   - **Concurrent releases.** The claim is exclusive, by its `mkdir`: of
     two releases that start together, at most one claims. The other
     reports `contention`, or, when it looks `<name>` up only after the
     claim, finds the claimed directory and finishes it beside the
     claimer, which the precondition below excludes. Nothing more is
     serialized. A release that finishes a
     claimed directory while another release of the same directory still
     runs (the claimer's checks or rename back, or a second finisher) is
     not guarded: one may rename back a directory the other has partly
     emptied, or remove with its last `rmdir` a placeholder a later claim
     made at the same name. Running one release of a directory at a time
     is the caller's precondition, as keeping writers away is: a block
     releases only the path its own make printed, once, and a finisher
     runs only after the release that left the directory claimed has
     ended. Within that precondition each step stays bound to the proof:
     an entry already gone is counted gone, the marker goes only after a
     fresh listing finds it alone, and `rmdir` fails on a directory that is
     not empty.
   - **Writers.** That no shell, file tool or runner still writes into the
     directory is the caller's precondition, which the second slice states.
     A process that already holds a file open keeps writing to it after the
     claim; its data goes with the unlink.
5. **Outcomes.** *Proposed.* The release prints one JSON line and exits
   with status 0 for `removed` and `absent`, which the line's outcome tells
   apart, and with a non-zero status of its own for each other outcome; the
   non-zero numbers are the implementation's. A report gives the path the directory has as the
   release ends; another release may change it after.
   - `removed`, status 0: the directory is gone.
   - `absent`, status 0: nothing at the path or at its `.removing-` name,
     and the path passed the path checks. A release given a `.removing-`
     path judges that name alone: nothing there is `absent`, whatever
     `<name>` holds, and the report says whether `<name>` exists. A second release of one directory,
     once both its names are gone, succeeds and removes nothing; a path of another form is `not-owned`.
   - `not-owned`, non-zero: a path, directory or marker check failed: a
     marker absent, malformed, of another directory or not a single
     regular file, or a directory or parent that does not match. Before the
     claim nothing changed; in a finisher the directory stays at its
     `.removing-` path.
   - `refused`, non-zero: owned, but an entry or the operation stops it: a
     forbidden entry, a nested `op` that fails its checks, or an
     `operation.json` that is not `closed`, does not name this directory,
     is malformed or is not a single regular file. The directory has its
     old name (a finisher's stays at its `.removing-` path), and nothing
     else changed.
   - `contention`, non-zero: `.removing-<name>` is there, or `<name>` went
     between the checks and the claim. Nothing changed, but a placeholder
     the report names as left (item 4).
   - `error`, non-zero: a system call failed for a reason other than what
     the checks judge (a permission, an I/O error) in a lookup, a read of
     a control file, a listing, the claim's `mkdir` or its rename. A
     control file that cannot be read is `error`; one that reads and fails
     its check is `not-owned` or `refused`; after this release's own claim,
     a failed directory or marker check of either kind is `claimed`. The
     directory has its old name (a finisher's stays at its `.removing-`
     path), and nothing changed but a placeholder the report names as
     left.
   - `claimed`, non-zero: after this release's claim, the directory could
     not be judged or put back: its directory or marker check failed, or
     the rename back did not happen. Nothing was removed. The report gives
     the `.removing-` path, the check that failed, and why the directory is
     not back: the original name taken, or the error code of the `mkdir`,
     lookup or rename that failed, or that it was not tried because the
     claimed directory is not proven. A later release given the
     `.removing-` path judges it again.
   - `partial`, non-zero: the removal began and did not finish. The report
     gives the path the directory has now, each entry this release
     unlinked, each it found already gone, each it kept with its error
     code, and whether any part could not be listed. It cannot name
     entries an earlier or concurrent release unlinked, which this release
     never saw. The marker stays while any other entry does, so a later
     release finishes the directory under the same proof. When the
     marker went and the last `rmdir` then failed (an entry that appeared
     after the listing, or a system error), the directory has no marker
     and no release finishes it: the report says so, and names the
     entries it finds there when it can still list the directory.
6. **Rollout and what this leaves.** *The rollout rule and the constraints
   it hands the second slice Proposed.* The make
   and release subcommands ship in a release before any runbook calls
   them, as the receivers of the amendment of 2026-10-10 did, and before
   any runbook switches, the implementation measures a same-parent rename and the release under a
   headless Claude run and Codex's `workspace-write` sandbox. Until the
   runbooks call them, that amendment's rule stands: no block deletes the
   file; once the second slice is accepted, the amendment's bullet saying
   so ("The CLI never deletes the file", which says a block does not
   either) and the matching sentence of `AGENTS.md` ("Nothing in such a
   block deletes the file") are folded for these directories. The second slice decides when a block calls the
   release, within these constraints:
   - the release is given the path the make printed, carried apart from the
     paths a block reads (a finalize's `DISPATCH_DIR` may name a peer run's
     ledger directory, which is never released);
   - `/orchestrator:next` reads its text directory in the exit trap that
     withdraws its dispatch mark and releases its admission, so that
     directory outlives the trap;
   - a peer's directory outlives the run's settlement and the operation's
     close;
   - a rerun of the write that closed an operation, given its released
     directory, fails on the missing directory, whose message advises
     running the write with no operation directory, where with the
     directory still there it would have refused on the `closed` record:
     the second slice decides whether the directory outlives a possible
     rerun or that message changes;
   - no writer, the agent's file tool included, names a directory after
     its release, since that tool would recreate it with no marker (item
     4);
   - one release of a directory runs at a time, and a finisher only after
     the release that left the directory claimed has ended (item 4,
     **Concurrent releases**).

   It also decides what a failed block, an admission release or a commit
   retry keeps, how a refusal or an older CLI is reported after the
   operation it followed succeeded, what a runbook does on a platform whose
   make fails, and what becomes of directories with no marker (an
   interrupted make, an interrupted last `rmdir`, a claim's placeholder
   left by a kill, a directory a late writer recreated), marked
   directories whose path no block holds, directories left at a
   `.removing-` path (`claimed`), and directories with a stale open
   operation or a transport older than this decision.
7. **Limits.** The checks and the removal are separate system calls: a
   process of the same user that swaps the directory for another between
   them is not caught, and a marker is written by the same user it proves.
   The proof guards against a wrong path, as the args reader's rule and
   `remove-tree.mjs` do, not against a hostile process of the same user.
   Nor against a restore: a backup that puts a released directory back,
   marker and `operation.json` included, under the same name in the same
   parent at an inode the file system reused passes every check, and a
   release of its path removes that restored copy. A restore of a
   temporary directory into `$TMPDIR` is a hand-made state the proof does
   not try to tell from the original; what it loses is the copy of a
   directory the CLI made and released.
   Nor does it tell one valid directory from another: it proves that the
   path names a directory the CLI made, of this kind, the user's own and
   with no operation open in its transport file, not that it is the
   directory this block made. A transcription that swaps the path of one live text directory
   for another's releases the other, losing whatever files a later block
   of that other command would have read; that the path is this block's
   own is the second slice's to carry (item 6, its first constraint).

## Consequences

**Positive.** The shell stops being part of the argument path, so the
entire class disappears rather than being mitigated — truncation,
expansion, redirection and quote termination are all properties of a shell
that is no longer there. The change is smaller than first scoped because
the parsers already take `--` plus an intact body. And the file interface
is the same one a hook producer would need, so Decision 6 costs nothing
extra later.

**Negative — and it is not claimed away.** **Model transcription remains,
and this ADR does not remove it.** The host delivers the argument text only
inside the runbook markdown, so the model reproduces it into the file. Its
fidelity was probed on eight hostile cases and four survived — NBSP,
zero-width space, CRLF and a combining mark were lost — with the case
labels naming what to look for. That probe includes display rendering and
the writing tool, so it does not isolate transcription and does not
establish a bound; it establishes that a fidelity problem exists. **No
claim of pipeline byte-exactness is made anywhere in this decision.** What
is claimed is narrower and verified: the shell stops damaging the text.

Whether that residue bites is **not** settled by this repository's corpus,
for two independent reasons: the corpus is downstream of transcription, and
it is deliberately normalised by `singleLine`. Its zero invisible
characters therefore evidence nothing about the residue in either
direction.

Other costs: sixteen runbooks change across four packages, so per-package
commits under ADR-0016 and four releases; runtime assets take effect only
once released and installed; a temporary file acquires a lifecycle whose
removal must survive early exits; and the capture step becomes a model
instruction rather than executable code, which is a real loss of
enforceability that Decision 6 is the plan to recover.

**Neutral.** The persona CLIs keep their interfaces. File-borne input
follows the precedent this repository already set with `--prompt-file` for
peer dispatch and in `companions/contract.md`: prose reaches a process as a
file, never as argv.

## Alternatives Considered

**Heredoc capture with a variable delimiter** — this ADR's own first
Decision, **dropped outright**. `<<"$DELIM"` uses the **literal string
`$DELIM`** as the delimiter, because quoting the delimiter word suppresses
its expansion. Verified in both zsh and bash: planting `$DELIM` followed by
a command in the body **executed the command** and truncated the capture.
The test that had "verified" it planted a different sentinel and passed for
the wrong reason. A second defect was hidden the same way: the heredoc
appends one LF, and the harness that reported 311/311 stripped exactly that
LF in its extractor — it normalised away the defect it was measuring.

**Heredoc capture with a fresh literal delimiter** — the repair, and still
not adopted. Mechanically the repair works: a literal quoted delimiter does
suppress all expansion, and stripping one trailing LF is an exact inverse
for text, text-plus-LF and empty. But **freshness is not absence**:
planting the actual literal delimiter still executed the control command in
both shells, and absence must be established *before* shell parsing, which
cannot be done from inside the shell. Its safety is probabilistic where
Decision 1's is structural. It also adds a second model obligation —
generating a token — on top of the transcription both designs share.

**One double-quoted argument.** Rejected on measurement: 271 of 311 exact,
36 corrupt. Double quotes still permit `$` and backtick expansion, so
`$(id -un)` executes.

**One single-quoted argument.** Rejected on measurement: 198 of 311 exact,
70 crashes; any apostrophe terminates the quoting.

**Per-token quoting by the model.** Scored 311 of 311 in a harness that
quoted *mechanically*, which is not the proposal — the proposal is for the
model to quote. Independently, splitting on whitespace and rejoining loses
whitespace structurally, failing five of eight edge cases, and the parser
joins body tokens with single spaces so the loss is unrecoverable.

**Adopting hook capture now.** Not rejected — deferred, with the reason
stated in Decision 6. An earlier draft of this ADR asserted that model
transcription was unavoidable in "every design available today"; the hook
interfaces refute that, and the assertion is withdrawn.

**Rejecting the file tool because the heredoc is machine-verifiable.** This
was the first draft's decisive argument and it is **withdrawn as
unsound**: it measured the heredoc's mechanical segment against the file
tool's model segment. Both designs have both segments, and given supplied
content, file-writing behaviour and downstream parsing are equally
mechanically testable.

## Implementation notes

Not part of the decision, but required when it lands:

- Acceptance asserts **byte-exact body preservation and absence of side
  effects**, never exit status. The 311 topics are replayed as fixtures
  through the JSON codec. Any probe that splices untrusted text into a
  shell line runs with its working directory **outside the repository** —
  the 16 stray files this investigation created are why that is written
  down.
- `tests/plugin-shape/test-runbook-shell-portability.mjs` is amended per
  Decision 8 in the change that removes the last splice, not before.
- The three quoted placeholders in the `investigate` runbooks are covered
  by the acceptance check, which is phrased against host-substituted text
  in shell source rather than against unquoted variables.
- Per-package commits under ADR-0016: `plugins/runtime` (11 sites),
  `plugins/designer` (2), `plugins/engineer` (2), `plugins/founder` (1).
  The Codex skill mirrors carry the same instructions and change with their
  packages.
- The temporary file is removed on every exit path, and the CLI's exit
  status must survive that removal — a naive `cmd; rm -f "$F"` returns the
  status of `rm`.

  *Narrowed on 2026-09-29: the reader now removes the file once it has read
  it, so a block that exits before the reader runs leaves the directory
  behind. See the amendment of that date at the end of this record.*

## Amendment 2026-09-29 — what the implementation measured

The implementation re-measured the sites before changing any, and spelled out
the grammars Decisions 3, 5 and 7 left to it. What it found changes or adds to
the sections above in these respects.

**(a) Fifteen sites, not sixteen.** ADR-0060 removed `runtime:compat`, and
with it `compat.md`'s splice: runtime had 10, engineer 2, designer 2 and
founder 1, plus the three quoted `investigate` placeholders. All eighteen are
gone. `tests/plugin-shape/test-command-argument-substitution.mjs`, which
pinned each by its line, now holds an empty list: no fenced block in any
command body receives host-substituted text.

**(b) One library in four byte-identical copies.** `scripts/lib/args-file.mjs`
ships in runtime, engineer, designer and founder, because each is installed on
its own, and `tests/plugin-shape/test-args-file-transport.mjs` fails when the
copies differ. The file is `{"agentic_args": 1, "text": "…"}`. Invalid UTF-8,
invalid JSON, another version, a missing or non-string `text`, an extra field,
a lone surrogate, a NUL and a file over 1 MiB are each refused with a message.

**(c) The runtime grammar (Decision 5) is the words of a POSIX command line
with every expansion removed.** Quoting and backslash escapes decode as they
would in a shell; `*`, `?`, `[`, `{`, `!` and `=` are ordinary characters. The
characters a shell would act on instead — the operators `; & | < > ( )`, a
backquote, `$` before a name, digit, `{` or `(`, and a word-initial `#` or `~`
— are refused unquoted rather than reinterpreted, so a user who expected a
shell is told so instead of being silently read otherwise. The words replace
`--args-file <path>` where it sat, which matters for `retention`, whose
subcommand must come first. A malformed file takes each CLI's existing
usage-error exit: 2 for `doctor` and `settings`, 40 for `bootstrap`, 1 for the
others.

**(d) The persona CLIs take the file as their only argument (Decision 3).**
`decide-registry.mjs resolve --args-file <path>` refuses any other argument
beside it, and only the first argument can name the file, so
`resolve -- --args-file` still passes `--args-file` as the body. Text that
starts with no flag is its own body, byte for byte, leading whitespace
included; after flags, the body follows the one run of whitespace that
separates them. A leading flag word that holds a quote or backslash is
refused rather than read as quoting — the flag values are bare by ADR-0027
§2.2. The resolver now sets its exit status instead of calling
`process.exit()`, which cut a piped context at 64 KiB while exiting zero; the
context carries the body, and the file allows one of up to 1 MiB.

**(e) The start rule (Decision 7)** lives in `scripts/start-args.mjs`: at most
one `--base-branch <ref>`, anywhere in the text; one pair of matching quotes
around the ref is removed; a second option, the `--base-branch=<ref>`
spelling, a missing or empty ref, or a quote, backslash or leading `-` left in
it is refused; the option and the whitespace separating it from the
description are removed and every other byte stays. A description that must
mention the option quotes it.

**(f) The file goes in a directory, and a trap removes it.** The runbook
creates a directory with `mktemp -d` and the model writes a new `args.json`
into it, so the writing step always creates a file and never replaces one.
Claude's file-writing tool documents a refusal to overwrite a file it has not
read; measured on 2026-09-29 it overwrote both an empty and a non-empty
unread file, so the design relies on that behaviour in neither direction. The
block that runs the CLI installs, immediately after assigning `ARGS_DIR`,

```text
trap '{ rm -f -- "$ARGS_DIR/args.json" && rmdir -- "$ARGS_DIR"; } || echo … >&2' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
```

Run by sh, bash, zsh and dash, it removes the directory on success, failure,
an early exit, and a hangup, interrupt or termination signal (each turned
into an exit with the conventional 128+n status); it keeps the command's exit
status otherwise, and warns — status still kept, even under `set -e` — when
the file or the directory cannot be removed. The test that checks this
replaces the guard-presence assertion (Decision 8). It removes only the file
and an empty directory, never a tree, because the directory path is
transcribed by the model from one call to the next. Two gaps remain and are
stated rather than closed: SIGKILL cannot be caught, and a flow abandoned
between creating the directory and running the block leaves the directory
behind — it holds only this file, under `$TMPDIR`.

*The trap was removed on 2026-09-29; the reader now removes the file. See
the amendment of that date at the end of this record.*

**(g) The Codex skills carry the same instructions.** The ten runtime skills,
the three `decide` skills and the engineer and designer `start` skills tell a
Codex model to put the user's arguments in an args file and pass
`--args-file`. Measured on 2026-09-29 with codex-cli 0.158.0 in its
`workspace-write` sandbox: asked to write the file into a `mktemp -d`
directory under `$TMPDIR`, Codex used `apply_patch`, and the file held the
text — an apostrophe, `;`, `$(…)` and `>` included — byte for byte.

**(h) The corpus had grown to 351 distinct topics, and every one passed** —
through all four library copies and all three persona parsers, with each
topic written to a real file outside the repository and read back. The topics
are not committed: the state they come from is gitignored, and they carry
local paths and host names. The suite replays their shapes instead
(`tests/fixtures/args-file-topic-shapes.json`): each topic with its letters
and digits replaced by a placeholder of the same class, and every whitespace,
quote, operator and option name kept, which is all a grammar reads.
`scripts/replay-args-file-corpus.mjs` replays the real topics on a machine
that has them and regenerates the fixture. A mutation spec
(`scripts/mutation-specs/args-file-transport.mjs`) puts 31 defects back into
the library, the CLIs, the runbooks and the cleanup; each is caught.

**(i) An observation on transcription, not a decision.** While this change
was being written, a `\u`-escape the model emitted in a file-writing tool call
arrived in the file as the character it names, while `\n` and `\t` stayed
escapes. In an args file that is harmless when the character may appear raw
in a JSON string, and a refusal when it may not: a raw control character makes
the file invalid JSON. The codec's strictness therefore turns this part of the
transcription residue into an explicit failure instead of a silent change. It
does not bound transcription, and the Negative consequence above stands.

**(j) Found, and not decided here.** Twenty persona runbook blocks create
their workflow with `--original-request "${AGENTIC_TOPIC:-<one-line scrubbed
user request>}"`, and `orchestrator:plan` with
`--original-request "<one-line scrubbed user feature description>"` —
placeholders the model fills with text derived from the request. That is
model-authored rather than host-substituted text, so it is outside this
decision, but it reaches a double-quoted shell string the same way. The
`decide` runbooks also create or resume their workflow in Phase 0, before
Phase 0.5 reads the args file, so a malformed file fails after that write;
parser errors already failed at the same point before this change. Both are
left for a follow-up.

*The first of these, with the wider class it belongs to, is decided by the
amendment of 2026-10-10 at the end of this record. The `decide` ordering is
not, and stays open.*

## Observation 2026-09-29 — after the release

Not a decision. The post-release check ran one `engineer:decide` on each host
with a 132-byte topic holding an apostrophe, double quotes, semicolons,
parentheses, `$(…)`, `>` and a newline, in a scratch worktree outside the
repository, and stopped each run after the resolver. On both hosts the body
reached the resolver byte for byte, and a search for the three files the
topic names found none of them.
That is evidence for those two runs and that topic; it does not bound
transcription, and the Negative consequence above stands.

The Codex run found a gap in (g). On codex-cli 0.158.0, run as `codex exec`
with `approval_policy` `on-request`, the `workspace-write` sandbox and the
`guardian_approval` feature on, the
model wrote the file with `apply_patch` as (g) measured, then submitted the
skill's resolver block as written, and Codex rejected it before it ran: "rm -f
style commands are not permitted. Use a safer approach", a string the Codex
binary carries next to references to its exec-policy source file. The model
reran the block with `rm` in place of `rm -f`, and that run removed the
directory. That run completed this path only because its model departed from
the skill's text. Which of those settings produced the refusal, whether every
run under them is refused the same way, and whether an interactive session
asks for approval instead were not measured. The fix changes the
packages' instructions and needs its own release, so it is left for a
follow-up; the evidence-loop record `the-arguments-the-shell-never-sees`
carries the run.

*Closed by the amendment of 2026-09-29 below.*

## Amendment 2026-09-29 — the reader removes the args file

Made by the headless-runbook slice of
[ADR-0063](0063-autopilot-fresh-session-driver.md) (S0). (f) installed a
shell trap to remove the args file and its directory. The trap is gone, and
the reader removes both instead.

**Why the trap went.**
- **Codex.** Read from the rust-v0.158.0 source, not measured:
  - `codex-rs/shell-command/src/command_safety/is_dangerous_command.rs`
    classifies an `rm` whose options include `-f` or `--force` as dangerous.
    It parses a `trap` action as `sh -c` source to find one. An `rm` without
    a force flag is not classified dangerous.
  - `codex-rs/core/src/exec_policy.rs` forbids a dangerous command when the
    approval policy is `never`, with the message the Observation above
    recorded, and asks for approval under `on-request`.
  - `codex-rs/exec/src/lib.rs` sets `codex exec` to `never` unless its
    approvals reviewer is `AutoReview`.
  - That accounts for the refusal the Observation saw. An interactive session
    under `on-request` would ask instead.
- **Claude.** An owner's user-level `permissions.ask` entry `Bash(rm:*)` makes
  a headless run deny a direct `rm -f` (autopilot probes W2–W5, R1/R2). Measured
  on 2026-09-29 with Claude Code 2.1.284, one run each: the same rule did not
  match the `rm` inside the trap's quoted string, and that block ran. The trap
  failed on Codex only. The runbooks' other `rm` lines failed on both hosts,
  and S0 removes those too.

**What changed.**
- The four copies of `scripts/lib/args-file.mjs` remove the file and its
  directory once they have read its bytes. They do this before decoding, so a
  refused file goes too.
- **Ownership rule.** The reader removes only what the runbook's `mktemp -d`
  step made:
  - a file named `args.json`;
  - that is the only entry of a directory named `agentic-args.<suffix>`;
  - directly under the temporary directory: `$TMPDIR`, the platform's
    temporary directory or `/tmp`, compared after resolving links;
  - with neither the file nor the directory a symbolic link;
  - and only if that file is the one the reader opened. The path is normalized
    before these checks. Otherwise `<dir>//args.json` would name its
    directory with a trailing separator, and lstat would follow a link. The
    reader also compares the opened file with the file it would remove by
    device and inode, because Node folds `..` by spelling while the
    operating system follows a link first. Both cases came from the
    Refine-verify review of this change.

  Any other path is read and left alone. A matching directory that holds
  anything else is left whole, with a warning. The directory is removed with
  `rmdir`, never as a tree.
- Every runbook and Codex skill block that reads an args file drops its trap
  line, and its prose says the command removes the file.
- **The gaps.** A block that exits before the reader runs leaves the directory
  behind. (f) already stated this for a flow abandoned before the block.
  SIGKILL during the read does the same. The file is read once, so running a
  block again needs a new args file.
- **Tests.**
  - `tests/plugin-shape/test-runbook-shell-portability.mjs` checks that no
    block installs a shell cleanup. It runs a block in sh, bash, zsh and dash
    and checks that no directory is left when the reader succeeds, when it
    rejects the text, or when the file is not valid JSON. It also states the
    early-exit gap as a test.
  - `tests/plugin-shape/test-args-file-transport.mjs` §2b checks the ownership
    rule. Each case that must leave a path in place is paired with the owned
    case it differs from.
  - The K group of `scripts/mutation-specs/args-file-transport.mjs` was
    rewritten for this cleanup.

## Observation 2026-09-29 — after the amendment's release

Not a decision. The amendment above shipped in runtime 0.99.2, engineer
0.22.3, designer 0.3.12 and founder 0.4.12 (release PR
[#839](https://github.com/each4all/agentic-plugins/pull/839)). Its
post-release check ran on codex-cli 0.159.1 as `codex exec`, with the three
settings the first Observation of this date recorded still in place
(`approval_policy` `on-request`, the `workspace-write` sandbox and the
`guardian_approval` feature on), in a scratch worktree outside the repository. It ran one
`$engineer:decide` with a 126-byte topic of the same kind as that one, stopped
after the resolver, and one `$runtime:dashboard --recent 2`. In both runs the
model wrote the args file with its file tool and ran the skill's block with
its placeholders filled. Codex refused neither block, and neither run
executed `rm` or `rmdir`. The decide body reached the resolver byte for byte,
and both args directories were gone afterwards. The dashboard run added one
line assigning `REPO_ROOT`, which the runtime Codex skills use and do not
define; that predates this ADR and is not about argument transport. This is
evidence for those two runs. An interactive Codex session was not run. The
evidence-loop record `the-runbooks-that-run-as-written` carries both runs.

## Amendment 2026-10-10 — text an agent authors reaches the CLI as a file (item (j))

*Status of this amendment: Accepted. The owner accepted it on 2026-10-10,
before the change that carries it (PR #920) merged.*

**What was found.** (j) left one case open: text the model writes into a
runbook block. Docket item C130 found the same case at a worse site.
`orchestrator:plan` Phase 2 assigns the Plan-verify phase note as `NOTE="…"`.
The note's breakdown carries the peer's sentences, so a backtick or `$(…)` in
peer text ran as a command. A peer reproduced this under bash and zsh while
reviewing PR #918; the assignment dates from PR #53. A survey of the four
plugins that run such blocks (orchestrator, engineer, designer, founder) found
the class wherever a block has the agent splice text it authors, or copies
from a peer or the user, into shell source:

- double-quoted placeholders: a request, a phase note, a summary, a decision,
  an architecture, a next action, an owner's resolution;
- single-quoted ones: a next action, a commit subject, where an apostrophe ends
  the literal;
- the persona phase-note heredoc.

**The rule.** Text an agent authors, or copies from a peer or the user, never
becomes shell source. The agent writes it with its file-writing tool into a
file in a private directory, and the block passes the file's path to a
`--<name>-file` option, which the CLI reads itself. This stays as it is:

- fixed literals and enums;
- values the persona generator substitutes, which it escapes (ADR-0066
  Decision 4);
- the quoted expansion of data a program has already read: a parsed
  `$FEATURE`, the `AGENTIC_TOPIC` the orchestrator exports, a peer's
  `$RESPONSE`. Expansion results are not evaluated again.

**Why a file, and why not a heredoc.** Decision 1's reasoning applies to the
model's own text as it does to the user's: the file is written by a tool, so
no shell parses it. A quoted heredoc was measured against it on 2026-10-10, in
bash and zsh, with one payload that held a line `PHASE_NOTE` followed by a
command. The heredoc ended at that line and ran the command, truncating the
note. The file delivered the payload byte for byte and ran nothing. This is
the fixed-literal delimiter the Alternatives above already rejected. The
persona finalize blocks use it, with a written duty to rename the delimiter
when the note holds the line. That duty retires when those blocks pass the
note as a file, in a later change (below: it does not migrate the
producers).

**Why raw text, not Decision 2's JSON envelope.** The owner chose raw text on
2026-10-10, the shape the orchestrator already reads: `--reason-file`
(ADR-0062) and `consensus-task --text-file`. Decision 2 needed JSON to tell
an empty argument from a newline. None of these fields is empty, and none
needs a trailing newline of its own, so raw text loses nothing here. A
multi-paragraph Markdown note is then written as itself. Nothing in it needs
escaping, so no escape that is valid JSON but wrong can change it.

**The contract.** Each receiving CLI reads `--<name>-file <path>` as follows:

- At most one of `--<name>` and `--<name>-file`, and exactly one where the
  flag is required. Both is refused by presence, an empty inline value and an
  `=` spelling included. A `-file` flag given twice is refused, since the last
  value would leave the first file unread. Where a parser takes each value as
  the next argument, a glued `=` spelling of these flags is refused rather
  than kept as an unknown flag.
- The file is strict UTF-8, and a byte-order mark is content. A NUL byte is
  refused.
- Exactly one trailing LF or CRLF is removed: the file's own line end, which
  the writing tool adds. A second newline and a lone CR are content. Nothing
  else is trimmed.
- An empty value, a missing or unreadable file, and `-` (standard input) are
  refused, naming the flag.
- Every file named is read when the CLI starts, before any path that can
  write: a file the CLI refuses leaves the workflow, a run ledger, the index
  and HEAD as they were. What a command checks of the text afterwards keeps
  its old place. `settle`, for one, still refuses a blank summary for a
  completed run only after it has brought the run's handle up to date, as it
  does for an inline summary.
- The CLI never deletes the file, unlike the args file: one next-action file
  can feed both `append` and `finish-verb`. A block does not delete it either,
  since a headless run can deny `rm` (the amendment of 2026-09-29 above). The
  file lives in a `mktemp -d` directory under `$TMPDIR`.
- After transport each field keeps its existing treatment: a request is
  scrubbed to one line, `settle` collapses a summary's whitespace, a
  resolution is trimmed, and a subject must be one line, with the
  Conventional Commit check applied as configured (ADR-0028 P13: refused
  under strict, a warning under lenient).
- The inline flags stay, for programs and cross-plugin callers: the
  orchestrator still hands the topic to engineer as `AGENTIC_TOPIC`.

**The receivers.**

- Persona `scripts/state.mjs`: `--original-request-file`,
  `--next-action-file`, `--phase-note-file`, `--summary-file` and
  `--resolution-file`, wherever the inline flag is read.
- Persona `scripts/peer-runner.mjs settle`: `--summary-file`.
- Engineer `scripts/phase7-commit.mjs`: `--subject-file`, and a repeated
  `--subject-pkg-file <package>=<path>` (ADR-0028 P8).
- Orchestrator `scripts/state.mjs`: the persona list without
  `--resolution-file`, plus `--decision-file` and `--architecture-file`
  (`plan-set`).
- The persona readers live in the generated `state.mjs`, which `peer-runner`
  and `phase7-commit` import, so no shared module was added. The
  orchestrator carries its own reader (ADR-0010 §5).
- Prompts already travel as files (`--prompt-file`).

**The rollout is receiver-first.** On Claude Code a runbook's text can come
from a newer checkout than the scripts it runs. On Codex, a package edit
reaches an installed plugin through a release and its pin, or through a
deliberate local override (AGENTS.md § Release process). A CLI older than
its receiver does not always refuse a `-file` option it cannot read. Measured
on 2026-10-10 against the released engineer 0.28.0 CLIs and the
orchestrator's `state.mjs` before this change. The `state.mjs` and Phase 7
parsers keep an unknown flag, so where the inline flag is optional the
command succeeds without the text, exit 0. In both `state.mjs` CLIs,
`create --original-request-file` recorded an empty request,
`append --phase-note-file` a phase with no note, and
`append --next-action-file` kept the previous next action. Phase 7 needs no
subject on its recovery path and takes its own with `--suggested-subjects`,
so there it completes and the subject file goes unread. The command fails
only where the inline flag is required: `checkpoint-set` and `finish-verb`
name the missing flag, and Phase 7's ordinary commit a missing subject.
`settle` alone refuses any argument it does not know, so it fails on
`--summary-file` even where it needs no summary. A runbook that passed a
`-file` option before its CLI could read it would mostly lose the text
without a sign. So the receivers are released before any runbook passes the
option. The change carrying this amendment does three things:

- it adds the receivers;
- it converts the instructions the CLIs print themselves, so no CLI tells an
  agent to splice text: Phase 7's plan notes and diagnostics name
  `--suggested-subjects` for a subject used as suggested and the subject files
  for an edited one, `autopilot-preflight`'s clear recipe names
  `--resolution-file` and `--next-action-file`, and the start's worktree
  fallback names `/runtime:worktree plan`, which takes the request through its
  own args file, with no request text in the line;
- it records this decision.

**It does not migrate the producers.** Until two later changes land, the
persona runbooks, skills and pipeline regions, and the orchestrator's, still
splice text as this amendment found them:

- the persona producers, with the persona-pipeline README's phase-note
  section;
- the orchestrator producers, `plan.md`'s `NOTE="…"` among them.

Each change replaces a form with the file transport and adds a guard against
its return. Neither is claimed here.

**Tests.**

- The receivers' suites run the file forms with hostile text, as much of it
  as each field can hold: a backtick, `$(…)`, both quotes, a backslash, a
  leading `--`, a line `PHASE_NOTE`, CRLF and non-ASCII text. The text
  arrives as written and nothing in it runs.
- The same suites check the trailing-newline rule, the BOM, and each
  refusal: both forms, an empty, missing, non-UTF-8 or NUL-holding file, and
  standard input. Each refusal leaves the workflow file byte for byte.
- For `settle` and Phase 7 the refusal comes before the write each would make
  first: a launched run's failed result, and the recovery path's
  `beginCommit`.

**Still open.** (j)'s second finding, `decide` writing its workflow before it
reads the args file, is not decided here.

## History

The records dated before 2026-11-25 stay above, as they were written. Later
records are in [the history file](history/0059-runbook-argument-transport.md):

- 2026-11-25, amendment: [Amendment 2026-11-25 — which directories a runbook may remove, and how (C175)](history/0059-runbook-argument-transport.md#amendment-2026-11-25--which-directories-a-runbook-may-remove-and-how-c175)
