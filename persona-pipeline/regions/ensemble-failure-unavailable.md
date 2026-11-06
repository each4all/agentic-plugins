- **Detect**: companion discovery returns empty (the `companions` plugin
  is not installed), or `error.kind ∈ {peer_cli_not_found,
  peer_unauthenticated, peer_invocation_error}`.
- **Action**: Proceed with orchestrator-only analysis, silently. A run the
  runner started settles as verdict `failed` with this `error_kind`
  (`peer-runner.mjs settle`), and a review's attempt as the outcome
  `unavailable`; with no run launched, the empty-id settle records no
  result, and its `peer-unavailable` reason (the finalize's `NO_RUN_REASON`,
  or `--no-run-reason` in `/start` and the Codex verb skills) records a
  review's attempt `unavailable` all the same (C163 A1a).
- **Surface**: Mention in the user-facing completion summary that the
  ensemble was unavailable. Do NOT label findings inside the saved
  artifact.
