# agentic-plugins — Architecture

> Cross-host AI agent collaboration framework.
> Plugins author once, run natively in either Claude Code or OpenAI
> Codex CLI, with bidirectional companion bridges.

This document is the architectural overview. The foundational decisions
behind it live in [`adr/`](adr/) — when a section here references "why"
it points to an ADR rather than restating the rationale.

---

## The architecture: hexagonal core + 4-layer composition

agentic-plugins applies **Hexagonal architecture** (ports and adapters) to AI
agent plugins (ADR-0001), and extends it with a **4-layer composition
model** for plugin organization (ADR-0010).

### Hexagonal layers (per-plugin internal structure)

```
┌──────────────────────────────────────────────────────────┐
│ COMPANION (bidirectional bridges, first-party)           │
│  - claude-companion : Codex → Claude peer-agent call     │
│  - codex-companion  : Claude → Codex peer-agent call     │
│  - contract.md      : XML prompt + parsing spec (shared) │
├──────────────────────────────────────────────────────────┤
│ ADAPTER (host-specific, medium-thick)                    │
│  ┌────────────────────────┬─────────────────────────────┐│
│  │ claude/                │ codex/                       ││
│  │ - manifest             │ - manifest                   ││
│  │ - hooks (12 events)    │ - hooks (6 events, Stop-     ││
│  │ - subagent (md+YAML)   │   based continuity)          ││
│  │ - auto-delegation      │ - explicit dispatch          ││
│  │   orchestration        │   orchestration              ││
│  │ - ${CLAUDE_PLUGIN_ROOT}│ - absolute path / setup      ││
│  └────────────────────────┴─────────────────────────────┘│
├──────────────────────────────────────────────────────────┤
│ CORE (host-neutral, standards-aligned)                   │
│  - skills/<n>/SKILL.md  (Agent Skills standard)          │
│  - mcp-servers/<n>/      (MCP standard)                  │
│  - personas/<n>.md       (host-neutral subagent intent)  │
│  - prompt-templates/     (XML templates per companion)   │
│  - protocols/            (intent docs: ensemble,         │
│                           continuity, orchestration)     │
└──────────────────────────────────────────────────────────┘
```

### 4-layer plugin composition (cross-plugin organization)

```
┌─────────────────────────────────────────────────────────────┐
│ L4 — Profile (sub-discipline within persona, unbounded)     │
│   engineer: backend, frontend, devops, sre, ml, data, ...   │
│   designer: ui, print, brand, frontend, image, motion, ...  │
│   (configuration data, not plugins; carried as args)        │
├─────────────────────────────────────────────────────────────┤
│ L3 — Persona / Workbench plugins (user install unit)        │
│   plugins/engineer  ← Stage 2                               │
│   plugins/designer  ← future L3 candidate                   │
│   skills: <persona>:<verb> for each of 6 verbs              │
│   verb-level sugar aliases inside plugin allowed (ADR-0010) │
├─────────────────────────────────────────────────────────────┤
│ L2 — Capability plugins (persona-agnostic activities)       │
│   plugins/orchestrator  ← Stage 3+ (first multi-verb L2     │
│                            occupant; ADR-0018/0019/0023)    │
│   (plugins/research retired at Stage 2.5+ per ADR-0014;     │
│    cited-brief absorbed into engineer:investigate)          │
│   future: plugins/decision, plugins/image                   │
│   skills: <capability>:<verb> for relevant verbs            │
├─────────────────────────────────────────────────────────────┤
│ L1 — Framework primitive plugins (infrastructure)           │
│   plugins/companions  ← Stage 1 (current, ADR-0008)         │
│   plugins/runtime    ← Stage 3+ runtime/operator (ADR-0024) │
└─────────────────────────────────────────────────────────────┘
```

Dependency direction: L4 (data) → L3 → L2 → L1.

### Six universal cognitive verbs (ADR-0010 §2)

Every L3 persona plugin and L2 capability plugin exposes skills named
by canonical verb:

| Verb | What |
|------|------|
| **Investigate** | gather evidence, scan, probe |
| **Frame** | turn evidence into problem model (goals/constraints/risks) |
| **Decide** | select direction, reject alternatives |
| **Compose** | produce artifact (code, plan, brief, ...) |
| **Critique** | evaluate against evidence/standards/goals |
| **Refine** | apply feedback, repair, iterate |

Convergence basis: 6 cognitive/process frameworks (Bloom, Miller,
OODA, PDCA, Double Diamond, Design Thinking) reduce to a small
recurrent control loop matching this verb set. Profile axis carries
unbounded discipline expansion without skill explosion.

