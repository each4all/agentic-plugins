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
  - **Skill frontmatter conformance** — every `SKILL.md` under a
    plugin's declared and conventional skills roots is validated
    against the rule set Codex enforces in its bundled
    `skills/.system/skill-creator/scripts/quick_validate.py`: only the
    keys `name`, `description`, `license`, `allowed-tools`, `metadata`;
    `name` and `description` both required; `name` hyphen-case within
    64 characters; `description` free of angle brackets (`<`, `>`) and
    within 1024 characters. Parity is measured against that validator's
    behaviour — CRLF is fine (it loads through `Path.read_text()`), and
    an unquoted `123`, `true`, `2026-08-03` or `*alias` is rejected
    because PyYAML does not resolve those to strings. Lengths are
    counted in code points, so an emoji costs one character.
  - **Two skill-frontmatter rules are deliberately stricter** than that
    validator, both fail-closed. A duplicate frontmatter key is an
    error (PyYAML silently keeps the last value; a duplicate in a
    shipped skill is a defect either way). A block scalar (`|`, `>`) or
    any value spanning lines is rejected rather than measured, because
    this linter carries no YAML dependency and a parser that guessed at
    a value it cannot read exactly would make the check vacuous.
    **Write skill descriptions as single-line quoted scalars** — the
    convention every packaged skill already follows.
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
