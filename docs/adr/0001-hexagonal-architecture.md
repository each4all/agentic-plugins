# ADR-0001: Hexagonal architecture (core / adapter / companion)

## Status

Accepted

## Context

agentic-plugins must work natively in two distinct AI agent CLI hosts —
Anthropic's Claude Code and OpenAI's Codex CLI — and allow each host to
invoke the other as a peer agent. The two hosts share open standards
for skills (Agent Skills, agentskills.io) and tools (Model Context
Protocol) but differ in their plugin manifest schemas, hook event
models, subagent invocation patterns, and runtime contracts.

A naive single-codebase approach (one set of files works in both)
breaks at the runtime boundary: hooks have different events, subagents
have different invocation models, paths resolve differently. A naive
fork approach (two codebases) duplicates the host-neutral content
(skills, MCP servers, persona descriptions) and guarantees drift.

Both naive approaches fail. A layered separation is required.

## Decision

agentic-plugins uses **Hexagonal architecture (ports and adapters)** with
three layers:

1. **CORE** (host-neutral, standards-aligned)
   - Holds: SKILL.md content (Agent Skills standard), MCP server
     implementations (MCP standard), persona descriptions, prompt
     templates (XML for companion contract), intent-only protocol docs
     (ensemble, continuity, orchestration as concept descriptions)
   - Single source of truth for "what" and "why"

2. **ADAPTER** (host-specific, **layered separation**)
   - One adapter per host: `adapters/claude/`, `adapters/codex/`
   - Holds: plugin manifest, hook configuration, subagent format
     conversion, host-specific orchestration implementation,
     continuity mechanism implementation, statusline/monitors (where
     applicable)
   - Adapters are **as thin as possible, but no thinner**. They contain
     whatever is required to honor core intent within the host's runtime
     model. Some adapters are substantial because the host's runtime
     contract demands it (e.g., Claude's auto-delegation vs Codex's
     explicit dispatch — same intent, different execution paths)
   - **Do not force false unification.** Where a host has unique
     runtime semantics (statusline, PreCompact, auto-delegation), the
     adapter implements them honestly; the other adapter implements its
     own host-native equivalent or documents the gap

3. **COMPANION** (bidirectional bridges, first-party)
   - `companions/claude-companion.mjs` (Codex → Claude peer-agent invocation)
   - `companions/codex-companion.mjs` (Claude → Codex peer-agent invocation)
   - Both implement the same `companions/contract.md`
   - Owned by agentic-plugins (no third-party dependency — see ADR-0004)

## Consequences

**Positive**:
- New host adoption is well-defined: add a new adapter folder, implement
  the four adapter contract items (ADR-0002), reuse the entire CORE
- CORE changes (skill body update, MCP server feature, persona refinement)
  apply to all hosts atomically with no host-specific changes
- Honest scope: where parity is not achievable, the limit is documented in
  the adapter, not papered over with false unification
- Companion contract is the framework's central asset and is shared by
  all adapters

**Negative**:
- Adapters can become substantial — the "thin adapter" intuition does
  not hold for hosts whose runtime model differs from another host's at
  the orchestration level
- Maintaining multiple adapters means tracking multiple host CLIs'
  evolution (Claude Code releases, Codex CLI releases)
- Two-host CI matrix (CORE tests + per-host adapter tests + companion
  round-trip tests)

**Neutral**:
- The framework is opinionated about layered separation. Plugin authors
  who want to skip layering and write host-specific monoliths cannot
  use agentic-plugins for that
- Persona description in CORE is host-neutral but adapter generates the
  host-specific format (markdown+YAML for Claude, TOML for Codex). This
  is auto-generation, not duplication

## Honest scope (final note)

agentic-plugins does NOT promise that every conceivable feature is unifiable
across hosts. The framework's promise is:

- Skills, MCP servers, persona descriptions, prompt templates: **fully
  host-neutral**, single source of truth
- Plugin manifests, hooks, subagent formats: **mechanically translated**
  from CORE intent to host format by the adapter
- Orchestration patterns, continuity mechanisms, host-specific UX
  (statusline, monitors): **separately implemented per host** to honor
  each host's native runtime model. The adapter contract requires the
  *outcome* but not a single implementation path

This boundary exists because attempting to unify host runtime semantics
produces the Electron-style "feels off in both" failure mode. agentic-plugins
prioritizes feeling native in each host over unifying implementation.

## Alternatives Considered

1. **Single shared codebase, no adapters** — Rejected. Cannot bridge
   different hook event models, subagent invocation patterns, or
   manifest schemas without false unification.

2. **Two parallel forks of each plugin** — Rejected. Guarantees drift.
   Loses the value of standards (Agent Skills, MCP) which already
   provide a shared core.

3. **Build only for one host (Claude Code), let users translate** —
   Rejected. This is what omcc already does. The user's stated goal
   requires native operation in both hosts.

4. **Use Codex's plugin system as the unifier** (since it's newer and
   broader) — Rejected. Codex's plugin manifest does not support all
   Claude features (e.g., subagent bundling). Forcing all plugins
   through Codex's manifest loses Claude-native capability.

5. **Build agentic-plugins as an extension of omcc** — Rejected. omcc has a
   focused mission (Claude marketplace) and agentic-plugins' mission is
   broader (cross-host framework). See ADR-0005.
