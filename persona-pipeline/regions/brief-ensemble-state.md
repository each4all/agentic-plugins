The {{brief_profile}} profile writes phase notes through {{persona}}'s
persistent workflow `.md` via `state.mjs`:

- The command-mode flow records the ensemble in the phase note it
  appends through `state.mjs append` after synthesis: the launch marker
  and the synthesis verdict, a body-level audit trail of which ensemble
  ran at what time and what it concluded, in human-readable form.
- The brief artifact itself (the saved `{{brief_file}}`) remains the
  durable artifact; even if the workflow `.md` is archived later, the
  brief is preserved at its `<root>/YYYY-MM-DD_<topic-slug>/` location.

In-flight peer dispatches do NOT survive session compaction as a task:
the background task and its notification belong to the session that
launched it, although the detached companion process may still be
running. The schema-1.x `pending_ensemble` field records that a dispatch
began (`run_id` + `started_at`). The launch marker is written with the
synthesis, so a session that compacts while the peer runs finds the
`pending_ensemble[]` entry with the matching `run_id`, not a phase note;
it cannot collect the original background task.

Inspect that run before dispatching again:
`peer-runner.mjs status --run-id <run_id> --json` reports its `status`,
`live`, `derived_status` and `paths.envelope` (the status JSON, not the
run result Step 2 reads):

- `live: true` — the companion is still running, and no notification
  will reach this session: cancel it (`peer-runner.mjs cancel --run-id
  <run_id>`) before a retry, or proceed local-only.
- `derived_status: completed_uncommitted` — the companion finished and
  wrote its envelope while the workflow still holds the pending entry:
  read `paths.envelope` as Step 2 item 3 reads `envelope_path`, then
  settle it with `state.mjs ensemble-commit`, with no new dispatch.
- Otherwise the run ended without an envelope to use: proceed local-only,
  or retry.

A retry takes a fresh run id, since the runner refuses a `run_id` whose
ledger already exists. The old pending entry stays until
`state.mjs ensemble-commit` settles its `run_id`: settle it with a
verdict that says the run was abandoned, whether the step retries or
proceeds local-only.

Workflow re-entry uses {{persona}}'s own continuity — `scripts/state.mjs`
restores the workflow `.md`'s tasks frontmatter and current_phase per
ADR-0011 §5; the {{brief_profile}} profile inherits that without
profile-specific wiring.
