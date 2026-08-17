# ADR-0053: The baseline verdict answers two questions — exactness stays strict, assurance becomes its own verdict

## Status

Proposed

## Context

[ADR-0051](0051-host-parity-baseline-source.md) made the packaged
`host-parity-baseline.md` the sole runtime authority, and
[ADR-0052](0052-release-obligation-enforcement.md) made changing it oblige a
release. Neither settled what the freshness *verdict* should mean.
`doctor.mjs:1191-1194` computes it as strict normalized string equality across
both hosts: any difference in either host version — including a pure patch bump
— produces `stale`, whose operator action names a runtime upgrade or a
`runtime:compat` refresh loop.

The question reaching this ADR was posed as a treadmill: strict equality makes
the verdict red so often that the refresh loop exists mostly to turn a line
green, so should it be replaced by verified-window semantics, or by drift
grading based on whether a release touched a contract this framework consumes?

The question survives, but almost none of its premises did.

### The duty-cycle premise measures a different gate

ADR-0052 measured an 18.4% freshness duty cycle and showed that even the most
aggressive automation candidate reaches 18.8% — "D buys no convergence." That
measurement is sound, and it is about **baseline versus newest published
version**. `doctor` does not ask that. It compares the packaged baseline against
the version **installed on the machine running it**, and the operator's own
upgrade cadence is far slower than npm's publish cadence.

Measured over this repository's 70 recorded `doctor` artifacts spanning 46.7
days (`.agentic-plugins/runs/doctor/`): `current` in **42 of 70 runs (60.0%)**,
`stale` in 27 (38.6%), `unknown` in 1. The locally observed Claude Code version
sits on a plateau for a median of 2.2 days and once for 14.2 days. The verdict
is not a permanently-on alarm; green is its majority state, and it flips on real
local host movement.

The 18.4% figure should not be carried into arguments about this verdict. It
answers a question this gate does not ask.

### Semver position carries no information for one of the two hosts

`scripts/check-host-version-drift.mjs:83-92` grades drift by semver position and
treats a patch difference as informational (exit 0), inside a 14-day staleness
window (`:34`, `:116-118`). ADR-0052 §Decision 6 recorded aligning `doctor` with
that policy as an open follow-up.

Measured across the 19-row Version History, **17 of 18 Claude Code steps are
patch-position and none are minor or major** — the product has been `2.1.x` for
the entire recorded history. Patch tolerance therefore does not reduce noise on
Claude Code; it removes the signal entirely, for the host that moves every ~3
days. Codex CLI, being `0.x`, distributes differently: 7 minor, 3 patch, 8
unchanged.

The refutation is not merely statistical. The one refresh lap that produced real
adoption work — `2.1.232`→`2.1.233`, which withdrew `TaskCreate`/`TaskGet`/
`TaskUpdate`/`TaskList`/`TodoWrite` from current models while twenty command
runbooks still instructed agents to call them — **is patch-position**. So is
`2.1.233`'s revert of two of `2.1.232`'s permission changes, and so is
`2.1.232`'s switch of subagent forking and background spawns to on-by-default.
The hosts ship contract-relevant behavior, permission changes, default changes
and reverts inside the patch component. Semver's own definition of a patch
release does not describe what these hosts put there.

The 14-day staleness axis fares no better: **0 of 18 refresh intervals exceed 14
days** (the maximum is exactly 14). At its shipped default the age check has
never fired and is equivalent to no check.

### A closed window does not cover the direction the host actually moves

All observed host movement is forward, because the baseline is refreshed *from*
the observed machine and the machine then moves ahead. A window with a fixed
upper bound leaves every subsequent release uncovered on arrival, so it does not
reach the problem it was proposed to solve. Cross-host review sharpened this
further: an endpoint range would also conceal skipped releases — the observed
series jumps `2.1.228`→`2.1.232` — and would silently cover materially different
intermediate behavior, such as `2.1.232`'s permission changes that `2.1.233`
reverted. Any window has to be an explicit finite cohort of reviewed releases,
not two endpoints.

### The real defect points the other way

The premise was that the verdict is too strict. Measurement found the opposite
error live in the shipped artifact.

The `2026-08-16` baseline records three consumed surfaces as explicitly
unverified: `Notification` hook payload compatibility on the newly-reached
Claude Desktop and VS Code hosts, `Agent`-tool result collection under
`2.1.232`'s background-spawn default, and whether an agent team on an affected
model still receives a shared todo list. On that exact baseline, proof
`doctor-20260816T144610Z-154506` reports `host_parity_baseline: current` with
`next_action: null`.

`current` means "the version strings match." It is read as "this host is
verified." Today those two disagree, in writing, in the same package.

### One verdict, two questions

Both errors have one cause. The verdict carries two facts at once:

- **Exactness** — does the packaged evidence describe *this* machine? Decidable
  from two version strings, cheap, and correct today.
- **Assurance** — is this machine acceptably covered by reviewed evidence? Not
  decidable from version strings at all. [ADR-0026](0026-runtime-compatibility-drift-and-release-notes.md)
  §3 already placed it behind human review, and §Alternatives already rejected
  treating any version mismatch as a hard implementation blocker.

