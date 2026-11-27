---
description: Resume an active orchestrator macro workflow with a clean/dirty drift report, or archive it
argument-hint: [archive [<workflow-id>]]
---

# Orchestrator · Resume

$ARGUMENTS

`/orchestrator:resume` is a workflow-continuity meta command: a thin
shim over `scripts/state.mjs` for the active macro workflow on the
current git branch. It mirrors the engineer resume pattern where that
pattern is useful, but the workflow remains orchestrator-native:
`workflow_type: macro`, `workflow_id: macro-plan-...`, and state under
canonical `.agentic-plugins/state/orchestrator/` (legacy
`.claude/agentic-orchestrator/` remains readable until explicit
migration per ADR-0025).

**Cognitive runbook lives in
`${CLAUDE_PLUGIN_ROOT}/core/skills/resume/SKILL.md`**. This command file owns
Claude-host shell bootstrap and state writes; the skill documents the
cross-host runbook and Codex hook-gate caveats.

Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ORCHESTRATOR_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep that opening line when you run a block: a
shell variable does not outlive a Bash call.

---

## Phase 0 — Argument parsing

Inspect `$ARGUMENTS`:

- Empty -> **resume mode**. Continue with Phase 1.
- Starts with `archive` -> **archive mode**. Continue with Phase 3.
- Anything else -> reject with:
  `Usage: /orchestrator:resume [archive [<workflow-id>]]`

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

- **Exit 0, empty stdout** -> no active macro workflow. Emit:
  `✗ No active orchestrator workflow; nothing to resume.`
  No macro to reason about — this guard surfaces a compact pointer, not the
  full Active Next-Action Proposal (per
  `core/skills/_shared/references/session-handoff.md § Active Next-Action Proposal`
  meta/guard exception): the honest next step is `/orchestrator:plan <feature>`
  for a multi-deliverable macro (or `/engineer:start` for a single deliverable),
  sized to the work shape.
- **Exit 0, single path** -> continue with Phase 2.
- **Exit 1** -> per-branch duplicate or malformed-file fail-closed
  diagnostic. Surface stderr and stop. Do not pick a workflow yourself;
  branch-keyed duplicates are user-resolvable corruption.

---

## Phase 2 — Drift report

Read frontmatter and compare current git state against the macro's
`git_baseline`:

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A fresh shell: the workflow is found again here, never carried from Phase 1's
# block.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active orchestrator workflow; nothing to resume." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read \
  --workflow-path "$ACTIVE" > /tmp/orchestrator-resume-frontmatter.json || exit $?

CURRENT_BRANCH="$(git branch --show-current)"
CURRENT_HEAD="$(git rev-parse HEAD)"
CURRENT_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"

BASE_BRANCH="$(jq -r '.git_baseline.branch' /tmp/orchestrator-resume-frontmatter.json)"
BASE_HEAD="$(jq -r '.git_baseline.head' /tmp/orchestrator-resume-frontmatter.json)"
BASE_DIGEST="$(jq -r '.git_baseline.status_digest // ""' /tmp/orchestrator-resume-frontmatter.json)"
SUBTASK_COUNT="$(jq -r '(.plan.subtasks // []) | length' /tmp/orchestrator-resume-frontmatter.json)"
```

Drift is **clean** only when branch, HEAD, and status digest match
the baseline. Any mismatch is **dirty**. This command reports drift;
it does not auto-reconcile or rewrite the plan.

Render:

```text
Workflow: <ACTIVE>
  workflow_id:    <workflow_id>
  workflow_type:  macro
  command:        /orchestrator:plan
  current_phase:  <current_phase>
  subtask_count:  <N>
  drift:          clean | dirty
```

If `latest_checkpoint` is present, include:

```text
  last_checkpoint: <at> — <summary>
