# ADR-0049: Evidence as data — a validated record store for release/proof facts, forward-only

## Status

Accepted

> Amended 2026-07-27 — see [Amendments](#amendments). `proofs[].command`
> is reclassified `operator-attested`; the `derived` manifest check is
> pinned to the cited tag and bound to the package; membership of every
> per-loop array is authored while entry fields keep the row's class;
> and the first live record is dated to the first release loop that
> follows the schema, authored after that loop's release completes.

> Amended 2026-09-09 — see [Amendments](#amendments). Decision 6's
> precondition 2 is recorded met; precondition 1 is **not** replaced —
> its coverage half was never built and stands unmet, its exporter half
> is partly answered, and a third clause is added for the
> claim-versus-mention discriminator. In Consequences the "value is
> entirely contingent on the follow-up landing" premise is **withdrawn as
> measured-false** and the withdrawal trigger is retired and replaced. See
> [ADR-0058](0058-evidence-store-disposition.md).

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

The table's granularity is one class per row, and that is too coarse in
two places — see Amendment 2026-07-27 items 1 and 4: `proofs[].command`
is `operator-attested`, not observed, and membership of every per-loop
array is authored even where the entries' own fields are derived.

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
release loop (made precise by Amendment 2026-07-27 item 3: the first
loop that follows the schema, authored after that loop's release
completes), each evidence loop gets one JSON file under
`docs/assurance/evidence/`, closed schema, `additionalProperties: false`,
in the style of the runtime plugin's packaged `data/schemas/`. The key is
the **evidence loop**, identified by a stable `record_id` — not the
release. A record carries `package_releases[]` and `proofs[]` as arrays
precisely because a loop may span several releases and several proof
observations.

**2. Every field declares its provenance.** The schema tags each field
`derived`, `observed`, `operator-attested`, or `authored`, per the table
above as corrected by Amendment 2026-07-27 items 1 and 4 — the tag is
per field and per collection, not per table row. This is not decoration: it is what tells a gate whether it may
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
  reachability. These run everywhere, including CI. The enumeration is
  incomplete as written; Amendment 2026-07-27 item 2 adds the tag-time
  package/version binding and the marketplace-sync relation checks.
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
  **Split into three clauses by Amendment 2026-09-09, and NOT lowered** —
  the coverage manifest this bullet requires was never built and that
  clause stands unmet; the exporter was built and returned `fail` for a
  reason this bullet does not name. See
  [ADR-0058](0058-evidence-store-disposition.md) §Decision 2.
- **A resolution for the single-line table constraint**, satisfying
  `cutover-audit.mjs` and the five-cell row pin, or a design that moves
  the evidence out of those rows into a standalone section that the rows
  link to.
  **Met** — `docs/assurance/scorecard-evidence-design.md`; see Amendment
  2026-09-09.

## Consequences

**Positive.** The next release's record (Amendment 2026-07-27 item 3:
the first loop after the schema, authored once its release completes) is
authored once, in a validated shape, with its derived fields checked
against git at authoring time rather than reconstructed from prose
afterwards. The record unit finally
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
negative and the store should be withdrawn rather than maintained
*(these two sentences are **withdrawn as measured-false** by Amendment
2026-09-09: the store's proof-artifact verification and three derived
checks stand alone and do not depend on the follow-up; the sixth-copy
cost above is unchanged and still accurate)* —
**withdrawal trigger: two consecutive release loops in which the store is
authored but the follow-up ADR has not been opened.** *(Retired and replaced
by Amendment 2026-09-09 — crossed at the second qualifying loop and
continued to nineteen, and unfireable once the follow-up ADR exists.)* The recurring
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
lens to the neighbouring table rows. A cross-host review of the
resulting draft then sharpened three of the four — it caught that a
future `observed` flip would invalidate records rather than widen
freely, that a tag-time manifest read still admits the wrong package's
tag, and that a commit's PR number is not always derivable — and argued
for supersedure over amendment, which is answered under **Form** below.

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
(`docs/DEVELOPMENT.md`, `omcc-cutover-scorecard.md` R3 —
`runtime:doctor --permission-proof --execute-permission-proof
--deep-peer-smoke …`), so the store must be able to carry it. What was
wrong is the class. It is **operator-attested**, the same class as
`install_method`, and by Decision 4 it is therefore never gated. The
verifiable part of a proof stays the run id and the artifact content
hash; the command rides alongside as an attestation.

Define it as an attested **normalized recipe**, not "the command that
was run". The cited recipe is not the invocation that produced the
artifact: `--record` is what writes an artifact at all
(`plugins/runtime/commands/doctor.md`), and the wrapper supplies
`--repo-root`; neither appears in the prose. A record claiming to hold
literal argv would be false on its face, and a validator that later
compared the two would fail every historical record.

The alternative — change runtime to persist a sanitized normalized
command so the field becomes genuinely `observed` — is recorded and
**not adopted**. The artifact is deliberately sanitized output (its own
`limits[0]`: raw peer stdout/stderr and prompt text are not stored), so
persisting an invocation needs a scrubbing policy, and the read/report
secret boundary is an open question in the backlog rather than a settled
one this ADR may assume. It would also make a documentation-store schema
wait on a runtime release.

If that runtime change is made later, the flip is **not** a free
widening, and an earlier draft of this Amendment was wrong to say so. A
record authored today cites a doctor artifact that will never contain an
invocation; reclassifying the existing field to `observed` would demand
local verification against a value the artifact never stored, which
Decision 4's own rule turns into a failure rather than an
unverified. The flip therefore requires either a distinct new field for
the persisted invocation, or an explicit grandfather rule keying the
class to the runtime version that produced the cited proof. Whichever is
chosen, it belongs to the ADR that makes the runtime change.

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
reads `0.86.0`, while the working tree reads `0.86.2`. Because one
record carries several releases, a working-tree comparison passes only
the entries whose version happens to equal the current manifest and
fails the rest — including entries inside the newest record — so the
store would fail its own gate as a function of time.

Reading the manifest at the tag is necessary and not sufficient: the
check must bind **package, version, and tag together**. Tags are
per-package but commits are not. `plugin-runtime-v0.83.0` and
`plugin-attention-v0.6.0` are the same commit `e249ac7c`, so the
manifest read at either tag reports runtime `0.83.0`; a record naming
the attention tag for a runtime release passes a bare tag-time version
comparison. The binding needs the tag-time release configuration that
maps package to tag prefix, and it must fail closed on a missing tag,
file, or key rather than skipping.

The same enumeration understates marketplace sync. Its sha needs the
relation checks the repo already applies in
`scripts/check-doc-evidence.mjs` — descendant of the release commit,
expected sync subject, no intervening release — not bare resolution and
reachability.

**3. The schema slice authors no live record; the first one comes from
the release loop after it.**

Decision 1 starts the store "with the next runtime release loop". Read
against the implementation order that is unsatisfiable by the slice that
creates it: schema and validator must land before anything can be
authored against them, so the schema slice ships test fixtures only. The
first live record belongs to **the first runtime release loop that
follows the schema landing**.

A second timing constraint follows from what a record contains, and it
is the one most likely to be missed. A record cannot be authored inside
the implementation PR of the loop it describes. Its release tag, squash,
marketplace-sync sha, proof run id and artifact hash come into existence
only after that PR merges, release-please cuts the release, the catalog
sync lands, the hosts are updated, and a doctor run is recorded against
the new install. Authoring is therefore a **post-release step of the
loop**, in the same position the recovery PR occupies today — which is
also why this decision does not remove that PR.

The withdrawal trigger in Consequences needs no reinterpretation: it
already counts only loops "in which the store is authored", so
acceptance and the schema landing never counted. What this item adds is
which loop is the first that can be counted. *(Superseded by Amendment
2026-09-09 — that trigger is retired, so there is no longer a counter for
this item to date. The post-release authoring position this item
establishes is unaffected and remains operative.)*

**4. Membership of every per-loop array is authored, and even entry
fields split by class.**

Item 1 is an instance of a general fault in the Context table: a row
carries one provenance label while a part of it belongs to another
class. The arrays have the same fault, and its root is Decision 1
itself. The record's key is the **evidence loop**, and the loop boundary
is an editorial judgment this ADR asserts rather than derives — Context
constraint 1 collapses 0.86.0/0.86.1/0.86.2 into one loop on exactly
such grounds. What the loop contains inherits that: membership of
`package_releases[]`, `feature_commits[]`, `hardening_commits[]` and
`proofs[]` is **authored**. Nothing in git or an artifact can decide
which loop owns an entry.

The two commit-array rows are where the wholesale `derived` label bites
hardest, because their declared source cannot supply the membership.
Measured on that same loop: fifteen commits touch `plugins/runtime` in
`plugin-runtime-v0.85.0..plugin-runtime-v0.86.2`, and the prose carries
nine as feature/hardening members. Of the six it does not, three are
doc-recovery PRs and three are release commits — and one of those,
`9e2af7d`, the record does carry, as `package_releases[].squash` for the
loop's release triple. The same commit is in one array and out of
another on role, which is a judgment no source states. The declared
source falls short in the other direction too: `cd27d2d` (#632) is
carried as one of the loop's feature PRs but is a `refactor(...)`
commit, and no `refactor` entry appears anywhere in
`plugins/runtime/CHANGELOG.md`, while the row sources
`feature_commits[]` from "git + `plugins/runtime/CHANGELOG.md`". Nor
does the feature/hardening split follow the changelog's headings:
`3615dcc` (#629) and `73127e3` (#635) are both `fix(...)` commits the
prose places on the feature side of the narrative.

Entry fields do not carry one class either. A sha is derived — it
resolves and checks for reachability. A PR number is derived only when
the declared source carries it: `b984dc8` names `#637` in both its
commit subject and its changelog entry, while `af620df` and `c549ed2`
name no PR in either, and their association with `#641` and `#639`
lives only in prose. The repo already knows this class exists —
`validate:doc-evidence` reports one PR number as not offline-verifiable
— so the schema must let a PR be attested rather than force every entry
to claim a derivation nothing can back.

Consequence for the validator, which is why this is recorded rather than
left implicit: per-entry checks are in scope everywhere, and **array
completeness is not gated by category**. No source states which commits
a loop should contain, and a check that infers it re-creates the
unbounded reconstruction-from-unstructured-input failure this ADR's
Context records for the prose parsers. What is available, and is left
open to the schema slice rather than foreclosed here, is accounting
rather than inference: git can bound the candidate range, so an explicit
disposition of every commit in it — included, or excluded with an
authored reason — could be gated for exhaustiveness without pretending
the category itself is derived.

**Unchanged**: Decision 1 (forward-only, keyed by evidence loop, closed
schema under `docs/assurance/evidence/`), Decision 2 (every field
declares its provenance — items 1 and 4 correct one classification and
push the granularity below the table row; neither reverses the rule),
Decision 3 (typed, plural relations), Decision 4's principle and its
`observed`-not-verified-in-CI asymmetry, Decision 5 (no rendering, no
generated regions, the prose stays hand-written), and Decision 6
(renderer and historical migration deferred behind two preconditions).
The headline cost in Consequences — on landing, the store adds a sixth
copy, and the recurring recovery PR is not eliminated — is unchanged,
and item 3 reinforces it: authoring happens after the release, in the
position that PR already occupies.

**Form — Amendment, over a recorded dissent.** The cross-host review of
this Amendment argued for partial supersedure instead, on the grounds
that Decision 2 imports "the table above" and items 1 and 4 correct
entries in that table, while item 3 makes Decision 1's timing anchor
precise. The dissent is recorded rather than adopted, for three
reasons. The README's discriminator turns on whether "a reader landing
on the old ADR must be pointed at the new one for the operative
decision" — here the correction is in the same document, and the repo's
established remedy for a reader landing on superseded prose is the
in-place pointer, used by ADR-0010's header banner and by ADR-0008's
inline "see Amendment 2026-05-04"; both are now applied above. The
precedent is stronger than the parity: ADR-0010's 2026-07-09 amendment
corrected values inside its own **Decision** §1 — dropping `image`,
`print`, `brand` and `motion` from the L4 row — and remained an
Amendment, whereas items 1 and 4 correct a **Context** table that a
Decision points at. And splitting a decision accepted one day earlier
across two documents would consume the ADR number that Decision 6
reserves for the renderer/migration follow-up, which is the ADR a reader
actually needs pointing at. If the follow-up disagrees, it supersedes
from a position of knowing the schema — this Amendment does not
foreclose that.


### 2026-09-09 — the preconditions measured: one met, one split and still unmet, and a trigger that had already died

**Trigger**: [ADR-0058](0058-evidence-store-disposition.md), written
against the two preconditions Decision 6 defers behind. It takes the ADR
number this ADR reserved **without being the ADR it was reserved for** —
the renderer/migration decision still cannot be written, and ADR-0058
declines to be it. ADR-0058 carries the measurements; this Amendment
records what changes here. Its first draft was corrected by a cross-host
review that disproved nine of its claims, and items 2 and 3 below are
what survived that.

**1. Precondition 2 is met.** `docs/assurance/scorecard-evidence-design.md`
resolves the single-line table constraint: each evidence cell becomes an
authored bounded claim plus a pointer to a same-file record section under
an anchor derived from the row id, held in place by four
mutation-verified assertions. Its implementation is independent — it does
not wait on rendering, and rendering no longer waits on it.

**2. Precondition 1 is split into three clauses and is NOT lowered.** The
bullet reads as one requirement and is two: an exporter *and* an
independent coverage manifest pinning expected record ids, proof ids,
tags and field identities. Only the exporter was built. Measured: the
corpus manifest's entries carry `path`, `blob` and `bytes`, and the string
`record_id` appears zero times in the manifest, in the oracle, and in the
lane artifact. **The coverage clause therefore stands unmet**, and the
circularity this bullet exists to prevent is still unguarded.

The exporter clause was answered in part. Required-role pairing is
perfect across the 201 anchors both sides bound — all five `mispaired`
rows differ on an optional role only — but the verdict is `fail`, and its
156 disagreements are not one thing: **116** are one side seeing a claim
where the other sees none, and **40** are rows where both see a claim and
the exporter did not supply a required binding. The 40 are ordinary
extractor work. The 116 are not: a rule can locate the right occurrence
and cannot judge whether a sentence asserts a relation or merely mentions
one.

ADR-0058 §Decision 2 therefore states precondition 1 as **(a)** the
unbuilt coverage manifest, **(b)** the exporter with its 40-row residue,
and **(c)** a new clause — an adjudicated source of truth for the
claim-versus-mention discriminator, or a scope restriction to relation
families where it does not arise. Any future verdict must state or
measure its own error bar: this one rests on 156 rows two annotators
agreed on and both self-reported `interpretive`.

Decision 6's operative condition is unchanged by this: two preconditions,
both required, neither met.

**3. The contingency premise is withdrawn, and the withdrawal trigger is
retired and replaced.** Consequences states that the store's "value is
entirely contingent on the deferred follow-up landing" and that without
it "this decision is net negative". Measured, the store is the only
reader in the repository that opens each cited *historical* doctor
artifact and verifies its bytes (23 of 23 on the maintainer checkout),
and it enforces the tag-time package/version binding, the
null-`marketplace_sync` claim, and the forward-only floor — none of which
depends on rendering. **The premise is withdrawn as measured-false. The
headline cost it sits beside — on landing this adds a sixth copy, and the
recurring recovery PR is not eliminated — is unchanged and still
accurate.**

The trigger counted "two consecutive release loops in which the store is
authored but the follow-up ADR has not been opened". It was crossed at the
second qualifying loop and ran to nineteen — 19 authored records, ADRs
0050–0057 each a different subject — and opening ADR-0058 makes the
counted condition permanently false, so it can never fire again however
long rendering stays blocked. It measured whether a document exists.

The replacement, stated in ADR-0058 §Decision 5, is **two consecutive
`plugin-runtime` release tags within the store era that appear in no
record's `package_releases[]`**, with an explicit evaluation contract. It
is derived-only, so it needs none of the authored membership judgment item
4 above protects; it cannot be retired by writing a document; and it is
published measured clean (19 runtime tags in era, 0 uncovered). ADR-0058
also records what it does **not** establish — it is a minimum tag-coverage
floor, not proof that loops are being authored, and a consolidation
control there shows the trigger staying clean while the store loses every
verified proof.

**Unchanged**: Decision 1 (forward-only, keyed by evidence loop, closed
schema), Decision 2 (every field declares its provenance), Decision 3
(typed, plural relations), Decision 4 (gates validate only what their
source can back, including the `observed`-not-verified-in-CI asymmetry),
**Decision 5 (no rendering, no generated regions, the prose stays
hand-written)**, and Decision 6's structure and gating condition — the
renderer and the historical migration remain deferred behind two
preconditions that are still not both met.

**Form — Amendment, over a second recorded dissent.** The cross-host
review of ADR-0058 argued for partial supersedure of Decision 6, on the
ground that a draft replacing precondition 1 while declaring itself the
reserved follow-up would leave a reader here needing another document for
the operative rule. Against that draft the argument was sound. It is not
adopted against this one, because the same review's coverage-manifest
finding removed its premise: precondition 1 is added to rather than
replaced, Decision 6's gating condition is untouched, ADR-0058 explicitly
declines to be the reserved follow-up, and clauses (a)/(b)/(c) are stated
in full above — so a reader landing here gets the operative rule without
leaving. The dissent is recorded for the same reason the 2026-07-27 one
was: if the renderer ADR later disagrees, it supersedes from a position of
knowing what the coverage clause costs.
