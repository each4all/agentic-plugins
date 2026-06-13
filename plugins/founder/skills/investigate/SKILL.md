---
name: investigate
description: "Gathers business evidence — scans markets, regulations, platforms, competitors, and demand signals, and produces durable cited business briefs from authoritative sources. The founder persona's evidence-gathering verb (ADR-0036 SD4 — business-item discovery / 탐색). Use when the user wants to size a market, scan for new-business items, research a regulatory or competitive landscape, gather demand signals, or build a cited evidence base before framing or deciding. Trigger phrases include 'new business idea', 'business item', 'is there a market for', 'market research', 'market sizing', 'TAM', 'validate this idea', 'competitive landscape', 'regulatory landscape', 'unit economics research', 'business plan research', '신사업', '사업아이템', '사업아이템 탐색', '시장조사', '시장성', '사업성', '경쟁사 분석', 'BM 조사', '리서치', '조사해줘'. Do NOT jump to deciding or planning — gather evidence first."
---

# Investigate (founder persona)

The founder plugin's evidence-gathering verb (per ADR-0010 §2,
ADR-0036 SD2/SD4). founder:investigate covers the **business-item
discovery** requirement (탐색): scanning markets, regulations, platforms,
competitors, and demand signals for candidate items, and producing a
durable cited **business brief**.

| Profile | What it does |
|---------|--------------|
| `business-brief` (default) | Research a business topic across authoritative sources and produce a durable cited business-brief artifact (5-tier source taxonomy, freshness/jurisdiction tagging, paywalled-source rules) |

The profile is set via `--profile=business-brief` on
`/founder:investigate`, or inferred from the user's intent when
auto-activated. A missing or unknown profile defaults to
`business-brief` (founder:investigate is single-profile at MVP; the
discovery verb is the business-brief verb). Additional business
investigate profiles (e.g., a competitor deep-dive or a regulatory
deep-dive) are deferred until demand arrives — the business-brief profile
already spans the discovery requirement.

**Core principle**: do NOT decide a direction or draft a plan until
evidence is gathered and the user has reviewed it. Investigation produces
a cited brief; deciding belongs to `/founder:decide`, framing the problem
belongs to `/founder:frame`, drafting belongs to `/founder:compose`.

> **Roadmap note (incubating, ADR-0036).** This verb is self-contained at
> PR3: it references only founder-local files that exist now —
> `references/business-brief-spec.md`, `references/business-brief-ensemble.md`,
> `references/output-file-rules.md`, and `../_shared/references/orchestration.md`.
> Cross-verb surfaces referenced below land in later roadmap PRs:
> the founder decision registry (`scripts/decide-registry.mjs` +
> `../decide/references/decision-axes.yml`) in PR4, the full
> `../_shared/references/ensemble-protocol.md` in PR5, and the
> session-handoff / entry-routing references with the meta skills (PR5–6).
> Where a later-PR file is named, the inline fallback described here is
> the PR3 behavior.

---

## When auto-activated (without command)

Lightweight in-context investigation — no peer ensemble dispatch. The
depth is appropriate for a quick scoping pass.

### Step 1: Confirm topic and scope

1. Restate the business topic as a single concise statement (the user's
   phrasing, normalized) and confirm the market geography (jurisdiction)
   and stage (idea / validation / build).
