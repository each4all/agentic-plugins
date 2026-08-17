# Host Parity Baseline

Observed on 2026-08-16 with Claude Code `2.1.233`, Codex CLI
`0.147.0`, official OpenAI Codex developer docs, and official Claude Code docs.
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

Local CLI evidence (full block re-observed 2026-07-20 for the dual drift
Claude `2.1.208`→`2.1.215` / Codex `0.144.1`→`0.144.6` — every listed
surface was re-run live; verb sets are unchanged on both hosts, so the
earlier version-tagged observations stand with the re-check noted.
2026-07-21: `claude --version` and `claude plugin --help` re-checked live
on the additive/fix-only `2.1.216` patch — verb set unchanged; all other
listed surfaces stand from the 2026-07-20 full re-run, Codex unchanged.
2026-07-22: dual drift Claude `2.1.216`→`2.1.217` / Codex
`0.144.6`→`0.145.0` — `claude --version`, `claude plugin --help`, `codex
--version`, `codex plugin --help`, and `codex features list` re-checked
live; both plugin verb sets are unchanged and the `codex features list`
hook story is unchanged (`plugin_hooks` `removed`, generic `hooks`
`stable`), the only stage changes being additive/internal (`multi_agent_v2`
under-development→stable and `enable_fanout` under-development→removed,
opt-in flags with no plugin/hook surface impact); all other listed surfaces
stand from the 2026-07-20 full re-run.
2026-07-23: Claude `2.1.217`→`2.1.218` patch drift — `claude --version` and
`claude plugin --help` re-checked live on the additive/fix-only `2.1.218`
patch (notable entries are host UX work: `/code-review` runs as a background
subagent, screen-reader deletion announcements, a Windows `\u`-prefixed-path
corruption fix, MCP failure diagnostics — none touching the
plugin/hook/permission contract); verb set unchanged; Codex unchanged at
`0.145.0`; all other listed surfaces stand from the 2026-07-20 full re-run.
2026-08-08: dual drift Claude `2.1.220`→`2.1.226` / Codex
`0.145.0`→`0.147.0` — `claude --version`, `claude plugin --help`,
`claude agents --help`, `claude mcp --help`, `codex --version`,
`codex --help`, `codex plugin --help`, every `codex plugin <sub> -h`,
`codex plugin marketplace --help`, `codex plugin list --json`, and
`codex features list` re-run live. **Every verb set on both hosts is
unchanged**, and the `codex plugin list --json` root/entry field sets are
unchanged. Two flag-inventory additions on Codex are additive
(`recommended_plugins` `stable`/`false` is new; `plugin_hooks` stays
`removed` and generic `hooks` stays `stable`). Unlike the four preceding
rows, this Codex minor is **not** "additive with no adoption work" — see the
Version History row of 2026-08-08 for the Agent Plugins manifest ingestion
it introduces.
2026-08-11: Claude `2.1.226`→`2.1.227` patch drift — `claude --version`,
`claude --help`, `claude plugin --help`, `claude agents --help`, and
`claude mcp --help` re-checked live on the fix/UX/perf-only `2.1.227` patch
(its entries are a subscription-tier feature-flag evaluation fix under an
expired login token, a `claude-code-action` `allowed_non_write_users` Bash
failure fix on GitHub-hosted runners, a `/tui` rewound-conversation fix,
slash-command menu styling, and event-loop stall reductions — none touching
the plugin/hook/permission/subagent contract); every re-run verb set is
unchanged and `--safe-mode` is still present. Codex unchanged at `0.147.0`
(version match, no release-note requirement), so all Codex surfaces stand
from the 2026-08-08 full re-run.
2026-08-16: Claude `2.1.227`→`2.1.233` patch drift (`2.1.228`, `2.1.229`,
`2.1.231`, `2.1.232`, `2.1.233`; `2.1.230` unpublished) — `claude --version`,
`claude --help`, `claude plugin --help`, `claude agents --help`, and
`claude mcp --help` re-checked live on `2.1.233`; every verb set is unchanged
and `--safe-mode` is still present. Codex unchanged at `0.147.0` (version
match, no release-note requirement), so all Codex surfaces stand from the
2026-08-08 full re-run — spot-re-verified here on `codex plugin --help`
(`add`/`list`/`marketplace`/`remove`) and `codex features list`
(`plugin_hooks` `removed`, generic `hooks` `stable`/true,
`recommended_plugins` `stable`/false, and still no `plugin_commands` row).
**Unlike the six preceding rows this one carries adoption work**: `2.1.233`
withdrew the todo/task-tracking tools (`TaskCreate`/`TaskGet`/`TaskUpdate`/
`TaskList`, `TodoWrite`) from Opus 4.8, Sonnet 5, Fable 5, Mythos 5, and newer
models behind an opt-in `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, invalidating a
standing instruction carried by twenty of this repository's Claude command
runbooks — see the Parity Matrix "Skills and commands" row and the Version
History row of 2026-08-16):

- `claude --version` -> `2.1.233 (Claude Code)`
- `claude --help` (the global `--safe-mode` flag / `CLAUDE_CODE_SAFE_MODE`
  added in 2.1.169 — starts a session with CLAUDE.md, plugins, skills, hooks,
  and MCP servers disabled for troubleshooting — is still present on 2.1.233)
- `claude plugin --help` (re-checked live on 2.1.233, verb set unchanged from
  the 2.1.215 full re-run: `details`, `disable`,
  `enable`, `eval`, `init`/`new`, `install`, `list`, `marketplace`,
  `prune`/`autoremove`, `tag`, `uninstall`/`remove`, `update`, `validate` —
  verb set unchanged from the 2.1.206 observations; `eval`, `init`/`new`, and
  `tag` remain additive relative to the 2.1.14x observations; runtime's
  allowlisted `install`/`update`/`uninstall`/`list` set is unaffected. The
  2.1.233 entry improving `validate` to check a bare `.claude/skills`
  directory widened that verb's coverage without adding or removing a verb)
- `claude agents --help` (re-checked live on 2.1.233: `--json` with `--all`
  plus `id`/`state` fields, added in 2.1.169, still present alongside
  `--model`/`--effort`; `--add-dir`, `--agent`, `--cwd`, `--mcp-config`,
  `--setting-sources`, `--settings`, `--strict-mcp-config`, and
  `--allow-dangerously-skip-permissions` are additive dispatch knobs runtime
  does not use)
- `claude mcp --help` (re-checked live on 2.1.233: `add`,
  `add-from-claude-desktop`, `add-json`, `get`, `list`, `login`, `logout`,
  `remove`, `reset-project-choices`, `serve` — verb set unchanged from the
  2.1.206 observations; `login`/`logout` cover MCP OAuth flows)
- `codex --version` -> `codex-cli 0.147.0`
- `codex --help` (re-checked live on 0.147.0: top-level surface `exec`, `review`,
  `login`/`logout`, `mcp`, `plugin`, `mcp-server`, `app-server`,
  `remote-control`, `app`, `completion`, `update`, `doctor`, `sandbox`,
  `debug`, `apply`, `resume`, `archive`/`delete`/`unarchive`, `fork`,
  `cloud`, `exec-server`, `features` — unchanged from 0.144.1; `delete` is
  additive since 0.139.0; the `doctor`/`update`/`login`/`logout`/`archive`
  additions date to 0.137.0. 0.147.0 removed the deprecated
  `codex exec --full-auto` flag in favor of `--sandbox workspace-write`;
  no agentic-plugins caller used it — `codex-companion.mjs` builds
  `exec --skip-git-repo-check --ephemeral`, and the live deep-peer smoke on
  0.147.0 passed in both directions)
- `codex plugin --help` (re-checked live on 0.147.0: `add`, `list`, `marketplace`,
  `remove` — command set unchanged from 0.137.0, whose per-plugin
  `add`/`list`/`remove` went beyond the prior marketplace-only surface;
  0.138.0 added `--json` to `add`/`remove`, and `list` supports `--json` plus
  a `-m`/`--marketplace` filter)
- `codex plugin list --json` (re-checked live on 0.147.0: root object is
  `{installed, available}`; installed entries carry
  `pluginId`/`name`/`marketplaceName`/`version`/`installed`/`enabled`/
  `installPolicy`/`authPolicy`, the 0.138.0 `marketplaceSource`
  `{sourceType, source}` field on source-backed entries, and the additive
  `source` `{source, path}` object; with `remote_plugin` stable,
  remotely-sourced plugins appear alongside marketplace-sourced ones — all
  additive relative to the field-selective ADR-0034 resolver)
- `codex plugin marketplace --help` (re-checked live on 0.147.0: `add`, `list`,
  `upgrade`, `remove` — unchanged from 0.137.0; `marketplace list --json`
  includes the marketplace source for source-backed marketplaces as of
  0.139.0, not every entry)
- `codex features list` (re-checked live on 0.147.0: `plugin_hooks` still
  reported `removed`, generic `hooks` stable/true,
  `plugins`/`plugin_sharing`/`multi_agent`/`remote_plugin` stable/true,
  `collaboration_modes` and `multi_agent_mode` `removed`; `multi_agent_v2`
  stabilized at 0.145.0 (opt-in, enabled=false) and `enable_fanout` retired
  there. New at 0.146.0–0.147.0: a `recommended_plugins` row, `stable`/false.
  There is **no** `plugin_commands` row at any stage — the command-migration
  path described in the ADR-0013 Trigger Watch is not a flag awaiting
  enablement)
- `~/.codex/config.toml` `[hooks.state]` (read live on 0.147.0: all four
  hook-bearing plugins — designer, engineer, founder, orchestrator — carry
  `enabled = true` plus a `trusted_hash` for each of `session_start`,
  `pre_compact`, and `stop`. The per-event hash is identical across the four
  because every hook command is the same `${PLUGIN_ROOT}`-relative text, which
  is why a plugin version bump that does not edit `hooks.json` carries its
  trust forward: the 0.21.1→0.21.2 engineer bump did not invalidate trust.
  What goes stale on such a bump is runtime's own attestation *record*, not
  Codex's trust state — re-record with `runtime:settings
  --attest-codex-hook-review`)

## Parity Matrix

| Surface | Claude Code baseline | Codex baseline | Runtime implication |
|---------|----------------------|----------------|---------------------|
| Instruction and memory roots | `CLAUDE.md` is a host memory/instruction file. Claude settings docs also identify memory files as the place for startup instructions and context. | `AGENTS.md` is the Codex project guidance path. Project `.codex/` layers load only when the project is trusted. | Keep `AGENTS.md` as the shared repo guidance source and `CLAUDE.md` as a host shim. Use `.agentic-plugins` for shared runtime artifacts/config, not as a replacement for host-native automatic instruction roots. |
| Plugin distribution | `claude plugin` exposes per-plugin `install`, `list`, `update`, `enable`, `disable`, `uninstall`, `details`, `validate`, and marketplace management. In Claude Code 2.1.143, enable/disable also enforces plugin dependencies, `details` reports component inventory plus projected token cost, and `prune`/`autoremove` can remove unused auto-installed dependencies. The 2.1.206-observed surface additionally exposes `eval`, `init`/`new`, and `tag` (additive relative to the 2.1.14x observations; outside runtime's allowlisted command set). The 2.1.228–2.1.233 window is additive/fix-only for this surface but three entries touch flows this repository actually runs: 2.1.228 stopped background plugin-cache cleanup from deleting a plugin's cache when its only version is a **symlinked development checkout** (the control case ADR-0051's P2 hardening pinned), 2.1.229 stopped one-shot `claude plugin` commands leaving a stray liveness file that could block cleanup of outdated plugin versions, and 2.1.232 made `/plugin install plugin@marketplace` refresh the marketplace first, while also fixing a startup race that could silently unregister a marketplace through concurrent `known_marketplaces.json` writes. **That refresh does not remove a step from this repository's post-release ritual**, and the distinction is the kind this file exists to keep: the changelog entry is scoped to the interactive slash command, whereas runtime upgrades an already-installed package with the non-slash `claude plugin update` surface (`plugins/runtime/commands/settings.md`, `scripts/doctor.mjs`) — the last recorded recovery still needed `claude plugin marketplace update agentic-plugins` first to pull the release. Treat the manual marketplace update as still required until the non-slash update path is directly measured. 2.1.229 added `command`-sourced marketplaces and 2.1.232 added GitLab-hosted ones plus `additionalMarketplaces`/`allowedMarketplaces` settings aliases; all are additive catalog sources that leave this repository's git-source marketplace flow unchanged. | Official Codex plugins bundle skills, apps, and MCP servers. Local non-interactive CLI in `0.144.1` (command set unchanged since `0.137.0`) exposes per-plugin `codex plugin add` (install from a configured marketplace snapshot), `list`, and `remove`, plus `codex plugin marketplace add`/`list`/`upgrade`/`remove`; interactive `/plugins` owns browse/install/toggle UX. `0.138.0` added `--json` to `add`/`remove` and the marketplace commands plus a `marketplaceSource` field on source-backed `list --json` entries (not universal), `0.139.0` can serve available-plugin lists from the cached remote catalog before a background refresh, and `0.143.0` enabled remote plugins (`remote_plugin` stable) with npm marketplace sources — additive catalog sources next to git/local marketplaces. It still has no per-plugin `update`, `enable`, `disable`, `details`, `validate`, or `prune`. | Runtime settings may execute allowlisted Claude plugin commands and Codex marketplace commands. As of Codex `0.137.0` the CLI does expose per-plugin `add`/`list`/`remove` (marketplace-snapshot-sourced), so runtime must not call the surface marketplace-only; it must also not claim full Claude-style parity (no per-plugin `update`/`enable`/`disable`/`details`/`validate`/`prune`). Runtime `doctor`/`settings` now recognize the per-plugin surface as `per-plugin-and-marketplace`, keyed on the observed `codex plugin --help` (ADR-0032), and `doctor` reads Codex installed-state host-natively from `codex plugin list --json` (read-only, list-authoritative-then-cache; ADR-0034) at parity with the Claude `claude plugin list` read — the `0.138.0`+ additive `list --json` fields (including 0.144.1's per-entry `source` object and remote-plugin rows) are ignored by that field-selective resolver (re-verified on `0.144.1`). `codex plugin add <plugin>@agentic-plugins` is executable behind `--execute-plugin-management` as a policy-gated H2 executor (ADR-0035 §5; see `follow-ups.md`). Runtime cleanup must distinguish retired/unknown user-requested cleanup from Claude's dependency-aware plugin enable/disable/prune behavior. |
| Plugin contents | Claude plugins can provide skills, agents, hooks, and MCP servers; local CLI supports `--plugin-dir` and `--plugin-url`. Claude Code 2.1.142 surfaces plugins with a root-level `SKILL.md` and no `skills/` directory as a skill, and plugin details show LSP servers. | Codex plugins are the distribution unit for reusable skills, apps, and MCP servers. The repo marketplace is `.agents/plugins/marketplace.json`, with Codex plugin manifests under `.codex-plugin/plugin.json`. | Keep dual host manifests and catalogs. Do not collapse host-specific plugin metadata into `.agentic-plugins`; that directory is runtime-owned state/config, not a host plugin manifest path. Runtime shape tests should continue requiring explicit Codex `skills/` mirrors even if Claude accepts a root-level `SKILL.md` shortcut. |
| Skills and commands | Claude plugin command surfaces include slash commands and skills. Subagents provided by enabled plugins can be mentioned as plugin-scoped agents. Claude Code 2.1.233 withdrew the todo/task-tracking tools (`TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList`, `TodoWrite`) from Opus 4.8, Sonnet 5, Fable 5, Mythos 5, and newer models, restorable with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` — so **the tool set a command can call is a function of host version × model, not host version alone**, and this is the first recorded parity fact of that shape. 2.1.233 also fixed skill/command argument substitution re-expanding argument values as template markers, which is the path every `$ARGUMENTS`-carrying command in this repository depends on. | Codex skills are invoked explicitly with `$skill` or selected implicitly from skill descriptions. `SKILL.md` is the workflow entrypoint; optional `agents/openai.yaml` configures presentation and dependencies. Codex exposes none of those five Claude tool names — measured zero occurrences of `TaskCreate`/`TaskUpdate`/`TodoWrite` in the `0.147.0` binary, against a working control — but it is **not** true that Codex has no tracker of this shape: the same binary carries `update_plan` (43 occurrences). The Codex skill mirrors never carried the Claude instruction, yet the instruction was not Claude-only in *reach*: `plugins/orchestrator/skills/next/SKILL.md` names `commands/next.md` as "the behavioral source" for Codex and has Codex follow the engineer command markdown explicitly, so a withdrawn-tool instruction in a Claude command file can reach a Codex session indirectly. | Runtime commands stay mirrored as Claude commands plus Codex skills. Text should say `$runtime:*` for Codex and `/runtime:*` for Claude instead of pretending the invocation syntax is identical. **A command runbook must not hard-depend on a host tool a model may not carry**: phrase progress tracking as the intent with the host tool as an optional means. The twenty runbooks across `designer`/`engineer`/`founder`/`orchestrator` that read "Use `TaskCreate` and `TaskUpdate` to track progress" were rewritten on 2026-08-16 for exactly this reason — they had instructed agents to call tools absent from the session's own tool list. Do not re-introduce the dependency by recommending `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`: that is a host-session opt-in the operator owns, and it has no Codex counterpart. |
| Hooks | Claude hooks are configured in settings, plugin hook config (the default `hooks/hooks.json` or a `.claude-plugin/plugin.json` `hooks`-declared `./`-relative path — string, array, or inline object per the plugin manifest reference; attention uses a declared `adapters/claude/hooks/hooks.json` to stay out of Codex default-file discovery), and skill/subagent frontmatter. They support rich lifecycle events, including `SessionStart`, `Stop`, `SubagentStop`, `PreCompact`, `PostCompact`, `MessageDisplay`, task/team-related events, worktree events, and JSON decision control. Plugin hooks use `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` for bundled scripts and persistent plugin data. Claude Code 2.1.144 ends turns with a warning after 8 consecutive Stop-hook blocks (override `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`); 2.1.145 added `background_tasks`/`session_crons` to `Stop`/`SubagentStop` input and `PostToolUse` `updatedToolOutput`; 2.1.147 surfaces active effort via `effort.level`/`$CLAUDE_EFFORT`; 2.1.152 added the `MessageDisplay` event and `SessionStart` `reloadSkills`/`sessionTitle` outputs; 2.1.169 added `--safe-mode` (`CLAUDE_CODE_SAFE_MODE`), which starts a session with CLAUDE.md, plugins, skills, hooks, and MCP servers disabled for troubleshooting. 2.1.219 added a `DirectoryAdded` event that fires after `/add-dir` or the SDK `register_repo_root` control request registers a new working directory mid-session — additive; no existing event's payload or decision contract changed, and runtime registers no handler for it. 2.1.229 added server-supplied hook support for self-hosted runner sessions, matching managed-environment behavior — additive, and runtime packages no server-supplied hooks. 2.1.233 fixed `Notification` hooks not firing for permission prompts under Claude Desktop and VS Code — a **delivery** fix, which is all the source establishes. It makes the ADR-0040 §3 `plugins/attention` `Notification` sensor reach two hosts where it previously never fired, and the sensor branches directly on `notification_type` (`adapters/claude/hooks/notification.mjs`). The changelog says nothing about that field, so **payload compatibility on the newly-reached hosts is unverified**, recorded here as such rather than inferred from silence; the matcher is left unchanged pending a probe on Desktop and VS Code. | Codex hooks are documented and generic `hooks` is stable/enabled. The `plugin_hooks` feature flag was **removed** in ~0.134.0 (PR #22552); `codex features list` on 0.144.1 still reports `plugin_hooks` as `removed` and generic `hooks` as `stable`. Plugin-bundled hooks are no longer gated by a separate flag: a plugin's hooks load when the plugin is enabled and generic `[features].hooks` (default on) is set, declared via a `.codex-plugin/plugin.json` `hooks` entry or the default `hooks/hooks.json`, and still require `/hooks` review+trust. Hook commands receive `PLUGIN_ROOT`/`PLUGIN_DATA`; Codex still sets `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` as compatibility aliases. Local non-interactive help still does not expose a `codex hooks` trust/query command. | Runtime must diagnose generic hooks, plugin enablement, manifest hook exposure, installed hook packaging, hook command portability, and hook trust/review separately. `/hooks` `Installed` counts are packaging evidence only; `Active=0` output and `Trust: New hook - review required` are not enough to attest. **The removed `plugin_hooks` flag obsoletes the old enablement path: writing `~/.codex/config.toml` `[features].plugin_hooks = true` is a no-op on 0.144.1, and `codex --enable plugin_hooks` targets a removed flag.** The former settings apply executor (`--apply-codex-plugin-hooks`) and the doctor `enable-codex-plugin-hooks` recommendation were removed per ADR-0035 §6; runtime keeps the read-only `plugin_hooks` stage diagnosis and verifies `[features].hooks` (default on) + plugin enablement + `/hooks` trust. Recording an operator attestation with `--attest-codex-hook-review` after the active Codex `/hooks` review/trust step still applies. `CLAUDE_PLUGIN_ROOT` inside a Codex-exposed hook command is compatibility telemetry, not a portability warning by itself; `adapters/claude/hooks` paths and bare `node` commands are portability warnings. The attestation is not host-native proof and is valid only while the hook-bearing plugin set and source versions still match. Runtime should not assume a portable Stop-hook block cap exists across hosts; if it adds hook retry policy, it must remain explicit and host-observed. |
| Subagent trigger model | Claude can delegate to built-in and custom subagents automatically based on description, and users can explicitly invoke them. Custom subagents live in `.claude/agents/` or `~/.claude/agents/`. Claude Code 2.1.232 turned subagent **forking** on by default (a `subagent_type: "fork"` subagent inherits the full conversation and prompt cache) and made non-teammate agent spawns in interactive sessions run in the background by default. Unlike the 2.1.217 concurrency caps and the 2.1.219 spawn-depth change, this one is **not** disposed of by observing that the companion contract spawns a process rather than a host subagent. That observation holds for peer invocation only: `plugins/engineer` also spawns *native* Claude subagents through the `Agent` tool (`skills/_shared/references/agent-taxonomy.md`, and the local-agent steps in `skills/critique/SKILL.md` and `skills/investigate/SKILL.md`), and those runbooks say "wait for local agents" without pinning how results are collected when a spawn is backgrounded by default. **Result collection under the 2.1.232 default is unprobed as of this observation** and is recorded here as an open question, not as a no-impact change. | Codex subagent workflows are enabled by default, but Codex only spawns subagents when explicitly asked. Built-ins include `default`, `worker`, and `explorer`; custom agents live in `.codex/agents/` or `~/.codex/agents/`. | Runtime consensus may plan broad manual/subagent lanes, but Codex fanout must remain an explicit operator/user action. Do not infer Claude-style automatic subagent delegation on Codex. |
| Agent teams / team mode | Claude agent teams are experimental, disabled by default via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, and provide multiple Claude instances with a lead, teammates, shared task list, and peer-to-peer messages. Claude Code 2.1.232 added a **non-team** cross-session channel alongside this: `@`-mentioning another Claude session by name, `SendMessage` delivering to a bare name that matches one live session, per-machine unique session names, and `/config` rows for cross-session inbound accept/hold/refuse. Additive and unadopted — but it means "multiple Claude instances talking to each other" is no longer synonymous with agent teams on this host. Note also that the shared-task-list property above predates the 2.1.233 todo-tool withdrawal recorded in the Skills and commands row; whether a team on an affected model still gets that list, or whether team sessions re-enable the tools, is **unprobed**. | Codex has subagent workflows and a stable local `multi_agent` feature flag, but the docs describe explicit subagent workflows, not Claude agent teams with shared mailbox/task-list semantics. | Cross-host "team mode" should be implemented as agentic-plugins runtime/orchestrator artifacts, companion dispatch, explicit consensus rounds, and manual/subagent lanes, not by depending on Claude agent teams as the portable abstraction. |
| Parallelism limits | Claude docs recommend subagents, agent view, agent teams, and worktree sessions for different parallelism shapes. Agent teams add high token cost and known limitations. Local `claude agents --help` exposes dispatch defaults for additional dirs, settings, MCP config, plugin dirs, permission mode, model, effort, and bypass-permissions availability; 2.1.169 `claude agents --json` added `--all` plus new `id`/`state` fields. | Codex docs expose `[agents]` settings: `agents.max_threads` defaults to `6`, `agents.max_depth` defaults to `1`, and deeper recursion raises cost/predictability risk. | Runtime should support explicit broad rosters without a hidden product cap, while preserving bounded max rounds, process budgets, timeouts, and explicit peer lists. Claude `claude agents` dispatch flags are useful host evidence but are not the portable runtime fanout contract. |
| Permissions and sandbox | Claude exposes permission modes such as `default`, `plan`, `acceptEdits`, and `bypassPermissions`; teammates inherit the lead's permissions at spawn. The 2.1.228–2.1.233 window is a worked example of why this file records an **observed** version rather than a recent one: 2.1.232 permission-checked Bash input redirections (`< file`) on all platforms and required approval for writes through Windows Cygwin-style symlinks, and 2.1.233 **reverted both** ("a narrower version will return in a later release") after they regressed ordinary `cd <dir> && <command> > file` approvals on Windows. A baseline refreshed to 2.1.232 — the version this loop originally targeted — would have recorded two permission behaviors that no longer exist. | Codex separates sandbox mode and approval policy. Defaults include workspace-write with network off; subagents inherit the current sandbox policy and non-interactive approval gaps fail back to the parent workflow. | Runtime must classify permission/sandbox/auth preconditions as operator action. Settings must not silently relax host permissions, sandbox, approval, or network policy for companions or subagents. |
| Model and effort | Claude CLI exposes `--model` and `--effort`. Subagent model resolution includes `CLAUDE_CODE_SUBAGENT_MODEL`, per-invocation model, subagent frontmatter, then main conversation model. Claude Code 2.1.142/2.1.143 added and then broadened `claude agents --model` and `--effort` propagation to dashboard-dispatched and background sessions. | Codex CLI exposes `--model`; config supports model defaults and spawned custom agents can include model and `model_reasoning_effort`. | Runtime's portable model/effort path remains `.agentic-plugins/config.toml` plus companion-contract `--model` and `--effort`. Host-native model config writes remain deferred. Runtime should keep model/effort evidence direction-specific and not treat Claude agent-view defaults as Codex-equivalent. |
| Settings/config | Claude uses `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, and managed policy files. Plugin enablement can live under `enabledPlugins` settings. Claude Code 2.1.142/2.1.143 background-session dispatch can propagate settings, MCP config, plugin dirs, strict MCP config, and additional dirs. | Codex uses `~/.codex/config.toml`, trusted project `.codex/config.toml`, system config, profiles, and CLI `-c` overrides. | Runtime `settings --apply` writes only `.agentic-plugins/config.toml`; the former narrow `settings --apply-codex-plugin-hooks` executor (writing `~/.codex/config.toml` `[features].plugin_hooks = true`) was removed per ADR-0035 §6 — runtime has no Codex host-config write executor. Host-native `.claude` config and broader `.codex` config mutation remain out of scope. Runtime should observe Claude dispatch flags but not use them to justify hidden host-native settings mutation. |
| MCP | Claude `claude mcp` manages MCP servers and hook MCP tools can participate in Claude hook decisions. | Codex `codex mcp` manages MCP server entries in Codex config. Plugins can bundle MCP servers. | Runtime may observe MCP command surfaces and plugin packaging, but should not auto-add or rewrite MCP servers outside an explicit settings executor. |
| Worktrees | Claude CLI exposes `--worktree` and `--tmux`, and agent view can move dispatched sessions into worktrees when edits are needed. Claude Code 2.1.143 added a `worktree.bgIsolation: "none"` setting and changed failed worktree cleanup to avoid force-deleting in-progress or gitignored files. 2.1.233 added GitLab merge-request URL support to `--worktree` and to the `claude agents` view (MRs display as `!N`) — additive, and `runtime:worktree plan` stays read-only. | Codex has app worktree docs and the local CLI supports ordinary git worktree workflows through shell commands, but runtime has no host-native Codex worktree executor. | `runtime:worktree plan` stays read-only. Actual `git worktree add/remove/prune`, host session spawning, and PR handling remain operator actions. Runtime worktree guidance should prefer conservative cleanup and never synthesize forced deletion as a hidden fallback. |

## Claude `SessionStart` Matrix (probed 2026-07-18)

ADR-0045 §7 probe-gate record. Probed live on Claude Code `2.1.214`
(darwin; isolated project directory; probe hooks loaded via an explicit
`--settings` file; headless `-p` runs), cross-checked against the
official hooks reference and the `v2.1.214` changelog. **This section is
version-bound**: the attention startup-sensor work (ADR-0045 §12 step 4)
must re-validate this verdict against the then-installed CLI before
registering a hook. The baseline header's observed-version line is
governed by the full compat refresh flow and is deliberately not bumped
by this section.

| Question | Observation / documented truth | Evidence |
| --- | --- | --- |
| Matcher vocabulary | Documented semantic matchers: `startup` (new session), `resume` (`--resume` / `--continue` / `/resume`), `clear` (`/clear`), `compact` (auto/manual compaction). `"*"`, `""`, and an omitted matcher are match-all forms (omitted matcher observed live matching a fresh session); regex/alternation matcher patterns are documented. **`2.1.214` adds a fifth emitted source `"fork"`** while the docs matcher table still lists four — whether literal `matcher: "fork"` is accepted is unproven. | docs + changelog + live probe |
| Fresh session | Exactly one `startup` firing per fresh session — headless `-p` included; `resume`/`clear`/`compact` did not fire. | live probe |
| Resume | `claude -p --resume <id>` fired `resume` only — no `startup` double-fire; payload `session_id` preserved (`2.1.73` fixed historical double-firing on `--resume`/`--continue`). `/resume`, conversation recovery, and crash restore were not probed. | live probe + changelog |
| `clear` / `compact` | Not non-interactively probeable (interactive slash commands). Documented sources; `compact` reinjection is separately evidenced by the four persona plugins' production `matcher: "compact"` hooks. | docs + indirect |
| Payload | stdin JSON carried `session_id`, `transcript_path`, `cwd`, `hook_event_name: "SessionStart"`, `source`. | live probe |
| stdout injection | Both channels enter model context on exit 0: raw stdout (probe token verbatim-echoed by the model) and JSON `hookSpecificOutput.additionalContext` (wrapped in a system reminder; not a user-visible chat message). Hook-output strings cap at 10,000 chars (overflow spills to a session file + preview). Special outputs: `initialUserMessage` (`-p`), `sessionTitle` (startup/resume only), `watchPaths`, `reloadSkills` (`2.1.152`). | live probe + docs |
| Ordering | **No ordering guarantee** — all matching handlers run in parallel; array order is not execution order (three identical 3-hook runs completed `B A C`, `A C B`, `A B C`). Plugin hooks merge with user/project hooks into the same parallel pool with no documented precedence; `additionalContext` concatenation order is unspecified; identical command+args handlers are deduplicated. | live probe + docs (mutually confirming) |
| Failure isolation | Hook `exit 1` non-blocking (observed: session proceeded). `exit 2` also cannot block SessionStart (documented; stderr surfaces as a hook-error notice). Exception: an exit-0 structured `"continue": false` response can halt Claude entirely — an entry sensor must never emit it. | live probe + docs |
| Timeout | Per-hook `timeout` field honored in **seconds** (observed: `sleep 8` + `timeout: 3` → killed, no side effect, session proceeded). Documented default: **600 s**, and synchronous SessionStart handlers delay session entry until they finish — a registered entry hook must set an explicit small timeout. `2.1.210` fixed hook-callback timeouts misreported as user rejection. | live probe + docs |
| Safe mode | `--safe-mode` produced zero hook firings **even from an explicitly passed `--settings` file** (observed — closes a documentation gap); session proceeded normally. Documented scope: disables hooks/plugins/skills; managed-policy hooks may remain active. | live probe + docs |
| Headless | SessionStart fires in `-p` (observed; docs confirm headless loads hooks; `--bare` is the opt-out that skips hook discovery; `2.1.204` fixed headless SessionStart hook-event streaming). | live probe + docs |
| `2.1.208` → `2.1.214` | Only explicit SessionStart lifecycle change: the new `"fork"` source (`2.1.214`; `/fork` became a copied background session in `2.1.212`). Also `2.1.214`: fixed `--settings`-enabled plugins not loading (regression since `2.1.181`); settings-file startup hardening (2 MiB cap). | changelog |

**Verdict (version-bound, `2.1.214`): PASS.** A usable
startup-equivalent matcher exists — `startup` — defined as: *fires
exactly once per fresh session (headless included), carries a parseable
JSON payload, is non-blocking on failure, honors a bounded per-hook
timeout, and injects hook stdout into model context*. All five
properties were observed live on `2.1.214`.

**S9 gate policy** (ADR-0045 §7/§12): the attention startup sensor may
register `matcher: "startup"` while a current-CLI re-validation of this
verdict holds; on a failed or stale re-validation the hook surface stays
unshipped (that subtask goes `deferred`) and the CLI + dashboard
surfaces ship regardless. Design constraints this matrix pins: the
sensor MUST pin an explicit `startup` matcher (an omitted matcher
matches every source, including `compact` — colliding with the persona
compact-hook lane) and MUST set an explicit small `timeout` (the 600 s
default delays session entry); `"fork"`-source sessions will not fire a
`startup`-matched sensor — acceptable for v1 (a fork is a copied
session, not a fresh entry), re-examined if fork adoption grows; the
parallel/no-precedence execution model is the probed ground for
ADR-0045 §1's single-arbiter ruling — independent SessionStart hooks
cannot be sequenced.

**Re-validation trail** (append a row per S9-gate re-validation; the
verdict above stays version-bound to the newest PASS row):

| Re-validated | Installed CLI | Method | Result |
| --- | --- | --- | --- |
| 2026-07-20 | `2.1.215` | Changelog delta `2.1.214`→`2.1.215` (one entry: `/verify`·`/code-review` no longer self-invoked — no SessionStart/hook/timeout/stdout/safe-mode change) + live probe (isolated git repo, explicit `--settings` hooks, headless `-p`, three `startup`-matched hooks + one `resume`-matched hook) | **PASS — verdict holds.** All five verdict properties re-observed: exactly one `startup` firing (the `resume` hook did not fire); payload carried `session_id`/`transcript_path`/`cwd`/`hook_event_name`/`source: "startup"`; raw-stdout probe token verbatim-echoed by the model (context injection); `timeout: 3` (seconds) killed a `sleep 8` hook with no side effect while the session proceeded; a hook `exit 1` was non-blocking and the CLI exited 0. Attention `matcher: "startup"` + explicit `timeout: 15` registration proceeds (ADR-0045 §12 step 4). |

## Claude Stop-Payload Matrix (probed 2026-07-21)

ADR-0047 §2 probe-gate record — the source verification the `signal`
implementation slice is required to run **before** wiring the row-1/2
classifier predicates ("the parity baseline records the fields'
existence, not their shape"). Probed live on Claude Code `2.1.216`
(darwin; isolated non-repo project directory; dump hooks loaded via an
explicit `--settings` file; headless `-p`; `--model haiku`), four cases:
bare turn (A), Stop while a `run_in_background` shell task was still
running (B), Stop after a backgrounded task had completed (B′), and Stop
after a session-scoped `CronCreate` (C). Binary string-table inspection of
the installed CLI corroborates the field cluster (`background_tasks`,
`session_crons`, `stop_hook_active`, `agent_transcript_path`,
`extendedHookInput`) on the Stop/SubagentStop input constructor.

| Property | Observed (2.1.216) | Evidence |
| --- | --- | --- |
| Field presence | `background_tasks` and `session_crons` are BOTH always present on `Stop` input as **arrays** — empty (`[]`) when nothing is pending, never absent/null on a supporting host. Absence therefore identifies a pre-`2.1.145` host (or a malformed payload), not an idle session. | live probe A/B/B′/C |
| Additional Stop fields | `permission_mode`, `stop_hook_active`, `last_assistant_message` accompany the documented common fields (`session_id`, `transcript_path`, `cwd`, `prompt_id`, `hook_event_name`). | live probe |
| `background_tasks` entry shape | `{ id, type, status, description, command }` — observed `type: "shell"`, `status: "running"` for a live `run_in_background` Bash task. | live probe B |
| Completed-task behavior | A backgrounded task that completed before the turn ended was **removed** from `background_tasks` (`[]` at Stop). No terminal status token was ever observed surviving in the list. | live probe B′ |
| `session_crons` entry shape | `{ id, schedule, recurring, prompt }` — a `*/10 * * * *` session cron created via `CronCreate` in the same turn. | live probe C |
| Predicate consequence (ADR-0047 §2) | Row 1/2 wire as: well-formed array ⇒ observable; **any resident entry ⇒ interim** (entry-shape-independent — no guessed terminal-token set; residents read not-terminal because terminal residents were never observed, erring only in the accepted false-negative direction); present-but-non-array ⇒ unobservable, never "empty". A future host version observed KEEPING terminal-status entries listed is a compat-watch trigger to widen the predicate with a source-verified token set — never a live guess. | probe A/B/B′/C + ADR-0047 §2 |
| Not probed | `SubagentStop` payload (out of the `signal` slice's scope — §3 leaves `subagent-complete` untouched); background task `type` vocabulary beyond `"shell"` (irrelevant to the type-agnostic predicate); terminal status tokens (never observed in-list). | — |

**Re-validation trail** (append a row when a Claude drift touches
Stop-payload semantics; the ADR-0047 §5 standing watch covers the adjacent
`agent_needs_input`/`agent_completed` evolution surface):

| Re-validated | Installed CLI | Method | Result |
| --- | --- | --- | --- |
| 2026-07-21 | `2.1.216` | Initial record (live probe matrix above) | Baseline established; attention `signal` slice wired against it. |

## What Fails If We Assume Claude Semantics On Codex

- A Claude plugin command plan that says `codex plugin install runtime` is still
  wrong for local Codex CLI `0.144.1` — the per-plugin install verb is `codex
  plugin add <PLUGIN[@MARKETPLACE]>` (sourced from a configured marketplace
  snapshot), not `install`. `codex plugin list` does now exist (it was absent in
  the prior marketplace-only surface), and `codex plugin remove` removes an
  installed plugin. There is still no per-plugin `update`, `enable`, `disable`,
  `details`, `validate`, or `prune`.
- A Claude SessionStart/Stop hook design must be exposed through Codex plugin
  metadata and still will not run automatically until the plugin is enabled,
  generic `[features].hooks` is on, and the hooks have been reviewed/trusted
  with `/hooks`. The separate `plugin_hooks` flag was removed in ~0.134.0;
  plugin hooks now follow plugin enablement. Codex generic hooks, plugin
  enablement, and bundled hook metadata are different readiness questions.
- A Codex hook plan that treats a `[features].plugin_hooks` value or marketplace
  cache metadata as proof of hook trust is overstated — and on 0.144.1
  `plugin_hooks` is still a removed flag, so its value is meaningless. Local CLI
  `0.144.1` does not expose a non-interactive hook trust query; `/hooks` remains
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
  `[features].plugin_hooks` toggle handled by `--apply-codex-plugin-hooks` was
  removed per ADR-0035 §6; no executor replaces it.
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

### Standing Notification Watch (ADR-0047 §5)

Two recorded notification gaps are under a **standing** `runtime:compat` watch
— seeded rows emitted on every `plan` run, not keywords that only fire on
future drift — so they stay visible until resolved:

- **Codex `notify=` payload variants beyond `agent-turn-complete`**
  (especially approval/permission shapes). At this baseline no approval
  payload reaches `notify=`, and the rendered
  `receivers/codex-notify-shuttle.mjs` silently no-ops on any other payload
  `type` — that no-op is contractual, pinned by test.
- **Claude `Notification` hook `agent_needs_input` / `agent_completed` types**
  (added in `2.1.198`, recorded in the Version History row of 2026-07-04).
  The attention `Notification` sensor continues to match only
  `permission_prompt`/`idle_prompt` and ignores the new types.

A watch signal in ingested release notes adds a required review step to the
compat plan but never wires a mapping: resolving a row requires a
source-verified payload shape recorded here plus a dedicated follow-up
decision (ADR-0030 discipline) before any shuttle or sensor change.

### ADR-0013 Trigger Watch (Codex plugin-command registration)

ADR-0013 is held `Reserved` pending a stable Codex mechanism for a **plugin to
register a command surface**. That is the half of issue #89 left open by its
2026-06-23 comment: the hook half resolved without ADR-0013 (plugin enablement
plus generic `[features].hooks`, gated by `/hooks` review/trust — wired in
ADR-0030, host-config write removed under ADR-0035 §6), and the trigger was
narrowed to command registration alone.

**Assessment 2026-08-08 — NOT FIRED**, observed live on Codex CLI `0.145.0`,
corroborated by an independent cross-host peer pass over the same surfaces.
This is a targeted single-surface re-observation, not a baseline refresh: the
`Observed on` header above is deliberately unchanged and no Version History row
is appended. Evidence, each re-run against the installed host rather than read
back from this file:

- `codex plugin --help` -> `add`, `list`, `marketplace`, `remove`. Those are
  install/catalog management verbs — the per-plugin surface ADR-0032 already
  recognizes — not a registration point for plugin-authored commands.
- The manifest field guide Codex itself ships,
  `plugin-creator/references/plugin-json-spec.md` embedded in the `0.145.0`
  binary, enumerates the complete top-level `.codex-plugin/plugin.json` field
  set: `name`, `version`, `description`, `author`, `homepage`, `repository`,
  `license`, `keywords`, `skills`, `hooks`, `mcpServers`, `apps`, `interface`.
  There is no `commands` field, and its path-conventions section names the
  component set outright — "`skills`, `hooks`, and string-valued `mcpServers`
  are supplemented on top of default component discovery; they do not replace
  defaults."
- The same bundled `plugin-creator` skill offers `--with-skills --with-hooks
  --with-scripts --with-assets --with-mcp --with-apps --with-marketplace`, and
  its "Supports optional creation of" list is `skills/`, `hooks/`, `scripts/`,
  `assets/`, `.mcp.json`, `.app.json`. No commands component in either.
- <https://developers.openai.com/codex/plugins/build> describes `skills`,
  `mcpServers`, `apps`, `hooks`, and the `interface` asset block, and no
  plugin-registered command component.
- `codex features list` on `0.145.0`: `plugins`, `plugin_sharing`, and
  `remote_plugin` stable/true, generic `hooks` stable/true, `plugin_hooks`
  still `removed` — the hook half of the trigger remains resolved. There is no
  `plugin_commands` row at any stage, so this is not a flag waiting to be
  enabled.

Three things look like they flip the verdict and do not. They are recorded so a
later reader does not have to re-litigate them:

- The `0.145.0` binary also ships `plugin-creator/scripts/validate_plugin.py`,
  whose `allowed_keys` set omits `commands`. That set is the narrower plugin
  *ingestion* contract, and it also omits `hooks` — which demonstrably works at
  runtime and is this project's own packaging path. Its silence about
  `commands` therefore carries little weight on its own; the manifest field
  guide above, not this validator, is the load-bearing evidence.
- Codex does have a slash-command surface: built-in `/` commands with tab
  completion, a `custom_prompt_view` TUI component, and "Slash commands" as an
  importable category in the `0.145.0` `/import` flow that migrates setup from
  another coding agent. Those are Codex-shipped commands plus per-user setup the
  operator authors or imports — not a component a marketplace-installed plugin
  declares, and not something a plugin manifest can target. Do not read "Codex
  has slash commands" as "Codex has plugin commands".
- Hook entries use `"type": "command"`, including this project's own
  `adapters/codex/hooks/hooks.json`. That names a lifecycle subprocess handler,
  not a user-invokable command registration.

What would flip this: a `commands`-shaped component in the plugin manifest
spec, or an equivalent documented plugin-local command/prompt registration
path, observable through `codex plugin --help`, the shipped manifest field
guide, or the official plugin docs. Until then the ADR-0021 skill-wrapper
parity (`$engineer:start` and its siblings) stays the honest Codex-side command
surface, and the ADR-0013 deferrals recorded across `plugins/engineer`,
`plugins/founder`, `plugins/designer`, and `docs/adr/` stay justified for
native command registration specifically.

One adjacent record was checked and needs no correction: the `plugin_hooks`
removal is recorded here and in `codex-capability-baseline.md` as ~`0.134.0`
(PR #22552), and no repository document assigns a different version to that
event. ADR-0030 separately cites `0.136.0` as the *installed* host when it was
written, and the Version History row of 2026-06-03 records `0.136.0` as the
first local removed-stage observation — both are observation versions, not
competing removal versions.

**Amendment 2026-08-08 (re-verified on Codex `0.147.0`) — verdict unchanged,
evidence widened.** The assessment above was written against `0.145.0` and
reasoned from Codex's own *authoring* spec. `0.146.0`–`0.147.0` added an
**ingestion** path that the authoring spec does not describe, and a reader who
checked only the paragraphs above would miss the strongest near-miss to date:

- The `0.147.0` binary carries `core-plugins/src/command_migration.rs` and
  `core-plugins/src/command_migration/render.rs`, a `RawPluginCommandManifest`
  serde struct, a `migrated-command-skills` namespace, a `commands/` path
  segment, and the Claude command-template markers `$ARGUMENTS` and the
  `` ! ``-prefixed backtick bash block, alongside the error string
  `No command template body was found.` Codex can therefore *read* a
  Claude-shaped `commands/` directory and render it into skills.
- The manifest candidate list is now a triple — `.codex-plugin/plugin.json`,
  `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json` — and the
  marketplace candidate list likewise includes `.claude-plugin/marketplace.json`
  and `.cursor-plugin/marketplace.json` next to `.agents/plugins/marketplace.json`.
  `0.146.0` announced "Support Agent Plugins manifests"; `0.147.0` announced
  "Install portable Agent Plugins and search across local, personal, workspace,
  and remote plugin catalogs."

It still does not fire the trigger, for two measured reasons rather than one
absence:

1. **Undocumented.** The Agent Plugins standard (<https://agent-plugins.org>)
   defines `plugin.json`, `skills/`, `mcp.json`, and reverse-domain extension
   namespaces — no commands component. The official
   <https://developers.openai.com/codex/plugins/build> documents skills,
   `mcpServers`, `apps`, `hooks`, and interface assets — no commands component,
   and no command migration. Issue #89's trigger requires a mechanism this
   project can target *without host-specific guesswork*; an undocumented
   internal migration path is exactly that guesswork.
2. **It does not fire for our plugins.** Every agentic-plugins plugin ships a
   `.codex-plugin/plugin.json`, which wins the candidate list, and no
   `migrated-command-skills` artifact exists anywhere under `~/.codex` on a
   host running `0.147.0` with all eight plugins installed and enabled. The
   `commands/` directories are copied into the marketplace snapshot and ignored.

The same triple-manifest change was checked against the ADR-0040 §3 invariant
that `plugins/attention` presents **zero** Codex hook surface by declaring its
Claude hooks at `adapters/claude/hooks/` and no hooks in its Codex manifest. If
Codex now read `.claude-plugin/plugin.json` for a plugin that also ships a Codex
manifest, that invariant would break. It does not: the `0.147.0` doctor proof
reports `bundled=designer,engineer,founder,orchestrator` with attention absent.
The Codex manifest takes precedence; the invariant holds.

## Compatibility Assurance

This section carries the **assurance record** — whether a host pair this
framework runs on is covered by an accepted human review. It is a different
fact from the `Observed on …` header above, and the two are deliberately not
merged ([ADR-0053](../../../docs/adr/0053-baseline-exactness-and-compatibility-assurance.md)
§Decision 1). The header answers *which versions were observed*; this record
answers *which were reviewed and accepted, for what code, with what left open*.

Four rules govern it, and none of them is a formatting preference:

- **Humans grant; runtime matches** (§Decision 2, §Decision 5). A reviewer
  authors the coverage predicate. Runtime mechanically evaluates whether the
  current environment is a member of it. Membership matching is not derivation,
  and there is no version comparison, elapsed time, or keyword silence that
  produces a grant. `runtime:compat` may assemble evidence; it may not accept.
- **Negative and unknown win** (§Decision 3). Duplicate, conflicting,
  superseded and revoked records resolve negative. A predicate whose inputs
  runtime cannot observe, or that matches ambiguously, yields `unassured`.
  Absence of evidence is never coverage.
- **Any window is an explicit finite cohort** (§Decision 7). Endpoint ranges are
  rejected because they conceal skipped releases. Cohort entries are complete
  host *tuples*, so two independent per-host lists cannot be read as authorizing
  their Cartesian product.
- **A grant binds to the code it was reviewed against** (§Decision 8). It names
  the consuming packages and their versions, and it is invalidated when a named
  package changes version, is absent, or is disabled. Grant ids are immutable
  and revocation is append-only: a revoked grant is never un-revoked, only
  replaced by a new id carrying `reapproval_of`.

**Grammar.** Exactly one sentinel-delimited ` ```json ` fence appears below.
Its content must be the **canonical serialization** of a
`runtime-host-assurance-1.0` record — the key order the packaged schema
declares, two-space indent, trailing newline. That is not tidiness: `JSON.parse`
resolves a duplicate key last-wins and says nothing, so a block whose bytes read
`revoked` to a human could parse as `granted`. Requiring the bytes to equal the
re-serialization of what they parsed to makes the shadowed member visible. The
schema version is pinned **exactly** — a newer minor is refused rather than read
with its unknown keys ignored, because a narrowing key an older reader dropped
would turn a restricted grant into a broad one
([ADR-0054](../../../docs/adr/0054-assurance-record-schema-and-rollout.md)
§Decision 3).

Structure is checked by `data/schemas/runtime-host-assurance-1.0.json`; the
rules a closed keyword subset provably cannot express — id uniqueness,
negative-wins, exact package-set equality, vacuous grants, residual coherence,
calendar validity — are checked in code (ADR-0054 §Decision 2).

**The grant set is currently empty, and that is the intended shipped state.**
Every host therefore reads `unassured`, and readiness blocks. This is
ADR-0054 §Decision 6's rollout: the gate's *failing* path is exercised by the
real gate on real machines before any positive result is possible, rather than
by a temporary interlock built to be deleted. The first grant lands with owner
ratification once the matcher that would honor it exists.

<!-- BEGIN COMPATIBILITY ASSURANCE -->
```json
{
  "schema": "runtime-host-assurance-1.0",
  "grants": []
}
```
<!-- END COMPATIBILITY ASSURANCE -->

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
| 2026-06-07 | `2.1.168` | `0.137.0` | Re-observed for host-version-drift #388. Codex `0.137.0` added per-plugin `codex plugin add`/`list`/`remove` and `marketplace list`, plus top-level `doctor`/`update`/`login`/`logout`/`archive`; the hooks story (`plugin_hooks` removed, `hooks` stable) is unchanged from 0.136.0. |
| 2026-06-10 | `2.1.170` | `0.139.0` | Re-observed for host-version-drift #388 (reopened). Codex plugin-surface changes are additive-only: `0.138.0` added `--json` to plugin `add`/`remove` and marketplace commands plus a `marketplaceSource` field on source-backed `list --json` entries (not universal; ignored by the field-selective ADR-0034 resolver), and `0.139.0` serves available-plugin lists cached-first with background refresh. `plugin_hooks` stays `removed`; new under-development flags `multi_agent_v2`/`remote_plugin`. Claude `2.1.169` added `--safe-mode` and `claude agents --json` `--all`/`id`/`state`; `2.1.170` ships the Fable 5 model. Also corrected the stale "codex plugin add executor remains deferred" implication in both baseline docs (it shipped under ADR-0035 §5). |
| 2026-06-11 | `2.1.173` | `0.139.0` | Re-observed during cutover-audit freshness recovery (compat run `compat-20260611T115129Z-5af90f`, content-backed Claude changelog ingest). Claude-only patch drift; `2.1.171` was never published. Additive/fix-only with no plugin-CLI or hook surface change: `2.1.172` adds nested sub-agent spawning (5 levels), a `/plugin` marketplace search bar, Bedrock region from `~/.aws`, and fixes `availableModels` restriction application, `/model` picker rows, and `WebFetch(domain:*.example.com)` wildcard permission matching; `2.1.173` normalizes Fable 5 `[1m]` model-name suffixes and fixes a Windows sandbox startup warning. Codex unchanged at `0.139.0`. Baseline refresh only; no adoption work required. |
| 2026-06-23 | `2.1.186` | `0.141.0` | Re-observed for host-version-drift #388 (Claude patch `2.1.173`→`2.1.186`, Codex minor `0.139.0`→`0.141.0`). Both drifts are additive/fix-only with no plugin-CLI or hook-contract surface change. Codex `0.139.0`→`0.141.0`: `codex features list` confirms `plugin_hooks` stays `removed` and `hooks`/`plugins`/`plugin_sharing` stay stable; the `codex plugin` CLI (`add`/`list`/`marketplace`/`remove`, with `--json`/`--available` on `list`) is unchanged; flag churn is additive/internal (`multi_agent` stable, `multi_agent_v2`/`remote_plugin` still under development). Claude `2.1.173`→`2.1.186`: the `claude plugin` CLI command set is unchanged (the `/plugin` TUI only gained a "Skills" Installed-tab section); `2.1.178` removed the `TeamCreate`/`TeamDelete` tools in favor of an implicit agent team under `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (host-native subagent orchestration — no impact on the companion-based runtime); `2.1.186` enforces `Agent(type)`/`Agent(x,y)` permission deny rules on named subagent spawns and relaxes skill frontmatter to accept kebab/snake/camelCase `display-name`/`default-enabled`/`fallback`/`metadata.*`; new settings are additive only (`respondToBashCommands`, `teammateMode:iterm2`, `attribution.sessionUrl`, `footerLinksRegexes`, `enforceAvailableModels`, `/config key=value`). The SessionStart/Stop hook reinjection contract that engineer/orchestrator/founder checkpoints rely on is intact (`2.1.182` has no published changelog entry). Baseline refresh only; no adoption work required. |
| 2026-06-23 | `2.1.186` | `0.142.0` | Re-observed after the operator updated Codex `0.141.0`→`0.142.0` (same-day follow-up to the prior row; resolves host-version-drift #388 — Codex is now at npm-latest `0.142.0`, Claude unchanged at `2.1.186`, so both hosts read `current`). Minor bump, no plugin-CLI or hook-contract surface change: `codex features list` still reports `plugin_hooks` `removed` and `hooks`/`plugins`/`plugin_sharing` `stable`; the `codex plugin` and `codex plugin marketplace` command sets are unchanged. New surface: a top-level `codex --dangerously-bypass-hook-trust` flag (run enabled hooks without persisted `/hooks` trust for a single invocation, explicitly for vetted automation) — not adopted by runtime, which keeps the per-host `/hooks` review/trust + `runtime:settings --attest-codex-hook-review` model. `codex hooks` remains a non-subcommand (forwards to the interactive CLI), so plugin-local hook trust stays an active-session operation. Baseline refresh only; no adoption work required. |
| 2026-07-01 | `2.1.197` | `0.142.4` | Re-observed during `runtime:doctor` freshness recovery (compat run `compat-20260701T000521Z-c44cea`, content-backed ingest of the Claude Code `CHANGELOG.md` and the Codex GitHub releases atom feed). Both drifts are patch-level and additive/fix/chore-only with no plugin-CLI or hook-contract surface change. Claude `2.1.186`→`2.1.197`: the `claude plugin` command set is unchanged (fixes only — `2.1.196` stops `claude plugin validate` skipping `source:"."` local plugins and halting after the first error class; `2.1.195` fixes `/plugin` Enable/Disable when a plugin's `plugin.json` `name` differs from its marketplace entry and requires explicit install consent for project-settings-enabled external plugins; `2.1.193` follows marketplace `renames` maps; `2.1.187`/`2.1.196` surface unused plugins for cleanup). The hooks change is fix-only (`2.1.195` makes hyphenated hook matchers exact-match instead of substring-matching; `2.1.191` fixes comma-separated matchers like `"Bash,PowerShell"` silently never firing) — the SessionStart/Stop/PreCompact reinjection contract engineer/orchestrator/founder checkpoints rely on is intact. `2.1.197` makes Claude Sonnet 5 the default model with a native 1M-token context window; runtime keeps host-default model/effort resolution, so no runtime change. Codex `0.142.0`→`0.142.4`: `0.142.4` and `0.142.3` are chore/maintenance patches with no user-facing changes, and `0.142.2` is additive (MCP tools, macOS auth-proxy support, plugin dark-mode logos, safety-buffering UI, plus bug fixes); the `codex features list` hook story (`plugin_hooks` `removed`, generic `hooks` stable) and the `codex plugin`/`codex plugin marketplace` command sets are unchanged, and no `/hooks` trust or `--dangerously-bypass-hook-trust` surface changed. Baseline refresh only; no adoption work required. |
| 2026-07-04 | `2.1.201` | `0.142.5` | Re-observed during `runtime:doctor` baseline-freshness recovery (compat run `compat-20260704T180436Z-32cdf0`, content-backed ingest of the Claude Code `CHANGELOG.md` and the Codex GitHub releases). Both drifts are patch-level and additive/fix-only with no plugin-CLI or hook-contract surface break. Claude `2.1.197`→`2.1.201`: `2.1.199`/`2.1.200`/`2.1.201` have no published changelog entries; `2.1.198` makes subagents run in the background by default, confirms Claude Sonnet 5 as the default model with a native 1M-token context (runtime keeps host-default model/effort resolution, so no runtime change), adds a `/dataviz` skill, and adds `agent_needs_input` and `agent_completed` `notification_type` values to the `Notification` hook — `permission_prompt` and `idle_prompt` remain valid and unchanged, so the ADR-0040 §3 `plugins/attention` `Notification` sensor (which matches `permission_prompt`/`idle_prompt` and ignores other types) is unaffected; the new types are a candidate future attention signal, not a break. The `claude plugin` CLI command set is unchanged, and the SessionStart/Stop/SubagentStop/PreCompact reinjection contract engineer/orchestrator/founder checkpoints rely on is intact. Codex `0.142.4`→`0.142.5`: a single logging bug fix (prevents full Responses WebSocket request payloads from being written to trace logs, PR #30771); the `codex features list` hook story (`plugin_hooks` `removed`, generic `hooks` stable) and the `codex plugin`/`codex plugin marketplace` command sets are unchanged. Baseline refresh only; no adoption work required. |
| 2026-07-10 | `2.1.206` | `0.144.1` | Re-observed during `runtime:doctor` baseline-freshness recovery (compat run `compat-20260710T054356Z-34315e`, content-backed ingest of the Claude Code `CHANGELOG.md` 2.1.202–2.1.206 excerpt and the Codex GitHub release notes `rust-v0.143.0`/`rust-v0.144.0`/`rust-v0.144.1`). Both drifts are additive/fix-only with no plugin-CLI or hook-contract surface break; the `plugin-runtime` `0.77.2` proof `doctor-20260710T044745Z-1a789e` (ready 100% 8/8, host_parity pass) was measured on exactly this host pair, corroborating that no adaptation is required. Claude `2.1.201`→`2.1.206`: no hook-contract change (`2.1.204` fixes SessionStart hook-event streaming in headless sessions — a delivery fix, not a payload change; `2.1.205` adds a transcript-tamper auto-mode rule and promotes `/doctor` to a full checkup; `2.1.206` adds `/cd` path suggestions and worktree-entry confirmation); `--safe-mode` and `claude agents --json --all` remain. Codex `0.142.5`→`0.144.1`: `codex plugin` and `codex plugin marketplace` verb sets unchanged; `codex features list` keeps `plugin_hooks` `removed` and generic `hooks` stable — the one stage change is `remote_plugin` under-development→stable (`0.143.0` enables remote plugins by default with npm marketplace sources; additive catalog-source surface, agentic-plugins' git-source marketplace flows unchanged); `0.144.0` adds a `writes` app-approval mode and default MCP auth elicitation; `0.144.1` is installer/code-mode reliability backports. Because the Local CLI evidence block had sat at `2.1.173`/`0.139.0`, several re-observed surfaces are new relative to that last full observation rather than to this drift interval — `claude plugin` `eval`/`init`/`new`/`tag`, `claude mcp` `login`/`logout`, Codex top-level `delete`, and the `codex plugin list --json` `{installed, available}` root with the per-entry `source` `{source, path}` object (all additive; runtime's allowlisted command set and the field-selective ADR-0034 resolver are unaffected; retained-binary evidence dates several of these to before `0.144.x`/`2.1.20x`, e.g. `delete` absent at `0.139.0` but present by `0.142.5`). Also repaired this file's internally inconsistent Local CLI evidence block, which header-only refreshes had left at `2.1.173`/`0.139.0` since 2026-06-11. Baseline refresh only; no adoption work required. |
| 2026-07-11 | `2.1.207` | `0.144.1` | Re-observed during the attention 0.4.1 relocation cascade's baseline-freshness follow-up (compat run `compat-20260711T081920Z-d8885f`, content-backed ingest of the Claude Code `CHANGELOG.md` 2.1.207 entry via explicit `--fetch-release-notes-url`). Claude `2.1.206`→`2.1.207` is fix-only with no plugin-CLI or hook-contract surface change: auto mode no longer needs the `CLAUDE_CODE_ENABLE_AUTO_MODE` opt-in on Bedrock/Vertex/Foundry (first-party auth flows unaffected; `disableAutoMode` opts out), plus streaming/TUI freezes, non-interactive remote-managed-settings consent recording, spurious prompt-injection warnings, the auto-updater overwriting a custom `~/.local/bin/claude` launcher (`/doctor` now reports an externally managed launcher), `cd`-compound permission prompts with `/dev/null` redirects, and transcript jump fixes. `claude plugin --help` and `claude mcp --help` re-checked on `2.1.207`: verb sets unchanged from the `2.1.206` observations. Codex `0.144.1` unchanged. The attention `0.4.1` install proof `doctor-20260711T045954Z-731e34` (parity `ready` `100%` 8/8, overall `pass`) was measured on exactly this host pair — its honest `host_parity_baseline` `stale` caveat is what this refresh closes. Baseline refresh only; no adoption work required. |
| 2026-07-14 | `2.1.208` | `0.144.1` | Re-observed during the attention 0.5.0 four-persona sensor cascade's baseline-freshness follow-up (compat run `compat-20260714T033123Z-85e463`, content-backed ingest of the Claude Code `CHANGELOG.md` 2.1.208 entry via explicit `--fetch-release-notes-url`). Claude `2.1.207`→`2.1.208` is additive/fix-only with no plugin-CLI or hook-contract surface change: adds an opt-in screen reader mode (`--ax-screen-reader` / `CLAUDE_AX_SCREEN_READER` / `axScreenReader`), a `vimInsertModeRemaps` setting, `CLAUDE_CODE_PROCESS_WRAPPER` (self-spawns honor a corporate launcher wrapper), and mouse-click support for fullscreen multi-select menus; fixes fast-mode restore after model switches, lost replies to background agents, and background-session attach after an updater binary swap. `claude plugin --help` and `claude mcp --help` re-checked on `2.1.208`: verb sets unchanged from the `2.1.206` observations. Codex `0.144.1` unchanged. The attention `0.5.0` install proof `doctor-20260714T021309Z-0cd852` (parity `ready` `100%` 8/8, overall `pass`) was measured on exactly this host pair — its honest `host_parity_baseline` `stale` caveat is what this refresh closes. Baseline refresh only; no adoption work required. |
| 2026-07-20 | `2.1.215` | `0.144.6` | Re-observed during the attention 0.7.0 post-release freshness recovery (compat run `compat-20260720T104815Z-9323ec`, content-backed ingest of the Claude Code `CHANGELOG.md` and the Codex GitHub releases atom feed, with `gh release view` closing the 0.144.2–0.144.5 gap the feed's alpha-heavy window dropped). Both drifts are additive/fix-only with no plugin-CLI or hook-contract surface break. Claude `2.1.208`→`2.1.215` (`2.1.213` unpublished): the hook-relevant entries are fixes — `2.1.210` fixes a hook-callback timeout misreported as user rejection, `2.1.211` floors a PreToolUse `ask` under auto mode, `2.1.212` fixes a `continue:false` hook halt dropped mid-stream and hook infrastructure errors misreported as user rejections — and `2.1.212` turns `/fork` into a copied background session (the `"fork"` SessionStart source noted by the probed matrix arrived in `2.1.214`), adds session-wide WebSearch/subagent caps, and deprecates the Task tool `mode` parameter; `2.1.214` is an extensive permission-fix release adding the EndConversation tool; `2.1.215` stops auto-invoking `/verify`/`/code-review`. The full Local CLI evidence block was re-run live on this pair: `claude plugin`/`claude mcp`/`claude agents` and all `codex plugin`/`codex plugin marketplace` verb sets unchanged. The SessionStart matrix verdict was separately re-validated live on `2.1.215` (PASS — §Claude `SessionStart` Matrix re-validation trail) and the attention `0.7.0` SessionStart entry sensor shipped against it. Codex `0.144.1`→`0.144.6` is fix/chore-only (`0.144.2` reverts a Guardian auto-review prompting regression, `0.144.3`/`0.144.4` are version-only/no-user-facing, `0.144.5` expands dangerous-command detection with clearer rejection reasons, `0.144.6` refreshes bundled GPT-5.6 model metadata/context windows); `plugin_hooks` stays `removed`, generic `hooks` stays stable, and one flag-inventory row is additive — `multi_agent_mode` now listed `removed`, no plugin/hook surface impact. Baseline refresh only; no adoption work required. |
| 2026-07-21 | `2.1.216` | `0.144.6` | Re-observed during the ADR-0047 Release A (`plugin-runtime` `0.84.0`) post-release freshness recovery (compat run `compat-20260721T105600Z-71cea8`, content-backed ingest of the Claude Code `CHANGELOG.md` via explicit `--fetch-release-notes-url`). Claude `2.1.215`→`2.1.216` is additive/fix-only with no plugin-CLI or hook-contract surface change: adds a `sandbox.filesystem.disabled` setting (skip filesystem isolation while keeping network egress control); fixes quadratic message-normalization slowdowns in long sessions, auto-mode "HTTP 401" denials after mid-session OAuth rotation, AskUserQuestion free-text wording, web-session idle re-asks, @-mention attachment after file-modifying hooks, worktree-isolated subagents escaping via `git -C`/`GIT_DIR`, stale daemon lockfiles, and assorted TUI/resume issues. `claude plugin --help` re-checked on `2.1.216`: verb set unchanged from the `2.1.206`/`2.1.215` observations. Codex `0.144.6` unchanged. This run was also the first live exercise of the ADR-0047 §5 standing notification watch shipped in `0.84.0`: the `claude-notification-agent-types` row correctly signalled on the changelog's recorded 2.1.198 `agent_needs_input`/`agent_completed` entry (a known, already-recorded gap — the row stays open by design) and the plan carried the required review step. Baseline refresh only; no adoption work required. |
| 2026-07-22 | `2.1.217` | `0.145.0` | Re-observed during the ADR-0047 Release B (`plugin-runtime` `0.85.0` / `plugin-attention` `0.9.0`) post-release freshness recovery (compat run `compat-20260722T011840Z-a3fb14`, content-backed ingest of the Claude Code `CHANGELOG.md` and the Codex GitHub releases atom feed via explicit `--fetch-release-notes-url`, both host gaps covered). Both drifts carry no plugin-CLI or hook-contract surface change. Claude `2.1.216`→`2.1.217` is additive/fix-only: the notable entries are host subagent-orchestration knobs — a cap on concurrently-running subagents (default 20, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), subagents no longer spawning nested subagents by default (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), and `--max-budget-usd` now halting background subagents — which do not touch the companion-based peer invocation runtime/engineer/orchestrator use (a separate `codex`/`claude` process, not a host subagent); no `Notification` hook type changed (the ADR-0040 §3 attention sensor still matches `permission_prompt`/`idle_prompt`), the SessionStart/Stop/SubagentStop reinjection contract is intact, and `claude plugin --help` re-checked live with the verb set unchanged. Codex `0.144.6`→`0.145.0` is a minor bump with no plugin-CLI or hook-contract break: `codex plugin`/`codex plugin marketplace` verb sets unchanged, `codex features list` keeps `plugin_hooks` `removed` and generic `hooks` `stable`, and the two stage changes are flag-inventory/internal — `multi_agent_v2` under-development→stable (the changelog's opt-in multi-agent V2 stabilization, `enabled=false`) and `enable_fanout` under-development→removed. The remaining 0.145.0 surface (paginated thread history, `/import` migration of Cursor/Claude Code settings/plugins/sessions, experimental Amazon Bedrock login + GPT-5.6 Sol default, audio inputs + realtime V3, GPT-5.4→GPT-5.6 Terra/Luna migration, and a Windows "correctly quoted hook commands" fix) is host-native feature work that does not change the companion/hook/plugin contract runtime depends on. Baseline refresh only; no adoption work required. |
| 2026-07-23 | `2.1.218` | `0.145.0` | Re-observed during the ADR-0048 (`plugin-runtime` `0.86.0` bootstrap-observability) post-release freshness recovery (compat run `compat-20260723T124245Z-8aabdc`, content-backed ingest of the Claude Code `CHANGELOG.md` via explicit `--fetch-release-notes-url`). Claude `2.1.217`→`2.1.218` is additive/fix-only with no plugin-CLI or hook-contract surface change: `/code-review` now runs as a background subagent, screen-reader announcements for word/line deletions in `--ax-screen-reader` mode, a fix for Windows `\u`-prefixed path segments being corrupted into CJK characters, a left-arrow conversation-discard confirmation, HTTP status/error detail in `claude mcp list` + `/mcp` connection failures plus an MCP config whitespace warning, multi-line paste and `/context` post-compact fixes, and `/ultrareview` / `/code-review ultra` argument/non-interactive fixes — host UX work; no `Notification` hook type changed, the SessionStart/Stop/SubagentStop reinjection contract is intact, and `claude plugin --help` re-checked live with the verb set unchanged. Codex `0.145.0` unchanged (version match, no release-note requirement). Baseline refresh only; no adoption work required. |
| 2026-07-25 | `2.1.220` | `0.145.0` | Re-observed during the `plugin-runtime` `0.86.1` (egress-ack intent WAL) post-release freshness recovery (compat run `compat-20260725T015749Z-387259`, content-backed ingest of the Claude Code changelog via explicit `--fetch-release-notes-url`). Claude `2.1.218`→`2.1.220` spans one substantial and one trivial release. `2.1.219` is the substantial one and it **does touch the hook surface**: it adds a `DirectoryAdded` event fired after `/add-dir` or the SDK `register_repo_root` control request registers a working directory mid-session — recorded in the Hooks row above as additive, since no existing event's payload or decision contract changed and runtime registers no handler for it. Its other entries are host-native feature work that does not reach the companion/hook/plugin contract: Claude Opus 5 (`claude-opus-5`) becomes the default Opus model (1M context; runtime keeps host-default model/effort resolution, so no runtime change), a `sandbox.network.strictAllowlist` setting, `mcp_server_errors` in the headless stream-json init event, a `workflowSizeGuideline` settings key, nested subagent forwarding in stream-json, and — relevant to read but not to adopt — default nested subagent spawn depth raised from 1 to 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` disables), which concerns host subagents and not the separate `codex`/`claude` process the companion contract spawns. `2.1.220` is "bug fixes and reliability improvements" only. `claude plugin --help` re-checked live on `2.1.220`: the verb set (`details disable enable eval help init|new install|i list marketplace prune|autoremove tag uninstall|remove update validate`) is unchanged from the `2.1.206` observation this file already records. Codex `0.145.0` unchanged (version match, no release-note requirement). Baseline refresh only; no adoption work required. |
| 2026-08-08 | `2.1.226` | `0.147.0` | Re-observed during the `plugin-runtime` `0.89.0` post-release freshness recovery (compat run `compat-20260808T064210Z-a414ba`, content-backed ingest of the Claude Code `CHANGELOG.md` and the Codex GitHub releases atom feed via explicit `--fetch-release-notes-url`, with `gh release view` closing the `0.146.0`/`0.146.1` gap the alpha-heavy feed window dropped). The full Local CLI evidence block was re-run live on this pair and **every verb set on both hosts is unchanged**. Claude `2.1.220`→`2.1.226` is additive/fix-only for the contracts runtime depends on: the SessionStart/Stop/SubagentStop/PreCompact reinjection contract is intact and the only hook-touching entry is a security fix (`2.1.222` stops PreToolUse auto-allow hooks bypassing tool restrictions in background agent tasks); `2.1.223` is a permission-hardening release (a Bash permission bypass, tab/invisible-Unicode padding hiding part of a command from the approval dialog, workflow scripts escaping their sandbox via dynamic `import()`, and an agent definition's `bypassPermissions` ignoring org policy) plus `owner/*` wildcards in the `strictKnownMarketplaces`/`blockedMarketplaces` managed settings; `2.1.224` adds an `archive` plugin source (install from a zip over HTTPS with optional SHA-256 pinning) and fixes plugin install records corrupting when one plugin is installed in multiple projects; `2.1.221` changes `/plugin install` to refresh a stale catalog and retry, activates plugins immediately when safe, and accepts `"."` as a `skills` path. **Codex `0.145.0`→`0.147.0` is the exception to the four preceding rows: it is not additive-with-no-adoption-work.** `0.146.0` added Agent Plugins manifest support, workspace plugin publishing, and additional plugin marketplaces; `0.147.0` added portable Agent Plugin install with search across local/personal/workspace/remote catalogs, and removed the deprecated `codex exec --full-auto` (no agentic-plugins caller used it — `codex-companion.mjs` builds `exec --skip-git-repo-check --ephemeral`, and the live deep-peer smoke passed both directions on `0.147.0`). Concretely, the binary's manifest candidate list is now the triple `.codex-plugin/plugin.json` / `.claude-plugin/plugin.json` / `.cursor-plugin/plugin.json`, the marketplace candidate list likewise spans `.agents/plugins/marketplace.json`, `.claude-plugin/marketplace.json`, and `.cursor-plugin/marketplace.json`, and a `core-plugins/src/command_migration.rs` path can render a Claude-shaped `commands/` directory into skills. Two consequences were measured, not assumed, and both are recorded in the ADR-0013 Trigger Watch amendment above: the trigger still does **not** fire (the migration path is absent from both the Agent Plugins standard and the official plugin docs, and no `migrated-command-skills` artifact materializes for our plugins because their `.codex-plugin` manifest wins the candidate list), and the ADR-0040 §3 zero-Codex-hook-surface invariant for `plugins/attention` survives the `.claude-plugin` ingestion (the `0.147.0` doctor proof reports `bundled=designer,engineer,founder,orchestrator`, attention absent). Flag inventory adds a `recommended_plugins` `stable`/false row; `plugin_hooks` stays `removed` and generic `hooks` stays `stable`. Adoption work required: none yet — the Agent Plugins standard is a watch item, not a migration this release forces. |
| 2026-08-11 | `2.1.227` | `0.147.0` | Re-observed during the first host drift after [ADR-0051](../../../docs/adr/0051-host-parity-baseline-source.md) made the packaged copy the sole runtime authority — so this is the first refresh that carries a release obligation rather than being a docs-only edit (compat run `compat-20260811T035848Z-d6c3df`, content-backed ingest of the Claude Code `CHANGELOG.md` via explicit `--fetch-release-notes-url`). Claude `2.1.226`→`2.1.227` is fix/UX/perf-only with no plugin-CLI, hook, subagent, or notification-contract surface change; its five entries are a feature-flag evaluation fix (flags were evaluated without the user's subscription tier when a session started with an expired login token, wrongly prompting Max users to enable Fable usage credits), a `claude-code-action` fix (every Bash command failed under `allowed_non_write_users` on GitHub-hosted runners), a `/tui` fix (it restored a conversation that had been rewound to before its first message), slash-command menu styling (selection-only highlight, bolded matches, glyph-preserving emoji/accented names), and event-loop stall reductions on file-not-found suggestions and at-mention size checks. The SessionStart/Stop/SubagentStop/PreCompact reinjection contract the engineer/orchestrator/founder/designer checkpoints rely on is intact, and `claude --version`, `claude --help`, `claude plugin --help`, `claude agents --help`, and `claude mcp --help` were re-checked live on `2.1.227` with every verb set unchanged from the 2026-08-08 full re-run (`--safe-mode` still present). Codex `0.147.0` unchanged (version match, no release-note requirement), so all Codex surfaces — including the `codex features list` story (`plugin_hooks` `removed`, generic `hooks` `stable`, `recommended_plugins` `stable`/false) and the Agent Plugins ingestion consequences recorded in the row above — stand from that same re-run. The ADR-0047 §5 standing notification watch signalled `claude-notification-agent-types` on the ingested notes, but the signal resolves to the already-recorded `2.1.198` `agent_needs_input`/`agent_completed` entry surfaced by whole-file changelog ingest, not to a new `2.1.227` payload; the row stays open by design, exactly as on the 2026-07-21 refresh. Baseline refresh only; no adoption work required — but per ADR-0051 §Decision 2 this content change obliges a `plugin-runtime` release, so unlike the `docs:`-typed counterexample `16b1833` that moved the baseline without a bump, this change lands under a bump-triggering `fix(plugin/runtime): …` PR title. |
| 2026-08-16 | `2.1.233` | `0.147.0` | Re-observed during the named baseline follow-up the owner opened when amending the 0.90.2 recovery's stop clause (compat run `compat-20260816T092409Z-9297c1`, content-backed ingest of the Claude Code `CHANGELOG.md` via explicit `--fetch-release-notes-url`; `claude --version`, `claude --help`, `claude plugin --help`, `claude agents --help`, and `claude mcp --help` re-run live, every verb set unchanged and `--safe-mode` still present). **This loop's own start condition fired.** It was planned against `2.1.232`, and the start-of-work re-measure found `2.1.233` — so the target moved before the first edit, exactly the failure mode [ADR-0052](../../../docs/adr/0052-release-obligation-enforcement.md) measured. That fact was recorded as evidence and the judgment handed to the owner, who chose to retarget this refresh at `2.1.233` and to open a separate follow-up (macro subtask ST9) for the structural question, rather than to keep or widen this loop's scope. Retargeting was not merely tidier: **`2.1.233` reverted two of `2.1.232`'s permission changes** (Bash input redirections `< file`, and Windows Cygwin-style symlink writes) after they regressed ordinary `cd <dir> && <command> > file` approvals, so a baseline landed on the originally planned `2.1.232` would have recorded two behaviors that no longer exist — recorded in the Permissions and sandbox row above. Claude `2.1.227`→`2.1.233` spans five published releases. Measured from npm publish times, the intervals are `2.1.228` +20.8h, `2.1.229` +25.7h, `2.1.231` +13.0h, `2.1.232` +13.1h, `2.1.233` +21.3h; `2.1.230` has no published changelog entry and no npm publish time, so it is genuinely unpublished rather than merely undocumented. `2.1.233` landed 2026-08-14T18:50Z, which made the quiet interval at this observation ≈42.8h — longer than every interval inside the window, and the reason this loop had a better chance of landing `current` than the two before it. **Unlike the six preceding rows, adoption work *is* required**, and it is self-inflicted rather than a host break: `2.1.233` withdrew the todo/task-tracking tools (`TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList`, `TodoWrite`) from Opus 4.8, Sonnet 5, Fable 5, Mythos 5, and newer models behind an opt-in `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, while twenty Claude command runbooks across `designer`, `engineer`, `founder`, and `orchestrator` still opened with "Use `TaskCreate` and `TaskUpdate` to track progress" — an instruction to call tools absent from the session's own tool list, observed directly on this host/model pair while running `/orchestrator:next`. Those runbooks were rewritten to phrase progress tracking as intent with the host tool as an optional means. The Codex skill mirrors never carried the instruction and are unchanged, but calling the dependency "Claude-only" would overstate it twice over: Codex lacks those five tool *names* (measured zero against a working control in the `0.147.0` binary) while carrying its own `update_plan` tracker, and `plugins/orchestrator/skills/next/SKILL.md` makes the Claude command markdown Codex's behavioral source, so the instruction could reach a Codex session indirectly. The remaining window is additive/fix-only for the contracts runtime depends on: the SessionStart/Stop/SubagentStop/PreCompact reinjection contract is intact, and the two hook-touching entries are `2.1.229`'s additive server-supplied hooks for self-hosted runner sessions and `2.1.233`'s **delivery** fix for `Notification` hooks not firing on permission prompts under Claude Desktop and VS Code. The ADR-0047 §5 standing `claude-notification-agent-types` watch row stays open by design, signalling as usual on the whole-file changelog ingest's `2.1.198` entry rather than on anything new. What the source does **not** establish is payload compatibility on the newly-reached hosts, and the Hooks row now says so rather than inferring it from silence — the attention sensor branches on `notification_type`, so that gap is recorded as unverified pending a probe. Three plugin-management entries touch flows this repository runs (`2.1.228`'s symlinked-development-checkout cache-cleanup fix, which lands on the very control case ADR-0051's P2 hardening pinned; `2.1.229`'s stray-liveness-file fix; `2.1.232`'s `/plugin install` marketplace-refresh-first, which is scoped to the interactive slash command and therefore does **not** remove the manual `claude plugin marketplace update` step from this repository's non-slash recovery ritual), and the new marketplace sources (`command`, GitLab) plus the `additionalMarketplaces`/`allowedMarketplaces` aliases are additive. `2.1.232` turned subagent forking and background agent spawns on by default; that one is **not** disposed of by the companion-spawns-a-process argument, because `plugins/engineer` also spawns native Claude subagents through the `Agent` tool, and result collection under the new default is unprobed — recorded in the Subagent trigger model row as an open question. The cross-session `@`/`SendMessage` channel and the GitLab merge-request `--worktree` support are additive and recorded in the team-mode and Worktrees rows. Codex unchanged at `0.147.0` (version match, no release-note requirement), spot-re-verified on `codex plugin --help` and `codex features list` (`plugin_hooks` `removed`, generic `hooks` `stable`, `recommended_plugins` `stable`/false, still no `plugin_commands` row) — so the ADR-0013 trigger remains **NOT FIRED** and every other Codex surface stands from the 2026-08-08 full re-run. Per ADR-0051 §Decision 2 this content change obliges a `plugin-runtime` release and lands under a bump-triggering `fix(plugin/runtime): …` PR title. |
