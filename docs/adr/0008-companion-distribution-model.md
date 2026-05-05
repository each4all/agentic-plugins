# ADR-0008: Companion distribution model — `companions` plugin + cache-glob discovery + env override

## Status

Accepted

## Context

[ADR-0001](0001-hexagonal-architecture.md) places the companion bridges
in the COMPANION layer at the repository root (`companions/`).
[ADR-0004](0004-companion-ownership.md) decides agentic-plugins owns both
companion CLIs as first-party scripts. [ADR-0006](0006-directory-layout-install-pattern.md)
pins the per-plugin directory layout and the native-per-host install
mechanism.

These decisions are clean at the source-tree level but leave one
runtime question undecided: **how does an installed plugin reach a
first-party companion script?**

When a user runs `/plugin install <plugin>@agentic-plugins` (Claude
Code) or `codex plugin marketplace add each4all/agentic-plugins`
(Codex CLI), each host caches the installed plugin in isolation:

- Claude Code: `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`
- Codex CLI: `~/.codex/plugins/cache/<marketplace>/<segment>/<short-sha>/`

From inside its install cache, an installed plugin **cannot reach**
files that live in the source-tree's `companions/` directory at the
repo root — the cache contains only that plugin's directory subtree,
not the surrounding monorepo. This is true on both hosts.

Four packaging strategies were evaluated:

1. **Bundle the companion script inside each consumer plugin.** Each
   plugin carries its own copy of `claude-companion.mjs` /
   `codex-companion.mjs` and invokes them via the host's plugin-root
   path resolution. This is the pattern OpenAI's `codex-plugin-cc`
   uses for its own internal `scripts/codex-companion.mjs`.
2. **Publish a separate `companions` plugin** alongside consumer
   plugins. Consumer plugins discover the installed `companions`
   plugin via cache-glob (Claude side) and equivalent (Codex side).
   This is the pattern omcc-research uses to consume codex-plugin-cc's
   bundled script (cross-plugin cache-glob).
3. **Distribute companions as a global Node binary.**
   `npm install -g @agentic-plugins/companions` puts both companion
   scripts on `$PATH`. Consumer plugins shell out to
   `claude-companion task ...` / `codex-companion task ...` directly.
4. **Inline a minimal companion implementation in each plugin.** Each
   plugin re-implements the companion contract on its own behalf,
   shelling out to the peer host CLI directly.

The user's existing usage of codex-plugin-cc is the consumer pattern
(option 2): `omcc-research`'s research skill (running in Claude Code)
cache-globs `~/.claude/plugins/cache/*/codex/*/scripts/codex-companion.mjs`
to find the companion script bundled inside the codex-plugin-cc
plugin, then shells out to it. The pattern is proven; the discovery
mechanism (cross-plugin cache-glob) works in practice.

The 1st-party application of option 2 — agentic-plugins owning both
the `companions` plugin and the consumer plugins — removes the
fragility that omcc-research has to tolerate against a third-party
publisher (release-cadence skew, undocumented private surfaces, no
contract guarantee). Both pieces of the system can evolve under one
release process and one contract surface
([`companions/contract.md`](../../companions/contract.md) v0.1.0).
agentic-plugins additionally introduces an explicit
`AGENTIC_COMPANIONS_ROOT` environment override (decision (c)) that
omcc-research lacks; this satisfies ADR-0002 item 4's adapter-owned
path-resolution requirement and supports development workflows
(point at the source-tree without installing the plugin) plus CI
smoke flows that omcc-research had no clean answer for.

This ADR resolves the distribution model so consumer plugins (Stage 1
`research`, future Stage 2/3 plugins) have a canonical, documented way
to invoke companions.

## Decision

agentic-plugins distributes companions as a **first-party `companions`
plugin**. Consumer plugins discover the companion script via
**cache-glob** at runtime, with an **explicit environment override**
(`AGENTIC_COMPANIONS_ROOT`) that takes precedence when set.

### (a) Script-only library plugin exception to ADR-0006

`plugins/companions/` is a **script-only library plugin**. It packages
the canonical `companions/{claude,codex}-companion.mjs` scripts
(byte-identical, drift-protected) and exposes them at a known path
(`scripts/`) inside the installed plugin cache. It does NOT define
user-facing slash commands, hooks, or subagents.

