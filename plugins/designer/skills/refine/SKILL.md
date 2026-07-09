---
name: refine
description: "Applies critique findings or feedback to a design artifact — revises the user flow, wireframe spec, CTA copy, component spec, or the frontend code + rendered screen, then re-critiques to confirm the change converges without introducing a new accessibility barrier. The designer persona's refinement verb (ADR-0010 §2, ADR-0042 SD4 convergence loop). Use after a critique to apply the findings, or to iterate a design toward convergence. Trigger phrases include 'apply the findings', 'address the review', 'fix this screen', 'revise the flow', 'incorporate the feedback', 'tighten the CTA', 'fix the a11y issues', 'apply the critique', 'iterate on this design', '리뷰 반영', '피드백 반영', '이 화면 고쳐줘', '플로우 수정', '지적 반영', '접근성 고쳐줘', '디자인 보완해줘'."
---

# Refine (designer persona)

The designer plugin's refinement verb (per ADR-0010 §2, ADR-0042 SD4). Refine
applies critique findings or feedback to an existing **design artifact** — a
pre-code design spec (user flow, wireframe spec, CTA copy, information
architecture, component spec) OR a post-code surface (the frontend code + the
rendered screen) — and verifies the revision holds together. Refine assumes the
*what to change* is known; the work is applying it faithfully and confirming the
design still reconciles. The user is the decision-maker; this verb maximizes the
fidelity and honesty of the revision, not the automation of the change.

Refine closes designer's **quality loop** (ADR-0042 SD4 item 5): the signature
shape is **critique → refine → re-critique until findings converge** (the
engineer Phase 5–6 convergence pattern, copied). A refinement is not "done" when
the edit lands — it is done when a re-critique of the revised artifact confirms
the finding is resolved and no new barrier was opened.

This verb takes no `--profile` argument — refine is **single-mode by design**
(the verb's purpose is faithful application + verification of an already-decided
change). The L4 design archetype (general default; ui / flow / cta / content)
flows through the Design Task Profile per `../investigate/SKILL.md` § Design Task
Profile (the shared `../_shared/references/orchestration.md` reference lands at
PR6), not via a per-call profile argument.

**Core principle**: do not revise the design until the *why* is confirmed. When
refining in response to a critique or a usability/conversion problem, the
upstream contract is:

```
critique  (or investigate for a load-bearing evidence gap)
   →  decide  (if 2+ viable remediation directions)
   →  refine
```

Skipping critique/investigate produces revisions that paper over the symptom (a
low-contrast CTA "fixed" by a color the design system does not sanction).
Skipping decide when 2+ remediation directions exist locks in an undeliberated
change (choosing a modal over an inline form without weighing the flow).

**Verify means the design still reconciles, not "run tests".** A design artifact
is held to its own acceptance criteria, not a unit-test suite:

- Do the revised elements still carry their **accessibility + consistency
  acceptance criteria** (the two-bullet block `/designer:compose` annotates in)?
- Does the revised flow still honor the frame's **measurable UX success
  metrics**, or did the change quietly trade one away?
- Are still-unvalidated assumptions still marked `[to be validated]` — a revision
  must not silently upgrade an assumption to a fact to make the design look more
  certain.
- **Did the change open a new accessibility barrier?** This is the load-bearing
  design gate: a revision that clears a usability or conversion problem by
  introducing a candidate WCAG A/AA barrier (contrast, semantic structure,
  visible focus, target size, non-color cue, accessible name) has **moved the
  veto gate, not cleared it**. Surface the new exposure; never bury it.

For a **post-code** revision (a frontend-code edit + the re-rendered screen), the
verification can additionally read the **re-rendered screen host-direct**
(same-host vision). designer does **not** run the frontend build — the re-rendered
screen is the one the user / frontend engineer supplies after rebuilding. If that
screen is unavailable, or the edit broke the render, the vision re-critique cannot
run: report the code/text verification only, flag the visual re-critique
**UNVERIFIED**, and do not claim full convergence. The candidate-only
accessibility boundary still holds either way (ADR-0042 Non-Goal 6): focus order,
keyboard traversal, and screen-reader behavior need runtime interaction testing a
static re-critique cannot certify.

