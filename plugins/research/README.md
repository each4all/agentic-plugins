# research plugin

Topic-bound research producing a durable cited research brief, with a
**bidirectional companion ensemble** — when invoked on Claude Code,
calls `codex-companion` for a Codex peer perspective; when invoked on
Codex CLI, calls `claude-companion` for a Claude peer perspective.
The peer's findings are reconciled into the saved brief through a
4-category synthesis taxonomy (`AGREED` / `LOCAL-ONLY` / `PEER-ONLY` /
`CONFLICT`) and Citation Remapping per
[`skills/research/references/ensemble-protocol.md`](skills/research/references/ensemble-protocol.md).

The brief is saved as `./output/YYYY-MM-DD_<topic-slug>/research_brief.md`
with the structure defined in
[`skills/research/references/research-brief-spec.md`](skills/research/references/research-brief-spec.md).
Set the `RESEARCH_OUTPUT_ROOT` environment variable to an absolute
path to redirect `./output/` to a sandbox of your choice.

This plugin is the Stage 1 reference plugin for agentic-plugins per
[ADR-0007](../../docs/adr/0007-migration-cutover-plan.md). It
references the omcc-research experience as a *lesson source*, not a
1:1 port — see
[`skills/research/SKILL.md`](skills/research/SKILL.md) for the
redesigned Step 1-4 flow.

## Install

The research plugin discovers companion scripts via cache-glob, so
the [`companions`](../companions/) plugin must be installed
alongside it. Install order does not matter for cache-glob discovery,
but auto-mode and command-mode both degrade gracefully when companions
are absent (research proceeds local-only).

### Claude Code

```sh
/plugin marketplace add each4all/agentic-plugins
/plugin install companions@agentic-plugins
/plugin install research@agentic-plugins
```

### Codex CLI

```sh
codex plugin marketplace add each4all/agentic-plugins
```

Then enable both plugins by adding the following to
`~/.codex/config.toml` (codex-cli 0.128.0 does not expose an in-app
enable command):

```toml
[plugins."companions@agentic-plugins"]
enabled = true

[plugins."research@agentic-plugins"]
enabled = true
```

## Invocation

### Claude Code (slash command)

```text
/research:research <topic>
```

Example:

```text
/research:research Node 24 child_process API surface
```

### Codex CLI (skill mention)

```text
$research <topic>
```

Example:

```text
$research current TLS 1.3 0-RTT considerations
```

In both cases, the skill walks through Step 1-4 of
[`skills/research/SKILL.md`](skills/research/SKILL.md): topic intake +
privacy gate → research execution → synthesis → output assembly.

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `RESEARCH_OUTPUT_ROOT` | Absolute path that replaces `./output/` as the per-topic-directory root. Sandboxes writes to this path. | `./output/` |
| `AGENTIC_COMPANIONS_ROOT` | Absolute path containing `claude-companion.mjs` and `codex-companion.mjs`; bypasses cache-glob discovery. Useful for development workflows pointing at a source-tree checkout. | (cache-glob fallback) |

`RESEARCH_OUTPUT_ROOT` requires an absolute path; relative paths and
tilde-prefixed paths are rejected and the skill falls back to
`./output/`. See
[`skills/research/references/output-file-rules.md`](skills/research/references/output-file-rules.md)
for the full sandbox semantics.

## What it does NOT do

- **Decision-bound option comparison** — research gathers evidence
  organized by sub-questions; it does not pick winners between options.
- **Recommendation sections** — the brief states evidence and
  confidence, never a chosen direction.
- **Inline source-of-discovery labels** — the brief carries only
  numeric `[N]` citations. Whether a peer ensemble ran is communicated
  in the user-facing completion summary, never inside the brief.

These constraints are enforced by the audit checklist in
[`skills/research/references/research-brief-spec.md`](skills/research/references/research-brief-spec.md).

## References

- [ADR-0001](../../docs/adr/0001-hexagonal-architecture.md) — layered
  separation (CORE / ADAPTER / COMPANION); skill protocol is CORE,
  companion mechanics are in `adapters/<host>/scripts/`
- [ADR-0006](../../docs/adr/0006-directory-layout-install-pattern.md)
  — per-plugin layout this plugin follows
- [ADR-0007](../../docs/adr/0007-migration-cutover-plan.md) — redesign
  stance: omcc-research is the lesson source, not a port target
- [ADR-0008](../../docs/adr/0008-companion-distribution-model.md) —
  cache-glob discovery + `AGENTIC_COMPANIONS_ROOT` env override
  contract that this plugin's adapter scripts implement
- [ADR-0009](../../docs/adr/0009-companion-contract-v0-1-1-prompt-file-stdin-precedence.md)
  — companion contract v0.1.1: the `--prompt-file` precedence fix that
  makes background-Bash adapter invocation work
- [`companions/contract.md`](../../companions/contract.md) — wire-spec
  contract v0.1.1 honored by the bundled companion scripts
- [`plugins/companions/`](../companions/) — script-only library plugin
  the research adapter discovers
