# Why the measurement contract says what it says

Companion to `measurement-contract.md`. **This document is not a shared input.**
Neither the exporter lane nor the oracle lane may read it (contract §11.2).

Everything here is corpus-derived. Under the contract's own sharing test
(§1.2) that makes it unshareable: counts, ratios, extremes and which shapes
actually occur all narrow what a correct artifact must look like, without the
lane having done the work. The contract therefore states its rules bare, and the
evidence for them lives here.

All readings were taken on one machine at `2cb9637`, the commit the corpus
manifest pins. They are a snapshot: the corpus moves, and §8 is about exactly
that. Re-measure rather than trusting these numbers as current.

---

## Why a corpus manifest rather than a commit (contract §2.1, §2.2)

Two corpora already exist in `scripts/check-doc-evidence.mjs`. Its release and
proof checks read an enumerated list of three stage documents; its commit-sha
check reads a discovered set of markdown files. At the pinned commit those sets
carry 438 and 575 commit citations respectively.

If one lane scoped to the enumerated set and the other to the discovered set,
137 rows — 23.8% of all occurrences — would appear as unmatched on one side.
None of them would be a defect. Binding each family to a profile, rather than
choosing a profile, is what removes this.

The stage-doc reading of 438 was independently reproduced by the cross-host peer
during planning, and the discovered reading of 575 matches the production
check's own `commitShas.checked`. The manifest's `discovered-md` byte total of
1,906,997 matches an independent walk of the same file set.

## Why the pin reads the commit, not the checkout (§2.1)

Measured directly: selecting from the commit tree yields 76 files; selecting
from the index yields more, and the count keeps climbing as this change adds
documents of its own — the contract, this rationale, the inventory. That is the
point rather than an aside: a pin resolved from a checkout changes as soon as
anyone adds a document, including the lanes themselves, and an earlier draft of
this sentence was already stale by one when a reviewer read it.

Churn makes this worse rather than theoretical. In the 60 days before the pin
the three stage documents were touched 52, 81 and 57 times; in the preceding 30
days eighteen `plugin-runtime` tags were cut, three of them on the pin date.

## Why spans are byte offsets into blob bytes (§3.2, §3.5)

The incumbent `flatten()` replaces a newline and optional block prefix with a
single space, which is not length-preserving. Measured over the discovered
corpus: 73 of 76 files lose characters, 10,413 in total, and only 12 of 575
citations — 2.087% — still sit at their true offset after flattening. An
exporter that reported a flattened index as a span would be wrong for 563
occurrences while looking entirely well-formed.

An earlier draft of the contract wrote "under two percent survive". That is
false: 2.087% is above two percent. The cross-host review caught it. The
contract no longer carries the figure at all, which is the better fix.

Byte offsets and JavaScript string indices diverge for 573 of 575 citations,
mean 325.5 and maximum 3,362. No non-ASCII character is adjacent to any
citation, so the divergence is a cumulative prefix effect and is invisible to
local inspection — which is why the contract states the unit rather than
trusting an implementer to notice.

## Why value is never identity (§3.2)

575 occurrences carry 223 distinct lexemes; 188 are repeats within a single
file, and the most frequent lexeme occurs 20 times corpus-wide and 6 times in
one file.

Note the consequence the first draft got backwards: because distinct spans are
distinct occurrences, those 188 repeats are 188 separate rows. They are *not* an
instance of "expected once, observed twice" on a single row, and citing them as
the reason to drop a `recovered-twice` status was wrong. The cross-host review
caught this. Multiplicity mismatch is now `conflicting` (§7.1 row 8) and arises
from the lanes disagreeing about a claim, not from repetition in the document.

## Why line and column are diagnostics only (§3.7)

96% of `docs/DEVELOPMENT.md`'s citations and 36% of the scorecard's sit inside
single physical lines longer than 3,000 bytes. The largest such lines measure
58,388 and 34,885 bytes. Line numbers locate 137 of DEVELOPMENT.md's 143
citations to just three lines.

## Why a quoted context window is a rebaseline aid, not identity (§3.6)

File-scoped, a symmetric window of ±48 characters uniquely locates all 438
stage-doc occurrences, and ±8 already covers 91.1%. Corpus-global — dropping
`path` from identity — the same widths locate only 424 and 324, and ±96 is
needed to reach all of them.

The cross-host peer measured this independently and reported the corpus-global
figures, which reproduced exactly. It is the reason `path` is part of the
physical key rather than an annotation.

