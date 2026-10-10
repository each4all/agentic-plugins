The lifecycle's last write, `state.mjs finish-verb`, records its next step in
closed-enum form, `--next-step-kind commit`: the owner saves and commits the
deliverable ({{persona}} runs no commit itself). It closes the workflow
`summary-complete` and sets the terminal marker. The next action shown is the
lifecycle's default; when the result selects another, write the compact form
of the proposal instead (selected_next, a one-line why, next_command), which
the footer shows as recommended next work.

The next action is text, so it reaches `state.mjs` as a file, never on the
command line: in shell source a quote, `$` or backtick of it would be read as
code (ADR-0059, amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `next-action.txt` in
   that directory, ending with one newline. The lifecycle's default is

   ```text
   {{next_action}}
   ```

   Nothing deletes the file.

Then run the block with `TEXT_DIR` set to that directory.

```bash
TEXT_DIR='<directory from step 1>'
# ADR-0063 D3 — finish-verb is the lifecycle's last write: the ADR-0017
# §sub-decision 5 atomic terminal write (summary-complete + terminal marker)
# with the next step, kind commit (the owner saves and commits).
# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
# archive gates are evaluated at the end of THIS turn, not at session close;
# if a gate fails the workflow stays marked and a later Stop re-evaluates it.
# Clearing the marker with `--terminal-marker false` works only before that
# Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
# --terminal-phase), and does not restore the previous phase or next_action.
# On Codex the Stop hook runs only once the operator has trusted the plugin
# hooks (`/hooks`), so evaluation waits for that. Full contract:
# core/skills/_shared/references/session-handoff.md § Archive timing.
node "<plugin-root>/scripts/state.mjs" finish-verb \
  --workflow-path "$ACTIVE" --host <claude|codex> \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --next-step-kind commit --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
```

The runtime completion footer is **code-emitted** on that terminal write
(ADR-0039): its completion state is
`publish-needed` while only the owner's save and commit remain, since
{{persona}} runs no commit itself.
The write fires the session-handoff sidecar, which renders the runtime
`footer.mjs`, the ADR-0031 continue-vs-fresh session handoff included, on that
command's stderr. It is advisory and pointer-only, and never mutates host
session context. The workflow is then terminal, and the Stop hook archives it
once every archive gate passes; until then `/{{persona}}:start` on this branch
finds it and resumes it, so start the next deliverable after the archive, or
on another branch. Do not hand-compose a second footer or hand-pass the
projection; surface the emitted one. On a detached HEAD the branch-based
preflight reports "no active branch context" and never recommends a fresh
session (ADR-0018 §sub-2); the path-targeted terminal sidecar renders the
footer as on a branch, its continue-vs-fresh advice included.
`${{persona}}:start` on Codex surfaces the footer as `/{{persona}}:start`
does. Wiring: `core/skills/_shared/references/session-handoff.md`.

On Claude the Stop hook fires at **every turn end**, so that terminal write puts
the workflow in front of the archive gates at the end of **that same turn**, not
at session close — it archives then if every gate passes, and otherwise stays
marked for a later Stop to re-evaluate. Clearing the marker
(`--terminal-marker false`, with set-terminal's full flag set) works only before
that Stop fires and does not restore the previous phase. On Codex the hook runs
only once the operator has trusted the plugin hooks (`/hooks`), so evaluation
waits. Full contract: `core/skills/_shared/references/session-handoff.md`
§ Archive timing.
