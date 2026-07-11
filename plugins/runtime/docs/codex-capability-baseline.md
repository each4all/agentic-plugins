# Codex Capability Baseline

Observed on 2026-07-10 with Codex CLI `0.144.1` plus official OpenAI
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

(2026-07-10: the `developers.openai.com/codex/*` URLs above now respond with
308 permanent redirects to `learn.chatgpt.com/docs/*`; the old URLs remain
functional. A coordinated URL migration across both baseline docs and their
test tokens is deliberately deferred to a follow-up.)

Local CLI evidence (re-observed 2026-07-10 on `0.144.1`):

- `codex --version` -> `codex-cli 0.144.1`
- `codex --help` (0.144.1 top-level surface: `exec`, `review`, `login`/`logout`,
  `mcp`, `plugin`, `mcp-server`, `app-server`, `remote-control`, `app`,
  `completion`, `update`, `doctor`, `sandbox`, `debug`, `apply`, `resume`,
  `archive`/`delete`/`unarchive`, `fork`, `cloud`, `exec-server`, `features`;
  `delete` is additive since the 0.139.0 observation — retained-binary evidence
  dates it to ≤0.142.5; the `doctor`/`update`/`login`/`logout`/`archive`
  additions date to 0.137.0)
- `codex exec --help` (non-interactive run surface unchanged)
- `codex hooks --help` (re-observed on 0.144.1 to still fall back to top-level
  help; no `hooks` subcommand is listed)
- `~/.codex/config.toml` `[hooks.state."<plugin>@<marketplace>:<hooks-path>:<event>:0:0"]`
  (observed on 0.142.5, 2026-07-09): a hook the operator trusts through `/hooks`
  is written as a `trusted_hash` line and **no `enabled` key** — absence means
  **enabled**. The 0.142.5 `/hooks` view rendered `Event` / `Matcher` / `Source` /
  `Command` / `Timeout` / `Trust` with no enable/disable toggle observed;
  current official hooks docs (re-checked 2026-07-10) additionally say `/hooks`
  can "disable individual non-managed hooks", so a per-hook disable path
  exists — the observed disable serialization remains an explicit
  `enabled = false`, and an absent key still means enabled. `enabled = true`
  appears only in configs written by an earlier Codex. Verified by behavior,
  not inference: `designer`'s `Stop` hook — whose entry carried a
  `trusted_hash` and no `enabled` key — executed during a `codex exec` turn and
  archived a terminal designer workflow. (Shape re-checked on 0.144.1: the
  mixed population persists — legacy rows with `enabled = true` and
  newer trusted rows with `trusted_hash` only coexist in the same config;
  a config-file parse proves serialization shapes, not the full set of states
  the current `/hooks` UI can write.)
  Two further `[hooks.state]` observations (0.144.1, 2026-07-10):
  - **Materialized event vocabulary**: the entries observed across all
    agentic-plugins hook-bearing plugins use exactly `session_start`,
    `pre_compact`, `stop`, and `subagent_stop`. A hooks-file event Codex does
    not recognize — Claude's `Notification` — produced **no** state entry at
    all (attention's file declares Notification/Stop/SubagentStop; only
    `stop` and `subagent_stop` materialized). `runtime:doctor` mirrors this
    vocabulary (`CODEX_HOOK_STATE_EVENTS`) so an event the host can never
    materialize surfaces as `unmapped`, not as a permanently-`missing`
    expectation; an event actually observed in `[hooks.state]` is always
    expected regardless of the mirror, so a future Codex that starts
    materializing new events self-heals.
  - **Default-file discovery is command-shape-blind**: attention declares no
    `hooks` in `.codex-plugin/plugin.json` and all its hook commands target
    `adapters/claude/hooks/…`, yet Codex discovered `hooks/hooks.json`,
    surfaced the mappable events in `/hooks`, and recorded the operator's
    trust (`trusted_hash` entries observed for `stop`/`subagent_stop`).
    Non-declaration does **not** keep a default-location hooks file out of
    the Codex review/trust surface — which is why `runtime:doctor` counts
    deliberately-Claude-only bundlers in its expected Codex hook sets.
    *Posture resolution (2026-07-11, source mechanism corrected — the
    observation above is preserved verbatim as the evidence that forced
    it):* the attention package relocated its Claude registration to a
    `.claude-plugin/plugin.json`-declared `adapters/claude/hooks/hooks.json`
    and removed the root default file, so the relocated package supplies
    neither discovery input (effective for a given machine once the
    released version is installed there). **Release/install proof is PENDING**: `/hooks` showing
    zero attention targets on the upgraded install is the *expected*
    outcome, not yet an observation, and whether the two stale
    pre-relocation `[hooks.state]` trust rows persist (display-only
    `unexpected_agentic_entries`) or get pruned by a host operation remains
    to be observed — runtime itself never mutates them either way.
