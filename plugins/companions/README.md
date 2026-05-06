# companions plugin

First-party Claude Code / Codex CLI companion bridges, packaged as an
installable plugin so consumer plugins (research, future Stage 2/3
plugins) can reach them via cache-glob discovery.

This is a **script-only library plugin** per
[ADR-0008 § (a)](../../docs/adr/0008-companion-distribution-model.md):
it ships `scripts/` and the two host manifests, plus an empty
`skills/` placeholder required by the Codex vendored plugin spec
(see [ADR-0008 § (a) Codex spec compliance carve-out](../../docs/adr/0008-companion-distribution-model.md)).
It does not define user-facing slash commands, hooks, subagents, or
any functional skills content. The bundled scripts are byte-identical
copies of the canonical
[`companions/claude-companion.mjs`](../../companions/claude-companion.mjs)
and [`companions/codex-companion.mjs`](../../companions/codex-companion.mjs),
synced via `npm run sync:companions -- --write` and drift-detected in
CI.

The wire-spec contract honored by both companions is
[`companions/contract.md`](../../companions/contract.md) v0.1.1.

## Install

### Claude Code

```sh
/plugin marketplace add each4all/agentic-plugins
/plugin install companions@agentic-plugins
```

After install, the cache directory is at:

```
~/.claude/plugins/cache/agentic-plugins/companions/<version>/scripts/
```

### Codex CLI

```sh
codex plugin marketplace add each4all/agentic-plugins
```

Then enable `companions` by adding the following to `~/.codex/config.toml`
(codex-cli 0.128.0 does not expose an in-app enable command):

```toml
[plugins."companions@agentic-plugins"]
enabled = true
```

Marketplace clone location (per ADR-0008 § (b), Amendment 2026-05-04
verified against codex-cli 0.128.0):

```
~/.codex/.tmp/marketplaces/agentic-plugins/plugins/companions/scripts/
```

The clone is a full git mirror of the marketplace repo and exists
independently of the plugin's enable state.

## Discovery for consumer plugins

Consumer plugins (e.g. `plugins/engineer/`) reach the bundled companion
scripts at runtime via cache-glob, with `AGENTIC_COMPANIONS_ROOT` env
override taking precedence when set. The discovery library
(`scripts/discover-peer.mjs`) is owned by this companions plugin and
imported by the consumer's adapter wrapper per ADR-0008 § (b.1).

**Since v0.3.0**, the canonical discovery algorithm itself lives inside
this plugin at [`scripts/discover-peer.mjs`](scripts/discover-peer.mjs).
Consumer adapter scripts bootstrap the companions cache root (small
~25-line cache-glob to find the companions plugin install), then import
`discover-peer.mjs` and call `discoverPeerCompanion({ peer })` for the
canonical resolution. This eliminates duplicated discovery code across
consumer plugins (plugin-boundary policy ADR-0010 §6 trigger evaluation:
discovery has high cohesion with companion invocation and is absorbed
into this plugin rather than spun out as a separate framework primitive).

### `AGENTIC_COMPANIONS_ROOT` (env override)

When set to an absolute path, the discovery script uses that path
directly and skips cache-glob. The path points to a directory
containing `claude-companion.mjs`, `codex-companion.mjs`, AND
`discover-peer.mjs` (the script-pair plus the discovery library).

**Breaking change in v0.3.0**: prior to v0.3.0 the discovery library
lived inline inside each consumer plugin's adapter script, and the
env-override directory only needed the script pair. As of v0.3.0
the canonical discovery library was extracted into the companions
plugin (`scripts/discover-peer.mjs`), so the env-override directory
must include `discover-peer.mjs` alongside the script pair.

The canonical source-tree `companions/` directory now ships all
three files and remains the documented dev/CI override target —
existing workflows that set `AGENTIC_COMPANIONS_ROOT=$REPO/companions`
continue to work after pulling v0.3.0. Users with custom override
directories that include only the script pair must add
`discover-peer.mjs` (drop in a copy from `companions/discover-peer.mjs`
or from any installed `companions` plugin v0.3.0+ cache directory).

If the directory lacks `discover-peer.mjs`, the wrapper fails fast
with a clear diagnostic (no silent fall-through to cache-glob —
that would surprise users who set the env override expecting cache
to be bypassed).

Useful for development workflows (point at source-tree `companions/`
without installing) and CI smoke flows.

### Cache-glob (auto-discovery fallback)

When `AGENTIC_COMPANIONS_ROOT` is unset, the consumer plugin globs the
host's plugin cache for the bundled script:

**Claude Code**:

```
~/.claude/plugins/cache/agentic-plugins/companions/*/scripts/<companion>.mjs
```

**Codex CLI** (per ADR-0008 § (b), Amendment 2026-05-04):

```
~/.codex/.tmp/marketplaces/agentic-plugins/plugins/companions/scripts/<companion>.mjs
```

The discovery algorithm (mandatory, applies to both hosts; see ADR-0008
§ (b)):

1. Glob the wildcard pattern.
2. For each match, read the plugin's `.codex-plugin/plugin.json` (or
   `.claude-plugin/plugin.json`) and verify `name == "companions"`.
   This eliminates cross-plugin false-match risk if another plugin in
   the same marketplace cache ships its own `scripts/` directory.
3. Among manifest-verified matches, select the newest valid one
   (SemVer descending; first with a working `--prompt-file` flag and a
   compatible `CONTRACT_VERSION` per `companions/contract.md` § 8.3 —
   typically the same major version as the consumer's required range).
4. If no manifest-verified match resolves, fall through to graceful
   degradation per ADR-0008 § (e) — proceed local-only and surface a
   completion warning pointing at the install command above.

## Drift protection

The bundled scripts MUST stay byte-identical to the canonical
`companions/{claude,codex}-companion.mjs`. Three mechanisms enforce
this:

1. **Sync script**: `npm run sync:companions -- --write` reads
   canonical and writes to `plugins/companions/scripts/`. Run after
   editing the canonical scripts.
2. **Drift-detection test**: `tests/plugin-shape/test-companions-plugin.mjs`
   fails if the bundled copies differ from canonical. Runs as part of
   `npm test`.
3. **CI guard**: `.github/workflows/{claude,codex}-tests.yml` invoke
   the drift-detection test on every PR that touches `companions/` or
   `plugins/companions/`.

If you edit a canonical companion script, run the sync command before
committing. The sync command preserves the executable bit.

## References

- [ADR-0008](../../docs/adr/0008-companion-distribution-model.md) —
  companion distribution model (this plugin + cache-glob discovery +
  env override)
- [`companions/contract.md`](../../companions/contract.md) — wire-spec
  contract v0.1.1
- [ADR-0001](../../docs/adr/0001-hexagonal-architecture.md) — layered
  separation (CORE / ADAPTER / COMPANION)
- [ADR-0004](../../docs/adr/0004-companion-ownership.md) — first-party
  companion ownership
- [ADR-0006](../../docs/adr/0006-directory-layout-install-pattern.md) —
  per-plugin directory layout (this plugin's script-only library
  shape is the documented exception per ADR-0008 § (a))
