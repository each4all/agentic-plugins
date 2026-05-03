# agentic-plugins

Cross-host AI agent collaboration framework.

agentic-plugins bridges Anthropic's Claude Code and OpenAI's Codex CLI as peer
agents. Plugins authored once run natively in either host, and each host
can invoke the other as a peer agent through bidirectional companion
bridges owned by agentic-plugins.

## Status

Stage 1 in progress. The companion layer ships now; reference plugins
follow. The architecture and foundational decisions are captured in
[`docs/adr/`](docs/adr/) and the overall design in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Stage roadmap lives in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

### Available now

The `companions/` layer is wire-spec complete (`v0.1.0`) with both
bridges implemented and tested:

- [`companions/contract.md`](companions/contract.md) — wire contract
- [`companions/claude-companion.mjs`](companions/claude-companion.mjs) — Codex → Claude bridge
- [`companions/codex-companion.mjs`](companions/codex-companion.mjs) — Claude → Codex bridge

See [`companions/README.md`](companions/README.md) for invocation
quickstart and the directional table.

### Coming next

- Top-level `package.json` + `bin` entries so companions install on PATH
- GitHub Actions CI (per-host test gates + marketplace JSON validation)
- First reference plugin (Stage 1 exit criterion per DEVELOPMENT.md)

## Concepts

- **Hexagonal architecture** — host-neutral CORE + per-host ADAPTER + bidirectional COMPANION
- **Bidirectional companions** — `claude-companion` (Codex → Claude) and `codex-companion` (Claude → Codex), both owned by agentic-plugins
- **Standards-aligned core** — [Agent Skills](https://agentskills.io) for skills, [Model Context Protocol](https://modelcontextprotocol.io) for tools
- **Native install** — each host uses its own plugin manager; agentic-plugins does not unify install UX

## For consumers

Install paths for plugins will be documented once the first reference
plugin ships:

```
# Claude Code (planned)
/plugin marketplace add each4all/agentic-plugins

# OpenAI Codex CLI (planned)
codex plugin marketplace add each4all/agentic-plugins
```

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
