# ADR-0049: Evidence as data — a validated record store for release/proof facts, forward-only

## Status

Accepted

## Context

The stage docs (`docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`,
`docs/assurance/omcc-cutover-scorecard.md`) restate the shipped
`plugin-runtime` version and the installed-state proof that backs it.
Keeping those statements true has required a manual recovery PR after
every recent release — 0.86.0 → [#636](https://github.com/each4all/agentic-plugins/pull/636),
0.86.1 → [#640](https://github.com/each4all/agentic-plugins/pull/640),
0.86.2 → [#643](https://github.com/each4all/agentic-plugins/pull/643) —
and the hand-editing is error-producing, not merely tedious.

### What five adversarial review rounds measured

[#644](https://github.com/each4all/agentic-plugins/pull/644) took the
prose-recovery tooling (`scripts/sync-doc-versions.mjs` deriving the
version tokens, `scripts/check-doc-evidence.mjs` gating the relations)
through five rounds of cross-host review. The outcome separates cleanly,
and the split is not a matter of taste:

- **Identifier comparisons converged.** Release triples verified against
  real tags and release commits, sha resolution and reachability, version
  token equality, run-id shape — these survived adversarial review and
  caught three real defects that no gate had ever seen: a mis-paired
  `#521`/`v0.77.1` triple, and two dangling citations of a squash-deleted
  branch commit.
- **Prose parsing did not converge.** Every round produced new defects in
  the checks that must decide *what a sentence means*:
  - Date-to-run-id binding by proximity is undecidable on this corpus.
    Agreeing and disagreeing id/date distances interleave, so no
    threshold separates them. (The specific distance list recorded during
    #644 is a snapshot of the corpus as it stood then; the corpus has
    grown since and the distances have moved. The conclusion is
    unchanged — a re-measurement during this ADR's review still found
    agreeing and disagreeing distances interleaved, reaching past 2900 —
    but the numbers should be read as a historical measurement, not a
    current inventory.)
  - Attributing a sha to a changelog version failed three times in three
    directions: bare semver attributed a runtime commit to a host version
    (`Codex 0.145.0 … af620df`); filtering to released runtime versions
    did not help because a host version can collide with one (`Codex CLI
    0.86.1`); requiring an explicit runtime marker removed the ambiguity
    and also the check, attributing **0 of 97** changelog-backed shas,
    because the documents attribute with bare semver. The check was
    removed in #644 rather than tuned a fourth time.

The generalisation: the machine-known fields were never unavailable. They
are **discarded at authoring time** by being written as prose, and every
gate since has been an attempt to reconstruct them. Reconstruction from
unstructured text has an unbounded adversarial surface; the fields
themselves do not.

### What one evidence record actually is

A single release/proof record carries facts of four distinct provenance
classes. The distinction matters because it determines what any gate can
honestly assert:

| field | source | provenance |
|---|---|---|
| `record_id` | authored, stable | authored |
| `evidence_loop` — what the loop was | authored | authored |
| `package_releases[]` — package, version, tag, release PR, squash, marketplace sync | git tags/commits + `.release-please-manifest.json` | **derived** |
| `feature_commits[]` — PR + sha | git + `plugins/runtime/CHANGELOG.md` | **derived** |
| `hardening_commits[]` — PR + sha | git + changelog | **derived** |
| `proofs[]` — run id, date, command, host CLI versions, installed state per host, doctor readings | `.agentic-plugins/runs/doctor/<id>/` | **observed** |
| `install_method` | operator statement | **operator-attested** |
| `narrative` | — | authored |
| `relations[]` — typed links to other records | editorial judgment | authored |

Three field groups are derivable from repo state, one is observed from a
doctor artifact, one is an operator attestation, and four are authored.
An earlier draft of this ADR claimed "thirteen facts, twelve of them
machine-held, one authored"; that count was wrong in both directions and
is corrected here.

### Three constraints the corpus imposes

Measured against the documents as they stand, not assumed:

1. **The record unit is the evidence loop, not the release.** The two
   documents cite 17 distinct `plugin-runtime` tags but 27 distinct
   doctor run ids. A single release can carry several records (2026-07-20
   alone carries four: the 0.83.0 install proof, an attention-0.7.0
   freshness record, a post-attestation restoration, and 0.83.1), and one
   loop can span several releases (0.86.0/0.86.1/0.86.2 are one ADR-0048
   loop, recorded once). Keying a store by release does not fit the data.

2. **The supersession relation is per-site, not per-record.** The four
   evidence-bearing regions carry *different* chains: `0.83.0` is a chain
   link in the scorecard R3 row and `DEVELOPMENT.md` but absent from the
   scorecard continuity paragraph; `0.81.0` and `0.80.1` are links in the
   continuity paragraph and R3 but not in `DEVELOPMENT.md`; `0.77.2` and
   `0.77.1` survive only in the continuity paragraph. The R4 row is
   deliberately headed one loop behind the others (`0.86.0`
   `doctor-20260723T124714Z-a2e2e0`) because it argues an
   attestation-currency discipline rather than reporting latest state.
   An earlier draft claimed `0.83.0`/`0.83.1`/`0.84.0`/`0.86.0`/`0.86.1`
   were all "absorbed in place, following no rule"; in fact only `0.86.0`
   and `0.86.1` are absorbed everywhere, and the rule the others follow is
   the one `scripts/sync-doc-versions.mjs` names — evidence-loop
   boundaries, which is exactly why the 0.86.x releases collapse into one
   record. A scalar `supersedes` pointer cannot represent this.

3. **The prose sites are not addressable regions.** The evidence sites
   are: the scorecard continuity paragraph (a single 227-line paragraph
   that opens with `runtime:settings` dry-run narrative), the scorecard
   attention-classification narrative, the scorecard R3 and R4
   requirement rows, and the `DEVELOPMENT.md` ADR-0012 condition-2 matrix
   row. The last three are **single physical markdown lines** (15 105,
   6 487 and 39 165 bytes). `plugins/runtime/scripts/cutover-audit.mjs`
   parses the requirement rows and the condition matrix line-by-line, and
   `tests/plugin-shape/test-runtime-plugin.mjs` pins every requirement row
   as a single line with exactly five cells — a pin added *because* R3
   once spanned 40+ physical lines and silently dropped out of the live
   cutover audit. Any block-marker convention re-creates that incident,
   and an unescaped `|` in rendered narrative shifts the columns.

### What the doctor artifacts can and cannot back

`.gitignore` ignores `.agentic-plugins/runs/`, and
`plugins/runtime/scripts/retention.mjs` (ADR-0047 §7) deletes over-cap
runs. Every one of the 27 currently cited runs exists on the maintainer
checkout, but that is a property of one machine, not of the repo. A fresh
clone and CI have git history and tags but no run artifacts. Any claim
that a gate validates proof readings "against the doctor artifact" is
therefore true locally and false in CI, and must be stated that way.

## Decision

Record the evidence as data **going forward**, validate what the repo can
actually validate, and leave the prose alone for now.

**1. A forward-only evidence store.** Starting with the next runtime
release loop, each evidence loop gets one JSON file under
`docs/assurance/evidence/`, closed schema, `additionalProperties: false`,
in the style of the runtime plugin's packaged `data/schemas/`. The key is
the **evidence loop**, identified by a stable `record_id` — not the
release. A record carries `package_releases[]` and `proofs[]` as arrays
precisely because a loop may span several releases and several proof
observations.

**2. Every field declares its provenance.** The schema tags each field
`derived`, `observed`, `operator-attested`, or `authored`, per the table
above. This is not decoration: it is what tells a gate whether it may
assert the field, and it is the field-level answer to the honest-scope
principle in AGENTS.md §5.

**3. Relations are typed and plural.** `relations[]` holds entries of the
form `{type, record_id}` with `type` drawn from a closed set —
`follows`, `supersedes`, `amends`, `restores`, `absorbs`. This records
the editorial judgment that is today invisible, without pretending it is
derivable. Because nothing renders from the store (item 5), a wrong
relation costs a wrong note and nothing more; the judgment itself still
belongs to the author.

**4. Gates validate only what their source can back.**
- `derived` fields are validated against git and the manifest — tag
  against `git for-each-ref`, squash against the tagged commit, PR number
  against the release commit subject, shas against resolution and
  reachability. These run everywhere, including CI.
- `observed` fields record the source run id and a content hash of the
  doctor artifact. They are verified locally when the artifact is
  present, and are **explicitly not verified in CI**. The store presents
  them as an operator attestation carrying a verifiable pointer, which is
  what the repo can honestly support.
- `operator-attested` and `authored` fields are never gated.

**5. No rendering, and no generated regions.** The five prose sites stay
hand-written. No markers are introduced into the scorecard or
`DEVELOPMENT.md`, and no consumer of those documents changes. The
existing gates all stay: `checkReleaseTriples`, sha
resolution/reachability, and `checkProofCitations` — the last of which
remains necessary precisely because the prose it inspects is still
hand-written.

**6. The historical migration and the renderer are deferred, not
rejected.** Moving the 27 historical records into the store and rendering
the prose from it is the eventual goal, and it needs its own ADR. Two
preconditions must be met before that ADR can honestly be written:

- **A typed exporter spike.** The current extractors cannot seed a store:
  `checkReleaseTriples` returns `{findings, checked, checkedTags}` and
  `checkCommitShas` returns `{findings, checked}` — counts and findings,
  not records, with no association between a sha and a record. An
  exporter that emits records with source locations is new work, and a
  migration acceptance criterion of "extract → render → extract, empty
  diff" is circular until an independent coverage manifest pins the
  expected record ids, proof ids, tags, and field identities: if
  extractor and renderer omit the same field, the diff is empty and the
  field is gone.
- **A resolution for the single-line table constraint**, satisfying
  `cutover-audit.mjs` and the five-cell row pin, or a design that moves
  the evidence out of those rows into a standalone section that the rows
  link to.

## Consequences

**Positive.** The next release's record is authored once, in a validated
shape, with its derived fields checked against git at authoring time
rather than reconstructed from prose afterwards. The record unit finally
matches the data — evidence loops, with plural releases and plural
proofs. The `supersedes` judgment becomes a recorded, typed decision
instead of an invisible editorial act, and it is recorded in the one
place where getting it wrong is cheap. The provenance classes make the
CI/local asymmetry explicit rather than implied. None of the existing
gates, consumers, or documents are disturbed.

**Negative — and this is the headline cost.** On the day it lands, this
**adds** a copy. The five hand-written prose sites remain, and the store
is a sixth record of the same facts. The duplication the ADR's own
Context identifies as the root cause is not reduced; it is increased by
one, and the store's value is entirely contingent on the deferred
follow-up landing. If that follow-up never lands, this decision is net
negative and the store should be withdrawn rather than maintained —
**withdrawal trigger: two consecutive release loops in which the store is
authored but the follow-up ADR has not been opened.** The recurring
post-release recovery PR is not eliminated by this decision.

Secondary costs: schema and validator work; a per-release authoring step
that must not be skipped or the store silently rots; and the store's
`observed` fields carry, in CI, exactly the trust level today's prose
carries — a copy — differing only in that it names its source and hash.

**Neutral.** Authoring gains a step and loses nothing. The store is
git-tracked, which also keeps cited runs pinned by
`retention-planner.mjs`'s tracked-file citation scan; that is a
requirement, not an accident, and the implementation must carry a
regression test for it.

## Alternatives Considered

**Render the prose from the store now (the original form of this ADR).**
Rejected on the three constraints in Context, each measured rather than
assumed: three of the five sites are single-line table cells with a
shipped test pinning that shape and a recorded incident from violating
it; the supersession relation is per-site, so one store field cannot
drive four projections; and the migration's stated seed mechanism does
not exist and its acceptance criterion is circular. The generated content
would have been roughly 73% of the scorecard and 36% of `DEVELOPMENT.md`
by volume — a rewrite of the repo's primary assurance document, not the
"more uniform" phrasing the original draft used. Deferred to a follow-up
ADR behind the two preconditions in Decision §6, not abandoned.

**Keep improving the prose parsers.** Rejected on five rounds of
evidence. Agreeing and disagreeing date distances interleave, so no
threshold exists. Attribution failed three times in three different
directions and, in its last sound form, checked nothing. Each round's
fixes were correct and each round found more, because the input space is
unstructured natural language.

**Demote the prose checks to advisory and stop.** This was the
alternative recommendation when #644 landed. It is narrower than it
sounds: #644 already removed the unsound attribution check and kept the
identifier gates, so "demote" now means demoting checks that converged.
Rejected for that reason — gate severity and authoring/storage design are
separate questions, and the converged checks earn their severity.

**Make release-please own the documents via `extra-files`.** Rejected for
the same reason the marketplace catalog is not an `extra-files` target
(AGENTS.md §Release process): it couples every package to commits
touching shared files. It also cannot supply the proof fields, which come
from a doctor run that happens after the release, not from the release
itself.

**Generate the whole scorecard.** Rejected as over-reach. The requirement
rows and condition matrices are argued positions, not records; rendering
them would force a schema onto reasoning that legitimately varies.

**Deduplicate the prose instead — one canonical record, four pointer
references.** This removes the five-copies root cause with no schema, no
renderer, and no markers. It is genuinely attractive and was not in the
original draft's alternatives. Not adopted **now** because the four sites
are not redundant copies of one record: each selects a different subset of
the chain for a different argument (R4 deliberately trails a loop behind
to argue attestation currency). Collapsing them to pointers is a
content decision about the assurance document, separable from this
storage decision, and belongs with the follow-up ADR where the per-site
projections are designed. Recorded here so it is evaluated there.

**Rewrite run ids and dates in place with a sync script.** Considered and
rejected during #644, and the reasoning still holds: cited run ids sit
among syntactically identical superseded records (25 id occurrences on one
`DEVELOPMENT.md` line, 20 in the scorecard R3 row, and the phrase
"re-recorded under the `<version>` install on `<date>` (`<id>`" appearing
six times in R3 alone — once current, five superseded), the only
distinguishing field is the version being changed, and whether a release
replaces the head record or prepends a link is an editorial judgment. This
ADR does not resolve that; it stops adding to the problem.

## Implementation notes

Not part of the decision, but required when it is implemented:

- `AGENTS.md` §Release process gains the store-authoring step. Its
  existing statements stay true under this ADR — `checkProofCitations` is
  retained and no script rewrites cited run ids or dates.
- The `retention-planner.mjs` tracked-file pin needs a regression test
  covering JSON records.
- The stale "appears five times" counts in
  `scripts/sync-doc-versions.mjs` and `scripts/check-doc-evidence.mjs`
  comments should be corrected to six while the surrounding code is
  touched.

## Amendments

### 2026-07-27 — four provenance and timing corrections found after acceptance

**Trigger**: the Plan-verify review of the backlog macro that schedules
this ADR's implementation read the Accepted text against the repo and
found three defects; a fourth surfaced from applying the first one's
lens to the neighbouring table rows. All four clarify or cascade — the
Decision's six items stay operatively accurate — so this is an
Amendment, not a supersedure (README §Amendments vs Supersedes).

**1. `proofs[].command` is not `observed`. Reclassified
`operator-attested`.**

The Context provenance table lists `command` among the `proofs[]`
sub-fields and sources the whole row from
`.agentic-plugins/runs/doctor/<id>/`. The doctor artifact does not hold
it. `plugins/runtime/scripts/doctor.mjs:5386-5399` builds the record as
a literal with exactly eight keys — `schema_version`, `runtime_version`,
`run_id`, `status`, `created_at`, `repo_root_pointer`, `report`,
`limits` — and nothing beneath `report` records the invocation. The
`*_command` keys that do appear are feature-surface probes
(`feature_surface.plugin_command: true`,
`plugin_command_status: {status, exit_code, error_code}`), which report
whether a host subcommand exists, not what was run.

The field is not dropped: both prose sites cite a proof invocation
(`runtime:doctor --permission-proof --execute-permission-proof
--deep-peer-smoke …`), so the store must be able to carry it. What was
wrong is the class. The command is a statement by the operator about
what they ran — the same kind of fact as `install_method` — so it is
**operator-attested**, and by Decision 4 it is therefore never gated.
The verifiable part of a proof stays the run id and the artifact content
hash; the command rides alongside as an attestation and must not be
presented as observed.

The alternative — change runtime to persist a sanitized normalized
command so the field becomes genuinely `observed` — is recorded and
**not adopted**. The artifact is deliberately sanitized output (its own
`limits[0]`: raw peer stdout/stderr and prompt text are not stored), so
persisting an invocation needs a scrubbing policy, and the read/report
secret boundary is an open question in the backlog rather than a settled
one this ADR may assume. It would also make a documentation-store schema
wait on a runtime release. If that runtime change is made later, moving
`command` from `operator-attested` to `observed` is strictly widening —
a field that was never gated becomes gateable — so no record authored
under this Amendment is invalidated by it.

**2. `derived` against the manifest means the manifest as it stood at
the cited tag.**

Decision 4 names "git and the manifest" as the sources for `derived`
fields, then enumerates only tag, squash, PR-number, and sha checks. The
implied manifest check is never stated, and its subject is `version` —
the one `package_releases[]` field the Context table sources from
`.release-please-manifest.json`. State the check, and state its
semantics: the comparison reads the manifest **at the cited tag**
(`git show <tag>:.release-please-manifest.json`), never the working
tree.

The working-tree reading is not merely imprecise, it is
self-invalidating. Measured here: the manifest at
`plugin-runtime-v0.83.0` reads `0.83.0` and at `plugin-runtime-v0.86.0`
reads `0.86.0`, while the working tree reads `0.86.2`. A validator
comparing against the working tree passes only the newest record and
turns every older one invalid at the next release — the store would fail
its own gate as a function of time.

**3. The schema slice authors no live record; the first one comes from
the release loop after it.**

Decision 1 starts the store "with the next runtime release loop". Read
against the implementation order that is unsatisfiable by the slice that
creates it: schema and validator must land before anything can be
authored against them, so the schema slice ships test fixtures only. The
first live record is authored by **the first runtime release loop that
follows the schema landing**.

This cascades into Consequences, because it moves a date that section
depends on. The withdrawal trigger — "two consecutive release loops in
which the store is authored but the follow-up ADR has not been opened" —
starts counting at that first live record, not at this ADR's acceptance
and not at the schema landing. A release loop that closes before the
schema exists is not a loop "in which the store is authored" and does
not count against the trigger.

**4. Membership of `feature_commits[]` / `hardening_commits[]` is
authored; only each entry's fields are `derived`.**

Item 1 is an instance of a general fault in the Context table: a row
carries one provenance label while a part of it belongs to another
class. The two commit-array rows have the same fault, labelled `derived`
wholesale. Each *entry's* fields genuinely are derived — a PR number and
a sha resolve and check for reachability. Which entries the array
*contains* is not, and neither is the split between the two arrays.

Measured on the loop this ADR already treats as one record
(0.86.0/0.86.1/0.86.2). Fifteen commits touch `plugins/runtime` in
`plugin-runtime-v0.85.0..plugin-runtime-v0.86.2`; the prose cites nine
as loop members and excludes six — three release commits and three
doc-recovery PRs — by category judgment, not by any rule a validator
could read. The stated source cannot supply the membership either:
`cd27d2d` (#632) is cited as one of the loop's feature PRs but is a
`refactor(...)` commit that release-please does not route, so it appears
in **no** changelog, while the row sources `feature_commits[]` from
"git + `plugins/runtime/CHANGELOG.md`". And the partition does not
follow the changelog's own headings: `3615dcc` (#629) is a `fix(...)`
commit that the prose places on the feature side of the narrative.

Consequence for the validator, which is why this is recorded rather than
left implicit: per-entry checks are in scope everywhere, and **array
completeness is explicitly not gated**. No source can back "you missed a
commit", and a check that guesses re-creates the unbounded
reconstruction-from-unstructured-input failure this ADR's Context
records for the prose parsers — the exact failure the decision exists to
stop.

**Unchanged**: Decision 1 (forward-only, keyed by evidence loop, closed
schema under `docs/assurance/evidence/`), Decision 2 (every field
declares its provenance — items 1 and 4 correct one classification and
add granularity beneath two rows; neither reverses the rule), Decision 3
(typed, plural relations), Decision 4's principle and its
`observed`-not-verified-in-CI asymmetry, Decision 5 (no rendering, no
generated regions, the prose stays hand-written), and Decision 6
(renderer and historical migration deferred behind two preconditions).
The headline cost in Consequences — on landing, the store adds a sixth
copy — is unchanged; item 3 fixes only when the withdrawal clock starts.