**Formal qualifier**: a plugin qualifies as **script-only library**
iff it ships no `commands/`, `hooks/`, `agents/`, `personas/`, or
`mcp-servers/` content — only `scripts/` and the two host manifests
(`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`). This is
a deliberately narrow definition: a plugin that ships even one slash
command or functional skill must follow the full ADR-0006 layout
including `adapters/`.

**Codex spec compliance carve-out**: the Codex vendored plugin spec
(`~/.codex/skills/.system/plugin-creator/references/plugin-json-spec.md`)
requires the `skills` field in `.codex-plugin/plugin.json` to point
at a real directory. A script-only library plugin MAY ship an empty
`skills/` directory containing **only** a placeholder README that cites
this carve-out. The placeholder does NOT disqualify the plugin from
the script-only category — the formal qualifier prohibits **functional**
skills content (a `SKILL.md` directory under `skills/<name>/`), not
the empty directory required by Codex's manifest schema.

ADR-0006 specifies the per-plugin directory layout including
`adapters/{claude,codex}/` for host-specific adapter assets.
**Script-only library plugins MAY omit the `adapters/` subtree** when
they have no host-specific behavior beyond shipping shared scripts.
The `companions` plugin is the canonical example. Future script-only
library plugins (extracted from `kit/`, etc.) follow the same pattern.

This is a documented exception, not a violation. ADR-0001's "honest
scope" rule, applied here to subtree-omission when no per-host content
exists: the `adapters/` subtree exists when a host has host-specific
behavior to honor; when there is none (a pure script-only library),
the subtree is omitted.

(ADR-0006 itself is not amended in this PR; future maintainers learn
of this exception via ADR-0008's Decision section. A separate ADR-0006
amendment may be issued if confusion warrants.)

### (b) Cache-glob discovery contract

Consumer plugins discover the companion script via cache-glob with a
**pinned marketplace name and pinned plugin name**, narrower than
omcc-research's wildcard `*/codex/*` pattern.

**Claude Code**:

```
~/.claude/plugins/cache/agentic-plugins/companions/*/scripts/<companion>.mjs
```

The wildcard segment is the companion plugin's installed version;
when multiple versions are present, the consumer SHOULD pick the
newest valid one (sort by SemVer descending, take first that has a
working `--prompt-file` flag and a `CONTRACT_VERSION` compatible with
the consumer's required range — typically the same major version per
[`companions/contract.md`](../../companions/contract.md) § 8.3 SemVer
policy).

**Codex CLI** (verified against codex-cli 0.128.0; see Amendment 2026-05-04):

```
~/.codex/.tmp/marketplaces/agentic-plugins/plugins/companions/scripts/<companion>.mjs
```

Codex CLI 0.128.0 stores marketplace artifacts as a **full repository
git clone** at `~/.codex/.tmp/marketplaces/<marketplace>/`, regardless
of whether the source is `marketplace add ./local/path` or
`marketplace add github:owner/repo` — both produce identical install
metadata `{source_type: "git", source: <git_url>, revision: <sha>}` in
`.codex-marketplace-install.json`. The `~/.codex/plugins/cache/`
hierarchy that earlier drafts of this ADR assumed is **not used** in
0.128.0. The glob therefore has zero wildcards: marketplace name and
plugin name are both pinned, and the repository's per-plugin layout
(`plugins/<plugin>/scripts/`) is the canonical sub-path inside the
clone. Plugin enable is a `~/.codex/config.toml` flag
(`[plugins."<plugin>@<marketplace>"] enabled = true`) with no path
effect — the marketplace clone is the storage; enable is independent.

**Discovery algorithm** (mandatory, applies to both hosts):

1. Glob the wildcard pattern above.
2. For each match, **read the plugin's `.codex-plugin/plugin.json`
   (or `.claude-plugin/plugin.json`)** and verify `name == "companions"`.
   This is required because a wildcard segment may inadvertently match
   another consumer plugin's `scripts/` directory in the same
   marketplace cache (a future `research` or other plugin could ship
   its own `scripts/` content). Manifest-name verification eliminates
   the cross-plugin false-match risk.
3. Among manifest-verified matches, select the newest valid one
   (SemVer descending; first with a working `--prompt-file` flag and
   compatible `CONTRACT_VERSION`).
4. If no manifest-verified match resolves, fall through to the
   graceful-degradation behavior in (e).

