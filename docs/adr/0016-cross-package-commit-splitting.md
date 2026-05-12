# ADR-0016: Cross-package commit splitting for release-please routing

## Status

Accepted

## Context

release-please owns per-package version automation in this repo
(see AGENTS.md §Release process). It tracks each package via
`release-please-config.json` `packages` map and applies Conventional
Commits semantics (`feat`, `fix`, `feat!` / BREAKING CHANGE footers,
etc.) to drive version bumps and CHANGELOG generation per package.

The currently tracked packages are:

- `companions` (root `companions/` directory)
- `plugins/companions`
- `plugins/engineer`

release-please's commit-to-package routing is **file-path based**: a
single commit's footer (`feat`, `fix`, `chore!`, BREAKING CHANGE, etc.)
applies to every package whose tracked path is touched by that commit.
There is no Conventional Commits scope mechanism in release-please
that overrides this — the scope (`feat(plugin/research):`) is a
human-readable label, not a routing override. The `packages` map is
the routing authority.

The consequence: when one commit modifies files in 2+ tracked
packages, every affected package receives the same footer signal.
A `feat!` commit intended for one package becomes a BREAKING bump on
every package whose path it incidentally touches.

### Incident — commit `28b5eb8`

Commit `28b5eb8` (`chore(plugin/research)!: archive at Stage 2.5+
(timeline collapse per ADR-0014 Amendment)`) carried a `chore!`
BREAKING CHANGE footer that was scoped semantically to
`plugin/research`. The commit's file footprint, however, included:

- `plugins/research/**` (deletions — intended target; package was
  removed from `release-please-config.json` in the same commit, so
  routing did not apply here)
- `plugins/companions/README.md`, `plugins/companions/skills/README.md`
  (cross-skill handoff cleanup)
- `plugins/engineer/README.md`,
  `plugins/engineer/skills/{compose,critique,decide,frame,refine}/SKILL.md`,
  `plugins/engineer/skills/investigate/references/{cited-brief-ensemble,cited-brief-spec,output-file-rules}.md`
  (cross-skill handoff cleanup)
- root-level docs (`AGENTS.md`, `README.md`,
  `docs/{ARCHITECTURE,DEVELOPMENT}.md`,
  `docs/adr/0014-plugins-research-deprecation.md`,
  `kit/lint/check-plugin-shape.mjs`, `package.json`,
  `plugins/README.md`, marketplace catalogs,
  `release-please-config.json`, `.release-please-manifest.json`)

