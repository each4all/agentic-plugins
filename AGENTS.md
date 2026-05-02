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
├── companions/                     # Bidirectional bridges (first-party)
│   ├── README.md
│   └── (claude-companion.mjs, codex-companion.mjs, contract.md — TBD)
├── kit/                            # Plugin authoring toolkit
│   ├── README.md
│   └── (adapter-generator/, manifest-templates/, lint/ — TBD)
├── plugins/                        # Reference dual-host plugins
│   ├── README.md
│   └── (per-plugin directories — TBD)
└── docs/
    ├── ARCHITECTURE.md             # Overall design overview
    ├── DEVELOPMENT.md              # How agentic-plugins is itself developed
    └── adr/                        # Architecture Decision Records
        ├── README.md               # ADR index
        ├── template.md             # Standard ADR template
        └── 0001..0007-*.md         # Decisions
```

---

## Architecture in one paragraph

agentic-plugins uses **Hexagonal architecture (ports and adapters)** applied to
AI agent plugins. The **core** layer holds host-neutral, standards-aligned
assets (Agent Skills SKILL.md, MCP servers, persona descriptions, prompt
templates). The **adapter** layer per host implements the host's runtime
model (manifest schemas, hook event/payload mapping, orchestration
patterns, continuity protocols). The **companion** layer holds two
bridges — one in each direction — that allow either host to invoke the
other as a peer agent for open-ended turns. See ADRs 0001–0006 for the
specifics.

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

Stage 0 (Scaffolding) is complete:

- All 7 ADRs accepted (0001–0007). See `docs/adr/`
- Tooling decided (Node + pnpm + vitest + prettier + GitHub Actions + release-please + MIT). See `docs/DEVELOPMENT.md` § Tooling
- LICENSE in place (MIT)
- No plugins or companions implemented yet

Next session — Stage 1 (see `docs/DEVELOPMENT.md` § Stage 1):

1. Read this `AGENTS.md`, then `docs/ARCHITECTURE.md`, then ADRs 0001–0007 (especially 0007 for the redesign stance — agentic-plugins is not a 1:1 omcc port)
2. Draft `companions/contract.md` — XML prompt structure, output parsing rules, error semantics
3. Implement both companion CLIs (`claude-companion.mjs`, `codex-companion.mjs`)
4. Design the Stage 1 reference plugin (research-domain) — name, structure, and command surface are agentic-plugins' own design, referencing omcc-research's experience (see ADR-0007 redesign stance)
5. Wire up per-host CI gates and marketplace JSON validation per `docs/DEVELOPMENT.md` § CI
6. Push to GitHub when ready (`each4all/agentic-plugins`)

---

## License

[MIT](LICENSE).
