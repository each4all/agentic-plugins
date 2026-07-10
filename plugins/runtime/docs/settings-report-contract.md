# runtime:settings Report Contract — probe-free mode (`--skip-host-cli-probes`)

Decision record and normative contract for the `runtime:settings` mode that
skips host-CLI subprocess probes (`runDoctor`). Decided 2026-07-10 (macro
`macro-plan-20260710T052754Z-e49879` subtask S2A; engineer workflow
`decide-20260710T120430Z-37d290`; Codex Brainstorm ensemble
`brainstorm-20260710T120637Z-1785b2b`, verdict `concerns`, peer position on the
vehicle adopted after verification). The implementation subtask (S2B) consumes
this contract; the contract is complete enough that S2B re-litigates nothing.

This is a **command-level report contract**, not a mutation-policy change.
[ADR-0035](../../../docs/adr/0035-runtime-active-execution-boundary-policy.md)'s
tier model (R0/M1/H2/H3) and §4 ceiling are untouched: the mode introduces a
second, orthogonal **evidence-collection axis** (host-CLI probes run or
skipped) alongside the existing **mutation axis** (`dry_run` / `--apply` /
`--execute-*` / `--attest-*`). ADR-0035 §3 invariant 4 ("preflight from
host-native read probes") is exactly why the evidence-consuming executors are
rejected in this mode — no new policy is needed to justify the rejection. If a
second runtime command later adopts the evidence axis, promoting the axis to an
ADR is the expected step; this document does not preempt that.

Line references below are anchors observed at decision time
(`plugin-runtime` 0.77.2 tree) and may drift; the contract text governs.

## 1. Decision record

- **Flag name: `--skip-host-cli-probes`.** Names the evidence axis and aligns
  with the report's `skipped` status vocabulary. Rejected: `--plan-only`
  (misleading — settings is *already* a dry-run planner, and the retained plan
  flags write M1 artifacts while `dry_run=true`; the name conflates the
  mutation axis with the evidence axis, which is the root cause this contract
  removes); `--no-host-cli-probes` (reserved by the analysis for a
  strict-R0 variant that was not chosen); `--local-only`/`--offline` (reads as
  a network property; the probes are local subprocesses).
- **Composition (owner lever, ratified 2026-07-10): allow `--apply` and the
  three plan flags; reject the three evidence-consuming executors and their
  exclusive modifiers.** The gate rule is derivable, not enumerative in
  spirit: *a flag is rejected under `--skip-host-cli-probes` iff its effect
  consumes host-CLI probe evidence, or it exclusively parameterizes a rejected
  flag.* Applied to the current surface:
  - **Rejected**: `--execute-plugin-management` (consumes `doctor.plugins` /
    `doctor.clis`), `--execute-plugin-cleanup` (consumes
    `doctor.host_parity.issues`), `--attest-codex-hook-review` (consumes
    `doctor.codex_plugin_hooks`), plus `--plugin-management-host`,
    `--plugin-management-timeout-ms`, and `--run-id` (each exclusively
    parameterizes a rejected surface — `--run-id`'s only consumer is the
    settings execution artifact writer).
  - **Allowed**: `--format`, `--host`, `--target`, `--repo-root`, every config
    flag (`--model`/`--effort`/direction-specific/`--notify-*`), `--apply`
    (`applyConfigPlans` consumes zero doctor evidence — it is a pure
    filesystem diff against `.agentic-plugins/config.toml`),
    `--permission-plan` (+ its `--permission-plan-max-*` parameters),
    `--notification-plan`, and `--egress-launcher-plan` (the three plan
    builders take `{repoRoot, homeDir, env, now[, host]}` and never read
    doctor output).
  - Rejected-alternative posture: a strict output-only mode (also rejecting
    `--apply` + the plan flags) was scored and declined — it re-couples the
    two axes (the `--plan-only` conflation, mirrored) and pushes the primary
    beneficiary use case (pure filesystem config plan → apply) back onto full
    probe runs.
- **Vehicle: this runtime-owned contract document** (precedent:
  [`footer-contract.md`](footer-contract.md), [`artifact-policy.md`](artifact-policy.md)),
  linked from [`follow-ups.md`](follow-ups.md); commit type `docs(runtime)`.
  Rejected: a new ADR or an in-place ADR-0035 §7 amendment — both legitimate
  per `docs/adr/README.md` § Amendments-vs-Supersedes, but field-level report
  schema inside an immutable record manufactures freshness debt (the kind the
  2026-07-10 baseline recovery just paid down), and the mutation policy needs
  no amendment (§3.4 already covers the rejections).
- **Semantics wording**: the mode skips **host-CLI subprocess probes**; it is
  *not* "host-state-free". The allowed plan builders and the peer-execution
  context still read local host files (e.g. `~/.codex/config.toml`,
  activation state) read-only.

## 2. Behavioral contract

- Under `--skip-host-cli-probes`, `runSettings` MUST NOT call `runDoctor`
  (today: unconditional at `settings.mjs:110`) and MUST NOT spawn any host
  CLI subprocess.
- `report.config.resolution_order` and `buildCompanionSettingPlans`'
  `currentDirections` are sourced from
  `lib/peer-execution-context.mjs` `resolvePeerExecutionContext()` — pure
  filesystem, no subprocess, no network; it already returns exactly
  `{companions: {directions}, model_effort: {resolution_order, directions}}`
  (`peer-execution-context.mjs:35`).
- Flag-conflict validation MUST live inside the exported `runSettings`,
  **before** any probe, config write, or artifact write — not only in argv
  parsing (`parseArgs`, `settings.mjs:3052`) — so the exported API path cannot
  bypass the gate. Rejection is an error (non-zero exit via the CLI), not a
  warning.
- Default full-mode behavior is preserved: probes run, all sections evaluate,
  exit codes unchanged, text output byte-identical, JSON output changed only
  by the additive discriminator keys in §3. **Scope erratum (2026-07-10,
  Plan-verify)**: byte-compatibility is scoped to full-mode runs **without
  plan flags** — when a plan flag is requested, the §3
  `mutation_boundary.writes_allowed` honesty fix changes that value (and its
  text rendering) by design, in both modes.
- Non-transactional ordering (ADR-0035 §3.10 disclosure): config apply runs
  before the plan-artifact writers, so a later plan-write failure can leave
  an applied config and earlier plan artifacts behind. This is deliberate —
  each write is independently idempotent and re-runnable; recovery is re-run,
  not rollback. The probe-free mode does not change this ordering.
- `dry_run` keeps its current meaning (mutation axis only:
  `!(apply || executePluginManagement || executePluginCleanup || attestCodexHookReview)`).
  Evidence collection never affects `dry_run`.

## 3. Report schema contract (`runtime-settings-1.17`)

`SETTINGS_SCHEMA_VERSION` bumps `runtime-settings-1.16` → `runtime-settings-1.17`
(additive, consistent with the 1.x bump history). The discriminator exists in
**both** modes — a narrowed report must never be distinguishable only by what
it lacks:

- `report_scope`: `"full"` | `"local_plan"`. Top-level, both modes.
- `host_cli_probes`: `{ status: "run", flag: null }` in full mode;
  `{ status: "skipped", flag: "--skip-host-cli-probes" }` in probe-free mode.
- `section_presence`: a map over every top-level report section, with enum
  `evaluated | not_evaluated | not_requested | local_only`:

  | Section | full | local_plan |
  |---|---|---|
  | `clis`, `plugins`, `plugin_command_surface`, `plugin_management`, `plugin_cleanup`, `hook_settings`, `codex_hook_review` | `evaluated` | `not_evaluated` (value `null`) |
  | `config`, `companion_settings`, `notify_settings`, `mutation_boundary`, `artifacts`, `limits`, `overall` | `evaluated` | `evaluated` |
  | `permission_plan`, `permission_plan_codex`, `notification_plan`, `egress_launcher_plan` | `evaluated` when requested, else `not_requested` | same |
  | `recommendations` | `evaluated` | `local_only` |

- **Null, never empty**: probe-derived sections are `null` when skipped —
  never `{}`, `[]`, or zero counters. An empty container or zero counter must
  never read as "evaluated and clean" (the false-pass rule). `null`-vs-omit
  was resolved to `null`: it keeps the key set stable across modes and makes
  unguarded consumers fail visibly (`Object.values(null)` throws exactly like
  `Object.values(undefined)`; the discriminator carries the semantics, `null`
  carries the ergonomics).
- `recommendations` in `local_plan` mode is rebuilt from evaluated inputs only
  (config-derived hints, `companion_settings`, `notify_settings` — erratum
  2026-07-10: the config-area hints are evaluated-derived and stay) and marked
  `local_only` in `section_presence` — it MUST NOT silently present as full
  coverage.
- `overall`: gains `scope: "full" | "local_plan"`. The `status` enum is
  unchanged (`pass` | `warning`) and is computed over evaluated sections only.
  **Erratum (2026-07-10, Plan-verify)**: in `local_plan` mode, "evaluated
  sections" includes requested plan sections — a requested plan section whose
  own `status` is `blocked` (or failed) yields `status: "warning"`, never an
  unqualified local pass. (Full mode has the same pre-existing gap — a
  blocked notification plan does not warn — deliberately unchanged by this
  contract and recorded as a follow-up.)
  Probe-derived counters are `null` (not `0`) in `local_plan` mode:
  `plugin_recommendations`, `hook_warnings`, `hook_review_warnings`,
  `auth_warnings`, `plugin_cleanup_warnings`, `plugin_management_executed`,
  `plugin_management_failed`. Evaluated counters (`planned_config_writes`,
  `applied_config_targets`, `setting_warnings`, `notify_warnings`) stay
  numeric. (`summarizeSettings`, today `settings.mjs:2096`, dereferences
  `report.clis`/`report.plugins`/`report.plugin_management` unconditionally
  and MUST gain scope-aware guards.)
- `mutation_boundary` honesty amendment (**both modes** — fixes a
  pre-existing gap surfaced by this decision's peer review):
  `mutation_boundary.writes_allowed` MUST enumerate requested plan-artifact
  families. Today (`settings.mjs:350-357`) it reports `"none; dry-run only"`
  even when `--permission-plan` writes an advisory artifact
  (`recordPermissionAdvisoryArtifact`, `written: true`). "Dry run" must never
  render as "no writes" while plan artifacts are being written.

## 4. Rendering contract

- **JSON**: full mode = current output plus the additive §3 discriminator
  keys, nothing else changed. `local_plan` mode = discriminator keys +
  `null`ed probe-derived sections; the key set matches full mode.
- **Text** (`formatText`, today `settings.mjs:2133`, dereferences
  `report.clis[name]`/`report.plugins[name]` unconditionally and MUST gain the
  same guards):
  - Full mode: byte-identical to pre-1.17 output.
  - `local_plan` mode: the header mode string gains the scope (e.g.
    `runtime:settings <version> (local-plan)` /
    `(local-plan+config-apply)` via `formatSettingsMode`), followed by
    explicit `report scope: local_plan` and
    `host CLI probes: skipped by --skip-host-cli-probes` lines; every skipped
    section renders one explicit `not evaluated` line instead of its normal
    body (never a zero-count summary line); the overall line is qualified —
    `local plan: pass` / `local plan: warning` — an unqualified `pass` is
    never printed from a narrowed report.

## 5. Artifact-family exclusion

- The mode MUST NOT create or update anything under
  `.agentic-plugins/runs/settings/**`. Both durable consumers treat that
  family as **execution evidence** — `dashboard.mjs:295` and
  `doctor.mjs:1955` read the newest `settings.json` there — so an unevaluated
  run recorded there could mask an earlier failed execution. Structurally,
  the single writer (`writeSettingsExecutionArtifact`, gated at
  `settings.mjs:321-328` on the three rejected executor/attest flags) is
  unreachable in this mode; a regression test pins the invariant regardless.
- The plan-artifact families (`runs/permission` — erratum 2026-07-10: the
  pinned family name is `permission`, `PERMISSION_ARTIFACT_FAMILY` in
  `lib/permission-artifacts.mjs` — plus the notification and egress-launcher
  families) are unaffected: when their flags are requested they write their
  own families exactly as in full mode. Their artifact pointers live inside
  each plan section (`permission_plan.artifact`, `notification_plan.artifact`,
  `egress_launcher_plan.artifact`) — **not** in `report.artifacts`, which
  carries only `settings_execution` (erratum 2026-07-10) — and
  `mutation_boundary.writes_allowed` must enumerate the requested families
  (§3).

## 6. Test obligations (S2B)

1. **New settings probe-boundary suite** (the existing
   `tests/runtime/test-consensus-probe-boundary.mjs` is consensus-specific by
   design): an injected-runner test asserting **zero** runner calls under
   `--skip-host-cli-probes`, plus a black-box CLI test with `claude`/`codex`
   marker shims on `PATH` proving no real host CLI is spawned.
2. Default full-mode regression: probes still run, sections evaluate, text
   output byte-compatible (modulo nothing), JSON delta limited to the §3 keys.
3. Renderer guards: `summarizeSettings` and `formatText` on a narrowed report
   (no throw, qualified output, explicit not-evaluated lines).
4. Schema-version lockstep: the `runtime-settings-1.17` constant, and the
   exact-version assertion in `tests/runtime/test-notification-plan.mjs`,
   updated together.
5. Conflict rejection: each rejected flag, exercised through the **exported
   `runSettings` API** (not only argv), rejects before any probe, config
   write, or artifact write.
6. Artifact-family exclusion: seed an earlier failed settings execution
   artifact, run every allowed probe-free combination (`--apply`, each plan
   flag, combinations), and assert the `runs/settings` directory, its latest
   pointer, and the doctor/dashboard latest-run selection are unchanged
   (non-masking).
7. `mutation_boundary` honesty: with a plan flag requested,
   `writes_allowed` enumerates the plan-artifact family (both modes).

## 7. Non-goals

- No probe-free variant of `runtime:doctor` (doctor *is* the probe surface).
- No runtime-wide evidence-axis ADR yet — promote when a second command
  adopts the axis (see the preamble).
- No change to consensus's probe boundary (`lib/peer-execution-context.mjs`
  and its allowlist test own that seam); the capability-narrowed
  `runCompanion` executor remains a separate deliverable.
- No host-native config writes, no permission/sandbox changes, no host
  session mutation — unchanged ADR-0035 §4 ceiling.
