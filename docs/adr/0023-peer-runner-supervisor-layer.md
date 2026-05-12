# ADR-0023: Peer-runner supervisor layer for companion dispatch

## Status

Accepted (PR-A through PR-E shipped — [#80](https://github.com/each4all/agentic-plugins/pull/80) ADR text, [#81](https://github.com/each4all/agentic-plugins/pull/81) engineer primitive, [#82](https://github.com/each4all/agentic-plugins/pull/82) engineer command integration, [#83](https://github.com/each4all/agentic-plugins/pull/83) orchestrator mirror, PR-E peer-now operational controls)

## Context

`companions/contract.md` v0.1.1 intentionally defines a stateless,
single-shot wire contract:

- one `task` subcommand
- prompt input through `--prompt-file`, positional prompt text, or stdin
- output as raw text or one JSON envelope
- no contract-level streaming, timeout, retry, background-job, queue, or
  persistent-thread semantics

That boundary remains correct. Companions are the cross-host wire
adapters between Claude Code and Codex CLI; they should not grow into
workflow job managers.

The caller side has now outgrown pure blocking dispatch. During the
2026-05-12 `/engineer:start` dogfood run for this ADR, peer dispatches
regularly ran for minutes. While a peer was running, the current surface
exposed only a `pending_ensemble` frontmatter row and the parent process
session. There was no stable way for the agent to ask:

- is this peer run still alive?
- how long has it been running?
- has it produced stdout or stderr bytes?
- can I cancel it by `run_id`?
- will raw output files accumulate forever?

Current implementation points:

- `plugins/engineer/scripts/dispatch-peer.mjs` resolves a companion,
  optionally records `pending_ensemble`, materializes prompt text into a
  temp file, spawns the companion, buffers stdout/stderr in memory, waits
  for process close, validates the companion envelope, and deletes only
  its own temp prompt directory.
- `plugins/orchestrator/scripts/dispatch-peer.mjs` mirrors the engineer
  wrapper but intentionally differs in graceful-degradation ordering:
  orchestrator resolves the companion before recording pending state so
  missing companions do not create orphan pending rows.
- `plugins/engineer/scripts/state.mjs` stores workflow summaries in
  `.claude/agentic-engineer/workflows/<workflow_id>.md`, including
  `pending_ensemble` and `ensemble_results`. `ensemble_results` has a
  retention cap of 20 and is designed for retrospective verdict
  summaries, not raw operational logs.
- `/engineer:peer-now` is explicitly a side-channel. It sends a raw
  cross-host prompt and remains excluded from `ensemble_results`.
- `.claude/` is gitignored, so repo-local hidden state under
  `.claude/agentic-engineer/` can hold runtime data without polluting
  commits.

The design challenge is to add monitoring, cancellation, and bounded
retention while preserving the v0.1.1 companion contract and the
existing workflow-state separation.

## Decision

Introduce a **caller-side peer-runner supervisor layer**. The supervisor
is responsible for operational lifecycle concerns around peer dispatch:
run handles, status, cancellation, output logs, final result capture, and
ledger retention.

`companions/contract.md` v0.1.1 is unchanged.

### 1. Layer boundary

The responsibilities are split as follows:

| Layer | Responsibility |
|---|---|
| `companions/*-companion.mjs` | Stateless wire adapter. Accept `task`, forward prompt bytes to peer CLI, return raw text or generic JSON envelope. |
| `peer-runner.mjs` | Stateful caller-side supervisor. Spawn companion, track process handle, tee stdout/stderr to files, expose status/cancel/sweep, enforce retention. |
| `dispatch-peer.mjs` | Compatibility adapter for existing verb and meta command surfaces. It may continue using the blocking path until callers migrate; future managed paths delegate to peer-runner semantics. |
| `state.mjs` workflow frontmatter | Workflow summary and retrospective verdict state: `pending_ensemble`, `ensemble_results`, checkpoint, terminal/archive data. It does not store raw peer logs. |
| verb commands / meta commands | User- and agent-facing orchestration. They choose whether to call the legacy blocking path or the managed peer-runner path. |

The peer-runner is not a new companion contract. It is an implementation
layer inside the caller plugin.

Managed peer-runner execution spawns the resolved companion directly.
It must not shell out to `dispatch-peer.mjs` as its child process: doing
so would keep the current double-buffering behavior and hide the
companion process behind another wrapper. `dispatch-peer.mjs` may later
become a compatibility shim that invokes peer-runner, but the dependency
direction for managed execution is:

```text
caller command -> peer-runner -> companion -> peer CLI
```

not:

```text
caller command -> peer-runner -> dispatch-peer -> companion -> peer CLI
```

### 2. Ledger location

Engineer peer-run ledger state lives under:

```text
<repo>/.claude/agentic-engineer/peer-runs/<run_id>/
  handle.json
  stdout.log
  stderr.log
  envelope.json
  prompt.xml
```

Rules:

- `handle.json` is required.
- `stdout.log` and `stderr.log` are append-only while the run is active.
- `envelope.json` is written only when the companion was invoked with
  `--output-format json` and a final envelope exists.
- `prompt.xml` is optional debug/replay data. It is not retained by
  default for every run unless the caller explicitly requests prompt
  retention.
- Directories and files use the same privacy posture as workflow state:
  hidden repo-local files under `.claude/`, mode `0o700` for directories
  and `0o600` for files where the implementation controls creation.

Orchestrator mirror state, when implemented, uses the analogous path:

```text
<repo>/.claude/agentic-orchestrator/peer-runs/<run_id>/
```

### 3. ID policy

For verb-skill ensembles, the existing `run_id` is the peer-run ledger
directory name. Do not add a separate `peer_run_id` field to
`pending_ensemble` in the first implementation.

`peer-runner run` requires a caller-supplied `--run-id` for
`kind=ensemble` so the workflow pending row, ledger directory, and later
`ensemble-commit` operation share the same key. For `kind=peer-now` and
`kind=manual`, the runner may generate a run id when omitted, but it
must print the generated id in machine-readable status output.

This preserves ADR-0017's state model:

```yaml
pending_ensemble:
  - phase: compose
    ensemble_type: plan-verify
    run_id: plan-verify-20260512T090000Z-abcdef
    started_at: 2026-05-12T09:00:00Z
```

The ledger path for that entry is derived:

```text
.claude/agentic-engineer/peer-runs/plan-verify-20260512T090000Z-abcdef/
```

If a future workflow needs multiple peer runs for one ensemble result,
that is a new trigger for adding `peer_run_id` or a list of peer-run
references. ADR-0023 does not take that step.

For `peer-now`, the caller also supplies or receives a `run_id`, but
the run remains excluded from `ensemble_results`. The ledger can track
it operationally without changing the `peer-now` semantic contract.

### 4. Handle schema

`handle.json` starts with a versioned JSON schema:

```jsonc
{
  "schema_version": "1.0",
  "run_id": "plan-verify-20260512T090000Z-abcdef",
  "plugin": "engineer",
  "kind": "ensemble",
  "workflow_path": "<absolute path or null>",
  "phase": "compose",
  "ensemble_type": "plan-verify",
  "host": "claude",
  "peer_host": "codex",
  "model": null,
  "effort": null,
  "cwd": "<absolute cwd>",
  "output_format": "json",
  "status": "queued",
  "pid": null,
  "pgid": null,
  "process_fingerprint": {
    "kind": "none"
  },
  "started_at": "2026-05-12T09:00:00Z",
  "updated_at": "2026-05-12T09:00:00Z",
  "completed_at": null,
  "last_output_at": null,
  "stdout_bytes": 0,
  "stderr_bytes": 0,
  "exit_code": null,
  "error_kind": null,
  "prompt_retained": false
}
```

Allowed `kind` values:

- `ensemble`
- `peer-now`
- `manual`

Allowed `status` values:

- `queued`
- `spawning`
- `running`
- `completed`
- `failed`
- `cancel_requested`
- `cancelled`
- `orphaned`
- `pruned`

Allowed `process_fingerprint.kind` values:

- `macos_lstart_command` - derived from `ps` where available
- `linux_proc_starttime` - derived from `/proc/<pid>/stat` where
  available
- `none` - no reliable fingerprint is available

When the implementation cannot verify a process fingerprint, cancellation
must fail closed with an explicit `unsupported_unverifiable` reason
rather than risk killing a reused PID.

### 5. CLI surface

The initial peer-runner CLI surface is intentionally small:

```text
peer-runner run
peer-runner status
peer-runner cancel
peer-runner sweep
```

`result`, `list`, and `prune` are not separate initial subcommands:

- `status --json` can return the final envelope path and byte counts.
- `sweep --apply` can perform retention pruning.
- A richer query surface is deferred until a concrete agent workflow
  needs it.

### 6. Cancellation policy

`peer-runner cancel --run-id <id>` is explicit. Hooks must not
automatically cancel running peer work.

Cancellation sequence:

1. Load `handle.json`.
2. Verify the run is cancellable (`running` or `cancel_requested`).
3. Verify the process identity using the recorded fingerprint when
   available.
4. Send `SIGTERM` to the process group when `pgid` is known; otherwise
   send it to the recorded `pid`.
5. Wait `PEER_RUN_CANCEL_GRACE_MS = 10000`.
6. If still alive and still verified, send `SIGKILL`.
7. Mark the handle `cancelled` with exit/error metadata.

Cross-host cancellation means "called from the other local agent host in
the same repo checkout" (for example, Codex asks to cancel a run started
by Claude Code). Remote-machine cancellation is a non-goal. If the
local process cannot be verified or signaled from the current host, the
CLI returns an explicit unsupported reason.

### 7. Sweep and reconcile policy

`peer-runner sweep` reconciles ledger state. It does not call
`state.mjs commitEnsemble` in the initial implementation.

Invariant:

- The caller that launched a verb ensemble remains responsible for the
  normal `state.mjs ensemble-commit` call after synthesis.
- If `envelope.json` exists, it is the source of truth for the peer-run
  result. Sweep may mark the ledger `completed` or `failed` from it.
- If `envelope.json` exists while `pending_ensemble` still contains the
  matching `run_id`, sweep must not silently pop the pending row. It may
  surface `completed_uncommitted` in status output so `/engineer:resume`
  or a future repair command can guide the agent.
  `completed_uncommitted` is a derived status annotation, not a persisted
  `handle.json` status.
- If no live process exists, no envelope exists, and the run is older
  than `PEER_RUN_STALE_GRACE_MS = 60000`, sweep may mark the ledger
  `orphaned`.

Hook integration:

- Claude `session-start` and `pre-compact` may call sweep in reconcile
  mode.
- Claude `stop` may call sweep in prune/reconcile mode but must not
  auto-cancel active peer runs.
- Codex currently has a Stop helper only; Codex-side integration starts
  with the same no-auto-cancel sweep posture.

Use a shared helper such as `peer-runs-sweep.mjs` if hook reuse would
otherwise duplicate process and retention logic.

### 8. Retention policy

Workflow state and peer-run operational state have separate retention
rules:

- `ensemble_results` keeps its existing cap of 20 entries per workflow.
- peer-run ledger directories keep terminal runs for
  `PEER_RUN_RETENTION_TTL_DAYS = 14`.
- terminal peer-run directories are also capped at
  `PEER_RUN_RETENTION_CAP = 200` per plugin per repo, keeping the newest
  runs by `updated_at`.
- non-terminal runs are not pruned only because the cap is exceeded.
  Sweep must first reconcile them to a terminal state (`completed`,
  `failed`, `cancelled`, or `orphaned`) or leave them in place.

Dangling pointers are acceptable:

- A workflow summary may outlive its raw peer-run logs.
- If a workflow references a pruned ledger directory, readers display
  the summary and surface raw detail as pruned/unavailable.
- A ledger directory may outlive an archived workflow until ledger
  retention removes it.

### 9. Implementation roadmap

Implementation is split to respect ADR-0016 release-please routing and
the existing engineer/orchestrator mirror differences:

1. **PR-A: ADR only**
   - Add this ADR as `Proposed`.
   - Update ADR index.
   - No runtime code changes.

2. **PR-B: Engineer peer-runner primitive**
   - Add `plugins/engineer/scripts/peer-runner.mjs`.
   - Add helper path functions such as `peerRunsDir(repoRoot)` where
     needed.
   - Add tests covering handle schema, status transitions, stdout/stderr
     byte tracking, cancellation races with injected child processes,
     sweep idempotency, retention pruning, and `.claude/` hidden-state
     behavior.
   - Do not replace all command runbooks yet.

3. **PR-C: Engineer command integration**
   - Replace selected verb-command dispatch snippets with the managed
     `peer-runner run` path.
   - Keep `dispatch-peer.mjs` as compatibility surface while callers
     migrate.
   - Preserve `peer-now` exclusion from `ensemble_results`.

4. **PR-D: Orchestrator mirror**
   - Add the analogous orchestrator peer-runner or mirror changes.
   - Preserve orchestrator's resolve-before-record graceful-degradation
     ordering from its current `dispatch-peer.mjs`.

5. **PR-E: Optional peer-now operational controls**
   - Add status/cancel support for peer-now runs if user/agent workflows
     need it.
   - Keep peer-now out of `ensemble_results`.

### 10. Test acceptance matrix

Future implementation PRs must include tests for at least:

- `run` creates `handle.json` with `schema_version: "1.0"`.
- stdout/stderr byte counts and `last_output_at` update while data is
  captured.
- `envelope.json` wins over stale `running` status.
- cancel sends TERM then KILL after the grace interval using injected
  child processes.
- PID reuse/fingerprint mismatch fails closed.
- cancel-after-exit is idempotent and does not rewrite a successful
  result into cancelled.
- sweep marks no-envelope dead process as orphaned after the stale grace
  period.
- sweep does not call `commitEnsemble`.
- retention prunes terminal runs by TTL and cap while preserving
  non-terminal runs.
- pruned ledger directories degrade workflow summary display gracefully.
- peer-now managed runs remain excluded from `ensemble_results`.
- orchestrator mirror preserves resolve-before-record semantics.

## Consequences

**Positive**:

- Agents get a concrete status/cancel/sweep surface for long-running
  peer dispatch without changing the companion wire contract.
- Raw peer output retention becomes bounded and explicit instead of
  depending on temp files, shell redirection, or workflow body excerpts.
- Workflow frontmatter stays summary-oriented. `ensemble_results` remains
  a retrospective verdict surface rather than an operational log store.
- `peer-now` can gain operational tracking later without being promoted
  into structured ensemble bookkeeping.
- The first implementation can dogfood on engineer before the
  orchestrator mirror follows.

**Negative**:

- A new state directory and JSON schema are introduced under
  `.claude/agentic-engineer/`.
- There are now two related state lifecycles: workflow summaries and
  peer-run operational artifacts. Readers must tolerate dangling
  pointers after ledger pruning.
- Cancellation is platform-sensitive. Safe PID verification requires
  host-specific fingerprint logic and fail-closed behavior.
- Until command runbooks migrate, both the legacy blocking
  `dispatch-peer` path and the managed peer-runner path may coexist.

**Neutral**:

- `companions/contract.md` remains the same. The out-of-scope clauses
  for streaming, timeouts, retries, and background jobs continue to
  apply to the wire contract.
- ADR-0023 does not decide a user-facing dashboard. The surface is
  agent-facing CLI state, matching the hidden-state posture established
  by ADR-0011 and ADR-0017.
- Automatic semantic repair of `pending_ensemble` is deferred. Sweep
  reconciles ledger state but does not mutate workflow verdict state in
  the first design.

## Alternatives Considered

### Option A - Extend `dispatch-peer.mjs` in place

`dispatch-peer.mjs` would directly own status, cancellation, output
files, retention, and envelope validation.

**Rejected** because `dispatch-peer.mjs` already spans path resolution,
prompt materialization, pending registration, child spawn, buffering,
and envelope validation. Adding job-control semantics there would make
it both wire adapter and supervisor. It also would not create a clean
shared surface for future `peer-now` operational tracking.

### Option B - Store supervisor state in `pending_ensemble`

`pending_ensemble` entries would gain fields such as PID, stdout path,
stderr path, and cancellation state.

**Rejected** because `pending_ensemble` is workflow summary frontmatter,
not an operational ledger. It is also intentionally bypassed by
`peer-now`. Large raw output cannot live in YAML frontmatter, so this
option still needs external files while making workflow state carry
responsibility for process lifecycle.

### Option C - Add a daemon, MCP server, or socket service

A long-running local service would own all peer dispatch and expose
true streaming and immediate cancellation.

**Rejected for now** because it expands the runtime lifecycle too far:
daemon startup, socket cleanup, cross-host discovery, permission
boundaries, and persistent session semantics. The current need is
bounded local job supervision, not a new service architecture.

### Option D - Hooks-only stale cleanup

Keep dispatch as-is and only add hook-time cleanup of stale
`pending_ensemble` rows and old output files.

**Rejected** because it addresses file accumulation but not live
monitoring or explicit cancellation. The user/agent would still have no
`run_id`-based way to inspect an in-flight peer run.

### Option E - Expand `companions/contract.md`

Add `status`, `cancel`, `result`, and streaming output modes to the
companion contract itself.

**Rejected** because the existing contract explicitly excludes
background jobs, streaming, timeouts, and persistent threads. Those
semantics require timing, lifecycle, and state guarantees that belong
above the stateless wire adapter. A future ADR may expand the companion
contract only after caller-side supervisor needs are proven insufficient.
