---
name: compose
description: "Produces the design artifact — user flows, wireframe specs (structure + text, code-first not pixel mockups), CTA copy, information architecture, component specs — each annotated with accessibility + consistency acceptance criteria, from a confirmed UX frame and a chosen direction. The designer persona's composition verb (ADR-0010 §2, ADR-0042 SD2). Use after framing and deciding to draft the design a frontend engineer implements. Trigger phrases include 'draft the flow', 'wireframe this screen', 'write the CTA copy', 'spec this component', 'information architecture', 'design spec', 'lay out this page', '플로우 작성', '와이어프레임', 'CTA 카피', '컴포넌트 스펙', '정보구조', '설계 명세', '구체화해줘'."
---

# Compose (designer persona)

The designer plugin's composition verb (per ADR-0010 §2, ADR-0042 SD2).
Compose produces a **design artifact** — the spec a frontend engineer
implements — from a confirmed UX frame and a chosen direction. This is the
code-first design step: turning a decided direction into explicit,
reviewable flows / wireframe structure / CTA copy / IA / component specs.

| Profile | What it produces |
|---------|------------------|
| `spec` (default) | A **design spec** for the surface: information architecture, the primary user flow, wireframe structure (text-level layout + content blocks), key component specs, and CTA/microcopy — every element annotated with accessibility + consistency acceptance criteria. |
| `flow` | A **user-flow spec**: the task flow with entry points, decision branches, and the full state set per screen (default / loading / empty / error / success), plus the IA the flow traverses. |
| `wireframe` | A **wireframe spec**: per-screen low-fidelity layout described in text (regions, hierarchy, content blocks, primary/secondary actions, CTA copy) — code-first structure, NOT pixel mockups or generated imagery. |

The profile is set via `--profile=<name>` on `/designer:compose`, or
inferred from intent. Missing profile → `spec`. Unknown profile → `spec`
with a one-line warning. The L4 design archetype (general default; ui /
flow / cta / content) flows through the Design Task Profile per
`../investigate/SKILL.md` § Design Task Profile (the shared
`../_shared/references/orchestration.md` reference), not a
per-call flag.

**Code-first, not Figma (ADR-0042).** Compose produces *text/structure* a
frontend engineer implements directly in code — wireframe specs describe
layout and content in words, not pixels. When generated imagery is genuinely
needed (an illustrative hero, an icon set), compose does NOT draw it: it
hands a brief to the `image` L2 capability (`image:compose`) — designer never
re-implements image generation (the artifact-handoff contract lives in
`../_shared/references/orchestration.md` § image L2 composition boundary).

**Quality is annotated in, not deferred (ADR-0042 SD4).** "Excluding Figma
is not excluding quality" means every composed element carries explicit
**acceptance criteria** on the two design-quality axes that the later
`designer:critique` holds the rendered UI to:

- **Accessibility** — candidate WCAG A/AA checks for the element: semantic
  structure / landmark, keyboard operability, visible focus, contrast,
  non-color cues, target size, accessible name. (Candidate-level per
  ADR-0042 Non-Goal 6 — runtime testing certifies conformance.)
- **Consistency** — which design-system component / token / pattern the
  element reuses, and where it deliberately diverges (with the reason).

Pull the measurable UX success metrics straight from the frame so the spec
is held to them (a flow whose frame metric was "≥90% first-time checkout
completion, 0 WCAG A/AA blockers on the primary path" carries those as
acceptance criteria, not as aspirations).

**Core principle**: a spec precedes code. A design spec built on an
unconfirmed frame or an undecided fork is speculation. Compose consumes
upstream output — a confirmed UX problem model from `/designer:frame` and,
when 2+ directions existed, a chosen direction from `/designer:decide`.

