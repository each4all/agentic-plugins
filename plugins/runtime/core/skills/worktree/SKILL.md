---
name: worktree
description: "Read-only ADR-0024 runtime worktree planner. Use when the user wants to isolate a non-trivial runtime/operator slice, inspect current git/worktree state, or decide whether to start follow-up work in a dedicated worktree."
---

# Worktree (runtime framework primitive)

`runtime:worktree` plans dedicated git worktrees for agentic-plugins follow-up work. It is read-only and emits evidence plus suggested commands; it never creates branches or worktrees itself.

## When invoked by command (`/runtime:worktree` or `$runtime:worktree`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/worktree.mjs" --repo-root "$REPO_ROOT" plan [--format text|json] [--task <text>] [--branch <name>] [--base <ref>] [--worktree-dir <path>]
```

3. Present only the returned plan.
   - Do not run suggested `git worktree add` commands unless the operator explicitly asks.
   - Keep branch/path/base blockers visible.
   - If the plan is blocked, resolve blockers before starting the next implementation slice.

## Scope

Worktree reports:

- current git branch, detached state, HEAD, and dirtiness;
- `git worktree list --porcelain` entries;
- base-ref resolution;
- candidate branch availability;
- candidate worktree path availability;
- suggested `git worktree add -b ...` command as an artifact of the plan.

## Boundaries

- No branch creation.
- No `git worktree add`, remove, prune, commit, push, pull, or checkout mutation.
- No host-native config, authentication, secret, sandbox, or permission writes.
- No PR creation or merge.
- No runtime context mutation.

## Example

```bash
$runtime:worktree plan --task "Next runtime consensus UX slice"
$runtime:worktree plan --branch feat/runtime-consensus-ux --base origin/main --worktree-dir ../agentic-plugins-runtime-consensus-ux
```
