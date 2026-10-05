# Runbook — how a release reaches the catalogs and the hosts

[`AGENTS.md`](../../AGENTS.md) §Release process states the release rules an
agent acts on. This runbook holds the mechanics behind them: how release-please
and the catalog sync divide the work, why the release commit's catalogs may
trail its manifest, what to do after installing a runtime release, how a
release reaches an installed Codex plugin, and the incidents the merge rules
came from. The text moved here from AGENTS.md on 2026-10-05 when AGENTS.md
became an entry point; the rules themselves did not change.

For activating the Codex catalog pins, and for what to do when the sync
refuses, see [`codex-pin-activation.md`](codex-pin-activation.md).

## Package versions and the two catalogs

release-please owns per-package version automation. It tracks each
package via `release-please-config.json` and writes new versions into
`.release-please-manifest.json` plus each plugin package's
`.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` (per the
`extra-files` mapping; the standalone `companions` package has none).

The two root catalogs are **deliberately not** `extra-files` targets.
Keeping `.claude-plugin/marketplace.json` under release-please
management would couple every plugin package to commits that touch any
catalog entry, producing no-op version bumps on unrelated plugins. The
Codex catalog, `.agents/plugins/marketplace.json`, has a second reason:
each entry pins the commit its release tag peels to, so its pin can be
derived only once release-please has cut that tag
([ADR-0061](../adr/0061-codex-installs-pinned-to-release-commits.md)
§Decision 2). Instead, `scripts/sync-marketplace-versions.mjs` syncs
both catalogs after each release. It writes each Claude entry's
`version`, and it advances a Codex entry's `ref` and `sha` only when
that package's manifest version has moved past its pin. It plans every
package before writing anything, so one package it cannot pin blocks
both catalogs. The release-please GitHub Action runs that sync as a
follow-up step automatically and validates what it wrote before
pushing. When the sync refuses, and for how the pins were first
activated, see [`codex-pin-activation.md`](codex-pin-activation.md).
Recovery is a new dispatch or a forward release, never a revert to
`local`.

## The release commit and CI

**Only the release commit may show its catalogs trailing the
manifest** ([ADR-0065](../adr/0065-release-ceremony-reduction.md)
Decision 8). The validators decide that from the commit's content, not
from its branch: in a commit that changes a package's version in
`.release-please-manifest.json` from v0 to v1, that package's Claude
catalog version and Codex pin may stand at exactly v0, and a package
with no release tag reachable from the commit's first parent may have
no Codex entry yet. Every other commit is checked strictly, and so is
the sync's own validation. No test reads a catalog's version, ref or
sha, or which entries the Codex catalog lists, so the release commit's
run is green. Three things follow:

- **The catalog sync commit gets no CI run of its own.** It is pushed
  with `GITHUB_TOKEN`, and a push made that way starts no workflow. The
  sync validated it before the push, and the next push to `main` checks
  it strictly.
- **A commit that lands on `main` while the release job runs is red**
  until the catalogs are synced, and the bot's push is then rejected as
  non-fast-forward. That red is the true signal that the retry is due.
- **The retry path is a manual dispatch** of `release-please.yml`
  (`gh workflow run release-please.yml --ref main`). It checks out
  current `main`, re-runs the sync and validates strictly, also when
  there is nothing to write. Do not re-run the failed job: release-please
  reports `releases_created` only once, so a re-run skips the sync.

## After installing a runtime release

**After installing a `plugin-runtime` release on a host, run
`runtime:doctor` with its proofs there** (`--permission-proof
--execute-permission-proof --deep-peer-smoke --execute-deep-peer-smoke
--workflow-continuation-proof --execute-workflow-continuation-proof`), and
treat a failure as a defect to fix forward. It is the one step that runs
the released bytes as installed, and it has found defects in released code
that no test did. It is a habit, not a gate: `main` does not wait on it,
no document restates its result, and the repository keeps no record of it
([ADR-0065](../adr/0065-release-ceremony-reduction.md) Decision 2). If
you record the proof (`--record`), install the release on both hosts
first. Both hosts read the same `.agentic-plugins/runs/doctor/`, and an
older runtime counts a newer artifact `malformed` (see
`READABLE_DOCTOR_SCHEMA_PAIRS` in `plugins/runtime/scripts/doctor.mjs`).

