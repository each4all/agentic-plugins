# plugins/

Reference dual-host plugins. Each plugin works natively in both Claude
Code and OpenAI Codex CLI per the Hexagonal architecture
(`docs/adr/0001-hexagonal-architecture.md`).

## Shipped plugins

- **`companions/`** — first-party Claude/Codex companion bridges
  (claude-companion, codex-companion) per `companions/contract.md`
  v0.1.1. Script-only library plugin per
  [ADR-0008](../docs/adr/0008-companion-distribution-model.md). Consumer
  plugins discover the bundled scripts via cache-glob (or
  `AGENTIC_COMPANIONS_ROOT` env override). See
  [`plugins/companions/README.md`](companions/README.md) for install,
  discovery, and drift-protection details.
- **`research/`** — Stage 1 reference plugin: topic-bound research
  producing a durable cited brief, with bidirectional companion
  ensemble (Claude → Codex via `codex-companion`, Codex → Claude via
  `claude-companion`). Per
  [ADR-0007](../docs/adr/0007-migration-cutover-plan.md), this plugin
  references omcc-research as a lesson source, not a 1:1 port; the
  redesign moves to host-neutral `LOCAL-ONLY/PEER-ONLY` synthesis,
  drops the cross-plugin backtick-prohibition workaround, and adds
  `RESEARCH_OUTPUT_ROOT` sandboxing. See
  [`plugins/research/README.md`](research/README.md) for install,
  invocation, and environment details.

## Planned plugins (tentative)

Per `docs/adr/0007-migration-cutover-plan.md`, plugin names and
structures are agentic-plugins' own design — not 1:1 ports of omcc.
omcc plugins serve as **experiential reference**, not porting targets.

- **Stage 2**: self-development plugin (name TBD) — references
  omcc-dev's workflow experience (`/start`, `/fix`, `/audit`, brainstorm,
  continuity, ensemble, etc.). Keep what works, redesign what doesn't,
  scope to what genuinely benefits from dual-host. From this point,
  agentic-plugins can develop itself in dual-host form
- **Stage 3+**: design-domain plugin — references omcc-designer's
  experience (poster, social-graphics, frontend, brief, evaluation,
  etc.) with the same redesign stance. Plus any remaining omcc-dev
  workflow patterns not covered in Stage 2

## Plugin layout convention

Per `docs/adr/0006-directory-layout-install-pattern.md`:

```
plugins/<plugin-name>/
├── .claude-plugin/plugin.json     # Claude Code plugin manifest
├── .codex-plugin/plugin.json      # Codex CLI plugin manifest
├── skills/                         # CORE: Agent Skills standard
│   └── <skill>/SKILL.md
├── personas/                       # CORE: persona description
│   └── <agent>.md
├── mcp-servers/                    # CORE: MCP server impls (optional)
├── prompt-templates/               # CORE: companion XML templates (optional)
└── adapters/                       # PER-HOST: thin where possible
    ├── claude/
    │   └── hooks/hooks.json
    └── codex/
        ├── hooks/hooks.json
        └── agents/<agent>.toml
```

CORE files (`skills/`, `personas/`, `mcp-servers/`, `prompt-templates/`)
are host-neutral. ADAPTER files (`adapters/{claude,codex}/`) are
host-specific and as thin as the host's runtime model permits.

**Script-only library plugin exception** (per ADR-0008 § (a)): a plugin
that ships only `scripts/` and the two host manifests — no `commands/`,
`hooks/`, `agents/`, `personas/`, `skills/`, or `mcp-servers/` content
— may omit the `adapters/` subtree. The `companions` plugin is the
canonical example. User-facing plugins continue to follow the full
layout above.
