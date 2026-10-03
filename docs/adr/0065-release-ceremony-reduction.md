# ADR-0065: Release ceremony reduction — the repository stops restating, proving and recording each release; the catalog sync stays

## Status

Proposed (2026-10-04). Asked for by the owner on 2026-10-03 (macro
`macro-plan-20261003T022443Z-139657`, item B: "reduce CI, test and release
machinery to what earns its keep"). The owner accepts it, and the commit that
accepts it applies [§Amendment cascade](#amendment-cascade-apply-verbatim-on-acceptance).

- **On acceptance** it:
  - supersedes [ADR-0049](0049-evidence-as-data.md) **in full**. No evidence
    record is authored or validated again. The records already written stay
    as frozen history (Decision 4);
  - supersedes [ADR-0058](0058-evidence-store-disposition.md) **in full**.
    Its subject, what to do with the store, is decided here. The
    renderer/migration ADR that ADR-0049 §Decision 6 reserved is cancelled,
    not deferred;
  - supersedes [ADR-0052](0052-release-obligation-enforcement.md) **in
    full**. The release-obligation check goes (Decision 5);
  - amends [ADR-0033](0033-ci-full-test-suite-coverage.md): Decision 3's
    branch-keyed lag detection, Decision 5 (iii)'s guard on that wiring, and
    the 2026-10-03 amendment's accepted cost "The post-sync dispatch still
    validates `main`";
  - amends [ADR-0061](0061-codex-installs-pinned-to-release-commits.md):
    §Decision 2's "Release-PR lag" state and its first-release exemption, the
    clause about the sync commit subject that the evidence store recognizes,
    and §Decision 8's requirement that machine acceptance record an
    evidence-loop record;
  - amends [ADR-0060](0060-remove-host-version-tracking.md) Decision 5, which
    kept the release-obligation mechanism and its reasoning;
  - reverses review-docket item **A1**. On 2026-08-28 the owner chose B there:
    keep the store and open a follow-up ADR, which became ADR-0058. The owner
    reopened that decision on 2026-10-03.
- **No status change** for [ADR-0051](0051-host-parity-baseline-source.md).
  ADR-0060 superseded it in full on 2026-09-18. AGENTS.md still cites its
  §Decision 2 as the obligation ADR-0052 enforces; that sentence goes with
  the rest of the release-process text (Decision 11).
- **Replaces** the derivable / proof-coupled split that AGENTS.md
  §Release process states. AGENTS.md is not an ADR; its text changes with
  the implementation (Decision 11).
- [ADR-0064](0064-runtime-surface-reduction.md) is Proposed. Its Decision 5
  takes the scorecard out of the stage-doc pipeline, which this ADR does
  first (Decision 7). Its Decision 7 says a release is installed on both hosts
  before a new proof is recorded, because an older reader on the other host
  counts the new artifact `malformed` (`doctor.mjs:124`); that skew rule still
  holds whenever a proof is recorded, and this ADR removes only the obligation
  to record one (Decision 2). A Proposed ADR is not amended from outside: its
  own acceptance subtask, R0, realigns it.

Docs-only. Two subtasks of the same macro implement it: B1 (the doc and
evidence pipeline, and the release-obligation gate) and B2 (the release
pipeline: catalog lag and the post-sync dispatch).

## Context

### What one release costs today

A `plugin-runtime` release runs this sequence today (AGENTS.md §Release
process):

1. The owner merges the release PR. The release commit's own push run reads
   both catalogs before the bot has synced them, so its catalog and version
   checks fail. That run is red by design (docket C58).
2. The release job syncs both catalogs and pushes a bot commit. It then
   rewrites the stage docs' `as of plugin-runtime vX` tokens and pushes a
   second bot commit. Because a `GITHUB_TOKEN` push starts no workflow, it
   dispatches `full-tests` and `validate` on post-sync `main`. Last, it
   asserts the release obligation.
3. `main` stays red on the proof-coupled assertion until a person:
   - installs the release on both hosts;
   - re-records a `runtime:doctor` proof;
   - hand-edits "Latest installed proof" and the scorecard's installed-state
     versions;
   - authors an ADR-0049 evidence record;
   - and lands all of that as a recovery PR.
4. Separately, a change to a protected packaged asset turns `main` red until a
   `plugin-runtime-v*` tag carries it (ADR-0052).

### Measured cost

Measured at `da61972e` (2026-10-03). Lines are `wc -l` of tracked files;
commits are non-merge commits on `main`.

| # | Item | Code and tests | Data and prose | Commits | `main` red |
|---|---|---|---|---|---|
| 1 | stage-doc version sync | 963 | 3 tokens left | 27 bot syncs since 2026-07-28; 149 commits edited a token line | 191.5 h on the release commit, overlapping 2; about a minute once the bot sync lands |
| 2 | proof coupling and recovery PR | 43-line freshness case, plus item 1's proof rules | the proof prose: two lines of `DEVELOPMENT.md` (72,818 bytes), 133 scorecard lines | 95 recovery PRs, 14,002 changed lines | 247.9 h in 48 windows (median 1.3 h, max 28.2 h) |
| 3 | doc-evidence gates | 1,777 | the corpus manifest | 7 | 0 |
| 4 | evidence store and measurement substrate | 8,517 | 28 records (3,999 lines); 147,913 lines of measurement data | 11 code, 28 records | — |
| 5 | release obligation | 1,577 | — | 5 | 30.1 h in 12 windows (median 2.9 min, max 20.6 h) |
| 6 | post-sync dispatch | 1,032 | — | 2 | — |
| 7 | scorecard in the pipeline | (in 1–3) | 2,927 lines | 126 | (in 2) |
| 8 | branch-keyed lag allowance | spread over 2 validators, 7 test files, 2 workflows | — | 7 | every release commit (74 of 74 since 2026-07-01); 99.3 h not covered by another cause |

The `main red` column covers 2026-07-05 to 2026-10-03 (2,175 hours), the span
for which every failed job's log is still readable. A window opens at the first
red commit and closes at the next all-green one; windows overlap, so a window
counts under each cause it contains. Over that span `main` was red for 377.6
hours, 17.4% of the time, and 99.4% of that was by design. A real defect alone
made it red for 0.35 hours: two jobs that hung on 2026-07-09 and passed on
re-run. Two more real failures, a brittle manifest test and the C56 teardown
flake, fell inside windows that were already red by design.

Items 1–6 add up to 13,909 lines of code and tests. The machinery's own
scripts and tests took 19 commits in 18 PRs and 13,080 changed lines to build
and repair. In AGENTS.md, 199 of the 267 lines of §Release process (231–429)
describe items 1–6.

### What the ceremony has caught

Measured from commit subjects and bodies on `main`. A failure fixed before its
commit leaves no trace there, so these are lower bounds.

**The recovery's proof and install: 7 defects in released code, in 95
recoveries** (3 of them in the 29 recoveries of the record era):

| # | Recovery | Defect | Fix |
|---|---|---|---|
| D1 | `67c2e1f4` #486 (0.72.0) | doctor reported a false packaging gap for the hook-only attention plugin | same PR, 0.72.1 |
| D2 | `a90bfdf0` #530 (0.77.0) | doctor read an absent Codex hook `enabled` key as disabled, so attestation was impossible | same PR, 0.77.1 |
| D3 | `bd8d3586` #542 (0.78.0) | doctor misread trusted attention hook entries | `aaf376d1` #543, 0.78.1 |
| D4 | `682ef9ee` #636 (0.86.0) | three bootstrap dogfood findings, recorded as follow-ups | 0.87.0 and 0.88.x |
| D5 | `f62b4989` #779 (0.97.2) | a regression shipped since 0.90.2 told every healthy doctor run to upgrade the runtime | `7a77beff` #780, 0.97.3 |
| D6 | `68438b9e` #834 (0.99.1) | Codex refused the runbooks' `rm -f` cleanup (docket C74) | `e348d588`, 0.99.2 |
| D7 | `ae42de7e` #840 (0.99.2) | `$REPO_ROOT` used but undefined in 9 of 10 runtime Codex skills since #479 (docket C78) | none on `main` |

D1–D3 and D5 are doctor misreading its own inputs, which only a doctor run
shows. D4, D6 and D7 came from installing and using the release. D5's subject,
`runtime:compat`, has since been removed (ADR-0060).

**The stage-doc sync** refused hand-edited tokens at `16b1833c` and twice at
`4d9805ec`. It protected the tokens it exists to keep.

**The evidence store**: no commit records it catching a wrong record. The one
wrong record on file, a wrong hook attestation cited at `b1d66e38`, was caught
in review. Its byte check of the cited proof artifacts verifies 34 of 34 on the
owner's machine; the artifacts are gitignored, so in CI it verifies none.

**The sha check**: two citations of an orphaned branch commit when it was built
(#644).

**The release obligation**: 12 red windows since 2026-07-05, each closed by an
ordinary release; 10 of them within 0.54 hours. None was a change that would
otherwise have missed a release.

### The line the owner drew

Keep what protects **shipped behavior**: the bytes a user installs. That is
the Claude catalog version sync, the ADR-0061 Codex pin sync, and the
validation of both. Everything else in the list protects the repository's
prose about its releases, or its record-keeping of them. Each item below is
judged against that line, with what it protected and what is lost stated
rather than argued away.

## Decision

The numbering follows the eight items the macro named, so each decision can be
traced to its question.

### Decision 1 — The stage docs stop restating shipped versions

**What it protected.** The `as of plugin-runtime vX` statements in
`docs/ARCHITECTURE.md` and `docs/DEVELOPMENT.md` stayed true without hand
edits, which had produced mis-paired release triples (#640).

**What it costs.** `scripts/sync-doc-versions.mjs` (441 lines) and its test
(488), plus the derivable-token case in `tests/plugin-shape/test-runtime-plugin.mjs`;
three release-job steps; 27 bot commits since 2026-07-28. 149 commits have
edited a line carrying one of these tokens. Three tokens are left today:
`ARCHITECTURE.md:257`, `DEVELOPMENT.md:57-58` and `DEVELOPMENT.md:572`.

**Decision.** The docs stop making the statement, rather than keeping it
true. A shipped version is read where release-please writes it:
`.release-please-manifest.json`, each package's `CHANGELOG.md`, and the
`plugin-<name>-v*` tags. `scripts/sync-doc-versions.mjs`, `npm run
sync:docs`, the release job's stage-doc sync, verify and push steps, and
their tests go.

**Lost.** A reader of `ARCHITECTURE.md` no longer sees which runtime version
the text was written against. The changelog answers that for any feature.

### Decision 2 — No proof is coupled to a release; the recovery PR ends

**What it protected.** A procedure, with a token check standing in for it.
The procedure: after every runtime release, install it on both hosts and
record a `runtime:doctor` proof against it (`permission_proof`,
`workflow_continuation_proof`, `deep_peer_smoke`). That is the only step that
ran the released bytes, as installed, before the release counted as done. CI
never verified that run. It checked that the prose tokens had moved to the
manifest version (`test-runtime-plugin.mjs:885`); the sync reads the local
proof pointer only where one exists (`sync-doc-versions.mjs:306`), and in CI
the store reports every cited artifact unverified. So `main` turned green when
the tokens were edited, and the proof was the procedure's, not the gate's.

**Where it lives.** The statement is the tail of one row:
`DEVELOPMENT.md:466`, the ADR-0012 condition-2 row, kept on one physical line
of 14,412 characters ("Latest installed proof: `plugin-runtime` `0.99.2`").
The scorecard repeats the version at four lines and the tag at one.
`sync-doc-versions.mjs` reads `.agentic-plugins/runs/doctor/latest.json` and
fails on `proof-not-recorded`; `test-runtime-plugin.mjs:867-909` asserts the
same tokens against the runtime manifest.

**What it costs.** 95 recovery commits between 2026-05-17 and 2026-09-30, every
one a PR, 14,002 changed lines. The 29 of the record era (#654–#840) changed
9,137 lines, a median of 265 per PR. In CI, `main` was red on this assertion
for 247.9 hours in 48 windows between 2026-07-05 and 2026-10-03, a median of 1.3
hours and at most 28.2; it is 65.6% of all red time in that span. The longest
wait in the whole history was 165.7 hours (0.68.0, #429).

**What it caught.** 7 of the 95 recoveries found a defect in released code
(§Context, "What the ceremony has caught"). That is the case for the ritual,
and it is real. Four of the seven were `runtime:doctor` misreading its own
inputs, which only a doctor run can show; the other three came from installing
and using the release.

**Decision.** That coupling ends. `main`'s state no longer depends on the
owner's machine. The "Latest installed proof" statement and the scorecard's
installed-state versions are no longer written, so nothing asserts them. The
recovery PR, the step that re-records a proof after each release, and the
`proof-not-recorded` assertion go.

The condition-2 row stays, because `runtime:cutover` parses it until subtask X
retires the audit, and `tests/runtime/test-cutover-audit.mjs` reads the real
file to keep that parse honest: a recovery once dropped the row's closing `|`
(`2c38052`, #736, 2026-08-25), and the live audit reported condition 2 missing
until the guard landed with #803 on 2026-09-23. That defect was itself a cost of
the ritual: the recovery rewrote a parsed line by hand after every release.
B1 removes the proof statement from the row's tail and keeps the row one line
with its four cells; that test guards it.

**Replacement: the check stays, as a habit, without a gate or a record.**
`runtime:doctor` stays, with every proof it runs. AGENTS.md §Release process
says: after installing a `plugin-runtime` release on a host, run
`runtime:doctor` with its proofs there, and treat a failure as a defect to fix
forward. That keeps the step that found the seven defects. What goes is
everything around it: `main` waiting on it, the hand-edited tokens, the record,
and the PR. The proof stays local, gitignored state, as it always was, and no
repository file cites it. When it is recorded, ADR-0064 Decision 7's skew rule
still applies: install the release on both hosts first.

**Machine acceptance under ADR-0061.** ADR-0061 §Decision 5 (b) counts a
machine as isolated from `main` once, among other things, "the evidence under
Decision 8 is recorded", and §Decision 8 names that evidence: a fresh doctor
proof and an evidence-loop record of the sibling roots, the receivers' state
and an eight-package cache comparison. The owner's machine passed it, and its
record (`the-machine-that-took-the-pins.json`) is frozen with the rest. For any
later machine the acceptance is the same checks, run by the operator on that
machine; it produces no repository record. §Amendment cascade item 5 says so in
ADR-0061.

**Lost.** Nothing enforces the habit. A release nobody runs doctor against is
found broken when it is used, and a doctor defect like four of the seven may go
unseen until someone reads a report closely. Detection was also never the same
as repair: the seventh defect (`$REPO_ROOT` undefined in 9 of 10 runtime Codex
skills, docket C78) was found by the 0.99.2 recovery and has no fix on `main`.
This ADR proposes that trade in line with the owner's 2026-10-03 direction,
real-use feedback over a ritual that holds `main` red, and puts the seven
defects in front of the owner before acceptance rather than after.

### Decision 3 — The doc-evidence gates go, the sha check with them

`scripts/check-doc-evidence.mjs` runs three prose checks and the store check.

| Check | What it protected | After Decisions 1, 2, 4 |
|---|---|---|
| release triples | a `(release PR, squash, tag)` triple cited in a stage doc names a real tag and its release commit | no new triple is written; the existing ones are frozen and were already verified |
| proof citations | a record presented as current cites the newest proof run id, with a matching date | no proof is cited as current any more |
| commit shas | every sha cited in `docs/**` or at the root resolves and is reachable from `main` | still has a subject: any document can cite a sha |
| evidence store | Decision 4 | withdrawn |

Run read-only at `da61972e`, the checks covered 91 release-triple claims, 2
proof-citation claims with 149 id/date pairs, 901 shas in 101 files (24
exempted through the corpus manifest), and 28 records with 34 proofs, with 0
findings. `scripts/check-doc-evidence.mjs` is 950 lines and its test 827.

**Decision.** All four go, with `npm run validate:doc-evidence`, its CI step,
its tests, and the corpus manifest that exists to feed the sha check its
exemptions. All 24 exempted tokens sit in the measurement substrate Decision 4
deletes, so the two leave together; deleting the manifest while keeping the
check would produce 24 findings.

The sha check is the one with a live subject, so its loss is the one this
decision pays. When it was built it caught two citations of a branch commit a
squash merge had orphaned (ADR-0049 §Context, #644). How often it fired since is
not measurable from history, because a failure fixed before the commit leaves no
trace. Without it, a document can cite such a commit again. It protects the
repository's citations, not anything a user installs, and the owner's line puts
it on the removed side. A smaller standalone sha lint was considered and is
recorded in §Alternatives.

### Decision 4 — The evidence store is withdrawn

**What it protected.** ADR-0058 Decision 4 kept the store for what it does on
its own: it is the only code that opens each cited historical proof artifact,
hashes its bytes and compares the transcribed run id, date and version; and it
applies three derived checks no prose gate applies (the tag-time
package/version binding, the null-sync claim, the forward-only floor). Its
measurement substrate (`evidence-corpus`, `evidence-measurement`,
`evidence-bundle`, the family registry and the association-policy measurement)
supports a renderer that ADR-0058 Decision 1 found blocked: 116 of 156
disagreeing rows are a claim-versus-mention judgment no extractor makes.

**What it costs.** 4,095 lines of source, 4,422 of tests, and 147,913 tracked
lines of measurement data (4.4 MB, 27 files). 28 records (3,999 lines) were
authored between 2026-07-28 and 2026-09-30, one per loop, covering 34 release
squashes and 67 package tags, every `plugin-runtime` tag from 0.86.3 to 0.99.2
among them. The measurement apparatus ADR-0058 added (bundle, corpus,
measurement, family registry and their tests) is 5,499 of the code and test
lines above.

The records have one reader besides the validators:
`runtime:retention`'s tracked-file scan (`scanTrackedDocCitations` in
`plugins/runtime/scripts/lib/retention-planner.mjs`), which pins every run id a
tracked file cites. Five run ids are cited by the records alone; ADR-0058
measured on 2026-09-09 that each is also pinned by at least one other source.
Freezing the records keeps all of those pins either way.

**Decision.** The store is withdrawn.

- **Stops:** authoring records. No release loop gets a record.
- **Deleted:** the validators and the tooling, and their npm scripts
  (`validate:evidence-store`, `validate:evidence-corpus`,
  `validate:family-registry`, `validate:evidence-bundle`), tests and inline
  fixtures:

  | Module | Lines | Its tests |
  |---|---|---|
  | `scripts/check-evidence-store.mjs` | 46 | `test-evidence-record-store.mjs` |
  | `scripts/lib/evidence-store.mjs` | 653 | 〃 |
  | `scripts/lib/evidence-schema.mjs` | 324 | 〃 |
  | `scripts/evidence-corpus.mjs` | 767 | `test-evidence-corpus.mjs` |
  | `scripts/evidence-measurement.mjs` | 1,122 | `test-evidence-measurement.mjs`, `test-artifact-schema.mjs`, `test-lane-s1-exporter.mjs` |
  | `scripts/evidence-bundle.mjs` | 308 | `test-evidence-bundle.mjs` |
  | `scripts/check-family-registry.mjs` | 363 | `test-family-registry.mjs` |
  | `scripts/measure-association-policy.mjs` | 358 | `test-measure-association-policy.mjs` |
  | `scripts/json-schema-mini.mjs` | 154 | no consumer outside the rows above |

  The measurement substrate under `docs/assurance/evidence/measurement/` goes
  with them: its only readers are that tooling and the corpus manifest of
  Decision 3. It includes the retained lane artifact, the one tracked file over
  the retention scanner's 1 MiB cap, so deleting it also lets
  `runtime:retention`'s citation scan complete again (ADR-0058 §"Three claims"
  item 1). Git history keeps every byte of it.
- **Frozen:** the 28 records under `docs/assurance/evidence/records/`, the
  schema that describes them, and the two design documents only ADR-0049 and
  ADR-0058 cite (`docs/assurance/scorecard-evidence-design.md`,
  `docs/assurance/scorecard-consumer-inventory.md`) stay where they are,
  unedited. The evidence README gets a dated note that nothing authors or
  validates the records any more. They are history, and the run ids they cite
  stay pinned by retention's tracked-file scan exactly as before, which keeps
  those runs on disk (§Alternatives).
  `docs/assurance/evidence/autopilot-probes-2026-09-24/` is not part of the
  store: it is ADR-0063's probe record and is untouched.
- **Cancelled:** the renderer and the historical migration that ADR-0049
  §Decision 6 deferred. With no store and no restated prose, there is nothing
  to render and nothing to migrate. Open PR
  [#758](https://github.com/each4all/agentic-plugins/pull/758)
  (`feat/evidence-measurement-contract`, 9 files, +2,477, open since 2026-08-29) builds on that substrate
  and is closed unmerged.

**Lost.** The byte-level verification of the cited proof artifacts, and the
three derived checks. They verified a record of a release, not the release.

### Decision 5 — Release-obligation enforcement goes; a commit-type rule replaces it

**What it protected.** `runtime` commands read
`plugins/runtime/data/plugin-set.json` and `plugins/runtime/data/schemas/**`
from the installed plugin. ADR-0052 made `main` red from the moment one of
those changed until a `plugin-runtime-v*` tag carried the change. The case it
was written for was `16b1833`, a `docs:`-typed baseline change that routed no
release and left released and repository bytes apart for 54 hours.

**Measured since it was adopted.** From 2026-07-05 it made `main` red in 12
windows, 30.1 hours in all. Ten closed within 0.54 hours, at the next release;
the two long ones were the assurance-record chain of 2026-08-17 (20.6 hours) and
ADR-0060's deletion of the baseline on 2026-09-28 (8.4 hours). AGENTS.md's
"measured median window is 5.3h" is ADR-0052's measure of the baseline's
divergence from its released copy before the check existed; with the check, the
median window was 2.9 minutes. The baseline that
produced most of its red windows was deleted by ADR-0060. The two paths left
changed 6 times between ADR-0052's adoption (2026-08-13) and 2026-10-03, the
last on 2026-08-28. All 6 carried a release-routing `feat` type, so release-please
released each of them without help. The check never stood between a change
and a missed release in that period.

ADR-0061 has since closed the failure ADR-0051 found behind this one: Codex
installed `main`'s bytes under a released version. Codex now installs only the
commit a release tag peels to. What remains is the property every package file
already has: `main` may be ahead of the last release until the next one.

**Decision.** `scripts/check-release-obligation.mjs` (591 lines),
`npm run validate:release-obligation`, the release job's post-tag verify step,
its two tests (919 lines) and its mutation spec go. It imports
`gitHistoryAvailable` from `check-doc-evidence.mjs`, so it leaves in the same
change as Decision 3 (B1).

Two open rows in `plugins/runtime/docs/follow-ups.md` lose their subject and
are closed by this decision: whether to widen the protected set to
`data/released-receiver-shapes.json`, and the release-version comparators that
disagree on grammar, whose last live member is this check. Rows that mention
the check in passing are dated audit records and stay.

**Replacement.** One sentence in AGENTS.md §Release process, enforced by review
like ADR-0016: a change under `plugins/runtime/data/` carries a release-routing
type (`feat` or `fix`) on its squash subject, so release-please releases it.

**Lost.** More than the commit type. The check compared the protected tree
against the released tree, so it also caught protected bytes that a correctly
typed commit added after the manifest had already advanced, and any other way
accepted bytes could miss a release. After this decision nothing asserts that
accepted protected bytes reached a release. The commit-type rule states the
intent to release, not that the release happened.

A change that misses a release ships with the next runtime release. That gap is
not short: ADR-0052 measured a release roughly every 15 hours, but since
0.86.3 the gaps between `plugin-runtime` tags have a median of 39.6 hours and a
maximum of 373.6 hours (0.97.1 → 0.97.2, 15.6 days), and 6 of 26 exceeded 72
hours.

### Decision 6 — The post-sync CI dispatch goes

**What it protected.** The bot's sync commits start no workflow, so without the
dispatch the tree after a release never got CI of its own.

**Decision.** `scripts/dispatch-post-sync-ci.mjs` (262 lines), its
release-job step, its test (604 lines) and its 23-mutation spec (166 lines) go,
and the release job drops `actions: write` and the `pushed` outputs only that
step reads. It landed on 2026-09-27 (#823) and was retargeted by A1 on
2026-10-03, so it is the youngest item here. Two
things make the dispatched runs redundant once Decisions 1 and 8 are in place:

- After Decision 1 the only bot commit is the catalog sync. It changes the two
  catalogs and the pin-floor data file and nothing else, and the release job
  already validates exactly those with the gates `validate.yml` runs, before it
  pushes (`sync-marketplace-versions.mjs`; ADR-0061 §Decision 2).
- After Decision 8 no test reads a catalog's version, ref or sha, so `npm test`
  over the post-sync tree is `npm test` over the release commit, which already
  ran.

B2 verifies the second claim against the suite before it removes the step.
Two readers are already known. The sync also adds a package's **first** Codex
entry when that package is released for the first time, and two tests compare
the Codex catalog's names with the plugin set, phase-aware through the tags:
`tests/runtime/test-plugin-set.mjs` and `tests/plugin-shape/test-runtime-plugin.mjs:374`.
Both read tags across the whole repository (`hasReleaseTag` in
`scripts/lib/codex-catalog-pins.mjs`, and the test helper's copy), so their
verdict on a fixed tree can change when a tag is cut. Decision 8 rules 2 and 3
settle both; B2 moves the comparisons into the validator or applies the same
rules. If any test that reads the synced fields remains, it moves into the
validators or the dispatch stays; the decision does not survive a
counterexample.

**Lost.** The commit at `main`'s head right after a release shows no CI
status. The next person's push to `main` runs the full suite over it.

The retry path is unchanged: a manual dispatch of `release-please.yml` re-runs
the catalog sync, because release-please reports `releases_created` only once.
Review-docket A1's pending item (b), a live dispatch of `release-please.yml` to
exercise the post-sync dispatch, loses its subject.

### Decision 7 — The scorecard leaves the stage-doc pipeline and is frozen

`docs/assurance/omcc-cutover-scorecard.md` (2,927 lines; 126 commits, 11 of
them since 2026-09-01, 8 of those post-release recoveries) is the third stage
doc. Its installed-state versions and proof citations are Decision 2's
tokens; `sync-doc-versions.mjs` rewrites it and `check-doc-evidence.mjs` gates
it.

**Decision.** It gets a dated note that it is a frozen record of the omcc
cutover. Nothing rewrites it, and no gate checks its tokens or citations. One
test keeps reading it: `test-runtime-plugin.mjs:935` pins its twelve
requirement rows as single physical lines so the audit sees all of them, and it
stays until the audit goes. Its rows are not edited:
`runtime:cutover` (`cutover-audit.mjs`) still parses its requirement rows, and
the ADR-0012 condition matrix in `docs/DEVELOPMENT.md`, until ADR-0064
Decision 5 retires the audit (subtask X). The audit compares installed versions
with `.release-please-manifest.json`, not with the scorecard's text, so
freezing the text changes no verdict.

### Decision 8 — Catalog lag is tolerated where a release produces it, and nowhere else

**The problem (docket C58).** The catalogs trail the manifest for exactly one
commit: the release commit, between release-please's merge and the bot's sync.
The allowance today is keyed on the **branch**: `AGENTIC_RELEASE_PLEASE_PR`
from `github.ref == refs/heads/release-please--branches--main`. It is read by:

- `validate.yml` and `full-tests.yml`;
- `validate-versions --allow-marketplace-lag` and
  `validate-marketplace --allow-version-lag`;
- the `allowLag` helper in `tests/plugin-shape/codex-catalog-source.mjs`;
- five plugin-shape test files and `test-sync-doc-versions.mjs`.

It is also incomplete: the Claude-catalog checks in the designer, image and
founder shape tests ignore it, so a release-branch run with it set would still
fail on a bump of those packages.

It has also stopped running. Of the last 200 runs on the release branch
(2026-08-22 to 2026-10-03), none was a push or dispatch run, the only kinds
that set it; all 200 were the `pull_request` runs the ADR-0033 amendment
removed. Since that amendment the branch gets no run at all, because
release-please pushes it with `GITHUB_TOKEN`. So the allowance guards a run
that does not happen, and the commit that does lag, the release commit on
`main`, has none. Since 2026-07-01, 74 of 74 release commits were red: all 74
failed catalog validation and 68 a test workflow. Since #823 the dispatched runs
show the synced tree green about a minute later, but the release commit's own
run stays red, and the catalog lag accounts for 99.3 hours of red not covered by
another cause since 2026-07-05.

**Decision.** The allowance is keyed on **content**. Call the commit under test
C and its first parent P.

1. **A package already released.** If C changes a package's version in
   `.release-please-manifest.json` from v₀ to v₁, that package's Claude catalog
   version and Codex pin may stand at v₀. Nothing else is excused: not a
   malformed or mismatched pin, not a catalog ahead of the manifest, not any
   version other than v₀ (the rest of ADR-0061 §Decision 2 is unchanged).
2. **A package's first release.** If C changes a package's manifest version and
   no release tag of that package is reachable from P, its Codex entry may be
   absent. This replaces ADR-0061 §Decision 2's first-release exemption, which
   ends at the package's first tag anywhere in the repository
   (`validate-marketplace.mjs:377`) and so turns the release commit red as soon
   as the release job cuts the tag. Every first release here has changed the
   manifest (`0.1.0` → `0.2.0` for orchestrator, founder, image, attention and
   designer). A first release that left it unchanged would be judged strictly,
   and B2 tests that case.
3. **Release history is read from the commit.** A check that asks whether a
   package has been released counts only tags reachable from C. A commit's
   verdict then does not change because a release was cut on another line of
   history later.
4. **Strict everywhere else.** Every other commit is checked strictly, on every
   branch. That includes the bot's sync commit once anything descends from it,
   and a commit someone pushes onto the release-PR branch beyond
   release-please's own (release-please keeps that branch at one commit).
5. **The writer is always strict.** `sync-marketplace-versions.mjs` validates
   the tree it wrote with no allowance. Rules 1 and 2 never apply to its call,
   though it runs on a checkout of the release commit.
6. **One checker.** Agreement between the manifest, the plugin manifests and
   the catalogs, and catalog membership, are checked in
   `validate-versions.mjs` and `validate-marketplace.mjs`. The plugin-shape
   tests and the two name comparisons of Decision 6 stop asserting them or call
   the validators, so the rules exist once. `AGENTIC_RELEASE_PLEASE_PR` goes,
   with the guard in `tests/scripts/test-full-suite-coverage.mjs` that asserts
   its wiring, the `allowLag` helper's own tests, and the mutations anchored on
   it in `scripts/mutation-specs/codex-catalog-pins.mjs`.

**What a run reports, state by state.**

| State | Verdict |
|---|---|
| The release commit on `main` | green, by rules 1 and 2, whether or not its tag exists yet |
| The bot's sync commit | no run of its own (a `GITHUB_TOKEN` push); validated in the job by rule 5 before the push, and strictly by the next push that descends from it |
| A `validate` or `full-tests` dispatch on a release commit | green, as rules 1 and 2 say. That states the commit is consistent, not that the catalogs were published; publication is the release job's result |
| A manual dispatch of `release-please.yml` | checks out current `main`, re-runs the sync, and validates strictly by rule 5, also when it writes nothing |
| A commit that lands on `main` while the release job runs | strict, so red until the sync lands; the bot's push is then rejected as non-fast-forward and the retry dispatch is due, as it is today |
| The tag cut, the catalog push failed | the release commit green, the release job red; the next push to `main` red until the retry dispatch |
| A multi-package release with some tags missing | the writer refuses the whole sync (`sync-marketplace-versions.mjs:180`); the remedy is to complete the missing release, then dispatch, as `docs/runbooks/codex-pin-activation.md` already says |

**Result.** A release leaves no run red by design, as long as no other commit
lands on `main` while the release job runs (its syncs took 0.03 hours in the
loop ADR-0052 measured). If one does, or the sync fails, the next run on `main`
is red, and that is the true signal: the catalogs lag and the retry dispatch is
due.

### Decision 9 — What stays

- release-please, its `extra-files`, and the package tags.
- `scripts/sync-marketplace-versions.mjs` with `scripts/lib/codex-catalog-pins.mjs`
  and `scripts/data/codex-pin-floors.json`: the Claude catalog version sync and
  the ADR-0061 Codex pin sync, including its in-job validation and its
  activation input.
- `validate-marketplace.mjs` and `validate-versions.mjs` in `validate.yml`,
  strict outside Decision 8's one commit.
- The retry path: a manual dispatch of `release-please.yml`, never a job re-run.
- `runtime:doctor` and every proof it runs, and the habit of running them after
  installing a runtime release, with no gate and no record (Decision 2).
- The ADR-0016 commit-splitting rule, the squash-message rules and the merge
  hygiene in AGENTS.md §Release process.

### Decision 10 — Historical records are not rewritten

These keep every statement they made, as ADR-0060 Decision 6 and ADR-0064
Decision 8 did for theirs:

- the frozen evidence records and their schema (Decision 4);
- the frozen scorecard (Decision 7);
- the doctor run ids cited in `docs/DEVELOPMENT.md` history paragraphs (42 distinct ids) and in the scorecard (56);
- changelogs, ADRs and their amendments.

Present-tense prose that describes a removed mechanism is corrected to the past
tense, or removed, in the change that removes the mechanism.

### Decision 11 — Implementation

B1 and B2 implement this ADR as separate pull requests, in that order.

- **B1** removes Decisions 1–5 and 7, together, because they import each other:
  `check-release-obligation` imports `gitHistoryAvailable` from
  `check-doc-evidence`, which imports `checkStore` from the store and reads the
  corpus manifest, while `evidence-corpus` and `measure-association-policy`
  import `EVIDENCE_DOCS` back from `check-doc-evidence`. It:
  - deletes the scripts, npm scripts, CI steps, tests and mutation specs those
    decisions name, and their executable dependents;
  - updates the release job for the removed doc-sync, verify and obligation
    steps, and the dispatch script's test, which pins their order and derives
    its sync-path inventory from both `CATALOGS` and the deleted `DOC_PATHS`;
  - strips the version and proof statements from `ARCHITECTURE.md` and
    `DEVELOPMENT.md`, keeping the condition-2 row parseable (Decision 2);
  - freezes the scorecard, the records and the two design documents with their
    notes;
  - rewrites AGENTS.md §Release process to what Decision 9 keeps, plus Decision
    2's doctor habit and Decision 5's sentence, and corrects its other
    present-tense mentions (the Build/CI
    validator list, and "doctor proof re-records after version bumps" under
    Current state);
  - rewrites the stale failure-domain text in `docs/runbooks/codex-pin-activation.md`
    and the release job's comments, including the one that justifies the sync
    commit's subject by the evidence store (`test-codex-pin-writer.mjs` pins the
    subject on its own, so the subject stays);
  - rewrites AGENTS.md's statement of ADR-0061 §Decision 5 (b) ("the §Decision
    8 evidence is recorded") to the checks themselves (Decision 2);
  - closes the two `follow-ups.md` rows of Decision 5 in their own
    `docs`-typed commit, since that is the one file inside a release-please
    package (ADR-0016); a `docs` commit routes no release;
  - closes PR #758.
- **B2** implements Decisions 6 and 8 in `release-please.yml`,
  `validate-versions.mjs`, `validate-marketplace.mjs`,
  `scripts/lib/codex-catalog-pins.mjs`, the CI workflows, the plugin-shape
  tests and their `codex-catalog-source.mjs` helper, the two name comparisons,
  `test-full-suite-coverage.mjs` and the `codex-catalog-pins` mutation spec. It
  tests every state in Decision 8's table, including a package's first release,
  a commit landing during the release job and a release with tags missing.

**Between B1 and B2.** B1 ends the proof-coupled red and the obligation red. It
does not change the release commit: until B2 lands, a release's own push run is
still red on catalog lag, exactly as today (docket C58), and the post-sync
dispatch still validates the synced tree. B2 should follow B1 directly; the
owner may hold runtime releases between them, but nothing breaks if a release
happens.

Both workflows keep
`fetch-depth: 0`, as does the release job: their comments cite the gates this
ADR removes, but kept ADR-0061 code needs full history too
(`sync-marketplace-versions.mjs` reads the tags, and
`tests/plugin-shape/codex-catalog-source.mjs` throws on a shallow clone). Only
the comments change.

### Decision 12 — Supersession is atomic with acceptance

The ADR-0056 §Decision 9 rule. The change that proposes this ADR adds a
"Proposed to be superseded" line to ADR-0049, ADR-0052 and ADR-0058. The commit
that flips this ADR to `Accepted` replaces those lines and applies the rest of
§Amendment cascade in the same commit.

## Amendment cascade (apply verbatim on acceptance)

`<date>` is the acceptance date.

**1. ADR-0049 — Status** (replaces the "Proposed to be superseded" line this
ADR's change added; the rest of the Status section stays):

```markdown
**Superseded by [ADR-0065](0065-release-ceremony-reduction.md)** (<date>), in
full. No evidence record is authored or validated any more. The records under
`docs/assurance/evidence/records/` and their schema are frozen history, and the
renderer and migration that §Decision 6 deferred are cancelled.
```

**2. ADR-0058 — Status** (replaces the "Proposed to be superseded" line):

```markdown
**Superseded by [ADR-0065](0065-release-ceremony-reduction.md)** (<date>), in
full. The store this ADR retained is withdrawn, its measurement substrate is
deleted, and the withdrawal trigger of §Decision 5 has no subject left.
```

**3. ADR-0052 — Status** (replaces the "Proposed to be superseded" line):

```markdown
**Superseded by [ADR-0065](0065-release-ceremony-reduction.md)** (<date>), in
full. The release-obligation check and its post-tag step are removed. A change
under `plugins/runtime/data/` carries a release-routing type on its squash
subject, a review convention stated in AGENTS.md §Release process.
```

**4. ADR-0033 — at the end of the 2026-10-03 amendment:**

```markdown
> **Amended <date> by [ADR-0065](0065-release-ceremony-reduction.md).** The
> branch-keyed allowance (`AGENTIC_RELEASE_PLEASE_PR`, Decision 3) is replaced
> by one keyed on content: only a commit that itself changes a package's
> version in `.release-please-manifest.json` may see the catalogs trail that
> change (ADR-0065 Decision 8). Decision 5 (iii) no longer asserts the
> release-please env wiring, which is gone. The accepted cost "The post-sync
> dispatch still validates `main` after the release" no longer holds. The
> dispatch is removed; the release commit's own run is green, and the release
> job validates the catalogs before it pushes the sync.
```

**5. ADR-0061 — after §Decision 2's validation states, and after §Decision 8:**

After §Decision 2:

```markdown
> **Amended <date> by [ADR-0065](0065-release-ceremony-reduction.md).**
> "Release-PR lag" and the first-release exemption are keyed on content, not
> on the release-please branch or on any tag in the repository: in the commit
> that changes a package's `.release-please-manifest.json` version, its pin
> may stand at the version the manifest held before, and a package with no
> release tag reachable from that commit's first parent may have no Codex
> entry. A check that asks whether a package is released counts only tags
> reachable from the commit under test. Every other state is checked strictly,
> and the writer always is. The evidence store is withdrawn, so nothing
> recognizes the sync commit's subject any more; the subject stays as it is.
> See ADR-0065 Decision 8.
```

After §Decision 8:

```markdown
> **Amended <date> by [ADR-0065](0065-release-ceremony-reduction.md).**
> Machine acceptance runs the same checks — a fresh `runtime:doctor` proof,
> each resolved sibling root, the receivers' state and the eight-package cache
> comparison — but records no evidence-loop record; ADR-0065 withdrew the
> store. The owner's machine's acceptance stays recorded in the frozen
> `docs/assurance/evidence/records/the-machine-that-took-the-pins.json`.
```

**6. ADR-0060 — after Decision 5:**

```markdown
> **Amended <date> by [ADR-0065](0065-release-ceremony-reduction.md).**
> The release-obligation mechanism this decision kept with a shorter list is
> removed, with its tests, and ADR-0052 is superseded in full.
```

**7. `docs/adr/README.md` — index.** The status cell of rows 0049, 0052 and
0058 becomes:

```markdown
Superseded by [ADR-0065](0065-release-ceremony-reduction.md) — in full
```

and the 0065 row's status cell becomes `Accepted`. The amended ADRs (0033,
0060, 0061) keep their status cells, as ADR-0052's did when ADR-0060 amended
it.

## Consequences

**Positive.**
- A release ends when release-please and the catalog sync finish. No PR follows
  it, and `main` does not wait on anyone's machine: the 247.9 hours of
  proof-coupled red since 2026-07-05, and the record era's 29 recovery PRs of
  9,137 lines, have no successor.
- `main` stops being red by design. Between 2026-07-05 and 2026-10-03 it was
  red 17.4% of the time and 99.4% of that was by design, so a red `main` said
  almost nothing. After B1 and B2, red means a failure.
- 13,909 lines of code and tests and 147,913 lines of measurement data leave
  the tree, and AGENTS.md §Release process shrinks by the 199 lines that
  describe them.
- `runtime:retention`'s citation scan completes again, because the one file
  over its cap leaves with the measurement substrate.
- The catalog-lag rule exists once, in the validators, and it applies to the
  commit that actually lags.

**Negative.**
- Nothing enforces running a released runtime as installed; the doctor run is
  a habit (Decision 2). Seven defects were found by that run in 95 recoveries.
- A document can cite a sha that does not resolve (Decision 3).
- The byte-level verification of the cited historical proof artifacts ends
  (Decision 4).
- Nothing asserts that accepted protected bytes reached a release, and a change
  that misses one can wait days for the next (Decision 5).
- `main`'s head right after a release shows no CI status (Decision 6).
- A commit that lands on `main` while the release job runs is red until the
  retry dispatch (Decision 8), as it is today.

**Neutral.**
- The records and the scorecard stay readable as history.
- `runtime:doctor` keeps every proof; only the obligation to record one goes.
- The catalog sync, the pins and their validation are unchanged except for
  where the lag allowance applies.

## Alternatives Considered

**Scope the proof coupling instead of removing it.** ADR-0052 §Decision 6 named
this as the largest cost lever: require a re-recorded proof only after a release
that touches what a proof exercises. Rejected: it keeps the tokens, the recovery
PR, the gates and the store for every release in that subset, and deciding the
subset is a judgment made per release.

**Keep the sha check as a standalone lint.** A small script that resolves every
7–40 hex token in `docs/**` and the root, without the triple, proof and store
checks. It keeps the one check with a live subject (Decision 3). Rejected on the
owner's line, since it protects citations and not shipped behavior; and the
rule it needs is not small, because 7-character decimal tokens are both real
citations and prose numbers, which the current corpus manifest handles with
exemptions. It is the cheapest thing on this list to bring back if dangling
citations start to cost more than the lint would.

**Keep authoring records, without the validator.** Rejected: ADR-0049 counted
the store as a sixth copy of the release facts even with its gates; without
them nothing would keep the copy true.

**Delete the records instead of freezing them.** Git history keeps them either
way. Rejected because it follows ADR-0060 Decision 6: history is not
rewritten. Freezing has one running cost, stated rather than hidden: the doctor
and settings runs the records cite stay pinned on the owner's machine, and
retention counts pinned runs against its caps without ever deleting them. That
is the state today, so nothing changes, but it is not free.

**Keep ADR-0052 for the two remaining paths.** Rejected on measurement
(Decision 5): every change to them since adoption routed its own release, and
the cross-host divergence behind the obligation is closed by ADR-0061.

**Catalog lag — other ways to stop the release commit being red.** Compared on
the compact axis set (`decide-registry.mjs resolve --size=minor`):

| Option | Essence | Foundation | Practical fit | Entry-routing guarantee |
|---|---|---|---|---|
| **Content-keyed allowance (Decision 8)** | removes the red at the one commit that lags | one rule in one validator, exact by construction | B2 changes validators and tests, no new writer | strict everywhere else; a failed sync shows on the next push |
| Key on the subject `chore: release main` | same | matches prose; any commit can reuse the subject | smallest change | a mistyped manual commit is excused |
| Sync the Claude catalog inside the release PR | Claude lag gone, Codex pin still trails (it needs the tag's commit) | a second writer of the catalogs | a release-PR workflow step | half the problem remains |
| Root catalogs as release-please `extra-files` | Claude lag gone, Codex pin still trails | rejected before (AGENTS.md: cross-package no-op bumps) | config change | half the problem remains |
| Status quo: red release commit, keep the dispatch | none | keeps the dispatch machinery | no work | `main` red by design on every release |

**Keep everything.** Rejected by the owner on 2026-10-03.
