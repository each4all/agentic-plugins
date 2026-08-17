# ADR-0053: The baseline has no assurance verdict — exactness stays strict, and assurance becomes a fact of its own

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

The question survives. Almost none of its premises did, and neither did the
first framing of the answer.

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
sits on a plateau for a median of 2.2 days and once for 14.2 days — sampled
sighting intervals between recorded proofs, not proven installed-version
residence times, since nothing observes the host between runs.

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

### The defect is a missing fact, not a wrong one

This ADR's first draft claimed `current` is a false assurance, on the ground
that the `2026-08-16` baseline records unverified surfaces while proof
`doctor-20260816T144610Z-154506` reports `host_parity_baseline: current` with
`next_action: null`. Cross-host review disproved the framing and the correction
is load-bearing, so it is recorded rather than quietly replaced.

`current` is not a false verdict. The check is labelled *Host parity baseline
freshness* (`doctor.mjs:1229`), its evidence is the two version strings it
compared, and the baseline's own header calls itself a checkpoint and explicitly
"not a promise that either host will keep this behavior." It says what it means
and means what it says.

The defect is that **no assurance fact exists at all**, and a consumer
substitutes exactness for it. `cutover-audit.mjs:104` places the freshness
verdict in the `checks` array and `:112` computes
`readyCandidate = checks.every((check) => CHECK_PASS.has(check.status))` against
`CHECK_PASS = {satisfied, current, fresh, not-active}` (`:17`). Nothing in the
system ever asked whether a human accepted this host; readiness simply promoted
"the strings match" into "this is fine."

That relocation matters for the option set. A missing fact cannot be repaired by
rewording the fact that exists, which is what Alternatives A and C-min propose.

The unverified surfaces are still the evidence that the missing fact is needed,
but they must be described accurately. The `2026-08-16` baseline records three
open gaps, and only two are on surfaces this framework consumes: `Notification`
hook payload compatibility on the newly-reached Claude Desktop and VS Code hosts
(the `plugins/attention` sensor branches on `notification_type`), and `Agent`-tool
result collection under `2.1.232`'s background-spawn default (`plugins/engineer`
spawns native subagents). The third — whether an agent team on an affected model
still receives a shared todo list — sits on a surface the same file marks
"additive and unadopted" and tells runtime not to depend on. Whether unadopted
watch items should block assurance at all is itself a question the split has to
answer rather than inherit.

### One verdict, two questions — and a third the first draft dropped

Both the exactness verdict and the missing one are about the baseline, and they
are different facts:

- **Exactness** — does the packaged evidence describe *this* machine? Decidable
  from two version strings, cheap, and correct today.
- **Assurance** — is this machine acceptably covered by reviewed evidence? Not
  decidable from version strings at all. [ADR-0026](0026-runtime-compatibility-drift-and-release-notes.md)
  §3 already placed it behind human review, and §Alternatives already rejected
  treating any version mismatch as a hard implementation blocker.

A two-verdict model is still incomplete. The same `status` field already carries
a third class that is neither: `missing`, `unreadable`, `escaped` and
`unparseable` from `host-parity-baseline.mjs:187-190`, plus the probe `unknown`
state when a host CLI cannot be read. Integrity and observability failures are
not freshness answers and must not be traded against coverage.

`doctor`'s inputs at the freshness site are two probe results and the parsed
baseline. Contract contact cannot be computed there. It can only enter the
system by being *authored* into the baseline — which is what human review
already produces, and what the verdict currently discards. Fourteen of the first
eighteen Version History rows carry the boilerplate "no adoption work required"
(fifteen if the `2026-08-08` row's "Adoption work required: none yet" is counted
by meaning rather than phrase); those are review conclusions the verdict cannot
represent.

Applicability is also not keyed by version alone. The `2.1.233` withdrawal was
scoped to particular models behind an opt-in environment variable, so two
sessions on the same host version can differ, and `doctor` cannot necessarily
observe the active model, the Desktop/VS Code integration, or session flags.

### Exactness reaches readiness by a second path

Inside `doctor`, `host_parity_baseline` is attached to the report at `:430` and
does not flow into `overall`, `readiness`, `readiness_matrix` or
`experience_parity`. That measurement is true and was stated too broadly in the
first draft: it describes the *direct* dataflow only.

