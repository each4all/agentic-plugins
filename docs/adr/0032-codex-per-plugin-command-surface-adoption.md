# ADR-0032: Codex per-plugin command surface adoption — stage-aware runtime recognition

## Status

Accepted

## Context

Codex CLI `0.137.0` added a per-plugin `codex plugin` command surface
beyond the prior marketplace-only shape. On the installed Codex CLI
`0.137.0`, `codex plugin --help` exposes:

- `add <PLUGIN[@MARKETPLACE]>` — install a plugin from a configured
  marketplace snapshot;
- `list` — list installed plugins (`--json`, `--available` for
  uninstalled marketplace plugins);
- `remove` — remove an installed plugin from local config and cache;
- `marketplace` — add/list/upgrade/remove configured marketplaces.

It does **not** expose `update` / `enable` / `disable` / `details` /
`validate` / `prune`, so this is not full Claude `claude plugin ...`
parity. PR #389 refreshed the two runtime host-truth baselines
([`host-parity-baseline.md`](../../plugins/runtime/docs/host-parity-baseline.md),
[`codex-capability-baseline.md`](../../plugins/runtime/docs/codex-capability-baseline.md))
to document the per-plugin surface and registered this code migration as
a follow-up (ADR-first per AGENTS.md;
[`plugins/runtime/docs/follow-ups.md`](../../plugins/runtime/docs/follow-ups.md)
per-plugin adoption entry).

The runtime `doctor` and `settings` code still models the Codex surface
as marketplace-only and emits now-false host-capability claims:

- `doctor.mjs` `inspectCli` probes only `codex plugin marketplace
  --help` (`doctor.mjs:108`), never `codex plugin --help`, so the
  per-plugin `add`/`list`/`remove` subcommands are not observed.
- `doctor.mjs` `buildPluginCommandSurface` hardcodes
  `codex.mode = plugin_marketplace ? 'marketplace-only' : 'unknown'`
  (`doctor.mjs:1468`); `supports.install_plugin` is `false` even though
  `codex plugin add` installs; `limits` assert the host exposes
  "marketplace add/upgrade/remove ... unless the host exposes an
  explicit per-plugin install/update command" (`doctor.mjs:1478-1479`).
- The `codex_marketplace_command_shape` host-parity warning
  (`doctor.mjs:1296`) fires whenever `plugin_marketplace && !
  plugin_install_command`, claiming Codex exposes marketplace semantics
  "rather than the Claude-style plugin install/list surface".
- `buildCodexCacheMaterialization` reasons that "current Codex CLI
  exposes marketplace add/upgrade/remove rather than per-plugin
  install/list" (`doctor.mjs:3630`).
- `settings.mjs` `pluginRecommendations` emits a
  `materialize-plugin-cache` detail string with the same false claim and
  `evidence.command_surface = 'marketplace-only'`
  (`settings.mjs:770,773`), plus an `add-marketplace` detail that says
  "Codex exposes marketplace add/upgrade/remove, not per-plugin install"
  (`settings.mjs:788`).
- The `settings`/`doctor` SKILL files, `commands/settings.md`, and
  `runtime/README.md` describe the marketplace-only behavior; the runtime
  tests assert the `marketplace-only` label.

On `0.137.0` this is a host-truth regression in operator output — the
kind of drift ADR-0026 exists to catch, and the same class of fix as the
ADR-0030 `plugin_hooks` removal migration.

Operators may still run Codex `0.130`–`0.136`, where the per-plugin
`add`/`list`/`remove` surface is absent and the marketplace-only model is
correct. The runtime reads `codex plugin --help` dynamically on every
run, so it can adapt its guidance per host rather than hardcoding a
single version assumption.

## Decision

Make the runtime Codex plugin command surface **stage-aware**, keyed on
the observed `codex plugin --help` command list (the presence of the
per-plugin `add`/`list`/`remove` subcommands), not on the Codex version
number. Detection is **recognition-only**: runtime reports the
per-plugin surface but does not execute `codex plugin add`/`remove`
against the host.

1. **Probe and detection** (`doctor.mjs`): capture `codex plugin --help`
   as a dedicated probe and pass it to `inspectCodexFeatureSurface`,
   which precisely detects the per-plugin subcommands from the help
   Commands block (`^\s+add\b` / `^\s+list\b` / `^\s+remove\b`) instead
   of loose substring matching over the combined help blob:
   - `plugin_install_command` ← `codex plugin add` (Codex's per-plugin
     install verb is `add`);
   - `plugin_list_command` ← `codex plugin list`;
   - `plugin_remove_command` ← `codex plugin remove` (new flag).
   - The marketplace flags (`plugin_marketplace`,
     `plugin_marketplace_add`/`upgrade`/`remove`) keep their existing
     detection over the marketplace help, unchanged.
