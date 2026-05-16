# omcc-dev Legacy Pattern Map

Status: Draft
Last reviewed: 2026-05-16
Scope: `../omcc/plugins/omcc-dev` plus the adjacent `omcc-research` and
`omcc-designer` handoff patterns that `omcc-dev:start` could consume.

This map supports the R1/R2 cutover gates in
[`omcc-cutover-scorecard.md`](omcc-cutover-scorecard.md). It is intentionally
behavior-oriented: a legacy surface can be cut over only when the behavior is
improved, retained, rejected with rationale, or deferred with an explicit
statement that no active daily workflow depends on it.

## Status Terms

- `improved`: agentic-plugins keeps the user value and replaces the legacy
  shape with a more portable, testable, or explicit surface.
- `retained`: agentic-plugins keeps the behavior with roughly the same
  semantics because it is still useful and portable.
- `rejected`: agentic-plugins intentionally drops the behavior because it
  violates a current boundary or duplicated a better surface.
- `deferred`: agentic-plugins has not shipped the behavior because it is future
  domain scope and is not load-bearing for current daily development.

## Pattern Inventory

| ID | Legacy surface | Legacy evidence | Agentic-plugins disposition | Replacement evidence | Status | Cutover impact |
|---|---|---|---|---|---|---|
| D1 | `/omcc-dev:start` feature workflow | `../omcc/plugins/omcc-dev/commands/start.md` | Single-deliverable feature work moved into engineer's lifecycle macro with explicit phase routing and state contracts. | `plugins/engineer/commands/start.md`; `plugins/engineer/skills/start/SKILL.md`; `tests/engineer/test-start-command.mjs`; ADR-0020/0021 | improved | Active daily workflow should use `/engineer:start` or `$engineer:start`. |
| D2 | `/omcc-dev:fix` root-cause bug workflow | `../omcc/plugins/omcc-dev/commands/fix.md` | Root-cause-first work is split into investigate for diagnosis and refine for implementation, with the entry-routing quality gate blocking premature patching. | `plugins/engineer/skills/investigate/SKILL.md`; `plugins/engineer/skills/refine/SKILL.md`; `tests/engineer/test-start-command.mjs`; `docs/assurance/omcc-cutover-scorecard.md` R7a | improved | Active daily workflow has a direct engineer replacement. |
| D3 | `/omcc-dev:audit` systematic codebase audit | `../omcc/plugins/omcc-dev/commands/audit.md` | Audit work is decomposed into engineer critique/review, orchestrator planning for multi-deliverable reviews, and runtime consensus when complementary host opinions are needed. | `plugins/engineer/skills/critique/SKILL.md`; `plugins/orchestrator/commands/plan.md`; `plugins/runtime/commands/consensus.md`; `tests/runtime/test-consensus.mjs` | improved | Active daily workflow has direct engineer/orchestrator/runtime replacements. |
| D4 | `/omcc-dev:resume` workflow recovery | `../omcc/plugins/omcc-dev/commands/resume.md`; `../omcc/plugins/omcc-dev/continuity-protocol.md` | Resume is retained through engineer and orchestrator meta surfaces, but the storage model is branch-keyed and migratable rather than the legacy shard layout. | `plugins/engineer/commands/resume.md`; `plugins/engineer/skills/resume/SKILL.md`; `plugins/orchestrator/commands/resume.md`; `plugins/runtime/commands/migrate.md`; ADR-0018/0025 | improved | Active daily workflow uses agentic-plugins state homes and migration checks. |
| D5 | `/omcc-dev:checkpoint` explicit handoff | `../omcc/plugins/omcc-dev/commands/checkpoint.md`; `../omcc/plugins/omcc-dev/hooks/hooks.json` | Checkpoint remains a first-class continuity operation across engineer and orchestrator, with runtime context/footer evidence for handoff quality. | `plugins/engineer/commands/checkpoint.md`; `plugins/engineer/skills/checkpoint/SKILL.md`; `plugins/orchestrator/commands/checkpoint.md`; `plugins/runtime/commands/context.md`; `plugins/runtime/scripts/footer.mjs` | retained | Active daily workflow has direct replacements. |
| D6 | `/omcc-dev:codex-now` ad hoc Codex perspective | `../omcc/plugins/omcc-dev/commands/codex-now.md` | Ad hoc peer input is replaced by explicit peer-now and consensus surfaces that store pointers, classify lanes, and avoid dumping raw peer output into the main session. | `plugins/engineer/commands/peer-now.md`; `plugins/engineer/skills/peer-now/SKILL.md`; `plugins/orchestrator/commands/peer-now.md`; `plugins/runtime/commands/consensus.md`; `tests/runtime/test-consensus.mjs` | improved | Active daily workflow has direct replacements. |
| D7 | `brainstorm` evidence-based decision skill | `../omcc/plugins/omcc-dev/skills/brainstorm/SKILL.md` | Decision work moved to engineer decide and the entry-routing decision contract, which requires options, tradeoffs, risks, evidence, and a recommendation. | `plugins/engineer/skills/decide/SKILL.md`; `tests/engineer/test-start-command.mjs`; `docs/assurance/omcc-cutover-scorecard.md` R6 | improved | Active daily workflow has direct replacement. |
| D8 | `explore` codebase exploration skill | `../omcc/plugins/omcc-dev/skills/explore/SKILL.md` | Exploration is split by intent across frame, investigate, and start phase-0/phase-1 routing. | `plugins/engineer/skills/frame/SKILL.md`; `plugins/engineer/skills/investigate/SKILL.md`; `plugins/engineer/commands/start.md` | improved | Active daily workflow has direct replacement. |
| D9 | `investigate` root-cause skill | `../omcc/plugins/omcc-dev/skills/investigate/SKILL.md` | Root-cause analysis is retained and expanded with cited-brief research profile support and the no-patch-before-root-cause rule. | `plugins/engineer/skills/investigate/SKILL.md`; `plugins/engineer/skills/refine/SKILL.md`; `tests/engineer/test-cited-brief.mjs`; ADR-0014/0015 | improved | Active daily workflow has direct replacement. |
| D10 | `parallel-review` multi-perspective review skill | `../omcc/plugins/omcc-dev/skills/parallel-review/SKILL.md` | Review breadth is retained through engineer critique, orchestrator plan/review lanes, and runtime consensus with bounded peer rosters. | `plugins/engineer/skills/critique/SKILL.md`; `plugins/orchestrator/commands/plan.md`; `plugins/runtime/scripts/consensus.mjs`; `tests/runtime/test-consensus.mjs` | improved | Active daily workflow has direct replacement. |
| D11 | `plan` dependency-ordered task decomposition skill | `../omcc/plugins/omcc-dev/skills/plan/SKILL.md` | Planning is split into engineer start for single-deliverable lifecycle work and orchestrator plan for macro/multi-deliverable work. | `plugins/engineer/commands/start.md`; `plugins/orchestrator/commands/plan.md`; ADR-0018/0020 | improved | Active daily workflow has direct replacement. |
| D12 | Claude subagents: architecture-mapper, flow-tracer, hypothesis-tracer, reviewer | `../omcc/plugins/omcc-dev/agents/*.md` | Claude adapter agents are retained where the host supports them; Codex keeps explicit skill/manual/peer lanes rather than pretending subagent semantics are portable. | `plugins/engineer/adapters/claude/agents/*.md`; `plugins/runtime/docs/host-parity-baseline.md`; ADR-0001 | improved | Active daily workflow must not depend on Claude-only agents when Codex equivalence is required. |
| D13 | SessionStart, PreCompact, and Stop hooks | `../omcc/plugins/omcc-dev/hooks/hooks.json` | Hook-assisted continuity is retained in host adapters, while runtime makes Codex hook feature/trust asymmetry explicit instead of treating it as silent parity. | `plugins/engineer/hooks/hooks.json`; `plugins/orchestrator/hooks/hooks.json`; `plugins/runtime/scripts/doctor.mjs`; `plugins/runtime/docs/codex-capability-baseline.md` | improved | Active daily workflow has replacements, with Codex hook trust as explicit operator evidence. |
| D14 | `.claude/omcc-dev` schema-2 shards and active registry | `../omcc/plugins/omcc-dev/continuity-protocol.md` | Legacy sharding was not ported. Agentic-plugins uses canonical `.agentic-plugins/state` homes, branch-keyed workflows, parent linkage, and explicit migration from older `.claude/agentic-*` homes. | `plugins/runtime/commands/migrate.md`; `plugins/runtime/scripts/migrate-workflow-storage.mjs`; `docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md`; `docs/adr/0025-workflow-storage-migration.md` | improved | Active daily workflow depends on canonical state, not legacy omcc shards. |
| D15 | Framework docs: orchestration, taxonomy, ensemble, presentation, continuity | `../omcc/plugins/omcc-dev/orchestration.md`; `agent-taxonomy.md`; `ensemble-protocol.md`; `presentation-protocol.md`; `continuity-protocol.md` | Concepts were split into ADR-backed layer boundaries, shared references, and per-plugin skills instead of one large plugin-local framework. | `docs/ARCHITECTURE.md`; `docs/adr/0010-plugin-boundary-policy.md`; `docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md`; `plugins/engineer/references/`; `plugins/orchestrator/references/` | improved | Active daily workflow reads agentic-plugins docs and skills. |
| D16 | Automatic Codex ensemble at phase boundaries | `../omcc/plugins/omcc-dev/commands/start.md`; `../omcc/plugins/omcc-dev/commands/audit.md` | Hidden automatic ensemble behavior is rejected as a default. Agentic-plugins keeps quality-first peer breadth through explicit consensus/peer-now surfaces with max rounds, peer rosters, and user-visible execution boundaries. | `plugins/runtime/commands/consensus.md`; `plugins/runtime/scripts/consensus.mjs`; `docs/assurance/omcc-cutover-scorecard.md` R10/R11 | rejected | No active daily dependency; peer execution remains explicit and bounded. |
| D17 | Artifact intake from `DESIGN.md` and `research_brief.md` | `../omcc/plugins/omcc-dev/commands/start.md` | Automatic designer/research artifact intake is deferred because the corresponding domain plugins are not the active cutover path. Engineer can still consume files when the user provides them as ordinary repo context. | `plugins/engineer/commands/start.md`; `docs/DEVELOPMENT.md` Stage 3+ runtime/operator track; ADR-0014/0015 | deferred | No active daily dependency; future domain-plugin work can reintroduce typed intake if it becomes load-bearing. |
| D18 | `omcc-research` handoff into `research_brief.md` | `../omcc/plugins/omcc-research` | The standalone research plugin pattern was retired; cited brief behavior moved into engineer investigate. | `docs/adr/0014-plugins-research-deprecation.md`; `docs/adr/0015-research-plugin-archive-timeline.md`; `plugins/engineer/skills/investigate/SKILL.md`; `tests/engineer/test-cited-brief.mjs` | improved | Active daily workflow has direct replacement through engineer investigate. |
| D19 | `omcc-designer` handoff into `DESIGN.md` | `../omcc/plugins/omcc-designer` | Designer remains future L3 domain work, not a cutover prerequisite for the current agentic-plugins self-development loop. | `AGENTS.md` Stage 3+ notes; `docs/DEVELOPMENT.md` runtime/operator target; ADR-0010 layer model | deferred | No active daily dependency; future designer plugin work should start from the 4-layer model. |
| D20 | Main-session raw peer output synthesis | `../omcc/plugins/omcc-dev/commands/codex-now.md`; `../omcc/plugins/omcc-dev/ensemble-protocol.md` | Raw peer output in the main session is rejected. Runtime and engineer/orchestrator surfaces use artifact pointers and summaries so continuity remains durable and bounded. | `plugins/runtime/commands/consensus.md`; `plugins/runtime/scripts/consensus.mjs`; `plugins/runtime/scripts/footer.mjs`; `tests/runtime/test-consensus.mjs`; `tests/runtime/test-footer.mjs` | rejected | No active daily dependency; operator can open artifacts when needed. |

## Active Daily Workflow Dependency Assessment

Current agentic-plugins development depends on engineer, orchestrator, runtime,
companions, git, GitHub, release-please, and the explicit installed-state
refresh loop in `omcc-cutover-scorecard.md`. The retained/improved rows above
cover those daily needs. The rejected rows remove hidden or non-portable
behavior. The deferred rows are future domain-plugin scope and are not required
for the active runtime/operator development track.

## R1/R2 Satisfaction Claim

R1 is satisfied by this inventory because every retained omcc-dev behavior has
an agentic-plugins equivalent, improvement, or rejection/deferment rationale.
R2 is satisfied when `runtime:cutover` reports this map as satisfied: all D1-D20
rows must be present, every status must be one of the terms above, and any
`rejected` or `deferred` row must explicitly state that no active daily workflow
depends on it.
