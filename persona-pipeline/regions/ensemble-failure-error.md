- **Detect**: `status: peer_error` with `error.kind: peer_run_error`, or
  the background dispatch exits unmappably.
- **Action**: Proceed orchestrator-only; settling the attempt records
  verdict `failed` with the ledger's `error_kind`, and a review's attempt the
  outcome `failed`, or `malformed` for an envelope that cannot be parsed or
  has the wrong shape (C163 A1a).
- **Surface**: Same as above.
