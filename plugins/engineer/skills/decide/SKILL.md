---
name: decide
description: "Selects a direction under constraints, evaluates options, commits to a next action — the engineer persona's decision verb (per ADR-0010 §2 — replaces and extends omcc-dev/brainstorm). Use whenever a meaningful choice exists between 2+ approaches, conventions, or designs. Trigger phrases include 'which approach', 'compare options', 'what's the best way', 'evaluate alternatives', 'design decision', 'should I use X or Y', 'how should I do this', 'which is better', 'pick one', '어떤 게 좋을까', '비교해줘', '선택해야 해', '어떤 방향으로', '결정 도와줘'."
---

# Decide (engineer persona)

The engineer plugin's decision verb (per ADR-0010 §2). Evaluate
2+ viable choices through evidence-based research and
multi-perspective comparison, and recommend a direction with
explicit rationale. The user makes the final call; this verb is the
decision-support engine.

**Core principle**: the user is the decision-maker. This verb
maximizes the quality of the analysis presented, not the
automation of the decision itself. Invoke this verb — even without
explicit user request — whenever a meaningful design choice is
about to be made: choosing between 2+ viable structural /
architectural alternatives, selecting a convention (naming,
language, layout, dependency), deciding how to apply a fix when
2+ viable approaches exist, or resolving any "should I do X or Y?"
fork during composition or refinement. Do not act first and
justify after; even when the answer feels obvious, present the
comparison and recommendation, then wait for user approval.

This verb takes no `--profile` argument — decide is single-mode by
design (the verb's purpose is presenting a multi-perspective
comparison and recommendation; sub-discipline weighting flows
through the orchestrator-level Task Profile per
`../_shared/references/orchestration.md`, not via per-call profile
arguments).

---

## When auto-activated (without command)

Lightweight in-context decision support — no subagent spawning, no
peer ensemble dispatch.

### Step 1: Clarify the choice

1. Identify the decision to be made (one item).
2. If only one option is apparent, search for alternatives before
   proceeding.
3. Quick context scan: project structure, tech stack, constraints.

### Step 2: Research

Before proposing options, gather evidence from authoritative sources.
Do not rely solely on internal knowledge — search first, then
synthesize.

**Search targets:**
- **Official documentation** (language/framework docs, API references)
- **Standards and specifications** (RFCs, W3C, ECMA, POSIX, OpenAPI)
- **Community consensus** (framework team recommendations,
  ecosystem-wide patterns)
- **Benchmarks and empirical data** (performance comparisons,
  adoption metrics)
- **Known pitfalls** (migration guides, deprecation notices,
  post-mortems)

Use WebSearch for current best practices; WebFetch for specific
documentation pages. Name or link every source so the user can verify
independently.

If web search tools are unavailable, state this limitation and base
research on internal knowledge, clearly distinguishing verified facts
from best-effort recall.

**Privacy guardrails:**
- Use generic technology terms in queries, not internal identifiers.
- Never include proprietary code, internal paths, or customer data
  in searches.
- When confidentiality is unclear, ask the user before searching.

### Step 3: Compare across multi-perspective

Evaluate each option from these perspectives. Not all carry equal
weight in every decision — state which are most decisive for this
choice and why.

| # | Perspective | Core question |
|---|-------------|---------------|
| 1 | **Essence** | Does this solve the fundamental problem, or just a symptom? |
| 2 | **Foundation** | Is this architecturally sound as a long-term base? |
| 3 | **Standards** | Does it align with industry standards and specifications? |
| 4 | **Best Practice** | Is it the canonical approach recommended by authoritative sources? |
| 5 | **Practical Fit** | Is it the best choice for this project's specific constraints? |

These five anchors are the same as omcc-dev/brainstorm's. They map
directly to the user's stated quality axes (표준 / 정석 / 권장 /
근본 / 본질) — the decision-support quality the engineer plugin
targets.

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting
the comparison. In interview mode, one decision item = one option
with its multi-perspective analysis.

#### REQUIRED output format — for each option:

