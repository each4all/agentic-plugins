---
description: Record a one-line progress checkpoint on the active engineer workflow (resumable via SessionStart re-injection)
argument-hint: <one-line summary>
---

# Engineer · Checkpoint

$ARGUMENTS

`/engineer:checkpoint` is a meta command per ADR-0017 §sub-decision-2:
a thin shim over `state.mjs setCheckpoint` that records a one-line
progress summary into the active workflow's `latest_checkpoint`
frontmatter field. The SessionStart hook re-injects that summary after
compact — both hosts register it with `matcher: "compact"` — so a
resumed conversation knows where the previous session stopped — useful for multi-day deliverables where
`current_phase` / `next_action` alone undersell context.

This command does NOT mutate `current_phase` or `next_action`. It
also does NOT bootstrap a new workflow — use one of the 6 verbs
(`/engineer:investigate`, `/engineer:frame`, `/engineer:decide`,
`/engineer:compose`, `/engineer:critique`, `/engineer:refine`) for
that.

**Cognitive runbook lives in
`${CLAUDE_PLUGIN_ROOT}/core/skills/checkpoint/SKILL.md`** per ADR-0022
(meta-skill category, ADR-0010 §3 cascade). This command file owns
the Claude-host bash bootstrap and the `state.mjs` writes below;
for each Phase 0–2 the cognitive description, summary-length
guidance, and host-availability matrix delegate to SKILL.md via the
matching `§ Phase N` pointer.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ENGINEER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

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

<!-- pipeline:begin checkpoint-locate -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/'engineer'-'checkpoint'-find.err)"
FIND_RC=$?
```
<!-- pipeline:end checkpoint-locate -->

Branch on the result:

- **Exit 0, empty stdout** → no active workflow. Emit:
  > ✗ No active workflow; nothing to checkpoint.
  > Recommended next: `/engineer:investigate` (or another verb) to
  > bootstrap a new workflow first.

  Do NOT attempt to read the workflows directory yourself or fabricate
  a workflow file.

- **Exit 0, single path on stdout** → that path is the single active
  workflow. Continue with Phase 2.

- **Exit 1, per-branch duplicate error on stderr** → two or more
  workflow files coexist on the current branch, violating the
  per-branch single-active invariant (ADR-0018 §sub-2 cascade of
  ADR-0011 §1). Reject with a one-line hint pointing at
  `/engineer:resume` (which can list per-branch duplicate candidates
  with their `git_baseline.branch` and archive stale ones). Do NOT
  pick one yourself — per-branch duplicate is a user-resolvable
  invariant violation, not a checkpoint case.

---

## Phase 2 — Set checkpoint

<!-- pipeline:begin checkpoint-set -->
The summary reaches `state.mjs` as a file, never in the block: it is the text
the user typed, and in shell source a quote, `$` or backtick of it would be
read as code (ADR-0059, amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `summary.txt` in that
   directory holding the summary from Phase 0, ending with one newline.
   Nothing deletes it.

Then run the block with `TEXT_DIR` set to that directory; a summary left
unwritten stops it before the write.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# The summary the agent wrote with its file tool: state.mjs reads it itself.
grep -q '[^[:space:]]' "$TEXT_DIR/summary.txt" 2>/dev/null || { echo "✗ summary.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --summary-file "$TEXT_DIR/summary.txt"
```
<!-- pipeline:end checkpoint-set -->

The CLI is signal-safe (atomic write under the per-file lock) and
schema-preserving:

- A workflow on disk with `schema: 1` keeps `schema: 1` after the
  checkpoint write — `latest_checkpoint` is a schema-1.1 additive
  field that 1.0 readers tolerantly ignore (ADR-0017 §"Schema
  versioning policy", additive non-breaking).
- A workflow with `schema: "1.1"` keeps `schema: "1.1"`.
- `host_history` gains a `{host, at: <ISO>, event: checkpointed}`
  entry per ADR-0011 §1's host-history append contract.

`summary.txt` holds the trimmed `$ARGUMENTS` text as typed: the file carries
embedded whitespace and special characters intact, since no shell reads it.
The CLI rejects an empty summary; Phase 0 already filtered that case.

---

## Completion

Emit one of:

- `✓ Checkpoint recorded: <summary>` (followed by the absolute
  workflow path on the next line, so the user can inspect by hand).
- `✗ No active workflow; nothing to checkpoint.` — Phase 1 found
  nothing.
- `✗ Per-branch duplicate detected — resolve via /engineer:resume
  before checkpointing.` — Phase 1 found more than one workflow on
  the current branch (corruption / external mutation per ADR-0018
  §sub-2).
- `✗ Empty summary; required form: /engineer:checkpoint <summary>.` —
  Phase 0 rejected.

Both hosts register the SessionStart hook with `matcher: "compact"`, so
the summary re-injects into the **post-compact** session context as part
of the `[engineer-active-metadata]` marker — not into an arbitrary new
session, and not on `claude --continue`, which carries a SessionStart
source the matcher does not select. Inside that window the user does not
need to re-issue `/engineer:resume`. Outside it — or on Codex before the
bundled hooks are `/hooks`-trusted — resume reads the same durable
checkpoint manually.
