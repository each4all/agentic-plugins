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

### Amendments vs Supersedes

When an Accepted ADR needs revision, the choice between *Amendment*
(adding to the existing ADR) and *Supersede* (writing a new ADR
that replaces all or part of the old one) follows a single
discriminator:

- **Amendment** — the original Decision-section prose remains
  *operatively accurate* after the change. The Amendment adds
  clarifications, sub-finding additions, or downstream cascades
  that follow from the original Decision. Pattern: ADR-0008's
  Amendments (additive clarifications), ADR-0010's 2026-05-06
  Amendment (downstream cascade from ADR-0014/0015).
- **Supersede** — the original Decision-section prose is
  *no longer operatively accurate*. A reader landing on the old
  ADR must be pointed at the new one for the operative decision.
  Pattern: ADR-0015 supersedes ADR-0014's timeline portion;
  ADR-0014's Decision §1 ("plugin remains installable through
  Stage 3 entry") is reversed.

Partial supersedure is supported: if an ADR's Decision sections
divide cleanly (e.g., capability decision vs timeline), the old
ADR's Status becomes `Superseded by ADR-NNNN (X portion only)` and
the new ADR scopes its supersedure to that portion. ADR-0014/0015
is the precedent.

When in doubt, ask: *does the original Decision-section prose remain
operatively accurate?* If no, write a new ADR (Supersede).

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
| [0010](0010-plugin-boundary-policy.md) | Plugin boundary policy — 4-layer composition + universal cognitive verbs + naming convention | Accepted |
| [0011](0011-workflow-continuity-storage.md) | Workflow continuity storage — minimal Option III for Stage 2 | Accepted |
| [0012](0012-omcc-removal-preconditions.md) | omcc + codex-plugin-cc removal preconditions | Accepted |
| 0013 | Codex CLI commands integration mechanism (file pending — Stage 3+ trigger) | Reserved |
| [0014](0014-plugins-research-deprecation.md) | plugins/research deprecation — capability folded into engineer:investigate cited-brief profile | Superseded by [ADR-0015](0015-research-archive-timeline-collapse.md) (timeline portion only) |
| [0015](0015-research-archive-timeline-collapse.md) | Research archive timeline collapse — supersedes ADR-0014 timeline portion | Accepted |
| [0016](0016-cross-package-commit-splitting.md) | Cross-package commit splitting for release-please routing | Accepted |
| [0017](0017-stage25-continuity-and-schema-roadmap.md) | Stage 2.5+ continuity and schema roadmap (meta commands + `ensemble_results` frontmatter + Stop auto-archive) | Accepted |
| [0018](0018-stage3-architecture-orchestrator-and-branch-context.md) | Stage 3+ architecture — orchestration capability + branch-as-workflow-context + cross-host verification | Accepted |
