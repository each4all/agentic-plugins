# orchestrator

Cross-host macro orchestration capability for Claude Code and Codex CLI. **L2 capability plugin** per [ADR-0010](../../docs/adr/0010-plugin-boundary-policy.md) 4-layer composition; **first multi-verb L2 occupant** per [ADR-0018](../../docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md) §sub-decision-1.

## Status

Ships `/orchestrator:plan` (macro plan + Plan-verify Codex ensemble through the ADR-0023 peer-runner supervisor), `/orchestrator:next` (same-host dispatch into engineer), `/orchestrator:done` (manual completion backup for engineer Stop-hook auto-writeback), `/orchestrator:finalize` + `/orchestrator:abort` (macro completion lifecycle), meta commands `/orchestrator:resume` / `/orchestrator:checkpoint` / `/orchestrator:peer-now`, `/orchestrator:audit` as a follow-up planning alias, and macro auto-archive A1–A4 on the host Stop event (branch-agnostic per ADR-0019 §5). Schema `'1.1'` (post-ADR-0019 PR-B). The cross-plugin invocation contract is [ADR-0019](../../docs/adr/0019-cross-plugin-invocation-contract.md). The cross-host `--peer` dispatch path for `/orchestrator:next` remains trigger-deferred PR-F scope.

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
| `/orchestrator:plan <feature>` | ✅ shipping | Build a macro plan: produce `plan.subtasks[]` proposals via Plan-verify ensemble (Claude + Codex), persist to `<repo>/.claude/agentic-orchestrator/workflows/<workflow_id>.md`, and present for approval. |
| `/orchestrator:next [<subtask-id>] [--workflow=<macro-id>]` | ✅ shipping (same-host) | Dispatch the next ready subtask into `plugins/engineer`. Branch precondition + ownership check + parent-linkage env vars per ADR-0019 §1+§3. Cross-host `--peer` remains trigger-deferred PR-F scope. |
| `/orchestrator:done <subtask-id> [--commit=<sha>] [--workflow=<macro-id>]` | ✅ shipping | Manually record subtask completion (idempotent backup for engineer Stop auto-writeback) per ADR-0019 §4. Required when the engineer session crashed before terminal commit OR for cross-host reconciliation. |
| `/orchestrator:finalize [--workflow=<macro-id>]` | ✅ shipping | Close the macro plan with all non-terminal subtasks → `deferred` + macro `current_phase: 'finalized'` + `terminal_marker: true`. Three-step §5 ritual: bulk subtask transition → active-children detach pass (NO parent lock; routes terminal engineer children through `stop-archive`, mid-flight via `detach-archive`) → terminal markers. |
| `/orchestrator:abort [--workflow=<macro-id>]` | ✅ shipping | Same ritual as `/finalize`, but subtask transition → `abandoned` and `current_phase: 'aborted'`. Use when work cannot continue. |
| `/orchestrator:resume [archive [<workflow-id>]]` | ✅ shipping | Inspect the active macro workflow, classify git drift as clean/dirty, append a resume marker, or archive stale macro workflow files. |
| `/orchestrator:checkpoint <summary>` | ✅ shipping | Write `latest_checkpoint: {at, summary}` on the active macro workflow. Claude SessionStart re-injects it; Codex can write it manually but has no automatic SessionStart hook today. |
| `/orchestrator:peer-now --peer <claude\|codex> (...)` | ✅ shipping | Raw side-channel peer consultation through `peer-runner.mjs --kind peer-now`; optionally appends a `[Peer]` note and stays out of `ensemble_results`. |
| `/orchestrator:audit <findings>` | ✅ shipping | Audit follow-up alias that canonicalizes to `/orchestrator:plan Audit follow-up: ...`; state remains `verb=plan`, `workflow_id=macro-plan-...`. |

## Workflow file shape

`<repo>/.claude/agentic-orchestrator/workflows/<workflow_id>.md` with frontmatter `schema: '1.1'` post ADR-0019 PR-B (legacy `'1.0'` files are still readable; mutations refused with archive/re-plan diagnostic). `workflow_id` format `macro-<verb>-<iso>-<rand>`. `workflow_type: macro`. The `plan` block carries `decision`, `architecture`, and `subtasks: [{id, verb, branch, blocked_by, status, label?, profile?, topic?, engineer_workflow_id?, commit?, pr_url?, closed_at?}]` per ADR-0018 §sub-decision-1 + ADR-0019 §2 spec. `verb` ∈ {investigate, frame, decide, compose, critique, refine}; `branch` must pass git ref-format and have no parent/child path-prefix relationship across subtasks. Optional top-level `terminal_marker: boolean` per ADR-0019 §5 (set by `/orchestrator:finalize` / `/orchestrator:abort` or auto-set when all subtasks reach terminal status). Optional `latest_checkpoint: {at, summary}` is written by `/orchestrator:checkpoint` for macro workflow continuity.

