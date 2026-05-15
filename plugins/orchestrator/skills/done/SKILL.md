---
name: done
description: "Manually records an orchestrator macro subtask as completed. Codex skill mirror for /orchestrator:done and backup path for engineer Stop-hook auto-writeback."
---

# Done (orchestrator completion skill)

`done` marks one macro subtask `completed` with the terminal commit SHA.
It is the manual backup for engineer Stop-hook auto-writeback. Use it
when the engineer session already produced a commit but the parent macro
was not updated automatically.

This is the Codex skill mirror of `commands/done.md`. Preserve that
command file as the canonical Claude runbook.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| Resolve macro via `find-active` / `find-macro` | Yes | Yes |
| Read subtask via `state.mjs read-subtask` | Yes | Yes |
| Fallback engineer child scan | Yes | Yes |
| Resolve branch or explicit commit SHA | Yes | Yes |
| `state.mjs subtask-update --status completed` | `--host claude` | `--host codex` |
| Automatic engineer Stop-hook writeback | Yes on Claude engineer Stop | Yes after Codex `plugin_hooks` + `/hooks` review/trust; manual backup when hook is unavailable |

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:done <subtask-id> [--commit=<sha>] [--workflow=<macro-id>]` | `$orchestrator:done <subtask-id> [--commit=<sha>] [--workflow=<macro-id>]` |
| Canonical command runbook | `commands/done.md` | `commands/done.md` is the behavioral source |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | Codex marketplace install path for `plugins/orchestrator` |
| Host flag | `--host claude` | `--host codex` |

---

## Phase 0 - Argument intake

Require a leading `<subtask-id>`.

Parse optional:

- `--commit=<sha>`;
- `--workflow=<macro-id>`.

Reject unsafe `--workflow` values. The workflow id must be basename
shaped.

---

## Phase 1 - Resolve macro and subtask

Resolve the macro using the same order as `next`:

1. explicit `--workflow`;
2. `state.mjs find-active --repo-root "$REPO_ROOT"`;
3. `state.mjs find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH"`.

Then read the subtask:

```bash
node "<orchestrator-plugin-root>/scripts/state.mjs" read-subtask \
  --workflow-path "$MACRO_PATH" \
  --subtask-id "$SUBTASK_ID"
```

If the subtask is already `completed`, report a no-op. If it is
`deferred` or `abandoned`, stop; terminal-partial states are absorbing
and must not be overwritten.

---

## Phase 2 - Resolve engineer workflow id

Prefer the subtask's recorded `engineer_workflow_id`.

If absent, scan engineer workflow homes and require both frontmatter
keys to match:

- `parent_workflow == <macro id>`;
- `originating_subtask == <subtask id>`.

Do not match on only one key. Do not invent an engineer workflow id.
If no child is found, stop and recommend `$orchestrator:next <id>`.

---

## Phase 3 - Resolve commit SHA

If `--commit=<sha>` is supplied, verify it resolves to a commit with
`git cat-file -e <sha>^{commit}` and peel annotated tags with
`git rev-parse <sha>^{commit}`.

If no commit is supplied, resolve the tip of the subtask branch via
`git rev-parse refs/heads/<subtask.branch>`. Do not use shorthand branch
names because tags can collide with branch names.

---

## Phase 4 - Atomic subtask update

Run:

```bash
node "<orchestrator-plugin-root>/scripts/state.mjs" subtask-update \
  --workflow-path "$MACRO_PATH" \
  --host codex \
  --subtask-id "$SUBTASK_ID" \
  --status completed \
  --engineer-workflow-id "$ENGINEER_WF_ID" \
  --commit "$COMMIT_SHA" \
  --closed-at "$CLOSED_AT" \
  --event updated
```

Surface the JSON envelope. `subtask-update` owns single-writer
ownership checks, absorbing-completed semantics, unblock propagation,
and macro auto-terminal promotion.

---

## Completion

Report the subtask id, commit, closed_at timestamp, and whether the
macro auto-promoted to terminal. Append the runtime completion footer
when available. For a real completed subtask, include PR handling
readiness fields when the footer helper can compute them.

---

## Anti-patterns

- Do not use current `HEAD` unless it is explicitly the subtask branch tip.
- Do not override `deferred` or `abandoned`.
- Do not complete without a matching engineer workflow id.
- Do not edit macro frontmatter by hand.
