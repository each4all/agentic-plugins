# ADR-0058: Evidence-store disposition — most of the gap is a judgment no rule makes, and the coverage half of the precondition was never built

## Status

Proposed

<!--
Amends ADR-0049 (§Decision 6's precondition 1 is ADDED TO, not replaced;
precondition 2 is recorded met; the Consequences contingency premise and
withdrawal trigger are withdrawn and replaced). It does NOT supersede:
ADR-0049's Decision-section prose remains operatively accurate —
rendering is still not adopted, the prose is still hand-written, the
migration is still deferred, and precondition 1's coverage requirement
still stands unmet. See README.md §"Amendments vs Supersedes"; the
cross-host review argued for partial supersedure and §Decision 7 records
why its own strongest finding answers it.
-->

## Context

[ADR-0049](0049-evidence-as-data.md) §Decision 6 deferred rendering and
the historical migration to a follow-up ADR behind two preconditions,
and reserved the next ADR number for it. **This document takes that
number without being that ADR**: ADR-0049 reserved it for the
renderer/migration decision, and the review of this draft was right that
declaring itself that ADR on a failed precondition would be the very
thing ADR-0049 §6 forbids. What this ADR does is report on the two
preconditions and decide the store's disposition in the meantime; the
renderer/migration ADR remains unwritten. Both preconditions have now
been worked, and they do not point the same way.

Everything numbered below was measured against the tree at `cbd90df`
during this ADR's authoring, through the checks' and the store's own
injection seams. Where a figure restates one another document already
reported, it was re-derived rather than copied — the incumbent record is
not treated as an oracle for its own claims.

A cross-host review of this ADR's first draft then re-derived those
figures independently and **disproved four of its claims**. They are
corrected in place below rather than quietly dropped, and listed together
in §"What the cross-host review disproved" so the corrections are
auditable as a set.

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
date pairs 94 → 94, and — at that document's own pin `69ca117` — shas
611 → 611, where a separate file under `docs/` silently drops to 60 and
65 with every gate green; the sha figure is 614 at `cbd90df`, because the
corpus keeps growing, which is the point that document makes about it), all twelve cells
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

Most of what that precondition asks for was built. A frozen corpus
substrate and its manifest (`1124d6c`), a measurement contract with an
executable comparator and reducer (`d7cdcba`, later `8e50380` at
contract 2.2.0), a selected-blob bundle (`73afa1c`), an artifact wire
schema (`cde74be`), the typed occurrence exporter itself under
bundle-only delivery (`832f030`), an independent two-annotator pairing
oracle with adversarial review and owner adjudication (`f5e6ad5`,
`69ca117`), and the verdict run against it (`18f07c0`).

**One half of it was not built, and this ADR's first draft claimed
otherwise.** The precondition asks for the exporter *and* for "an
independent coverage manifest [that] pins the expected record ids, proof
ids, tags, and field identities". Measured: `corpus-manifest.json` entries
carry exactly `path`, `blob`, `bytes` — a *file* pin, not a record pin —
and the string `record_id` appears zero times in the manifest, zero times
in the oracle, and zero times in the lane artifact. The contract says so
itself: `measurement-contract.md` states the comparator checks agreement,
not completeness, and cannot see an anchor both sides omit. The
circularity ADR-0049 §6 warned about is therefore **still open**, and no
verdict on the exporter closes it.

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

**The mechanical part works, over a stated denominator.** All 5
`mispaired` rows differ on an OPTIONAL role only — `marketplace_sync` on
four, `squash` on one; the family registry declares both `required:
false`. Required-role pairing is perfect **across the 201 anchors both
sides bound** (197 agreeing, 4 mispaired on an optional role): wherever
both bound an anchor, the lane named the same physical occurrence for
every required role. That is precisely the class the oracle was built to
reach, the one every value-level check in this repository is blind to
because the values agree, and the exporter does not commit it. The
denominator matters and the first draft omitted it — perfection over the
mutually bound set says nothing about the 236 rows outside it.

**Most of the rest is interpretive, and a quarter of it is not.**
`missed` 60 plus `unexpected` 96 is 156 rows, and **none of the 156
differs on which occurrence fills a role** — `differing_roles` is empty
on every one. But they do not all mean the same thing, and the first
draft of this ADR said they did:

