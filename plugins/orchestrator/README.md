# orchestrator

Cross-host macro orchestration capability for Claude Code and Codex CLI. **L2 capability plugin** per [ADR-0010](../../docs/adr/0010-plugin-boundary-policy.md) 4-layer composition; **first multi-verb L2 occupant** per [ADR-0018](../../docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md) §sub-decision-1.

## Status

Ships `/orchestrator:plan` (macro plan + Plan-verify opposite-host peer ensemble through the ADR-0023 peer-runner supervisor), `/orchestrator:next` (same-host dispatch into engineer), `/orchestrator:done` (records a subtask completed once its pull request has merged, with the merge commit — [ADR-0062](../../docs/adr/0062-subtask-completion-recorded-at-landing.md)), `/orchestrator:finalize` + `/orchestrator:abort` (macro completion lifecycle), `/orchestrator:approve` (the owner's approval of a macro plan, bound to the plan's hash — [ADR-0063](../../docs/adr/0063-autopilot-fresh-session-driver.md) D6), meta commands `/orchestrator:resume` / `/orchestrator:checkpoint` / `/orchestrator:peer-now`, `/orchestrator:audit` as a follow-up planning alias, `/orchestrator:autopilot` (Claude Code only: drives an approved macro one fresh worker per step and halts at owner judgment — [ADR-0063](../../docs/adr/0063-autopilot-fresh-session-driver.md)), and macro auto-archive A1–A4 on the host Stop event (branch-agnostic per ADR-0019 §5). Schema `'1.2'` (ADR-0063 D6; `'1.1'` files are read and written at `'1.1'`). The cross-plugin invocation contract is [ADR-0019](../../docs/adr/0019-cross-plugin-invocation-contract.md). The cross-host `--peer` dispatch path for `/orchestrator:next` remains trigger-deferred PR-F scope.

## What it is

`orchestrator` is the macro layer. It manages **multi-deliverable workflows** by emitting a list of subtasks (`plan.subtasks[]`), dispatching each ready subtask into a separate `engineer` workflow, and closing or archiving the parent macro when the subtasks reach terminal states. The cognitive workbench (investigate / frame / decide / compose / critique / refine) lives in `plugins/engineer`.

| Layer | Plugin | Responsibility |
|-------|--------|----------------|
| L1 framework | `plugins/companions` | Cross-host bidirectional companion bridges (Claude ↔ Codex) |
| **L2 capability** | **`plugins/orchestrator` (this plugin)** | **Multi-deliverable macro planning, dispatch, completion, and Plan-verify ensemble** |
| L3 persona | `plugins/engineer` | Single-deliverable cognitive verb chain |
| L4 profile | `engineer:<sub-discipline>` | Discipline-specific context (backend, frontend, …) |

## Commands

