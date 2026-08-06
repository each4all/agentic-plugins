---
description: Explicit workflow storage migration from legacy .claude/agentic-* homes to .agentic-plugins/state, plus read-only cross-checkout legacy egress-intent discovery
argument-hint: "workflow-storage [--plugin all|engineer|orchestrator] [--apply] | legacy-egress-intents [--root <path>] [--skip <path>]"
---

# Runtime - Migrate

$ARGUMENTS

Two subcommands. `workflow-storage` (the default) is the ADR-0025
migration planner: dry-run by default, mutating only with `--apply`.
`legacy-egress-intents` is the ADR-0048 residual (d) discovery: **always
read-only**, and there is no `--apply` for it.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/migrate.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS
```

`--repo-root` is placed **before** `$ARGUMENTS`, so the dispatcher finds
the subcommand by name rather than by position. `scripts/migrate.mjs` is
the entry point; `scripts/migrate-workflow-storage.mjs` remains a working
direct entry point for the workflow-storage half.

## workflow-storage (default)

Apply mode moves only generated local workflow state:

- `<repo>/.claude/agentic-engineer` -> `<repo>/.agentic-plugins/state/engineer`
- `<repo>/.claude/agentic-orchestrator` -> `<repo>/.agentic-plugins/state/orchestrator`

Notes:

- Dry-run reports legacy/canonical namespace presence, workflow branch
  counts, peer-run counts, non-terminal peer runs, lock blockers, and exact
  source/destination paths.
- `--plugin all` is intended for dry-run inventory. If both engineer and
  orchestrator are ready to move, apply one namespace at a time with
  `--plugin engineer --apply` or `--plugin orchestrator --apply`.
- `--apply` refuses to run when locks, malformed workflow state, malformed
  peer-run handles, non-terminal peer runs, or existing canonical state would
  make the move ambiguous.
- Tracked worktree dirtiness is reported for operator awareness but is not a
  blocker; this command only moves gitignored generated state and writes the
  ignored migration manifest.
- The command does not rewrite workflow schemas, peer-run handle schemas,
  host-native config, authentication, secrets, sandbox, or permission settings.

## legacy-egress-intents (read-only)

A one-time, machine-scoped inventory of **pre-upgrade, repo-scoped** egress
intent WALs. The WAL moved from `<checkout>/.agentic-plugins/runs/doctor/
egress-intents/` to `$HOME`, and `runtime:doctor` fences only the checkout it
is run from — so an old proof sent from a *different* checkout is invisible
to it and could still permit a re-send.

```bash
node "$RUNTIME_ROOT/scripts/migrate.mjs" --repo-root "$REPO_ROOT" legacy-egress-intents
node "$RUNTIME_ROOT/scripts/migrate.mjs" --repo-root "$REPO_ROOT" legacy-egress-intents --skip "$HOME/mnt"
```

- Scans `$HOME` by default. `--root <path>` **replaces** that root (repeatable);
  `--skip <path>` excludes a subtree by device/inode identity (repeatable).
- `--max-depth` and `--time-budget-ms` bound the walk. Defaults are 6 and
  120000ms, chosen against a measured `$HOME` walk. A slow network mount can
  dominate the budget — that is what `--skip` is for, and the report names the
  directories the budget left unwalked.
- Exit codes: `0` nothing found in the scanned scope, `2` locations found,
  `1` the scan did not complete.
- Writes nothing, reads no record body, and never emits a shell command for the
  operator to run. The scan itself spawns no subprocess; the wrapper above runs
  `git rev-parse` to resolve the repo root, as every runtime command does.

**How to act on a finding.** The guidance is uniform for every location and
its unit is the individual record, not the directory. A pre-upgrade record may
carry no process identity, and this runtime reads a missing identity as
*unknown*, not dead — so an older sender may still be in flight. For each
reported location: make sure no older proof is running, check the phone, then
manually remove the specific records you reviewed. Never act on the directory
as a whole, and never on records the scan did not list.

The live machine-global WAL is excluded by device/inode identity and is never
reported. The current checkout's own legacy directory **is** reported, annotated
as already fenced by this checkout's doctor — reporting every location is the
point, and excluding the familiar one would be a false clean.

Irreducible residual, stated in every output: checkouts outside the scanned
roots are not covered.
