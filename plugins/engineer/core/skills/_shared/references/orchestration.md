# Dynamic Agent Orchestration

Follow this framework at every stage that allocates agents.
Pursue the best results through task-analysis-based dynamic composition,
not static counts.

**Plugin boundary note**: this orchestration framework is
engineer-internal (lives at
`plugins/engineer/skills/_shared/references/`). Per ADR-0010 §5,
cross-plugin imports are forbidden — when Stage 3+ designer plugin
needs equivalent orchestration, it MUST ship its own copy. If the
framework proves universal across L3 personas during Stage 3
implementation, an L1/L2 extraction may be considered through a
fresh ADR; this file does NOT serve cross-persona imports as-is.

The **orchestrator** is the host where the user is currently invoking the
skill (Claude Code or Codex CLI). It dispatches its host's local agents
(Claude `Agent` tool subagents, or Codex internal context analysis) and the
**peer** host's companion ensemble in parallel per `ensemble-protocol.md`.
The orchestrator/peer assignment is symmetric — every `/engineer:*` skill
runs from either side.

---

## Principles

1. **Quality first**: Optimize for result quality, not token efficiency.
2. **Max effort**: Every primary agent uses the host's
   maximum-effort/maximum-depth configuration. Skills do not override the
   user's host-level model/effort settings.
3. **Task decides**: No predefined minimum/maximum agent count. If the task
   requires 1, use 1; if it requires 7, use 7.
4. **Mission-specific**: Assign concrete missions tailored to this task,
   not generic perspective labels.
5. **No overlap**: Clearly delineate mission boundaries so multiple
   perspectives do not review the same area.

---

## Orchestration Process

Before allocating agents, always perform these 3 steps.

### Step 1: Task Profiling

Analyze the task along the following dimensions and record the result in
this format:

```
Task Profile:
  Scope: [file count], [estimated LOC]
  Layers: [framework layers + project layers]
  Persona: [engineer | (designer in Stage 3+)]
  Profile: [profile arg, e.g., backend / frontend / devops / sre / ml / data]
  Risks: [list applicable risk areas, or "none"]
  Complexity: [low / medium / high]
  Ensemble Affinity: [LOW / MEDIUM / HIGH]
```

The Persona + Profile axes encode the 4-layer composition (per ADR-0010):
the persona dictates which L3 plugin owns the orchestration; the profile
passes L4 sub-discipline context to skills (source priorities, evaluation
criteria, vocabulary, etc.).

**Analysis dimensions**:

- **Scope**: Number of files changed/targeted, LOC, related directories
  and modules.
- **Layers**: Framework layers (L1 framework primitive / L2 capability /
  L3 persona / L4 profile per ADR-0010) plus project layers (UI / API /
  business logic / data / infrastructure / configuration).
- **Persona**: which L3 plugin is invoked (`engineer` for now; `designer`
  from Stage 3).
- **Profile**: the `--profile=<name>` argument carrying sub-discipline
  context (`backend` / `frontend` / `devops` / `sre` / `ml` / `data`,
  etc.). May be empty when the verb operates persona-wide.
- **Risk areas**: Security / Data / Public interfaces / Concurrency /
  Failure / Novelty / Precedent / Downstream blast radius.
- **Complexity**: Domain complexity, algorithmic depth, cross-service
  coordination.
- **Ensemble Affinity**: LOW / MEDIUM / HIGH. Recorded for context;
  **NOT a dispatch gate** — engineer's always-max policy dispatches the
  peer ensemble at every phase boundary regardless, per
  `ensemble-protocol.md`. The Affinity rating informs orchestrator-side
  agent count decisions (HIGH suggests more local perspectives, LOW
  fewer).

### Step 2: Agent Composition

Select roles from `agent-taxonomy.md`.

**Selection criteria — ask yourself for each role:**

> "If this perspective is missing, could this task have a **real defect**
> that goes undetected?"

- YES → include
- NO → exclude

> "Can this perspective provide meaningful feedback that **does not
> overlap** with other selected perspectives?"

- YES → include
- NO → exclude (not applicable or absorbed by another perspective)

**Overlap resolution:**

When two roles overlap in scope (e.g., correctness and concurrency both
examining shared state access):
- If you can write non-overlapping specific missions for each → include
  both, separate via mission boundaries.
- If separating missions still results in reviewing the same thing →
  merge into the broader role.

**Guidelines:**

- Do not over-allocate for simple changes. A README typo fix does not
  need a security reviewer.
- Do not omit perspectives for complex changes. An auth refactoring must
  include security.
- Judge by **actual risk**, not surface-level characteristics. A config
  file change can affect security.

### Step 3: Mission Briefing

Give each selected agent a **concrete mission specific to this task**.

**Bad mission:**
> "Review from a correctness perspective"

**Good mission:**
> "Verify session state transition correctness in this auth middleware
> refactoring. Focus on behavior during concurrent requests while tokens
> are being refreshed, and check how error paths change now that the
> extractToken function has been removed."

