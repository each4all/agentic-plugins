# The evidence measurement contract

Contract version: **2.0.0**

This document fixes the semantics that a **typed occurrence exporter** and an
**independently authored span-level pairing oracle** must share in order to be
compared. With the two machine-readable files it names — the corpus manifest
and the family registry — it is the only thing they may share, and the three
are sealed together as one bundle (§11.3).

It names **no expected value**: no commit, tag, run id, record id, or count
that either side should produce. §1.2 states the test, and why the corpus pin
is not an exception to it.

**It also names no association rule.** Which occurrence binds to which is the
single question this contract deliberately does not answer; §4.2 says why, and
what it fixes instead. That is the change from version 1.x, and it is a
breaking one: the clauses that fixed a minimal binding span, a candidate
ranking, and a tie policy are gone rather than amended.

Status: accepted. The decision it implements is
`association-policy.md` in this directory, ratified at squash `8ebbe48`. That
document is **rationale-class** and is not an input to either lane (§2.3).

---

## 1. What belongs in this contract

### 1.1 The inclusion rule

A candidate semantic dimension belongs here **if and only if all three hold**:

1. Two authors working independently from the same frozen documents could
   reasonably choose differently; **and**
2. that difference could change pairing, multiplicity, comparison status,
   comparability, or the final verdict; **and**
3. it can be stated as an implementation-neutral observable, equivalence rule,
   or policy — without naming an expected value and without prescribing how
   either side discovers anything.

If 1 and 2 hold but 3 does not, the dimension is left **authored**,
**ambiguous**, or **unresolved**, and the comparator surfaces or blocks on it
rather than inferring an answer.

Association satisfies 1 and 2 and was assumed to satisfy 3. It does not, and
the assumption is what three superseded revisions of this clause got wrong.
§4.2 records the resolution: association is moved out of the contract and into
each lane, and the contract fixes an authority that can adjudicate it instead.

The rule exists so a later author can add a dimension without reopening the
decision that produced this document. A list can only be trusted; a rule can be
checked.

### 1.2 What may be shared, and what may not

The distinction is about the **origin** of a datum, not its effect:

- **Protocol and input parameters** — facts that hold independently of what
  this corpus contains — are shareable, and most of them must be shared or the
  two lanes are not measuring the same thing. Coordinate conventions, family
  recognition rules, the status vocabulary, and the identity of the corpus all
  sit here.
- **Corpus-derived facts** — anything learned by inspecting this corpus's
  expected outputs — are not shareable. Counts, frequencies, ratios, extremes,
  which shapes actually occur and which do not: each of these narrows what a
  correct artifact must look like without either lane having done the work.

An earlier draft used a different test — "would publishing it make a wrong
artifact look right" — and it was wrong in both directions. It forbids sharing
the coordinate convention, since publishing that does correct an exporter using
the wrong one; and it permits aggregate corpus fingerprints, since no single
aggregate makes any one artifact correct while all of them together guide
fitting.

The corpus pin is shareable under this test: an object name identifies *which
bytes* are measured and reports nothing about what is in them.

**Family recognition rules are shareable; association constructions are not.**
The two look alike and are not. A family's recognition rule states the lexical
shape of one datum, and both lanes must apply the same one or they are
enumerating different populations before they disagree about anything real. An
association construction states which *joining shapes actually occur between*
data in this corpus — that is a reading of the corpus, and publishing it hands
both lanes the same partial answer. This is the contradiction version 1.1
carried: §1.2 forbade sharing which lexical shapes occur while §4.2 prescribed a
binding rule and §13 declared grammars not free. It is resolved in one
direction — the constructions are lane-private extraction policy (§4.2), and
each lane declares the policy it implemented rather than receiving one (§4.5).

### 1.3 Three dispositions

Every dimension ends in one of:

- **Fixed** — stated normatively below or in the family registry.
- **Free** — deliberately unconstrained (§13), with the consequence named.
- **Stated but unexercised** — the clause is written, the frozen corpus does not
  exercise it, and it is listed in §12.

Fixed/free and exercised/unexercised are different axes: the third disposition
is the *intersection* — a Fixed clause with no instance in the corpus — not a
third alternative to the first two. A Free dimension is never listed in §12,
because there is no clause to be unexercised.

---

## 2. The corpus

### 2.1 The pin is a manifest

The corpus is `corpus-manifest.json` in this directory, produced and checked by
`scripts/evidence-corpus.mjs`.

The manifest is **normative for membership**, not only integrity. A commit alone
does not say which files are measured, and this repository contains more than
one answer to that question (§2.2). The manifest lists the files, so "the
corpus" is a set.

**Membership is enforced, not assumed.** An occurrence naming a path the pinned
profile does not contain, or a blob the manifest does not record for that path,
is a structural error (§8.2). Without that check an artifact could measure a
file outside the corpus, compare cleanly against an oracle that made the same
excursion, and pass — the manifest would be normative in prose and decorative
in practice.

The manifest is built from the **commit's tree**, never a working tree or index,
and its `commit` must be a full object name. A symbolic ref re-resolves on every
run, so it names a moving corpus while claiming to have frozen one; the verifier
rejects it.

Content digests live only in the manifest, which is JSON. They are kept out of
this document because a content digest is indistinguishable in prose from a
commit citation, and this repository's commit-citation gate reads every markdown
file under `docs/` and at the repository root.

**The manifest digest**, which §8.2, §10.1 and §11.3 all require both artifacts to
declare, is the manifest's own `digest` field: the SHA-256, in lowercase hex, of
the manifest serialised with its `digest` key removed, its object keys in
lexicographic order, two-space indentation, and a trailing newline. Both the
algorithm and the serialisation are fixed here because neither is derivable: an
earlier revision made the digest normative in three places while defining it
nowhere and producing it nowhere, so two authors would have picked different
values — the manifest blob id, a hash of the file bytes, a hash of a
re-serialisation — and every comparison would have ended `not-comparable` before
measuring anything. `scripts/evidence-corpus.mjs` computes and verifies it.

