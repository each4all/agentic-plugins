---
description: Runtime-owned context hygiene artifact scaffold and read-only budget check for ADR-0024 next-session handoff
argument-hint: "capture|status|check [--format text|json] [--summary <text>|--summary-file <path>] [--risk green|yellow|red] [--token-budget <n>] [--used-tokens <n>|--remaining-tokens <n>] [--artifact kind:<repo-path>] [--next-action <text>] [--next-session-prompt <text>|--next-session-prompt-file <path>] [--run-id <id>|--latest] [--stale-after-hours <n>]"
---

# Runtime - Context

$ARGUMENTS

Run the runtime-owned context hygiene artifact scaffold and read-only budget check. This command does not trim, rewrite, or mutate host session context. It also does not compact host session context. `capture` writes a bounded repo-local artifact; `status` reads one by explicit run id or latest-artifact lookup; `check` only computes an advisory green/yellow/red risk from caller-supplied inputs.

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
/runtime:context status --latest --stale-after-hours 12
/runtime:context check --token-budget 100000 --used-tokens 82000
/runtime:context check --risk yellow --risk-reason "Long implementation session."
```

Notes:

- Context artifacts stay under `<repo>/.agentic-plugins/runs/context/<run-id>/`.
- `status --latest` reads the newest readable context artifact and reports age/stale handoff metadata; it does not create or update artifacts.
- `check` is read-only and does not create a context artifact or trigger `capture`.
- Main-session output is limited to context summary, risk level, artifact pointers, and recommended next-session prompt/action.
- Context budget checks use explicit caller-supplied values only; this command does not measure Claude or Codex host context automatically.
- This command does not migrate engineer/orchestrator workflow state.
- Consensus raw output and peer raw output must be referenced by artifact pointer only.
- Codex manual-hook and permission limits are reported as limits, not host parity.
