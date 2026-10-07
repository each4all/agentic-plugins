| Operation | Claude | Codex |
|-----------|--------|-------|
{{#capability dispatch_target}}
| `phase7-commit.mjs --mode plan` / `execute` / `close` | `--host claude` | `--host codex` — the same driver and on-disk state; the host flag records write provenance and spells the `/orchestrator:done` pointer (`$orchestrator:done` on Codex) |
{{/capability}}
{{^capability dispatch_target}}
| `phase7-commit.mjs --mode plan` / `execute` / `close` | `--host claude` | `--host codex` — the same driver and on-disk state; the host flag records write provenance |
{{/capability}}
{{#capability dispatch_target}}
| `state.mjs autopilot-preflight` (mode + pending owner gate) | Yes | Yes — reports a pending gate the same way; there is no autopilot run on Codex, so it never prints the banner there |
| `phase7-commit.mjs --mode autopilot` (the whole step, decided in code) | Yes, only under an autopilot run (`AGENTIC_AUTOPILOT`) | No — autopilot mode is Claude-only (ADR-0063 D9); ignore it on Codex |
{{/capability}}
{{^capability dispatch_target}}
| `state.mjs autopilot-preflight` (a pending owner gate) | Yes | Yes — reports a pending gate the same way |
{{/capability}}
| Stop-hook archive after a commit | Yes — at the end of the committing turn when every gate passes | Once the plugin hooks are enabled and `/hooks`-trusted; otherwise `${{persona}}:resume` archives by hand |
