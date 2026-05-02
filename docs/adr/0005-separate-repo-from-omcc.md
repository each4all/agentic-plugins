# ADR-0005: Separate repo from omcc

## Status

Accepted

## Context

omcc (`github.com/e16tae/omcc`) is the existing Claude Code plugin
marketplace. agentic-plugins' design extends well beyond omcc's scope:
bidirectional peer-agent companions, dual-host adapters, Hexagonal
architecture (ADR-0001), first-party companions (ADR-0004).

The user's stated intent is for agentic-plugins to **replace** omcc for their
own use once feature parity is reached. omcc serves as the experience
base from which agentic-plugins is designed; it is not a sibling project that
remains operational long-term.

Two structural options:

- **(X) Separate repo for agentic-plugins** — omcc untouched until agentic-plugins
  reaches parity, then archived
- **(Y) Rewrite omcc in place** — omcc becomes agentic-plugins via major rewrite,
  preserving git history but disrupting omcc usage during transition

## Decision

agentic-plugins is developed in a **separate repository** from omcc. omcc is
untouched. Once agentic-plugins reaches feature parity (per ADR-0007 cutover
plan), omcc is archived.

## Consequences

**Positive**:
- omcc continues operating normally during agentic-plugins development. The user
  has a working tool while building its successor
- agentic-plugins has a clean slate — no migration of legacy code, no mixed-state
  during transition
- Each repo has a coherent identity: omcc = "Claude Code marketplace
  (legacy/stable)"; agentic-plugins = "cross-host framework (new direction)"
- If agentic-plugins turns out not to deliver, omcc remains as fallback
- agentic-plugins' git history starts fresh, reflecting its own architectural
  origin rather than evolving from omcc's foundation

**Negative**:
- For the development period, two repos exist for partially overlapping
  concerns
- Skills/agents/protocols from omcc that get reused in agentic-plugins are
  copied (with attribution) rather than git-history-preserved
- README cross-references between the two repos must be maintained until
  cutover

**Neutral**:
- The user's stated intent to abandon omcc means this is *temporary*
  duplication, not permanent fork. The migration cutover plan
  (ADR-0007) defines the endpoint

## Alternatives Considered

1. **Rewrite omcc in place (Option Y above)** — Rejected. omcc would be
   broken during the rewrite (mixed legacy + new code), and the user
   loses their working tool. Naming/branding would also need a rename
   mid-rewrite, disrupting URLs and install commands

2. **Develop agentic-plugins inside omcc as a subdirectory** — Rejected. omcc's
   current structure assumes Claude-only marketplace. Adding a parallel
   cross-host framework inside it muddies omcc's identity. Also, omcc's
   CI / release-please config is tuned for omcc-shaped releases

3. **Build agentic-plugins as an omcc fork** — Rejected. Forks imply long-term
   parallel maintenance. agentic-plugins' intent is to *replace* omcc, not run
   alongside it. A new repo with attribution to omcc reflects this
   intent more honestly than a fork

4. **Build agentic-plugins as an omcc git submodule** — Rejected. Submodules
   create coupling that we explicitly want to avoid. agentic-plugins should
   be able to evolve independently; omcc should remain stable

## References

- omcc: github.com/e16tae/omcc
- ADR-0007 (cutover plan): see `0007-migration-cutover-plan.md`