**Mission writing rules:**

1. Include the specific context of this task.
2. Specify particular files/functions/areas to focus on.
3. Concretize the key question from `agent-taxonomy.md` for this task.
4. Explicitly state boundaries to avoid overlap with other agents'
   missions.

**Ensemble parallel track:**

The orchestrator launches the peer ensemble (Codex from Claude side, or
Claude from Codex side) per `ensemble-protocol.md` in parallel with the
selected local agents. The dispatch is automatic on every `/engineer:*`
phase boundary (always-max policy); affinity is recorded but does not
gate.

The peer runs as an independent parallel track — it is NOT an "agent" in
the agent taxonomy. Do not include it in the agent count or mission
briefing. It receives its own prompt via `ensemble-protocol.md`.

### Agent failure handling

If any local agent fails to return (timeout, error, or empty result):

1. Notify the user which agent (perspective) failed.
2. Ask: retry, or proceed with available results?
3. Follow the user's decision.
4. If proceeding without retry, note the missing perspective in the
   synthesis output so the user knows coverage was incomplete.

Peer ensemble failures are handled separately per `ensemble-protocol.md`
§Failure Handling — graceful degradation, never blocks the workflow.

---

## Examples

### Example 1: Investigate — understanding codebase before multi-layer feature

```
Task Profile:
  Scope: New feature spans 3 layers (API + business logic + data)
  Layers: L3 engineer, project: API + business logic + data
  Persona: engineer
  Profile: backend
  Risks: Need to identify integration points with existing code
  Complexity: medium
  Ensemble Affinity: MEDIUM (recorded, not gating)

Agent Composition:
  architecture-mapper x 1 — "Map the connection structure between API
                            and data layers, existing endpoint patterns"
  flow-tracer x 1         — "Trace the request flow of the most similar
                            existing feature to understand integration
                            patterns"
  dependency-analyzer x 1 — "Analyze the dependency graph and impact
                            radius of modules the new feature will touch"
Ensemble: peer dispatched per ensemble-protocol.md (always-max).
```

### Example 2: Investigate — intermittent 500 errors after deployment

```
Task Profile:
  Scope: Error logs in 2 services
  Layers: L3 engineer, project: API + data
  Persona: engineer
  Profile: backend
  Risks: Concurrency (connection pool), failure (external service timeout)
  Complexity: high (intermittent — hard to reproduce)
  Ensemble Affinity: HIGH

Agent Composition:
  hypothesis-tracer x 1  — "DB connection pool exhaustion hypothesis:
                            trace leak points in connection
                            acquire/release paths"
  regression-hunter x 1  — "Search recent deployment diffs for
                            connection management or timeout
                            configuration changes"
  state-analyzer x 1     — "Analyze state transitions during request
                            processing, especially resource cleanup in
                            error paths"
Ensemble: peer dispatched per ensemble-protocol.md.
```

### Example 3: Critique — auth middleware refactoring

```
Task Profile:
  Scope: 3 files, 150 LOC
  Layers: L3 engineer, project: API + business logic
  Persona: engineer
  Profile: backend
  Risks: Security (auth, sessions), public interface (middleware contract)
  Complexity: medium
  Ensemble Affinity: HIGH

Agent Composition:
  correctness x 1 — "Session state transition correctness, edge cases
                    in token refresh logic"
  security x 1    — "Token handling, CSRF defense, session fixation
                    attack vectors"
  api-design x 1  — "Middleware interface backward compatibility,
                    consumer code impact"
  conventions x 1 — "Whether middleware patterns are consistent with
                    existing project middleware"
  concurrency x 1 — "Session state race conditions under concurrent
                    requests"
Ensemble: peer Review point type dispatched per
          ensemble-protocol.md (peer `task` invocation with the
          Review prompt template).
```

### Example 4: Critique full-codebase — DB schema migration + API change

```
Task Profile:
  Scope: 8 files, 300 LOC
  Layers: L3 engineer, project: API + data + business logic
  Persona: engineer
  Profile: backend
  Risks: Data (schema change), public interface (API), failure
         (migration failure)
  Complexity: high
  Ensemble Affinity: HIGH

Agent Composition:
  correctness x 1        — "Migration SQL logic correctness, API handler
                            mapping to new schema"
  migration-safety x 1   — "Rollback feasibility, existing data
                            preservation, migration ordering"
  performance x 1        — "New index efficiency, lock impact during
                            migration, query plan changes"
  api-design x 1         — "Response schema backward compatibility,
                            versioning strategy, client impact"
  error-resilience x 1   — "Recovery path on migration failure,
                            partial-apply state handling"
Ensemble: peer Adversarial-scan point type dispatched per
          ensemble-protocol.md (peer `task` invocation with the
          Adversarial-scan prompt template + sub-profile focus
          text).
```
