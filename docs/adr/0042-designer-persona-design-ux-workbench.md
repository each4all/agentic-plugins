# ADR-0042: `designer` persona (L3) — code-first design/UX decision & quality workbench

## Status

Proposed

<!--
Long-roadmap pattern (precedent: ADR-0027/0028/0029/0036): this ADR is
merged `Proposed` ahead of the implementation ladder, then flipped to
`Accepted` in the roadmap's dogfood PR once `plugins/designer` has driven
a real design/UX deliverable end-to-end. Until that flip, the axis
schema (SD3) and quality-assurance lenses (SD4) are PROVISIONAL, subject
to re-tuning from dogfood the same way ADR-0036 SD3 marked founder's
business axes provisional.
-->

## Context

### A third persona — the design/UX discipline

`designer` has been a **reserved-but-deferred** third L3 persona since
the beginning of the project. ADR-0007 §Stage 3 named a "design-domain
plugin" as remaining workflow work; ADR-0010 §1 lists `designer
(Stage 3)` in the L3 row alongside `engineer` and `founder`, §7 fixes
the L3 naming axis as `engineer / designer`, and §2 already uses
`/designer:compose` and `/designer:critique` as the canonical usage
examples. ADR-0036 (founder) explicitly kept `designer` "a future L3
candidate — preserved, not replaced."

The reason `designer` never shipped is **not** a §6-trigger failure — it
is the project's demand-triggered discipline (ADR-0037 §Context): a
persona is built when real demand arrives, not pre-built to fill a slot.
That demand has now arrived: an owner developing a real service needs to
carry frontend work, user-flow planning, and design from an idea to
shipped code, and wants agentic-plugins to cover the design/UX portion
at quality.

### Motivating scenario — code-first delivery, agent-assured design quality

The concrete demand that triggers this ADR (recorded verbatim as the
scope-fixing input):

> A service is under development. Frontend work, user-flow planning, and
> design remain. The delivery is **code-first** — flows and specs feed
> directly into frontend code; there is deliberately no Figma /
> visual-mockup step. Excluding Figma is **not** excluding design
> quality — the owner wants UI/UX quality maximally assured *with the
> agent*.

This scenario is load-bearing for scope. It says the deliverable is
**not** "produce pixel-accurate mockups" but "systematically assure the
quality of the UI/UX that materializes as code." The design artifact of
record in a code-first flow is the running frontend itself; what the
persona must add is (a) the pre-code thinking that shapes it (flows,
IA, CTA, decision) and (b) the post-code quality critique that holds it
to a standard — the judgment a human would otherwise perform by eye in a
design tool, made explicit, reproducible, and multi-perspective.

### Scope boundary — a thinking/decision workbench, not a visual-production tool

`designer` is scoped as a **design/UX decision and quality workbench**:
the six canonical cognitive verbs applied to UX/UI/CTA/flow, weighted
toward structural and textual artifacts (user flows, wireframe specs,
CTA copy, information architecture, heuristic critiques) and toward
**decision support and quality assurance**. Actual visual production
(rendered imagery) is delegated to the already-shipped `image` L2
capability (ADR-0037), never re-implemented here.

This boundary is a direct response to the cautionary tale that produced
the whole 4-layer policy: the predecessor `omcc-designer` plugin
accumulated 25+ skills (poster, social-graphics, frontend, brief,
evaluation, extraction, …), and ADR-0010 §Context introduced the
six-verb discipline **specifically to prevent that sprawl**. `designer`
compresses the discipline into the six verbs (ADR-0010 §2 already maps
`omcc-designer poster/social/frontend output → Compose` and
`omcc-designer/design-evaluation → Critique`), and pushes visual
generation out to `image` rather than re-absorbing it.

### Forces

1. **§6 Trigger 3 — mental-model discontinuity.** "Designing" and
   "engineering" are different hats in the user's own vocabulary;
   installing one must not require the other. This is the same
   justification founder claimed (ADR-0036, Trigger 3 only); Triggers 1
   and 2 are **not** claimed. The demand signal — the motivating
   scenario above — is the real gate that had been missing.
2. **Cross-host symmetry.** designer's substrate is text, code, and
   host-native vision (screenshots) — all available on both Claude Code
   and Codex CLI — so the persona is native+canonical on both hosts, the
   same standard engineer/founder meet. The one asymmetry (an optional
   external design tool) is excluded from v1 precisely to avoid a
   host-specific dependency (see SD5).
3. **Copy-not-import (ADR-0029).** A second/third/fourth persona must
   copy-and-trim engineer's workflow machinery, never import across
   plugin boundaries (ADR-0010 §5). founder set the precedent as the
   third copy; designer is the fourth.
4. **Six-verb discipline (ADR-0010 §2).** The persona ships exactly the
   six canonical verbs plus the lifecycle macro and the meta skills — no
   discipline-specific verb sprawl.

## Decision

Add **`plugins/designer`** as a Layer-3 persona plugin: a code-first
design/UX decision and quality workbench composed of the six canonical
cognitive verbs, following ADR-0036 (founder) as its structural
precedent and ADR-0029 (copy-not-import) for its machinery.

### Sub-decision 1 — Persona: `designer`

The L3 name is **`designer`**, keeping the `engineer / founder /
designer` persona axis (ADR-0010 §7). Command surface is
`/designer:<verb>` (Claude) and `$designer:<verb>` (Codex). Profile and
topic flow as arguments (ADR-0010). Plugin-name-level marketplace
aliases are a non-goal (ADR-0011 §9); verb-level sugar aliases within
the plugin are permitted (ADR-0010 §3).

### Sub-decision 2 — Requirement→verb mapping (pre-code + post-code)

The six verbs carry the design/UX discipline, and — unlike a
pre-code-only design tool — the mapping spans **both** the pre-code
design phase and the **post-code quality phase**:

| Verb | designer role | Primary artifact |
|---|---|---|
| **investigate** | Scan references, competitor UX, design systems, heuristic standards; read existing frontend code | cited design brief |
| **frame** | Structure the UX problem — users, JTBD, goals, **measurable success metrics**, constraints, risks | problem model |
| **decide** | Compare and choose a direction (pattern, layout, CTA strategy, flow branch) under the design decision axes | decision matrix |
| **compose** | Produce user flows, wireframe specs (structure/text), CTA copy, IA, component specs | structural/textual artifacts |
| **critique** | Evaluate against design-quality lenses — **pre-code** specs AND **post-code** rendered screens (vision) + frontend code | critique report |
| **refine** | Apply critique/feedback; iterate to convergence | revised artifact |

The `critique` verb is deliberately dual-input: it evaluates pre-code
specs *and* post-code reality (a rendered screenshot via host-native
vision, plus the frontend code itself). This is the mechanism that makes
"agent-assured quality without a design tool" concrete (SD4).

### Sub-decision 3 — Design decision axes (PROVISIONAL)

`designer:decide` carries a decision-axis registry on the ADR-0027 §1.1
portable schema, copied-not-imported per ADR-0029 (designer ships its
own axis set, not engineer's software-quality axes or founder's business
axes). The insight fixing the schema: **unlike engineer's nine
context-invariant software-quality axes, the decisive axis of a design
decision shifts with context** — a landing-page CTA is won on
conversion, an onboarding flow on usability, a dashboard on clarity. A
fixed two-axis pair would be wrong; the right shape is **a shared axis
pool with context-selected decisive lenses**, exactly the preset
mechanism engineer (`--size`) and founder (`decision-axes.yml`) already
use.

Seven-axis pool. **usability is the common decisive** (the second
decisive axis is the context lens), and **accessibility is the common
veto gate** across every preset. The four presets map 1:1 onto the L4
profiles of SD6:

| Axis | `balanced` (general/flow) | `conversion` (cta) | `experience` (ui) | `clarity` (content) |
|---|---|---|---|---|
| usability 사용성 | **decisive** | **decisive** | **decisive** | **decisive** |
| consistency 일관성 | **decisive** | supporting | supporting | supporting |
| conversion 전환 | supporting | **decisive** | supporting | supporting |
| desirability 매력도 | supporting | supporting | **decisive** | supporting |
| content-clarity 명확성 | supporting | supporting | supporting | **decisive** |
| feasibility 구현가능성 | supporting | supporting | supporting | supporting |
| accessibility 접근성 | gate | gate | gate | gate |

- Each preset has **usability + one context axis** as its two decisive
  axes (≥2-decisive floor, ADR-0027 §1.3, enforced by
  `decide-registry.mjs validatePreset`).
- **Accessibility is encoded as `role: supporting` + `gate: true`, not a
  `gate` role.** The ADR-0027 role enum is `decisive | supporting` ONLY
  ([ADR-0027](0027-decide-skill-multi-axis-evolution.md)); `gate` is a
  persona-local additive field the copied reader already accepts —
  exactly how founder encodes its regulatory/safety veto
  (`plugins/founder/skills/decide/references/decision-axes.yml`:
  `role: supporting` + `gate: true`). A hard accessibility fail (WCAG
  A/AA) is checked FIRST and vetoes decisive strength; design that
  excludes users is not a tradeoff to fold into the plan. The `gate`
  column above is shorthand for this supporting+gate:true encoding, not
  a new role value — the schema stays forward-compatible with the
  portable reader.
- **MVP ships the `balanced` preset only**; `conversion` / `experience`
  / `clarity` are defined in the registry but activated incrementally
  (founder shipped `general` only). A shape test asserts every L4
  profile in SD6 resolves to a defined preset.

The axis set and roles are **PROVISIONAL** (ADR-0036 SD3 precedent):
a first-cut hypothesis, re-tuned from real designer dogfood beyond the
≥2-decisive floor.

### Sub-decision 4 — Quality-assurance strategy (the differentiator)

This is designer's answer to the motivating scenario's core requirement.
"Excluding Figma is not excluding quality": the human's implicit
by-eye quality judgment is replaced by an **explicit, reproducible,
multi-perspective critique loop** that reaches all the way to the
code-materialized UI.

1. **Quality embedded at the design stage (pre-code).** `frame` fixes
   measurable UX success metrics and constraints; `decide` selects
   direction under the accessibility veto + decisive lens (quality is
   built into the decision, not bolted on); `compose` annotates
   flows/wireframes with the accessibility/consistency criteria.

2. **Post-code quality critique loop (the core mechanism).** After the
   engineer persona renders the frontend, `designer:critique` evaluates
   the **rendered screenshot + the frontend code** under design-quality
   lenses, run in parallel the way `engineer:critique
   --profile=parallel-review` runs. Each lens name IS an SD3 axis id
   (lens ⇒ the axis it evaluates), so decide and critique share ONE axis
   vocabulary — no orphan lens:

   | `designer:critique --profile=` | SD3 axis evaluated | Criteria source | Input |
   |---|---|---|---|
   | `usability` | usability 사용성 | Nielsen's 10 heuristics | screenshot |
   | `a11y` | accessibility 접근성 (gate) | WCAG A/AA (see limits below) | screenshot + code |
   | `conversion` | conversion 전환 | CTA/hierarchy/funnel-friction | screenshot + copy |
   | `consistency` | consistency 일관성 | design-system/pattern conformance | screenshot + code |

   MVP ships these four lenses; `desirability` / `content-clarity` /
   `feasibility` lenses complete the 1:1 axis coverage and activate
   incrementally. This is what "decide and critique share the seven-axis
   pool" means concretely — decide uses the axes as decisive/supporting
   roles, critique uses the same axes as evaluation lenses.

3. **Vision input is host-direct, not companion-mediated.** Both hosts
   accept image input directly (Claude natively; Codex CLI via `codex
   exec --image <file>`), so a screenshot critique run **on the active
   host** is cross-host symmetric. The **peer path is not**:
   `codex-companion.mjs` exposes no `--image` flag, so **cross-host peer
   critique is code/text-based**, or passes screenshots as
   verified-local absolute file paths prompt-mediated (the
   `plugins/image` critique-dispatch precedent), never as inline image
   bytes. Honest scope: vision-grounded critique is a same-host
   capability; the peer adds a code/text perspective.

4. **Privacy gate before any external send.** Screenshots and frontend
   code can carry proprietary UI, customer data, or secrets. Before any
   web/reference search OR cross-host peer dispatch, `critique` (and
   `investigate`) pass an explicit **privacy gate** with
   redaction/genericization rules and a **local-only mode** for
   sensitive material — the founder investigate privacy-gate precedent
   (ADR-0036 SD4). Vision screenshots are treated as sensitive by
   default.

5. **Convergence loop.** critique → refine → re-critique until findings
   converge (engineer Phase 5–6 pattern, copied).

6. **Complementary to engineer, not overlapping.** designer critiques
   the *design/UX* dimension; engineer critiques *code correctness*. The
   two compose without duplication.

**Accessibility-critique limits (honest scope).** A static screenshot +
code critique surfaces *candidate* WCAG A/AA issues (contrast, visible
focus styling, semantic structure, alt text) but **cannot certify
conformance** — focus order, keyboard traversal, and screen-reader
behavior require runtime interaction testing. designer flags and
prioritizes; it does not issue a conformance certificate (Non-Goal 6).

The quality criteria (Nielsen heuristics, WCAG checkpoints, conversion
principles, consistency rules) live as a single internalized reference
inside the plugin so every critique applies the same standard.

### Sub-decision 5 — image L2 boundary + Figma exclusion

- **image L2 is composed, never re-implemented.** When a deliverable
  needs actual generated imagery (concept visuals, hero images,
  moodboards, illustration), `designer` composes `image:compose`
  (ADR-0037 §Consequences: "`designer`, whenever demand arrives,
  composes this capability instead of re-implementing image
  generation"). `image` (gpt-image) is strong at concept/illustration
  and unsuited to pixel-accurate UI mockups — which the code-first scope
  does not need.
- **Figma / external design tools are excluded in v1.** Three forces
  converge: (a) no real demand — the owner is code-first and does not
  use Figma; (b) a design-tool integration is not cross-host-validated —
  **both** hosts have MCP support, so this is a scope/demand exclusion,
  not a claim that MCP is Claude-only; (c) role overlap with the `image`
  capability. Existing designs enter designer via **host-direct vision on
  user-supplied screenshots** (same-host, per SD4 item 3) and **reading
  frontend code** — no external-tool dependency. A future design-tool
  integration is a separate ADR gated on real demand (a preserved seam,
  not a v1 feature).
- **ADR-0010 §1 L4 correction.** The L4 row currently lists
  `designer:{ui, print, brand, frontend, image, motion, ...}`, which
  predates ADR-0037 extracting `image` to L2. This ADR amends that entry
  (see Consequences): designer's imagery concern is satisfied by
  composing the `image` L2 plugin, so `image` is dropped from designer's
  L4 profile list.

### Sub-decision 6 — Persona surfaces

- **Design Task Profile** (analogous to founder's Business Task Profile)
  in `skills/_shared/references/orchestration.md`, carrying persona =
  designer, the skill-profile (verb execution mode), and the L4 Profile
  axis.
- **L4 profiles**: MVP ships `general` only (founder precedent). The
  demand-facing archetypes are `ui` / `flow` / `cta` / `content`, each
  resolving to a decision preset defined in SD3: `general`⇒balanced,
  `flow`⇒balanced (flow decisions turn on usability+consistency),
  `ui`⇒experience, `cta`⇒conversion, `content`⇒clarity. Every profile
  resolves to a defined preset (shape-tested, SD3). `print` / `brand` /
  `motion` are visual-production disciplines and are **not** introduced
  (Non-Goal).
- **Triggers**: bilingual English/Korean trigger phrases per skill
  (e.g. "review this UI", "user flow", "heuristic evaluation", "CTA",
  "접근성", "유저플로우", "UX 검토", "와이어프레임").
- **Ensembles**: design-anchored ensemble points (the founder
  `ensemble-protocol.md` template, re-anchored to design critique /
  reference-scan).

### Sub-decision 7 — Workflow machinery: fourth copy-and-trim

designer copies-and-trims engineer's (equivalently founder's) workflow
machinery per ADR-0029, never importing it. The scripts (`state.mjs`,
`dispatch-peer.mjs`, `peer-runner.mjs`, `session-handoff.mjs`,
`stop-archive.mjs`, `validate-commit.mjs`, `discover-runtime.mjs`,
`decide-registry.mjs` + `lib/`) are rebranded: `STATE_DIR_REL =
'.agentic-plugins/state/designer'`, `plugin: 'designer'`, canonical-home
storage, self-sensor source `peer-runner-designer`, and a
`[designer-active-metadata]` re-injection marker.

Like founder (ADR-0036 SD7 / Non-Goal 3), designer **omits**
`parent-writeback.mjs` and `phase7-commit.mjs`-style dispatch linkage: it
is not an orchestrator dispatch target (Non-Goals). The Claude/Codex hook
adapters mirror founder's (SessionStart / PreCompact / Stop).

### Non-Goals

1. **Figma / external design-tool integration** — deferred to a
   demand-gated future ADR (SD5).
2. **orchestrator→designer automatic dispatch** — designer is
   **non-dispatch** in v1 (founder precedent). A multi-deliverable
   program that spans design + frontend runs designer and engineer as
   sequential workflows with **artifact handoff** (designer's flow/spec
   documents feed `engineer:start` / `orchestrator:plan`), not a single
   auto-orchestrated macro. Auto-dispatch is a future ADR-0019 cascade
   if demand arrives.
3. **Pixel-accurate UI mockup generation** — unnecessary under the
   code-first scope; the running frontend is the design artifact of
   record.
4. **`decision` L2 extraction** — designer's axes are evaluated on their
   own merits; a shared `decision` L2 is gated on §6 Trigger 1 (a second
   registry consumer) per ADR-0027/ADR-0036, independent of this ADR.
5. **`print` / `brand` / `motion` L4 profiles** — visual-production
   disciplines outside the decision/quality scope.
6. **Formal accessibility (WCAG) conformance certification** — designer
   surfaces and prioritizes *candidate* a11y issues from static
   screenshot+code critique, but conformance requires runtime
   keyboard / focus-order / screen-reader testing (SD4 limits). designer
   flags; it does not issue a certificate.

## Consequences

**Positive**
- Code-first UI/UX quality becomes a systematic, reproducible,
  multi-perspective agent loop (SD4) rather than implicit by-eye review —
  the motivating scenario is met with no additional development beyond
  this persona.
- designer and engineer compose cleanly: design/UX quality critique +
  code correctness critique, complementary and non-overlapping.
- The L3 axis gains its long-reserved third occupant, keeping
  `engineer / founder / designer` consistent (ADR-0010 §7).
- Existing `image` L2 and future `decision` L2 remain independently
  evaluated; designer composes rather than absorbs.

**Negative**
- A **fourth** copy of the workflow machinery (ADR-0029) adds
  maintenance surface; a machinery change now propagates to four
  personas. Accepted as the standing cost of copy-not-import, already
  paid at founder.
- The decision axes (SD3) and quality lenses (SD4) are PROVISIONAL and
  will need dogfood re-tuning before the Accepted flip.
- runtime **inventory + hook-readiness** awareness (doctor/settings
  `PLUGIN_NAMES`) must be extended in a **separate** `plugins/runtime` PR
  (ADR-0016 cross-package split), so designer is briefly invisible to
  runtime diagnostics until that RT track lands. Following founder,
  runtime's `workflow_kind` projection is **not** extended for designer
  (runtime models only `engineer`/`orchestrator`; founder/designer are
  unsupported kinds by design) — extending workflow-projection semantics
  would be a separate runtime-enablement ADR, not this RT track.

**Neutral**
- `image` shipping before `designer` (ADR-0037) already inverted
  ADR-0010 §6's illustrative "after design ships" ordering; this ADR
  confirms the composition direction rather than the sequence.
- designer's non-dispatch stance (Non-Goal 2) matches founder, so the
  orchestrator dispatch contract (ADR-0019) is unchanged.

## Alternatives Considered

1. **Full design scope including visual production** (designer drives UI
   mockups/imagery via image L2 + Figma). Rejected: the owner is
   code-first and does not want a mockup step; this re-inflates toward
   the omcc-designer sprawl and binds a Claude-only tool, for no demand.
2. **Figma as a core bidirectional dependency** (design-to-code /
   code-to-design). Rejected: no demand, severe cross-host asymmetry,
   role overlap with image L2. Preserved as a demand-gated future seam
   (SD5).
3. **Fixed two-axis decision schema** (e.g. usability + conversion,
   always). Rejected: the decisive axis of a design decision is
   context-dependent; a fixed pair is wrong for the other contexts. The
   axis-pool + context-lens preset (SD3) subsumes all candidate pairs.
4. **Fold design into `engineer:compose` as a profile** (no new
   plugin). Rejected: "designing" vs "engineering" is a mental-model
   discontinuity in the user's vocabulary (§6 Trigger 3); the post-code
   quality lenses and the design-specific decision axes do not belong in
   the engineer persona's install intent.
5. **Fold designer's imagery into a `designer:image` L4 profile**
   (pre-ADR-0037 shape). Rejected: ADR-0037 already extracted image to a
   reusable L2 capability; re-absorbing it under designer would
   under-serve non-design image demand and duplicate the capability.

## Implementation Roadmap

Indicative ladder, following the founder (ADR-0036) precedent. Actual
subtask decomposition is produced and Plan-verified by
`/orchestrator:plan` at implementation time; this section is directional,
not binding.

- **PR1 — atomic scaffold**: `plugins/designer/` manifests
  (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`), both
  marketplace catalog entries, `release-please-config.json` package key +
  `.release-please-manifest.json` entry (seed `0.1.0`), CHANGELOG/README,
  `tests/plugin-shape/test-designer-plugin.mjs` + the explicit
  `package.json` `test:plugin-shape` wiring, and the AGENTS.md package
  list. Atomic because `validate-marketplace` requires catalog entries to
  resolve to a real plugin directory. The **ADR-0010 §1 L4 correction
  (SD5) is deferred to PR7** — founder deferred its ADR-0010 cascade to
  the Accepted flip so ADR-0010 never cites a still-`Proposed` decision
  (ADR-0036 SD1).
