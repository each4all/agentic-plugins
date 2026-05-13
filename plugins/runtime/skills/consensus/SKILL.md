---
name: consensus
description: "Artifact-only ADR-0024 runtime consensus scaffold. Use when the user wants to plan peer fanout, record peer outputs as artifacts, synthesize disagreements, or create a targeted rebuttal round without executing peers directly."
---

# Consensus (runtime framework primitive)

`runtime:consensus` is the first ADR-0024 dynamic peer consensus loop scaffold. It owns runtime consensus artifacts and keeps raw peer output out of the main session.

## When invoked by command (`/runtime:consensus` or `$runtime:consensus`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" plan --task <text> [--format text|json] [--peers claude,codex] [--max-rounds <n>] [--max-peers <n>] [--token-budget <n>] [--time-budget-ms <n>] [--process-budget <n>]
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" record --run-id <id> --peer <peer> --input-file <path>
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" synthesize --run-id <id> --summary-file <path> [--disagreements-file <path>]
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" next-round --run-id <id>
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" status --run-id <id>
```

3. Present only the returned synthesis and pointers.
   - Do not paste raw peer outputs into the main session.
   - Use artifact paths under `.agentic-plugins/runs/consensus/<run-id>/`.
   - Treat peer execution as manual or host-native unless a future PR adds an explicit executor boundary.

## Scope

Consensus reports and manages:

- independent fanout prompt artifacts;
- budget policy fields (`max_rounds`, `max_peers`, token/time/process budget);
- raw peer output pointers, byte counts, and hashes;
- synthesized summary;
- durable disagreements;
- evidence pointers;
- targeted rebuttal prompt artifacts for a next round.

## Boundaries

- No direct peer execution.
- No companion bridge mutation.
- No engineer/orchestrator workflow state migration.
- No host-native config, authentication, secret, sandbox, or permission writes.
- No claim that Codex manual-hook or permission limits are host parity.

## Example

```bash
$runtime:consensus plan --task "Review this risky runtime change" --max-rounds 2
$runtime:consensus record --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --peer claude --input-file claude.txt
$runtime:consensus synthesize --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --summary-file summary.md --disagreements-file disagreements.md
```
