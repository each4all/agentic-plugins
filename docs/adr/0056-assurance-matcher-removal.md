# ADR-0056: Remove the assurance grant/cohort matcher — keep the review, drop the machine verdict

## Status

Accepted (2026-08-27). Supersedes [ADR-0053](0053-baseline-exactness-and-compatibility-assurance.md) and [ADR-0054](0054-assurance-record-schema-and-rollout.md) in part — the assurance verdict, not ADR-0053 §Decision 1's exactness. Implemented by the `grant-impl` subtask in the same release.

## Context

[ADR-0053](0053-baseline-exactness-and-compatibility-assurance.md) separated two
facts at the freshness site: **exactness** (does the observed host version equal
the baseline's?) and **assurance** (has a human reviewed this host pair?). It
made readiness gate on assurance in every path.
[ADR-0054](0054-assurance-record-schema-and-rollout.md) then gave assurance a
record: one canonical JSON block in the packaged baseline, a grant naming an
explicit **cohort** of `(claude, codex)` version tuples, and a matcher that
answers `covered` only when the machine's observed tuple is a member.

The design is sound and the implementation does what it says. The problem is
that **the matcher has never once answered `covered` on a real machine**, and
the reason is arithmetic rather than a defect.

### The measurement

The scorecard records the only two verdicts the gate has ever produced:

- **R1 shipped an empty grant set**, so every host read `unassured` — the
  empty-set refusal.
- **R2 shipped one owner-ratified grant**, `claude-2-1-234-235-codex-0-147-0`,
  naming two tuples: claude `2.1.234` / codex `0.147.0` and claude `2.1.235` /
  codex `0.147.0`. The machine read claude `2.1.237` / codex `0.148.0` — in
  neither — so the layer read `unassured` with `record_status: resolved`. The
  reader, the integrity check, the canonical-bytes comparison and package
  resolution all worked. **Only the cohort match failed.**

R3 was deferred rather than attempted.

The scorecard also records why, measured rather than asserted: across the
retained compat snapshots Claude has taken **18 distinct versions at a median
2.1 days apart** (minimum 0.5) while the review round trip that produced R2's
grant took **10.8 hours** brief-to-install. Codex is slower — 7 versions at a
median 10.2 days — but R2 lost to a Codex step that landed inside the window
anyway.

Exact-tuple cohort matching is a number comparison against a moving target. A
grant is authored against the versions a reviewer actually read (ADR-0053
§Decision 5 requires exactly that, and §Decision 7 permits a cohort to name only
reviewed tuples), so no foresight at authoring time can cover the next release.
Each grant is correct, and each is stale before or shortly after it ships.

### The second cost: residuals get filed instead of fixed

A grant binds to the code it was reviewed against (ADR-0054 §Decision 8), and
revocation is append-only. That has a consequence the residual ledger now
demonstrates: **fixing a bound package invalidates the grant**, so an adversarial
audit that finds a real defect in a bound surface faces a choice between shipping
the fix and keeping the grant. The repository has consistently chosen to file.
`plugins/runtime/docs/follow-ups.md` currently carries at least six open rows
that came out of ST5's assurance audit — exact package-set equality named by
ADR-0054 §Decision 2 and implemented by no layer, the monotonicity gate's
unpinned release history, historical tags read through the working tree's schema,
the `maxLength` code-unit miscount, and two dashboard reader defects.

A verification layer whose success path has never fired, and whose existence
converts findings into deferrals, is costing more than it returns.

### What is actually worth keeping

The **review methodology** is not the matcher. The R3 brief's §2 (extraction
under controls, plus a per-surface human disposition) and §8 (control tables) are
how a person reads two host changelogs and reaches a defensible judgement. That
method survives this ADR and is the engine of macro B's content reviewer.

**What is preserved is "extraction under controls plus human disposition", not
the lexical extractor as an unqualified engine** — and the brief itself is the
source of that qualification. Its own §8.2 correction narrows "validated" to
**17 of 19** rows of R2's full published set, records a zero-count miscount
inherited verbatim from R2's prose, and reports that independent verification
found **seven of eight** lexical hits false-positive on semantically classified
rows. Carrying the method forward without carrying that correction would repeat
the overclaim this ADR is about.

What is being removed is the attempt to have a machine *ratify* a human
judgement into a verdict it can re-derive later from version numbers.

## Decision