### 2.2 Two profiles, not interchangeable

| Profile | Membership | Scope |
|---|---|---|
| `stage-docs` | enumerated | The stage documents that make release and current-proof claims. |
| `discovered-md` | discovered | Every tracked markdown file at the repository root or under `docs/`, excluding generated changelogs. |

Both are pinned. Profile binding is declared by the family registry (§3.4,
§4.1) and is **not uniform across the two units**:

- A **family** is bound to **one or more** profiles. Most data occurs in both,
  and a family recognisable in both must say so or one lane will look for it
  where the other does not.
- A **relation** is bound to **exactly one** profile, and every role's family
  must be bound to that profile (§4.1).

Version 1.1 stated here that "every family and relation is bound to exactly one
profile" while citing §3.4, which said the opposite for families. The two
readings put a family's occurrences in different populations, which is a
disagreement about membership before either lane compares a value. The rule
above is the single statement of it; §3.4 and §4.1 apply it to each unit and
add no third version, and `scripts/check-family-registry.mjs` enforces both
halves.

### 2.3 What is not corpus

- **Evidence records** (`docs/assurance/evidence/records/`) are not measured
  prose input and are not an authority for either lane. Their array membership
  is authored (§6.3), so they cannot establish coverage. They may be compared
  afterwards as a separate projection, outside this contract.
- **Run artifacts** under `.agentic-plugins/runs/` are not corpus. They are
  untracked, so a measurement that read them would return different answers on
  different machines. Fields that depend on them carry the `artifact-only`
  qualifier (§7.5) and are governed by §8.3's artifact rows.
- **`association-policy.md` in this directory, and its harness
  `scripts/measure-association-policy.mjs` with the test that pins it, are
  rationale-class.** They contain readings of the frozen corpus — connector
  inventories, distance sweeps, repetition ratios — and are therefore not
  inputs to either lane under §1.2 and §11.2. They are not in the sealed bundle
  (§11.3), and a lane that consulted them must record that under §11.4.

---

## 3. Occurrences

### 3.1 The unit is a source occurrence

The primary unit is one **occurrence**: a contiguous region of one corpus file
carrying one datum of one family. A claim assembled from several occurrences is
a **relation** (§4) that *references* occurrences; a relation is never itself an
occurrence.

Incumbent tooling in this repository counts a partially-assembled claim as
covered. This contract does not: an incomplete relation is a disposition of its
own (§4.3), and the occurrences it does name are still individually resolvable.

### 3.2 Physical identity

An occurrence's **physical identity** is exactly:

```
(path, blob, start_byte, end_byte)
```

- Spans are **half-open UTF-8 byte ranges over the exact blob bytes**.
- `path` is part of the key. Without it, identity is corpus-global.
- **Value is never part of identity.** Two identical lexemes at different spans
  are two occurrences, always.
- **Family and type are not part of the key either** (§3.3).
- **Profile is not part of the key**, and this is a correction. Version 1.1 and
  an earlier 2.0.0 draft included it, arguing that identity would otherwise be
  corpus-global — which `path` already prevents. The profiles of §2.2 are not
  disjoint: a document can belong to both, and then every occurrence in it held
  two identities, so an oracle row anchored under one profile and a lane row
  under the other never paired and the same bytes counted twice. The ratified
  decision names four components; these are those four. Profile remains a
  compared field (§3.3) and a membership constraint (§2.1), not a key.

Two occurrences of the *same* family may not share a physical identity. Two
occurrences of *different* families may — see §3.3.

This is the key the oracle uses (§4.4), and the reason it does. Values in this
corpus repeat, so agreeing on a value is not agreeing on an occurrence: a
binding that attached the right value to the wrong occurrence is invisible to
every value-level check. Identity is physical or it is not identity.

### 3.3 Family, type and canonical value are compared, not keyed

Semantic family, type, and canonical value are **compared fields**. If family
were part of the key, one family disagreement would surface as one `missed` plus
one `unexpected` — two findings for one difference, on opposite sides of the
ledger, with nothing linking them.

Because families are compared rather than keyed, two families may claim the same
extent. The comparator pairs on physical identity first and reports the family
disagreement on that single row. Its occurrence index is therefore keyed by
identity **and** family: keyed by identity alone, the second of two same-extent
occurrences overwrote the first, and the result depended on the order of an
array this contract never ordered.

**"Compared" means every field the registry declares**, not family and literal
alone. A registry that declares `package`, `version`, `kind` or `shape` and a
comparator that ignores them is a contract asserting a check nobody runs: two
artifacts disagreeing on a version would agree on everything compared.
Authority-derived fields are the exception, and only because §5 resolves them
instead.

### 3.4 Families are declared, not described

The family set is fixed by `family-registry.json` in this directory. For each
family it declares an id, its unit, the **profiles** it is bound to (§2.2), a
**recognition rule stated as a lexical observable**, its fields with their
permitted states, its cardinality, and whether it is **required** (§8.1).

The registry is machine-checked by `scripts/check-family-registry.mjs`, wired as
`npm run validate:family-registry`. Without that check every defect in it ships
silently, and §8.2 makes an occurrence whose family is not in the registry a
structural error, so one registry typo turns a whole comparison
`not-comparable`.

Two rules govern the family entries:

- A recognition rule states what the datum **is in the document** — its lexical
  shape — never what it means and never how to search for it. A family defined
  by concept rather than shape puts one author's occurrences where the other has
  none, because one concept can have more than one lexical shape.
- A family that is recognisable but which a profile never carries must be
  declared in `expected_zero`. **An undeclared expected-zero is
  indistinguishable from an omission**, so an undeclared zero is a finding.

Adding a family is a contract-version change (§10.1).

### 3.5 Normalisation may not escape