See [`adr/0001-hexagonal-architecture.md`](adr/0001-hexagonal-architecture.md)
and [`adr/0010-plugin-boundary-policy.md`](adr/0010-plugin-boundary-policy.md).

---

## Where each layer lives

### `companions/` — cross-host bridges

Two companion CLIs, both first-party, sharing one contract.

```
companions/
├── README.md
├── contract.md             # XML prompt + output parsing spec
├── claude-companion.mjs    # Codex → Claude bridge
├── codex-companion.mjs     # Claude → Codex bridge
└── tests/                  # Round-trip smoke tests
```

`claude-companion` shells out to the `claude` CLI (headless mode);
`codex-companion` shells out to the `codex` CLI. Both speak the same
XML prompt contract and produce parseable output for the calling
adapter to consume.

See [`adr/0003-mcp-vs-companion.md`](adr/0003-mcp-vs-companion.md) for
why peer-agent invocation is companion-CLI rather than MCP, and
[`adr/0004-companion-ownership.md`](adr/0004-companion-ownership.md) for
why both companions are first-party (no third-party dependency).

### `kit/` — plugin authoring toolkit

Tools for plugin authors (internal and external):

```
kit/
├── README.md
└── lint/                   # Plugin-shape conformance (active, CI-gated)
                            #   - check-plugin-shape.mjs:
                            #       manifest required fields / name match across
                            #       .claude-plugin and .codex-plugin / skills path /
                            #       scripts executable bit / adapter traversal
                            #   - run via `npm run lint:plugin-shape`
                            #   - planned (not yet built): adapter-contract
                            #     conformance per ADR-0002 four-item rubric
```

Sub-directories `adapter-generator/` and `manifest-templates/` are
planned futures listed in [`kit/README.md`](../kit/README.md) but not
yet built — they are trigger-driven (3+ plugins in tree / external
contributor onboarding pain). See `kit/README.md` §"When to build kit
features".

### `plugins/` — reference dual-host plugins

Each plugin demonstrates the layered structure:

```
plugins/<plugin-name>/
├── .claude-plugin/plugin.json     # Claude Code plugin manifest
├── .codex-plugin/plugin.json      # Codex CLI plugin manifest
├── skills/                         # CORE: Agent Skills standard
│   └── <skill>/SKILL.md
├── personas/                       # CORE: persona description
│   └── <agent>.md
├── mcp-servers/                    # CORE: MCP server impls
├── prompt-templates/               # CORE: companion XML templates
└── adapters/                       # PER-HOST: thin where possible, medium where required
    ├── claude/
    │   └── hooks/hooks.json
    └── codex/
        ├── hooks/hooks.json
        └── agents/<agent>.toml      # Generated from personas/
```

See [`adr/0006-directory-layout-install-pattern.md`](adr/0006-directory-layout-install-pattern.md).

### `.claude-plugin/` and `.agents/plugins/` — marketplace catalogs

Each host's marketplace catalog at the repo root:

```
.claude-plugin/
└── marketplace.json        # Catalog for /plugin marketplace add each4all/agentic-plugins

.agents/
└── plugins/
    └── marketplace.json    # Catalog for codex plugin marketplace add each4all/agentic-plugins
```

### `docs/`

```
docs/
├── ARCHITECTURE.md         # This file
├── DEVELOPMENT.md          # How agentic-plugins is itself developed
└── adr/                    # Architecture Decision Records
```

---

## What is host-neutral vs host-specific

The split per [`adr/0001-hexagonal-architecture.md`](adr/0001-hexagonal-architecture.md):

| Concern | Layer | Why |
|---|---|---|
| SKILL.md content | CORE | Agent Skills open standard |
| MCP server impl | CORE | MCP open standard |
| Persona description (intent) | CORE | "What this agent does" is host-neutral |
| Prompt template (XML) | CORE | Companion contract is shared |
| Plugin manifest schema | ADAPTER | Different schemas per host |
| Hook event names | ADAPTER | Claude has 12 events, Codex has 6 |
| Hook payload semantics | ADAPTER | stdin near-1:1, stdout response divergent |
| Subagent format | ADAPTER | markdown+YAML (Claude) vs TOML (Codex) |
| Subagent invocation model | ADAPTER | Auto-delegate (Claude) vs explicit (Codex) |
| Continuity mechanism | ADAPTER | PreCompact (Claude) vs Stop-based (Codex) |
| Statusline / monitors | ADAPTER (Claude only) | Codex has no equivalent |
| Slash command surface | ADAPTER | `/plugin:skill` (Claude) vs `$skill` mention (Codex) |
| Companion bridge | COMPANION | Two scripts, one contract |