End to end, the same exactness policy still reaches cutover through
`runtime:compat`. `compat.mjs` classifies any version mismatch as drift and
reaches `overallStatus: 'current'` only when `driftClass === 'none'`, which
requires exact equality; `cutover-audit.mjs:1002` then requires the latest
compat run to be `status === 'current' && drift_class === 'none'` or reports
`blocked`; and a compat run needing attention also reduces doctor's experience
parity, which cutover separately requires at 100%. A reviewed, assured host that
differs from the dated header would therefore still fail readiness even after
the freshness verdict stopped gating it.

Any decision that moves gating off exactness has to move it in both places, or
it changes nothing.

## Decision

**The freshness site reports exactness and assurance as separate facts, over an
integrity layer that outranks both. Strict normalized equality is retained,
unchanged, as the exactness verdict. Assurance is granted only by human review,
carried in the packaged baseline, mechanically matched but never mechanically
granted, and is what readiness and cutover gate on — in every path that reaches
them. This ADR decides the policy; schema and code are a follow-up.**

1. **Exactness keeps the computation and the grammar.** Strict normalized
   equality at `doctor.mjs:1191-1194` is correct for the question it answers and
   is not relaxed. The single baseline grammar and failure vocabulary
   established by ADR-0051 §Decision 4 are not forked.

   Stated precisely, because §Decision 2 does add content to the packaged
   baseline: the *dated-header* grammar — `HEADER_RE` and the
   `{date, claude, codex}` shape `parseBaseline` returns — is unchanged, and
   every existing caller keeps parsing exactly what it parses today. Assurance
   is a **separate section with its own reader, added to the same single-source
   module** (`plugins/runtime/scripts/lib/host-parity-baseline.mjs`), never a
   widening of the header. That is an addition under ADR-0051 §Decision 4, not a
   fork: what §Decision 4 forbids is four callers each inventing a grammar for
   the same fact, and this adds one grammar for a new fact in the one place that
   owns grammars.

2. **Assurance is a separate, human-granted verdict.** It records whether the
   host this machine runs is covered by accepted review, and it is never derived
   from a version comparison. `runtime:compat` may assemble release-note
   evidence and candidate contract contacts; it may not grant acceptance. This
   preserves ADR-0026 §3's human-review boundary rather than routing around it.

3. **Integrity outranks both, as an independent hard stop.** `missing`,
   `unreadable`, `escaped`, `unparseable` and an unreadable host probe are not
   freshness answers and are not tradeable against coverage. A parseable
   assurance section next to a broken or escaped baseline, an unknown schema, or
   a failed probe is **blocked**, never covered. Negative and unknown win over
   positive at every layer, and duplicate, conflicting, superseded or revoked
   assurance records resolve negative-wins.

4. **Readiness and cutover gate on assurance in every path.** Moving
   `host_parity_baseline` out of `cutover-audit`'s `CHECK_PASS` is necessary and
   not sufficient. `compat` keeps recording drift as evidence — a non-exact host
   stays visibly drifted — but its readiness *classification*, the
   `latest_compat_snapshot` check at `cutover-audit.mjs:1002`, and the
   experience-parity contribution must key on assurance rather than on exact
   equality. Remembered snapshots taken before this decision are never
   retroactively granted assurance.

5. **Humans grant; runtime matches.** The distinction is normative because the
   two are easy to conflate:
   - A human authors the coverage predicate — which releases, which packages,
     which models, flags or integrations it applies to.
   - Runtime mechanically evaluates whether the current environment is a member
     of that predicate. Membership matching is not derivation.
   - A predicate whose inputs runtime cannot observe, or that matches
     ambiguously, yields **unassured**. Absence of evidence is never coverage.

6. **Assurance may be granted with recorded residuals.** A reviewer may accept a
   host while open questions remain, provided each residual is recorded with its
   surface and disposition. Without this rule assurance becomes strictly harder
   to satisfy than exactness and the treadmill simply relocates — the failure
   this decision exists to avoid. A residual on a surface the baseline marks
   unadopted does not block; a residual on a consumed surface is the reviewer's
   call and is recorded as such.

7. **Any window is an explicit finite cohort of reviewed releases.** Endpoint
   ranges are rejected: they conceal skipped releases and cover behaviorally
   distinct intermediate versions. Independent per-host cohorts do not authorize
   their Cartesian product — a host pair is covered only if the tuple was
   reviewed or a reviewer approved a combinability rule.

