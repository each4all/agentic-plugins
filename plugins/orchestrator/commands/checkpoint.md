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
`${CLAUDE_PLUGIN_ROOT}/core/skills/checkpoint/SKILL.md`**. This command owns
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

The summary reaches `state.mjs` as a file, never as shell source (ADR-0059,
amendment of 2026-10-10): typed text spliced into a block is cut at `;`,
expanded at `$(…)` and run at a backtick.

1. Create a private directory for the file, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool (Claude: the Write tool), not the shell,
   write `summary.txt` in that directory: the trimmed summary, exactly as
   typed otherwise, ending with one newline.

Phase 2's block reads it from there: put the path in its `TEXT_DIR` line.
`state.mjs` removes the file's final newline, keeps everything else, and
refuses an empty or missing file before it writes; nothing deletes the file
(a headless run can deny `rm`).

---

## Phase 1 — Locate active macro workflow

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
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
  `core/skills/_shared/references/session-handoff.md § Active Next-Action Proposal`
  meta/guard exception): the honest next step is `/orchestrator:plan <feature>`
  to start a multi-deliverable macro (or `/engineer:start` for a single
  deliverable) — pick per the work shape.
- **Exit 0, single path** -> continue.
- **Exit 1** -> duplicate/corrupt branch state. Surface stderr and
  tell the user to resolve via `/orchestrator:resume` first.

---

## Phase 2 — Set checkpoint

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host claude --summary-file "$TEXT_DIR/summary.txt"
```

The CLI writes atomically under the per-file lock, preserves schema
`'1.1'`, and appends `{host: claude, event: checkpointed}` to
`host_history`.

Claude SessionStart re-injects `checkpoint_summary` and
`checkpoint_at` in the `[orchestrator-active-metadata]` marker. Both
hosts register that hook with `matcher: "compact"`, so re-injection is
**post-compact only** — not an arbitrary new session, and not on
`claude --continue`, whose SessionStart source the matcher does not
select. Outside that window `/orchestrator:resume` reads the same
durable checkpoint. Codex
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
