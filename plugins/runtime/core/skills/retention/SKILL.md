---
name: retention
description: "ADR-0047 §7 citation-aware artifact retention for runtime. Use when the user wants to plan (read-only) or explicitly apply deletion of unpinned, over-cap, age-cleared run directories of the runtime-owned families (doctor/compat/settings) under a reviewed plan hash and write-ahead receipts. Dry-run by default; deletion needs --execute."
---

# Retention (runtime framework primitive)

`runtime:retention` is the ADR-0047 §7 operator surface for citation-aware
artifact retention. The planner is **read-only**; the apply executor is
**dry-run by default** and deletes only with an explicit `--execute` AND the
`--expected-plan-hash` of the plan the operator reviewed.

## When invoked by command (`/runtime:retention` or `$runtime:retention`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/retention.mjs" plan|apply|resolve [--family doctor|compat|settings] [--expected-plan-hash <hash>] [--execute] [--format text|json] --repo-root "$REPO_ROOT"
```

3. Present the result as an operator retention report.
   - `plan` is read-only and safe to run repeatedly; it prints the
     actionable/pinned split and the plan hash to review.
   - `apply` is dry-run by default; `--execute` REQUIRES `--expected-plan-hash`.
   - Blocked/refused output is a stop condition; do not delete run directories
     by hand around it in the main session.

## Scope

Deletion is confined to unpinned, over-cap, age-cleared run directories of the
three v1 runtime-owned families (`doctor`, `compat`, `settings`) under
`.agentic-plugins/runs/<family>/`. It never touches host config, never anything
outside `runs/`, never a pinned/live/latest/young/unreadable run, and never
`latest.json`.

## Apply Boundary

Apply mode is explicit-only and layered (ADR-0047 §7):

```bash
$runtime:retention apply --family compat --expected-plan-hash <reviewed-hash> --execute
```

Guarded by, in order: dry-run default → the reviewed plan hash must still match
after the executor recomputes the plan under the family lock (drift is a refusal
with re-present) → `scan_complete` (an incomplete pin scan withholds all
deletion) → a real O_EXCL family mutex (an open receipt blocks new applies) →
containment + no-follow re-run at the destructive boundary → a last-instant age
re-check → a write-ahead receipt whose per-target transitions survive a crash →
per-invocation deletion/byte/wall-clock ceilings.

Forbidden writes:

- tracked source files;
- host-native Claude Code or Codex CLI config;
- authentication state or secrets;
- sandbox or permission settings;
- any path outside `.agentic-plugins/runs/<family>/` and the receipt home under
  `.agentic-plugins/state/runtime/retention/`.

## Out of Scope

- No automatic retention during engineer/orchestrator/runtime command execution.
- No quarantine/move-aside (deletion is real recursive removal — a moved run
  breaks every pointer the pin scan protects).
- No widening of the family registry beyond doctor/compat/settings at v1.
