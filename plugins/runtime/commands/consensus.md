---
description: Runtime consensus scaffold and explicit companion executor for ADR-0024 peer fanout, disagreement tracking, synthesis, owner decisions, and artifact-only cancellation
argument-hint: "plan|record|synthesize|decide|cancel|next-round|execute|status [--format text|json] [--task <text>|--task-file <path>] [--run-id <id>|--latest] [--peer <id>] [--peers <ids>] [--input-file <path>] [--summary-file <path>] [--decision-file <path>] [--reason <text>|--reason-file <path>] [--confirm-no-active-process] [--disagreements-file <path>] [--contradictions-file <path>] [--convergence-state <state>] [--max-rounds <n>] [--max-peers <n>] [--token-budget <n>] [--time-budget-ms <n>] [--process-budget <n>] [--timeout-ms <n>] [--execute]"
---

# Runtime - Consensus

$ARGUMENTS

Run the runtime-owned consensus artifact scaffold and its explicit companion executor. Planning, recording, synthesis, owner-decision recording, artifact-only cancellation, next-round, and status do not execute peer agents. The only execution path is `execute --execute`, which dispatches companions through `companions/contract.md`, stores raw peer stdout as artifact files, and prints only artifact pointers plus sanitized execution or synthesized consensus state.

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
/runtime:consensus synthesize --run-id <id> --summary-file <summary.md> --disagreements-file <disagreements.md> --convergence-state contradiction
/runtime:consensus next-round --run-id <id>
/runtime:consensus execute --run-id <id> --round 2 --execute
/runtime:consensus decide --run-id <id> --decision-file <owner-decision.md> --decided-by owner
/runtime:consensus cancel --run-id <id> --reason-file <cancellation-reason.md> --confirm-no-active-process
/runtime:consensus status --latest
```

Notes:

- Raw peer output stays under `<repo>/.agentic-plugins/runs/consensus/<run-id>/`.
- Main-session output is limited to synthesized summary, convergence state, durable disagreements, contradiction summaries, evidence pointers, artifact paths, and next action.
- Companion dispatch requires the explicit `execute --execute` boundary. Runtime never relaxes sandbox, approval, auth, permission, or host session state.
- Only companion-backed peers (`claude`, `codex`) are executable by `execute --execute`; any other peer id in `--peers` is a manual/subagent lane with prompt artifacts that must be collected through `record`.
- The manifest and status output include peer lane metadata and explicit roles:
  `companion_execute` lanes use `<peer>_companion_peer` roles and are eligible
  for `execute --execute`; `manual_subagent_record` lanes use
  `<peer>_manual_subagent_peer` roles and should be run manually or through
  local subagents before collection with `record`.
- The manifest, prompt artifacts, and text output include a quality policy:
  objective `best-results-over-token-minimization`, all requested peers active
  by default unless `--max-peers` constrains breadth, host-native/runtime
  settings model-effort defaults without token-saving downshift, and
  independent fanout plus bounded contradiction rebuttal as the default review
  depth.
- Execution records per-peer progress in `execution-progress.json` plus status, failure type, retryability, byte count, and SHA-256. Raw stdout stays in peer raw-output artifacts.
- `execute` and `status` include an `execution_remediation` block when execution has run. It lists sanitized failure counts, per-peer retry commands, suggested timeout increases for timeout failures, proof commands, and artifact pointers. It is advisory only and never auto-retries peers.
- Timeouts are retryable and include bounded remediation metadata. Retry a selected peer with `--peers <peer> --timeout-ms <n> --process-budget 1`, or run `runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke` when prompt startup latency is unclear.
- If `status` sees a running progress artifact whose peer `started_at + timeout_ms` has elapsed without a final `execution.json`, it reports `execution_stalled`; inspect the progress artifact and confirm no original execute process is still active before retrying the guarded selected-peer command.
- `status` reads manifest, execution, progress, and consensus-result artifacts to recommend the next bounded operator action: execute/record, retry selected peers, synthesize, plan next-round for direct contradictions, stop for owner decision, or preserve non-consensus. `status --latest` picks the newest readable consensus manifest by `updated_at`/`created_at` without reading raw peer output.
- Permission and sandbox failures are classified as non-retryable until the operator resolves host policy outside runtime.
- Max rounds default to 2 total rounds and are hard-capped at 3. When direct contradictions remain after the configured round budget is exhausted, consensus reports `owner-decision-required` instead of creating another loop. Process budget and timeout caps bound execution; broader manual peer fanout is artifact-bounded by the explicit `--peers` roster and optional `--max-peers`, with no hidden fixed peer-count cap.
- `decide` records the owner decision that resolves `owner-decision-required`, `contradiction`, `insufficient-evidence`, or `non-consensus` outcomes. It stores the decision body as an artifact pointer, preserves the prior consensus pointer and evidence pointers, and does not print the decision text into status or footer output.
- `cancel` records an operator cancellation as pointer-only artifacts. If a running progress artifact exists without a final execution artifact, it requires `--confirm-no-active-process`; it does not kill, interrupt, or signal host CLI processes.
- `synthesize` records `convergence_state` as `aligned`, `complementary`, `contradiction`, `insufficient-evidence`, `owner-decision-required`, or `non-consensus`.
- `next-round` requires direct-contradiction durable disagreements from `consensus.json` or an explicit `--disagreements-file`; it does not create empty rebuttal rounds or execute peers.
- This command does not migrate engineer/orchestrator workflow state.
