# The evidence measurement contract

Contract version: **1.0.0**

This document fixes the semantics that a **typed occurrence exporter** and an
**independently authored coverage manifest** must share in order to be
compared. With the two machine-readable files it names — the corpus manifest
and the family registry — it is the only thing they may share.

It names **no expected value**: no commit, tag, run id, record id, or count
that either side should produce. §1.2 states the test, and why the corpus pin
is not an exception to it.

The reasoning and measurements behind these clauses are **deliberately not
here**. They are corpus-derived, so publishing them to both lanes would leak
the shape of a correct answer (§1.2). They live in
`measurement-contract-rationale.md`, which is **not** a shared input.

Status: proposed. Authored before either artifact exists, on purpose —
authored afterwards it would describe whichever one was written first.

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

The rule exists so a later author can add a dimension without reopening the
decision that produced this document. A list can only be trusted; a rule can be
checked.

### 1.2 What may be shared, and what may not

The distinction is about the **origin** of a datum, not its effect:

- **Protocol and input parameters** — facts that hold independently of what
  this corpus contains — are shareable, and most of them must be shared or the
  two lanes are not measuring the same thing. Coordinate conventions, lexical
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

### 1.3 Three dispositions

Every dimension ends in one of:

- **Fixed** — stated normatively below or in the family registry.
- **Free** — deliberately unconstrained (§13), with the consequence named.
- **Stated but unexercised** — the clause is written, the frozen corpus does not
  exercise it, and the margin by which it fails to is recorded (§12).

Fixed/free and exercised/unexercised are different axes: the third disposition
is the *intersection* — a Fixed clause with no instance in the corpus — not a
third alternative to the first two. A Free dimension is never listed in §12,
because there is no clause to be unexercised.

---

## 2. The corpus

### 2.1 The pin is a manifest

The corpus is `docs/assurance/evidence/measurement/corpus-manifest.json`,
produced and checked by `scripts/evidence-corpus.mjs`.

The manifest is **normative for membership**, not only integrity. A commit alone
does not say which files are measured, and this repository contains more than
one answer to that question (§2.2). The manifest lists the files, so "the
corpus" is a set.

The manifest is built from the **commit's tree**, never a working tree or index,
and its `commit` must be a full object name. A symbolic ref re-resolves on every
run, so it names a moving corpus while claiming to have frozen one; the verifier
rejects it.

Content digests live only in the manifest, which is JSON. They are kept out of
this document because a content digest is indistinguishable in prose from a
commit citation, and this repository's commit-citation gate reads every markdown
file under `docs/`.

### 2.2 Two profiles, not interchangeable

| Profile | Membership | Scope |
|---|---|---|
| `stage-docs` | enumerated | The stage documents that make release and current-proof claims. |
| `discovered-md` | discovered | Every tracked markdown file at the repository root or under `docs/`, excluding generated changelogs. |

Both are pinned. **Every family and relation is bound to exactly one profile**
by the family registry (§3.4), so a family is never compared against a corpus
that does not carry it. Binding families to profiles — rather than choosing one
profile — is what prevents the two lanes from disagreeing about membership
before they disagree about anything real.

### 2.3 What is not corpus

- **Evidence records** (`docs/assurance/evidence/records/`) are not measured
  prose input and are not an authority for either lane. Their array membership
  is authored (§6.3), so they cannot establish coverage. They may be compared
  afterwards as a separate projection, outside this contract.
- **Run artifacts** under `.agentic-plugins/runs/` are not corpus. They are
  untracked, so a measurement that read them would return different answers on
  different machines. Fields that depend on them carry the `artifact-only`
  qualifier (§7.2) and are governed by §8's artifact rule.

---

## 3. Occurrences

### 3.1 The unit is a source occurrence

The primary unit is one **occurrence**: a contiguous region of one corpus file
carrying one datum of one family. A claim assembled from several occurrences is
a **relation** (§4) that *references* occurrences; a relation is never itself an
occurrence.

Incumbent tooling in this repository counts a partially-assembled claim as
covered. This contract does not: an incomplete relation is reported under §4,
and its member occurrences are still individually compared.

### 3.2 Physical identity

An occurrence's **physical identity** is exactly:

```
(profile, path, blob, start_byte, end_byte)
```

