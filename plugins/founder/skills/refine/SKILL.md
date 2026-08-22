---
name: refine
description: "Applies critique findings or feedback to a business artifact — revises the venture plan, brief, or canvas, then verifies the change holds together. The founder persona's refinement verb (per ADR-0010 §2, ADR-0036 SD6). Use after a critique to incorporate the findings, or to apply feedback to a plan. Trigger phrases include 'apply the findings', 'address the review', 'revise the plan', 'incorporate the feedback', 'fix the unit-economics', 'tighten the strategy', 'update the canvas', 'apply the critique', '리뷰 반영', '피드백 반영', '계획 수정', '플랜 고쳐줘', '지적 반영', '보완해줘'."
---

# Refine (founder persona)

The founder plugin's refinement verb (per ADR-0010 §2, ADR-0036 SD6).
Apply critique findings or feedback to an existing **business artifact**
(a venture plan, a brief, a lean / business-model canvas, a strategy) and
verify the revision holds together. Refine assumes the *what to change*
is known; the work is doing it faithfully and confirming the artifact
stays internally consistent.

This verb takes no `--profile` argument — refine is single-mode by design
(the verb's purpose is faithful application + verification of an
already-decided change). Business sub-discipline context flows through
the Business Task Profile per `../_shared/references/orchestration.md`,
not via per-call profile arguments.

**Core principle**: do not revise the plan until the *why* is confirmed.
When refining in response to a business critique or an underperformance,
the upstream contract is:

```
critique (or investigate --profile=root-cause for an underperformance)
   →  decide (if 2+ viable remediation directions)
   →  refine
```

Skipping critique/investigate produces revisions that paper over the
symptom (a margin "fixed" by an unsupported assumption). Skipping decide
when 2+ remediation directions exist locks in an undeliberated change.

**Verify means internal consistency, not "run tests".** A business
artifact has no test suite — the verification is that the revised
sections still reconcile: do the revised unit-economics still hold up
against the go-to-market and pricing? Did the change open a new
regulatory / safety gate exposure? Are still-unverified numbers still
marked `[to be validated]`? founder does not let a revision quietly
introduce a fresh inconsistency.

---

## When auto-activated (without command)

Lightweight in-context refinement — no peer ensemble dispatch.

### Step 1: Verify upstream

Before revising, confirm the basis for the change:

- For critique-driven changes: a finding list from `/founder:critique`
  (or an equivalent feedback document).
- For underperformance-driven changes: a confirmed root cause from
  `/founder:investigate --profile=root-cause`. If none is confirmed,
  suggest running investigate first.
- For direction-driven changes: the direction is confirmed via
  `/founder:decide` (when 2+ viable remediation directions existed).

If multiple findings are pending, present them as a list and confirm with
the user which to address now (all? a subset? defer the rest?).

### Step 2: Apply the revision

For each item being addressed:

1. State the change before applying it: "Plan: revise the `<section>` to
   <action> because <finding>."
2. Apply the change to the artifact.
3. If the change is non-trivial (it touches unit-economics, the
   business model, or a gate-relevant section), present the before→after
   and confirm before moving on.

When the remediation involves 2+ viable directions, do NOT choose
silently — route through `/founder:decide` first.

### Step 3: Verify internal consistency

1. Re-read the sections downstream of the change. Confirm they still
   reconcile (a revised price flows to revised unit-economics flows to a
   revised go-to-market and milestone set).
2. Confirm the change did not introduce a new veto-gate exposure (규제노출
   Regulatory-Exposure, 안전리스크 Safety/Harm-Risk). A revision that solves
   a market problem by entering a regulated activity has moved the gate,
   not cleared it.
3. Confirm every still-unverified number or claim still carries its
   `[to be validated]` marker — a revision must not silently upgrade an
   assumption to a fact.

If verification surfaces a new inconsistency, return to Step 2 and report
it. Do NOT mark the refinement complete on an unreconciled artifact.

### Step 4: Present the result

```
## Refinement Summary
- Applied: [N findings / 1 revision / etc.]
- Verified: [downstream sections reconcile; gate exposure unchanged;
  [to be validated] markers intact]
- Deferred: [items not addressed and why]
```

If findings remain, that informs the Active Next-Action Proposal at
completion — typically `/founder:critique` again on the revised artifact
to confirm the change did not expose a new weakness.

---

## When invoked by command (`/founder:refine` Claude command or `$founder:refine` Codex skill mention)

Full refinement with Business Task Profile + peer ensemble verification +
state-write.

### Step 1: Business Task Profile

Build the Business Task Profile per
`../_shared/references/orchestration.md` Step 1 (Market / Segment / Stage
/ Risk-class / Evidence-confidence).

### Step 2: Apply the revision

Follow Step 2 above, at command fidelity.

