# Changelog

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

### Deferred (follow-up PRs)

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
- PR7 — real-topic dogfood → ADR-0036 `Accepted` flip + ADR-0010
  cascade amendment + AGENTS.md / ARCHITECTURE.md inventory updates
- Separate `plugins/runtime` PR (ADR-0016 cross-package rule) —
  `PLUGIN_NAMES` inventory recognition in `runtime:doctor` /
  `runtime:settings`, plus extending the ADR-0031 session-handoff
  seam's `workflow_kind` enum (`normalizeProjection` currently accepts
  engineer/orchestrator only, so founder projections degrade the
  completion footer to context-risk-only until that lands)