- Spans are **half-open UTF-8 byte ranges over the exact blob bytes**.
- `path` is part of the key. Without it, identity is corpus-global and a locally
  authored pin stops being decidable.
- **Value is never part of identity.** Two identical lexemes at different spans
  are two occurrences, always.
- **Family and type are not part of the key either** (§3.3).

Two occurrences of the *same* family may not share a physical identity. Two
occurrences of *different* families may — see §3.3.

### 3.3 Family, type and canonical value are compared, not keyed

Semantic family, type, and canonical value are **compared fields**. If family
were part of the key, one family disagreement would surface as one `missed` plus
one `unexpected` — two findings for one difference, on opposite sides of the
ledger, with nothing linking them.

Because families are compared rather than keyed, two families may claim the same
extent. The comparator pairs on physical identity first and reports the family
disagreement as `conflicting` on that single row.

### 3.4 Families are declared, not described

The family set is fixed by
`docs/assurance/evidence/measurement/family-registry.json`. For each family it
declares an id, its bound profile, its unit, a **recognition rule stated as a
lexical observable**, its fields with their permitted states, its cardinality,
and whether it is **required** (§8.1).

Two rules govern the registry:

- A recognition rule states what the datum **is in the document** — its lexical
  shape — never what it means and never how to search for it. A family defined
  by concept rather than shape puts one author's occurrences where the other has
  none, because one concept can have more than one lexical shape.
- A family that is recognisable but which a profile never carries must be
  declared in `expected_zero`. **An undeclared expected-zero is
  indistinguishable from an omission**, so an undeclared zero is `missed`.

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
span and compares spans. A quote that resolves to zero or to more than one span
yields `unresolved`, never a guess.

### 3.7 Line and column are diagnostics

Line and column may be reported for humans and are never compared.

---

## 4. Relations

A **relation** binds occurrences into one claim. The registry declares each
relation's id, bound profile, roles, and which roles are required.

### 4.1 Relation identity

A relation's identity is `(profile, relation id, anchor occurrence identity)`.
Exactly one role is the **anchor**, named in the registry. Anchoring on an
occurrence rather than on a set means a relation that loses a member is still
the same relation, reported incomplete, rather than a different relation that
appears missing.

### 4.2 Association scope is structural, never a character window

A role occurrence may be associated with an anchor only if both lie in the same
**association scope**: the smallest enclosing markdown block — a paragraph, a
list item, a table cell, or a fenced block — of the anchor.

A character-distance window is **prohibited**. Window width is not a neutral
implementation detail: this repository's own tooling records that widening a
proximity window changed which claims were found, and that choosing a different
candidate within a window produced a false result. A dimension that provably
changes outcomes cannot be left free (§1.1), and a structural scope is the
statement of it that names no width.

### 4.3 Candidate selection and ties

Within the association scope, for each role:

1. Candidates are the occurrences of that role's family satisfying the role's
   declared position relative to the anchor.
2. If exactly one candidate exists, it fills the role.
3. If none exists, the role is `unresolved` if required, `not-applicable`
   otherwise.
4. **If more than one candidate exists, the role is `ambiguous`.** The
   comparator does not rank, prefer the nearest, or prefer the first. Ranking is
   the dimension that produced a false result here before; a tie is reported.

### 4.4 Relation comparison

A relation row carries its own status from the §7.1 vocabulary, computed over
the tuple of its filled roles. A relation whose required roles are all filled
and agree is `recovered-once`; one with a role the two lanes fill differently is
`conflicting`; one with an `ambiguous` role is `ambiguous`; one present on only
one side is `missed` or `unexpected`.

Member occurrences are compared independently. A relation may be `conflicting`
while every one of its member occurrences is `recovered-once` — that is the
pairing disagreement this section exists to catch, and it is invisible at the
occurrence level.

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
`expected_zero` mechanism is for, and why `authored-by-design` (§7.2) may be
attached only to a row that exists. It can never excuse a silent omission,
because a silently omitted required family is `missed` by §7.1 before any
qualifier is considered.

---

## 7. The comparison vocabulary

### 7.1 Comparison statuses — total and mutually exclusive

Each compared row gets exactly one status. The row's inputs are: expected count
`E`, observed count `O`, value agreement, and whether the counterpart
association resolved.

