---
name: finalize
description: "Closes an orchestrator macro plan with remaining work intentionally deferred. Codex skill mirror for /orchestrator:finalize and ADR-0019 finalize lifecycle."
---

# Finalize (orchestrator lifecycle skill)

`finalize` closes a macro plan when remaining subtasks should be
recorded as `deferred` for a future revision. It preserves the
ADR-0019 three-step ritual:

1. bulk transition non-terminal subtasks to `deferred`;
2. archive or detach active engineer children with no parent lock held;
3. set macro terminal markers to `current_phase: finalized` and
   `terminal_marker: true`.

This is the Codex skill mirror of `commands/finalize.md`. Preserve that
command file as the canonical Claude runbook.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| Resolve macro via `find-active` / `find-macro` | Yes | Yes |
| Bulk subtask transition to `deferred` | `--host claude` | `--host codex` |
| Engineer child `stop-archive` / `detach-archive` pass | Yes | Yes |
| Set macro terminal markers | `--host claude` | `--host codex` |
| Macro auto-archive Stop hook | Automatic on Claude Stop | Manual helper: `adapters/codex/hooks/stop.mjs` |

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:finalize [--workflow=<macro-id>]` | `$orchestrator:finalize [--workflow=<macro-id>]` |
| Canonical command runbook | `commands/finalize.md` | `commands/finalize.md` is the behavioral source |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | Codex marketplace install path for `plugins/orchestrator` |
| Host flag | `--host claude` | `--host codex` |

---

## Phase 0 - Resolve macro

Parse optional `--workflow=<macro-id>` and reject unsafe values. Resolve
the macro by explicit id, active branch, or branch-agnostic
`find-macro`.

Set `DETECTED_HOST=codex` when running from Codex. In direct checkout
development, prefer the actual invoking host over cache path guessing.

---

## Phase 1 - Bulk transition to deferred

Run the parent state transition under the macro file lock:

```bash
node "<orchestrator-plugin-root>/scripts/state.mjs" bulk-subtask-status \
  --workflow-path "$MACRO_PATH" \
  --host codex \
  --from-statuses pending,blocked,in_progress \
  --to-status deferred
```

After this command returns, the parent lock is released. Do not hold the
parent lock while archiving engineer children.

---

## Phase 2 - Archive or detach engineer children

Resolve and preflight the engineer plugin with
`scripts/discover-engineer.mjs`.

Scan canonical and legacy engineer workflow homes for files whose
frontmatter has `parent_workflow == <macro id>`.

For each child:

- if the child's branch HEAD exists and the child is terminal, invoke
  engineer `state.mjs stop-archive` with the child's branch HEAD;
- otherwise invoke engineer `state.mjs detach-archive`;
- count failures and stop before Phase 3 if any child failed to archive.

Every engineer-side CLI invocation must use `$ENGINEER_PLUGIN_ROOT` in
argv. Do not rely on a rebound `$CLAUDE_PLUGIN_ROOT` for engineer
commands.

---

## Phase 3 - Set macro terminal markers

Run:

```bash
node "<orchestrator-plugin-root>/scripts/state.mjs" set-terminal \
  --workflow-path "$MACRO_PATH" \
  --host codex \
  --terminal-phase finalized \
  --terminal-marker true \
  --next-action archive
```

The macro now passes A1/A2/A3. A4 passes only when no active engineer
children remain.

---

## Phase 4 - Codex Stop hook / manual fallback

Codex can load orchestrator's bundled Stop hook when the plugin is enabled,
`[features].plugin_hooks = true`, and the hook has passed Codex review/trust.
After a successful Codex finalize, run the manual helper when plugin hooks are
disabled, not yet trusted, or the user wants immediate archive parity:

```bash
node "<orchestrator-plugin-root>/adapters/codex/hooks/stop.mjs"
```

Claude runs the Stop hook automatically through the Claude plugin hook
binding.

---

## Completion

Report the macro id, deferred subtask count, child archive/detach
summary, and whether the manual Codex stop helper was run. Append the
runtime completion footer when available.

---

## Anti-patterns

- Do not set terminal markers if any child failed to archive or detach.
- Do not hold the parent macro lock while archiving children.
- Do not mark remaining work `completed`; finalize means `deferred`.
- Do not claim Codex Stop hook auto-archive runs automatically.
