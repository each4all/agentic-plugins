# runtime

Runtime operator control plane for agentic-plugins. **L1 framework primitive** per [ADR-0024](../../docs/adr/0024-runtime-operator-control-plane.md).

## Status

Ships `runtime:doctor` and the first `runtime:settings` implementation. Dynamic consensus, context hygiene, completion footer work, deep peer smoke, and automatic plugin install/update apply mode are deferred to follow-up PRs and tracked in [`docs/follow-ups.md`](docs/follow-ups.md).

## What it is

`runtime` owns cross-plugin host/runtime truth shared by `engineer`, `orchestrator`, and future plugins:

- host CLI availability and auth diagnosis;
- marketplace, install, and cache state;
- companion discovery and contract compatibility;
- model/effort observation along the ADR-0024 resolution order;
- companion sandbox/permission readiness observations;
- workflow and peer-run ledger health.

It does not own persona-level engineering work or macro planning. Those remain in `engineer` and `orchestrator`.

| Layer | Plugin | Responsibility |
|-------|--------|----------------|
| L1 framework | `plugins/companions` | Script-only companion bridges and discovery library |
| **L1 framework** | **`plugins/runtime` (this plugin)** | **Readiness, operator diagnostics, runtime policy, and future settings** |
| L2 capability | `plugins/orchestrator` | Multi-deliverable planning, dispatch, lifecycle closure |
| L3 persona | `plugins/engineer` | Single-deliverable cognitive verb chain |

## Commands

| Command | Status | Description |
|---------|--------|-------------|
| `/runtime:doctor [--format text\|json] [--model <id>] [--effort <level>] [--deep-peer-smoke]` | shipping | Read-only diagnosis for host CLIs, auth, plugin cache/install state, companion readiness, model/effort observation, and workflow/peer-run ledger health. |
| `/runtime:settings [--format text\|json] [--target repo\|user\|both] [--model <id>] [--effort <level>] [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>] [--apply]` | shipping | Dry-run settings planner for marketplace/plugin/CLI readiness and agentic-plugins-owned model/effort config. `--apply` writes only `.agentic-plugins/config.toml`. |

Codex skill parity:

```sh
$runtime:doctor
$runtime:doctor --format json
$runtime:settings
$runtime:settings --codex-model gpt-5.4 --codex-effort high --apply
```

## Doctor behavior

Doctor is read-only. It does not:

- install or update plugins;
- authenticate either host;
- write config;
- sweep, cancel, or prune peer-run ledgers;
- execute peer agents by default;
- relax sandbox or permission boundaries.

Readiness output distinguishes missing CLI, missing plugin/cache state, unauthenticated host, and available surfaces. Because this first PR does not run peer-agent smoke checks or inspect host permission state directly, companion sandbox/permission readiness is reported as unknown/read-only inference rather than proven availability.

## Model and effort

ADR-0024 resolution order is reported as:

1. explicit doctor command flags;
2. workflow/subtask override observation;
3. repo-local `.agentic-plugins/config.toml`;
4. user-global `~/.agentic-plugins/config.toml`;
5. host-native default.

Companion invocation continues to use `companions/contract.md` `--model` and `--effort`; runtime does not invent a second path.

## Settings behavior

Settings is dry-run by default. It checks marketplace registration and install/cache state for `companions`, `engineer`, `orchestrator`, and `runtime`; reports Claude Code and Codex CLI availability/version; and plans repo-local plus user-global model/effort defaults.

`--apply` is intentionally narrow. It only upserts flat keys in:

- `<repo>/.agentic-plugins/config.toml`
- `~/.agentic-plugins/config.toml`

Supported keys are `model`, `effort`, `claude_model`, `claude_effort`, `codex_model`, and `codex_effort`. Direction-specific keys map to the companion peer: `claude_*` for Codex -> Claude and `codex_*` for Claude -> Codex.

Settings does not write host-native config, auth, secrets, sandbox/permission settings, or execute plugin install/update commands. Plugin install/update remains a host-native command recommendation in this PR.

## Install

```sh
# Claude Code
claude /plugin install runtime@agentic-plugins

# Codex CLI
codex plugin install --marketplace agentic-plugins runtime
```

## License

[MIT](../../LICENSE).
