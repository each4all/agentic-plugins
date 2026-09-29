---
description: Read-only runtime worktree planner for isolating the next non-trivial runtime/operator slice
argument-hint: "plan [--format text|json] [--task <text>] [--branch <name>] [--base <ref>] [--worktree-dir <path>]"
---

# Runtime - Worktree

$ARGUMENTS

Plan a dedicated git worktree for the next runtime/operator slice. This command is read-only: it does not create branches, add worktrees, edit files, commit, push, or open pull requests.

The arguments above reach the command through an args file, never through
the shell (ADR-0059): typed text spliced into a command line is cut at `;`,
expanded at `$(…)` and redirected at `>`, and the damage can exit zero.
Before the block below:

1. Create a private directory for the file, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `args.json` in that
   directory holding `{"agentic_args": 1, "text": "…"}`, with `text` set to
   the arguments above exactly as typed, as a JSON string (`""` when there
   are none).

Then run the block with `ARGS_DIR` set to that directory. The command reads
the text as shell-style words and expands nothing: quote a value that holds
spaces, and quote `;` `&` `|` `<` `>` `(` `)`, a backquote, a `$` expansion,
or a word-initial `#` or `~` to pass it as text — unquoted, each is refused
with a message rather than reinterpreted. The command removes the args file
and its directory once it has read them.

```bash
ARGS_DIR='<directory from step 1>'
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${AGENTIC_RUNTIME_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$RUNTIME_ROOT" ] || RUNTIME_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/runtime -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"

node "$RUNTIME_ROOT/scripts/worktree.mjs" --repo-root "$REPO_ROOT" --args-file "$ARGS_DIR/args.json"
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
