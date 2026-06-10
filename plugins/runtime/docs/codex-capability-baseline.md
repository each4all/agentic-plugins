# Codex Capability Baseline

Observed on 2026-06-07 with Codex CLI `0.137.0` plus official OpenAI
developer docs. This file is a runtime-owned host-truth checkpoint, not a
replacement for the upstream docs.

For Claude-vs-Codex behavior differences, see
[`host-parity-baseline.md`](host-parity-baseline.md).

## Sources

Official OpenAI developer docs:

- <https://developers.openai.com/codex/cli>
- <https://developers.openai.com/codex/guides/agents-md>
- <https://developers.openai.com/codex/skills>
- <https://developers.openai.com/codex/plugins>
- <https://developers.openai.com/codex/plugins/build>
- <https://developers.openai.com/codex/mcp>
- <https://developers.openai.com/codex/subagents>
- <https://developers.openai.com/codex/concepts/subagents>
- <https://developers.openai.com/codex/hooks>
- <https://developers.openai.com/codex/config-basic>
- <https://developers.openai.com/codex/concepts/sandboxing>
- <https://developers.openai.com/codex/agent-approvals-security>

Local CLI evidence:

- `codex --version` -> `codex-cli 0.137.0`
- `codex --help` (0.137.0 adds top-level `doctor`, `update`, `login`/`logout`,
  and `archive`/`unarchive` alongside `exec`, `review`, `mcp`, `plugin`,
  `sandbox`, `resume`, `fork`, `cloud`, `features`)
- `codex exec --help`
- `codex hooks --help` (observed to fall back to top-level help; no
  `hooks` subcommand is listed)
- `codex plugin --help` (0.137.0: `add`, `list`, `marketplace`, `remove`)
- `codex plugin add --help` (installs `PLUGIN[@MARKETPLACE]` from a configured
  marketplace snapshot; `--marketplace` selects the source)
- `codex plugin list --help` (lists plugins from configured marketplace
  snapshots; `--json` supported)
- `codex plugin remove --help` (removes an installed plugin from local config
  and cache)
- `codex plugin marketplace --help` (0.137.0: `add`, `list`, `upgrade`, `remove`)
- `codex debug --help`
- `codex mcp --help`
- `codex features list` (0.137.0: `plugin_hooks` removed, generic `hooks`
  stable, `plugins`/`plugin_sharing`/`multi_agent` stable — unchanged from
  0.136.0)

## Confirmed Codex Surfaces

