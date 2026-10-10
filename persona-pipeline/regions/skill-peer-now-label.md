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
  one newline, and pass that file. Include `run_id: $RUN_ID` and `handle:
  $HANDLE_PATH` in the note; cap the appended excerpt at 4000 chars (the
  first 4000 of `$STDOUT_PATH`); print the full response to the user
  separately. Re-resolve `$STDOUT_PATH` / `$ACTIVE` if
  Phase 1 and Phase 2 run in separate Bash calls.
- **Per-branch duplicate error** → reject with a hint pointing at the
  `resume` meta skill. Do NOT pick a workflow yourself.
