# Agent Taxonomy

Catalog of available agent capabilities for orchestration. The orchestrator
selects from this catalog via the process in `orchestration.md`.

**Plugin boundary note**: this file is engineer-internal (lives at
`plugins/engineer/skills/_shared/references/`). Per ADR-0010 §5,
cross-plugin imports are forbidden — when Stage 3+ designer plugin
needs an equivalent agent taxonomy, it MUST ship its own copy. If
the taxonomy proves universal across L3 personas during Stage 3
implementation, an L1/L2 extraction may be considered through a
fresh ADR; this file does NOT serve cross-persona imports as-is.

Agents listed here are **perspective definitions**. The actual agent
invocation mechanism is host-specific:

- **Claude Code side**: agents materialize as subagent definitions under
  `plugins/engineer/adapters/claude/agents/` (Deliverable D), invokable via
  the `Agent` tool with `subagent_type: "<name>"`.
- **Codex CLI side**: agents materialize as in-context perspective analysis
  driven by `plugins/engineer/adapters/codex/agents/` configurations
  (Deliverable D).

This taxonomy is host-neutral — perspective semantics, not invocation
plumbing.

## Agent types

**Primary agents** — have dedicated definition files and are invokable by
name on hosts that support subagent dispatch. The orchestrator names the
primary agent in its mission spec.

**Orchestration patterns** — named combinations of a primary agent + a
task-specific mission. Patterns are catalogued for orchestrator
convenience, but they are NOT separate callable types — the orchestrator
spawns the pattern's base primary agent with the pattern's mission text:

```
Agent({ subagent_type: "<primary-name>", prompt: "<custom mission>" })
```

Primary agents accept custom missions and follow them instead of their
default investigation targets.

---

## Analysis Agents

Used during exploration and understanding (`/engineer:investigate` analysis
profile). Map the structure and flow of the codebase.

### architecture-mapper (primary)

- **Purpose**: Map codebase structure, layers, entry points, and key
  abstractions
- **Key question**: "How is this system organized?"
- **Best for**: Understanding structure before adding features, analyzing
  architecture change impact

### flow-tracer (primary)

- **Purpose**: Trace request/data flows end-to-end from entry point to
  termination
- **Key question**: "Where does data enter, how is it transformed, and
  where is it stored?"
- **Best for**: Understanding existing behavior, tracing bug impact paths,
  identifying performance bottlenecks

### dependency-analyzer (pattern, base: architecture-mapper)

- **Purpose**: Map module dependencies and change impact radius
- **Spawn as**: `architecture-mapper` + mission focused on dependency
  graphs and impact scope
- **Key question**: "How far does this change's impact reach?"
- **Best for**: Scoping refactoring, detecting dependency cycles, analyzing
  breaking change impact

### pattern-detector (pattern, base: flow-tracer)

- **Purpose**: Identify recurring patterns, anti-patterns, and consistency
  deviations in the codebase
- **Spawn as**: `flow-tracer` + mission focused on pattern extraction and
  deviation detection
- **Key question**: "What patterns repeat in this codebase, and where do
  they deviate?"
- **Best for**: Pre-refactoring assessment, coding convention audits

---

## Review Agents

Used during verification and quality assurance (`/engineer:critique`).
All use the host's reviewer template and operate according to the assigned
perspective.

**Default candidates**: correctness and conventions should be considered
for inclusion in most code changes.
**Specialist roles**: The rest are selected only when the task's risk
areas apply.

### correctness

- **Focus**: Logic errors, edge cases, null/undefined risks, type mismatches
- **Key question**: "What inputs or states could produce wrong results?"
- **Best for**: All code changes (default inclusion candidate)

### simplicity

- **Focus**: Unnecessary complexity, code duplication, excessive
  abstraction, dead code
- **Key question**: "Can the same result be achieved more simply?"
- **Best for**: New feature implementation, refactoring

### conventions

- **Focus**: Project pattern consistency, naming, file structure, error
  handling style
- **Key question**: "Does this work the same way as the rest of the
  codebase?"
- **Best for**: All code changes (default inclusion candidate)

### security

- **Focus**: OWASP Top 10, authentication/authorization, secret exposure,
  injection, cryptography
- **Key question**: "How could this be exploited?"
- **Best for**: Auth/crypto code, user input handling, external API
  integration, secret management

### performance

- **Focus**: N+1 queries, unnecessary recomputation, memory leaks, large
  payloads, missing indexes
- **Key question**: "What happens at 10x/100x scale?"
- **Best for**: DB query changes, loop/iteration processing, caching
  logic, data serialization

### api-design

- **Focus**: Interface consistency, backward compatibility, contract
  compliance, versioning
- **Key question**: "Will consumers of this API break?"
- **Best for**: Public API/SDK changes, plugin interfaces, shared
  libraries

### migration-safety

- **Focus**: Schema change safety, data preservation, rollback feasibility,
  migration ordering
- **Key question**: "Can this be safely rolled back?"
- **Best for**: DB schema changes, data migrations, config format changes

### concurrency

- **Focus**: Race conditions, deadlocks, atomicity, shared state access
- **Key question**: "What happens under concurrent access?"
- **Best for**: Async code, shared resource access, queue/worker
  processing, cache invalidation

### error-resilience

- **Focus**: Failure propagation, retry logic, recovery paths, partial
  failure handling
- **Key question**: "What happens when this fails?"
- **Best for**: External service calls, network-dependent code,
  transaction processing, pipelines

### debt

- **Focus**: TODO/FIXME/HACK accumulation, deprecated API usage, test
  coverage gaps, technical debt
- **Key question**: "What maintenance burden does this create?"
- **Best for**: `/engineer:critique --profile=full-codebase` audits,
  legacy code changes, dependency updates

---

## Investigation Agents

Used during root cause analysis and debugging (`/engineer:investigate`
root-cause profile, `/engineer:refine` failure-mode tracing).

### hypothesis-tracer (primary)

- **Purpose**: Trace a specific hypothesis through the codebase to collect
  supporting/refuting evidence
- **Key question**: "If this hypothesis is correct, what evidence should
  be visible in the code?"
- **Best for**: When a specific root cause candidate exists, tracing
  logic/condition errors

### regression-hunter (pattern, base: hypothesis-tracer)

- **Purpose**: Search recent change history for commits/changes that
  caused a regression
- **Spawn as**: `hypothesis-tracer` + mission focused on recent
  git-diff-derived hypotheses
- **Orchestrator responsibility**: the base agent has no git access.
  Before spawning, run `git log --oneline -20` and collect relevant diffs
  (`git show`, `git diff`), and embed them in the mission prompt so the
  agent can reason about specific commits.
- **Key question**: "Which recent change broke this behavior?"
- **Best for**: "It worked before" type bugs, post-deployment incidents

### state-analyzer (pattern, base: hypothesis-tracer)

- **Purpose**: Analyze runtime state, data flow anomalies, and state
  transition errors
- **Spawn as**: `hypothesis-tracer` + mission focused on state transitions
  and runtime data shape
- **Key question**: "How does state change at runtime, and where does it
  diverge from expectations?"
- **Best for**: State-related bugs, cache inconsistency, data corruption,
  intermittent failures
