# runtime

Runtime operator control plane for agentic-plugins. **L1 framework primitive** per [ADR-0024](../../docs/adr/0024-runtime-operator-control-plane.md).

## Status

Ships `runtime:doctor`, `runtime:settings` with explicit plugin-management and retired-plugin cleanup execution plus durable sanitized execution artifacts, a Codex hook-review operator attestation artifact for the manual `/hooks` trust step, `runtime:consensus` with artifact scaffolding plus an explicit companion executor, `runtime:compat` with host-version snapshots plus release-note gap planning, `runtime:worktree` with a read-only dedicated-worktree planner, the first runtime-owned `runtime:context` scaffold with a read-only explicit budget check, an explicit `runtime:migrate workflow-storage` path migration surface, and a pointer-only completion footer helper. `runtime:consensus` peer breadth is bounded by the explicit `--peers` roster and optional `--max-peers`, not by a hidden fixed product cap. `runtime:compat` records Claude Code / Codex CLI version drift, stores explicit release-note artifacts, and emits compatibility update plans without fetching URLs by default or mutating host state. `runtime:context` captures a read-only git source snapshot when available, and `status`/footer lookup report age-based stale state, source-freshness state, and handoff guidance so a time-fresh handoff can still be flagged when the current git commit moved or source state is unverifiable. The footer can also link read-only `runtime:consensus status` guidance from an explicit or latest consensus run without printing peer prompts, peer raw outputs, or consensus body text. `runtime:doctor --sandbox-permission-probe` reports an explicit read-only sandbox/permission preflight without peer execution, `runtime:doctor --permission-proof` reports a plan-only permission proof preflight, `runtime:doctor --permission-proof --execute-permission-proof` runs a bounded companion-contract proof under host-native permission defaults, `runtime:doctor --deep-peer-smoke` reports a plan-only preflight, and `runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke` runs a bounded companion-contract smoke while omitting raw peer stdout from doctor output. The current Codex capability boundary is tracked in [`docs/codex-capability-baseline.md`](docs/codex-capability-baseline.md), and the broader Claude-vs-Codex behavior boundary is tracked in [`docs/host-parity-baseline.md`](docs/host-parity-baseline.md), so runtime docs distinguish official host support, local CLI observations, and non-portable host-specific behavior. Automatic unbounded consensus loops, richer permission-proof retention/cancellation, host-native config apply beyond narrow `plugin_hooks`, automatic release-note URL fetch, and automatic context mutation/capture triggers are deferred to follow-up PRs and tracked in [`docs/follow-ups.md`](docs/follow-ups.md).

## What it is

`runtime` owns cross-plugin host/runtime truth shared by `engineer`, `orchestrator`, and future plugins:

