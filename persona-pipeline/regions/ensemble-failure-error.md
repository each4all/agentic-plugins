- **Detect**: `status: peer_error` with `error.kind: peer_run_error`, or
  the background dispatch exits unmappably.
- **Action**: Proceed orchestrator-only; settling the attempt records
  verdict `failed` with the ledger's `error_kind`.
- **Surface**: Same as above.
