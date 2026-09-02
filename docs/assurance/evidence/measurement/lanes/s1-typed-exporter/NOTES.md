# Lane S1 implementation notes

## Outcome

`exporter.mjs` scans the 77 unique manifest files once and emits 3,416 typed
occurrences plus exactly 437 anchor rows. The artifact has `role: "lane"` and
uses manifest paths verbatim. It does not resolve commit or tag literals against
live state, as required by contract §5.

The exporter includes a dependency-free validator for every assertion keyword
used by the sealed JSON Schema, followed by semantic checks the schema cannot
express: manifest membership and blobs, registry fields and states, physical
identity uniqueness, UTF-8 span round trips, policy and attestation digests,
role/disposition consistency, and total anchor coverage (contract §§2.1, 3.2,
3.5, 3.8, 4.3, 4.5, 6, 8.2, and 11.4).

## Extraction policy

Association is lane judgment, not a contract requirement (contract §4.2 and
§13). I implemented separate construction grammars because the relations have
different lexical evidence.

For `release-triple`, a package tag carries a claim only when an explicit
`tag`/`tags` cue or a cue-connected tag group introduces it. A direct `release
PR` cue starts a record and the next such cue ends it; a 320-byte maximum gap
prevents a record from absorbing distant prose. A reverse `PR ... released ...
tag` form is also recognized. `squash` is eligible only between that record's PR
and tag; marketplace-sync cues are eligible after the tag. A unique candidate
fills a role. Any unranked multiplicity is `ambiguous`; an explicit tag claim
without a release-PR candidate is `incomplete`; text without the tag
construction is `not-a-claim`. This is the structured policy declared and
digested under contract §4.5.

I rejected nearest-PR/nearest-commit ranking. The corpus contains feature PRs,
release PRs, feature squashes, release squashes, marketplace syncs, and stage-doc
syncs near one another; distance would silently choose a physical occurrence
without enough lexical evidence. I also rejected line and paragraph containment
because hard wrapping and extremely long Markdown rows make those containers
unstable. These are lane judgments permitted by contract §4.2, not normative
rules.

For `proof-date-binding`, the compact date in the run ID is only an equality
guard. A separate registry-valid ISO date must also participate in one of the
declared connector constructions: DATE-AS, RUN-ON, DATE-DIRECT,
RUN-PARENTHETICAL, DATE-LABELLED, or a labelled parenthetical group. The grammar
uses a 256-byte maximum gap and rejects period, semicolon, question mark,
exclamation mark, table-cell, and blank-line boundaries, except for the declared
semicolon-separated labelled-group form. Markdown decoration and ASCII
whitespace are normalized only while matching connectors; emitted coordinates
always point to original bytes (contract §3.5). Distinct surviving candidates
are never ranked and would be `ambiguous` (contract §§4.2–4.3).

I rejected value-plus-proximity alone. A same-calendar date can describe a
nearby baseline or narrative event rather than the run. A full timestamp such as
`YYYY-MM-DDTHH:MMZ` is not an `iso-date` occurrence because `T` is a word
neighbor under the registry rule (contract §3.4); when that timestamp is
connector-qualified, the row is `incomplete` rather than inventing a date role
(contract §4.3).

Every numerical limit, construction vocabulary, normalization choice, record
boundary, and disposition precedence used by these association grammars appears
as a flat scalar in the corresponding policy's `parameters`. Policy digests use
contract §2.1 canonical serialization with their own `digest` omitted, as
required by §4.5.

## Recognition and representation decisions

Family recognition follows the registry rather than the association grammars
(contract §3.4). In particular: commit runs are maximal and reject a left
hyphen, alphanumeric or U+2026 neighbors; content digests are longer than 40
hex characters and `prefixed` wins; PR tokens require a real terminating
non-word character; proof IDs do not contribute an internal ISO date; and bare
semvers inside package tags are excluded. The two sides of
`plugin-runtime-v0.85.0..plugin-runtime-v0.86.2` are both package tags because
the package-tag rule does not impose the bare-semver family's full-stop
boundary.

All registry-declared fields are emitted. Commit/tag canonical fields are
`unresolved`, and proof `artifact_present` is `not-applicable`; no value is
carried for a non-present field state (contract §§3.3, 5, and 6).

The three stage files also belong to `discovered-md`. Because same-family
occurrences may not duplicate one physical identity (contract §3.2), they are
scanned once and labeled `stage-docs`; the remaining files are labeled
`discovered-md`. The schema offers one scalar profile and the contract does not
state a precedence for overlapping membership, so this is lane judgment. It
keeps every relation anchor and role in the relations' declared stage profile
(contract §§2.2 and 4.1).

The registry does not spell out complete character grammars for `<package>` or
`<kind>`, nor whether every use of “word” is Unicode-wide. I used ASCII token
characters for package/kind/word boundaries and Unicode letters/numbers for the
commit rule's “alphanumeric.” I did not derive allowlists from observed values.
These parser interpretations are the only recognition details the inputs left
unable to decide; parser implementation itself is free under contract §13.

## Counts

| Relation | Bound | Not a claim | Ambiguous | Incomplete | Total |
|---|---:|---:|---:|---:|---:|
| `release-triple` | 117 | 17 | 0 | 11 | 145 |
| `proof-date-binding` | 125 | 165 | 0 | 2 | 292 |

Every in-scope anchor has exactly one row, including negative and incomplete
results, as required by contract §4.3.

## Spans, digests, and verification

Regex indices are converted through a complete UTF-16-index-to-UTF-8-byte map.
Before writing, the exporter fatally decodes every `bytes[start:end]` and
requires equality with `literal`; the tests independently repeat this for all
3,416 occurrences. Every span round-tripped (contract §§3.2 and 3.5).

Canonical JSON is emitted by a custom recursive serializer. It writes keys
directly in lexical order, including integer-like keys that JavaScript would
otherwise reorder, with two-space indentation and a final newline (contract
§2.1). Bundle framing follows §11.3 exactly; artifact sealing removes the whole
`attestation` key per §11.4.

Verification commands:

```text
node out/exporter.mjs
node --test out/tests.mjs
```

The tests include schema mutations, semantic mutations, missing/duplicate
anchors, repeated literals, non-ASCII prefixes, CRLF and hard wraps, first- and
last-byte spans, code delimiters/fences, boundary negatives, ambiguous
synthetic candidates, connector-negative proximity, and the full-timestamp
incomplete form.

## Clean-room attestation

No §11.2 prohibited input, other lane output, oracle, comparator result,
authority snapshot, rationale-class association policy, project history, or
network source was accessed. `attestation.prohibited_inputs_accessed` is
therefore `[]` (contract §11.4). Outside `bundle/`, I read the required
`TASK.md` task brief and the lane-authored files under `out/` during
verification; neither supplied corpus-derived measurement evidence.

