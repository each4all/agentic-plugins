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
        └── 0001..0017-*.md         # Decisions (0013 reserved, 0014 superseded by 0015 timeline portion)
```

---

## Architecture in one paragraph

agentic-plugins uses **Hexagonal architecture (ports and adapters)** applied to
AI agent plugins (ADR-0001), extended with a **4-layer composition model**
per ADR-0010:

1. **Layer 1 — Framework primitive** (`plugins/companions`): cross-host
   peer-agent invocation infrastructure
2. **Layer 2 — Capability** (`plugins/orchestrator` Stage 3+):
   persona-agnostic activities reusable by multiple personas. The
   first multi-verb L2 occupant is `plugins/orchestrator` (Stage 3+
   first shipped as a plan-only MVP per
   [ADR-0018](docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md)
   §sub-decision-1, then expanded by [ADR-0019](docs/adr/0019-cross-plugin-invocation-contract.md)
   and [ADR-0023](docs/adr/0023-peer-runner-supervisor-layer.md) into
   macro planning, supervised Plan-verify peer dispatch, same-host
   engineer dispatch, manual completion backup, finalize/abort, and
   macro auto-archive. The Stage 1 `plugins/research` incumbent was
   retired at Stage 2.5+ ([ADR-0014](docs/adr/0014-plugins-research-deprecation.md)),
   its cited-brief contract absorbed into `engineer:investigate`'s
   cited-brief profile. Other planned occupants (`decision`, `image`)
   remain future work.
3. **Layer 3 — Persona / workbench** (`plugins/engineer` Stage 2,
   `plugins/designer` future L3 candidate): user-facing install unit, composes
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
invocation. See ADRs 0001–0024 for the specifics (0013 remains
reserved pending Codex CLI commands integration trigger; 0014 was
superseded by 0015 for the `plugins/research` archive timeline only;
0017–0023 cover continuity, orchestrator, command-surface parity, and
peer-runner supervision follow-ups; 0024 accepts the runtime/operator
control-plane track).

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

### Release process

release-please owns per-package version automation. It tracks each
package via `release-please-config.json` and writes new versions into
`.release-please-manifest.json` plus each package's
`.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` (per the
`extra-files` mapping).

The root `.claude-plugin/marketplace.json` catalog is **deliberately
not** an `extra-files` target — keeping the catalog under
release-please management would couple every plugin package to commits
that touch any catalog entry, producing no-op version bumps on
unrelated plugins. Instead, the catalog is synced separately by
`scripts/sync-marketplace-versions.mjs` after each release. The
release-please GitHub Action runs that sync as a follow-up step
automatically, and `validate:versions` fails CI if catalog entries
drift from the manifest.

Release-please changelog hygiene depends on merge shape. For a
single-package PR, prefer a squash merge whose final message is the one
intended changelog entry. When preserving multiple release-routed
commits is necessary, use rebase merge if available or avoid a merge
commit body that repeats the same conventional headline. A GitHub merge
commit that embeds a conventional PR title can be parsed alongside the
original branch commit, producing duplicate changelog entries for the
same change.

### Cross-package commit splitting

release-please routes a commit's footer (`feat`, `fix`,
BREAKING CHANGE, etc.) to **every** package whose tracked path the
commit touches — Conventional Commits scope is a label, not a
routing override. When a single commit modifies files in 2+
release-please package paths, **split into per-package commits
before pushing**. Per-package commits stage only that package's
files (`git add <package-path> && git commit`).

The package paths are the keys of `release-please-config.json`
`packages` — currently `companions`, `plugins/companions`,
`plugins/engineer`, and `plugins/orchestrator`. Files **outside**
every package key prefix are exempt: root files (`AGENTS.md`,
`README.md`, `package.json`, etc.),
`docs/`, `scripts/`, `tests/`, `kit/`, `.claude-plugin/`,
`.agents/`, `.github/`, and any other unlisted path. Root-level
docs may be folded into any per-package commit or a separate
docs-only commit at author's discretion. The exemption is
structural — it is determined by `release-please-config.json` and
shrinks automatically if a new package's path overlaps a previously
exempt area.

This is a convention enforced by reviewer attention, not a CI gate.
A violation surfaces as an incorrect release-please PR (e.g., a
BREAKING bump on a package the change did not target). See
[ADR-0016](docs/adr/0016-cross-package-commit-splitting.md) for the
full rationale, the originating `28b5eb8` incident, and rejected
alternatives (pre-commit lint hook, monorepo decomposition, scope
as routing override).

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

Primary local commands:

- `npm test` — full Node test suite.
- `npm run test:plugin-shape` — plugin shape + engineer/orchestrator state tests.
- `npm run test:cross-host` — cross-host workflow contract tests.
- `npm run lint:plugin-shape` — validate all plugin directories with `kit/lint`.
- `npm run validate:marketplace`, `npm run validate:versions`, and
  `npm run validate:artifacts` — catalog, release-please manifest, and
  generated-artifact ignore policy consistency.
- `npm run sync:companions` and `npm run sync:marketplace` — drift-correction helpers.

GitHub Actions run on Node 24 and cover Claude companion tests, Codex
companion tests, cross-host tests, marketplace/version validation, and
release-please automation.

---

## Current state and next session

**Stage 0 (Scaffolding)** — complete (2026-04 to 2026-05-02). All 7 ADRs accepted (0001–0007), tooling decided, LICENSE in place.

**Stage 1 (Reference plugin + companion contract)** — complete (2026-05-05). Shipped `plugins/companions` (script-only library) and `plugins/research` (single-skill capability with bidirectional companion ensemble; retired at Stage 2.5+ per [ADR-0014](docs/adr/0014-plugins-research-deprecation.md), cited-brief contract absorbed into `engineer:investigate`). Round-trip verification at the time: bidirectional companion calls succeeded in both directions; per-host CI gates (`claude-tests.yml`, `codex-tests.yml`) green on every push. The two reference brief artifacts (`output/` directory, gitignored locally) demonstrated the protocol but were not committed evidence — exit verification was the green CI runs and the protocol acceptance documented in `docs/DEVELOPMENT.md` §Stage 1 exit evidence.

**Stage 2 (Self-development plugin)** — complete (2026-05-06). ADRs 0010 (plugin boundary policy + 4-layer composition + 6 universal verbs), 0011 (workflow continuity Option III storage), and 0012 (omcc + codex-plugin-cc removal preconditions) accepted. Shipped `plugins/engineer` (canonical L3 persona name; plugin-name level marketplace aliases like `/dev:` are a Stage 2 non-goal per ADR-0011 §9). Verb-level aliases inside the plugin (e.g., `/engineer:audit` ≡ `/engineer:critique --profile=full-codebase`) are permitted (ADR-0010 §3). All five deliverables (A foundation → B kit/discovery absorbed into `plugins/companions` per ADR-0010 §6 high-cohesion evaluation → C plugin core + 6 verb skills → D adapters + minimal continuity → E validation + dogfood) merged. Stage 2 exit gate met: `plugins/engineer` drives its own development without omcc-dev (see `docs/DEVELOPMENT.md` §Stage 2 exit evidence). Per-condition progress is tracked via the [ADR-0012](docs/adr/0012-omcc-removal-preconditions.md) four-condition matrix in `docs/DEVELOPMENT.md`; condition 1 is satisfied, condition 4 is functionally satisfied, and conditions 2/3 remain partial.

**Stage 2.5+ / Stage 3+ continuity cascade** — active but mostly shipped through ADR-0023. ADR-0014/0015 archived `plugins/research` and folded cited-brief into `engineer:investigate`; ADR-0017 accepted and implemented engineer resume/checkpoint/peer-now plus `ensemble_results` and Stop auto-archive; ADR-0018 shipped `plugins/orchestrator` as the first multi-verb L2 capability; ADR-0019 shipped orchestrator→engineer same-host dispatch, `/done`, `/finalize`, `/abort`, and macro auto-archive; ADR-0020–0022 added `/engineer:start` and Codex macro/meta skill parity without waiting on ADR-0013; ADR-0023 added peer-runner supervision for monitoring, cancellation, sweep, and bounded ledger retention. ADR-0024 accepts the immediate runtime/operator control-plane track: `doctor`, `settings`, dynamic peer consensus, context hygiene, model/effort resolution, and host-readiness diagnosis. ADR-0013 remains reserved for a future Codex CLI command integration mechanism.

> **User-environment cleanup note**: users of agentic-plugins versions
> ≤0.3.x may have a stale `research@agentic-plugins 0.1.0` cache from
> the pre-archive era. Run `claude /plugin uninstall research@agentic-plugins`
> (or the equivalent Codex command) to remove it — the plugin is no
> longer in either marketplace catalog (per ADR-0014/0015).

**Stage 3+ (Runtime/operator track)** — accepted by ADR-0024 and actively shipping through `plugins/runtime`. As of `plugin-runtime` v0.26.6, runtime provides the L1 framework primitive for host readiness and operator control: `doctor`, `settings`, explicit consensus execution, context hygiene scaffolding, workflow-storage migration, Codex plugin hook readiness diagnosis, sandbox-limited host auth diagnosis, retired plugin cleanup planning, and an advisory completion footer. `plugins/designer` remains possible future work referencing omcc-designer experience under the same 4-layer composition, but it is no longer the active next-step trigger for ADR-0012 condition 3.

Next steps:

1. Read this `AGENTS.md`, then `docs/ARCHITECTURE.md`, then ADRs 0001–0024 (especially 0010 for plugin boundary policy, 0012 for omcc removal gates, 0016 for release-please routing, 0018/0019 for orchestrator, 0020–0022 for engineer command-surface parity, 0023 for peer-runner supervision, and 0024 for runtime/operator control-plane scope).
2. Stage 2.5+ continuation: ADR-0013 authoring when its trigger fires (Codex CLI plugin-commands schema lands or an alternative mechanism is designed).
3. Stage 3+ runtime/operator dogfood: continue ADR-0024 in small PRs from the current shipped surface. The next high-value slice is dogfooding `runtime:consensus plan → execute --execute → synthesize → next-round`, then tightening bounded rebuttal UX, cancellation/retention details, and context/footer integration while preserving the explicit no-unbounded-loops, no-host-permission-relaxation, no-host-session-mutation boundaries. The first non-trivial Stage 3+ workflow developed engineer-only remains the trigger candidate for ADR-0012 condition 3 → satisfied transition.

---

## License

[MIT](LICENSE).
