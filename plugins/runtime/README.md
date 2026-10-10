# runtime

Runtime operator control plane for agentic-plugins. **L1 framework primitive** per [ADR-0024](../../docs/adr/0024-runtime-operator-control-plane.md).

## Status

Ships `runtime:doctor`, `runtime:settings` with explicit plugin-management and retired-plugin cleanup execution plus durable sanitized execution artifacts, a Codex hook-review operator attestation artifact for the manual `/hooks` trust step, `runtime:consensus` with artifact scaffolding plus an explicit companion executor, convergence taxonomy, owner-decision artifacts for exhausted or otherwise unresolved consensus, owner-ratification artifacts for converged runs whose synthesis flagged a residual owner lever, and artifact-only cancellation for abandoned or intentionally stopped consensus runs, `runtime:worktree` with a read-only dedicated-worktree planner, the first runtime-owned `runtime:context` scaffold with a read-only explicit budget check, an explicit `runtime:migrate workflow-storage` path migration surface, `runtime:dashboard` with the ADR-0040 §6 read-only Tier 1 + Tier 2 aggregate operator snapshot (three-persona workflow/peer-run state, macro subtask progress, consensus runs, the ADR-0045 §7 snapshot-only arbitrated entry advisory behind an explicit `--host`, recorded doctor freshness, settings and Codex hook-attestation recency, artifact attention items, and a filesystem-only `--watch` mode that always excludes the advisory), and a pointer-only completion footer helper. `runtime:consensus` peer breadth is bounded by the explicit `--peers` roster and optional `--max-peers`, not by a hidden fixed product cap; contradiction rebuttal defaults to 2 total rounds, is hard-capped at 3, and exhausted contradictions become `owner-decision-required` instead of another loop. The explicit `decide` command records the owner decision as a pointer, byte count, hash, previous consensus pointer, and evidence pointers without printing the decision text or executing another peer round. The explicit `ratify` command is the converged-run mirror: it records the owner's resolution of a synthesis-flagged residual owner lever as a ratification pointer, byte count, hash, and optional single-line lever summary while the manifest status stays `converged` and `consensus.json`/`convergence_state` stay untouched, without printing the ratification text or executing peers. The explicit `cancel` command records a cancellation reason pointer, byte count, hash, previous status, and progress pointer without printing the reason text or killing host processes; if progress is running, it requires operator confirmation that no original execute process is still active. `runtime:context` captures a read-only git source snapshot when available, and `status`/footer lookup report age-based stale state, source-freshness state, and handoff guidance so a time-fresh handoff can still be flagged when the current git commit moved or source state is unverifiable. The footer can also link read-only `runtime:consensus status` guidance from an explicit or latest consensus run without printing peer prompts, peer raw outputs, owner decision text, cancellation reason text, or consensus body text. `runtime:doctor --permission-proof` reports a plan-only permission proof preflight without peer execution, `runtime:doctor --permission-proof --execute-permission-proof` runs a bounded companion-contract proof under host-native permission defaults, `runtime:doctor --deep-peer-smoke` reports a plan-only preflight, `runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke` runs a bounded companion-contract smoke, `runtime:doctor --workflow-continuation-proof` reports a plan-only engineer workflow continuation preflight, and `runtime:doctor --workflow-continuation-proof --execute-workflow-continuation-proof` runs a bounded proof through engineer state plus dispatch while omitting raw peer stdout from doctor output. The real-network egress provider-ack proof (`--egress-ack-proof`, ADR-0048 §3) was removed with the egress subsystem by ADR-0064 Decision 1 (2026-10-05), and the read-only sandbox permission probe (`--sandbox-permission-probe`) by its Decision 4; that probe's per-direction preflight still runs inside `--permission-proof`. Doctor and settings both print per-plugin Codex hook review targets for `/hooks`, including hook file paths, events, commands, and warnings. With `--record`, doctor writes sanitized proof/report metadata under `.agentic-plugins/runs/doctor/`; later doctor runs reuse that proof only while runtime, host CLI, and plugin source/cache versions still match. Host versions are reported as observed facts with no verdict; ADR-0060 removed host-version tracking and both host baseline documents (see [Host-version tracking was removed](#host-version-tracking-was-removed-adr-0060)), and ADR-0064 retired the omcc cutover audit (see [`runtime:cutover` was retired](#runtimecutover-was-retired-adr-0064)). Automatic unbounded consensus loops, host-process cancellation/kill, proof retention mutation, host-native config apply (the former narrow `plugin_hooks` write was removed per ADR-0035 §6), and automatic context mutation/capture triggers are deferred to follow-up PRs and tracked in [`docs/follow-ups.md`](docs/follow-ups.md).

Codex hook diagnosis also reads `~/.codex/config.toml` `[hooks.state]` and reports expected bundled hook entries that are enabled, disabled, missing, or untrusted. A hook-review attestation is blocked while expected bundled hook entries are explicitly disabled, which keeps stale or manually disabled hook rows from being hidden behind a generic `/hooks` follow-up.

## What it is

`runtime` owns cross-plugin host/runtime truth shared by `engineer`, `orchestrator`, and future plugins:

- host CLI availability and auth diagnosis;
- marketplace, install, and cache state;
- companion discovery and contract compatibility;
- model/effort observation along the ADR-0024 resolution order;
- opt-in companion permission, peer-smoke, and workflow-continuation proofs;
- workflow and peer-run ledger health;
- read-only worktree planning for isolating non-trivial follow-up slices;
- bounded context hygiene artifacts for next-session handoff.
- read-only aggregate operator dashboard over persona workflow/peer-run ledgers, macro subtask progress, consensus runs, the snapshot-only arbitrated entry advisory, and recorded operator-health evidence.
- advisory completion footer rendering for workflow handoff pointers.

The workflow readers behind doctor, the dashboard and the entry brief read
persona and orchestrator records across the ADR-0067 read set: the default
state root, where git placed the main worktree, then the checkout when it
differs. From a linked worktree they therefore see workflows stored under the
main worktree as well as the worktree's own, and report two files holding one
branch key or workflow id as ambiguity. Handoff slots, session capture and
run ledgers stay per checkout. Install procedure and the collision check that
precedes it: [`docs/runbooks/shared-state-readers.md`](../../docs/runbooks/shared-state-readers.md).

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
| `/runtime:doctor [--format text\|json] [--model <id>] [--effort <level>] [--permission-proof] [--execute-permission-proof] [--permission-proof-timeout-ms <n>] [--deep-peer-smoke] [--execute-deep-peer-smoke] [--deep-peer-smoke-timeout-ms <n>] [--workflow-continuation-proof] [--execute-workflow-continuation-proof] [--workflow-continuation-proof-timeout-ms <n>] [--record] [--strict]` | shipping | Read-only diagnosis for host CLIs, auth, plugin cache/install state, companion readiness, model/effort observation, workflow/peer-run ledger health, optional plan-only permission proof, explicit opt-in permission proof under host-native defaults, optional plan-only deep peer smoke preflight, explicit opt-in companion-contract smoke execution, optional plan-only engineer workflow continuation preflight, and explicit opt-in engineer state/dispatch continuation proof with raw peer stdout omitted. The report's `session_capture` section (ADR-0044 S4) diagnoses the half-enabled capture states — key on but attention missing/disabled, runtime below the dynamically-declared publisher floor, safe mode — via the shared readiness assessment, and the `entry_brief` section (ADR-0045 S8, session-capture-contract.md §18) mirrors it for the entry hook chain: the additive `floors.entry_brief` declaration, `runtime-below-entry-floor`, and the executor-existence probe (`entry-executor-missing` at a passing floor). `--record` writes sanitized doctor proof/report metadata for later version-matched reuse. Exit `0` no hard failures and every requested proof executor passed / `10` findings (`overall.status` is `fail`, or `warning` under the opt-in `--strict`) / `20` a requested proof produced no usable verdict for some lane / `30` a requested proof needs operator action in the host / `40` `--record` could not persist the artifact / `2` invalid usage / `1` unexpected. Codes `10` and above still write the complete report to stdout, so a caller parses the report and reads the code as a classifier; `1` and `2` produce no report. |
| `/runtime:settings [--format text\|json] [--target repo\|user\|both] [--model <id>] [--effort <level>] [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>] [--apply] [--attest-codex-hook-review] [--execute-plugin-management] [--execute-plugin-cleanup] [--plugin-management-host all\|claude\|codex] [--skip-host-cli-probes] [--run-id <settings-run-id>]` | shipping | Dry-run settings planner for marketplace/plugin/CLI readiness and agentic-plugins-owned model/effort config. `--skip-host-cli-probes` runs the probe-free local plan per [`docs/settings-report-contract.md`](docs/settings-report-contract.md) — no `runDoctor`/host-CLI subprocess probes, filesystem-only model/effort resolution, a discriminated `report_scope=local_plan` report (`section_presence` map, `null` probe-derived sections, qualified `local plan:` text) that can never read as a clean full pass, no `runs/settings` execution artifact; `--apply` stays allowed (the plan flags it once allowed were removed by ADR-0057 and ADR-0064) while the execute/attest flags and their modifiers are rejected. `--apply` writes only `.agentic-plugins/config.toml`; `--execute-plugin-management` runs only allowlisted host-native plugin install/update/add/upgrade commands; `--execute-plugin-cleanup` runs only doctor-detected retired/unknown `agentic-plugins` Claude plugin cleanup commands; `--attest-codex-hook-review` records the operator's completed Codex `/hooks` review/trust step as a sanitized artifact;  all explicit executors omit raw stdout/stderr and write sanitized execution artifacts under `.agentic-plugins/runs/settings/<run-id>/`. `--session-capture off\|stop-hook` plans the ADR-0044 opt-in key, and the report's `session_readiness` section (ADR-0044 S4, evaluated in both report scopes) surfaces the half-enabled capture states via the same shared assessment doctor reads; the `entry_readiness` section (ADR-0045 S8, contract §18) mirrors it for the entry hook chain, executor-existence probe included. `--entry-brief off\|startup` / `--entry-brief-empty silent\|report` plan the ADR-0045 user-scope-only entry keys: the repo target structurally refuses them (`refused_user_scope_only`), a tracked repo value is reported as ignored, and the effective resolution is env (`AGENTIC_ENTRY_BRIEF*`) > user-global > shipped default. |
| `/runtime:migrate workflow-storage [--format text\|json] [--plugin all\|engineer\|orchestrator] [--apply]` | shipping | Explicit ADR-0025 workflow storage migration planner. Dry-run reports legacy/canonical state, branch counts, peer-run and lock blockers, and source/destination paths. `--apply` moves only gitignored `.claude/agentic-*` workflow state into `.agentic-plugins/state/<plugin>` and writes a local migration manifest. |
| `/runtime:migrate legacy-egress-intents` | removed | The ADR-0048 residual (d) read-only inventory of pre-upgrade egress intent WALs was removed with the egress subsystem by [ADR-0064](../../docs/adr/0064-runtime-surface-reduction.md) Decision 1 (2026-10-05). The command refuses the name, exit `1`, and runs nothing. |
| `/runtime:consensus plan\|record\|synthesize\|decide\|ratify\|cancel\|next-round\|execute\|status ...` | shipping | Runtime-owned consensus artifact manager and explicit companion executor. Creates fanout/rebuttal prompts, records or executes raw peer output as files, records owner decisions for unresolved consensus, records owner ratifications for converged runs whose synthesis flagged a residual owner lever, records artifact-only cancellation for stopped runs, and emits only sanitized execution metadata, synthesized summary, durable disagreements, evidence pointers, artifact paths, owner-decision/owner-ratification/cancellation pointers, `status --latest` guidance from the newest readable manifest, and `status --latest-open` guidance that skips terminal runs. |
| `/runtime:worktree plan [--format text\|json] [--task <text>] [--branch <name>] [--base <ref>] [--worktree-dir <path>]` | shipping scaffold | Read-only dedicated-worktree planner. Reports current branch/dirtiness, existing `git worktree list --porcelain` entries, base-ref resolution, candidate branch/path availability, and suggested `git worktree add` commands without executing them. A persona start that a dirty tree or another active workflow blocks prints this planner's command as its first proposal ([ADR-0067](../../docs/adr/0067-autopilot-worktree-lanes-and-proposals.md) Decision 8, item 3); `/orchestrator:next` renders its own from the same path rule. |
| `/runtime:context capture\|status\|check\|note\|publish-session\|entry-brief ...` | shipping scaffold | Runtime-owned context hygiene artifact manager and read-only explicit budget check. Writes context summary, risk level, artifact pointers, next-session prompt/action, and read-only git source snapshot under `.agentic-plugins/runs/context/`; `status --latest` reads the newest handoff artifact with age stale metadata, source-freshness state, and explicit reuse-or-refresh guidance; `check` creates no artifact. ADR-0044 S3a adds `note (--text\|--file\|--clear)` — explicit, byte-capped, atomic session-capture note staging with operator/hook-grade output-mode split — and `status --slot`, a read-only validated inspection of the session-capture slot/entry/note files with per-file fail-closed skip. ADR-0044 S3b adds `publish-session`, the hook-grade slot publisher gated by the `session_capture` config key (default `off`), intended for the attention Stop sensor; config-off stops production while existing artifacts stay readable, abrupt termination hands off the previous turn's slot, and rollback is consumer-first with a one-shot `state/runtime/session-capture/` cleanup (see [`docs/session-capture-contract.md`](docs/session-capture-contract.md) §9/§13). ADR-0045 S7b adds `entry-brief`, the R0 entry arbiter: bounded reads over persona/orchestrator state, the macro bridge, handoff slots, entry.json, and runtime ledgers; one pointer-only brief (`runtime-entry-brief-1.0`) whose single command is synthesized from the contract §16 lattice and host-localized; `--surface cli|dashboard` always compute while `--surface session-start-hook` is hook-grade and gated by the user-scope-only `entry_brief` key (contract §14-§17). |
| `/runtime:dashboard [--format text\|json] [--host claude\|codex] [--watch] [--interval-seconds <n>] [--watch-count <n>]` | shipping scaffold | Read-only ADR-0040 §6 aggregate operator dashboard. Tier 1: active workflows for engineer, orchestrator, AND founder (persona-generic reads; doctor's `{engineer, orchestrator}` ledger contract untouched), peer runs with stale/non-terminal emphasis, orchestrator macro subtask progress, consensus run states, and the ADR-0045 §7(ii) **entry advisory** — the same arbitrated pointer-only brief `runtime:context entry-brief` computes for the current branch, snapshot mode only, behind the wrapper-threaded trusted `--host` (`skipped (host-not-threaded)` without one; the `entry_brief` gate is informational — the section always computes). Tier 2: recorded doctor freshness, settings and Codex hook-attestation recency, and artifact-inventory attention items (the notify-state and recent-notification rows went with notification, ADR-0064 Decision 1; report `runtime-dashboard-4.0`). `--watch` re-renders from filesystem reads only (never re-probes host CLIs, never spawns, always excludes the entry advisory before the arbiter runs) on a bounded poll interval (default 2s, floor 1s) with explicit exit (SIGINT or `--watch-count`). Snapshot mode's advisory is the one declared exception to the dashboard's no-spawn shape: bounded git probes via the shared entry-brief executor (contract §17). |

### Host permission configuration — runtime offers no opinion (ADR-0057)

Runtime once shipped an evidence-grounded, cross-host **permission-prompt advisor**
(`runtime:doctor --permission-diagnosis` for the read-only diagnosis,
`runtime:settings --permission-plan` for the safety-graded host-config fragment).
[ADR-0057](../../docs/adr/0057-permission-advisor-removal.md) removed it. Its premise
was allowlist catch-up — an allow list that accretes and still prompts — and Claude
Code solved that in the host with a permission **mode**, `auto`, that decides per call
through a model classifier instead of matching a list. The advisor never modelled
`auto`, and run on the machine it was written for it recommended `allow: []` plus 90
restrictions, including denying `cd`, `cat` and `git status`.

Two things survived the removal deliberately, because measurement showed they were not
advisor machinery:

- **`runtime:doctor --permission-proof --execute-permission-proof`** takes no advisor
  input. It is the dedicated live proof that *records* ADR-0035 §4's no-relaxation
  fact — that runtime injected no sandbox, approval, or permission-mode flags. It used
  to apply only when an operator had applied an advisor fragment; it is now always
  applicable and declinable, like `--deep-peer-smoke`.
- **The portable machine profile kept `permissions.claude.defaultMode`** —
  reproducing a machine needed the operator's chosen mode. Its enum was *widened*, not
  deleted: it omitted `auto` and `dontAsk`, so it refused this machine's real posture
  exactly as it refused a nonsense string. The profile itself was removed later, by
  [ADR-0064](../../docs/adr/0064-runtime-surface-reduction.md) Decision 3
  (2026-10-04).

A runtime-shipped permission-relaxing Guard Hook remains explicitly out of scope.
ADR-0038 §6 refused it by **effect** rather than by who flips the switch, and ADR-0057
§Decision 8 carries that refusal forward as binding rather than vacating it with the
advisory it shipped alongside.

Runtime also ships `scripts/footer.mjs`, a helper persona completion surfaces use to render the ADR-0024 advisory footer from explicit fields or a `runtime:context` artifact pointer. The workflow-projection seam behind it models all four personas (engineer, orchestrator, founder, designer — ADR-0043 §1); code-emission wires up per persona as its ADR-0043 onboarding lands (§5 of that ADR tracks the per-persona rollout — a not-yet-onboarded persona simply emits nothing). It is intentionally not a new slash command.
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
$runtime:worktree plan --task "Next runtime operator slice"
$runtime:dashboard
$runtime:dashboard --format json
$runtime:dashboard --watch --interval-seconds 2 --watch-count 5
$runtime:context capture --summary "Handoff summary" --risk yellow --next-action "Start a fresh session before the next large change."
$runtime:context status --latest --stale-after-hours 12
$runtime:context check --token-budget 100000 --used-tokens 82000
```

## Doctor behavior

Doctor is read-only with respect to source files, host configuration, host trust, auth, secrets, sandbox, and permission state. With `--record`, it may write only a generated runtime artifact under `.agentic-plugins/runs/doctor/`. It does not:

- install or update plugins;
- authenticate either host;
- write config;
- sweep, cancel, or prune peer-run ledgers;
- execute peer agents by default;
- relax sandbox or permission boundaries.

Readiness output starts with a `readiness_matrix` / `Readiness Matrix` summary that separates host CLI availability, runtime installation evidence, authentication state, direction-specific peer model/effort inputs, hook evidence, companion readiness, and companion execution readiness. It distinguishes missing CLI, missing plugin/cache state, source-only availability, unauthenticated host, installed host evidence, and explicit executor evidence. Host `authenticated` remains the direct host auth probe result; execution readiness is reported separately from `--permission-proof --execute-permission-proof`, `--deep-peer-smoke --execute-deep-peer-smoke`, and `--workflow-continuation-proof --execute-workflow-continuation-proof` results so a child-process auth, sandbox failure, or workflow-state failure is not mistaken for direct shell auth state. Readiness does not judge companion permission state. `--permission-proof` adds a structured plan-only preflight for both companion directions: read-only CLI, auth, permission-surface, and companion-script evidence taken from the already observed probes (it records `peer_execution=false`, does not run companion scripts or peer agents, and does not mutate host-native config/auth/secrets/sandbox state), plus model/effort inputs, blockers, warnings, and next-step guidance. The former `--sandbox-permission-probe` reported that same preflight on its own; ADR-0064 Decision 4 removed it, and doctor refuses the flag as an unknown argument. `--deep-peer-smoke` adds a structured plan-only preflight section for both companion directions, including readiness status, model/effort inputs, blockers, warnings, and next-step guidance. `--workflow-continuation-proof` adds a structured plan-only preflight for the engineer workflow state/dispatch path.

Doctor reports the observed `claude --version` and `codex --version` under `clis`, as facts with no verdict attached: since [ADR-0060](../../docs/adr/0060-remove-host-version-tracking.md) nothing compares them against a remembered pair. The runtime handoff artifact criterion reads the settings and consensus collections only.

When `--record` is supplied, doctor writes `.agentic-plugins/runs/doctor/<run-id>/doctor.json` plus `latest.json`. The artifact is sanitized doctor output and stores proof status, byte counts, hashes, timing, and version metadata. A later doctor run may reuse recorded proof for the experience-parity peer-execution criteria only when the current runtime version, host CLI versions, and plugin source/cache versions still match the recorded report; otherwise the proof is reported as not reusable and must be refreshed.

Doctor also emits a `host_parity` / `Host Parity` section. It makes
Claude-vs-Codex differences explicit rather than hiding them behind a shared
abstraction: Codex explicit skill surfaces and plugin-hook trust boundaries,
host-specific plugin install/update command shape, different permission
surfaces, stale host plugin caches, failed Claude plugin entries, and retired
agentic-plugins installs such as the old `research` plugin. These findings are
diagnostic output only; doctor does not uninstall, upgrade, or mutate either
host.

### Host-version tracking was removed (ADR-0060)

Before ADR-0060 this package carried a host-parity baseline
(`docs/host-parity-baseline.md`, with its Codex sibling
`docs/codex-capability-baseline.md`), a `runtime:compat` command that snapshotted
host versions and planned against release notes, and a doctor check that
reported whether the installed Claude Code / Codex CLI pair was the one the
baseline had been reviewed against. [ADR-0060](../../docs/adr/0060-remove-host-version-tracking.md)
removed all of it: the baseline was refreshed eight times in under three months
while the behaviour it recorded changed about once, and every null refresh cost a
release. What an operator sees now:

- **Nothing detects host drift.** A host change that breaks a surface this
  package depends on is discovered when the surface breaks. The probed matrices
  the baseline recorded were deleted with it (§Decision 2), not relocated.
- **Host versions are still reported** — `doctor` keeps the raw observation in
  `clis`. `runtime:cutover` repeated it in its `host_pair_identity`
  observation, labelled `not_verified`, until ADR-0064 retired the audit.
- **Retained records keep reading.** Doctor artifacts from every earlier schema
  era stay readable (report `runtime-doctor-1.3` adds no new section; it only
  lost `host_parity_baseline` and `compat_runs`, and `runtime-doctor-1.4`,
  ADR-0064, only loses `egress_ack_proof`, `sandbox_permission_probe` and the
  per-direction `sandbox_permission` members), and historical assurance
  results in them are still decoded and reported as `historical_assurance`,
  never mapped onto a current status (ADR-0056). Recorded compat runs under
  `.agentic-plugins/runs/compat/` are left on disk, unread: the inventory still
  counts them, and retention no longer manages them.

### `runtime:cutover` was retired (ADR-0064)

`runtime:cutover` audited the omcc → agentic-plugins cutover (ADR-0007,
ADR-0012) and recorded dogfood evidence, and the completion footer could
suggest its `record` command. The owner declared the cutover on 2026-06-03.
The audit's last recorded run was that day. Its unrecorded read-only reruns on
2026-09-23 and 2026-09-29 computed `not-ready` only because the newest context
artifact had aged.
[ADR-0064](../../docs/adr/0064-runtime-surface-reduction.md) §Decision 5
removed the command, its Codex skill, `scripts/cutover-audit.mjs` and the
footer's `--cutover-*` flags. What an operator sees now:

- **The declaration is final.** The audit's later `not-ready` computations
  and the frozen [cutover scorecard](../../docs/assurance/omcc-cutover-scorecard.md)
  are history; nothing re-decides the cutover.
- **The footer refuses `--cutover-*`** as unknown arguments, and its report
  has no `cutover_record` field.
- **Recorded cutover evidence is left on disk, unread.** Retention no longer
  scans `.agentic-plugins/runs/cutover/` for citations (scanner
  `runtime-retention-scanner-1.1`), so a doctor or settings run that only a
  cutover record cited is no longer pinned by it.

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

Once the Codex catalog pins each plugin to its release commit (ADR-0061), doctor
reports three separate facts per Codex plugin in `plugins.<name>.codex_install`:
the catalog target (the `ref` version and `sha`), the installed version, and whether
the installed files were verified against the tree at the pinned commit (a read-only
`git ls-tree` of the registered marketplace clone's object store). Host parity names
installs that are behind, ahead of, or divergent from their pin, and settings turns
the first and last into a manual repair follow-up. Codex hook review reads hooks from
the installed package only, never the source tree or the marketplace clone. Before
activation the catalog is unpinned and Codex currentness is reported unknown, not
compared with the source checkout.

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
It records the Codex CLI version, the hook-bearing plugin set, the Codex-installed
version of each covered plugin, and the review target checklist, and is blocked
while expected bundled hook entries are explicitly disabled in Codex hook state.
`runtime:doctor` treats it as current only while those still match what it
observes on the machine; a hook-bearing plugin counts only once Codex has
installed it, because Codex loads hooks from the installed package.

## Migration Behavior

Migration is explicit and dry-run by default. One subcommand ships:

```sh
$runtime:migrate workflow-storage [--plugin all|engineer|orchestrator] [--apply]
```

`legacy-egress-intents`, the read-only cross-checkout inventory of pre-upgrade
egress intent WALs (ADR-0048 residual (d)), was removed with the egress
subsystem by [ADR-0064](../../docs/adr/0064-runtime-surface-reduction.md)
Decision 1 (2026-10-05). The command refuses that name, exit `1`, and runs
nothing.

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

Worktree planning is read-only. The command inspects `git worktree list --porcelain`, current branch/detached state, `git status --porcelain=v1 --untracked-files=normal`, base-ref resolution, candidate branch availability, and candidate worktree path availability. It then emits a suggested `git worktree add -b <branch> <path> <base>` command with `execute=false`.

`runtime:worktree` never creates branches, adds or removes worktrees, commits, pushes, opens PRs, or mutates runtime context. It recommends a dedicated worktree for non-trivial follow-up when the current checkout is on `main`, dirty, detached, or already sharing work with other worktrees. Blockers such as an unresolved base ref, existing target branch, or occupied target path must be resolved before running the suggested command manually.

## Context behavior

Context is a runtime-owned artifact scaffold and read-only check surface for ADR-0024 context hygiene. It does not inspect or mutate host session context directly. The first flows are:

1. `capture`: create `<repo>/.agentic-plugins/runs/context/<run-id>/context.json`, `summary.md`, and `next-session-prompt.md`; when git is available, record the current commit, branch, and dirty-state as read-only source metadata.
2. `status`: read the stored artifact by `--run-id`, or read the newest readable artifact with `--latest`, and emit the same bounded handoff fields plus age/stale metadata, source-freshness metadata comparing the artifact commit to the current git commit, and advisory reuse-or-refresh guidance.
3. `check`: compute an advisory green/yellow/red risk from caller-supplied `--token-budget` plus `--used-tokens` or `--remaining-tokens`, or from caller-supplied `--risk`.
4. `note` (ADR-0044 S3a): stage a semantic handoff note into `<repo>/.agentic-plugins/state/runtime/session-capture/note.json` via `--text`/`--file`, or empty the staging slot with `--clear`. The write is byte-capped (4096 UTF-8 bytes), atomic (uniquely named sibling temp + rename), containment-checked before any directory creation, and records staging-time git context; `--file` reads only a regular file (lstat no-follow — FIFO/device/symlink sources rejected). The explicit invocation is the ADR-0035 invariant-1 opt-in; the `session_capture` config gate governs only the S3b publisher. Operator invocations report on stdout and exit 1 on error; `--hook-grade` (hook/sidecar callers) exits 0 always, writes nothing to stdout, and emits at most one stderr line.
5. `status --slot` (ADR-0044 S3a): read-only inspection of the session-capture staging area — schema- and semantics-validated `slot.json`/`entry.json`/`note.json` with per-file fail-closed skip, a slot/entry generation verdict (`committed`/`mixed`/`absent`), and advisory note fold-window age diagnostics. Note bodies are never echoed; malformed files are skipped, never repaired or deleted on read.
6. `publish-session` (ADR-0044 S3b): the hook-fired slot publisher — hook-grade by definition (exit 0 always, nothing on stdout, at most one stderr line), gated inside the executor by the `session_capture` config key (enum `off | stop-hook`, shipped default `off`), intended for the attention Stop sensor rather than interactive use. Operators inspect its output via `status --slot` and plan the opt-in via `runtime:settings --session-capture`.
7. `entry-brief` (ADR-0045 S7b): the R0 entry arbiter — bounded, consuming-nothing reads over the four persona/orchestrator state homes (canonical + legacy), the subtask-branch macro bridge, the four persona handoff slots (dual-anchor marker-dependent freshness), the session-capture `entry.json`, and the context/consensus ledgers; the contract §16 precedence lattice elects at most one leader (linked engineer child → single active workflow → bridged macro readiness with a clean-tree-gated `orchestrator:next` → fresh branch-matched entry.json), synthesizes its command only from the closed state table, and renders the pointer-only `runtime-entry-brief-1.0` brief. `--surface cli` (default) / `--surface dashboard` always compute and report; `--surface session-start-hook` is hook-grade (exit 0 always, at most one marker-paired stdout line under the 4096-byte cap) and is the only surface bound by the user-scope-only `entry_brief` gate (env > user-global > default; a tracked repo value is ignored and reported; the settings repo target structurally refuses these keys). Uncertainty above the would-be leader yields `indeterminate` (no command); unlinked peer actives yield `owner-choice-required`; detached HEAD yields `no-branch-context`.

Session-capture lifecycle semantics (session-capture-contract.md §1/§9/§13):

- **Config-off persistence**: setting `session_capture = "off"` stops production only — existing slot/entry/note artifacts remain on disk and readable, and consumers arbitrate their staleness like any other slot state. Removing them is an operator action, never automatic.
- **Rolling-checkpoint limit**: the slot refreshes on turn end, so abrupt host termination emits no final capture — the previous turn's slot **is** the handoff. A session that never staged a note hands off a structural-only slot and says so (`summary_source = structural`).
- **Consumer-first rollback**: ADR-0045 entry surfaces (when they exist) → `session_capture = "off"` → attention sensor → runtime, with the one-shot cleanup — removing `.agentic-plugins/state/runtime/session-capture/` entirely — so a stale staged note cannot silently resurface after a re-upgrade.
- **Half-enabled diagnosis**: the states between "off" and a working chain (key on but attention missing/disabled, runtime below the publisher floor the installed attention build declares in `data/runtime-floors.json`, safe mode disabling hooks entirely) are surfaced by the `runtime:doctor` `session_capture` section and the `runtime:settings` `session_readiness` section, both reading the shared `lib/session-readiness.mjs` assessment — the publisher floor is discovered dynamically from the declaration, never hardcoded.

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

- context state (`green`, `yellow`, or `red`) with its measurement provenance —
  `context_state_measurement` (`measured`, `unmeasured`, `unknown`) and
  `context_state_origin` (`caller`, `context-artifact`, `runtime-default`).
  Runtime measures no host context, so an unsupplied state renders as
  `unmeasured (no budget sensor)` rather than as a risk level;
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

When supplied `--context-run-id`, the helper reads only bounded fields from the matching `runtime:context` artifact: risk level, artifact pointers, recommended action, next-session prompt pointer, lookup freshness, and handoff guidance. It does not print the context summary body, prompt body, raw peer output, consensus raw output, or the artifact's free-text `risk_reason` — an artifact-recorded risk is reported with an `unknown` measurement basis and the artifact itself stays a pointer.

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
registry from observed state only, renders Stage 4–5 fragments (the Stage-4
session decision menu and the per-host statusline — a `[tui]` table carrying
`status_line` on Codex, the single-quoted canonical `statusLine.command` plus the
credential-free shim artifact on Claude) with per-fragment
backup/verify/manual-revert guidance (the Stage-4 model/effort step is a
presented `runtime:settings` command, not a fragment), and presents —
never executes — the plugin-management command carrying the §1.6 plan hash
(`runtime:settings --execute-plugin-management --expected-plan-hash <hash>`;
the executor refuses on divergence). `status` and `verify` are read-only:
they re-probe and re-judge in memory and write nothing; `verify` judges the
**recorded** proof evidence (`passed` / `failed` / `stale` / `absent`) and
never runs a proof to make itself pass. `resume` is the only verb that
produces Stage-8 evidence: on an explicit operator `execute` answer it invokes
`runtime:doctor --record` with the relevant `--execute-*` flag and copies the
proof's metadata only into the run — per-direction results for the
peer-proof kinds, plus pointers, hashes, and bound versions. `abandon` closes a
crashed or unwanted run so a new plan can start; nothing the operator already
applied is ever reversed. Bootstrap's notification and egress steps, its
`attest` verb and the egress delivery proof were removed by
[ADR-0064](../../docs/adr/0064-runtime-surface-reduction.md) Decisions 1 and 6
(2026-10-05): Stage 5 is the statusline, the run schema is
`runtime-bootstrap-run-1.5` and the `--format json` report is
`runtime-bootstrap-report-3.0`. A terminal run recorded earlier is shown as
history (exit `50`), an open one migrates on `resume`, and `abandon` stays the
way out (contract §7).
Bootstrap guides each machine through the stages on its own; the portable
machine profile (`profile export` / `profile seed`), which carried one
machine's choices to another as interview defaults, was removed by
[ADR-0064](../../docs/adr/0064-runtime-surface-reduction.md) Decision 3
(2026-10-04). Completion has two terminal states —
`complete` (config resolved **and** every required proof passed at current
bound versions) and `configured-not-verified` — because "installed" and
"proven" are different claims. Run artifacts live only under the
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
