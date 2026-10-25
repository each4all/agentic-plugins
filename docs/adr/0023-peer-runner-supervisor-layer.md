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

(2026-10-19: a run whose companion is gone and whose runner its host killed
before its cleanup, and the end of the companion's whole group, are in the
amendment of that date, C142.)

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

## Amendment 2026-10-13 — a codex peer runs in a snapshot of the checkout (C96)

**Why.** A codex peer asked only to read a diff was measured tidying the
working tree it was pointed at (`git checkout -- .`, `git clean`): the
caller's uncommitted edits were reverted and its untracked files deleted.
The peer's `--cwd` was the live checkout, and nothing between the runner
and the peer stood in the way. The persona dispatchers that spawn a
companion, `peer-runner.mjs` and `dispatch-peer.mjs`, now give a codex peer a
snapshot instead (`scripts/lib/peer-snapshot.mjs`, generated from
`persona-pipeline/`). A claude peer keeps the directory it is given: the
measured behaviour is codex's.

**Capture.** With the caller's git selectors removed (`GIT_DIR`,
`GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`,
`GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_PREFIX`,
`GIT_CEILING_DIRECTORIES`), hooks and fsmonitor off: HEAD is read; the
worktree's own index is copied twice; tree I is written from the first copy
(an unmerged index fails the snapshot); tree W is the second copy after
`add -A` (`.gitignore` respected) with the state homes
(`.agentic-plugins/state`, `.claude/agentic-*`) removed; HEAD is read again,
and a capture HEAD moved under is taken once more, then fails. The live
index and working tree are only read.

**Materialize.** In a `mkdtemp` directory outside the checkout (the system
temporary directory, or `/tmp` when that lies inside the checkout or its
path holds a character XML escapes, `&<>"'`), an owner
record is written first, then `git worktree add --detach --no-checkout
--lock --reason "peer-snapshot v1 <dir>/owner.json" <dir>/tree <HEAD>` (an
unborn HEAD, as in runtime doctor's proof repository, gets `--orphan` on a
throwaway branch name, which needs git 2.42), `read-tree -u --reset W`,
`read-tree I`, and the intent-to-add entries and assume-unchanged /
skip-worktree flags are replayed, so `status`, `diff` and `diff --cached`
there read as in the checkout. The peer's `--cwd` is the snapshot's copy of
the directory it was given. The companion reads a private copy of the prompt
in which every absolute path of the checkout's toplevel, in each spelling
the caller used, raw or XML-escaped, is rewritten to the snapshot (whose
root needs no escaping); outputs stay in the live
ledger. The handle gains an additive `snapshot` record (isolation, reason,
root, peer_cwd, head, index_tree, worktree_tree, owner_path, removed_at,
cleanup_error, prompt_paths_rewritten); schema 1.0 is unchanged.

**Lifecycle.** The snapshot is removed on every end — completed, failed,
cancelled, thrown, a signal to the CLI (SIGINT, SIGTERM, SIGHUP: the peer's
process group is stopped, the ledger records `cancelled`, the CLI exits
128+n; a signal that comes after the run's terminal write leaves the run as
it ended, and the exit code follows the ledger) — after anything left of the
peer's process group is stopped, by `git worktree remove -f -f` (which takes
a locked worktree and one whose directory is gone), the owner record last
and only once the rest is gone, so a snapshot that could not be removed
whole is found and retried by a later reclaim. A cleanup failure is
recorded in `snapshot.cleanup_error` and reported, and never changes the
run's status. A run that throws (an unreadable prompt, a ledger write that
fails) ends its ledger `failed` with the error's code. Whether a run is
cancelled is decided inside the serialized write of its terminal record,
and its process control (the owner record, the cancellation, the exit watch)
is armed by the update that records the running peer whether or not the
ledger takes that write; once the run has ended, a cancellation signals
nothing of it.
`dispatch-peer.mjs` now spawns the companion in its own process group, so
the signal runtime doctor's timeout sends the wrapper reaches the whole
peer. A signal also stops a capture still running (each git call that can
be cancelled runs in its own process group, which is stopped whole, filters
included, before the call returns; what was made is removed), so a slow
filter cannot hold a cancellation. Whatever the peer, nothing of its process group outlives the
run: a child the companion leaves behind is stopped at the end, and one that
holds the companion's stdout or stderr open — which would hold the run's
wait for the pipes to close — is stopped a second after the companion
itself exits. A codex peer never inherits the caller's git selectors, in a
snapshot or not.

**Reclaim.** Each isolated run, and `peer-runner sweep`, first removes this
repository's snapshots whose owners are gone: a worktree locked with the
`peer-snapshot v1` reason naming the owner record beside it, whose
supervisor (the run that made it) and companion (pid, group and
fingerprint, recorded once it runs) are both gone or replaced by another
process. A live peer outliving a killed supervisor keeps its snapshot until
it ends, and so does a live companion group whose leader has exited, however
old the record (only a group under a pid another process now has is judged
by age). A verdict to reclaim is checked against the owner record read
again, since the supervisor may have written it before it died. The owner
record marks the launch just before the companion is
spawned, so a supervisor that dies between the spawn and the companion's
record leaves a snapshot that is judged like an identity that cannot be
told: it, an unreadable owner record, and any identity that cannot be told
are reclaimed only after 24 hours. A snapshot directory an interrupted
creation left (an owner record naming this repository by its common git
directory, so from any of its worktrees; no worktree) is reclaimed the same
way, with the throwaway branch its record names.

**Failure.** A snapshot that cannot be made fails the run before a
companion is spawned — running the peer in the live tree instead is the
failure this prevents: the ledger ends `failed` with `error_kind:
snapshot_failed`, `exit_code` null and `snapshot.reason`, and `settle`
records verdict `failed`; `dispatchPeer` returns `{ ok: false, status:
'companion_error', kind: 'snapshot_failed', exitCode: 3, envelope: null }`.
A directory with no `.git` in any ancestor is no checkout and runs as before
(`snapshot.isolation: none`).

