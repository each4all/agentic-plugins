---
name: critique
description: "Evaluates an existing design artifact — a pre-code design spec OR a post-code rendered screen + frontend code — across the design quality lenses (usability / accessibility / conversion / consistency), with accessibility as a veto gate, and reports severity-rated findings. The designer persona's critique verb (ADR-0010 §2, ADR-0042 SD4). Use for design review, UI/UX review, heuristic evaluation, a candidate accessibility spot-check, a conversion review, or a design-system consistency review — on a spec before code, or on the rendered screen after. Trigger phrases include 'review this screen', 'critique this UI', 'design review', 'is this accessible', 'a11y check', 'heuristic evaluation', 'does this match the design system', 'review the wireframe', 'check this flow', 'poke holes in this design', '디자인 리뷰', '이 화면 봐줘', 'UI 검토', '접근성 체크', '휴리스틱 평가', '디자인 시스템 일관성', '이 화면 괜찮아', '전환율 관점에서 봐줘'."
---

# Critique (designer persona)

The designer plugin's critique verb (per ADR-0010 §2, ADR-0042 SD4). Critique
evaluates an **existing** design artifact against the internalized quality
criteria and reports severity-rated findings. The user is the decision-maker;
this verb is the quality-evaluation engine — it maximizes the rigor and honesty
of the review, not the automation of the fix.

This is designer's **post-code quality-assurance** differentiator (ADR-0042
SD4). Critique operates on two input shapes — the **pre-code** design spec (from
`/designer:compose`) and the **post-code** rendered screen (a screenshot) plus
the frontend code that produced it — and holds both to the same standard: the
single internalized reference in `references/quality-criteria.md`. Fixes are the
`/designer:refine` verb's job (lands at PR5B); a genuine 2+-direction fork
routes to `/designer:decide`.

## The four quality lenses (ADR-0042 SD4)

The lenses reuse the SD3 decision-axis vocabulary — **a lens name IS an axis id**
(`../decide/references/decision-axes.yml`), so `decide` and `critique` share ONE
vocabulary with no orphan lens. decide uses the axes as decisive/supporting
*roles*; critique uses the same axes as evaluation *lenses*. Each lens applies
the criteria recorded in `references/quality-criteria.md`.

<!-- @critique:lens-table:begin -->
| # | Lens (`--profile=`) | SD3 axis | Gate? | Evaluates against (`references/quality-criteria.md`) |
|---|---------------------|----------|-------|------------------------------------------------------|
| 1 | `usability`    | 사용성 usability     | —        | Nielsen's 10 usability heuristics — § Usability |
| 2 | `a11y`         | 접근성 accessibility | **GATE** | WCAG 2.1/2.2 A/AA candidate checks — § Accessibility |
| 3 | `conversion`   | 전환 conversion      | —        | CTA clarity / value legibility / funnel friction / honest persuasion — § Conversion |
| 4 | `consistency`  | 일관성 consistency   | —        | Design-system + platform + internal-pattern conformance — § Consistency |
<!-- @critique:lens-table:end -->

The **`a11y` lens flag is an alias for the `accessibility` axis** — there is no
`a11y` axis id (mirrors the decide profile-flag alias). The remaining three SD3
axes — **desirability**, **content-clarity**, **feasibility** — are named as
lenses but **defined-but-inactive at the MVP** (they complete the 1:1 axis
coverage and activate incrementally; see `references/quality-criteria.md`
§ Defined-but-inactive lenses).

> **accessibility HONESTY BOUNDARY (ADR-0042 Non-Goal 6).** The accessibility
> lens flags **candidate** WCAG A/AA issues from specs, code, and screenshots —
> contrast, semantic structure, alt text, visible focus, target size, use of
> color. It does **not** certify conformance: focus **order**, keyboard
> traversal, and screen-reader behavior require runtime interaction testing a
> static critique cannot perform. A gate FAIL is a candidate blocker to resolve
> or explicitly accept-with-rationale, not a conformance certificate. designer
> flags and prioritizes; it does not issue a certificate.

