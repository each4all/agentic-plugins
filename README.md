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

Two installable plugins ship in this repository:

- [`plugins/companions/`](plugins/companions/) — script-only library
  plugin that bundles the canonical companion CLIs for cache-glob
  discovery by consumer plugins (per
  [ADR-0008](docs/adr/0008-companion-distribution-model.md))
- [`plugins/research/`](plugins/research/) — Stage 1 reference plugin:
  topic-bound research producing a durable cited brief, with
  bidirectional companion ensemble. References omcc-research as
  lesson source, not a 1:1 port (per
  [ADR-0007](docs/adr/0007-migration-cutover-plan.md))

See each plugin's README for install commands, invocation, and
environment details.

### Coming next

- Stage 2: self-development plugin (omcc-dev workflow patterns
  redesigned for dual-host)
- Marketplace catalog schema docs and broader `kit/lint/` adapter
  conformance checks
- Non-interactive auth story for CI smoke tests (DEVELOPMENT.md Risk #4)

## Concepts

- **Hexagonal architecture** — host-neutral CORE + per-host ADAPTER + bidirectional COMPANION
- **Bidirectional companions** — `claude-companion` (Codex → Claude) and `codex-companion` (Claude → Codex), both owned by agentic-plugins
- **Standards-aligned core** — [Agent Skills](https://agentskills.io) for skills, [Model Context Protocol](https://modelcontextprotocol.io) for tools
- **Native install** — each host uses its own plugin manager; agentic-plugins does not unify install UX

## For consumers

```sh
# Claude Code
/plugin marketplace add each4all/agentic-plugins
/plugin install companions@agentic-plugins
/plugin install research@agentic-plugins

# OpenAI Codex CLI
codex plugin marketplace add each4all/agentic-plugins
# then enable plugins in ~/.codex/config.toml — see plugins/companions/README.md
```

Each plugin's README documents its invocation surface and environment
variables.

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
for the cutover plan.

## License

[MIT](LICENSE).