- `codex plugin --help` (0.144.1: `add`, `list`, `marketplace`, `remove` —
  command set unchanged from 0.137.0)
- `codex plugin add --help` (installs `PLUGIN[@MARKETPLACE]` from a configured
  marketplace snapshot; `--marketplace` selects the source; 0.138.0 added
  `--json`)
- `codex plugin list --help` (lists plugins from configured marketplace
  snapshots; `--json` supported plus a `-m`/`--marketplace` filter and
  `--available`; 0.138.0 added a `marketplaceSource` `{sourceType, source}`
  field to source-backed JSON entries — not all entries carry it — and 0.139.0
  can serve available-plugin lists from the cached remote catalog before a
  background refresh; on 0.144.1 the `--json` root is `{installed, available}`
  and installed entries additionally carry a `source` `{source, path}` object —
  additive relative to the field-selective ADR-0034 resolver)
- `codex plugin remove --help` (removes an installed plugin from local config
  and cache; 0.138.0 added `--json`)
- `codex plugin marketplace --help` (0.144.1: `add`, `list`, `upgrade`,
  `remove` — unchanged from 0.137.0; `marketplace list --json` includes the
  marketplace source for source-backed marketplaces as of 0.139.0, not every
  entry)
- `codex debug --help`
- `codex mcp --help` (0.144.1: `list`, `get`, `add`, `remove`, `login`,
  `logout` — the MCP OAuth `login`/`logout` verbs were previously unrecorded
  in this file's evidence; retained-binary checks show them present at least
  since 0.139.0, so this records an omission repair, not a new surface)
- `codex features list` (0.144.1: `plugin_hooks` removed, generic `hooks`
  stable, `plugins`/`plugin_sharing`/`multi_agent` stable — unchanged from
  0.137.0; `enable_fanout` and `multi_agent_v2` remain under development;
  `remote_plugin` moved from under-development to **stable/true** — 0.143.0
  enabled remote plugins by default with npm marketplace sources, an additive
  catalog-source surface next to git/local marketplaces)

## Confirmed Codex Surfaces

