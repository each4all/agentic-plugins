The last write, `finish-verb`, records the lifecycle's next step in
closed-enum form, `--next-step-kind commit`: the owner saves and commits the
deliverable ({{persona}} runs no commit itself). It closes the workflow
`summary-complete`, and the code-emitted completion footer follows.

Its next action reaches `state.mjs` as a file, never in the block: in shell
source a quote, `$`, backtick or line of it would be read as code (ADR-0059,
amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `next-action.txt` in
   that directory, ending with one newline: the compact form of the proposal
   (selected_next + one-line why + next_command), which the footer surfaces
   verbatim as "recommended next work". The lifecycle's default is

   ```text
   {{next_action}}
   ```

   Nothing deletes the file.

Then run the block with `TEXT_DIR` set to that directory; a next action left
unwritten stops it before any write.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# The next action the agent wrote with its file tool: state.mjs reads it
# itself, so no line of it is shell source. A file left unwritten stops the
# block before any write.
grep -q '[^[:space:]]' "$TEXT_DIR/next-action.txt" 2>/dev/null || { echo "✗ next-action.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
# ADR-0029 §1 / completion-output contract §2 — write the COMPACT form
# (selected_next + one-line why + next_command) into --next-action; the
# code-emitted footer surfaces it verbatim as "recommended next work".
# ADR-0063 D3 — finish-verb is the lifecycle's last write: the ADR-0017
# §sub-decision 5 atomic terminal write (summary-complete + terminal marker)
# with the next step. ADR-0066 Decision 3: an inherited AGENTIC_AUTOPILOT
# changes nothing here.
# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
# archive gates are evaluated at the end of THIS turn, not at session close;
# if a gate fails the workflow stays marked and a later Stop re-evaluates it.
# Clearing the marker with `--terminal-marker false` works only before that
# Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
# --terminal-phase), and does not restore the previous phase or next_action.
# On Codex the Stop hook runs only once the operator has trusted the plugin
# hooks (`/hooks`), so evaluation waits for that. Full contract:
# core/skills/_shared/references/session-handoff.md § Archive timing.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --next-step-kind commit --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
```

The runtime completion footer is **code-emitted** on this terminal write
(ADR-0039): `finish-verb` takes
`set-terminal`'s path, which fires the ADR-0031 session-handoff sidecar; it
shells out to the runtime `footer.mjs` and prints the rendered footer —
context state, completion state (`publish-needed` while only the owner's save
and commit remain) + state-derived next action, workflow id/path, artifact
pointers, recommended next work, and the continue-vs-fresh session handoff —
on this command's **stderr**. The workflow is then terminal, and the Stop hook
archives it once every archive gate passes (here, once the owner's commit
moves HEAD); until then `/{{persona}}:start` on this branch finds it and
resumes it, so start the next deliverable after the archive, or on another
branch. Do **not** hand-compose a
second footer; surface the emitted one. It is advisory, pointer-only and
fail-closed (a missing or too-old runtime emits nothing, and the SessionStart
backstop still re-surfaces the handoff); it never mutates host session
context. On a detached HEAD the branch-based preflight reports "no active
branch context" and never recommends a fresh session (ADR-0018 §sub-2); the
path-targeted terminal sidecar renders the footer as on a branch, its
continue-vs-fresh advice included. Wiring details:
`core/skills/_shared/references/session-handoff.md`.
