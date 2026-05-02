# agentic-plugins — Architecture

> Cross-host AI agent collaboration framework.
> Plugins author once, run natively in either Claude Code or OpenAI
> Codex CLI, with bidirectional companion bridges.

This document is the architectural overview. The foundational decisions
behind it live in [`adr/`](adr/) — when a section here references "why"
it points to an ADR rather than restating the rationale.

---

## The three layers

agentic-plugins applies **Hexagonal architecture** (ports and adapters) to AI
agent plugins:

```
┌──────────────────────────────────────────────────────────┐
│ COMPANION (bidirectional bridges, first-party)        │
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

See [`adr/0001-hexagonal-architecture.md`](adr/0001-hexagonal-architecture.md).

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
├── adapter-generator/      # Generate per-host adapter scaffolding from core spec
├── manifest-templates/     # Boilerplate plugin.json for each host
└── lint/                   # Adapter-contract conformance checks
```

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

agentic-plugins replaces omcc. omcc remains operational (Claude-only) until
agentic-plugins reaches feature parity. See
[`adr/0007-migration-cutover-plan.md`](adr/0007-migration-cutover-plan.md)
for the cutover plan (stub — to be filled in the next development session).
