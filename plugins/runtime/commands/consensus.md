---
description: Runtime consensus scaffold and explicit companion executor for ADR-0024 peer fanout, disagreement tracking, and synthesis
argument-hint: "plan|record|synthesize|next-round|execute|status [--format text|json] [--task <text>|--task-file <path>] [--run-id <id>|--latest] [--peer <id>] [--peers <ids>] [--input-file <path>] [--summary-file <path>] [--disagreements-file <path>] [--max-rounds <n>] [--max-peers <n>] [--token-budget <n>] [--time-budget-ms <n>] [--process-budget <n>] [--timeout-ms <n>] [--execute]"
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
/runtime:consensus plan --task "Review this implementation risk" --peers claude,codex,security,release --max-rounds 2 --max-peers 4
/runtime:consensus execute --run-id <id> --execute
/runtime:consensus record --run-id <id> --peer claude --input-file <peer-output.txt>
/runtime:consensus record --run-id <id> --peer codex --input-file <peer-output.txt>
/runtime:consensus record --run-id <id> --peer security --input-file <peer-output.txt>
/runtime:consensus record --run-id <id> --peer release --input-file <peer-output.txt>
/runtime:consensus synthesize --run-id <id> --summary-file <summary.md> --disagreements-file <disagreements.md>
/runtime:consensus next-round --run-id <id>
/runtime:consensus execute --run-id <id> --round 2 --execute
/runtime:consensus status --latest
```

Notes:

- Raw peer output stays under `<repo>/.agentic-plugins/runs/consensus/<run-id>/`.
- Main-session output is limited to synthesized summary, durable disagreements, evidence pointers, artifact paths, and next action.
- Companion dispatch requires the explicit `execute --execute` boundary. Runtime never relaxes sandbox, approval, auth, permission, or host session state.
- Only companion-backed peers (`claude`, `codex`) are executable by `execute --execute`; any other peer id in `--peers` is a manual/subagent lane with prompt artifacts that must be collected through `record`.
- The manifest and status output include peer lane metadata: `companion_execute` lanes are eligible for `execute --execute`; `manual_subagent_record` lanes should be run manually or through local subagents and then collected with `record`.
- Execution records per-peer progress in `execution-progress.json` plus status, failure type, retryability, byte count, and SHA-256. Raw stdout stays in peer raw-output artifacts.
- `execute` and `status` include an `execution_remediation` block when execution has run. It lists sanitized failure counts, per-peer retry commands, suggested timeout increases for timeout failures, proof commands, and artifact pointers. It is advisory only and never auto-retries peers.
- Timeouts are retryable and include bounded remediation metadata. Retry a selected peer with `--peers <peer> --timeout-ms <n> --process-budget 1`, or run `runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke` when prompt startup latency is unclear.
- `status` reads manifest, execution, progress, and consensus-result artifacts to recommend the next bounded operator action: execute/record, retry selected peers, synthesize, plan next-round, or stop for owner decision. `status --latest` picks the newest readable consensus manifest by `updated_at`/`created_at` without reading raw peer output.
- Permission and sandbox failures are classified as non-retryable until the operator resolves host policy outside runtime.
- Max rounds, process budget, and timeout caps prevent automatic unbounded loops; broader manual peer fanout is artifact-bounded by the explicit `--peers` roster and optional `--max-peers`, with no hidden fixed peer-count cap.
- `next-round` requires durable disagreements from `consensus.json` or `--disagreements-file`; it does not create empty rebuttal rounds or execute peers.
- This command does not migrate engineer/orchestrator workflow state.
