# ADR-0023 history: Peer-runner supervisor layer for companion dispatch

This file is the record: amendments, implementation notes and superseded text
of [ADR-0023](../0023-peer-runner-supervisor-layer.md), each as it was
written. The ADR states the current decision (ADR-0070). The amendments and
implementation notes dated before this file was opened stay in the ADR, as
they were written there.

## Amendment 2026-11-22 — a macOS start read in the C locale and UTC (C141)

**Why.** On macOS a process's fingerprint was its `ps -o lstart= -o
command=` text, read in the caller's locale and time zone (the 2026-10-14
limits: one process reads `Wed Oct 14 10:31:38 2026` under `LC_ALL=C` and a
Korean date under `ko_KR.UTF-8`). A cancel, settle or reclaim run under
another locale or time zone than the runner that recorded the fingerprint
read a live process as another: a cancel ended `unsupported_unverifiable`,
and the reclaim judged the supervisor gone. The pattern that split the start
from the command line fit only the C locale, so under any other the start
swallowed the command line (docket C81, the same defect). The run locks'
reader (ADR-0068) pinned the locale and not the time zone.

**Decision.** Every macOS reader of a process's fingerprint, the peer
runner's and the peer snapshot's (`process-identity.mjs`), the run locks'
(`run-locks.mjs`) and the persona's holds (`holds.mjs`), reads `ps` as an
earlier writer did (the caller's environment, or for the run locks and holds
the C locale; `ps` found on PATH alone, its output buffer, no time limit,
and `none` when that read fails), giving `lstart` and `command` as an earlier reader reads
and compares them, and under `LC_ALL=C` and `TZ=UTC0` before and after it,
giving `pinned`, the start and command a later reader compares. The pid may
pass to another process between two reads, so `pinned` is kept only when
both of its reads name one process, which then held the pid through the
earlier read as well: the earlier fields, and the run locks' zombie flag, are
that process's. Every pinned read, and every other tool `process-identity.mjs` runs (the
process table, `lsof`, `sysctl`), closes its stdin: a sandbox may refuse the pipe a spawn
opens for it and end the read `EPERM` though `ps` printed (seen under the
Codex sandbox, critique of 2026-11-22), which would leave every record
without `pinned`. The kind stays
`macos_lstart_command`. The process table the peer snapshot reads
(`processLineage`), which turns `lstart` into seconds, was already read
under both; it shares the one constant now.

Only `pinned` is compared. A record without it (an earlier writer's)
cannot be told from the process, and its `lstart` proves nothing even when
it reads the same: two readings in different zones spell two starts hours
apart alike, so equal text could name a process that reused the pid. Such a
record is no proof for a signal (a cancel refuses, and the run locks'
`provablySame` is false), its identity reads `unknown` (a reclaim keeps the
snapshot until its age, as for any identity that cannot be told; a sweep
does not orphan the run), and a lock or hold record of it counts as held.

**Mixed versions.** An earlier reader, given a later record, ignores
`pinned` and compares `lstart` and `command` as it always has. A later
writer produces those fields exactly as an earlier one did in the same
environment (the critique of 2026-11-22 found one that did not: the earlier
read fell back to `/bin/ps` where an earlier writer recorded `none`, which an
earlier reader whose own lookup fails would have read as a process gone, and
one that finds `ps` as proof by equal text; it reads from PATH alone now). So
a pair of readers in one environment agrees as before, and a pair in two
keeps the 2026-10-14 limit until both are later (a bounded consensus of the
two peers, 2026-11-22, agreed that no later record makes an earlier reader's
identity decisions, a signal, an orphan or a reclaim, worse than an earlier
record would). One earlier check is not an identity decision and does read a
later record differently: an earlier runner's settle waits for a run's second
capture only while the supervisor's whole fingerprint, serialized, equals the
one recorded, so a later record, which carries `pinned`, never equals what
that runner reads. Settled by an earlier runner on macOS while a later runner
is still capturing, a review is recorded unbound (it vouches for no tree)
rather than waiting; an earlier runner reading its own records already did so
across locales. It closes when every runner is a later one.

A later runner's settle waits while the supervisor is unchanged as an
earlier runner judged it, every field of its fingerprint equal, but for a
macOS reading's locale and time zone (`supervisorUnchanged`): with `pinned`
on both sides the caller-local `lstart` and `command` are left out of the
comparison, and otherwise `pinned` is, so a record without one (an earlier
runner's, or a pinned read that failed) is compared exactly as before. So it
neither waits on a process an earlier runner would have told apart nor lets
go of one it held. Two refine-verify passes rejected looser rules: comparing
identity alone waited on a pid another process took (or a start tick in
another pid namespace), and falling back on the start in seconds let go of a
legacy record an earlier runner held. The handle and owner record schemas
are unchanged, so an earlier runner or reclaim reads every later record. A
new fingerprint kind was considered and rejected (review of 2026-11-22): an
earlier reclaim reads a kind it does not know as another process and may
remove a live run's snapshot, and an earlier runner's handle check refuses
the handle, which stops its whole sweep.

**Upgrading on macOS.** The 2026-10-14 limit an earlier reader keeps
(another time zone reads a live process as another) is the owner's to manage
by practice, not enforced (owner decision of 2026-11-22): install a release
carrying this amendment on both hosts of a machine together, and let active
runs finish, or cancel them, before upgrading or rolling back.

**Effects of the change itself.** A run, lock or hold recorded before the
upgrade has no `pinned`, so the later reader cannot tell it:
- A cancel refuses a run the runner recorded before the upgrade, even in the
  same environment, where it used to succeed (`unsupported_unverifiable`);
  it lasts as long as such a run, and a reclaim waits for the snapshot's age.
  When such a run's runner died and another process took its pid, the sweep
  leaves the run running until that process exits, where an earlier sweep in
  the writer's environment orphaned it.
- A lock or hold an earlier writer recorded, whose process died and whose pid
  another process took, counts as held until that process exits, where an
  earlier reader in the writer's zone saw the reuse. Rare: it needs the
  holder's death and the pid's reuse inside the upgrade window.
- When both pinned reads fail, or name two processes, while the earlier read
  succeeds, the record has no `pinned` and its run cannot be verified for its
  life: a cancel refuses and the sweep keeps it.
- In both cases above, a run whose identity reads `unknown` keeps its peer
  snapshot only for the snapshot's age (24 hours), where an earlier reader in
  the writer's environment kept it while the supervisor lived: a run that
  outlasts that age, with no live group of its companion, may have its
  snapshot reclaimed under it. It needs such a run to span the upgrade, or a
  pinned read to fail, and to run a day.
- `ps` under the C locale escapes a command line's non-ASCII bytes, so two
  command lines that differ only there read alike in `pinned`. A pid taken
  by such a process in the same second as the recorded one started, with the
  same lineage, would match; the earlier reading, in the caller's locale,
  could tell them apart. Not handled: it needs all three at once.

**Left as it was.** A `ps` that never answers blocks a reader, as it did:
the earlier read has no time limit, as an earlier writer's had none, and the
run locks' and holds' pinned reads have none either; the peer runner's pinned
reads stop after 10 s, unless `ps` ignores the signal that stops it.

A runner whose `ps` read fails while the pid lives
still orphans a stale run (the sweep's check reads a fingerprint of `none`
as the original gone), as before this amendment. The stall detector's
process table (ADR-0068 Decision 3, item 6) pins the locale and not the time
zone: it compares a start only between samples of one driver.

## Amendment 2026-11-22 — which processes outside the companion's group a run may signal (C181)

**Why.** Peer runs left processes alive for hours after they ended: two
sessions whose parent was init, found on 2026-11-22 from a refine-verify run
that had completed normally four and a half hours earlier (docket C181).
Measured that day on Linux 6.8 with codex-cli 0.171.0, Claude Code 2.1.330,
engineer 0.37.1 and companions 0.4.4 (subtask `orphan-measure` of macro
`macro-plan-20261120T224328Z-9b3901`; its brief and raw evidence are kept
outside the repository, under the owner's `ops/macro-9b3901/orphan-measure/`).
What follows holds for the runs sampled, as counted, and no more:

- codex ran each shell command as `codex-linux-sandbox` (setsid) under
  `bwrap --as-pid-1 --new-session --die-with-parent`, which started an inner
  `codex-linux-sandbox` as pid 1 of new user, pid, mount and network
  namespaces, in a session of its own.
- A command that returned left nothing (two runs): the namespace's init
  ended, and the kernel ended every process in the namespace, detached and
  setsid children included.
- A command that never returned left the namespace (three runs): codex
  answered and exited normally, the runner recorded the run `completed` and
  removed the snapshot, the outer sandbox and `bwrap` died, and the inner
  init lived on with every child, reparented to init. The runner's end
  stopped only the companion's group, which held neither. `SIGKILL` to that
  init alone ended all eleven processes of its namespace.
- A runner killed with `SIGKILL` left the same init, its handle `running`
  and its snapshot. The reclaim keeps an occupied snapshot for its age (24
  hours) and signals nothing; past that age a later scan, when one runs and
  its removal succeeds, removes the directory and leaves the processes.
- A variable set only in the runner's environment reached no process in the
  sandbox; `AGENTIC_COMPANION_DEPTH`, which the companion sets through
  `shell_environment_policy.set`, reached every one; a child spawned with a
  scrubbed environment lost it.
- Claude Code's Bash tool started every command in a session of its own.
  The autopilot worker's group `SIGTERM` let a headless claude end its own
  background task; a group `SIGKILL` alone left the task alive.
- The mutation harness stopped its in-group children on a normal end, a
  timeout and its own `SIGKILL`; a test's detached child survived all three.
- Membership: every process of every run sampled, codex's sandbox and its
  namespace included, stayed in the cgroup the run was started in (each run
  was started inside a `systemd-run --user --scope` unit of the
  experiment's own).

The control, kept apart from those observations: a run outside codex,
started the same way, whose six kinds of child all stayed in its scope, was
ended whole by one `systemctl --user kill <unit>.scope` (the manager's
default signal, `SIGTERM`, to every process of the unit). No write to
`cgroup.kill` was part of that measurement; the revision below measured one.

The decision of 2026-10-19 (C142) let a run signal its companion's group
only, and said that "a location proves no ancestry", so a process found
only by its working directory in the snapshot is never signalled. Nothing outside
the group could be signalled, so nothing ever ended these processes. The
cgroup is the mechanism this amendment proposes; the observations above
show only that it would have held every process sampled.

**Decision.** §6 now lets a run end, outside its companion's group, one
thing only: a cgroup the run made for itself before anything it launched
ran, closed to every entry but a deliberate one that names it, and ended
whole through `cgroup.kill` under the start check below. On Linux it is a
`systemd-run --user --scope` unit under a name used once, entered through a
gate that runs nothing until the runner has seen the gate alone in the
scope, recorded the scope's identity (unit name, `InvocationID`, cgroup
path, cgroup id, boot id, and the gate's pid and start with their clock) in
the launch's own durable record and taken the write permission off the
scope's entry; the kill is written through the directory whose id it
checked. Entry stays open to three deliberate acts that name the scope. Two
of them (the permission given back, a `cgroup.procs` opened before the
closing) can bring in only a process of the user manager's delegated
subtree, which the caller could already end through a cgroup of its own. The
third, an attach through the system manager, can put any process of the user
there. The start check withholds the kill when a member other than the gate
(or the companion it became) started at the gate's tick or earlier, or its
start cannot be read in the recorded clock, a start later than that clock's
current time included: a younger process attached on purpose, or any process
attached between the reading and the write, is the limit the amendment
states. What a process says or where it stands (a working directory, an open
file, a marker variable, an argument list, a name, an age) still grants
nothing; the rule of 2026-10-19 stands, and so do the signals to the
companion's group and their checks. A launcher inside another's scope makes
none of its own. Where no scope can be made, and on macOS and Windows,
nothing changes.

**How the draft changed.** The first draft granted two things: the init of
the codex sandbox's pid namespace, recognised by its argument list carrying
the run's snapshot path, its `NSpid`, its uid and its start; and a process
group registered with its creator's lineage. The plan-verify review (codex,
run `plan-verify-20261122T124408Z-89a5b2`) showed that neither identity
proves the run launched the process:

- an argument list is what the process says of itself: a process of the
  same user can carry the run's path (its own codex session on the same
  snapshot, without any intent), and a nested pid namespace satisfies
  `NSpid … 1`; the uid of the init says nothing of the processes its death
  ends; and the pid read last can pass to another process before the
  signal, which node, having no pidfd, cannot close;
- the heavy-work lock's registered groups record a group id and its leader's
  start, a chain of lock handles and a time, and no lineage; its
  `signalGroup` judges liveness, accepting a group whose leader is gone or
  unreadable, so it is no proof of identity; and the autopilot step's Bash
  sessions and a test's detached child are registered nowhere.

Both were discovery, not provenance, so the first draft's identities were
dropped rather than patched, for a cgroup the run creates before it
launches. The review also noted that the snapshot's tree (`snapshot.root`)
and the peer's working directory (`snapshot.peer_cwd`) can differ, which no
longer matters.

The second draft stated the cgroup with a unit name, a path and a leaf check,
and said its provenance held by construction. The critique (codex, run
`review-20261122T130853Z-c7a96d`) showed that it did not, on two conditions
the draft had left out: a scope collected and made again under the same name
had the same path and passed every check, so the identity must name the
cgroup instance, not its name (and a 64-bit one: where `ino_t` is narrower,
the kernel's generation is not in the inode number); and a process of the user, or the manager on
its behalf, could put an unrelated process into the scope, and the kill
would end it, so entry must be closed. It also found that a bare
`systemd-run --scope` executes the command before anything can be recorded;
that the worker, the harness and a peer run with no snapshot have no handle
and owner record to bind; that a scope made inside another lands beside it,
outside its kill; that a fallback after an unclear failure could launch the
companion twice; and that the fit with the existing signals, retention and
occupancy was unstated. The revision of that day carried each of these.

The re-check of that revision (codex, run `review-20261123T023327Z-2205c3`,
scoped to the passages it changed, with a local review) found its reason for
leaving deliberate entry open false. The revision had said every process a
deliberate entry can bring in lies in the user manager's delegated subtree,
where the same process could already end it. An attach through the system
manager is not held to that subtree, which a probe then confirmed (below), and
"a process of the user can already signal every process of the user" fails
across pid namespaces. The current text states that entry as a limit with
its true reason, and narrows it by the members' starts. The re-check also
asked for:

- the gate alone in the scope, read by a runner that shares the manager's
  pid and cgroup namespaces;
- a launcher that learns from the manager, not from its own cgroup path,
  whether it is inside another launcher's scope;
- no direct launch once the word was tried, and a refused kill write
  recorded as such;
- the occupancy hold named as the reclaim's, the normal end removing its
  snapshot as before, and the pid-namespace reading rules of 2026-10-19 named;
- the cgroup being gone counted as emptied, beside `populated 0`, since the
  manager collects an emptied scope at once;
- the kernel's exit effects past the scope stated precisely, and ordinary
  outbound migration named;
- one harness record per test launch, under held or joined ownership.

Measured for the current text (2026-11-23, systemd 255, Linux 6.8, one run
each): a process started in the user's login session (outside
`user@UID.service`) could not be written into a user scope's `cgroup.procs`
(`Permission denied`: the common ancestor's file is root's); an unprivileged
`AttachProcessesToUnit` call to the system manager, naming `user@UID.service`
and the scope's path below it, moved that process into the scope, and did so
again with the scope closed (0444 and 0555). A process of another user was not
tried.

The refine-verify of that text (codex, run
`refine-verify-20261123T031811Z-bf05bb`) found that the start check missed
two cases: an older process attached after its reading, and one that shares
the gate's clock tick. It also asked for:

- the gate's start recorded, with its clock, for a reclaimer that runs after
  the companion ended;
- a `/proc` that is the runner's;
- the nested-scope reading not taking the manager's "no unit" as proof, since
  it is also the answer to a failed read;
- the limit naming an attached pid-namespace init, whose death ends its
  namespace;
- a new unit not claimed to be a new cgroup;
- the normal end described as removing the snapshot after a bounded stop,
  whatever that stop achieved.

The text that followed carried each of these: the word waits for the clock
to pass the gate's tick, and a member at that tick or earlier withholds the
kill.

The third critique (codex, run `review-20261123T051329Z-2a7329`, scoped,
with a local review) judged every other finding of the earlier rounds
resolved and kept the deliberate attach (above) open: the text grants the
kill while it admits a younger process attached on purpose, or any process
attached after the reading. Neither side disputed the facts. That round was
the last the review allowed, and the owner ruled on 2026-11-23 to keep that
entry as the amendment's stated limit, to be weighed again when the clause
is accepted, and granted one more round for the rest. The refine that
followed changed the text so that it:

- no longer says the shared pid and cgroup namespaces make the starts the
  runner reads the manager's: a start depends on the reader's time
  namespace, so it is compared only in the clock the record keeps;
- records the gate's pid with its start, so a reader after the runner can
  tell the gate, or the companion it became, from the other members;
- reads the launcher's own cgroup path before and after the manager's
  answer, the two the same, for the nested-scope reading;
- marks a scoped attempt's record abandoned, where it wrote one, before a
  direct launch, and launches nothing when the mark cannot be written;
- ends a scope that fails before the word before it reaps the gate, so the
  gate's pid stays its own through the start check;
- says a move of the launcher after its readings changes only which kill
  covers its scope;
- no longer says the manager collects an emptied scope at once (it tries
  once it handles the notice, and may fail), nor that the gate alone at its
  reading is alone at the word.

Its refine-verify (codex, run `refine-verify-20261123T081033Z-4e4ecb`)
judged the other targets resolved, asked for the last three points and the
wording fixes that carry them, and found the nested-scope race after the
second reading still open; the text states that race as harmless to what a
kill may reach. Those post-pass fixes had no peer verdict before the
critique that followed.

The fourth critique (codex, run `review-20261123T131637Z-8f52d1`, scoped,
with a local review), the round the owner granted, judged those fixes
resolved save two wordings (the nested-scope race and the history's opening
summary), and found two gaps of the deliberate-attach class, which it
deferred as known limits: a start read in a time namespace whose negative
boottime offset wraps an older start into a later one, and a `cgroup.kill`
that the init of the writer's own pid namespace ignores. The owner ruled on
2026-11-23 to state both in the text and to close with one refine and its
refine-verify, with no further critique round. The refine that followed
changed the text so that it:

- reads a start later than the clock's current time as unreadable;
- names the init the kill spares, and spares it too where the limit names an
  attached init's namespace;
- qualifies the leaf reading by a cgroup made below the scope on purpose
  since;
- states a move of the launcher after its readings as putting it under, or
  taking it out of, an enclosing kill without widening any kill;
- no longer makes the pre-word cleanup depend on keeping the gate unreaped,
  since the start check names the gate by pid and start together;
- requires the user manager's own cgroup to be `user@UID.service`;
- says a prepared record's kill reaches only what the scope then holds.

Its refine-verify (codex, run `refine-verify-20261123T133757Z-bff998`)
judged the targets resolved but the cleanup and the summary's repeated start
check, and found the attached-init, `user@UID.service` and prepared-record
points; those were fixed after the pass, with no peer verdict.

Before the commit the owner chose one more scoped re-check of those fixes
(codex, run `review-20261123T143520Z-135ddd`). It judged eight targets
resolved, kept G4-F3 open as a minor gap of the pid-reuse class (a reaped
gate's pid taken by another process within the gate's start tick), and found
two of the fixes wrong. systemd 255 runs the user manager's own process in
`user@UID.service/init.scope` and reports `user@UID.service` as the cgroup
it manages, its `ControlGroup` property (measured on this host on
2026-11-24), so a check of the process's own cgroup would have refused a
scope on every ordinary host. And `cgroup.kill` sends its `SIGKILL` unforced
to a process whose namespace can see the writer, so the init of each pid
namespace above the writer's is spared as well as the init of its own. It
also found the crash sentence too broad: a runner can die before writing a
record, or leave one that is incomplete or disagrees. The owner ruled on
2026-11-24 to fix all three and check them once more before the commit. The
refine that followed made the check read the manager's `ControlGroup`,
spared the init of the writer's own pid namespace and of each one above it
in both places, and limited the crash sentence to a record that carries the
whole identity, agrees and is not marked abandoned.

Measured for the revision of 2026-11-22 (systemd 255, Linux 6.8, one run
each): a scope stopped and made again under its name got a directory inode
number and an `InvocationID` other than the first's; a create under a name
the manager still held failed (`already loaded`); with the scope's
`cgroup.procs` and `cgroup.threads` set to 0444 and its directory to 0555, a
write of an outside pid into it and a `mkdir` below it were refused
(`Permission denied`), and the manager's `AttachProcessesToUnit` was refused
(`Process migration not available on non-delegated units`; an attach through
the system manager to the scope's path below the delegated user manager,
which writes as root, was not tried), while the members still forked and
called `setsid`, and `bwrap` with new user and pid namespaces, `--as-pid-1`,
`--new-session` and `--die-with-parent` (the codex sandbox's options, not
codex itself) ran inside, every process of it in the scope; the modes
survived a `daemon-reload`; a gate waiting on a fifo stood alone in the
scope before its word and ran its payload after it; a write of `1` to
`cgroup.kill` through `/proc/self/fd/<n>` of the opened directory ended
every member, the manager collected the scope, and the open directory then
held no `cgroup.events`.

**Alternatives weighed** (each measured or read on 2026-11-22):

- *The namespace init by its argument list* (the first draft, above).
  Narrowest, one process per run, and complete by kernel rule, but its
  identity is self-reported. It reaches only a codex peer's sandbox on
  Linux.
- *A run-unique environment marker*, carried as `AGENTIC_COMPANION_DEPTH` is.
  It reaches every sandbox process that keeps its environment, but a
  scrubbed environment drops it (the repository's hermetic test environment
  does), it depends on how each codex version treats the policy override,
  and it is a claim a process makes about itself, as an argument list is.
- *`PR_SET_CHILD_SUBREAPER`.* A subreaper adopts what its descendants leave,
  which keeps the descent readable, and an adopted child's pid stays
  reserved until it is reaped. It would still need a new rule to signal: the
  lineage that 2026-10-19 reads decides only whether a snapshot is occupied,
  and grants no signal. Node has no `prctl`, so it needs a native helper or a
  launcher process; the runner as its own subreaper dies with a runner
  killed with `SIGKILL`, and a separate per-run launcher would have to
  outlive it. Linux only. A smaller step than a scope where no systemd user
  manager exists; not decided here.
- *A launch-time registration by a supervising process that outlives the
  runner.* The general form of the subreaper; it needs the launcher to take
  part in every launch, as the scope does, without the kernel's membership.
- *Process-group or session ancestry.* It does not reach: the outer and the
  inner sandbox, and each Bash command of a headless claude, start a session
  of their own.

**What the scope costs.** A systemd user manager with a cgroup v2 hierarchy
and `cgroup.kill` (present on the measured machine: systemd 255, cgroup v2);
a container, a CI image or a host's own sandbox may not give one, and there
the run keeps today's authority. Each launch goes through a gate: a process
more, a wait for the runner's word, and a scoped attempt that fails whole
when the record cannot be written (the runner then launches directly, before
any word, with no authority outside the group, once a record it wrote is
marked abandoned, and launches nothing when that mark cannot be written).
Each launcher needs a durable record written before its word, which the
worker and the harness do not keep today. A closed scope refuses entry to
tools that would have attached to it, and a launcher within another's scope
gives up a scope of its own, so its own end reaches only its group until the
enclosing kill. Under autopilot that is the usual case for a peer run: what
escapes its group waits for the step's kill. The kill reads every member's
start first. The closing holds against an entry nobody meant, not against a
process of the user that names the scope on purpose through the system
manager: that caller can put there any process of the user, one it could not
signal itself included. The start check withholds the kill when, at its
reading, a member other than the gate (or the companion it became) started
at the gate's tick or earlier or its start cannot be read; a younger process
attached on purpose, or any process attached after that reading, is the
limit this amendment accepts. Two readings narrow it further: a start later
than the clock's current time counts as unreadable, since a time namespace's
negative offset could otherwise make an older start look younger, and the
kill spares the init of the writer's own pid namespace and of each one above
it, which only that deliberate attach brings there. Where that limit is not
acceptable the authority would have to be withheld wherever the system
manager takes that call from the user, as it did unprivileged on the
measured host. A process of the user may still leave the scope by its own
act; the authority follows the cgroup, not the process.

**Left to the second amendment.** When each end uses this authority (the
runner's normal end before it removes the snapshot, a reclaim of a run whose
runner was killed, a cancel, the autopilot worker at its step bound, the
mutation harness), whether `dispatch-peer.mjs` gains a record of its own,
what a run records and keeps when it cannot see its cgroup empty, how a
reader of an earlier release treats the new records, and the races (a death
between the scope's creation and the record, a gate that never gets its
word, a child holding a pipe open, a sweep, cancel and settle at once).

**Not observed.** Why the inner sandbox outlives `bwrap --die-with-parent`;
a runner killed while codex is still mid-command; codex itself inside a
closed scope; macOS; a claude peer's commands at a run's end; the system
manager's attach of another user's process, or a caller in a pid namespace
of its own; a launcher in a cgroup namespace asking the manager for its unit.
