---
description: Explicit workflow storage migration from legacy .claude/agentic-* homes to .agentic-plugins/state
argument-hint: "workflow-storage [--format text|json] [--plugin all|engineer|orchestrator] [--apply]"
---

# Runtime - Migrate

$ARGUMENTS

Run the ADR-0025 workflow storage migration planner. It is dry-run by
default. Mutation is allowed only with `--apply`, and apply mode moves
only generated local workflow state:

- `<repo>/.claude/agentic-engineer` -> `<repo>/.agentic-plugins/state/engineer`
- `<repo>/.claude/agentic-orchestrator` -> `<repo>/.agentic-plugins/state/orchestrator`

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/migrate-workflow-storage.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS
```

Notes:

- `workflow-storage` is the only migration subcommand today.
- Dry-run reports legacy/canonical namespace presence, workflow branch
  counts, peer-run counts, non-terminal peer runs, lock blockers, and exact
  source/destination paths.
- `--plugin all` is intended for dry-run inventory. If both engineer and
  orchestrator are ready to move, apply one namespace at a time with
  `--plugin engineer --apply` or `--plugin orchestrator --apply`.
- `--apply` refuses to run when locks, malformed workflow state, malformed
  peer-run handles, non-terminal peer runs, or existing canonical state would
  make the move ambiguous.
- Tracked worktree dirtiness is reported for operator awareness but is not a
  blocker; this command only moves gitignored generated state and writes the
  ignored migration manifest.
- The command does not rewrite workflow schemas, peer-run handle schemas,
  host-native config, authentication, secrets, sandbox, or permission settings.
