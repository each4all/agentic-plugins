# Verb finalize: the cases that are not the plain one

<!-- pipeline:begin finalize-reference -->
A verb runbook's finalize block (`/founder:compose`, `frame`,
`investigate`, `decide`, `critique` and `refine`, each in its Phase 2) says
what to set and what to write before the block. This reference holds the rest:
what the block does with a case that is not the plain one, and why each of its
steps is as it is. Read the section whose heading names what you see; a normal
step needs none of them.

## When the block stops

Every check the block makes before `peer-runner.mjs settle`, its first write,
says `nothing was written`: the workflow is as it was. Fix what the message
names and run the block again; the message names a fresh `TEXT_DIR` when the
rerun needs one.
A stop after settle is a stop on the workflow's own state, and its message
says what: see § Running the block again.

## Which run the block settles (`DISPATCH_DIR`)

The block reads the run's id from the result the runner wrote in
`DISPATCH_DIR`, `prompt.xml.run.json`, never from a value carried from the
dispatch's shell. A runner that ended without writing its result (killed, or
stopped by an error after it launched the run) leaves that file empty: the
block then takes the run from `prompt.xml.dispatch.json`, which the dispatch
block wrote there before the launch, naming the run and the workflow. A run
whose handle or record names another workflow than the one the block finds, a
handle that cannot be read as that run's (one gone is left to the dispatch's
record), or a directory with no result, or one naming no well-formed run id,
stops the block before any write; settle, its first write, refuses a run of
another phase. A well-formed run id is one the runner accepts: letters,
digits, `.`, `_`, `:` and `-`, with no `..`, so a run the runner launched can
always be finalized.

An empty `DISPATCH_DIR` is the empty id, "no run launched", and settle refuses
it while the workflow holds a run of this phase it would hide. It never stands
for a run whose directory is gone, and no run is chosen from the workflow's
pending entries.

When a run launched but its dispatch's directory is gone (a later session, or
a system that cleared its temporary files), `DISPATCH_DIR` is the run's own
ledger directory, the one holding the `envelope.json` the synthesis read
(`.agentic-plugins/state/founder/peer-runs/<run id>`): the block reads the
run from its `handle.json` and checks it as it checks a dispatch's, the
workflow in the block and the phase in settle, so the run settled is always
the one the synthesis read. With neither directory left, nothing binds the run
to the synthesis: the block cannot settle it, and settle does by hand
(`peer-runner.mjs settle --run-id`); then run the block with `DISPATCH_DIR`
empty from a fresh `TEXT_DIR`. A limit: a run already recorded with the
verdict `conflict` and no owner ruling is not ended that way (§ A conflict:
it holds every finish but its own, and the empty id names no run), so with
neither directory left that conflict is the owner's to decide.

## When no run launched (`NO_RUN_REASON`, `ATTEMPT_TYPE`)

For a review, settle records the attempt with the outcome the reason gives,
`unavailable` or `skipped`, under an id derived from `TEXT_DIR`, so a rerun
records it once (C163 A1a); with `NO_RUN_REASON` left empty, the attempt is
`skipped` with the reason `unspecified`. For an ensemble that is no review it
records nothing. Settle records `subject.json`, when the text directory holds
one, with the attempt (ADR-0069); with no such file the attempt covers no
path. `ATTEMPT_TYPE` records a review that never launched under the type it
would have had. A `peer-runner.mjs` older than the runbook takes none of
these flags, so the block passes them only when the script names them; it then
records no attempt, and settles as before.

## What settle records, and when it refuses

`peer-runner.mjs settle` decides from the run ledger what the workflow
records, not from the block's values alone: a run that never launched records
no verdict (for a review, the attempt of § When no run launched); a run that launched and failed, was cancelled or was abandoned
records verdict `failed` with the ledger's `error_kind`; a run that completed
records the synthesis verdict, or `degraded` when its answer was empty or
unreadable. It runs before the block writes anything, so its refusal leaves
the workflow as it was:

- while a run is still live, or its handle, not yet terminal, was last
  updated less than the stale grace (a minute) ago: collect it, or wait, and
  run the block again;
- for a run of another workflow or phase;
- when an empty id would hide an attempt the ledger holds for this phase:
  collect that run and synthesize it, then set `DISPATCH_DIR` to its
  directory, or to its ledger directory when that is gone, and finalize from a
  fresh text directory.

Once it has recorded a run, running the block again records nothing more for
it.

## Running the block again

