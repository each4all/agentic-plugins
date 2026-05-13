---
description: Read-only runtime readiness diagnosis for Claude/Codex hosts, plugins, companions, model/effort, permissions, and workflow ledgers
argument-hint: "[--format text|json] [--model <id>] [--effort <level>] [--sandbox-permission-probe] [--deep-peer-smoke] [--execute-deep-peer-smoke]"
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
- `--model` and `--effort` are observed as explicit ADR-0024 resolution inputs; companion invocation still uses `companions/contract.md` `--model` and `--effort`.
- `--sandbox-permission-probe` is an explicit opt-in read-only preflight. It reports CLI/auth/permission-surface/companion-script evidence for both companion directions and records `peer_execution=false`.
- `--deep-peer-smoke` is an explicit opt-in flag. By itself it adds a plan-only preflight section with per-direction readiness, model, and effort inputs.
- `--execute-deep-peer-smoke` must be paired with `--deep-peer-smoke`. It executes the smoke through the existing companion contract and reports only sanitized metadata: status, exit codes, peer host/model, timing, stdout byte count, and stdout SHA-256. Raw peer stdout is not printed.
- `--deep-peer-smoke-timeout-ms <n>` bounds each companion process when the executor flag is used.
- Codex CLI has no verified plugin-local automatic hook packaging today; doctor reports that limit instead of claiming parity.
