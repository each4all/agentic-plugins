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

When invoked by command (`/engineer:decide`), the active axis set is
the **resolved preset** from `$AGENTIC_DECIDE_CONTEXT_FILE` (built
in commands/decide.md Phase 0.5 from
`skills/decide/references/decision-axes.yml` per ADR-0027 §1).
Render the comparison using those axes in document order. The axis
table below is the `default` preset's documentation rendering and is
unchanged by registry updates — it shows the **fallback** axes when
the registry is missing or invalid (graceful-degradation per §1.6).

<!-- @decide:axis-table:begin -->
| # | Perspective | Core question |
|---|-------------|---------------|
| 1 | **Essence** | Does this solve the fundamental problem, or just a symptom? |
| 2 | **Foundation** | Is this architecturally sound as a long-term base? |
| 3 | **Standards** | Does it align with industry standards and specifications? |
| 4 | **Best Practice** | Is it the canonical approach recommended by authoritative sources? |
| 5 | **Practical Fit** | Is it the best choice for this project's specific constraints? |

These five anchors are the `default` preset. They map directly to
the user's stated quality axes (표준 / 정석 / 권장 / 근본 / 본질) —
the decision-support quality the engineer plugin targets. The
`nine-axis` preset extends the mapping to the full 9-axis matrix
(see `references/decision-axes.yml`).

**Axis selection and ritual size (command-invoked mode, per
ADR-0027 §1.5)**:

Axis-set resolution follows §1.5 precedence — `--preset=<id>` wins
outright; absent `--preset`, `--size=<tier>` implies the axis-set
per §1.5(2):

- `--size=minor` (no `--preset`) → `compact` preset (4 axes —
  essence, foundation, practical-fit, entry-routing-guarantee). The
  `entry-routing-guarantee` axis is a single combined check covering
  the 4 entry-routing-contract guarantees (source-of-truth, root
  cause, verification evidence, rollback path) per
  `../_shared/references/entry-routing-contract.md` lines 46-49.
- `--size=standard` (or no `--size`, no `--preset`) → `default`
  preset (5 axes; shown in the table above).
- `--size=major` (no `--preset`) → `nine-axis` preset (9 axes; see
  `references/decision-axes.yml`).

When both `--preset` and `--size` are passed, `--preset` controls the
axis-set and `--size` independently controls per-axis rendering depth
— see `@decide:per-option-output`, `@decide:comparison-table`, and
`@decide:recommendation-rule` for the size-aware depth rules.
Example: `--size=minor --preset=nine-axis` renders **9 axes at minor
depth** — NOT 4 axes at minor depth.

In auto-activated mode (no command, no `$AGENTIC_DECIDE_CONTEXT_FILE`),
the skill MAY read `--size`-style hints from the user's prose per
ADR-0027 §2.6 (e.g., "compare these as a minor decision" → minor
ritual; "this is a major architectural choice" → major ritual). Absent
any such prose hint, the skill uses the `default` preset at `standard`
depth.
<!-- @decide:axis-table:end -->

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting
the comparison. In interview mode, one decision item = one option
with its multi-perspective analysis.

<!-- @decide:per-option-output:begin -->
#### REQUIRED output format — for each option:

For command-invoked mode, render one bullet per axis in the resolved
preset (from `$AGENTIC_DECIDE_CONTEXT_FILE`), in document order, with
the axis's English label. The five-bullet template below is the
`default` preset's rendering at `size=standard`.

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
  THIS project's tech stack, team, timeline, existing patterns] — [source]
