Locate the active workflow with `state.mjs find-active`:

- **Empty stdout** → no active workflow. Standalone mode: print the response
  from `$STDOUT_PATH` and skip the state mutation.
- **Single path** → append a `[Peer]` label phase note via `state.mjs append
  --phase-label "[Peer] $PEER consultation" --phase-note-file <note file>
  --event updated`. Do NOT pass `--current-phase` / `--next-action`. The
  note holds the peer's words, so it reaches `state.mjs` as a file, never on
  the command line (ADR-0059, amendment of 2026-10-10): with your
  file-writing tool, not the shell, write it as `note.md` in a private
  directory (`mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`), ending with
  one newline, and pass that file. Write the run's values into the note, not
  the variable names (the file tool expands nothing): `run_id: <id>` and
  `handle: <path>`, the `run_id` and `handle_path` of the run's result,
  `prompt.xml.run.json` in the dispatch's directory. Cap the appended excerpt
  at 4000 chars (the first 4000 of the file its `stdout_path` names); print
  the full response to the user separately. A Bash call carries no shell
  variable from the dispatch's: the call that appends finds the workflow with
  `find-active` itself, and reads the run from that result file. Append only
  when that file reads `ok: true`: any other result is a failed consultation,
  reported, with no note (R4 J3).
- **Per-branch duplicate error** → reject with a hint pointing at the
  `resume` meta skill. Do NOT pick a workflow yourself.
