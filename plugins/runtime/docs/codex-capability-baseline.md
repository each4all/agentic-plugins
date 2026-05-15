# Codex Capability Baseline

Observed on 2026-05-14 with Codex CLI `0.130.0` plus official OpenAI
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

- `codex --version` -> `codex-cli 0.130.0`
- `codex --help`
- `codex exec --help`
- `codex plugin --help`
- `codex plugin marketplace --help`
- `codex plugin marketplace add --help`
- `codex plugin marketplace upgrade --help`
- `codex plugin marketplace remove --help`
- `codex mcp --help`
- `codex features list`

## Confirmed Codex Surfaces

| Surface | Baseline | Runtime implication |
|---------|----------|---------------------|
| Local CLI | Codex CLI is the local terminal coding agent. Local help exposes `exec`, `review`, `mcp`, `plugin`, `sandbox`, `resume`, `fork`, `cloud`, `features`, and related commands. | Runtime may diagnose local CLI availability and command shape, but should keep version and feature observations explicit because this surface changes quickly. |
| `AGENTS.md` | Codex loads instruction files before work, layering user and project guidance. Project `.codex/` layers load only for trusted projects. | Repo guidance in `AGENTS.md` remains the canonical Codex host instruction path. Runtime should not replace it with generated host config. |
| Skills | Skills are the reusable workflow authoring format. `SKILL.md` is the required skill entry point, and plugins are the distribution unit for reusable skills and apps. | Codex-facing runtime commands stay packaged as skills under `plugins/runtime/skills/`. Runtime docs should mention `$runtime:*` skill invocation rather than Claude slash-command parity. |
| Plugins and marketplaces | `.codex-plugin/plugin.json` is the required plugin manifest. A repo-scoped marketplace lives at `$REPO_ROOT/.agents/plugins/marketplace.json`; Codex can also read personal and Claude-style marketplace locations. | Keep `.codex-plugin/plugin.json` plus `.agents/plugins/marketplace.json` as the Codex distribution surface. Do not invent a second Codex install manifest. |
| Local plugin command shape | In CLI `0.130.0`, `codex plugin` only exposes `marketplace`, and `codex plugin marketplace` exposes `add`, `upgrade`, and `remove`. | `runtime:settings --execute-plugin-management --plugin-management-host codex` should stay marketplace-scoped. Do not claim Claude-style per-plugin `install`, `list`, or `update` commands for Codex unless the local CLI grows them. |
| MCP | Codex supports MCP in the CLI and IDE extension. MCP configuration is stored with other Codex config in `config.toml`, and `codex mcp` manages server entries. | Runtime may diagnose MCP availability and config paths. Runtime must not auto-add MCP servers outside an explicit future executor. |
| Subagents | Codex subagent workflows are enabled by default, but Codex only spawns subagents when explicitly asked. Custom agents live under `~/.codex/agents/` or `.codex/agents/`, and subagents inherit the current sandbox policy. | Runtime consensus can model manual/subagent lanes, but automatic hidden fanout remains out of bounds. Any Codex subagent use must be an explicit operator or user action. |
| Hooks | Codex hooks are a documented lifecycle extension, and bundled plugin hooks are gated by the `plugin_hooks` feature flag. Local `codex features list` reports `hooks` as stable/enabled and `plugin_hooks` as under development/disabled, while `codex --enable plugin_hooks features list` reports `plugin_hooks` enabled for that invocation. | Runtime should keep generic hooks, plugin_hooks enablement, manifest hook exposure, and hook trust/review as separate readiness facts. Do not treat plugin-bundled hooks as runtime-ready based only on generic hook support. |
| Config | Codex reads user config from `~/.codex/config.toml`, trusted project config from `.codex/config.toml`, and system config from `/etc/codex/config.toml` on Unix. | Current `runtime:settings --apply` continues writing only `.agentic-plugins/config.toml`. The only supported host-native Codex config write is the explicit `--apply-codex-plugin-hooks` path for `~/.codex/config.toml` `[features].plugin_hooks = true`; broader Codex config mutation remains deferred. |
| Sandbox and approvals | Codex separates sandbox boundaries from approval policy. CLI help exposes `read-only`, `workspace-write`, and `danger-full-access`; approval policies include `untrusted`, `on-request`, and `never`. | Runtime doctor/settings may observe and preflight these controls, but must not relax sandbox, approval, permission, or network settings automatically. |

## Negative Baseline

- Do not claim Codex has Claude-style per-plugin install/list/update commands
  while the local CLI remains marketplace-only.
- Do not claim Codex subagents run automatically from runtime consensus,
  footer, context, or doctor output. Subagent fanout must stay explicit.
- Do not mutate `~/.codex/config.toml` except the explicit
  `--apply-codex-plugin-hooks` write to `[features].plugin_hooks = true`.
  Do not mutate `.codex/config.toml`, hooks, MCP entries, sandbox policy,
  approval policy, or permissions from runtime's current settings executor.
- Do not claim automatic plugin-hook parity while local `plugin_hooks` is
  disabled, even though generic Codex hooks and bundled hook metadata are
  available.
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