---

## What agentic-plugins does NOT try to unify

Per [`adr/0001-hexagonal-architecture.md`](adr/0001-hexagonal-architecture.md)
final note (the "honest scope" rule):

- Host-specific runtime semantics (auto-delegation, context lifecycle events) are NOT unified into a fake common API
- Each adapter implements its host's native pattern; core specifies *intent*, adapter specifies *execution*
- Where parity is impossible (e.g., statusline in Codex), the limit is documented, not papered over

This avoids the Electron-style "feels off in both" failure mode.

---

## Migration from omcc

agentic-plugins replaces omcc. omcc remains operational (Claude-only)
until agentic-plugins reaches the cutover criteria.

See [`adr/0007-migration-cutover-plan.md`](adr/0007-migration-cutover-plan.md)
for the full cutover plan: redesign-over-port stance, Stage 1–3
milestones, cutover trigger conditions, data migration policy
(clean start, no automated import), and the omcc archive procedure.

Stage progression:

- **Stage 1** (complete) — `plugins/companions` + `plugins/research` (research retired at Stage 2.5+ per [ADR-0014](adr/0014-plugins-research-deprecation.md); cited-brief contract absorbed into `engineer:investigate`). Bidirectional companion contract verified.
- **Stage 2** (complete) — `plugins/engineer` self-development plugin. See [`adr/0010-plugin-boundary-policy.md`](adr/0010-plugin-boundary-policy.md), [`adr/0011-workflow-continuity-storage.md`](adr/0011-workflow-continuity-storage.md), and the ADR-0017 / ADR-0020–0023 continuity follow-ups.
- **Stage 3+** (in progress) — `plugins/orchestrator` L2 capability is shipped for macro planning, same-host engineer dispatch, macro completion, meta continuity commands, and peer-runner-supervised Plan-verify. `plugins/runtime` is the ADR-0024 L1 runtime/operator primitive; as of `plugin-runtime` v0.39.0 it ships `runtime:doctor` readiness diagnostics with an observed experience-parity score, Claude plugin CLI diagnosis with slash `/plugin` observed only as host asymmetry, retired-plugin cleanup, and Codex `/hooks` review/trust when packaged hooks are ready, including explicit `Trust: New hook - review required` and `Active=0` blocker guidance plus manifest-declared Codex hook command-portability diagnostics, `runtime:settings` dry-run/apply planning with explicit plugin-management and retired-plugin cleanup execution artifacts, semantic failure classification for unavailable host plugin surfaces and sandboxed peer proof failures, Claude `claude plugin ...` install/update execution when the non-slash CLI is available, a narrow doctor-detected `claude plugin uninstall <plugin>@agentic-plugins` cleanup executor, manual follow-up checklists for host-native cleanup commands when cleanup is not executed or cannot complete, a narrow `--apply-codex-plugin-hooks` host-config executor, and an artifact-only `--attest-codex-hook-review` path for recording the operator-completed Codex `/hooks` review/trust step, sandbox-limited host auth diagnosis, retired plugin cleanup planning, `runtime:consensus` artifacts plus role-explicit peer lanes, an explicit `execute --execute` companion boundary, convergence taxonomy, contradiction-aware rebuttal prompts, and remediation metadata, `runtime:compat` host-version drift snapshots, explicit release-note gap planning, and operator-explicit release-note URL fetch via `--fetch-release-notes-url`, read-only `runtime:worktree` planning, runtime-owned `runtime:context` handoff artifacts with budget checks, source-freshness and dirty-worktree guidance, an explicit workflow-storage migration surface, read-only `runtime:cutover` omcc readiness auditing with explicit gate and unresolved-row details, runtime artifact inventory, the explicit non-interactive Codex hook trust-query boundary, and an advisory pointer-only completion footer with context/consensus/PR-readiness guidance plus conservative completion-state next actions. Automatic unbounded consensus loops, broad host-native config apply beyond Codex `[features].plugin_hooks`, implicit release-note URL fetch without operator opt-in, automatic host-session context mutation/compaction, general plugin uninstall, Codex trust-state mutation, artifact deletion, and richer cancellation/selection policy remain follow-up boundaries. `plugins/designer` remains a possible future design-domain L3 plugin. Same 4-layer composition.
- **Cutover** — declared by user when Stage 1–3 milestones met, ≥1 week sustained use without regression, and ≥1 clear improvement over omcc.
