# ADR-0049: Evidence as data — record release/proof facts once, render the prose

## Status

Proposed

## Context

The stage docs (`docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`,
`docs/assurance/omcc-cutover-scorecard.md`) restate the shipped
`plugin-runtime` version and the installed-state proof that backs it.
Keeping those statements true has required a manual recovery PR after
every release — 0.86.0 → [#636](https://github.com/each4all/agentic-plugins/pull/636),
0.86.1 → [#640](https://github.com/each4all/agentic-plugins/pull/640),
0.86.2 → [#643](https://github.com/each4all/agentic-plugins/pull/643) —
and the hand-editing is error-producing, not merely tedious.

### What one evidence record actually is

A single release/proof record carries thirteen facts:

| field | source |
|---|---|
| runtime version | `.release-please-manifest.json` |
| proof command | fixed string |
| proof run id, proof date | `.agentic-plugins/runs/doctor/<id>/` |
| Claude / Codex CLI versions | doctor artifact |
| installed state per host | doctor artifact |
| doctor readings (`overall`, experience parity, `entry_brief`, `session_capture`, `host_parity_baseline`) | doctor artifact |
| feature PRs + shas | git + `plugins/runtime/CHANGELOG.md` |
| hardening PRs + shas | git + changelog |
| release triple (PR, squash, tag, marketplace sync) | git tags and commits |
| install method | operator statement |
| loop narrative | **human** |
| supersession relation | **human judgment** |

Twelve of the thirteen are already held, exactly, by git, the manifest,
or a doctor artifact. One — the narrative — is genuinely authored.

That record is then **hand-copied into five prose sites** (four in the
scorecard, one in `DEVELOPMENT.md`), each phrased differently, and the
copies accumulate: seventeen tagged releases and twenty-four cited proof
run ids are in the documents today.

### Why the current tooling cannot close this

[ADR-0016](0016-cross-package-commit-splitting.md)-style discipline and
the [#644](https://github.com/each4all/agentic-plugins/pull/644) tooling
(`scripts/sync-doc-versions.mjs` deriving the version tokens,
`scripts/check-doc-evidence.mjs` gating the relations) both operate by
**recovering those twelve fields out of prose**. That recovery was taken
through five rounds of adversarial cross-host review during #644. The
outcome separates cleanly:

- **Identifier comparisons converged.** Release triples verified against
  real tags and release commits, sha resolution and reachability, version
  token equality, run-id shape — these survived adversarial review and
  caught three real defects that no gate had ever seen: a mis-paired
  `#521`/`v0.77.1` triple, and two dangling citations of a squash-deleted
  branch commit.
- **Prose parsing did not converge.** Every round produced new defects in
  the checks that must decide *what a sentence means*. Concretely:
  - Date-to-run-id binding by proximity is undecidable here. Measured
    across the corpus, id/date pairs that AGREE sit at distances
    13–56, 86, 127, 184, 192, 228, 330, 448, 585, 707; pairs that
    DISAGREE sit at 75, 162, 195, 229, 248, 292, 407, 520, 927. They
    interleave from 75 onward, so no threshold separates them.
  - Attributing a sha to a changelog version failed three times in three
    directions: bare semver attributed a runtime commit to a host version
    (`Codex 0.145.0 … af620df`); filtering to released runtime versions
    did not help because a host version can collide with one (`Codex CLI
    0.86.1`); requiring an explicit runtime marker removed the ambiguity
    and also the check, attributing **0 of 97** changelog-backed shas,
    because the documents attribute with bare semver. The check was
    removed in #644 rather than tuned a fourth time.

The generalisation: the twelve machine-known fields were never
unavailable. They were **discarded at authoring time** by being written
as prose, and every gate since has been an attempt to reconstruct them.
Reconstruction from unstructured text has an unbounded adversarial
surface; the fields themselves do not.

## Decision

Record the evidence once, as data. Render the prose from it. Gate the
data, not the prose.

**1. A single evidence store.** Release/proof records move to
`docs/assurance/evidence/` as one JSON file per runtime release, closed
schema, `additionalProperties: false`, in the style of the runtime
plugin's packaged `data/schemas/`. Fields are exactly the thirteen above.
The human-authored ones are explicit and labelled:

- `narrative` — free text; what the release was. Never gated.
- `supersedes` — the editorial judgment that is currently implicit in
  whether a recovery PR replaces the head record or prepends a chain
  link. Today that decision leaves no trace: `0.85.0`/`0.82.0`/`0.81.0`
  survive as chain links while `0.83.0`/`0.83.1`/`0.84.0`/`0.86.0`/
  `0.86.1` were absorbed in place, a split that follows no rule. As a
  field it becomes a recorded decision.

**2. Rendered regions.** The five prose sites become generated regions,
delimited by explicit markers, produced by a renderer from the store.
Everything outside the markers stays hand-written.

**3. Data-level gates replace prose-level gates.** Each machine-known
field is validated against its own source — tag against
`git for-each-ref`, squash against the tagged commit, proof readings
against the doctor artifact, version against the manifest. No regular
expression reads a sentence. The rendered output is additionally
verified by re-rendering and failing on any diff, so an edit inside a
generated region cannot survive.

**4. Migration is proved, not asserted.** The initial store is generated
by the identifier extractors already shipped in
`scripts/check-doc-evidence.mjs`, which resolve 40 release-triple claims
and 236 cited shas on the current documents, plus git and the doctor
artifacts. The migration is accepted only when re-rendering reproduces
the current prose's **facts** — the acceptance criterion is a field-level
diff of extracted-then-rendered against extracted-from-current, empty.
Hand-transcription of the twenty-four historical records is explicitly
forbidden, because it is the exact failure mode this ADR exists to
remove.

**5. Scope is the recurring record only.** Release/proof records and
their supersession chain. The scorecard's requirement rows, ADR-0012
condition matrix, and narrative sections are out of scope and stay
hand-written.

**6. The prose-parsing gates retire on migration.** `checkProofCitations`
(citation-phrase date binding) is transitional: sound within its closed
grammar but covering 39 of 94 cited ids. It is removed once the records
it inspects are rendered from data. The identifier gates
(`checkReleaseTriples`, sha resolution/reachability) are retained — they
validate the store's git-derived fields and remain useful for the
hand-written regions.

## Consequences

**Positive.** The recurring post-release recovery collapses to: re-record
the doctor proof, add one record to the store, write the narrative
sentence. The five hand-copies become one authored record. The defect
class that motivated all of this — a token moved while the tokens beside
it did not — becomes unrepresentable, because there is one instance of
each fact. The unbounded prose-parsing surface disappears, replaced by a
field set whose size is known. The `supersedes` judgment stops being an
invisible editorial act.

**Negative.** These documents read differently. The scorecard is an
assurance artifact humans read, and today's records are dense and
discursive; a template plus a `narrative` field will be more uniform, and
some rhetorical nuance is lost. Generated regions inside hand-edited
markdown are a known hazard — people edit inside the markers — mitigated
but not eliminated by the re-render diff gate. The migration is
substantial and touches the repo's primary assurance document. And the
semantic claims in `narrative` remain unverifiable by any gate; this ADR
contains them, it does not check them.

**Neutral.** Authoring shifts from writing prose to filling a record plus
a sentence. Reviewers gain a field-level diff instead of a prose diff,
which is easier to verify and harder to skim.

## Alternatives Considered

**Keep improving the prose parsers.** Rejected on five rounds of
evidence. The date-proximity measurement above is not a tuning problem —
agreeing and disagreeing distances interleave, so no threshold exists.
Attribution failed three times in three different directions and, in its
last sound form, checked nothing. Each round's fixes were correct and
each round found more, because the input space is unstructured natural
language.

**Demote the prose checks to advisory and stop.** This was the
alternative recommendation when #644 landed. It stops the treadmill but
leaves the root cause: one record, five hand-copies, twelve
machine-known fields discarded at authoring time. The next release still
needs the manual recovery, and the copies still drift — silently, since
the checks no longer gate.

**Make release-please own the documents via `extra-files`.** Rejected for
the same reason the marketplace catalog is not an `extra-files` target
(AGENTS.md §Release process): it couples every package to commits
touching shared files. It also cannot supply the proof fields, which come
from a doctor run that happens after the release, not from the release
itself.

**Generate the whole scorecard.** Rejected as over-reach. The requirement
rows and condition matrices are argued positions, not records; rendering
them would force a schema onto reasoning that legitimately varies.
Scoping to the recurring record keeps the boundary where the repetition
actually is.

**Rewrite run ids and dates in place with a sync script.** Considered
and rejected during #644, and the reasoning still holds: cited run ids
sit among syntactically identical superseded records (25 ids on one
`DEVELOPMENT.md` line, 20 in the scorecard R3 row, the phrase
"re-recorded under the `<version>` install on `<date>` (`<id>`" appearing
five times — once current, four superseded), the only distinguishing
field is the version being changed, and whether a release replaces the
head or prepends a link is not derivable. This ADR resolves that by
removing the need to locate anything in prose at all.
