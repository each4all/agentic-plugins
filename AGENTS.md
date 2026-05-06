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
│   └── lint/                       # Plugin shape conformance checks
├── plugins/                        # Reference dual-host plugins (4-layer per ADR-0010)
│   ├── README.md
│   ├── companions/                 # L1 framework primitive — script-only library plugin (ADR-0008).
│   │                               # As of v0.3.0 also bundles canonical companion discovery
│   │                               # library (scripts/discover-peer.mjs); Stage 2 Deliverable B
│   │                               # absorbed discovery into this plugin per ADR-0010 §6 trigger
│   │                               # evaluation (high cohesion, no separate plugin spawned)
│   └── engineer/                   # L3 persona — 6-verb workbench (Stage 2 complete 2026-05-06).
│                                   # research capability folded in via investigate's cited-brief
│                                   # profile per ADR-0014 + ADR-0015 (Stage 2.5+); plugins/research
│                                   # archived at commit 28b5eb8
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
        └── 0001..0015-*.md         # Decisions (0013 reserved, 0014 superseded by 0015 timeline portion)
```

---

## Architecture in one paragraph

agentic-plugins uses **Hexagonal architecture (ports and adapters)** applied to
AI agent plugins (ADR-0001), extended with a **4-layer composition model**
per ADR-0010:

1. **Layer 1 — Framework primitive** (`plugins/companions`): cross-host
   peer-agent invocation infrastructure
2. **Layer 2 — Capability** (planned occupants: `decision`, `image`):
   persona-agnostic activities reusable by multiple personas. The L2
   slot is defined but currently empty — the Stage 1 `plugins/research`
   incumbent was retired at Stage 2.5+ ([ADR-0014](docs/adr/0014-plugins-research-deprecation.md)),
   its cited-brief contract absorbed into `engineer:investigate`'s
   cited-brief profile.
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
  Stage 1 `plugins/research` was the precedent for this pattern
  (its single command was `/research:research`); the plugin was
  retired at Stage 2.5+ per [ADR-0014](docs/adr/0014-plugins-research-deprecation.md),
  but the rule itself stands for any future single-verb L2
  capability. See ADR-0010 §3 for the special-case rule

Profile and topic flow as arguments. Verb-level sugar aliases
within a plugin are permitted (ADR-0010 §3); plugin-name level
marketplace aliases are not (ADR-0011 §Non-Goals item 9).

The **adapter** sub-layer per host implements the host's runtime
model (manifest schemas, hook event/payload mapping, orchestration
patterns, continuity protocols). The **companion** layer (Layer 1)
holds two bridges — one in each direction — for peer-agent
invocation. See ADRs 0001–0015 for the specifics (0013 reserved
pending Codex CLI commands integration trigger; 0014 superseded by
0015 for the `plugins/research` archive timeline only — the
capability decision in 0014 is operative).

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

**Stage 1 (Reference plugin + companion contract)** — complete (2026-05-05). Shipped `plugins/companions` (script-only library) and `plugins/research` (single-skill capability with bidirectional companion ensemble; retired at Stage 2.5+ per [ADR-0014](docs/adr/0014-plugins-research-deprecation.md), cited-brief contract absorbed into `engineer:investigate`). Round-trip verification at the time: bidirectional companion calls succeeded in both directions; per-host CI gates (`claude-tests.yml`, `codex-tests.yml`) green on every push. The two reference brief artifacts (`output/` directory, gitignored locally) demonstrated the protocol but were not committed evidence — exit verification was the green CI runs and the protocol acceptance documented in `docs/DEVELOPMENT.md` §Stage 1 exit evidence.

**Stage 2 (Self-development plugin)** — complete (2026-05-06). ADRs 0010 (plugin boundary policy + 4-layer composition + 6 universal verbs), 0011 (workflow continuity Option III storage), and 0012 (omcc + codex-plugin-cc removal preconditions) accepted. Shipped `plugins/engineer` (canonical L3 persona name; plugin-name level marketplace aliases like `/dev:` are a Stage 2 non-goal per ADR-0011 §9). Verb-level aliases inside the plugin (e.g., `/engineer:audit` ≡ `/engineer:critique --profile=full-codebase`) are permitted (ADR-0010 §3). All five deliverables (A foundation → B kit/discovery absorbed into `plugins/companions` per ADR-0010 §6 high-cohesion evaluation → C plugin core + 6 verb skills → D adapters + minimal continuity → E validation + dogfood) merged. Stage 2 exit gate met: `plugins/engineer` drives its own development without omcc-dev (see `docs/DEVELOPMENT.md` §Stage 2 exit evidence).

**Stage 2.5+ (Research deprecation cascade)** — in progress. ADR-0014 deprecates `plugins/research` and folds the cited-brief contract into `engineer:investigate`'s new `cited-brief` profile (capability decision); ADR-0015 supersedes ADR-0014's deprecation-period timeline with immediate Stage 2.5+ archive (no installed-user audience to require the deprecation period). ADR-0010 amended as cascade. Implementation commits: `dc49ef0` (Stage 2 ADR finalization + ADR-0013 reservation), `2034877` (ADR-0014), `4077552` (`engineer:investigate --profile=cited-brief` absorption), `28b5eb8` (`plugins/research` archive), `944fd4e` (ADR-0010 cascade), `3ee7100` (ADR-0015 supersede + audit shape). Other Stage 2.5+ candidates: ADR-0013 (Codex CLI commands integration mechanism, file pending — Stage 3+ trigger).

**Stage 3 (Design domain)** — planned. Will ship `plugins/designer` referencing omcc-designer experience under the same 4-layer composition. The cited-brief precedent (research → `engineer:investigate` absorption per ADR-0014/0015) is the reference pattern for designer's domain-specific evidence-gathering — `designer:investigate` will likely follow the same in-persona pattern rather than depend on a separate L2 research plugin.

Next steps:

1. Read this `AGENTS.md`, then `docs/ARCHITECTURE.md`, then ADRs 0001–0015 (especially 0010 for plugin boundary policy, 0011 for continuity scope, and 0014/0015 for the research deprecation cascade)
2. Stage 2.5+ continuation: ADR-0013 authoring when its trigger fires (Codex CLI plugin-commands schema lands or alternative mechanism designed)
3. Stage 3 (designer plugin) brainstorm + plan

---

## License

[MIT](LICENSE).