- host CLI availability and auth diagnosis;
- marketplace, install, and cache state;
- companion discovery and contract compatibility;
- model/effort observation along the ADR-0024 resolution order;
- companion sandbox/permission readiness observations;
- workflow and peer-run ledger health;
- host-version drift and release-note gap planning for compatibility updates;
- read-only worktree planning for isolating non-trivial follow-up slices;
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
| `/runtime:settings [--format text\|json] [--target repo\|user\|both] [--model <id>] [--effort <level>] [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>] [--apply] [--apply-codex-plugin-hooks] [--attest-codex-hook-review] [--execute-plugin-management] [--execute-plugin-cleanup] [--plugin-management-host all\|claude\|codex] [--run-id <settings-run-id>]` | shipping | Dry-run settings planner for marketplace/plugin/CLI readiness and agentic-plugins-owned model/effort config. `--apply` writes only `.agentic-plugins/config.toml`; `--execute-plugin-management` runs only allowlisted host-native plugin install/update/add/upgrade commands; `--execute-plugin-cleanup` runs only doctor-detected retired/unknown `agentic-plugins` Claude plugin cleanup commands; `--attest-codex-hook-review` records the operator's completed Codex `/hooks` review/trust step as a sanitized artifact; all explicit executors omit raw stdout/stderr and write sanitized execution artifacts under `.agentic-plugins/runs/settings/<run-id>/`. |
| `/runtime:migrate workflow-storage [--format text\|json] [--plugin all\|engineer\|orchestrator] [--apply]` | shipping | Explicit ADR-0025 workflow storage migration planner. Dry-run reports legacy/canonical state, branch counts, peer-run and lock blockers, and source/destination paths. `--apply` moves only gitignored `.claude/agentic-*` workflow state into `.agentic-plugins/state/<plugin>` and writes a local migration manifest. |
| `/runtime:consensus plan\|record\|synthesize\|next-round\|execute\|status ...` | shipping | Runtime-owned consensus artifact manager and explicit companion executor. Creates fanout/rebuttal prompts, records or executes raw peer output as files, and emits only sanitized execution metadata, synthesized summary, durable disagreements, evidence pointers, artifact paths, and `status --latest` guidance from the newest readable manifest. |
| `/runtime:compat snapshot\|check\|ingest-release-notes\|plan ...` | shipping scaffold | Runtime-owned host-version compatibility artifact manager. Records Claude Code / Codex CLI version snapshots, compares them to the remembered host-parity baseline, stores explicit release-note files or URL pointers, and emits compatibility update plans without fetching URLs by default or mutating host state. |
| `/runtime:worktree plan [--format text\|json] [--task <text>] [--branch <name>] [--base <ref>] [--worktree-dir <path>]` | shipping scaffold | Read-only dedicated-worktree planner. Reports current branch/dirtiness, existing `git worktree list --porcelain` entries, base-ref resolution, candidate branch/path availability, and suggested `git worktree add` commands without executing them. |
| `/runtime:context capture\|status\|check ...` | shipping scaffold | Runtime-owned context hygiene artifact manager and read-only explicit budget check. Writes context summary, risk level, artifact pointers, next-session prompt/action, and read-only git source snapshot under `.agentic-plugins/runs/context/`; `status --latest` reads the newest handoff artifact with age stale metadata, source-freshness state, and explicit reuse-or-refresh guidance; `check` creates no artifact. |

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
$runtime:settings --execute-plugin-cleanup
$runtime:settings --attest-codex-hook-review
$runtime:migrate workflow-storage
$runtime:migrate workflow-storage --plugin engineer --apply
$runtime:consensus plan --task "Review this risky change" --max-rounds 2
$runtime:consensus execute --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --execute
$runtime:consensus status --latest
$runtime:compat snapshot
$runtime:compat ingest-release-notes --latest --release-notes-file /tmp/codex-release-notes.md
$runtime:compat plan --latest
$runtime:worktree plan --task "Next runtime operator slice"
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

Readiness output starts with a `readiness_matrix` / `Readiness Matrix` summary that separates host CLI availability, runtime installation evidence, authentication state, direction-specific peer model/effort inputs, hook evidence, companion readiness, companion execution readiness, and sandbox/permission status. It distinguishes missing CLI, missing plugin/cache state, source-only availability, unauthenticated host, installed host evidence, and explicit executor evidence. Host `authenticated` remains the direct host auth probe result; companion execution readiness is reported separately from `--permission-proof --execute-permission-proof` and `--deep-peer-smoke --execute-deep-peer-smoke` results so a child-process auth or sandbox failure is not mistaken for direct shell auth state. By default companion sandbox/permission readiness remains `unknown`. `--sandbox-permission-probe` adds an explicit read-only preflight for both companion directions using the already observed CLI, auth, feature-surface, and companion-script evidence. It records `peer_execution=false`, does not run companion scripts, does not run peer agents, and does not mutate host-native config/auth/secrets/sandbox state. `--permission-proof` adds a structured plan-only preflight for both companion directions, including the permission surface, model/effort inputs, blockers, warnings, and next-step guidance. `--deep-peer-smoke` adds a structured plan-only preflight section for both companion directions, including readiness status, model/effort inputs, blockers, warnings, and next-step guidance.

Doctor also reads the newest `runtime:compat` snapshot/gap/plan metadata and includes it in the runtime handoff artifact criterion. Host-version drift with missing content-backed release notes blocks experience parity until the operator ingests release-note evidence or refreshes the baseline. This read is bounded to JSON metadata: doctor does not read raw release-note bodies or raw host help output from compatibility artifacts.

Doctor also emits a `host_parity` / `Host Parity` section. It makes
Claude-vs-Codex differences explicit rather than hiding them behind a shared
abstraction: Codex explicit skill surfaces and plugin-hook trust boundaries,
host-specific plugin install/update command shape, different permission
surfaces, stale host plugin caches, failed Claude plugin entries, and retired
agentic-plugins installs such as the old `research` plugin. These findings are
diagnostic output only; doctor does not uninstall, upgrade, or mutate either
host. Codex-specific capability drift, including marketplace-only plugin
management and plugin-hook readiness, is documented in
[`docs/codex-capability-baseline.md`](docs/codex-capability-baseline.md).
The source-backed parity matrix for Claude expectations that do not port
directly to Codex is documented in
[`docs/host-parity-baseline.md`](docs/host-parity-baseline.md).

