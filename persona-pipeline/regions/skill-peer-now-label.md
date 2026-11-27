Locate the active workflow with `state.mjs find-active`:

- **Empty stdout** → no active workflow. Standalone mode: print the response
  from `$STDOUT_PATH` and skip the state mutation; then release the
  dispatch's directory with the release block below (ADR-0059 Decision 10).
- **Single path** → append a `[Peer]` label phase note via `state.mjs append
  --phase-label "[Peer] $PEER consultation" --phase-note-file <note file>
  --event updated`. Do NOT pass `--current-phase` / `--next-action`. The
  note holds the peer's words, so it reaches `state.mjs` as a file, never on
  the command line (ADR-0059, amendment of 2026-10-10): with your
  file-writing tool, not the shell, write it as `note.md` in the dispatch's
  directory, ending with one newline, and pass that file. Once the append
  succeeded, release that directory with the release block below (ADR-0059
  Decision 10); a failed append keeps it for the retry. Write the run's values into the note, not
  the variable names (the file tool expands nothing): `run_id: <id>` and
  `handle: <path>`, the `run_id` and `handle_path` of the run's result,
  `prompt.xml.run.json` in the dispatch's directory. Cap the appended excerpt
  at 4000 chars (the first 4000 of the file its `stdout_path` names); print
  the full response to the user separately. A Bash call carries no shell
  variable from the dispatch's: the call that appends finds the workflow with
  `find-active` itself, and reads the run from that result file. Append only
  when that file reads `ok: true`: any other result is a failed consultation,
  reported, with no note (R4 J3).
{{#capability dispatch_target}}
  Append only to the workflow the dispatch kept in its directory as
  `prompt.xml.workflow` (empty for none): a workflow found now that the
  consultation was not for gets no note. When the dispatch's directory holds
  `op`, the operation directory the dispatch opened the consultation's
  operation in, pass `--operation-dir <that directory>/op --close-operation
  true` with the append: the note is its last write (ADR-0068 Decision 2,
  item 7).
{{/capability}}
- **Per-branch duplicate error** → reject with a hint pointing at the
  `resume` meta skill. Do NOT pick a workflow yourself.

The release block, once the response is printed (standalone) or the append
succeeded: the response stays in the run ledger, at the result's
`stdout_path`, so read it from there after this block, never from the
directory. Fill `<plugin-root>` with this plugin's installed root, the path
you read this SKILL.md from, cut before its `/core/skills/` directory. A
failed consultation, or a failed append, keeps the directory: its
`prompt.xml.err`, or the append's retry, reads it.

```bash
DISPATCH_TEXT_DIR='<the directory the dispatch ran with>'
case "$DISPATCH_TEXT_DIR" in
  ''|'<'*) echo "✗ DISPATCH_TEXT_DIR is empty or not filled in; nothing was released." >&2; exit 1 ;;
esac
# ADR-0059 Decision 10, item 1 — the response is printed or the note
# appended: no block, rerun or continuation reads the directory again.
RELEASE_PATH="$DISPATCH_TEXT_DIR"
{{> tmpdir-release-skill}}
```
