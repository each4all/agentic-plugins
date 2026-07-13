---
name: decide
description: "Selects a business direction under constraints — compares 2+ candidate items/strategies across the decisive market + unit-economics axes and the regulatory + safety veto gates, and recommends one with explicit rationale. The founder persona's decision verb (ADR-0010 §2, ADR-0036 SD3). Use whenever a meaningful choice exists between 2+ business directions, segments, models, or go/no-go calls. Trigger phrases include 'which business idea', 'compare these directions', 'should we pursue X or Y', 'go or no-go', 'which segment', 'which market', 'pick a direction', 'evaluate these opportunities', '어떤 사업', '어느 방향', '비교해줘', '진출할까', '할지 말지', '어느 시장', '결정 도와줘'."
---

# Decide (founder persona)

The founder plugin's decision verb (per ADR-0010 §2, ADR-0036 SD3).
Evaluate 2+ viable business directions through evidence-based research and
multi-axis comparison, and recommend one with explicit rationale. The user
is the decision-maker; this verb is the decision-support engine — it
maximizes the quality of the analysis, not the automation of the call.

Invoke this verb — even without an explicit request — whenever a
meaningful business choice is about to be made: choosing between 2+
candidate items, target segments, business models, pricing approaches, or
a go/no-go on a single direction. Do not commit first and justify after;
present the comparison and recommendation, then wait for user approval.

**The three-tier business axis model (ADR-0036 SD3).** The decision axes
resolve from `references/decision-axes.yml` (the registry). They carry
three tiers of weight:

| Tier | Axes | Role in the recommendation |
|------|------|----------------------------|
| **Decisive** | 시장성 Market-Attractiveness · 단위경제 Unit-Economics | Pick the winner. A decisive-favored direction is not downgraded by supporting axes alone. |
| **Supporting** | 지불의사 Willingness-to-Pay · 경쟁강도 Competitive-Intensity | Sharpen confidence, break ties; never override the decisive axes on their own. |
| **Veto gate** (`gate: true`) | 규제노출 Regulatory-Exposure · 안전리스크 Safety/Harm-Risk | Checked FIRST. A hard fail vetoes the direction regardless of market or unit-economics strength — not a tradeoff to fold into the plan. |

This verb takes no `--profile` argument — decide is single-mode. Business
sub-discipline context flows through the Business Task Profile per
`../_shared/references/orchestration.md`.

> **PROVISIONAL (잠정, ADR-0036 SD3).** The decisive set and axis questions
> are a first-cut hypothesis, expected to be re-tuned as real founder
> dogfood (ADR-0036 PR7) and market data accumulate. Treat the roles as a
> baseline, not a settled invariant beyond the ≥2-decisive floor.

---

## When auto-activated (without command)

Lightweight in-context decision support — no subagent spawning, no peer
ensemble dispatch.

### Step 1: Clarify the choice

1. Identify the business decision (one item — one go/no-go, or one
   compare-these-directions).
2. If only one option is apparent, search for alternatives before
   proceeding (the null option — "don't pursue" — is always a candidate).
3. Quick context scan: stage (idea / validation / build), known
   constraints, the evidence on hand.

### Step 2: Research (with privacy guardrails)

Before proposing directions, gather market evidence from authoritative
sources per `../investigate/references/business-brief-spec.md` (the 5-tier
source taxonomy). Do not rely solely on internal knowledge.

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web search
AND peer-host dispatch. Use generic market/category terms in queries, never
proprietary identifiers or customer data. When confidentiality is unclear,
ask the user before searching.

If web search is unavailable, state the limitation and base research on
internal knowledge, clearly distinguishing verified facts from best-effort
recall.

### Step 3: Compare across the resolved business axes

When invoked by command (`/founder:decide`), the active axis set is the
**resolved preset** from `$AGENTIC_DECIDE_CONTEXT_FILE` (built in
`commands/decide.md` Phase 0.5 from `references/decision-axes.yml`). Render
the comparison using those axes in document order. The table below is the
`default` preset's documentation rendering — the **fallback** axes when the
registry is missing or invalid (graceful-degradation per ADR-0027 §1.6).

