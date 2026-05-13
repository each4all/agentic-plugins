---
description: Read-only runtime readiness diagnosis for Claude/Codex hosts, plugins, companions, model/effort, permissions, and workflow ledgers
argument-hint: "[--format text|json] [--model <id>] [--effort <level>] [--sandbox-permission-probe] [--deep-peer-smoke]"
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
- `--deep-peer-smoke` is an explicit opt-in flag. It adds a plan-only preflight section with per-direction readiness, model, and effort inputs, but it does not execute peer agents yet.
- Codex CLI has no verified plugin-local automatic hook packaging today; doctor reports that limit instead of claiming parity.
