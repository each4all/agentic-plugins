# Designer Quality Criteria — the single internalized critique reference

This file is the **single internalized quality reference** for
`designer:critique` (ADR-0042 SD4). Every critique lens holds the design
artifact — a pre-code spec or a post-code rendered screen + frontend code — to
the standards recorded here, so every critique applies the **same** standard
rather than an ad-hoc, re-invented rubric each run.

Provenance of the four active-lens standards:

- **Usability** — Nielsen's 10 usability heuristics (Nielsen Norman Group).
- **Accessibility** — WCAG 2.1 / 2.2 Level A and AA success criteria, restricted
  to the subset a **static** screenshot + code critique can flag as *candidate*
  issues (see the honesty boundary below).
- **Conversion** — task-completion / call-to-action / funnel-friction principles.
- **Consistency** — design-system, platform-convention, and internal-pattern
  conformance rules.

> **accessibility HONESTY BOUNDARY (ADR-0042 Non-Goal 6).** The accessibility
> lens flags **candidate** WCAG A/AA issues from specs, code, and screenshots —
> contrast, visible focus styling, semantic structure, alt text, target size,
> use-of-color. It does **not** certify conformance: focus **order**, keyboard
> traversal, and screen-reader behavior require runtime interaction testing that
> a static critique cannot perform. A gate FAIL is a **candidate blocker** to
> resolve or explicitly accept-with-rationale, never a conformance certificate.

> **PROVISIONAL (잠정, ADR-0042 SD3).** The criteria weighting and the
> active/inactive lens split are a first-cut hypothesis, expected to be re-tuned
> as real designer dogfood (ADR-0042 PR7) accumulates. Treat these as a
> baseline, not a settled invariant.

**Single shared vocabulary (ADR-0042 SD4).** A critique lens name **is** an SD3
decision-axis id — `designer:decide` and `designer:critique` share ONE axis
vocabulary, no orphan lens. The axis *definitions* (question, role, gate) are
sourced once from `../../decide/references/decision-axes.yml`; this file holds
the *evaluation criteria* those lenses apply. The lone alias: the
`--profile=a11y` critique flag is sugar for the **`accessibility`** axis (there
is no `a11y` axis id), mirroring the decide profile-flag alias.

---

## Usability — Nielsen's 10 usability heuristics

The usability lens (`--profile=usability`, axis `usability` 사용성) evaluates the
flow / spec / screen against Nielsen's 10 heuristics. For each, critique
inspects the artifact and reports concrete findings with a failure signal.

<!-- @criteria:usability:begin -->
1. **Visibility of system status** — the design keeps the user informed through
   timely feedback. *Failure signal*: an action with no loading / success /
   progress state; a state change with no visible response.
2. **Match between system and the real world** — language, concepts, and order
   follow the user's world, not internal jargon. *Failure signal*: system- or
   developer-oriented labels; unfamiliar terms; unnatural ordering.
3. **User control and freedom** — clearly marked exits, undo, and redo; the user
   is never trapped. *Failure signal*: no back / cancel; destructive actions
   without undo or confirmation.
