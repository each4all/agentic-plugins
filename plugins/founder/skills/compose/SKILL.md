---
name: compose
description: "Produces the business planning artifact — a venture plan, a lean/business-model canvas, or a validation/experiment plan — from a confirmed opportunity frame and a chosen direction. The founder persona's composition verb (기획구상, ADR-0010 §2 / ADR-0036 SD2). Use after framing and deciding to actually draft the plan. Trigger phrases include 'write the business plan', 'draft the plan', 'put together the venture plan', 'make a lean canvas', 'business model canvas', 'validation plan', 'what should we test next', 'go-to-market plan', '사업계획서', '기획안 작성', '린 캔버스', '검증 계획', '계획 세워줘', '구체화해줘'."
---

# Compose (founder persona)

The founder plugin's composition verb (per ADR-0010 §2, ADR-0036 SD2).
Compose produces a **business planning artifact** from a confirmed
opportunity frame and a chosen direction. This is the planning step
(기획구상): turning a validated direction into an explicit, reviewable plan.

| Profile | What it produces |
|---------|------------------|
| `plan` (default) | A structured **venture plan**: problem/opportunity, customer + JTBD, value proposition, market, business model, unit economics, go-to-market, milestones, key risks + mitigations, validation backlog. |
| `canvas` | A one-page **lean / business-model canvas** (problem, solution, key metrics, unique value proposition, unfair advantage, channels, customer segments, cost structure, revenue streams). |
| `validation-plan` | A **validation / experiment plan**: riskiest assumptions → cheapest test for each → success criteria → decision rule (pivot / persevere / kill). |

The profile is set via `--profile=<name>` on `/founder:compose`, or
inferred from intent. Missing profile → `plan`. Unknown profile → `plan`
with a one-line warning. The L4 business-model archetype (general default;
b2b-saas / consumer-app / commerce / content with demand) flows through the
Business Task Profile per `../_shared/references/orchestration.md`, not a
per-call flag.

**Core principle**: a plan precedes commitment. A venture plan built on an
unconfirmed frame or an undecided fork is speculation. Compose consumes
upstream output — a confirmed opportunity model from `/founder:frame` and,
when 2+ directions existed, a chosen direction from `/founder:decide`.

**Honest-uncertainty principle**: a plan that marks its unverified
assumptions `[to be validated]` is more useful than one that pretends
certainty. Every revenue, cost, and demand number that is not yet evidenced
carries the marker — and those markers become the `validation-plan`
backlog. founder does not manufacture false confidence in a financial
projection.

---

## When auto-activated (without command)

Lightweight in-context composition — no subagent spawning, no peer ensemble
dispatch.

### Step 1: Profile selection

1. "draft the plan" / "business plan" → `plan`. "lean canvas" /
   "business model canvas" → `canvas`. "what should we test" / "validation
   plan" → `validation-plan`.
2. If ambiguous, default to `plan`.

### Step 2: Verify upstream work

Compose consumes a confirmed problem frame from `/founder:frame` (or an
equivalent opportunity model) and a confirmed direction from
`/founder:decide` (when 2+ viable directions existed). If either is
missing, suggest running the upstream verb first rather than composing on
incomplete inputs — composing without a frame produces a generic plan;
composing through an undecided fork locks in a choice the user did not
approve.

### Step 3: Produce the artifact

For `plan`, draft each section; for `canvas`, fill each box; for
`validation-plan`, list assumptions ranked by risk with the cheapest test
+ success criterion + decision rule for each. Mark every unverified number
or claim `[to be validated]`. Pull the unit-economics direction and the
key risks straight from the frame / decision so the plan stays consistent
with what was decided.

### Step 4: Present and confirm

Present the artifact and confirm before any downstream action. For a
non-trivial plan, present section by section and confirm the
business-model + unit-economics sections explicitly — they carry the most
load-bearing assumptions.

---

## When invoked by command (`/founder:compose` Claude command or `$founder:compose` Codex skill mention)

Full composition with Business Task Profile + peer ensemble + state-write.

### Step 1: Business Task Profile

