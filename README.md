# agentic-plugins

Cross-host AI agent collaboration framework.

agentic-plugins bridges Anthropic's Claude Code and OpenAI's Codex CLI as peer
agents. Plugins authored once run natively in either host, and each host
can invoke the other as a peer agent through bidirectional companion
bridges owned by agentic-plugins.

## Status

Stage 1: companion layer + first reference plugin shipped. The
architecture and foundational decisions are captured in
[`docs/adr/`](docs/adr/) and the overall design in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Stage roadmap lives in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

### Available now

The `companions/` layer is wire-spec complete (`v0.1.1`) with both
bridges implemented and tested:

- [`companions/contract.md`](companions/contract.md) — wire contract
- [`companions/claude-companion.mjs`](companions/claude-companion.mjs) — Codex → Claude bridge
- [`companions/codex-companion.mjs`](companions/codex-companion.mjs) — Claude → Codex bridge

Six installable plugins ship in this repository:

- [`plugins/companions/`](plugins/companions/) — script-only library
  plugin that bundles the canonical companion CLIs for cache-glob
  discovery by consumer plugins (per
  [ADR-0008](docs/adr/0008-companion-distribution-model.md))
- [`plugins/engineer/`](plugins/engineer/) — Stage 2 L3 persona
  plugin: 6 universal cognitive verbs (investigate / frame / decide
  / compose / critique / refine) with bidirectional companion
  ensemble. The investigate verb's `cited-brief` profile produces
  durable cited research artifacts (absorbing the Stage 1
  `plugins/research` contract per
  [ADR-0014](docs/adr/0014-plugins-research-deprecation.md))
- [`plugins/founder/`](plugins/founder/) — second L3 persona plugin
  for new-business planning per
  [ADR-0036](docs/adr/0036-founder-persona-business-planning.md)
  (Accepted): the six universal cognitive verbs (investigate / frame
  / decide / compose / critique / refine) re-anchored to business
  concerns (markets, unit-economics, regulation, competition), with
  the business ensemble protocol, the `founder:start` lifecycle macro,
  and resume / checkpoint / peer-now meta skills
- [`plugins/image/`](plugins/image/) — L2 capability plugin for
  cross-host image generation via Codex's integrated gpt-image
  ([ADR-0037](docs/adr/0037-image-capability-plugin.md)): the six
  cognitive verbs (investigate / frame / decide / compose / critique /
  refine); generation runs only through Codex's integrated gpt-image
  (never a direct OpenAI API call), with the Claude host dispatching
  through the `codex-companion` bridge and results returned by
  shared-filesystem path. Lean L2 — no workflow-continuity machinery.
- [`plugins/orchestrator/`](plugins/orchestrator/) — Stage 3+ L2
  capability plugin per
  [ADR-0018](docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md)
  §sub-decision-1 and
  [ADR-0019](docs/adr/0019-cross-plugin-invocation-contract.md):
  macro plan, Plan-verify opposite-host peer ensemble, same-host
  engineer dispatch, manual completion backup, finalize/abort
  lifecycle, meta continuity commands, and macro auto-archive.
- [`plugins/runtime/`](plugins/runtime/) — Stage 3+ L1 framework
  primitive per
  [ADR-0024](docs/adr/0024-runtime-operator-control-plane.md):
  `runtime:doctor` readiness diagnostics, dry-run/default
  `runtime:settings`, explicit `runtime:consensus` companion execution
  artifacts, `runtime:compat` host-version drift planning, read-only
  `runtime:worktree` planning, `runtime:context` handoff/check artifacts,
  read-only `runtime:cutover` readiness evidence, workflow-storage migration,
  and the pointer-only completion footer.

See each plugin's README for install commands, invocation, and
environment details.

The earlier Stage 1 `plugins/research` reference plugin was retired
at Stage 2.5+ per
[ADR-0014](docs/adr/0014-plugins-research-deprecation.md); its
cited-brief contract is now folded into `engineer:investigate`.

### Current follow-ups

- Runtime artifact retention/deletion and richer consensus cancellation
  policy
- Host-native config apply beyond agentic-plugins-owned config
- Risk/budget-driven consensus peer selection and automated synthesis
  policy
- Non-interactive auth story for CI smoke tests (DEVELOPMENT.md Risk #4)

## Concepts

- **Hexagonal architecture** — host-neutral CORE + per-host ADAPTER + bidirectional COMPANION
- **Bidirectional companions** — `claude-companion` (Codex → Claude) and `codex-companion` (Claude → Codex), both owned by agentic-plugins
- **Standards-aligned core** — [Agent Skills](https://agentskills.io) for skills, [Model Context Protocol](https://modelcontextprotocol.io) for tools
- **Native install** — each host uses its own plugin manager; agentic-plugins does not unify install UX

## For consumers

```sh
# Claude Code
claude plugin marketplace add each4all/agentic-plugins
claude plugin install companions@agentic-plugins
claude plugin install engineer@agentic-plugins
claude plugin install founder@agentic-plugins
claude plugin install image@agentic-plugins
claude plugin install orchestrator@agentic-plugins
claude plugin install runtime@agentic-plugins

# OpenAI Codex CLI
codex plugin marketplace add each4all/agentic-plugins
codex plugin add runtime@agentic-plugins
# repeat `codex plugin add <plugin>@agentic-plugins` per plugin — the add
# command records `enabled = true` in ~/.codex/config.toml itself; a manual
# enable edit is only a fallback when a post-check still shows it disabled
```

Each plugin's README documents its invocation surface and environment
variables. Once `runtime` is installed, `runtime:bootstrap` conducts the rest
of the machine setup (staged plan, rendered fragments, presented installs,
proofs) — see
[`plugins/runtime/docs/machine-bootstrap-contract.md`](plugins/runtime/docs/machine-bootstrap-contract.md).

## For developers

- [`AGENTS.md`](AGENTS.md) — primary development guidance (cross-tool standard)
- [`CLAUDE.md`](CLAUDE.md) — Claude Code reference into AGENTS.md
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — overall design
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — how agentic-plugins is itself developed (dogfooding plan)
- [`docs/adr/`](docs/adr/) — architecture decision records

## Relationship to omcc

agentic-plugins is the dual-host successor to [omcc](https://github.com/e16tae/omcc).
omcc remains operational (Claude-only) until agentic-plugins reaches feature
parity. See [`docs/adr/0007-migration-cutover-plan.md`](docs/adr/0007-migration-cutover-plan.md)
for the cutover plan and
[`docs/assurance/omcc-cutover-scorecard.md`](docs/assurance/omcc-cutover-scorecard.md)
for the current requirement-to-evidence scorecard.

## License

[MIT](LICENSE).