An implementation may normalise text internally — flattening hard wraps,
stripping block prefixes, normalising line endings — **only** while maintaining
a complete map back to blob bytes. **No normalised offset may appear in an
artifact as a source coordinate.**

Normalisation that removes or replaces bytes is not length-preserving, so a
normalised index is not a source position. The requirement covers **line-ending
normalisation specifically**: a producer that maps CRLF to LF and reports the
resulting index has reported a position that does not exist in the blob.

The coordinate **unit** is subject to the same rule. Byte offsets and offsets in
any fixed-width or UTF-16 code-unit representation diverge cumulatively across a
file, so a coordinate in the wrong unit is wrong at distances unrelated to
anything near the occurrence.

The comparator enforces this structurally: for every occurrence, decoding
`blob[start_byte:end_byte]` as UTF-8 must yield exactly the reported literal
(§8.2). A span that fails this is a structural error, not a comparison result.

### 3.6 Quoted context is a rebaseline aid

An artifact may carry a short quoted context window beside a span, so a human
can author a pin without counting bytes and so a span can be re-anchored after
the corpus moves. It is **not** identity: the comparator resolves a quote to a
span and compares spans. A quote that resolves to zero spans, to more than one,
or to a span that does not contain its own occurrence yields `unresolved`,
never a guess — there is no nearest-match or first-match fallback, because a
rebaseline aid that ranks candidates re-anchors a row onto the wrong occurrence,
which is the exact error §4.4 exists to detect, introduced by the tool meant to
survive it.

Because it is an aid rather than an assertion, **an unresolvable quote is
reported and decides no verdict.** It appears in the comparison output and in
no reducer row.

### 3.7 Line and column are diagnostics

Line and column may be reported for humans and are never compared.

---

## 4. Relations, anchors and dispositions

A **relation** binds occurrences into one claim. The registry declares each
relation's id, bound profile, anchor role, roles, which roles are required, and
the anchor domain the relation is measured over.

### 4.1 Relation identity and the anchor domain

A relation's identity is `(profile, relation id, anchor occurrence identity)`.
Exactly one role is the **anchor**, named in the registry. Anchoring on an
occurrence rather than on a set means a relation that loses a member is still
the same relation, reported incomplete, rather than a different relation that
appears missing.

**Every role's family must be bound to the relation's own profile** (§2.2). A
relation cannot reference an occurrence its profile does not contain, and a
registry that declares one is invalid — `scripts/check-family-registry.mjs`
rejects it. An earlier revision bound two roles of a `stage-docs` relation to a
family declared only for `discovered-md`, which left the relation either
permanently incomplete or unconditionally failing depending on which reading an
author took.

**The anchor domain is declared, not inferred.** Each relation declares
`anchor_domain`: the anchor family, the profile, and any **restriction** that
narrows the population — stated as a lexical observable on the anchor token
itself, or `null` for the whole family. A domain left to inference is the
failure this clause exists to prevent: the anchor families in this registry
admit token kinds that no candidate rule considered, so one author measuring
"the family" and another measuring "the kind everyone talks about" produce
coverage figures that are not about the same population, and every ratio
computed from them is meaningless. The restriction is a shareable lexical
observable under §1.2 — it says which tokens are in scope, not what the corpus
contains.

### 4.2 The contract fixes no association rule

Which occurrence binds to which is **not fixed here**. There is no minimal
binding span, no distance window, no block scope, no candidate ranking, and no
tie-break. A lane may implement any extraction policy it likes.

This is a reversal. The rule was removed by a ratified decision — the
`association-policy.md` of §2.3, squash `8ebbe48` — taken on measurements of
the frozen corpus after three successive rules had been adopted inside
implementation changes with no decision step and each found wrong.

**Those measurements are deliberately not repeated here.** They are readings of
this corpus, and §1.2 forbids a shared input from carrying one; an earlier
revision of this clause summarised them — a distance sweep, a share of bindings
joined by punctuation, how one container behaved — and each sentence handed
both lanes the same partial answer about what the corpus contains. The
reasoning that survives in this document is the part that is true of prose
rather than of these bytes:

- **A binding rule is a claim about meaning wearing the clothes of a claim
  about position.** Distance, containment and order are properties of a
  document's layout; whether a token asserts a relation or merely mentions one
  is not. A rule built from the first can agree with the second only by
  coincidence, and nothing in the rule reports when the coincidence ends.
- **An enumerated construction set has no stopping point over prose**, because
  prose has no closed grammar. Completeness can be approached and cannot be
  demonstrated, so a contract that fixes one is fixing a rule it cannot say is
  finished.
- **One rule for two relations assumes the relations are alike**, which is a
  property of the specific relations rather than of relations in general, so
  the contract has no basis for asserting it.

An author who wants the corpus evidence reads the ratified decision — which is
why §11.2 forbids a *lane* from reading it.

What replaces it is an **authority that can adjudicate an association without
being one**: an independently authored, span-level pairing oracle (§4.4).
Correctness is then a property a lane is measured against, not a property it is
told to have. §13 records that association policy is consequently **free**,
which is the exact inverse of version 1.1's §13.

Construction grammars remain necessary — as **lane extraction policy**, not as
contract text. They are lane-private for the reason §1.2 gives: a construction
inventory is a reading of this corpus, and handing the same reading to both
lanes destroys their independence. Each lane declares the policy it implemented
(§4.5).

### 4.3 Every in-scope anchor gets exactly one disposition

For every occurrence in a relation's declared anchor domain (§4.1), an artifact
carries **exactly one row**, whose disposition is exactly one of — and the row
must be consistent with the roles it names, which §8.2 checks:

| Disposition | Meaning |
|---|---|
| `bound` | This anchor carries a claim, and every required role is filled by a named occurrence. |
| `not-a-claim` | This anchor occurrence does not assert this relation at all. |
| `ambiguous` | This anchor carries a claim, and some role has more than one candidate that the artifact's policy does not rank. |
| `incomplete` | This anchor carries a claim, and some required role has no candidate to fill. |