```

**Size-aware per-axis depth (per ADR-0027 ritual-sizing ownership)**:

- `size=minor` → 1-2 line assessment per axis. The evidence rule is
  NOT relaxed — every assessment still carries a short `[source]`
  parenthetical (file path, doc anchor, or `[uncited inference]` when
  the assessment is the LLM's own synthesis without an external
  source). Only the prose verbosity shrinks. For the
  `entry-routing-guarantee` axis in the `compact` preset, the
  assessment MUST address all 4 guarantees explicitly (one phrase per
  guarantee is sufficient at minor size) — see
  `@decide:recommendation-rule` for the hard-gate behavior when any
  guarantee is missing.
- `size=standard` → the template above (substantive WHY + `[source]`
  per bullet). Absent a prose-hinted size (per ADR-0027 §2.6),
  auto-activated mode renders at standard depth.
- `size=major` → the standard template PLUS a `- **2nd-order risks**:`
  bullet per axis listing second-order dependencies, failure modes,
  or consumer impact specific to that axis.

If `size=minor` triggered a ritual-fallback (compact preset missing
or malformed per ADR-0027 §1.6), render the resolved fallback
preset's axes at minor depth; the entry-routing-guarantee hard-gate
becomes ADVISORY because the axis is no longer in the resolved set.
<!-- @decide:per-option-output:end -->

<!-- @decide:comparison-table:begin -->
#### REQUIRED output format — after all options:

For command-invoked mode, render one row per axis in the resolved
preset, in document order. The five-row template below is the
`default` preset's rendering at `size=standard`.

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

**Size-aware cell density (per ADR-0027 ritual-sizing ownership)**:

- `size=minor` → terse cell text (a phrase, not a full sentence per
  cell). Evidence pointers may collapse to a single short reference
  per cell when material to the cell's verdict.
- `size=standard` → the template above (one-sentence-equivalent per
  cell). Absent a prose-hinted size (per ADR-0027 §2.6),
  auto-activated mode uses this density.
- `size=major` → after each axis row, append one **italicized risk
  note** as a separate row directly beneath the axis row, prefixed
  with the axis name in italics (e.g., `| _Essence — risk_ | _<note
  per option>_ | ... |`). Use this single cohesive shape across
  every major-size comparison table — do NOT introduce a separate
  risk column, so the comparison-table region stays stable for PR4
  weighting/sensitivity and PR5 validation surfaces.
<!-- @decide:comparison-table:end -->

<!-- @decide:weighting-sensitivity-output:begin -->
#### REQUIRED output format — weighting + sensitivity (ADR-0027 §1.3 + PR4)

This region renders ONLY when the sensitivity opt-in gate fires:
`context.weights_explicit === true` (user passed `--weights=<spec>`,
emitted by `decide-registry.mjs` per ADR-0027 §5.6 PR4 amendment)
OR `context.size === "major"`. Both signals are top-level fields of
`$AGENTIC_DECIDE_CONTEXT_FILE`, so the LLM reads them directly — do
NOT infer explicit-presence from `Object.keys(context.weights).length > 0`,
which would re-introduce the object-identity bug peer G3 warded off
at the JS API. In all other cases, omit this entire section so
default `/engineer:decide <prose>` output stays byte-identical to
the pre-PR4 baseline (backward-compat invariant).

**Grade emission contract (size-aware)**:

When this region renders, each per-option bullet in
`@decide:per-option-output` MUST carry a `[grade: ◎|○|△|×]` suffix.
The 4-grade scale maps to numeric scores (◎=3, ○=2, △=1, ×=0) — single
source of truth lives in the `GRADE_MARKERS` exported constant at
`scripts/lib/decide-scores.mjs` (the same module supplies the
`gradeToScore()` function consumers use to convert). The MUST is
load-bearing because the weighted aggregate row below cannot be
computed without per-axis grades — omitting them produces `(n/a)` in
every cell (PR4 refine M7: strengthened from "MAY carry an optional"
since the aggregate row's presence is non-optional when the region
renders, per the unified opt-in gate above). PR4 refine A1: explicit
`GRADE_MARKERS` reference pins the prose-code contract — changing the
marker set in code requires touching this prose, preventing silent
drift.

Auto-activated mode and default invocation (no `--weights`,
`size !== "major"`) do NOT emit grades — the output stays prose-only
to preserve the backward-compat invariant.

- `size=minor` (+ `--weights=…`) → emit `[grade: X]` per bullet using
  the compact preset's axes; the weighted aggregate row still applies.
- `size=standard` (+ `--weights=…`) → emit `[grade: X]` per bullet so
  the weighted aggregate row can be computed.
- `size=major` → emit `[grade: X]` per bullet AND the sensitivity
  flip summary below (sensitivity auto-enables in major mode even
  without explicit `--weights`).

**Weighted aggregate row** (appended to `@decide:comparison-table`
after all axis rows AND any size=major italicized risk-note rows):

```
| _Weighted aggregate_ | <option-A score> | <option-B score> | ... |
```

Per-option score formula: `Σ(grade_i × weight_i) / Σ(weight_i)` over
scored axes. Uniform `{}` weights are expanded to 1.0 per axis before
aggregation. Zero-weight axes are excluded from both numerator and
denominator. All-zero weights or all-missing grades produce `(n/a)`
in the cell with a diagnostic note beneath the row.

**ADR §1.3 advisory-only invariant**: the weighted aggregate row is
**advisory information**, NOT the recommendation winner. The
`@decide:recommendation-rule` rule (decisive axes win) remains the
sole winner-picker. When the aggregate row indicates a different top
option than the §1.3 rule, the recommendation block adds a
`Sensitivity-aggregate divergence:` line (per
`@decide:recommendation-rule` size=major rigor below) and lowers
confidence by one tier — but does NOT flip the recommendation itself.

**Sensitivity flip summary** (renders when sensitivity opt-in gate
fires — `context.weights_explicit === true` OR `context.size === "major"`;
matches `analyzeSensitivity()` in `scripts/lib/decide-sensitivity.mjs`):

```
### Sensitivity (±20% per-axis weight perturbation)
- _unperturbed_top_: <option-letter>
- _flipped_: <true | false>
- _flips_:
  - axis=<axis-id>, direction=<+20% | -20%>, → option <letter>
  - ...
