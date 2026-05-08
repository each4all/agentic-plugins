# orchestrator

Cross-host macro orchestration capability for Claude Code and Codex CLI. **L2 capability plugin** per [ADR-0010](../../docs/adr/0010-plugin-boundary-policy.md) 4-layer composition; **first multi-verb L2 occupant** per [ADR-0018](../../docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md) §sub-decision-1.

## Status

`v0.1.0` — **plan-only MVP**. Ships `/orchestrator:plan` (macro plan + Plan-verify Codex ensemble). `/orchestrator:next` and `/orchestrator:done` are deferred to follow-up PRs alongside the cross-plugin invocation contract (ADR-0018 §sub-decision-1 follow-up ADR).

## What it is

`orchestrator` is the macro layer. It manages **multi-deliverable workflows** by emitting a list of subtasks (`plan.subtasks[]`) — each subtask is a unit that a separate `engineer` workflow then drives end-to-end. The orchestrator's responsibility ends at the macro plan; the cognitive workbench (investigate / frame / decide / compose / critique / refine) lives in `plugins/engineer`.

| Layer | Plugin | Responsibility |
|-------|--------|----------------|
| L1 framework | `plugins/companions` | Cross-host bidirectional companion bridges (Claude ↔ Codex) |
| **L2 capability** | **`plugins/orchestrator` (this plugin)** | **Multi-deliverable macro plan + Plan-verify ensemble** |
| L3 persona | `plugins/engineer` | Single-deliverable cognitive verb chain |
| L4 profile | `engineer:<sub-discipline>` | Discipline-specific context (backend, frontend, …) |

## Commands (plan-only MVP)

| Command | Status | Description |
|---------|--------|-------------|
| `/orchestrator:plan <feature>` | ✅ shipping | Build a macro plan: produce `plan.subtasks[]` proposals via Plan-verify ensemble (Claude + Codex), persist to `<repo>/.claude/agentic-orchestrator/workflows/<workflow_id>.md`, and present for approval. |
| `/orchestrator:next` | ⏳ follow-up PR | Pick the next unblocked subtask and dispatch its verb chain into `plugins/engineer`. Requires the cross-plugin invocation contract (ADR-0018 §sub-1 follow-up ADR). |
| `/orchestrator:done <subtask-id>` | ⏳ follow-up PR | Mark a subtask completed; record the engineer workflow id, commit SHA, PR URL, and close timestamp. |
| `/orchestrator:resume`, `/orchestrator:checkpoint`, `/orchestrator:peer-now` | ⏳ follow-up PR | Meta commands mirroring engineer's pattern. |

## Workflow file shape

`<repo>/.claude/agentic-orchestrator/workflows/<workflow_id>.md` with frontmatter `schema: '1.0'` (distinct from engineer's `'1.1'`). `workflow_id` format `macro-<verb>-<iso>-<rand>`. `workflow_type: macro`. The `plan` block carries `decision`, `architecture`, and `subtasks: [{id, label, branch, blocked_by, status, engineer_workflow_id, commit, pr_url, closed_at}]` per ADR-0018 §sub-decision-1 spec.

Per [ADR-0018 §sub-decision-2](../../docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md), the **active workflow** is the one whose `git_baseline.branch` equals the current branch. `git checkout` is the primary context-switch primitive; no extra "switch workflow" UX. This applies symmetrically to engineer and orchestrator.

## Hooks

Claude Code hooks declared in `hooks/hooks.json`:

- `SessionStart` (matcher `compact`): re-inject the active workflow snapshot
- `PreCompact`: write a snapshot before compaction
- `Stop`: write a `stop` snapshot — **snapshot-only in this MVP** (auto-archive A1–A4 gate is deferred to a follow-up PR alongside `/orchestrator:done` and the macro-phase terminal_marker mapping)

Codex CLI 0.128.0 has **no plugin-local automatic hook packaging verified**, so `hooks/hooks.json` declares only Claude hooks; the Codex-side `Stop` script under `adapters/codex/hooks/stop.mjs` ships as a manual helper that may be wired by the user when a future Codex hook surface is verified for plugin-local registration.

## Schema vs engineer

`orchestrator` and `engineer` are **separate plugins with separate schemas**:

| Plugin | schema | Workflow dir | workflow_id format |
|--------|--------|---------------|--------------------|
| `engineer` | `'1.1'` | `.claude/agentic-engineer/workflows/` | `<verb>-<iso>-<rand>` |
| `orchestrator` (this) | `'1.0'` | `.claude/agentic-orchestrator/workflows/` | `macro-<verb>-<iso>-<rand>` |

The two schema lines evolve independently. orchestrator's `state.mjs` rejects engineer-schema files (`'1.1'` / `1` / `2`) cleanly to keep the two namespaces separate.

## Install

```sh
# Claude Code
claude /plugin install orchestrator@agentic-plugins

# Codex CLI
codex plugin install --marketplace agentic-plugins orchestrator
```

The plan-only MVP requires `companions` (L1) for the Plan-verify Codex ensemble. `engineer` is **not** required for this MVP — it becomes a runtime dependency only when `/orchestrator:next` lands in a follow-up PR.

## License

[MIT](../../LICENSE).
