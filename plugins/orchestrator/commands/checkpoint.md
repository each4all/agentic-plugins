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
   # Step 1: a private text directory, marked so that the step that reads it
   # last releases it (ADR-0059 Decisions 9 and 10).
   CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
   [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
   MAKE_KIND='text'
   MAKE_PARENT=''
   # ADR-0059 Decision 9: make and mark the directory MAKE_KIND names (text or
   # op; MAKE_PARENT, when set, for an op nested in it); its path is MADE_DIR.
   # The fallbacks of Decision 10, item 4 make it the old way: an older
   # state.mjs, lacking tmpdir-make, and a platform where the make is unsupported
   # with mktemp -d, a nested op in a parent made the old way with mkdir. A fallback's path is
   # checked for what a single-quoted shell literal cannot carry, as the make
   # checks its own. Each status is read in a condition, so errexit changes
   # nothing here.
   MADE_DIR=''
   if grep -q -e "'tmpdir-make'" "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" 2>/dev/null; then
     if [ -n "${MAKE_PARENT:-}" ]; then
       MADE_DIR="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-make --kind op --parent "$MAKE_PARENT")" && MAKE_RC=0 || MAKE_RC=$?
     else
       MADE_DIR="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-make --kind "$MAKE_KIND")" && MAKE_RC=0 || MAKE_RC=$?
     fi
   elif [ -r "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ]; then
     MAKE_RC=old
   else
     echo "✗ Cannot read $CLAUDE_PLUGIN_ROOT/scripts/state.mjs; no directory was made." >&2
     exit 1
   fi
   case "$MAKE_RC" in
     0) ;;
     3|4|old)
       if [ -n "${MAKE_PARENT:-}" ]; then
         MADE_DIR="$MAKE_PARENT/op"
         mkdir -m 700 "$MADE_DIR" || { echo "✗ $MADE_DIR already holds an operation directory, or cannot be made: run from a fresh directory. No directory was made." >&2; exit 1; }
       else
         MADE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentic-$MAKE_KIND.XXXXXX")" || exit 1
         [ "$MAKE_RC" != 3 ] || echo "agentic-dir make: unsupported on this platform; $MADE_DIR was made with mktemp -d and will not be released" >&2
       fi
       node -e 'process.exit(/[\x00-\x1f\x7f\x27]/.test(process.argv[1])?1:0)' "$MADE_DIR" \
         || { echo "✗ The directory made holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one." >&2; exit 1; }
       ;;
     5) echo "✗ TMPDIR (${TMPDIR:-/tmp}) holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one. No directory was made." >&2; exit 1 ;;
     *) exit 1 ;;
   esac
   [ -n "$MADE_DIR" ] || { echo "✗ The make printed no directory; nothing can be written." >&2; exit 1; }
   printf '%s\n' "$MADE_DIR"
   ```

2. With your file-writing tool (Claude: the Write tool), not the shell,
   write `summary.txt` in that directory: the trimmed summary, exactly as
   typed otherwise, ending with one newline.

Phase 2's block reads it from there: put the path in its `TEXT_DIR` line.
`state.mjs` removes the file's final newline, keeps everything else, and
refuses an empty or missing file before it writes. Phase 2's block releases
the directory once its write succeeded (ADR-0059 Decision 10); a block that
stops keeps it for its rerun. No block runs `rm` (a headless run can deny
it).

---

## Phase 1 — Locate active macro workflow

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# Its path on standard output, its diagnostic on standard error, its own exit
# status: the branches below read all three from this call.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT"
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
# A fresh shell: the workflow is found again here, never carried from Phase 1's
# block. A lookup that fails or finds none stops the block and keeps the
# directory.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active orchestrator workflow; nothing to checkpoint." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host claude --summary-file "$TEXT_DIR/summary.txt" || exit $?
# ADR-0059 Decision 10, item 1 — the checkpoint is written: no block, rerun
# or continuation reads the directory again.
RELEASE_PATH="$TEXT_DIR"
# ADR-0059 Decision 10, item 4: release RELEASE_PATH (nothing when it is
# empty), cleanup only. On standard error the CLI's own line, or one of these
# when its result cannot be read; the block's standard output and exit status
# stay what its own work set, errexit or not.
if [ -n "${RELEASE_PATH:-}" ]; then
  if grep -q -e "'tmpdir-release'" "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" 2>/dev/null; then
    RELEASE_REPORT="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-release --path "$RELEASE_PATH")" || :
    node -e 'let r=null;try{r=JSON.parse(process.argv[1])}catch{}process.exit(r!==null&&typeof r==="object"&&typeof r.outcome==="string"?0:1)' "$RELEASE_REPORT" 2>/dev/null \
      || echo "agentic-dir release: the result is unknown; the directory may remain at $RELEASE_PATH or at its .removing- path" >&2
  elif [ -r "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ]; then
    echo "agentic-dir release: no tmpdir-release in this state.mjs; the directory is kept at $RELEASE_PATH" >&2
  else
    echo "agentic-dir release: the result is unknown (cannot read $CLAUDE_PLUGIN_ROOT/scripts/state.mjs); the directory may remain at $RELEASE_PATH" >&2
  fi
fi
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
