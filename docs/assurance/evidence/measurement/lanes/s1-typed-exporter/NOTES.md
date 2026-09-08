# Lane S1 implementation notes

## Outcome

`exporter.mjs` enumerates all seven registry families over the manifest corpus,
emits one occurrence per `(path, blob, start_byte, end_byte, family)`, applies
two independently chosen relation policies, and writes a canonical
`artifact.json` with `role: "lane"`. It validates the sealed inputs, Git blob
IDs, schema, relation totality, role consistency, digests, and span round trips
before writing.

The emitted occurrence inventory has 3,416 rows. The required relation anchor
rows are:

| Relation | Total | `bound` | `not-a-claim` | `ambiguous` | `incomplete` |
|---|---:|---:|---:|---:|---:|
| `release-triple` | 145 | 87 | 12 | 16 | 30 |
| `proof-date-binding` | 292 | 125 | 50 | 4 | 113 |

## Extraction policies

The contract deliberately leaves association policy free (§4.2, §13). The
choices below are therefore lane S1 judgments, not contract requirements. Each
policy is emitted in the structured §4.5 form, every implementation threshold
and grammar choice that can be varied is named in its flat `parameters` object,
and its digest is SHA-256 over the §2.1 canonical serialization without
`digest` (§4.5).

Both policies parse a smallest Markdown structural clause: a pipe-delimited
table cell, a list item including indented continuations, or a blank-line
bounded paragraph, then a semicolon/sentence-bounded clause within it. Fenced
code is inventoried as occurrences but relation-looking text inside it is
`not-a-claim`. The precise fence, list, cell, paragraph, and sentence choices
are declared as parameters (§4.5).

For `release-triple`, an anchor is claim-bearing when it is explicitly linked
by `tag`/`tags`, including an explicit punctuation/`and` tag list; when it is
the sole tag in a clause containing a labeled `release PR`, `release pull
request`, or `released as PR`; or when its clause has the explicit action cue
`released`, `published`, `cut`, or `shipped` within the declared 96-code-unit
prefix. Required and optional candidates must follow their lexical labels
through Markdown wrappers, whitespace, and punctuation only. The optional
commit roles use distinct `squash` and `marketplace sync` labels; family alone
never assigns either role, because the registry declares their family collision
and §4.3 requires actual role consistency. A required PR candidate missing from
an otherwise recognized construction is `incomplete`; text outside a recognized
construction is `not-a-claim`; multiplicity or an optional-role identity
collision is `ambiguous`; exactly one required PR candidate is `bound`.

For `proof-date-binding`, a date candidate must be in the same structural clause
and either the same table-cell clause or connected within the declared 120-code-
unit limit by an explicit lexical form such as `RUN on DATE`, `DATE as RUN`,
`RUN (DATE)`, `dated`, or `recorded on`. A claim cue with no candidate is
`incomplete`; no cue is `not-a-claim`; one candidate is `bound`; more than one
is `ambiguous`.

Both declarations say `ranking: none` and `tie_policy: ambiguous`. I chose this
over nearest/first-candidate ranking because §4.2 explicitly does not supply a
proximity or tie rule, repeated values make a positional guess unsafe (§3.2),
and §4.3 provides `ambiguous` for an unranked multiplicity. I rejected global
file/paragraph proximity because it crosses claim boundaries, and rejected
manual per-occurrence enumeration because that would be a corpus-fitted
annotation policy rather than the declared reusable construction mechanism.

Every package tag and proof run ID in the registry's unrestricted `stage-docs`
anchor domains receives exactly one row, as required by §4.1 and §4.3. The
anchor role is never repeated in `roles`, and unfilled roles are absent rather
than `null` (§3.8, §4.3).

## Recognition and coordinates

Family recognition follows the registry lexical observables (§3.4). Package-tag
and proof-run spans are found before the explicit bare-semver and ISO-date
containment exclusions. Hex runs are first made maximal so runs longer than 40
become one `content-digest`, never commit-citation windows. A prefixed content
digest wins over bare in accordance with the registry's required field
precedence (§3.3–§3.4).

All source matching occurs on strict UTF-8 decoded text with a complete mapping
from JavaScript string boundaries back to source byte boundaries. The artifact
uses only half-open byte ranges over the original bytes (§3.2, §3.5). A fatal
UTF-8 decoder checks every emitted `bytes[start_byte:end_byte]` and requires it
to equal `literal` before output. All 3,416 spans round-tripped. Tests exercise
non-ASCII prefixes, a Korean boundary, CRLF, hard wraps, indentation, repeat
values, byte zero, end-of-file, delimiters, inline code, and code fences (§3.5).

