---
description: Read-only runtime operator dashboard aggregating Tier 1 agentic state (three-persona workflows, peer runs, macro subtask progress, consensus, and the ADR-0045 snapshot-only entry advisory) and Tier 2 operator health (doctor/compat/baseline freshness, settings and Codex hook-attestation recency, artifact attention, notify-state health)
argument-hint: "[--format text|json] [--host claude|codex] [--watch] [--interval-seconds <n>] [--watch-count <n>] [--recent <n>]"
---

# Runtime - Dashboard

$ARGUMENTS

Render the ADR-0040 §6 aggregate operator view in one read-only snapshot. This command is R0 per ADR-0035: filesystem reads — it never probes host CLIs (that is `runtime:doctor`'s job; the dashboard reports the recorded doctor/compat evidence and its age instead) and never mutates state or host config. One declared exception to the no-spawn shape (ADR-0045 §7/§11): the **snapshot-mode entry advisory** pays the entry arbiter's bounded git probes (repo-root/branch/porcelain via the shared `runtime:context entry-brief` executor). `--watch` never does — the watch loop stays filesystem-only and spawn-free.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/dashboard.mjs" --repo-root "$REPO_ROOT" --host claude $ARGUMENTS
```

Examples:

```bash
/runtime:dashboard
/runtime:dashboard --format json
/runtime:dashboard --watch --interval-seconds 2
/runtime:dashboard --watch --watch-count 5 --recent 10
```

Notes:

- Tier 1 (agentic state) covers active workflows for all three personas — engineer, orchestrator, and founder — via the persona-generic reader (doctor's `{engineer, orchestrator}` ledger contract is untouched), peer runs with stale/non-terminal emphasis, orchestrator macro subtask progress, and consensus run states.
- The Tier-1 **entry advisory** (ADR-0045 §7(ii)) renders the same arbitrated, pointer-only entry brief `runtime:context entry-brief` computes for the current branch — snapshot mode only, excluded from `--watch` before the arbiter can run. It requires the trusted `--host` above (this command threads `--host claude`; the Codex skill threads `--host codex`); without one it reports `skipped (host-not-threaded)`, and a conflicting duplicate `--host` is rejected rather than last-wins so appended arguments cannot override the wrapper's threaded provenance. The advisory arbitrates over all four personas in one section without changing the Tier-1 persona rows, and the `entry_brief` config gate is informational here — the section always computes (the gate binds only the SessionStart hook surface).
- Tier 2 (operator health) covers recorded doctor/compat/baseline freshness, settings and Codex hook-attestation recency, artifact-inventory attention items, notify-state health (expired dedupe claim buildup, stale reclaim/rotation locks, unreadable notify state under `.agentic-plugins/state/runtime/notify/`), and the `file-log` channel's recent notifications when that channel is configured.
- `--format json` emits the machine-readable report (`runtime-dashboard-2.0`; 1.0 + the additive snapshot-only `tier1.entry_advisory`, + the snapshot-only `tier2.retention` projection, − the `tier2.assurance` facts removed by ADR-0056 §Decision 5, with `tier2.doctor.latest.assurance` renamed `historical_assurance` and carrying its `schema_era`). The MAJOR is deliberate: the change is non-additive, and the minor-with-projection alternative is vacuous because this report is never persisted, so there is no historical corpus to project.
- `--watch` re-renders from filesystem reads only on a bounded poll interval (default 2s, floor 1s via `--interval-seconds`); exit is explicit — Ctrl-C (SIGINT/SIGTERM) or a bounded `--watch-count <n>`. Watch mode never re-probes host CLIs and never carries the entry advisory (`--host` is accepted alongside `--watch` for uniform wrapper threading, but the advisory stays excluded); the watch loop itself spawns nothing — the one-time `git rev-parse` above is this wrapper's repo-root resolution at launch, shared by every runtime command and outside the loop. With `--format json`, watch frames output as NDJSON (one report per line).
- `--recent <n>` bounds how many recent file-log notifications are listed (default 5).
- This command does not replace `runtime:doctor` diagnosis, `runtime:compat` drift planning, or `runtime:context` handoff capture; it aggregates their recorded artifacts.
