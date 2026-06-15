---
name: critique
description: "Evaluates an existing business artifact — a venture plan, a brief, a lean canvas, a strategy — against market evidence, unit-economics, the regulatory/safety gates, competition, and failure modes. The founder persona's critique verb (per ADR-0010 §2, ADR-0036 SD6). Use to review a plan before committing, pressure-test a strategy, or run an adversarial pre-mortem. Trigger phrases include 'review this plan', 'check my business plan', 'pressure-test this', 'what's wrong with this strategy', 'pre-mortem', 'red-team this venture', 'poke holes in this', 'is this plan sound', 'critique the canvas', '사업계획 검토', '플랜 리뷰', '약점 짚어줘', '이 전략 괜찮아', '구멍 찾아줘', '레드팀', '사전부검'."
---

# Critique (founder persona)

The founder plugin's critique verb (per ADR-0010 §2, ADR-0036 SD6).
Evaluate an existing **business artifact** (a venture plan, a brief, a
lean / business-model canvas, a go-to-market or pricing strategy) from
multiple independent business perspectives to catch what
single-perspective review misses — the inflated market, the
unit-economics hole, the unmitigated regulatory gate, the incumbent
response the plan assumed away.

| Profile | What it does |
|---------|--------------|
| (default) | Multi-perspective review of a specific business artifact (the plan / brief / canvas under review) |
| `red-team` | Adversarial **pre-mortem** of an entire venture or strategy, with a Risk-class sub-focus (market / unit-economics / competitive / regulatory / execution / full) |

A verb-level sugar alias `/founder:premortem` MAY be published per
ADR-0010 §3 verb-level alias policy, expanding to
`/founder:critique --profile=red-team`. The canonical command is
`/founder:critique`.

The profile is set via `--profile=<name>` on `/founder:critique`, or
inferred from intent when auto-activated. A missing profile means the
default (review the artifact on hand). An unknown profile falls back to
default with a one-line warning. The `red-team` sub-focus is read from
the Risk-class taxonomy per `../_shared/references/ensemble-protocol.md`
§Adversarial-scan focus text.

**Core principle**: validity is the orchestrator's judgment. When
synthesizing findings (in both modes), judge each finding's validity
yourself — do not ask the user "is this an issue?". Drop invalid ones;
surface valid ones by severity. A finding that an axis is weak needs a
market or logical basis, the same standard the artifact itself is held
to. When a remediation involves 2+ viable directions, route through
`/founder:decide`; founder does **not** fix here — `/founder:refine`
applies the changes.

**Gate severity rule**: an unmitigated **veto gate** (규제노출
Regulatory-Exposure, 안전리스크 Safety/Harm-Risk — the `gate: true` axes in
`../decide/references/decision-axes.yml`) is CRITICAL by definition, not
a tradeoff to fold into "execution concerns". This mirrors the decide
verb's veto rule.

---

## When auto-activated (without command)

Lightweight in-context review — no peer ensemble dispatch. The
orchestrator evaluates each selected business perspective directly in
context.

### Step 1: Identify what to review

Identify the artifact in scope. For the default profile, that is the
business artifact on hand — the venture plan from `/founder:compose`, a
brief from `/founder:investigate`, a canvas, or a strategy the user
supplies. If nothing is on hand, ask the user what to review.

For `red-team` profile, the scope is the whole venture / strategy; select
the Risk-class sub-focus (market / unit-economics / competitive /
regulatory / execution / full).

### Step 2: Determine review perspectives

Select perspectives based on the artifact's risk profile. Default
candidates align with founder's decision axes + Risk-class taxonomy:

- **시장성 Market-Attractiveness** — is the market real, reachable, sized honestly?
- **단위경제 Unit-Economics** — do the numbers reconcile? CAC vs value captured, contribution-margin path?
- **지불의사 Willingness-to-Pay** — is there behavioral demand evidence, not just stated interest?
- **경쟁강도 Competitive-Intensity** — is the wedge defensible, or a race to the bottom?
- **규제노출 Regulatory-Exposure** (gate) — does it clear licensing/compliance for the jurisdiction(s)?
- **안전리스크 Safety/Harm-Risk** (gate) — are safety / liability / privacy / harm exposures acceptable and mitigable?
- **Execution** — are the team, dependencies, and go-to-market assumptions realistic?
- **Evidence quality** — which load-bearing claims are presented as facts without support?

Add specialist depth only where the artifact's risk warrants it. A quick
viability sanity-check does not need all eight; a `build`-stage plan must
include unit-economics + the gates.

### Step 3: Synthesize

1. Merge findings from all perspectives.
2. Remove duplicates.
3. Sort by severity (CRITICAL > MAJOR > MINOR > SUGGESTION). An
   unmitigated veto gate is CRITICAL.
4. Present the consolidated review.

### Output format

```
## Review Summary
[1-2 sentence overall assessment — is this plan sound enough to commit?]

## Gate verdict
규제노출 [PASS/CONDITIONAL/FAIL] · 안전리스크 [PASS/CONDITIONAL/FAIL]
[if any FAIL/CONDITIONAL: the blocker and what would clear it]

## Critical Issues
- [section/claim] [perspective] — [description + the failure scenario]

## Major Issues
- [section/claim] [perspective] — [description]

## Suggestions
- [section/claim] [perspective] — [description]

## Looks Strong
- [what holds up under scrutiny]
```

Do NOT fix issues in this skill — critique produces findings. The
concrete next step is the Active Next-Action Proposal at completion (see
§ Completion below), not a fixed handoff.

