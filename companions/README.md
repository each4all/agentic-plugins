# companions/

Bidirectional companion bridges between Claude Code and OpenAI Codex CLI.

## Status

Stage 1 companion layer complete: contract `v0.1.1` (amended from
v0.1.0 per ADR-0009) plus both implementations shipped (PRs #1, #2,
#3 merged on main). See `docs/DEVELOPMENT.md` § Stage 1 for the
broader Stage 1 scope.

## Contents

- **[`contract.md`](contract.md)** — wire-spec contract that both companions
  implement. Pin-point reference for: invocation surface (CLI subcommand +
  flags), prompt structure (XML vocabulary), output convention (text +
  optional JSON envelope), error semantics (exit codes + named error
  kinds). Versioned independently (current: `v0.1.1`).
- **[`claude-companion.mjs`](claude-companion.mjs)** — Codex → Claude peer-agent
  invocation. Shells out to the public `claude -p` CLI.
- **[`codex-companion.mjs`](codex-companion.mjs)** — Claude → Codex peer-agent
  invocation. Shells out to the public `codex exec` CLI.
- **[`peer-cli.mjs`](peer-cli.mjs)** — how both companions start their peer
  CLI without a shell: the `CODEX_BIN` / `CLAUDE_BIN` override, then the
  platform's lookup (§ Peer CLI resolution below).
- **[`cli-entry.mjs`](cli-entry.mjs)** — the canonical CLI entry guard the two
  companions and `discover-peer.mjs` import.
- **[`tests/`](tests/)** — hermetic unit tests (`*.test.mjs`, mocked spawn) plus
  env-gated smoke tests (`*.smoke.mjs`) against the real peer CLIs. Smoke tests
  use the `*.smoke.mjs` name (outside Node's default discovery) so `npm test`
  never runs them; invoke them explicitly via `npm run test:smoke` (ADR-0033).

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

# Codex → Claude (text mode)
echo '<task>Reply OK</task>' | companions/claude-companion.mjs task

# Codex → Claude (JSON envelope)
echo '<task>Reply OK</task>' | companions/claude-companion.mjs task --output-format json
```

Both directions use the same `task` subcommand, prompt-input
precedence, JSON envelope option, and exit-code contract. Both scripts
honor the five pinned options from contract § 2.2: `--prompt-file`,
`--model`, `--effort`, `--cwd`, `--output-format`. Exit codes follow
contract § 5.1 (`0` success, `1` peer run error, `2` companion misuse,
`3` peer infra error).

## Peer CLI resolution

Each companion decides how to start its peer CLI (`codex`, `claude`) in
`peer-cli.mjs` before it spawns anything, and spawns it without
`shell: true`. (On Linux, glibc's `execvp` itself runs an executable text
file that has no `#!` line through `/bin/sh`; a real CLI has one.) This is
implementation behaviour, not part of the wire contract: a failure is the
existing contract § 5.3 row `companion_error` / exit `3` /
`peer_cli_not_found`, whose message names the override variable.

1. **Override**: `CODEX_BIN` (for `codex-companion.mjs`) or `CLAUDE_BIN` (for
   `claude-companion.mjs`), on every platform, when set and non-empty. A value
   with a path separator is a path, relative ones resolved against the
   companion's working directory; a value without one is a file name looked up
   on `PATH` (`CODEX_BIN=codex-nightly`). An override that names no file, a
   directory, or something that cannot run is an error naming the variable:
   the companion never falls back to `PATH`. On Windows an override may name
   an `.exe` or `.com`, an npm `.cmd` shim, or a JavaScript file (run with the
   companion's own Node); a drive-relative value such as `C:codex.exe` is
   refused.
2. **macOS and Linux**: the bare name, which `spawn` looks up on `PATH` as it
   always has.
3. **Windows**: the `PATH` directories in order (the working directory is not
   searched, and `PATHEXT` is ignored), each trying `<name>.exe`, then
   `<name>.cmd`. An `.exe` runs as is. A `.cmd` is read as an npm cmd-shim and
   is never run itself: a node shim (the `npm install -g @openai/codex` case)
   runs its target script as `process.execPath <target>`, and a shim with no
   program whose target is an `.exe` (the `npm install -g
   @anthropic-ai/claude-code` case, whose bin is `claude.exe`) runs that
   `.exe`. The first hit is final, so an unreadable or malformed shim in an
   earlier directory is reported rather than skipped.

**Windows limits** (honest scope, ADR-0001): only the npm cmd-shim layout is
read (every layout cmd-shim 2.x to 9.x writes); a shim that runs another
program, passes shebang arguments or sets variables is refused, as are `.ps1`,
`.bat` and extensionless shims; the companion's own Node replaces a
`node.exe` installed beside the shim. A cancel ends the process the companion
started: for the node `codex` shim that is the Node launcher, and the native
`codex` it starts may outlive it. Windows is verified by tests that simulate
the platform, `PATH` and a shim tree in process; there is no Windows CI job.
When a launch fails, set the variable to the CLI's executable.

An override path is normalized before it is checked, as `path.resolve` does
(`a/../b` is `b`, without asking whether `a` exists or is a link), and an
override or shim target that is a JavaScript file the user may not read
passes the check and fails in Node, reported as a peer run error (exit 1)
rather than `peer_cli_not_found`; both take a hand-made path or file.

An override name without a separator is looked up in the `PATH` entries
only, each resolved to an absolute path: unlike a shell, an empty `PATH`
entry does not stand for the working directory. The companions' own unit
tests stub `spawn` and resolve the peer the Linux and macOS way; the Windows
lookup is held by `tests/peer-cli.test.mjs`, which simulates it.

## Tests

```bash
# Hermetic unit tests (mocked spawn, no network, fast)
node --test companions/tests/claude-companion.test.mjs
node --test companions/tests/codex-companion.test.mjs
node --test companions/tests/peer-cli.test.mjs

# Env-gated smoke tests against real peer CLIs (require auth + network)
COMPANIONS_SMOKE=1 node --test companions/tests/claude-companion.smoke.mjs
COMPANIONS_SMOKE=1 node --test companions/tests/codex-companion.smoke.mjs
```

## Nested peer invocation guard

A peer run is a full agent turn, and that agent can run shell commands —
including the *other* companion. Nothing in the wire contract stops
`claude → codex-companion → codex → claude-companion → claude → …` from
recursing; that bound would otherwise be accidental. Measured 2026-08-22
(claude 2.1.239 / codex-cli 0.148.0): `codex → claude-companion → claude`
already completed a nested round trip in the lab, and `claude → codex →
claude-companion` spawned the nested `claude -p` and was stopped only by
the codex sandbox's network. None of the 168 recorded peer runs on this
machine had ever executed a nested companion — the prompts have not
triggered it, but nothing prevented it.

Both companions carry a **cooperative** guard (companion-internal — no
contract-surface change; contract § 2.4 still holds, nothing is *required*
in the environment):

- Every companion stamps the peer CLI it spawns with
  `AGENTIC_COMPANION_DEPTH=<depth+1>`.
- A companion that starts with `AGENTIC_COMPANION_DEPTH` already at or above
  `AGENTIC_COMPANION_MAX_DEPTH` (default **1** — one peer hop) **refuses
  before reading the prompt** and spawns nothing. It emits the existing
  contract § 5.3 row `companion_error` / exit `3` / `peer_invocation_error`
  (text mode: empty stdout + the one-line stderr summary; JSON mode: the
  envelope, no `metadata` because the peer never ran).
- A marker that is present but not a canonical non-negative integer is
  treated as nested (**fail closed**). A malformed
  `AGENTIC_COMPANION_MAX_DEPTH` falls back to the default bound — a typo
  never widens the guard.

### Deliberately widening or disabling it

`AGENTIC_COMPANION_MAX_DEPTH`, set in the **outermost** caller's
environment, propagates with the marker and raises the allowed depth
(`=2` permits one extra hop); `=0` refuses even a top-level call (a
dispatch kill-switch).

### This is not a security boundary

It is cooperative recursion protection. A wrapper that strips or rewrites
the environment defeats the marker — a documented limit, not a hidden one.
On the codex side the marker is delivered to the peer's shell tools via a
`-c shell_environment_policy.set.AGENTIC_COMPANION_DEPTH=…` config override
(codex does not forward arbitrary parent env to its shell tools); a
measured side effect of that override is that codex's `-c` handling drops a
config-file `shell_environment_policy.inherit` back to its built-in default
for that one peer call, which *widens* (never narrows) the env the codex
peer's own shell tools inherit. See the block comment in
[`codex-companion.mjs`](codex-companion.mjs) for the measurement.

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