## Why family is compared and not keyed (§3.3)

Under a natural type taxonomy, 269 spans in the stage documents have identical
extent and attract two labels — a runtime tag is also a plugin tag. That count
reflects the taxonomy used to probe it rather than an inherent property of the
corpus, so it demonstrates realisability, not frequency. Overlaps of *differing*
extent measure zero, which is why §3.3's clause is written for exact extent only
and why §12 records the rest as unexercised.

## Why the association scope is structural (§4.2, §4.3)

The repository's own tooling records both failures this rule prevents:

- `scripts/check-doc-evidence.mjs` records that a 600-character window skipped a
  proof record whose run id sat 955 characters after its anchor, and that 1,200
  was needed. Window width demonstrably changes which claims are found.
- The same file records that taking the *first* rather than the *last* candidate
  paired a tag with a feature PR's squash instead of the release PR's, producing
  a false finding.

A first draft of the contract listed proximity window, search order and
candidate ranking as deliberately free, and asserted that none of them could
change a comparison status. The cross-host review disproved that with the two
readings above. They are now fixed, and the fix names no width.

## Why relations are separate from occurrences (§3.1, §4)

At the pinned commit the incumbent release check reports 77 "checked" claims.
Only 64 of those carry both a squash and a marketplace-sync sha; the breakdown
is 64 complete, 2 squash-only, 10 sync-only, 1 neither, across 33 distinct tags.

So "checked: 77" counts anchor sites that had a PR mention, not verified
relations. Two lanes each picking a natural-looking unit would disagree on
cardinality before comparing a single value — and, worse, could recover every
individual occurrence while pairing them differently, which no occurrence-level
comparison can see. That is what §4.4's last paragraph is for.

## Why literal and canonical are separate (§5)

Every one of the 438 commit citations in the stage documents is exactly 7
characters. The evidence record schema requires full 40-character shas. A lane
reporting literals and a lane reporting canonical values would mismatch on all
438 rows while agreeing completely about the facts.

## Why records and run artifacts are not corpus (§2.3)

The record schema is closed — `additionalProperties: false` — and carries no
location field of any kind. An accepted amendment to ADR-0049 records that
attributing a sha to a record was rejected as undecidable from prose, after an
unambiguous rule attributed 0 of 97 candidates.

The records also carry 142 sha-shaped occurrences across 19 files. If one lane
treated the store as input and the other excluded it, those 142 would flip
between `unexpected` and `recovered` with no defect on either side.

Run artifacts: 48 distinct doctor run ids are cited by the stage documents; all
48 exist on the authoring machine and none is tracked in git. The same
measurement therefore returns a different answer in CI, which is what the
`artifact-only` qualifier and §8.3 rows 5 and 8 exist to express.

## The §12 margins

- **Line endings.** No carriage return byte occurs in any of the 76 corpus files,
  in the working tree or in the committed blobs, and there is no
  `.gitattributes`. A planted CRLF was verified to be detectable, so the zero is
  a property of the corpus rather than of the detector. The cross-host review
  noted that an earlier draft called "the CRLF clause" dead while §3.5 contained
  no line-ending sentence at all; §3.5 now carries one explicitly, so the row
  names a clause that exists.
- **Table-cell scope.** 30 tag occurrences sit inside table rows, and the nearest
  cell delimiter to any of them is 1,284 characters away at minimum, with a
  median of 8,424. The scorecard row concerned grew from 15,105 to 34,885 bytes
  in roughly the month before the pin. Under the first draft's character-window
  rule this margin was a function of the window width, which the review rightly
  called policy-dependent; under §4.2's structural scope it is a function of
  document shape alone.

## What the cross-host review changed

The Plan-verify pass returned the draft as not-ready and was right on every
claim checked. Confirmed and repaired: the false "under two percent" figure; the
backwards multiplicity rationale; the unsound sharing test in §1.2; the
assertion that window, order and ranking could be left free; a non-total status
table and a reducer that produced no verdict for a lone extra, for a
multiplicity mismatch, or for two empty artifacts; a self-contradiction between
"artifact-only does not decide the verdict" and "artifact-only blocks or fails";
an authority snapshot that could not detect drift because it was captured only
once; and isolation stated as instruction rather than delivery.

On the tooling it found that `verifyManifest` accepted a manifest whose commit
was the symbolic ref `HEAD`, one with a wrong or missing schema, and one with a
duplicated path — all reporting no drift. Reproduced locally, all four, plus
four further shapes. All now fail.

