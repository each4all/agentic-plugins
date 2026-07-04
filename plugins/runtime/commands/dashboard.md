---
description: Read-only runtime operator dashboard aggregating Tier 1 agentic state (three-persona workflows, peer runs, macro subtask progress, consensus) and Tier 2 operator health (doctor/compat/baseline freshness, settings and Codex hook-attestation recency, artifact attention, notify-state health)
argument-hint: "[--format text|json] [--watch] [--interval-seconds <n>] [--watch-count <n>] [--recent <n>]"
---

# Runtime - Dashboard

$ARGUMENTS

Render the ADR-0040 §6 aggregate operator view in one read-only snapshot. This command is R0 per ADR-0035: pure filesystem reads — it never probes host CLIs (that is `runtime:doctor`'s job; the dashboard reports the recorded doctor/compat evidence and its age instead), never spawns processes, and never mutates state or host config.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/dashboard.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS
```

Examples:

```bash
/runtime:dashboard
/runtime:dashboard --format json
/runtime:dashboard --watch --interval-seconds 2
/runtime:dashboard --watch --watch-count 5 --recent 10
```

Notes:

- Tier 1 (agentic state) covers active workflows for all three personas — engineer, orchestrator, and founder — via the persona-generic reader (doctor's `{engineer, orchestrator}` ledger contract is untouched), peer runs with stale/non-terminal emphasis, orchestrator macro subtask progress, and consensus run states.
- Tier 2 (operator health) covers recorded doctor/compat/baseline freshness, settings and Codex hook-attestation recency, artifact-inventory attention items, notify-state health (expired dedupe claim buildup, stale reclaim/rotation locks, unreadable notify state under `.agentic-plugins/state/runtime/notify/`), and the `file-log` channel's recent notifications when that channel is configured.
- `--format json` emits the machine-readable report (`runtime-dashboard-1.0`).
- `--watch` re-renders from filesystem reads only on a bounded poll interval (default 2s, floor 1s via `--interval-seconds`); exit is explicit — Ctrl-C (SIGINT/SIGTERM) or a bounded `--watch-count <n>`. Watch mode never re-probes host CLIs. With `--format json`, watch frames output as NDJSON (one report per line).
- `--recent <n>` bounds how many recent file-log notifications are listed (default 5).
- This command does not replace `runtime:doctor` diagnosis, `runtime:compat` drift planning, or `runtime:context` handoff capture; it aggregates their recorded artifacts.