### Step 3: Privacy gate (before any external call)

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web
search AND peer-host dispatch. Genericize the revision before the peer
prompt; the pre-genericization value MUST never leave the local host. See
`../investigate/references/business-brief-spec.md` § Privacy Gate.

### Step 4: Peer ensemble parallel verification (Refine-verify point)

Launch the peer ensemble per `../_shared/references/ensemble-protocol.md`
using the **Refine-verify** ensemble point type (peer `task` with the
Refine-verify prompt template per
`../_shared/references/ensemble-protocol.md` §Refine-verify). The peer
independently verifies the revision resolves the finding without
introducing a new inconsistency or a new gate exposure.

The peer call is automatic (always-max policy); skills do not pass
`--model` / `--effort`.

### Step 5: Synthesize

After both sides return:

1. Re-check internal consistency (Step 3 of auto-activated mode).
2. Collect the peer verification.
3. Synthesize per `../_shared/references/ensemble-protocol.md` §Base
   Synthesis Categories.
4. Resolve any new findings:
   - Straightforward → apply inline (return to Step 2).
   - 2+ viable directions → route through `/founder:decide`.
   - A peer-flagged regression (new inconsistency / new gate exposure) →
     pause and report to the user before proceeding.

Loop Steps 2-5 until no new findings emerge.

### State write (when invoked from a workflow command)

When `/founder:refine` runs as a sub-step of a founder workflow command,
the invoking command writes the applied revision (section, summary) and
the verification result (consistency confirmed, peer verdict) to its
workflow file. This skill itself does not write workflow state. When
invoked standalone, no workflow file write occurs.

---

## Completion — Active Next-Action Proposal

At the end of a successful refine (both paths), emit an **Active
Next-Action Proposal** instead of a fixed next verb — derived from this
refinement, not a fixed table:

```
- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + consistency/gate check>
- evidence_pointers:     <revised sections / artifact path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or $founder:<verb> for a verb>
```

Typical `selected_next` candidates for refine: `/founder:critique` to
confirm the revision with another review pass — or "the plan is sound,
proceed" when the change was small and the artifact reconciles, or
`/founder:investigate` when the refinement exposed a load-bearing
assumption that needs evidence. The routing is a fallback only when
evidence is genuinely neutral — do not end with a hardcoded "next: X". A
blocked outcome (peer flagged a regression) pauses for user direction
before any forward proposal.

(When the invoking workflow command's terminal write runs — `state.mjs
set-terminal` — the runtime completion footer is **code-emitted** on that
command's stderr per ADR-0039/ADR-0043 S3; do not hand-compose a second
footer — surface the emitted one. Standalone skill invocations write no
workflow state and emit no footer. Wiring:
`skills/_shared/references/session-handoff.md`.)

On Claude the Stop hook fires at **every turn end**, so that terminal write puts
the workflow in front of the archive gates at the end of **that same turn**, not
at session close — it archives then if every gate passes, and otherwise stays
marked for a later Stop to re-evaluate. Clearing the marker
(`--terminal-marker false`, with set-terminal's full flag set) works only before
that Stop fires and does not restore the previous phase. On Codex the hook runs
only once the operator has trusted the plugin hooks (`/hooks`), so evaluation
waits. Full contract: `skills/_shared/references/session-handoff.md`
§ Archive timing.

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

When refine reaches a **genuine 2+-branch decision point** — two viable
remediation directions, or two ways to close the same gap — surface a
**compact multi-axis lens** comparing the branches across the decisive
business axes (시장성 / 단위경제) + the veto gates, instead of a flat list,
reading `../decide/references/decision-axes.yml` (the
`scripts/decide-registry.mjs resolve --size=minor` compact 4-axis set;
the registry file is readable even when the resolver CLI is not).
Bounded: only at a genuine 2+-branch point, never the full matrix for a
trivial reversible step. A weightier fork should route to
`/founder:decide`.

---

## Anti-patterns (do not produce)

- **Refining before the why is confirmed**. Apply the upstream contract:
  critique / investigate → decide (if needed) → refine.
- **Choosing silently between remediation directions** when 2+ viable
  approaches exist. Route through `/founder:decide`.
- **Marking refinement complete on an unreconciled artifact**. If the
  revised unit-economics no longer reconcile with the go-to-market, the
  refinement is not done.
- **Solving a market problem by quietly entering a regulated activity**.
  That moves the veto gate, it does not clear it — surface the new
  exposure, do not bury it.
- **Upgrading an assumption to a fact**. A revision must not silently drop
  a `[to be validated]` marker to make the plan look more certain.
- **Leaking proprietary material** to the peer or to web search.
  Genericize the revision before any external call.
- **Professional-advice claims**. founder does not produce legal,
  financial, tax, or clinical advice (ADR-0036 Non-Goal 6); flag
  regulated-domain revisions as needing a qualified professional.