It also found that the contract itself leaked corpus fingerprints while
forbidding them. That is why this document exists and why it is not shared.

---

## The §12 margins

The contract lists which clauses the corpus does not exercise; the margins live
here, because a margin is a corpus reading and §11.2 makes the contract a shared
input to both lanes.

- **Line endings (§3.5).** No carriage-return byte occurs in any of the 76 corpus
  files, in the working tree or in the committed blobs, and the repository
  declares no line-ending attributes. A planted CRLF was verified detectable, so
  the zero is a property of the corpus and not of the detector.
- **Optional-role ties inside a binding span (§4.3 rule 2).** Under the minimal
  binding span the required roles cannot tie by construction, and no optional
  role in the pinned corpus has two candidates inside its span. The clause exists
  for a document that later writes two squash shas into one release sentence.
- **Same-extent multi-family (§3.3).** Exact-extent collisions are realisable
  under a natural taxonomy — 269 spans in the stage documents attract two labels
  when the taxonomy lets one pattern subsume another — but the registry's
  exclusion clauses prevent it, and overlaps of *differing* extent measure zero.

## What the second review round changed

A high-effort multi-agent review of the repaired draft returned 15 findings, all
reproduced. Four of them meant the contract could not work at all:

- **The block-scope association rule pinned every verdict at `blocked`.** The
  first draft used a character window; review one showed width changes results,
  so the repair replaced it with the smallest enclosing markdown block. On this
  corpus that block is a 34,000-byte table cell holding 33 tag anchors and 49 PR
  citations: 32 of 33 anchors had more than one candidate in scope, and 87 of 87
  run-id anchors had more than one date. Both required relations were therefore
  `ambiguous`, and §8.3 fixed the verdict at `blocked` — no `pass` and no `fail`
  was reachable on the contract's own pinned corpus.

  The deeper fault is that replacing a distance with a container is still
  proximity with the width hidden, and `AGENTS.md` already records that this
  repository abandoned proximity outright for its date-to-id binding in favour of
  a closed set of exact constructions. The repair had reintroduced a rejected
  approach in a different guise. §4.2 now uses a minimal binding span, which
  names no width and no container; measured on the same corpus it yields 86
  recovered and **0 ambiguous**.
- **`release-triple` referenced a family its own profile could not contain.** Its
  `squash` and `marketplace_sync` roles named `commit-citation`, which was bound
  to `discovered-md` while the relation was `stage-docs` — so the triple was
  either never measured or unconditionally failing, depending on which reading an
  author took. Families now carry a list of profiles, and every family measurably
  occurs in both.
- **The only `expected_zero` was falsified by the corpus.** It claimed
  `content-digest` never occurs in the stage documents; measured, 23 runs of more
  than 40 hex characters do. A conforming producer would emit 23 `unexpected`
  rows and fail unconditionally. Worse, the claim contradicted a finding this
  same track had already recorded — that the family has two lexical shapes and
  the unprefixed one occurs there. `expected_zero` is now empty by measurement.
- **The manifest digest was normative in three sections and defined nowhere.**
  Two authors would have picked different values and every comparison would have
  ended `not-comparable`. §2.1 now fixes the algorithm and the serialisation, and
  the script produces and verifies it.

Three tooling faults were fail-open rather than fail-closed:

- `ls-tree --format=%(path)` C-quotes a non-ASCII path even under `-z`, so such a
  file silently left the discovered profile while `verify` printed "no drift".
  Reproduced with a Korean filename. The fix is `core.quotePath=false`, and the
  regression test now creates a path the setting affects — the previous test set
  the option but never exercised it.
- A bare `pin` defaulted `--commit` to HEAD and overwrote the tracked manifest, a
  rebaseline as a side effect of running a tool, which §10.2 rule 2 forbids.
  Reproduced. The earlier repair had closed the flag-present-but-valueless case
  and left this mirror live — the same half-a-fix shape twice in one change.
- `show` rendered a manifest pinning zero files as valid and exited 0.

And the registry had no validator at all, which is why three of its defects
shipped. `scripts/check-family-registry.mjs` now gates it, and its own mutation
suite reproduces each of the three.

Two comments in the test suite claimed coverage they did not have — that all
nine shape mutations had a known-failing ancestor when four were already caught,
and that a gitlink exercised the non-blob branch when no gitlink is created
anywhere. Both are corrected rather than removed, because the claim was the
defect, not the test.
