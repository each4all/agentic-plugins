---
name: consensus
description: "ADR-0024 runtime consensus scaffold with an explicit companion executor. Use when the user wants to plan peer fanout, execute companions only behind --execute, record peer outputs as artifacts, synthesize disagreements, or create a targeted rebuttal round."
---

# Consensus (runtime framework primitive)

`runtime:consensus` is the first ADR-0024 dynamic peer consensus loop scaffold. It owns runtime consensus artifacts, keeps raw peer output out of the main session, and executes companion dispatch only through the explicit `execute --execute` boundary.

## When invoked by command (`/runtime:consensus` or `$runtime:consensus`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" plan --task <text> [--format text|json] [--peers claude,codex,reviewer] [--max-rounds <n>] [--max-peers <n>] [--token-budget <n>] [--time-budget-ms <n>] [--process-budget <n>]
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" execute --run-id <id> [--round <n>] [--peers claude,codex] --execute [--timeout-ms <n>] [--process-budget <n>] [--model <id>] [--effort <level>]
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" record --run-id <id> --peer <peer> --input-file <path>
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" synthesize --run-id <id> --summary-file <path> [--disagreements-file <path>] [--contradictions-file <path>] [--convergence-state aligned|complementary|contradiction|insufficient-evidence|owner-decision-required|non-consensus]
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" next-round --run-id <id>
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" status --run-id <id>
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" status --latest
```

3. Present only the returned synthesis and pointers.
   - Do not paste raw peer outputs into the main session.
   - Use artifact paths under `.agentic-plugins/runs/consensus/<run-id>/`.
   - Execute peers only when the user supplied `execute --execute`.

## Scope

Consensus reports and manages:

- independent fanout prompt artifacts;
- companion-executable peers (`claude`, `codex`) versus manual/subagent peer labels that are record-only;
- peer lane metadata (`companion_execute` versus `manual_subagent_record`) with
  explicit peer roles, operator actions, and command templates;
- quality-first policy metadata (`best-results-over-token-minimization`,
  default peer breadth, model/effort defaults, and review-depth defaults);
- budget policy fields (`max_rounds`, optional `max_peers`, token/time/process budget);
- raw peer output pointers, byte counts, and hashes;
- per-peer execution progress pointer and status;
- advisory `execution_remediation` for retryable failures, operator-action
  preconditions, proof commands, suggested timeout increases, and artifact
  pointers;
- synthesized summary;
- convergence state;
- durable disagreements;
- contradiction summaries;
- evidence pointers;
- targeted rebuttal prompt artifacts for a next round.
- explicit companion execution metadata, including status, failure type, retryability, byte counts, hashes, and artifact pointers.
- bounded timeout remediation metadata, including a selected-peer retry command.
- status guidance that recommends the next bounded operator action from
  manifest, execution, progress, and consensus-result artifacts.
- stalled-progress guidance when a running peer exceeds its timeout without a
  final execution artifact, guarded by an inspect-before-retry instruction.
- latest-run lookup for `status --latest`, selected from readable manifest
  timestamps without reading raw peer output.

## Boundaries

- No peer execution except `execute --execute`.
- `execute --execute` dispatches only companion-backed peers (`claude`, `codex`); other peer labels are manual/subagent lanes collected through `record`.
- Manual/subagent lanes are first-class artifact lanes, not hidden execution. Run those prompt artifacts manually or through local subagents, then use `record` to attach their output.
- No companion bridge mutation.
- No engineer/orchestrator workflow state migration.
- No host-native config, authentication, secret, sandbox, or permission writes.
- No claim that Codex plugin-hook feature/trust state or permission limits are host parity.
- No automatic unbounded loops; max rounds default to 2 total rounds and are hard-capped at 3. If direct contradictions remain after the configured round budget is exhausted, report `owner-decision-required` instead of creating another rebuttal loop. Process budget and timeout caps bound companion execution, while peer breadth is bounded by the explicit `--peers` roster and optional `--max-peers` with no hidden fixed peer-count cap.
- No false compromise: synthesis must classify peer output as `aligned`, `complementary`, `contradiction`, `insufficient-evidence`, `owner-decision-required`, or `non-consensus`.
- No empty rebuttal rounds; `next-round` requires direct-contradiction durable disagreements and still never executes peers.

## Example

```bash
$runtime:consensus plan --task "Review this risky runtime change" --peers claude,codex,security,release --max-rounds 2 --max-peers 4
$runtime:consensus execute --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --execute
$runtime:consensus record --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --peer claude --input-file claude.txt
$runtime:consensus record --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --peer security --input-file security.txt
$runtime:consensus synthesize --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --summary-file summary.md --disagreements-file disagreements.md --convergence-state contradiction
$runtime:consensus next-round --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef
$runtime:consensus execute --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --round 2 --execute
$runtime:consensus status --latest
```
