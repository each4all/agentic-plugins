# founder — new-business planning workbench (L3 persona)

> **Incubating scaffold.** This plugin ships its workflow machinery
> (state I/O, stop-archive, session hooks) but **no user-facing
> commands or skills yet** — the verb surface lands through the
> [ADR-0036](../../docs/adr/0036-founder-persona-business-planning.md)
> implementation roadmap (PR3+ below). Installed hooks no-op cleanly
> when no founder workflow exists.

`founder` is the second L3 persona plugin of agentic-plugins (after
`engineer`), targeting **new-business planning** (신사업 기획). A
*founder* here is the owner of a new-business decision — startup
founding, corporate venturing, or side-business planning — not only a
startup CEO.

## Planned surface (per ADR-0036 §Sub-decision 2)

| Requirement | Surface (lands in) |
|---|---|
| Business-item discovery (사업아이템 탐색) | `founder:investigate` — business-brief profile (PR3) |
| Ideation (구상) | `founder:frame` — business problem model (PR3) |
| Concretization (구체화) | `founder:decide` → `founder:compose` (PR4) → `founder:critique` → `founder:refine` (PR5) |
| Planning composition (기획구상) | `founder:start` lifecycle macro + meta skills (PR6) |

## Workspace convention (ADR-0036 §Sub-decision 5)

founder workflows anchor to a **per-venture content git repository**
(recommended, not enforced) — business documents are version-controlled
deliverables, and the lifecycle terminates on real commits. Running
inside a code repository works but is the friction ADR-0036 §F3
records. State will live at `<repo>/.agentic-plugins/state/founder/`
(ADR-0025 canonical home; created at first use, never committed).

## Roadmap status (ADR-0036 §Implementation Roadmap)

| PR | Scope | Status |
|---|---|---|
| PR1 | Atomic scaffold: manifests, catalogs, release wiring, shape test | ✅ #420 |
| PR2 | Workflow machinery copy-trim (state/dispatch/peer-runner/hooks) | ✅ this PR |
| PR3 | investigate (business-brief spec) + frame (business Task Profile) | ⏳ |
| PR4 | decide (business axes registry) + compose | ⏳ |
| PR5 | critique + refine + business ensemble templates | ⏳ |
| PR6 | start macro + meta skills | ⏳ |
| PR7 | Real-topic dogfood → ADR-0036 `Accepted` flip | ⏳ |

Additionally deferred (separate `plugins/runtime` PR per ADR-0016
cross-package rule): `runtime:doctor` / `runtime:settings` inventory
recognition — their `PLUGIN_NAMES` lists do not yet include `founder`,
so runtime diagnostics will not report this plugin until that PR lands.
