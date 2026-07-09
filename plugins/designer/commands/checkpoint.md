---
description: Record a one-line progress checkpoint on the active designer workflow (resumable via SessionStart re-injection)
argument-hint: <one-line summary>
---

# Designer · Checkpoint

$ARGUMENTS

`/designer:checkpoint` is a meta command per ADR-0022 (meta-skill category,
adopted for designer per ADR-0042 SD7): a thin shim over `state.mjs
checkpoint-set` that records a one-line progress summary into the active
workflow's `latest_checkpoint` frontmatter field. The next session's
SessionStart hook re-injects that summary so a resumed conversation knows
where the previous session stopped — useful for the multi-session arc of a
design deliverable where `current_phase` / `next_action` alone undersell
context.

This command does NOT mutate `current_phase` or `next_action`. It also does
NOT bootstrap a new workflow — use one of the six verbs
(`/designer:investigate`, `/designer:frame`, `/designer:decide`,
`/designer:compose`, `/designer:critique`, `/designer:refine`) or
`/designer:start` for that.

**Cognitive runbook + the Host-availability matrix live in
`$CLAUDE_PLUGIN_ROOT/skills/checkpoint/SKILL.md`** per ADR-0022. This
command file owns the Claude-host bash bootstrap and the `state.mjs` writes
below; the summary-length guidance, privacy note, and host-availability
matrix delegate to SKILL.md via the matching `§ Phase N` pointer.

> **designer is not an orchestrator dispatch target** (ADR-0042 Non-Goal 2):
> this command reads no parent-linkage environment variables.

Plugin root in shell snippets below is `$CLAUDE_PLUGIN_ROOT` (set by Claude
Code for plugin slash commands). If unset, fall back to
`$(find ~/.claude/plugins/cache/agentic-plugins/designer -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

---

## Phase 0 — Argument parsing

Inspect `$ARGUMENTS`:

- **Empty / whitespace-only** → reject with a one-line usage hint and stop.
  A checkpoint without a summary defeats the purpose. Required form:
  `/designer:checkpoint <one-line summary>`.
- **Otherwise** → treat the entire `$ARGUMENTS` text as the summary. Trim
  leading/trailing whitespace. Do NOT split on whitespace or parse
  sub-commands. Multi-word summaries are normal.

Keep the summary free of proprietary UI text, unreleased feature names,
customer data, or secrets read out of frontend code — a checkpoint is a
progress pointer, not a data store (see SKILL.md § Phase 0 privacy note). It
is durable local state, not an external transmission, so the peer-dispatch
privacy gate does not fire here. Length: the on-disk record keeps the full
text; the SessionStart hook shows only a prefix. Warn if `$ARGUMENTS` is
unusually long (>1000 chars); do not silently truncate.

---

## Phase 1 — Locate active workflow

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/designer-checkpoint-find.err)"
FIND_RC=$?
```

Branch on the result:

- **Exit 0, empty stdout** → no active workflow. Emit:
  > ✗ No active workflow; nothing to checkpoint.
  > Recommended next: `/designer:investigate` (or another verb, or
  > `/designer:start`) to bootstrap a workflow first.
- **Exit 0, single path on stdout** → that path is the single active
  workflow. Continue with Phase 2.
- **Exit 1, per-branch duplicate error on stderr** → two or more workflow
  files coexist on the current branch (ADR-0018 §sub-2). Reject with a hint
  pointing at `/designer:resume`. Do NOT pick one yourself.

---

## Phase 2 — Set checkpoint

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --summary "$SUMMARY"
```

The CLI is signal-safe (atomic write under the per-file lock) and
schema-preserving: `latest_checkpoint` is a schema-1.1 additive field that
1.0 readers tolerantly ignore; `host_history` gains a `{host, at: <ISO>,
event: checkpointed}` entry per ADR-0011 §1.

`$SUMMARY` is the trimmed `$ARGUMENTS` text. Pass it as a single quoted
argument so embedded whitespace survives intact. The CLI rejects empty
summaries; Phase 0 already filtered that case.

---

## Completion

Emit one of:

- `✓ Checkpoint recorded: <summary>` (followed by the absolute workflow path
  on the next line).
- `✗ No active workflow; nothing to checkpoint.` — Phase 1 found nothing.
- `✗ Per-branch duplicate detected — resolve via /designer:resume before
  checkpointing.` — Phase 1 found more than one workflow.
- `✗ Empty summary; required form: /designer:checkpoint <summary>.` — Phase 0
  rejected.

The next SessionStart (after `/compact` or `claude --continue`) re-injects
the summary into the post-compact session context as part of the
`[designer-active-metadata]` marker. The user does not need to re-issue
`/designer:resume` to see the checkpoint — it surfaces automatically in the
next session header.