The three stage documents also belong to `discovered-md`. Because profile is not
physical identity and same-family occurrences may not duplicate one physical
identity (§3.2), they are emitted once. The contract supplies no scalar-profile
precedence for an occurrence in overlapping profiles; as a lane judgment I use
`stage-docs` for shared paths so the relation anchors carry their relation's
profile, and `discovered-md` otherwise.

Locally observable fields are emitted in `fields`, including `literal`. I did
not resolve `canonical`: §3.3 exempts authority-derived fields from lane
comparison, §5 assigns resolution to the comparator, and §9 withholds authority
snapshots from lanes. Likewise, `artifact_present` is omitted when
`artifact_only_scope` is `out-of-scope`: §2.3 says it still applies (so
`not-applicable` would be false) but is neither compared nor blocked in this
delivery model.

## Underspecified lexical judgments

The following were not decidable from a more formal lexical definition in the
contract/registry, so I made and tested these lane judgments instead of
inventing corpus-specific exceptions:

- “word character” and “alphanumeric” use ECMAScript's ASCII `\w`-style
  vocabulary. This means `0.128.0` immediately followed by Korean `이` is a
  `bare-semver`. The source byte mapping still ends before the Korean bytes.
- A PR citation at end-of-blob is not recognized. The rule says it must be
  terminated by a non-word character, unlike the ISO-date rule, which expressly
  permits end-of-blob.
- A package segment accepts one or more Unicode letters/numbers separated by
  `.`, `_`, or `-`; an outer word/hyphen boundary is required. Sentence `.` is
  allowed after the patch component, while `.DIGIT` is rejected as a fourth
  version component. Code delimiters are wrappers, not span bytes.
- A proof-run kind accepts Unicode letters/numbers plus `_` and `-`, is parsed
  against the fixed timestamp suffix, and the lowercase-hex suffix is maximal
  and nonempty. No run-kind allow-list is used.
- A `_sha256` introducer is a same-line letter/underscore field name ending in
  `_sha256`, followed by `:`, `=`, or a table `|` separator and Markdown/quote
  wrappers. `sha256:` must be directly adjacent to the hex run. Only the hex
  run is the occurrence literal.
- Start/end of blob count as boundaries except for the explicitly strict PR
  termination judgment above.

These are parser choices permitted by §13, but they can affect the population,
so they are stated rather than hidden. The overlap-profile scalar choice and the
out-of-scope authority-field representation are the two wire-level gaps I could
not derive from the supplied contract.

## Integrity, schema, and attestation

Canonical JSON is emitted recursively with lexicographic keys, two-space
indentation, and one trailing newline (§2.1). It is manually serialized so
JavaScript cannot reorder integer-like keys numerically. The exporter verifies:

- the manifest self-digest under §2.1;
- the exact four-member, NUL/decimal-length framed bundle digest under §11.3,
  against the recorded delivery seal;
- every policy digest under §4.5; and
- the artifact digest over the artifact with `attestation` removed under §11.4.

The dependency-free schema checker implements every assertion used by the
sealed `artifact-schema.json` and fails closed on an unsupported assertion. A
second semantic pass covers the checks the schema cannot express: manifest
membership/blob equality (§2.1), valid and round-tripping spans (§3.5), known
families/roles, unique physical-family occurrences (§3.2–§3.3), policy shape and
digests (§4.5), disposition/role consistency and total anchor coverage (§4.3),
and attestation equality (§11.4).

No network access, repository history, other lane output, oracle, comparator
output, authority snapshot, rationale-class association document, or other
§11.2 prohibited project input was read. `TASK.md` was the sole external input
read outside `bundle/`; the user required it to be read first, and it is named
in `attestation.prohibited_inputs_accessed` under the user's stricter reporting
instruction. Self-authored files under `out/` were subsequently read only for
verification.

## Verification

The required commands pass:

```text
node out/exporter.mjs
node --test out/tests.mjs
```

The test suite contains behavior-sensitive positive and negative controls for
each item it names. In particular, deleting canonical key ordering, maximal-run
handling, wrapper exclusion, non-ASCII byte mapping, repeated-occurrence
identity, wrapped construction binding, ambiguity, code-fence handling, schema
enforcement, a disposition invariant, or any anchor row makes its corresponding
test fail.
