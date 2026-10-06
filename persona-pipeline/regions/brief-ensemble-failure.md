Failure modes map to the JSON envelope `error.kind` values defined in
`companions/contract.md` § 5.3, plus per-claim malformed-output cases
that surface only after parsing the peer's content.

### Peer host CLI unavailable, not installed, or unauthenticated

- Detect: `error.kind ∈ {peer_cli_not_found, peer_unauthenticated,
  peer_invocation_error}`, OR `peer-runner.mjs run` returns no companion
  path (`peer_cli_not_found` equivalent at the discovery layer).
- Action: Proceed with local-only research, silently. A run the runner
  started settles as verdict `failed` with this `error_kind`
  (`peer-runner.mjs settle`); with no run launched there is nothing to
  settle.
- Surface: Mention in the user-facing completion summary that the
  ensemble was unavailable. Do NOT label findings inside the brief.

### Peer timeout or runtime error

- Detect: `status: peer_error` with `error.kind: peer_run_error`, OR the
  background dispatch exits unmappably (treated as
  `peer_invocation_error`).
- Action: Proceed local-only; settling the attempt records verdict
  `failed` with the ledger's `error_kind`.
- Surface: Same as above.

### Peer returns empty output

- Detect: Envelope `status: success` but `stdout` parses to no claims,
  only structural shell, or is missing the per-sub-question response
  blocks.
- Action: Treat as if the peer was unavailable. Proceed local-only;
  settling the completed attempt records verdict `degraded`. `settle` sees
  an empty or unreadable answer itself; an answer that parses to only
  structural shell reads to it like any other, so pass `degraded` as the
  synthesis verdict then.
- Surface: Same as above.

### Peer returns malformed partial output

- Detect: `stdout` is structurally valid but missing required fields for
  some claims (e.g., tier omitted, claim without conclusion, source-URL
  field empty).
- Action: Parse only the claims that pass structural validation (claim +
  conclusion + at least one retrievable source URL). Discard claims with
  unverifiable or empty source URLs. Continue with the salvageable subset.
- Surface: Mention in the completion summary that ensemble coverage was
  partial.

### Peer returns PEER-ONLY claim with no source URL

- Treat as malformed at the per-claim level (no source URL means nothing
  to verify).
- Discard the claim. Do NOT add it to Open Questions — there is nothing
  to follow up on.

### Graceful degradation principle

The brief is always assembled and saved on the local-only path. Ensemble
failure NEVER blocks save. The completion summary states the degradation;
the brief itself shows no ensemble-specific labels or markers — readers
of the brief should not be able to tell whether the ensemble ran at all.
