1. Wait for the background dispatch notification — do NOT poll, sleep,
   or proactively check status.
2. Read the peer-runner JSON first. Its `status` (`completed`, `failed`
   or `cancelled`), `error_kind` and `envelope_path` describe the run,
   not the peer's answer. When `envelope_path` is null there is no
   envelope to read, and the run degrades to local-only: `error_kind`
   says why — `peer_cli_not_found` (no companion resolved),
   `envelope_parse_error` (the companion's stdout was not JSON), or a
   spawn, signal or cancel kind. Diagnose it from `stdout_path` /
   `stderr_path`.
3. Otherwise read `envelope_path` for the parsed companion envelope. Its
   keys are pinned by `companions/contract.md` §4.2:
   `{status, peer_host, peer_model, stdout, exit_code, [error, metadata]}`;
   an envelope the runner marked `error_kind: envelope_shape_invalid`
   breaks that contract (a missing or mistyped key, or a `status` that
   disagrees with its `exit_code` or `error`) and is malformed, with no
   answer to parse. Classify by the envelope's
   `status`: `success` → parse the peer answer;
   `peer_error` (`error.kind: peer_run_error`) → peer malformed/empty;
   `companion_error` with `error.kind ∈ {peer_cli_not_found,
   peer_unauthenticated, peer_invocation_error}` → degrade to local-only;
   `companion_error` with `error.kind: companion_misuse` → adapter bug,
   surface as a runtime error (not a degradation case).
4. If the peer failed or returned empty output, proceed to Synthesize
   with orchestrator-only results (graceful degradation, see *Failure
   Handling*). Either way the finalize settles the attempt from its run
   ledger (`peer-runner.mjs settle`), which records what the ledger shows:
   verdict `failed` with its `error_kind`, `degraded` for a completed run
   with no usable answer, or the synthesis verdict. The ledger shows an
   empty or unreadable answer; for one that parses to nothing usable, only
   structural shell, the synthesis verdict is `degraded`.
