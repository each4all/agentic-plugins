---
description: Record a one-line progress checkpoint on the active orchestrator macro workflow
argument-hint: <one-line summary>
---

# Orchestrator · Checkpoint

$ARGUMENTS

`/orchestrator:checkpoint` records a concise progress note in the
active macro workflow's `latest_checkpoint` frontmatter field. It
does not mutate `current_phase`, `next_action`, or `plan.subtasks[]`.
The workflow namespace is `.agentic-plugins/state/orchestrator/` for
new repos; legacy `.claude/agentic-orchestrator/` state remains active
until explicit migration.

**Cognitive runbook lives in
`$CLAUDE_PLUGIN_ROOT/skills/checkpoint/SKILL.md`**. This command owns
Claude-host shell bootstrap; the skill documents Codex use and Codex
hook-gate boundaries.

---

## Phase 0 — Argument parsing

- Empty / whitespace-only -> reject:
  `Usage: /orchestrator:checkpoint <one-line summary>`
- Otherwise -> trim `$ARGUMENTS` and pass the full text as the
  checkpoint summary. Do not split on whitespace.

If the summary is unusually long, warn that Claude SessionStart
metadata displays only a 256-character prefix; the on-disk value is
kept in full.

---

## Phase 1 — Locate active macro workflow

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/orchestrator-checkpoint-find.err)"
FIND_RC=$?
```

Branch on the result:

- **Exit 0, empty stdout** -> emit
  `✗ No active orchestrator workflow; nothing to checkpoint.`
  There is no macro to reason about, so this guard surfaces a compact
  pointer, not the full Active Next-Action Proposal (per
  `skills/_shared/references/session-handoff.md § Active Next-Action Proposal`
  meta/guard exception): the honest next step is `/orchestrator:plan <feature>`
  to start a multi-deliverable macro (or `/engineer:start` for a single
  deliverable) — pick per the work shape.
- **Exit 0, single path** -> continue.
- **Exit 1** -> duplicate/corrupt branch state. Surface stderr and
  tell the user to resolve via `/orchestrator:resume` first.

---

## Phase 2 — Set checkpoint

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host claude --summary "$SUMMARY"
```

The CLI writes atomically under the per-file lock, preserves schema
`'1.1'`, and appends `{host: claude, event: checkpointed}` to
`host_history`.

Claude SessionStart re-injects `checkpoint_summary` and
`checkpoint_at` in the `[orchestrator-active-metadata]` marker. Codex
can write the same field via `$orchestrator:checkpoint`; automatic Codex
SessionStart behavior requires the bundled plugin hooks to be loaded
(plugin enabled, generic `[features].hooks` default on) and trusted in
the active host session.

---

## Completion

- `✓ Orchestrator checkpoint recorded: <summary>`
- `✗ No active orchestrator workflow; nothing to checkpoint.`
- `✗ Per-branch duplicate detected — resolve via /orchestrator:resume before checkpointing.`
- `✗ Empty summary; required form: /orchestrator:checkpoint <summary>.`

Always include the absolute workflow path on success.