```

`_unperturbed_top_` is the aggregate top BEFORE any perturbation
(internally computed by `analyzeSensitivity`; exposed so the LLM can
compare it against the §1.3 decisive-axis winner — when the two differ
this is the "Sensitivity-aggregate divergence" case described in
`@decide:recommendation-rule` size=major rigor below). When
`flipped: false`, the recommendation is stable under weight
perturbation. When `flipped: true`, each entry names the axis and
direction that produces a different top option under the
advisory-only aggregate view. The two-option single-differentiator
case emits `_flips_: []` with a diagnostic explaining that
perturbation cannot reverse order on positive weights (peer (f)
sanity invariant pinned by `tests/engineer/test-decide-scores.mjs`).

**Size-aware rendering**:

- `size=minor` + `--weights=…` → render this summary in compact form
  (header + `_flipped_` + `_unperturbed_top_` lines only; omit the
  `_flips_` list if `flipped: false`).
- `size=standard` + `--weights=…` → render in full as shown above.
- `size=major` (with or without `--weights`) → render in full AND
  trigger the recommendation-rule sensitivity rigor below.
<!-- @decide:weighting-sensitivity-output:end -->

### Step 4: Recommend

Always provide a recommendation. Never leave the user with only a
comparison.

<!-- @decide:recommendation-rule:begin -->
When the **decisive** axes (axes with `role: decisive` in the
resolved preset) clearly favor one option, recommend it. Do not
downgrade based on supporting axes alone — address practical
concerns in the execution plan instead.

In the `default` preset the decisive axes are Essence and Foundation;
in the `nine-axis` preset they are also Essence and Foundation; in
the `compact` preset they are also Essence and Foundation (per
ADR-0027 §1.3 minimum-decisive-axis invariant: every preset declares
at least two decisive axes, and these two remain decisive across all
shipped presets to preserve the cross-preset recommendation rule).

**Entry-routing hard gate (compact preset only — overrides the
"supporting axes don't downgrade" rule above)**: when the resolved
preset is `compact` (i.e. `--size=minor` resolved through ADR-0027
§1.5(2) without fallback), the `entry-routing-guarantee` axis is
nominally `role: supporting`, BUT the underlying gate is NOT
optional — see
`../_shared/references/entry-routing-contract.md` lines 46-49
("This gate is not optional"). If the recommended option's
`entry-routing-guarantee` axis assessment finds that any of the 4
guarantees (source-of-truth/standard, invariant/root cause,
verification evidence, rollback/defer/escalation path) is missing
or unmet, treat it as a hard gate: lower the recommendation
confidence to MEDIUM or LOW, recommend defer, or route back to
`/engineer:investigate`, `/engineer:decide`, or
`/orchestrator:plan`. Do NOT fold the failing guarantee into
"execution-plan concerns" or assume it can be addressed after the
recommendation. This rule applies only when the resolved preset
includes `entry-routing-guarantee` — if `--size=minor` triggered a
ritual-fallback (compact missing/malformed per §1.6), the hard
gate becomes ADVISORY because the axis is not in the resolved set.

#### REQUIRED output format:

```
**Recommendation: Option [letter] ([name])** — Confidence: [HIGH/MEDIUM/LOW]