**B.13 contingency (resolved by Amendment 2026-05-04)**: B.13.1
verification on 2026-05-04 against codex-cli 0.128.0 triggered this
contingency — the assumed `<marketplace>/<segment>/<short-sha>/`
cache layout does not exist in 0.128.0. The Codex glob above is the
empirically verified path; this ADR's Amendment 2026-05-04 records
the resolution. Future Codex CLI versions that introduce a true
`~/.codex/plugins/cache/` layout (or alter `.tmp/marketplaces/`
semantics) require a follow-up amendment. The consumer plugin
SHOULD NOT ship discovery code that papers over an unresolved layout
in any future contingency.

### (b.1) Discovery script ownership

The discovery script is **owned by each consumer plugin's adapter**
(`adapters/<host>/scripts/discover-companion.mjs`) per
[ADR-0001](0001-hexagonal-architecture.md)'s layered separation
principle (host-specific runtime mechanics live in the ADAPTER layer;
CORE protocol documents specify intent only). This means:

- The protocol document (`skills/<n>/references/ensemble-protocol.md`)
  describes *what* to invoke (companion contract surface, prompt
  vocabulary, synthesis taxonomy).
- The adapter script handles *how* to find and invoke it (this ADR's
  cache-glob + env override + manifest-verify algorithm).

Consumer plugins SHOULD reuse the discovery algorithm verbatim; small
helpers may eventually consolidate in `kit/lint/` or `kit/discovery/`
when 2+ plugins exhibit the pattern.

### (c) `AGENTIC_COMPANIONS_ROOT` environment override

When the environment variable `AGENTIC_COMPANIONS_ROOT` is set to an
absolute path, the discovery script uses that path directly and
skips the cache-glob. The variable's value points to a directory
containing `claude-companion.mjs` and `codex-companion.mjs` (the
script-pair, not the bundle root).

This satisfies [ADR-0002 item 4](0002-adapter-contract.md): "Where a
host lacks a built-in plugin-root variable, the adapter MUST provide
an equivalent mechanism." Codex CLI does not currently expose a
plugin-root variable; the `AGENTIC_COMPANIONS_ROOT` env override is
that adapter-owned mechanism. It also supports development-time
testing (point at the source-tree `companions/` without installing
the plugin) and CI smoke flows.

The override always wins when set; cache-glob is the auto-discovery
fallback when the variable is unset.

### (d) Copy-vs-symlink: copy with drift detection

`plugins/companions/scripts/{claude,codex}-companion.mjs` are
**byte-identical copies** of the canonical
`companions/{claude,codex}-companion.mjs`, not symlinks. Symlinks
were rejected because:

- Host plugin-install caching may not preserve symlink semantics
  (the install step typically copies file contents to the cache
  directory; whether it follows symlinks is host-dependent and not
  contractually guaranteed).
- Symlinks complicate cross-platform behavior (Windows host support,
  if needed later, is poor with POSIX symlinks).

Drift between the canonical scripts and the bundled copies is
prevented by three mechanisms that **Deliverable B implements**.
None of these exist in the repository at ADR-0008 acceptance time;
the gap is closed when B merges. Until then, `plugins/companions/`
does not yet exist, so there is nothing to drift from.

1. **Sync script** (`scripts/sync-companion-bundles.mjs`, created in
   B.2) — reads canonical, writes copies. Run via
   `npm run sync:companions -- --write` (the npm script defaults to
   drift-check; `-- --write` performs the sync action).
2. **Drift-detection test** (initially in `tests/plugin-shape/`,
   created in B.1; later integrated into
   `kit/lint/check-plugin-shape.mjs` per B.10) — fails CI if the
   bundled copies are not byte-identical to the canonical scripts.
   Authors who edit the canonical scripts must run the sync script
   before committing.
3. **CI guard** (`.github/workflows/claude-tests.yml`,
   `.github/workflows/codex-tests.yml`, extended in B.14) — runs the
   drift-detection test on every PR that touches `companions/` or
   `plugins/companions/`. Until B.14 extends them, the named workflows
   run only the existing companion-only unit/syntax tests.

ADR-0008's acceptance establishes the **contract** for drift
prevention; Deliverable B implements the **mechanism** that fulfills
the contract. Neither side is useful in isolation. The sequence
A (ADR) → B (mechanism) is the planned dependency order; if B is
delayed or skipped, this ADR's drift-prevention guarantee is
unfulfilled and a follow-up ADR amendment is required.

### (e) Install-order semantics + graceful degradation

A consumer plugin's adapter MUST handle the case where the
`companions` plugin is not installed. The required behavior:

- **Auto-activated mode** (skill invoked without explicit ensemble
  request): proceed without companion ensemble silently. The skill's
  primary work (research, etc.) completes using only the local host's
  capabilities.