Whatever run the block settles, the empty id included, it keeps in its text
directory as `finalize-run.json` before settle. Every value the last write
takes is checked before settle too, so a step that fails after it fails on the
workflow's own state, and its message says what. Run again with the same
`TEXT_DIR` after a later step failed, the block settles that same run again,
which records nothing more; a phase note the failed run already appended (the
failure came at the last write) is appended a second time. A kept run that
differs from the one this run of the block names stops it before any write:
each finalize takes a fresh text directory, and a record left by another stays
its own. The empty id binds too: after settle refuses it (a run of this phase
is pending), collect that run, synthesize it, and finalize it from a fresh
text directory. A file left unwritten, blank, or not UTF-8 text stops the
block as well: each of `note.md`, `summary.txt` and `next-action.txt` is held
to every reader's rule before any write (strict UTF-8, no NUL byte, text left
once blanks are trimmed), since the append reads the note only after settle
has written.

## The last write and the Stop hook

`next-action.txt`, which the append and the last write record, holds the
compact form of the proposal (selected_next + one-line why + next_command) so
the durable state and the code-emitted completion footer agree with the Active
Next-Action Proposal (ADR-0029 §1). In the verb form `finish-verb` is the
verb's last write (ADR-0063 D3): the ADR-0017 §sub-decision 5 atomic terminal
write (summary-complete + terminal marker) with the next step. A write that
records an owner gate is never terminal, and neither is the `append` a verb
that waits for convergence ends with when it did not converge.
An inherited `AGENTIC_AUTOPILOT` changes nothing in it (ADR-0066 Decision 3).

After a terminal write the archive gates are evaluated, on Claude, at the end
of that turn, not at session close (on Codex only once the plugin hooks are
trusted); if a gate fails the workflow stays marked and a
later Stop re-evaluates it. Clearing the marker with `set-terminal
--terminal-marker false` needs set-terminal's full flag set
(`--workflow-path`, `--host`, `--terminal-phase`), and does not restore the
previous phase or next_action. Full contract: `session-handoff.md` § Archive
timing.

## A conflict (`investigate`, `decide` and `critique`)

The block branches on the verdict the settle recorded for the run, not on
`VERDICT` alone, and before it appends the phase note. Recorded `conflict`,
with `VERDICT` set to `conflict`, it writes the contested items to the task
file (`consensus-task`), then appends the note and records the gate with the
run id in the same write as the next step `owner-decision`. When the recorded
verdict and `VERDICT` disagree (a run recorded `failed`, or a conflict
recorded by an earlier attempt), or the task file cannot be written, the block
stops after the settle and before the phase note, and its message says what to
set: the recorded verdict, with `contested.md` when that is `conflict`, or,
for a conflict with no run named, the run's directory. Run the block again:
its settle does nothing for a run it already recorded, so the branch that
matches runs and the note is appended once: on a conflict, `consensus-task`
first, then the note and the gate. The task file, written again on a later run
of the block, is replaced whole. compose, frame and refine, and every other
verdict, never take this branch.

Before settle, the block reads every result this phase recorded on the
workflow, and the gate it holds. A recorded conflict with no owner ruling
holds the phase, and only that same run, finalized with `VERDICT` set to
`conflict`, gets past it. Two machine-written records count as a ruling: the
verb's conflict gate, pending and naming that run, and that run's retired task
file (the owner cleared the gate). While the verb's conflict gate is pending,
it holds every finish but a run of the block for the gate's own run with
`VERDICT` set to `conflict`, the empty id included; its message says the owner
resolves the gate first. With no such gate pending, a conflict whose task file
was never retired (the gate was never set, for example because an earlier run
of the block stopped at `consensus-task`) holds every finish but its own run's
as a conflict, whatever later run the phase recorded since: any other
`VERDICT`, the empty id, and any other run finalized as a conflict stop the
block before any write, and its message names that run, to finalize first with
`VERDICT` set to `conflict`. A conflict whose id could never name a gate (a
run settled by hand under such an id) stops it too, and its message says the
owner decides it: no run of the block can end it on its gate. A recorded
conflict thus never ends without its gate. The read comes before settle
because a run settled now is not yet recorded, and a run recorded later cannot
hide an earlier conflict.

With `VERDICT` set to `conflict`, the run id must also suit the task file and
the gate: a letter or digit, then letters, digits, `_` and `-`, 128 at most,
as the runbook's dispatch makes them; and on every path an id opening with
`--` stops the block, since the verdict read takes it as a flag. Both stop it
before any write.
<!-- pipeline:end finalize-reference -->
