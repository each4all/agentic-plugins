# Changelog

## [0.4.2](https://github.com/each4all/agentic-plugins/compare/plugin-founder-v0.4.1...plugin-founder-v0.4.2) (2026-08-08)


### Bug Fixes

* **plugin/founder:** scope checkpoint re-injection to post-compact on both hosts ([49a88d7](https://github.com/each4all/agentic-plugins/commit/49a88d7b5cf471fb576e7f079e254dacf4afba7d))

## [0.4.1](https://github.com/each4all/agentic-plugins/compare/plugin-founder-v0.4.0...plugin-founder-v0.4.1) (2026-08-03)


### Bug Fixes

* **plugin/founder:** make the peer-run sweep preview state what --apply deletes ([45b6217](https://github.com/each4all/agentic-plugins/commit/45b62176b84cb9994a9ff4a576f7e4ca495a4b3a))
* **plugin/founder:** re-verify a peer run immediately before deleting it ([b79954a](https://github.com/each4all/agentic-plugins/commit/b79954a085d01a4151b669ad06161b51b9e1bdb2))

## [0.4.0](https://github.com/each4all/agentic-plugins/compare/plugin-founder-v0.3.1...plugin-founder-v0.4.0) (2026-07-13)


### Features

* **plugin/founder:** emit terminal handoff sidecar + completion footer (ADR-0043 S3) ([578936b](https://github.com/each4all/agentic-plugins/commit/578936b43ad832c9721bb51c221852bdb20b41db))

## [0.3.1](https://github.com/each4all/agentic-plugins/compare/plugin-founder-v0.3.0...plugin-founder-v0.3.1) (2026-07-12)


### Bug Fixes

* **plugin/founder:** register peer-runner child observers synchronously with spawn ([5900c7f](https://github.com/each4all/agentic-plugins/commit/5900c7f5302eb74b16a9603cc23c3d03bc35e113))

## [0.3.0](https://github.com/each4all/agentic-plugins/compare/plugin-founder-v0.2.0...plugin-founder-v0.3.0) (2026-07-04)


### Features

* **plugin/founder:** emit ADR-0040 §5 peer-run terminal self-sensor notifications ([020ac92](https://github.com/each4all/agentic-plugins/commit/020ac92299ec54c9cf03946c287522fbe87da9b9))

## [0.2.0](https://github.com/each4all/agentic-plugins/compare/plugin-founder-v0.1.0...plugin-founder-v0.2.0) (2026-06-15)


### Features

* **plugin/founder:** copy-trim workflow machinery + hooks + tests (ADR-0036 PR2) ([#422](https://github.com/each4all/agentic-plugins/issues/422)) ([614bf15](https://github.com/each4all/agentic-plugins/commit/614bf156b5e2ed2e11410b8e11f26f6160a6b57b))
* **plugin/founder:** founder L3 persona — new-business planning workbench (ADR-0036) ([d0a4d10](https://github.com/each4all/agentic-plugins/commit/d0a4d104331adf8e0f0c0a7655eda2a50c37c347))
* **plugin/founder:** scaffold founder persona plugin (ADR-0036 PR1) ([#420](https://github.com/each4all/agentic-plugins/issues/420)) ([749b705](https://github.com/each4all/agentic-plugins/commit/749b7051575827fbeb600ab56cd90ef5a9e573b3))

## 0.1.0 (initial scaffold seed)

Inert scaffold per [ADR-0036](../../docs/adr/0036-founder-persona-business-planning.md)
§Implementation Roadmap PR1. No user-facing surface ships in this
version — the seed exists so catalogs, release automation, and
plugin-shape tests are wired atomically before machinery lands.
(The first release-please tag for this package will be a MINOR bump
from this seed, per the orchestrator/runtime precedent.)

### Features

- Second L3 persona plugin (`founder`) registered per
  [ADR-0010](../../docs/adr/0010-plugin-boundary-policy.md) 4-layer
  composition — new-business planning workbench (ADR-0036)
- Host manifests for Claude Code (`.claude-plugin/plugin.json`) and
  Codex CLI (`.codex-plugin/plugin.json`), both carrying the explicit
  incubating marker; no `skills`/`hooks`/`interface` declarations yet
- Marketplace catalog entries in both hosts' catalogs
- release-please package wiring (`plugin-founder` component,
  manifest version sync via extra-files)
- Plugin-shape conformance test with a PR1-only negative boundary
  (asserts the scaffold stays inert until the first surface PR)

### Shipped through the ADR-0036 roadmap (PR2–PR7)

The follow-up PRs all landed:

- PR2 — workflow machinery copy-trim: `state.mjs`, `dispatch-peer.mjs`,
  `peer-runner.mjs`, `stop-archive.mjs`, `session-handoff.mjs`, hooks
- PR3 — `founder:investigate` (business-brief profile +
  `business-brief-spec.md`: 5-tier business source taxonomy,
  freshness/jurisdiction tags, paywalled-source rules, privacy gate) +
  `founder:frame` (business Task Profile)
- PR4 — `founder:decide` (persona-local business axes registry with
  gate-style regulatory/safety axes) + `founder:compose`
- PR5 — `founder:critique` + `founder:refine` + the nine
  business-anchored ensemble point templates
- PR6 — `founder:start` lifecycle macro + meta skills
  (resume / checkpoint / peer-now with Host-availability matrices)
- PR7 — real-topic dogfood (validated end-to-end) → ADR-0036
  `Accepted` flip + ADR-0010 cascade amendment + AGENTS.md /
  ARCHITECTURE.md inventory updates

### Still deferred (separate `plugins/runtime` PR, ADR-0016 cross-package rule)

`PLUGIN_NAMES` inventory recognition in `runtime:doctor` /
`runtime:settings`, plus extending the ADR-0031 session-handoff seam's
`workflow_kind` enum (`normalizeProjection` currently accepts
engineer/orchestrator only, so founder projections degrade the
completion footer to context-risk-only until that lands).