- **Command-invoked mode** (slash command or `$skill` mention with
  ensemble intent): preflight discovery; if companions are missing,
  proceed local-only and surface a one-line completion warning to the
  user pointing at the install command. Hard abort is **discouraged**;
  consumer plugins SHOULD degrade gracefully unless their core
  function genuinely cannot proceed without ensemble work, in which
  case they MUST surface a clear, actionable install instruction
  rather than a generic error.

**Operational mode-detection rule**: the skill detects mode by its
invocation source. Slash command invocation (Claude `/<plugin>:<skill>`)
or skill mention (Codex `$<skill>`) signals **command-mode**.
Auto-delegation (skill triggered by description-matching during
auto-activation, no explicit user invocation) signals **auto-mode**.
Adapter scripts MUST encode this distinction; the protocol document
SHOULD reference it without specifying host-specific detection
mechanics.

This mirrors omcc-research's pattern (companions are an enhancement,
not a hard dependency) and matches the user's existing mental model.

The `companions` plugin's marketplace entry uses
`policy.installation: "AVAILABLE"` (not `INSTALLED_BY_DEFAULT`) on
the Codex side. Users who don't install a consumer plugin shouldn't
be forced to carry companions on their machine.

### (f) Versioning and release coordination

`plugins/companions/` and consumer plugins are versioned
**independently** under release-please. The companion CONTRACT_VERSION
constant (currently `0.1.0` in both
`companions/{claude,codex}-companion.mjs`) is the runtime
compatibility gate: consumer plugins SHOULD verify
`CONTRACT_VERSION` is compatible with their required range during
preflight (typically same major version per
[`companions/contract.md`](../../companions/contract.md) § 8.3).

Plugin-level SemVer cadence:

- `plugins/companions/` MAJOR bump: required when CONTRACT_VERSION's
  major version bumps (breaking wire spec change per
  [`companions/contract.md`](../../companions/contract.md) § 8.3).
- `plugins/companions/` MINOR bump: when a new optional companion
  flag, error.kind, or envelope field ships (per the contract's
  compatibility policy).
- Consumer plugin MAJOR bump: when the consumer's user-visible
  surface (slash command name, output file shape) changes
  incompatibly.

**Release-please configuration** (`release-please-config.json` +
`.release-please-manifest.json`) does not currently exist in this
repository — only the intent is documented in `docs/DEVELOPMENT.md`.
This ADR specifies the package list it MUST contain when created
(`companions/` for canonical scripts, `plugins/companions/` for the
installed plugin, plus each consumer plugin like `plugins/research/`),
but ADR-0008's acceptance does NOT depend on release-please existing
at acceptance time. Deliverable B creates the configuration as part
of its task list.

**Future amendment trigger**: if CONTRACT_VERSION reaches `1.0.0`
with breaking wire-spec changes, this ADR is reviewed for currency.
If the cache-glob discovery contract and `AGENTIC_COMPANIONS_ROOT`
env-override semantics still hold under the new contract, this ADR
remains accepted; otherwise it is superseded by a new ADR per the
ADR process in [`AGENTS.md`](../../AGENTS.md).

## Consequences

**Positive**:

- Consumer plugins have a canonical, documented runtime path to
  reach companions. The pattern is proven (codex-plugin-cc consumer
  pattern, used in production by omcc-research) but applied
  first-party so version-skew fragility is removed.
- Single source of truth at install time too — consumer plugins
  don't carry redundant companion copies. A companion bug fix or
  contract update flows to all consumers via one plugin update.
- Drift between canonical and bundled scripts is prevented by
  mechanical CI gate, not human discipline.
- The discovery contract (cache-glob + env override) accommodates
  both default install paths and explicit overrides for development /
  CI / unusual sandbox configurations.
- ADR-0001 layered separation honored: mechanics in adapters, contract
  in core. The protocol docs (`skills/<n>/references/ensemble-protocol.md`)
  describe what to invoke; the adapter scripts handle how.

**Negative**:

- One additional plugin to maintain in both marketplace catalogs
  (`companions` plus each consumer). User installs two plugins for
  any plugin that uses the companion ensemble.
- Cache-glob discovery has runtime fragility classes that consumer
  adapters must handle: empty cache (graceful degradation),
  multiple installed versions (pick newest valid), stale/orphaned
  installs (skip), non-executable bit (warn + skip), old companions
  without `--prompt-file` (skip per CONTRACT_VERSION check),
  cross-plugin false matches (resolved by manifest-name verification
  in the (b) Discovery algorithm).