| Command | Status | Description |
|---------|--------|-------------|
| `/orchestrator:plan <feature>` | ✅ shipping | Build a macro plan: produce `plan.subtasks[]` proposals via a Plan-verify opposite-host peer ensemble, persist to `<repo>/.agentic-plugins/state/orchestrator/workflows/<workflow_id>.md` for new repos, and present for approval. |
| `/orchestrator:next [<subtask-id>] [--workflow=<macro-id>]` | ✅ shipping (same-host) | Dispatch the next ready subtask into `plugins/engineer`. Branch precondition + ownership check + parent-linkage env vars per ADR-0019 §1+§3. The child records the selection the dispatch made (subtask, branch, verb, profile, topic); every binding of a child to its subtask (this writeback, the engineer's terminal note, `/orchestrator:done`'s owner scan) compares it under the macro's file lock and refuses a subtask revised since (ADR-0067 Decision 4, item 5). Plan-approval gate (ADR-0063 D4): under an autopilot run a plan not approved at its current hash is refused (`plan-unapproved`); interactive dispatch warns in one line about a plan pending approval or changed since it was approved. Cross-host `--peer` remains trigger-deferred PR-F scope. |
| `/orchestrator:done <subtask-id> [--pr=<n>] [--commit=<sha>] [--correct \| --no-commit] [--waive-dispatch] [--workflow=<macro-id>] [reason]` | ✅ shipping | Record subtask completion after its pull request merges (ADR-0062): resolves the merge commit bound to this attempt, verifies it against the integration branch, and unblocks successors. The engineer's Phase 7 and Stop hook only note the branch commit. `--correct` replaces a recorded value with an audit line; `--no-commit` completes work that landed no commit. The write compares the dispatch its owner records and refuses when that cannot be read; `--waive-dispatch`, with a reason, completes without the comparison when the owner's workflow file is gone, and the macro records it. |
| `/orchestrator:finalize [--workflow=<macro-id>]` | ✅ shipping | Close the macro plan with all non-terminal subtasks → `deferred` + macro `current_phase: 'finalized'` + `terminal_marker: true`. Three-step §5 ritual: bulk subtask transition → active-children detach pass (NO parent lock; routes terminal engineer children through `stop-archive`, mid-flight via `detach-archive`) → terminal markers. |
| `/orchestrator:abort [--workflow=<macro-id>]` | ✅ shipping | Same ritual as `/finalize`, but subtask transition → `abandoned` and `current_phase: 'aborted'`. Use when work cannot continue. |
| `/orchestrator:approve [--workflow=<macro-id>]` | ✅ shipping | Show the plan's subtasks and hash, then record the owner's approval of exactly that plan: `plan_approval_status: approved`, `plan_approval_approved_at`, `plan_approval_plan_hash` (ADR-0063 D6). Any later `plan-set` returns the plan to pending approval. Refused while the Plan-verify ensemble's `plan-conflict` gate is set, and under an autopilot run. |
| `/orchestrator:resume [archive [<workflow-id>]]` | ✅ shipping | Inspect the active macro workflow, classify git drift as clean/dirty, append a resume marker, or archive stale macro workflow files. |
| `/orchestrator:checkpoint <summary>` | ✅ shipping | Write `latest_checkpoint: {at, summary}` on the active macro workflow. Claude SessionStart re-injects it after compact (`matcher: "compact"`, so not on an arbitrary new session and not on `claude --continue`); Codex does the same once the bundled hooks load (generic `[features].hooks`) and are reviewed/trusted in `/hooks`. |
| `/orchestrator:peer-now --peer <claude\|codex> (...)` | ✅ shipping | Raw side-channel peer consultation through `peer-runner.mjs --kind peer-now`; optionally appends a `[Peer]` note and stays out of `ensemble_results`. |
| `/orchestrator:audit <findings>` | ✅ shipping | Audit follow-up alias that canonicalizes to `/orchestrator:plan Audit follow-up: ...`; state remains `verb=plan`, `workflow_id=macro-plan-...`. |
| `/orchestrator:autopilot [preview\|start [--execute]\|status\|stop] [options]` | ✅ shipping (Claude Code only) | Drive an approved macro without relaying commands between sessions (ADR-0063): each step runs as one command in a fresh `claude -p` worker, decided from closed-enum state only, and the run halts at owner judgment (an unapproved plan, an owner gate, a next step below HIGH confidence, a subtask waiting for its pull request to merge, a step that changed nothing). Dry-run by default; `start --execute` runs it and asks for the model plan first. See [Autopilot](#autopilot-claude-code-only). |

## Autopilot (Claude Code only)

`/orchestrator:autopilot` is the owner-launched driver of ADR-0063. It lives in
`adapters/claude/autopilot/` because everything it relies on is Claude Code host
truth — stream-json session hosting, `--permission-prompts none`, hook events and
per-message usage in the stream (D9). **There is no Codex skill for it: on Codex
the steps stay manual**, and the host-neutral state it reads (`next_step_*`,
`awaiting_owner_*`, `plan_approval_*`) serves a person driving Codex just the same.

- **One step, one fresh worker.** `/orchestrator:next`, `/engineer:<verb>`,
  `/engineer:commit`, `/orchestrator:done` (or `--no-commit` after a close
  without a commit) and `/orchestrator:finalize`, each in its own `claude -p`
  process with `AGENTIC_AUTOPILOT` set. The driver is stateless: a relaunch
  continues from the state a halt left.
- **Landing stays the owner's** (ADR-0062, owner decision D23). Workers never push or
  open a pull request — the denylist forbids it, and network pushes fail at the git
  level in every worker. Each commit is reported once while the run goes on
  (ADR-0067 Decision 7): a `◆ landing-ready` line, a ledger record and a line in
  the main worktree's `.agentic-plugins/runs/autopilot/landing/<macro-id>.jsonl`,
  with the branch, its commit, the push and pull-request commands, a read-only
  `git merge-tree` overlap check against the integration branch and the other
  waiting branches (run in a scratch repository, so no merge driver or
  attribute of the checkout applies), and an advisory merge order. At an `awaiting-landing` halt
  the run lists each branch the same way; after the merge, a relaunch records the
  landing and goes on.
- **Halts** print the reason and its pointer, write
  `.agentic-plugins/runs/autopilot/<run-id>/halt.json` and exit 2;
  `--notify-local` adds one local macOS notification. There is no plugin notification.
- **Locks, stop and peers.** A run holds its macro's lock, under the main worktree, and
  the lock of each checkout it drives. A worker group in flight may have an entry of its
  own in the macro lock (ADR-0067 Decision 6), so a driver that died while any group runs
  still holds the macro. `status` lists the worker groups a run's entries record, and
  `stop` on a dead driver empties every group it can prove is the run's before it reports.
  `stop` reports a run stopped (exit 0) only once nothing of it runs: it reads the run's
  entries again while it waits, so a group left by a driver that died as it was stopped
  is emptied too, and it exits 1 while any part of the run still runs.
  After a killed or failed step, the driver cancels only the peer runs that step left
  pending on its own subtask's engineer workflows.
- **A dead run is cleaned up.** Each run keeps a record in the main worktree's
  `.agentic-plugins/runs/autopilot/open/<run-id>.json` from before its first step until
  it ends with every worker group empty. Once nothing of a dead driver's run is left
  running, `stop`, or the next run of the macro before its first step, cancels the pending
  peer runs whose handle names that run, counts its unfinished step's whole budget as
  spent, records it halted (`interrupted`), and removes the record. A pending peer that
  names no run is reported, never cancelled: peer-runner does not record the run yet, so
  until it does, `stop` and the next run print the command that cancels such a peer. A
  record whose ledger is gone, whose peer could not be cancelled, or one of whose peer-run
  homes cannot be read (anything but its absence), is kept and reported for the owner.
- **Lanes (the layer only).** `adapters/claude/autopilot/lanes.mjs` holds ADR-0067
  Decision 5's lane layer: a lane is a locked git worktree at
  `<parent>/<repo>-lanes/<macro-id>/<subtask-id>`, named from the main worktree, created
  from a freshly fetched baseline, removed only once its subtask is done and only when
  clean and provably the run's (read again from git and the lane where each step of the
  removal acts), and reconciled at a run's start. The scheduler that runs
  steps in lanes (`--lanes`, Decision 6) is not shipped yet: every run is serial, as before.
