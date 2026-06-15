---
description: Record a one-line progress checkpoint on the active founder workflow (resumable via SessionStart re-injection)
argument-hint: <one-line summary>
---

# Founder · Checkpoint

$ARGUMENTS

`/founder:checkpoint` is a meta command per ADR-0022 (meta-skill category,
adopted for founder per ADR-0036 SD2): a thin shim over `state.mjs
checkpoint-set` that records a one-line progress summary into the active
workflow's `latest_checkpoint` frontmatter field. The next session's
SessionStart hook re-injects that summary so a resumed conversation knows
where the previous session stopped — useful for the multi-session arc of a
business deliverable where `current_phase` / `next_action` alone undersell
context.

This command does NOT mutate `current_phase` or `next_action`. It also does
NOT bootstrap a new workflow — use one of the six verbs
(`/founder:investigate`, `/founder:frame`, `/founder:decide`,
`/founder:compose`, `/founder:critique`, `/founder:refine`) for that.

**Cognitive runbook + the Host-availability matrix live in
`$CLAUDE_PLUGIN_ROOT/skills/checkpoint/SKILL.md`** per ADR-0022. This
command file owns the Claude-host bash bootstrap and the `state.mjs` writes
below; the summary-length guidance, privacy note, and host-availability
matrix delegate to SKILL.md via the matching `§ Phase N` pointer.

Plugin root in shell snippets below is `$CLAUDE_PLUGIN_ROOT` (set by Claude
Code for plugin slash commands). If unset, fall back to
`$(find ~/.claude/plugins/cache/agentic-plugins/founder -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

---

## Phase 0 — Argument parsing

Inspect `$ARGUMENTS`:

- **Empty / whitespace-only** → reject with a one-line usage hint and stop.
  A checkpoint without a summary defeats the purpose. Required form:
  `/founder:checkpoint <one-line summary>`.
- **Otherwise** → treat the entire `$ARGUMENTS` text as the summary. Trim
  leading/trailing whitespace. Do NOT split on whitespace or parse
  sub-commands. Multi-word summaries are normal.

Keep the summary free of raw proprietary identifiers / customer data — a
checkpoint is a progress pointer, not a data store (see SKILL.md § Phase 0
privacy note). Length: the on-disk record keeps the full text; the
SessionStart hook shows only a prefix. Warn if `$ARGUMENTS` is unusually
long (>1000 chars); do not silently truncate.

---

## Phase 1 — Locate active workflow

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/founder-checkpoint-find.err)"
FIND_RC=$?
```

Branch on the result:

- **Exit 0, empty stdout** → no active workflow. Emit:
  > ✗ No active workflow; nothing to checkpoint.
  > Recommended next: `/founder:investigate` (or another verb) to bootstrap
  > a workflow first.
- **Exit 0, single path on stdout** → that path is the single active
  workflow. Continue with Phase 2.
- **Exit 1, per-branch duplicate error on stderr** → two or more workflow
  files coexist on the current branch (ADR-0018 §sub-2). Reject with a hint
  pointing at `/founder:resume`. Do NOT pick one yourself.

---

## Phase 2 — Set checkpoint

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host claude --summary "$SUMMARY"
```

The CLI is signal-safe (atomic write under the per-file lock) and
schema-preserving: `latest_checkpoint` is a schema-1.1 additive field that
1.0 readers tolerantly ignore; `host_history` gains a `{host: claude, at:
<ISO>, event: checkpointed}` entry per ADR-0011 §1.

`$SUMMARY` is the trimmed `$ARGUMENTS` text. Pass it as a single quoted
argument so embedded whitespace survives intact. The CLI rejects empty
summaries; Phase 0 already filtered that case.

---

## Completion

Emit one of:

- `✓ Checkpoint recorded: <summary>` (followed by the absolute workflow path
  on the next line).
- `✗ No active workflow; nothing to checkpoint.` — Phase 1 found nothing.
- `✗ Per-branch duplicate detected — resolve via /founder:resume before
  checkpointing.` — Phase 1 found more than one workflow.
- `✗ Empty summary; required form: /founder:checkpoint <summary>.` — Phase 0
  rejected.

The next SessionStart (after `/compact` or `claude --continue`) re-injects
the summary into the post-compact session context as part of the
`[founder-active-metadata]` marker. The user does not need to re-issue
`/founder:resume` to see the checkpoint — it surfaces automatically in the
next session header.