| # | Condition | Status |
|---|---|---|
| 1 | Structural error (§8.2) on either side | *not a status — see §8.2* |
| 2 | `E = 0`, `O = 0`, an `expected_zero` declaration covers the site | `recovered-once` |
| 3 | `E = 0`, `O = 0`, no declaration | *no row exists* |
| 4 | `E > 0`, `O = 0` | `missed` |
| 5 | `E = 0`, `O > 0` | `unexpected` |
| 6 | `E > 0`, `O > 0`, any compared value disagrees | `conflicting` |
| 7 | `E > 0`, `O > 0`, values agree or are indeterminate, association unresolved | `ambiguous` |
| 8 | `E > 0`, `O > 0`, values agree, association resolved, `E ≠ O` | `conflicting` |
| 9 | `E > 0`, `O > 0`, values agree, association resolved, `E = O` | `recovered-once` |
| 10 | `E > 0`, `O > 0`, a compared value is indeterminate, association resolved | `ambiguous` |

**Rows are evaluated in order; the first matching row wins.** That is the
precedence rule, and it is total: rows 2–10 partition every combination of the
four inputs.

Two consequences worth stating because earlier drafts got them wrong:

- **Multiplicity mismatch is `conflicting`** (row 8), not a missing case and not
  a separate status. Since identical lexemes at different spans are distinct
  occurrences (§3.2), a multiplicity mismatch cannot arise from repetition in
  the document; it arises when the two lanes disagree about how many
  counterparts one expectation has, which is a disagreement about the claim.
- **`recovered-once` names agreement, not the number one.** Row 2 uses it for a
  satisfied expected-zero and row 9 for any matched `E = O`.

### 7.2 Qualifiers

Qualifiers annotate a row; they never replace its status and never change it.

| Qualifier | Meaning |
|---|---|
| `authored-by-design` | The row concerns a field the registry declares authored (§6.3). |
| `artifact-only` | A compared field's authority is an untracked run artifact (§2.3). |

### 7.3 One run-level condition

`baseline-stale` is **not** a status and not a qualifier. It is a property of the
whole comparison, recorded on the run. Two occurrences in one run can differ on
every status and every qualifier and cannot differ on this.

It is disjoint from a corpus digest mismatch: a digest mismatch is detected
*before* comparison and yields `not-comparable` (§8.3 row 1); `baseline-stale`
records that an **authority** (§9) moved while the corpus did not.

---

## 8. The verdict

### 8.1 "Required" is defined by the registry

A family or relation is **required** iff its registry entry says so. A row is
required iff its family or relation is required. An `unexpected` row has no
expectation and is therefore never required; §8.3 handles it explicitly rather
than through requiredness.

### 8.2 Structural errors precede comparison

These are checked before any status is assigned, on both artifacts:

- schema or contract-version mismatch;
- corpus manifest digest mismatch, or differing pins between the artifacts;
- a span that is not a valid half-open range within its blob;
- a literal that does not equal the UTF-8 decoding of its own span (§3.5);
- an occurrence whose family is not in the registry.

Any structural error yields `not-comparable` for the whole run. A structural
error is never reported as `missed`, `unexpected`, or `conflicting` — those
would attribute to one lane a fault in the artifact's own well-formedness.

### 8.3 The reducer

Evaluated in order; **the first matching row wins**.

| # | Condition | Verdict |
|---|---|---|
| 1 | Any structural error (§8.2) | `not-comparable` |
| 2 | Any authority-drift condition (§9), including `baseline-stale` | `not-comparable` |
| 3 | Any required row is `missed` or `conflicting` | `fail` |
| 4 | Any row is `unexpected` | `fail` |
| 5 | Any compared field's authority is `artifact-only` and its artifact is present but disagrees | `fail` |
| 6 | Any required row is `ambiguous` | `blocked` |
| 7 | Any required field is `unresolved` | `blocked` |
| 8 | Any compared field's authority is `artifact-only` and its artifact is absent | `blocked` |
| 9 | Otherwise | `pass` |

Notes on rows that earlier drafts got wrong:

- **Row 4 is unconditional.** An extra occurrence is a defect regardless of
  requiredness; making it conditional left an input with no verdict.
- **Rows 5 and 8 replace an earlier contradiction** between "artifact-only does
  not decide the verdict" and "artifact-only can fail". Present-and-disagreeing
  fails, absent blocks, present-and-agreeing is silent. It never *alone* decides
  a `pass`.
