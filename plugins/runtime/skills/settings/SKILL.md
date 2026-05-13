---
name: settings
description: "Dry-run runtime settings planner for agentic-plugins. Use when the user wants to inspect marketplace/plugin/CLI readiness and plan repo-local or user-global model/effort defaults. Mutates only agentic-plugins-owned config when --apply is explicit."
---

# Settings (runtime framework primitive)

`runtime:settings` is the ADR-0024 operator settings surface. It plans host/plugin setup and agentic-plugins config changes. Dry-run is the default.

## When invoked by command (`/runtime:settings` or `$runtime:settings`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/settings.mjs" --repo-root "$REPO_ROOT" [--format text|json] [--target repo|user|both] [--model <id>] [--effort <level>] [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>] [--apply]
```

3. Present the result as a settings plan, not as proof of host parity.
   - Dry-run output is the default and must be safe to run repeatedly.
   - `--apply` may write only `.agentic-plugins/config.toml` in the repo and/or user home.
   - Plugin install/update remains a host-native command recommendation only.
   - Codex may expose host-level hooks, but agentic-plugins has no verified plugin-local automatic hook packaging today.

## Scope

Settings reports and plans:

- agentic-plugins marketplace registration for `companions`, `engineer`, `orchestrator`, and `runtime`.
- Known Claude/Codex plugin install/cache state for those plugins.
- `claude` and `codex` CLI availability and versions.
- Repo-local `.agentic-plugins/config.toml` model/effort defaults.
- User-global `~/.agentic-plugins/config.toml` model/effort defaults.
- Direction-specific companion defaults:
  - `claude_model` / `claude_effort` for Codex -> Claude.
  - `codex_model` / `codex_effort` for Claude -> Codex.
- Effective projected companion defaults after repo-local and user-global
  precedence. Warn when a lower-precedence write would not actually affect
  companion invocation.

## Apply Boundary

Apply mode is explicit-only:

```bash
$runtime:settings --model gpt-5.4 --effort high --apply
```

Allowed writes:

- `<repo>/.agentic-plugins/config.toml`
- `~/.agentic-plugins/config.toml`

Forbidden writes:

- Host-native Claude Code or Codex CLI config.
- Authentication state or secrets.
- Sandbox or permission relaxation.
- Plugin install/update/uninstall execution.

## Out of Scope

- No dynamic peer consensus loop.
- No context hygiene mutation.
- No automatic completion footer mutation. The footer helper is read-only and advisory.
- No deep peer smoke or sandbox permission proof.
- No automatic plugin install/update apply mode.