Permission proof execution requires the separate `--execute-permission-proof` flag in addition to `--permission-proof`. The executor invokes each available companion through `companions/contract.md` JSON-envelope mode with the resolved model/effort inputs and no doctor-injected sandbox, approval, permission-mode, or host-native policy relaxation flags. Doctor output records only execution status, exit codes, peer host/model metadata, duration, stdout byte count, stdout SHA-256, and sanitized operator-action class. Permission, sandbox, and child-process auth failures are reported as `operator_action_required` with `operator_action_kind` values such as `permission_required`, `sandbox_blocked`, or `auth_required`; they are operator preconditions, not runtime implementation failures. Raw peer stdout, prompt bodies, host secrets, and account details are not printed into the main report. `--permission-proof-timeout-ms <n>` bounds each companion process. This proves companion invocation under current host permission defaults; it does not authorize future writes or broader tool use.

Deep peer smoke execution requires the separate `--execute-deep-peer-smoke` flag in addition to `--deep-peer-smoke`. The executor invokes each available companion through `companions/contract.md` JSON-envelope mode with the resolved model/effort inputs and no host session persistence beyond the companion behavior. Doctor output records only execution status, exit codes, peer host/model metadata, duration, stdout byte count, stdout SHA-256, and the same sanitized operator-action class when the companion is blocked by host preconditions. Raw peer stdout, prompt bodies, host secrets, and account details are not printed into the main report. `--deep-peer-smoke-timeout-ms <n>` bounds each companion process. This executor does not mutate host-native config/auth/secrets/sandbox state and does not claim Codex plugin-hook parity.

## Model and effort

ADR-0024 resolution order is reported as:

1. explicit doctor command flags;
2. workflow/subtask override observation;
3. repo-local `.agentic-plugins/config.toml`;
4. user-global `~/.agentic-plugins/config.toml`;
5. host-native default.

Companion invocation continues to use `companions/contract.md` `--model` and `--effort`; runtime does not invent a second path.

## Settings behavior

Settings is dry-run by default. It checks marketplace registration and install/cache state for `companions`, `engineer`, `orchestrator`, and `runtime`; reports Claude Code and Codex CLI availability/version; and plans repo-local plus user-global model/effort defaults. When a host CLI is unavailable, settings emits a structured, non-executable host-CLI install plan with host-native installation guidance; it never installs Claude Code or Codex CLI itself.

`--apply` is intentionally narrow. It only upserts flat keys in:

- `<repo>/.agentic-plugins/config.toml`
- `~/.agentic-plugins/config.toml`

Supported keys are `model`, `effort`, `claude_model`, `claude_effort`, `codex_model`, and `codex_effort`. Direction-specific keys map to the companion peer: `claude_*` for Codex -> Claude and `codex_*` for Claude -> Codex.

Settings also projects the effective companion model/effort after the selected target's planned writes. This projection uses the same repo-local before user-global precedence as doctor. If a user-global write would be shadowed by an existing repo-local or direction-specific setting, settings reports a warning instead of implying the requested value will take effect.

Settings is still dry-run for plugin management unless `--execute-plugin-management` is supplied. The executor runs only allowlisted host-native plugin commands generated by the settings recommendations:

- Claude plugin install/update commands.
- Codex marketplace add/upgrade commands.

Retired or unknown `agentic-plugins` cleanup is a separate explicit boundary:

```sh
$runtime:settings --execute-plugin-cleanup
```

This executor runs only `claude plugin uninstall <plugin>@agentic-plugins`
commands generated from `runtime:doctor` retired/unknown plugin findings, such
as the archived `research` plugin. It does not expose general plugin uninstall
or arbitrary host command execution.

Codex temporary marketplace manifests are reported separately from per-plugin
install cache evidence. The current observed Codex plugin command surface is
marketplace-only (`add` / `upgrade` / `remove`), not Claude-style per-plugin
`install` / `list`. If the marketplace cache is current but the per-plugin
cache is absent, settings reports a manual cache-materialization item instead
of retrying `codex plugin marketplace add`; doctor surfaces the same state in
the readiness matrix and host-parity diagnostics.

