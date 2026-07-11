# kit/

Plugin authoring toolkit — utilities for agentic-plugins plugin developers
(both internal and any future external contributors).

## Status

**Active.** `lint/` ships the plugin-shape conformance check that runs
in CI on every push (per-host `claude-tests.yml` and `codex-tests.yml`).
The other sub-directories listed under "Planned" below are not built —
they are trigger-driven futures.

## Current contents

- **`lint/`** — Plugin-shape conformance checks.
  - `check-plugin-shape.mjs` — verifies manifest required fields,
    name match across `.claude-plugin/plugin.json` and
    `.codex-plugin/plugin.json`, skills path resolution, scripts
    executable bit, adapters/hosts/{scripts,hooks} traversal, and —
    for hook-bearing plugins (ADR-0040 §3 hook-only category) —
    Claude hook registration validity from BOTH sources: the root
    default `hooks/hooks.json` whenever it exists (Codex default-file
    discovery reads it regardless of manifests), and every
    `.claude-plugin/plugin.json` `hooks`-declared path (`./`-prefixed,
    `.json`-suffixed, POSIX separators, inside the plugin lexically AND
    physically — existing targets are realpath-checked so in-plugin
    symlinks to outside content are rejected — no duplicate or
    root-default redeclaration by real file identity; string or
    string-array form — inline objects are rejected as a policy this
    linter sets, following ADR-0006's file-backed layout convention).
    Each registration file gets structural validation plus existence +
    physical containment of every `${CLAUDE_PLUGIN_ROOT}/…` command
    target inside the plugin.
  - Run locally via `npm run lint:plugin-shape`.
  - CI-gated on both host workflows in `.github/workflows/`.

## Planned (trigger-driven, not yet built)

- **Adapter-contract conformance lint** — verifies a plugin's adapter
  implements all four required items per
  [ADR-0002](../docs/adr/0002-adapter-contract.md) (manifest mapping,
  event mapping, companion invocation, path resolution). Trigger:
  third-party adapter author submits a PR, or a third in-tree adapter
  pattern emerges (currently 2 in tree: companions Stage 1 pattern,
  engineer Stage 2 pattern). Surfaced as a follow-up by the 2026-05-06
  Stage 2.5+ exit audit (Q3 G-5).
- **`adapter-generator/`** — generate per-host adapter scaffolding
  from a CORE plugin spec, saving authors from hand-writing manifests,
  hook configurations, and persona-to-TOML conversions. Trigger:
  3+ plugins in tree (currently 2 — `companions`, `engineer`;
  `designer` pending Stage 3).
- **`manifest-templates/`** — boilerplate `.claude-plugin/plugin.json`
  and `.codex-plugin/plugin.json` templates with required fields
  documented. Trigger: external contributor onboarding pain. Manual
  authoring remains fine for the small initial plugin set.

## When to build kit features

When a pattern is observed in 2+ plugins and the manual authoring cost
exceeds the maintenance cost of the kit feature, extract it. Until
then, manual authoring is preferred — `kit/` accumulates only
sustained patterns, not speculative ones.