The four are **total and mutually exclusive** over the anchor domain.

A disposition is defined by the roles it fills, so an artifact cannot borrow one
it has not earned: `bound` requires every required role filled, `incomplete`
requires at least one unfilled, and `not-a-claim` requires none filled. An
earlier revision left this unchecked, and two `bound` rows carrying no roles at
all compared equal and reached `agreeing`.

**A missing row is a structural coverage failure, not a silent pass** (§8.2) —
missing, that is, relative to the domain the run is measured over, which §4.4
defines and which is *not* the same as the registry's declared domain. §4.4
states that gap rather than leaving §4.3 to imply it away.
This is the clause that makes recall measurable. Under a vocabulary where an
unmatched anchor simply produces nothing, an artifact that recognises one
construction and stays silent about everything else scores the same as one that
adjudicated every anchor — and this repository has shipped exactly that failure,
in a live gate that recognised a subset of the forms in use and reported no
findings on the rest. Requiring a row for every anchor makes silence
impossible: a lane that cannot decide must say `ambiguous`, which is a result,
and a lane that decides there is no claim must say `not-a-claim`, which is a
claim of its own and is checkable.

The cost is stated rather than hidden: an artifact must enumerate the whole
anchor domain rather than only the anchors it recognised, so it is larger — by
however much of that domain carries no claim, which is a property of the
documents and is not stated here (§1.2). That is the price of a recall figure
that means something.

### 4.4 The pairing oracle is the correctness authority

A run's correctness authority is a **span-level pairing oracle**: an artifact
that carries, for every in-scope anchor, one §4.3 disposition and — where
`bound` or `incomplete` — the **exact physical identity** (§3.2) of the
occurrence filling each role.

Four properties are fixed:

1. **It keys on physical occurrence identity, never on value.** A row names
   `(profile, path, blob, start_byte, end_byte)` for the anchor and for every
   filled role. Value agreement is not pairing agreement (§3.2).
2. **It is authored by independent annotation with adjudication, not by running
   a rule.** A rule here would be a third implementation of the guess §4.2
   rejected, and it would rank the lanes by similarity to itself rather than by
   correctness. The corpus is frozen and finite, so an extensional list is
   available and a rule is not needed.
3. **It is not derived from any lane's output**, and no lane may see it
   (§11.2). Its annotation provenance is recorded per row.
4. **It is versioned with the corpus.** Rebaselining the corpus requires a new
   oracle version; spans are never silently repaired (§10.2 rule 4, §10.3).

**Without an oracle a run has no correctness verdict** (§8.3 row 2). Two lanes
that agree establish nothing: two implementations of the same wrong policy agree
perfectly, and this is the reason lane-declared policies alone were rejected as
the mechanism. Agreement between lanes is a diagnostic, never a verdict.

The oracle's anchor enumeration **defines the in-scope domain for the run**, and
that has a consequence worth stating plainly rather than burying: an oracle that
omits an anchor exempts every lane from being scored on it.

What is checked is **agreement**, not completeness. The comparator requires every
artifact in a run to carry a row for the same set of anchors, and reports a
difference as a structural error (§8.2) without deciding which side is right.
It does not enumerate the domain from the registry's recognition rules itself:
that would be a third reading of rules the registry states once, and a third
reading is the failure §3.4 exists to prevent.

The residual hole is therefore precise and is recorded in §14 — an anchor that
**both** the oracle and every lane miss is invisible to this comparison. An
independent enumerator would close it; adding one is a contract-version change
with an owner, not a quiet improvement.

### 4.5 Each lane declares its policy

Every artifact declares, per relation, the extraction policy it implemented. The
declaration is **structured and digested, never a bare name**: two materially
different implementations can and do share one label, so a label alone cannot
tell an agreement from a coincidence.

The contract fixes the declaration's **shape**, not its content:

| Key | Meaning |
|---|---|
| `relation` | The relation id this policy governs. |
| `anchor_domain` | The domain the artifact actually measured, in the §4.1 shape. Declared even when it equals the registry's, because a silent narrowing is the failure it exists to catch. |
| `class` | A short mechanism name — `annotation`, `construction-grammar`, `proximity`, `hybrid`, or any other the author needs. Free text; not gated against a list. |
| `parameters` | A flat object of scalars naming every tunable the implementation has. Empty is a claim, not an omission. |
| `ranking` | How the policy chooses when a role has more than one candidate, or `none` if it does not choose. |
| `tie_policy` | What it emits when it does not choose: `ambiguous` or `ranked`. |
| `digest` | SHA-256 over the canonical serialisation of the declaration without `digest`, using §2.1's serialisation — lexicographic keys, two-space indent, trailing newline. Not §11.3's, which digests bytes rather than a value. |

The shape is **checked, not merely required** (§8.2): `parameters` must be a
flat object of scalars, `tie_policy` must be `ambiguous` or `ranked`, `class`
and `ranking` must be non-empty, and `anchor_domain` must carry family, profile
and restriction. Checking only that the seven keys are *present* accepts
`parameters: "whatever"`, which is the bare name this clause forbids wearing
seven keys. `class` is the one value never checked against a list (§4.2).

A **policy mismatch** between two artifacts in one run is a **first-class
finding** on the run, not noise scattered across rows: it says the row-level
disagreements below it may be explained by a declared difference rather than by
an error. It never decides the verdict on its own, because the oracle does that.

Absent an oracle, a policy mismatch cannot be adjudicated and the run is
`not-comparable` — which is the same outcome §8.3 row 2 gives any oracle-less
run, for the same reason.

---

## 5. Literal and canonical identity

Every occurrence carries its **literal** text — the exact bytes of its span —
and may carry a **canonical** value.

- Literal and canonical are **separate fields**; neither replaces the other.
- Where a canonical value is not literally present, the artifact records which
  authority produced it (§9) and which span justified it.