It invokes commands as argv arrays, never through a shell, and records only status, exit code, byte counts, timing, retry classification, and sanitized error metadata. Raw stdout and stderr are omitted from settings output and artifacts. `--plugin-management-host all|claude|codex` scopes install/update execution. Settings writes `.agentic-plugins/runs/settings/<run-id>/settings.json` plus `.agentic-plugins/runs/settings/latest.json` for explicit plugin-management, plugin-cleanup, Codex plugin-hook config writes, or Codex hook-review attestations; `runtime:doctor` reads those artifacts and reports failed action types, retryability, and the newest current hook-review attestation. Settings still does not write host-native Claude config, mutate Codex hook trust state, change auth, secrets, sandbox/permission settings, or execute general plugin uninstall commands.

Codex hook trust remains an active-session UI operation. After opening `/hooks`
in Codex and reviewing/trusting the bundled agentic-plugins hooks, the operator
can record that manual step with:

```sh
$runtime:settings --attest-codex-hook-review
```

The attestation is not host-native proof and does not mutate Codex trust state.
It records the current hook-bearing plugin set and source versions, and
`runtime:doctor` treats it as current only while those still match the observed
checkout.

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

Consensus is a runtime-owned artifact scaffold and explicit companion executor for ADR-0024 dynamic peer loops. Planning, recording, synthesis, next-round, and status do not execute peers. The only direct dispatch path is `execute --execute`. The first flow is:

1. `plan`: create `<repo>/.agentic-plugins/runs/consensus/<run-id>/manifest.json`, `task.md`, and round-1 peer prompt files. The peer roster may include companion-backed peers (`claude`, `codex`) plus manual/subagent peer labels such as `security` or `release`; manual labels are record-only lanes.
2. `execute --execute`: invoke only companion-backed `claude` and/or `codex` peers through `companions/contract.md`, bounded by peer list, process budget, max rounds, and timeout caps. Raw peer stdout is written under the run artifact tree; main output reports prompt pointer, raw-output pointer, byte count, SHA-256, status, failure type, and retryability only.
3. `record`: copy manually obtained peer raw output, including manual/subagent lane output, into the run artifact tree and update the manifest with pointer, byte count, and hash.
4. `synthesize`: write `consensus.json` with `synthesized_summary`, `durable_disagreements`, `evidence_pointers`, `next_action`, and next-round availability.
5. `status`: read manifest, execution, progress, and consensus-result artifacts to recommend the next bounded operator action: execute/record, retry selected peers, synthesize, plan next-round, or stop for owner decision. If a running progress artifact has exceeded its per-peer timeout without a final `execution.json`, status reports `execution_stalled` and asks the operator to inspect the progress artifact and confirm no original execute process is still active before retrying a guarded selected-peer command.
6. `next-round`: create targeted rebuttal prompts from synthesized disagreement summaries when budget remains.
7. `execute --round <n> --execute`: run a bounded rebuttal round after `next-round`.

Main-session output intentionally omits raw peer output. It reports artifact pointers, prompt pointers, hashes, byte counts, sanitized failure class/retryability, and the bounded consensus result only. Execution and progress artifacts also carry the per-peer prompt pointer so timeout or retry handoffs can inspect the exact prompt artifact without reading raw peer output. Permission, sandbox, approval, and child-process authentication failures are classified as `operator_action_required` with `failure_type` values such as `permission_required`, `sandbox_blocked`, or `auth_required`; they are non-retryable until the operator satisfies the host precondition outside runtime. CLI availability, network, timeout, and transient host failures remain separate classes. `runtime:doctor` reads the latest consensus execution artifact summary and reports failed retryability plus operator-action counts without reading raw peer output. This surface does not migrate engineer/orchestrator workflow state, mutate companion scripts, alter host-native config/auth/secrets/sandbox/permission state, mutate host session context, or claim Codex plugin-hook parity. Automatic unbounded loops are forbidden; broader manual fanout is bounded by the explicit `--peers` roster, optional `--max-peers`, max rounds, process budget, and timeout caps rather than a hard-coded peer-count ceiling.

## Worktree behavior

Worktree planning is read-only. The command inspects `git worktree list --porcelain`, current branch/detached state, `git status --porcelain=v1`, base-ref resolution, candidate branch availability, and candidate worktree path availability. It then emits a suggested `git worktree add -b <branch> <path> <base>` command with `execute=false`.

`runtime:worktree` never creates branches, adds or removes worktrees, commits, pushes, opens PRs, or mutates runtime context. It recommends a dedicated worktree for non-trivial follow-up when the current checkout is on `main`, dirty, detached, or already sharing work with other worktrees. Blockers such as an unresolved base ref, existing target branch, or occupied target path must be resolved before running the suggested command manually.

