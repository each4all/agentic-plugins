---
name: migrate
description: "Explicit ADR-0025 workflow storage migration planner plus read-only cross-checkout legacy egress-intent discovery. Use to dry-run or apply migration from legacy .claude/agentic-* workflow homes into .agentic-plugins/state, or to inventory pre-upgrade repo-scoped egress intent WALs left in other checkouts."
---

# Migrate (runtime framework primitive)

Two subcommands with deliberately different mutation boundaries:

- `runtime:migrate workflow-storage` — the ADR-0025 operator migration
  surface. Plans or applies the path migration from legacy
  `.claude/agentic-*` homes to `.agentic-plugins/state/<plugin>`.
- `runtime:migrate legacy-egress-intents` — the ADR-0048 residual (d)
  discovery. **Read-only, always**; there is no `--apply`.

## When invoked by command (`/runtime:migrate` or `$runtime:migrate`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/migrate.mjs" --repo-root "$REPO_ROOT" workflow-storage [--format text|json] [--plugin all|engineer|orchestrator] [--apply]
node "<runtime-plugin-root>/scripts/migrate.mjs" --repo-root "$REPO_ROOT" legacy-egress-intents [--root <path>]... [--skip <path>]... [--max-depth <n>] [--time-budget-ms <n>] [--format text|json]
```

`scripts/migrate-workflow-storage.mjs` remains a working direct entry
point for the workflow-storage half.

3. Present the result as an operator migration report.
   - Dry-run is the default and must be safe to run repeatedly.
   - `--plugin all` is for inventory. If multiple namespaces are ready,
     apply one namespace at a time.
   - `--apply` may move only generated local state from `.claude/agentic-*`
     to `.agentic-plugins/state/<plugin>`.
   - Blocked output should be treated as a stop condition; do not manually
     move files around it in the main session.

## legacy-egress-intents

The egress intent WAL moved from `<checkout>/.agentic-plugins/runs/doctor/
egress-intents/` to a machine-global `$HOME` location. `runtime:doctor`
fences only the checkout it runs in, so a proof the older runtime sent from a
different checkout is invisible to it and could still permit a re-send. This
subcommand is the one-time, machine-scoped inventory that closes that gap.

Report it as an inventory, never as an action list:

- `--root` **replaces** the default `$HOME` root; `--skip` excludes a subtree
  by device/inode identity. Both are repeatable and both are reported.
- Exit codes: `0` nothing found in the scanned scope, `2` locations found,
  `1` the scan did not complete.
- Status `no_findings_in_scanned_scope` is deliberately not called "clean" —
  checkouts outside the scanned roots are an irreducible residual, and it is
  stated in every output.
- The live machine-global WAL is excluded by device/inode identity. The
  current checkout's own legacy directory **is** a finding, annotated
  `already_fenced_by_current_doctor` — excluding it would be a false clean.
- A scan that could not complete demotes the status to `incomplete`, and in
  that state the output carries **no removal instruction at all**.

**Guidance to relay, unchanged, for every location** — a pre-upgrade record
may carry no process identity, and this runtime reads a missing identity as
*unknown*, not dead, so an older sender may still be in flight: make sure no
older proof is running, check the phone, then manually remove the specific
records the operator reviewed. Never present the directory as the unit to act
on, never suggest removing records the scan did not list, and never generate a
shell command.

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
- For `legacy-egress-intents`: no auto-move, no auto-delete, no `--apply`, no
  classification of discovered records (the pre-upgrade format cannot support
  it), no full-filesystem scan, no checkout registry, and no change to the
  shipped machine-global WAL protocol.