| Surface | Baseline | Runtime implication |
|---------|----------|---------------------|
| Local CLI | Codex CLI is the local terminal coding agent. Local help on `0.144.1` exposes `exec`, `review`, `mcp`, `plugin`, `sandbox`, `resume`, `fork`, `cloud`, `features`, `doctor`, `update`, `app`, `delete`, and related commands, plus experimental `app-server`/`remote-control`/`exec-server`. | Runtime may diagnose local CLI availability and command shape, but should keep version and feature observations explicit because this surface changes quickly. |
| `AGENTS.md` | Codex loads instruction files before work, layering user and project guidance. Project `.codex/` layers load only for trusted projects. | Repo guidance in `AGENTS.md` remains the canonical Codex host instruction path. Runtime should not replace it with generated host config. |
| Skills | Skills are the reusable workflow authoring format. `SKILL.md` is the required skill entry point, and plugins are the distribution unit for reusable skills and apps. | Codex-facing runtime commands stay packaged as skills under `plugins/runtime/skills/`. Runtime docs should mention `$runtime:*` skill invocation rather than Claude slash-command parity. |
| Plugins and marketplaces | `.codex-plugin/plugin.json` is the required plugin manifest. A repo-scoped marketplace lives at `$REPO_ROOT/.agents/plugins/marketplace.json`; Codex can also read personal and Claude-style marketplace locations. | Keep `.codex-plugin/plugin.json` plus `.agents/plugins/marketplace.json` as the Codex distribution surface. Do not invent a second Codex install manifest. |
| Local plugin command shape | In CLI `0.144.1` (command set unchanged since `0.137.0`), `codex plugin` exposes `add`, `list`, `marketplace`, and `remove`; `codex plugin marketplace` exposes `add`, `list`, `upgrade`, and `remove`. Per-plugin `add` (install from a configured marketplace snapshot), `list`, and `remove` arrived in `0.137.0` beyond the prior marketplace-only surface; `0.138.0` added `--json` to `add`/`remove` and the marketplace commands plus a `marketplaceSource` field on source-backed `list --json` entries (not universal); `0.139.0` can serve available-plugin lists from the cached remote catalog before a background refresh; `0.143.0` enabled remote plugins (`remote_plugin` stable) with npm marketplace sources — additive catalog sources next to git/local marketplaces. There is still no per-plugin `update`, `enable`, `disable`, `details`, `validate`, or `prune`. | The CLI is no longer marketplace-only — it has per-plugin `add`/`list`/`remove`. Runtime `doctor`/`settings` recognize this surface as `per-plugin-and-marketplace` (ADR-0032), and `doctor` reads Codex installed-state host-natively from `codex plugin list --json` (read-only, list-authoritative-then-cache; ADR-0034) — the `0.138.0`+ additive JSON fields (including 0.144.1's `{installed, available}` root, per-entry `source` object, and remote-plugin rows) are ignored by that field-selective resolver (re-verified on `0.144.1`). `runtime:settings --execute-plugin-management` can execute `codex plugin add <plugin>@agentic-plugins` as a policy-gated H2 executor (ADR-0035 §5; see `follow-ups.md`); the cached-first available-list behavior makes the executor's read-only `--available` pre-flight potentially cache-aged, which is acceptable for a pre-flight but must not be re-labeled as source truth. Do not claim full Claude-style parity (`update`/`enable`/`disable`/`details`/`validate`/`prune` are still absent). |
| MCP | Codex supports MCP in the CLI and IDE extension. MCP configuration is stored with other Codex config in `config.toml`, and `codex mcp` manages server entries. | Runtime may diagnose MCP availability and config paths. Runtime must not auto-add MCP servers outside an explicit future executor. |
| Subagents | Codex subagent workflows are enabled by default, but Codex only spawns subagents when explicitly asked. Custom agents live under `~/.codex/agents/` or `.codex/agents/`, and subagents inherit the current sandbox policy. | Runtime consensus can model manual/subagent lanes, but automatic hidden fanout remains out of bounds. Any Codex subagent use must be an explicit operator or user action. |
| Hooks | Codex hooks are a documented lifecycle extension. The `plugin_hooks` feature flag was **removed** in ~0.134.0 (PR #22552): `codex features list` on 0.144.1 still reports `plugin_hooks` as `removed` and generic `hooks` as `stable`. Plugin-bundled hooks are no longer gated by a separate flag — they load when the plugin is enabled and generic `[features].hooks` (default on) is set, declared via a `.codex-plugin/plugin.json` `hooks` entry or the default `hooks/hooks.json`, subject to `/hooks` review+trust. Plugin hook commands receive `PLUGIN_ROOT`/`PLUGIN_DATA`, and Codex still sets `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` for compatibility with existing plugin hooks. Local non-interactive help does not expose a `codex hooks` trust/query command. | Runtime should keep generic hooks, plugin enablement, manifest hook exposure, hook command portability, and hook trust/review as separate readiness facts. Do not treat plugin-bundled hooks as runtime-ready based only on generic hook support or `/hooks` `Installed` counts; `Active=0` output and `Trust: New hook - review required` are not enough to attest. Because `plugin_hooks` is removed, the former `--apply-codex-plugin-hooks` write (`[features].plugin_hooks = true`) and `codex --enable plugin_hooks` targeted a dead flag on 0.137.0; that settings write executor and the doctor `enable-codex-plugin-hooks` recommendation were removed per ADR-0035 §6, and runtime `settings`/`doctor` now report the `[features].hooks` + plugin-enablement + `/hooks` trust model read-only. `CLAUDE_PLUGIN_ROOT` in a Codex-exposed command is compatibility telemetry, not a warning by itself; a Claude adapter hook path remains a portability warning. Bare `node` hook commands are also portability warnings because a hook runner may not inherit a login-shell PATH. After the operator reviews/trusts hooks with `/hooks`, `runtime:settings --attest-codex-hook-review` may record a sanitized artifact for doctor to consume; it does not mutate or independently prove Codex trust state. **Hook-state `enabled` semantics**: in `[hooks.state."…"]`, an absent `enabled` key means ENABLED — it is what a current Codex writes on trust. Official docs describe a per-hook disable for non-managed hooks via `/hooks`; the observed disable serialization is an explicit `enabled = false`, so only an explicit `enabled = false` is a disable. Runtime must not read absence as disabled: doing so reported every hook trusted by a current Codex as disabled, and the attestation gate refuses while any expected entry is disabled, so no newly-installed hook-bearing plugin could ever be attested (observed when `designer` became the first such plugin after the ADR-0035 §6 writer removal). |
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
  CLI state. In local CLI `0.144.1`, `/hooks` is an active-session UI command:
  top-level help does not list a `hooks` subcommand, and `codex plugin
  marketplace` exposes add/list/upgrade/remove with no hook trust query.
  (`~/.codex/config.toml` no longer exposes a `plugin_hooks` enablement flag;
  its `[hooks.state]` `trusted_hash` rows are Codex-internal trust bookkeeping,
  not a supported query surface.) Treat `/hooks` `Installed` counts as packaging evidence only;
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