8. **Assurance binds to the code whose compatibility was reviewed.** The
   `2.1.233` correction spanned five independently released packages, and the
   two consumed open surfaces belong to `plugins/attention` and
   `plugins/engineer`, which version separately from `plugins/runtime`. A
   runtime-packaged grant that names only host versions can therefore outlive
   the code it described. A grant records the consuming package set and
   versions it was reviewed against, and is invalidated when a named package
   changes version, is absent, or is disabled. Rolling back a package does not
   resurrect withdrawn coverage.

9. **Safety is never inferred from semver position, keyword silence, or elapsed
   time.** Recorded with the measurement that forces it: 17 of 18 Claude Code
   steps are patch-position, and the single lap that produced real adoption work
   is patch-position. A patch-tolerant verdict would have graded the `2.1.233`
   tool withdrawal as not worth reporting.

10. **Direction is recorded, and needs more states than ahead/behind.** "Host
    ahead of the last review" and "machine behind the reviewed baseline" are
    distinct states with distinct operator actions and stop sharing one word.
    Two further states are required because exactness and precedence disagree:
    `normalizeVersion` preserves prerelease and build metadata while the
    module's comparison form drops them, so `0.147.0-rc.1` versus `0.147.0`, and
    `2.1` versus `2.1.0`, are non-exact at equal precedence —
    `same-precedence-nonexact`. Per-host mixed direction and unparseable
    versions are likewise their own states. The comparator must be **packaged**:
    the module exports `releaseVersion` but no comparison function today, and
    `compareSemver` lives in `scripts/check-host-version-drift.mjs`, a repo-only
    CI script an installed runtime cannot import. This is the sound half of
    ADR-0052 §Decision 6's alignment follow-up.

11. **Migration and precedence are decided here, not deferred.** They are safety
    properties, not formatting:
    - A new reader against an old baseline or an old recorded artifact yields
      **unassured**, and unassured blocks. Exactness-only degradation is safe
      for a non-gating legacy reader and fail-open for old gating logic, so the
      degrade rule applies to reporting, never to readiness.
    - An old reader ignores the new section, which is correct but means it
      cannot enforce this policy; the accepted cutover gate therefore names a
      **minimum assurance-capable runtime version**, below which readiness is
      not claimable.
    - Rollout is atomic or shadow-read-first. A rollback must not restore
      exactness-as-pass; per ADR-0052 §Decision 7 a protected-asset rollback is
      a forward patch at the next version.

12. **Governance.**
    - This ADR **amends** ADR-0051 by adding an assurance section to what the
      packaged baseline carries. ADR-0051 §Decision 1–8 remain operatively
      accurate: the packaged copy stays the sole authority, changing it still
      obliges a release, and the grammar stays single-sourced. Adding the
      section changes a protected blob and correctly inherits ADR-0052's
      `check-release-obligation.mjs`, which digests the whole tracked protected
      set; a sidecar file outside the baseline or `data/schemas/**` would
      instead require expanding the protected paths and is not chosen.
    - It **closes ADR-0052 §Decision 6's "patch-tolerance alignment" follow-up
      as rejected on measurement**, retaining only its direction-aware half
      (item 10 above). ADR-0052's enforcement decision is otherwise untouched.
      Recorded rather than dropped, because the follow-up reads persuasive and a
      future reader would otherwise re-propose it.
    - ADR-0026's Decision sections are unchanged and are the layer this decision
      builds on.
    - Deferred to the follow-up: the assurance record's schema, whether the
      doctor report's `runtime-doctor-1.0` schema version bumps (it is compared
      by exact string equality at `doctor.mjs:1987`, so this is a real choice
      with artifact-reading consequences), and the concrete code changes.

**The failure mode this gate exists to prevent, stated so it cannot be traded
away**: loosening the verdict risks missing a real contract change. Host
surfaces this framework consumes — hooks, plugin manifest schema, permission
model, tool availability, subagent behavior, sandboxing — change outside this
repository, and `2.1.233` demonstrates that they change inside a patch bump.
Nothing in this decision permits a mechanically-derived `covered`. Mechanical
*matching* against a human-authored grant is required (item 5); mechanical
*granting* is forbidden. Assurance is granted by review or it is not granted.

## Consequences

**Positive**: The fact readiness actually needs starts existing, instead of
being substituted for by a version-string comparison that never claimed to
answer it. The review conclusions the verdict currently discards get a place to
live. Integrity failures stop being expressible as freshness. A reviewed host
that differs from the dated header can become ready without the baseline being
refreshed first — which is the only path in the option set that decouples
readiness from the refresh lap at all.