<!-- @decide:axis-table:begin -->
| # | Axis | Tier | Core question |
|---|------|------|---------------|
| 1 | **시장성 Market-Attractiveness** | decisive | Is there a real, reachable market of sufficient size/growth/timing? |
| 2 | **단위경제 Unit-Economics** | decisive | Can a customer be acquired and served for less than the value captured, with a path to positive contribution margin? |
| 3 | **지불의사 Willingness-to-Pay** | supporting | Is there behavioral evidence customers will actually pay, not just stated interest? |
| 4 | **경쟁강도 Competitive-Intensity** | supporting | Is there a compounding wedge, or a saturated race to the bottom? |
| 5 | **규제노출 Regulatory-Exposure** | **gate** | Does it clear licensing/compliance for the target jurisdiction(s)? A hard blocker is a veto. |
| 6 | **안전리스크 Safety/Harm-Risk** | **gate** | Are safety, liability, privacy, ethical-harm exposures acceptable and mitigable? An unmitigated exposure is a veto. |

These six anchors are the `default` preset (`--size=standard` /
`--size=major`). The `compact` preset (`--size=minor`) drops the two soft
supporting axes but KEEPS the two gates — a minor decision must still clear
regulatory + safety.

**Axis-set resolution + ritual size (command mode, ADR-0027 §1.5)**:
`--preset=<id>` wins outright; absent `--preset`, `--size=<tier>` implies
the preset — `minor`→`compact` (4 axes), `standard`/`major`→`default`
(6 axes). `--size` independently controls per-axis rendering depth (see
the @decide regions below). In auto-activated mode (no command, no context
file) the skill MAY read a size hint from the user's prose ("treat this as
a minor/major decision"); absent a hint, use `default` at `standard` depth.
<!-- @decide:axis-table:end -->

<!-- @decide:per-option-output:begin -->
#### REQUIRED output format — for each direction:

Render one bullet per axis in the resolved preset, in document order, with
the axis's label. The template below is the `default` preset at
`size=standard`.

```
### Direction [letter]: [name]
[1-sentence summary of the direction]

- **시장성 Market-Attractiveness**: [assessment — size/growth/reachability] — [source]
- **단위경제 Unit-Economics**: [assessment — CAC vs LTV, contribution-margin path] — [source]
- **지불의사 Willingness-to-Pay**: [assessment — behavioral demand evidence] — [source]
- **경쟁강도 Competitive-Intensity**: [assessment — wedge / defensibility] — [source]
- **규제노출 Regulatory-Exposure** [gate]: [PASS / CONDITIONAL / FAIL + the blocker] — [source]
- **안전리스크 Safety/Harm-Risk** [gate]: [PASS / CONDITIONAL / FAIL + the exposure] — [source]
```