- **Bounds.** Steps, total cost, a run wall clock, and each step's budget and wall
  clock (`--max-steps`, `--max-cost`, `--max-time`, `--step-budget`,
  `--step-timeout`). A step started inside a Claude session runs as a background task,
  which the host stops after two hours; longer runs belong in a terminal through the
  optional launcher — `preview` prints the command that installs
  `adapters/claude/autopilot/launcher.template.mjs` as
  `~/.agentic-plugins/bin/agentic-autopilot`.
- **Requirements.** The repository ignores `.agentic-plugins/{runs,state,tmp,cache}/`;
  engineer carries ADR-0063 S3+S4 (0.24.0) and orchestrator S6 (0.16.0); the plugin
  code a worker loads must not live inside the repository the run drives (on a
  directory marketplace, drive a separate worktree), and it must be the version the
  run pinned. A dedicated worktree is recommended.

## Workflow file shape

`<repo>/.agentic-plugins/state/orchestrator/workflows/<workflow_id>.md` with frontmatter `schema: '1.2'` (ADR-0063 D6; a `'1.1'` file keeps its schema when written). Existing legacy `.claude/agentic-orchestrator/` state remains readable/writable until explicit migration; legacy schema `'1.0'` files are still readable but mutations are refused with archive/re-plan diagnostic. `workflow_id` format `macro-<verb>-<iso>-<rand>`. `workflow_type: macro`. The `plan` block carries `decision`, `architecture`, and `subtasks: [{id, verb, branch, blocked_by, status, label?, profile?, topic?, engineer_workflow_id?, commit?, pr_url?, closed_at?}]` per ADR-0018 §sub-decision-1 + ADR-0019 §2 spec. `verb` ∈ {investigate, frame, decide, compose, critique, refine}; `branch` must pass git ref-format and have no parent/child path-prefix relationship across subtasks. Optional top-level `terminal_marker: boolean` per ADR-0019 §5 (set by `/orchestrator:finalize` / `/orchestrator:abort` or auto-set when all subtasks reach terminal status). Optional `latest_checkpoint: {at, summary}` is written by `/orchestrator:checkpoint` for macro workflow continuity. Optional flat scalars (ADR-0063 D6, absent = null) record the plan's approval: `plan_approval_status` (`pending | approved`), with `plan_approval_approved_at` and `plan_approval_plan_hash` (sha256 over the subtasks' id, label, branch, blocked_by, verb, profile and topic — `state.mjs plan-hash`) exactly when approved; and `awaiting_owner_gate` (`plan-approval | plan-conflict`), `awaiting_owner_since` and `awaiting_owner_pointer`, all or none, set exactly while the plan is pending. `plan-set` returns the plan to pending, at `plan-conflict` when its Plan-verify verdict (`--verdict`) is `conflict` and at `plan-approval` otherwise; `awaiting-owner-clear --gate plan-conflict` returns it to `plan-approval`; `plan-approve` approves. `next-ready` reports `approval: {status, hash_ok}` on every output.

