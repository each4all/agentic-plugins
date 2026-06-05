# Host Parity Baseline

Observed on 2026-06-03 with Claude Code `2.1.161`, Codex CLI
`0.136.0`, official OpenAI Codex developer docs, and official Claude Code docs.
This file is a runtime-owned host-truth checkpoint for Claude-vs-Codex
differences. It is not a promise that either host will keep this behavior.

## Sources

Official OpenAI Codex developer docs:

- <https://developers.openai.com/codex/cli>
- <https://developers.openai.com/codex/guides/agents-md>
- <https://developers.openai.com/codex/skills>
- <https://developers.openai.com/codex/plugins>
- <https://developers.openai.com/codex/plugins/build>
- <https://developers.openai.com/codex/subagents>
- <https://developers.openai.com/codex/hooks>
- <https://developers.openai.com/codex/config-basic>
- <https://developers.openai.com/codex/concepts/sandboxing>
- <https://developers.openai.com/codex/agent-approvals-security>

Official Claude Code docs:

- <https://code.claude.com/docs/en/sub-agents>
- <https://code.claude.com/docs/en/agents>
- <https://code.claude.com/docs/en/agent-teams>
- <https://code.claude.com/docs/en/plugins>
- <https://code.claude.com/docs/en/plugin-marketplaces>
- <https://code.claude.com/docs/en/settings>
- <https://code.claude.com/docs/en/hooks>
- <https://code.claude.com/docs/ko/hooks-guide>
- <https://code.claude.com/docs/en/changelog>

Local CLI evidence:

- `claude --version` -> `2.1.161 (Claude Code)`
- `claude --help`
- `claude plugin --help`
- `claude agents --help`
- `claude mcp --help`
- `codex --version` -> `codex-cli 0.136.0`
- `codex --help`
- `codex plugin --help`
- `codex plugin marketplace --help`
- `codex features list` (0.136.0: `plugin_hooks` reported `removed`, generic
  `hooks` stable/true, `plugins`/`plugin_sharing`/`multi_agent` stable/true,
  `enable_fanout` under development, `collaboration_modes` removed)

## Parity Matrix

