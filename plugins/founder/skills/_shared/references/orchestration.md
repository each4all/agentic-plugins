# Dynamic Orchestration (founder persona)

Follow this framework at every stage that allocates analysis effort.
Pursue the best results through task-analysis-based dynamic composition,
not static counts.

**Plugin boundary note**: this orchestration framework is
founder-internal (lives at
`plugins/founder/skills/_shared/references/`). Per ADR-0010 §5,
cross-plugin imports are forbidden — founder ships its **own copy** of
the orchestration pattern rather than importing engineer's
(ADR-0029 §Neutral copy/adapt rule). The business Task Profile fields
below are the persona-shaped data that distinguishes this copy from the
engineer original (ADR-0036 SD6 / F4); the orchestration *mechanics*
are the shared shape. If the framework proves universal across L3
personas, an L1/L2 extraction may be considered through a fresh ADR;
this file does NOT serve cross-persona imports as-is.

The **orchestrator** is the host where the user is currently invoking
the skill (Claude Code or Codex CLI). It dispatches the **peer** host's
companion ensemble in parallel per `ensemble-protocol.md` (founder's own
copy; the nine business-anchored point templates ship in
`ensemble-protocol.md`, and its research-scan point cross-references
`investigate`'s self-contained `references/business-brief-ensemble.md`
contract). The orchestrator/peer assignment is symmetric — every
`/founder:*` skill runs from either side.

---

## Principles

1. **Quality first**: Optimize for result quality, not token efficiency.
2. **Max effort**: Every primary analysis uses the host's
   maximum-effort/maximum-depth configuration. Skills do not override
   the user's host-level model/effort settings.
3. **Task decides**: No predefined minimum/maximum effort. A one-item
   scan needs less orchestration than a multi-market landscape sweep.
4. **Mission-specific**: Assign concrete missions tailored to this
   business question, not generic perspective labels.
5. **No overlap**: Clearly delineate mission boundaries so multiple
   perspectives do not survey the same ground.

---

## Orchestration Process

Before allocating effort, always perform Step 1 (Task Profiling). Steps
2–3 (local-agent composition + mission briefing) are **reserved**: all
six founder verbs run **orchestrator-direct** (web evidence-gathering /
problem modelling / cognitive analysis) plus the peer ensemble, and do
**not** spawn local subagents (mirroring the engineer cited-brief
precedent where external source retrieval is the work and read-only file
subagents would not help). Steps 2–3 would apply only to a future
agent-spawning founder verb — none ship today; founder's local
business-analysis roster (the agent-taxonomy reference) would land with
such a verb if one is ever added.

### Step 1: Business Task Profiling

Analyze the task along the following dimensions and record the result in
this format (ADR-0036 SD6 / F4 — these business fields replace the
engineer `Scope` / `Layers` / `Risks` software fields, which are
meaningless for business topics):

```
Business Task Profile:
  Market:              [the addressable market / industry / category in scope]
  Segment:             [target customer segment or buyer persona, or "undetermined"]
  Stage:               [idea | validation | build]
  Persona:             founder
  Skill-profile:       [the verb's profile mode, when the verb has one — e.g. investigate's "business-brief"; empty for single-mode verbs like frame]
  Profile:             [L4 business-model archetype — general (MVP default); b2b-saas / consumer-app / commerce / content land with demand]
  Risk-class:          [dominant risk category: market | competitive | regulatory | unit-economics | safety | execution — list applicable, or "none surfaced yet"]
  Evidence-confidence: [LOW | MEDIUM | HIGH — how much validated evidence backs the current understanding]
  Ensemble Affinity:   [LOW | MEDIUM | HIGH]
```

Two distinct profile axes, kept separate to avoid conflation:

- **Skill-profile** — the verb's own profile *mode* (e.g.
  `investigate --profile=business-brief`). It selects how the verb runs,
  not the L4 sub-discipline. Single-mode verbs (e.g. `frame`) leave it
  empty.
- **Profile (L4 archetype)** — the 4-layer L4 axis (per ADR-0010): the
  persona dictates which L3 plugin owns the orchestration (`founder`);
  the L4 profile passes business-model context to skills (source-priority
  overrides, axis-weight overlays, domain guards). MVP ships only the
  `general` default; the archetype taxonomy (`b2b-saas`, `consumer-app`,
  `commerce`, `content`) is deferred until demand arrives (ADR-0036 SD6,
  ADR-0010 §1 — L4 is the unbounded axis).

**Analysis dimensions**:

- **Market**: the addressable problem/market, its size/growth/timing
  where known. Drives source selection (which official-stats /
  market-intelligence tiers matter — see `business-brief-spec.md`).
- **Segment**: who the buyer/user is. Sharpens sub-questions and the
  willingness-to-pay evidence the brief must seek.
