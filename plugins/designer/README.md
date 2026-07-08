# designer — code-first design/UX decision & quality workbench (L3 persona)

> **Incubating scaffold.** This release is the **atomic scaffold only**
> (manifests, both marketplace catalogs, release wiring, and a staged
> shape test) per [ADR-0042](../../docs/adr/0042-designer-persona-design-ux-workbench.md).
> The persona surfaces — workflow machinery, the six verb skills, the
> `designer:start` lifecycle macro, and the meta skills — land across the
> ADR-0042 implementation ladder. Until the roadmap completes and ADR-0042
> flips to `Accepted`, no functional command/skill surface ships.

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

## Roadmap status (ADR-0042 §Implementation Roadmap)

| PR | Scope | Status |
|---|---|---|
| PR1 | Atomic scaffold: manifests, both catalogs, release wiring, staged shape test | ✅ this release |
| PR2 | Workflow machinery copy-trim (state/dispatch/peer-runner/session-handoff/stop-archive/hooks) | ⏳ pending |
| PR3 | investigate (design brief + privacy gate) + frame | ⏳ pending |
| PR4 | decide (7-axis design decision registry) + compose | ⏳ pending |
| PR5 | critique (quality lenses) + refine (convergence loop) | ⏳ pending |
| PR6 | start lifecycle macro + resume / checkpoint / peer-now meta skills | ⏳ pending |
| PR7 | Real-topic dogfood → ADR-0042 `Accepted` flip + ADR-0010 §1 L4 correction + doc cascade | ⏳ pending |

Additionally deferred (separate `plugins/runtime` PR per
[ADR-0016](../../docs/adr/0016-cross-package-commit-splitting.md)
cross-package rule): `runtime:doctor` / `runtime:settings` inventory
recognition — their `PLUGIN_NAMES` lists do not yet include `designer`,
so runtime diagnostics will not report this plugin until that RT PR lands.
Per ADR-0042 Consequences, the runtime `workflow_kind` projection is
**not** extended for designer (runtime models only `engineer` /
`orchestrator`).

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
