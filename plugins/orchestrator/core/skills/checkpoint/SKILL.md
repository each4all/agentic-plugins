---
name: checkpoint
description: "Records a one-line progress checkpoint on the active orchestrator macro workflow. A workflow-continuity meta operation, not a planning verb. Use when the user wants durable macro-plan context re-surfaced in the next post-compact session — both hosts register SessionStart with matcher \"compact\" — or carried across a cross-host handoff."
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
| SessionStart re-injection — both hosts register the hook with `matcher: "compact"`, so this is **post-compact only**, never an arbitrary new session and not `claude --continue` | Yes, emits `checkpoint_summary` and `checkpoint_at` after compact | Yes once the bundled hooks load (generic `[features].hooks`) and pass `/hooks` trust; otherwise manual resume reads the same durable checkpoint |

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
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | For a mentioned `orchestrator` skill, the plugin directory that contains it: Codex injects a mentioned skill with its absolute path (`<path>…/core/skills/<skill>/SKILL.md</path>`), and dropping `/core/skills/<skill>/SKILL.md` from it leaves the root, which holds `.codex-plugin/plugin.json`. If that path is no longer in context, for example after compaction, a new mention of the skill supplies it again. With the default Codex home and the `agentic-plugins` marketplace added from Git, the root is `~/.codex/plugins/cache/agentic-plugins/orchestrator/<version>`, the versioned copy Codex loads skills from, and `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/orchestrator` is the marketplace checkout, which tracks the repository's `main` branch, not that copy. |
| Host flag | `--host claude` | `--host codex` |

---

## Phase 0 — Argument intake

Reject empty input. Treat the full argument string as the summary
after trimming leading/trailing whitespace. Do not split on
whitespace.

If the summary is very long, warn that SessionStart metadata displays
only a 256-character prefix while preserving the full on-disk value.

The summary travels as a file, never as shell source (ADR-0059, amendment
of 2026-10-10): typed text spliced into a command line is cut at `;`,
expanded at `$(…)` and run at a backtick.

1. Create a private directory for it, and note the path it prints
   (`<plugin-root>` being the orchestrator plugin root, § Command resolution):

   ```bash
   # Step 1: a private text directory, marked so that the step that reads it
   # last releases it (ADR-0059 Decisions 9 and 10).
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
   if grep -q -e "'tmpdir-make'" "<plugin-root>/scripts/state.mjs" 2>/dev/null; then
     if [ -n "${MAKE_PARENT:-}" ]; then
       MADE_DIR="$(node "<plugin-root>/scripts/state.mjs" tmpdir-make --kind op --parent "$MAKE_PARENT")" && MAKE_RC=0 || MAKE_RC=$?
     else
       MADE_DIR="$(node "<plugin-root>/scripts/state.mjs" tmpdir-make --kind "$MAKE_KIND")" && MAKE_RC=0 || MAKE_RC=$?
     fi
   elif [ -r "<plugin-root>/scripts/state.mjs" ]; then
     MAKE_RC=old
   else
     echo "✗ Cannot read <plugin-root>/scripts/state.mjs; no directory was made." >&2
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

2. With your file-editing tool, not the shell, write `summary.txt` there,
   holding the trimmed summary and ending with one newline.

Put the directory in Phase 2's `TEXT_DIR` line. `state.mjs` reads the file
itself and refuses an empty or missing one before it writes. Phase 2's block
releases the directory once its write succeeded (ADR-0059 Decision 10); a
block that stops keeps it for its rerun.

---

## Phase 1 — Locate active macro

Run:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT"
```

If no active workflow exists, there is no macro to reason about — surface a
compact pointer (not the full Active Next-Action Proposal — the meta/guard
exception in `core/skills/_shared/references/session-handoff.md`): the honest next
step is `orchestrator:plan` for a multi-deliverable macro, or `engineer:start`
for a single deliverable. If duplicate/corrupt branch state is reported, stop
and ask the user to resolve it with `orchestrator:resume`.

---

## Phase 2 — Set checkpoint

```bash
TEXT_DIR='<directory from step 1>'
# A fresh shell: the workflow is found again here, never carried from Phase 1's
# command. A lookup that fails or finds none stops the block and keeps the
# directory.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active orchestrator workflow; nothing to checkpoint." >&2; exit 1; }
node "<plugin-root>/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host <claude|codex> --summary-file "$TEXT_DIR/summary.txt" || exit $?
# ADR-0059 Decision 10, item 1 — the checkpoint is written: no block, rerun
# or continuation reads the directory again.
RELEASE_PATH="$TEXT_DIR"
# ADR-0059 Decision 10, item 4: release RELEASE_PATH (nothing when it is
# empty), cleanup only. On standard error the CLI's own line, or one of these
# when its result cannot be read; the block's standard output and exit status
# stay what its own work set, errexit or not.
if [ -n "${RELEASE_PATH:-}" ]; then
  if grep -q -e "'tmpdir-release'" "<plugin-root>/scripts/state.mjs" 2>/dev/null; then
    RELEASE_REPORT="$(node "<plugin-root>/scripts/state.mjs" tmpdir-release --path "$RELEASE_PATH")" || :
    node -e 'let r=null;try{r=JSON.parse(process.argv[1])}catch{}process.exit(r!==null&&typeof r==="object"&&typeof r.outcome==="string"?0:1)' "$RELEASE_REPORT" 2>/dev/null \
      || echo "agentic-dir release: the result is unknown; the directory may remain at $RELEASE_PATH or at its .removing- path" >&2
  elif [ -r "<plugin-root>/scripts/state.mjs" ]; then
    echo "agentic-dir release: no tmpdir-release in this state.mjs; the directory is kept at $RELEASE_PATH" >&2
  else
    echo "agentic-dir release: the result is unknown (cannot read <plugin-root>/scripts/state.mjs); the directory may remain at $RELEASE_PATH" >&2
  fi
fi
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