`doctor`'s inputs at the freshness site are two probe results and the parsed
baseline. Contract contact cannot be computed there. It can only enter the
system by being *authored* into the baseline — which is what human review
already produces, and what the verdict currently discards. Fourteen of the first
eighteen Version History rows state that no adoption work was required; those
are fourteen review conclusions the verdict cannot represent.

Applicability is also not keyed by version alone. The `2.1.233` withdrawal was
scoped to particular models behind an opt-in environment variable, so two
sessions on the same host version can differ. A grading scheme keyed on version
equality would not have expressed it.

### What the verdict currently gates

Inside `doctor`, `host_parity_baseline` is reported but does not feed `overall`,
`readiness`, `readiness_matrix` or `experience_parity`. It is load-bearing
elsewhere: `cutover-audit.mjs:104` places it in the `checks` array and `:112`
computes `readyCandidate = checks.every((check) => CHECK_PASS.has(check.status))`
against `CHECK_PASS = {satisfied, current, fresh, not-active}` (`:17`). A
verdict that is `stale` roughly 40% of the time therefore blocks
`final-owner-declaration` roughly 40% of the time, on a fact that does not by
itself establish risk.

`doctor` also discards direction. `check-host-version-drift.mjs` computes
`compareSemver`; `doctor` collapses "the host moved ahead of the last review"
and "this machine is running an older host than was reviewed" into the same
word, and that word tells the operator their baseline is old — which is false in
the second case.

## Decision

**The freshness site reports two independent verdicts. Strict normalized
equality is retained, unchanged, as the exactness verdict. A second verdict —
compatibility assurance — is granted only by human review, carried in the
packaged baseline, and is what readiness and cutover gate on. This ADR decides
the split; implementation is a separate follow-up.**

1. **Exactness keeps the computation and the grammar.** Strict normalized
   equality at `doctor.mjs:1191-1194` is correct for the question it answers and
   is not relaxed. The single baseline grammar and failure vocabulary
   established by ADR-0051 §Decision 4 are not forked.

   Stated precisely, because §Decision 2 does add content to the packaged
   baseline and the two claims must not be read as contradicting each other:
   the *dated-header* grammar — `HEADER_RE` and the `{date, claude, codex}`
   shape `parseBaseline` returns — is unchanged, and every existing caller
   keeps parsing exactly what it parses today. Assurance is a **separate
   section with its own reader, added to the same single-source module**
   (`plugins/runtime/scripts/lib/host-parity-baseline.mjs`), never a widening
   of the header. That is an addition under ADR-0051 §Decision 4, not a fork:
   what §Decision 4 forbids is four callers each inventing a grammar for the
   same fact, and this adds one grammar for a new fact in the one place that
   owns grammars. A reader that does not know the section must degrade to
   exactness-only rather than fail — the follow-up owns that rule.

2. **Assurance is a separate, human-granted verdict.** It records whether the
   host this machine runs is covered by accepted review, and it is never derived
   from a version comparison. `runtime:compat` may assemble release-note
   evidence and candidate contract contacts; it may not grant acceptance. This
   preserves ADR-0026 §3's human-review boundary rather than routing around it.

3. **Readiness and cutover gate on assurance; exactness is evidence.**
   `cutover-audit`'s `CHECK_PASS` membership moves to the assurance verdict.
   Exactness stays visible and reportable, and stops functioning as an implied
   incompatibility conclusion.

4. **Safety is never inferred from semver position, keyword silence, or elapsed
   time.** Recorded with the measurement that forces it: 17 of 18 Claude Code
   steps are patch-position, and the single lap that produced real adoption work
   is patch-position. A patch-tolerant verdict would have graded the `2.1.233`
   tool withdrawal as not worth reporting.

5. **Any window is an explicit finite cohort of reviewed releases.** Endpoint
   ranges are rejected: they conceal skipped releases and cover behaviorally
   distinct intermediate versions. A cohort names the releases a human actually
   reviewed.

6. **Applicability may be narrower than a version.** Where a recorded contact is
   scoped to particular models, flags, or integrations, the record carries that
   scope. Unknown applicability never defaults to covered.

7. **Direction is recorded.** "Host ahead of the last review" and "machine
   behind the reviewed baseline" are distinct states with distinct operator
   actions and stop sharing one word. `compareSemver` already exists in
   `check-host-version-drift.mjs`; this is the sound half of ADR-0052
   §Decision 6's alignment follow-up.

8. **Governance.**
   - This ADR **amends** ADR-0051 by adding an assurance field to what the
     packaged baseline carries. ADR-0051 §Decision 1–8 remain operatively
     accurate: the packaged copy stays the sole authority, changing it still
     obliges a release, and the grammar stays single-sourced.
   - It **closes ADR-0052 §Decision 6's "patch-tolerance alignment" follow-up as
     rejected on measurement**, retaining only its direction-aware half (item 7
     above). Recorded rather than dropped, because the follow-up reads
     persuasive and a future reader would otherwise re-propose it.
   - ADR-0026's Decision sections are unchanged and are the layer this decision
     builds on.
   - Scope is the decision only. Schema, migration, precedence between the two
     verdicts for older artifacts, and the acceptance-record shape are a
     follow-up.