### Decision 1 — Remove the grant/cohort/covered matcher

The assurance record leaves the packaged baseline, and the modules that
evaluate it are removed. Readiness no longer has an assurance verdict to gate on.

### Decision 2 — The removal manifest is by identifier, not by the word

The word `assurance` appears in **83 files** in this repository (84 counting this
ADR, which is the point: the count inflates with every document that discusses
the layer). That number must not be used to scope the work, and this ADR states
the trap because the macro plan's own estimate (58 files) was derived that way.
Measured 2026-08-27: `plugins/designer` (6 files) and `plugins/engineer` (1 file)
use it only as **"quality assurance"** — designer's post-code differentiator and
the engineer agent taxonomy. Those are a different concept and must not be
touched. Historical grant reviews, evidence records and changelog entries are
also left alone: they record what was observed at the time.

**Modules removed in full**

| Module | Lines | Exports |
|---|---|---|
| `plugins/runtime/scripts/lib/assurance-contract.mjs` | 922 | `ASSURANCE_GRANT_STATES`, `ASSURANCE_MATCH_STATES`, `UNOBSERVABLE_PREDICATE_KEYS`, `assuranceRecordIssues`, `observePackages`, `matchAssurance` |
| `plugins/runtime/scripts/lib/host-assurance-facts.mjs` | 190 | `buildAssuranceProbe`, `readAssuranceInputs`, `observeMachinePackages`, `resolveHostAssuranceFacts` |

`plugins/runtime/scripts/lib/assurance-result.mjs` (600 lines) is **reduced, not
deleted** — see Decision 5.

**Modules reduced (the assurance grammar is embedded in code that survives)**

| Module | What goes |
|---|---|
| `lib/host-parity-baseline.mjs` | `ASSURANCE_SCHEMA_FAMILY`, `ASSURANCE_SCHEMA_VERSION`, the `BEGIN/END COMPATIBILITY ASSURANCE` sentinels, `ASSURANCE_STATUSES`, `ASSURANCE_SUMMARIES`, `parseAssuranceSection`, `resolveAssuranceRecord`, and the assurance-region masking the baseline parser applies |
| `lib/schema-validate.mjs` | the `runtime-host-assurance-1.0` schema registration |
| `lib/compat-artifacts.mjs` | the assurance-era schema families, the assurance statuses, `READY_COMPAT_STATUSES`, and the historical projection |
| `lib/state-readers.mjs` | the interpretation and rendering of retained assurance-era compat artifacts |
| `lib/runtime-floor.mjs` | `evaluateHostFloor`, `evaluateRuntimeFloor`, `describeFloorFailure` (see Decision 4); `comparePrereleaseAware` stays |

**The surviving dependency is `buildAssuranceProbe`, not `observePackages`.** An
earlier draft of this ADR had that backwards and the cross-host review disproved
it against the tree. `observePackages` is passed *only* as `packageObservation`
into `resolveHostAssuranceFacts` (`doctor.mjs:1291`) — it feeds the evaluator and
nothing else, and its other caller exercises functions Decision 4 removes, so it
becomes dead. `buildAssuranceProbe` is what builds the raw / probe-gated /
normalized host facts that `buildHostParityBaseline` consumes for **exactness**
(`doctor.mjs:1319`), which survives. That helper is re-homed or replaced by a
non-assurance equivalent; `observePackages` is deleted unless a new consumer is
introduced deliberately.

**Consumers to rewire.** Each carries more assurance behaviour than an import
line, and the implementation must visit every site:

- `doctor.mjs` — the report field (`:461`), fact composition (`:1271`), the
  experience criterion (`:2704`), compat handoff (`:3048`), text rendering
  (`:5932`)
- `compat.mjs` — snapshot observation (`:130`), plan semantics (`:509`), gap
  projection (`:658`), frozen-result readiness (`:801`), `readinessStatus`
  (`:865`)
- `dashboard.mjs` — schema `1.3` (`:71`, introduced for the fields being
  removed), old-doctor projection (`:299`), authored-record reader (`:377`),
  report field (`:989`), text rows (`:1132`)
- `cutover-audit.mjs` — check registration (`:107`), completion checklist
  (`:591`), the assurance/floor checks (`:998`–`:1107`), and the compat
  live-coverage / identity gate (`:1208`–`:1304`)

