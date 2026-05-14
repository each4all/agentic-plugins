---
description: Read-only runtime worktree planner for isolating the next non-trivial runtime/operator slice
argument-hint: "plan [--format text|json] [--task <text>] [--branch <name>] [--base <ref>] [--worktree-dir <path>]"
---

# Runtime - Worktree

$ARGUMENTS

Plan a dedicated git worktree for the next runtime/operator slice. This command is read-only: it does not create branches, add worktrees, edit files, commit, push, or open pull requests.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/worktree.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS
```

Examples:

```bash
/runtime:worktree plan --task "Next runtime consensus UX slice"
/runtime:worktree plan --branch feat/runtime-consensus-ux --base origin/main --worktree-dir ../agentic-plugins-runtime-consensus-ux
```

Notes:

- Output includes the current git branch, dirtiness, existing worktrees, base-ref resolution, candidate branch/path availability, and suggested commands.
- Suggested commands such as `git worktree add -b <branch> <path> <base>` are not executed. Run them manually only after accepting the plan.
- The planner recommends a worktree for non-trivial follow-up when the current checkout is on `main`, dirty, detached, or already sharing work with other worktrees.
- This command does not replace validation, PR readiness checks, release-package scoping, or runtime context handoff.
