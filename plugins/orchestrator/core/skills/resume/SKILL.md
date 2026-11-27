---
name: resume
description: "Re-enters an in-flight orchestrator macro workflow with a clean/dirty drift report, or archives a stale macro workflow. A workflow-continuity meta operation, not a macro planning verb. Use when the user wants to inspect or continue an active orchestrator plan after compaction, branch switching, or cross-host handoff."
---

# Resume (orchestrator meta skill)

`resume` inspects the active orchestrator macro workflow for the
current git branch. It reports clean/dirty drift against
`git_baseline`, optionally appends a resume marker, and can archive
stale macro workflows.

This is a meta skill, not a planning verb. It does not create a new
workflow and does not mutate `plan.subtasks[]`. Bootstrap new macro
work with `orchestrator:plan`.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| Locate active macro via `state.mjs find-active` | Yes | Yes — filesystem state is host-shared |
| Drift report with git probes | Yes | Yes |
| Append resume marker | `--host claude` | `--host codex` |
| Archive macro workflow | `--host claude` | `--host codex` |
| SessionStart re-injection — both hosts register the hook with `matcher: "compact"`, so this is **post-compact only** | Yes, through the Claude hook, after compact | Yes once the bundled hooks load (generic `[features].hooks`) and pass `/hooks` trust; otherwise resume reads the same durable workflow file |

Codex can inspect, append, and archive using the same `state.mjs`
surface. Automatic SessionStart re-injection in Codex additionally requires
the plugin enabled with generic `[features].hooks` (default on) and
`/hooks` review/trust.

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:resume [archive [<id>]]` | `$orchestrator:resume [archive [<id>]]` |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | For a mentioned `orchestrator` skill, the plugin directory that contains it: Codex injects a mentioned skill with its absolute path (`<path>…/core/skills/<skill>/SKILL.md</path>`), and dropping `/core/skills/<skill>/SKILL.md` from it leaves the root, which holds `.codex-plugin/plugin.json`. If that path is no longer in context, for example after compaction, a new mention of the skill supplies it again. With the default Codex home and the `agentic-plugins` marketplace added from Git, the root is `~/.codex/plugins/cache/agentic-plugins/orchestrator/<version>`, the versioned copy Codex loads skills from, and `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/orchestrator` is the marketplace checkout, which tracks the repository's `main` branch, not that copy. |
| Host flag | `--host claude` | `--host codex` |

---

## Phase 0 — Argument intake

- Empty -> resume mode.
- Starts with `archive` -> archive mode.
- Anything else -> reject with
  `orchestrator:resume [archive [<workflow-id>]]`.

---

## Phase 1 — Locate active macro

Run:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT"
```

Outcomes:

- Empty stdout -> no active macro to reason about; surface a compact pointer
  (not the full Active Next-Action Proposal — the meta/guard exception in
  `core/skills/_shared/references/session-handoff.md`): the honest next step is
  `orchestrator:plan` for a multi-deliverable macro, or `engineer:start` for a
  single deliverable.
- One path -> continue.
- Non-zero -> duplicate/corrupt branch state; surface the diagnostic
  and do not choose a workflow for the user.

---

## Phase 2 — Drift report

Read the workflow with `state.mjs read --workflow-path <path>`.
Compare current branch, HEAD, and status digest against
`git_baseline`. Classify as:

- `clean` when all match.
- `dirty` when any differ.

For dirty drift, run git probes when the baseline commit object is
available: commits since baseline, working tree diff stat, renames,
and deletes. Always state that orchestrator does not auto-reconcile
macro workflows.

If `latest_checkpoint` exists, include `at` and `summary`.

Append a resume marker. Its note, a one-paragraph drift summary, is text
you write, so it travels as a file, never as shell source (ADR-0059,
amendment of 2026-10-10).

1. Create a private directory for it, and note the path it prints:

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

2. With your file-editing tool, not the shell, write `note.md` there, ending
   with one newline, and `workflow-id.txt` beside it: the `workflow_id` the
   drift report read, ending with one newline.