## Runtime assets that take effect only when released

**Some `plugins/runtime` assets do not take effect until a release ships
them.** `runtime` commands resolve `plugins/runtime/data/plugin-set.json`
and `plugins/runtime/data/schemas/**` from the *installed* plugin, not
from the repository, so editing them on `main` changes nothing anyone
runs until a release is tagged. **A change under `plugins/runtime/data/`
therefore carries a release-routing type (`feat` or `fix`) on its squash
subject**, which is what release-please routes on, so the change is
released. Like the commit-splitting rule in AGENTS.md, this is a
convention enforced by review: nothing checks that the release happened
([ADR-0065](../adr/0065-release-ceremony-reduction.md) Decision 5). The
counterexample `16b1833` was typed `docs:`, routed nothing, and left
released and repository bytes apart for 54 hours. Roll such an asset back
with a forward patch, never by reusing or lowering a version: a reused
version would name two different trees.

## On Codex the premise holds machine by machine

The Codex mechanism was measured on 2026-09-24 with codex-cli 0.156.1.
When the marketplace is added from Git without a ref, a `codex exec` or
app-server start can upgrade the marketplace clone once `main` has moved,
and then force-reinstalls every configured plugin from it without a
version change. While the Codex catalog's entries were `local`, an
installed Codex plugin therefore ran `main`'s bytes under its released
version.
[ADR-0061](../adr/0061-codex-installs-pinned-to-release-commits.md) pins
each Codex catalog entry to its release commit and moves cross-plugin
discovery to the installed cache. Its publisher activation (§Decision 5
(a)) landed on 2026-09-26 in `3006c8b`. A machine receives the pinned
catalog at its next successful marketplace refresh. From then on, on the
measured version, the reinstall that follows a move of `main`
materializes the pinned commits, and a materialization that fails leaves
the older cache in place (§Decision 6, §Decision 7). The marketplace
clone keeps tracking `main`. Codex materializes the pinned commits from
it, but its checked-out package files are `main`'s, can hold unreleased
changes, and are not an install surface. The premise that editing
`plugins/runtime/data/` on `main` changes nothing anyone runs holds on a
machine only once that machine passes §Decision 5 (b):

- its installed packages meet the migration floors;
- its home receivers are re-rendered;
- a fresh Codex session resolves each sibling under the Codex installed
  cache;
- the operator has run the §Decision 8 checks on that machine: a fresh
  `runtime:doctor` proof, each resolved sibling root, the receivers'
  state, and the eight-package cache comparison. They leave no
  repository record (ADR-0065 Decision 2).

On a machine past it, every package edit, including a `docs`- or
`test`-typed one, reaches an installed Codex plugin only through a
release and the pin that follows it. Exercising an unreleased change
there takes a release or a deliberate local override, which never enters
the catalog (§Decision 7). On a machine that has not passed it, "editing
them on `main` changes nothing anyone runs" holds on Claude Code only,
and on Claude only for a version already materialized and not replaced.

## Merge shape and the changelog

Release-please changelog hygiene depends on merge shape. For a
single-package PR, prefer a squash merge whose final message is the one
intended changelog entry. When preserving multiple release-routed
commits is necessary, use rebase merge if available or avoid a merge
commit body that repeats the same conventional headline. A GitHub merge
commit that embeds a conventional PR title can be parsed alongside the
original branch commit, producing duplicate changelog entries for the
same change.

**The squash message comes from the PR, not from the branch commits.**
The repository is configured `squash_merge_commit_title=PR_TITLE` and
`squash_merge_commit_message=PR_BODY`. GitHub's default for the latter
is `COMMIT_MESSAGES`, which concatenates every branch commit as a
`* <subject>` bullet plus its full body — two failure modes at once.
It re-emits each branch commit's conventional headline into the body,
which is the duplicate-changelog hazard described above; and on any
branch with a propose → review → revise trajectory it preserves the
**superseded** commit bodies as assertions in the permanent record. That
happened on `85fee0a` (ADR-0049): the review had disproved the first
commit's rationale, and the squash carried it onto `main` anyway. See
the correction on [#646](https://github.com/each4all/agentic-plugins/pull/646).
The rules this leads to — the PR body is the commit body, no
footer-shaped lines in it, and both parts passed explicitly when merging
from the CLI — are in AGENTS.md §Release process.