```

For dirty state, include native git probes when `BASE_HEAD` is an
available commit object:

```bash
git log "$BASE_HEAD..HEAD" --oneline
git diff --stat HEAD
git log --diff-filter=R --name-status "$BASE_HEAD..HEAD"
git log --diff-filter=D --name-status "$BASE_HEAD..HEAD"
```

Always print this dirty-state notice:

```text
current plugin does not auto-reconcile macro workflows; review and decide [resume / archive / abort]
```

---

## Phase 2b — Append resume marker

When the baseline commit object is available, append a resume marker.
Do not mutate `current_phase` or `next_action`.

The marker's note is text you write, so it reaches `state.mjs` as a file,
never as shell source (ADR-0059, amendment of 2026-10-10): a backtick or
`$(…)` in a block's source runs as a command.

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
   write `note.md` in that directory: a one-paragraph macro drift summary,
   ending with one newline. Write `workflow-id.txt` beside it too: the
   `workflow_id` the drift report showed, ending with one newline.

Then run the block with the path in its `TEXT_DIR` line and the drift class
in its label. The block finds the active workflow again and stops when it is
not the one the drift report described (the branch or its workflow changed
since): run Phase 2 again. `state.mjs` reads the note itself, removes its final newline,
and refuses an empty or missing file before it writes. The block releases the
directory once the marker is written (ADR-0059 Decision 10); a block that
stops keeps it for its rerun. No block runs `rm` (a headless run can deny it).

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A fresh shell: the workflow is found again here, never carried from an
# earlier block. A lookup that fails or finds none stops the block and keeps
# the directory.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active orchestrator workflow; nothing to resume." >&2; exit 1; }
# The workflow the drift report described, from the file the agent wrote: a
# marker on another one (the branch or its workflow changed since) would put
# this drift note on a macro it does not describe.
node -e 'let id;try{id=require("fs").readFileSync(process.argv[1],"utf8").replace(/\r?\n$/,"")}catch{process.exit(1)}process.exit(id!==""&&id===require("path").basename(process.argv[2],".md")?0:1)' "$TEXT_DIR/workflow-id.txt" "$ACTIVE" \
  || { echo "✗ workflow-id.txt in TEXT_DIR ($TEXT_DIR) is missing or names another workflow than $ACTIVE (the branch or its workflow changed since the drift report); run Phase 2 again. Nothing was written." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host claude \
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

If the baseline commit is unavailable, skip the marker and say why.

---

## Phase 3 — Archive Mode

Forms:

- `/orchestrator:resume archive` -> archive the single active macro
  workflow on the current branch.
- `/orchestrator:resume archive <workflow-id>` -> archive the named
  macro workflow: the file the block below prints, found in the
  orchestrator workflow homes of this checkout's read set (ADR-0067
  Decision 4, item 2), the default state root first; stop when it exits
  non-zero (no root holds it, or two files do).

For the named form:

The id reaches `state.mjs` as a file, never in the block: typed into shell
source, a quote, `$` or backquote in it would be read as code (ADR-0059,
C134(a)). Before the block:

1. Create a private directory for it, and note the path it prints:

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

2. With your file-writing tool (Claude: the Write tool), not the shell, create
   `workflow-id.txt` in that directory holding the id exactly as typed,
   ending with one newline.

Then run the block with that directory in its `ID_DIR` line;
`resolve-workflow` reads the id from the file itself, and refuses a missing
or empty file, or one holding more than the id, before it looks. Once it
prints the workflow, it releases the directory (ADR-0059 Decision 10): the
printed path is all a later step reads. A refusal keeps it for the rerun.

```bash
ID_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
if ! WORKFLOW="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id-file "$ID_DIR/workflow-id.txt")"; then
  echo "✗ The id in $ID_DIR/workflow-id.txt names no single macro file in the orchestrator workflow homes of this checkout's read set (the reason is above); nothing archived." >&2
  exit 1
fi
printf 'WORKFLOW=%s\n' "$WORKFLOW"
# ADR-0059 Decision 10, item 1 — the id is resolved and printed: no block,
# rerun or continuation reads the directory again.
RELEASE_PATH="$ID_DIR"
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

Confirm with the user before mutation. Show workflow id, current
phase, subtask counts, and path.

On confirmation, join the macro's run lock and archive (ADR-0067 Decision 4,
item 5): an autopilot run or another session holding the lock refuses,
naming the holder, and nothing is archived; the admission is released on
every exit, after the archive included.

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
MACRO_ID="$(basename "$WORKFLOW" .md)"
ADMISSION="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" admission join \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --command resume \
  --host claude --session-id "${CLAUDE_CODE_SESSION_ID:-}")" || exit 1
release_admission() {
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
}
trap 'release_admission' EXIT
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" archive \
  --workflow-path "$WORKFLOW" --host claude --repo-root "$REPO_ROOT"
```

Archive is a move to the `archive/` beside the macro, in its own home
(canonical or legacy, wherever the macro lives), not a delete. The state
CLI is collision-safe and idempotent.

---

## Completion

- `✓ Resumed orchestrator macro: <workflow_id> (drift=<clean|dirty>)`
- `✓ Archived orchestrator macro: <workflow_id>`
- `✗ No active orchestrator workflow; nothing to resume.`
- `✗ Per-branch duplicate detected — reconcile or archive stale macro workflows first.`

Always include the absolute workflow path.