[2-3 sentence rationale explaining WHY, not just WHAT]

Decisive factors: [which 1-2 perspectives most influenced this]
Sources: [key references that support the recommendation]

Choose [other option] instead if: [specific conditions under which
a different option becomes the better choice]
```

**Size-aware recommendation rigor (per ADR-0027 ritual-sizing
ownership)**:

- `size=minor` → 1-sentence rationale + Decisive factors +
  Choose-other-if + (when compact preset is resolved) the explicit
  entry-routing-guarantee hard-gate verdict above. The Sources line
  may collapse to a brief `Sources: [file or link]` pointer but MUST
  remain present — the evidence rule from `@decide:per-option-output`
  is preserved.
- `size=standard` → the template above (2-3 sentence rationale +
  Sources + Choose-other). Absent a prose-hinted size (per ADR-0027
  §2.6), auto-activated mode uses this depth.
- `size=major` → the standard template PLUS a `Decisive-axis
  ranking:` block listing the recommended option's per-decisive-axis
  ranking versus alternatives (e.g.,
  `essence: A > C > B; foundation: A = C > B`). When the
  `@decide:weighting-sensitivity-output` region also renders (per its
  presence rule), TWO advisory lines are appended below the ranking
  block — both informational, NEITHER flips the §1.3 recommendation:
  - If the weighted aggregate top option ≠ the §1.3 recommendation
    winner, add `Sensitivity-aggregate divergence: aggregate favors
    option <X>; recommendation stays option <Y> per §1.3 decisive-axis
    rule.` AND lower Confidence by one tier (HIGH → MEDIUM → LOW;
    LOW stays LOW).
  - If the sensitivity flip summary reports `flipped: true`, add
    `Sensitivity: perturbation flips top to <Z> on axis <axis-id>
    <direction>.` listing every flip entry from the summary. Same
    one-tier Confidence downgrade applies (combined with the
    divergence downgrade, but capped at a single downgrade per
    recommendation — never two stacked).
  The recommendation winner stays bound to the §1.3 rule across all
  size=major sensitivity / divergence cases — the user reads the
  advisory lines and decides whether to override.
<!-- @decide:recommendation-rule:end -->

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

**Cross-host scope note (ADR-0001 §5 honest scope)**: the Phase 0.5
flag-parser bootstrap that writes `$AGENTIC_DECIDE_CONTEXT_FILE` lives
in `commands/decide.md` on the Claude side. Codex `$engineer:decide`
skill mentions reach this SKILL.md directly without the Claude command
file (Codex's plugin manifest currently exposes only `skills/`; a
Codex equivalent of `commands/*.md` awaits the ADR-0013 trigger).
The full-fidelity axis-awareness contract (ADR-0027 §1.5 sizing,
§2.2 flag grammar, §4 Brainstorm `<axis_awareness>` block) is
therefore **Claude-command-mode** today. Codex skill-mention LLM
serving `$engineer:decide` MAY replicate the contract by invoking
`scripts/decide-registry.mjs resolve` itself with the user's flag
string and reading the resulting `ResolvedDecisionContext` before
emitting the Brainstorm prompt — best-effort cross-host equivalence
per ADR-0001 §5. Build that script path from the Codex install root
documented in `../checkpoint/SKILL.md` § Claude/Codex command
resolution, which records the default layout: a Codex skill mention has
no plugin-root variable in its shell, so `$CLAUDE_PLUGIN_ROOT` resolves
empty there and a non-default install root must be resolved from the
running install. What
ADR-0013 defers is the command file that would run this automatically,
not the script's reachability. Absent that step, Codex falls back to free-form
2-3 approaches (axis-awareness omitted), matching the §4.3
presence-rule omit branch.

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

**ADR-0027 §4 axis-awareness contract**: the Brainstorm prompt
template emits an optional `<axis_awareness>` block carrying the
resolved preset's axes, size, and weights so the peer's tradeoff
vocabulary aligns with the orchestrator's comparison frame. The
block is present only in command mode AND when
`context.registry_fallback === false` (per ADR-0027 §4.3 presence
rule + §5.6 PR5 amendment); auto-activated invocation never
dispatches a peer (see `## When auto-activated` above — "no peer
ensemble dispatch"), so the standalone-skill path NEVER emits
`<axis_awareness>`. The full template, presence rule, snapshot
rule, and [Peer · unmapped] synthesis sub-label live in
`../_shared/references/ensemble-protocol.md` § Brainstorm.

Synthesize per `../_shared/references/ensemble-protocol.md`:
- Add any peer-proposed approaches the orchestrator did not consider.
- Elevate confidence for AGREED approaches.
- Label unique approaches by source ([Local] / [Peer]).
- When `<axis_awareness>` was present at dispatch, additionally
  tag PEER-ONLY approaches whose tradeoff vocabulary is orthogonal
  to the snapshotted axes as `[Peer · unmapped]` per ADR-0027 §4.4.

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

## Completion — Active Next-Action Proposal

At the end of a successful decide (both the auto-activated and the command
path above), emit an **Active Next-Action Proposal** instead of a fixed
next verb, per `../_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal — derived from this decision, not a fixed
table:

```
- selected_next:         <verb | commit | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; the commit / owner-decision action otherwise>
```

Typical `selected_next` candidates for decide: `/engineer:compose` to
produce the artifact for the chosen direction — or `/engineer:investigate`
if a decisive evidence gap surfaced, or `/engineer:frame` if deciding
reframed the problem. The routing table is the fallback only when evidence
is genuinely neutral — do not end with a hardcoded "next: X". When
`selected_next` is `engineer:decide`, also name the decision size
(`--size=minor|standard|major`) per the contract. The auto-activated path
stays lightweight (ADR-0029 §3): it emits this proposal shape and routing
reasoning without dispatching a peer.

---

## Session-level handoff preflight (ADR-0031)

The completion footer — including the ADR-0031 continue-vs-fresh
session-handoff — is **code-emitted** on this verb's terminal path (ADR-0039):
`state.mjs set-terminal` fires the session-handoff sidecar, which renders the
runtime `footer.mjs` on the terminal command's stderr. Do not hand-compose the
footer or hand-pass the projection here; surface the emitted one. On detached
HEAD the sidecar reports "no active branch context" and does not auto-recommend
a fresh session. This mirrors the `/engineer:decide`
command's preflight so `$engineer:decide` on Codex surfaces it identically.

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
