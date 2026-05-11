# Changelog

## Unreleased

### Features

- **ADR-0019 PR-E — macro completion lifecycle**: `/orchestrator:finalize` + `/orchestrator:abort` slash-command runbooks implement the §5 three-step ritual (bulk subtask status transition → active-children detach pass → terminal markers). Engineer children are routed cross-plugin via the new `state.mjs` `stop-archive` / `detach-archive` CLIs (PR-E engineer side; orchestrator probes the child's `git_baseline.branch` HEAD via `git rev-parse` and passes it as explicit `--head-sha` per ADR-0019 §5 D-ε′).
- **Macro auto-archive A1–A4** on `Stop`: orchestrator hooks (Claude auto + Codex manual helper) now invoke `runMacroStopArchiveAll` which iterates every non-archived macro under `workflows/`, snapshots each, evaluates the four hard gates (terminal_marker / macro terminal_phase / all_subtasks_terminal / no_active_engineer_children), and atomically moves passing macros into `archive/`. Branch-agnostic discovery — the Stop event firing on a subtask branch still archives the parent macro on its own branch.
- **`scripts/stop-archive.mjs`** (new): pure `evaluateMacroStopArchive` gate evaluator + composite `runMacroStopArchive` + branch-agnostic iterator `runMacroStopArchiveAll`. Mirrors engineer's stop-archive shape with the §5 macro-specific divergences.
- **`scripts/state.mjs` primitives**: `archiveWorkflow` + `bulkSubtaskStatus` (atomic, domain-constrained from→to enum) + `setMacroTerminal` (atomic terminal_phase + terminal_marker write) + predicates `terminalMarkerCheck` / `macroTerminalPhaseCheck` / `allSubtasksTerminalCheck` + scan helpers `listAllMacros` / `noActiveEngineerChildrenScan`. New CLI subcommands `bulk-subtask-status`, `set-terminal`, `archive`.
- **`scripts/discover-engineer.mjs` preflight extension**: probe for the two new engineer CLI subcommand tokens (`detach-archive` + `stop-archive`) so a PR-D-era engineer install (without PR-E CLIs) is rejected with a clear diagnostic before `/orchestrator:finalize` / `/orchestrator:abort` dispatch.

### Internal

- `VALID_HOOK_EVENTS` extended with `archived` for the macro auto-archive host_history event.
- `tests/orchestrator/test-stop-archive.mjs`, `test-finalize.mjs`, `test-abort.mjs` new test files; `test-state.mjs`, `test-discover-engineer.mjs`, `test-hooks.mjs`, `tests/plugin-shape/test-orchestrator-plugin.mjs` extended.

## [0.3.0](https://github.com/each4all/agentic-plugins/compare/plugin-orchestrator-v0.2.0...plugin-orchestrator-v0.3.0) (2026-05-11)


### Features

* **orchestrator+engineer:** /finalize + /abort + macro stop-archive A1-A4 (ADR-0019 PR-E) ([#67](https://github.com/each4all/agentic-plugins/issues/67)) ([c0d5c0b](https://github.com/each4all/agentic-plugins/commit/c0d5c0b622d690ae3a23f83ba5c317089fe4be6b))
* **orchestrator+engineer:** /next + /done dispatch + Phase 0 parent-linkage (ADR-0019 PR-D) ([#66](https://github.com/each4all/agentic-plugins/issues/66)) ([084848a](https://github.com/each4all/agentic-plugins/commit/084848ad829386ccf67649699bea79bcd9ae426d))
* **plugins/orchestrator:** schema 1.1 bump + plan producers (ADR-0019 PR-B) ([#63](https://github.com/each4all/agentic-plugins/issues/63)) ([8bf71c2](https://github.com/each4all/agentic-plugins/commit/8bf71c2649634a4f4cd8fd23b8aba8d17e83fb1a))
* **plugins/orchestrator:** single-subtask update API (ADR-0019 PR-C0) ([#64](https://github.com/each4all/agentic-plugins/issues/64)) ([8b6a685](https://github.com/each4all/agentic-plugins/commit/8b6a685763342f2fabeaaa0ef62d33eaa258d3f3))

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
