# runtime

Runtime operator control plane for agentic-plugins. **L1 framework primitive** per [ADR-0024](../../docs/adr/0024-runtime-operator-control-plane.md).

## Status

Ships `runtime:doctor`, `runtime:settings` with explicit plugin-management and retired-plugin cleanup execution plus durable sanitized execution artifacts, a Codex hook-review operator attestation artifact for the manual `/hooks` trust step, `runtime:consensus` with artifact scaffolding plus an explicit companion executor, convergence taxonomy, owner-decision artifacts for exhausted or otherwise unresolved consensus, owner-ratification artifacts for converged runs whose synthesis flagged a residual owner lever, and artifact-only cancellation for abandoned or intentionally stopped consensus runs, `runtime:compat` with host-version snapshots plus release-note gap planning, `runtime:worktree` with a read-only dedicated-worktree planner, the first runtime-owned `runtime:context` scaffold with a read-only explicit budget check, an explicit `runtime:migrate workflow-storage` path migration surface, `runtime:cutover` with a read-only omcc cutover readiness report, legacy pattern-map check, and explicit dogfood evidence recorder, `runtime:dashboard` with the ADR-0040 §6 read-only Tier 1 + Tier 2 aggregate operator snapshot (three-persona workflow/peer-run state, macro subtask progress, consensus runs, recorded doctor/compat/baseline freshness, settings and Codex hook-attestation recency, artifact attention items, notify-state health, and a filesystem-only `--watch` mode), and a pointer-only completion footer helper. `runtime:consensus` peer breadth is bounded by the explicit `--peers` roster and optional `--max-peers`, not by a hidden fixed product cap; contradiction rebuttal defaults to 2 total rounds, is hard-capped at 3, and exhausted contradictions become `owner-decision-required` instead of another loop. The explicit `decide` command records the owner decision as a pointer, byte count, hash, previous consensus pointer, and evidence pointers without printing the decision text or executing another peer round. The explicit `ratify` command is the converged-run mirror: it records the owner's resolution of a synthesis-flagged residual owner lever as a ratification pointer, byte count, hash, and optional single-line lever summary while the manifest status stays `converged` and `consensus.json`/`convergence_state` stay untouched, without printing the ratification text or executing peers. The explicit `cancel` command records a cancellation reason pointer, byte count, hash, previous status, and progress pointer without printing the reason text or killing host processes; if progress is running, it requires operator confirmation that no original execute process is still active. `runtime:compat` records Claude Code / Codex CLI version drift, stores explicit release-note artifacts, requires content-backed notes to cover each changed host and observed version before detailed planning, and emits compatibility update plans without fetching URLs by default or mutating host state; URL content fetch is available only when the operator supplies `--fetch-release-notes-url`. `runtime:context` captures a read-only git source snapshot when available, and `status`/footer lookup report age-based stale state, source-freshness state, and handoff guidance so a time-fresh handoff can still be flagged when the current git commit moved or source state is unverifiable. The footer can also link read-only `runtime:consensus status` guidance from an explicit or latest consensus run without printing peer prompts, peer raw outputs, owner decision text, cancellation reason text, or consensus body text, and it can render an advisory `runtime:cutover record` command for dogfood evidence without writing cutover artifacts. `runtime:doctor --sandbox-permission-probe` reports an explicit read-only sandbox/permission preflight without peer execution, `runtime:doctor --permission-proof` reports a plan-only permission proof preflight, `runtime:doctor --permission-proof --execute-permission-proof` runs a bounded companion-contract proof under host-native permission defaults, `runtime:doctor --deep-peer-smoke` reports a plan-only preflight, `runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke` runs a bounded companion-contract smoke, `runtime:doctor --workflow-continuation-proof` reports a plan-only engineer workflow continuation preflight, and `runtime:doctor --workflow-continuation-proof --execute-workflow-continuation-proof` runs a bounded proof through engineer state plus dispatch while omitting raw peer stdout from doctor output. Doctor and settings both print per-plugin Codex hook review targets for `/hooks`, including hook file paths, events, commands, and warnings. With `--record`, doctor writes sanitized proof/report metadata under `.agentic-plugins/runs/doctor/`; later doctor/cutover runs reuse that proof only while runtime, host CLI, and plugin source/cache versions still match. The current Codex capability boundary is tracked in [`docs/codex-capability-baseline.md`](docs/codex-capability-baseline.md), and the broader Claude-vs-Codex behavior boundary is tracked in [`docs/host-parity-baseline.md`](docs/host-parity-baseline.md), so runtime docs distinguish official host support, local CLI observations, and non-portable host-specific behavior. Automatic unbounded consensus loops, host-process cancellation/kill, proof retention mutation, host-native config apply (the former narrow `plugin_hooks` write was removed per ADR-0035 §6), implicit release-note URL fetch without operator opt-in, and automatic context mutation/capture triggers are deferred to follow-up PRs and tracked in [`docs/follow-ups.md`](docs/follow-ups.md).