Per [ADR-0018 §sub-decision-2](../../docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md), the **active workflow** is the one whose `git_baseline.branch` equals the current branch. `git checkout` is the primary context-switch primitive; no extra "switch workflow" UX. This applies symmetrically to engineer and orchestrator.

In a repository with linked worktrees, `<repo>` is the checkout's **read set** ([ADR-0067](../../docs/adr/0067-autopilot-worktree-lanes-and-proposals.md) Decision 1): the default state root, where git placed the main worktree, then the checkout's own home when it differs. A record under the default state root is found from every checkout of the repository, one in a linked worktree's own home only from that worktree; a branch key or workflow id that two files hold in one read set is reported by the readers and refused by the writers, never chosen. New records go to the checkout's own home until the operator's cutover turns shared creation on, and to the default state root from then on (`AGENTIC_STATE_BASE` may name the checkout instead, Decision 2). The cutover, its verification and its rollback are `state.mjs cutover` and `state.mjs shared-creation`, run in the main checkout as [`docs/runbooks/state-root-cutover.md`](../../docs/runbooks/state-root-cutover.md) describes. `/orchestrator:next`, `/orchestrator:done`, `/orchestrator:finalize`, `/orchestrator:abort` and `/orchestrator:resume`'s archive join the macro's run lock as an admission before they act (`state.mjs admission join | check | release`, Decision 4, item 5), so a session and an autopilot run never act on one macro at once.

## Peer-run operational state

`scripts/dispatch-peer.mjs` remains the compatibility wrapper for raw callers and tests. `/orchestrator:plan` uses `scripts/peer-runner.mjs run --kind ensemble` for managed Plan-verify dispatch. The runner stores operational state under:

```text
<repo>/.agentic-plugins/state/orchestrator/peer-runs/<run_id>/
  handle.json
  stdout.log
  stderr.log
  envelope.json
  prompt.xml   # only when --retain-prompt is supplied
```

Orchestrator keeps its graceful-degradation rule: the runner resolves the companion before creating this ledger or recording `pending_ensemble`. If the opposite-host companion is unavailable, it returns `peer_cli_not_found` and `/orchestrator:plan` proceeds with a LOCAL-ONLY synthesis. If the companion resolves, the runner records the pending row, supervises the child process, supports `status` / `cancel` / `sweep`, and enforces terminal ledger retention. `/orchestrator:peer-now` also uses the runner, but with `--kind peer-now`; it creates operational ledger state and remains excluded from `pending_ensemble` / `ensemble_results`.

## Hooks

Claude Code hooks declared in `hooks/hooks.json`:

