# Changelog

## [0.2.0](https://github.com/each4all/agentic-plugins/compare/plugin-orchestrator-v0.1.0...plugin-orchestrator-v0.2.0) (2026-05-08)


### Features

* **plugins/orchestrator:** MVP scaffolding (ADR-0018 §sub-1) ([#53](https://github.com/each4all/agentic-plugins/issues/53)) ([3615bbc](https://github.com/each4all/agentic-plugins/commit/3615bbc24fe0c851a7b58a269976562b094ea183))

## 0.1.0 (initial)

Initial plan-only MVP scaffold per [ADR-0018](../../docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md) §sub-decision-1.

### Features

- L2 capability plugin per [ADR-0010](../../docs/adr/0010-plugin-boundary-policy.md) 4-layer composition (first multi-verb L2 occupant)
- `/orchestrator:plan <feature>` — macro plan command + Plan-verify Codex ensemble
- Workflow file at `<repo>/.claude/agentic-orchestrator/workflows/<workflow_id>.md` with frontmatter `schema: '1.0'` and `workflow_id: macro-<verb>-<iso>-<rand>`
- `subtasks[]` schema per ADR-0018 §sub-decision-1: `{id, label, branch, blocked_by, status, engineer_workflow_id, commit, pr_url, closed_at}`
- Branch-keyed active workflow lookup (ADR-0018 §sub-decision-2 cascade)
- Claude Code hooks: `SessionStart` (re-inject), `PreCompact` (snapshot), `Stop` (snapshot-only in MVP)
- `Stop` is **snapshot-only** in this MVP; auto-archive A1–A4 gate ships in a follow-up PR alongside `/orchestrator:done` and macro-phase `terminal_marker` mapping

### Deferred (follow-up PRs)

- `/orchestrator:next` and `/orchestrator:done` commands
- Cross-plugin invocation contract (orchestrator → engineer) per ADR-0018 §sub-decision-1 follow-up ADR
- Meta commands: `/orchestrator:resume`, `/orchestrator:checkpoint`, `/orchestrator:peer-now`
- `Stop` auto-archive A1–A4 gate (macro-phase mapping)