**The state guard.** The ADR-0067 write guard reads every worktree of the
repository; a snapshot carries no state home, so it is no second copy of
any record and a live workflow stays writable while one exists.

**Limits.**

- Ignored files (`node_modules`, build output) are not in the snapshot, so
  a peer cannot run what needs them; submodules are not initialized there.
- Clean and smudge filters (LFS) run when the snapshot is materialized.
- A tracked absolute symlink into the checkout still points at it.
- A host sandbox that grants the peer more writable roots, or full access,
  can still write the live tree by absolute path; the snapshot removes the
  default route, not every route.
- Assume-unchanged and skip-worktree entries carry their index bytes, not
  their working-tree bytes.
- Shared refs (`main`) may move while a review runs; the snapshot pins
  HEAD only.
- A peer-now answer comes from the snapshot: files the peer writes are
  discarded with it.
- Image dispatch is not isolated (its peer writes the image output), and
  the orchestrator's copies of both dispatchers follow in their own change
  (2026-10-14: they did; see the next amendment).
- The handle's updates are serialized within one runner process only: a
  `cancel` from another process that lands between an update's read and
  its rename can still be overwritten (C139, present before this change).

## Amendment 2026-10-14 — the orchestrator's peers run in a snapshot too (C96)

**What.** `plugins/orchestrator/scripts/peer-runner.mjs` and
`dispatch-peer.mjs` take the 2026-10-13 change as the persona copies have
it: the same capture, materialization, prompt rewrite, lifecycle, reclaim,
`snapshot_failed` outcome, cancellation and exit-linger rules, the CLI
signal handling (128+n) and `--cancel-grace-ms`, and the `queued` rule
of reconcile (a `queued` ledger whose handle has not moved for the stale
grace is orphaned: a run is `queued` while its snapshot is captured, so a
runner killed then leaves a ledger only this rule ends). The libraries are
copies, not imports (ADR-0010 §5): `plugins/orchestrator/scripts/lib/`
holds `peer-snapshot.mjs` and `process-identity.mjs`, each the
`persona-pipeline/` source byte for byte under a three-line copy notice,
and `tests/scripts/test-orchestrator-peer-snapshot-parity.mjs` fails when a
copy drifts. So one owner-record schema, worktree lock reason and reclaim
rule hold across the four plugins, and a reclaim run by any of them judges
the others' snapshots the same way. `lib/run-locks.mjs` imports
`isProcessAlive` and `fingerprintsMatch` from `process-identity.mjs`
and re-exports them: one definition for the run locks, the runner and the
snapshot's owner record.

**The orchestrator's order is kept.** Both dispatchers still resolve the
companion before anything is recorded. With no companion, `run` returns
`peer_cli_not_found` with every path null and writes no ledger, no
`pending_ensemble` row and no snapshot, and reclaims none: the reclaim, like
the capture, comes after the resolution. With one, the order is the
persona's from the ledger on (ledger, handle, prompt, pending row, snapshot,
spawn). A `snapshot_failed` run therefore has its pending row recorded; the
plan runbooks (`commands/plan.md`, `core/skills/plan/SKILL.md`) commit
the ensemble result of any run that launched and did not complete
(`failed`, `cancelled` or `orphaned`) as `failed`, its `error_kind` in
the summary, while `plan-set` keeps the local synthesis's verdict. The
orchestrator has no `settle`. `peer-runner sweep` reclaims snapshots
before it scans the ledgers, so a scan that refuses (two homes holding
ledgers) does not keep them.

**Limits**, beyond those of the 2026-10-13 amendment:

- A state home that is tracked or staged would be restored into the
  snapshot by `read-tree I` (or by a peer's `checkout -- .`), and the
  ADR-0067 write guard would then read it as a second copy. This repository
  ignores `.agentic-plugins/state/`; a repository that tracks it is not
  covered.
- A run is `queued` while its snapshot is captured, and the `queued` rule
  judges it by staleness alone: a capture that takes longer than the stale
  grace (a slow clean filter, say) is orphaned by a concurrent sweep, and a
  retention that then prunes the ledger fails the run. The persona runners
  have the same rule; a capture heartbeat, or a supervisor recorded on the
  queued handle, belongs in the shared source and in both copies at once.
- The capture's own git processes, and the filters they run, are in no
  owner record, and a runner killed outright (SIGKILL) while it captures
  does not take them with it (a cancellable call runs in a process group of
  its own, which only the runner stops): they keep running, and a
  reclaim, finding the supervisor gone and no companion recorded, removes
  the snapshot directory, an unfinished one included (its temporary
  indexes, before the worktree exists), while they still use it. The
  persona runners have the same rule; recording the capture's process
  group in the owner record belongs in the shared source, and the
  orchestrator copy then follows it.
- On macOS a process's fingerprint is its `ps -o lstart=` text, which
  follows the caller's locale (measured: one process reads
  `Wed Oct 14 10:31:38 2026` under `LC_ALL=C` and a Korean date under
  `ko_KR.UTF-8`): a reclaimer running under another locale
  than the run that recorded it would read a live supervisor as replaced.
  The fix belongs in the shared source, `persona-pipeline/`, with the
  persona releases it brings; the orchestrator copy then follows it.

## Amendment 2026-10-19 — a run its host killed before its cleanup (C142)

