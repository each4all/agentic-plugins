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

## Amendment 2026-11-24 — when a run ends its scope, and what it keeps (C181)

**Why.** The amendment of 2026-11-22 decided which processes outside the
companion's group a run may end, and how: its own closed scope, through
`cgroup.kill`. It left when each launcher uses that kill, what a run records
and keeps when it cannot see its scope emptied, how a reader of an earlier
release treats the new records, and the races, to this second slice, and
said nothing uses the first until both are accepted (subtask
`orphan-adr-lifecycle` of macro `macro-plan-20261120T224328Z-9b3901`). The
measurement it rests on is the first slice's (2026-11-22, Linux 6.8,
codex-cli 0.171.0): every orphan sampled came from a run that ended, by a
normal end (a command that never returned) or by its runner's `SIGKILL`, and
from an autopilot step's or a test's process that left its group.

**Decision.** §6 now says who writes the kill, and when:

- the peer runner at every end of a run, in one sequence every cleanup path
  awaits: at the companion's exit, or the event that ends the run where no
  exit comes, it stops the group, checks the scope within two seconds and
  then writes the kill, waits up to ten seconds for the scope, drains its
  pipes within two seconds of that observation, captures the snapshot for
  the review's binding only on gone (otherwise the review stays
  unbound for good), writes the handle terminal with the teardown and the
  capture's outcome in one write, and removes the snapshot only on a
  reading of gone it makes itself;
