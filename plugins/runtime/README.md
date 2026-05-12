# runtime

Runtime operator control plane for agentic-plugins. **L1 framework primitive** per [ADR-0024](../../docs/adr/0024-runtime-operator-control-plane.md).

## Status

Ships `runtime:doctor` only. `runtime:settings`, dynamic consensus, context hygiene, and completion footer work are deferred to follow-up PRs and tracked in [`docs/follow-ups.md`](docs/follow-ups.md).

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
| `/runtime:settings` | deferred | Future dry-run/apply settings surface. Not present in this PR. |

Codex skill parity:

```sh
$runtime:doctor
$runtime:doctor --format json
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

## Install

```sh
# Claude Code
claude /plugin install runtime@agentic-plugins

# Codex CLI
codex plugin install --marketplace agentic-plugins runtime
```

## License

[MIT](../../LICENSE).