- `SessionStart` (matcher `compact`): re-inject the active workflow snapshot
- `PreCompact`: write a snapshot before compaction
- `Stop`: macro auto-archive — iterate every non-archived macro under `workflows/` (branch-agnostic, per ADR-0019 §5), snapshot each, evaluate the four hard gates (A1 `terminal_marker` / A2 macro terminal_phase whitelist `{commit-complete, finalized, aborted}` / A3 `all_subtasks_terminal` / A4 `no_active_engineer_children`), and atomically move passing macros into `archive/`. The non-conventional commit subject gate emits a soft warning but does not block archive.

Codex CLI exposes host-level hooks and plugin-bundled hooks. The
orchestrator Codex manifest points at
`./adapters/codex/hooks/hooks.json`, so the plugin management surface can show
host-specific lifecycle commands without routing through Claude adapter paths.
Automatic Codex execution still depends on the plugin being enabled with
generic `[features].hooks` (default on) plus Codex hook review/trust in the
active host session. The Codex-side `Stop`
script under `adapters/codex/hooks/stop.mjs` remains a manual fallback invoked
from `/orchestrator:finalize` and `/orchestrator:abort` Phase 4 tails (or by
the user manually) when plugin hooks are disabled or not yet trusted.

## Schema vs engineer

`orchestrator` and `engineer` are **separate plugins with separate schemas**:

| Plugin | schema | Workflow dir | workflow_id format |
|--------|--------|---------------|--------------------|
| `engineer` | `'1.4'` | `.agentic-plugins/state/engineer/workflows/` (`.claude/agentic-engineer/workflows/` legacy) | `<verb>-<iso>-<rand>` |
| `orchestrator` (this) | `'1.2'` (ADR-0063 D6; `'1.0'` legacy read-only) | `.agentic-plugins/state/orchestrator/workflows/` (`.claude/agentic-orchestrator/workflows/` legacy) | `macro-<verb>-<iso>-<rand>` |

Both schema lines are `1.y` strings, and each plugin reads any `1.y`, so namespace separation is preserved by structural validation, not by the version: orchestrator requires `workflow_type: macro` + `plan.subtasks[]`; engineer files lack those fields and fail at the per-field gates. orchestrator's `state.mjs` rejects engineer schema-1 / 2 (numeric) cleanly. Legacy 1.0 orchestrator files are readable but mutations are refused with an archive/re-plan diagnostic per ADR-0019 PR-B.

## Install

```sh
# Claude Code
claude /plugin install orchestrator@agentic-plugins

# Codex CLI
codex plugin marketplace add each4all/agentic-plugins
```

Required peers:
- `companions` (L1) — for the Plan-verify opposite-host peer ensemble inside `/orchestrator:plan`.
- `engineer` (L3) — runtime peer for `/orchestrator:next` dispatch (the runbook spawns engineer's `state.mjs` CLI). Discovery is automatic per ADR-0019 §1, with ADR-0061 §Decision 3's candidates: the `AGENTIC_ENGINEER_ROOT` override, then the versioned install cache of the host orchestrator runs from, then the other host's cache only when that host has no engineer installed (the fallback is reported on stderr), then the monorepo sibling only when orchestrator itself runs from a checkout. The Codex marketplace clone is never a candidate. Install engineer before `/orchestrator:next` invocations or set `AGENTIC_ENGINEER_ROOT=<path>` to override.

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `PEER_RUN_CANCEL_GRACE_MS` | Grace period used by `scripts/peer-runner.mjs cancel` between TERM and KILL. | `10000` |
| `PEER_RUN_STALE_GRACE_MS` | Age threshold used by `scripts/peer-runner.mjs sweep` before a dead, no-envelope non-terminal run is marked `orphaned`. | `60000` |
| `PEER_RUN_RETENTION_TTL_DAYS` | Terminal peer-run ledger TTL used by `scripts/peer-runner.mjs sweep --apply`. | `14` |
| `PEER_RUN_RETENTION_CAP` | Maximum terminal peer-run ledger directories retained per repo by `scripts/peer-runner.mjs sweep --apply`. Non-terminal runs are preserved. | `200` |

## License

[MIT](../../LICENSE).