| Surface | Claude Code baseline | Codex baseline | Runtime implication |
|---------|----------------------|----------------|---------------------|
| Instruction and memory roots | `CLAUDE.md` is a host memory/instruction file. Claude settings docs also identify memory files as the place for startup instructions and context. | `AGENTS.md` is the Codex project guidance path. Project `.codex/` layers load only when the project is trusted. | Keep `AGENTS.md` as the shared repo guidance source and `CLAUDE.md` as a host shim. Use `.agentic-plugins` for shared runtime artifacts/config, not as a replacement for host-native automatic instruction roots. |
| Plugin distribution | `claude plugin` exposes per-plugin `install`, `list`, `update`, `enable`, `disable`, `uninstall`, `details`, `validate`, and marketplace management. In Claude Code 2.1.143, enable/disable also enforces plugin dependencies, `details` reports component inventory plus projected token cost, and `prune`/`autoremove` can remove unused auto-installed dependencies. | Official Codex plugins bundle skills, apps, and MCP servers. Local non-interactive CLI exposes `codex plugin marketplace add`, `upgrade`, and `remove`; interactive `/plugins` owns browse/install/toggle UX. | Runtime settings may execute allowlisted Claude plugin commands and Codex marketplace commands, but must not claim Codex has Claude-style per-plugin install/list/update commands in CLI `0.136.0`. Runtime cleanup must distinguish retired/unknown user-requested cleanup from Claude's dependency-aware plugin enable/disable/prune behavior. |
| Plugin contents | Claude plugins can provide skills, agents, hooks, and MCP servers; local CLI supports `--plugin-dir` and `--plugin-url`. Claude Code 2.1.142 surfaces plugins with a root-level `SKILL.md` and no `skills/` directory as a skill, and plugin details show LSP servers. | Codex plugins are the distribution unit for reusable skills, apps, and MCP servers. The repo marketplace is `.agents/plugins/marketplace.json`, with Codex plugin manifests under `.codex-plugin/plugin.json`. | Keep dual host manifests and catalogs. Do not collapse host-specific plugin metadata into `.agentic-plugins`; that directory is runtime-owned state/config, not a host plugin manifest path. Runtime shape tests should continue requiring explicit Codex `skills/` mirrors even if Claude accepts a root-level `SKILL.md` shortcut. |
| Skills and commands | Claude plugin command surfaces include slash commands and skills. Subagents provided by enabled plugins can be mentioned as plugin-scoped agents. | Codex skills are invoked explicitly with `$skill` or selected implicitly from skill descriptions. `SKILL.md` is the workflow entrypoint; optional `agents/openai.yaml` configures presentation and dependencies. | Runtime commands stay mirrored as Claude commands plus Codex skills. Text should say `$runtime:*` for Codex and `/runtime:*` for Claude instead of pretending the invocation syntax is identical. |
| Hooks | Claude hooks are configured in settings, plugin `hooks/hooks.json`, and skill/subagent frontmatter. They support rich lifecycle events, including `SessionStart`, `Stop`, `SubagentStop`, `PreCompact`, `PostCompact`, `MessageDisplay`, task/team-related events, worktree events, and JSON decision control. Plugin hooks use `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` for bundled scripts and persistent plugin data. Claude Code 2.1.144 ends turns with a warning after 8 consecutive Stop-hook blocks (override `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`); 2.1.145 added `background_tasks`/`session_crons` to `Stop`/`SubagentStop` input and `PostToolUse` `updatedToolOutput`; 2.1.147 surfaces active effort via `effort.level`/`$CLAUDE_EFFORT`; 2.1.152 added the `MessageDisplay` event and `SessionStart` `reloadSkills`/`sessionTitle` outputs. | Codex hooks are documented and generic `hooks` is stable/enabled. The `plugin_hooks` feature flag was **removed** in ~0.134.0 (PR #22552); `codex features list` on 0.136.0 reports `plugin_hooks` as `removed` and generic `hooks` as `stable`. Plugin-bundled hooks are no longer gated by a separate flag: a plugin's hooks load when the plugin is enabled and generic `[features].hooks` (default on) is set, declared via a `.codex-plugin/plugin.json` `hooks` entry or the default `hooks/hooks.json`, and still require `/hooks` review+trust. Hook commands receive `PLUGIN_ROOT`/`PLUGIN_DATA`; Codex still sets `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` as compatibility aliases. Local non-interactive help still does not expose a `codex hooks` trust/query command. | Runtime must diagnose generic hooks, plugin enablement, manifest hook exposure, installed hook packaging, hook command portability, and hook trust/review separately. `/hooks` `Installed` counts are packaging evidence only; `Active=0` output and `Trust: New hook - review required` are not enough to attest. **The removed `plugin_hooks` flag obsoletes the old enablement path: writing `~/.codex/config.toml` `[features].plugin_hooks = true` is a no-op on 0.136.0, and `codex --enable plugin_hooks` targets a removed flag.** Runtime `settings`/`doctor` `plugin_hooks` handling (apply, `enable-codex-plugin-hooks` recommendation, stage diagnosis) must migrate to verifying `[features].hooks` (default on) + plugin enablement + `/hooks` trust — tracked as a follow-up (see `follow-ups.md`). Recording an operator attestation with `--attest-codex-hook-review` after the active Codex `/hooks` review/trust step still applies. `CLAUDE_PLUGIN_ROOT` inside a Codex-exposed hook command is compatibility telemetry, not a portability warning by itself; `adapters/claude/hooks` paths and bare `node` commands are portability warnings. The attestation is not host-native proof and is valid only while the hook-bearing plugin set and source versions still match. Runtime should not assume a portable Stop-hook block cap exists across hosts; if it adds hook retry policy, it must remain explicit and host-observed. |
| Subagent trigger model | Claude can delegate to built-in and custom subagents automatically based on description, and users can explicitly invoke them. Custom subagents live in `.claude/agents/` or `~/.claude/agents/`. | Codex subagent workflows are enabled by default, but Codex only spawns subagents when explicitly asked. Built-ins include `default`, `worker`, and `explorer`; custom agents live in `.codex/agents/` or `~/.codex/agents/`. | Runtime consensus may plan broad manual/subagent lanes, but Codex fanout must remain an explicit operator/user action. Do not infer Claude-style automatic subagent delegation on Codex. |
| Agent teams / team mode | Claude agent teams are experimental, disabled by default via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, and provide multiple Claude instances with a lead, teammates, shared task list, and peer-to-peer messages. | Codex has subagent workflows and a stable local `multi_agent` feature flag, but the docs describe explicit subagent workflows, not Claude agent teams with shared mailbox/task-list semantics. | Cross-host "team mode" should be implemented as agentic-plugins runtime/orchestrator artifacts, companion dispatch, explicit consensus rounds, and manual/subagent lanes, not by depending on Claude agent teams as the portable abstraction. |
| Parallelism limits | Claude docs recommend subagents, agent view, agent teams, and worktree sessions for different parallelism shapes. Agent teams add high token cost and known limitations. Local `claude agents --help` exposes dispatch defaults for additional dirs, settings, MCP config, plugin dirs, permission mode, model, effort, and bypass-permissions availability. | Codex docs expose `[agents]` settings: `agents.max_threads` defaults to `6`, `agents.max_depth` defaults to `1`, and deeper recursion raises cost/predictability risk. | Runtime should support explicit broad rosters without a hidden product cap, while preserving bounded max rounds, process budgets, timeouts, and explicit peer lists. Claude `claude agents` dispatch flags are useful host evidence but are not the portable runtime fanout contract. |
| Permissions and sandbox | Claude exposes permission modes such as `default`, `plan`, `acceptEdits`, and `bypassPermissions`; teammates inherit the lead's permissions at spawn. | Codex separates sandbox mode and approval policy. Defaults include workspace-write with network off; subagents inherit the current sandbox policy and non-interactive approval gaps fail back to the parent workflow. | Runtime must classify permission/sandbox/auth preconditions as operator action. Settings must not silently relax host permissions, sandbox, approval, or network policy for companions or subagents. |
| Model and effort | Claude CLI exposes `--model` and `--effort`. Subagent model resolution includes `CLAUDE_CODE_SUBAGENT_MODEL`, per-invocation model, subagent frontmatter, then main conversation model. Claude Code 2.1.142/2.1.143 added and then broadened `claude agents --model` and `--effort` propagation to dashboard-dispatched and background sessions. | Codex CLI exposes `--model`; config supports model defaults and spawned custom agents can include model and `model_reasoning_effort`. | Runtime's portable model/effort path remains `.agentic-plugins/config.toml` plus companion-contract `--model` and `--effort`. Host-native model config writes remain deferred. Runtime should keep model/effort evidence direction-specific and not treat Claude agent-view defaults as Codex-equivalent. |
| Settings/config | Claude uses `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, and managed policy files. Plugin enablement can live under `enabledPlugins` settings. Claude Code 2.1.142/2.1.143 background-session dispatch can propagate settings, MCP config, plugin dirs, strict MCP config, and additional dirs. | Codex uses `~/.codex/config.toml`, trusted project `.codex/config.toml`, system config, profiles, and CLI `-c` overrides. | Runtime `settings --apply` writes only `.agentic-plugins/config.toml`; the former narrow `settings --apply-codex-plugin-hooks` executor (writing `~/.codex/config.toml` `[features].plugin_hooks = true`) is obsolete now that `plugin_hooks` was removed in Codex ~0.134.0 — migrating it is a follow-up. Host-native `.claude` config and broader `.codex` config mutation remain out of scope. Runtime should observe Claude dispatch flags but not use them to justify hidden host-native settings mutation. |
| MCP | Claude `claude mcp` manages MCP servers and hook MCP tools can participate in Claude hook decisions. | Codex `codex mcp` manages MCP server entries in Codex config. Plugins can bundle MCP servers. | Runtime may observe MCP command surfaces and plugin packaging, but should not auto-add or rewrite MCP servers outside an explicit settings executor. |
| Worktrees | Claude CLI exposes `--worktree` and `--tmux`, and agent view can move dispatched sessions into worktrees when edits are needed. Claude Code 2.1.143 added a `worktree.bgIsolation: "none"` setting and changed failed worktree cleanup to avoid force-deleting in-progress or gitignored files. | Codex has app worktree docs and the local CLI supports ordinary git worktree workflows through shell commands, but runtime has no host-native Codex worktree executor. | `runtime:worktree plan` stays read-only. Actual `git worktree add/remove/prune`, host session spawning, and PR handling remain operator actions. Runtime worktree guidance should prefer conservative cleanup and never synthesize forced deletion as a hidden fallback. |

## What Fails If We Assume Claude Semantics On Codex

- A Claude plugin command plan that says `codex plugin install runtime` or
  `codex plugin list` is wrong for local Codex CLI `0.136.0`; the observed
  non-interactive surface is marketplace-scoped.
- A Claude SessionStart/Stop hook design must be exposed through Codex plugin
  metadata and still will not run automatically until the plugin is enabled,
  generic `[features].hooks` is on, and the hooks have been reviewed/trusted
  with `/hooks`. The separate `plugin_hooks` flag was removed in ~0.134.0;
  plugin hooks now follow plugin enablement. Codex generic hooks, plugin
  enablement, and bundled hook metadata are different readiness questions.
- A Codex hook plan that treats a `[features].plugin_hooks` value or marketplace
  cache metadata as proof of hook trust is overstated — and on 0.136.0
  `plugin_hooks` is a removed flag, so its value is meaningless. Local CLI
  `0.136.0` does not expose a non-interactive hook trust query; `/hooks` remains
  an active-session operator check, with runtime able to record only an explicit
  attestation artifact. `/hooks` `Installed` counts are packaging evidence only;
  `Active=0` output and `Trust: New hook - review required` are not enough to
  attest.
- A Claude subagent design that relies on automatic delegation by description
  will not trigger Codex subagents. Codex requires an explicit ask to spawn
  subagents.
- Claude agent teams are not a portable cross-host primitive. They are
  Claude-only, experimental, disabled by default, and have team-state semantics
  that Codex subagent workflows do not expose as the same product surface.
- Writing generated `.codex/config.toml`, `.claude/settings.json`, or host hook
  files from runtime would change host-native behavior and may be skipped or
  blocked by trust/policy. Current runtime settings must stay in
  `.agentic-plugins/config.toml`. The former `~/.codex/config.toml`
  `[features].plugin_hooks` toggle handled by `--apply-codex-plugin-hooks` is
  obsolete now that the flag is removed; migrating that executor is a follow-up.
- Treating a Codex marketplace cache refresh as a per-plugin install proof
  overstates readiness. Doctor/settings must continue reporting source,
  marketplace cache, per-plugin materialization, and manual session refresh
  separately.

## `.claude`, `.codex`, And `.agentic-plugins`

Use each root for the layer that actually owns it:

- `.claude/` is Claude Code host state/config and legacy agentic-plugins
  workflow storage. It is ignored because it can contain local host state.
- `.codex/` is Codex host state/config. It is ignored because it can contain
  local host state and project trust-sensitive configuration.
- `.agentic-plugins/` is agentic-plugins-owned runtime state/config. Generated
  runs and workflow state are ignored, while `.agentic-plugins/config.toml`
  may be tracked for intentional shared runtime defaults.

The portability boundary is therefore not "never use `.claude` or `.codex`".
It is: use host roots only for host-native discovery/config surfaces, and use
`.agentic-plugins` for cross-host runtime artifacts, workflow state, model/effort
defaults, and migration targets that agentic-plugins owns.

## Team-Mode Strategy

A portable agentic-plugins team mode should be built as:

1. `runtime:worktree plan` to isolate non-trivial parallel work.
2. `runtime:consensus plan` with explicit companion peers and manual/subagent
   lanes for broad review.
3. Explicit companion execution through `execute --execute` and explicit Codex
   or Claude subagent use by the operator when native host workers are needed.
4. `record`, `synthesize`, and bounded `next-round` to converge durable
   disagreements without pasting raw worker output into the main session.
5. `runtime:context capture/status` plus the footer helper for handoff and PR
   readiness.

This gives the project a cross-host collaboration substrate without depending
on Claude's experimental team-mode state files or Codex-only subagent internals.

## Drift Policy

Refresh this baseline when any of these change:

- installed `claude --version` or `codex --version`;
- official Claude Code docs for plugins, subagents, agent teams, settings, or
  hooks;
- official Codex docs for plugins, skills, subagents, hooks, config, sandboxing,
  or approvals;
- `claude plugin --help`, `claude agents --help`, `codex plugin --help`,
  `codex plugin marketplace --help`, or `codex features list`;
- runtime starts writing host-native `.claude` or `.codex` config beyond the
  `.agentic-plugins`-owned path (the former Codex `plugin_hooks` toggle is
  removed), packaging hooks, or launching host-native subagent/team workflows
  automatically.

## Version History

This trail records each human-reviewed baseline observation so a drift alert
can show *why* the baseline is stale. Append a row when you refresh the
`Observed on …` header at the top of this file; never rewrite past rows and
never let automation edit it (ADR-0026). The header stays the single source of
truth for the current baseline — the drift checker
(`scripts/check-host-version-drift.mjs`) reads only the first dated header
line, not this table.

| Observed | Claude | Codex | Note |
| --- | --- | --- | --- |
| 2026-06-03 | `2.1.161` | `0.136.0` | Baseline at host-version-drift gate introduction. |
