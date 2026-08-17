---
name: dashboard
description: "Read-only ADR-0040 runtime operator dashboard. Use when the user wants one aggregate view of agentic state (three-persona active workflows, peer runs with stale emphasis, orchestrator macro subtask progress, consensus runs, and the ADR-0045 snapshot-only arbitrated entry advisory) plus operator health (doctor/compat/baseline freshness, the three compatibility-assurance facts, settings and Codex hook-attestation recency, artifact attention items, notify-state health, recent file-log notifications), optionally re-rendered with --watch."
---

# Dashboard (runtime framework primitive)

`runtime:dashboard` renders the ADR-0040 §6 aggregate operator view: Tier 1 agentic state and Tier 2 operator health in one R0 read-only snapshot. It reads filesystem state — recorded doctor/compat/settings artifacts, persona workflow/peer-run ledgers, consensus runs, and runtime notify state — and never probes host CLIs or mutates anything. One declared exception to the no-spawn shape (ADR-0045 §7/§11): the snapshot-mode entry advisory pays the entry arbiter's bounded git probes through the shared `runtime:context entry-brief` executor; `--watch` never does.

## When invoked by command (`/runtime:dashboard` or `$runtime:dashboard`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/dashboard.mjs" --repo-root "$REPO_ROOT" --host codex [--format text|json] [--watch] [--interval-seconds <n>] [--watch-count <n>] [--recent <n>]
```

3. Present only the rendered snapshot.
   - Keep attention rows (stale peer runs, artifact-cap breaches, notify-state issues, stale doctor evidence) visible.
   - When the operator needs a live host diagnosis rather than recorded evidence, route to `/runtime:doctor` instead of re-running the dashboard.

## Scope

Dashboard reports:

- Tier 1: active workflows for engineer, orchestrator, AND founder (persona-generic namespace reads; doctor's `{engineer, orchestrator}` ledger contract stays untouched); peer runs with stale/non-terminal emphasis; orchestrator macro subtask progress parsed from macro workflow frontmatter; consensus run states.
- Tier 1 also carries the **entry advisory** (ADR-0045 §7(ii)): the same arbitrated, pointer-only entry brief `runtime:context entry-brief` computes for the current branch — snapshot mode only, excluded from `--watch` before the arbiter can run; requires the wrapper-threaded trusted `--host` (this skill threads `--host codex`, so synthesized commands render `$`-localized) and reports `skipped (host-not-threaded)` without one; arbitrates over all four personas without changing the Tier-1 persona rows; the `entry_brief` gate is informational here (it binds only the SessionStart hook surface).
- Tier 2: recorded doctor artifact recency and runtime-version match; latest compat run drift class and host gaps; host-parity-baseline header; three separate compatibility-assurance facts — the authored record's readability and semantic coherence, the newest recorded doctor run's assurance verdict (a report predating the record reads `legacy-unassured`; no recorded run reads `no-recorded-run`), and this machine's assurance, which the dashboard always reports as `not-evaluated` because it performs no live host probe and so cannot establish which host pair is running; latest settings execution/attestation artifact recency (plan-only and probe-free settings runs record no execution artifact) plus the newest Codex hook-review attestation; artifact-inventory attention items; notify config status and notify-state health (expired dedupe claims, stale reclaim/rotation locks, unreadable state); recent `file-log` notifications when configured.
- `--watch`: filesystem-only re-render on a bounded poll interval (default 2s, floor 1s) with an explicit exit (SIGINT/SIGTERM or `--watch-count`); with `--format json` the stream is framed as NDJSON (one report per line).

## Boundaries

- No host CLI probing (`claude`/`codex` are never spawned — recorded evidence only).
- No process spawning except the snapshot entry advisory's bounded git probes (ADR-0045 §7/§11 declared exception; the watch loop spawns nothing — only the wrapper's one-time repo-root resolution at launch precedes it), and no network access.
- No state mutation: no writes under `.agentic-plugins/`, no artifact recording, no retention/cleanup.
- No host-native config, authentication, secret, sandbox, or permission writes.
- No unbounded loops: watch mode polls on a bounded interval and exits explicitly.
- No runtime context mutation.

## Example

```bash
$runtime:dashboard
$runtime:dashboard --format json
$runtime:dashboard --watch --interval-seconds 2 --watch-count 5
```
