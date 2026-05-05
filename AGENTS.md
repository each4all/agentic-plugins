# agentic-plugins — Development Guidance for AI Agents

This document is for AI coding agents (Claude Code, Codex CLI, Cursor, etc.)
assisting with agentic-plugins development. It is the **primary** development
guidance file. `CLAUDE.md` references this file rather than duplicating
content — keeping a single source of truth across hosts is a core agentic-plugins
principle (see "Dogfooding" below).

---

## What agentic-plugins is

agentic-plugins is a **cross-host AI agent collaboration framework**. Two faces:

1. **External face** — what consumers install:
   - Bidirectional companion CLIs (`companions/`)
   - Reference plugins that work natively in Claude Code AND Codex CLI (`plugins/`)
   - Plugin authoring toolkit (`kit/`)
   - Two marketplace catalogs (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`)
2. **Internal face** — how agentic-plugins is itself developed:
   - This `AGENTS.md` and supporting docs
   - Future internal dev plugins (planned, see `docs/DEVELOPMENT.md`)
   - Tests that validate the adapter contract and companion contract
   - CI gates for both Claude Code and Codex CLI environments

Both faces are equal-priority. agentic-plugins is built so it can build itself.

---

## Repository layout

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the rationale, and
the directory tree below for the literal locations:

```
agentic-plugins/
├── README.md                       # Charter for consumers
├── AGENTS.md                       # This file — dev guidance
├── CLAUDE.md                       # References AGENTS.md
├── .gitignore
├── .claude-plugin/
│   └── marketplace.json            # Claude Code marketplace catalog
├── .agents/
│   └── plugins/
│       └── marketplace.json        # Codex CLI marketplace catalog
├── companions/                     # Bidirectional bridges (first-party, source of truth)
│   ├── README.md
│   ├── contract.md                 # Wire-spec v0.1.1 (ADR-0009)
│   ├── claude-companion.mjs        # Codex → Claude bridge
│   ├── codex-companion.mjs         # Claude → Codex bridge
│   └── tests/                      # unit + smoke (COMPANIONS_SMOKE=1)
├── kit/                            # Plugin authoring toolkit
│   ├── README.md
│   ├── lint/                       # Plugin shape conformance checks
│   └── (discovery/ — Stage 2 Deliverable B)
├── plugins/                        # Reference dual-host plugins (4-layer per ADR-0010)
│   ├── README.md
│   ├── companions/                 # L1 framework primitive — script-only library plugin (ADR-0008)
│   ├── research/                   # L2 capability — topic-bound research, Stage 1 reference plugin
│   └── (engineer/ — L3 persona, Stage 2 Deliverable C)
├── scripts/
│   ├── sync-companion-bundles.mjs  # drift-checked companion script copy
│   └── validate-marketplace.mjs    # marketplace catalog validation
├── tests/
│   └── plugin-shape/               # per-plugin shape conformance tests
└── docs/
    ├── ARCHITECTURE.md             # Overall design overview (4-layer per ADR-0010)
    ├── DEVELOPMENT.md              # How agentic-plugins is itself developed
    └── adr/                        # Architecture Decision Records
        ├── README.md               # ADR index
        ├── template.md             # Standard ADR template
        └── 0001..0011-*.md         # Decisions
```

---

## Architecture in one paragraph

agentic-plugins uses **Hexagonal architecture (ports and adapters)** applied to
AI agent plugins (ADR-0001), extended with a **4-layer composition model**
per ADR-0010:

1. **Layer 1 — Framework primitive** (`plugins/companions`): cross-host
   peer-agent invocation infrastructure
2. **Layer 2 — Capability** (`plugins/research`): persona-agnostic
   activities reusable by multiple personas
3. **Layer 3 — Persona / workbench** (`plugins/engineer` Stage 2,
   `plugins/designer` Stage 3): user-facing install unit, composes
   capabilities through profiles
4. **Layer 4 — Profile** (sub-discipline within persona, e.g.,
   `engineer:backend`, `designer:ui`): configuration data carrying
   discipline-specific context

Skills inside each L3/L2 plugin follow the **6 universal cognitive
verbs**: Investigate / Frame / Decide / Compose / Critique / Refine
(ADR-0010). Canonical names per layer:

- **L3 persona plugins** use `<persona>:<verb>` (e.g.,
  `/engineer:investigate`, `/designer:critique`)
- **L2 capability plugins** use `<capability>:<verb>` (e.g.,
  future `/decision:decide`, `/decision:critique`)
- **Single-verb capability plugins** are a special case where
  plugin name and verb collide: `<capability>:<capability>`. The
  shipped Stage 1 `plugins/research` is exactly this case — its
  one command is `/research:research` (Investigate is implicit
  in the plugin name). See ADR-0010 §3 for the special-case rule

Profile and topic flow as arguments. Verb-level sugar aliases
within a plugin are permitted (ADR-0010 §3); plugin-name level
marketplace aliases are not (ADR-0011 §Non-Goals item 9).

The **adapter** sub-layer per host implements the host's runtime
model (manifest schemas, hook event/payload mapping, orchestration
patterns, continuity protocols). The **companion** layer (Layer 1)
holds two bridges — one in each direction — for peer-agent
invocation. See ADRs 0001–0011 for the specifics.

---

## Conventions

### Commits — Conventional Commits

`<type>(<scope>): <description>`

Types: `feat`, `fix`, `docs`, `ci`, `refactor`, `chore`, `test`
Scope: subsystem name (e.g., `companions`, `kit`, `plugin/<name>`, `adr`, `docs`)

Examples:
- `feat(companions): add claude-companion XML output parser`
- `docs(adr): finalize ADR-0007 cutover plan`
- `test(kit): add adapter-contract conformance tests`

### Branching — never commit to main

1. `git checkout -b <type>/<scope>`
2. commit on the branch
3. `git push -u origin <branch>`
4. open PR via `gh pr create`

### Pull strategy

Use **merge** for `git pull`. Run `git pull --no-rebase` explicitly. Do
not rely on bare `git pull` since `pull.rebase=true` in any config layer
silently rewrites history.

### Versioning

SemVer (MAJOR.MINOR.PATCH). MAJOR for breaking changes (companion
contract, adapter contract, manifest schema). MINOR for new plugins or
new adapter features. PATCH for fixes and docs.

### ADR process

1. Copy `docs/adr/template.md` to `docs/adr/NNNN-<slug>.md` (next number)
2. Fill out Status (start with `Proposed`), Context, Decision, Consequences, Alternatives Considered
3. PR for review; on merge change Status to `Accepted`
4. To supersede an ADR: create a new ADR that references the old one and change the old one's Status to `Superseded by ADR-NNNN`

---

## Development principles

These are repo-wide rules. Plugin-specific conventions go in each
plugin's own `CLAUDE.md`/`AGENTS.md`.

### 1. Standards-aligned core

When the same capability has both a host-specific implementation and an
open-standard implementation, the standard goes in `core/`, the host
specific goes in the adapter. Examples:
- Skills → Agent Skills standard (agentskills.io) → core
- Tools → MCP standard → core
- Hooks → host-specific event names → adapter
- Subagents → persona description in core, host-format (markdown+YAML or TOML) generated in adapter

### 2. Layered separation, not thin adapter

Adapters are **as thin as possible, but no thinner**. They contain
whatever is necessary to honor core intent within the host's runtime
model. Some adapters will be substantial (e.g., orchestration patterns
that require host-specific subagent invocation). Do not force false
unification.

### 3. Companion contract is the framework

The two companions (`claude-companion`, `codex-companion`) implement the
same `companions/contract.md`. This contract — XML prompt structure,
output parsing, error semantics — is the inviolable contract. Both
adapters call companions through this contract; no adapter calls a
companion through ad-hoc shell wrapping.

### 4. Dogfooding

agentic-plugins is developed using AI coding agents. Initially Claude Code
(this session). As soon as agentic-plugins' first plugin is stable enough to
self-serve, agentic-plugins switches to using its own plugin for further
development — that switch event is itself a milestone. See
`docs/DEVELOPMENT.md` for the dogfooding plan.

### 5. Honest scope

If a feature cannot be made native+canonical in both hosts, the project
documents the limit rather than forcing false unification. This applies
in particular to host-specific runtime semantics (auto-delegation,
context lifecycle events, statusline, etc.). See ADR-0001 final note.

---

## Build / test / CI

Currently empty. To be decided in the next development session. Likely
shape:
- Per-host smoke test workflows (Claude Code in CI, Codex CLI in CI)
- Adapter contract conformance tests in `kit/lint/`
- Companion round-trip tests in `companions/tests/`
- Marketplace JSON validation (both `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`)

---

## Current state and next session

**Stage 0 (Scaffolding)** — complete (2026-04 to 2026-05-02). All 7 ADRs accepted (0001–0007), tooling decided, LICENSE in place.

**Stage 1 (Reference plugin + companion contract)** — complete (2026-05-05). Shipped `plugins/companions` (script-only library) and `plugins/research` (single-skill capability with bidirectional companion ensemble). Round-trip verification: bidirectional companion calls succeed in both directions; per-host CI gates (`claude-tests.yml`, `codex-tests.yml`) green on every push. The two reference brief artifacts (`output/` directory, gitignored locally) demonstrate the protocol but are not committed evidence — exit verification is the green CI runs and the protocol acceptance documented in `docs/DEVELOPMENT.md` §Stage 1 exit evidence.

**Stage 2 (Self-development plugin)** — in progress. ADRs 0010 (plugin boundary policy + 4-layer composition + 6 universal verbs) and 0011 (workflow continuity Option III storage) drafted. Building `plugins/engineer` (canonical L3 persona name; plugin-name level marketplace aliases like `/dev:` are a Stage 2 non-goal per ADR-0011 §9). Verb-level aliases inside the plugin (e.g., `/engineer:audit` ≡ `/engineer:critique --profile=full-codebase`) are permitted (ADR-0010 §3). 5 deliverables (A foundation → B kit/discovery → C plugin core + 6 verb skills → D adapters + minimal continuity → E validation + dogfood). Stage 2 exit gate: `plugins/engineer` can drive its own development without omcc-dev.

**Stage 3 (Design domain)** — planned. Will ship `plugins/designer` referencing omcc-designer experience under same 4-layer composition.

Next steps within Stage 2:

1. Read this `AGENTS.md`, then `docs/ARCHITECTURE.md`, then ADRs 0001–0011 (especially 0010 for plugin boundary policy and 0011 for continuity scope)
2. Continue Stage 2 Deliverables B → E per `docs/DEVELOPMENT.md` §Stage 2
3. Stage 2 dogfood verification = Stage 2 exit
4. Stage 3 (designer plugin) brainstorm + plan

---

## License

[MIT](LICENSE).
