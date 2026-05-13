# runtime

Runtime operator control plane for agentic-plugins. **L1 framework primitive** per [ADR-0024](../../docs/adr/0024-runtime-operator-control-plane.md).

## Status

Ships `runtime:doctor`, `runtime:settings` with explicit plugin-management execution and durable sanitized execution artifacts, an artifact-only `runtime:consensus` scaffold, the first runtime-owned `runtime:context` scaffold with a read-only explicit budget check, an explicit `runtime:migrate workflow-storage` path migration surface, and a pointer-only completion footer helper. `runtime:doctor --sandbox-permission-probe` reports an explicit read-only sandbox/permission preflight without peer execution, `runtime:doctor --permission-proof` reports a plan-only permission proof preflight, `runtime:doctor --permission-proof --execute-permission-proof` runs a bounded companion-contract proof under host-native permission defaults, `runtime:doctor --deep-peer-smoke` reports a plan-only preflight, and `runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke` runs a bounded companion-contract smoke while omitting raw peer stdout from doctor output. Automatic consensus peer execution, richer permission-proof retention/cancellation, host-native config apply, and automatic context mutation/capture triggers are deferred to follow-up PRs and tracked in [`docs/follow-ups.md`](docs/follow-ups.md).

## What it is

`runtime` owns cross-plugin host/runtime truth shared by `engineer`, `orchestrator`, and future plugins:

- host CLI availability and auth diagnosis;
- marketplace, install, and cache state;
- companion discovery and contract compatibility;
- model/effort observation along the ADR-0024 resolution order;
- companion sandbox/permission readiness observations;
- workflow and peer-run ledger health;
- bounded context hygiene artifacts for next-session handoff.
- advisory completion footer rendering for workflow handoff pointers.

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
| `/runtime:doctor [--format text\|json] [--model <id>] [--effort <level>] [--sandbox-permission-probe] [--permission-proof] [--execute-permission-proof] [--permission-proof-timeout-ms <n>] [--deep-peer-smoke] [--execute-deep-peer-smoke] [--deep-peer-smoke-timeout-ms <n>]` | shipping | Read-only diagnosis for host CLIs, auth, plugin cache/install state, companion readiness, model/effort observation, workflow/peer-run ledger health, optional read-only sandbox/permission probe, optional plan-only permission proof, explicit opt-in permission proof under host-native defaults, optional plan-only deep peer smoke preflight, and explicit opt-in companion-contract smoke execution with raw peer stdout omitted. |
| `/runtime:settings [--format text\|json] [--target repo\|user\|both] [--model <id>] [--effort <level>] [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>] [--apply] [--execute-plugin-management] [--plugin-management-host all\|claude\|codex] [--run-id <settings-run-id>]` | shipping | Dry-run settings planner for marketplace/plugin/CLI readiness and agentic-plugins-owned model/effort config. `--apply` writes only `.agentic-plugins/config.toml`; `--execute-plugin-management` runs only allowlisted host-native plugin install/update/add/upgrade commands, omits raw stdout/stderr, and writes sanitized execution artifacts under `.agentic-plugins/runs/settings/<run-id>/`. |
| `/runtime:migrate workflow-storage [--format text\|json] [--plugin all\|engineer\|orchestrator] [--apply]` | shipping | Explicit ADR-0025 workflow storage migration planner. Dry-run reports legacy/canonical state, branch counts, peer-run and lock blockers, and source/destination paths. `--apply` moves only gitignored `.claude/agentic-*` workflow state into `.agentic-plugins/state/<plugin>` and writes a local migration manifest. |
| `/runtime:consensus plan\|record\|synthesize\|next-round\|status ...` | shipping scaffold | Runtime-owned consensus artifact manager. Creates fanout/rebuttal prompts, records raw peer output as files, and emits only synthesized summary, durable disagreements, evidence pointers, and artifact paths. |
| `/runtime:context capture\|status\|check ...` | shipping scaffold | Runtime-owned context hygiene artifact manager and read-only explicit budget check. Writes context summary, risk level, artifact pointers, and next-session prompt/action under `.agentic-plugins/runs/context/`; `status --latest` reads the newest handoff artifact with stale metadata; `check` creates no artifact. |

Runtime also ships `scripts/footer.mjs`, a helper used by engineer and orchestrator completion surfaces to render the ADR-0024 advisory footer from explicit fields or a `runtime:context` artifact pointer. It is intentionally not a new slash command.
The helper can also render advisory PR handling readiness so completion
surfaces use one criterion set before asking the user whether to commit,
push, and open a PR.

Runtime artifact git policy is documented in
[`docs/artifact-policy.md`](docs/artifact-policy.md) and validated by
`npm run validate:artifacts`. In short, `.agentic-plugins/config.toml` remains
trackable for intentional repo-local defaults, while generated artifacts under
`.agentic-plugins/runs/`, generated workflow state under
`.agentic-plugins/state/`, local runtime caches, temporary files, and local
override TOML files are ignored.

Codex skill parity:

