---
name: decide
description: "Selects a design/UX direction under constraints — compares 2+ candidate designs/patterns/flows across the decisive usability axis + the archetype axis, with accessibility as a veto gate, and recommends one with explicit rationale. The designer persona's decision verb (ADR-0010 §2, ADR-0042 SD3). Use whenever a meaningful choice exists between 2+ UI patterns, layouts, flows, component approaches, or a ship/rework call. Trigger phrases include 'which pattern', 'compare these designs', 'tab bar or hamburger', 'which layout', 'should this be a modal or a page', 'pick a direction', 'evaluate these UX options', '어떤 패턴', '어느 디자인', '비교해줘', '이게 나아 저게 나아', '어떤 레이아웃', '결정 도와줘'."
---

# Decide (designer persona)

The designer plugin's decision verb (per ADR-0010 §2, ADR-0042 SD3).
Evaluate 2+ viable design/UX directions through evidence-based comparison
across the resolved design axes, and recommend one with explicit rationale.
The user is the decision-maker; this verb is the decision-support engine —
it maximizes the quality of the analysis, not the automation of the call.

Invoke this verb — even without an explicit request — whenever a
meaningful design choice is about to be made: choosing between 2+ candidate
patterns, layouts, flows, component approaches, interaction models, or a
ship/rework call on a single direction. Do not commit first and justify
after; present the comparison and recommendation, then wait for user
approval.

**The three-tier design axis model (ADR-0042 SD3).** The decision axes
resolve from `references/decision-axes.yml` (the registry). They carry
three tiers of weight:

| Tier | Axes | Role in the recommendation |
|------|------|----------------------------|
| **Decisive** | 사용성 Usability (the common decisive axis) + the archetype axis (일관성 Consistency for a general/`balanced` call; 전환 Conversion / 매력도 Desirability / 명확성 Content-Clarity for a CTA / UI / content call) | Pick the winner. A decisive-favored direction is not downgraded by supporting axes alone. |
| **Supporting** | the remaining non-gate axes (전환 Conversion · 매력도 Desirability · 명확성 Content-Clarity · 구현가능성 Feasibility · 일관성 Consistency, per preset) | Sharpen confidence, break ties; never override the decisive axes on their own. |
| **Veto gate** (`gate: true`) | 접근성 Accessibility | Checked FIRST. A hard WCAG A/AA barrier vetoes the direction regardless of usability/archetype strength — not a tradeoff to fold into the build plan. |

This verb takes no `--profile` argument — decide is single-mode. Design
sub-discipline context flows through the **Design Task Profile**
(canonically defined in `../_shared/references/orchestration.md`; the verb
skills restate it inline for self-containment).

> **accessibility HONESTY BOUNDARY (ADR-0042 Non-Goal 6).** The
> accessibility gate flags *candidate* WCAG A/AA issues from specs, code,
> and screenshots — contrast, semantic structure, alt text, visible focus,
> target size. It does **not** certify conformance: focus order, keyboard
> traversal, and screen-reader behavior need runtime testing. A gate FAIL
> is a candidate blocker to resolve or explicitly accept-with-rationale,
> not a certificate.

> **Dogfood-validated, still evolving (ADR-0042 SD3).** The decisive/supporting
> split and the axis questions were validated by the ADR-0042 Accepted-flip
> dogfood: the presets discriminated between real directions and the
> accessibility gate exercised its veto. They remain open to re-tuning as
> designer dogfood accumulates — but the ≥2-decisive floor and the
> accessibility veto gate are settled invariants.

---

## When auto-activated (without command)

Lightweight in-context decision support — no subagent spawning, no peer
ensemble dispatch.

### Step 1: Clarify the choice

1. Identify the design decision (one item — one ship/rework call, or one
   compare-these-directions).