Both `plugins/companions` and `plugins/engineer` were therefore routed
the BREAKING signal even though the user-facing command surface in
neither package was breaking. release-please's `bump-minor-pre-major:
true` setting (in `release-please-config.json`) means a BREAKING
signal at `0.x` produces a minor bump (`0.3.0 → 0.4.0`), not a major
bump — so the surface impact today is one extra minor version per
affected package. After 1.0, the same incident would produce a major
bump on every routed package, raising the cost from cosmetic to
functionally significant. The fix is the same in either regime: split
before commit.

The `28b5eb8` incident's BREAKING signal was, in practice, accepted as
the bump for both packages (current manifest: `plugin-companions
0.4.0`, `plugin-engineer 0.4.0`). Adjacent commits `4ebfa02`
(`chore(release-please): narrow extra-files routing + add marketplace
sync`) and `384f424` (`chore(marketplace): sync catalog versions to
release-please-manifest`) reduced future cross-package coupling risk
by decoupling the marketplace catalog from per-package routing — not
strictly a remediation of `28b5eb8`, but an adjacent narrowing that
addresses one mechanism by which cross-package commits could
incidentally bump unrelated packages.

### Forces

- **release-please file-path routing is by design, not a bug.** Any
  fix that reroutes commits *after* the fact would fight the tool.
  The fix has to live before the commit.
- **Convention-only enforcement is acceptable** for a solo-developer
  project. A pre-commit lint hook is mechanically possible but adds
  per-commit friction that is hard to justify at current scale.
- **root-level docs are a legitimate exception** because they live
  outside any package path and are routed nowhere. A blanket
  "split everything" rule punishes refactors that genuinely cross
  packages purely at the README/docs level.
- **release-please-config.json is the single source of truth** for
  which paths are package-routed. The exemption rule must reference
  this file by structure, not by maintaining a parallel hand-curated
  list.

## Decision

### Rule

**When a single commit touches files in 2+ release-please package
paths, split into per-package commits before pushing.**

A "release-please package path" is any path listed as a key in
`release-please-config.json` `packages`. As of 2026-05-13 those keys
are `companions`, `plugins/companions`, `plugins/engineer`, and
`plugins/orchestrator`. Any file under one of these prefixes is
package-routed.

### Merge-shape clarification (2026-05-13)

For a single-package PR, prefer a squash merge whose final message is
the one intended changelog entry. When preserving multiple
release-routed commits is necessary, use rebase merge if available or
avoid a merge commit body that repeats the same conventional headline.
A regular GitHub merge commit can embed the PR's conventional title in
the merge body; release-please may parse that merge commit alongside the
original branch commit and generate duplicate changelog entries for the
same change.

### Exemption — root-level docs

Files **outside** every `release-please-config.json` `packages` key
prefix are exempt — they are not routed to any package and may be
combined freely with package changes in the same commit. This
includes (non-exhaustive, by virtue of being outside the package
keys):

- root files: `AGENTS.md`, `CLAUDE.md`, `README.md`, `LICENSE`,
  `package.json`, `release-please-config.json`,
  `.release-please-manifest.json`, `.gitignore`
- `docs/` (including `docs/adr/`)
- `scripts/`
- `tests/`
- `kit/`
- `.claude-plugin/` (root marketplace catalog)
- `.agents/` (root marketplace catalog)
- `.github/`
- any other path not under a `packages` key prefix

The exemption is **structural** — it is determined by membership in
`release-please-config.json` `packages`, not by a hand-curated list.
If a future ADR adds a new package whose path overlaps one of the
above (e.g., `kit/` becomes a tracked package), the exemption shrinks
automatically without needing this ADR amended.

### Mixed cases

A commit that touches:

- one package + only root-level docs → not split (one package routed,
  docs are exempt)
- two packages (no docs) → split per package
- two packages + root-level docs → split per package; root-level docs
  may be folded into either per-package commit OR a third
  docs-only commit, at author's discretion (no routing harm either
  way)

### Process

The split happens **before** push. Authors stage and commit per
package using `git add <package-path>` then `git commit`, repeating
for each affected package. There is no automated lint or pre-commit
hook (see Alternatives Considered §1).

This is a convention, not a CI gate. A violation does not fail CI;
it produces an incorrect release-please PR which the human reviewer
must catch (or accept and override via manual manifest edit, as was
done for `28b5eb8`).

## Consequences

**Positive**:

- Per-package version bumps reflect the author's actual intent. A
  BREAKING change targeted at one package no longer collaterally
  bumps unrelated packages.
- The release-please PR is reviewable on its own merits — the
  per-package CHANGELOG entries match the per-package commits.
- Audit trail improves: `git log --follow plugins/X/` shows changes
  scoped to that package, with clean Conventional Commits semantics
  for that package.
- The exemption rule is anchored to `release-please-config.json` and
  evolves with it automatically.

**Negative**:

- Branches that genuinely cross packages (e.g., a Stage transition
  touching both `plugins/companions` and `plugins/engineer`) require
  more commits — author overhead.
- The convention is enforced by reviewer attention, not tooling. A
  hurried push under merge pressure can violate it without immediate
  feedback. Mitigation: release-please PRs are themselves the late
  feedback signal — an unexpected bump on a package is the visible
  symptom.
- New contributors must read this ADR (or AGENTS.md §Cross-package
  commit splitting) before pushing. The cross-reference in
  AGENTS.md §Conventions is the discovery surface.

**Neutral**:

- The exemption list is not separately maintained. Readers must
  consult `release-please-config.json` to know what is package-routed
  at a given moment. This is a cost (one extra lookup) and a benefit
  (single source of truth) at once.
- "Touching" a path includes file deletions and renames, both of
  which release-please reads as commit-affecting changes. Splitting
  applies equally.

## Alternatives Considered

1. **Pre-commit lint hook** (e.g., a script that runs on `git commit`
   and rejects multi-package staged sets) — Rejected for current
   scale. Implementation cost is low (a node script invoking
   `git diff --cached --name-only` and checking against
   `release-please-config.json`), but per-commit friction is
   non-trivial for a solo workflow. The convention is sufficient
   when the developer is also the reviewer. If contributor count
   grows, this can be revisited as an additive measure (the ADR's
   rule does not change; only the enforcement mechanism does).

2. **Monorepo decomposition** (split `agentic-plugins` into separate
   repos per package) — Rejected. Conflicts with ADR-0006
   (directory layout + install pattern) and ADR-0001 (hexagonal
   layered model). Cross-host coherence and the dogfooding pattern
   (AGENTS.md §Dogfooding) both require shared-repo edits across
   layers. The cross-package routing problem is a small price.

3. **Conventional Commits scope as routing override** (treat
   `feat(plugins/engineer): …` as authoritative regardless of
   file paths) — Rejected as infeasible. release-please does not
   support scope-as-routing; the scope is a label only. Implementing
   this would require forking or replacing release-please.

4. **release-please-config.json `packages` re-structure** (e.g.,
   make `plugins/` a single package or use exclusion patterns) —
   Rejected. The current structure encodes deliberate per-plugin
   versioning (each plugin can major-bump independently — ADR-0007
   cutover plan). Collapsing them into one package undoes that. The
   problem is commit shape, not package shape.

5. **Always squash-merge with rewritten commit message** — Rejected.
   release-please reads the squash commit's body, but composing a
   correct multi-package squash body is harder than splitting the
   commits in the first place, and squash erases the per-package
   audit trail.

## References

- AGENTS.md §Conventions §Cross-package commit splitting (this ADR's
  discovery surface)
- AGENTS.md §Conventions §Release process (release-please mechanism
  description)
- `release-please-config.json` (the routing authority)
- `28b5eb8` (originating incident — `chore(plugin/research)!`
  archive commit that crossed `plugins/companions` +
  `plugins/engineer` packages)
- `4ebfa02`, `384f424` (post-incident narrowing of catalog sync to
  decouple marketplace from per-package routing)
- ADR-0006 — Directory layout + install pattern (constrains
  monorepo decomposition alternative)
- ADR-0007 — Migration cutover plan (motivates per-plugin
  versioning)
