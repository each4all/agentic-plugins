# ADR-0030: Codex `plugin_hooks` removal — stage-aware runtime migration

## Status

Accepted

## Context

Codex CLI removed the `plugin_hooks` feature flag in PR #22552
(shipped ~0.134.0). On the installed Codex CLI `0.136.0`,
`codex features list` reports `plugin_hooks` with stage `removed`
(the entry is retained only for legacy-config compatibility), while
generic `hooks` is `stable`. Plugin-bundled hooks now load when the
plugin is enabled and generic `[features].hooks` (default on) is set,
declared via a `.codex-plugin/plugin.json` `hooks` entry or the default
`hooks/hooks.json`, and still require `/hooks` review + trust. PR #369
refreshed the two runtime host-truth baselines
([`host-parity-baseline.md`](../../plugins/runtime/docs/host-parity-baseline.md),
[`codex-capability-baseline.md`](../../plugins/runtime/docs/codex-capability-baseline.md))
to document this and registered this code migration as a follow-up
(ADR-first per AGENTS.md).

The runtime `doctor` and `settings` code still treats `plugin_hooks` as
the enablement gate:

- `doctor.mjs` `inspectCodexFeatureSurface` reads `codex_plugin_hooks`
  and `codex_plugin_hooks_stage`. The `enable-codex-plugin-hooks`
  recommendation (`doctor.mjs:893`) and the
  `codex_plugin_hooks_feature_disabled` host-parity issue
  (`doctor.mjs:1166`) fire when `codex_plugin_hooks !== true`; the
  Codex-plugin-hooks status resolves to `feature_disabled` in that case.
- `settings.mjs` `buildCodexPluginHooksHostConfigPlan`
  (`settings.mjs:1648`) plans and, under `--apply-codex-plugin-hooks`,
  writes `~/.codex/config.toml [features].plugin_hooks = true`. The
  `mutation_boundary` advertises `session_command:
  'codex --enable plugin_hooks'`.

On `0.136.0`, `codex_plugin_hooks` is `false` (stage `removed`), so
doctor recommends **enabling a removed flag** and settings would
**write a dead flag**. That is a host-truth regression in operator
output — the kind of drift ADR-0026 exists to catch.

The installed host is `0.136.0`, but operators may still run Codex
`0.130`–`0.133`, where `plugin_hooks` is a real flag
(`under development` → `stable`). The runtime reads `codex features
list` dynamically on every run, so it can adapt its guidance per host
rather than hardcoding a single version assumption.

## Decision

Make the runtime plugin-hook readiness path **stage-aware**, keyed on
the observed `codex features list` `plugin_hooks` stage. A single shared
classifier (`pluginHooksStage === 'removed'`) gates the two branches so
`doctor` and `settings` apply one rule.

1. **When `plugin_hooks` stage is `removed`** (Codex ≳ 0.134):
   plugin-hook readiness no longer depends on `plugin_hooks`. Readiness
   is determined by generic `[features].hooks` enabled (default on) +
   bundled plugins + manifest exposure + operator `/hooks` review/trust.
   - **doctor**: do not emit `enable-codex-plugin-hooks`. If generic
     `hooks` is off, emit a generic `enable-codex-hooks` recommendation
     instead. The Codex-plugin-hooks status and the host-parity issue
     resolve on generic hooks + packaging, not on `plugin_hooks`. The
     stage is surfaced as evidence (`plugin_hooks=removed`) so the output
     explains why the legacy gate is skipped.
   - **settings**: `buildCodexPluginHooksHostConfigPlan` plans no write
     (status `not_applicable_removed`); `--apply-codex-plugin-hooks`
     becomes an explicit no-op with a "flag removed" warning rather than
     writing a dead flag. `mutation_boundary.session_command` /
     `persistent_config_snippet` reflect generic hooks (default on)
     instead of `codex --enable plugin_hooks`.
2. **When stage is not `removed`** (`under development` / `stable`,
   Codex `0.130`–`0.133`): keep the existing `plugin_hooks` enablement
   path unchanged, so older hosts still receive correct guidance and the
   `--apply-codex-plugin-hooks` executor still functions.
3. The `--attest-codex-hook-review` artifact path is **unchanged** in
   both branches — trust attestation is stage-independent and remains
   the only runtime-owned way to record the operator `/hooks` step.

The refreshed Hooks rows in the two baselines are the behavioral spec
for the `removed` branch.

## Consequences

**Positive**: On `0.136.0`, doctor/settings stop recommending and
writing a removed flag and instead give correct generic-hooks guidance.
Operators still on `0.130`–`0.133` keep working unchanged. The
stage-keyed rule adapts to the actual host on each run, using the
`features list` stage signal the baselines already document, instead of
adding another hardcoded version gate.

**Negative**: doctor and settings carry dual-path logic (removed vs
legacy) and the tests to cover both until the legacy path can be
dropped. The `--apply-codex-plugin-hooks` executor keeps a
now-mostly-inert surface (no-op on modern hosts) rather than being
deleted outright.

**Neutral**: `plugin_hooks` references remain in code and docs but are
reframed as stage-gated legacy rather than the primary gate. A future
ADR may drop the legacy path and the `--apply-codex-plugin-hooks`
executor once Codex `0.130`–`0.133` support is no longer needed.

## Alternatives Considered

- **Removed-premise simplification**: delete the `plugin_hooks` path
  entirely, key only on generic `hooks`, and drop
  `--apply-codex-plugin-hooks`. Simpler and matches the `0.136`
  baseline, but breaks correct guidance for operators still on Codex
  `0.130`–`0.133`, where `plugin_hooks` is the real gate. Rejected for
  losing host-range robustness when the runtime already reads the stage
  dynamically and can support both branches cheaply. (Chosen against by
  the owner on 2026-06-03.)
- **Leave the code as-is (docs-only)**: PR #369 refreshed only the
  baselines. Leaving the code unchanged keeps emitting a
  dead-flag recommendation and a dead-flag write plan on `0.136`.
  Rejected — it is a host-truth regression in operator-facing output,
  exactly what the baselines now say is wrong.
