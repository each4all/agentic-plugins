---
description: Runtime consensus scaffold and explicit companion executor for ADR-0024 peer fanout, disagreement tracking, and synthesis
argument-hint: "plan|record|synthesize|next-round|execute|status [--format text|json] [--task <text>|--task-file <path>] [--run-id <id>] [--peer <id>] [--input-file <path>] [--summary-file <path>] [--disagreements-file <path>] [--max-rounds <n>] [--max-peers <n>] [--token-budget <n>] [--time-budget-ms <n>] [--process-budget <n>] [--timeout-ms <n>] [--execute]"
---

# Runtime - Consensus

$ARGUMENTS

Run the runtime-owned consensus artifact scaffold and its explicit companion executor. Planning, recording, synthesis, next-round, and status do not execute peer agents. The only execution path is `execute --execute`, which dispatches companions through `companions/contract.md`, stores raw peer stdout as artifact files, and prints only artifact pointers plus sanitized execution or synthesized consensus state.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/consensus.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS
```

Common flow:

```bash
/runtime:consensus plan --task "Review this implementation risk" --max-rounds 2
/runtime:consensus execute --run-id <id> --execute
/runtime:consensus record --run-id <id> --peer claude --input-file <peer-output.txt>
/runtime:consensus record --run-id <id> --peer codex --input-file <peer-output.txt>
/runtime:consensus synthesize --run-id <id> --summary-file <summary.md> --disagreements-file <disagreements.md>
/runtime:consensus next-round --run-id <id>
/runtime:consensus execute --run-id <id> --round 2 --execute
```

Notes:

- Raw peer output stays under `<repo>/.agentic-plugins/runs/consensus/<run-id>/`.
- Main-session output is limited to synthesized summary, durable disagreements, evidence pointers, artifact paths, and next action.
- Companion dispatch requires the explicit `execute --execute` boundary. Runtime never relaxes sandbox, approval, auth, permission, or host session state.
- Execution records status, failure type, retryability, byte count, and SHA-256. Permission and sandbox failures are classified as non-retryable until the operator resolves host policy outside runtime.
- Max rounds, max peers, process budget, and timeout caps prevent automatic unbounded loops.
- This command does not migrate engineer/orchestrator workflow state.