**Tests.** An earlier draft claimed a one-grant pin in
`tests/runtime/test-plugin-set.mjs`; **there is none** — that file pins only the
floor (`:146`). The grant identity pin is `test-host-assurance-record.mjs:142`,
with a one-grant count in the monotonicity suite. The manifest is:
`test-assurance-contract.mjs`, `test-assurance-plane-hardening.mjs`,
`test-host-assurance-record.mjs`, `test-compat-assurance.mjs`,
`tests/scripts/test-assurance-monotonicity.mjs`, the assurance halves of
`test-baseline-consumer-contract.mjs` and `test-runtime-floor.mjs`, the matcher
case in `test-machine-probe.mjs:624`, compat fixtures and schema pins in
`test-compat.mjs`, doctor fixtures at `test-doctor.mjs:2146`, the cutover
assurance/floor cases in `test-cutover-audit.mjs`, and the packaged schema pin at
`test-runtime-plugin.mjs:876`.

**Repo-level**: `scripts/check-assurance-monotonicity.mjs` (431 lines) and its
`validate:assurance-monotonicity` npm script. No workflow calls the script
directly, but its suite is CI-reachable through discovery-based `npm test`.

**Documentation contracts to edit**: the packaged baseline's assurance prose and
canonical JSON block (`host-parity-baseline.md:516` onward), the runtime README
(`:46`), `commands/compat.md` (`:12`), `commands/dashboard.md` (`:36`), the
compat / cutover / dashboard / doctor skills, and the generated dashboard
metadata (`skills/dashboard/agents/openai.yaml`). **ADR-0051 §Decision 3
normatively states that the baseline gains the assurance section**
(`0051-host-parity-baseline-source.md:259`); this ADR amends that clause, and
`grant-impl` records the amendment there.

### Decision 3 — The generic comparator survives, and so does the floor *field*

`comparePrereleaseAware` in `plugins/runtime/scripts/lib/runtime-floor.mjs` is
imported by `bootstrap.mjs:38` and is not assurance machinery. It stays.

`minimum_version` in `plugin-set.json` also stays, and the macro plan's framing
of it as an "assurance-only floor" is **corrected here**: `bootstrap.mjs:618`
reads `entry.minimum_version` for **every** plugin to build its floor map. The
field is general. Only **runtime's value** is assurance-specific.

### Decision 4 — Runtime's floor `0.91.0` returns to `null`

`plugins/runtime/data/plugin-set.json` sets `plugins.runtime.minimum_version:
"0.91.0"`. ADR-0054 §Decision 5 introduced it as "the minimum assurance-capable
runtime version" — the version below which a host cannot read the assurance
record at all. With no assurance record, that floor guards nothing, and leaving
it would assert an incompatibility that no longer exists.

It returns to `null`, which is what every other plugin except `companions` and
`engineer` declares. `evaluateHostFloor`, `evaluateRuntimeFloor` and
`describeFloorFailure` — the assurance half of `runtime-floor.mjs` — are removed
with it; `comparePrereleaseAware` stays behind in that file.

### Decision 5 — A schema bump with an explicit matrix, and a legacy-only decoder that survives

`compat` and `doctor` artifacts carry a readiness vocabulary that named assurance
outcomes. The affected contracts, each of which needs its own decision rather than
one blanket sentence:

| Contract | Current | Decision |
|---|---|---|
| compat snapshot / gap | `1.1` | minor bump to `1.2` — post-assurance family |
| compat plan | `1.1` | minor bump; its statuses are assurance-shaped today |
| doctor inner report | `runtime-doctor-1.0` | minor bump; the reader must accept both |
| doctor outer artifact | `1.0` | minor bump |
| nested experience parity | `1.0` | bump, because Decision 8 changes its denominator |
| dashboard | `1.3` | `1.3` exists specifically for the fields being removed; removing them is **non-additive**, so `grant-impl` decides minor-with-projection or major and states which |

**The vocabularies are two, not one, and an earlier draft conflated them.**
Producer values in the doctor path are `covered` / `unassured` / `blocked`;
doctor *reader* values additionally include the hyphenated `legacy-unassured` and
`unreadable`; compat uses underscore forms plus `current`, `assured`,
`release_notes_required` and `gap_analysis_ready`. `grant-impl` names, for each
contract, the tokens it writes new, the tokens it still reads as historical, and
the projection between them.