- **Resolving a literal to a canonical form is the comparator's work** against
  the frozen authority snapshot, never a producer's work against live state.

Abbreviated and full-width forms of the same identifier are therefore never
compared directly. Comparing them would report disagreement between two
artifacts that agree.

---

## 6. Field states

Each field is in exactly one state:

| State | Meaning |
|---|---|
| `present` | A value was observed. |
| `explicit-null` | The document affirmatively asserts there is none. |
| `unresolved` | A value should exist but the producer could not determine it. |
| `not-applicable` | The field does not apply here. |

### 6.1 Absence is not a state

Absence means there is no occurrence. A field cannot be absent from an
occurrence that exists.

### 6.2 Optionality is cardinality

Expressed by the registry, not by a field state.

### 6.3 Authored facts are never recovery failures

Evidence-loop boundaries, membership of a record's root arrays, and per-site
supersession chains are **authored judgments**, not recoverable from prose; an
accepted decision in this repository records that attributing one class of them
was tried and withdrawn as undecidable.

The registry declares no family for an authored fact. Therefore an artifact that
omits one is **correct**, and there is no row to mark — this is what §3.4's
`expected_zero` mechanism is for, and why `authored-by-design` (§7.5) may be
attached only to a row that exists. It can never excuse a silent omission,
because §4.3 makes a missing anchor row structural before any qualifier is
considered.

---

## 7. The comparison vocabulary

A comparison has one **oracle** (§4.4) and one or more **lanes**. It is
asymmetric on purpose: the oracle is the authority, the lane is the candidate.

Version 1.1 compared two symmetric inventories with an expected-count /
observed-count table. That table is **removed, not amended**: the ratified
decision replaced the second artifact with an oracle that adjudicates pairings
rather than inventorying fields, so there is no second count to compare against.
What replaces it is a containment check (§7.1) and a disposition table (§7.2).

### 7.1 Occurrence containment

Every occurrence identity the oracle names — as an anchor or as a filled role —
must appear in the lane's occurrence inventory with the **same family** and the
**same literal**.

A named identity the lane does not carry is `absent-occurrence`. One it carries
under a different family or literal is `divergent-occurrence`. Both are lane
findings; neither is structural, because the artifact is well-formed and simply
disagrees.

The check is one-directional by construction. The oracle is not an occurrence
inventory, so the lane's occurrences outside the oracle's rows have no
counterpart and are not compared here.

### 7.2 Anchor disposition comparison

Each in-scope anchor gets exactly one status. Rows are evaluated in order and
**the first matching row wins**.

| # | Oracle | Lane | Status |
|---|---|---|---|
| 1 | `ambiguous` | any | `not-adjudicated` |
| 2 | `bound`, `not-a-claim` or `incomplete` | `ambiguous` | `unresolved` |
| 3 | `bound` | `bound`, role bindings identical | `agreeing` |
| 4 | `bound` | `bound`, role bindings differ | `mispaired` |
| 5 | `bound` | `not-a-claim` | `missed` |
| 6 | `bound` | `incomplete` | `missed` |
| 7 | `incomplete` | `incomplete`, filled roles identical | `agreeing` |
| 8 | `incomplete` | `incomplete`, filled roles differ | `mispaired` |
| 9 | `incomplete` | `bound` | `unexpected` |
| 10 | `incomplete` | `not-a-claim` | `missed` |
| 11 | `not-a-claim` | `not-a-claim` | `agreeing` |
| 12 | `not-a-claim` | `bound` or `incomplete` | `unexpected` |

The six statuses are total and mutually exclusive, and rows 1–12 partition all
sixteen disposition pairs.

Three of them carry the decision's comparison semantics directly: **oracle
`bound` against lane `not-a-claim` is `missed`** (row 5) and **the reverse is
`unexpected`** (row 12).

- **`not-adjudicated` is the oracle's own limit, not the lane's error.** Row 1
  precedes everything: where the authority declined to decide, no lane can be
  scored. These rows are counted and reported, never charged, and §8.4 stops a
  run made entirely of them from reading as a `pass`.
- **`unresolved` is the lane's refusal to decide** where the oracle did decide.
  It is `blocked`, not `fail`: a lane that says "I cannot tell" has not asserted
  anything false.
- **`mispaired` is the finding this whole design exists to reach.** Rows 4 and 8
  fire when both sides bound the same anchor and disagree about *which
  occurrence* filled a role. Every value-level check in this repository is blind
  to it, because the values agree.

### 7.3 Role binding comparison

Role bindings are identical when, for every role the relation declares, the two
sides name the same physical identity (§3.2) or both leave it unfilled. A
`mispaired` row carries the differing roles as detail.

A pairing disagreement is **one row, not two**. Reporting it as a `missed` on
one role and an `unexpected` on another would split one difference into two
findings on opposite sides of the ledger with nothing linking them — the same
defect §3.3 avoids by not keying on family.

### 7.4 Policy declaration comparison

The declarations (§4.5) of the artifacts in a run are compared by digest. A
difference is a **run-level finding** that **names the keys that differ**, and
`parameters` is compared key by key — §4.5 fixes it flat for exactly this.
Reporting only that two digests differ says the policies are not the same and
nothing about how, which is the whole diagnostic value of the clause. It never
changes a row's status, and — with an oracle present — never changes the
verdict. It is the diagnostic that says whether a row-level disagreement is
explained by a declared difference.

An **anchor-domain** difference is reported separately from the rest of the
declaration even though it is part of it, because a narrowed domain changes what
every ratio in the report is a ratio *of*.

### 7.5 Qualifiers

Qualifiers annotate a row; they never replace its status and never change it.

| Qualifier | Meaning |
|---|---|
| `authored-by-design` | The row concerns a field the registry declares authored (§6.3). |
| `artifact-only` | A compared field's authority is an untracked run artifact (§2.3). |