```
### Option [letter]: [name]
[1-sentence summary of the approach]

- **Essence**: [substantive assessment — explain WHY this does or
  doesn't address the fundamental problem] — [source]
- **Foundation**: [substantive assessment — long-term architectural
  health, maintenance cost, extensibility, coupling] — [source]
- **Standards**: [substantive assessment — cite specific standards,
  RFCs, specs. If none apply, explain why] — [source]
- **Best Practice**: [substantive assessment — name specific
  authoritative sources, framework recommendations, community
  consensus] — [source]
- **Practical Fit**: [substantive assessment — evaluate against
  THIS project's tech stack, team, timeline, existing patterns]
```

#### REQUIRED output format — after all options:

```
### Key Differences
| Perspective | Option A | Option B | ... |
|-------------|----------|----------|-----|
| Essence     | ...      | ...      |     |
| Foundation  | ...      | ...      |     |
| Standards   | ...      | ...      |     |
| Best Practice | ...    | ...      |     |
| Practical Fit | ...    | ...      |     |
```

### Step 4: Recommend

Always provide a recommendation. Never leave the user with only a
comparison.

When Essence and Foundation clearly favor one option, recommend it.
Do not downgrade to a different option due to Practical Fit alone —
address practical concerns in the execution plan instead.

#### REQUIRED output format:

```
**Recommendation: Option [letter] ([name])** — Confidence: [HIGH/MEDIUM/LOW]

[2-3 sentence rationale explaining WHY, not just WHAT]

Decisive factors: [which 1-2 perspectives most influenced this]
Sources: [key references that support the recommendation]

Choose [other option] instead if: [specific conditions under which
a different option becomes the better choice]
```

**Confidence levels:**
- **HIGH** — Strong evidence, clear standards alignment, consensus
- **MEDIUM** — Good evidence, but reasonable alternatives exist
- **LOW** — Limited evidence, subjective tradeoffs, context-dependent

**Wait for user to choose a direction** before proceeding. If the
user says "just do it" or "your call", present only the
recommendation and confirm before proceeding.

### Edge cases

- **Only one viable option**: still follow the protocol. Present the
  single option with its perspective analysis and note why
  alternatives were excluded.
- **All options roughly equal**: set confidence to LOW, state the
  choice is preference-dependent, recommend based on Practical Fit
  as the tiebreaker.
- **Rapidly evolving domain**: flag that the landscape is shifting,
  cite source dates, note what to watch for.
- **User rejects all options**: ask what aspect was missing, return
  to Step 2 (Research) with refined constraints.
- **Search returns no relevant results**: state "No search results
  found"; base that perspective on internal knowledge and label it
  explicitly.

---

## When invoked by command (`/engineer:decide` Claude command or `$engineer:decide` Codex skill mention)

Full decision support with Task Profile + peer ensemble +
state-write integration.

### Pre-decide: Task Profile

Build the Task Profile per
`../_shared/references/orchestration.md` Step 1.

### Steps 1-4

Follow the auto-activated steps above.

### Step 5: Peer ensemble parallel analysis

Before Step 4 Recommend, launch the peer ensemble per
`../_shared/references/ensemble-protocol.md` using the **Brainstorm**
ensemble point type. The peer independently proposes 2-3 approaches
with tradeoffs.

Synthesize per `../_shared/references/ensemble-protocol.md`:
- Add any peer-proposed approaches the orchestrator did not consider.
- Elevate confidence for AGREED approaches.
- Label unique approaches by source ([Local] / [Peer]).

### Approval gate

**Wait for user to choose a direction** — do not proceed without
explicit approval.

### State write (when invoked from a workflow command)

When `/engineer:decide` is invoked as a sub-step of a workflow
command, the invoking command writes the decision (`chosen`,
`rationale`, `rejected`) to its workflow file per
`continuity-protocol.md` Phase-boundary Write Rules (Deliverable D).

When invoked standalone, no workflow file write occurs.

---

## Anti-patterns (do not produce)

- **Acting first, justifying after**. Always present comparison +
  recommendation before applying the chosen option.
- **Recommendation without rationale**. The user needs the *why*,
  not just the *what*.
- **Skipping the peer ensemble** in command mode. Engineer's policy
  is always-max — the peer ensemble runs at every command-mode
  decision.
- **Marketing claims without citation** ("best", "fastest", "most
  popular") need a benchmark or consensus citation.
- **Single-option presentation that hides alternatives** — even
  when one option dominates, name the rejected alternatives so the
  user sees the search space.
