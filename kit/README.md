# kit/

Plugin authoring toolkit — utilities for agentic-plugins plugin developers
(both internal and any future external contributors).

## Status

**Stub.** No implementation yet. To be built as plugins emerge and
demand patterns crystallize.

## Planned contents

- `adapter-generator/` — Generate per-host adapter scaffolding from
  CORE plugin spec. Saves authors from hand-writing manifest files,
  hook configurations, and persona-to-TOML conversions
- `manifest-templates/` — Boilerplate `.claude-plugin/plugin.json` and
  `.codex-plugin/plugin.json` templates with required fields and
  documented optional ones
- `lint/` — Adapter-contract conformance checks per
  `docs/adr/0002-adapter-contract.md`. Verifies a plugin's adapter
  implements all four required items (manifest mapping, event mapping,
  companion invocation, path resolution)

## When to build kit features

When a pattern is observed in 2+ plugins, extract it into kit. Until
then, manual authoring is fine for the small initial plugin set.