> **PROVISIONAL (잠정, ADR-0042 SD3).** The active/inactive lens split and the
> criteria weighting are a first-cut hypothesis, expected to be re-tuned as real
> designer dogfood (ADR-0042 PR7) accumulates. Treat these as a baseline, not a
> settled invariant beyond the accessibility veto gate.

**Profile selection**: `--profile=<lens>` focuses the review on one lens; a
missing profile runs **all four active lenses** (the default full-surface
critique). An unknown profile, or one of the three defined-but-inactive lenses
(`desirability` / `content-clarity` / `feasibility`), falls back to the full
active set with a one-line warning rather than emitting a half-specified rubric.

**Core principle**: a critique names findings and their severity; it does not
silently rewrite the design. The accessibility gate is a **veto**, not a
tradeoff. A finding that opens two viable remediation directions is a
`/designer:decide` fork, not a critique verdict; applying the fixes is
`/designer:refine`.

**Gate severity rule**: an **unmitigated accessibility veto gate is a CRITICAL
finding by definition** — never demoted to a MINOR or folded into "polish
later". A CONDITIONAL gate is allowed only with the remediation named explicitly.
(The `gate: true` axis is `accessibility` in `../decide/references/decision-axes.yml`.)

---

## Dual input — pre-code spec AND post-code rendered screen (ADR-0042 SD4)

Critique accepts two artifact shapes; it may receive one or both:

1. **Pre-code design spec** — an IA / user-flow / wireframe / component spec /
   CTA copy (typically a `/designer:compose` artifact). Text-only; no vision
   needed. Critique checks each element against the criteria and the
   accessibility acceptance criteria that compose annotated in.
2. **Post-code rendered screen** — a **screenshot** of the built UI plus the
   **frontend code** that produced it. This is where vision applies.

**Vision is host-direct (ADR-0042 SD4 item 3).** On the **active host**, the
model reads the screenshot directly — Claude natively; Codex CLI via
`codex exec --image <file>` — so a screenshot critique run **on the active host
is cross-host symmetric**. Vision-grounded critique of a rendered screen is a
**same-host** capability. `Screenshots are sensitive by default` (see § Privacy
gate).

**The peer path is not host-direct.** `codex-companion.mjs` exposes no `--image`
flag, so **cross-host peer critique is code/text-based**: by default the peer
receives the genericized spec / frontend code and **does not receive the
screenshot at all**, so the authoritative vision-grounded judgment stays
same-host. The one ADR-named exception (the `plugins/image` critique-dispatch
precedent) passes a screenshot as a **verified-local absolute file path
prompt-mediated** — never inline image bytes — and only helps when the peer
shares this host's filesystem (same machine): the path is verified local first
(resolve the real path, confirm it is a regular image file on this host) and
embedded as untrusted text, so the peer may read the file on its own host.
**Either way no image bytes cross the companion bridge, and the vision-grounded
judgment is same-host.** designer's critique ensemble uses the code/text peer
path by default and treats the verified-local-path variant as an explicit
same-filesystem opt-in.

---

## When auto-activated (without command)

Lightweight in-context critique — no peer ensemble dispatch, no subagents.

### Step 1: Identify what to review

Determine the artifact shape (pre-code spec, post-code screen, or both) and the
surface + platform (web / iOS / Android / desktop; viewport; LTR/RTL). If a
screenshot is provided, note that vision applies (same-host). If only a
file/PR reference is given, read the frontend code.

### Step 2: Determine review lenses

Default: run all four active lenses (usability / accessibility / conversion /
consistency). If `--profile=<lens>` (prose equivalent) narrows the intent,
focus there — but the **accessibility gate is always evaluated** even under a
narrowed profile, because an unmitigated barrier is a veto regardless of the
requested focus.

### Step 3: Apply the criteria