Build the Business Task Profile per `../_shared/references/orchestration.md`
Step 1 — Persona=founder, the Market / Segment / Stage / Risk-class /
Evidence-confidence fields, and the verb's Skill-profile
(`plan` / `canvas` / `validation-plan`).

### Step 2: Compose

Produce the artifact per Step 3 above, at command fidelity.

### Step 3: Peer ensemble parallel analysis (Plan-verify point)

Launch the peer ensemble using the **Plan-verify** point type. The
Independence-Rule exception applies (per the engineer Plan-verify
precedent): the peer DOES receive the genericized draft plan as input — its
job is to find gaps in that specific plan (missing risks, unsupported
unit-economics, sequencing problems, untested assumptions). Genericize per
the privacy gate before the peer prompt; the peer must never see
proprietary venture concepts or customer data. The peer call is automatic
(always-max policy); skills do not pass `--model` / `--effort`. (founder's
`../_shared/references/ensemble-protocol.md` §Plan-verify carries the
prompt template + synthesis contract; the concrete dispatch bash lives in
`commands/compose.md` and mirrors the research-scan dispatch in
`../investigate/references/business-brief-ensemble.md`.)

### Step 4: Synthesize

Incorporate valid gaps. Adjust sequencing for valid ordering issues. Add
peer-surfaced risks/assumptions to the plan and its validation backlog.
Note CONFLICT items for user resolution.

### Step 5: Present

Present the synthesized artifact and confirm before downstream verbs.

### State write (when invoked from a workflow command)

When `/founder:compose` runs as a sub-step of a founder workflow command,
the invoking command writes the artifact + progress to its workflow file.
This skill itself does not write workflow state. When invoked standalone,
no workflow file write occurs.

---

## Completion — Active Next-Action Proposal

At the end of a successful compose (both paths), emit an **Active
Next-Action Proposal** instead of a fixed next verb — derived from this
artifact, not a fixed table:

```
- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + evidence-quality gate>
- evidence_pointers:     <plan sections / brief path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or $founder:<verb> for a verb>
```

Typical `selected_next` candidates for compose: `/founder:critique` to
review the plan — or `/founder:decide` if composing
surfaced an undecided fork, or `/founder:investigate` if a load-bearing
assumption needs evidence before the plan is trustworthy. The routing is a
fallback only when evidence is genuinely neutral — do not end with a
hardcoded "next: X".

(When the invoking workflow command's terminal write runs — `state.mjs
set-terminal` — the runtime completion footer is **code-emitted** on that
command's stderr per ADR-0039/ADR-0043 S3; do not hand-compose a second
footer — surface the emitted one. Standalone skill invocations write no
workflow state and emit no footer. Wiring:
`skills/_shared/references/session-handoff.md`.)

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

When composing reaches a **genuine 2+-branch decision point** — two viable
plan structures, two go-to-market wedges, two pricing models — surface a
**compact multi-axis lens** comparing the branches across the decisive
business axes (시장성 / 단위경제) + the gates, instead of a flat list, reading
`../decide/references/decision-axes.yml` (the `--size=minor` compact
4-axis set). Bounded: only at a genuine 2+-branch point. A weightier fork
should route to `/founder:decide` rather than be settled inline.

---

## Anti-patterns (do not produce)

- **Composing without a confirmed frame**. A plan without a frame hides the
  assumption that the opportunity is obvious — the "great plan for a market
  that does not exist" failure mode.
- **Composing through an undecided fork** ("I'll figure out the model as I
  go"). Forks belong to `/founder:decide`; composing through them locks in
  an unapproved choice.
- **Skipping the peer ensemble** in command mode. founder's policy is
  always-max — the peer exists to catch the missing risk or the
  unsupported unit-economics line.
- **Fabricated confidence on financials**. Mark unverified revenue / cost /
  demand numbers `[to be validated]`; never present a projection as
  evidenced when it is an assumption.
- **Leaking proprietary material** to the peer or to web search. Genericize
  the plan and any customer/interview data before any external call.
- **Professional-advice claims**. founder does not produce legal,
  financial, tax, or clinical advice (ADR-0036 Non-Goal 6); flag
  regulated-domain plan sections as needing a qualified professional.
