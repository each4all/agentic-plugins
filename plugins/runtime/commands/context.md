---
description: Runtime-owned context hygiene artifact scaffold for ADR-0024 next-session handoff
argument-hint: "capture|status [--format text|json] [--summary <text>|--summary-file <path>] [--risk green|yellow|red] [--artifact kind:<repo-path>] [--next-action <text>] [--next-session-prompt <text>|--next-session-prompt-file <path>] [--run-id <id>]"
---

# Runtime - Context

$ARGUMENTS

Run the runtime-owned context hygiene artifact scaffold. This command does not trim, rewrite, or mutate host session context. It writes a bounded repo-local artifact and prints only the context summary, risk level, artifact pointers, and recommended next-session prompt/action.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/context.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS
```

Common flow:

```bash
/runtime:context capture --summary "Runtime PR context summary" --risk yellow --next-action "Start a fresh session before the next large change."
/runtime:context capture --summary-file context-summary.md --artifact consensus:.agentic-plugins/runs/consensus/<run-id>/consensus.json
/runtime:context status --run-id <id>
```

Notes:

- Context artifacts stay under `<repo>/.agentic-plugins/runs/context/<run-id>/`.
- Main-session output is limited to context summary, risk level, artifact pointers, and recommended next-session prompt/action.
- This command does not migrate engineer/orchestrator workflow state.
- Consensus raw output and peer raw output must be referenced by artifact pointer only.
- Codex manual-hook and permission limits are reported as limits, not host parity.