2. **When the per-plugin surface is present** (Codex ≳ 0.137):
   - `mode` resolves to `per-plugin-and-marketplace` (distinct from
     Claude's `per-plugin-command`, because Codex still lacks
     update/enable/disable/details/validate/prune).
   - `supports` exposes `install_plugin` / `list_plugin` /
     `remove_plugin` as `true`, with `update_plugin: false` kept explicit
     so the non-parity is visible in the data.
   - `limits` state that Codex exposes per-plugin add/list/remove plus
     marketplace add/upgrade/remove, lacks the rest of the Claude verbs,
     and that `runtime:settings` recognizes the surface but does not
     auto-execute `codex plugin add` (execution wiring is a deferred
     follow-up).
   - The host-parity entry becomes an informational
     `codex_plugin_command_partial_parity` note instead of the
     marketplace-only warning.
   - `buildCodexCacheMaterialization` drops the false "rather than
     per-plugin install/list" claim and may suggest `codex plugin add
     <plugin>@<marketplace>` as a manual materialization step.
   - `settings.mjs` threads the recognized surface into
     `pluginRecommendations` so the `materialize-plugin-cache` detail and
     evidence reflect the per-plugin surface.
3. **When the per-plugin surface is absent** (Codex `0.130`–`0.136`):
   keep the existing marketplace-only model, parity warning, and
   recommendation strings unchanged, so older hosts still receive correct
   guidance.
4. **No execution wiring and no read-exec adoption in this ADR.**
   Recognition-only deliberately excludes (a) wiring `codex plugin add`
   as an executable cache-materialization action behind
   `--execute-plugin-management`, and (b) using `codex plugin list
   --json` as a host-native installed-state read signal. Both remain
   deferred follow-ups; the execution wiring in particular is to be
   decided alongside the broader runtime non-mutating-boundary
   deliberation rather than coupled to this correctness fix.

The refreshed plugin rows in the two baselines are the behavioral spec
for the per-plugin branch. The command-surface schema version bumps to
`runtime-plugin-command-surface-1.4` for the added per-plugin
`remove_plugin` / `update_plugin` support fields and the
`marketplace_list` field (Codex `0.137.0` also exposes `codex plugin
marketplace list`, previously unmodeled). To avoid overclaiming, the
parity summary and `limits` enumerate only the per-plugin verbs actually
observed in `codex plugin --help` (so a host exposing only `add` is not
reported as `add/list/remove`).

## Consequences

**Positive**: On `0.137.0`, doctor/settings stop emitting a false
marketplace-only capability model and a false "no per-plugin install"
claim, and instead report the per-plugin add/list/remove surface without
overclaiming full Claude parity. Operators still on Codex `0.130`–`0.136`
keep the correct marketplace-only guidance. The surface-keyed rule adapts
to the actual host on each run, using the `codex plugin --help` command
list rather than a hardcoded version gate.

**Negative**: doctor and settings carry dual-path logic (per-plugin vs
marketplace-only) and the tests to cover both. The recognition-only
boundary means `runtime:settings` recognizes `codex plugin add` but still
leaves Codex cache materialization manual, which can read as an
incomplete capability until the execution-wiring follow-up lands.

**Neutral**: the marketplace-only strings remain in code and docs but are
reframed as the older-host branch rather than the primary model. A future
ADR may add the `codex plugin add` executor and/or the `codex plugin list
--json` read signal, and may eventually drop the marketplace-only branch
once Codex `0.130`–`0.136` support is no longer needed.

## Alternatives Considered

- **Recognition + execution wiring (Option C)**: also wire `codex plugin
  add` as an executable cache-materialization action behind the existing
  `--execute-plugin-management` flag, for parity with the Claude
  `claude plugin install` execution path. Rejected for this ADR: it
  couples a new Codex host-mutation path to a correctness fix while the
  runtime non-mutating boundary is under active owner deliberation, and
  it broadens the surface (semantic-failure classification, executor
  tests) beyond the root falsehood. Deferred to a follow-up that can be
  decided together with the non-mutating-boundary track. (Chosen against
  by the owner on 2026-06-07.)
- **Recognition + `codex plugin list --json` read signal (Option B)**:
  add a host-native installed-state read probe. Rejected for this ADR as
  scope beyond the capability-model correction; the filesystem-based
  cache materialization detection already works. Left as a deferred
  follow-up.
- **Version-gated detection**: branch on the Codex version (`>= 0.137`)
  instead of the observed command surface. Rejected — the runtime already
  reads `codex plugin --help` dynamically, so keying on the actual
  command list is more robust than a hardcoded version assumption and
  matches the ADR-0030 stage-aware precedent.
- **Label-only swap (no probe change)**: change the `marketplace-only`
  label without probing `codex plugin --help`. Rejected — without
  observing the per-plugin subcommands the runtime cannot honestly detect
  the surface; it would hardcode a different label, not recognize the
  host.
- **Leave the code as-is (docs-only)**: PR #389 refreshed only the
  baselines. Leaving the code unchanged keeps emitting a false
  marketplace-only model and "no per-plugin install" claim on `0.137.0`.
  Rejected — it is a host-truth regression in operator-facing output,
  exactly what the baselines now say is wrong.