- **Stage**: `idea` (item discovery), `validation` (testing demand /
  unit economics), or `build` (committed, planning execution). Stage
  sets evidence depth expectations — an `idea`-stage scan tolerates more
  Open Questions than a `build`-stage one.
- **Risk-class**: the dominant risk surface. `regulatory` and `safety`
  are veto-like (gate-style) — an unmitigated blocker must lower
  confidence or route back (the gate-style axes live in founder's
  `decision-axes.yml` per ADR-0036 SD3).
- **Evidence-confidence**: how validated the current picture is. LOW
  with honest Open Questions beats HIGH that hides gaps.
- **Ensemble Affinity**: LOW / MEDIUM / HIGH. Recorded for context;
  **NOT a dispatch gate** — founder's always-max policy dispatches the
  peer ensemble at every command-mode phase boundary regardless, per
  `ensemble-protocol.md` / `business-brief-ensemble.md`.

### Step 2: Composition (reserved — no agent-spawning founder verb ships today)

Select local-analysis roles from founder's business-analysis roster (a
future agent-taxonomy reference — founder ships no agent-spawning verb
today, so Steps 2–3 are reserved, not exercised).

**Selection criteria — ask yourself for each role:**

> "If this perspective is missing, could this business judgment carry an
> **undetected blind spot** (a market, a cost line, a regulatory
> exposure)?"

- YES → include
- NO → exclude

> "Can this perspective provide meaningful feedback that **does not
> overlap** with other selected perspectives?"

- YES → include
- NO → exclude (absorbed by another perspective)

**Guidelines:**

- Do not over-allocate for a quick scan. A one-paragraph viability
  sanity-check does not need a full landscape sweep.
- Do not omit perspectives for a committed venture. A `build`-stage
  unit-economics plan must include the cost/pricing perspective.
- Judge by **actual risk**, not surface framing. A "simple" consumer
  app can carry heavy privacy/regulatory exposure.

### Step 3: Mission Briefing (reserved — no agent-spawning founder verb ships today)

Give each selected perspective a **concrete mission specific to this
business question**.

**Bad mission:**
> "Look at the market"

**Good mission:**
> "Size the addressable market for a B2B expense-automation tool aimed
> at 50–200-seat startups in the EU. Focus on official-stats and
> market-intelligence tiers for seat counts and spend per seat; flag any
> figure older than 18 months or jurisdiction-mismatched."

**Mission writing rules:**

1. Include the specific business context (market, segment, stage).
2. Specify which source tiers / regions / time windows to focus on.
3. Concretize the key question for this task.
4. Explicitly state boundaries to avoid overlap with other missions.

**Ensemble parallel track:**

The orchestrator launches the peer ensemble (Codex from Claude side, or
Claude from Codex side) in parallel with any local analysis. Dispatch is
automatic on every `/founder:*` phase boundary (always-max policy);
affinity is recorded but does not gate. The peer runs as an independent
parallel track — it is NOT a local agent and is not included in any
agent count or mission briefing. It receives its own prompt per the
ensemble contract (`business-brief-ensemble.md` for research-scan;
`ensemble-protocol.md` for the other point types).

### Failure handling

If any local analysis fails to return: notify the user which
perspective failed, ask retry-or-proceed, follow the user's decision,
and if proceeding note the missing perspective in the synthesis so the
user knows coverage was incomplete. Peer ensemble failures are handled
separately per the ensemble contract — graceful degradation, never
blocks the workflow.

---

## Examples

### Example 1: Investigate (business-brief) — new-item discovery scan

```
Business Task Profile:
  Market:              SMB restaurant back-office software (KR)
  Segment:             independent owner-operators, 1–3 locations
  Stage:               idea
  Persona:             founder
  Skill-profile:       business-brief
  Profile:             general
  Risk-class:          market (demand uncertain), unit-economics (low ARPU risk)
  Evidence-confidence: LOW
  Ensemble Affinity:   HIGH (broad landscape, controversial demand signals)

Execution: business-brief profile — orchestrator runs per-sub-question
  WebSearch/WebFetch across the 5 source tiers; peer research-scan
  dispatched per business-brief-ensemble.md (always-max). No local
  subagents.
```

### Example 2: Frame — turning a discovery brief into a problem model

```
Business Task Profile:
  Market:              EU expense-automation for 50–200-seat startups
  Segment:             finance leads at venture-backed startups
  Stage:               validation
  Persona:             founder
  Skill-profile:       (none — frame is single-mode)
  Profile:             general
  Risk-class:          regulatory (VAT/e-invoicing mandates), competitive (saturated)
  Evidence-confidence: MEDIUM
  Ensemble Affinity:   MEDIUM

Execution: frame articulates the business problem model (problem,
  customer + JTBD, value hypothesis, business-model sketch, constraints,
  validation criteria, key risks, out-of-scope); peer Frame-point
  ensemble produces an independent model; synthesize via
  AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT. No local subagents.
```
