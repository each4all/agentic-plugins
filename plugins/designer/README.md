# designer — code-first design/UX decision & quality workbench (L3 persona)

It ships the **complete** persona surface: the six universal cognitive verbs
(investigate / frame / decide / compose / critique / refine) re-anchored to
design/UX, the 7-axis design decision registry, a design-anchored peer
ensemble, the `designer:start` lifecycle macro, the
resume / checkpoint / peer-now meta skills, and the L4 design profiles
(`general` / `flow` / `ui` / `cta` / `content`). Per
[ADR-0042](../../docs/adr/0042-designer-persona-design-ux-workbench.md) the
persona is **Accepted** (real-topic dogfood validated it end-to-end).
Installed hooks no-op cleanly when no designer workflow exists.

`designer` is the third L3 persona plugin of agentic-plugins (after
`engineer` and `founder`), targeting **code-first design/UX** — the
design and user-experience discipline applied to a delivery where flows
and specs feed directly into frontend code, with **no Figma / visual-mockup
step**. Excluding Figma is *not* excluding design quality: designer replaces
the human's implicit by-eye judgment with an explicit, reproducible,
multi-perspective critique loop that reaches all the way to the
code-materialized UI.

`designer` is scoped as a **design/UX decision and quality workbench**,
not a visual-production tool — the six cognitive verbs weighted toward
structural and textual artifacts (user flows, wireframe specs, CTA copy,
information architecture, heuristic critiques) and toward decision support
and quality assurance. Actual generated imagery is delegated to the
already-shipped [`image`](../image) L2 capability (ADR-0037), never
re-implemented here.

## Surface (per ADR-0042 §Sub-decision 2)

The six verbs span **both** the pre-code design phase and the **post-code
quality phase**:

| Verb | designer role | Primary artifact |
|---|---|---|
| `investigate` | Scan references, competitor UX, design systems, heuristic standards; read existing frontend code | cited design brief |
| `frame` | Structure the UX problem — users, JTBD, goals, measurable success metrics, constraints, risks | problem model |
| `decide` | Compare and choose a direction (pattern, layout, CTA, flow) under the design decision axes | decision matrix |
| `compose` | Produce user flows, wireframe specs, CTA copy, IA, component specs | structural/textual artifacts |
| `critique` | Evaluate pre-code specs AND post-code rendered screens (vision) + frontend code under design-quality lenses | critique report |
| `refine` | Apply critique/feedback; iterate to convergence | revised artifact |

The `critique` verb is deliberately dual-input — it evaluates pre-code
specs *and* post-code reality (a rendered screenshot via host-native
vision, plus the frontend code itself). This is the mechanism that makes
"agent-assured quality without a design tool" concrete (ADR-0042 SD4).

## Runtime integration

`runtime:doctor` and `runtime:settings` recognize `designer` in their plugin
inventory and Codex hook-readiness checks. Per
[ADR-0043](../../docs/adr/0043-founder-designer-footer-enablement.md) the
runtime `workflow_kind` projection seam models all four personas (S2), and
designer terminal paths **code-emit** the runtime completion footer through
the ADR-0031 session-handoff sidecar (S4) — see
`skills/_shared/references/session-handoff.md` for the wiring, the dual
discovery floors, and the footer-rendered marker contract. Designer stays
out of the `runtime:dashboard` Tier-1 active-workflow view: Tier-1 scoping
is a deliberate ADR-0040 §6 decision independent of the projection seam
(designer inclusion is a demand-gated follow-up per ADR-0043 §3), and the
attention sensors enrich designer terminal Stops since
`plugin-attention-v0.5.0` (the ADR-0043 §3 follow-up — transition-anchored
freshness, headline omitted on designer's usually-publish-needed `blocked`).

## Scope boundaries (ADR-0042 Non-Goals)

- **Figma / external design-tool integration** — excluded in v1
  (code-first scope; a demand-gated future ADR).
- **Pixel-accurate UI mockup generation** — unnecessary; the running
  frontend is the design artifact of record.
- **orchestrator → designer automatic dispatch** — designer is
  non-dispatch in v1 (founder precedent); design + frontend programs run
  designer and engineer as sequential workflows with artifact handoff.
- **Formal WCAG conformance certification** — designer surfaces and
  prioritizes *candidate* accessibility issues from static screenshot +
  code critique; conformance requires runtime keyboard / focus-order /
  screen-reader testing.
