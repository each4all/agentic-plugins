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
| Macro auto-archive Stop hook | Automatic on Claude Stop | Automatic after the bundled hooks load (generic `[features].hooks`) + `/hooks` review/trust; manual helper fallback: `adapters/codex/hooks/stop.mjs` |

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
# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
# macro archive gates are evaluated at the end of THIS turn, not at session
# close; if a gate fails (a subtask still non-terminal, an engineer child
# still active) the macro stays marked and a later Stop re-evaluates it.
# Clearing the marker with `--terminal-marker false` works only before that
# Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
# --terminal-phase), and does not reopen the subtasks /finalize or /abort
# already closed. Once archived the macro is outside find-active, so recovery
# is a fresh /orchestrator:plan. On Codex the Stop hook runs only once the
# operator has trusted the plugin hooks (`/hooks`), so evaluation waits.
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

## Phase 4 - Codex Stop hook / fallback

Codex can load orchestrator's bundled Stop hook when the plugin is enabled,
generic `[features].hooks` (default on) is set, and the hook has passed Codex
review/trust.
After a successful Codex finalize, run the manual helper when plugin hooks are
disabled, not yet trusted, not active in the current host session, or the user
wants immediate archive parity:

```bash
node "<orchestrator-plugin-root>/adapters/codex/hooks/stop.mjs"
```

Claude runs the Stop hook automatically through the Claude plugin hook
binding.

---

## Completion

Report the macro id, deferred subtask count, child archive/detach
summary, whether Codex Stop hook automation is expected for the active session,
and whether the fallback helper was run. The runtime completion footer is
**code-emitted** on this verb's terminal path (ADR-0039): the macro terminal
write (`set-terminal`) fires the ADR-0031 session-handoff sidecar, which renders
the runtime `footer.mjs` on the command's stderr. Do not hand-compose the footer
or hand-pass the projection here; surface the emitted one. A finalized macro
normally projects `archive_gate=ready_to_archive` once every macro gate passes;
the footer reports whatever gate it computes — never archive from it. The render
computes identically on Codex; only auto re-injection of the next-session prompt
depends on the stage-appropriate Codex hook gate (generic `[features].hooks`,
default on) + a `/hooks` trust (operator-attested; not provable
non-interactively). The terminal footer resolves the macro by PATH (not by
branch), so it renders even on detached HEAD — the "no active branch context"
degradation applies only to the branch-resolved `/plan`/`/next` preflight.

---

## Anti-patterns

- Do not set terminal markers if any child failed to archive or detach.
- Do not hold the parent macro lock while archiving children.
- Do not mark remaining work `completed`; finalize means `deferred`.
- Do not claim Codex Stop hook auto-archive runs automatically unless
  the stage-appropriate hook gate (generic `[features].hooks`, default on)
  and `/hooks` review/trust are complete for
  the active session.
