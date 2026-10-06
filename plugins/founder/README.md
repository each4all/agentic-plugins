# founder — new-business planning workbench (L3 persona)

`founder` is the second L3 persona plugin of agentic-plugins (after
`engineer`), targeting **new-business planning** (신사업 기획). A
*founder* here is the owner of a new-business decision — startup
founding, corporate venturing, or side-business planning — not only a
startup CEO.

It ships the **complete** six-verb persona surface: the six universal
cognitive verbs (investigate / frame / decide / compose / critique /
refine) re-anchored to business concerns, a business-anchored peer
ensemble, the `founder:start` lifecycle macro, and the
resume / checkpoint / peer-now meta skills. Per
[ADR-0036](../../docs/adr/0036-founder-persona-business-planning.md) the
persona is **Accepted** (real-topic dogfood validated end-to-end).
Installed hooks no-op cleanly when no founder workflow exists.

## Surface (per ADR-0036 §Sub-decision 2)

| Requirement | Surface | Status |
|---|---|---|
| Business-item discovery (사업아이템 탐색) | `founder:investigate` — business-brief profile | ✅ shipped |
| Ideation (구상) | `founder:frame` — business problem model | ✅ shipped |
| Concretization (구체화) | `founder:decide` → `founder:compose` → `founder:critique` → `founder:refine` | ✅ shipped |
| Planning composition (기획구상) | `founder:start` lifecycle macro + resume / checkpoint / peer-now meta skills | ✅ shipped |

All six verbs re-anchor to business concerns — markets, unit-economics,
regulation, competition — per ADR-0036 §Sub-decision 6. `founder:decide`
carries a persona-local business axes registry (decisive
market-attractiveness + unit-economics axes plus gate-style
regulatory-exposure + safety-risk veto axes); `founder:critique` and
`founder:refine` drive the nine business-anchored ensemble point
templates in founder's own ensemble protocol.

The discovery + ideation surfaces (`investigate` / `frame`) carry their
own in-persona contracts: the 5-tier business source taxonomy +
freshness/jurisdiction + paywalled-source rules + privacy gate live in
[`business-brief-spec.md`](core/skills/investigate/references/business-brief-spec.md),
and the business Task Profile lives in
[`orchestration.md`](core/skills/_shared/references/orchestration.md). Per
ADR-0010 §5 these are founder-owned copies, not imports of the engineer
originals.

## Workspace convention (ADR-0036 §Sub-decision 5)

founder workflows anchor to a **per-venture content git repository**
(recommended, not enforced) — business documents are version-controlled
deliverables, and the lifecycle terminates on real commits. Running
inside a code repository works but is the friction ADR-0036 §F3
records. State lives at `<repo>/.agentic-plugins/state/founder/`
(ADR-0025 canonical home; created at first use, never committed).

## Owner gates and mixed versions (ADR-0066 Decision 7)

From the release that carries ADR-0066 Stage 2b, founder writes new workflow
files at schema 1.4: each verb records its next step in closed-enum form, and
a verb that needs the owner's judgment — a decision whose directions conflict, a refine finding that keeps
coming back, a request that belongs in another verb or workflow — ends with an owner gate
instead of closing. The Stop hook never archives a workflow while its gate is
pending. Existing files are not migrated; they stay readable as they are.

While a workflow carries an owner gate, every host that touches it must run
that release or a later one. An earlier founder reads the file and keeps its
keys, but its Stop hook archives the gated workflow, and its terminal write
leaves a stale next step behind
(`tests/persona-pipeline/test-mixed-version.mjs` records this against the
previous release). Install the release on both hosts, and on Codex check that
the catalog pin has moved to it, before sharing a gated workflow. Recovery
goes forward only: upgrade the host that is behind, never rewrite the file
for an older one.

## Roadmap status (ADR-0036 §Implementation Roadmap)

| PR | Scope | Status |
|---|---|---|
| PR1 | Atomic scaffold: manifests, catalogs, release wiring, shape test | ✅ #420 |
| PR2 | Workflow machinery copy-trim (state/dispatch/peer-runner/hooks) | ✅ #422 |
| PR3 | investigate (business-brief spec) + frame (business Task Profile) | ✅ done |
| PR4 | decide (business axes registry) + compose | ✅ done |
| PR5 | critique + refine + business ensemble templates | ✅ done |
| PR6 | start macro + meta skills | ✅ done |
| PR7 | Real-topic dogfood → ADR-0036 `Accepted` flip | ✅ done |

Additionally deferred (separate `plugins/runtime` PR per ADR-0016
cross-package rule): `runtime:doctor` / `runtime:settings` inventory
recognition — their `PLUGIN_NAMES` lists do not yet include `founder`,
so runtime diagnostics will not report this plugin until that PR lands.
