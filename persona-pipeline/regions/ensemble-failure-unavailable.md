- **Detect**: companion discovery returns empty (the `companions` plugin
  is not installed), or `error.kind ∈ {peer_cli_not_found,
  peer_unauthenticated, peer_invocation_error}`.
- **Action**: Proceed with orchestrator-only analysis, silently. A run the
  runner started settles as verdict `failed` with this `error_kind`
  (`peer-runner.mjs settle`); with no run launched there is nothing to
  settle.
- **Surface**: Mention in the user-facing completion summary that the
  ensemble was unavailable. Do NOT label findings inside the saved
  artifact.
