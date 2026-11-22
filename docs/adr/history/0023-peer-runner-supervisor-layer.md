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