Put the directory in the block's `TEXT_DIR` line. The block finds the active
workflow again and stops when it is not the one the drift report read (the
branch or its workflow changed since): run the drift report again. `state.mjs` reads the note
itself and refuses an empty or missing one before it writes. The block
releases the directory once the marker is written (ADR-0059 Decision 10); a
block that stops keeps it for its rerun.

```bash
TEXT_DIR='<directory from step 1>'
# A fresh shell: the workflow is found again here, never carried from an
# earlier command. A lookup that fails or finds none stops the block and keeps
# the directory.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active orchestrator workflow; nothing to resume." >&2; exit 1; }
# The workflow the drift report read, from the file the agent wrote: a marker
# on another one (the branch or its workflow changed since) would put this
# drift note on a macro it does not describe.
node -e 'let id;try{id=require("fs").readFileSync(process.argv[1],"utf8").replace(/\r?\n$/,"")}catch{process.exit(1)}process.exit(id!==""&&id===require("path").basename(process.argv[2],".md")?0:1)' "$TEXT_DIR/workflow-id.txt" "$ACTIVE" \
  || { echo "✗ workflow-id.txt in TEXT_DIR ($TEXT_DIR) is missing or names another workflow than $ACTIVE (the branch or its workflow changed since the drift report); run the drift report again. Nothing was written." >&2; exit 1; }
node "<plugin-root>/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host <claude|codex> \
  --phase-label "Resume: drift=<clean|dirty>" \
  --phase-note-file "$TEXT_DIR/note.md" \
  --event resumed || exit $?
# ADR-0059 Decision 10, item 1 — the marker is written: no block, rerun or
# continuation reads the directory again.
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

Do not mutate `current_phase`, `next_action`, or `plan`.

---

## Phase 3 — Archive mode

Resolve the active or named workflow and ask for confirmation before
mutation. A named workflow is the file the block below prints: the
orchestrator workflow homes of the checkout's read set, the default state root
first (ADR-0067 Decision 4, item 2); stop when it exits non-zero (3: no root
holds the id; 1: two files do, or the id is not a macro id). The id reaches
`state.mjs` as a file, never in a command: typed into one, a quote, `$` or
backquote in it would be read as code (ADR-0059, C134(a)).

1. Create a private directory for it, and note the path it prints:

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

2. With your file-editing tool, not the shell, write `workflow-id.txt` in it,
   holding the id exactly as typed and ending with one newline.

Put the directory in the block's `ID_DIR` line. Once the block prints the
workflow, it releases the directory (ADR-0059 Decision 10): the printed path
is all a later step reads. A refusal keeps it for the rerun.

```bash
ID_DIR='<directory from step 1>'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
node "<plugin-root>/scripts/state.mjs" resolve-workflow \
  --repo-root "$REPO_ROOT" --workflow-id-file "$ID_DIR/workflow-id.txt" || exit $?
# ADR-0059 Decision 10, item 1 — the id is resolved and printed: no block,
# rerun or continuation reads the directory again.
RELEASE_PATH="$ID_DIR"
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

Use the path it prints as `WORKFLOW`. Then join the
macro's run lock (ADR-0067 Decision 4, item 5) and archive, releasing the
admission on every exit: a run or another session holding the lock
refuses, naming the holder, and nothing is archived.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
MACRO_ID="$(basename "$WORKFLOW" .md)"
ADMISSION="$(node "<plugin-root>/scripts/state.mjs" admission join \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --command resume --host <claude|codex>)" || exit 1
release_admission() {
  node "<plugin-root>/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
}
trap 'release_admission' EXIT
node "<plugin-root>/scripts/state.mjs" archive \
  --workflow-path "$WORKFLOW" --host <claude|codex> --repo-root "$REPO_ROOT"
```

Archive moves the file to the `archive/` beside it, in its own home
(canonical or legacy, wherever the macro lives).

---

## Anti-patterns

- Do not bootstrap a macro workflow from resume.
- Do not pick between duplicate same-branch macro files without user
  input.
- Do not auto-reconcile drift.
- Do not use engineer workflow ids or engineer schema paths.