### 7.6 One run-level condition

`baseline-stale` is **not** a status and not a qualifier. It is a property of the
whole comparison, recorded on the run. Two rows in one run can differ on every
status and every qualifier and cannot differ on this.

It is disjoint from a bundle or corpus digest mismatch: a digest mismatch is
detected *before* comparison and yields `not-comparable` (§8.3 row 1);
`baseline-stale` records that an **authority** (§9) moved while the corpus did
not.

---

## 8. The verdict

### 8.1 "Required" is defined by the registry

A family or relation is **required** iff its registry entry says so. A row is
required iff its relation is required. §8.3 handles `unexpected` explicitly
rather than through requiredness, because an `unexpected` row has no expectation
to be required.

### 8.2 Structural errors precede comparison

These are checked before any status is assigned, on every artifact:

- schema or contract-version mismatch;
- **bundle digest mismatch, or differing bundle seals between the artifacts**
  (§11.3);
- corpus manifest digest mismatch, or differing pins between the artifacts;
- a span that is not a valid half-open range within its blob;
- a literal that does not equal the UTF-8 decoding of its own span (§3.5);
- an occurrence whose family is not in the registry;
- an occurrence outside the pinned profile's membership, or whose blob is not
  the one the manifest records for its path (§2.1);
- an anchor row whose disposition contradicts the roles it names (§4.3);
- a policy declaration whose shape does not match §4.5;
- no sealed bundle digest supplied to the comparator, or a seal that does not
  verify against the tree (§11.3);
- an artifact missing a policy declaration for a relation it reports (§4.5);
- a missing attestation record, or one whose declared contract version, bundle
  digest, manifest digest or artifact digest disagrees with the artifact it
  sits beside (§11.4);
- **a missing anchor row** — an in-scope anchor (§4.1) for which the artifact
  carries no §4.3 disposition.

Any structural error yields `not-comparable` for the whole run. A structural
error is never reported as `missed`, `unexpected`, or `mispaired` — those would
attribute to one lane a fault in the artifact's own well-formedness.

The last item is the one that costs something, and it is deliberate. An artifact
that covers part of the anchor domain would be scored on the subset it chose,
which reports a precision figure as if it were a recall figure. Refusing to
compare is the honest outcome, and the remedy is mechanical: emit the missing
rows.

### 8.3 The reducer

Evaluated in order; **the first matching row wins**.

| # | Condition | Verdict |
|---|---|---|
| 1 | Any structural error (§8.2) | `not-comparable` |
| 2 | The run has no oracle (§4.4) | `not-comparable` |
| 3 | Any authority-drift condition (§9), including `baseline-stale` | `not-comparable` |
| 4 | Any row on a required relation is `mispaired`, `missed` or `unexpected` | `fail` |
| 5 | Any occurrence-containment finding (§7.1) on a required relation | `fail` |
| 6 | Any compared field's authority is `artifact-only`, its artifact is present, and it disagrees | `fail` |
| 7 | Any row on a required relation is `unresolved` | `blocked` |
| 8 | Any required field is `unresolved` (§6) | `blocked` |
| 9 | Any compared field's authority is `artifact-only` and its artifact is absent | `blocked` |
| 10 | §8.4's non-vacuity condition is not met | `blocked` |
| 11 | Otherwise | `pass` |

Notes on rows that earlier revisions got wrong:

- **Row 4 covers `unexpected` unconditionally within a required relation.** An
  extra claim is a defect regardless of which role carries it.
- **Rows 6 and 9 replace an earlier contradiction** between "artifact-only does
  not decide the verdict" and "artifact-only can fail". Present-and-disagreeing
  fails, absent blocks, present-and-agreeing is silent. It never *alone* decides
  a `pass`.
- **Row 2 is new in 2.0.0** and is the reducer's statement of §4.4: correctness
  has an authority or it has no verdict.
- **`not-adjudicated` appears in no row.** It is counted, reported, and cannot
  fail a lane; §8.4 is what keeps it from manufacturing a `pass`.
- `authored-by-design` never reaches the reducer: by §6.3 an authored fact has
  no family, so it produces no row to be required.

**Verdict reachability is a property of this reducer, not an aspiration**, and
it is stated precisely because the imprecise version is easy to satisfy by
cheating.

Rows 1–5, 7, 8, 10 and 11 are reachable with no `artifact-only` field in scope
at all, which is what makes `pass` and `fail` properties of the artifacts rather
than of the machine. Rows 6 and 9 are machine-dependent **by construction**
(§2.3), so where the registry declares an `artifact-only` field, a machine
without that run artifact reaches `blocked` — and that is the correct answer,
not a defect to engineer around.

Two consequences the comparator's tests must honour, because an earlier revision
honoured neither. Reachability is demonstrated on the **shipped** registry, not
on a reduced one with the `artifact-only` family removed; and a field the
registry declares and an artifact omits is read as **absent**, never as
satisfied. An artifact that reached `pass` by saying nothing about a run
artifact would have recreated reachability by dropping the condition instead of
meeting it.

### 8.4 `pass` cannot be vacuous

A `pass` additionally requires that **every required relation produced at least
one adjudicated row** — a row whose status is not `not-adjudicated` — unless an
`expected_zero` declaration covers it.

**"Covers" is keyed**, because an unkeyed exemption excuses everything: a
declaration covers a relation when its `family` is the relation's **anchor
family** and its `profile` is the relation's **own profile**. A declaration for
a different profile, or for a role family that is not the anchor, excuses
nothing. This is the other half of §3.4's rule — an *undeclared* zero is a
finding, and a *declared* one is what keeps a legitimately empty relation from
reading as a vacuous pass in one direction and as a coverage failure in the
other.

Two vacuity routes are closed by that one sentence, and it is §8.3 row 10 that
enforces it. Without it, two empty artifacts satisfy rows 1–9 and fall through
to `pass`; and an oracle that declined every anchor would also reach `pass`,
having decided nothing.