| Surface | Baseline | Runtime implication |
|---------|----------|---------------------|
| Local CLI | Codex CLI is the local terminal coding agent. Local help exposes `exec`, `review`, `mcp`, `plugin`, `sandbox`, `resume`, `fork`, `cloud`, `features`, and related commands. | Runtime may diagnose local CLI availability and command shape, but should keep version and feature observations explicit because this surface changes quickly. |
| `AGENTS.md` | Codex loads instruction files before work, layering user and project guidance. Project `.codex/` layers load only for trusted projects. | Repo guidance in `AGENTS.md` remains the canonical Codex host instruction path. Runtime should not replace it with generated host config. |
| Skills | Skills are the reusable workflow authoring format. `SKILL.md` is the required skill entry point, and plugins are the distribution unit for reusable skills and apps. | Codex-facing runtime commands stay packaged as skills under `plugins/runtime/skills/`. Runtime docs should mention `$runtime:*` skill invocation rather than Claude slash-command parity. |
| Plugins and marketplaces | `.codex-plugin/plugin.json` is the required plugin manifest. A repo-scoped marketplace lives at `$REPO_ROOT/.agents/plugins/marketplace.json`; Codex can also read personal and Claude-style marketplace locations. | Keep `.codex-plugin/plugin.json` plus `.agents/plugins/marketplace.json` as the Codex distribution surface. Do not invent a second Codex install manifest. |
| Local plugin command shape | In CLI `0.137.0`, `codex plugin` exposes `add`, `list`, `marketplace`, and `remove`; `codex plugin marketplace` exposes `add`, `list`, `upgrade`, and `remove`. Per-plugin `add` (install from a configured marketplace snapshot), `list`, and `remove` are new beyond the prior marketplace-only surface; there is still no per-plugin `update`, `enable`, `disable`, `details`, `validate`, or `prune`. | The CLI is no longer marketplace-only — it has per-plugin `add`/`list`/`remove`. Runtime `doctor`/`settings` recognize this surface as `per-plugin-and-marketplace` (ADR-0032), and `doctor` reads Codex installed-state host-natively from `codex plugin list --json` (read-only, list-authoritative-then-cache; ADR-0034). `runtime:settings --execute-plugin-management --plugin-management-host codex` still executes only marketplace commands; wiring `codex plugin add` as an executable action remains a deferred follow-up (see `follow-ups.md`). Do not claim full Claude-style parity (`update`/`enable`/`disable`/`details`/`validate`/`prune` are still absent). |
| MCP | Codex supports MCP in the CLI and IDE extension. MCP configuration is stored with other Codex config in `config.toml`, and `codex mcp` manages server entries. | Runtime may diagnose MCP availability and config paths. Runtime must not auto-add MCP servers outside an explicit future executor. |
| Subagents | Codex subagent workflows are enabled by default, but Codex only spawns subagents when explicitly asked. Custom agents live under `~/.codex/agents/` or `.codex/agents/`, and subagents inherit the current sandbox policy. | Runtime consensus can model manual/subagent lanes, but automatic hidden fanout remains out of bounds. Any Codex subagent use must be an explicit operator or user action. |
| Hooks | Codex hooks are a documented lifecycle extension. The `plugin_hooks` feature flag was **removed** in ~0.134.0 (PR #22552): `codex features list` on 0.137.0 still reports `plugin_hooks` as `removed` and generic `hooks` as `stable`. Plugin-bundled hooks are no longer gated by a separate flag — they load when the plugin is enabled and generic `[features].hooks` (default on) is set, declared via a `.codex-plugin/plugin.json` `hooks` entry or the default `hooks/hooks.json`, subject to `/hooks` review+trust. Plugin hook commands receive `PLUGIN_ROOT`/`PLUGIN_DATA`, and Codex still sets `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` for compatibility with existing plugin hooks. Local non-interactive help does not expose a `codex hooks` trust/query command. | Runtime should keep generic hooks, plugin enablement, manifest hook exposure, hook command portability, and hook trust/review as separate readiness facts. Do not treat plugin-bundled hooks as runtime-ready based only on generic hook support or `/hooks` `Installed` counts; `Active=0` output and `Trust: New hook - review required` are not enough to attest. Because `plugin_hooks` is removed, the former `--apply-codex-plugin-hooks` write (`[features].plugin_hooks = true`) and `codex --enable plugin_hooks` targeted a dead flag on 0.137.0; that settings write executor and the doctor `enable-codex-plugin-hooks` recommendation were removed per ADR-0035 §6, and runtime `settings`/`doctor` now report the `[features].hooks` + plugin-enablement + `/hooks` trust model read-only. `CLAUDE_PLUGIN_ROOT` in a Codex-exposed command is compatibility telemetry, not a warning by itself; a Claude adapter hook path remains a portability warning. Bare `node` hook commands are also portability warnings because a hook runner may not inherit a login-shell PATH. After the operator reviews/trusts hooks with `/hooks`, `runtime:settings --attest-codex-hook-review` may record a sanitized artifact for doctor to consume; it does not mutate or independently prove Codex trust state. |
| Config | Codex reads user config from `~/.codex/config.toml`, trusted project config from `.codex/config.toml`, and system config from `/etc/codex/config.toml` on Unix. | Current `runtime:settings --apply` continues writing only `.agentic-plugins/config.toml`. The former host-native Codex write — the `--apply-codex-plugin-hooks` path for `~/.codex/config.toml` `[features].plugin_hooks = true` — was **removed per ADR-0035 §6** (it would have written a dead flag). Runtime has no Codex host-config write executor; Codex config mutation is out of scope. |
| Sandbox and approvals | Codex separates sandbox boundaries from approval policy. CLI help exposes `read-only`, `workspace-write`, and `danger-full-access`; approval policies include `untrusted`, `on-request`, and `never`. | Runtime doctor/settings may observe and preflight these controls, but must not relax sandbox, approval, permission, or network settings automatically. |

## Negative Baseline

- Do not claim Codex has full Claude-style per-plugin plugin management. Codex
  `0.137.0` added per-plugin `codex plugin add` (install from a configured
  marketplace snapshot), `list`, and `remove`, so the CLI is no longer
  marketplace-only — but it still has no per-plugin `update`, `enable`,
  `disable`, `details`, `validate`, or `prune`, and `add` is marketplace-snapshot
  sourced rather than an arbitrary install path.
- Do not claim Codex subagents run automatically from runtime consensus,
  footer, context, or doctor output. Subagent fanout must stay explicit.
- Do not mutate `~/.codex/config.toml` from runtime settings. (The former
  `--apply-codex-plugin-hooks` write to `[features].plugin_hooks = true` was
  removed per ADR-0035 §6 — the flag itself was removed in ~0.134.0 — and no
  executor replaces it.) Do not mutate
  `.codex/config.toml`, hooks, MCP entries, sandbox policy, approval policy,
  or permissions.
- Do not claim automatic plugin-hook parity from packaging alone: plugin hooks
  now require the plugin enabled, generic `[features].hooks` on, and `/hooks`
  review+trust. (The separate `plugin_hooks` flag was removed in ~0.134.0.)
- Do not claim runtime can independently verify Codex hook trust/review from
  CLI state. In local CLI `0.137.0`, `/hooks` is an active-session UI command:
  top-level help does not list a `hooks` subcommand, and `codex plugin
  marketplace` exposes add/list/upgrade/remove with no hook trust query.
  (`~/.codex/config.toml` no longer exposes a `plugin_hooks` enablement flag,
  and never exposed per-hook trust state.) Treat `/hooks` `Installed` counts as packaging evidence only;
  `Active=0` output is not enough to attest.
- Do not treat Codex marketplace cache freshness as equivalent to source truth.
  Doctor/settings should continue reporting marketplace state, per-plugin cache
  state, and stale cache/materialization guidance separately.

## Drift Policy

Refresh this baseline when any of these change:

- the installed `codex --version`;
- official Codex plugin, hook, skill, subagent, MCP, config, sandbox, or
  approvals docs;
- `codex plugin --help`, `codex plugin marketplace --help`, or
  `codex features list`;
- runtime starts writing host-native Codex config or adding plugin-hook
  integration.
