# Precondition-1 verdict — lane S1 against the pairing oracle

- **Verdict**: `fail` — missed on required relation `proof-date-binding` (§8.3 row 4)
- **Oracle**: `oracle-adjudicated-1`, artifact digest `09071db747185819e7d2f09e8409495cdca4d35c2fb27a1fed569d4a3da97d63`
- **Lane**: `lane-s1-markdown-lexical-grammar-v1`, artifact digest `e01c0040bb09ffd3e506ca68e86b581dba5696368907de5fea85c003d725b00f`
- **Bundle** `c7e68f04…` · **manifest** `b2f1433a…` · **corpus pin** `d49f74e` · **contract** 2.2.0

**`fail` is a successful critique result.** §8.4 states it plainly — "`fail` is a
successful comparison; a comparator that reports a defect as a tool error has
lost the result" — and this document reports it as an outcome, not as a failure
to run.

**No repair was made.** §11.5 prohibits repairing either side during comparison,
because doing so converts an independent measurement into a fitting exercise.
Every item below is a finding. Neither the oracle nor the lane artifact was
edited after the comparison was run.

## Reproducing it

```
node scripts/evidence-measurement.mjs compare \
  --artifact docs/assurance/evidence/measurement/oracle/oracle.json \
  --artifact docs/assurance/evidence/measurement/lanes/s1-typed-exporter/artifact.json \
  --baseline docs/assurance/evidence/measurement/authority-baseline.json --json
```

`--baseline` is not optional. §9 requires **two** authority snapshots — a
baseline captured when the corpus was pinned and a run snapshot captured at
comparison time — because a single snapshot records current authority and
cannot detect that it moved. Omitting it does not produce a drift-free run; it
produces `not-comparable`, and a first attempt here omitted it and leaked 20
authority-derived fields to `unresolved` before that was noticed.

## The harness-ownership question, resolved

The plan flagged this as unresolved: "'run S1 against S2' hides an unowned
implementation — structural validation, span pairing, relation comparison,
authority evaluation, reducer execution and report serialisation — and no
earlier subtask owns it. Decide before dispatching S3 whether that harness
belongs to S0, S1, or here."

**It belongs to S0, and S0 already delivered it.** The record decides this
rather than a preference:

- `scripts/evidence-measurement.mjs` — the file containing `compare`,
  `reduce`, `validateArtifact`, `buildAuthoritySnapshot`, `authorityDrift` and
  `verifySeal` — was added whole in `d7cdcba`, which is S0's commit (PR #762).
- S0's own scope required it in as many words: "make the correctness
  predicates normative and executable (the draft ships neither comparator nor
  reducer); supply the authority-snapshot artifact and its builder".

The flag was true when written and was answered by S0's scope in the same
series. S3 therefore owns running the harness and reporting the result, not
building it. No harness code was written here.

## The comparator refuses rather than rebases

The plan requires that a mismatched baseline be refused rather than silently
rebased if a release or recovery lands mid-flight. Verified by mutation against
the real artifacts, each expecting `not-comparable`, with a control that must
NOT be `not-comparable`:

| Case | Result |
|---|---|
| control — unmutated run | `fail` (so the refusals below are not "always refuse") |
| oracle declares a bundle digest the seal does not carry | `not-comparable` — §8.2 / §11.3 |
| lane declares a different bundle digest from the oracle | `not-comparable` — §8.2 / §11.3 |
| oracle declares a manifest digest that is not the pinned one | `not-comparable` — §2.1 |
| only one authority snapshot supplied | `not-comparable` — §9 `baseline-absent` |
| a baseline tag retargeted to another object | `not-comparable` — §9 `tag-retargeted` |
| oracle declares contract 2.1.0 against a 2.2.0 tree | `not-comparable` — §10.1 |

## Every category the plan enumerates

