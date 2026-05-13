---
description: Dry-run runtime settings planner for agentic-plugins config, host/plugin readiness, and companion model/effort defaults
argument-hint: "[--format text|json] [--target repo|user|both] [--model <id>] [--effort <level>] [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>] [--apply]"
---

# Runtime - Settings

$ARGUMENTS

Run the runtime settings planner. It is dry-run by default. Mutation is allowed only with `--apply`, and apply mode writes only agentic-plugins-owned config files:

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
- Plugin install/update is recommendation-only in this PR. The command does not run host-native install/update commands.
- Host-native config, authentication, secrets, and sandbox/permission settings are never written by this command.
- Codex CLI has no verified plugin-local automatic hook packaging today; settings reports manual paths instead of claiming parity.