Every assessment carries a short `[source]` parenthetical (brief path, doc
anchor, official-stats/market-intelligence tier, or `[uncited inference]`
when it is the LLM's own synthesis). Gate axes render an explicit
**PASS / CONDITIONAL / FAIL** verdict so the veto rule below has a clean
input.

**Size-aware per-axis depth**:
- `size=minor` → 1-2 line assessment per axis (evidence rule NOT relaxed —
  the `[source]` parenthetical stays). Gates still render PASS/CONDITIONAL/FAIL.
- `size=standard` → the template above.
- `size=major` → the standard template PLUS a `- **2nd-order risks**:`
  bullet per axis (downstream dependencies, failure modes, capital/timing
  exposure specific to that axis).
<!-- @decide:per-option-output:end -->

<!-- @decide:comparison-table:begin -->
#### REQUIRED output format — after all directions:

Render one row per axis in the resolved preset, in document order.

```
### Key Differences
| Axis | Direction A | Direction B | ... |
|------|-------------|-------------|-----|
| 시장성 Market-Attractiveness | ... | ... | |
| 단위경제 Unit-Economics | ... | ... | |
| 지불의사 Willingness-to-Pay | ... | ... | |
| 경쟁강도 Competitive-Intensity | ... | ... | |
| 규제노출 Regulatory-Exposure (gate) | PASS/COND/FAIL | ... | |
| 안전리스크 Safety/Harm-Risk (gate) | PASS/COND/FAIL | ... | |
```

**Size-aware cell density**: `size=minor` → terse phrases; `size=standard`
→ one-sentence-equivalent cells; `size=major` → append one italicized
risk-note row beneath each axis row (e.g. `| _시장성 — risk_ | _<note per
direction>_ | … |`). Use this single cohesive shape — do NOT add a
separate risk column, so the table region stays stable for the
weighting/sensitivity rows below.
<!-- @decide:comparison-table:end -->

<!-- @decide:weighting-sensitivity-output:begin -->
#### REQUIRED output format — weighting + sensitivity (ADR-0027 §1.3 + PR4)

This region renders ONLY when the opt-in gate fires:
`context.weights_explicit === true` (user passed `--weights=<spec>`) OR
`context.size === "major"`. Both are top-level fields of
`$AGENTIC_DECIDE_CONTEXT_FILE` — read them directly; do NOT infer
explicit-presence from `Object.keys(context.weights).length`. In all other
cases, omit this section so default `/founder:decide <prose>` output stays
prose-only (backward-compat).

When it renders, each per-direction bullet in `@decide:per-option-output`
carries a `[grade: ◎|○|△|×]` suffix (◎=3, ○=2, △=1, ×=0 — single source of
truth is the `GRADE_MARKERS` constant in `scripts/lib/decide-scores.mjs`).
The grades feed the weighted aggregate row; omitting them produces `(n/a)`.

**Weighted aggregate row** (appended to the comparison table after all
axis rows):

```
| _Weighted aggregate_ | <A score> | <B score> | ... |
```

Per-direction score: `Σ(grade_i × weight_i) / Σ(weight_i)` over scored
axes. Uniform `{}` weights expand to 1.0 per axis. The aggregate row is
**advisory only** — it is NOT the recommendation winner. When it favors a
different direction than the @decide:recommendation-rule winner, the
recommendation adds a `Sensitivity-aggregate divergence:` line and lowers
confidence one tier, but does NOT flip the recommendation.

**Sensitivity flip summary** (matches `analyzeSensitivity()` in
`scripts/lib/decide-sensitivity.mjs`):

```
### Sensitivity (±20% per-axis weight perturbation)
- _unperturbed_top_: <direction-letter>
- _flipped_: <true | false>
- _flips_:
  - axis=<axis-id>, direction=<+20% | -20%>, → direction <letter>
```

`size=minor` + `--weights` → compact form (header + `_flipped_` +
`_unperturbed_top_`); `size=standard` + `--weights` → full; `size=major`
(± `--weights`) → full AND trigger the recommendation-rule sensitivity
rigor below.
<!-- @decide:weighting-sensitivity-output:end -->

### Step 4: Recommend

Always provide a recommendation. Never leave the user with only a
comparison.

<!-- @decide:recommendation-rule:begin -->
**Apply the three tiers in order:**

1. **Gates first (veto).** For each direction, evaluate the `gate: true`
   axes (규제노출 Regulatory-Exposure, 안전리스크 Safety/Harm-Risk). If a
   recommended direction has a **FAIL** on any gate (an unmitigated
   regulatory blocker or safety/harm exposure), treat it as a HARD VETO:
   do NOT recommend it on market/unit-economics strength. Lower confidence
   to LOW, recommend **defer / no-go**, or route back to
   `/founder:investigate` (to size the gate) or `/founder:frame` (to
   reshape around it). A **CONDITIONAL** gate is allowed only with the
   mitigation named explicitly as a precondition in the recommendation —
   never folded silently into "execution concerns". This veto behavior
   overrides the decisive-axis rule below.

2. **Decisive axes pick the winner.** Among gate-passing (or
   gate-conditional-with-named-mitigation) directions, when the decisive
   axes (시장성 Market-Attractiveness, 단위경제 Unit-Economics) clearly favor
   one direction, recommend it. Do NOT downgrade a decisive-favored
   direction on supporting axes alone — address willingness-to-pay /
   competitive concerns in the validation plan instead. (Every founder
   preset declares exactly these two decisive axes — ADR-0027 §1.3
   minimum-decisive invariant — so this rule holds across `default` and
   `compact`.)

3. **Supporting axes break ties / set confidence.** When the decisive
   axes are close, 지불의사 Willingness-to-Pay and 경쟁강도
   Competitive-Intensity break the tie and calibrate confidence.

#### REQUIRED output format:

```
**Recommendation: Direction [letter] ([name])** — Confidence: [HIGH/MEDIUM/LOW]

Gate verdict: 규제노출 [PASS/COND/FAIL] · 안전리스크 [PASS/COND/FAIL]
[if any CONDITIONAL: the named mitigation that is now a precondition]

[2-3 sentence rationale explaining WHY — decisive-axis evidence first]

Decisive factors: [which of 시장성 / 단위경제 most influenced this]
Sources: [key market references that support the recommendation]

Choose [other direction] instead if: [specific conditions — e.g. a gate
clears, or a willingness-to-pay signal materializes]
```

**Size-aware rigor**: `size=minor` → 1-sentence rationale + gate verdict +
Decisive factors + Choose-other-if + a brief Sources pointer (evidence
rule preserved). `size=standard` → the template above. `size=major` → the
template PLUS a `Decisive-axis ranking:` block (per-decisive-axis ranking
across directions, e.g. `시장성: A > C > B; 단위경제: A = C > B`); and when
the weighting/sensitivity region renders, append the advisory
`Sensitivity-aggregate divergence:` / `Sensitivity: perturbation flips …`
lines with a single one-tier confidence downgrade — NEITHER flips the §1.3
recommendation.
<!-- @decide:recommendation-rule:end -->

**Confidence levels:** **HIGH** — strong validated evidence, gates clearly
pass, decisive axes aligned. **MEDIUM** — good evidence, reasonable
alternatives, or a CONDITIONAL gate with a credible mitigation. **LOW** —
thin evidence, subjective tradeoffs, or an unresolved gate.

**Wait for the user to choose a direction** before proceeding. If the user
says "your call", present only the recommendation and confirm.

### Edge cases

- **Only one viable direction**: still follow the protocol; present the
  single direction with its axis analysis (including gate verdict) and note
  why alternatives were excluded. The null "don't pursue" option counts.
- **All directions roughly equal on decisive axes**: set confidence LOW,
  break the tie on supporting axes, state the choice is evidence-thin.
- **A gate FAILs on every direction**: recommend no-go / reframe; the
  veto is the finding. Do not pick "least-bad" past a hard gate.
- **Search returns nothing**: state "No market evidence found"; base that
  axis on internal knowledge and label it explicitly.

---

## When invoked by command (`/founder:decide` Claude command or `$founder:decide` Codex skill mention)

Full decision support with Business Task Profile + peer ensemble +
state-write integration.

**Cross-host scope note (ADR-0001 §5 honest scope)**: the Phase 0.5
flag-parser bootstrap that writes `$AGENTIC_DECIDE_CONTEXT_FILE` lives in
`commands/decide.md` on the Claude side. Codex `$founder:decide` skill
mentions reach this SKILL.md directly. A Codex LLM serving
`$founder:decide` MAY replicate the contract by invoking
`scripts/decide-registry.mjs resolve` itself with the user's flag string
and reading the resulting `ResolvedDecisionContext` before emitting the
Brainstorm prompt — best-effort cross-host equivalence per ADR-0001 §5.
Absent that step, Codex falls back to the `default` business axes at
standard depth (no `--weights` / `--size` parsing).

### Pre-decide: Business Task Profile

Build the Business Task Profile per
`../_shared/references/orchestration.md` Step 1 (Market / Segment / Stage /
Risk-class / Evidence-confidence).

### Steps 1-4

Follow the auto-activated steps above, at command fidelity.

### Step 5: Peer ensemble parallel analysis (Brainstorm point)

Before Step 4 Recommend, launch the peer ensemble using the **Brainstorm**
point type. The peer independently proposes 2-3 business directions with
tradeoffs. Genericize per the privacy gate before the peer prompt — the
peer must never see proprietary venture concepts or customer data. The
peer call is automatic (always-max policy); skills do not pass `--model` /
`--effort`. (founder's `../_shared/references/ensemble-protocol.md`
§Brainstorm carries the prompt template + synthesis contract, including the
`<axis_awareness>` business-axis block; the dispatch shape mirrors the
research-scan dispatch in `../investigate/references/business-brief-ensemble.md`.)

Synthesize: add PEER-ONLY directions; elevate confidence for AGREED;
label unique directions by source ([Local] / [Peer]); present CONFLICT
directions both ways and ask the user.

### Approval gate

**Wait for the user to choose a direction** — do not proceed without
explicit approval.

### State write (when invoked from a workflow command)

When `/founder:decide` runs as a sub-step of a founder workflow command,
the invoking command writes the decision (`chosen`, `rationale`, gate
verdict, `rejected`) to its workflow file. This skill itself does not write
workflow state. When invoked standalone, no workflow file write occurs.

---

## Completion — Active Next-Action Proposal

At the end of a successful decide (both paths), emit an **Active
Next-Action Proposal** instead of a fixed next verb — derived from this
decision, not a fixed table:

```
- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — decisive 시장성/단위경제 + the gate verdict>
- evidence_pointers:     <comparison rows / brief path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or $founder:<verb> for a verb>
```

Typical `selected_next` candidates for decide: `/founder:compose` to
produce the planning artifact for the chosen direction — or
`/founder:investigate` if a decisive evidence gap or an unresolved gate
surfaced, or `/founder:frame` if deciding reframed the opportunity. The
routing is a fallback only when evidence is genuinely neutral — do not end
with a hardcoded "next: X".

(When the invoking workflow command's terminal write runs — `state.mjs
set-terminal` — the runtime completion footer is **code-emitted** on that
command's stderr per ADR-0039/ADR-0043 S3; do not hand-compose a second
footer — surface the emitted one. Standalone skill invocations write no
workflow state and emit no footer. Wiring:
`skills/_shared/references/session-handoff.md`.)

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

Decide IS the multi-axis verb — its comparison already renders the resolved
axes across directions. If a *sub-fork* surfaces mid-decision, keep the
lens bounded to the decisive business axes (시장성 / 단위경제) + the gates
rather than re-running the full matrix for a trivial reversible step.

---

## Anti-patterns (do not produce)

- **Committing first, justifying after**. Always present comparison +
  recommendation before the user commits to a direction.
- **Recommending past a failed gate**. A FAIL on 규제노출 or 안전리스크 is a
  veto, not a tradeoff — never fold it into "execution concerns" to keep a
  market-attractive direction alive.
- **Downgrading a decisive-favored direction on supporting axes alone**.
  Willingness-to-pay / competitive concerns belong in the validation plan,
  not the winner-pick.
- **Recommendation without rationale**. The user needs the *why* —
  decisive-axis evidence and the gate verdict — not just the *what*.
- **Marketing claims without citation** ("huge market", "no competition")
  need a market-data or source citation.
- **Leaking proprietary material** to the peer or to web search. Genericize
  the directions and any customer/interview data before any external call.
- **Professional-advice claims**. founder does not produce legal,
  financial, tax, or clinical advice (ADR-0036 Non-Goal 6); flag
  regulated-domain gate verdicts as needing a qualified professional.
