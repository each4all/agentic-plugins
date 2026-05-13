---
description: Artifact-only runtime consensus scaffold for ADR-0024 peer fanout, disagreement tracking, and synthesis
argument-hint: "plan|record|synthesize|next-round|status [--format text|json] [--task <text>|--task-file <path>] [--run-id <id>] [--peer <id>] [--input-file <path>] [--summary-file <path>] [--disagreements-file <path>] [--max-rounds <n>] [--max-peers <n>] [--token-budget <n>] [--time-budget-ms <n>] [--process-budget <n>]"
---

# Runtime - Consensus

$ARGUMENTS

Run the runtime-owned consensus artifact scaffold. This command does not execute peer agents. It creates prompts, records peer raw output as artifact files, and prints only artifact pointers plus synthesized consensus state.

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
/runtime:consensus record --run-id <id> --peer claude --input-file <peer-output.txt>
/runtime:consensus record --run-id <id> --peer codex --input-file <peer-output.txt>
/runtime:consensus synthesize --run-id <id> --summary-file <summary.md> --disagreements-file <disagreements.md>
/runtime:consensus next-round --run-id <id>
```

Notes:

- Raw peer output stays under `<repo>/.agentic-plugins/runs/consensus/<run-id>/`.
- Main-session output is limited to synthesized summary, durable disagreements, evidence pointers, artifact paths, and next action.
- Peer execution remains manual or host-native in this MVP; no companion, sandbox, auth, or permission mutation is performed.
- This command does not migrate engineer/orchestrator workflow state.
