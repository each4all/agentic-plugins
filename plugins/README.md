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
- **`engineer/`** — Stage 2 L3 persona plugin: 6 universal cognitive
  verbs (`investigate`, `frame`, `decide`, `compose`, `critique`,
  `refine`) plus the `audit` sugar alias, with bidirectional
  companion ensemble (Claude → Codex via `codex-companion`, Codex →
  Claude via `claude-companion`) under an always-max policy. The
  `investigate` verb ships three profiles — `analysis`, `root-cause`,
  and `cited-brief`; the cited-brief profile absorbs the Stage 1
  `plugins/research` contract per
  [ADR-0014](../docs/adr/0014-plugins-research-deprecation.md). See
  [`plugins/engineer/README.md`](engineer/README.md) for install,
  invocation, and environment details (including the
  `RESEARCH_OUTPUT_ROOT` env var preserved from Stage 1 for
  backwards compatibility).
- **`orchestrator/`** — Stage 3+ L2 capability plugin (plan-only MVP
  per [ADR-0018](../docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md)
  §sub-decision-1): macro plan + Plan-verify Codex peer ensemble for
  multi-deliverable features. First multi-verb L2 occupant; the
  `/orchestrator:plan` command produces `plan.subtasks[]` proposals
  (a list of deliverables) that future engineer workflows drive
  end-to-end. Workflow files at `<repo>/.claude/agentic-orchestrator/
  workflows/<workflow_id>.md` with frontmatter `schema: '1.0'` and
  `workflow_id: macro-<verb>-<iso>-<rand>`. Stop hook is snapshot-
  only in this MVP; auto-archive ships in a follow-up PR alongside
  `/orchestrator:next` and `/orchestrator:done`. See
  [`plugins/orchestrator/README.md`](orchestrator/README.md).

The Stage 1 `plugins/research` reference plugin was retired at
Stage 2.5+ per
[ADR-0014](../docs/adr/0014-plugins-research-deprecation.md);
its cited-brief contract is now folded into `engineer:investigate`,
and saved `research_brief.md` artifacts from the Stage 1 period
remain forward-compatible with the cited-brief profile's audit
and parse logic.

## Planned plugins (tentative)

Per `docs/adr/0007-migration-cutover-plan.md`, plugin names and
structures are agentic-plugins' own design — not 1:1 ports of omcc.
omcc plugins serve as **experiential reference**, not porting targets.

- **Stage 3+**: design-domain plugin — references omcc-designer's
  experience (poster, social-graphics, frontend, brief, evaluation,
  etc.) with the same redesign stance and the same 4-layer
  composition model

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
