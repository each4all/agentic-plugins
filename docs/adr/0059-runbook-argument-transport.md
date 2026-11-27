# ADR-0059: Runbook argument transport — the text reaches the CLI as a written file, and the shell never sees it

## Status

Accepted

Decision 9, which directories a runbook may remove and how (amendment of
2026-11-25, C175), and Decision 10, when a runbook releases its directories
(amendment of 2026-11-26, C175): Accepted (2026-11-26, the owner explicitly
in the main session). Implemented for the persona plugins (designer,
engineer, founder; implementation note of 2026-11-27): their runbooks,
skills and references make each text and operation directory through the
make and release it on the paths `persona-pipeline/tmpdir-paths.json`
lists. Not yet implemented for the orchestrator: until its runbooks switch
(Decision 10, item 8), its blocks keep `mktemp -d` and delete nothing.

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

Item 7 states the limits of the proof. *Amended 2026-11-25 (C175, slice 1): [history](history/0059-runbook-argument-transport.md#amendment-2026-11-25--which-directories-a-runbook-may-remove-and-how-c175).*

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
2. **The CLI makes the directory and marks it.** Such a
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
3. **The proof.** The release is given the path the make
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
4. **The claim, then the removal.**
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
5. **Outcomes.** The release prints one JSON line and exits
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
6. **Rollout and what this leaves.** The make
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
     directory outlives every read of it in that trap (Decision 10, item 1
     releases it as the trap's last step);
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
   [Decision 10](#decision-10) decides each of them. *Amended
   2026-11-26 (C175, slice 2; the trap constraint reworded on acceptance): [history](history/0059-runbook-argument-transport.md#amendment-2026-11-26--when-a-runbook-releases-its-directories-c175).*
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
   Decision 10, item 7 keeps this a limit and says why. *Amended
   2026-11-26 (C175, slice 2): [history](history/0059-runbook-argument-transport.md#amendment-2026-11-26--when-a-runbook-releases-its-directories-c175).*

<a id="decision-10"></a>
**10. A runbook releases each directory it made once, after the last read
of it, on each path that leaves no reader of it, and keeps it on every
other path.**

Item 7 states the limits.
*Amended 2026-11-26 (C175, slice 2): [history](history/0059-runbook-argument-transport.md#amendment-2026-11-26--when-a-runbook-releases-its-directories-c175).*

This decision applies Decision 9 to the runbooks. It changes nothing in
Decision 9's proof, claim or outcomes (items 2 to 5), with three exceptions:
the `unsupported` and `unsupported-path` outcomes that items 4 and 1
add, the message that item 5 changes, and the owner's release path of
item 6.

1. **A releasing step on every successful end of the command.**
   A command's phases run in separate shell calls, and each one reads the
   directory again, so the block that made a directory is rarely the last
   one to read it. The runbook therefore names a releasing step for each
   directory on **each path where item 2 makes it releasable**, not on one
   block: every path that ends the command successfully, a directory whose
   last reader has run before the command ends, and an end that no rerun
   reads. Each releasing step is the last step on that directory's path,
   not necessarily the command's (the early releases above). It comes
   after every write and every read of the directory on that path: the
   block's own reads, its exit trap, and any file the runbook has the agent
   read after the block exits (a response, or an error file such as
   `prompt.xml.err`). No successful end is exempt. Where the agent would
   read a file of the directory after the last block of a successful end,
   that block prints the file's text, or the path of a copy outside the
   directory (a peer run's ledger file), to its own output before it
   releases; where it cannot, the runbook adds a last block whose only
   work is the release, after the agent's read. The runbook change that
   switches a command lists every path that ends it and the releasing step
   on each, and item 8's static check holds every make to that list. The
   bullets below give the kinds of end the measurement found (history),
   with the sites it named; they are the classes a runbook change starts
   from, not a complete list of its paths:
   - **A persona verb.** The bootstrap block releases its request
     directory after `create` succeeded. The topic directory it makes for
     `AGENTIC_TOPIC` is made and released in that same block, from the
     variable it holds. The finalize releases its own text directory, the
     dispatch's text directory and `OP_DIR` after its last write succeeded.
     That holds whichever form the last write took: the verb, verify or
     owner-decision form. Inside `/engineer:start`, and on refine's
     owner-gate paths (close inside `/start`, *Fix now* carrying `OP_DIR`
     into another finalize, the *Defer* block), the releasing step is on
     the path that makes the operation's last write. The same holds for
     decide's owner-selection resolution, its text directory and the
     operation directory it opens when `OP_DIR` is empty
     (`decide-owner-selection.md`).
   - **Directories a verb makes inside its own run**, for a block whose
     write is not the operation's last: critique's scope close, refine's
     scope record, a skill's review settle and the routing owner gates
     (`critique-scope-close.md`, `refine-scope-record.md`,
     `skill-review-settle.md`, `routing-owner-gates.md`). Each such
     directory is released by the block that reads it last, after its
     write succeeded, and only when neither a later block nor a retry of
     the command reads it. Work a runbook repeats (refine's scope record,
     run again after a later edit) makes a fresh directory each time, so
     each run's release ends only its own.
   - **`/<persona>:start`.** Its bootstrap and each phase boundary make
     directories of their own (`start-bootstrap.md`,
     `start-phase-boundary.md`); each is released by the block that reads
     it last. The terminal step releases what it made: after the commit
     (below), or, on the founder and designer terminal that commits
     nothing, after its terminal write (`start-terminal.md`).
   - **Persona `/checkpoint` and `/resume`.** The block that writes the
     checkpoint or the resume marker releases its text
     directory after that write (`checkpoint-set.md`, `resume-*.md`).
     `/resume` also makes a read directory (`READ_DIR`, `resume-read.md`)
     that the drift report and the marker block read; the marker block
     releases both, after the marker's write, and also on its successful
     path that skips the marker (an invalid baseline, which it reports and
     ends with status 0, `resume-marker.md`). `/resume archive <id>`
     resolves the id in a block of its own, which reads `workflow-id.txt`
     from its text directory and prints the workflow path
     (`resume-archive-resolve.md`); the archive block, run after the user
     confirms, is given only that path (`resume-archive.md`). The resolver
     block therefore releases its directory after it prints the path, its
     last read, so that confirmation and cancellation alike leave nothing to
     release. A refused resolution keeps it: the user corrects the id file
     and runs the block again (item 3).
   - **A peer consultation** (`peer-now`, persona and orchestrator). With a
     workflow, the persona's note block appends the note and closes the
     nested `op`; the orchestrator's has no nested `op`, and appends only.
     The response the command then shows is the run's stdout file in the
     peer-run ledger, which the note block names from the run result in the
     text directory: the block prints that ledger path (or the response)
     before it releases, so no later read touches the text directory.
     Standalone, the block that shows the response releases, after
     printing it. A run with no terminal result leaves its operation open
     on purpose, and is no successful end: its directory is kept (item 3).
     The persona skill's separate note directory is released by the note's
     block.
   - **The commit** (`/engineer:commit`, `/engineer:start`'s Phase 7 and
     their persona twins). The subject and body directory is released only
     after the driver's whole success: the commits made, the gates after
     them passed and the terminal write done, or, on the close path, the
     workflow archived. A stop at the staging-set gate is also a whole
     success, since its gate write was the driver's last write and the
     owner's commit composes its own body.
   - **`/orchestrator:next`.** The release is the last step of Phase 5's
     exit trap (Phase 4's writeback on the Codex skill). It runs only when
     each of three results authorizes it, each read on its own: the
     writeback exited 0; the admission release exited 0; and the mark's
     withdrawal reported, in a form the block reads rather than an exit
     status, one of four dispositions: `withdrawn` (removed now), `gone`
     (shown absent: the lane's operation registry was read `absent`, or
     read `ok` with no record of the id), `unpublished` (the mark file
     names no operation id) or `carried` (a child linked to the subtask
     holds its id, and the record stays under the child's ownership, which
     the child's last write ends). Each of these authorizes the release.
     Nothing else does, since none of the rest shows who holds the mark:
     `unknown` (a child that could not be read, which may own the record),
     `unreadable` (a registry that could not be read, so absence is not
     shown), a withdrawal that failed outright (a mark file or state root
     that cannot be read, a lock that fails: an error raised before any
     ownership is established) and a reply the block does not recognize (an
     older CLI). Today the helper reports `carried` for both a carrying
     child and an unreadable one, `gone` for an unreadable registry
     (`readOps` returns `unreadable` with no records, and
     `withdrawDispatchMark` reads that as no record), and exits 0 with no
     word for a null operation id, so the CLI that ships first (item 8)
     reports each of them apart. A trap whose helper cannot read the
     subtask (today `|| return 0`) authorizes nothing either. The trap sets
     the block's exit status from these results, so an exit 0 with a failed
     cleanup cannot happen: an `EXIT` trap that only runs commands leaves
     the status the block had. Phase 3b's trap never releases, since a
     rerun of Phase 3b reads the directory. A refusal, in Phase 3b or
     before it, keeps its directory too: each refusal message either tells
     the user to rerun `/orchestrator:next`, or points to another command
     (`/orchestrator:plan` for an empty plan, `/orchestrator:finalize` when
     every subtask is terminal) without saying whether a later
     `/orchestrator:next` may start from this directory, and the command's
     own text lets a block run again over what the earlier phases kept, so
     a reader may be left (item 2). Retention is the default while such
     reuse remains possible. A switching
     change that releases on some refusal (every subtask terminal, say)
     rewrites that refusal's message in the same change to say what item 2
     requires (item 8).
   - **`/orchestrator:plan`.** The last block that succeeds releases the
     directory: the one that appends the note, commits the summary and
     records `contested.md` when there is a conflict. Its retries read the
     directory, and so does a report of a prompt that could not be read
     (`prompt.xml.err`). A persisted consensus task is read from its own
     path, never from the text directory.
   - **`/orchestrator:done`** and the other orchestrator commands. The path
     that reads the reason file, or the text, last releases its directory,
     after that read. `done` makes its reason directory inside its one
     block, on every run, so no rerun reads an earlier run's: the block
     releases it on each of its exits, as the last step, after the
     admission trap's release where the path joined the admission. Its
     path for a subtask already completed exits 0 without recording
     anything on the subtask and never reads the reason file, but it runs
     `holds-retire`, which may finish a retirement of the subtask's hold
     records (a write). That call's exit 0 is no evidence that the
     retirement happened: it exits 0 after warning that the retirement is
     waiting, is unreadable or failed (`state.mjs`, the holds-retire
     helper). The release does not wait on it, since the call is no reader
     of the directory: a retirement not finished is retried by a later
     `done`, `holds-retire`, `status`, the next Stop or the next run, none
     of which reads it. The release follows the call whatever it reports,
     and the call's own warning is the report of a deferred retirement.
   - An args directory keeps the reader's removal (the amendment of
     2026-09-29).

   **What the release is given.** A directory that a later block releases
   reaches that block on a line of its own: the releasing block opens with
   one line per such directory, the path the make printed, apart from the
   lines it reads through. A block that makes and releases a directory in
   the same shell call has no such line, since the path does not exist when
   the block opens: it releases the directory from the variable that
   captured the make's output, never from a path it reads (a file, an
   argument, another block's output). The dispatched bootstrap's topic
   directory and `/orchestrator:done`'s reason directory are released this
   way. A nested `op` has no line and no releasing step of its own: it is
   never released on its own and goes with its parent's release (Decision
   9, item 3). A finalize's `DISPATCH_DIR` may name a peer run's ledger
   directory, or be empty when no run launched, while the
   dispatch still made a text directory. That text directory has its own
   line, and is released even when no run launched. A ledger directory is
   never given to the release. The make refuses a path that a
   single-quoted shell literal cannot carry (a `'`, or a control character
   such as a line break) with the reason `unsupported-path`, and makes
   nothing. No fallback follows that refusal: `mktemp -d` under the same
   `TMPDIR` would make a path that the later blocks cannot carry either, so
   the block stops and says to set `TMPDIR` to a path without such
   characters (item 4).
2. **Once no reader is left, and never twice.** This is the
   one rule of when a directory may be released; items 1 and 3 apply it. A
   directory is releasable at a point of a path when both hold:
   - every write and read of it the path makes has completed, and so has
     every cleanup the path runs before that point; and
   - no reader of it is left after that point: no later block of the path,
     no rerun or retry that the runbook, its reference or the block's own
     message directs from that state, and no continuation of the command
     (a finalize after a dispatch, a commit after a verb).

   A path's success is the ordinary case: its last write having completed,
   whatever it recorded (an owner gate written by the block's last write
   is a success, while a block that stops before its last write, a gate
   written earlier in the block included, is not), or, for a path that
   ends the command with status 0 and writes nothing (a no-op the command
   reports as done), its last read. A release inside a run (item 1's
   bootstrap and in-verb directories) is the same rule met before the
   command ends. A path that ends non-zero leaves a reader whenever its
   message directs a rerun of the block or the command over the same
   directory, or says nothing of what follows while the runbook lets a
   block run again over what earlier blocks kept; it is releasable only
   where no rerun can read the directory (a block that makes the directory
   afresh on every run) or the message itself says that nothing reads it
   again. The runbook never tells the agent to release a directory by
   hand, or to run the release again, and never runs a block again over a
   directory it has released. Work the runbook repeats makes a fresh
   directory each time (item 1), so the rule is kept per directory, not
   per command. Whether the inputs are gone is no replay guard: when a
   release is refused or skipped they remain, and a block run again over
   them could repeat its writes. Item 4's line therefore says that nothing
   is to be repeated.
3. **What a failure keeps.** On every path that does not end in
   a success, the command keeps each directory it made that a remaining
   block, a retry or a continuation of the command still reads (item 2).
   A directory item 1 released earlier, after its last reader and with no
   retry reading it, is not among them, nor is one that every run of its
   block makes afresh (`/orchestrator:done`'s reason directory). The
   directories kept are the inputs the next step reads:
   - a block that exits non-zero, a finalize's later step included, which
     its rerun repeats from the same directories;
   - a refusal the runbook answers by rewriting a file and running the
     block again: a commit subject or body refused (exit 9 or 2), and a
     verify request the finalize refuses;
   - a `review-held` commit (exit 10), whose report is the owner's: the
     commit runs again after the owner's acceptance or a new review;
   - a split commit that stopped halfway, a gate that failed after commits
     landed, and an archive that was refused, each of which a rerun of the
     commit resumes;
   - in `/orchestrator:next`, a writeback that succeeded while the
     withdrawal or the admission release did not authorize the release
     (item 1). The admission id and the mark file stay readable. Recovery
     is cleanup only, never a rerun of Phase 5, which checks the admission
     before it writes, and each leftover has its own action. An admission
     still held is released by `admission release`, which takes the
     admission id (`admission`), whatever became of the mark. A mark whose
     withdrawal did not show who holds it (`unknown`, `unreadable`, a
     withdrawal that failed outright, or a reply the block does not
     recognize, item 1) is of unresolved ownership, and is never cleared on
     that ground: the child may hold the operation, and a `writer-clear`,
     which records the clear without checking whether the child still
     runs, would lift its lane exclusion and make its closing write refuse.
     The directory is kept, and recovery runs the withdrawal again once its
     cause is fixed (`dispatch-mark-withdraw` with the kept mark file,
     which goes through the ownership check) until it reports one of item
     1's authorizing dispositions. The owner's `writer-clear`, which takes
     the mark's operation id (`dispatch-mark.json`), is for one case only:
     the owner has established that the operation's session is gone. The
     block's message names whichever is left, with its id, and for a mark
     the withdrawal to retry first.

   The ownership rule of the last bullet holds for every exit of
   `/orchestrator:next` that leaves a mark, not only a writeback that
   succeeded, and on both hosts (the Codex skill's Phase 3b and Phase 4
   blocks included):
   - **A writeback that failed, or an exit before it.** The mark is ended
     as above: the withdrawal, retried with the original lane arguments
     (the subtask and branch kept in `subtask.json`) and the kept mark
     file, until it reports an authorizing disposition. Where the mark
     file is gone (today's Phase 5 refusal for a missing
     `dispatch-mark.json` sends the owner straight to `writer-clear`), the
     operation is found by its exact id (`agentic-autopilot status`), and
     cleared only once the owner has established that its session is gone.
     The switching change rewrites that refusal's message to say so.
   - **A rerun of Phase 3b over a kept mark.** Phase 3b withdraws a mark an
     earlier run of the block left before it publishes a new one, and the
     publication rewrites the mark file. Today it calls the withdrawal
     without reading its result, so an indeterminate withdrawal followed
     by a publication replaces the only record of the old operation id.
     The block proceeds to the publication only on an authorizing
     disposition; on any other it stops, keeps the mark file and the lane
     arguments as they are, and names the withdrawal to retry.

   "Kept" is bounded by where the directory was made. In an autopilot step
   the directory is under the step's `TMPDIR`, which ADR-0068, Decision 5,
   item 13 removes once the step's peers are settled, whatever the outcome
   and subject to its guards. There, what crosses into a later step is
   what the workflow and the run record, not these directories, and a
   later step starts in directories of its own (as ADR-0068 already
   expects of a replay).
4. **How a release is reported.** This covers every release
   attempt, on a successful end or on any other end item 2 allows. The release
   reports on the directory, never on the command. Its line goes to
   standard error, so that the block's own output on standard output (a
   driver's JSON) stays intact. This rule is for the release's own
   outcome: it never changes the block's exit status, which stays what the
   path's own work set, the primary operation's, or, in
   `/orchestrator:next`'s Phase 5 trap, the status item 1 has the trap set
   from the writeback, withdrawal and admission release results.
   - `removed` and `absent` print nothing.
   - Each other outcome prints one line with the disposition Decision 9,
     item 5 gives it:
     - `not-owned`, `refused`, `contention` or `error`: the directory is
       kept at its path, which the line names;
     - `claimed`: it is left at its `.removing-` path, which the line names,
       together with the check that failed;
     - `partial`: some entries are gone, and the line says whether the
       marker remains.
     The line never suggests rerunning the block, the release or the
     command.
   - A release that dies, or prints nothing, or prints a line that does not
     parse: the block prints one line saying that the release's result is
     unknown, and that the directory may remain at its path or at its
     `.removing-` path.
   - **An older CLI.** The block looks for the subcommand as the runbooks
     look for a flag. A CLI that can be read and lacks the release
     subcommand skips the release with one line: the directory is kept. A
     CLI that cannot be read stops the block, as running it would. A CLI
     that lacks the make subcommand makes the directory with
     `mktemp -d "${TMPDIR:-/tmp}/…"` as today, with what that does with an
     empty `TMPDIR`. A nested make whose parent text directory has no
     marker (a parent made the old way) makes `op` the old way too,
     `mkdir -m 700`, so a legacy parent always holds a legacy `op`.
   - **Where the make is unsupported** (the platform of Decision 9, item 2,
     **Platforms**): the make exits with the reason `unsupported`, and the
     block makes the directory with `mktemp -d` and prints one line saying
     that it will not be released. The path travels to later blocks as
     today's `mktemp -d` path does.
   - **A path no fallback may carry.** Every branch that hands a path to
     later shell calls checks it first: the make refuses it as
     `unsupported-path` (item 1), and the fallback branches (an older CLI,
     an unsupported platform, a legacy nested `op`) check the path
     `mktemp -d` or `mkdir` produced with the same rule in the block's own
     shell (a `case` on `'` and control characters) before printing it,
     and stop the block when it fails. A `TMPDIR` a single-quoted literal
     cannot carry thus stops the block on every branch.
     The release of such a directory changes nothing, reports
     `unsupported` with status 0, and prints nothing. Any other failure of
     the make (a `TMPDIR` that is set but unusable, no space) stops the
     block, as a failed `mktemp -d` does today.
5. **The closing write's message.** A missing operation
   directory does not tell which write already ran: the workflow's list of
   open operations may hold a later operation, and an empty list does not
   prove that the write landed. So the last write, given an operation
   directory that is missing, no longer advises running the write with no
   operation directory. It writes nothing, exits non-zero, and says that
   the directory may have been released after this write already ran, in
   which case nothing is to be repeated, or lost. It names the workflow's
   open operations, and for a lost directory it names the owner's
   `writer-clear`, with item 3's condition: only once the owner has
   established that the operation's session is gone, since a clear while
   the session still runs lifts its lane exclusion and makes its closing
   write refuse.
6. **Abandoned directories: listed, and removed by the owner.**
   No CLI removes a directory by age on its own. Seven days without a write
   does not prove that a command is over: a `/orchestrator:next` paused
   after its switch keeps its admission id and dispatch mark in its text
   directory, outside the `operation.json` that Decision 9 judges, and a
   later read would find them gone.
   - **The listing.** A subcommand of each CLI that makes directories reads
     the root and changes nothing. It names every entry of a top-level
     kind's form, with the newest modification time among the directory
     and its entries (`lstat`) and its state: marked and releasable,
     marked and refused (with the reason code), claimed (a `.removing-`
     path), or without a marker.
   - **`--execute`.** The owner's run releases marked directories the
     listing found, each `<name>` passed to the release one at a time,
     through the full proof. This is the CLI reading the root itself, not a
     path a block transcribed, which is what Decision 9, item 3 guards
     against. Age only narrows the candidates: a directory whose newest
     modification time is younger than an age the owner gives (7 days by
     default) is never selected, but an older one is not thereby over, for
     the reason this item opens with. What the run relies on instead is the
     owner's precondition, stated in its output before it acts: **no
     command whose directories the root could hold is running, paused or
     awaiting a retry** — no `/orchestrator:next` between its switch and
     its writeback, no admission held, no persona operation open, no peer
     run unsettled, no finalize or commit the owner means to rerun — and no
     other run of `--execute`. Two checks narrow what a mistaken
     precondition costs. The run skips every directory that holds a file a
     paused `/orchestrator:next` keeps outside `operation.json`
     (`admission`, `dispatch-mark.json`); the owner releases such a
     directory by naming its path, after clearing what it records. And it
     runs **claim-only**: when `.removing-<name>` exists, or appears before
     the claim, it skips that directory rather than finishing it. It
     finishes a `.removing-` path only when the owner names that path, on
     the same precondition.
   - **What no CLI removes**, though the listing names it: a directory
     with no marker (made by `mktemp -d` before the switch, an interrupted
     make, a directory a late writer recreated, a `.removing-` path emptied
     down to no marker); a marked directory whose operation is not
     `closed`, or whose transport has no marker id; and an empty
     `.removing-` placeholder left by a claim.
7. **Limits.**
   - Once the runbooks switch, abandoned directories grow only on paths
     that end without a success (item 3) or are abandoned, and on a
     successful end whose release was refused or skipped, or whose make
     was unsupported (item 4). They are not bounded until the owner
     runs `--execute`, outside autopilot steps.
   - `--execute` rests on the owner's precondition, which no CLI checks: a
     command paused across sessions, or a retry the owner forgot, is not
     visible in a directory's age. The skip of `/orchestrator:next`'s kept
     files covers the case that motivated item 6; any other paused reader
     (a finalize, a commit, a `/start` between phases) loses its inputs if
     the owner runs `--execute` while it waits, and its retry then starts
     from fresh directories.
   - An owner's `--execute` after a failed finalize can still change that
     finalize's retry. An open `OP_DIR` is refused and stays. A text
     directory that goes takes `finalize-run.json` and
     `finalize-verify.json` with it. The run's ledger recovers a launched
     run, but not a verify request, nor the identity of a review attempt
     that never launched, which is derived from the text directory's path.
     A retry from a fresh directory may then register a second attempt, or
     append a second phase note.
   - The swap of two live directories' paths (Decision 9, item 7) stays a
     limit. Giving the release the marker id beside the path would not bind
     it: the id travels the way the path does, and a model that copies
     another command's directory copies that command's id with it. What
     narrows the window is item 1: a directory released is live only until
     its last reader has run. A directory kept (item 3) stays live across
     the command's exit while a retry or a cleanup still uses it, and the
     window stays open for it until then.
8. **Rollout.** Decision 9, item 6 stands: the CLI ships first,
   and its measurements come before any runbook switches. Then each
   runbook switches in one change per package, its make and its releasing
   steps together, the persona pipeline's regions first and the
   orchestrator's commands and skills after. Each change lists, for each
   directory it makes, every path through the command, not only its
   successful ends: on each path the directory's last write, last read and
   the cleanup before the release, the readers a retry or rerun from that
   state would have, and whether item 2 releases it there (where) or keeps
   it (item 3). Early releases inside a run, and releases on a non-zero
   end such as `done`'s, are entries of that list like any other. A static
   check refuses two things: a `mktemp -d` of a text or operation
   directory, or a raw `mkdir` of a nested `op`, left in a switched
   runbook outside item 4's fallback branches (the make's `unsupported`
   platform outcome, a CLI that lacks the make, a legacy parent's `op`),
   and a make whose releasing steps do not match that list (a path the
   list releases on with no releasing step, or a releasing step on a path
   the list keeps). It also holds each releasing step to item 1's input:
   the directory's line at the head of the releasing block, or, for a
   directory the same block made, the variable that captured that make's
   output, and nothing else. A change that releases a directory on an end
   with a non-zero status rewrites that end's message in the same change, so that
   the message says that nothing reads the directory again, unless every
   run of the block makes that directory afresh (item 2). A count of make
   sites
   does not show that the timing is right; the list of paths does. Once a
   package's runbooks have switched, the sentence of the amendment of
   2026-10-10 that says a block never deletes the file is folded for that
   package's text and operation directories, and so is the `AGENTS.md`
   sentence. The rule that a block never runs `rm` stands.

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
  can feed both `append` and `finish-verb`. No block deletes the file on its
  own or runs `rm`, since a headless run can deny `rm` (the amendment of
  2026-09-29 above). The file lives in a private directory under `$TMPDIR`.
  In a package whose runbooks have switched (Decision 10, item 8: today the
  persona plugins, designer, engineer and founder), the make marks that
  directory, and the runbook releases it, with the file, through the CLI's
  proof once no reader of it is left (Decisions 9 and 10). Until a package
  switches (today the orchestrator), it is a `mktemp -d` directory and nothing
  deletes the file. *Amended 2026-11-27 (folded for the persona plugins, as
  Decision 9, item 6 and Decision 10, item 8 require): [history](history/0059-runbook-argument-transport.md#fold-2026-11-27--the-amendment-of-2026-10-10s-bullet-for-the-persona-plugins).*
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
- 2026-11-26, amendment: [Amendment 2026-11-26 — when a runbook releases its directories (C175)](history/0059-runbook-argument-transport.md#amendment-2026-11-26--when-a-runbook-releases-its-directories-c175)