Codex hook diagnosis also reads `~/.codex/config.toml` `[hooks.state]` and reports expected bundled hook entries that are enabled, disabled, missing, or untrusted. A hook-review attestation is blocked while expected bundled hook entries are explicitly disabled, which keeps stale or manually disabled hook rows from being hidden behind a generic `/hooks` follow-up.

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
- read-only aggregate operator dashboard over persona workflow/peer-run ledgers, macro subtask progress, consensus runs, recorded operator-health evidence, and notify-state health.
- read-only omcc cutover readiness aggregation plus explicit dogfood evidence recording.
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
| `/runtime:doctor [--format text\|json] [--model <id>] [--effort <level>] [--sandbox-permission-probe] [--permission-proof] [--execute-permission-proof] [--permission-proof-timeout-ms <n>] [--deep-peer-smoke] [--execute-deep-peer-smoke] [--deep-peer-smoke-timeout-ms <n>] [--workflow-continuation-proof] [--execute-workflow-continuation-proof] [--workflow-continuation-proof-timeout-ms <n>] [--permission-diagnosis] [--permission-diagnosis-max-files <n>] [--permission-diagnosis-max-file-bytes <n>] [--record]` | shipping | Read-only diagnosis for host CLIs, auth, plugin cache/install state, companion readiness, model/effort observation, workflow/peer-run ledger health, optional read-only sandbox/permission probe, optional plan-only permission proof, explicit opt-in permission proof under host-native defaults, optional plan-only deep peer smoke preflight, explicit opt-in companion-contract smoke execution, optional plan-only engineer workflow continuation preflight, and explicit opt-in engineer state/dispatch continuation proof with raw peer stdout omitted. `--permission-diagnosis` (ADR-0038) is the read-only permission advisor: it classifies which observed tool calls are prompt-shaped, by host x mechanism, from usage records — sanitized, pointer-only, writing no artifact. `--record` writes sanitized doctor proof/report metadata for later version-matched reuse. |
| `/runtime:settings [--format text\|json] [--target repo\|user\|both] [--model <id>] [--effort <level>] [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>] [--apply] [--attest-codex-hook-review] [--execute-plugin-management] [--execute-plugin-cleanup] [--plugin-management-host all\|claude\|codex] [--permission-plan] [--permission-plan-max-files <n>] [--permission-plan-max-file-bytes <n>] [--skip-host-cli-probes] [--run-id <settings-run-id>]` | shipping | Dry-run settings planner for marketplace/plugin/CLI readiness and agentic-plugins-owned model/effort config. `--skip-host-cli-probes` runs the probe-free local plan per [`docs/settings-report-contract.md`](docs/settings-report-contract.md) — no `runDoctor`/host-CLI subprocess probes, filesystem-only model/effort resolution, a discriminated `report_scope=local_plan` report (`section_presence` map, `null` probe-derived sections, qualified `local plan:` text) that can never read as a clean full pass, no `runs/settings` execution artifact; `--apply` and the plan flags stay allowed while the execute/attest flags and their modifiers are rejected. `--apply` writes only `.agentic-plugins/config.toml`; `--execute-plugin-management` runs only allowlisted host-native plugin install/update/add/upgrade commands; `--execute-plugin-cleanup` runs only doctor-detected retired/unknown `agentic-plugins` Claude plugin cleanup commands; `--attest-codex-hook-review` records the operator's completed Codex `/hooks` review/trust step as a sanitized artifact; `--permission-plan` (ADR-0038) emits the M1 cross-host permission plan — the recommended `.claude/settings.json` and `~/.codex/config.toml` fragments (safety-graded, allowlist/posture cross-referenced, never `bypassPermissions`/`danger-full-access`), written only to a sanitized agentic-plugins-owned advisory artifact for the operator to apply, never to host config; all explicit executors omit raw stdout/stderr and write sanitized execution artifacts under `.agentic-plugins/runs/settings/<run-id>/`. |
| `/runtime:migrate workflow-storage [--format text\|json] [--plugin all\|engineer\|orchestrator] [--apply]` | shipping | Explicit ADR-0025 workflow storage migration planner. Dry-run reports legacy/canonical state, branch counts, peer-run and lock blockers, and source/destination paths. `--apply` moves only gitignored `.claude/agentic-*` workflow state into `.agentic-plugins/state/<plugin>` and writes a local migration manifest. |
| `/runtime:consensus plan\|record\|synthesize\|decide\|ratify\|cancel\|next-round\|execute\|status ...` | shipping | Runtime-owned consensus artifact manager and explicit companion executor. Creates fanout/rebuttal prompts, records or executes raw peer output as files, records owner decisions for unresolved consensus, records owner ratifications for converged runs whose synthesis flagged a residual owner lever, records artifact-only cancellation for stopped runs, and emits only sanitized execution metadata, synthesized summary, durable disagreements, evidence pointers, artifact paths, owner-decision/owner-ratification/cancellation pointers, `status --latest` guidance from the newest readable manifest, and `status --latest-open` guidance that skips terminal runs. |
| `/runtime:compat snapshot\|check\|ingest-release-notes\|plan ...` | shipping scaffold | Runtime-owned host-version compatibility artifact manager. Records Claude Code / Codex CLI version snapshots, compares them to the remembered host-parity baseline, stores explicit release-note files, URL pointers, or explicitly fetched URL content, requires changed-host/version release-note coverage, and emits compatibility update plans without fetching URLs by default or mutating host state. |
| `/runtime:worktree plan [--format text\|json] [--task <text>] [--branch <name>] [--base <ref>] [--worktree-dir <path>]` | shipping scaffold | Read-only dedicated-worktree planner. Reports current branch/dirtiness, existing `git worktree list --porcelain` entries, base-ref resolution, candidate branch/path availability, and suggested `git worktree add` commands without executing them. |
| `/runtime:context capture\|status\|check\|note ...` | shipping scaffold | Runtime-owned context hygiene artifact manager and read-only explicit budget check. Writes context summary, risk level, artifact pointers, next-session prompt/action, and read-only git source snapshot under `.agentic-plugins/runs/context/`; `status --latest` reads the newest handoff artifact with age stale metadata, source-freshness state, and explicit reuse-or-refresh guidance; `check` creates no artifact. ADR-0044 S3a adds `note (--text\|--file\|--clear)` — explicit, byte-capped, atomic session-capture note staging with operator/hook-grade output-mode split — and `status --slot`, a read-only validated inspection of the session-capture slot/entry/note files with per-file fail-closed skip. |
| `/runtime:dashboard [--format text\|json] [--watch] [--interval-seconds <n>] [--watch-count <n>] [--recent <n>]` | shipping scaffold | Read-only ADR-0040 §6 aggregate operator dashboard. Tier 1: active workflows for engineer, orchestrator, AND founder (persona-generic reads; doctor's `{engineer, orchestrator}` ledger contract untouched), peer runs with stale/non-terminal emphasis, orchestrator macro subtask progress, consensus run states. Tier 2: recorded doctor/compat/baseline freshness, settings and Codex hook-attestation recency, artifact-inventory attention items, notify-state health (expired dedupe claims, stale reclaim/rotation locks) read directly from `.agentic-plugins/state/runtime/notify/`, and recent `file-log` notifications when configured. `--watch` re-renders from filesystem reads only (never re-probes host CLIs) on a bounded poll interval (default 2s, floor 1s) with explicit exit (SIGINT or `--watch-count`). |
| `/runtime:cutover [record] [--format text\|json] [--completion-audit] [--footer-state <state>] [--omcc-dev-active yes\|no\|unknown] [--dogfood-date YYYY-MM-DD]` | shipping scaffold | omcc cutover readiness report plus explicit dogfood evidence recorder. Audit mode is read-only and aggregates ADR-0012 condition state, scorecard rows, legacy omcc-dev pattern-map completeness, host parity baseline freshness, installed/cache plugin versions, latest compat/consensus/context artifacts, forward-looking one-week omcc-dev-free dogfood evidence, latest footer evidence, and latest omcc-dev activity evidence. Text and JSON output include gate details that state the required threshold, current value, and blocker for ADR-0012, scorecard, parity, dogfood, footer, and final owner-declaration gates, plus an operator verification checklist for active manual checks such as Codex `/hooks`, dogfood records, and the owner cutover declaration. `--completion-audit` adds a prompt-to-artifact checklist plus ADR-0012 transition advice across requirement rows, condition rows, runtime commands, artifacts, gates, and weak/missing evidence for final-readiness review. `record` writes only sanitized cutover evidence artifacts under `.agentic-plugins/runs/cutover/`. It can only emit `cutover-ready-candidate`; final cutover remains a user declaration. |

### Permission-prompt advisor (ADR-0038)

Runtime ships an evidence-grounded, cross-host **permission-prompt advisor** split across its two operator surfaces, entirely inside the ADR-0035 R0/M1 tiers (no new mutation domain):

- **`runtime:doctor --permission-diagnosis` (R0)** reads available usage records (Claude transcripts, Codex rollouts) read-only and reports which observed tool calls are prompt-shaped, classified by host x mechanism (Claude Bash-not-allowlisted / file-modification / WebFetch-domain / MCP; Codex sandbox-blocked / approval-requested), with user-rejected calls surfaced as the definite signal. It writes no artifact.
- **`runtime:settings --permission-plan` (M1)** turns that evidence into a recommended, safety-graded host configuration for **both** hosts: a `.claude/settings.json` allow/deny/ask + `permissions.defaultMode` fragment (cross-referenced against your existing rules, which outrank an observation — a pattern already governed by an equal-or-stricter rule is never re-recommended, and the plan never emits a rule weaker than one you already set; where the advisor is stricter than your rule, it surfaces the conflict and still recommends the corrective one) and a `~/.codex/config.toml` `approval_policy` / `sandbox_mode` + bounded project-trust fragment. The plan never recommends `bypassPermissions` / `danger-full-access` (isolated-environment notes only) and is written only to a sanitized, agentic-plugins-owned advisory artifact under `.agentic-plugins/runs/permission/` for the operator to apply — **runtime never writes host config**, even with `--apply`.

Both surfaces sanitize to ADR-0038 §5: only generalized command patterns and counts are retained — never verbatim arguments, secrets, or transcript source paths. A runtime-shipped permission-relaxing Guard Hook is explicitly out of scope (ADR-0038 §6 defers it to a separate effect-based ADR amending ADR-0035 §4).

Runtime also ships `scripts/footer.mjs`, a helper persona completion surfaces use to render the ADR-0024 advisory footer from explicit fields or a `runtime:context` artifact pointer. The workflow-projection seam behind it models all four personas (engineer, orchestrator, founder, designer — ADR-0043 §1); code-emission wires up per persona as its ADR-0043 onboarding lands (§5 of that ADR tracks the per-persona rollout — a not-yet-onboarded persona simply emits nothing). It is intentionally not a new slash command.
The helper can also render advisory PR handling readiness so completion
surfaces use one criterion set before asking the user whether to commit,
push, and open a PR.
For omcc cutover dogfood work, it can render a host-localized
`runtime:cutover record` command from explicit footer state plus explicit
`--cutover-omcc-dev-active yes|no|unknown` evidence; this remains advisory
and does not write cutover artifacts.

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
$runtime:doctor --workflow-continuation-proof --execute-workflow-continuation-proof
$runtime:doctor --permission-proof --execute-permission-proof --deep-peer-smoke --execute-deep-peer-smoke --workflow-continuation-proof --execute-workflow-continuation-proof --record
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
$runtime:consensus decide --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --decision-file owner-decision.md
$runtime:consensus ratify --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --ratification-file owner-ratification.md --lever "fs-scoping timing: wait for a trigger"
$runtime:consensus cancel --run-id consensus-YYYYMMDDTHHMMSSZ-abcdef --reason-file cancellation-reason.md --confirm-no-active-process
$runtime:consensus status --latest
$runtime:compat snapshot
$runtime:compat ingest-release-notes --latest --release-notes-file /tmp/codex-release-notes.md
$runtime:compat ingest-release-notes --latest --release-notes-url https://example.com/codex-release-notes --fetch-release-notes-url
$runtime:compat plan --latest
$runtime:worktree plan --task "Next runtime operator slice"
$runtime:dashboard
$runtime:dashboard --format json
$runtime:dashboard --watch --interval-seconds 2 --watch-count 5
$runtime:context capture --summary "Handoff summary" --risk yellow --next-action "Start a fresh session before the next large change."
$runtime:context status --latest --stale-after-hours 12
$runtime:context check --token-budget 100000 --used-tokens 82000
$runtime:cutover record --footer-state next-work-available --footer-reason "release/install loop complete" --omcc-dev-active no
```

## Doctor behavior

Doctor is read-only with respect to source files, host configuration, host trust, auth, secrets, sandbox, and permission state. With `--record`, it may write only a generated runtime artifact under `.agentic-plugins/runs/doctor/`. It does not:

- install or update plugins;
- authenticate either host;
- write config;
- sweep, cancel, or prune peer-run ledgers;
- execute peer agents by default;
- relax sandbox or permission boundaries.

Readiness output starts with a `readiness_matrix` / `Readiness Matrix` summary that separates host CLI availability, runtime installation evidence, authentication state, direction-specific peer model/effort inputs, hook evidence, companion readiness, companion execution readiness, and sandbox/permission status. It distinguishes missing CLI, missing plugin/cache state, source-only availability, unauthenticated host, installed host evidence, and explicit executor evidence. Host `authenticated` remains the direct host auth probe result; execution readiness is reported separately from `--permission-proof --execute-permission-proof`, `--deep-peer-smoke --execute-deep-peer-smoke`, and `--workflow-continuation-proof --execute-workflow-continuation-proof` results so a child-process auth, sandbox failure, or workflow-state failure is not mistaken for direct shell auth state. By default companion sandbox/permission readiness remains `unknown`. `--sandbox-permission-probe` adds an explicit read-only preflight for both companion directions using the already observed CLI, auth, feature-surface, and companion-script evidence. It records `peer_execution=false`, does not run companion scripts, does not run peer agents, and does not mutate host-native config/auth/secrets/sandbox state. `--permission-proof` adds a structured plan-only preflight for both companion directions, including the permission surface, model/effort inputs, blockers, warnings, and next-step guidance. `--deep-peer-smoke` adds a structured plan-only preflight section for both companion directions, including readiness status, model/effort inputs, blockers, warnings, and next-step guidance. `--workflow-continuation-proof` adds a structured plan-only preflight for the engineer workflow state/dispatch path.

Doctor also reads the newest `runtime:compat` snapshot/gap/plan metadata and includes it in the runtime handoff artifact criterion. Host-version drift with missing or mismatched content-backed release notes blocks experience parity until the operator ingests release-note evidence that mentions the changed host and observed version, or refreshes the accepted baseline. This read is bounded to JSON metadata: doctor does not read raw release-note bodies or raw host help output from compatibility artifacts.

When `--record` is supplied, doctor writes `.agentic-plugins/runs/doctor/<run-id>/doctor.json` plus `latest.json`. The artifact is sanitized doctor output and stores proof status, byte counts, hashes, timing, and version metadata. A later doctor or cutover audit may reuse recorded proof for the experience-parity peer-execution criteria only when the current runtime version, host CLI versions, and plugin source/cache versions still match the recorded report; otherwise the proof is reported as not reusable and must be refreshed.

Doctor also emits a `host_parity` / `Host Parity` section. It makes
Claude-vs-Codex differences explicit rather than hiding them behind a shared
abstraction: Codex explicit skill surfaces and plugin-hook trust boundaries,
host-specific plugin install/update command shape, different permission
surfaces, stale host plugin caches, failed Claude plugin entries, and retired
agentic-plugins installs such as the old `research` plugin. These findings are
diagnostic output only; doctor does not uninstall, upgrade, or mutate either
host. Codex-specific capability drift, including the Codex plugin command
surface and plugin-hook readiness, is documented in
[`docs/codex-capability-baseline.md`](docs/codex-capability-baseline.md).
The source-backed parity matrix for Claude expectations that do not port
directly to Codex is documented in
[`docs/host-parity-baseline.md`](docs/host-parity-baseline.md).

Permission proof execution requires the separate `--execute-permission-proof` flag in addition to `--permission-proof`. The executor invokes each available companion through `companions/contract.md` JSON-envelope mode with the resolved model/effort inputs and no doctor-injected sandbox, approval, permission-mode, or host-native policy relaxation flags. Doctor output records only execution status, exit codes, peer host/model metadata, duration, stdout byte count, stdout SHA-256, and sanitized operator-action class. Permission, sandbox, and child-process auth failures are reported as `operator_action_required` with `operator_action_kind` values such as `permission_required`, `sandbox_blocked`, or `auth_required`; they are operator preconditions, not runtime implementation failures. Raw peer stdout, prompt bodies, host secrets, and account details are not printed into the main report. `--permission-proof-timeout-ms <n>` bounds each companion process. This proves companion invocation under current host permission defaults; it does not authorize future writes or broader tool use.

Deep peer smoke execution requires the separate `--execute-deep-peer-smoke` flag in addition to `--deep-peer-smoke`. The executor invokes each available companion through `companions/contract.md` JSON-envelope mode with the resolved model/effort inputs and no host session persistence beyond the companion behavior. Doctor output records only execution status, exit codes, peer host/model metadata, duration, stdout byte count, stdout SHA-256, and the same sanitized operator-action class when the companion is blocked by host preconditions. Raw peer stdout, prompt bodies, host secrets, and account details are not printed into the main report. `--deep-peer-smoke-timeout-ms <n>` bounds each companion process. This executor does not mutate host-native config/auth/secrets/sandbox state and does not claim Codex plugin-hook parity.

Workflow continuation proof execution requires the separate `--execute-workflow-continuation-proof` flag in addition to `--workflow-continuation-proof`. The executor creates an ephemeral temp repo, runs `plugins/engineer/scripts/state.mjs create`, dispatches the peer through `plugins/engineer/scripts/dispatch-peer.mjs` with ensemble bookkeeping flags, verifies `pending_ensemble` via `state.mjs read`, runs `state.mjs ensemble-commit`, and verifies that `ensemble_results` was recorded while the pending entry was cleared. Doctor output records only execution status, exit codes, peer host/model metadata, duration, stdout byte count, stdout SHA-256, and workflow state-check booleans. Raw peer stdout, prompt bodies, host secrets, account details, and temp workflow file bodies are not printed. `--workflow-continuation-proof-timeout-ms <n>` bounds each subprocess. The temp repo is removed best-effort; source files and host-native config/auth/secrets/sandbox/permission state are not mutated.

## Model and effort

ADR-0024 resolution order is reported as:

1. explicit doctor command flags;
2. workflow/subtask override observation;
3. repo-local `.agentic-plugins/config.toml`;
4. user-global `~/.agentic-plugins/config.toml`;
5. host-native default.

Companion invocation continues to use `companions/contract.md` `--model` and `--effort`; runtime does not invent a second path.

## Settings behavior

Settings is dry-run by default. It checks marketplace registration and install/cache state for `attention`, `companions`, `designer`, `engineer`, `founder`, `image`, `orchestrator`, and `runtime`; reports Claude Code and Codex CLI availability/version; and plans repo-local plus user-global model/effort defaults. When a host CLI is unavailable, settings emits a structured, non-executable host-CLI install plan with host-native installation guidance; it never installs Claude Code or Codex CLI itself.

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
install cache evidence. Codex `0.137.0` added a per-plugin `codex plugin add` /
`list` / `remove` surface beyond the prior marketplace-only `add` / `upgrade` /
`remove`. Runtime recognizes it (ADR-0032): doctor reports a
`per-plugin-and-marketplace` command surface — keyed on the observed `codex
plugin --help` command list, not the version — without claiming full Claude
parity, because Codex still lacks `update` / `enable` / `disable` / `details` /
`validate` / `prune`. On this per-plugin surface, `settings
--execute-plugin-management` can run `codex plugin add <plugin>@agentic-plugins`
as an **H2 executor** (ADR-0035 §5/§6, Claude-install parity): policy-gated at
execute time by a read-only `codex plugin list --available --json` pre-flight
(requires `installPolicy = AVAILABLE` and a non-`ON_INSTALL`/non-unknown
`authPolicy`, else blocked), post-verified via `codex plugin list --json`
(`CODEX_INSTALL_NOT_VERIFIED` when an exit-0 add is not confirmed), with a fixed
argv that excludes `-c`/`--config`/`--enable`/`--disable` and no Codex trust-state
mutation (`enabled ≠ trusted`). Older Codex (`0.130`–`0.136`) is reported as
`marketplace-only` and the recommendation stays manual; doctor surfaces the same
state in the readiness matrix and host-parity diagnostics.

It invokes commands as argv arrays, never through a shell, and records only status, exit code, byte counts, timing, retry classification, and sanitized error metadata. Raw stdout and stderr are omitted from settings output and artifacts. `--plugin-management-host all|claude|codex` scopes install/update execution. Settings writes `.agentic-plugins/runs/settings/<run-id>/settings.json` plus `.agentic-plugins/runs/settings/latest.json` for explicit plugin-management, plugin-cleanup, or Codex hook-review attestations; `runtime:doctor` reads those artifacts and reports failed action types, retryability, and the newest current hook-review attestation. Settings still does not write host-native Claude or Codex config (the former `--apply-codex-plugin-hooks` write was removed per ADR-0035 §6), mutate Codex hook trust state, change auth, secrets, sandbox/permission settings, or execute general plugin uninstall commands.

Codex hook trust remains an active-session UI operation. Settings prints a
per-plugin review target checklist for the bundled hooks, including the hook
file path, events, handler count, hook commands, and portability warnings to
compare against the active Codex `/hooks` view. Settings also reads
`~/.codex/config.toml` `[hooks.state]` and reports expected bundled hook
entries that are explicitly disabled. After opening `/hooks` in Codex and
reviewing/trusting those listed bundled agentic-plugins hooks, the operator can
record that manual step with:

```sh
$runtime:settings --attest-codex-hook-review
```

The attestation is not host-native proof and does not mutate Codex trust state.
It records the current hook-bearing plugin set, source versions, and review
target checklist, and is blocked while expected bundled hook entries are
explicitly disabled in Codex hook state.
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

Consensus is a runtime-owned artifact scaffold and explicit companion executor for ADR-0024 dynamic peer loops. Planning, recording, synthesis, owner-decision recording, owner-ratification recording, artifact-only cancellation, next-round, and status do not execute peers. The only direct dispatch path is `execute --execute`. The first flow is:

1. `plan`: create `<repo>/.agentic-plugins/runs/consensus/<run-id>/manifest.json`, `task.md`, and round-1 peer prompt files. The peer roster may include companion-backed peers (`claude`, `codex`) plus manual/subagent peer labels such as `security` or `release`; manual labels are record-only lanes. Each lane records an explicit role such as `claude_companion_peer` or `security_manual_subagent_peer`. The manifest also records a quality-first policy: objective `best-results-over-token-minimization`, all requested peers active by default unless `--max-peers` constrains breadth, host-native/runtime-settings model-effort defaults without token-saving downshift, and independent fanout plus bounded contradiction rebuttal as the default review depth. The round policy is explicit: `max_rounds` defaults to 2, `--max-rounds` is hard-capped at 3, and exhausted contradictions become `owner-decision-required`.
2. `execute --execute`: invoke only companion-backed `claude` and/or `codex` peers through `companions/contract.md`, bounded by peer list, process budget, max rounds, and timeout caps. Raw peer stdout is written under the run artifact tree; main output reports prompt pointer, raw-output pointer, byte count, SHA-256, status, failure type, and retryability only.
3. `record`: copy manually obtained peer raw output, including manual/subagent lane output, into the run artifact tree and update the manifest with pointer, byte count, and hash.
4. `synthesize`: write `consensus.json` with `synthesized_summary`, `convergence_state`, `durable_disagreements`, `contradictions`, `evidence_pointers`, `next_action`, and next-round availability.
5. `decide`: when consensus remains unresolved and the owner chooses a path, write `owner-decision.md` plus `owner-decision.json` with decision pointer, byte count, hash, previous consensus pointer, evidence pointers, and next action. The command does not print the decision text or create another round.
6. `ratify`: when a run converged (`aligned`/`complementary`) but the synthesis preserved a residual owner sub-lever as a durable disagreement, write `owner-ratification.md` plus `owner-ratification.json` with ratification pointer, byte count, hash, consensus pointer, optional single-line `--lever` summary, and next action. A plain ratification of an `aligned` run without a lever is also allowed. The manifest status stays `converged`; `consensus.json` and `convergence_state` are never rewritten. The command refuses unresolved runs (use `decide`), already-ratified runs, owner-decided runs, and cancelled runs, and does not print the ratification text; the `--lever` summary is displayed metadata, so sensitive detail belongs in the ratification body. Once any terminal artifact (cancellation, owner decision, ratification) exists, `record`/`synthesize`/`next-round`/`execute` refuse the run — and `decide`/`ratify` refuse all three terminal artifacts including their own — so the recorded resolution can never drift from the evidence it covered; the gates key on artifact pointers, not manifest status.
7. `cancel`: when a run is intentionally stopped, write `cancellation-reason.md` plus `cancellation.json` with reason pointer, byte count, hash, previous status, optional execution/progress pointers, and next action. The command does not print the reason text or kill host processes; if progress is running, it requires `--confirm-no-active-process`; it refuses owner-decided and ratified runs so their artifacts stay preserved.
8. `status`: read manifest, execution, progress, consensus-result, owner-decision, owner-ratification, and cancellation artifacts to recommend the next bounded operator action: execute/record, retry selected peers, synthesize, plan next-round for direct contradictions, record owner decision, proceed from owner decision, optionally ratify a converged run's residual owner lever, proceed from a recorded ratification, preserve non-consensus, or preserve a cancelled run. It also reports aggregate round-output completeness from the manifest so staged single-peer retries are distinguishable from the latest execution artifact summary. `status --latest` selects the newest readable manifest, while `status --latest-open` skips cancelled, converged, and owner-decided runs so terminal artifacts remain preserved without hiding the next open run. If a running progress artifact has exceeded its per-peer timeout without a final `execution.json`, status reports `execution_stalled` and asks the operator to inspect the progress artifact and confirm no original execute process is still active before retrying a guarded selected-peer command.
9. `next-round`: create targeted rebuttal prompts from synthesized direct-contradiction summaries when budget remains.
10. `execute --round <n> --execute`: run a bounded rebuttal round after `next-round`.

The convergence taxonomy is `aligned`, `complementary`, `contradiction`,
`insufficient-evidence`, `owner-decision-required`, and `non-consensus`.
`aligned` and `complementary` complete without a rebuttal round. `contradiction`
requires a bounded rebuttal round while `max_rounds` remains. When contradiction
persists after the bounded round budget, status reports owner decision rather
than inventing a compromise. Rebuttal prompts include issue framing, opposing
views, and the requested evidence standard; they are generated only from
durable disagreement summaries and never from raw peer output.

Main-session output intentionally omits raw peer output. It reports artifact pointers, prompt pointers, peer roles, quality policy, hashes, byte counts, aggregate round-output completeness, sanitized failure class/retryability, and the bounded consensus result only. Execution and progress artifacts also carry the per-peer prompt pointer so timeout or retry handoffs can inspect the exact prompt artifact without reading raw peer output. Permission, sandbox, approval, and child-process authentication failures are classified as `operator_action_required` with `failure_type` values such as `permission_required`, `sandbox_blocked`, or `auth_required`; they are non-retryable until the operator satisfies the host precondition outside runtime. CLI availability, network, timeout, and transient host failures remain separate classes. `runtime:doctor` reads the latest consensus execution artifact summary and reports failed retryability plus operator-action counts without reading raw peer output. This surface does not migrate persona workflow state, mutate companion scripts, alter host-native config/auth/secrets/sandbox/permission state, mutate host session context, or claim Codex plugin-hook parity. Automatic unbounded loops are forbidden; broader manual fanout is bounded by the explicit `--peers` roster, optional `--max-peers`, default 2-round contradiction loop, hard cap 3, process budget, and timeout caps rather than a hard-coded peer-count ceiling.

## Worktree behavior

Worktree planning is read-only. The command inspects `git worktree list --porcelain`, current branch/detached state, `git status --porcelain=v1`, base-ref resolution, candidate branch availability, and candidate worktree path availability. It then emits a suggested `git worktree add -b <branch> <path> <base>` command with `execute=false`.

`runtime:worktree` never creates branches, adds or removes worktrees, commits, pushes, opens PRs, or mutates runtime context. It recommends a dedicated worktree for non-trivial follow-up when the current checkout is on `main`, dirty, detached, or already sharing work with other worktrees. Blockers such as an unresolved base ref, existing target branch, or occupied target path must be resolved before running the suggested command manually.

## Context behavior

Context is a runtime-owned artifact scaffold and read-only check surface for ADR-0024 context hygiene. It does not inspect or mutate host session context directly. The first flows are:

1. `capture`: create `<repo>/.agentic-plugins/runs/context/<run-id>/context.json`, `summary.md`, and `next-session-prompt.md`; when git is available, record the current commit, branch, and dirty-state as read-only source metadata.
2. `status`: read the stored artifact by `--run-id`, or read the newest readable artifact with `--latest`, and emit the same bounded handoff fields plus age/stale metadata, source-freshness metadata comparing the artifact commit to the current git commit, and advisory reuse-or-refresh guidance.
3. `check`: compute an advisory green/yellow/red risk from caller-supplied `--token-budget` plus `--used-tokens` or `--remaining-tokens`, or from caller-supplied `--risk`.
4. `note` (ADR-0044 S3a): stage a semantic handoff note into `<repo>/.agentic-plugins/state/runtime/session-capture/note.json` via `--text`/`--file`, or empty the staging slot with `--clear`. The write is byte-capped (4096 UTF-8 bytes), atomic (uniquely named sibling temp + rename), containment-checked before any directory creation, and records staging-time git context; `--file` reads only a regular file (lstat no-follow — FIFO/device/symlink sources rejected). The explicit invocation is the ADR-0035 invariant-1 opt-in; the `session_capture` config gate governs only the S3b publisher. Operator invocations report on stdout and exit 1 on error; `--hook-grade` (hook/sidecar callers) exits 0 always, writes nothing to stdout, and emits at most one stderr line.
5. `status --slot` (ADR-0044 S3a): read-only inspection of the session-capture staging area — schema- and semantics-validated `slot.json`/`entry.json`/`note.json` with per-file fail-closed skip, a slot/entry generation verdict (`committed`/`mixed`/`absent`), and advisory note fold-window age diagnostics. Note bodies are never echoed; malformed files are skipped, never repaired or deleted on read.

Context output is intentionally limited to:

- context summary;
- risk level (`green`, `yellow`, or `red`);
- artifact pointers;
- recommended next-session action;
- generated or caller-supplied next-session prompt preview and pointer.
- read-only handoff lookup metadata for `status`, including selected artifact age, stale/not-stale state, source-freshness state, dirty-state hints, and handoff guidance.

`status --latest` reads existing artifacts only; it does not create, update, or compact anything. If the selected handoff is age-stale, source-stale, source-unknown, or the current worktree is dirty, status recommends a fresh capture before relying on the artifact as next-session truth, but it still does not trigger capture automatically. `check` does not create a context artifact, trigger `capture`, measure host context automatically, compact the session, or start a new session. This scaffold does not migrate persona workflow state, run peers, paste consensus raw output into the main session, mutate host-native config/auth/secrets/sandbox state, or claim Codex plugin-hook parity.

## Completion footer behavior

The footer helper renders the standard ADR-0024 completion footer:

- context state (`green`, `yellow`, or `red`);
- linked context artifact, lookup freshness, and handoff guidance when a context artifact is supplied;
- linked consensus run and bounded status guidance when a consensus run is supplied;
- workflow kind/id/path;
- artifact pointers, including `.agentic-plugins/runs/context/<run-id>/context.json` and `.agentic-plugins/runs/consensus/<run-id>/` when linked;
- completion state (`review-needed`, `publish-needed`, `cleanup-needed`,
  `next-work-available`, `blocked`, or `closed`) plus a state-derived next
  action;
- recommended next work;
- next-session action and command or prompt pointer;
- explicit advisory/pointer-only limits.
- optional PR handling readiness, with criteria for deliverable boundary,
  validation, context risk, blocking reviews, and branch pushability.

When supplied `--context-run-id`, the helper reads only bounded fields from the matching `runtime:context` artifact: risk level, artifact pointers, recommended action, next-session prompt pointer, lookup freshness, and handoff guidance. It does not print the context summary body, prompt body, raw peer output, or consensus raw output.

When supplied `--context-latest`, the helper reads the newest existing readable `runtime:context` artifact and reports read-only lookup metadata, including selected timestamp, age, stale state, stale threshold, skipped invalid artifacts, source-freshness state when a git source snapshot is available, and handoff guidance. Guidance can recommend reusing the handoff, inspecting unverifiable source state, capturing new context, or settling a dirty worktree before capture. `--stale-after-hours <n>` sets the age-based stale threshold. The latest lookup does not create, update, or compact context.

When supplied `--consensus-run-id`, `--consensus-latest`, or `--consensus-latest-open`, the helper calls `runtime:consensus status` and includes only run/result/execution/progress pointers plus `status_guidance` next action/steps. Latest consensus lookup selects the newest readable consensus manifest; latest-open lookup skips cancelled, converged, and owner-decided runs while preserving them as audit artifacts. The footer does not execute peers, synthesize, plan another round, print peer prompts, print peer raw output, or print consensus body text.

Completion state is conservative by default. The helper infers
`publish-needed` only when PR handling readiness passes, `blocked` when PR
or consensus evidence is blocked, `next-work-available` when consensus or
caller-supplied follow-up work is actionable, and `review-needed` when
evidence is incomplete or should be inspected. `cleanup-needed` and `closed`
are explicit caller states; `closed` is never inferred from partial runtime
evidence. Callers may use `--completion-state`, `--completion-reason`, and
`--completion-next-action` to report a fully known completion outcome.

Embedded `runtime:*` guidance commands are rendered with the selected host's invocation syntax when `--host claude` or `--host codex` is supplied, while stored context and consensus artifacts remain host-neutral.

When supplied PR handling fields, the helper recommends `ask-user` only
when the deliverable boundary is reached, validation passed or was
explicitly waived, context risk is green/yellow, no blocking review
findings remain, and the branch is pushable. Incomplete evidence returns
`defer`; failed criteria return `block`. The helper never commits, pushes,
opens PRs, updates PR metadata, merges, or marks a PR ready for review.

## Bootstrap behavior

`runtime:bootstrap` is the ADR-0046 machine-scoped, artifact-only bootstrap
lifecycle — the staged path from a bare host to a proven agentic-plugins
install. The normative contract is
[`docs/machine-bootstrap-contract.md`](docs/machine-bootstrap-contract.md)
(packaged in this plugin); the script owns facts, schemas, state, and the
completion reducer, and the command/skill markdown owns interview pacing only.

**Stage 0 is pre-runtime, document-only, and host-native** — runtime does not
exist on the machine yet, so these exact commands are run manually (they are
the same block the contract's §2 carries):

```sh
# Claude Code
claude plugin marketplace add each4all/agentic-plugins
claude plugin install runtime@agentic-plugins

# Codex CLI
codex plugin marketplace add each4all/agentic-plugins
codex plugin add runtime@agentic-plugins
```

From Stage 1 on, `runtime:bootstrap plan` starts a run: it probes both host
CLIs live (neutral cwd, `$CODEX_HOME` honored), resolves the selected bundle
(`base` | `engineering` | `business` | `design` | `full` | `custom` with
`--plugins`, hard-dependency closure enforced), judges the expected-step
registry from observed state only, renders Stage 4–6 fragments (model/effort,
Codex notification channel, egress launcher, and **both** hosts' permission
plans) with per-fragment backup/verify/manual-revert guidance, and presents —
never executes — the plugin-management command carrying the §1.6 plan hash
(`runtime:settings --execute-plugin-management --expected-plan-hash <hash>`;
the executor refuses on divergence). `status` and `verify` are read-only:
they re-probe and re-judge in memory and write nothing; `verify` judges the
**recorded** proof evidence (`passed` / `failed` / `stale` / `absent`) and
never runs a proof to make itself pass. `resume` is the only verb that
produces Stage-8 evidence: on an explicit operator `execute` answer it invokes
`runtime:doctor --record` with the relevant `--execute-*` flag and copies the
proof's metadata only (per-direction results, pointers, hashes, bound
versions) into the run. `abandon` closes a crashed or unwanted run so a new
plan can start; nothing the operator already applied is ever reversed.
`profile export` / `profile seed` carry a secrets-free, enumerated,
user-global-only machine profile between machines: seeded values are interview
defaults requiring confirmation, never configuration to apply, and never an
input to any activation or config loader. Completion has two terminal states —
`complete` (config resolved **and** every required proof passed at current
bound versions) and `configured-not-verified` — because "installed" and
"proven" are different claims. Run artifacts and profiles live only under the
machine-global `~/.agentic-plugins/` home (0700/0600, atomic writes,
family-wide lock, retention reported but never auto-deleted).

## Install

```sh
# Claude Code
claude plugin install runtime@agentic-plugins

# Codex CLI
codex plugin marketplace add each4all/agentic-plugins
```

## License

[MIT](../../LICENSE).
