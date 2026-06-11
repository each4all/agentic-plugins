---
name: consensus
description: "ADR-0024 runtime consensus scaffold with an explicit companion executor. Use when the user wants to plan peer fanout, execute companions only behind --execute, record peer outputs as artifacts, synthesize disagreements, record owner decisions, ratify a converged run's residual owner lever, cancel consensus as artifacts, or create a targeted rebuttal round."
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
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" decide --run-id <id> --decision-file <path> [--decided-by owner]
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" ratify --run-id <id> --ratification <text>|--ratification-file <path> [--ratified-by owner] [--lever <single-line summary>]
node "<runtime-plugin-root>/scripts/consensus.mjs" --repo-root "$REPO_ROOT" cancel --run-id <id> --reason <text>|--reason-file <path> [--confirm-no-active-process]
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
- aggregate round-output completeness, separate from the latest execution
  command summary, so staged single-peer retries are readable before synthesis;
- per-peer execution progress pointer and status;
- advisory `execution_remediation` for retryable failures, operator-action
  preconditions, proof commands, suggested timeout increases, and artifact
  pointers;
- synthesized summary;
- convergence state;
- durable disagreements;
- contradiction summaries;
- owner decision artifacts that close exhausted or otherwise unresolved
  consensus without running another peer round;
- owner ratification artifacts that record the owner's resolution of a
  synthesis-flagged residual owner lever on a converged (`aligned`/
  `complementary`) run, with an optional single-line `--lever` summary,
  while the manifest status stays `converged` and `consensus.json` /
  `convergence_state` stay untouched;
- an `owner_decision_briefing` in `status` output when convergence is
  unresolved (`owner-decision-required`, round-budget-exhausted
  `contradiction`, `insufficient-evidence`, or `non-consensus`): the
  synthesized durable disagreements (type, summary, evidence pointers), the
  `decide` command to run, and the `owner-decision.md` template sections. It is
  derived from synthesized durable disagreements only and never surfaces raw
  peer output (pointer-only invariant);
- an advisory `owner_ratification_briefing` in `status` output when a run
  converged with durable disagreements still preserved and no ratification
  exists: the synthesized durable disagreements, the `ratify` command, and
  the `owner-ratification.md` template sections (same pointer-only
  invariant; recording a ratification is optional);
- cancellation artifacts that close abandoned or intentionally stopped
  consensus runs without killing host processes;
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
- latest-open lookup for `status --latest-open`, which skips cancelled,
  converged, and owner-decided runs while preserving them as artifacts.

## Boundaries

- No peer execution except `execute --execute`.
- `execute --execute` dispatches only companion-backed peers (`claude`, `codex`); other peer labels are manual/subagent lanes collected through `record`.
- Manual/subagent lanes are first-class artifact lanes, not hidden execution. Run those prompt artifacts manually or through local subagents, then use `record` to attach their output.
- No companion bridge mutation.
- No engineer/orchestrator workflow state migration.
- No host-native config, authentication, secret, sandbox, or permission writes.
- No claim that Codex plugin-hook feature/trust state or permission limits are host parity.
- No automatic unbounded loops; max rounds default to 2 total rounds and are hard-capped at 3. If direct contradictions remain after the configured round budget is exhausted, report `owner-decision-required` instead of creating another rebuttal loop. Process budget and timeout caps bound companion execution, while peer breadth is bounded by the explicit `--peers` roster and optional `--max-peers` with no hidden fixed peer-count cap.
- Owner decisions are explicit artifacts. `decide` records a decision pointer,
  prior consensus pointer, evidence pointers, byte count, and hash; it does not
  print decision text, execute peers, or create another rebuttal round. When
  `status` reports an unresolved run it emits an `owner_decision_briefing` (text:
  an "Owner decision required:" section) listing the synthesized disagreements,
  the `decide` command, and the `owner-decision.md` template sections. Author the
  `owner-decision.md` from those briefing disagreements (never from raw peer
  output) with the sections: Context, Open Question, Considered Options,
  Decision, Rationale, Rollback.
- Owner ratifications are explicit artifacts and the converged-run mirror of
  `decide`. `ratify` requires converged consensus (`aligned`/`complementary`;
  unresolved runs must use `decide`), refuses already-ratified, owner-decided,
  and cancelled runs, keeps the manifest status `converged`, and never rewrites
  `consensus.json`, `convergence_state`, or the synthesized disagreements
  (no-averaging stays intact). It records a ratification pointer, byte count,
  hash, consensus pointer, optional single-line lever summary, and next action;
  it does not print ratification text, execute peers, or create another round.
  The `--lever` summary is displayed metadata (status prints it); keep
  sensitive owner-resolution detail in the pointer-only ratification body.
  Author the `owner-ratification.md` from the briefing disagreements with the
  sections: Context, Ratified Consensus, Residual Owner Lever, Owner
  Resolution, Rationale.
- Terminal artifacts gate the mutators: `record`, `synthesize`, `next-round`,
  and `execute` refuse a run that already has a cancellation, owner-decision,
  or owner-ratification artifact, and `decide`/`ratify` refuse all three
  terminal artifacts including their own (re-deciding or re-ratifying needs a
  new consensus run) — a recorded owner resolution can never end up attached
  to evidence or synthesis it never covered. The gates key on artifact
  pointers, not manifest status. Start a new consensus run instead.
- Cancellation is an explicit artifact. `cancel` records a reason pointer, byte
  count, hash, previous status, and optional progress pointer; if progress is
  running, require `--confirm-no-active-process` after operator verification.
  It does not kill, interrupt, or signal host CLI processes.
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
$runtime:consensus decide --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --decision-file owner-decision.md
$runtime:consensus ratify --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --ratification-file owner-ratification.md --lever "fs-scoping timing: wait for a trigger"
$runtime:consensus cancel --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --reason-file cancellation-reason.md --confirm-no-active-process
$runtime:consensus status --latest
```