**Why.** `engineer-peer-snapshot-*` directories were found left in the
temporary directory (2026-10-17, five during autopilot run `6f6884`, whose
steps ended with exit 143; 2026-10-19, one more). The 2026-10-13 lifecycle
holds when the runner gets to run its end, and measured on Claude Code
(2.1.303, macOS) it does not always: a background task the host ends (its
step closed on a report, or aborted) gets SIGTERM to each of its processes,
the companion included, and SIGKILL about 1.5 s later. A runner still
stopping a peer that takes longer is killed before its cleanup: its snapshot
and locked worktree stay, and its handle stays `cancel_requested`. The Bash
tool starts each command in a process group of its own, so the autopilot
worker's group signals and its 5 s grace never reach the runner. `cancel`
then answered `not_running`, wrote nothing and removed nothing; `settle`
refused the run for the stale grace; and the next codex dispatch's reclaim,
or a `sweep`, removed the snapshot only when there was one (none after a
macro's last step, or after an interactive session ends).

**Who finishes such a run.** Whoever finds it: the next dispatch's reclaim
and `sweep` as before, and now `cancel` and `settle`, each for that one run's
snapshot only, never a scan of the repository's. They act only on a run
proven over: `snapshotEnded` (`lib/peer-snapshot.mjs`) reads the run's owner
record and answers `ended` when its supervisor is gone (no process has its
pid), nothing of its
companion's group runs (or nothing was launched) and no process runs in its
tree (below); `alive` when the
supervisor or a process of that group runs; `unknown` otherwise (no record,
a record naming no supervisor or another run, or a companion without its pid
or with a group it does not lead (the runner starts it as its group's
leader), an identity that cannot be told, a group alive under a companion
pid whose process cannot be told, a group alive whose leader is gone while
none of its processes runs in the run's tree (below), a launch never named,
a pid past the range a pid takes, or init's pid 1). The run's handle, which the runner writes apart from the
record, is checked against it: a record that omits the companion the handle
names, or names another, is `unknown` (`owner-incomplete`) whatever its
`launched_at` says, since the runner records the same process in both
(fourth review, 2026-10-19, reproduced by the peer: a record with no
companion and no launch read `ended` while a child of the handle's group
ran). The runner keeps that process on the handle (`peer_process`, its pid
and group) past the writes that clear `pid` and `pgid` (its end, a cancel,
an orphan write), so a repeat `settle` and a terminal run's `cancel` check
against it too (refine-verify, 2026-10-19, reproduced by the peer: a repeat
settle removed the snapshot the first had kept). A handle an earlier runner
wrote has no `peer_process`: `settle` then checks against its `pid` and
`pgid` as read before its reconcile. Every judgment and every group signal
reads the handle's process one way (`handlePeerProcess`): `peer_process`,
else `pid` and `pgid`. A field present that is not a pid in 2..2^31−1, a
group its pid does not lead, a pid without its group (except on Windows,
where the companion leads none), a `peer_process` that names no pid, or
`pid`/`pgid` that disagree with `peer_process`, is a handle the runner did
not write: the run is `unknown`
(`handle-malformed`) and no group of it is signalled, where such a field was
read before as naming no process and so skipped the check it should feed
(fifth review, 2026-10-19, reproduced by the peer: a numeric-string `pgid`
let a run be finished while its group ran). A supervisor pid
a process has under another fingerprint is one that cannot be told, not one
gone: a recorded fingerprint that is incomplete or of a kind the platform
does not take reads as another, and so does a macOS `lstart` read under
another locale or time zone than the runner's (the 2026-10-14 limits), the
runner alive (third review, 2026-10-19, reproduced end to end). A pid truly
reused is left to the reclaim. A record judged `ended` is read again, as the
reclaim's is, since a supervisor may have written it before it died. Unlike
the reclaim's judgment, no age counts: a dead supervisor is still no proof that its
companion's group stopped, and a supervisor that lives or cannot be told
still owns its run and its cleanup.

The supervisor the handle keeps (its snapshot record's, below) is read the
same way (`handleSupervisor`) and checked against the record's: a record
naming another supervisor, by pid or fingerprint, is `owner-incomplete`,
since the runner copies one onto the other; a kept supervisor that is
`null`, names no pid in 2..2^31−1 or no fingerprint, or is absent beside a
`peer_process`, is `handle-malformed`. Only a handle with neither, an earlier
runner's, is judged on the record alone (sixth review, 2026-10-20, reproduced
by the peer: a record naming an exited supervisor let a cancel finish a run,
and remove its snapshot, while the handle's supervisor ran). Nor is a run
`ended` while any process the user can see runs in its tree (`treeOccupancy`:
Linux reads every `/proc/<pid>/cwd`, macOS `lsof -d cwd` over every process).
A process the companion starts in a group or session of its own outlives the
companion's group there, and the removal would delete the worktree under it
(sixth review, 2026-10-20, reproduced by a local reviewer: a detached child
ran on in the removed tree; that the installed codex starts some of its
children so is an inference from its binary). Such a run is `unknown`
(`tree-occupied`) and nothing is signalled, since a location proves no
ancestry; processes that cannot be listed are `tree-unknown`. A listing
counts as complete only when it is proved complete, and a process it did not
read is listed `unreadable`, never left out (owner ruling of 2026-10-21 on
the eighth review). It must list its reader: a Linux `/proc` that does not
(empty, unmounted or masked), or whose `self` names the reader under another
pid (one mounted from another pid namespace, which numbers every process as
that namespace does; refine-verify of the eighth review, reproduced by the
peer with an injected `/proc`), and an `lsof` that does not (none at all, or
others only) cannot be read; nor does such a `/proc` give a clock (refine-verify of the
sixth review, reproduced by the peer with injected read failures; eighth
review, reproduced by the peer at the library seam: both read as a tree with
nothing in it). Nor can a Linux `/proc` mounted `hidepid=invisible` or
`hidepid=ptraceable` (2 or 4; systemd's `ProtectProc=invisible` mounts one),
which still lists its reader but leaves out every process the reader may not
ptrace, its own set-uid children (`sudo`) and those not dumpable among them:
every mount at `/proc` that `/proc/self/mountinfo` shows must be of type
proc and carry no `hidepid` but `0`, `off`, `1` or `noaccess`, whose refusals
leave a process listed, and a mountinfo that cannot be read, or shows no
mount at `/proc`, proves nothing. Every one, since their order does not tell
which one is read: a mount moved over a later one is listed first
(refine-verify of the ninth review, reproduced by the peer at the library
seam with a real occupant, which a cancel removed the tree under when the
last line was taken; the kernel's order inferred from `fs/namespace.c`). Its
`gid=` exemption is not honoured (ninth review, P-F1, owner ruling of
2026-10-22; reproduced at the library seam by a local reviewer and the peer,
the kernel's behaviour inferred from `fs/proc/base.c` and proc(5)).
A mount at or under one process's directory (`/proc/<pid>`, such as an empty
tmpfs over it) proves nothing either: `/proc` still lists the pid, and its
links read as those of a process that exited (eleventh review, R-F4,
reproduced by the peer with injected mountinfo and reads; the native mount
inferred from mount semantics). A mount under `/proc`'s other entries
(`/proc/sys/fs/binfmt_misc`) hides no process.
A mountinfo line is cut at its first ` - ` only, since a source after it may
itself read `-` (tenth review, Q-F2, reproduced by the peer through a cancel
that removed a real occupied worktree). A `/proc` mounted `hidepid=1`
(`noaccess`) lists every process but refuses the owner of another user's,
which is then listed `unreadable`: while one runs, every tree reads
`tree-unknown` and only the reclaim's age removes it (the safe direction,
stated as a limit; tenth review). A Linux listing of every process is read
in the pid namespace the supervisor's recorded clock names, or proves
nothing: a reader in another one with a `/proc` of its own (a sandbox that
unshares it, such as `bwrap --unshare-pid --proc /proc`) lists its reader as
itself and hides nothing, yet holds none of the run's processes, and a pid
namespace that cannot be read now is no proof either (tenth review, Q-F1,
reproduced at the library seam by a local reviewer; that a host sandbox runs
a cancel so is inferred from the bubblewrap arguments in Claude Code's
binary). An owner record with no clock (an earlier runner's, or one whose
clock could not be read when it was written) names no pid namespace to check,
so its Linux listing proves nothing: the tree reads `tree-unknown`, and only
the reclaim's age removes it (eleventh review, R-F1, reproduced by the peer
as a cancel that removed a real worktree under a live occupant, read from
another pid namespace; owner ruling of 2026-10-24). A group's listing, which
ties a gone leader's group to the run (`groupTiedToTree`), keeps two of these
rules: it reads only a `/proc` that is the reader's, and, when the record or
the handle keeps a clock, only in the pid namespace that clock names. Read
otherwise, a group id names another namespace's group, so the tie is
`unknown` and nothing is signalled (fourteenth review, U-F1, reproduced by the
peer and locally with an injected `/proc`: a cancel signalled an unrelated
group of the reader's under the run's group id). A record with no clock reads
its group in the reader's namespace, as an earlier runner's did. For the same
reason a Linux fingerprint is read only through a `/proc` that is the
reader's, else it is none: a process of another namespace under the
companion's pid, with the start time recorded, would match a live companion
and have its group signalled (refine-verify of the fourteenth review's fixes,
F1, reproduced by the peer with an injected `/proc` and a real group). And,
as the listing does, when the record or the handle keeps a clock, a
fingerprint is read only by a reader in the pid namespace that clock names,
else it is none: each namespace numbers its own processes, so the reader's
process under the recorded pid shares no more than a start tick with the
run's. A match read in another namespace is `unknown`, and an unknown identity
is never signalled. The rule holds at every place a match is read: the live
cancel's handle process, `stopHandleGroup`'s group leader, and the supervisor
and companion that `snapshotEnded` and the reclaim judge, each under the
clock of the run's supervisor (its own fingerprint's, for the supervisor). A
record with no clock is read in the reader's namespace, as before (eighteenth
review, Y-F1, reproduced by the peer in all four runners with a modeled
`/proc` and a real group; owner ruling of 2026-10-25). A documented limit of
this rule: a handle whose snapshot record keeps a supervisor the runner never
writes (`handleSupervisor` reads it `malformed`, a pid out of a run's range,
say) gives the live cancel no clock, so its handle process is read in the
reader's namespace, as a record with no clock is. Only a handle made or changed
by hand reaches it, so it is not fixed now (refine-verify of the eighteenth
review's fix, reproduced by the peer with a supervisor pid of 1; owner ruling
of 2026-10-25 on uncommon cases). The namespace check reads the reader's whole
clock, so a reader whose boot id or time namespace cannot be read is in no
namespace and reads every clocked fingerprint as none: a refusal, never a
signal. Once the processes listed
are read, a Linux listing reads `/proc` again and reads each process it had
not met, until a round meets none (at most four rounds, the last after
the fifth read of `/proc`), as the
macOS rounds read the process table again; one of the user's own still unmet
after the last round is listed `unreadable`, and one that has exited by then
leaves the listing unproved, since a child it started may be one no round
read (eleventh review, R-F2, reproduced locally with an injected chain of
processes that each fork the next into the tree and exit: five or more read
the tree empty). A process of the run that starts a child and exits
while the listing runs is gone when its turn comes, and the child, started
after `/proc` was first read, is met in a later round (tenth review, Q-F3,
reproduced by the peer with an injected fork-and-exit sequence: a cancel
removed the tree under the child). A pid met once is not read again, so a
process given a pid that another process held earlier in the same listing
(the system's pids wrapping around within it) is not met; a process started
after the last round is no more seen than one started after any listing
ends.
On macOS a listing of every process counts only when `lsof`
exits 0 (it did, three times of three, over every process on the owner's
Mac, 2026-10-21); exit 1 stands only for a pid list, where it means a process
of the list has exited since (seventh review, reproduced by the peer with an
injected `lsof` that listed one unrelated process and exited 1: a cancel
removed the tree under a live child). Exit 0 is not enough: `lsof` leaves
out, exiting 0, a process it may not inspect, one of the user's own that runs
set-uid as `login` and `sudo` do (eighth review, reproduced natively:
`/usr/bin/login` was in `ps -A` and not in the listing; the cause is
inferred from lsof's source), and one started after it read the process
table. So `ps -A -o pid=,ppid=,ruid=,stat=,lstart=`, run after `lsof` in UTC and
the C locale, lists every process, and every process of the user's own (by
its real uid) that it lists and `lsof` did not name is read again by its
pid, and `ps` run again, until a round meets none it had not met (at most
four rounds): one `lsof` names is read; one the last `ps` lists that `lsof`
never named (one the system would not let it read, one started meanwhile,
one whose pid another process holds now) is `unreadable`; one the last `ps`
no longer lists, or lists as a zombie (its directory went with its exit;
measured: a zombie of the user's own read as hidden, and under the suite's
load made a judgment `tree-unknown`), has exited (refine-verify of the eighth review, reproduced by
the peer with injected answers: a child forked during the second read, and a
process that took a left-out one's pid, were dropped though the last `ps`
listed them). The `ps` run itself (set-uid on macOS) is not among them. Measured on the owner's Mac
(2026-10-22): without the second read, a process launchd started for the user
between the two tools (its parent init) made one listing in five
`tree-unknown`; with it, twenty of twenty read empty. A `ps` or a second
`lsof` that fails leaves the listing unproved. A record `lsof` prints with
no name, and one whose name is no path (`cwd info error: …`, refine-verify
of the seventh review, reproduced by the peer with an injected listing), is
`unreadable` too. `lsof`, `ps` and `sysctl` are taken from PATH, else from
`/usr/sbin` and `/bin`, and `lsof` runs with `-b -w`. On Linux a process
of the user's own whose directory the system will not say (one not dumpable,
as a process that hardens itself makes itself) is `unreadable`, and a cwd
link that is gone is no proof its process exited: once a multithreaded
process's main thread has exited, its link is gone while its other threads
run on (proc_pid_cwd(5)), so each thread's link is read (seventh review,
established by reading and by the peer's injected `/proc`). A thread that
exits while they are read may have started another that this read of the
task list does not name, whatever the others read, and a task list read
while threads exit can end early (`proc_task_readdir`), whatever threads it
names: while a thread other than the main one is gone when its link is read,
or the list names fewer threads than the process's status counts
(`Threads`), or that status cannot be read, or a read of the list after the
count no longer names every thread it named (a thread read and exited before
the count leaves a place in it that a thread the list left out fills), the
task list is walked again (four walks in all), and a process still read so is
`unreadable`, listed with every directory its threads were read in, so a
process placed outside the run still keeps a tree one of its threads was
read in. Only a process
whose task list names no thread with a link left and whose status counts one
thread at most (a zombie), or whose status is gone, is passed over (eleventh
review, R-F3, reproduced by the peer through injected reads: a leaderless
process whose last thread started another in the tree read as exited, and
the judgment `ended`; the refine-verify of its fix reproduced the same
through a walk in which another thread was read, and through a task list
that named the main thread alone, the kernel's early end inferred from
`fs/proc/base.c`; the twelfth review, S-F1, reproduced it through a list cut
short to the main thread and one thread outside the tree while the status
counted three; the refine-verify of that fix reproduced it again through a
thread that exited once read, and found a walk that proved nothing dropping
the directory a thread was read in, which read a tree empty under a process
started before the supervisor (F1, F2). That a zombie's status counts one thread, and that a zombie
leader stays counted in `Threads` while its other threads run, since
`nr_threads` drops only when a thread is released, are inferred from the
kernel source, not measured).

An `unreadable` process keeps the tree `tree-unknown` unless it is placed
outside the run by the run's supervisor, whose start time, clock and
ancestors the snapshot records beside its fingerprint (`processLineage`;
`starttime`, `clock`, `ancestors`), and the listing reads the hidden
process's the same way. It is placed when it started before the supervisor
(what the run starts descends from the supervisor and starts after it), or
when one of its ancestors started before the supervisor and is neither init
(pid 1, or on Linux one whose status's `NSpid` ends in 1 or names none, a
pid namespace's init as far as the reader can tell) nor one of the
supervisor's ancestors: a process of the run descends from the supervisor,
and one its parent leaves is given to the nearest subreaper among its
ancestors or to its pid namespace's init, which adopts what a parent in its
namespace leaves though it is no ancestor of that parent (refine-verify of
the eighth review: a run that forks into an existing namespace below the
reader's; reproduced by the peer as a topology on an injected `/proc`, the
kernel's choice of reaper inferred from its source), so each ancestor of it
is the supervisor, a process the run started since, an ancestor of the
supervisor, or such an init. Only its ancestors below the first such init
count: what lies above an init that may have adopted it is that init's
lineage and says nothing of its own (ninth review, P-F3, reproduced by the
peer on an injected `/proc`: a child of the run left in a namespace it
entered, under an init whose parent predates the run, read `none` and then
`ended`). On macOS, which has no subreaper and gives an orphan to launchd,
one is also placed when its ancestors reach one of the supervisor's other
than launchd before they reach the supervisor's pid: a process of the run
reaches those only through the supervisor (ninth review, P-F4, recurring
O-F1, owner ruling of 2026-10-22: a new terminal tab's set-uid `login`, under
the terminal the supervisor runs in, made every tree `tree-unknown` while the
tab was open; measured that `login` is the one own process `lsof` cannot
read on the owner's Mac, the rest inferred). On Linux a recorded ancestor may
be a subreaper, which adopts what the run leaves, so the rule is macOS's
alone. So the interactive codex, another lane's peer, a new ssh session or
a `sudo` started since is placed by the shell, the session or the daemon it
runs under when that started before the run and is no ancestor of the
supervisor (eighth review: one hidden process started after the supervisor
made every tree `tree-unknown` on a dual-host machine; reproduced with an
injected `/proc`, native Linux inferred). On Linux each ancestor is read,
then its child again, and a child whose parent changed in between gives no
ancestors: its parent's pid may since be another process's. Start times and
pids compare only when read in one clock (`clockDomain`): on Linux the same
boot, time namespace and pid namespace, since a time namespace's offset
shifts every start time its reader sees (refine-verify of the seventh
review, 2026-10-21, reproduced by the peer with injected start times) and a
pid names a process only within its namespace; on macOS the same boot time
`kern.boottime` reports, to the microsecond (the same value through this
session, 2026-10-21 to 22), since a start time there is the wall clock read
at the fork, and setting that clock moves the boot time macOS reports (an
inference from XNU, not measured here); in seconds alone a clock set back by
less than a second kept it (refine-verify of the eighth review, reproduced by
the peer with injected answers). A clock set between the supervisor's start
and the record shows in no boot time read then: the runner records its own
start time only when its uptime, a monotonic clock, dates its start to the
second its start time names (with up to 1.5 s for it to start up). Without the start-time
bound one hidden process anywhere on the machine (an ssh-agent; on macOS a
`login`, measured) made every tree `tree-unknown`, so no host-killed run
was ever `ended` and the reclaim waited its full age (seventh and eighth
reviews). Where the tie
needs a name read as written, here a name that may be the tree's counts:
Linux's " (deleted)" mark dropped or kept, and an escaped lsof name, which
keeps the tree's spelling verbatim unless the tree's own path holds a byte
lsof escapes (then any escaped name counts). The reclaim reads the tree the
same way: a snapshot whose owners are gone but whose tree is occupied is kept
as an identity it cannot tell, until it is old (`tree-occupied`, then
`tree-occupied-expired`), where it was reclaimed at once. The snapshot-gone
routes of `cancel` below check the removed tree too, after the handle's
group is stopped: occupied, a live run is refused (`supervisor_unknown`,
`snapshot-gone-tree-…`) and a terminal one keeps its removal unrecorded
(`skipped: tree-…`).

**cancel.** For a run whose handle records a snapshot not yet removed and
whose companion is no longer running: `ended` → the run's answer decides
when it wrote one (the envelope, as `reconcileOne` reads it), else it is
recorded `cancelled`; then its snapshot is removed and recorded on the
handle (`snapshot.removed_at`, `cleanup_error`), and the answer is `ok`,
reason `ended`. A supervisor gone whose companion's group lives on (its
leader dead, a child left) has that group stopped first (SIGTERM, SIGKILL
after the grace), then judged again; still alive, the answer is reason
`group_alive`. Only a group whose leader, the companion, is still the
process the record names, or is gone while a process of the group runs in
the run's tree, is stopped: under a pid whose process cannot be told it may
be another process's own group, and the run is `unknown`. So may a group
whose leader is gone: once the companion's group ended, the system may give
its id to a process that leads a group of its own and exits while its
members run on (a job-control pipeline, a daemon's double fork), and the id
alone cannot tell that group from the run's (fifth review, 2026-10-19,
reproduced by a local reviewer with a modelled owner record: an unrelated
leaderless group was killed and the snapshot removed). The tie is what the
group's processes run in (`groupTiedToTree`; Linux reads `/proc`, macOS `ps`
and `lsof`): the companion starts in the snapshot's tree and what it starts
inherits it, and no other process runs in a directory made for one run. A
group's id cannot be reused while any process of it lives, so one tied
process proves the group the run's. The tree is the one beside the owner
record, never the record's own `tree`, which could name any directory, and
it is never followed through a link (only its parent's spelling is
resolved), since a link put in its place could name `/`. A name that
cannot be read as written ties nothing: lsof writes a name's unprintable
bytes as escapes, so a name holding a backslash reads as unread, and Linux's
" (deleted)" suffix is dropped only when no directory has the full name
(refine-verify, 2026-10-19, reproduced by the peer). A group nothing ties is
`companion-untied` (`unknown`), and nothing is signalled. `alive` → `supervisor_alive`, `unknown` →
`supervisor_unknown` (so is a group alive under a supervisor that cannot be
told); each refusal is `ok: false` (exit 1) and writes nothing. A ledger
that holds another run under the id by the time of the write is refused too
(`replaced`). A snapshot a reclaim already removed leaves no record to
judge, and its removal is no proof the companion's group stopped (a reclaim
also removes a snapshot on age alone, its owners' identities unknown): what
is left of the group the handle names is stopped first, and a group that
cannot be stopped is `group_alive`. The handle keeps that group's id past
the run's end (`peer_process`), so it is signalled only while the handle's
own process, the group's leader, is still the one the handle recorded, or is
gone while a process of the group runs in the run's tree (the same tie, read
from the removed tree's path, which both platforms still report for a
process inside it): a pid another process now has, or one that cannot be
told, may lead a group of its own under that id, so may a gone leader's id
that nothing ties, and a handle whose process fields the runner did not
write proves no group; each is `supervisor_unknown`, nothing signalled. Once the directory is gone and the handle has not moved for
the stale grace, the run is then finished as `ended`, the removal recorded
(`already_gone`); before that it is `supervisor_unknown`. The record's
absence is no proof its supervisor is gone either (a reclaim removes a
record on age while its supervisor cannot be told), so the handle keeps the
supervisor's pid and fingerprint in its snapshot record, copied from the
owner record when the snapshot is made, and the run is finished, or a
terminal run's group stopped and its removal recorded, only once that
supervisor is gone: one alive is `supervisor_alive`, one that cannot be told
`supervisor_unknown` (`snapshot-gone-supervisor-…`; a terminal run answers
`already_terminal` with `skipped: supervisor-…`), nothing written or
signalled (refine-verify, 2026-10-19, reproduced by the peer: a cancel
finished such a run while its recorded supervisor was alive). The run's own
runner never leaves that state: it writes the handle terminal at its end,
before its `finally` removes the snapshot. These reasons are deliberately not `not_running`, which the
autopilot's dead-run cleanup reads as nothing left to cancel: a refusal
keeps the dead run's open-run record. A terminal run whose snapshot was not
removed (its runner killed inside its own end) answers `already_terminal`
as before, its status unchanged: a process of its companion's group its dead
runner left is stopped first (`group_alive`, `ok: false`, when it cannot
be), and the snapshot is removed once the run is `ended`. With no owner
record left (a reclaim removed the snapshot, the run made terminal since by
an envelope's reconcile, which keeps the handle's group) and the snapshot's
directory and tree gone, the group the handle names is stopped the same
way, its leader proven first, and its removal is recorded (`already_gone`),
so a later cancel has nothing of it left to judge or stop. An owner record
that is still there but cannot be read proves nothing of its supervisor,
which may be at work: nothing is signalled, the snapshot is kept
(`skipped: owner-unreadable`), and the reclaim's age rule remains its route
(refine-verify, 2026-10-19, reproduced by the peer). A cancel of a live run now answers `ok` only once the
companion's whole group is gone (`group_alive` otherwise); its handle is read
the same way first, and one whose process fields the runner did not write is
refused (`unsupported_unverifiable`, `handle-malformed`) before anything is
written or signalled. A group is signalled only as the one its pid leads,
and never group 1, init's, which `kill(-1)` would read as every process the
user may signal. Each answer
reports the removal apart, in `snapshot_cleanup` (`removed`, `skipped` with
why the run is not proven over, `error`): a removal skipped or failed never
changes the run's status or the answer's `ok`; a failed removal keeps the
owner record, so the next reclaim retries it. The removal goes through the
checkout the snapshot was made from, or, that one gone, its repository's
common git directory. It takes nothing on the owner record's word (a
corrupted record, or one another tool wrote, could name any worktree, and a
forced `worktree remove` deletes uncommitted files): the record must sit in
a snapshot directory, its tree must be that directory's `tree` and the tree
the run's handle recorded, its branch the one the snapshot's creation names
for that directory, and a worktree registered at the tree must be locked
naming that record, as the reclaim requires of every worktree it removes.
Anything else removes and records nothing (`skipped` names the check), and
the reclaim, which takes its worktree from git's lock, remains its route.
The orchestrator's `cancel`
does the same (its copies of both files, per the 2026-10-14 amendment).