`fail` is a **successful** comparison. A comparator that reports a defect as a
tool error has lost the result.

---

## 9. The authority snapshot

A pinned corpus does not freeze everything a comparison consults. Authorities
include at least: tag references, tag and commit subjects, reachability from an
integration branch, manifests as they stood at a tag, retained run artifacts,
and the reference clock any staleness judgment uses.

- The comparator holds **two** authority snapshots: a **baseline** captured when
  the corpus was pinned, and a **run** snapshot captured at comparison time.
  Drift is the difference. A single snapshot taken at comparison time records
  current authority and cannot detect that it moved — so a run offered only one
  is `not-comparable`, not drift-free. Reporting a check that could not run as a
  check that found nothing is the failure this bullet exists to prevent.
- **Drift is movement, not growth.** A new commit on the integration branch and
  a newly created tag change no authority a comparison consulted, and treating
  them as drift would make every comparison `not-comparable` within hours of any
  pin — the same verdict-unreachability that retired contract 1.0, by a
  different door. A retargeted tag, a re-created tag object, a rewritten subject
  and a commit that has stopped being reachable are movements, and every field
  the snapshot records is compared: a field recorded and not compared is a check
  that looks present and is not.
- Neither snapshot is available to either authoring lane. An authority both
  lanes may consult is a third oracle; one they may consult *differently* is a
  silent divergence.
- Every authority-derived value names the snapshot entry it came from. One that
  does not is `unresolved`.
- **Authority drift yields `not-comparable`** (§8.3 row 3), never `fail`.

The snapshot is **enumerated, not sampled**. `scripts/evidence-measurement.mjs
authority` builds it: every commit reachable from the integration branch with
its subject, and every tag with its object, target and subject. A selection rule
would be a second place the baseline and the run snapshot could differ — in what
they *chose* to include rather than in what moved — and drift detection over two
differently-selected sets is unsound. The committed baseline is
`authority-baseline.json` in this directory; it is JSON rather than prose so
that it does not enter this repository's markdown commit-citation corpus, and it
is regenerated only by a deliberate rebaseline (§10.2 rule 2).

---

## 10. Freezing, rebaseline and growth

### 10.1 Versioning

Both artifacts declare this contract's version, the corpus manifest digest, and
the bundle digest (§11.3) before comparison. A mismatch is a structural error
(§8.2). Adding or changing a family, relation, disposition, status, or reducer
row is a version change.

### 10.2 Rules

1. A comparison in flight **completes against its own pin or aborts**. It never
   rebases mid-run.
2. **Rebaseline is deliberate and owner-authorised**: an explicit act producing a
   new manifest and a new comparison, never a side effect of running a tool.
3. **Superseded pins stay addressable** — an earlier comparison keeps naming its
   own manifest.
4. A rebaseline **does not migrate an oracle**. Re-anchoring is authoring work,
   subject to §11.

Rules 2 and 3 are obligations on the operator, not properties a comparator can
verify from two artifacts. They are stated here because they are part of the
procedure; §11.4's attestation is what makes them auditable.

### 10.3 Post-freeze growth

**A form discovered after the freeze requires a contract-version change and an
explicit rebaseline. It never grows silently.**

This is the rule that keeps §4.2's treadmill from running inside a measurement.
A lane that meets a joining shape its policy does not recognise emits
`ambiguous` or `not-a-claim` — both are results, and both are scored. What it
may not do is widen its policy mid-run, or widen it between runs while claiming
the earlier verdict still holds: the second is the more tempting failure,
because nothing visibly breaks.

Concretely, all three of the following are version changes under §10.1 and
require a new corpus pin, a new oracle version (§4.4 property 4), and a fresh
comparison:

- adding a family, a relation, or an anchor-domain restriction;
- widening a lane's declared policy after a comparison has run against it;
- re-anchoring an oracle row onto a span the previous version did not name.

**Convergence, for a frozen corpus, is defined and finite**: every in-scope
anchor has an oracle disposition; every `bound` and `incomplete` row names exact
role spans; every construction a lane declares carries positive and
adversarial-negative controls; and the corpus, oracle and policy digests are
frozen together. Convergence so defined says nothing about prose outside the
pin. **No claim is made that any lane's grammar generalises to future
documents**, and a measurement that reported one would be reporting a fit.

---

## 11. Clean-room independence

Independence is procedural, so it is stated as procedure and **recorded**, not
assumed.

### 11.1 Isolation is by delivery, not by instruction

Each lane receives a **selected-blob bundle**: the blobs the manifest names, and
nothing else. Telling a lane not to look is not isolation — a lane with ordinary
repository access at the pinned commit can read the incumbent detector, the
excluded evidence records, and this repository's history, all of which reveal
the shape of a correct answer.

### 11.2 What each lane may and may not see

**May**: this contract, the family registry, the corpus manifest, and its
selected-blob bundle.

**May not**: the other lane's artifact or any part of it; the comparator's
output; either authority snapshot (§9); the other lane's intermediate totals,
coverage counts, or diagnostics; conformance examples drawn from this corpus;
`association-policy.md` and its harness (§2.3); and any construction inventory
derived from this corpus (§1.2, §4.2).

### 11.3 The sealed bundle

The three shared inputs are sealed as one **bundle digest**: the SHA-256, in
lowercase hex, over the exact bytes of this contract, the family registry, and
the corpus manifest, in that fixed order.

**The framing is fixed here because it is not derivable.** For each member, in
order, the hash absorbs

```
<repository-relative path> NUL <byte length in decimal ASCII> NUL <the file's exact bytes>
```

with the path and the length encoded as UTF-8 and `NUL` the single byte 0x00.
The length prefix is what makes concatenation unambiguous: without it, moving a
byte from the end of one member to the start of the next leaves the digest
unchanged. Stating only "over the bytes, in this order" would have left two
implementations free to frame it differently and to disagree about a digest
both computed correctly.