2. If only one option is apparent, search for alternatives before
   proceeding (the null option — "keep the current design" / "don't ship
   this change" — is always a candidate).
3. Quick context scan: surface + platform (web / iOS / Android / desktop;
   viewport; LTR/RTL), stage (discovery / design / evaluation), known
   constraints (design system, frontend stack), the evidence on hand.

### Step 2: Research (with privacy guardrails)

Before proposing directions, gather design evidence from authoritative
sources per `../investigate/references/design-brief-spec.md` (the 5-tier
source taxonomy: standards-heuristics, design-system, competitor-reference,
user-research, design-press). Do not rely solely on internal knowledge.

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data
visible in screenshots, and secret-bearing frontend code pass an explicit
privacy gate before BOTH web search AND peer-host dispatch. Use generic
pattern/category terms in queries, never proprietary identifiers or
customer data. **Screenshots are sensitive by default** — describe a
candidate design in genericized terms rather than transmitting a raw
screenshot. When confidentiality is unclear, ask the user before searching.

If web search is unavailable, state the limitation and base research on
internal knowledge, clearly distinguishing verified heuristics/standards
from best-effort recall.

### Step 3: Compare across the resolved design axes

When invoked by command (`/designer:decide`), the active axis set is the
**resolved preset** from `$AGENTIC_DECIDE_CONTEXT_FILE` (built in
`commands/decide.md` Phase 0.5 from `references/decision-axes.yml`). Render
the comparison using those axes in document order. The table below is the
`balanced` preset's documentation rendering — the **fallback** axes when
the registry is missing or invalid (graceful-degradation per ADR-0027 §1.6).

<!-- @decide:axis-table:begin -->
| # | Axis | Tier | Core question |
|---|------|------|---------------|
| 1 | **사용성 Usability** | decisive | Can users accomplish the task efficiently and without confusion — learnable flow, clear affordances/states, forgiving error recovery? |
| 2 | **일관성 Consistency** | decisive | Does it cohere with the design system, platform conventions, and existing patterns, or fragment the experience? |
| 3 | **전환 Conversion** | supporting | Does it move the user toward the intended action — clear CTA, low-friction path, value legible at the decision point? |
| 4 | **매력도 Desirability** | supporting | Will users want to use it — polished, trustworthy, on-brand for the audience? |
| 5 | **명확성 Content-Clarity** | supporting | Is content clear, scannable, correctly leveled — labels, microcopy, hierarchy, reading order? |
| 6 | **구현가능성 Feasibility** | supporting | Can it be built/maintained within the frontend-stack + component-library + effort constraints? |
| 7 | **접근성 Accessibility** | **gate** | Does it clear WCAG A/AA (contrast, semantics, keyboard, focus, target size)? A hard barrier is a veto (candidate-level — Non-Goal 6). |

These seven anchors are the `balanced` preset — the default, resolved
for every `--size` tier. The archetype presets (`conversion`, `experience`,
`clarity`) swap the second decisive axis and drop the axes their archetype
does not turn on; they are reachable via explicit `--preset=<id>` or via the
L4 profiles that wire them (`cta` → `conversion`, `ui` → `experience`,
`content` → `clarity`; see `../_shared/references/orchestration.md`).

**Axis-set resolution + ritual size (command mode, ADR-0027 §1.5)**:
`--preset=<id>` wins outright; absent `--preset`, `--size=<tier>` resolves
`balanced` at every tier (designer has no compact tier — `--size` controls
rendering depth, not preset). In auto-activated mode (no command, no
context file) the skill MAY read a size hint from the user's prose ("treat
this as a minor/major decision"); absent a hint, use `balanced` at
`standard` depth.
<!-- @decide:axis-table:end -->

<!-- @decide:per-option-output:begin -->
#### REQUIRED output format — for each direction:

Render one bullet per axis in the resolved preset, in document order, with
the axis's label. The template below is the `balanced` preset at
`size=standard`.

```
### Direction [letter]: [name]
[1-sentence summary of the design direction]

- **사용성 Usability**: [assessment — task success, learnability, error recovery] — [source]
- **일관성 Consistency**: [assessment — design-system / platform / pattern fit] — [source]
- **전환 Conversion**: [assessment — CTA clarity, path friction] — [source]
- **매력도 Desirability**: [assessment — polish, trust, brand fit] — [source]
- **명확성 Content-Clarity**: [assessment — labels, hierarchy, reading order] — [source]
- **구현가능성 Feasibility**: [assessment — component reuse, build/maintenance cost] — [source]
- **접근성 Accessibility** [gate]: [PASS / CONDITIONAL / FAIL + the candidate WCAG barrier] — [source]
```

Every assessment carries a short `[source]` parenthetical (heuristic /
standard / design-system doc / competitor reference / user-research
Evidence-ID / `[uncited inference]` when it is the LLM's own synthesis).
The gate axis renders an explicit **PASS / CONDITIONAL / FAIL** verdict so
the veto rule below has a clean input (candidate-level — never phrased as a
conformance certificate).

**Size-aware per-axis depth**:
- `size=minor` → 1-2 line assessment per axis (evidence rule NOT relaxed —
  the `[source]` parenthetical stays; the accessibility gate still renders
  PASS/CONDITIONAL/FAIL).
- `size=standard` → the template above.
- `size=major` → the standard template PLUS a `- **2nd-order effects**:`
  bullet per axis (downstream interaction states, edge/empty/error states,
  responsive/RTL behavior, maintenance cost specific to that axis).
<!-- @decide:per-option-output:end -->

<!-- @decide:comparison-table:begin -->
#### REQUIRED output format — after all directions:

Render one row per axis in the resolved preset, in document order.

```
### Key Differences
| Axis | Direction A | Direction B | ... |
|------|-------------|-------------|-----|
| 사용성 Usability | ... | ... | |
| 일관성 Consistency | ... | ... | |
| 전환 Conversion | ... | ... | |
| 매력도 Desirability | ... | ... | |
| 명확성 Content-Clarity | ... | ... | |
| 구현가능성 Feasibility | ... | ... | |
| 접근성 Accessibility (gate) | PASS/COND/FAIL | ... | |
```

**Size-aware cell density**: `size=minor` → terse phrases; `size=standard`
→ one-sentence-equivalent cells; `size=major` → append one italicized
effect-note row beneath each axis row (e.g. `| _사용성 — 2nd-order_ | _<note
per direction>_ | … |`). Use this single cohesive shape — do NOT add a
separate column, so the table region stays stable for the
weighting/sensitivity rows below.
<!-- @decide:comparison-table:end -->

<!-- @decide:weighting-sensitivity-output:begin -->
#### REQUIRED output format — weighting + sensitivity (ADR-0027 §1.3)

This region renders ONLY when the opt-in gate fires:
`context.weights_explicit === true` (user passed `--weights=<spec>`) OR
`context.size === "major"`. Both are top-level fields of
`$AGENTIC_DECIDE_CONTEXT_FILE` — read them directly; do NOT infer
explicit-presence from `Object.keys(context.weights).length`. In all other
cases, omit this section so default `/designer:decide <prose>` output stays
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

The accessibility **veto is never encoded as a weight**. The gate axis does
carry a weight in the advisory aggregate like any supporting axis — the
resolver emits `accessibility: 1.0` by default and accepts an explicit
`--weights=accessibility:<w>` — but that weight only tilts the advisory row.
A gate **FAIL vetoes regardless of the aggregate**, and no weight (including
`accessibility:0`) can remove, soften, or strengthen the veto: the veto is
applied categorically by @decide:recommendation-rule tier 1, before any
aggregate is read. Never present a high accessibility weight as if it were
the gate, and never treat a low one as a waiver.

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

1. **Gate first (veto).** For each direction, evaluate the `gate: true`
   axis (접근성 Accessibility). If a recommended direction has a **FAIL** on
   the gate (an unmitigated candidate WCAG A/AA barrier — e.g. text that
   cannot meet contrast, an interaction with no keyboard path, an icon-only
   control with no accessible name), treat it as a HARD VETO: do NOT
   recommend it on usability/archetype strength. Lower confidence to LOW,
   recommend the accessible alternative, or route back to
   `/designer:investigate` (to size the barrier) or `/designer:frame` (to
   reshape around it). A **CONDITIONAL** gate is allowed only with the
   remediation named explicitly as a precondition in the recommendation —
   never folded silently into "polish later". This veto overrides the
   decisive-axis rule below. (Gate verdicts are candidate-level per
   Non-Goal 6 — runtime a11y testing still required to certify.)

2. **Decisive axes pick the winner.** Among gate-passing (or
   gate-conditional-with-named-remediation) directions, when the decisive
   axes (사용성 Usability + the archetype axis) clearly favor one direction,
   recommend it. Do NOT downgrade a decisive-favored direction on supporting
   axes alone — address conversion / desirability / feasibility concerns in
   the build plan instead. (Every designer preset declares 사용성 Usability
   plus one archetype decisive axis — ADR-0027 §1.3 minimum-decisive
   invariant — so this rule holds across `balanced` and the archetypes.)

3. **Supporting axes break ties / set confidence.** When the decisive axes
   are close, the supporting axes break the tie and calibrate confidence.

#### REQUIRED output format:

```
**Recommendation: Direction [letter] ([name])** — Confidence: [HIGH/MEDIUM/LOW]

Gate verdict: 접근성 Accessibility [PASS/COND/FAIL]
[if CONDITIONAL: the named remediation that is now a precondition]

[2-3 sentence rationale explaining WHY — decisive-axis evidence first]

Decisive factors: [which of 사용성 / the archetype axis most influenced this]
Sources: [key references / heuristics / user-research that support it]

Choose [other direction] instead if: [specific conditions — e.g. the gate
barrier is resolved, or a conversion signal materializes]
```

**Size-aware rigor**: `size=minor` → 1-sentence rationale + gate verdict +
Decisive factors + Choose-other-if + a brief Sources pointer (evidence rule
preserved). `size=standard` → the template above. `size=major` → the
template PLUS a `Decisive-axis ranking:` block (per-decisive-axis ranking
across directions, e.g. `사용성: A > C > B; 일관성: A = C > B`); and when the
weighting/sensitivity region renders, append the advisory
`Sensitivity-aggregate divergence:` / `Sensitivity: perturbation flips …`
lines with a single one-tier confidence downgrade — NEITHER flips the §1.3
recommendation.
<!-- @decide:recommendation-rule:end -->

**Confidence levels:** **HIGH** — strong evidence (validated user-research
or clear heuristic/standard), gate clearly passes, decisive axes aligned.
**MEDIUM** — good evidence, reasonable alternatives, or a CONDITIONAL gate
with a credible remediation. **LOW** — thin evidence, subjective tradeoffs,
or an unresolved gate barrier.

**Wait for the user to choose a direction** before proceeding. If the user
says "your call", present only the recommendation and confirm.

### Edge cases

- **Only one viable direction**: still follow the protocol; present the
  single direction with its axis analysis (including gate verdict) and note
  why alternatives were excluded. The null "keep current" option counts.
- **All directions roughly equal on decisive axes**: set confidence LOW,
  break the tie on supporting axes, state the choice is evidence-thin.
- **The gate FAILs on every direction**: recommend rework / reframe; the
  veto is the finding. Do not pick "least-inaccessible" past a hard barrier.
- **Search returns nothing**: state "No external evidence found"; base that
  axis on internal heuristics and label it explicitly.

---

## When invoked by command (`/designer:decide` Claude command or `$designer:decide` Codex skill mention)

Full decision support with Design Task Profile + peer ensemble +
state-write integration.

**Cross-host scope note (ADR-0001 §5 honest scope)**: the Phase 0.5
flag-parser bootstrap that writes `$AGENTIC_DECIDE_CONTEXT_FILE` lives in
`commands/decide.md` on the Claude side. Codex `$designer:decide` skill
mentions reach this SKILL.md directly. A Codex LLM serving
`$designer:decide` MAY replicate the contract by invoking
`scripts/decide-registry.mjs resolve` itself with the user's flag string
and reading the resulting `ResolvedDecisionContext` before emitting the
Brainstorm prompt — best-effort cross-host equivalence per ADR-0001 §5.
Absent that step, Codex falls back to the `balanced` design axes at standard
depth (no `--weights` / `--size` parsing).

### Pre-decide: Design Task Profile

Build the Design Task Profile per `../investigate/SKILL.md` § Design Task
Profile (Persona=designer, the Surface / Users / Stage / Platform /
Evidence-confidence fields, and Ensemble Affinity — recorded but not
gating, always-max policy). The shared
`../_shared/references/orchestration.md` reference.

### Steps 1-4

Follow the auto-activated steps above, at command fidelity.

### Step 5: Peer ensemble parallel analysis (Brainstorm point)

Before Step 4 Recommend, launch the peer ensemble using the **Brainstorm**
point type. The peer independently proposes 2-3 design directions with
tradeoffs across the resolved axes. Genericize per the privacy gate before
the peer prompt — the peer must never see proprietary UI or customer data,
and **screenshots are never sent to the peer as bytes** (the peer path is
code/text-based; `codex-companion` has no `--image` flag — vision critique
is a same-host `designer:critique` capability). The peer
call is automatic (always-max policy); skills do not pass `--model` /
`--effort`. (designer's `../_shared/references/ensemble-protocol.md`
§Brainstorm carries the formal prompt template +
synthesis contract, including the `<axis_awareness>` design-axis block; the
dispatch shape mirrors the reference-scan dispatch in
`../investigate/references/design-brief-ensemble.md`.)

Synthesize: add PEER-ONLY directions; elevate confidence for AGREED; label
unique directions by source ([Local] / [Peer]) in workflow phase notes only
(never in a saved artifact); present CONFLICT directions both ways and ask
the user.

### Approval gate

**Wait for the user to choose a direction** — do not proceed without
explicit approval.

### State write (when invoked from a workflow command)

When `/designer:decide` runs as a sub-step of a designer workflow command
(e.g. the `/designer:start` lifecycle macro), the invoking
command writes the decision (`chosen`, `rationale`, gate verdict,
`rejected`) to its workflow file. This skill itself does not write workflow
state. When invoked standalone, no workflow file write occurs.

---

## Completion — Active Next-Action Proposal

At the end of a successful decide (both paths), emit an **Active
Next-Action Proposal** instead of a fixed next verb — derived from this
decision, not a fixed table:

```
- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — decisive 사용성/archetype axis + the accessibility gate verdict>
- evidence_pointers:     <comparison rows / brief path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or $designer:<verb> for a verb>
```

Typical `selected_next` candidates for decide: `/designer:compose` to draft
the flows/specs for the chosen direction — or `/designer:investigate` if a
decisive evidence gap or an unresolved accessibility gate surfaced, or
`/designer:frame` if deciding reframed the UX problem. The routing is a
fallback only when evidence is genuinely neutral — do not end with a
hardcoded "next: X".

**Surface note (ADR-0042 Accepted).** The full designer surface ships: the
six cognitive verbs (`investigate` / `frame` / `decide` / `compose` /
`critique` / `refine`), the `/designer:start` lifecycle macro, and the
`resume` / `checkpoint` / `peer-now` meta skills. Every `next_command` this
proposal can name is runnable. The decision record is the durable handoff.

Always include the workflow path when invoked from a workflow command:

```
Workflow: <absolute path to workflow .md file>
```

(The inline Active Next-Action Proposal shape above is what designer ships;
the deeper runtime-completion-footer / ADR-0031 session-handoff seam
integration that the engineer plugin carries is future work, not part of
designer's surface.)

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

Decide IS the multi-axis verb — its comparison already renders the resolved
axes across directions. If a *sub-fork* surfaces mid-decision (e.g. two ways
to structure the same flow), keep the lens bounded to the decisive design
axes (사용성 + the archetype axis) + the accessibility gate rather than
re-running the full matrix for a trivial reversible step.

---

## Anti-patterns (do not produce)

- **Committing first, justifying after**. Always present comparison +
  recommendation before the user commits to a direction.
- **Recommending past a failed accessibility gate**. A FAIL on 접근성
  Accessibility is a veto, not a tradeoff — never fold a candidate WCAG
  barrier into "polish later" to keep a slicker direction alive.
- **Downgrading a decisive-favored direction on supporting axes alone**.
  Conversion / desirability / feasibility concerns belong in the build
  plan, not the winner-pick.
- **Recommendation without rationale**. The user needs the *why* —
  decisive-axis evidence and the gate verdict — not just the *what*.
- **Aesthetic claims without grounding** ("looks cleaner", "more modern")
  need a heuristic, standard, user-research, or competitor-reference basis.
- **Leaking proprietary material** to the peer or to web search. Genericize
  the directions and any customer/user data before any external call;
  screenshots are sensitive by default and never sent as bytes.
- **Certifying accessibility conformance**. The gate flags *candidate* WCAG
  A/AA issues; it does not issue a certificate — runtime testing (focus
  order, keyboard, screen-reader) is required (ADR-0042 Non-Goal 6).
