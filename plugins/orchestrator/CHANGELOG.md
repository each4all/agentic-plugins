# Changelog

## Unreleased

### Features

- **Meta-command parity**: `/orchestrator:resume`, `/orchestrator:checkpoint`, and `/orchestrator:peer-now` now ship as Claude command runbooks plus Codex meta skills. They mirror engineer continuity patterns while staying in the macro workflow namespace (`.claude/agentic-orchestrator`, `workflow_type: macro`).
- **Checkpoint persistence**: orchestrator `state.mjs` now supports `latest_checkpoint` and `checkpoint-set`; Claude SessionStart re-injects `checkpoint_summary` / `checkpoint_at`, and Codex does the same after plugin hooks are enabled and reviewed/trusted in `/hooks`.
- **`/orchestrator:audit` follow-up alias**: audit findings can be turned into a macro remediation plan via canonical `/orchestrator:plan Audit follow-up: ...`; the state verb remains `plan` and workflow ids remain `macro-plan-...`.
- **ADR-0019 PR-E — macro completion lifecycle**: `/orchestrator:finalize` + `/orchestrator:abort` slash-command runbooks implement the §5 three-step ritual (bulk subtask status transition → active-children detach pass → terminal markers). Engineer children are routed cross-plugin via the new `state.mjs` `stop-archive` / `detach-archive` CLIs (PR-E engineer side; orchestrator probes the child's `git_baseline.branch` HEAD via `git rev-parse` and passes it as explicit `--head-sha` per ADR-0019 §5 D-ε′).
- **Macro auto-archive A1–A4** on `Stop`: orchestrator hooks (Claude auto + trusted Codex auto, with a Codex fallback helper) now invoke `runMacroStopArchiveAll` which iterates every non-archived macro under `workflows/`, snapshots each, evaluates the four hard gates (terminal_marker / macro terminal_phase / all_subtasks_terminal / no_active_engineer_children), and atomically moves passing macros into `archive/`. Branch-agnostic discovery — the Stop event firing on a subtask branch still archives the parent macro on its own branch.
- **`scripts/stop-archive.mjs`** (new): pure `evaluateMacroStopArchive` gate evaluator + composite `runMacroStopArchive` + branch-agnostic iterator `runMacroStopArchiveAll`. Mirrors engineer's stop-archive shape with the §5 macro-specific divergences.
- **`scripts/state.mjs` primitives**: `archiveWorkflow` + `bulkSubtaskStatus` (atomic, domain-constrained from→to enum) + `setMacroTerminal` (atomic terminal_phase + terminal_marker write) + predicates `terminalMarkerCheck` / `macroTerminalPhaseCheck` / `allSubtasksTerminalCheck` + scan helpers `listAllMacros` / `noActiveEngineerChildrenScan`. New CLI subcommands `bulk-subtask-status`, `set-terminal`, `archive`.
- **`scripts/discover-engineer.mjs` preflight extension**: probe for the two new engineer CLI subcommand tokens (`detach-archive` + `stop-archive`) so a PR-D-era engineer install (without PR-E CLIs) is rejected with a clear diagnostic before `/orchestrator:finalize` / `/orchestrator:abort` dispatch.

### Internal

- `VALID_HOOK_EVENTS` extended with `archived` for the macro auto-archive host_history event and `checkpointed` for macro checkpoints.
- `tests/orchestrator/test-stop-archive.mjs`, `test-finalize.mjs`, `test-abort.mjs` new test files; `test-state.mjs`, `test-discover-engineer.mjs`, `test-hooks.mjs`, `tests/plugin-shape/test-orchestrator-plugin.mjs` extended.

## [0.11.0](https://github.com/each4all/agentic-plugins/compare/plugin-orchestrator-v0.10.0...plugin-orchestrator-v0.11.0) (2026-07-02)


### Features

* **plugin/orchestrator:** adopt ADR-0029 Active Next-Action Proposal on macro completion surfaces (orch-next-action-shape) ([#467](https://github.com/each4all/agentic-plugins/issues/467)) ([04dbed4](https://github.com/each4all/agentic-plugins/commit/04dbed438cf0f200113ce3bce62da2ff28e345c0))
* **plugin/orchestrator:** code-emit the completion footer on the terminal path (ADR-0039 orch-wire) ([#466](https://github.com/each4all/agentic-plugins/issues/466)) ([2cd24f9](https://github.com/each4all/agentic-plugins/commit/2cd24f9a209e6d816d9ce12221a735a12d4a760a))

## [0.10.0](https://github.com/each4all/agentic-plugins/compare/plugin-orchestrator-v0.9.0...plugin-orchestrator-v0.10.0) (2026-06-23)


### Features

* **plugin/orchestrator:** ADR-0031 activation sidecar — fire session-handoff from macro terminal surfaces ([#432](https://github.com/each4all/agentic-plugins/issues/432)) ([15eb4f3](https://github.com/each4all/agentic-plugins/commit/15eb4f3ecd3d9a091af84aee218f194b8f60506d))
* **plugin/orchestrator:** ADR-0031 hook backstop — late re-surface macro session-handoff from Stop/SessionStart ([#434](https://github.com/each4all/agentic-plugins/issues/434)) ([c763006](https://github.com/each4all/agentic-plugins/commit/c763006561f1044e1eaa1455ac38f3fa58469eb4))

## [0.9.0](https://github.com/each4all/agentic-plugins/compare/plugin-orchestrator-v0.8.0...plugin-orchestrator-v0.9.0) (2026-06-04)


### Features

* **plugin/orchestrator:** ADR-0031 session-level handoff projection (orchestrator-wiring) ([#381](https://github.com/each4all/agentic-plugins/issues/381)) ([f82003f](https://github.com/each4all/agentic-plugins/commit/f82003fd31f12b45e6814116ad8bd9eed938cddf))

## [0.8.0](https://github.com/each4all/agentic-plugins/compare/plugin-orchestrator-v0.7.3...plugin-orchestrator-v0.8.0) (2026-06-01)


### Features

* **orchestrator:** port ADR-0028 forward-compat — read tolerance + serialize preserve ([#357](https://github.com/each4all/agentic-plugins/issues/357)) ([acaa734](https://github.com/each4all/agentic-plugins/commit/acaa734fa343ad49c7dddb83b6391c44e6a60d9e))

## [0.7.3](https://github.com/each4all/agentic-plugins/compare/plugin-orchestrator-v0.7.2...plugin-orchestrator-v0.7.3) (2026-05-17)


### Bug Fixes

* resolve Codex hook Node lookup ([b68d17c](https://github.com/each4all/agentic-plugins/commit/b68d17cdc495977719332eb7a3734dfa4dd1c8e9))

## [0.7.2](https://github.com/each4all/agentic-plugins/compare/plugin-orchestrator-v0.7.1...plugin-orchestrator-v0.7.2) (2026-05-15)


### Bug Fixes

* **plugin/orchestrator:** add Codex-native lifecycle hooks ([53de0f1](https://github.com/each4all/agentic-plugins/commit/53de0f11a3302da91013551ed4d538178d2cfdd0))

## [0.7.1](https://github.com/each4all/agentic-plugins/compare/plugin-orchestrator-v0.7.0...plugin-orchestrator-v0.7.1) (2026-05-14)


### Bug Fixes

* diagnose Codex plugin hook readiness ([e80ed84](https://github.com/each4all/agentic-plugins/commit/e80ed84565fc8326b8baf6c6e401b746de0f26f5))

## [0.7.0](https://github.com/each4all/agentic-plugins/compare/plugin-orchestrator-v0.6.0...plugin-orchestrator-v0.7.0) (2026-05-14)


### Features

* **plugin/orchestrator:** mirror lifecycle commands as codex skills ([9945a02](https://github.com/each4all/agentic-plugins/commit/9945a0213b0405fac6f755e82c4221e3f06de9fd))

## [0.6.0](https://github.com/each4all/agentic-plugins/compare/plugin-orchestrator-v0.5.0...plugin-orchestrator-v0.6.0) (2026-05-13)


### Features

* **plugin/orchestrator:** support canonical workflow state home ([b388ba2](https://github.com/each4all/agentic-plugins/commit/b388ba2414cc0e8d32b3e9e81c3f3e5647a45dda))

## [0.5.0](https://github.com/each4all/agentic-plugins/compare/plugin-orchestrator-v0.4.0...plugin-orchestrator-v0.5.0) (2026-05-12)


### Features

* **plugin/orchestrator:** add meta command parity ([b456e04](https://github.com/each4all/agentic-plugins/commit/b456e047bd46214ee397b410f2c7e8862e918c05))

## [0.4.0](https://github.com/each4all/agentic-plugins/compare/plugin-orchestrator-v0.3.0...plugin-orchestrator-v0.4.0) (2026-05-12)


### Features

* **plugin/orchestrator:** route plan ensembles through peer-runner ([49649f9](https://github.com/each4all/agentic-plugins/commit/49649f9e6a0a66ea17f93d114b29bd565937db65))

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
