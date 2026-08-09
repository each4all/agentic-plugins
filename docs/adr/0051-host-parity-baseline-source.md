# ADR-0051: Host-parity baseline source — the packaged copy is the only authority, and changing it obliges a release

## Status

Proposed

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

The cause is in the two catalogs. `.claude-plugin/marketplace.json`
pins `runtime` with `"version": "0.89.0"`; `.agents/plugins/marketplace.json`
declares `{"source": "local", "path": "./plugins/runtime"}` with no
version, so a Codex install tracks the working tree while a Claude
install is frozen at the released package.

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

3. **Pinning the Codex catalog is a precondition, not a follow-up.**
   While `.agents/plugins/marketplace.json` declares an unpinned local
   source, "the packaged copy" is not a single artifact and this
   decision does not hold. The Codex catalog entry gains the same
   version pin the Claude catalog carries. Until it does, the two hosts
   can disagree and any provenance recorded is a per-host fact.

4. **One grammar, one failure vocabulary.** The three readers parse
   differently today — `compat.mjs:797` accepts loose version text with
   no date, while `doctor.mjs:1166` and `dashboard.mjs:408` require the
   dated `Observed on …` header and then disagree on the name for
   failure (`missing` vs `unparsed`). The dated header is the canonical
   grammar. A present-but-unparseable baseline is **visible failure**,
   never a silent degrade: there is no second source to fall back to,
   which is precisely what makes single authority safe to parse
   strictly.

5. **Provenance is recorded even with one source, and it is
   content-identifying.** A baseline value carries the resolved path,
   the runtime manifest version, the **content SHA-256**, and the
   parsed values. Origin alone is not audit-grade — `PLUGIN_ROOT` can
   itself be a development checkout, so the label `package` is not
   self-evidently truthful, and a path cannot distinguish the same file
   before and after mutation. `compat`'s `remembered_baseline` and
   `doctor`'s host-parity evidence both carry it. Existing snapshots
   without the field are read as legacy and are not retro-filled.

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

**Out of scope.** This ADR decides the source rule. The code change,
its regression tests, the catalog pin, and the contract amendment land
in a separate PR under ADR-0016 routing.

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
- The Codex catalog pin (item 3) changes how Codex installs resolve
  runtime, which is a behavior change for anyone relying on the
  unpinned local source during development.

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