2. **Privacy gate (initial pass)**: PRIVACY GATE: proprietary venture
   concepts, interview/customer data, and unpublished business material
   pass an explicit gate before BOTH web search AND peer-host dispatch.
   Review the topic now for proprietary content and genericize or remove
   it (e.g., "our AI scheduling app for clinics" → "AI scheduling
   software for healthcare providers"). This is the first pass; the
   binding gate runs after sub-questions are drafted (Step 3), because
   sub-questions are also external transmission. See
   `references/business-brief-spec.md` § Privacy Gate.

### Step 2: Scope the brief

1. Draft 1–7 sub-questions that decompose the topic into investigation
   axes (market size, demand, competition, regulation, unit economics,
   …). Confirm with the user (or auto-proceed if obvious).
2. Define scope — what the brief covers and explicitly excludes.

### Step 3: Source-tier scan

**Binding privacy gate (before any external call)**: re-run the gate now
over the topic AND scope AND jurisdiction AND every confirmed
sub-question — not just the topic. The spec requires topic and confirmed
sub-questions to pass before web search or peer dispatch; a sub-question
can carry proprietary content the topic alone did not (a competitor
name, an unpublished feature). Genericize any that does; only the
genericized form leaves the local host. If a sub-question cannot be
genericized without losing it, drop it or abort at scoping. Raw
primary-field data is never transmitted. Only after this gate passes:

For each confirmed sub-question, gather external evidence using the
**5 source-type tiers** from `references/business-brief-spec.md` §
Source Type Taxonomy:
`official-stats`, `research-institutional`, `market-intelligence`,
`primary-field`, `secondary-press`.

Collection priority: prefer `official-stats` and
`research-institutional` for hard numbers; use `market-intelligence` for
industry sizing and competitive structure (flagging vendor estimates);
use `primary-field` for demand / willingness-to-pay signals; fall back to
`secondary-press` for leads, recency, and sentiment.

Use WebSearch + WebFetch. Capture sources in **research-execution
order** (`[1]`, `[2]`, …), deduplicate URLs canonically, and record
title, URL, access date, tier, plus as-of date and jurisdiction for any
time-sensitive or geography-bound claim. Mark paywalled / vendor-claim /
estimate / summary-of-paid-report sources via the `Access-note` field —
never launder a figure up the tier ladder.

### Step 4: Synthesize and present (auto mode)

Produce the durable artifact per `references/business-brief-spec.md`
(canonical structure, citation conventions, audit checklist) and save it
per `references/output-file-rules.md` (per-topic directory under the
resolved output root, fixed filename `business_brief.md`):

1. Run the **Audit Checklist** before saving — every finding cited or
   sentinel-marked; freshness/jurisdiction tagged; no tier laundering;
   regulated-advice findings carry the honesty-boundary note.
2. Save to `<resolved-root>/YYYY-MM-DD_<topic-slug>/business_brief.md`.
3. Present a completion summary inline — saved path, sub-questions
   covered, source-tier breakdown, overall confidence, any Open
   Questions.

The business-brief profile produces a saved artifact, not a workflow
state write — the artifact is the handoff. Other founder verbs
(`/founder:frame`, `/founder:decide`, `/founder:compose`,
`/founder:critique`, `/founder:refine`) consume it as additional context.

---

## When invoked by command (`/founder:investigate` Claude command or `$founder:investigate` Codex skill mention)

Full investigation with peer ensemble parallel research and (when invoked
from a workflow command) state writes.

### Step 1: Business Task Profile

Build the Business Task Profile per
`../_shared/references/orchestration.md` Step 1, capturing `Persona:
founder`, `Skill-profile: business-brief` (the verb mode), `Profile:
general` (the L4 archetype — MVP default), Market, Segment, Stage,
Risk-class, Evidence-confidence, and Ensemble Affinity (recorded but not
gating — always-max policy). Market/Segment/Stage are descriptive only
for the business-brief profile (the domain's quality dimensions — market breadth,
source-tier requirement, freshness, jurisdiction spread — do not map onto
file/layer/risk axes). After the Task Profile, run the auto-mode Step 1–2
flow above (topic + jurisdiction + stage confirmation, sub-questions,
scope, existing-directory check per `references/output-file-rules.md`, and
the privacy gate) before proceeding.

### Step 2: Local evidence gathering

No subagent spawning. The orchestrator runs WebSearch + WebFetch directly
per-sub-question (Step 3 above). Local-host evidence-gathering is
single-actor here because external source retrieval is the work, and
parallelizing it across read-only-file subagents (which lack web tools)
would not help — the cited-brief precedent founder copies.

### Step 3: Peer ensemble parallel research

Simultaneously with the local web-search work, launch the peer ensemble —
the **research-scan** ensemble point per
`references/business-brief-ensemble.md`. Dispatch goes through
`plugins/founder/scripts/peer-runner.mjs run` for command-managed
ensembles; the prompt carries the genericized topic, confirmed
sub-questions, scope, jurisdiction, and the `<citation_contract>` and
`<privacy_contract>` XML blocks per the ensemble protocol; the companion
is invoked in JSON envelope mode via `--prompt-file`.

The privacy gate (Step 1) MUST have passed before this dispatch — the
peer prompt is external transmission. The peer call is automatic
(always-max policy); skills do not pass `--model` or `--effort` flags.

### Step 4: Collect, evaluate, synthesize

1. Wait for the local per-sub-question WebSearch / WebFetch run to
   return; collect findings.
2. Wait for the peer ensemble background notification; read the peer
   envelope.
3. Synthesize per `references/business-brief-ensemble.md` § Synthesis —
   `AGREED` / `LOCAL-ONLY` / `PEER-ONLY` / `CONFLICT`; PEER-ONLY claims
   undergo the bidirectional Independence Rule (Path A locally verify and
   cite with tier/as-of/jurisdiction tags, Path B move to Open
   Questions); citation numbering is remapped to local capture order
   (peer's internal labels MUST NOT be copied verbatim).

### Step 5: Present

Present clearly and confirm with the user before finalizing (the founder
presentation protocol lands in PR5; until then, present the synthesized
brief and ask the user to confirm before save). The business-brief
profile has three possible terminal outcomes:

- **saved** — audit passed and the brief was written to
  `<resolved-root>/YYYY-MM-DD_<topic-slug>/business_brief.md`. Show the
  saved path, sub-question coverage, source-tier breakdown, overall
  confidence, and any degraded-ensemble note.
- **aborted-at-save** — the user chose abort at the existing-directory
  gate or at a final review prompt. No file written; the synthesized
  brief is shown inline only.
- **aborted-at-scoping** — the user declined the topic, sub-questions, or
  privacy gate before dispatch. No web search / peer dispatch ran.

### State write (when invoked from a workflow command)

When `/founder:investigate` is invoked as a sub-step of a founder
workflow command (e.g., a future `/founder:start` lifecycle macro), the
invoking command writes the investigation results to its workflow file.
This skill itself does not write workflow state — it hands findings to
the invoking command, which owns the write.

When invoked standalone (no parent workflow command), no workflow file
write occurs.

The saved brief artifact
(`<resolved-root>/YYYY-MM-DD_<topic-slug>/business_brief.md`) is
**orthogonal** to any workflow state write — when invoked from a workflow
command, the workflow file gets the phase-note write AND the brief
artifact is saved separately (dual write, no collision). The brief
artifact is never tracked in the workflow's state-managed body; it is
referenced by saved-path only.

---

## Completion — Active Next-Action Proposal

At the end of a successful investigation (the `saved` outcome, both the
auto-activated and the command path above), emit an **Active Next-Action
Proposal** instead of a fixed next verb — derived from these findings,
not a fixed table:

```
- selected_next:         <verb | commit | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + the evidence-quality gate>
- evidence_pointers:     <brief path / sub-questions / Open Questions — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or $founder:<verb> for a verb; the action otherwise>
```

Typical `selected_next` candidates for business-brief: `/founder:frame`
(scope a business problem model from the brief), `/founder:decide`
(choose between surveyed directions — name the decision size
`--size=minor|standard|major`), or `/founder:compose` (draft a planning
artifact from it). The routing is a fallback only when evidence is
genuinely neutral — do not end with a hardcoded "next: X". The two
aborted outcomes have no forward result, so they skip the proposal.

(The full Active Next-Action Proposal contract — `entry-routing-contract.md`
— lands with the founder cross-verb surfaces in PR5; the shape above is
the PR3 inline form.)

Always include the workflow path when invoked from a workflow command, so
the user can inspect or resume:

```
Workflow: <absolute path to workflow .md file>
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

When this verb reaches a **genuine 2+-branch decision point** — two
viable candidate items, or two competing readings of the same demand
evidence, or a non-neutral `selected_next` with 2+ candidates — surface a
**compact multi-axis lens** comparing the branches across the decisive
business axes + size-appropriate supporting axes, instead of a flat list.

Resolve the sized axis set from founder's own decision registry
(`scripts/decide-registry.mjs resolve --size=<minor|standard|major>` +
`../decide/references/decision-axes.yml`) — the single axis source of
truth. **PR3 fallback** (the registry lands in PR4): keep the decisive
axes **시장성 (market-attractiveness)** and **단위경제 (unit-economics)**
— founder's two decisive axes per ADR-0036 SD3 — and add the most
relevant supporting axes (지불의사 / 경쟁강도 / 규제노출 / 안전리스크) as
the question warrants. Bounded: only at a genuine 2+-branch point (not
every invocation); never a full matrix for a trivial reversible step.

---

## Anti-patterns (do not produce)

- **Deciding or planning** while still in investigate. Investigation
  produces a cited brief; choosing a direction belongs to
  `/founder:decide`, drafting to `/founder:compose`.
- **Skipping the peer ensemble** in command mode to save tokens.
  founder's policy is always-max — the peer is dispatched at every
  command-mode boundary, degrading silently only when the companion is
  unavailable.
- **Leaking proprietary material** through the privacy gate. The topic
  and sub-questions are external transmission — genericize before any web
  search or peer dispatch. The pre-genericization value MUST never leave
  the local host.
- **Tier laundering** — presenting a vendor-claim / paywalled /
  estimate / summary-of-paid-report figure at a higher authority than its
  tier and access-note warrant. Every figure keeps its `Access-note`.
- **Stale or jurisdiction-blind figures** stated as current fact.
  Market / pricing / regulatory claims carry an as-of date and a
  jurisdiction tag; cross-jurisdiction transfer is an inference, not a
  cited fact.
- **Source-of-discovery labels in the brief artifact**. The saved brief
  MUST NOT carry `[Local]` / `[Peer]` / `[Both]` markers or any
  host-specific equivalent. Numeric `[N]` citations are the only allowed
  labeling format. See `references/business-brief-spec.md` § Ensemble
  Label Policy.
- **Decision-bound option comparisons** in the business-brief profile.
  business-brief is **topic-bound** evidence gathering. Comparing 2+
  directions against criteria to pick a path belongs to `/founder:decide`
  (or `/founder:frame` when scoping the decision).
- **Professional-advice claims**. founder does not produce legal,
  financial, tax, or clinical advice (ADR-0036 Non-Goal 6). Regulated-
  advice findings carry the honesty-boundary note.