- **Row 2 covers authority drift**, which an earlier reducer omitted while §9
  required it.
- `authored-by-design` never reaches the reducer: by §6.3 an authored fact has
  no family, so it produces no row to be required.

### 8.4 `pass` cannot be vacuous

A `pass` additionally requires that **every required family and relation in the
registry produced at least one row**, unless an `expected_zero` declaration
covers it. Without this, two empty artifacts satisfy rows 1–8 and reach `pass`.

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
  current authority and cannot detect that it moved.
- Neither snapshot is available to either authoring lane. An authority both
  lanes may consult is a third oracle; one they may consult *differently* is a
  silent divergence.
- Every authority-derived value names the snapshot entry it came from. One that
  does not is `unresolved`.
- **Authority drift yields `not-comparable`** (§8.3 row 2), never `fail`.

---

## 10. Freezing and rebaseline

### 10.1 Versioning

Both artifacts declare this contract's version and the corpus manifest digest
before comparison. A mismatch is a structural error (§8.2). Adding or changing a
family, relation, status, or reducer row is a version change.

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
procedure; §11's attestation is what makes them auditable.

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
and `measurement-contract-rationale.md`.

### 11.3 The attestation record

Each lane emits an attestation alongside its artifact recording: the contract
version and manifest digest it worked against, the digest of its own artifact at
seal time, the seal timestamp, and a statement of which of §11.2's prohibited
inputs it had access to, if any.

Both artifacts are **sealed** — digest recorded — before either is disclosed to
the comparator. An artifact whose digest changes after the other was disclosed
invalidates the comparison; the remedy is a new comparison, not an edited
artifact.

An attestation is a **claim by its lane**, not a proof. It makes a violation
recorded and reviewable rather than invisible; it cannot make one impossible.
§11.1 is what actually reduces the opportunity.

### 11.4 Repairs during comparison are prohibited

A defect found while comparing is a finding. Repairing either side mid-comparison
converts an independent measurement into a fitting exercise.

---

## 12. Stated but unexercised

Fixed clauses the frozen corpus does not exercise, with the margin. A future
author who finds an instance moves the clause into the exercised body and records
the reading that moved it.

| Clause | Margin |
|---|---|
| §3.5's line-ending sentence — a producer must not report an index derived from CRLF-to-LF normalisation | No carriage return occurs in any pinned blob, and the repository declares no line-ending attributes. The surrounding rule *is* exercised by hard-wrap flattening; only the line-ending case is not. The corpus reading, not the detector, is what makes this zero. |
| §4.2's table-cell scope — a table cell as an association scope boundary | Relation anchors do occur inside table cells, but every currently associated role lies far from any cell boundary, so the boundary never decides an association today. It becomes live if a cell is split, and the largest such cell has been growing. Under §4.2 the scope is structural rather than width-based, so this margin no longer depends on a window width. |
| §3.3's same-extent multi-family case | Families in the registry can in principle claim the same extent, and the registry's exclusion clauses are written to prevent it. No pair currently does. |

---

## 13. What this contract leaves free

Named so divergence here is a choice rather than an oversight.

Parser implementation, internal representations, and data structures; the order
in which a producer scans; the physical serialisation of either artifact beyond
its declared schema and version; diagnostic prose; performance; and every real
identifier, digest, tag, run id and count either artifact is expected to contain.

**Regular expressions are free; grammars are not.** A recognition rule is fixed
by the registry as a lexical observable (§3.4); how a producer implements the
match is its own affair. **Proximity windows, search order, and candidate
ranking are not free** — §4.2 and §4.3 fix them, because this repository's own
tooling demonstrates that each one changes results.

---

## 14. Consequences

- Two authors can work without meeting, and a disagreement is *attributable*: to
  one artifact, to an authority, to an authored judgment, or to a gap here.
- `fail` and `blocked` are results. Only `not-comparable` means the measurement
  did not happen.
- The contract can be extended without being reopened: §1.1 decides membership,
  §12 records what has never been tested, §10.1 versions the change.
- The costs are real and are not hidden. §11.3's attestation is a claim, not a
  proof. §10.2's rules 2 and 3 are operator obligations no comparator checks.
  §13 lists where divergence stays silent.