**settle** (the persona runners; the orchestrator has none). After its
commit, a run proven over has its snapshot removed the same way, reported
as `snapshot_cleanup`; a repeat (`already-settled`) does it too, so a settle
stopped between its commit and its cleanup leaves the snapshot to the next.
The run's ledger reads `orphaned` (reconcile, after the stale grace) and the
workflow's ensemble result `failed`. So the autopilot's report-close path
(cancel, then settle) passes such a step: the cancel finishes the run, and
the settle records it `failed`.

**Not covered.** `cancel` keeps its earlier answers for a run with no
snapshot record (a claude peer, no checkout) and for `queued`, `spawning`,
`no_pid` and `unsupported_unverifiable` runs; `sweep` and the next
dispatch's reclaim remain their route. A runbook's finalize settles
directly, so within the stale grace of a host-killed run it is still refused
(collect it, or wait): only the autopilot's report-close path cancels first.
`reconcileOne`'s staleness rule is unchanged: a runner stopped (not dead) past the stale grace is still
orphaned by a sweep or a settle, though its snapshot is then kept, its
supervisor alive. A run its host killed in an interactive session that then
ends, with no later codex run, `cancel` or `settle` in that repository,
keeps its snapshot: nothing observes it. A snapshot already removed by a
reclaim leaves no record, which `cancel` accepts only past the stale grace
(above). When that run was also orphaned (a sweep or a settle past the stale
grace, which clears the handle's `pid` and `pgid`), only `peer_process`
names the group: a handle an earlier runner wrote has none, so nothing names
the group any more, and a process of it left running is not stopped. A snapshot whose directory
is gone while git still lists its registration is reported removed
(`already_gone`); the next reclaim removes the registration
(`directory-gone`). On Windows the runner records no group for its companion, so its runs are
never proven over here (`owner-incomplete`): the reclaim's age rule remains
their route. A group alive whose leader is gone is stopped only while a
process of it runs in the run's tree: one whose every process has moved
elsewhere is not stopped, and its run is not finished here (`companion-untied`),
where it was before (the reclaim still keeps the snapshot while the group
lives, as it always has). On a platform with neither `/proc` nor `ps` and
`lsof`, or where they fail, no group whose leader is gone is tied, and such a
run is left the same way. The tie proves where a process runs, not whose
child it is: another process of the same user that entered the snapshot's
tree would tie its own group (an assumption the runner does not enforce; the
tree is a private temporary directory made for one run). The listing reads a
group's members and then their directories, and a group may end and its id
be reused between the tie and the signal (an inference; not seen). A handle
an earlier runner wrote keeps no supervisor: after a reclaim removed its
snapshot, the stale grace alone remains its route, as before. A live run's `cancel` stops the companion's group
right after the leader it verified exits, with no tie: a group alive then is
the run's unless it ended and another process's took its id in that moment
(an inference; not seen). A handle an earlier runner wrote names the companion
only until a terminal or orphan write clears its `pid` and `pgid`: after
that, a terminal run's `cancel` and a repeat `settle` (`already-settled`)
judge its owner record alone. The reclaim, which reads no handle, still
reclaims a record with no companion and no launch at once when nothing runs
in its tree (`supervisor-gone-companion-unrecorded`), the record the runner
writes when it dies before the launch. On Windows, and wherever the
processes cannot be listed, no run is `ended` here (`tree-unknown`) and the
reclaim keeps a snapshot whose owners are gone until it is old, where it
reclaimed it at once. A process of another user in the tree is not seen (the
tree lies in a private directory made for one run), nor is one of the run's
whose real uid is another's (a command `sudo` runs as root). While a hidden
process of the user's own (Linux, one not dumpable; macOS, one set-uid) is
not placed outside the run, no run is `ended` here (`tree-unknown`): one
started after the supervisor and left to init, or on Linux to a subreaper
among the supervisor's ancestors, on Linux one whose every ancestor that
started before the run is an ancestor of the supervisor (a shell opened in
the supervisor's tmux after the run started; macOS places it), one adopted by a pid
namespace's init whose ancestors below it all started since, one whose
ancestors cannot be read, or any while the
supervisor's start time, clock or ancestors are not recorded (an earlier
runner's record, a platform that lists none, a macOS supervisor whose uptime
contradicts its start time). The snapshot of a run its host
killed then waits for the reclaim's age, which removes it whether or not the
tree is occupied. On a machine that starts processes faster than the listing
reads them (another lane's test suite beside the run, measured 2026-10-21:
five to fourteen processes unread in each listing of about 960, all started
within the last second), the macOS rounds meet new processes in every round
(the Linux rounds are expected to as well, not measured), and those still
unmet after the last stay `unreadable`; when one descends from an
ancestor of the supervisor (a sibling of the runner under its host), nothing
places it outside the run, and the tree reads `tree-unknown`. That is the
safe default, kept on purpose (owner ruling of 2026-10-22): cancel, settle
and the reclaim keep the snapshot, and a later attempt judges it again. It
is the retention direction, never a removal under a live process, and only
delays the cleanup on a busy machine. A rule that places a process started
after the listing began is deferred to C142's listing-hardening slice. A hidden process placed outside the run that then entered
the tree is not seen, the same premise as another process of the user's that
enters it. An ancestor of the supervisor that its parent chain skipped when
it was recorded (a parent that died first gave the supervisor to a
subreaper above it) and that becomes a subreaper itself later would place a
process of the run outside it (an inference; not seen). On macOS a debugger
that attaches to a process becomes its parent: one attached to a hidden
process of the run, which takes root for a set-uid one, would place it
outside the run (an inference from XNU's `ptrace`; not seen). A macOS supervisor
recorded by another process than itself (the suite's) has no uptime check:
a clock set back between its start and the record by more than the time to
the run's first child goes unseen. A pid `lsof` named whose process exited
and whose pid another process took before the last `ps` reads as the one
named, the same window as the pid reuse ones above. No listing is one
read of every process: a process of the run that forks a child into the tree
and exits while the listing reads the processes is gone when its turn comes
(the peer, eighth review, on an injected `/proc`); the rounds above meet the
child, and past the last round the listing is unproved on Linux and the
child `unreadable` on macOS (tenth review, Q-F3; eleventh review, R-F2). The suite judges each listing on an injected one (`/proc`,
`spawnSync`), and its cases that are not about the listing judge only the
processes they read or record their supervisors as a snapshot does; a
listing that proves nothing (on Linux, one a process started and exited
during the last round left unproved) is taken again, up to five times, so
such a case does not hang on what else starts on the machine (twelfth
review, S-F2, inferred, not measured on Linux). The
runners, cancels, settles and dispatches those cases start judge the same:
the suite preloads (`node --import`) a module that installs its listing on
`globalThis` under the library's `LISTING_HOOK`, which a judgment reads when
its caller passes no listing. Only code loaded into the process installs it,
and the library reads no environment variable for it (C142 O-F2 recurrence,
measured: 33 of the full suite's cases failed under another lane's load
before it). A case pins that a runner started without the preload never
reads that listing's variable, and that it judges the system's listing, the
one production judges: with a real process running in the run's tree, its
cancel keeps the run and writes nothing (ninth review, P-F2: before that
case, a default listing that named no process passed every suite). It
asserts the retention direction only, since what else runs on the machine
may keep a run too. How a
real Linux kernel reports a leaderless or a hidden process is what proc(5)
documents, not measured here, and the branch's Linux CI run is owed before
it lands. Occupancy is judged by working directory only: a descendant of the run
that left the tree but keeps files open in it or uses absolute paths into
it, a thread with a working directory of its own (macOS; Linux, a thread
that unshared its filesystem attributes while the main thread runs), and a
working directory in the snapshot's directory above the tree are not seen.
No listing proves that nothing uses a path, so this is a limit, not a check
to add (seventh review, reproduced by the peer; docket C142). Nor does the
runner's own normal end look at the tree: once the companion exits
normally, the runner and `dispatch-peer` remove the snapshot without an
occupancy check, so a detached child the companion left there runs on in the
removed tree (seventh review, reproduced by a local reviewer). That is C96's
ordinary path, outside this judgment of a run its host killed; it is on the
docket with C142. The macOS fingerprint's locale
dependence (the 2026-10-14 limits) no longer ends a run here: a `cancel` or
`settle` run under another locale than the runner reads a live supervisor
as replaced, which this judgment takes as `unknown`: `cancel` refuses
(`supervisor_unknown`, nothing written), and neither removes the snapshot
(`settle` still records its settlement, as for any run not proven over).
The reclaim still reads it as gone. A `cancel` and a `settle` of one run in two processes still
race on the handle (C139).

**Rollout.** The autopilot driver calls the pinned engineer's
`peer-runner.mjs` (`roots.engineer`), so the fix reaches autopilot only
through an engineer release that is installed and pinned; it is rolled back
forward only. The dead-run cleanup cancels with the engineer a dead run
pinned while that version is still installed, so a run left by an older
pin is still answered `not_running` and left to the reclaim. The persona and orchestrator releases carry it for their own
runs.

**Test hygiene.** A fake companion and a child it starts that would run on
end on their own after ten minutes, and the runbook-run tests make their
snapshots in a private area beside their checkout, removed with it: a test
run killed midway leaves nothing among the shared temporary directory's
snapshots (two such leftovers were found while this was measured: a
`designer-peer-snapshot-*` of a killed runbook test, and a `hang`-mode fake
companion alive 31 h).
