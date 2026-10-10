The lifecycle's one terminal write is the Phase 7 commit driver,
`phase7-commit.mjs` (ADR-0028 §Layer-3): it computes the staging set from
`commit_manifest` ∩ `git_changes`, splits it per release-please package
(ADR-0016, P8), commits with the subject(s) the user confirmed, runs the
post-commit gates (P11 pending ensemble, no active children, clean after
commit, the P10 parent writeback), and writes `set-terminal` last (P5). No
`finish-verb` runs here.

Phase 7 never commits on its own (P6). It takes two steps, each its own
block: plan mode reads the workflow and git and suggests subjects; present
them to the user with [a]ccept / [e]dit / [c]ancel, and when the plan says
`ask_user` also confirm the staging set and its extras. The user picks one
of: the intersection only (the default, no extra flag); specific extras
opted back in (`--include-extra <path>` for each, PR4 A4); or the whole
working tree (`--accept-current-tree`, all or nothing). Then execute mode
commits with the subject(s) the user confirmed.

```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# A shell variable does not outlive a Bash call: unless ACTIVE is set, the
# workflow is the one find-active names on this branch.
if [ -z "${ACTIVE:-}" ]; then
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
fi
[ -n "$ACTIVE" ] || { echo "✗ No active workflow on this branch; Phase 7 has nothing to commit." >&2; exit 1; }
# Step 1 — plan mode: read the workflow and git, suggest subjects. It writes
# nothing.
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" \
  --mode plan \
  --workflow-path "$ACTIVE" \
  --repo-root "$REPO_ROOT" \
  --host "${AGENTIC_HOST:-claude}" || exit $?
```

The subject the user confirmed reaches the driver as a file, never in the
block: in shell source a quote, `$` or backtick of it would be read as code
(ADR-0059, amendment of 2026-10-10). Before the execute block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `subject.txt` in that
   directory holding the subject, one line ending with one newline. Nothing
   deletes it.

Then run the block with `TEXT_DIR` set to that directory. When the user
accepted the suggested subject as it stands, pass `--suggested-subjects`
instead of `--subject-file`, and no file is needed. When the plan splits the
commit across packages (`shouldSplit`), write one file per package
(`subject-1.txt`, `subject-2.txt`, …) and pass one
`--subject-pkg-file '<package path>'="$TEXT_DIR/subject-<n>.txt"` per package
instead of `--subject-file`, or `--suggested-subjects` for every suggestion;
the body (P1, with the P9 trailer allowlist) is shared by every per-package
commit. Add each extra the user opted in with `--include-extra
<path>`, or `--accept-current-tree` for the whole tree; when the bootstrap
accepted the current tree (`ACCEPT_CURRENT_TREE=1`), pass it again here, so
the driver stages all of `git_changes` rather than the intersection.

ARCHIVE TIMING — decide before running execute mode. The driver writes
`set-terminal` as its last step, and on Claude the Stop hook fires at every
turn end, so the archive gates are evaluated at the end of this turn, not at
session close. If the workflow must stay open past this turn, do not run
execute mode yet: clearing the marker afterwards works only before that Stop
fires and needs set-terminal's full flag set (`--workflow-path`, `--host`,
`--terminal-phase`). Full contract:
`core/skills/_shared/references/session-handoff.md` § Archive timing.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# A shell variable does not outlive a Bash call: unless ACTIVE is set, the
# workflow is the one find-active names on this branch.
if [ -z "${ACTIVE:-}" ]; then
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
fi
[ -n "$ACTIVE" ] || { echo "✗ No active workflow on this branch; Phase 7 has nothing to commit." >&2; exit 1; }
# Step 2 — execute mode: commit with the approved subject, which the driver
# reads from the file the agent wrote with its file tool before it writes
# anything, run the gates, then set-terminal. A failure leaves the workflow
# open (no terminal marker); the driver names the recovery on stderr: refine,
# then run this start command again, which resumes at Phase 7.
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" \
  --mode execute \
  --workflow-path "$ACTIVE" \
  --repo-root "$REPO_ROOT" \
  --host "${AGENTIC_HOST:-claude}" \
  --subject-file "$TEXT_DIR/subject.txt" \
  --confirm-non-interactive || exit $?
# On success the driver already ran the P10 parent writeback synchronously
# (for a macro subtask: a note on the macro, not its completion, which
# /orchestrator:done records after the merge, ADR-0062) and then wrote
# set-terminal; the Stop hook evaluates the archive gates (ADR-0017
# §sub-decision 5) and only retries the writeback idempotently, or backstops a
# driver that died between the two writes.
```

The runtime completion footer is **code-emitted** on this terminal path
(ADR-0039): `set-terminal` fires the ADR-0031 session-handoff sidecar, which
shells out to the runtime `footer.mjs` and prints the rendered footer —
context state, completion state + state-derived next action, workflow
id/path, artifact pointers, recommended next work, and the continue-vs-fresh
session handoff — on the commit command's **stderr**. Do **not** hand-compose
a second footer; surface the emitted one. It is advisory, pointer-only and
fail-closed (a missing or too-old runtime emits nothing, and the SessionStart
backstop still re-surfaces the handoff); it never mutates host session
context. On a detached HEAD the branch-based preflight reports "no active
branch context" and never recommends a fresh session (ADR-0018 §sub-2); the
path-targeted terminal sidecar renders the footer as on a branch, its
continue-vs-fresh advice included. Wiring details:
`core/skills/_shared/references/session-handoff.md`.