---

## When invoked by command (`/founder:critique` Claude command or `$founder:critique` Codex skill mention)

Full review with Business Task Profile + peer ensemble parallel analysis
+ state-write.

### Step 1: Business Task Profile

Build the Business Task Profile per
`../_shared/references/orchestration.md` Step 1 — Persona=founder, the
Market / Segment / Stage / Risk-class / Evidence-confidence fields, and
the verb's Skill-profile (`(default)` / `red-team`).

### Step 2: Collect the artifact context

Collect the artifact under review and the claims it rests on (plan
sections, the brief's findings, the canvas boxes). For `red-team`, gather
the whole venture scope and the load-bearing assumptions. This is the
context the orchestrator reviews directly and (genericized) embeds in the
peer prompt.

### Step 3: Privacy gate (before any external call)

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web
search AND peer-host dispatch. Genericize the artifact before the peer
prompt; the pre-genericization value MUST never leave the local host. See
`../investigate/references/business-brief-spec.md` § Privacy Gate.

### Step 4: Peer ensemble parallel analysis

Launch the peer ensemble per `../_shared/references/ensemble-protocol.md`:

- Default profile → **Review** ensemble point type (peer `task` with the
  Review prompt template per `../_shared/references/ensemble-protocol.md`
  §Review).
- `red-team` profile → **Adversarial-scan** ensemble point type (peer
  `task` with the Adversarial-scan prompt template + the Risk-class
  sub-focus text per `../_shared/references/ensemble-protocol.md`
  §Adversarial-scan).

The peer call is automatic (always-max policy); skills do not pass
`--model` / `--effort`.

### Step 5: Synthesize

1. Collect the peer ensemble result.
2. Deduplicate findings across all sources by section/claim.
3. Unify severity ratings (take the higher on a duplicate). An
   unmitigated veto gate is CRITICAL.
4. Label sources per `../_shared/references/ensemble-protocol.md` §Base
   Synthesis Categories — `[Local]` / `[Peer]` / `[Both]` in the workflow
   phase notes; the saved review report strips them.

### Step 6: Present

Use the same output shape as auto-activated mode. Do NOT fix issues —
critique produces findings; the next action is the Active Next-Action
Proposal at completion.

### State write (when invoked from a workflow command)

When `/founder:critique` runs as a sub-step of a founder workflow
command, the invoking command writes the findings to its workflow file.
This skill itself does not write workflow state. When invoked standalone,
no workflow file write occurs.

---

## Completion — Active Next-Action Proposal

At the end of a successful critique (both paths), emit an **Active
Next-Action Proposal** instead of a fixed next verb — derived from these
findings, not a fixed table:

```
- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + the gate verdict>
- evidence_pointers:     <finding sections / artifact path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or $founder:<verb> for a verb>
```

Typical `selected_next` candidates for critique: `/founder:refine` to
address selected findings (typically CRITICAL + MAJOR; the user picks
which MINOR / SUGGESTION to include) — or `/founder:decide` when a
finding opens a genuine fork (two remediation directions, or a reframe vs
persevere call), or `/founder:investigate` when a finding rests on a
load-bearing claim that needs evidence before it can be judged. When the
artifact holds up and only minor polish remains, `selected_next` may be
"the plan is sound — proceed". The routing is a fallback only when
evidence is genuinely neutral — do not end with a hardcoded "next: X".

(The inline Active Next-Action Proposal shape above is what founder
ships; the deeper runtime-completion-footer / ADR-0031 session-handoff
seam integration that the engineer plugin carries is future work, not
part of founder's surface.)

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

When critique reaches a **genuine 2+-branch decision point** — two viable
remediation directions, or two severity reads of the same finding, or a
non-neutral `selected_next` with 2+ candidates in the proposal above —
surface a **compact multi-axis lens** comparing the branches across the
decisive business axes (시장성 / 단위경제) + the veto gates, instead of a flat
list, reading `../decide/references/decision-axes.yml` (the
`scripts/decide-registry.mjs resolve --size=minor` compact 4-axis set; the
registry file is readable even when the resolver CLI is not). Bounded:
only at a genuine 2+-branch point, never the full matrix for a trivial
reversible step. A weightier fork should route to `/founder:decide`.

---

## Anti-patterns (do not produce)

- **Asking the user "is this an issue?"** Validity is the orchestrator's
  judgment. Drop invalid findings; surface valid ones by severity.
- **Folding a failed gate into "execution concerns"**. An unmitigated
  규제노출 / 안전리스크 exposure is CRITICAL — surface it as a veto-grade
  finding, never soften it to keep a market-attractive plan looking sound.
- **Single-perspective review** when the artifact's risk profile warrants
  more (e.g., reviewing a regulated-domain plan without the regulatory +
  safety gates).
- **Fixing in the same skill**. Critique produces findings;
  `/founder:refine` applies the changes.
- **Severity inflation**. CRITICAL is reserved for fatal flaws and
  unmitigated gates; SUGGESTION is for polish that does not gate the
  decision.
- **Findings without basis**. "The market is too small" with no source is
  as weak as the claim it critiques — cite a market reality or mark it
  INFERENCE:.
- **Leaking proprietary material** to the peer or to web search.
  Genericize the artifact before any external call.
- **Professional-advice claims**. founder does not produce legal,
  financial, tax, or clinical advice (ADR-0036 Non-Goal 6); flag
  regulated-domain findings as needing a qualified professional.