---

## When auto-activated (without command)

Lightweight in-context refinement — no peer ensemble dispatch, no subagents.

### Step 1: Verify upstream

Before revising, confirm the basis for the change:

- For critique-driven changes: a finding list from `/designer:critique` (or an
  equivalent feedback document).
- For evidence-gap changes: a load-bearing convention / accessibility claim
  confirmed via `/designer:investigate`. If a claim the revision rests on is
  unverified, suggest investigating first rather than guessing.
- For direction-driven changes: the direction is confirmed via `/designer:decide`
  (when 2+ viable remediation directions existed).

If multiple findings are pending, present them as a list and confirm with the
user which to address now (all? the CRITICAL + MAJOR set? a subset? defer the
rest?).

### Step 2: Apply the revision

For each item being addressed:

1. State the change before applying it: "Plan: revise the `<flow/screen/element>`
   to <action> because <finding>."
2. Apply the change to the artifact (the spec text, or the frontend code).
3. If the change is non-trivial (it touches a primary flow, a CTA, a gate-relevant
   accessibility criterion, or a shared component), present the before→after and
   confirm before moving on.

When the remediation involves 2+ viable directions, do NOT choose silently —
route through `/designer:decide` first.

### Step 3: Verify the design reconciles (+ the re-critique)

1. Re-read the elements downstream of the change. Confirm they still reconcile
   (a revised layout still satisfies the flow's states — default / loading /
   empty / error / success; a revised CTA still matches the IA and the value
   proposition).
2. Confirm the change did not open a **new accessibility barrier** (the gate
   above). A revision that solves a usability/conversion problem by introducing a
   candidate WCAG A/AA barrier has moved the gate, not cleared it.
3. Confirm every still-unvalidated assumption keeps its `[to be validated]`
   marker, and the revised flow still honors the frame's measurable success
   metrics.
4. **Re-critique** the revised artifact (the convergence step): re-apply the
   relevant `/designer:critique` lenses (usability / accessibility / conversion /
   consistency) to the change. For a post-code revision, read the re-rendered
   screen host-direct **when the user / frontend engineer supplies it** (designer
   does not run the build); if it is unavailable or the edit broke the render, the
   vision re-critique cannot run — flag it UNVERIFIED and do not claim convergence.
   Loop back to Step 2 for any new finding until findings converge — no new
   CRITICAL / MAJOR and the accessibility gate passes. **Bound the loop**: at most
   a few passes (default 2, hard cap 3); if findings still do not converge, stop
   and pause (route to `/designer:decide` / `/designer:investigate` / an owner
   decision) rather than iterating indefinitely.

If verification surfaces a new inconsistency or a new barrier, return to Step 2
and report it. Do NOT mark the refinement complete on an unreconciled artifact or
an unresolved re-critique.

### Step 4: Present the result

```
## Refinement Summary
- Applied: [N findings / 1 revision / etc.]
- Verified: [downstream elements reconcile; accessibility gate exposure
  unchanged; measurable success metrics intact; [to be validated] markers intact]
- Re-critique: [converged — no new CRITICAL/MAJOR, gate PASS] OR [new findings → looping]
- Deferred: [items not addressed and why]
```

If findings remain, that informs the Active Next-Action Proposal at completion —
typically `/designer:critique` again on the revised artifact (the re-critique
handoff) to confirm the change did not expose a new weakness.

---

## When invoked by command (`/designer:refine` Claude command or `$designer:refine` Codex skill mention)

Full refinement with Design Task Profile + peer ensemble verification + state-write.

### Step 1: Design Task Profile

Build the Design Task Profile per `../investigate/SKILL.md` § Design Task Profile
(Persona=designer; Surface / Users / Stage / Platform / Evidence-confidence
fields; Ensemble Affinity recorded but not gating — always-max policy). Refine is
single-mode, so there is no verb Skill-profile to record. The shared
`../_shared/references/orchestration.md` Dynamic Orchestration reference lands at
PR6.

### Step 2: Apply the revision

