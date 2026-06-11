---
name: checkpoint
description: "Records a one-line progress checkpoint on the active orchestrator macro workflow. A workflow-continuity meta operation, not a planning verb. Use when the user wants durable macro-plan context re-surfaced in a later Claude session or cross-host handoff."
---

# Checkpoint (orchestrator meta skill)

`checkpoint` writes a one-line summary to the active macro workflow's
`latest_checkpoint` frontmatter field. It does not mutate
`current_phase`, `next_action`, or `plan.subtasks[]`.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| `state.mjs checkpoint-set` | `--host claude` | `--host codex` |
| Schema preservation | Yes | Yes |
| SessionStart re-injection | Yes, emits `checkpoint_summary` and `checkpoint_at` | Yes once the bundled hooks load (generic `[features].hooks`) and pass `/hooks` trust; otherwise manual resume reads the same durable checkpoint |

Codex can write the checkpoint for a future Claude handoff. The
checkpoint is durable; the automatic re-injection surface is
automatic in Codex only after the plugin is enabled with generic
`[features].hooks` (default on) and `/hooks`
review/trust.

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:checkpoint <summary>` | `$orchestrator:checkpoint <summary>` |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | Codex marketplace install path for `plugins/orchestrator` |
| Host flag | `--host claude` | `--host codex` |

---

## Phase 0 — Argument intake

Reject empty input. Treat the full argument string as the summary
after trimming leading/trailing whitespace. Do not split on
whitespace.

If the summary is very long, warn that SessionStart metadata displays
only a 256-character prefix while preserving the full on-disk value.

---

## Phase 1 — Locate active macro

Run:

```bash
node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT"
```

If no active workflow exists, stop and recommend
`orchestrator:plan`. If duplicate/corrupt branch state is reported,
stop and ask the user to resolve it with `orchestrator:resume`.

---

## Phase 2 — Set checkpoint

```bash
node "<plugin-root>/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host <claude|codex> --summary "$SUMMARY"
```

The state CLI writes under the per-file lock, sets
`latest_checkpoint: {at, summary}`, updates `updated_at`, and appends
`host_history` event `checkpointed`.

---

## Anti-patterns

- Do not record an empty checkpoint.
- Do not advance macro phase or subtask status.
- Do not edit workflow frontmatter by hand.
- Do not imply Codex has automatic SessionStart re-injection unless
  the stage-appropriate hook gate (generic `[features].hooks`, default on)
  and `/hooks` review/trust are complete.
