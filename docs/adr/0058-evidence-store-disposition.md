# ADR-0058: Evidence-store disposition — the exporter works; the discriminator is what is missing

## Status

Proposed

<!--
Amends ADR-0049 (§Decision 6's precondition 1 is restated; the
Consequences withdrawal trigger is retired and replaced). It does NOT
supersede: ADR-0049's Decision-section prose remains operatively
accurate — rendering is still not adopted, the prose is still
hand-written, and the migration is still deferred. See
README.md §"Amendments vs Supersedes".
-->

## Context

[ADR-0049](0049-evidence-as-data.md) §Decision 6 deferred rendering and
the historical migration to a follow-up ADR behind two preconditions,
and reserved the next ADR number for it. This is that ADR. Both
preconditions have now been worked, and they do not point the same way.

Everything numbered below was measured against the tree at `cbd90df`
during this ADR's authoring, through the checks' and the store's own
injection seams. Where a figure restates one another document already
reported, it was re-derived rather than copied — the incumbent record is
not treated as an oracle for its own claims.

### Precondition 2 — met

"A resolution for the single-line table constraint, satisfying
`cutover-audit.mjs` and the five-cell row pin, or a design that moves the
evidence out of those rows into a standalone section that the rows link
to."

Answered by [`docs/assurance/scorecard-evidence-design.md`](../assurance/scorecard-evidence-design.md)
(`cbd90df`). Each evidence cell becomes an authored bounded claim plus a
pointer to a same-file record section under an anchor derived from the
row id. The decision is measured rather than argued: same-file is the
only move that preserves the enumerated corpora (release claims 77 → 77,
date pairs 94 → 94, shas 611 → 611, where a separate file under `docs/`
silently drops to 60 and 65 with every gate green), all twelve cells
already exceed the audit's 220-character budget so a bounded cell makes
that output authored for the first time, and four assertions catch 6 of 6
mutations where the incumbent shape test catches 1.

It is a decision, not an implementation. Nothing in the scorecard's bytes
changed at that commit, and nothing in this ADR makes its implementation
wait on rendering.

### Precondition 1 — `fail`

"A typed exporter spike … an exporter that emits records with source
locations … a migration acceptance criterion of 'extract → render →
extract, empty diff' is circular until an independent coverage manifest
pins the expected record ids, proof ids, tags, and field identities."

Everything that precondition asks for was built. A frozen corpus
substrate and its manifest (`1124d6c`), a measurement contract with an
executable comparator and reducer (`d7cdcba`, later `8e50380` at
contract 2.2.0), a selected-blob bundle (`73afa1c`), an artifact wire
schema (`cde74be`), the typed occurrence exporter itself under
bundle-only delivery (`832f030`), an independent two-annotator pairing
oracle with adversarial review and owner adjudication (`f5e6ad5`,
`69ca117`), and the verdict run against it (`18f07c0`).

The verdict is [`fail`](../assurance/evidence/measurement/verdicts/precondition-1.md),
and the shape of the failure is the finding:

| | rows |
|---|---:|
| agreeing | 240 (54.9%) |
| missed | 60 |
| unexpected | 96 |
| mispaired | 5 |
| unresolved (lane declined) | 20 |
| not-adjudicated (oracle declined) | 16 |
| **total** | **437** |

**The mechanical part works.** All 5 `mispaired` rows differ on an
OPTIONAL role only — `marketplace_sync` on four, `squash` on one.
Required-role pairing is perfect: wherever both sides bound an anchor,
the lane named the same physical occurrence for every required role. That
is precisely the class the oracle was built to reach, the one every
value-level check in this repository is blind to because the values
agree, and the exporter does not commit it.

**The interpretive part does not.** `missed` 60 plus `unexpected` 96 is
156 rows, and not one is a disagreement about which occurrence fills a
role. Every one is a disagreement about whether a claim exists at all,
dominated by 87 rows where the lane says "a claim whose role I could not
fill" and the oracle says "no claim here". A rule can locate the right
occurrence; it cannot judge whether a sentence asserts a relation or
merely mentions one.

