> **Status: DECIDED — 2026-08-22 by the repository owner (e16tae). The second
> assurance grant is DEFERRED, not authored.**
>
> This is the durable owner-decision artifact for macro
> `macro-plan-20260820T052104Z-0c7041`, subtask ST3. It is the counterpart of
> [the first grant's ratification](owner-ratification-first-grant.md) and takes
> the opposite outcome: **no second grant is issued.** ADR-0053 §Decision 5
> leaves the grant/refuse call to a human, and a refusal needs a record for the
> same reason a grant does — otherwise the absence of a second grant reads as
> work not done rather than a decision taken.
>
> Because no grant is authored, nothing carries a
> `review_provenance.reference` pointing here. That is the expected shape of a
> deferral, not an omission.

# Owner decision — the second assurance grant is deferred

Inputs: the verified review brief
[claude-2.1.236-2.1.237-codex-0.148.0.md](claude-2.1.236-2.1.237-codex-0.148.0.md)
(ST1 at `88ff062`, adversarially re-verified by ST2 at `7b0bdfb`), a cross-host
Brainstorm review, and the measurements recorded inline below, all taken on
2026-08-22.

## 1. The decision

**Defer.** No second grant is authored. Macro subtasks ST4 (grant authoring)
and ST5 (install + proof) are marked `deferred` rather than attempted.

The reason is not a defect found in the reviewed hosts. The review found none
that would block a grant. The reason is that **the owner intends to review
whether this repository should track Claude Code and Codex CLI versions at
all**, and a grant is by construction a version-tracking artifact — its cohort
*is* a set of version tuples. Authoring one now would mean building, releasing
and proving an asset whose reason to exist is itself under review.

That review is future work and is deliberately not pre-empted here. This
document records the deferral and hands it the measurements.

## 2. What was on the table

Four options were compared on the repository's nine quality axes, with essence
and foundation decisive. Three of the four assumed the grant would be authored:

| | Option | Additional review cost |
| --- | --- | --- |
| A0 | Grant the reviewed tuples, ship, accept `unassured` | none |
| A1 | Freeze the host, review `2.1.238`+`2.1.239`, grant four tuples | 98 changelog items |
| A2 | Grant the reviewed tuples, select retained `2.1.237`, prove there | none |
| A3 | Amend ADR-0053 §Decision 4 to split certification from liveness | ADR-level |

A1 was the cross-host reviewer's recommendation and was the leading option
until the owner stated the tracking question. Once the tracking plane itself is
under review, every option that produces a grant inherits the same defect: it
spends ST4 and ST5 on an artifact that the pending review may delete. The
question moved up a level, from *what should the second grant say* to *should
this plane exist*, and the second question dominates the first.

## 3. Why the loop did not converge — measured

The brief's §8.8 recorded that the host moved past the reviewed cohort while
the review ran. Re-probing at decision time found it had moved **again**.

| Fact | Measurement |
| --- | --- |
| Installed pair at decision time | claude `2.1.239` (installed 2026-08-22 05:23 local), codex `0.148.0` |
| Reviewed tuples | claude `2.1.236` and `2.1.237`, both against codex `0.148.0` — two versions behind |
| Claude release rate | **0.92 versions/day** over 72 days (66 patch increments, `2.1.173` → `2.1.239`) → mean residence **26.2h** |
| Last two Claude intervals | `2.1.237`→`2.1.238` 19h01m; `2.1.238`→`2.1.239` 23h48m |
| Unreviewed delta to reach the installed pair | `2.1.238` **39** bullets + `2.1.239` **59** bullets = **98 items** |
| Time available to review them | ~18h of expected residence remaining on `2.1.239` |
| Comparable prior lap | ST1+ST2 reviewed 35 items in roughly 48h |

The arithmetic is the finding: catching the installed pair requires reviewing
roughly three times the previous lap's volume in roughly a third of its time.
The loop does not converge at this cadence, and no choice of cohort fixes that,
because `cohortMatch` is exact tuple equality with no range tolerance.

**The item counts above reproduce the brief's own verified figures** —
`2.1.236` = 33 and `2.1.237` = 2 — using the file's own `## <version>`
delimiter, which is the control that makes the two new counts trustworthy.

## 4. The asymmetry the tracking review should start from

"Updates are too frequent" is true of exactly one of the two hosts, and the
distinction is not a property of the vendors' release cadences:

| Host | Install shape | Behaviour on this machine |
| --- | --- | --- |
| Claude Code | native binary; `~/.local/bin/claude` is a **symlink** into `~/.local/share/claude/versions/` that the updater repoints | **Auto-updates.** Moved four times in three days |
| Codex CLI | `bun` global package | **Does not auto-update.** Held `0.148.0` since 2026-08-19 even though stable `0.149.0` published 2026-08-20T21:04:55Z |

So Codex's apparent stability through R2 and R3 — the "ten-day plateau" the
brief's §6 treated as a property of the host — is an artifact of the
installation method. Codex is already, in effect, manually pinned. The entire
tracking burden comes from one host, and that host has vendor-supported version
selection: `claude install <target>` accepts a specific version, and
`DISABLE_AUTOUPDATER` / `autoUpdates` appear in the shipped binary.

**Whether that freeze actually holds was not verified.** The binary also
contains `autoUpdatesProtectedForNative`, whose name suggests native installs
may refuse the setting; a name is not a measurement, and confirming it requires
observing a release land without the machine moving. The tracking review should
measure this first, because it decides whether "keep tracking" is even an
option.

This widens the review's option set beyond keep-or-drop: drop tracking; freeze
Claude and keep tracking; track only the manually-pinned host; or split
certification from liveness as option A3 above proposed.

## 5. What the matcher was measured to do

Run against the real `matchAssurance` with the shipped record, an authoritative
installed-plugin listing on both hosts, and a passing control
(the shipped grant at its own tuple `{2.1.235, 0.147.0}` → `covered`):

| Case | Result |
| --- | --- |
| Shipped grant @ installed `{2.1.239, 0.148.0}` | `unassured` — "no grant names the host pair" |
| Shipped + a candidate second grant @ `{2.1.237, 0.148.0}` | **`covered`** |
| Shipped + candidate @ `{2.1.239, 0.148.0}` | `unassured` |
| The first grant's own tuple after a second grant lands | still `covered` — disjoint cohorts coexist |
| Two grants whose cohorts overlap | `unassured` — "duplicate records resolve negative" |
| A grant carrying any non-empty `predicate` | `unassured` — the record is incoherent |
| Residual ledger at 32 entries / at 33 | schema-valid / **refused, not truncated** |

Two of these settle questions the subtask raised in the abstract: omitting
`predicate` and keeping cohorts disjoint are both confirmed necessary against
the real code rather than argued from it. They are recorded here so the next
lap, if there is one, does not re-derive them.

The residual figure is the one with a consequence. The brief's §4 ledger
expanded per consuming package, **plus** the four inherited-surface residuals
its §8.4 adds, comes to exactly **32** — the schema ceiling, with no headroom.
Any grant authored later must either compress rows or close probes.

## 6. What this deferral accepts, stated rather than left to be discovered

- **The matcher's positive path remains unexercised on a real machine.** R1
  shipped `grants: []` and the negative path was observed on this repository's
  own machine. The first grant shipped and never matched (`b340bbe`). Deferring
  the second leaves `covered` verified only by tests. If the tracking review
  decides to keep the plane, this hole is still open and closing it is still
  owed.
- **The cheap way to close it has an expiry.** The version store retains three
  binaries; `2.1.236` has already been pruned, and at ~0.92 versions/day
  `2.1.237` — the only reviewed version still on disk — is expected to fall out
  within about a day. After that, closing the hole requires reviewing whatever
  version is then installed. The owner was offered a copy of that binary and
  declined; this records the consequence, not a disagreement.
- **The ST1/ST2 review is not wasted, and it is not ratification-complete
  either.** Its Codex `0.148.0` analysis — the expensive half, 393 release
  bullets — remains valid for as long as this machine stays on `0.148.0`. But
  the cross-host reader's premise attack stands: four consumed surfaces are
  absent from the residual ledger, seven Codex hook rows are unscreened, and no
  live Codex skill invocation was performed. Any future grant must close those
  first; the brief alone is not a grant.

## 7. What this decision does not claim

- It does not claim the reviewed host pair is defective. No blocking defect was
  found in `2.1.236`, `2.1.237` or codex `0.148.0`.
- It does not decide whether version tracking should continue. That is the
  review this deferral makes room for.
- It does not revoke, supersede or otherwise touch the first grant, which
  remains `granted` and immutable per ADR-0054 §Decision 8.
- It does not claim the freeze mechanism works. §4 records it as unverified.