## Context behavior

Context is a runtime-owned artifact scaffold and read-only check surface for ADR-0024 context hygiene. It does not inspect or mutate host session context directly. The first flows are:

1. `capture`: create `<repo>/.agentic-plugins/runs/context/<run-id>/context.json`, `summary.md`, and `next-session-prompt.md`; when git is available, record the current commit, branch, and dirty-state as read-only source metadata.
2. `status`: read the stored artifact by `--run-id`, or read the newest readable artifact with `--latest`, and emit the same bounded handoff fields plus age/stale metadata, source-freshness metadata comparing the artifact commit to the current git commit, and advisory reuse-or-refresh guidance.
3. `check`: compute an advisory green/yellow/red risk from caller-supplied `--token-budget` plus `--used-tokens` or `--remaining-tokens`, or from caller-supplied `--risk`.

Context output is intentionally limited to:

- context summary;
- risk level (`green`, `yellow`, or `red`);
- artifact pointers;
- recommended next-session action;
- generated or caller-supplied next-session prompt preview and pointer.
- read-only handoff lookup metadata for `status`, including selected artifact age, stale/not-stale state, source-freshness state, dirty-state hints, and handoff guidance.

`status --latest` reads existing artifacts only; it does not create, update, or compact anything. If the selected handoff is age-stale, source-stale, source-unknown, or the current worktree is dirty, status recommends a fresh capture before relying on the artifact as next-session truth, but it still does not trigger capture automatically. `check` does not create a context artifact, trigger `capture`, measure host context automatically, compact the session, or start a new session. This scaffold does not migrate engineer/orchestrator workflow state, run peers, paste consensus raw output into the main session, mutate host-native config/auth/secrets/sandbox state, or claim Codex plugin-hook parity.

## Completion footer behavior

The footer helper renders the standard ADR-0024 completion footer:

- context state (`green`, `yellow`, or `red`);
- linked context artifact, lookup freshness, and handoff guidance when a context artifact is supplied;
- linked consensus run and bounded status guidance when a consensus run is supplied;
- workflow kind/id/path;
- artifact pointers, including `.agentic-plugins/runs/context/<run-id>/context.json` and `.agentic-plugins/runs/consensus/<run-id>/` when linked;
- recommended next work;
- next-session action and command or prompt pointer;
- explicit advisory/pointer-only limits.
- optional PR handling readiness, with criteria for deliverable boundary,
  validation, context risk, blocking reviews, and branch pushability.

When supplied `--context-run-id`, the helper reads only bounded fields from the matching `runtime:context` artifact: risk level, artifact pointers, recommended action, next-session prompt pointer, lookup freshness, and handoff guidance. It does not print the context summary body, prompt body, raw peer output, or consensus raw output.

When supplied `--context-latest`, the helper reads the newest existing readable `runtime:context` artifact and reports read-only lookup metadata, including selected timestamp, age, stale state, stale threshold, skipped invalid artifacts, source-freshness state when a git source snapshot is available, and handoff guidance. Guidance can recommend reusing the handoff, inspecting unverifiable source state, capturing new context, or settling a dirty worktree before capture. `--stale-after-hours <n>` sets the age-based stale threshold. The latest lookup does not create, update, or compact context.

When supplied `--consensus-run-id` or `--consensus-latest`, the helper calls `runtime:consensus status` and includes only run/result/execution/progress pointers plus `status_guidance` next action/steps. Latest consensus lookup selects the newest readable consensus manifest. The footer does not execute peers, synthesize, plan another round, print peer prompts, print peer raw output, or print consensus body text.

Embedded `runtime:*` guidance commands are rendered with the selected host's invocation syntax when `--host claude` or `--host codex` is supplied, while stored context and consensus artifacts remain host-neutral.

When supplied PR handling fields, the helper recommends `ask-user` only
when the deliverable boundary is reached, validation passed or was
explicitly waived, context risk is green/yellow, no blocking review
findings remain, and the branch is pushable. Incomplete evidence returns
`defer`; failed criteria return `block`. The helper never commits, pushes,
opens PRs, updates PR metadata, merges, or marks a PR ready for review.

## Install

```sh
# Claude Code
claude plugin install runtime@agentic-plugins

# Codex CLI
codex plugin marketplace add each4all/agentic-plugins
```

## License

[MIT](../../LICENSE).