- **PR2 — machinery**: copy-trim workflow scripts + hooks/adapters (SD7)
  + shape/unit tests. Dominant cost (founder PR2 shape).
- **PR3 — investigate + frame**: design brief (+ SD4 privacy gate) and
  the UX problem model.
- **PR4 — decide + compose**: design axis registry + resolver (SD3);
  flow / wireframe / CTA / IA composition.
- **PR5 — critique + refine**: quality lenses (SD4) + convergence loop +
  ensemble templates.
- **PR6 — start macro + 3 meta skills**: checkpoint / resume / peer-now.
- **PR7 — real-topic dogfood + Accepted flip**: drive a real design/UX
  deliverable end-to-end, flip Status → Accepted, and land the deferred
  ADR-0010 §1 L4 correction + doc cascade.
- **RT track — runtime inventory + hook readiness** (separate
  `plugins/runtime` PR per ADR-0016): add `designer` to doctor/settings
  `PLUGIN_NAMES` and Codex hook-readiness inventory **only**. Does **not**
  extend the `workflow_kind` projection enum (Consequences).

`/orchestrator:plan` produces and Plan-verifies this PR2–PR7
decomposition at implementation time; the ladder above is the expected
shape, matching how founder actually shipped (ADR-0036 §Implementation
Roadmap). Every PR gated by the standard CI surface (`npm test`,
`lint:plugin-shape`, `validate:marketplace`, `validate:versions`,
`validate:artifacts`).

## References

- [ADR-0007](0007-migration-cutover-plan.md) §Stage 3 — design-domain
  plugin origin, omcc-designer redesign stance
- [ADR-0010](0010-plugin-boundary-policy.md) §1/§2/§6/§7 — 4-layer
  model, six-verb sufficiency (omcc-designer skills mapped), separation
  triggers, persona naming axis; §1 L4 correction (SD5)
- [ADR-0027](0027-decide-skill-multi-axis-evolution.md) — portable
  decide-registry schema, preset precedence, ≥2-decisive invariant
- [ADR-0029](0029-entry-routing-contract-enforcement.md) — copy-not-import
  for second/third/fourth persona machinery
- [ADR-0036](0036-founder-persona-business-planning.md) — structural
  precedent (second L3 persona, decision axes, copy-and-trim, roadmap,
  Accepted-flip pattern)
- [ADR-0037](0037-image-capability-plugin.md) — image L2 boundary
  (designer composes, does not re-implement)
- [ADR-0016](0016-cross-package-commit-splitting.md) — RT-track
  separation rationale
- Nielsen's 10 usability heuristics; WCAG 2.x A/AA — the internalized
  quality-criteria source (SD4)
