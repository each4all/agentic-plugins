---
description: Read-only runtime readiness diagnosis for Claude/Codex hosts, plugins, companions, model/effort, permissions, artifacts, and workflow ledgers
argument-hint: "[--format text|json] [--model <id>] [--effort <level>] [--sandbox-permission-probe] [--permission-proof] [--execute-permission-proof] [--deep-peer-smoke] [--execute-deep-peer-smoke] [--artifact-inventory]"
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
- The `Experience Parity` section summarizes the cross-host user-experience goal as weighted readiness criteria: host plugin availability, plugin-management follow-ups, bidirectional companion contract, explicit peer execution proof, workflow continuity storage, lifecycle hook continuity, and runtime handoff artifacts. Its score is observed readiness only; it is not a declaration that the overall project goal is complete.
- The `Plugin Command Surface` section reports whether Claude's `claude plugin ...` CLI surface and Codex's marketplace surface are actually usable before settings suggests executable plugin-management steps. Claude's slash `/plugin` probe is retained only as observed host asymmetry. When Claude plugin CLI management is unavailable to doctor, retired Claude plugin cleanup is required, or Codex packaged hooks still need active-session review/trust, output includes a `Manual Follow-ups` checklist with the host-native `claude plugin ...` or `/hooks` commands to run in the relevant host.
- The `Codex Plugin Hooks` section separates generic `hooks`, the `plugin_hooks` feature flag, `.codex-plugin/plugin.json` hook exposure, and installed/source `hooks/hooks.json` packaging.
- `--model` and `--effort` are observed as explicit ADR-0024 resolution inputs; companion invocation still uses `companions/contract.md` `--model` and `--effort`.
- `--sandbox-permission-probe` is an explicit opt-in read-only preflight. It reports CLI/auth/permission-surface/companion-script evidence for both companion directions and records `peer_execution=false`.
- `--permission-proof` is an explicit opt-in permission preflight. By itself it does not execute peers.
- `--execute-permission-proof` must be paired with `--permission-proof`. It invokes each companion under host-native permission defaults and reports only sanitized metadata: status, exit codes, peer host/model, timing, stdout byte count, stdout SHA-256, and permission-failure class. Runtime does not pass sandbox, approval, permission-mode, or host-native policy relaxation flags.
- `--permission-proof-timeout-ms <n>` bounds each companion process when the permission executor flag is used.
- `--deep-peer-smoke` is an explicit opt-in flag. By itself it adds a plan-only preflight section with per-direction readiness, model, and effort inputs.
- `--execute-deep-peer-smoke` must be paired with `--deep-peer-smoke`. It executes the smoke through the existing companion contract and reports only sanitized metadata: status, exit codes, peer host/model, timing, stdout byte count, and stdout SHA-256. Raw peer stdout is not printed.
- `--deep-peer-smoke-timeout-ms <n>` bounds each companion process when the executor flag is used.
- `--artifact-inventory` is an explicit opt-in read-only inventory of `.agentic-plugins/runs` generated artifacts. It reports per-family counts, bytes, age metadata, and retention pressure without reading raw artifact bodies or deleting anything.
- `--artifact-retention-cap <n>` and `--artifact-max-bytes <n>` tune the advisory inventory thresholds.
- Codex CLI supports bundled plugin hooks behind `plugin_hooks`; doctor reports whether hook-bearing agentic-plugins are packaged and exposed before claiming automatic hook parity, and surfaces `/hooks` as a manual follow-up when runtime cannot verify the active-session review/trust state. `/hooks` `Installed` counts are packaging evidence only; `Active=0` output and `Trust: New hook - review required` are not enough to record attestation. Doctor also warns when Codex-exposed hook commands still point at Claude adapter paths, since installed metadata alone does not prove active Codex execution; `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` are Codex plugin-hook compatibility aliases, while `PLUGIN_ROOT`/`PLUGIN_DATA` are preferred for new Codex commands. Current local Codex CLI evidence exposes no non-interactive hook trust query, so a current `runtime:settings --attest-codex-hook-review` artifact is the only runtime-owned way to clear that follow-up.