For each active lens, evaluate the artifact against the matching section of
`references/quality-criteria.md` (§ Usability / § Accessibility / § Conversion /
§ Consistency). When a screenshot is present, read it directly (same-host
vision) and ground visual findings in what is observed, not guessed from the
filename. Separate observed facts from inference; label aesthetic claims with
the heuristic / criterion they rest on.

### Step 4: Synthesize

Merge findings, dedupe, and sort by severity **CRITICAL > MAJOR > MINOR >
SUGGESTION**. Compute the accessibility **gate verdict** (PASS / CONDITIONAL /
FAIL — candidate-level). An unmitigated gate FAIL is CRITICAL.

### Output format

```
## Review Summary
[1-2 sentences: overall read + the gate verdict headline]

## Gate verdict
접근성 Accessibility: [PASS / CONDITIONAL / FAIL] — [candidate barrier(s); "unverified: focus order / keyboard / screen-reader (runtime)"]

## Critical Issues
- [element / spec section / screen region] [lens] — [finding + the failure signal + criteria ref]

## Major Issues
- ...

## Minor Issues
- ...

## Suggestions
- ...

## Looks Strong
- [what holds up well, per lens]
```

Each finding line is `[element/region] [lens] — [description + failure signal]`.
Gate findings render a candidate PASS/CONDITIONAL/FAIL, never a conformance
certificate.

---

## When invoked by command (`/designer:critique` Claude command or `$designer:critique` Codex skill mention)

Full critique with Design Task Profile + peer ensemble + state-write integration.

### Step 1: Design Task Profile

Build the Design Task Profile per `../investigate/SKILL.md` § Design Task Profile
(Persona=designer; Surface / Users / Stage / Platform / Evidence-confidence
fields; Ensemble Affinity recorded but not gating — always-max policy). The
shared `../_shared/references/orchestration.md` Dynamic Orchestration reference
lands at PR6.

### Step 2: Collect the artifact context

Gather the artifact under review: the pre-code spec text and/or the post-code
screenshot + frontend code. For a screenshot, confirm it is a **local file on
this host** before any external step. Read the relevant frontend source (the
code that renders the screen) so accessibility / consistency findings are
grounded in markup, not only pixels.

### Step 3: Privacy gate (before any external call)

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data visible
in screenshots, and secret-bearing frontend code pass an explicit privacy gate
before BOTH web search AND peer-host dispatch. Genericize before any peer
prompt; the pre-genericization value MUST never leave the local host.
**Screenshots are sensitive by default** — a rendered screen is critiqued
same-host (Claude natively; Codex via `codex exec --image`) and is **never sent
to the peer as inline image bytes**; the peer path is code/text-based, or a
verified-local absolute file path the peer reads on its own host. When
confidentiality is unclear, ask the user, or run **local-only** (skip the peer
and any web reference lookup). See
`../investigate/references/design-brief-spec.md` § Privacy Gate.

### Step 4: Peer ensemble parallel analysis (Review point type)

Launch the peer ensemble (always-max policy; never ask the user, never direct
them to run companion CLIs manually). The peer receives the **genericized**
artifact — spec text and/or frontend code, or a verified-local screenshot path,
**never image bytes** — and returns an independent code/text critique across the
lenses. Build the Review prompt, write it to a tempfile, and dispatch in the
background. The prompt template + synthesis contract land in
`../_shared/references/ensemble-protocol.md` § Review at PR6; the dispatch shape
mirrors the reference-scan dispatch in
`../investigate/references/design-brief-ensemble.md` (command-managed via
`scripts/peer-runner.mjs`). See `commands/critique.md` for the concrete dispatch
bash.

The peer's core contribution is the code/text perspective (semantic structure,
naming, pattern/token conformance, copy, funnel logic). By default it receives no
screenshot, so the vision-grounded findings (contrast as-rendered, visual
hierarchy, spacing) are the same-host model's responsibility; no inline image
bytes ever reach the peer.

### Step 5: Synthesize

