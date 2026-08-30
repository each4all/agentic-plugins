# Association policy — the decision, and why the rule is not the contract's job

**Status**: Accepted 2026-08-31 (owner-ratified).
**Scope**: subtask S0B of the ADR-0049 follow-up track. This decides what the
evidence measurement contract fixes about ASSOCIATION — how one occurrence is
bound to another to form a relation — before any contract text is written.

**This document is rationale-class, not contract-class.** It contains readings of
the frozen corpus. The two measurement lanes the contract governs must not
consume it, for the same reason the contract itself forbids corpus fingerprints
in normative text: two lanes that share a reading of the corpus are not
independent. Its numbers are produced by `scripts/measure-association-policy.mjs`
and pinned by `tests/scripts/test-measure-association-policy.mjs`, so they can be
re-derived rather than trusted.

---

## The decision

The contract **stops trying to fix the association rule**. It fixes instead:

1. **The relation schema and anchor domains** — what a relation is, which
   occurrence is its anchor, and which population of anchors is in scope.
2. **A total disposition per in-scope anchor** — every anchor gets exactly one of
   `bound`, `not-a-claim`, `ambiguous`, `incomplete`. **No row is a structural
   coverage failure**, not a silent pass.
3. **An independently authored span-level pairing oracle** as the correctness
   authority, keyed by physical occurrence identity — path, blob, start byte, end
   byte — never by value.
4. **A required policy declaration from each lane**, with a policy mismatch
   surfaced as a first-class finding rather than as scattered row noise.

Each lane then implements whatever extraction policy it likes — the incumbent
hybrid, a construction grammar, anything else — and is judged against the oracle.
Construction grammars are **demoted from contract to lane policy**.

Comparison semantics that follow: oracle `bound` against lane `not-a-claim` is
`missed`; the reverse is `unexpected`; a policy mismatch without an oracle is
`not-comparable`.

## Why not a better rule

The same clause was attempted three times and was wrong three times, always
because the rule was chosen inside an implementation change with no decision
step:

| Attempt | Rule | Outcome |
|---|---|---|
| 1 | character-distance window | width provably changes which claims are found |
| 2 | smallest enclosing markdown block | that block is a 34,000-byte table cell; 32/33 and 87/87 anchors ambiguous, every verdict pinned at `blocked` |
| 3 | minimal binding span | 0 ambiguous, but 76% of associations false (66 of 87) |

Attempt 3 shipped because its measurement checked the symptom being fixed —
ambiguity — rather than the property required. The measurements below say why a
fourth rule would not have helped either.

### The value oracle cannot certify any rule, and cannot in principle

A run id encodes its own date, so a date binding looks falsifiable without
hand-labelling. Measured, that oracle ranks materially different rules
identically:

```
incumbent 7 patterns, doctor only ............ 94 bound, 0 disagreeing
same patterns, all kinds + `ID on DATE` ..... 107 bound, 0 disagreeing
```

It cannot do better, because **values repeat**: 292 run-id occurrences carry 88
distinct values, and 95 runtime-tag occurrences carry 35 distinct tags — roughly
threefold. Two lanes agreeing on a *value* have therefore not agreed on an
*occurrence*, and a binding that attached the right value to the wrong occurrence
is invisible to every value-level check.

### Distance does not separate claims from mentions

An earlier draft of this decision reported a clean separating threshold — zero
false pairings up to width 40, first false at 80 — and concluded that
`AGENTS.md`'s record ("agreeing and disagreeing distances interleave and no
threshold separates them") did not reproduce. **That was wrong, and the error was
in the measuring instrument.** The gap was expressed as `[^.;]{0,N}`, which
forbids a period *inside* the gap; in these documents that silently excluded
every candidate pair spanning a version number such as `0.97.0` — which is where
the wrong pairings live. Re-measured with clause segmentation and an edge gap,
and independently reproduced by a second lane:

```
width  10 -> 111 bound,  0 disagreeing
width  20 -> 117 bound,  0 disagreeing
width  40 -> 125 bound,  1 disagreeing   (first false pairing at gap 38)
width  80 -> 134 bound,  3 disagreeing
width 160 -> 141 bound,  6 disagreeing
width 320 -> 154 bound,  9 disagreeing
```

