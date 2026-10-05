Locate the active workflow with `state.mjs find-active`:

- **Empty stdout** → no active workflow. Standalone mode: print the response
  from `$STDOUT_PATH` and skip the state mutation.
- **Single path** → append a `[Peer]` label phase note via `state.mjs append
  --phase-label "[Peer] $PEER consultation" --phase-note "<note>" --event
  updated`. Do NOT pass `--current-phase` / `--next-action`. Include
  `run_id: $RUN_ID` in the note; cap the appended excerpt at 4000 chars
  (`head -c 4000` on `$STDOUT_PATH`); print the full response to the user
  separately. Re-resolve `$STDOUT_PATH` / `$ACTIVE` if Phase 1 and Phase 2
  run in separate Bash calls.
- **Per-branch duplicate error** → reject with a hint pointing at the
  `resume` meta skill. Do NOT pick a workflow yourself.