| what the 156 rows are | rows |
|---|---:|
| one side says **no claim exists**, the other says a claim does | **116** |
| both say a claim exists; the lane could not fill a required role (`bound` → `incomplete`) | **40** |

The 116 are the discriminator: a rule can locate the right occurrence, but
it cannot judge whether a sentence asserts a relation or merely mentions
one. The dominant single pattern inside them, 87 rows, is the lane
reporting a claim it could not complete where the oracle reports no claim
at all.

The 40 are **not** that. Both sides agree a claim is present; the exporter
did not produce a binding the contract requires. That is ordinary
extractor work, and it is what stops this ADR from concluding that
exporter effort is exhausted. Roughly three quarters of the gap is a
judgment no rule makes; roughly one quarter is a rule that could be
better.

So the precondition is not wrong; it is **incomplete and partly
unmet**. Its coverage half was never delivered. Its exporter half was
delivered and, in being run, revealed a third requirement neither half
states: a source of truth for claim-versus-mention that a renderer could
consult. Further exporter work can close the 40; nothing in the exporter
closes the 116. ADR-0049 §6 named the circularity correctly ("if
extractor and renderer omit the same field, the diff is empty and the
field is gone"); this measurement says where it bites, and the missing
coverage manifest is why it is still unguarded.

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
also cited outside it and **5 are cited by no tracked file other than a
store record** — 3 as `proofs[].run_id` values and 2 more appearing only
as tokens in record narrative, both `settings-` runs. Store-only citation
is 3 by structured field and 5 by any token.

**"Cited only by the store" is not "protected only by the store", and the
first draft conflated them.** The planner pins from four sources, and
every one of the five carries at least two:

| run id | pin sources |
|---|---|
| the 3 `doctor-` ids | tracked-doc + live-reader-selected + cross-artifact-reference |
| the 2 `settings-` ids | tracked-doc + cross-artifact-reference |

So withdrawing the store would unpin **none** of them, and the claim that
"the store pins the artifacts that make the store verifiable" does not
survive measurement. What survives is narrower and still worth stating:
the store is where those five are *cited*, and it is the only consumer
that then does anything with the artifact.

**A second measurement makes the whole pin argument moot today, and it is
a cost this ADR creates.** The scan is bounded at 1 MiB per tracked file
and fails closed on an oversized text source. Exactly one tracked file
exceeds that cap — the retained lane artifact, at 1,627,462 bytes — so a
live `planRetention` run reports `scan_complete: false` and authorizes
**zero** deletions across all three families. Control: re-running the scan
with only that file removed from the tracked-file list returns
`incomplete: []`. Retention is therefore not pinning selectively; it is
declining to act at all, and §Decision 6 is what put it in that state.

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

**3. "An empty store passes."** True in two distinct situations, only one
of which is a test affordance — and this ADR's first draft named only that
one. Measured against the live repository:

| case | findings |
|---|---|
| control — live store | 0 (19 records, 23 proofs verified) |
| injected empty, no floor supplied | 0 — **passes** |
| injected empty + the real 19-stem floor | 19 — fails, "record exists on the integration branch but is absent" |
| injected empty + `floor: null` | 1 — fails closed, "the integration base could not be read" |

A non-injected empty store derives its floor from git: measured with a
`PATH` shim counting invocations, a real empty store spends 2 git calls
(`rev-parse origin/main`, `ls-tree` of the records directory) establishing
the floor before it returns. So an empty **working tree** cannot pass
while the integration base still carries records.

**That is the correct scope, and the first draft overstated it as "only
through the injection seam".** The floor is derived from the *current*
integration base, not from history, so it does not preserve membership
once a deletion is itself part of that base: the cross-host review
demonstrated a full-history clone going 19 records / 0 findings → delete
records → 19 findings → advance the integration ref onto the deletion →
**0 records, 0 findings, `ran: true`**. The floor stops an unnoticed local
loss and a bad merge; it does not stop a deletion that lands on the
integration branch.

One stale artefact of the pre-floor design survives and is worth fixing
while this is in hand: `scripts/check-doc-evidence.mjs`'s comment above
`runAllChecks` still claims `checkStore` "returns before any git work
when there are no records". The two invocations above disprove it.

### The withdrawal trigger is dead by its own terms

ADR-0049 Consequences: "**withdrawal trigger: two consecutive release
loops in which the store is authored but the follow-up ADR has not been
opened.**"

**It was crossed at the second qualifying loop and the sequence ran to
nineteen.** The store holds 19 records, one per authored loop, and ADRs
0050–0057 are each a different subject, so no follow-up ADR existed at any
point in the run: 19 consecutive qualifying loops, 18 overlapping adjacent
pairs, against a threshold of 2. It is not "breached nineteen times over"
— an earlier phrasing here that the review corrected, and that the store's
own arithmetic contradicts.

The store recorded its own breach as it happened. The narrative of
`records/adr0051-p2-hardening-and-the-amended-stop-clause.json` restates
the trigger, counts it at the ninth record, and reports it met. That
narrative is **not** edited by this change: records are forward-only and
it was true when written, so what a retired trigger leaves behind in the
store stays as history. Supersession discipline applies to ADR text, not
to the record set.

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

`docs/assurance/evidence/measurement/` is about 4.5 MB, of which 4.25 MB
is JSON: the oracle and its two annotator sources, the lane
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
reviews in place turns the doc-evidence gate red with 24 findings.

The reverse direction is **not** silent, and the first draft said it was:
`tests/scripts/test-doc-evidence-consistency.mjs` asserts
`corpusBlobRefs > 0` with the message "a zero here means the exemption
stopped matching", so removing the reviews while keeping the manifest
fails that test rather than passing quietly. The coupling is real; the
characterisation of how it would surface was wrong.

Two limits on the exemption's safety, both found by the review and both
recorded rather than smoothed over. **Full-object types do not establish
prefix safety**: membership is tested by prefix *before* resolution, so a
real commit whose 7-character abbreviation matches a manifest blob's
prefix would be exempted and never checked — demonstrated in a
constructed repository. No such collision exists in this repository today,
which is a snapshot, not a property. And the substrate carries a
**production retention cost**: its lane artifact is the only tracked file
over the citation scanner's 1 MiB per-file cap, which fails the scan
closed and stops retention authorizing any deletion at all (§"Three claims
… corrected", item 1).

### What the cross-host review disproved

Recorded as a set, because a draft that quietly absorbed its corrections
would present measurement it did not do. The review reproduced the store,
proof, tag-coverage, sha-corpus, verdict and substrate figures
independently and agreed with them; these are the ones it broke.

| first draft claimed | measured |
|---|---|
| everything precondition 1 asks for was built | the coverage manifest was never built — entries pin `path`/`blob`/`bytes`, and `record_id` appears 0 times in the manifest, oracle and lane artifact |
| all 156 disagreements are about whether a claim exists | **116** are; the other **40** are `bound` → `incomplete`, where both sides see a claim and the exporter missed a required binding |
| required-role pairing is perfect | true, but over the **201** mutually bound anchors — a denominator the draft omitted |
| the five run ids are pinned only by the store | each carries 2–3 pin sources; withdrawing the store unpins **none** of them |
| an empty store passes only through the injection seam | also passes once the deletion reaches the integration base, because the floor reads the current base, not history |
| removing the annotator reviews widens the exemption silently | it fails `test-doc-evidence-consistency.mjs`'s `corpusBlobRefs > 0` assertion |
| the store never claimed to cover non-runtime packages | **12** non-runtime tags are cited, and one record carries no runtime release at all |
| the trigger was breached "19 times over" | crossed at the second qualifying loop, continuing to nineteen — 18 adjacent pairs |
| 0 of 77 blob ids is a commit object, so the exemption is safe | true for full objects, but membership is tested by prefix *before* resolution; a colliding abbreviation would be exempted. None exists here today |

Two further review findings changed the decision rather than a number:
the retention scan is fail-closed because of what §Decision 6 retains,
and tag coverage is a floor rather than a proof of loop authoring. Both
are carried above.

One review recommendation is **not adopted** — partial supersedure of
ADR-0049 Decision 6 — and §Decision 7 gives the reason: the review's own
coverage-manifest finding removes the premise the recommendation rested
on.

## Decision

**1. Rendering and the historical migration stay deferred, behind two
named blockers rather than one vague one.** Not "deferred pending more
spike work". The coverage manifest the acceptance criterion depends on
was never built, so the criterion is still circular; and of the 156
disagreeing rows out of 437, **116** are a claim-versus-mention judgment
no extractor produces. The remaining 40 are tractable extractor work and
are not a reason to defer — they are simply not enough on their own.
ADR-0049 Decision 5 (no rendering, no generated regions, the prose stays
hand-written) is unchanged and remains operative.

**2. ADR-0049 §Decision 6's precondition 1 is ADDED TO, not replaced.**
The first draft of this ADR replaced it, on the reading that everything it
asked for was built. That reading was false: the coverage manifest it
requires — pinning expected record ids, proof ids, tags and field
identities — does not exist, and no artifact in the substrate carries a
`record_id` at all. Precondition 1 therefore **stands, unmet in its
coverage half**, and gains a third clause the attempt to satisfy it
revealed:

> **Precondition 1 (a) — unchanged and still unmet.** An independent
> coverage manifest pinning the expected record ids, proof ids, tags and
> field identities, so that "extract → render → extract, empty diff" is
> not circular. What exists today pins files, blobs and byte counts.
>
> **Precondition 1 (b) — the exporter, partly answered.** A typed
> exporter emitting records with source locations. Built, and sound over
> the anchors both sides bind; 40 rows remain where the exporter did not
> supply a binding both sides agree is required. That residue is ordinary
> extractor work.
>
> **Precondition 1 (c) — new.** A resolution for the claim-versus-mention
> discriminator: either an adjudicated source of truth a renderer may
> consult for whether a given span asserts a relation, or a scope
> restriction to relation families in which the discriminator provably
> does not arise. 116 of the 156 disagreements are this, and no amount of
> (b) reaches them.
>
> Any future verdict on precondition 1 must state its own error bar or
> measure it. The `18f07c0` verdict rests on 156 rows where two
> annotators agreed and both self-reported `interpretive`, and that error
> rate is unmeasured.

Stated this way the deferral in ADR-0049 Decision 6 keeps its operative
condition — two preconditions, both required, neither yet met — and this
ADR adds precision rather than lowering the bar. The exporter, oracle and
comparator are not re-work for the next attempt; they are the substrate
it starts from.

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
> authored but the follow-up ADR has not been opened." Crossed at the
> second qualifying loop and continued to nineteen, and made permanently
> unfireable by this document.
>
> **Replacement — a minimum tag-coverage policy, not a proof of loop
> authoring.** Two consecutive `plugin-runtime` release tags, within the
> store era, that appear in no record's `package_releases[]`.

**Its evaluation contract, because a predicate that cannot be re-run is
not a trigger.** The *store era* begins at the earliest tag cited by any
record — today `plugin-runtime-v0.86.3` — and the boundary is inclusive.
The population is tags that exist in `refs/tags/` at evaluation time and
whose creation date is at or after that anchor. *Consecutive* is over that
population ordered by tag creation date. Evaluation is read-only and does
not gate CI.

Two properties earn it. It is **derived-only** — tags come from
`refs/tags/` and `package_releases[].tag` is a derived field — so it is
decidable without touching the authored membership judgment ADR-0049
Amendment item 4 protects. And it **cannot be retired by writing a
document**; only authoring records clears it.

**What it does not do, stated because the first draft implied otherwise.**
Tag coverage is a proxy for loop authoring, and the review demonstrated
the gap: consolidating every release into a single existing record and
deleting every proof leaves 19 records, 0 findings, **0 verified proofs**,
and 19 covered runtime tags — the trigger stays clean while the store
loses exactly the historical verification Decision 4 retains it for. This
is a floor, not an assurance. Three further residuals: a deleted or
retargeted *uncovered* tag leaves the counted population without any
record being authored (a covered tag cannot, because the store validator
already fails on it); a package rename or a release-please component
change would stop new tags entering the population, and a future evaluator
should resolve the prefix from the release configuration at the tag, which
`expectedTag` already reads, rather than from a literal; and the era
anchor is stable only because the forward-only floor stops the record
carrying it from being removed locally — Decision 4 and Decision 5 hold
each other up, and neither survives a deletion that reaches the
integration branch.

**Runtime-only is a policy choice, and the historical justification the
first draft gave for it is false.** The store does cover other packages:
12 non-runtime tags are cited, and one record —
`persona-host-claim-correction.json` — carries engineer, founder and
designer releases and **no runtime release at all**. The boundary is
chosen, not inherited: `plugin-runtime` is the package whose release loop
the store's authoring cadence tracks, and the 15 uncovered non-runtime
tags in the era are outside the trigger because monitoring them would fire
it on the day it is written without describing a lapse in that cadence.
Measured at authoring: 19 `plugin-runtime` tags in the era, **0
uncovered**, longest consecutive uncovered streak 0.

Two adjacent failure modes deliberately get **no** trigger, and the
reasons are recorded so a later reader does not read the omission as an
oversight. *The store is authored but never catches anything* is not
discriminable — a gate that finds nothing looks identical to a working
one. *Rendering stays blocked indefinitely* is no longer a withdrawal
condition, because Decision 4 above removes the contingency it rested on; it is
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
(24 exemptions measured above); and precondition 1 (a) and (c) start from
them rather than from nothing.

**Retention is the price, it is being paid now, and it is not left
implicit.** The retained lane artifact is the only tracked file over the
citation scanner's 1 MiB per-file cap, so `scan_complete` is `false` and
retention authorizes no deletions in any family. Retaining the substrate
therefore costs an operating capability, not just disk. The disposition
is: **accept it for now and fix it in the scanner or the artifact, not by
deleting evidence.** Three routes exist and none is decided here —
chunking or compressing the artifact below the cap, teaching the scanner
to stream a file larger than the cap instead of failing it closed, or
declaring the measurement tree a non-citation source with an explicit
exclusion. The first two keep the fail-closed property that makes the
scanner trustworthy; the third trades it for a scoped exception and is the
one that needs the most care. Whichever is taken, it is a runtime change
with its own review, and it should not wait long: a retention planner that
can never act is a gate that has quietly stopped running.

Three further consequences follow, and are the operative part of this
decision:

- **The lane exporter is retained as evidence, not promoted.**
  `docs/assurance/evidence/measurement/lanes/s1-typed-exporter/exporter.mjs`
  is the artifact of a `fail`. It must not be used to seed a store, back
  a renderer, or be read as a sanctioned extractor. It is committed so
  the verdict can be re-run against it.
- **Piecemeal deletion is prohibited.** The manifest and the annotator
  reviews are coupled through the gate exemption in a measured
  direction: dropping the manifest alone produces 24 findings; dropping
  the reviews alone fails
  `tests/scripts/test-doc-evidence-consistency.mjs`'s `corpusBlobRefs > 0`
  assertion. Any future removal removes the substrate, the gate's
  exemption path and that assertion in one commit, with the sha check
  re-measured in that commit.
- **The prohibition is prose, and that is a known weakness.** Nothing
  today asserts that the retained unit is intact — the seal covers the
  bundle, the sha gate covers the exemption, and no check covers "all
  annotator sources, briefs and verdicts are still here together". A gate
  that pinned the retained inventory and its digests would close it. It is
  named here rather than built, because this ADR ships no code.

**7. ADR-0049 is amended, not superseded — and the review's argument for
partial supersedure is answered by its own strongest finding.** The
cross-host review argued that Decision 6's operative condition changes
here: it gates the follow-up ADR on two preconditions, and a draft that
replaced one of them while declaring itself that follow-up would leave a
reader on ADR-0049 needing another document for the operative rule. On
that draft the argument was correct.

It does not survive the correction the same review forced. Precondition 1
is **not** replaced — its coverage clause stands, unmet, because the
review measured that the coverage manifest was never built. Decision 6's
operative condition is therefore unchanged: two preconditions, both
required, neither met, and the renderer/migration ADR still unwritten —
which this document explicitly declines to be. What lands here is added
precision inside a precondition and, in Consequences, a withdrawn premise
and a replaced trigger. That is the Amendment side of `README.md`
§"Amendments vs Supersedes", on the same reading ADR-0049's own
2026-07-27 Amendment used when it corrected a Context table a Decision
points at — and unlike that occasion, the reader is not sent elsewhere
for an operative rule, because ADR-0049's Amendment carries precondition
1 (a)/(b)/(c) in full.

Every other Decision section stays operatively accurate: the store is
still forward-only and keyed by evidence loop, provenance is still
declared per field, relations are still typed and plural, and gates still
validate only what their source can back.

## Consequences

**Positive.** The two preconditions stop being an open question of
unknown size: one is met, the other resolves into three clauses of which
one is unbuilt, one is partly answered, and one is a judgment no rule
makes. The withdrawal trigger becomes something that can actually fire,
keyed to authorship rather than to the existence of a document, published
with the measurement that shows it clean at 0 of 19 and with the
consolidation control that shows what it does not catch. Three claims
behind the retention decision are corrected in the record, and nine more
this ADR's own first draft made are corrected against the review that
disproved them. The measurement substrate acquires a stated disposition,
a stated coupling to a production gate, and — new to this revision — a
named production cost that was being paid unnoticed.

**Negative.** The duplication ADR-0049 identified as the root cause is
still not reduced, and this ADR does not reduce it — the five prose sites
remain hand-written and the store remains a sixth copy. The recurring
post-release recovery PR is not eliminated. Precondition 1 is now
demonstrably harder than it was believed to be: its coverage half was
never built, and its new (c) clause asks for an adjudicated judgment
source that the honest reading of `18f07c0` suggests may never be
satisfiable for the full relation set — in which case rendering is
permanently limited to the scope-restricted half. About 4.5 MB of
committed evidence is retained for a precondition that returned `fail`, 13
of its markdown files sit permanently in the discovered sha corpus, and
**one of its files currently disables retention's ability to authorize any
deletion**. That last cost is accepted on a stated intention to fix it,
which is a debt this decision creates rather than discharges.

**Neutral.** The store's justification changes shape without changing its
behaviour: no schema change, no validator change, no record rewrite, and
no consumer of any document changes. The scorecard evidence design gains
an independent schedule it did not have while it was described as a
migration precondition.

## Alternatives Considered

**Adopt rendering now.** Not available, and now for two independent
reasons rather than one. Precondition 1's coverage half was never built,
so the acceptance criterion is still circular by ADR-0049 §6's own
argument; and its exporter half returned `fail` on a residue that is
mostly not tooling — a renderer built on the current extractor would
inherit
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
  pointer, covering the precondition clauses and the trigger replacement.
  Its `README.md` index row also ends with the retired trigger and must be
  corrected in the same change — an ADR's summary lives in two places, and
  correcting one leaves the other standing.
- Two documents pin ADR-0049 to a single amendment date and are corrected
  here: `AGENTS.md` §Release process and
  `docs/assurance/evidence/README.md`. A third,
  `docs/assurance/evidence/schema/evidence-record-1.0.json`, is left alone
  deliberately — its pointer reads "Decision 1-4, as amended 2026-07-27",
  and Decisions 1–4 are among what the new Amendment leaves unchanged.
- **The retention scan must be unblocked.** Whichever route §Decision 6
  names is taken, it is a runtime change with its own review and should
  be opened promptly: today `planRetention` reports `scan_complete: false`
  and authorizes no deletions in any family.
- `scripts/check-doc-evidence.mjs`'s stale comment above `runAllChecks`
  ("`checkStore` returns before any git work when there are no records")
  is corrected: the forward-only floor spends two git invocations before
  the empty-store return. It is left to a code PR rather than done here,
  because this change set is decision-only.
- A gate asserting the retained substrate inventory and its digests would
  turn §Decision 6's "moves as a unit" from prose into a check. Named,
  not built, for the same reason.
- The replacement trigger is stated in prose and is not gated. Making it
  a check is possible — it reads only tags and a derived field — and is
  deliberately not required here, because a trigger whose whole purpose
  is to prompt an owner decision does not need to fail a build to work.
