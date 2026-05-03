# companions/

Bidirectional companion bridges between Claude Code and OpenAI Codex CLI.

## Status

Stage 1 companion layer complete: contract `v0.1.0` plus both implementations
shipped (PRs #1, #2, #3 merged on main). See `docs/DEVELOPMENT.md` § Stage 1
for the broader Stage 1 scope.

## Contents

- **[`contract.md`](contract.md)** — wire-spec contract that both companions
  implement. Pin-point reference for: invocation surface (CLI subcommand +
  flags), prompt structure (XML vocabulary), output convention (text +
  optional JSON envelope), error semantics (exit codes + named error
  kinds). Versioned independently (current: `v0.1.0`).
- **[`claude-companion.mjs`](claude-companion.mjs)** — Codex → Claude peer-agent
  invocation. Shells out to the public `claude -p` CLI.
- **[`codex-companion.mjs`](codex-companion.mjs)** — Claude → Codex peer-agent
  invocation. Shells out to the public `codex exec` CLI.
- **[`tests/`](tests/)** — hermetic unit tests (`*.test.mjs`, mocked spawn) plus
  env-gated smoke tests (`*.smoke.test.mjs`) against the real peer CLIs.

## Which companion to invoke

The companion is named after the **peer it reaches**, not the caller:

| If your plugin runs under | …and wants to invoke | …shell out to |
|---|---|---|
| Claude Code | Codex CLI | `companions/codex-companion.mjs` |
| Codex CLI | Claude Code | `companions/claude-companion.mjs` |

## Quickstart

Both scripts have `#!/usr/bin/env node` shebangs and are mode `0755`.
Invoke with the prompt on stdin (Decision 3 — stdin-only delivery):

```bash
# Claude → Codex (text mode)
echo '<task>Reply OK</task>' | companions/codex-companion.mjs task

# Claude → Codex (JSON envelope)
echo '<task>Reply OK</task>' | companions/codex-companion.mjs task --output-format json
```

`claude-companion.mjs` invocation is symmetric. Both scripts honor the
five pinned options from contract § 2.2: `--prompt-file`, `--model`,
`--effort`, `--cwd`, `--output-format`. Exit codes follow contract § 5.1
(`0` success, `1` peer run error, `2` companion misuse, `3` peer infra error).

## Tests

```bash
# Hermetic unit tests (mocked spawn, no network, fast)
node --test companions/tests/claude-companion.test.mjs
node --test companions/tests/codex-companion.test.mjs

# Env-gated smoke tests against real peer CLIs (require auth + network)
COMPANIONS_SMOKE=1 node --test companions/tests/claude-companion.smoke.test.mjs
COMPANIONS_SMOKE=1 node --test companions/tests/codex-companion.smoke.test.mjs
```

## Why companions and not MCP?

Companions are for **peer-agent invocation** — full-turn delegation where
the peer agent uses its own tools and reasoning. MCP is for stateless
atomic tool calls. See [`docs/adr/0003-mcp-vs-companion.md`](../docs/adr/0003-mcp-vs-companion.md).

## Why first-party and not third-party?

To control the contract and avoid third-party version coupling. Both
companions live in this repository, share `contract.md`, and shell out
only to the **public** peer-host CLIs (`claude -p`, `codex exec`). See
[`docs/adr/0004-companion-ownership.md`](../docs/adr/0004-companion-ownership.md)
and § 6 Out of Scope in [`contract.md`](contract.md) for the explicit
non-port boundary against omcc-codex-companion's internal app-server
APIs.
