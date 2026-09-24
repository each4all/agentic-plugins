# ADR-0061: Codex installs pinned to release commits — the catalog carries the pin, and cross-plugin discovery reads the installed cache

## Status

Accepted (2026-09-24). Docs-only; an orchestrator macro executes
§Implementation manifest.

Supersedes **in part** — in each, its Codex discovery candidate, and in the
two ladders also the host order a Codex-hosted caller follows:

- [ADR-0008](0008-companion-distribution-model.md) — § (b)'s Codex
  candidate, the fixed marketplace-clone path;
- [ADR-0019](0019-cross-plugin-invocation-contract.md) — the Codex layout of
  its sibling-plugin-root resolver, "a single fixed path … (no version
  directory in the path)";
- [ADR-0039](0039-completion-footer-activation.md) — §5's
  "Codex-fixed-cache" rung, and its Claude-before-Codex order for a
  Codex-hosted caller;
- [ADR-0040](0040-operator-observability.md) — the same rung and order in
  the §3 sensor ladder, as the §4 receiver shuttle and the §5 peer-run
  self-sensor use it.

Amends [ADR-0052](0052-release-obligation-enforcement.md) (its premise holds
on Codex only after §Decision 5 (a), on machines past §Decision 5 (b)) and
[ADR-0046](0046-machine-bootstrap.md) (the "Codex catalog is versionless"
rationale). In each partly superseded ADR, whichever of the override
variables, capability floors, candidate filters, selection policy and
no-stale-fallback rules it carries is unchanged; for a Codex-hosted caller
the ladders' host order becomes Codex first (§Decision 3).

Supersession was atomic with acceptance (the ADR-0056 §Decision 9 rule): the
change that accepted this ADR also changed the status of the four partly
superseded ADRs and added amendment notes to ADR-0046 and ADR-0052. It added
a dated pointer to [ADR-0006](0006-directory-layout-install-pattern.md)'s
2026-09-18 amendment too, whose rollback procedure describes the Codex rung;
no decision there is amended. The code still resolves the superseded rungs
until §Implementation manifest S1–S3 ship, and §Decision 5 keeps the catalog
unpinned until then.

## Context

### The premise, and the host it does not hold on