- Codex CLI 0.128.0 stores marketplace clones at
  `~/.codex/.tmp/marketplaces/<marketplace>/`. The `.tmp/` naming
  suggests ephemerality, but in 0.128.0 there is no cleanup policy
  and the directory persists across `codex` invocations (verified:
  marker files dating from 2026-03-27 still resident as of
  2026-05-04 verification). Future Codex CLI versions may add
  cleanup policies (TTL, GC on `marketplace upgrade`, etc.) that
  would invalidate this ADR's discovery contract; in that case, an
  ADR amendment is required.
- `marketplace add` for both local paths and GitHub URLs produces a
  git clone with identical install metadata in 0.128.0 (`source_type:
  "git"`, `source: <git_url>`, `revision: <sha>`). If a future Codex
  version diverges (e.g., local paths get a different storage shape,
  or path resolution rejects non-git local directories), this ADR
  must amend the Codex glob accordingly.
- Install-order discipline is required: users must install
  `companions` before (or alongside) any consumer plugin to get the
  ensemble enhancement. Graceful degradation softens this but doesn't
  eliminate the UX wrinkle on first install.
- `AGENTIC_COMPANIONS_ROOT` becomes a permanent named contract.
  Renaming or restructuring the variable later requires a deprecation
  cycle across all consumer plugins (parallel-support old + new for
  one minor release at minimum). The omcc-research wildcard pattern
  doesn't have this issue because it has no env contract — but it
  also has no way to override discovery for development/CI use.
- The drift-prevention mechanism (sync script + drift-detection test
  + CI guard) introduced by decision (d) is a permanent maintenance
  burden: `scripts/sync-companion-bundles.mjs` must stay correct
  through any canonical-script restructuring; the drift-detection
  test must run on every relevant PR; if canonical scripts move, both
  the sync script and the test must be updated together. Trade-off
  accepted to avoid symlink fragility.

**Neutral**:

- Script-only library plugins are a new plugin shape (no slash
  commands, hooks, or subagents). The exception to ADR-0006 is
  narrowly scoped to library plugins; user-facing plugins continue
  to follow the full ADR-0006 layout including `adapters/`.
- Per-host plugin manifest schemas continue to evolve outside this
  ADR (Codex CLI plugin format is documented but not formally
  versioned; Claude Code marketplace.json schema is published). This
  ADR consumes those schemas; it does not stabilize them.

## Alternatives Considered

1. **Bundle the companion script inside each consumer plugin
   (Option 1)** — Rejected. Equivalent to codex-plugin-cc's INTERNAL
   pattern (scripts in its own `scripts/` directory invoked via
   `${CLAUDE_PLUGIN_ROOT}`), but applied externally would create N
   copies of the same companion across N consumer plugins. Each
   bug-fix or contract-update would require N coordinated bumps.
   Source duplication + drift risk on a 1st-party stack with no
   third-party justification. Codex's bundled scripts work because
   ONE plugin owns them; that property doesn't extend to N consumers.
   Reconsider if startup latency or install-order UX dominates over
   drift-and-coordination cost (e.g., 10+ consumer plugins all
   needing companions, with measured discovery overhead causing
   user-visible delay).

2. **`npm install -g @agentic-plugins/companions` (Option 3)** —
   Rejected. Splits the install UX into two channels (npm + plugin
   marketplace). Adds an npm/Node version-resolution surface to the
   user's setup. Doesn't follow the user's existing mental model
   (codex-plugin-cc consumer pattern uses cache-glob, not PATH).
   Useful as a future option for heavy CI use cases or non-host
   tooling, but not the primary distribution channel.

3. **Inline a minimal companion in each plugin (Option 4)** —
   Rejected. Re-implementing the companion contract per-plugin
   guarantees drift between the canonical contract and the inline
   implementations, and violates [ADR-0004](0004-companion-ownership.md)'s
   intent (single first-party companion as the contract surface).
   Even a "minimal" inline implementation owns the wire spec, exit
   codes, error.kind triage — exactly the contract `companions/contract.md`
   already specifies.

4. **Cache-glob with wildcard marketplace** (omcc-research style:
   `~/.claude/plugins/cache/*/codex/*/scripts/codex-companion.mjs`)
   — Rejected. The wildcard catches any plugin named `codex` from
   any marketplace, which is necessary for omcc-research's
   third-party consumer story but not for our 1st-party case. With
   marketplace + plugin pinned (`agentic-plugins/companions`), the
   discovery is unambiguous and a future install of a different
   marketplace's `codex`-named plugin can't interfere with our
   discovery.