- for a peer run whose runner is gone (its supervisor, which the scope's own
  record names, proven gone by a check that validates the record and the
  reader's namespace and boot before any probe), whichever of its persona's
  `cancel`, `settle` and `sweep` reads it, as a step apart from their
  snapshot branches, and the next dispatch's reclaim for a snapshot of its
  own persona only; a live run's cancel writes none, since the runner's own
  end follows;
- the autopilot worker at every end of a step, after its group signals and
  without waiting for the claude to exit, and, for a step whose driver (the
  scope's recorded supervisor) is gone, the dead-run cleanup or a lock or
  lane path that meets it first;
- the mutation harness at the end of each test launch, and whichever process
  next waits on, closes or collects an ownership holding a dead harness's
  entry;
- no launcher inside another's scope.

Two records bind on the identity's fields written before the word; a run
with a snapshot binds only while its owner record exists and agrees, and a
run with none binds on its handle alone. A reader observes a scope `gone`
(final: under the recorded boot, the recorded path absent or of another id;
or a boot id other than the recorded one), `emptied` (that moment only,
reported and never consumed), or `unproven`, `withheld`, `refused`,
`pending`; every reading needs the reachability check, a proof that the
reader's cgroup mount shows the hierarchy's root and the manager in it, and
a lookup from that mount's opened root that never crosses a mount, for
`cgroup.events` and `cgroup.kill` alike. No reader asks the manager to
stop a unit. A stored teardown is a report, since nothing orders two
processes' writes: removing a snapshot whose owner record carries a scope
(one whose owner record reads whole with no scope, or whose owner record
and tree are both absent, goes as 2026-10-19 decides; one whose owner
record cannot be read, or is absent while a tree is left, is kept; and
`directory-gone` and `owner-unreadable-expired` remove
one that may have carried a scope without a reading, each on its proof),
binding a review, reusing or
removing a checkout or lane, and dropping a lock entry, deleting its copy or
giving the lock to another holder each rest on a reading of gone the actor
made itself (the dead-run cleanup, for a step's records alone, takes the
one a `cancel` it called made at that call and returned to it); retention
alone takes a stored teardown. While a scope is not read gone,
the snapshot is kept by every remover (the gate sits in the shared
removal and comes before every 2026-10-19 verdict, the age rule included,
save a directory both lookups found absent and an owner record read whole
that does not parse or is no owner record; a directory left with neither
owner record nor tree is outside the gate, as one whose owner record reads
whole with no scope is, while one whose owner record is absent but whose
tree is left is kept; and a remover may rest on its own earlier reading of
gone), the handle is not pruned, `sweep` retries, the
answers report it apart, an autopilot checkout takes no step and no lock or lane path drops it (the
block is read from the step records, so it survives the driver), a dead
step's peer runs with scopes of their own keep its scratch, and a harness
launch gives no verdict. Sweeps, reclaims, dead-run cleanups and lock
collectors write their kills once and read without waiting of their own,
once an invocation, or once a pass of a loop that already polls (a
heavy-work acquire, a joined wrapper's wait, a release); only the
launcher's own end waits.

The new fields are an optional `scope` object with its own version; the
handle's `schema_version` and the owner record's schema stay as they are,
and a harness entry rides on the group entry an earlier lock reader parses.
An earlier reader of a later record acts on processes as it does today but
can erase what a later reader needs (a snapshot removed under a live scope,
a pruned handle, a dropped ownership), and an earlier driver takes a later
run's cancel `ok` as settled; the owner installs scope-writing releases of
every persona and the orchestrator together and lets runs finish before a
rollback, as practice.

Races: a runner dead after the word but before naming its companion leaves
the scope to a reader that proves its supervisor gone, and the group stays
`unknown` as 2026-10-19 decides; a runner dead before its records leaves a
gate that exits on the end of its word channel; a reused pid widens nothing;
a reader in another namespace withholds, and its misses are no reading of
gone; a held pipe is drained within a bound after the scope's end and
recorded `pipe_held`; concurrent kills of one cgroup reach its members at
each write, and only the deliberate-attach limit of the first slice widens
that.

`dispatch-peer.mjs` gains no record and keeps its limit.

**How the draft changed.** The plan-verify review (codex, run
`plan-verify-20261123T222917Z-e56e54`, verdict conflict) found the first
draft unsound in three places and incomplete in nine; every finding was
taken:

- the reclaim, which reads no handle, could not check the two records agree,
  and a removal of the owner record left a handle that could not bind
  alone: the reclaim was to read the handle by run id, a remover of this
  release to record the removal on the handle first (replaced after the
  critique, below), and an earlier release's removal is stated as erasing
  the authority;
- the normal end wrote the handle terminal before the pipes were joined and
  the answer read: the order is now group stop, scope end, bounded drain,
  answer, terminal write, snapshot;
- the autopilot block lived only in one driver, while the serial path and
  the lanes released lock entries and scratch on the group's end alone and
  the dead-run cleanup removed the open-run record: the block is read from
  the step records at every start and dispatch, and holds those releases;
- the recovery steps of `cancel`, `settle` and `sweep` ran only inside their
  snapshot branches, and the supervisor lived in the snapshot record: the
  scope step stands apart, and the scope's record names its supervisor;
- the worker's recovery was keyed to "the worker" though the worker runs in
  the driver, and its scope end waited on the claude's exit: the driver is
  the recorded supervisor, and the bound ends the scope regardless;
- the harness gated only the next launch and the release, not the
  unregistering of its entry, the deletion of its copy, or the two ways an
  acquirer collects a dead holder's ownership;
- "a teardown only rises" could not hold across processes, and an emptied
  scope was taken as final: stored teardowns are reports, and the acts read
  the cgroup;
- the age rule was stated as removing a snapshot "whatever it holds", wider
  than `judgeSnapshot`'s live vetoes;
- hooks and dispatches had no budget for a backlog of ten-second waits;
- a miss read from another namespace could have counted as gone;
- a proven scope was taken for the end of an unnamed companion's group, part
  of which may have left the scope;
- an earlier driver's reading of a later run's cancel was not stated.

**How the critique changed it.** The first critique of the revision (codex,
run `review-20261123T223645Z-d14e85`, with a local reviewer of the code
claims; eleven major findings, six minor) found it inconsistent in its
removals, incomplete in its gates, and unbuildable in one rule; every major
finding was taken:

- the reclaim's age and owners-gone removals contradicted "a snapshot is
  removed only on gone or emptied", and removers were missing (the
  autopilot's `scratchBusy`, `dispatch-peer.mjs`'s reclaim, the
  orchestrator's copies): the gate now sits in the shared removal, before
  every 2026-10-19 verdict, with its two exceptions named;
- the removal recorded on the handle could not be built (a runner refuses
  another persona's handle, and the repository-wide reclaim removes every
  persona's snapshots), could be erased by a whole-handle write, and turned
  a two-record binding into one: dropped, since no remover of this release
  now removes a snapshot under a scope it has not read gone or emptied, and
  binding is defined over the fields written before the word, a run with a
  snapshot binding only while its owner record agrees;
- the install practice named the engineer only, though the founder's,
  designer's and orchestrator's reclaims remove an engineer snapshot: every
  persona and the orchestrator move together;
- `gone` both required the recorded boot and accepted another, and a mount
  that does not show the hierarchy's root could read a live scope absent:
  the two readings are separated, and every reading needs proof of the
  hierarchy it reads;
- the supervisor's death "as `snapshotEnded` judges it" inherited
  `identityState`'s reading of a pid it cannot find as gone, probed before
  the namespace is checked: the check is now specified, the record and the
  reader's namespace and boot validated before any probe, failures not gone;
- the reclaim could not discover a run with no snapshot: those runs are left
  to their persona's `cancel`, `settle` and `sweep`, and the reclaim ends
  only its own persona's;
- the autopilot hold missed the paths that drop a worker lock entry as
  debris (`acquireLock`, `joinAdmission`), the driver's start, and a lane's
  retirement, reconciliation and removal: each is named and gated;
- a dead step's peer runs with scopes of their own, terminal ones included,
  were not read by the dead-run cleanup, which takes a cancel's `ok` as
  settled: it now reads them and keeps the step's scratch;
- the heavy-work gate named the reaper, which acquisition's earlier waits
  never let a busy entry reach, and missed the joined wrapper's wait and the
  autopilot verification's releases, and said a joined release waits, which
  does nothing: each wait that first meets the entry ends the scope;
- the drain's two-second deadline and the ten-second empty wait did not
  fit, and the runner's and harness's cleanup paths diverged: one sequence,
  with its deadlines, which every path awaits, on the companion's exit
  rather than its pipes' close;
- a withheld end capture let a completed review settle unbound by accident:
  the capture now depends on the teardown, and its `scope-unproven` reason
  is final.

The refine's own verification (codex, run
`refine-verify-20261123T224930Z-df26cb`) found the first pass short in
ten places, and the second pass took each: the two exceptions to the
snapshot gate now need proof (a lookup that found nothing, a record read
whole that does not parse), since the reclaim folds access errors into
them; `emptied` was argued as the end of what the run owes its scope,
which let a removal or a pruning rest on it (the third pass withdrew that,
below);
a reading stays on the mount it attested; a supervisor is proven gone only
in the whole recorded clock (boot, time and pid namespaces) and through a
`/proc` that hides no process; the run's end starts at whatever event ends
it, bounds its checks, and writes the terminal status with the end
capture's outcome in one write; the autopilot hold rides on the driver's
existing `lingering` mark and on gates at the places a lock entry, a lane,
a scratch or an open-run record is dropped; a step's scoped peers are found
by an association their scope records, across every persona's ledger; and a
check's scratch directory is swept only when no harness entry names a copy
in it with a live scope.

The second pass's verification (codex, run
`refine-verify-20261123T225601Z-ac6fa9`) found six more targets resolved
and the rest short, and the third pass took each: removal, pruning and the
end of retries rest on `gone` alone, a reader that reads `emptied` asking
the manager to stop the unit; every lookup and the read of `cgroup.events`
go through the attested mount's opened root, refusing to cross a mount; the
step's scope survives every rewrite of its lock entry, and admission runs
the gate before it refuses; a scoped peer handle with a missing or
ambiguous association, an unreadable one and an unlistable ledger keep the
step's records; a check records the heavy-work ownership it holds, and a
harness entry names its copy by device and inode too, which a
`.removing-` rename keeps; the scope's part of an end is bounded after the
checks; another writer's terminal write leaves the capture to the runner;
and the dead-run cleanup's delegated `cancel`, with its sixty-second bound,
is placed in the kills-first order.

The third pass's verification (codex, run
`refine-verify-20261123T230255Z-f6dc71`) found the binding, the gate's
exceptions, the supervisor check and the reclaim's reach resolved, and the
rest of the short items traced to two causes, which the fourth pass
removed: acts that still rested on `emptied` (a worker entry, a harness
entry, a capture, the dead-run cleanup's selection), now all on `gone`;
and the manager stop the third pass added, now withdrawn (above). It also
pinned the open root to the attested mount by its mount id and put
`cgroup.kill` under the no-crossing rule; had the harness, not the check,
record the ownership it really holds; widened the ambiguous-peer hold to
every ledger the cleanup scans; had settlement read the handle again after
proving the runner gone; and stated what has no deadline and the order of
delegated cancels as they are.

The fourth pass's verification (codex, run
`refine-verify-20261123T230948Z-070f2b`) found the worker's releases and
the harness's ownership resolved, and the rest narrowed to races and three
gaps, which a last edit, after that verification, took: settlement binds to
the capture the runner recorded on its own reading of gone; retention keeps
a handle whose owner record could not be read, as its snapshot is kept; the
dead-run cleanup also scans the state roots the run's records name, a
lane's checkout among them, and takes each delegated `cancel`'s reading.
Two races are stated as limits rather than closed: a whole-handle write
(C139) that erases the capture outcome, which leaves a review unbound and
never wrongly bound, and a mount table changed on purpose between a
reader's sample and its lookup, a rare move of a process acting as the user
like the first slice's deliberate attach. The fourteen-second bound leaves
out the kernel's own time inside the kill's write.

The minor findings were folded in as well: the symmetric `owner-incomplete`
case, `unproven` defined at each reader's deadline and the budget stated
per scope, "starts in that scope" for what the step's claude launches, a
pointer that read "below" for a paragraph above, the reclaim's conditions,
and this record's count.

A second critique (scoped, codex run `review-20261123T232042Z-f620c6`)
found five of those fixes still short, and the owner ruled they be fixed
rather than recorded as limits. The binding paragraph no longer says no
remover of this release removes an unread scope's snapshot: it names the
two removals that read no scope, `directory-gone` and
`owner-unreadable-expired`, and when each leaves a handle that binds
nothing. The other-boot reading of gone and a supervisor's start are read
through a `/proc` the reader opened once and checked by mount id, refusing
to cross a mount, as the cgroup lookup is; a reader that cannot read its
boot so reads no boot at all. The mount race is restated for what that
pinning leaves: a mount replaced, between the sample and the opening of its
root, by one with the same reused mount id, which a unique mount id closes
where the kernel has one; an overmount placed after the sample is refused,
never read. Its verification found one more way to hide a live supervisor,
a remount of the same procfs that changes its `hidepid` and keeps its mount
id: so no such process is read from a signal-0 probe's `ESRCH`, never from
a miss in `/proc`. The dead-run cleanup's scan for a dead step's scoped
peers no longer skips a handle whose stored teardown says gone, and for a
handle that binds nothing because its snapshot's owner record is proven
absent, its `cancel` writes no kill but still reads the scope, a reading
needing no authority. The gate keeps a snapshot whose owner record could
not be read, as before. The
dead-run cleanup's release of a step's records rests on the reading each
`cancel` it called returned, which the consuming rule now admits, not on a
second reading of its own. And a collector inside a loop that already
polls (a heavy-work acquire, a joined wrapper's wait, a release) reads
the scope again at each pass, so it advances within its
invocation; the kill is still written once an invocation. Two minors rode
along: the step a settlement's capture comes from is step 5, and a nested
peer's survivor may run in its removed tree until the enclosing kill, as
today. Two findings of that critique stay limits, on rare paths: a live
driver releasing a fallback worker's records without the peer-scope scan,
and a handle pruned between a runner's terminal write and its snapshot's
removal.

A third critique (scoped, codex run `review-20261123T234730Z-6d1123`) hit
the critique cap with five majors open; the owner granted one more round
and ruled which to fix. The consume rule now names the snapshot removals
that rest on no reading, as the binding paragraph does, and so does the
Decision summary here. The supervisor check decides the boot before the
rest of the clock, so a verified reboot proves the supervisor gone however
the namespaces compare. Every autopilot check now gets a record before its
scratch, naming whether it runs the harness, so the scratch sweep tells an
ordinary check, or a harness that never reached a launch, from a check
whose record was lost, which keeps its directory; a root marker field tells
this release's roots from an earlier one's. A snapshot directory with
neither an owner record nor a tree (a failed first owner write, or a
removal stopped short) passes the gate, having no tree for a scope to use,
while one whose owner record is absent but whose tree is left is kept, since
a lost record may have carried a scope; the race summary
admits the dead-run cleanup's delegated reading; and the persona check's
citation is corrected. Two findings of that critique became limits, on the
owner's ruling: same-boot gone across containers sharing run records, and
retention pruning an unbound handle a dead step's scan needs. A Known limits
paragraph now states all four rare-path limits in the Decision text.

A fourth critique (scoped, codex run `review-20261124T025722Z-01f613`) hit
the raised cap with two majors open; the owner granted a last round. The
gate bullet and the race summary now name the snapshot directory left with
its owner record absent, as the binding paragraph and the consume rule
decide it (gone with no tree, kept with one), where today's reclaim folds it
into `owner-unreadable-expired`; and both say a remover may rest on a
reading of gone its own process made earlier, as the runner's end does
after its capture and terminal write. The scratch sweep reads an ownership
the check's record names that is absent (no directory of its token, though
other tokens' may stay) as retired, since every remover of an ownership in
this release removes it only once none of its entries holds a running group
or a scope not read gone; that is the normal end of a `mutate` check, whose
harness's release removes its ownership. It reads absence only where it
finds the lock's directory by the device and inode the harness recorded,
and reads the groups directory from it without crossing a mount, so a sweep
that cannot see that directory, or sees a mount over its groups, keeps the
check's. The empty
snapshot directory is stated as outside the gate, not a third exception to
it. An ownership
removed outside those removers cannot be told from one retired, a fifth
Known limit, which also names a mount over the groups directory that only
the harness's mount namespace has.

**Alternatives weighed.**

- *A kill only when something is seen left.* The runner would look for
  members after the companion's exit and write the kill only when it found
  one. It reads the same cgroup either way, and a kill of an empty scope
  costs nothing, so the check adds a window between the reading and the
  write and saves nothing. Rejected.
- *Keep the normal end's removal as it is (2026-10-19) and leave a scope that
  did not empty to the reclaim.* That removes a tree under what may still run
  there, which the first slice set out to stop; and a reclaim's own run is
  not guaranteed (nothing observes a repository after an interactive session
  ends). Rejected: the snapshot stays until a remover reads its scope gone,
  the age rule included.
- *A removal record, written before a snapshot is removed, that lets the
  handle bind alone.* The critique showed it cannot be written on the
  handle across personas, and a record of its own would add a third record
  to keep in agreement. With every removal gated on a reading of gone,
  which is final, nothing is owed to the scope after a removal of this
  release, so the record serves nothing. Rejected.
- *Removal on a reading of emptied.* The second pass let it rest there,
  arguing that only a deliberate attach repopulates a closed scope. The
  second pass's verification showed the premise wrong for the run's own
  processes: one that left the scope may be attached back. Removing the
  owner record then would end the binding while the scope may fill again,
  and the third pass's verification found the same for every other act
  (a lock entry, a capture, a copy). Every act waits for gone, which the
  manager's own collection of an emptied scope brings. Rejected.
- *A reader that asks the manager to stop an emptied unit.* The third pass
  had it, to hasten gone. A stop sends the manager's own signals to what the
  scope holds when the stop runs, a second way to signal outside the
  companion's group that no identity check binds to the invocation checked.
  Rejected: the manager removes an emptied scope by itself, and one it
  leaves is the owner's to stop.
- *A version bump of the handle or the owner record.* Rejected for the
  reasons the C141 amendment recorded for a new fingerprint kind: an earlier
  runner would refuse the handle and stop its sweep, and an earlier reclaim
  would read the owner record as none.
- *A lock around the teardown.* The acts that rely on a teardown read the
  cgroup themselves, so a stored one overwritten by an older observation
  costs one more reading; the handle's two-process races (C139) are not this
  amendment's to close. Rejected.
- *A teardown failure that turns a run `failed`.* The answer was the
  companion's and is complete at its exit; the scope is the run's
  operational cleanup, reported apart, as the snapshot's removal is.
  Rejected.
- *`sweep` kept to reconcile only, the kill left to `cancel` and the
  reclaim.* After an interactive session ends, `sweep` from the next
  session's hook may be the only reader that ever comes; a run whose runner
  is gone has no work left to cancel. Rejected, under the condition that
  the supervisor is proven gone.

**Not observed.** No part of this slice was measured beyond the first
slice's: the drain bound, the empty wait and the ordering against the
handle's terminal write are design values, to be measured by the
implementation. Whether the worker's step record and the harness's
ownership entry pass an unknown field in each earlier release is for the
implementation to show; the decision requires that they do, or that the
field go where they do not read it.

**Accepted 2026-11-24.** The owner accepted both C181 amendments (this one
and the 2026-11-22 amendment above) explicitly, in the main session. On
acceptance, the known limit for a heavy-work ownership removed outside its
removers no longer says that "the install practice keeps away" an earlier
release's remover: the decision states no such practice, and an older
install a session or an autopilot pin keeps, or a harness loaded from a
checkout of an earlier commit, still runs one. The sentence now names
those cases. The clauses that held each amendment's effect until both were
accepted (the second amendment's pointer and the rollout's last sentence)
were dropped, since both now are.
