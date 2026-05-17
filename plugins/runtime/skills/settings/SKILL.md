---
name: settings
description: "Dry-run runtime settings planner for agentic-plugins. Use when the user wants to inspect marketplace/plugin/CLI readiness, plan repo-local or user-global model/effort defaults, explicitly execute allowlisted plugin install/update commands, explicitly clean up retired agentic-plugins Claude plugins, explicitly enable Codex plugin_hooks, or record a Codex /hooks review attestation. Mutates only agentic-plugins-owned config when --apply is explicit; writes Codex plugin_hooks only when --apply-codex-plugin-hooks is explicit; runs plugin management only when --execute-plugin-management is explicit; runs retired plugin cleanup only when --execute-plugin-cleanup is explicit; records hook-review attestation only when --attest-codex-hook-review is explicit."
---

# Settings (runtime framework primitive)

`runtime:settings` is the ADR-0024 operator settings surface. It plans host/plugin setup and agentic-plugins config changes. Dry-run is the default.

## When invoked by command (`/runtime:settings` or `$runtime:settings`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/settings.mjs" --repo-root "$REPO_ROOT" [--format text|json] [--target repo|user|both] [--model <id>] [--effort <level>] [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>] [--apply] [--apply-codex-plugin-hooks] [--attest-codex-hook-review] [--execute-plugin-management] [--execute-plugin-cleanup] [--plugin-management-host all|claude|codex] [--run-id <settings-run-id>]
```

3. Present the result as a settings plan, not as proof of host parity.
   - Dry-run output is the default and must be safe to run repeatedly.
   - `--apply` may write only `.agentic-plugins/config.toml` in the repo and/or user home.
   - `--execute-plugin-management` runs only allowlisted host-native plugin install/update/add/upgrade commands. It preflights the relevant host plugin command surface first, uses Claude's non-slash `claude plugin install/update` CLI when available, blocks unavailable CLI surfaces before execution, does not use a shell, does not print raw stdout/stderr, writes sanitized execution artifacts under `.agentic-plugins/runs/settings/<run-id>/`, and treats host "plugin surface unavailable" output as failed even when the host exits 0.
   - `--execute-plugin-cleanup` runs only `claude plugin uninstall <plugin>@agentic-plugins` commands generated from `runtime:doctor` retired/unknown `agentic-plugins` findings. It blocks unavailable Claude plugin surfaces, does not use a shell, does not print raw stdout/stderr, writes sanitized execution artifacts, and does not authorize general plugin uninstall.
   - Codex bundled plugin hooks are planned separately: report packaged hook plugins, `plugin_hooks` status, `~/.codex/config.toml` `[hooks.state]` enabled/disabled state for expected bundled hooks, the session/config steps needed to enable plugin hooks, and the `/hooks` manual follow-up when active-session review/trust cannot be verified. `--apply-codex-plugin-hooks` may write only `~/.codex/config.toml` `[features].plugin_hooks = true`. After the operator reviews/trusts hooks in Codex with `/hooks`, `--attest-codex-hook-review` records a sanitized settings artifact that doctor can use while the hook-bearing plugin set and source versions still match and expected bundled hook state is not explicitly disabled.

## Scope

Settings reports and plans:

- agentic-plugins marketplace registration for `companions`, `engineer`, `orchestrator`, and `runtime`.
- Known Claude/Codex plugin install/cache state for those plugins.
- Codex temporary marketplace cache state, reported separately from per-plugin
  install cache evidence.
- `claude` and `codex` CLI availability and versions.
- Non-executable host-CLI install plans when Claude Code or Codex CLI is
  unavailable. Settings reports host-native installation guidance but never
  installs the host CLIs itself.
- Repo-local `.agentic-plugins/config.toml` model/effort defaults.
- User-global `~/.agentic-plugins/config.toml` model/effort defaults.
- Direction-specific companion defaults:
  - `claude_model` / `claude_effort` for Codex -> Claude.
  - `codex_model` / `codex_effort` for Claude -> Codex.
- Effective projected companion defaults after repo-local and user-global
  precedence. Warn when a lower-precedence write would not actually affect
  companion invocation.
- Dry-run plugin management plans and, behind `--execute-plugin-management`,
  execution metadata, retry classification, and durable sanitized artifacts for
  allowlisted Claude/Codex plugin install/update commands.
- Dry-run retired/unknown plugin cleanup plans and, behind
  `--execute-plugin-cleanup`, execution metadata, retry classification, and
  durable sanitized artifacts for doctor-detected `agentic-plugins` Claude
  plugin cleanup commands.
- Dry-run Codex plugin hook enablement plans and, behind
  `--apply-codex-plugin-hooks`, the narrow user config write for
  `~/.codex/config.toml` `[features].plugin_hooks = true`.
- Manual Codex `/hooks` follow-up when bundled plugin hooks are packaged and
  `plugin_hooks` is enabled but settings cannot verify active-session hook
  review/trust state. Include the review target checklist: plugin version,
  hook file path, events, handler count, hook commands, and portability
  warnings. Include expected bundled hook entries from `~/.codex/config.toml`
  `[hooks.state]` that are explicitly disabled. Treat `/hooks` `Installed`
  counts as packaging evidence only; `Active=0` output, disabled hook state,
  and `Trust: New hook - review required` are not enough to attest. Carry
  doctor warnings for Codex-exposed commands that still point at Claude adapter
  paths or rely on a bare `node` command that may not exist in the hook runner
  PATH. Codex plugin hooks also expose
  `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` as compatibility aliases, though
  `PLUGIN_ROOT`/`PLUGIN_DATA` are preferred for new Codex commands.
- Codex `/hooks` operator attestation, behind `--attest-codex-hook-review`,
  recorded only as a settings artifact. This is not host-native proof and does
  not mutate Codex trust state. Attestation is blocked while expected bundled
  hook entries remain explicitly disabled in Codex hook state.

## Apply Boundary

Config apply mode is explicit-only:

```bash
$runtime:settings --model gpt-5.4 --effort high --apply
```

Allowed writes:

- `<repo>/.agentic-plugins/config.toml`
- `~/.agentic-plugins/config.toml`

Plugin management execution is a separate explicit boundary:

```bash
$runtime:settings --execute-plugin-management --plugin-management-host codex
```

Allowed plugin-management commands:

- Claude plugin install/update commands generated by settings recommendations.
- Codex marketplace add/upgrade commands generated by settings recommendations.

Retired/unknown plugin cleanup execution is a separate explicit boundary:

```bash
$runtime:settings --execute-plugin-cleanup
```

Allowed plugin-cleanup commands:

- Claude plugin uninstall commands for retired/unknown `agentic-plugins`
  entries generated from `runtime:doctor` host-parity findings.

Codex plugin hook persistence is another explicit boundary:

```bash
$runtime:settings --apply-codex-plugin-hooks
```

Allowed Codex host config write:

- `~/.codex/config.toml` `[features].plugin_hooks = true`

This does not trust hooks, change sandbox/approval/auth settings, or enable any
other Codex feature. Start a fresh Codex session or use the reported session
command, then review/trust hooks with `/hooks`; when plugin hooks are already
ready, settings reports that `/hooks` step in `Manual Follow-ups`.

Codex hook review attestation is explicit and artifact-only:

```bash
$runtime:settings --attest-codex-hook-review
```

Run it only after the active Codex session has opened `/hooks` and the operator
has reviewed/trusted every listed bundled agentic-plugins hook review target.
It records the current hook-bearing plugin set, source versions, and review
target checklist so `runtime:doctor` can clear the manual follow-up until those
change.

If Codex already has a current temporary marketplace cache but no per-plugin
install cache, report that as manual cache materialization. The observed Codex
plugin command surface is marketplace-only (`add` / `upgrade` / `remove`), so
do not keep retrying `codex plugin marketplace add` and do not invent a
per-plugin `codex plugin install` step.

The executors record only status, exit code, byte counts, timing, and sanitized
error metadata. They omit raw stdout and stderr. A host command that exits 0 can
still be marked failed if its sanitized output indicates the plugin command
surface was unavailable. If the Claude `claude plugin ...` CLI surface is
unavailable before execution, retired Claude plugin cleanup remains unhandled, or
Codex packaged hooks need active-session review/trust, settings emits a manual
follow-up checklist with the host-native `claude plugin ...` or `/hooks`
commands to run from the relevant host session. A failed slash `/plugin` probe
is reported as host asymmetry but does not block execution when the non-slash
Claude plugin CLI is available.
Executed settings runs write
`.agentic-plugins/runs/settings/<run-id>/settings.json` and update
`.agentic-plugins/runs/settings/latest.json`; `runtime:doctor` reads the latest
artifact and reports failed action types plus retryability.

Forbidden writes:

- Host-native Claude Code config.
- Host-native Codex CLI config outside `[features].plugin_hooks`.
- Authentication state or secrets.
- Sandbox or permission relaxation.
- General plugin uninstall execution outside doctor-detected retired/unknown
  `agentic-plugins` cleanup.

## Out of Scope

- No dynamic peer consensus loop.
- No context hygiene mutation.
- No automatic completion footer mutation. The footer helper is read-only and advisory.
- No deep peer smoke or sandbox permission proof.
- No broad host-native config apply mode, authentication automation,
  sandbox/permission relaxation, or general plugin uninstall execution.