| Category | Measured |
|---|---|
| candidate schema validity | 0 structural errors |
| duplicated or missing anchor rows | 0 (structural; §4.3 makes a missing row structural, not a silent pass) |
| invalid spans | 0 containment findings, 0 quote findings |
| wrong values | 0 — reported through containment, which compares literals and every registry-declared field |
| **wrong pairings whose values agree** | **5 `mispaired`** |
| false positives | 96 `unexpected` |
| missed claims | 60 `missed` |
| ambiguous mappings | 16 `not-adjudicated` (oracle declined) + 20 `unresolved` (lane declined) |
| policy declaration mismatch | 2 findings, keys `class`, `parameters`, `ranking` |

**The zeros are measurements, not silence.** All 813 oracle occurrence
identities are present in the lane's 3416, and 1395 declared field values were
actually compared across them, so `containment: 0` reports agreement over a
populated set rather than an empty one. `authority_fields` resolved 1050 values
against the snapshot with 0 unresolved.

`drift.drifted` is `false` with one `head_advanced` note. §9 is explicit that
growth is not drift — a new commit on the integration branch moves no authority
a comparison consulted, and treating it as drift would make every comparison
`not-comparable` within hours of any pin.

`artifact_only.scope` is `out-of-scope`, so §8.3 rows 6 and 9 do not apply. That
is contract 2.2.0's fix working: under 2.1.0 a clean-room run could never report
an artifact present, row 9 always fired, and `pass` was unreachable in
principle.

## Row statuses

```
agreeing        240   (54.9%)
missed           60
unexpected       96
mispaired         5
unresolved       20
not-adjudicated  16
                437
```

`proof-date-binding` — agreeing 146, unexpected 87, missed 40, not-adjudicated 15, unresolved 4
`release-triple` — agreeing 94, missed 20, unexpected 9, unresolved 16, mispaired 5, not-adjudicated 1

## Finding 1 — pairing itself is clean

All 5 `mispaired` rows differ on an OPTIONAL role only — `marketplace_sync` on
four, `squash` on one. **Required-role pairing is perfect**: wherever both sides
bound an anchor, the lane named the same physical occurrence for every required
role.

This is the class §4.4 built the oracle to reach — "every value-level check in
this repository is blind to it, because the values agree" — and the lane does
not commit it.

## Finding 2 — every real disagreement is about whether a claim exists

`missed` 60 plus `unexpected` 96 is 156 rows, and not one of them is a
disagreement about which occurrence fills a role.

```
78  oracle not-a-claim → lane incomplete    proof-date-binding
26  oracle bound       → lane incomplete    proof-date-binding
14  oracle bound       → lane incomplete    release-triple
13  oracle bound       → lane not-a-claim   proof-date-binding
 9  oracle not-a-claim → lane bound         proof-date-binding
 9  oracle not-a-claim → lane incomplete    release-triple
 5  oracle bound       → lane not-a-claim   release-triple
 2  oracle incomplete  → lane not-a-claim
```

The dominant pattern, 87 rows, is the lane saying "a claim whose role I could
not fill" where the oracle says "no claim at all". That is the
claim-versus-mention discriminator the association decision named as the thing
no rule has: a rule can locate the right occurrence and cannot judge whether a
sentence asserts a relation or merely mentions one.

The policy-mismatch findings are the diagnostic §7.4 designed them to be. The
oracle declares `class: annotation` and the lane a rule with named parameters,
so the declarations differ by construction; §7.4 says such a finding "never
changes a row's status, and — with an oracle present — never changes the
verdict". It is what says whether a row disagreement is explained by a declared
difference, and here it says the disagreement is exactly the declared one.

## What this verdict rests on, stated rather than assumed

The oracle's own error bar is **not measured**. 156 rows on which both
independent annotators agreed and both self-reported `interpretive` remain a
correlated-error zone; the adversarial pass did not reduce it (144 to 156). This
verdict is sound conditional on those rows being right, and nothing here
establishes that they are. A sampled owner review that declares a measured error
rate was proposed and has not been run.

A further 36 rows (8.2%) are scored by neither side — 16 where the oracle
declined and 20 where the lane did.

The comparison covers only what both artifacts enumerate. §4.4 records the
residual hole precisely: an anchor that both the oracle and every lane miss is
invisible to this comparison, and closing it needs an independent enumerator,
which is a contract-version change with an owner rather than a quiet
improvement.