**Negative**: Three layers are three things to understand, and a consumer could
gate on the wrong one — which is why §Decision 3, 4 and 11 are decided here
rather than deferred. Assurance is only as good as the review behind it, and a
`covered` label can overstate what a changelog proves. The follow-up touches the
packaged baseline and both readiness paths, so it carries ADR-0051's release
obligation, ADR-0052's enforcement, and a minimum-runtime-version floor.

**Neutral**: For a host version outside the reviewed cohort, assurance remains
ungranted until the same human review lands, on the same cadence. This decision
does not reduce review latency, which ADR-0052 measured as 81.7% of one
obligation loop, and does not claim to. The refresh loop's yield is likewise
unchanged — sparse but non-zero, as the `2.1.233` lap shows.

## Alternatives Considered

### A — Keep strict equality, calibrate the wording only

Change nothing computational; state that `stale` means the packaged evidence
does not describe this exact machine, not that the host is incompatible. The
smallest and safest option, and it preserves the detector that surfaced the
`2.1.233` defect. Rejected because the defect is a missing fact rather than a
misworded one: no wording makes `readyCandidate` consult a human's acceptance,
because no such record exists for it to consult. Wording also cannot reach the
second path — `compat`'s exact-equality classification would keep blocking
cutover regardless of how the freshness line reads.

### C-min — Rename and re-rank only

Split `stale` by direction, rename the forward case away from defect language,
and decide `cutover-audit`'s `CHECK_PASS` treatment — without adding an
assurance plane. Held as the fallback if the owner judges the assurance plane's
cost too high. Not adopted for the same reason as A, plus one of its own:
removing exactness from `CHECK_PASS` without putting assurance in its place
removes a gate rather than correcting it, and leaves `latest_compat_snapshot`
blocking on the same fact anyway.

### B — Replace equality with verified-window or contract-contact grading

Replace `current`/`stale` with grades such as `covered-no-contact` or
`contact-unverified`. Rejected because it is not computable where the verdict is
computed — `doctor` holds two version strings and the parsed baseline, and "did
this release touch a contract we consume" is precisely what ADR-0026 §3 placed
behind human review — and because replacing exactness discards a cheap, correct,
independently useful fact in order to express a different one that can simply be
added alongside it.

An earlier draft also rejected B on the ground that it would fork the shared
baseline parser. That argument is withdrawn: the adopted design itself adds a
new grammar for a new fact in the same single-source module without widening the
header parser, so grading could have done the same. Recorded rather than deleted,
because a rejected option deserves the reasons that actually hold.

### B′ — Patch-tolerance alignment with the CI drift gate

The variant ADR-0052 §Decision 6 recorded as a follow-up. Prototyped against the
real history and rejected on measurement, per §Decision 9: it silences 17 of 18
Claude Code steps including the only lap that produced adoption work. Its
companion 14-day age window has never fired across 18 intervals. What remains
sound is direction-awareness, adopted as §Decision 10.

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
  enforcement; §Decision 6 follow-ups; §Decision 7 forward-patch rollback;
  loop-cost decomposition
- `docs/assurance/evidence/records/baseline-2-1-233-and-the-withdrawn-todo-tools.json`
  — the tracked evidence record for the motivating lap: proof id, host versions,
  baseline hash, and the five package releases it required
- `plugins/runtime/scripts/doctor.mjs:1191-1194`, `:1229`, `:430`, `:1987` — the
  exactness computation, its label, where it attaches, and the artifact
  schema-version equality check
- `plugins/runtime/scripts/lib/host-parity-baseline.mjs:76`, `:113`, `:143`,
  `:187-190` — `normalizeVersion`, the comparison form, the header parser, and
  the integrity statuses
- `plugins/runtime/scripts/compat.mjs` — drift classification and the
  `current`-only-on-exact-equality path
- `plugins/runtime/scripts/cutover-audit.mjs:17,104,112,1002` — both readiness
  paths exactness reaches
- `scripts/check-host-version-drift.mjs:34,73,83-92,116-118` — semver-position
  grading, the repo-only `compareSemver`, and the 14-day age window
- `plugins/runtime/docs/host-parity-baseline.md` — Version History; the
  `2026-08-16` row's recorded open surfaces; rows 180–182
- `.agentic-plugins/runs/doctor/` — the 70 recorded proofs behind the
  duty-cycle measurement