Per [ADR-0018 §sub-decision-2](../../docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md), the **active workflow** is the one whose `git_baseline.branch` equals the current branch. `git checkout` is the primary context-switch primitive; no extra "switch workflow" UX. This applies symmetrically to engineer and orchestrator.

## Peer-run operational state

`scripts/dispatch-peer.mjs` remains the compatibility wrapper for raw callers and tests. `/orchestrator:plan` uses `scripts/peer-runner.mjs run --kind ensemble` for managed Plan-verify dispatch. The runner stores operational state under:

```text
<repo>/.claude/agentic-orchestrator/peer-runs/<run_id>/
  handle.json
  stdout.log
  stderr.log
  envelope.json
  prompt.xml   # only when --retain-prompt is supplied
```

Orchestrator keeps its graceful-degradation rule: the runner resolves the companion before creating this ledger or recording `pending_ensemble`. If the Codex companion is unavailable, it returns `peer_cli_not_found` and `/orchestrator:plan` proceeds with a LOCAL-ONLY synthesis. If the companion resolves, the runner records the pending row, supervises the child process, supports `status` / `cancel` / `sweep`, and enforces terminal ledger retention. `/orchestrator:peer-now` also uses the runner, but with `--kind peer-now`; it creates operational ledger state and remains excluded from `pending_ensemble` / `ensemble_results`.

## Hooks

Claude Code hooks declared in `hooks/hooks.json`:

- `SessionStart` (matcher `compact`): re-inject the active workflow snapshot
- `PreCompact`: write a snapshot before compaction
- `Stop`: macro auto-archive — iterate every non-archived macro under `workflows/` (branch-agnostic, per ADR-0019 §5), snapshot each, evaluate the four hard gates (A1 `terminal_marker` / A2 macro terminal_phase whitelist `{commit-complete, finalized, aborted}` / A3 `all_subtasks_terminal` / A4 `no_active_engineer_children`), and atomically move passing macros into `archive/`. The non-conventional commit subject gate emits a soft warning but does not block archive.

Codex CLI exposes a host-level hooks feature in current releases, but agentic-plugins has **no plugin-local automatic hook packaging verified** for orchestrator lifecycle events. `hooks/hooks.json` therefore declares only Claude hooks; the Codex-side `Stop` script under `adapters/codex/hooks/stop.mjs` ships as a manual helper invoked from `/orchestrator:finalize` and `/orchestrator:abort` Phase 4 tails (or by the user manually) for cross-host macro auto-archive parity.

## Schema vs engineer

`orchestrator` and `engineer` are **separate plugins with separate schemas**:

| Plugin | schema | Workflow dir | workflow_id format |
|--------|--------|---------------|--------------------|
| `engineer` | `'1.1'` | `.claude/agentic-engineer/workflows/` | `<verb>-<iso>-<rand>` |
| `orchestrator` (this) | `'1.1'` (post ADR-0019 PR-B; `'1.0'` legacy read-only) | `.claude/agentic-orchestrator/workflows/` | `macro-<verb>-<iso>-<rand>` |

The two schema lines collide on the literal `'1.1'` string but namespace separation is preserved by structural validation: orchestrator requires `workflow_type: macro` + `plan.subtasks[]`; engineer files lack those fields and fail at the per-field gates. orchestrator's `state.mjs` rejects engineer schema-1 / 2 (numeric) cleanly. Legacy 1.0 orchestrator files are readable but mutations are refused with an archive/re-plan diagnostic per ADR-0019 PR-B.

## Install

```sh
# Claude Code
claude /plugin install orchestrator@agentic-plugins

# Codex CLI
codex plugin marketplace add each4all/agentic-plugins
```

Required peers:
- `companions` (L1) — for the Plan-verify Codex ensemble inside `/orchestrator:plan`.
- `engineer` (L3) — runtime peer for `/orchestrator:next` dispatch (the runbook spawns engineer's `state.mjs` CLI). Discovery is automatic (env override → Claude cache → Codex cache → monorepo sibling) per ADR-0019 §1; install engineer before `/orchestrator:next` invocations or set `AGENTIC_ENGINEER_ROOT=<path>` to override.

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `PEER_RUN_CANCEL_GRACE_MS` | Grace period used by `scripts/peer-runner.mjs cancel` between TERM and KILL. | `10000` |
| `PEER_RUN_STALE_GRACE_MS` | Age threshold used by `scripts/peer-runner.mjs sweep` before a dead, no-envelope non-terminal run is marked `orphaned`. | `60000` |
| `PEER_RUN_RETENTION_TTL_DAYS` | Terminal peer-run ledger TTL used by `scripts/peer-runner.mjs sweep --apply`. | `14` |
| `PEER_RUN_RETENTION_CAP` | Maximum terminal peer-run ledger directories retained per repo by `scripts/peer-runner.mjs sweep --apply`. Non-terminal runs are preserved. | `200` |

## License

[MIT](../../LICENSE).
