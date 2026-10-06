- **Detect**: `status: peer_error` with `error.kind: peer_run_error`, or
  the background dispatch exits unmappably.
- **Action**: Record the failure mode internally; proceed
  orchestrator-only.
- **Surface**: Same as above.
