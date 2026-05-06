# Architecture Decision Records (ADRs)

This directory contains the foundational architectural decisions for
agentic-plugins. Each ADR captures one decision with its context, the chosen
direction, and the consequences.

## Format

ADRs follow the standard 5-section format:

1. **Status** — `Proposed`, `Accepted`, `Superseded by ADR-NNNN`, `Deprecated`
2. **Context** — Forces at play and why a decision is needed
3. **Decision** — What was decided
4. **Consequences** — What follows from the decision (positive, negative, neutral)
5. **Alternatives Considered** — What else was on the table and why rejected

See [`template.md`](template.md) for the canonical layout.

## File naming

`NNNN-<kebab-case-slug>.md` where `NNNN` is a zero-padded sequence
number starting at 0001. Numbers are never reused. To replace a
decision, write a new ADR with `Status: Accepted` that references the
old one, and change the old one's status to `Superseded by ADR-NNNN`.

## Process

1. Copy `template.md` to `NNNN-<slug>.md` (next number)
2. Status starts as `Proposed`
3. Discuss / iterate
4. Merge with `Status: Accepted`
5. To supersede: new ADR + update old ADR's status

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-hexagonal-architecture.md) | Hexagonal architecture (core / adapter / companion) | Accepted |
| [0002](0002-adapter-contract.md) | Adapter contract — 4 required items | Accepted |
| [0003](0003-mcp-vs-companion.md) | MCP vs companion-CLI — when to use which | Accepted |
| [0004](0004-companion-ownership.md) | Companion ownership — agentic-plugins owns both | Accepted |
| [0005](0005-separate-repo-from-omcc.md) | Separate repo from omcc | Accepted |
| [0006](0006-directory-layout-install-pattern.md) | Directory layout + install pattern | Accepted |
| [0007](0007-migration-cutover-plan.md) | Migration cutover plan from omcc to agentic-plugins | Accepted |
| [0008](0008-companion-distribution-model.md) | Companion distribution model — `companions` plugin + cache-glob discovery + env override | Accepted |
| [0009](0009-companion-contract-v0-1-1-prompt-file-stdin-precedence.md) | Companion contract v0.1.1 — `--prompt-file` and `PROMPT_ARG` precedence over stdin | Accepted |
| [0010](0010-plugin-boundary-policy.md) | Plugin boundary policy — 4-layer composition + universal cognitive verbs + naming convention | Proposed |
| [0011](0011-workflow-continuity-storage.md) | Workflow continuity storage — minimal Option III for Stage 2 | Proposed |
| [0012](0012-omcc-removal-preconditions.md) | omcc + codex-plugin-cc removal preconditions | Proposed |