Reconcile local + peer findings per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT.
Label discovery side (`[Local]` / `[Peer]` / `[Both]`) in workflow phase notes
only — never in a saved artifact. Dedupe, then sort by severity. An unmitigated
accessibility gate FAIL is CRITICAL regardless of which side found it. Present
CONFLICT findings both ways and let the user weigh them.

### Step 6: Present

Emit the severity-grouped report (the Output format above), leading with the
gate verdict. State plainly what remains **unverified** (focus order, keyboard,
screen-reader — runtime).

### State write (when invoked from a workflow command)

When `/designer:critique` runs as a sub-step of a designer workflow command (the
`/designer:start` lifecycle macro lands at PR6), the invoking command writes the
critique findings + gate verdict to its workflow file. This skill itself does
not write workflow state. When invoked standalone, no workflow file write occurs.

---

## Completion — Active Next-Action Proposal

At the end of a successful critique (both paths), emit an **Active Next-Action
Proposal** instead of a fixed next verb — derived from the findings, not a fixed
table:

```
- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — the decisive findings + the accessibility gate verdict>
- evidence_pointers:     <finding sections / criteria refs / artifact path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or $designer:<verb> for a verb>
```

Typical `selected_next` candidates for critique: `/designer:refine` to address
the selected findings (CRITICAL + MAJOR by default; the user picks which MINOR /
SUGGESTION items to include) — or `/designer:decide` when a finding opens a
genuine 2+-direction fork, or `/designer:investigate` when a load-bearing
accessibility or convention claim needs authoritative evidence. When no CRITICAL
or MAJOR (and the gate passes), the design is in good shape — say so. The routing
is a fallback only when evidence is genuinely neutral — do not end with a
hardcoded "next: X".

**Incubating note (ADR-0042).** designer ships across the implementation ladder:
at PR5A `investigate` + `frame` + `decide` + `compose` + `critique` are
installed. `refine` lands at PR5B and the `start` lifecycle macro + meta skills
at PR6. If the proposal names an unlanded verb (`refine` / `start`),
`next_command` is directional, not runnable — the critique report is the durable
handoff until the persona completes.

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

If a critique surfaces a **genuine 2+-branch decision point** — two viable
remediation directions, or two defensible severity reads of the same finding —
surface a **compact multi-axis lens** across the decisive design axes (사용성
Usability + the archetype axis) + the accessibility gate, reading
`../decide/references/decision-axes.yml` (the
`scripts/decide-registry.mjs resolve --size=minor` resolver gives the compact
rendering of `balanced`). Bounded: only at a genuine 2+-branch point, never the
full matrix for a trivial reversible fix. A weightier fork routes to
`/designer:decide` rather than being settled inside the critique.

---

## Anti-patterns (do not produce)

- **Certifying accessibility conformance**. The gate flags *candidate* WCAG A/AA
  issues; it does not issue a certificate — focus order, keyboard traversal, and
  screen-reader behavior need runtime testing (ADR-0042 Non-Goal 6). Always state
  what remains unverified.
- **Demoting an unmitigated accessibility barrier**. A hard candidate WCAG A/AA
  barrier is CRITICAL and a veto — never a MINOR, never "polish later".
- **Guessing from the filename**. A screenshot critique reads the image
  (same-host vision); it does not infer the UI from the file name or the code
  alone when the pixels are available.
- **Sending screenshots to the peer as bytes**. The peer path is code/text or a
  verified-local absolute path; `codex-companion` has no `--image` flag. Vision
  is same-host.
- **Leaking proprietary material** to the peer or to web search. Genericize the
  artifact; screenshots are sensitive by default and never sent as bytes.
- **Fixing inside the critique**. Critique names findings and severity; applying
  them is `/designer:refine`. A 2+-direction remediation fork is `/designer:decide`.
- **Aesthetic claims without grounding** ("looks cleaner", "more modern") — every
  finding rests on a heuristic, WCAG criterion, conversion principle, or
  consistency rule in `references/quality-criteria.md`.