```sh
$runtime:doctor
$runtime:doctor --format json
$runtime:doctor --sandbox-permission-probe
$runtime:doctor --permission-proof --execute-permission-proof
$runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke
$runtime:settings
$runtime:settings --codex-model gpt-5.4 --codex-effort high --apply
$runtime:settings --execute-plugin-management --plugin-management-host codex
$runtime:settings --execute-plugin-management --plugin-management-host codex --run-id settings-YYYYMMDDTHHMMSSZ-abcdef
$runtime:migrate workflow-storage
$runtime:migrate workflow-storage --plugin engineer --apply
$runtime:consensus plan --task "Review this risky change" --max-rounds 2
$runtime:context capture --summary "Handoff summary" --risk yellow --next-action "Start a fresh session before the next large change."
$runtime:context status --latest --stale-after-hours 12
$runtime:context check --token-budget 100000 --used-tokens 82000
```

## Doctor behavior

Doctor is read-only. It does not:

- install or update plugins;
- authenticate either host;
- write config;
- sweep, cancel, or prune peer-run ledgers;
- execute peer agents by default;
- relax sandbox or permission boundaries.

Readiness output starts with a `readiness_matrix` / `Readiness Matrix` summary that separates host CLI availability, runtime installation evidence, authentication state, direction-specific peer model/effort inputs, hook evidence, companion readiness, and sandbox/permission status. It distinguishes missing CLI, missing plugin/cache state, source-only availability, unauthenticated host, and installed host evidence. By default companion sandbox/permission readiness remains `unknown`. `--sandbox-permission-probe` adds an explicit read-only preflight for both companion directions using the already observed CLI, auth, feature-surface, and companion-script evidence. It records `peer_execution=false`, does not run companion scripts, does not run peer agents, and does not mutate host-native config/auth/secrets/sandbox state. `--permission-proof` adds a structured plan-only preflight for both companion directions, including the permission surface, model/effort inputs, blockers, warnings, and next-step guidance. `--deep-peer-smoke` adds a structured plan-only preflight section for both companion directions, including readiness status, model/effort inputs, blockers, warnings, and next-step guidance.

Doctor also emits a `host_parity` / `Host Parity` section. It makes
Claude-vs-Codex differences explicit rather than hiding them behind a shared
abstraction: Codex manual skill invocation versus Claude plugin hooks,
host-specific plugin install/update command shape, different permission
surfaces, stale host plugin caches, failed Claude plugin entries, and retired
agentic-plugins installs such as the old `research` plugin. These findings are
diagnostic output only; doctor does not uninstall, upgrade, or mutate either
host.

Permission proof execution requires the separate `--execute-permission-proof` flag in addition to `--permission-proof`. The executor invokes each available companion through `companions/contract.md` JSON-envelope mode with the resolved model/effort inputs and no doctor-injected sandbox, approval, permission-mode, or host-native policy relaxation flags. Doctor output records only execution status, exit codes, peer host/model metadata, duration, stdout byte count, stdout SHA-256, and sanitized permission-failure class. Raw peer stdout, prompt bodies, host secrets, and account details are not printed into the main report. `--permission-proof-timeout-ms <n>` bounds each companion process. This proves companion invocation under current host permission defaults; it does not authorize future writes or broader tool use.

Deep peer smoke execution requires the separate `--execute-deep-peer-smoke` flag in addition to `--deep-peer-smoke`. The executor invokes each available companion through `companions/contract.md` JSON-envelope mode with the resolved model/effort inputs and no host session persistence beyond the companion behavior. Doctor output records only execution status, exit codes, peer host/model metadata, duration, stdout byte count, and stdout SHA-256. Raw peer stdout, prompt bodies, host secrets, and account details are not printed into the main report. `--deep-peer-smoke-timeout-ms <n>` bounds each companion process. This executor does not mutate host-native config/auth/secrets/sandbox state and does not claim Codex manual-hook parity.

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

Settings also projects the effective companion model/effort after the selected target's planned writes. This projection uses the same repo-local before user-global precedence as doctor. If a user-global write would be shadowed by an existing repo-local or direction-specific setting, settings reports a warning instead of implying the requested value will take effect.

Settings is still dry-run for plugin management unless `--execute-plugin-management` is supplied. The executor runs only allowlisted host-native plugin commands generated by the settings recommendations:

- Claude plugin install/update commands.
- Codex marketplace add/upgrade commands.

It invokes commands as argv arrays, never through a shell, and records only status, exit code, byte counts, timing, retry classification, and sanitized error metadata. Raw stdout and stderr are omitted from settings output and artifacts. `--plugin-management-host all|claude|codex` scopes execution. Settings writes `.agentic-plugins/runs/settings/<run-id>/settings.json` plus `.agentic-plugins/runs/settings/latest.json` for explicit plugin-management executions; `runtime:doctor` reads the latest artifact and reports failed action types and retryability. Settings still does not write host-native config, auth, secrets, sandbox/permission settings, or execute plugin uninstall commands.

## Migration Behavior