5. **`policy.installation: "INSTALLED_BY_DEFAULT"` on Codex** for
   the `companions` plugin — Rejected. Forces companions on users
   who install only consumer plugins that don't use the ensemble.
   Better to keep companions opt-in (`AVAILABLE`) and surface clear
   install instructions when a consumer plugin needs ensemble work
   and doesn't find companions. Users retain control.

6. **Symlink the canonical scripts into `plugins/companions/scripts/`
   instead of copying** (Variant of decision (d)) — Rejected. Host
   install caching may not preserve symlink semantics (whether the
   cache copy follows symlinks is host-implementation-dependent and
   not contractually guaranteed). Cross-platform symlink behavior is
   inconsistent (Windows). Copy + drift detection is more robust.
   Reconsider if Windows host support is dropped from agentic-plugins'
   scope AND host install caching is verified to follow symlinks
   across all supported hosts.

## References

- [ADR-0001](0001-hexagonal-architecture.md) — Layered separation
  (CORE / ADAPTER / COMPANION); mechanics in adapters, contract in
  core
- [ADR-0002](0002-adapter-contract.md) — Item 4: adapter-owned path
  resolution mechanism (satisfied by `AGENTIC_COMPANIONS_ROOT` env)
- [ADR-0004](0004-companion-ownership.md) — agentic-plugins owns
  both companions; this ADR specifies how installed consumers reach
  them
- [ADR-0006](0006-directory-layout-install-pattern.md) — Per-plugin
  layout including `adapters/{claude,codex}/`; this ADR documents the
  script-only library plugin exception
- [ADR-0007](0007-migration-cutover-plan.md) — Redesign stance;
  codex-plugin-cc / omcc-research consumer pattern is the lesson
  source, not a 1:1 port target
- [`companions/contract.md`](../../companions/contract.md) v0.1.0 —
  the wire-spec contract this ADR's distribution model serves

## Amendments

### 2026-05-04 — Codex cache layout corrected for codex-cli 0.128.0

**Trigger**: B.13.1 verification follow-up after Deliverable B merged
(PR #9, commit 56ae15c). Verified the actual codex-cli 0.128.0
behavior of `marketplace add` and plugin enable to determine the
empirical cache layout.

**Finding**: `~/.codex/plugins/cache/` is unused in 0.128.0;
marketplace clones live at `~/.codex/.tmp/marketplaces/<marketplace>/`
as a full git clone (regardless of `local` vs `github` source — both
produce identical install metadata at `.codex-marketplace-install.json`
with `source_type: "git"`). Plugin enable is a `~/.codex/config.toml`
flag (`[plugins."<plugin>@<marketplace>"] enabled = true`) with no
path effect; the marketplace clone is the storage and exists
independently of plugin enable state. The `<marketplace>/<segment>/<short-sha>/`
cache layout assumed in the original § (b) does not exist in 0.128.0.

**Changes (this PR)**:

- § (b) "Codex CLI" subsection: glob updated to
  `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/companions/scripts/<companion>.mjs`
  (zero wildcards; marketplace + plugin both pinned). Original
  `<segment>/<short-sha>/` interpretation discarded.
- § (b) "B.13 contingency": marked **resolved**; noted that future
  Codex CLI versions altering this layout require a new amendment.
- Negative consequences: replaced "cache layout ambiguity" risk with
  two new risks — `.tmp/` naming cleanup-policy fragility (Codex
  0.128.0 has no cleanup, but future versions may), and divergent
  local vs github source handling (currently identical, future may
  diverge).

**Verified against**: codex-cli 0.128.0 (`/Users/lmuffin/.bun/bin/codex
--version`); install metadata at
`~/.codex/.tmp/marketplaces/agentic-plugins/.codex-marketplace-install.json`;
marker file `~/.codex/.tmp/app-server-remote-plugin-sync-v1` resident
since 2026-03-27 (40 days at verification time) confirming `.tmp/`
treated as durable storage in 0.128.0.

**Out of scope (follow-up may amend)**: behavior of `marketplace
upgrade` (in-place git pull vs replace), behavior of `marketplace add`
for non-git local directories (no `.git/`), behavior across Codex CLI
upgrades that introduce a true `~/.codex/plugins/cache/` activation.
