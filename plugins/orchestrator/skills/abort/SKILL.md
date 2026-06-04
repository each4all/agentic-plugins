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
| Macro auto-archive Stop hook | Automatic on Claude Stop | Automatic after `plugin_hooks` + `/hooks` review/trust; manual helper fallback: `adapters/codex/hooks/stop.mjs` |

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
`[features].plugin_hooks = true`, and the hook has passed Codex review/trust.
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
and whether the fallback helper was run. Append the runtime completion footer
when available.

Surface the ADR-0031 session-level continue-vs-fresh preflight per
`skills/_shared/references/session-handoff.md`: compute the macro projection
(find-active then find-macro) and pass it to the runtime footer/check. An
aborted macro normally projects `archive_gate=ready_to_archive` once every
macro gate passes; report whatever gate it computes — never archive from the
preflight. The preflight computes identically on Codex; only
auto re-injection of the next-session prompt depends on `[features].plugin_hooks`
+ a `/hooks` trust (operator-attested; not provable non-interactively). On
detached HEAD, report "no active branch context".

---

## Anti-patterns

- Do not use abort for merely postponed work; use finalize/deferred.
- Do not set terminal markers if child archive/detach failed.
- Do not hold the parent lock while archiving children.
- Do not claim Codex Stop hook auto-archive runs automatically unless
  `[features].plugin_hooks = true` and `/hooks` review/trust are complete for
  the active session.