So the precondition as written asks for the wrong thing. It reads as a
tooling gap — build an exporter that emits records — and the exporter is
not what is missing. What is missing is a source of truth for
claim-versus-mention that a renderer could consult, and no amount of
further exporter work produces one. ADR-0049 §6 named the circularity
correctly ("if extractor and renderer omit the same field, the diff is
empty and the field is gone"); this measurement says where it bites.

**The verdict's own error bar is unmeasured, and that is stated rather
than assumed.** 156 rows on which both independent annotators agreed and
both self-reported `interpretive` are a correlated-error zone; the
adversarial pass did not reduce it (144 → 156). A sampled owner review
declaring a measured error rate was proposed and has not been run. A
further 36 rows (8.2%) are scored by neither side.

### Three claims from the 2026-08-28 owner assessment, corrected

The owner decided on 2026-08-28 to retain the store and open this ADR
rather than withdraw. That decision is recorded, not reopened. But the
assessment that supported it carried three claims that Plan-verify
qualified, and an ADR that records the decision should not carry them
uncorrected. Each is re-measured here.

**1. "The store's only consumer is its own validator."** Understated —
there is a second consumer, indirect but real.
`plugins/runtime/scripts/lib/retention-planner.mjs` enumerates every
git-tracked file and scans each decodable one for run-id tokens of any
registry family; a token found in a tracked file pins that run against
deletion. The store's records are tracked JSON, so every run id they
carry is pinned by that scan without the planner knowing the store
exists.

Measured over the tracked tree: 831 files scanned, 1 skipped as binary,
146 distinct run-id tokens. Of the 34 run ids the store cites, 29 are
also cited outside it and **5 are pinned only by the store** — 3 as
`proofs[].run_id` values and 2 more that appear only as tokens in record
narrative, both `settings-` runs. That is exactly the split the
disposition question needed: store-only pinning is 3 by structured field
and 5 by any token.

The retention argument is nonetheless self-referential, and calling it
so is the honest reading: the only citer of those five runs is the store,
so the store pins the artifacts that make the store verifiable. That is
not vacuous — the artifact is the thing being preserved and the record is
the reason to preserve it — but it is not independent corroboration
either, and it was previously stated as though it were.

**2. "The store's unique contribution is that it hashes proof
artifacts."** Understated in two directions.

`scripts/lib/evidence-store.mjs` also enforces three things no prose gate
applies: the **tag-time package/version binding** (`expectedTag` reads
`release-please-config.json` *at the cited tag* and requires package,
version and tag to agree, because `plugin-runtime-v0.83.0` and
`plugin-attention-v0.6.0` are the same commit and a bare tag-time version
comparison accepts the wrong package's tag); the **null-sync claim** (a
`marketplace_sync` of `null` is a claim that no catalog-sync commit sits
in the release window, and fails if one does — omission is not an escape
from the relation check); and the **forward-only integration-branch
floor** (records present on the base and absent from the working tree are
findings, with an unreadable base failing closed rather than degrading to
"no floor").

The hashing claim itself needs a scope. `scripts/sync-doc-versions.mjs`
also reads under `.agentic-plugins/runs/doctor/`, but only
`latest.json` — a pointer to the current proof, read for its reported
version, never hashed. The store is the only reader in the repository
that opens each *cited historical* artifact, hashes its bytes against
`artifact_sha256`, and then re-compares the transcribed `run_id`, `date`
and `runtime_version` against the parsed content. On this checkout that
is 23 proofs: 23 verified, 0 unverified, 0 failed.

**3. "An empty store passes."** True only through the injection seam,
and the seam is a unit-test affordance with no working tree behind it.
Measured against the live repository:

| case | findings |
|---|---|
| control — live store | 0 (19 records, 23 proofs verified) |
| injected empty, no floor supplied | 0 — **passes** |
| injected empty + the real 19-stem floor | 19 — fails, "record exists on the integration branch but is absent" |
| injected empty + `floor: null` | 1 — fails closed, "the integration base could not be read" |

A non-injected empty store derives its floor from git and cannot take
that pass: measured with a `PATH` shim counting invocations, a real empty
store spends 2 git calls (`rev-parse origin/main`, `ls-tree` of the
records directory) establishing the floor before it returns. So the
green an empty store can reach is correct only for the pre-first-record
state — which is what the code comment above the floor says, and what
the assessment's shorter phrasing lost.

One stale artefact of the pre-floor design survives and is worth fixing
while this is in hand: `scripts/check-doc-evidence.mjs`'s comment above
`runAllChecks` still claims `checkStore` "returns before any git work
when there are no records". The two invocations above disprove it.

### The withdrawal trigger is dead by its own terms

ADR-0049 Consequences: "**withdrawal trigger: two consecutive release
loops in which the store is authored but the follow-up ADR has not been
opened.**"

It was satisfied 19 times over. The store holds 19 records, one per
authored loop, and ADRs 0050–0057 are each a different subject — no
follow-up ADR existed at any point in that run, so all 19 loops counted
consecutively against a threshold of 2.

Worse than breached, it is now unfireable. The condition it counts is
"the follow-up ADR has not been opened", and this document opens it. From
merge onward the counter can never advance again, however long rendering
stays blocked. A trigger that a single document permanently retires was
measuring a proxy — whether an ADR exists — not the thing it cared about,
which is whether the duplication ever gets reduced.

Its premise is also wrong. ADR-0049 stated that the store's "value is
entirely contingent on the deferred follow-up landing" and that "if that
follow-up never lands, this decision is net negative". Measured above,
the store does two things standing alone that nothing else in the
repository does, neither of which depends on rendering. The headline cost
ADR-0049 named — on landing, a sixth copy — is real and unchanged; the
contingency claim attached to it is not.

### The measurement substrate is load-bearing, not spike residue

`docs/assurance/evidence/measurement/` is about 4.5 MB, of which roughly
4.0 MB is JSON: the oracle and its two annotator sources, the lane
artifact, and the authority baseline. Disposing of it looked like a
question about dead weight. It is not.

`scripts/check-doc-evidence.mjs` reads
`docs/assurance/evidence/measurement/corpus-manifest.json` to build a
blob-id index, and exempts tokens matching those blobs from the
discovered-corpus commit-sha gate — otherwise a manifest blob id read as
an abbreviated commit sha would fail to resolve. The comment recording
that exemption's safety was measured at pin `d49f74e`, before the
substrate's own documents existed, and reported that the exemption masked
nothing. Re-measured at `cbd90df`:

- blob index: 77 ids; **0 of the 77 is also a commit object** — the
  safety property still holds, so no real commit can be exempted;
- discovered corpus: 91 markdown files, 638 extracted tokens;
- **24 tokens are now exempted**, all of them inside the substrate's own
  `oracle/annotators/*/REVIEW.md`.

Controls, run through the checker's `docs` injection seam: a
manifest-listed blob cited in a document is exempt and not checked; an
*unlisted* repository blob cited the same way produces one finding,
`resolves to a blob, not a commit`; a real commit sha is checked and
clean. So removing `corpus-manifest.json` while leaving the annotator
reviews in place turns the doc-evidence gate red with 24 findings, and
removing the reviews while keeping the manifest silently widens an
exemption that then covers nothing.

## Decision

**1. Rendering and the historical migration stay deferred, with the
blocker named.** Not "deferred pending more spike work". The blocker is
that claim-versus-mention is an interpretive judgment, measured at 156
disagreeing rows out of 437 with pairing otherwise clean, and no
extractor produces it. ADR-0049 Decision 5 (no rendering, no generated
regions, the prose stays hand-written) is unchanged and remains
operative.

**2. ADR-0049 §Decision 6's precondition 1 is restated.** As written it
asks for a typed exporter spike with an independent coverage manifest;
both were built and the exporter is sound on the part a rule can decide.
It is replaced by:

> **Precondition 1′.** A resolution for the claim-versus-mention
> discriminator: either an adjudicated source of truth a renderer may
> consult for whether a given span asserts a relation, or a scope
> restriction to relation families in which the discriminator provably
> does not arise. A future verdict on this precondition must state its
> own error bar or measure it — the `18f07c0` verdict rests on 156 rows
> where two annotators agreed and both self-reported `interpretive`, and
> that error rate is unmeasured.

The exporter, oracle and comparator are not re-work for the next attempt;
they are the substrate it starts from.

**3. Precondition 2 is recorded met, and its implementation is
independent of this ADR.** `scorecard-evidence-design.md` may be
implemented on its own schedule. It does not wait on rendering, and
rendering no longer waits on it. If a renderer ever lands, the twelve-row
table is a natural second projection and that design does not obstruct
it — as its own §5 records for the peer's deferred generated-table
approach.

**4. The store is retained, on a restated justification.** Retention is
the owner's 2026-08-28 decision and is not reopened here. What changes is
the basis: the store is kept for what it does standing alone — the only
byte-level verification of cited historical proof artifacts (23/23
verified here), and three derived checks no prose gate applies — not as a
staging area whose worth arrives with rendering. ADR-0049's contingency
claim is withdrawn as measured-false; its sixth-copy cost is not.

**5. The withdrawal trigger is retired and replaced.**

> **Retired.** "Two consecutive release loops in which the store is
> authored but the follow-up ADR has not been opened." Breached 19 times
> against a threshold of 2, and made permanently unfireable by this
> document.
>
> **Replacement.** Two consecutive `plugin-runtime` release tags, within
> the store era, that appear in no record's `package_releases[]`.

Three properties make it a measure rather than another proxy. It is
**derived-only** — tags come from `refs/tags/` and the field is a derived
one, so it is decidable without touching the authored membership
judgment ADR-0049 Amendment item 4 protects. It **cannot be retired by
writing a document**; only authoring records clears it. And it keys on
the actual failure mode that remains: not "rendering never lands", but
"the store stops being authored and rots into a stale copy".

Measured at authoring, so the replacement is not born breached: the store
era opens at `plugin-runtime-v0.86.3`, contains 19 `plugin-runtime` tags,
and **0 are uncovered** — longest consecutive uncovered streak 0. The
scope is stated rather than assumed: 15 tags of other packages in the
same era are uncovered and are deliberately out of scope, because the
store never claimed to cover them and widening the trigger to all
packages would fire it on the day it is written, which is the failure
being repaired.

Two adjacent failure modes deliberately get **no** trigger, and the
reasons are recorded so a later reader does not read the omission as an
oversight. *The store is authored but never catches anything* is not
discriminable — a gate that finds nothing looks identical to a working
one. *Rendering stays blocked indefinitely* is no longer a withdrawal
condition, because Decision 4 removes the contingency it rested on; it is
a standing open item under Decision 1, not a countdown. A third,
*proofs become unverifiable everywhere as retention prunes them*, is a
genuine value collapse and is measurable — `proofStatus.verified`
falling to 0 — but only on a maintainer checkout, so it is recorded as a
watch item rather than a trigger, since a trigger keyed to one machine
is not a repository property.

**6. The measurement substrate is retained whole, and moves as a unit if
it ever moves.** `docs/assurance/evidence/measurement/**` and
`scripts/evidence-measurement.mjs` / `scripts/evidence-corpus.mjs` stay,
for three reasons: they are what makes the `fail` reproducible (the
verdict document's reproduction command is inert without them);
`corpus-manifest.json` is live infrastructure for the production sha gate
(24 exemptions measured above); and precondition 1′ starts from them
rather than from nothing.

Two consequences of that follow, and are the operative part of this
decision:

- **The lane exporter is retained as evidence, not promoted.**
  `docs/assurance/evidence/measurement/lanes/s1-typed-exporter/exporter.mjs`
  is the artifact of a `fail`. It must not be used to seed a store, back
  a renderer, or be read as a sanctioned extractor. It is committed so
  the verdict can be re-run against it.
- **Piecemeal deletion is prohibited.** The manifest and the annotator
  reviews are coupled through the gate exemption in a measured
  direction: dropping the manifest alone produces 24 findings, dropping
  the reviews alone leaves an exemption covering nothing. Any future
  removal removes the substrate and the gate's exemption path in one
  commit, with the sha check re-measured in that commit.

**7. ADR-0049 is amended, not superseded.** Its Decision-section prose
remains operatively accurate on every point: the store is still
forward-only and keyed by evidence loop, provenance is still declared per
field, relations are still typed and plural, gates still validate only
what their source can back, rendering is still not adopted, and the
migration is still deferred. What this ADR changes lives in §Decision 6's
precondition wording and in the Consequences trigger — a restatement and
a replacement that follow from the original decision rather than reverse
it. This matches the discriminator in `README.md` §"Amendments vs
Supersedes" and the precedent ADR-0049's own 2026-07-27 Amendment set
when it corrected a Context table that a Decision points at.

## Consequences

**Positive.** The two preconditions stop being an open question of
unknown size and become one met design plus one named, measured blocker.
The withdrawal trigger becomes something that can actually fire, keyed to
authorship rather than to the existence of a document, and it is
published with the measurement that shows it clean at 0 of 19 rather than
asserted. Three claims that supported the retention decision are
corrected in the record. The measurement substrate acquires a stated
disposition and a stated coupling to a production gate, so a future
tidy-up cannot remove it by mistake.

**Negative.** The duplication ADR-0049 identified as the root cause is
still not reduced, and this ADR does not reduce it — the five prose sites
remain hand-written and the store remains a sixth copy. The recurring
post-release recovery PR is not eliminated. Precondition 1′ is harder
than precondition 1 was believed to be: it asks for an adjudicated
judgment source, and the honest reading of `18f07c0` is that this may
never be satisfiable for the full relation set, in which case rendering
is permanently limited to the scope-restricted half. About 4.5 MB of
committed evidence is retained for a precondition that returned `fail`,
and 13 of its markdown files sit permanently in the discovered sha
corpus.

**Neutral.** The store's justification changes shape without changing its
behaviour: no schema change, no validator change, no record rewrite, and
no consumer of any document changes. The scorecard evidence design gains
an independent schedule it did not have while it was described as a
migration precondition.

## Alternatives Considered

**Adopt rendering now.** Not available. Precondition 1 returned `fail`,
and the failure is not in the tooling that could be improved before
merging this — a renderer built on the current extractor would inherit
the same claim-versus-mention blindness as the extractor, making
extract → render → extract exactly the empty-diff tautology ADR-0049 §6
warned about. Adopting it would also have required partially superseding
ADR-0049's forward-only clause and Decisions 5–6, which this ADR
therefore does not do.

**Withdraw the store.** The alternative the assessment recommended, and
the owner rejected on 2026-08-28. Recorded, not reopened. Two things are
worth preserving from it: withdrawal would break nothing (measured then),
and the trigger genuinely was breached — this ADR agrees on both and
disagrees only with the contingency premise that made withdrawal look
mandatory.

**Leave the trigger standing and count again later.** Rejected because
there is nothing left to count. The condition is "the follow-up ADR has
not been opened", and merging this document makes that false forever. A
trigger retained in that state is worse than none: it reads as an active
safeguard while being incapable of firing.

**Replace it with a calendar trigger** ("re-decide in six months").
Rejected: a date measures elapsed time, not whether the store is doing
anything. It would fire on a healthy store and stay silent on a rotting
one, which is the wrong way round.

**Widen the replacement trigger to all packages.** Rejected on
measurement: 15 non-runtime tags in the store era carry no record, so
this trigger would fire the day it is written. The store's records cover
runtime release loops and have never claimed otherwise; a trigger that is
already breached at authoring is precisely the failure being repaired.

**Base the replacement on record count or authoring cadence** ("a loop
with no record"). Rejected because loop membership is authored, by
ADR-0049 Amendment item 4 — no source states which release belongs to
which loop, so a gate reading it would be inferring the very judgment
that ADR declared underivable. Tag coverage is the derived shadow of the
same question and is decidable.

**Delete the spike and keep only the verdict document.** Attractive on
size — about 4.5 MB against an 8.8 KB verdict. Rejected on two measured
counts: the verdict's own reproduction command becomes inert, so a `fail`
would be recorded with no way to re-run it against either side; and
`corpus-manifest.json` is consumed by the production sha gate, where its
removal produces 24 findings. The second was not anticipated when the
disposition question was framed as one about dead weight.

**Promote the lane exporter to production as a "good enough"
extractor.** Rejected. It is 54.9% agreeing against the oracle, and its
disagreements are concentrated in exactly the judgment a renderer would
need. Shipping it would convert a measured `fail` into an implicit pass
by changing the subject from correctness to availability.

**Supersede ADR-0049 in part.** Considered against the README's
discriminator and rejected: ADR-0049's Decision prose is still operative
in full, the changes land in a precondition's wording and in a
Consequences trigger, and its own 2026-07-27 Amendment set the precedent
for correcting material a Decision points at without supersedure. A
reader landing on ADR-0049 needs a pointer, which the amendment provides;
they do not need to be sent elsewhere for the operative decision.

## Implementation notes

Not part of the decision, but required when it lands:

- ADR-0049 gains an Amendment block dated to this ADR, and a header
  pointer, covering the precondition restatement and the trigger
  replacement. Its `README.md` index row also ends with the retired
  trigger and must be corrected in the same change — an ADR's summary
  lives in two places, and correcting one leaves the other standing.
- `scripts/check-doc-evidence.mjs`'s stale comment above `runAllChecks`
  ("`checkStore` returns before any git work when there are no records")
  is corrected: the forward-only floor spends two git invocations before
  the empty-store return.
- The replacement trigger is stated in prose and is not gated. Making it
  a check is possible — it reads only tags and a derived field — and is
  deliberately not required here, because a trigger whose whole purpose
  is to prompt an owner decision does not need to fail a build to work.