**Historical records are not reinterpreted**, and making that implementable
requires keeping code the first draft deleted. `projectRecordedAssurance`
(`assurance-result.mjs:525`) is the **only** decoder for a historical doctor
assurance section. It survives as a legacy-only decoder alongside
`NO_RECORDED_ASSURANCE` and the reader status list; the matcher-facing exports
(`evaluateAssurance`, `matchAssurance`, `isGrantId`, the producer status lists) go.
A reader encountering `assured` / `unassured` / `legacy_unassured` /
`assurance_blocked` reports them as historical and **never maps them onto a
current status**.

**The compat family reader needs three eras, not two.** `projectGapFamily`
currently distinguishes pre-assurance `1.0` from assurance-era `1.1`, and every
readable non-assurance-bearing family takes the legacy branch — so merely adding
`1.2` to the readable list would classify a *post*-assurance artifact as legacy.
The families are named explicitly: pre-assurance, assurance-era, post-assurance.

**Old `current` is not new `current`.** Under `1.1`, `current` required `covered`.
If post-removal `current` means exact-and-no-drift without any review, projecting
an old `current` into it silently changes what the record claimed. Readers carry
`schema_era` alongside the status, and historical values are excluded from the
ready set.

`plugins/runtime/data/schemas/runtime-host-assurance-1.0.json` is removed and its
`$id` is not reused.

### Decision 6 — The replacement readiness policy, and the clause that must not be deleted naively

Removing the verdict leaves a hole where readiness used to be decided, and the
cross-host review measured a **fail-open** in the obvious way of closing it.

Today `compat` treats `current` and `assured` as the healthy set;
`state-readers.mjs` collapses both to collection `available` and then **drops the
schema era** from the projection it returns. Cutover's freshness check computes
`recordedReady` from that stored status *and* a separate `liveCovered` clause
(`assurance.status === 'covered'` with a valid grant id). It is `liveCovered`,
not exactness, that stops a stored bit from passing on its own — exactness is
explicitly observation-only. **Delete `liveCovered` without replacing it and an
old `1.1` run whose status was `current` or `assured` satisfies current
readiness.**

The replacement policy is therefore named here rather than left to the
implementation:

1. **Historical statuses are never in the ready set.** A record from an
   assurance-era family is readable evidence of the past and is not a current
   verdict, whatever token it carries.
2. **The era travels with the status.** `state-readers.mjs` stops dropping the
   schema era from its projection, because the era is what rule 1 keys on.
3. **The live host pair comes from exactness, not from the removed record.**
   Cutover currently sources the observed pair from
   `host_parity_assurance.evidence.normalized_observed`; it moves to
   `host_parity_baseline.evidence.normalized_observed` (`doctor.mjs:1402`), which
   is the same observation without the verdict attached.
4. **`grant-impl` publishes the new truth table** for `readinessStatus`. Three
   shapes were considered and none is a default: accepting only `current`
   reintroduces exactness as a gate under another name; accepting every analyzed
   drift state lets a stale pair read healthy; deleting the compat check entirely
   drops host-pair identity and freshness protection. The table is a decision,
   and it is made with the code in front of it.

### Decision 7 — The residual ledger migrates per finding, and is not silently closed

The open assurance-audit rows in `plugins/runtime/docs/follow-ups.md` are not
deleted by this removal. `grant-impl` produces an **enumerated before/after
mapping**, one entry per row, into:

- **resolved by removal** — the row described a defect in code that no longer
  exists;
- **survives** — the row describes a defect in code that stays;
- **splits** — part of the row is resolved and part survives.

**"Splits" is a required category, not a convenience.** The review measured four
rows that cannot be triaged whole: the `maxLength` row's assurance-array concern
disappears while the generic UTF-16 code-unit behaviour survives in
`schema-validate.mjs`; both dashboard reader/rendering rows describe
`dashboard.mjs` and survive untouched; the comparator row leaves
`check-release-obligation.mjs`'s own `Number` conversion disagreeing with the
baseline comparator; and the criterion-shape row keeps its disabled-Codex-version
and private-ready-list halves while only its gate/detail-count mismatch is
resolved. Triaging any of those whole would let a live defect vanish behind a
refactor.

A row closed as "resolved by removal" says so, naming this ADR.

### Decision 8 — Removing the experience criterion changes parity's denominator