4. **Consistency and standards** — same words/actions mean the same thing;
   platform conventions are honored. *Failure signal*: one concept named two
   ways; a control that behaves unlike its platform norm. (Deep design-system /
   platform conformance is the **consistency** lens's domain.)
5. **Error prevention** — the design prevents problems before they occur.
   *Failure signal*: easy-to-hit destructive actions; no constraints / good
   defaults / confirmation on error-prone steps.
6. **Recognition rather than recall** — options, actions, and information are
   visible; the user need not remember across steps. *Failure signal*: relies on
   memory of a prior screen; hidden but needed options.
7. **Flexibility and efficiency of use** — accelerators and personalization serve
   experts without blocking novices. *Failure signal*: only one rigid path for a
   frequent task; no shortcuts for power users.
8. **Aesthetic and minimalist design** — no irrelevant or rarely-needed content
   competing with the essential. *Failure signal*: visual noise; competing
   primary actions; content that dilutes the key message. (Emotional appeal /
   brand polish is the **desirability** lens's domain.)
9. **Help users recognize, diagnose, and recover from errors** — errors are in
   plain language, state the problem, and suggest a fix. *Failure signal*: error
   codes with no explanation; a message that says what failed but not how to
   recover.
10. **Help and documentation** — help is available, findable, task-focused, and
    concise where the design cannot be fully self-evident. *Failure signal*: a
    complex feature with no inline guidance; help that is unsearchable or
    generic.
<!-- @criteria:usability:end -->

---

## Accessibility — WCAG 2.1 / 2.2 Level A and AA (candidate checks)

The accessibility lens (`--profile=a11y`, axis `accessibility` 접근성, the **veto
gate**) flags *candidate* WCAG A/AA barriers from what a static critique can
observe. An unmitigated hard barrier is a **VETO** — it is a CRITICAL finding
that overrides usability / conversion / desirability strength, never a tradeoff
folded into "polish later".

Statically checkable (from screenshot + code) — flag candidate PASS / CONDITIONAL / FAIL:

<!-- @criteria:accessibility:begin -->
- **1.1.1 Non-text content (A)** — images/icons/controls have appropriate text
  alternatives; decorative images are marked as such. *Signal*: `<img>` with no
  `alt`; icon-only control with no accessible name.
- **1.3.1 Info and relationships (A)** — structure conveyed visually is available
  in markup: semantic headings, lists, landmarks, programmatic labels.
  *Signal*: heading levels faked with font size; a form field with no associated
  `<label>`.
- **1.4.1 Use of color (A)** — color is not the *only* means of conveying
  information, indicating an action, or distinguishing an element. *Signal*: a
  required field or error shown by red text alone; a link distinguished from
  body text by color only.
- **1.4.3 Contrast (minimum) (AA)** — text/background contrast ≥ 4.5:1 (≥ 3:1 for
  large text ≥ 24px, or ≥ 18.66px bold). *Signal*: light-gray placeholder or
  low-contrast body text.
- **1.4.11 Non-text contrast (AA)** — UI-component boundaries, states, and
  meaningful graphics meet ≥ 3:1. *Signal*: an input border or focus indicator
  that barely differs from its background.
- **1.4.4 Resize text (AA) / 1.4.10 Reflow (AA)** — content is usable at 200%
  zoom / 320 CSS-px width without loss of content or two-dimensional scrolling.
  *Signal*: fixed-px containers that clip or overlap on zoom / narrow viewport.
- **2.4.7 Focus visible (AA)** — a visible focus indicator is present for
  keyboard focus. *Signal*: `outline: none` with no replacement focus style.
- **2.5.8 Target size (minimum) (AA, 2.2)** — pointer targets are ≥ 24×24 CSS px
  (or have adequate spacing). *Signal*: tightly packed icon buttons below 24px.
- **3.3.1 Error identification (A) / 3.3.2 Labels or instructions (A)** — inputs
  have persistent visible labels; errors are identified in text and describe how
  to fix. *Signal*: placeholder-only labels; an error state with no text.
- **4.1.2 Name, role, value (A)** — interactive elements expose an accessible
  name, role, and state (native semantics or correct ARIA). *Signal*: a `<div>`
  acting as a button with no `role`/`tabindex`/name.
<!-- @criteria:accessibility:end -->

**Candidate-only boundary (Non-Goal 6) — NOT certifiable from a static critique**,
flag as *needs runtime testing* rather than PASS:

- **2.1.1 Keyboard (A)** — every function operable by keyboard (needs interaction).
- **2.4.3 Focus order (A)** — focus order preserves meaning and operability
  (needs runtime traversal).
- **Screen-reader behavior** — actual announced name/role/state/reading order
  under a screen reader (needs AT testing).

A critique that "passes" accessibility statically must still state that focus
order, keyboard traversal, and screen-reader behavior remain **unverified** —
designer flags and prioritizes; it does not certify.

---

## Conversion — task-completion, CTA, and funnel-friction principles

The conversion lens (`--profile=conversion`, axis `conversion` 전환) evaluates
whether the design moves the user toward the intended action.

<!-- @criteria:conversion:begin -->
- **One clear primary action per view** — a single, visually dominant primary
  CTA; secondary actions are visibly subordinate. *Signal*: two equally-weighted
  primary buttons competing for the click.
- **Value legible at the decision point** — the benefit / what-happens-next is
  clear where the user decides, not buried above or after. *Signal*: a CTA with
  no supporting value proposition; cost/commitment revealed only after commit.
- **Low path friction** — the number of steps, required fields, and cognitive
  load on the conversion path is minimized to what is genuinely needed.
  *Signal*: asking for information not needed to complete the action; avoidable
  interstitials.
- **CTA copy is specific and honest** — the label states the outcome ("Create
  account", not "Submit"); it does not overpromise. *Signal*: vague or
  generic button copy; a label that misrepresents the result.
- **Honest persuasion — NO dark patterns** — no confirmshaming, forced
  continuity, hidden costs, misdirection, disguised ads, or preselected
  opt-ins. *Signal*: a decline option worded to shame; a pre-checked
  subscription; costs disclosed only at the final step. **A dark pattern is a
  finding, not a conversion win.**
- **Trust and risk reduction** — appropriate reassurance at the point of risk
  (security cues, reversibility, social proof where truthful). *Signal*: a
  high-commitment action with no reassurance and no clear reversal path.
<!-- @criteria:conversion:end -->

---

## Consistency — design-system, platform, and internal-pattern conformance

The consistency lens (`--profile=consistency`, axis `consistency` 일관성)
evaluates whether the design coheres with the established system rather than
introducing one-offs that fragment the experience.

<!-- @criteria:consistency:begin -->
- **Design-system component/token reuse** — uses existing components, tokens
  (color, spacing, type scale, radius), and variants rather than bespoke values.
  *Signal*: a hand-rolled button; an off-scale spacing or non-token color.
- **Platform-convention conformance** — honors the target platform's conventions
  (iOS HIG / Android Material / web norms) for navigation, controls, gestures,
  and system UI. *Signal*: an Android-style control on iOS; a non-standard
  navigation model with no justification.
- **Internal pattern consistency** — the same problem is solved the same way as
  elsewhere in the product (dialogs, empty states, forms, tables, filters).
  *Signal*: a second, divergent pattern for an already-solved interaction.
- **Terminology and iconography consistency** — the same concept uses the same
  word and the same icon throughout. *Signal*: "Delete" here, "Remove" there for
  the identical action; an icon reused for two meanings.
- **Interaction and state consistency** — hover / focus / active / disabled /
  loading / empty / error states are handled the way the system handles them
  elsewhere. *Signal*: a control missing a state its siblings all define.
<!-- @criteria:consistency:end -->

---

## Defined-but-inactive lenses (MVP)

To keep the 1:1 lens ⇒ SD3-axis coverage complete, the remaining three axes are
**named as lenses but inactive at the MVP** (ADR-0042 SD4 — they "complete the
1:1 axis coverage and activate incrementally"). Their axis definitions live in
`../../decide/references/decision-axes.yml`; their critique criteria are stubbed
here and mature in a later slice (ADR-0042 PR7 dogfood):

- **desirability** (매력도) — emotional appeal, polish, trust, and brand fit
  (distinct from usability's task-efficiency and aesthetic-minimalist heuristic).
- **content-clarity** (명확성) — labels, microcopy, information hierarchy, reading
  order, reading level, plain-language.
- **feasibility** (구현가능성) — build/maintenance cost within the frontend stack
  and component library; component reuse over new infrastructure.

Invoking `--profile=<one of these>` is accepted but reports that the lens is
defined-but-inactive at the MVP and falls back to the full active-lens set,
rather than emitting a half-specified rubric.

---

## Related

- `../SKILL.md` — the `designer:critique` skill body; each lens cites the
  matching section above by relative path.
- `../../decide/references/decision-axes.yml` — the SD3 axis registry: the single
  source of the shared axis *vocabulary* (id, labels, role, `gate`). This file
  is the evaluation-criteria companion, not a second axis definition.
- `docs/adr/0042-designer-persona-design-ux-workbench.md` — SD4 (the
  quality-assurance differentiator, the host-direct vision model, the privacy
  gate, candidate-only a11y) and Non-Goal 6 (no conformance certification).