`AGENTS.md` §Release process states that runtime commands resolve their
protected assets "from the *installed* plugin, not from the repository, so
editing them on `main` changes nothing anyone runs until a release is
tagged", and [ADR-0052](0052-release-obligation-enforcement.md) enforces a
release for every protected change on that basis. Two further rules lean on
the same premise: one package version names one tree, and rollback is a
forward patch (ADR-0052 §Decision 7, ADR-0006's 2026-09-18 amendment).

On Claude Code the premise holds only for a version already materialized and
not replaced, which is narrower than it states. Claude does not re-copy an
installed version whose manifest version is unchanged
([ADR-0051](0051-host-parity-baseline-source.md) §Decision 3 records this).
Its bytes for a version are frozen at the first install or update that
materializes that version, copied from the marketplace's current tree rather
than from the tag. They equal the tag only if that tree's copy of the package
still matched the tag at that moment (for a Git-sourced marketplace: no commit
touched the package in between). On this machine that held for all eight
packages: Claude's install records name post-tag commits (for `engineer
0.21.10`, the catalog sync `fffd79c`), and the caches match the tags file for
file.

On Codex CLI the premise does not hold at all.

### What is installed today (measured 2026-09-24, `main` at `e2d2872`)

Each host cache was compared file by file against a `git archive` of the
package's release tag and of `main`:

| Package | Version | Tag tree = `main` tree? | Claude cache vs tag | Codex cache vs tag | Codex cache vs `main` |
|---|---|---|---|---|---|
| attention | 0.9.0 | no | 0 differ | 3 differ | 0 differ |
| designer | 0.3.8 | no | 0 | 5 | 0 |
| engineer | 0.21.10 | no | 0 | 10 | 0 |
| founder | 0.4.8 | no | 0 | 4 | 0 |
| runtime | 0.97.4 | no | 0 | 1 | 0 |
| companions | 0.4.1 | yes | 0 | 0 | 0 |

`image` and `orchestrator` have identical tag and `main` trees, so both
caches agree there. The cross-host peer repeated the Codex half for all eight
packages by per-file hash and got the same 23 files, every one equal to
`main`. So Codex's `engineer 0.21.10` includes the unreleased skill-root
corrections from `6389ae4` (#808), and Claude's `engineer 0.21.10` does not.
Both hosts report the same version. The unreleased `attention` changes touch
two code files (`adapters/claude/hooks/stop.mjs`, `scripts/lib/sensor.mjs`),
though every changed line in them is a comment.

### Why: the mechanism, in codex-cli 0.156.1

These are read from the source at the installed version's tag,
[`rust-v0.156.1`](https://github.com/openai/codex/tree/rust-v0.156.1), and the
behaviour was confirmed by the measurements further down.

1. **Every app-server start runs a marketplace auto-upgrade.**
   `maybe_start_plugin_startup_tasks_for_config`
   ([manager.rs:2769](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core-plugins/src/manager.rs#L2769))
   spawns a `plugins-marketplace-auto-upgrade` thread when plugins are
   enabled. The in-process app-server that `codex exec` starts always
   requests it
   ([in_process.rs:498](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/in_process.rs#L498)),
   as does the TUI when it starts its embedded server (a TUI attached to an
   existing app-server starts none). A standalone `codex app-server`
   requests it by default
   ([lib.rs:480](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/lib.rs#L480)).
2. **The gate is revision identity, not time and not version.** For each
   configured Git marketplace, `git ls-remote <source> <ref or HEAD>`
   resolves a revision, and a full 40-hex `ref` skips the lookup
   ([git.rs:16](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core-plugins/src/marketplace_upgrade/git.rs#L16)).
   The snapshot is replaced unless its `.codex-marketplace-install.json`
   matches the source, ref, sparse paths and that revision
   ([marketplace_upgrade.rs:252](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core-plugins/src/marketplace_upgrade.rs#L252)).
   The config's `last_updated` and `last_revision` are discarded on the way
   in, and there is no configuration key that turns the upgrade off.
3. **An upgraded snapshot forces a reinstall of every configured plugin
   from it.** `upgrade_configured_marketplaces_for_config_with_mode` calls
   `refresh_non_curated_plugin_cache_force_reinstall_detailed`
   ([manager.rs:2940](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core-plugins/src/manager.rs#L2940)).
   That mode skips the version-equality shortcut
   ([loader.rs:676](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core-plugins/src/loader.rs#L676)),
   so an unchanged `0.21.10` directory is rewritten from the new
   `plugins/engineer`. Disabled plugins are included.

With every catalog entry `{"source": "local", "path": "./plugins/<p>"}`, the
snapshot is the install source. So a commit to `main` reaches every
installed Codex plugin at the next Codex start whose upgrade succeeds, under
the version the plugin already had.
[ADR-0051](0051-host-parity-baseline-source.md) §Decision 3 named this
force-reinstall path in August but read it as a single timing split, and
withdrew a Codex catalog pin as "beside the point" (its §Alternatives E
records the withdrawal): with `local` entries no pin was available *here*,
"not unavailable in principle". The force-reinstall is the normal case, and a
`git-subdir` entry makes the pin available.

### When it fires (measured)

The measurements used an isolated `CODEX_HOME`, a `file://` bare repository
as a Git marketplace, and one plugin whose skill body changes between
commits. Before each trigger, docs-style commits with an unchanged version
had moved `main` past the snapshot.

- **Triggers**: `codex exec`, `codex app-server` and
  `codex plugin marketplace upgrade`. The snapshot moved in each of the six
  `codex exec` runs made while `main` was ahead of it. Under a `local` entry
  the cache moved with it, the two timed runs within 1 s of start. Under a
  `local` entry the one `codex app-server` run that followed a `main` move
  moved both within 6 s. Runs with a pinned entry or a marketplace `ref` are
  described under §What pinning is available.
- **Do not trigger**: `codex plugin list --json`, `codex --version`,
  `codex debug prompt-input` and `codex plugin marketplace list`, each run
  with `main` ahead of the snapshot; a positive-control `codex exec`
  afterwards moved it. This agrees with the source: only an app-server start
  runs the upgrade
  ([message_processor.rs:549](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/message_processor.rs#L549)).
- **TUI**: not measured. The claim that it triggers rests on the source,
  and holds only when the TUI starts its embedded server.

In this repository's own workflow, every Claude→Codex peer dispatch is a
`codex exec`. Each one starts the refresh check, which, when `main` has moved
and the upgrade succeeds, refreshes the owner's Codex installs to `main`.

### How long unreleased bytes sat under a released version

The sample is every commit since 2026-08-01 that touches a release-please
package under `plugins/`, other than the 29 `chore: release main` commits
(two further commits touch only `plugins/README.md`, which is in no package):
96 package/commit pairs across 92 commits. 88 pairs (85 commits) have since been
released. The interval runs from the commit's committer time on `main` to
that of the first release commit tagged for the package that contains it
(the tags are lightweight and carry no time of their own). The median is
0.4 h; by nearest rank, p75 is 26.8 h, p90 46.6 h and the maximum 113.5 h;
25 pairs (24 commits) exceed 24 h. The other 8 pairs (7 commits, all
`docs`-typed) are still unreleased. These intervals are **exposure
windows**: the time a Codex install *could* have held content its version
did not name. They are not measured run durations.

### What reads which tree on Codex

- **Skills load from the installed cache**
  `~/.codex/plugins/cache/agentic-plugins/<p>/<version>/`. Measured by
  app-server `skills/list`: 55 of 55 skills, recorded in
  [ADR-0008](0008-companion-distribution-model.md)'s 2026-09-24 amendment.
- **Hooks run from the installed cache.** App-server `hooks/list` reports
  each plugin hook's `sourcePath`, and `${PLUGIN_ROOT}` in its command
  expanded, under `~/.codex/plugins/cache/agentic-plugins/<p>/<version>/`
  ([discovery.rs:567](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/hooks/src/engine/discovery.rs#L567)).
- **Cross-plugin locators read the snapshot**
  `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/<p>`. Nineteen
  production files reference it: the canonical and bundled `discover-peer.mjs`,
  and the four persona/orchestrator `dispatch-peer.mjs` bootstraps; image's
  `compose-dispatch.mjs`, which critique and refine also use; five
  `discover-runtime.mjs` copies, where attention holds two resolvers;
  `discover-engineer.mjs`; engineer's `parent-writeback.mjs`; runtime's
  `doctor.mjs`, with a private engineer resolver and an effective-hook
  order of source → installed → snapshot; the home-rendered
  `codex-notify-shuttle.mjs` and `agentic-statusline.mjs` templates; and
  `machine-probe.mjs`, which reads the snapshot only as an observation.
  `peer-execution-context.mjs` already prefers the installed cache over the
  snapshot, but it prefers repository source over both.

Today the two trees are identical, so this split is invisible. Once the
install is pinned (below), they differ. Any reader of the snapshot then runs
unreleased code, beside skills that come from the release.

### What pinning is available (measured)

- **Consumer side**: `codex plugin marketplace add … --ref <REF>` (or
  `owner/repo@ref`) pins the whole marketplace to one ref. A lightweight tag
  held: after a `main` push, neither the snapshot nor the cache moved. An
  annotated tag rewrote the snapshot on every start. `ls-remote` returns the
  tag object while activation records the commit, so the metadata never
  matches. The content stayed the same. Either way, **one ref cannot name
  eight independently released packages**. At the commit tagged
  `plugin-runtime-v0.97.4` (`b1b10a1`), `attention` and `designer` each
  already differ from their own release tags by one file. Read from source
  and help rather than measured: adding the same marketplace with a
  different ref is rejected as a name collision, and `upgrade` takes no
  `--ref`.
- **Publisher side**: a catalog entry may use `git-subdir` (or `url`) with
  `path`, `ref` and `sha`
  ([marketplace.rs:1020](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core-plugins/src/marketplace.rs#L1020)).
  When `sha` is present Codex checks it out and requires `rev-parse HEAD` to
  equal it
  ([loader.rs:1862](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core-plugins/src/loader.rs#L1862)),
  so `sha` wins over `ref`. A relative `url` resolves inside the marketplace
  root
  ([marketplace.rs:758](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core-plugins/src/marketplace.rs#L758)),
  so `"./"` clones from the local snapshot. The fixture, with the entry
  pinned to C1:
  - After a docs-style push of C2, the snapshot moved to C2 and the cache
    stayed at C1's bytes. The force reinstall re-cloned C1.
  - After a release C3 (a new version and tag) plus a catalog commit
    pinning C3, the cache moved to the new version directory with C3's
    bytes. The old version directory was removed, and `skills/list` served
    the new path.
  - A pin to a nonexistent 40-hex sha left the existing cache and
    `skills/list` untouched.
  - Migration: a cache already drifted to `main` under a local entry
    returned to the tag's bytes after one `codex exec` start, once the entry
    became a pin.
- **Cost on this repository**: a local sparse clone plus checkout of
  `plugins/runtime` at `plugin-runtime-v0.97.4` took 0.09 s from the
  snapshot and 12.55 s from `https://github.com/each4all/agentic-plugins`.
  The checked-out tree equals the Claude cache of `runtime 0.97.4` (0
  differing files). A pinned plugin is materialized once per marketplace
  upgrade, and once per process on the first `plugin/list`, because
  materialization precedes the version comparison.
- **What the host reports**: after a pin, `codex plugin list --json` reports
  `source` as `{"source": "git-subdir", "url": <snapshot root>, "path", "ref",
  "sha"}` instead of `{"source": "local", "path": <snapshot>/plugins/<p>}`.
  Its `version` stays the installed version, so a failed materialization
  across a version change shows as the catalog target and the installed
  version disagreeing. A failed same-version repair shows no disagreement
  (Decision 4).

## Decision

### Decision 1 — The Codex catalog pins each entry to its release commit

Every entry's `source` object in `.agents/plugins/marketplace.json` becomes
the following; `name`, `policy` and `category` are unchanged:

```json
{"source": "git-subdir", "url": "./", "path": "plugins/<p>",
 "ref": "plugin-<p>-v<version>", "sha": "<40-hex commit of that tag>"}
```

- `sha` is authoritative. It is `git rev-parse plugin-<p>-v<version>^{commit}`,
  peeled so an annotated tag can never put a tag-object id where Codex
  compares a commit.
- `ref` is the human and diagnostic label. `<version>` is the entry's release
  version.
- `url: "./"` keeps materialization local to the snapshot the host already
  fetched: no network, no second authentication path, and no network-bound
  clone on Codex's per-plugin Git runner, which has no timeout.
- The Claude catalog is unchanged.

### Decision 2 — The pin is written after the tag, and validated in stated states

**Writer.** The pin is written by the post-tag catalog sync that already
writes Claude versions (`scripts/sync-marketplace-versions.mjs` in
`release-please.yml`). That step runs after release-please cuts tags, on a
`fetch-depth: 0` checkout. The version comes from
`.release-please-manifest.json`. The step checks and stages **both**
catalogs, validates them before its bot push (a `GITHUB_TOKEN` push triggers
no workflow, so nothing downstream catches it), and keeps the
`sync catalog versions` commit subject that `scripts/lib/evidence-store.mjs`
recognizes. `workflow_dispatch` remains the repair path, and it is also the
first-activation path, because the activating change touches no package and
so cuts no release.

**Validation states.** The catalog is in one of two phases, and each check
runs in one of the states below.

- **Before activation**: every entry is `local`, as today, and the pin checks
  do not apply.
- **After activation** (an `activated` marker in the floor data file, which
  the writer sets in the same commit as the first pins; Decision 5 (a)):
  every entry is pinned and a `local` entry is invalid. Activation is
  one-way. A catalog that mixes `local` and pinned entries is invalid in
  either phase, and so is a marker without pins.
- **A package with no release tag yet** (after activation): it has no Codex
  entry until the post-tag writer adds its first pin, and the cross-catalog
  count and name checks exempt it until then.
- **Always, for a pinned entry**: source shape, name/path identity against
  the Claude entry and the package, `sha` as 40 lowercase hex, and `ref`
  grammar `plugin-<name>-v<semver>`.
- **With history and tags**: `ref` resolves; `ref^{commit}` equals `sha`;
  the tree at `sha` has `plugins/<p>/.codex-plugin/plugin.json` whose name
  is `<p>` and whose version is the `ref` version.
- **Release-PR lag**: while a release PR has advanced the manifest ahead of
  its tag (the existing `AGENTIC_RELEASE_PLEASE_PR` allowance), a valid
  released pin may **trail** the manifest. Lag never excuses a malformed or
  mismatched pin.
- **Post-tag (release job, and `main` outside the lag window)**: the pinned
  version equals the manifest version. `validate:versions` reports Codex
  pin drift the same way it reports Claude catalog drift.
- **Monotonic pin**: the baseline is the catalog on the target branch before
  the change — the pull request's base, or the catalog as it stood before the
  release job's write. A pin never moves to a lower version, and an unchanged
  version keeps the same `sha`. A `local` baseline entry (first activation)
  imposes no bound.
- **No history**: a check that needs history fails and says so. A
  structural-only pass never reports full validation.
  `marketplace-validate.yml` moves to `fetch-depth: 0`.

### Decision 3 — On Codex, a sibling plugin resolves from the installed cache, and the snapshot is never a candidate

For every cross-plugin locator, whether companion, runtime, engineer or
orchestrator:

- The Codex candidate is
  `<CODEX_HOME or ~/.codex>/plugins/cache/agentic-plugins/<p>/<version>/`.
  It must be manifest-name verified, and among retained versions the highest
  manifest-verified SemVer that passes the locator's own filter wins. Codex
  keeps one version directory per plugin after an install; the fixture's old
  directory was removed. The rule still covers more than one.
- The snapshot path is removed from every ladder. It is **not** kept as a
  fallback, because a fallback to it would silently reintroduce this defect
  whenever the cache lookup failed.
- An installed caller resolves installed siblings **before** repository
  candidates. Repository or sibling-checkout candidates apply only when the
  caller itself runs from a checkout, or when an explicit override
  (`AGENTIC_COMPANIONS_ROOT`, `AGENTIC_RUNTIME_ROOT`, `AGENTIC_ENGINEER_ROOT`,
  `AGENTIC_ORCHESTRATOR_ROOT`) names one. This closes the repository-first
  order in `peer-execution-context.mjs` for installed execution. Its
  development path moves behind an explicit override, which S2 adds; the
  file reads none today.
- A caller running from a Codex install resolves each sibling from the
  Codex cache first, whatever the locator's order is today. The Claude cache
  is used only when Codex has no such sibling installed, and that fallback is
  reported (Decision 4) because the Claude copy is not pinned (§Consequences,
  Residual). A Claude-hosted caller likewise prefers the Claude cache.
- Host detection uses the resolved `CODEX_HOME`, not the literal `/.codex/`
  path segment. Resolvers that hard-code `~/.codex` honor `CODEX_HOME`, as
  `machine-probe.mjs` and the receivers already do.
- The `discover-runtime.mjs` copies and `discover-engineer.mjs` already use
  override → same-host cache → other host's cache → sibling. The
  `dispatch-peer.mjs` bootstraps, `parent-writeback.mjs` and doctor's private
  engineer resolver are Claude-first today, and the previous bullet changes
  that for Codex-hosted callers. `compose-dispatch.mjs` keeps having no
  sibling rung, and the receivers keep their own orders apart from the Codex
  rung.
- Unchanged otherwise: companion discovery keeps ADR-0008's
  newest-compatible selection, which moves past an incompatible newest
  candidate. The runtime resolvers keep their candidate filters: the notify-,
  footer- and capability-gated ones take the newest candidate that carries
  their file, and attention's entry-brief resolver takes the newest by
  manifest alone. None re-descends to an older build when the chosen root
  fails its floor. Per-capability floors and the silent fail-closed on a
  missing or too-old root are unchanged too.
- The home-rendered receivers (the notify shuttle and the statusline) get
  new templates. Their outgoing shapes are registered in
  `data/released-receiver-shapes.json`, so installed shims read as legacy
  rather than foreign, and the operator re-renders them. A runtime release
  does not rewrite home copies.

### Decision 4 — Diagnostics keep three facts apart

For each Codex plugin, runtime reports:

1. **catalog target**: the version from `ref`, and `sha`;
2. **observed installed version**: from `codex plugin list --json`, or the
   manifest-verified cache;
3. **whether content identity was verified**.

A catalog `sha` does not prove installed bytes. A failed materialization
across a version change leaves an older cache while the catalog names a newer
target. A failed same-version repair leaves divergent bytes under a matching
version, so version agreement alone is not content identity; only fact 3 can
say so. A missing or malformed pin is an explicit `unknown` or error.
It never falls back to repository or snapshot manifests. That fallback is
exactly the comparison that would mark a correct pinned install stale
against unreleased `main`. `doctor`'s effective hooks come from the
installed package: an installed package with no hooks is authoritative, and
lookup does not fall through to snapshot or source hooks. Snapshot presence
remains "not installation evidence". Where a Codex-hosted caller resolved a
sibling from the Claude cache (Decision 3), diagnostics say so. Installation
state remains
list-authoritative ([ADR-0034](0034-codex-plugin-list-read-signal.md)), and
currentness remains advisory ([ADR-0046](0046-machine-bootstrap.md)).

### Decision 5 — Activation has two gates

- **(a) Publisher activation.** The catalog writer emits pins only when a
  checked-in per-package migration floor is met by every package's tag. The
  floor is the first release that carries Decision 3's locators, Decision
  3's receiver templates and Decision 4's diagnostics where the package has
  them, and the currently unreleased skill-root corrections of #808 for
  engineer, designer and founder. Until every floor is met, the catalog stays
  `local` and `AGENTS.md` carries the dated limitation. After activation, a
  floor failure is an **error**. The writer records activation in the floor
  data file in the commit that writes the first pins, never reverts to
  `local`, and Decision 2 rejects a manual revert.
- **(b) Machine acceptance.** A machine counts as isolated from `main` when:
  its installed packages are at or above the floor; its home receivers are
  re-rendered; a fresh Codex session resolves each sibling to a path under the
  Codex installed cache; and the evidence under Decision 8 is recorded.
  Decision 6's claim holds only on machines past (b).

### Decision 6 — The invariant this restores, and its limit

After activation, an installed Codex plugin runs a package's `main` edits only
after that package is released and its pin advances. `docs`- and `test`-typed
commits under a package reach Codex only through a release, as they already do
for a Claude version that is materialized and not replaced. Typing a package
change `docs` so that no release is routed, while Codex still received it,
stops being an option. This holds on machines past Decision 5 (b). The
snapshot keeps tracking `main`, and after activation it is **not** an install
surface. Reading it means reading unreleased bytes. Codex still performs a
clone and a reinstall whenever `main` moves; the bytes it installs are what
changes.

### Decision 7 — Rollback moves forward only

- Before activation, cancelling means not flipping.
- After activation, recovery is a forward package release plus a
  regenerated pin. No tag is moved or recreated. No version is reused or
  lowered, and a pin never moves to an older version than the one it
  replaces; Decision 2's monotonic-pin check enforces this.
- When materialization fails, the older cache stays. Across a version change
  Decision 4 reports target ≠ installed; for a same-version repair it reports
  content identity unverified. Neither is a success.
- An operator override for one machine (a local marketplace, or an explicit
  `AGENTIC_*_ROOT`) is separate from the writer, and it never enters the
  catalog.

### Decision 8 — Hook trust and runtime attestation are different obligations

- Codex `/hooks` review and trust is per hook definition. A newly
  untrusted or changed hook needs review.
- Runtime's Codex hook attestation is bound to the Codex version and the
  covered plugins' versions (`doctor.mjs`). It renews whenever those
  versions or the plugin set change, even when every hook hash is
  identical.

Machine acceptance (Decision 5 (b)) records a fresh `runtime:doctor` proof
and the evidence-loop record that `AGENTS.md` §Release process requires. The
record includes each resolved sibling root, the receivers' state, and an
eight-package comparison of the Codex cache against the pinned trees.

## Consequences

**Positive**

- On Codex, a catalog version names one tree, its release commit, and a
  successful materialization installs exactly that tree; Decision 4 reports
  when an install does not hold it. ADR-0052's release obligation then
  describes what Codex runs as well as what Claude runs. Claude keeps its
  existing, narrower guarantee (§Context), which this ADR does not change.
- No re-registration. `codex plugin marketplace add each4all/agentic-plugins`
  and `README.md` Stage 0 are unchanged, and drifted caches repair
  themselves at the next Codex start after activation (measured on the
  migration fixture). Operators who rendered the home receivers re-render
  them (Decision 3).
- The Codex catalog gains a release identity. Runtime can report catalog
  target against installed version for Codex, which ADR-0046 could not do
  while the catalog was versionless.
- An unreachable pin fails safe on the machine: the cache it already had
  stays in place. A reachable wrong commit would install; Decision 2's
  publish-time `ref^{commit}` = `sha` check is what prevents one.

**Negative**

- Dogfooding a `main` change on Codex now needs a release, or a deliberate
  local override, just as it does on Claude.
- The change spans every package. Eighteen locator files (plus
  `machine-probe.mjs`'s observation), their tests, the receiver templates,
  runtime diagnostics, the catalog writer and validators all move before a
  single pin is active, and home receivers need an operator re-render.
- Materialization cost: one local clone per pinned plugin on each
  marketplace upgrade, and one more per process on the first `plugin/list`
  (0.09 s measured for runtime).
- The snapshot and the cache now hold different trees by design. Any future
  reader that reaches for the snapshot reintroduces the defect. Decision 3
  makes that a contract, and S1–S3 add guards for it.

**Neutral**

- Codex still re-clones and force-reinstalls on every `main` move. It
  installs the pinned bytes.
- `codex plugin list --json` reports a different `source` shape.
  `machine-probe.mjs`'s installed-state parser never reads `source`.
  `doctor`'s repository-catalog summary reads `source.path`, and the
  registered-catalog reader reads only a top-level `version`.
- The dated records that call the snapshot the tree Codex serves stay as
  written. The ADR-0008 2026-09-24 amendment already names that
  disagreement.

**Residual (not decided here)**

- Claude Code's catalog stays relative-path, so a fresh Claude install, a
  reinstall, or an update that changes the version copies the marketplace's
  current tree under the catalog version.
  On this machine the Claude marketplace is a `directory` source pointing at
  the working checkout, so it copies whatever is checked out there. Pinning
  the Claude catalog is a separate decision.

## Alternatives Considered

**A. Do nothing; document that Codex tracks `main`.** This is the smallest
change. It gives up the invariant that ADR-0052, the rollback rule and the
doctor proofs rest on, since a version would no longer identify installed
bytes. Rejected by the owner.

**B. A release-only composite branch that consumers track with `--ref`.**
Release automation would assemble a commit whose `plugins/<p>` equals each
package's tag tree, and consumers would add the marketplace with
`--ref <branch>`. This keeps `local` entries and one clone, and it keeps
snapshot and cache equal, so S1–S2 and S3's receiver templates would not be
prerequisites. Rejected:
every existing consumer must remove and re-add the marketplace (add rejects
a changed ref under the same name), a default install from `README.md`
still receives `main`, and it needs a new tree-synthesis step and a
protected branch whose accidental edits must be detected.

**C. Release on every package-touching commit** (make `docs`/`test`
bump-inducing). This does not close the window. Codex still receives the
commit at merge, and the release PR merges later (the exposure windows in
§Context: p75 26.8 h). It also inflates releases.

**D. Consumer `--ref` to one release tag.** One ref cannot name eight
packages. Measured at `plugin-runtime-v0.97.4`, two packages already differ
from their own tags. An annotated tag also churns the snapshot on every
start.

**E. `git-subdir` with an `https` `url`.** This is equivalent in outcome.
Rejected for cost and exposure: 12.55 s against 0.09 s for runtime, a network
dependency on every upgrade, eight clones per upgrade, and no timeout on the
per-plugin Git runner.

**F. Keep the snapshot as a last-resort discovery fallback.** Rejected
under Decision 3. A fallback that runs unreleased code whenever the cache
lookup fails turns a visible error into a silent wrong answer.

**G. `url` vs `git-subdir` source kind.** Both accept `path`, `ref` and
`sha`. `git-subdir` requires `path` and states the intent. It is chosen for
legibility; the choice has no behavioural consequence.

## Implementation manifest

Ordering is load-bearing. Per-package commits follow ADR-0016. S1–S3 are
bump-inducing and so carry the unreleased #808 corrections into the tags
the floor names.

- **S1 — Companion discovery.** `companions/discover-peer.mjs` and its
  bundle (`scripts/sync-companion-bundles.mjs` keeps them equal).
  The engineer, founder, designer and orchestrator `dispatch-peer.mjs`
  bootstraps, which also gain same-host preference for a Codex-hosted caller.
  Image's `compose-dispatch.mjs`. Tests for a custom
  `CODEX_HOME`, competing Claude/Codex versions, multiple retained
  versions, a newer snapshot present (it must not be chosen), and an
  installed caller inside a repository cwd.
- **S2 — Sibling resolvers.** The five `discover-runtime.mjs` copies
  (attention's two resolvers, and founder's and designer's capability
  filters, preserved), `discover-engineer.mjs`, `parent-writeback.mjs` and
  doctor's private engineer resolver (both gaining same-host preference), and
  `peer-execution-context.mjs`
  (installed before repository, with a new explicit development override).
  Package documentation moves with its code: the companions, engineer,
  orchestrator and attention READMEs, the eleven persona skill-table
  sentences, the seven orchestrator rows, `machine-bootstrap-contract.md`,
  and the exact-text guard
  `tests/plugin-shape/test-codex-plugin-root-contract.mjs`.
- **S3 — Runtime diagnostics and receivers.** Decision 4's three facts in
  `machine-probe.mjs`, `doctor.mjs` (catalog summary, currentness,
  effective-hook source) and `plugin-management-plan.mjs` (no source-manifest
  currentness; remediation text no longer says `./plugins/<name>`). New
  shuttle and statusline templates with their released shapes registered.
- **S4 — Catalog writer and gates.** The sync script writes and validates
  pins. The validators implement Decision 2's states. Add the floor data file
  and its check. Update `release-please.yml` (both catalogs checked and
  staged) and `marketplace-validate.yml` (`fetch-depth: 0`). Replace the
  plugin-shape assertions that require `source: "local"` with pin-shape
  assertions. This lands with the writer **disabled** until the floors are
  met, then is activated with `workflow_dispatch`.
- **S5 — Non-package documentation.** At activation, reword `AGENTS.md`'s
  dated limitation to hold per machine until Decision 5 (b), and update its
  catalog-sync paragraph, which S4 makes cover the Codex catalog too.
  Dated records stay as written, per the citation-move rule. ADR-0032's and
  ADR-0035's "marketplace snapshot" wording stays accurate, because
  `url: "./"` still materializes from the snapshot.
- **S6 — Machine acceptance.** Decision 5 (b) and Decision 8 on the owner's
  machine: re-render the receivers, re-review hooks where Codex asks,
  record a fresh doctor proof, and write the evidence-loop record. The
  record includes the eight-package cache-vs-pin comparison (0 differing
  files is the acceptance bar) and each resolved sibling root.

## Verification recipe

The fixture that produced §Context's measurements can be re-run by the S4
pull request. It is read-only toward the real `~/.codex`:

1. `git init --bare mp.git`, plus a work repository with
   `.agents/plugins/marketplace.json` (marketplace `fx`) and
   `plugins/alpha/.codex-plugin/plugin.json` (version `0.1.0`) with one
   skill. Commit C1, tag `plugin-alpha-v0.1.0`, and push.
2. `CODEX_HOME=<scratch>/home`, with `config.toml` declaring
   `[marketplaces.fx]` as `source_type = "git"` and
   `source = "file://<scratch>/mp.git"`. Then
   `codex plugin marketplace upgrade fx` and `codex plugin add alpha@fx`.
3. Control: with a `local` entry, push a same-version body change and start
   `codex exec … < /dev/null`. The cache body follows `main`.
4. Treatment: pin the entry
   (`git-subdir`, `url "./"`, `ref`, `sha` = C1), push a same-version change,
   and start `codex exec`. The cache body stays at C1. Release C3 with a new
   version and tag, re-pin, and start again: the new version directory,
   with the old one removed.
5. Read `skills/list` and `hooks/list` from `codex app-server` (JSON-RPC:
   `initialize`, `initialized`, then the request) to confirm which paths
   are served.

## References

- [ADR-0006](0006-directory-layout-install-pattern.md) — the 2026-09-18
  rollback rule, which now points here for the Codex rung.
- [ADR-0008](0008-companion-distribution-model.md) — companion discovery;
  its 2026-09-24 amendment recorded the versioned cache and deferred this
  decision.
- [ADR-0016](0016-cross-package-commit-splitting.md) — per-package commits.
- [ADR-0019](0019-cross-plugin-invocation-contract.md),
  [ADR-0039](0039-completion-footer-activation.md),
  [ADR-0040](0040-operator-observability.md) — the discovery ladders whose
  Codex rung this replaces.
- [ADR-0034](0034-codex-plugin-list-read-signal.md) — list-authoritative
  installed state.
- [ADR-0046](0046-machine-bootstrap.md) — registered-catalog authority and
  advisory currentness.
- [ADR-0048](0048-bootstrap-observability.md) §2 — its 2026-08-24
  amendment: the statusline shim's discovery ladder stays copied into
  installed bytes, and changes when install layouts change.
- [ADR-0051](0051-host-parity-baseline-source.md) §Decision 3 and
  §Alternatives E — the earlier reading of the force-reinstall path, and the
  withdrawn catalog pin.
- [ADR-0052](0052-release-obligation-enforcement.md) — the release
  obligation whose premise this restores on Codex.
- [ADR-0056](0056-assurance-matcher-removal.md) §Decision 9 — supersession
  atomic with acceptance.
- Codex CLI source at
  [`rust-v0.156.1`](https://github.com/openai/codex/tree/rust-v0.156.1):
  `core-plugins/src/{manager.rs, marketplace_upgrade.rs,
  marketplace_upgrade/git.rs, loader.rs, marketplace.rs}`,
  `app-server/src/{in_process.rs, lib.rs}`, `hooks/src/engine/discovery.rs`.
