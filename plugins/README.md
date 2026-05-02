# plugins/

Reference dual-host plugins. Each plugin works natively in both Claude
Code and OpenAI Codex CLI per the Hexagonal architecture
(`docs/adr/0001-hexagonal-architecture.md`).

## Status

**Empty.** First reference plugin to be selected and built in Stage 1
of the development plan (`docs/DEVELOPMENT.md`).

## Planned plugins (tentative)

Per `docs/adr/0007-migration-cutover-plan.md`, plugin names and
structures are agentic-plugins' own design — not 1:1 ports of omcc.
omcc plugins serve as **experiential reference**, not porting targets.

- **Stage 1**: research-domain reference plugin — references omcc-research's
  experience (single skill, ensemble protocol, graceful degradation).
  Plugin name, skill structure, and command surface are agentic-plugins'
  own design (decided when Stage 1 starts)
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
