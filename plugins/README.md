# plugins/

Reference dual-host plugins. Each plugin works natively in both Claude
Code and OpenAI Codex CLI per the Hexagonal architecture
(`docs/adr/0001-hexagonal-architecture.md`).

## Shipped plugins

- **`attention/`** — hook-only L1 attention sensors per
  [ADR-0040 §3](../docs/adr/0040-operator-observability.md): Claude
  `Notification` (permission_prompt → approval/urgent, idle_prompt →
  idle), `Stop` (workflow-terminal behind a freshness-checked
  session-handoff projection read, else bare turn-complete), and
  `SubagentStop` (subagent-complete) sensors that resolve the runtime
  plugin root via a version-gated `discover-runtime.mjs` copy
  (runtime ≥ 0.71.0) and shell out to `notify.mjs emit`. **Hook-only**
  — hooks + sensor scripts, no skills/verbs/state machinery, the
  hook-bearing sibling of the script-only shape; fail-closed silent
  observers (exit 0 always, never stdout, no decision output); no
  Codex hooks at v1. See
  [`plugins/attention/README.md`](attention/README.md).
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
- **`founder/`** — second L3 persona plugin for new-business planning
  per [ADR-0036](../docs/adr/0036-founder-persona-business-planning.md):
  the six universal cognitive verbs (`investigate`, `frame`, `decide`,
  `compose`, `critique`, `refine`) re-anchored to business concerns
  (markets, unit-economics, regulation, competition), with the business
  ensemble protocol, the `founder:start` lifecycle macro, and the
  resume / checkpoint / peer-now meta skills. The `investigate` and
  `frame` verbs carry founder-owned in-persona contracts (5-tier
  business source taxonomy + privacy gate in `business-brief-spec.md`,
  business Task Profile in `orchestration.md`) — copies, not imports,
  per [ADR-0010](../docs/adr/0010-plugin-boundary-policy.md) §5.
  Accepted as a complete L3 persona (2026-06-15). See
  [`plugins/founder/README.md`](founder/README.md).
- **`image/`** — L2 capability plugin for cross-host image generation via
  Codex's integrated gpt-image
  ([ADR-0037](../docs/adr/0037-image-capability-plugin.md)): the six
  cognitive verbs (`investigate`, `frame`, `decide`, `compose`, `critique`,
  `refine`), with generation only through Codex's integrated gpt-image
  (never a direct OpenAI API call) and the Claude host dispatching through
  `codex-companion`. **Lean L2** — verb skills + commands + dispatch helpers
  (`compose-dispatch`, `brief-validate`, `variant-select`,
  `critique-dispatch`, `refine-dispatch`); no workflow-continuity machinery
  (no `state.mjs`/hooks/start/meta). compose / critique / refine are verified
  end-to-end with real gpt-image generation. See
  [`plugins/image/README.md`](image/README.md).
- **`orchestrator/`** — Stage 3+ L2 capability plugin per
  [ADR-0018](../docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md)
  §sub-decision-1 and [ADR-0019](../docs/adr/0019-cross-plugin-invocation-contract.md):
  macro plan, Plan-verify peer ensemble, same-host engineer dispatch,
  manual completion backup, finalize/abort lifecycle, and macro
  auto-archive A1-A4. First multi-verb L2 occupant; workflow files live
  at `<repo>/.agentic-plugins/state/orchestrator/workflows/<workflow_id>.md`
  for new repos, with legacy `.claude/agentic-orchestrator/` state
  supported until explicit migration. Files use frontmatter
  `schema: '1.1'`, `workflow_type: macro`, and
  `workflow_id: macro-<verb>-<iso>-<rand>`. See
  [`plugins/orchestrator/README.md`](orchestrator/README.md).
- **`runtime/`** — Stage 3+ L1 framework primitive per
  [ADR-0024](../docs/adr/0024-runtime-operator-control-plane.md):
  read-only `doctor` diagnostics for host CLI/auth readiness,
  marketplace/cache/plugin state, companion contract compatibility,
  model/effort observation, companion sandbox/permission readiness, and
  workflow/peer-run ledger health. `settings`, dynamic consensus,
  context hygiene, and completion footer work are deferred. See
  [`plugins/runtime/README.md`](runtime/README.md).

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

- **Future**: design-domain plugin — references omcc-designer's
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

**Hook-only plugin exception** (per ADR-0040 §3): a plugin that ships
only `hooks/hooks.json`, its hook entry scripts under
`adapters/<host>/hooks/`, and supporting `scripts/` — no functional
skills, no verbs, no state machinery — is the hook-bearing sibling of
the script-only shape. The Codex manifest's required `skills` field is
satisfied by an empty `skills/` placeholder per the ADR-0008 carve-out.
`kit/lint/check-plugin-shape.mjs` validates the hook registration
structurally (event → matcher groups → `type: "command"` entries) and
verifies every `${CLAUDE_PLUGIN_ROOT}/…` command target exists inside
the plugin. The `attention` plugin is the canonical example.
