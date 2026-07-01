---
name: abort
description: "Abandons an orchestrator macro plan with remaining work marked not-done. Codex skill mirror for /orchestrator:abort and ADR-0019 abort lifecycle."
---

# Abort (orchestrator lifecycle skill)

`abort` closes a macro plan when work cannot continue. It follows the
same three-step ritual as `finalize`, with different terminal labels:

- non-terminal subtasks become `abandoned`;
- macro `current_phase` becomes `aborted`.

Use `finalize` when remaining work is intentionally deferred. Use
`abort` when the plan is intentionally not done.

This is the Codex skill mirror of `commands/abort.md`. Preserve that
command file as the canonical Claude runbook.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| Resolve macro via `find-active` / `find-macro` | Yes | Yes |
| Bulk subtask transition to `abandoned` | `--host claude` | `--host codex` |
| Engineer child `stop-archive` / `detach-archive` pass | Yes | Yes |
| Set macro terminal markers | `--host claude` | `--host codex` |
| Macro auto-archive Stop hook | Automatic on Claude Stop | Automatic after the bundled hooks load (generic `[features].hooks`) + `/hooks` review/trust; manual helper fallback: `adapters/codex/hooks/stop.mjs` |

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:abort [--workflow=<macro-id>]` | `$orchestrator:abort [--workflow=<macro-id>]` |
| Canonical command runbook | `commands/abort.md` | `commands/abort.md` is the behavioral source |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | Codex marketplace install path for `plugins/orchestrator` |
| Host flag | `--host claude` | `--host codex` |

---

## Phase 0 - Resolve macro

Parse optional `--workflow=<macro-id>` and reject unsafe values. Resolve
the macro by explicit id, active branch, or branch-agnostic
`find-macro`.

Set `DETECTED_HOST=codex` when running from Codex.

---

## Phase 1 - Bulk transition to abandoned

Run:

```bash
node "<orchestrator-plugin-root>/scripts/state.mjs" bulk-subtask-status \
  --workflow-path "$MACRO_PATH" \
  --host codex \
  --from-statuses pending,blocked,in_progress \
  --to-status abandoned
```

Parent per-file lock is released after this command returns.

---

## Phase 2 - Archive or detach engineer children

This phase is identical to `finalize`:

1. resolve and preflight the engineer plugin;
2. scan engineer workflow homes for `parent_workflow == <macro id>`;
3. route terminal children through engineer `state.mjs stop-archive`;
4. route mid-flight, deleted-branch, or gate-not-met children through
   engineer `state.mjs detach-archive`;
5. stop before Phase 3 if any child failed to archive or detach.

The parent macro lock must not be held during this pass. Engineer-side
CLI invocations must use `$ENGINEER_PLUGIN_ROOT` in argv.

---

## Phase 3 - Set macro terminal markers

Run:

```bash
node "<orchestrator-plugin-root>/scripts/state.mjs" set-terminal \
  --workflow-path "$MACRO_PATH" \
  --host codex \
  --terminal-phase aborted \
  --terminal-marker true \
  --next-action archive
```

---

## Phase 4 - Codex Stop hook / fallback

Codex can load orchestrator's bundled Stop hook when the plugin is enabled,
generic `[features].hooks` (default on) is set, and the hook has passed Codex
review/trust.
After a successful Codex abort, run the fallback helper when plugin hooks are
disabled, not yet trusted, not active in the current host session, or the user
wants immediate archive parity:

```bash
node "<orchestrator-plugin-root>/adapters/codex/hooks/stop.mjs"
```

Claude runs the Stop hook automatically through the Claude plugin hook
binding.

---

## Completion

Report the macro id, abandoned subtask count, child archive/detach
summary, whether Codex Stop hook automation is expected for the active session,
and whether the fallback helper was run. The runtime completion footer is
**code-emitted** on this verb's terminal path (ADR-0039): the macro terminal
write (`set-terminal`) fires the ADR-0031 session-handoff sidecar, which renders
the runtime `footer.mjs` on the command's stderr. Do not hand-compose the footer
or hand-pass the projection here; surface the emitted one. An aborted macro
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

- Do not use abort for merely postponed work; use finalize/deferred.
- Do not set terminal markers if child archive/detach failed.
- Do not hold the parent lock while archiving children.
- Do not claim Codex Stop hook auto-archive runs automatically unless
  the stage-appropriate hook gate (generic `[features].hooks`, default on)
  and `/hooks` review/trust are complete for
  the active session.