Follow Step 2 above, at command fidelity. When the change is non-trivial, apply
it element by element, confirming the accessibility acceptance criteria
explicitly — they carry the most load-bearing quality assumptions.

### Step 3: Privacy gate (before any external call)

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data visible
in screenshots, and secret-bearing frontend code pass an explicit privacy gate
before BOTH web search AND peer-host dispatch. Genericize the revision before the
peer prompt; the pre-genericization value MUST never leave the local host.
**Screenshots are sensitive by default** — a rendered screen is re-critiqued
same-host (Claude natively; Codex via `codex exec --image`) and is **never sent
to the peer as inline image bytes**; the peer path is code/text-based, or a
verified-local absolute file path the peer reads on its own host. When
confidentiality is unclear, ask the user, or run **local-only** (skip the peer).
See `../investigate/references/design-brief-spec.md` § Privacy Gate.

### Step 4: Peer ensemble parallel verification (Refine-verify point type)

Launch the peer ensemble (always-max policy; never ask the user, never direct
them to run companion CLIs manually) using the **Refine-verify** ensemble point
type. The peer receives the **genericized** before→after of the changed
elements — spec text and/or frontend code, or a verified-local screenshot path,
**never image bytes** — and independently verifies the revision resolves the
finding without introducing a new inconsistency or a new accessibility barrier.
Build the Refine-verify prompt, write it to a tempfile, and dispatch in the
background. The prompt template + synthesis contract land in
`../_shared/references/ensemble-protocol.md` § Refine-verify at PR6; the dispatch
shape mirrors the reference-scan dispatch in
`../investigate/references/design-brief-ensemble.md` (command-managed via
`scripts/peer-runner.mjs`). See `commands/refine.md` for the concrete dispatch
bash.

The peer's core contribution is the code/text perspective (semantic structure,
naming, pattern/token conformance, copy, funnel logic). By default it receives no
screenshot, so the vision-grounded re-critique of the re-rendered screen
(contrast as-rendered, visual hierarchy, spacing) is the same-host model's
responsibility **when the re-rendered screen is available** (designer does not run
the build — the user / frontend engineer supplies it; an unavailable or broken
re-render leaves the visual re-critique UNVERIFIED, not converged); no inline image
bytes ever reach the peer.

### Step 5: Synthesize + converge

After both sides return:

1. Re-check that the design reconciles (Step 3 of auto-activated mode), including
   the accessibility gate-exposure check.
2. Collect the peer verification.
3. Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT. Label discovery
   side (`[Local]` / `[Peer]` / `[Both]`) in workflow phase notes only — never in
   a saved artifact.
4. Resolve any new findings:
   - Straightforward → apply inline (return to Step 2).
   - 2+ viable remediation directions → route through `/designer:decide`.
   - A peer-flagged regression (a new inconsistency or a **new accessibility
     barrier**) → pause and report to the user before proceeding.

Loop Steps 2–5 until findings converge (no new CRITICAL / MAJOR and the
accessibility gate passes). This is the critique → refine → re-critique
convergence loop. **Bound it (no unbounded loop)**: run at most a few passes
(default 2, hard cap 3). If findings still do not converge — each pass exposes a
fresh CRITICAL / MAJOR, or the peer keeps flagging a regression — STOP: pause and
route to an owner decision (a 2+-direction remediation fork → `/designer:decide`;
a load-bearing unverified claim → `/designer:investigate`; otherwise present the
residual findings for the owner to weigh). A paused refine is left unresolved on
purpose — it is not marked complete.

### State write (when invoked from a workflow command)

When `/designer:refine` runs as a sub-step of a designer workflow command (the
`/designer:start` lifecycle macro lands at PR6), the invoking command writes the
applied revision (element, summary) and the verification result (design
reconciles, gate exposure unchanged, peer verdict, re-critique convergence) to
its workflow file. This skill itself does not write workflow state. When invoked
standalone, no workflow file write occurs.

---

## Completion — Active Next-Action Proposal

At the end of a successful refine (both paths), emit an **Active Next-Action
Proposal** instead of a fixed next verb — derived from this refinement, not a
fixed table:

```
- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — the design reconciles + the accessibility gate verdict; the decisive design axes (사용성 Usability + the archetype axis) for a fork>
- evidence_pointers:     <revised elements / criteria refs / artifact path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or $designer:<verb> for a verb>
```

Typical `selected_next` candidates for refine: `/designer:critique` to re-critique
the revised artifact (the convergence handoff — confirm the finding is resolved
and no new barrier opened) — or "the design is sound, proceed" when the change was
small and reconciles cleanly, or `/designer:investigate` when the refinement
exposed a load-bearing pattern/accessibility assumption that needs evidence. The
routing is a fallback only when evidence is genuinely neutral — do not end with a
hardcoded "next: X". A blocked outcome (peer flagged a regression / a new
accessibility barrier) pauses for user direction before any forward proposal.

**Incubating note (ADR-0042).** designer ships across the implementation ladder:
at PR5B `investigate` + `frame` + `decide` + `compose` + `critique` + `refine` are
installed — the six-verb cognitive set is complete. The `start` lifecycle macro +
the resume / checkpoint / peer-now meta skills land at PR6. If the proposal names
an unlanded surface (`start`), `next_command` is directional, not runnable — the
refinement summary is the durable handoff until the persona completes.

Always include the workflow path when invoked from a workflow command:

```
Workflow: <absolute path to workflow .md file>
```

(The inline Active Next-Action Proposal shape above is what designer ships; the
deeper runtime-completion-footer / ADR-0031 session-handoff seam integration that
the engineer plugin carries is not part of designer's surface — future work if
demand arrives.)

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If a refinement reaches a **genuine 2+-branch decision point** — two viable
remediation directions, or two ways to close the same gap — surface a **compact
multi-axis lens** across the decisive design axes (사용성 Usability + the archetype
axis) + the accessibility gate, reading `../decide/references/decision-axes.yml`
(the `scripts/decide-registry.mjs resolve --size=minor` resolver gives the compact
rendering of `balanced`; the registry file is readable even when the resolver CLI
is not). Bounded: only at a genuine 2+-branch point, never the full matrix for a
trivial reversible fix. A weightier fork routes to `/designer:decide` rather than
being settled inside the refine.

---

## Anti-patterns (do not produce)

- **Refining before the *why* is confirmed**. Apply the upstream contract:
  critique / investigate → decide (if needed) → refine. A fix without a confirmed
  finding papers over the symptom.
- **Choosing silently between remediation directions** when 2+ viable approaches
  exist. Route through `/designer:decide`.
- **Marking refinement complete on an unreconciled artifact or an unresolved
  re-critique**. If the revised flow no longer satisfies its states, or a
  re-critique surfaces a new CRITICAL / MAJOR, the refinement is not done — the
  convergence loop has not closed.
- **Clearing a usability/conversion problem by introducing an accessibility
  barrier**. That moves the veto gate, it does not clear it — surface the new
  candidate WCAG A/AA exposure, never bury it. An unmitigated barrier introduced
  by the revision is CRITICAL.
- **Upgrading an assumption to a fact**. A revision must not silently drop a
  `[to be validated]` marker to make the design look more certain.
- **Sending screenshots to the peer as bytes**. The Refine-verify peer path is
  code/text or a verified-local absolute path; `codex-companion` has no `--image`
  flag. Vision-grounded re-critique is same-host.
- **Leaking proprietary material** to the peer or to web search. Genericize the
  revision; screenshots are sensitive by default and never sent as bytes.
- **Certifying accessibility conformance** on the re-critique. The gate flags
  *candidate* WCAG A/AA issues; conformance needs runtime testing (focus order,
  keyboard, screen-reader) per ADR-0042 Non-Goal 6. Always state what remains
  unverified.
- **Claiming convergence on a code/text-only pass** when the post-code re-render
  could not be re-critiqued. An unavailable / broken re-render leaves the visual
  re-critique UNVERIFIED — report it, do not mark the refinement complete.
- **Looping indefinitely**. Bound the convergence loop (default 2 passes, hard cap
  3); persistent non-convergence pauses and routes to `/designer:decide` /
  `/designer:investigate` / an owner decision, it does not spin.