**The failure mode this gate exists to prevent, stated so it cannot be
traded away**: loosening the verdict risks missing a real contract change.
Host surfaces this framework consumes — hooks, plugin manifest schema,
permission model, tool availability, subagent behavior, sandboxing — change
outside this repository, and `2.1.233` demonstrates that they change inside a
patch bump. Nothing in this decision permits a mechanically-derived `covered`.
Assurance is granted by review or it is not granted; absence of evidence is
never coverage.

## Consequences

**Positive**: The two errors measured in §Context become expressible. `stale`
stops asserting risk it cannot establish, and coverage stops being implied by a
matching version string while the baseline's own text records unverified
surfaces. The fourteen review conclusions the verdict currently discards get a
place to live. Cutover readiness gates on the fact that actually bears on it.
Direction-aware reporting removes a message that is wrong for the behind case.

**Negative**: Two verdicts are two things to understand, and a consumer could
gate on the wrong one — precedence and migration rules are required, not
optional. Assurance is only as good as the review behind it, and a `covered`
label can overstate what a changelog proves. The follow-up touches the packaged
baseline, so it carries ADR-0051's release obligation and ADR-0052's
enforcement.

**Neutral**: The refresh loop's cadence is unchanged. This decision does not
reduce review latency, which ADR-0052 measured as 81.7% of one obligation loop,
and does not claim to. The loop's yield is likewise unchanged — sparse but
non-zero, as the `2.1.233` lap shows.

## Alternatives Considered

### A — Keep strict equality, calibrate the wording only

Change nothing computational; state that `stale` means the packaged evidence
does not describe this exact machine, not that the host is incompatible. The
smallest and safest option, and it preserves the detector that surfaced the
`2.1.233` defect. Rejected because it leaves the measured false assurance
standing: the wording change addresses the `stale` direction and says nothing
about `current` being reported over three recorded unverified surfaces. It also
leaves `stale` inside `cutover-audit`'s failing set.

### B — Replace equality with verified-window or contract-contact grading

Replace `current`/`stale` with grades such as `covered-no-contact` or
`contact-unverified`. Rejected on two independent grounds. It is not computable
where the verdict is computed: `doctor` holds two version strings and the parsed
baseline, and "did this release touch a contract we consume" is precisely what
ADR-0026 §3 placed behind human review. And it changes the baseline grammar,
which the four modules that import the parser — `compat.mjs`, `doctor.mjs`,
`dashboard.mjs` and the CI-only `check-host-version-drift.mjs`, the same four
whose disagreement ADR-0051 was written to end — share with
`tests/runtime/test-baseline-consumer-contract.mjs`, reintroducing the
forked-parser failure ADR-0051 §Decision 4 exists to prevent. The useful half of the proposal — recording what review concluded —
survives in §Decision 2 without touching the version grammar.

### B′ — Patch-tolerance alignment with the CI drift gate

The variant ADR-0052 §Decision 6 recorded as a follow-up. Prototyped against the
real history and rejected on measurement, per §Decision 4: it silences 17 of 18
Claude Code steps including the only lap that produced adoption work. Its
companion 14-day age window has never fired across 18 intervals. What remains
sound is direction-awareness, which is adopted as §Decision 7.

### C-min — Rename and re-rank only

Split `stale` by direction, rename the forward case away from defect language,
and decide `cutover-audit`'s treatment — without adding an assurance plane. Held
as the fallback if the owner judges the assurance plane's cost too high for its
current benefit. Not adopted, because renaming relocates the false assurance
rather than removing it: `current` would still be the word reported over
recorded unverified surfaces.

### Relocating the baseline outside the package

ADR-0051 §Alternatives D, deferred by ADR-0052 §Decision 1 on measurement. Not
reopened here. It addresses where the baseline lives, not what the verdict
means, and ADR-0052 showed it buys no convergence; this decision is orthogonal
to it and does not change its trigger.

## References

- [ADR-0026](0026-runtime-compatibility-drift-and-release-notes.md) — compat
  evidence model; §3 human-review boundary; §Alternatives rejection of
  mismatch-as-blocker
- [ADR-0051](0051-host-parity-baseline-source.md) — packaged copy as sole
  authority; §Decision 4 one grammar, one failure vocabulary
- [ADR-0052](0052-release-obligation-enforcement.md) — release-obligation
  enforcement; §Decision 6 follow-ups; loop-cost decomposition
- `plugins/runtime/scripts/doctor.mjs:1191-1194` — the exactness computation
- `plugins/runtime/scripts/cutover-audit.mjs:17,104,112` — where the verdict
  gates
- `scripts/check-host-version-drift.mjs:34,83-92,116-118` — semver-position
  grading and the 14-day age window
- `plugins/runtime/docs/host-parity-baseline.md` — Version History; the
  `2026-08-16` row's recorded unverified surfaces
- `.agentic-plugins/runs/doctor/` — the 70 recorded proofs behind the
  duty-cycle measurement
