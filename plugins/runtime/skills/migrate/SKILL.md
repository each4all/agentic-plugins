---
name: migrate
description: "Explicit ADR-0025 workflow storage migration planner for runtime. Use when the user wants to dry-run or apply migration from legacy .claude/agentic-* workflow homes into .agentic-plugins/state without changing workflow schemas."
---

# Migrate (runtime framework primitive)

`runtime:migrate workflow-storage` is the ADR-0025 operator migration
surface. It plans or applies the path migration from legacy
`.claude/agentic-*` homes to `.agentic-plugins/state/<plugin>`.

## When invoked by command (`/runtime:migrate` or `$runtime:migrate`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/migrate-workflow-storage.mjs" --repo-root "$REPO_ROOT" workflow-storage [--format text|json] [--plugin all|engineer|orchestrator] [--apply]
```

3. Present the result as an operator migration report.
   - Dry-run is the default and must be safe to run repeatedly.
   - `--plugin all` is for inventory. If multiple namespaces are ready,
     apply one namespace at a time.
   - `--apply` may move only generated local state from `.claude/agentic-*`
     to `.agentic-plugins/state/<plugin>`.
   - Blocked output should be treated as a stop condition; do not manually
     move files around it in the main session.

## Scope

Migration reports:

- which plugin namespaces exist in legacy and canonical homes;
- active workflow counts by branch;
- archive counts;
- peer-run counts and non-terminal peer-run counts;
- lock files that block migration;
- ambiguity when canonical state already exists;
- exact source and destination paths;
- tracked worktree dirtiness as non-blocking operator awareness.

## Apply Boundary

Apply mode is explicit-only:

```bash
$runtime:migrate workflow-storage --plugin engineer --apply
```

Allowed writes:

- rename `.claude/agentic-engineer` to `.agentic-plugins/state/engineer`;
- rename `.claude/agentic-orchestrator` to `.agentic-plugins/state/orchestrator`;
- write `.agentic-plugins/state/migrations/workflow-storage-v1.json`.

Forbidden writes:

- tracked source files;
- host-native Claude Code or Codex CLI config;
- authentication state or secrets;
- sandbox or permission settings;
- workflow schema or peer-run handle rewrites.

## Out of Scope

- No automatic migration during engineer/orchestrator/runtime command execution.
- No workflow schema conversion.
- No peer-run ledger pruning, cancellation, or sweeping.
- No host plugin install/update or authentication mutation.