**Declaring versions is not enough, and that is why this exists.** A contract
version and a schema id are author-maintained strings: two lanes can hold
materially different normative text under one version number — one of them
edited, the other not, or one holding a revision that was later corrected — and
every §8.2 check would pass while the two were working from different rules.
The digest is over bytes, so it cannot be true of two different texts.

`scripts/evidence-measurement.mjs seal` computes it and writes
`bundle-seal.json` in this directory; `seal --verify` fails when any of the
three files has moved a byte. Both artifacts declare the bundle digest, and a
mismatch — between an artifact and the seal, or between two artifacts — is a
structural error (§8.2).

**The RECORDED seal is the authority, not a freshly computed one.** A comparator
that recomputes the digest and compares artifacts against that result runs a
check that cannot fail: edited shared bytes are accepted whenever both artifacts
declare the recomputed value. A comparison whose seal does not verify does not
proceed, and a comparison offered no seal at all is `not-comparable` rather than
unsealed — a skipped check is not a passed one.

The rationale-class documents of §2.3 are deliberately **not** in the bundle. A
digest over them would make them look like a shared input.

### 11.4 The attestation record

Each lane emits an attestation alongside its artifact recording: the contract
version, the bundle digest and the manifest digest it worked against; the digest
of its own artifact at seal time; the seal timestamp; and a statement of which
of §11.2's prohibited inputs it had access to, if any.

**The artifact digest is defined here because it is not derivable**, for the
same reason §2.1 fixes the manifest digest: it is the SHA-256, in lowercase hex,
over §2.1's serialisation of the artifact **with its `attestation` key
removed**. The exclusion is structural, not stylistic — the attestation carries
the digest, so a digest over the whole document could never be computed by the
lane that has to write it. Two authors left to choose would pick the file bytes,
a re-serialisation, or a blob id, and every comparison would end
`not-comparable` before measuring anything.

Both artifacts are **sealed** — digest recorded — before either is disclosed to
the comparator. An artifact whose digest changes after the other was disclosed
invalidates the comparison; the remedy is a new comparison, not an edited
artifact.

An attestation is a **claim by its lane**, not a proof. It makes a violation
recorded and reviewable rather than invisible; it cannot make one impossible.
§11.1 is what actually reduces the opportunity.

What a comparator can still decide about a claim is whether it is *present* and
whether it *agrees with the artifact beside it*, and both are structural (§8.2).
An attestation naming a different bundle than its own artifact is not a weak
claim but a broken one, and `prohibited_inputs_accessed` must be written even
when empty: an empty array is a claim, an absent key is a silence.

### 11.5 Repairs during comparison are prohibited

A defect found while comparing is a finding. Repairing either side
mid-comparison converts an independent measurement into a fitting exercise.

---

## 12. Clauses the corpus does not exercise

Some fixed clauses will have no instance in the frozen corpus. Recording which
ones is worth doing — an untested clause is a clause whose first real use is in
production — and **it cannot be done here.**

"Clause X has no instance in this corpus" is a reading of the corpus, and §11.2
makes this document a shared input to every lane. Naming the clause is not a
smaller leak than quantifying its margin: both tell an author what the corpus
does not contain, which narrows what a correct artifact looks like without that
author having done the work. Two earlier revisions got this wrong in two
different ways — the first stated the margins inline; the second moved them to
a companion rationale file, declared the leak closed, and left the *list of
clause names* in the contract, where a lane still read it.

**The rule, therefore, and the whole of §12:** clauses the corpus does not
exercise are recorded in a **rationale-class** document (§2.3), produced
**after** the measurement rather than before it, and no lane may read it
(§11.2). This contract names none of them. An author who finds an instance
moves the clause into the exercised body of the rationale record and notes the
reading that moved it — there, never here.

## 13. What this contract leaves free

Named so divergence here is a choice rather than an oversight.

Parser implementation, internal representations, and data structures; the order
in which a producer scans; the physical serialisation of either artifact beyond
its declared schema and version; diagnostic prose; performance; and every real
identifier, digest, tag, run id and count either artifact is expected to
contain.

**Association policy is free** — the construction grammar or other mechanism by
which a lane binds a role to an anchor, its proximity behaviour, its search
order, and its candidate ranking. This is the exact inverse of version 1.1,
which fixed all four and declared grammars not free; §4.2 records the
measurements that reversed it. Free does not mean unstated: §4.5 requires the
policy to be declared, structured and digested, and §4.3 requires it to produce
a disposition for every anchor it was pointed at.

Family recognition rules are **not** free: the registry fixes each one as a
lexical observable (§3.4), because a family is the population being measured
rather than an answer about it. How a producer implements the match is its own
affair.

---

## 14. Consequences

- Two authors can work without meeting, and a disagreement is *attributable*: to
  one artifact, to an authority, to an authored judgment, to a declared policy
  difference, or to a gap here.
- A pairing error whose values agree is now reachable as a finding. Under every
  value-level check this repository has run, it was not.
- `fail` and `blocked` are results. Only `not-comparable` means the measurement
  did not happen — and §8.3 rows 1–3 name every way to get there.
- The contract can be extended without being reopened: §1.1 decides membership,
  §12 records what has never been tested, §10.1 and §10.3 version the change.
- The costs are real and are not hidden. The oracle is hand-authored, so the
  measurement is bounded by one author's judgment and by the size of a corpus a
  human can annotate. **An anchor that every artifact in a run misses is
  invisible** (§4.4): the comparator checks that the artifacts agree on the
  anchor domain, not that the domain is complete, and closing that would take an
  independent enumerator this contract does not have. §4.3's totality makes artifacts large. §11.4's attestation
  is a claim, not a proof. §10.2's rules 2 and 3 are operator obligations no
  comparator checks. §13 lists where divergence stays silent.