Migration is explicit and dry-run by default. The first supported subcommand is:

```sh
$runtime:migrate workflow-storage [--plugin all|engineer|orchestrator] [--apply]
```

Dry-run reports namespace presence in legacy `.claude/agentic-*` and canonical
`.agentic-plugins/state/<plugin>` homes, active workflow counts by branch,
archive counts, peer-run counts, non-terminal peer-run counts, lock blockers,
tracked worktree dirtiness, and exact source/destination paths.

`--apply` moves state directories rather than copying them. It refuses when
canonical state already exists, both homes contain overlapping workflow
branches, creation or workflow lock files are present, workflow files are
malformed, peer-run handles are malformed, or peer-run handles are
non-terminal. `--plugin all` is safe for dry-run inventory; when both engineer
and orchestrator are ready, apply one namespace at a time with an explicit
`--plugin` value to avoid partial multi-namespace migration. On success it writes
`.agentic-plugins/state/migrations/workflow-storage-v1.json`. It does not
rewrite workflow schemas, peer-run handle schemas, host-native config,
authentication, secrets, sandbox, or permission settings.

## Consensus behavior

Consensus is a runtime-owned artifact scaffold for ADR-0024 dynamic peer loops. It does not execute peers directly. The first flow is:

1. `plan`: create `<repo>/.agentic-plugins/runs/consensus/<run-id>/manifest.json`, `task.md`, and round-1 peer prompt files.
2. `record`: copy each peer raw output into the run artifact tree and update the manifest with pointer, byte count, and hash.
3. `synthesize`: write `consensus.json` with `synthesized_summary`, `durable_disagreements`, `evidence_pointers`, and `next_action`.
4. `next-round`: create targeted rebuttal prompts from synthesized disagreement summaries when budget remains.

Main-session output intentionally omits raw peer output. It reports artifact pointers and the bounded consensus result only. This scaffold does not migrate engineer/orchestrator workflow state, mutate companion scripts, alter host-native config/auth/secrets, or claim Codex manual-hook parity.

## Context behavior

Context is a runtime-owned artifact scaffold and read-only check surface for ADR-0024 context hygiene. It does not inspect or mutate host session context directly. The first flows are:

1. `capture`: create `<repo>/.agentic-plugins/runs/context/<run-id>/context.json`, `summary.md`, and `next-session-prompt.md`.
2. `status`: read the stored artifact by `--run-id`, or read the newest readable artifact with `--latest`, and emit the same bounded handoff fields plus age/stale metadata.
3. `check`: compute an advisory green/yellow/red risk from caller-supplied `--token-budget` plus `--used-tokens` or `--remaining-tokens`, or from caller-supplied `--risk`.

Context output is intentionally limited to:

- context summary;
- risk level (`green`, `yellow`, or `red`);
- artifact pointers;
- recommended next-session action;
- generated or caller-supplied next-session prompt preview and pointer.
- read-only handoff lookup metadata for `status`, including selected artifact age and stale/not-stale state.

`status --latest` reads existing artifacts only; it does not create, update, or compact anything. `check` does not create a context artifact, trigger `capture`, measure host context automatically, compact the session, or start a new session. This scaffold does not migrate engineer/orchestrator workflow state, run peers, paste consensus raw output into the main session, mutate host-native config/auth/secrets/sandbox state, or claim Codex manual-hook parity.

## Completion footer behavior

The footer helper renders the standard ADR-0024 completion footer:

- context state (`green`, `yellow`, or `red`);
- linked context artifact and lookup freshness when a context artifact is supplied;
- workflow kind/id/path;
- artifact pointers, including `.agentic-plugins/runs/context/<run-id>/context.json` when linked;
- recommended next work;
- next-session action and command or prompt pointer;
- explicit advisory/pointer-only limits.
- optional PR handling readiness, with criteria for deliverable boundary,
  validation, context risk, blocking reviews, and branch pushability.

When supplied `--context-run-id`, the helper reads only bounded fields from the matching `runtime:context` artifact: risk level, artifact pointers, recommended action, and next-session prompt pointer. It does not print the context summary body, prompt body, raw peer output, or consensus raw output.

When supplied `--context-latest`, the helper reads the newest existing readable `runtime:context` artifact and reports read-only lookup metadata, including selected timestamp, age, stale state, stale threshold, and skipped invalid artifacts. `--stale-after-hours <n>` sets the stale threshold. The latest lookup does not create, update, or compact context.

When supplied PR handling fields, the helper recommends `ask-user` only
when the deliverable boundary is reached, validation passed or was
explicitly waived, context risk is green/yellow, no blocking review
findings remain, and the branch is pushable. Incomplete evidence returns
`defer`; failed criteria return `block`. The helper never commits, pushes,
opens PRs, updates PR metadata, merges, or marks a PR ready for review.

## Install

```sh
# Claude Code
claude /plugin install runtime@agentic-plugins

# Codex CLI
codex plugin marketplace add each4all/agentic-plugins
```

## License

[MIT](../../LICENSE).
