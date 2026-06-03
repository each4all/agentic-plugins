---
description: Read-only runtime readiness diagnosis for Claude/Codex hosts, plugins, companions, model/effort, permissions, artifacts, and workflow ledgers
argument-hint: "[--format text|json] [--model <id>] [--effort <level>] [--sandbox-permission-probe] [--permission-proof] [--execute-permission-proof] [--deep-peer-smoke] [--execute-deep-peer-smoke] [--workflow-continuation-proof] [--execute-workflow-continuation-proof] [--artifact-inventory] [--record]"
---

# Runtime - Doctor

$ARGUMENTS

Run the runtime doctor. It is read-only: it does not install plugins, mutate settings, run authentication, sweep ledgers, or relax sandbox/permission settings.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/doctor.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS
```

Notes:

- `--format json` emits the machine-readable report.
- Default output starts with a `Readiness Matrix` that separates CLI availability, runtime installation evidence, authentication state, direction-specific peer model/effort inputs, hook evidence, companion readiness, and sandbox/permission status for Claude and Codex.
- The `Experience Parity` section summarizes the cross-host user-experience goal as weighted readiness criteria: host plugin availability, plugin-management follow-ups, bidirectional companion contract, explicit peer execution proof, explicit engineer workflow continuation proof, workflow continuity storage, lifecycle hook continuity, and runtime handoff/compatibility artifacts. Its score is observed readiness only; it is not a declaration that the overall project goal is complete.
- The `Compatibility Artifacts` section reads the latest `runtime:compat` snapshot/gap/plan metadata and reports host-version drift, release-note requirements, and next actions without reading raw release-note bodies or raw host help output.
- The `Plugin Command Surface` section reports whether Claude's `claude plugin ...` CLI surface and Codex's marketplace surface are actually usable before settings suggests executable plugin-management steps. Claude's slash `/plugin` probe is retained only as observed host asymmetry. When Claude plugin CLI management is unavailable to doctor, retired Claude plugin cleanup is required, or Codex packaged hooks still need active-session review/trust, output includes a `Manual Follow-ups` checklist with the host-native `claude plugin ...` or `/hooks` commands to run in the relevant host.
- The `Codex Plugin Hooks` section separates generic `hooks`, the `plugin_hooks` feature flag, `.codex-plugin/plugin.json` hook exposure, installed/source hook packaging, the per-plugin review target checklist that the operator should compare against the active Codex `/hooks` view, and `~/.codex/config.toml` `[hooks.state]` enabled/disabled state for expected bundled hook entries.
- `--model` and `--effort` are observed as explicit ADR-0024 resolution inputs; companion invocation still uses `companions/contract.md` `--model` and `--effort`.
- `--sandbox-permission-probe` is an explicit opt-in read-only preflight. It reports CLI/auth/permission-surface/companion-script evidence for both companion directions and records `peer_execution=false`.
- `--permission-proof` is an explicit opt-in permission preflight. By itself it does not execute peers.
- `--execute-permission-proof` must be paired with `--permission-proof`. It invokes each companion under host-native permission defaults and reports only sanitized metadata: status, exit codes, peer host/model, timing, stdout byte count, stdout SHA-256, and permission-failure class. Runtime does not pass sandbox, approval, permission-mode, or host-native policy relaxation flags.
- `--permission-proof-timeout-ms <n>` bounds each companion process when the permission executor flag is used.
- `--deep-peer-smoke` is an explicit opt-in flag. By itself it adds a plan-only preflight section with per-direction readiness, model, and effort inputs.
- `--execute-deep-peer-smoke` must be paired with `--deep-peer-smoke`. It executes the smoke through the existing companion contract and reports only sanitized metadata: status, exit codes, peer host/model, timing, stdout byte count, and stdout SHA-256. Raw peer stdout is not printed.
- `--deep-peer-smoke-timeout-ms <n>` bounds each companion process when the executor flag is used.
- `--workflow-continuation-proof` is an explicit opt-in flag. By itself it adds a plan-only preflight for the engineer workflow state and dispatch path.
- `--execute-workflow-continuation-proof` must be paired with `--workflow-continuation-proof`. It creates an ephemeral temp repo, runs engineer `state.mjs create`, dispatches the peer through engineer `dispatch-peer.mjs` with ensemble bookkeeping, verifies `pending_ensemble`, commits `ensemble_results`, and reports only sanitized metadata plus state-check booleans. Raw peer stdout and temp workflow file bodies are not printed.
- `--workflow-continuation-proof-timeout-ms <n>` bounds each subprocess when the workflow continuation executor flag is used.
- `--artifact-inventory` is an explicit opt-in read-only inventory of `.agentic-plugins/runs` generated artifacts. It reports per-family counts, bytes, age metadata, and retention pressure without reading raw artifact bodies or deleting anything.
- `--artifact-retention-cap <n>` and `--artifact-max-bytes <n>` tune the advisory inventory thresholds.
- `--record` writes a sanitized doctor artifact under `.agentic-plugins/runs/doctor/<run-id>/doctor.json`. It stores report metadata and proof hashes/byte counts, not raw peer stdout/stderr or prompt text. Later doctor/cutover runs may reuse the recorded proof only when runtime, host CLI, and plugin source/cache versions still match.
- `--run-id <doctor-run-id>` is accepted only with `--record` for deterministic test or operator-controlled artifact naming.
- Codex CLI gates bundled plugin hooks behind `plugin_hooks` (Codex < ~0.134) or, once that flag is removed, generic `[features].hooks`; doctor reports whether hook-bearing agentic-plugins are packaged and exposed before claiming automatic hook parity, and surfaces `/hooks` as a manual follow-up when runtime cannot verify the active-session review/trust state. The follow-up includes review targets with plugin version, hook path, events, commands, and command warnings. `/hooks` `Installed` counts are packaging evidence only; `Active=0` output and `Trust: New hook - review required` are not enough to record attestation. Doctor also reports explicitly disabled expected hook-state entries from `~/.codex/config.toml`, which must be re-enabled in `/hooks` before attestation. Doctor also warns when Codex-exposed hook commands still point at Claude adapter paths or rely on a bare `node` command that may not exist in the hook runner PATH; `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` are Codex plugin-hook compatibility aliases, while `PLUGIN_ROOT`/`PLUGIN_DATA` are preferred for new Codex commands. Current local Codex CLI evidence exposes no non-interactive hook trust query, so a current `runtime:settings --attest-codex-hook-review` artifact is the only runtime-owned way to clear that follow-up.
