1. Wait for the background dispatch notification — do NOT poll, sleep,
   or proactively check status.
2. Read the peer-runner JSON first. Its `status` (`completed`, `failed`
   or `cancelled`), `error_kind` and `envelope_path` describe the run,
   not the peer's answer. When `envelope_path` is null there is no
   envelope to read, and the run degrades to local-only: `error_kind`
   says why — `peer_cli_not_found` (no companion resolved),
   `envelope_parse_error` (the companion's stdout was not JSON), or a
   spawn, signal or cancel kind.
3. Otherwise read `envelope_path` for the parsed companion envelope. Its
   keys are pinned by `companions/contract.md` § 4.2:
   `{status, peer_host, peer_model, stdout, exit_code, [error, metadata]}`;
   an envelope the runner marked `error_kind: envelope_shape_invalid`
   breaks that contract (a missing or mistyped key, or a `status` that
   disagrees with its `exit_code` or `error`) and is malformed, with no
   answer to parse. Classify by the envelope's
   `status`:
   - `success` → proceed to peer-claim parsing.
   - `peer_error` (`error.kind: peer_run_error`) → treat as peer
     malformed-or-empty (see "Failure Handling").
   - `companion_error` with `error.kind ∈ {peer_cli_not_found,
     peer_unauthenticated, peer_invocation_error}` → peer infrastructure
     unavailable; degrade to local-only.
   - `companion_error` with `error.kind: companion_misuse` → adapter
     bug; surface as a runtime error (NOT a degradation case — it
     indicates the dispatcher constructed an invalid invocation).
4. The peer's `stdout` is the structured answer to the {{ensemble_type}}
   prompt: claims and sources for each sub-question. Parse against the
   Normalized Claim Shape below.
5. If the peer failed in any failure-mode, record the failure internally
   and proceed to Synthesize with local-only findings. Mention
   degradation in the user-facing completion summary AFTER the brief is
   saved — never as a finding label inside the brief artifact.