**Honest-uncertainty principle**: a spec that marks its unvalidated
assumptions `[to be validated]` (e.g. "assumes users recognize the
hamburger affordance — validate with user-research") is more useful than
one that pretends certainty. Those markers become the user-research /
`designer:investigate` backlog.

---

## When auto-activated (without command)

Lightweight in-context composition — no subagent spawning, no peer ensemble
dispatch.

### Step 1: Profile selection

1. "draft the flow" / "user flow" / "states" → `flow`. "wireframe" /
   "lay out this screen" → `wireframe`. "design spec" / "component spec" /
   "IA" / anything integrated → `spec`.
2. If ambiguous, default to `spec`.

### Step 2: Verify upstream work

Compose consumes a confirmed UX frame from `/designer:frame` (or an
equivalent UX problem model) and a confirmed direction from
`/designer:decide` (when 2+ viable directions existed). If either is
missing, suggest running the upstream verb first rather than composing on
incomplete inputs — composing without a frame produces a generic screen
("a beautiful screen for a task the user never had"); composing through an
undecided fork locks in a pattern the user did not approve.

### Step 3: Produce the artifact

For `spec`, draft each section (IA → flow → wireframe structure → component
specs → CTA/microcopy); for `flow`, map the task flow with the full state
set per screen; for `wireframe`, describe each screen's layout structure and
content blocks in text. **Annotate every element with its accessibility +
consistency acceptance criteria** (the two-bullet block above). Mark every
unvalidated assumption `[to be validated]`. Pull the constraints and
measurable success metrics straight from the frame so the spec stays
consistent with what was framed and decided.

### Step 4: Present and confirm

Present the artifact and confirm before any downstream action. For a
non-trivial spec, present section by section and confirm the flow + the
accessibility acceptance criteria explicitly — they carry the most
load-bearing quality assumptions.

---

## When invoked by command (`/designer:compose` Claude command or `$designer:compose` Codex skill mention)

Full composition with Design Task Profile + peer ensemble + state-write.

### Step 1: Design Task Profile

Build the Design Task Profile per `../investigate/SKILL.md` § Design Task
Profile — Persona=designer, the Surface / Users / Stage / Platform /
Evidence-confidence fields, the verb's Skill-profile
(`spec` / `flow` / `wireframe`), and Ensemble Affinity (recorded, not
gating — always-max policy).

### Step 2: Compose

Produce the artifact per Step 3 above, at command fidelity, with the
accessibility + consistency acceptance criteria on every element.

### Privacy gate (before any external call)

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data
visible in screenshots, and secret-bearing frontend code pass an explicit
privacy gate before BOTH web search AND peer-host dispatch. Genericize
before the peer prompt; the pre-genericization value MUST never leave the
local host. **Screenshots are sensitive by default** and are never sent to
the peer as bytes (the peer path is code/text-based; vision critique is a
same-host `designer:critique` capability). See
`../investigate/references/design-brief-spec.md` § Privacy Gate.

### Step 3: Peer ensemble parallel analysis (Plan-verify point)

Launch the peer ensemble using the **Plan-verify** point type. The
Independence-Rule exception applies (per the engineer Plan-verify
precedent): the peer DOES receive the genericized draft spec as input — its
job is to find gaps in that specific spec (missing states — empty / error /
loading, unhandled edge cases, untested accessibility criteria,
design-system inconsistencies, responsive/RTL gaps, ambiguous CTA copy).
Genericize per the privacy gate before the peer prompt; the peer must never
see proprietary UI or customer data, and screenshots are never sent as
bytes. The peer call is automatic (always-max policy); skills do not pass
`--model` / `--effort`. (designer's `../_shared/references/ensemble-protocol.md`
§Plan-verify carries the prompt template + synthesis
contract; the dispatch shape mirrors the reference-scan dispatch in
`../investigate/references/design-brief-ensemble.md`.)

### Step 4: Synthesize

Incorporate valid gaps (missing states, edge cases). Add peer-surfaced
accessibility/consistency criteria the local pass missed. Note CONFLICT
items for user resolution.

### Step 5: Present

Present the synthesized artifact and confirm before downstream verbs.

### State write (when invoked from a workflow command)

When `/designer:compose` runs as a sub-step of a designer workflow command,
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
- rationale:             <why best — how the artifact honors the confirmed frame + chosen direction, plus its accessibility + consistency acceptance criteria>
- evidence_pointers:     <spec sections / flow states / brief path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or $designer:<verb> for a verb>
```

Typical `selected_next` candidates for compose: `/designer:critique` to
evaluate the spec (and, once built, the rendered screen) against the
accessibility + consistency + usability criteria — or `/designer:decide` if
composing surfaced an undecided fork, or `/designer:investigate` if a
load-bearing pattern assumption needs evidence before the spec is
trustworthy. The routing is a fallback only when evidence is genuinely
neutral — do not end with a hardcoded "next: X".

**Surface note (ADR-0042 Accepted).** The full designer surface ships: the
six cognitive verbs (`investigate` / `frame` / `decide` / `compose` /
`critique` / `refine`), the `/designer:start` lifecycle macro, and the
`resume` / `checkpoint` / `peer-now` meta skills. Every `next_command` this
proposal can name is runnable. The composed spec is the durable handoff.

Always include the workflow path when invoked from a workflow command:

```
Workflow: <absolute path to workflow .md file>
```

(When the invoking workflow command's terminal write runs — `state.mjs
set-terminal` — the runtime completion footer is **code-emitted** on that
command's stderr per ADR-0039/ADR-0043 S4; do not hand-compose a second
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

When composing reaches a **genuine 2+-branch decision point** — two viable
layout structures, two flow shapes, two component approaches — surface a
**compact multi-axis lens** comparing the branches across the decisive
design axes (사용성 Usability + the archetype axis) + the accessibility gate,
instead of a flat list, reading the resolved axes from
`../decide/references/decision-axes.yml` (the
`scripts/decide-registry.mjs resolve --size=minor` resolver gives the
compact rendering of `balanced`). Bounded: only at a genuine 2+-branch
point, never the full matrix for a trivial reversible step. A weightier fork
should route to `/designer:decide` rather than be settled inline.

---

## Anti-patterns (do not produce)

- **Composing without a confirmed frame**. A spec without a frame hides the
  assumption that the UX problem is obvious — the "beautiful screen, no real
  task" failure mode.
- **Composing through an undecided fork** ("I'll pick the pattern as I go").
  Forks belong to `/designer:decide`; composing through them locks in an
  unapproved pattern.
- **Deferring quality instead of annotating it**. Every element carries its
  accessibility + consistency acceptance criteria in the spec — "we'll check
  a11y later" is the failure mode SD4 exists to prevent.
- **Pixel mockups / generated imagery inline**. Wireframe specs are
  text/structure (code-first); generated imagery is an `image:compose`
  handoff, never drawn here.
- **Skipping the peer ensemble** in command mode. designer's policy is
  always-max — the peer exists to catch the missing state (empty / error)
  or the untested accessibility criterion.
- **Fabricated certainty on assumptions**. Mark unvalidated pattern/user
  assumptions `[to be validated]`; never present an assumed user behavior as
  evidenced.
- **Leaking proprietary material** to the peer or to web search. Genericize
  the spec and any customer/user data before any external call; screenshots
  are sensitive by default and never sent as bytes.
- **Certifying accessibility conformance**. The acceptance criteria flag
  *candidate* WCAG A/AA checks; conformance needs runtime testing (focus
  order, keyboard, screen-reader) per ADR-0042 Non-Goal 6.
