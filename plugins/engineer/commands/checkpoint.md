---
description: Record a one-line progress checkpoint on the active engineer workflow (resumable via SessionStart re-injection)
argument-hint: <one-line summary>
---

# Engineer · Checkpoint

$ARGUMENTS

`/engineer:checkpoint` is a meta command per ADR-0017 §sub-decision-2:
a thin shim over `state.mjs setCheckpoint` that records a one-line
progress summary into the active workflow's `latest_checkpoint`
frontmatter field. The next session's SessionStart hook re-injects
that summary so a resumed conversation knows where the previous
session stopped — useful for multi-day deliverables where
`current_phase` / `next_action` alone undersell context.

This command does NOT mutate `current_phase` or `next_action`. It
also does NOT bootstrap a new workflow — use one of the 6 verbs
(`/engineer:investigate`, `/engineer:frame`, `/engineer:decide`,
`/engineer:compose`, `/engineer:critique`, `/engineer:refine`) for
that.

The plugin root in shell snippets below is `$CLAUDE_PLUGIN_ROOT`
(set by Claude Code for plugin slash commands). If unset for any
reason, fall back to
`$(find ~/.claude/plugins/cache/agentic-plugins/engineer -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

---

## Phase 0 — Argument parsing

Inspect `$ARGUMENTS`:

- **Empty / whitespace-only** → reject with a one-line usage hint and
  stop. A checkpoint without a summary defeats the purpose
  (re-injection has nothing to surface). Required form:
  `/engineer:checkpoint <one-line summary>`.
- **Otherwise** → treat the entire `$ARGUMENTS` text as the summary.
  Trim leading/trailing whitespace. Do NOT split on whitespace, do
  NOT attempt to parse sub-commands. Multi-word summaries are normal.

Length: `state.mjs setCheckpoint` does not enforce a hard cap — the
SessionStart hook truncates to 256 chars on display per its
`MAX_LENGTHS.checkpoint_summary` constant, but the on-disk record
keeps the full text. If `$ARGUMENTS` is unusually long (>1000 chars),
warn the user that re-injection will display only a prefix; do not
silently truncate.

---

## Phase 1 — Locate active workflow

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/engineer-checkpoint-find.err)"
FIND_RC=$?
```

Branch on the result:

- **Exit 0, empty stdout** → no active workflow. Emit:
  > ✗ No active workflow; nothing to checkpoint.
  > Recommended next: `/engineer:investigate` (or another verb) to
  > bootstrap a new workflow first.

  Do NOT attempt to read the workflows directory yourself or fabricate
  a workflow file.

- **Exit 0, single path on stdout** → that path is the single active
  workflow. Continue with Phase 2.

- **Exit 1, multi-active error on stderr** → the directory contains
  more than one workflow file, violating ADR-0011 §1 single-active
  invariant. Reject with a one-line hint pointing at
  `/engineer:resume` (which can list multi-active candidates and
  archive stale ones). Do NOT pick one yourself — multi-active is a
  user-resolvable invariant violation, not a checkpoint case.

---

## Phase 2 — Set checkpoint

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host claude --summary "$SUMMARY"
```

The CLI is signal-safe (atomic write under the per-file lock) and
schema-preserving:

- A workflow on disk with `schema: 1` keeps `schema: 1` after the
  checkpoint write — `latest_checkpoint` is a schema-1.1 additive
  field that 1.0 readers tolerantly ignore (ADR-0017 §"Schema
  versioning policy", additive non-breaking).
- A workflow with `schema: "1.1"` keeps `schema: "1.1"`.
- `host_history` gains a `{host: claude, at: <ISO>, event:
  checkpointed}` entry per ADR-0011 §1's host-history append contract.

`$SUMMARY` is the trimmed `$ARGUMENTS` text. Pass it through the
shell as a single quoted argument so embedded whitespace and special
characters survive intact. The CLI rejects empty summaries; Phase 0
already filtered that case.

---

## Completion

Emit one of:

- `✓ Checkpoint recorded: <summary>` (followed by the absolute
  workflow path on the next line, so the user can inspect by hand).
- `✗ No active workflow; nothing to checkpoint.` — Phase 1 found
  nothing.
- `✗ Multi-active workflows detected — resolve via /engineer:resume
  before checkpointing.` — Phase 1 found more than one.
- `✗ Empty summary; required form: /engineer:checkpoint <summary>.` —
  Phase 0 rejected.

The next SessionStart (after `/compact` or `claude --continue`)
re-injects the summary into the post-compact session context as part
of the `[engineer-active-metadata]` marker. The user does not need to
re-issue `/engineer:resume` to see the checkpoint — it surfaces
automatically in the next session header.