`bidirectional_host_compatibility_assurance` is one weighted criterion inside the
experience-parity score, and it is **in the denominator** (`doctor.mjs:2725`).
Removing it changes the criterion count, the total weight, the score, and
possibly the headline (`partial` → `ready`). That is intended — a criterion that
can never be satisfied should not sit in a denominator — but it is a scoring
change, not a field deletion. `grant-impl` bumps the `runtime-experience-parity`
schema and states the recalculated weights; the scorecard's current numbers are
restated in post-release recovery, not in the implementation PR (see
Consequences).

### Decision 9 — This ADR is docs-only; `grant-impl` implements it

Two-stage: `Proposed` here, `Accepted` on merge. Implementation, the residual
triage, the readiness truth table and the schema bumps all land in the
`grant-impl` subtask.

**Supersession is atomic with acceptance.** While this ADR is `Proposed`,
ADR-0053 and ADR-0054 say *proposed to be superseded*; the merge that flips this
ADR to `Accepted` flips their wording in the same commit. An accepted ADR pointing
at a proposed one, or the reverse, is a state the index should never show.

## Consequences

**There is no machine verdict of "reviewed", and that is the point.** Nothing
will answer `covered` again. A reviewer's judgement lives in the brief and in the
baseline's prose, where a human reads it, and no gate re-derives it from version
numbers. Readiness reports exactness, drift, and proof evidence — three things
that are actually re-derivable — and stops claiming a fourth that was not.

**Exactness is not relaxed.** ADR-0053 §Decision 1's strict normalized equality
stays exactly as it is. Removing assurance removes the *second* fact at the
freshness site, not the first.

**`grant-impl` will put `main` into release-obligation debt, and all THREE
protected paths are involved.** `plugins/runtime/data/plugin-set.json`
(Decision 4), `plugins/runtime/data/schemas/**` (Decision 5) **and
`plugins/runtime/docs/host-parity-baseline.md`** — removing the record edits the
packaged baseline, which an earlier draft of this ADR omitted. All three are
PROTECTED PATHS under
[ADR-0052](0052-release-obligation-enforcement.md), so
`validate:release-obligation` fails from the moment `grant-impl` merges until a
release carrying it is tagged. That red is the intended signal, and it is why
`runtime-recovery-2` is scoped "one recovery per release" — if `grant-impl` and
`advisor-impl` are released separately, each needs its own proof re-record.

**The legacy reader ships in the same release as the new producer — not before,
not after.** Doctor accepts only `runtime-doctor-1.0` for the inner report today
and dashboard exact-pins it independently; doctor scans every retained run, and a
rejected historical artifact increments `malformed`, which blocks the collection.
A fresh new-schema record cannot clear old malformed entries, so a producer that
lands without its dual reader turns every retained artifact into a fault.

**Current scorecard claims change in post-release recovery, not in
`grant-impl`.** The repository's continuity order is merge → release → install →
record evidence, and `sync-doc-versions.mjs` refuses a manifest/proof mismatch.
`grant-impl` may change code, schemas and the baseline; the scorecard's live
weighting and status are restated once new artifacts exist. The historical R1/R2
refusal narrative stays either way — it is the evidence for this decision.

**The scorecard loses its assurance rows and keeps its history.** The narrative
recording the empty-set and cohort-miss refusals stays: it is the evidence for
this decision, and deleting it would remove the reason the layer was removed.

**Reversal is a new review layer, not a revert.** If a future host pair becomes
stable enough that exact-tuple matching could succeed, the answer is to design a
matcher against that stability — not to restore one measured against a
2.1-day release cadence.

## Alternatives Considered

**Widen the cohort to version ranges.** Rejected: it would let a grant cover
versions nobody read, which is precisely what ADR-0053 §Decision 5 forbids. The
matcher is not too strict; the thing it matches moves too fast.

**Keep the layer and accept `unassured` as the normal state.** Rejected on the
residual evidence. A gate whose success path never fires is not merely inert —
it converted six audit findings into deferred rows because fixing a bound
package invalidates the grant.

**Automate the review so grants keep pace.** Rejected: a machine-generated grant
is not a human review, and ADR-0053 §Decision 2's "humans grant; runtime matches"
is the invariant that made the layer meaningful in the first place.

**Remove only the cohort match, keep the grant record.** Rejected: a grant that
matches everything is a grant that asserts nothing, and it would leave the same
bound-package problem while removing the only thing that made the binding
honest.
