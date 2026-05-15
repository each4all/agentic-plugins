---
description: Dry-run runtime settings planner for agentic-plugins config, host/plugin readiness, companion model/effort defaults, Codex plugin_hooks, and explicit plugin-management execution artifacts
argument-hint: "[--format text|json] [--target repo|user|both] [--model <id>] [--effort <level>] [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>] [--apply] [--apply-codex-plugin-hooks] [--execute-plugin-management] [--plugin-management-host all|claude|codex] [--run-id <settings-run-id>]"
---

# Runtime - Settings

$ARGUMENTS

Run the runtime settings planner. It is dry-run by default. Config mutation is allowed only with `--apply`, and apply mode writes only agentic-plugins-owned config files:

- `<repo>/.agentic-plugins/config.toml`
- `~/.agentic-plugins/config.toml`

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/settings.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS
```

Notes:

- `--model` and `--effort` plan shared runtime defaults.
- `--claude-model`, `--claude-effort`, `--codex-model`, and `--codex-effort` plan direction-specific companion defaults that still flow through `companions/contract.md` `--model` and `--effort`.
- Output includes the projected effective companion model/effort after repo/user config precedence is applied. Settings warns when a lower-precedence target is shadowed by an existing repo-local or direction-specific setting.
- Missing Claude Code or Codex CLI is reported as a non-executable host-CLI install plan. Settings gives host-native installation guidance but does not install host CLIs.
- Plugin install/update is dry-run unless `--execute-plugin-management` is supplied. Settings preflights the relevant host plugin command surface first. Claude uses the non-slash `claude plugin install/update` CLI when available, while the slash `/plugin` probe is reported only as observed host asymmetry. Unavailable surfaces, retired-plugin cleanup, and Codex packaged hook review/trust gaps produce a manual follow-up checklist for host-native commands. The executor runs only allowlisted host-native plugin commands as argv arrays, omits raw stdout/stderr, writes sanitized artifacts under `.agentic-plugins/runs/settings/<run-id>/`, and can be scoped with `--plugin-management-host`. A zero exit code is not treated as success when a host reports that its plugin command surface is unavailable.
- Codex temporary marketplace cache is reported separately from the per-plugin install cache. When the marketplace cache is already current but the install cache is missing, settings emits a manual cache-materialization recommendation instead of retrying `codex plugin marketplace add` or inventing a per-plugin `codex plugin install` command.
- Host-native Claude config, authentication, secrets, and sandbox/permission settings are never written by this command.
- Settings includes a `Codex Plugin Hooks` plan. It reports bundled hook packaging and recommends `plugin_hooks` enablement with a session command and persistent config snippet. With `--apply-codex-plugin-hooks`, it may write only `~/.codex/config.toml` `[features].plugin_hooks = true`; hook trust/review remains manual in Codex with `/hooks`, which settings surfaces as a manual follow-up once plugin hooks are packaged and enabled.