`bound` keeps rising after `disagreeing` becomes non-zero. Genuine bindings and
false ones are interleaved along the distance axis, so **no width admits every
claim and excludes every mention**. `AGENTS.md`'s record stands.

### A lexical rule has a ceiling on this corpus

Of 124 date-binding pairs, **63 (51%) are joined by punctuation alone** — `ID
(DATE`, `DATE (ID` — with no lexical marker to name. The incumbent's seven
"constructions" are already a mix of lexical and punctuational patterns rather
than a lexical set, and even so they leave 13 `ID on DATE` occurrences unmatched:
a wrong date planted there is invisible, while the same date planted in a
recognised form yields exactly one finding.

The connector inventory is 20 distinct forms over those 124 pairs, with a head of
four covering 82% and a long tail. Inspected, the tail is **not** noise — the
bindings a looser rule adds are genuine date claims in varied prose. So an
enumerated grammar must keep growing to stay complete, which is a treadmill
rather than a convergence.

### Ranking is routine, not an edge case

Of 209 clauses holding an anchor, 88 hold exactly one id and one date; 31 (15%)
hold more than one candidate for a role. Any positional rule must **rank** in
those, and ranking is the dimension that produced a false result in this
repository before.

### The relations are not alike

The release relation's prose is far more diffuse — 72 distinct two-word prefixes
introduce 123 tag occurrences, against the date relation's 20 connector forms —
and its roles are ambiguous by family: `squash` and `marketplace_sync` are both
`commit-citation`, and 98 resolved release spans contain exactly one sha. A
single normative rule for both was never going to fit; per-relation *policies*
under one shared meta-contract are what the shape actually supports.

### The anchor population is wider than every rule that was proposed

The family registry admits eight run kinds — doctor 174, settings 73, compat 30,
bootstrap 8, audit 2, review 2, consensus 2, cutover 1 — while every candidate
rule reasoned about `doctor` alone. Any "coverage" figure computed as
`population − matches` therefore mixes an all-kind population with a doctor-only
extractor, which is why no such remainder is quoted here as a `not-a-claim`
count.

## Consequences

- **S0** writes the contract to this shape: schema, anchor domains, total
  dispositions, oracle identity, comparator semantics, and the policy-declaration
  requirement. It does not name a normative association rule.
- **S2** becomes a span-level **pairing oracle** rather than the field-coverage
  manifest its original topic described. Its rows key on physical occurrence
  identity and carry an explicit disposition for every in-scope anchor.
- **S3** compares a lane's output against that oracle, and reports a policy
  mismatch as a first-class finding.
- **S1** is unchanged in kind, and gains an obligation: it must declare its
  extraction policy alongside its output.

Convergence, for a frozen corpus, means every anchor has an oracle disposition,
every positive relation names exact role spans, every construction carries
positive and adversarial-negative controls, and the corpus, oracle and policy
digests are frozen together. New bytes require a new version. **This grammar is
not claimed to generalise to future prose**; for that, structured evidence
authoring is the durable cure, and that question is out of scope here.

## Rejected

- **A normative construction grammar per relation.** Necessary as a lane
  extraction policy, insufficient as the contract's correctness authority: it
  defines truth as whatever syntax the parser knows, has no stopping point on
  this corpus, and cannot express the 51% of claims joined by punctuation.
- **Lane-declared policies alone.** Exposes the dimension that caused all three
  failures, but cannot say which policy is right — two lanes declaring the same
  wrong policy agree perfectly. Adopted as a diagnostic beside the oracle, not
  as the mechanism.
- **A tuned proximity rule.** Falsified above: the distances interleave.

## Reproducing the numbers

```
node scripts/measure-association-policy.mjs
node --test tests/scripts/test-measure-association-policy.mjs
```

The harness reads the pinned corpus commit rather than the checkout, and the
tests pin both the readings and the properties this decision draws from them —
separately, because a future edit could preserve one while destroying the other.
