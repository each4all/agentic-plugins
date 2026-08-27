# ADR-0051: Host-parity baseline source — the packaged copy is the only authority, and changing it obliges a release

## Status

Accepted (implemented 2026-08-10)

> **Corrected 2026-08-10, before acceptance.** §Decision 3 originally required
> pinning the Codex catalog entry, on the theory that an unpinned
> `{source: local}` entry was why the two hosts' packages diverged. Implementation
> measurement refuted both halves and the section is rewritten below; the
> original claim is preserved in §Alternatives so the reasoning stays auditable.
> The decision itself — packaged copy as sole authority, changing it obliges a
> release — is unchanged and, as it turns out, is the whole fix.

> **Extended 2026-08-14 (post-acceptance hardening).** §Decision 4's failure
> vocabulary grows from two verdicts to four — `missing`, `unreadable`,
> `escaped`, `unparseable` — and §Decision 5's content hash is taken over the
> file's BYTES rather than a UTF-8 re-encoding of them. Both were reproduced
> against the accepted implementation before they were changed: a
> present-but-unreadable baseline reported "not present", a symlinked `docs/`
> or leaf made a file outside the package the authority while still reporting
> `source: 'package'`, and two different invalid byte sequences produced one
> content hash. The decisions are unchanged; this applies their stated
> principles — visible failure, distinct operator actions, content-identifying
> provenance — to cases the original two verdicts collapsed.
>
> The same pass makes every reader ask a shared predicate
> (`baselineFailure`) instead of enumerating statuses, because the enumeration
> was the real defect: five readers each listed the two they knew and gave
> anything else a benign meaning. One review item from the same round was
> **refuted** and is recorded rather than fixed — `provenance.reason` was
> already surfaced by `doctor` and `dashboard`; what was wrong was the status
> above it.

## Context

`plugins/runtime/docs/host-parity-baseline.md` records the accepted
Claude Code / Codex CLI versions that `runtime:compat` compares an
observed snapshot against and that `runtime:doctor` reports freshness
for. Four readers exist and they do not agree on where the file lives:

| Reader | Line | Root |
|---|---|---|
| `compat.mjs` | `:790` | `PLUGIN_ROOT` — the installed package |
| `doctor.mjs` | `:1159` | `repoRoot` |
| `dashboard.mjs` | `:403` | `repoRoot` |
| `scripts/check-host-version-drift.mjs` | `:33` | repository root (CI script, not a runtime command; reuses `compat`'s parser at `:29`) |

This was assumed latent — "inside the source tree they resolve to the
same file". Measured 2026-08-09, they did not, and the measurement is
worse than a two-way split.

### "The packaged copy" is not one thing

Both host caches report runtime `0.89.0`, and their baselines differ:

| Source | Baseline header |
|---|---|
| repository working tree | `2026-08-08` · `2.1.226` · `0.147.0` |
| Codex cache `runtime/0.89.0` | `2026-08-08` · `2.1.226` · `0.147.0` |
| Claude cache `runtime/0.89.0` | `2026-07-25` · `2.1.220` · `0.145.0` |

The catalogs look like the cause and are not: both entries point at the
same local path. What actually produced the split is recorded in
§Decision 3 — packaged content changed under an unchanged version, and
the two hosts resolve updates differently.

`compat` reads `PLUGIN_ROOT`. Which `PLUGIN_ROOT` depends on which host
invoked it — so today the same command answers differently on the two
hosts on the same machine, for the same repository, at the same commit.

The divergence between the repository and the Claude package is
structural on top of that: the baseline is refreshed by the
**post-release** freshness-recovery loop (`16b1833` is *"post-0.89.0
freshness recovery — … dual host-baseline refresh"*), so a refresh
always lands after the release whose package would have carried it.

### The risk runs in both directions

An earlier draft of this ADR claimed the failure mode was
over-reporting and never silence, on the reasoning that an older
baseline can only re-raise a drift the repository already resolved.
**That is false, and cross-host review refuted it.**
`buildGapAnalysis` compares with exact inequality, not ordering
(`compat.mjs:397`, `observedVersion !== baselineVersion`). If an
operator pins or rolls a host back to `2.1.220` / `0.145.0`, the stale
Claude package reports `matches` — silence — while the repository
baseline would report `version_changed`. Stale baselines both
under-report and over-report; only the incident measured here is a
forward-upgrade over-report.

### What was actually measured, stated precisely

On 2026-08-09, `compat` invoked from the Claude package reported
`drift=host-version-changed` / `release_notes_required` against
`2.1.220` / `0.145.0` for host versions the repository had accepted the
day before. Ingesting the previously fetched release notes (Claude
`CHANGELOG.md` 495,499 B; Codex `releases.atom` 307,141 B) moved the
run to `gap_analysis_ready` — so re-ingestion **does** clear
`release_notes_required`, and an earlier draft that said no amount of
ingesting could clear it contradicted this project's own measurement.
What does not clear is the drift itself: `runtime_handoff_artifacts`
stays `partial` 9/15, which is the observed `experience_parity` ceiling
of 95%. The cost is a repeated re-ingest on every fresh snapshot, not a
permanently unclearable gap.

### The underlying conflict is between two accepted documents

[ADR-0026](0026-runtime-compatibility-drift-and-release-notes.md) §3
resolves a changed-version gap when **either** a content-backed
release-note artifact covers the changed host and observed version
**or** the accepted baseline is intentionally refreshed in repository
docs after human review, and its §Consequences records that a baseline
refresh is *"a repository review action, not a runtime command"*.

`machine-bootstrap-contract.md` §preamble states the opposite locality
for readers: a runtime command *"can read `PLUGIN_ROOT/docs/…`
(precedent: `scripts/compat.mjs` …) but cannot read `repoRoot/docs/…`
(anti-pattern: `scripts/cutover-audit.mjs`)"*, and
[ADR-0046](0046-machine-bootstrap.md):444 restates it. That passage
argues why the **bootstrap contract** ships inside the package; it is
not by itself a normative rule binding every baseline consumer. It is
nonetheless the only stated locality doctrine in the tree.

So the baseline is authored and reviewed in the repository, distributed
in the package, and read from whichever of the two a given consumer
happened to choose.

## Decision

**The packaged copy is the sole authority for runtime commands, and
changing the baseline obliges a runtime release. The repository copy is
the source that is reviewed and released — never a runtime read.**

1. **Single authority.** Every runtime command resolves the baseline
   from `PLUGIN_ROOT/docs/host-parity-baseline.md`. `doctor.mjs:1159`
   and `dashboard.mjs:403` change to match `compat.mjs:790`.
   `scripts/check-host-version-drift.mjs` is **explicitly carved out**:
   it is a CI script operating on the source tree, not a runtime
   command, and continues to read the repository path (`:33`). Its
   reuse of `compat`'s `extractBaselineVersions` (`:29`) is deliberate
   single-sourcing and must survive item 4 — the canonical grammar is
   shared with CI, not forked from it.

2. **Release obligation.** A change to `host-parity-baseline.md` is a
   change to a load-bearing distributed asset. It requires a
   `plugins/runtime` release before it is in force. In practice the
   freshness-recovery loop already produces a runtime-affecting commit;
   this makes the coupling explicit rather than incidental, and it is
   the price paid for removing the dual authority.

3. **Content may not change under an unchanged version.** This replaces
   a catalog-pinning precondition that measurement refuted during
   implementation.

   The cross-host divergence is not caused by catalog pinning. **Both**
   catalogs point at the same local path — the Claude entry is
   `{"source": "./plugins/runtime", "version": "0.89.0"}` and the Codex
   entry is `{"source": {"source": "local", "path": "./plugins/runtime"}}` —
   and a **local-source** Codex entry carries no top-level version —
   which `sync-marketplace-versions.mjs`, `scripts/validate-versions.mjs`
   and `scripts/validate-marketplace.mjs` each record as by-design.
   (Narrower than the first draft's "no per-entry version field at all":
   Codex npm sources carry `source.version` and git sources carry
   `ref`/`sha`. Every entry in this catalog is `local`, so the pin was
   unavailable *here* — not unavailable in principle.) The proposed pin
   was therefore both unimplementable for this catalog and beside the
   point.

   The measured cause is timing under a fixed version:

   | | |
   |---|---|
   | Claude cache `runtime/0.89.0` installed | 2026-08-08 15:30:03 |
   | repository baseline last changed (`16b1833`) | 2026-08-08 16:33:48 |
   | Codex cache `runtime/0.89.0` installed | 2026-08-09 21:18:40 |

   `16b1833` changed packaged content **without a version bump**. That
   is necessary but **not sufficient** on its own, and cross-host review
   was right to press on it: the two hosts also resolve updates
   differently. Claude skips an update when the resolved manifest
   version is unchanged, while Codex `0.147.0` has both a
   version-conditional refresh and a force-reinstall path, and a
   marketplace upgrade selects the latter. So the split needs both
   factors — content moving under a fixed version, **and** one host
   whose update path re-copies regardless. Either alone leaves the two
   caches agreeing.

   So the rule is the one §Decision 2 already states, and this item
   names its converse: a change to `docs/host-parity-baseline.md` — or
   to any packaged asset a runtime command reads to reach a verdict —
   **must ship as a version change**. §Decision 5's content hash is what
   makes a violation observable rather than silent.

4. **One grammar, one failure vocabulary.** The three readers parse
   differently today — `compat.mjs:797` accepts loose version text with
   no date, while `doctor.mjs:1166` and `dashboard.mjs:408` require the
   dated `Observed on …` header and then disagree on the name for
   failure (`missing` vs `unparsed`). The dated header is the canonical
   grammar. A present-but-unparseable baseline is **visible failure**,
   never a silent degrade: there is no second source to fall back to,
   which is precisely what makes single authority safe to parse
   strictly.

   *Extended 2026-08-14.* The vocabulary is `resolved | missing |
   unreadable | escaped | unparseable`, and readers ask
   `baselineFailure()` rather than listing it. Splitting `unreadable`
   and `escaped` out of `missing` follows from this item's own rule —
   they call for different operator actions (fix permissions, reinstall
   a mis-packaged install, restore a deleted file) — and the shared
   predicate is what keeps a sixth verdict from arriving at five
   readers as `stale` or `available`.

5. **Provenance is recorded even with one source, and it is
   content-identifying.** A baseline value carries the resolved path,
   the runtime manifest version, the **content SHA-256**, and the
   parsed values. Origin alone is not audit-grade — `PLUGIN_ROOT` can
   itself be a development checkout, so the label `package` is not
   self-evidently truthful, and a path cannot distinguish the same file
   before and after mutation. `compat`'s `remembered_baseline` and
   `doctor`'s host-parity evidence both carry it. Existing snapshots
   without the field are read as legacy and are not retro-filled.

   *Extended 2026-08-14.* The hash is taken over the file's BYTES. A
   UTF-8 decode maps every invalid byte sequence to U+FFFD, so hashing
   the decoded string gave two different files one digest —
   reproduced with `FF FE` and `FF FF` — a collision class in the one
   field whose job is telling two same-version installs apart.
   Provenance also carries `canonical_path` beside `path`: the
   operator-facing spelling and the bytes actually read are different
   questions, and their difference is the only evidence an `escaped`
   verdict has. Manifest state travels too (`ok | partial |
   disagreement | absent | unusable`), because a package whose two
   manifests disagree reported one version on one surface and another
   on the next, and said nothing.

6. **Convergence is promised only where it holds.** `compat` binds the
   baseline into its snapshot (`compat.mjs:93`) and `check` / `plan`
   reuse that stored value (`:140`, `:314`), while `doctor` and
   `dashboard` read live. After a refresh, an existing compat run
   **intentionally** disagrees with a current doctor until a new
   snapshot is taken. This decision makes fresh reads agree; it does
   not and should not make recorded artifacts mutate.

7. **Governance.** On acceptance this ADR **amends**
   `machine-bootstrap-contract.md` §preamble and
   [ADR-0046](0046-machine-bootstrap.md):444 by promoting their
   illustrative precedent/anti-pattern statement into a normative rule
   for baseline-class assets, and back-references are added there.
   ADR-0026 §3 is **unchanged**: both of its resolution branches stand,
   and a baseline refresh remains a repository review action — item 2
   only states when that review takes effect for runtime.

8. **`cutover-audit.mjs`.** Its `host-parity-baseline` checklist item
   (`:545`) names `plugins/runtime/docs/host-parity-baseline.md` as the
   source while reusing doctor's result. Under item 1 that label
   becomes wrong and must be reconciled in the implementation PR.

> **Amended by [ADR-0053](0053-baseline-exactness-and-compatibility-assurance.md)
> (accepted 2026-08-17): the packaged baseline gains a compatibility-assurance
> section.** Items 1–8 above are unchanged and remain operative — the packaged
> copy stays the sole authority, changing it still obliges a release, and the
> grammar stays single-sourced. ADR-0053 adds a *new fact* rather than widening
> an existing one: `HEADER_RE` and `parseBaseline`'s `{date, claude, codex}`
> shape are untouched, and assurance is a separate section with its own reader
> in this same module, which is an addition under item 4 rather than the fork
> item 4 forbids. Two findings from that work bear directly on this ADR. Item 8's
> reconciliation is broader than stated: exactness reaches cutover a second time
> through `compat`'s exact-equality `drift_class` and the
> `latest_compat_snapshot` check, so moving the checklist item alone changes
> nothing. And the `status` field this ADR gave a failure vocabulary carries a
> third class — `missing`/`unreadable`/`escaped`/`unparseable` plus probe
> `unknown` — which ADR-0053 §Decision 3 makes an independent hard stop that
> outranks any assurance grant.

> **Further amended by [ADR-0056](0056-assurance-matcher-removal.md) (accepted
> 2026-08-27): the assurance section is REMOVED from the packaged baseline.**
> Items 1–8 remain operative and are, if anything, cleaner: the packaged copy is
> the sole authority, changing it still obliges a release (ADR-0052), and the
> grammar is single-sourced in one module again rather than two grammars over one
> file. The clause the amendment above added — "the packaged baseline gains a
> compatibility-assurance section" — is **withdrawn**, and this note is written
> in place rather than by rewriting §Decision 3, so the trail of what was
> normative when is legible.
>
> Two consequences for readers of this ADR. The `withoutAssuranceRegion` masking
> ADR-0053 required is now `withoutQuotedRegions`: it still blanks fenced and
> HTML-quoted blocks before `HEADER_RE` runs — item 4's grammar is unchanged, and
> the exactly-one-header property still holds — but it no longer blanks a
> sentinel region, because there is none. And the third status class named just
> above still outranks everything: integrity remains a hard stop, with nothing
> beneath it to outrank.

**Out of scope.** Enforcement of §Decision 2 is **prose only** and is
recorded as an explicit follow-up: nothing in CI, release-please, or the
validators fails when a packaged asset changes without a version change,
and `16b1833` is the counterexample that motivated this ADR. Until a
diff-aware gate exists, §Decision 5's content hash is the detector, not
the preventer.

> **Decided 2026-08-13 by [ADR-0052](0052-release-obligation-enforcement.md).**
> The follow-up this paragraph records is closed: enforcement is a
> history-and-tag reconciliation check that derives release debt from
> immutable history, covering `docs/host-parity-baseline.md`,
> `data/plugin-set.json` and `data/schemas/**` by directory. It detects
> rather than prevents, which ADR-0052 §Consequences states plainly and
> justifies against the measurement that `main` carries no branch
> protection, so a PR-time gate could not have blocked the merge either.
> One correction to the paragraph above: `16b1833`'s baseline blob is
> byte-identical to the blob at tag `plugin-runtime-v0.90.0`, so the
> change did ship — 54.0h later, on an unrelated `feat`. The
> counterexample is a divergence *window* closed by luck, not an asset
> that never shipped.
>
> **Shipped** as `scripts/check-release-obligation.mjs`
> (`npm run validate:release-obligation`), gated by
> `tests/scripts/test-release-obligation.mjs` under `full-tests.yml`'s
> `fetch-depth: 0` checkout and re-run inline in `release-please.yml` after
> the tag is cut, because a `GITHUB_TOKEN` push triggers no workflow. The
> phrase "diff-aware gate" above is superseded rather than satisfied: the
> adopted check compares two full protected file *sets* across the
> merge→release boundary and never diffs against a PR base, which is why
> deletion, rename and an absent base are structural non-issues instead of
> cases to enumerate.

## Consequences

**Positive**

- One authority. The four-way split collapses, and the cross-host
  disagreement measured above becomes impossible once item 3 lands.
- The consumer-repository defect is fixed: `doctor` stops reporting
  `baseline-freshness: missing` with a remediation telling an operator
  to restore a file from this project's source tree that their project
  never contained.
- No repository on the filesystem can shadow the accepted baseline. An
  arbitrary consumer repo, fork, stale branch, vendored copy, or dirty
  worktree has no path to suppress a drift signal.
- Strict parsing becomes safe, because there is no fallback for a
  malformed source to launder through.

**Negative**

- **A baseline refresh does not take effect until a release.** In the
  source tree this is felt immediately: after a host CLI update,
  `doctor` reports `stale` and `compat` re-raises drift until the
  runtime release ships. The 95% `experience_parity` ceiling therefore
  persists through that window by design, and this ADR does not remove
  it — it makes the reason explicit and bounded instead of structural
  and unexplained.
- Release cadence becomes coupled to host-version observation cadence.
  A host that ships often forces runtime patch releases that carry no
  code change.
- ~~The release obligation is not mechanically enforced (see §Decision
  §Out of scope).~~ A contributor can still change the packaged baseline
  without a version change; what differs from before is that provenance
  makes the result observable rather than invisible.
  **Superseded 2026-08-13 by [ADR-0052](0052-release-obligation-enforcement.md):**
  the obligation is now mechanically detected. A contributor can still
  *merge* such a change — `main` has no branch protection, so nothing can
  block the merge — but `main` then stays red until a release ships the
  bytes. The redness is the intended signal, and its expected duration is
  the measured 5.3h median refresh window.

**Neutral**

- The baseline file keeps its location, format, and review path.
- `check-host-version-drift.mjs` keeps reading the repository, which is
  correct for CI and now stated rather than incidental.

## Alternatives Considered

**A — package-only, without a release obligation.** Item 1 alone.
Rejected because it silently keeps the defect: with no rule tying a
baseline change to a release, a refresh sits in the repository having no
effect on any runtime command, and the only signal that it has not
taken effect is the drift it was meant to clear.

**B — `repoRoot` everywhere; change `compat`.** The direction this
investigation started from. Rejected: it contradicts the locality
doctrine, and the consumer-repository measurement shows the cost — the
check degrades to `missing` for every operator outside this repository.

**C — repository override with a packaged fallback and recorded
provenance.** Adopted in a first draft and **withdrawn after
cross-host review**, which is recorded here rather than removed because
the reasons generalize. `repoRoot` is the current Git top-level
(`commands/compat.md:13`), so precedence makes *any* repository at that
path an authority — including forks, stale branches, and dirty
worktrees. The draft explicitly blessed uncommitted edits as "the point
of an override", which contradicts ADR-0026's reviewed-acceptance rule
that the same draft claimed to leave intact. Provenance records such a
choice; it does not authorize it. The draft also rested on a risk model
("over-reporting, never silence") that `compat.mjs:397` refutes, and on
a measurement that had examined only one host's package.

**E — pin the Codex catalog entry** (the original §Decision 3).
Withdrawn during implementation, and recorded because the reasoning was
wrong in an instructive way. It inferred a cause from a correlation —
the Codex entry lacked a `version` field and the Codex package happened
to be fresh — without checking whether the field exists in that schema
(it does not; three repository tools say so) or whether the Claude entry
was pinned in any load-bearing sense (it is not; both entries resolve
the same local path). Install timestamps then showed the two packages
differ only in when they were last copied. The lesson generalizes: a
version number is not an identity for content unless something forbids
content from moving under it, which is what §Decision 2 now supplies.

**D — relocate the baseline to a runtime-owned artifact.** Content-
addressed storage outside `docs/`, written by an explicit command.
The first draft rejected this for removing ADR-0026 §3's
repository-review property; **that rejection was a false coupling** and
is corrected here. Approval and storage are separable: an explicit
command can create a content-addressed candidate while a tracked
acceptance record binds its hash and source commit through PR review.
It is rejected for now on scope, not on soundness — it introduces a new
artifact family, a new acceptance record, and a migration, to solve a
dual-authority problem that item 1 plus item 2 closes without new
machinery. It remains the successor if the release obligation proves
too costly in practice, and it is the better shape if the baseline ever
needs to change faster than runtime can release.

> **Re-judged 2026-08-13 by [ADR-0052](0052-release-obligation-enforcement.md)
> §Decision 1 — still deferred.** Both clauses of the trigger stated
> above have now been measured against one full exercise of the
> obligation, and both come out negative. The release obligation costs
> **0.13h — 0.3%** of a 51.84h loop, and a 4m48s median across all 163
> release commits; the expensive ~23.09h belongs to a *different*
> obligation (`sync-doc-versions.mjs:306`'s proof-coupled doc gate,
> which fires on any runtime bump). And the baseline does not need to
> change faster than runtime can *release* — runtime releases in six
> minutes — but faster than **reviewed acceptance** can land, which D's
> own design keeps. Granting D everything downstream of the refresh
> merge for free still clears only 3 of 12 host-publish gaps, an 18.8%
> freshness duty cycle against the measured 18.4%. ADR-0052
> §Alternatives records a concrete design that satisfies §Decision 1
> without shipping a changing pointer in the package, so the deferral
> stays re-triggerable rather than becoming a dead end.

## References

- [ADR-0026](0026-runtime-compatibility-drift-and-release-notes.md) §3
  and §Consequences — the two-branch resolution rule and the
  repository-review requirement, both unchanged by this decision.
- [ADR-0046](0046-machine-bootstrap.md):444 — restates the
  precedent/anti-pattern locality statement amended by §Decision 7.
- [ADR-0049](0049-evidence-as-data.md) §Decision 2 and 4 — provenance
  declaration and "gates validate only what their source can back",
  applied to a gate's *input* in §Decision 5.
- [ADR-0016](0016-cross-package-commit-splitting.md) — routing for the
  implementation PR.
- `plugins/runtime/docs/machine-bootstrap-contract.md` §preamble.
- `plugins/runtime/scripts/{compat,doctor,dashboard,cutover-audit}.mjs`
  and `scripts/check-host-version-drift.mjs` — the readers.
- `.claude-plugin/marketplace.json` / `.agents/plugins/marketplace.json`
  — the pinned and unpinned catalog entries behind the cross-host
  divergence.
