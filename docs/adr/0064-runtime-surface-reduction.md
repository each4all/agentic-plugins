# ADR-0064: Runtime surface reduction — remove notification and egress, the machine profile, the sandbox probe, and the cutover audit

## Status

Accepted (2026-10-04) by the owner. The commit that accepted it applied
[§Amendment cascade](#amendment-cascade-apply-verbatim-on-acceptance).
Proposed 2026-09-29. Drafted 2026-09-25 in the owner's handoff package,
outside this repository, from the owner's item-by-item review, and realigned
before adoption to ADR-0060's implementation and ADR-0059–0062. Proposed
alongside [ADR-0063](0063-autopilot-fresh-session-driver.md); the two are
independent.

**Realigned 2026-10-04** by its acceptance subtask, R0 of macro
`macro-plan-20261003T022443Z-139657`, against `main` at `efc81016`:
- to [ADR-0065](0065-release-ceremony-reduction.md), accepted the same day. No
  proof is re-recorded after a release, and ADR-0065 has already taken the
  scorecard out of the stage-doc pipeline, so Decision 5 keeps only what the
  audit itself needs;
- to a re-measured manifest. Decision 1 adds the bootstrap machinery that
  creates, reduces and registers the notify and egress steps
  (`lib/step-registry.mjs`, `lib/completion-reducer.mjs`,
  `lib/evidence-contract.mjs`), the `attest` verb, and smaller surfaces the
  2026-09-25 inventory missed. Decision 2 adds a seventh relocation and
  corrects a module name;
- to a new slice order. The machine profile goes before notify (Decision 3),
  and the notify/egress removal is split in two (Decision 11);
- with the behaviour of retained and open bootstrap runs and of a partially
  upgraded host pair (Decision 7), and the dashboard bump corrected from minor
  to major.

A cross-host review of the realignment (Codex, Plan-verify) confirmed the
order and the version choices and found twelve more items, each checked
against the code and folded in. The weightiest: attention's session capture
finds its runtime through the notify-capable resolver, so R2 must change it
and be installed before the R4 release; emitters fall back to older cached
runtimes; the bootstrap JSON report and the historical projection need their
own handling; the sandbox probe's preflight is shared with the permission
proof; and registry edits belong to each removal slice, not to R5.

- **On acceptance** it:
  - supersedes [ADR-0041](0041-cross-machine-notification-egress.md) **in full**;
  - supersedes [ADR-0040](0040-operator-observability.md) **except §6**
    (`runtime:dashboard`) and **except §3 as re-chartered by ADR-0044**
    (attention as the Claude lifecycle sensor);
  - supersedes [ADR-0047](0047-notify-attention-gating-gc.md) **except §7**
    (citation-aware retention);
  - amends [ADR-0048](0048-bootstrap-observability.md) (§1 Stage 5, §3, §4),
    [ADR-0035](0035-runtime-active-execution-boundary-policy.md) §4 (tier E1
    retired), [ADR-0046](0046-machine-bootstrap.md) (the portable machine
    profile) and [ADR-0057](0057-permission-advisor-removal.md) (its
    "three surfaces" note on the sandbox probe);
  - records [ADR-0005](0005-separate-repo-from-omcc.md),
    [ADR-0007](0007-migration-cutover-plan.md) and
    [ADR-0012](0012-omcc-removal-preconditions.md) as **completed history**.
- **Sibling removals.**
  - [ADR-0060](0060-remove-host-version-tracking.md) (accepted 2026-09-18)
    was planned as the first slice of this ADR's implementation macro. It was
    implemented on its own on 2026-09-28 in #829 and released as runtime
    0.99.0 (#830), before this ADR was proposed (§Decision 10).
  - [ADR-0065](0065-release-ceremony-reduction.md) (accepted 2026-10-04)
    removed the release ceremony. Its Decision 7 froze
    `docs/assurance/omcc-cutover-scorecard.md` and took it out of the
    stage-doc pipeline, which was part of Decision 5 here; its B1 slice deleted
    the pipeline's scripts. Its Decision 2 ended the proof re-record after a
    release, which Decision 11 here follows.

<!--
Drafted 2026-09-25 against the fix/adr0061-sibling-resolvers branch, which
landed as #812; citations re-verified at 68438b9e on 2026-09-29, and the
manifest re-measured at efc81016 on 2026-10-04 by subtask R0. Evidence: the
owner's item-by-item review of 2026-09-25 (REVIEW.md in the owner's handoff
package) and the measurements quoted in Context. Plan, per-file manifest and
slice order: the handoff package's design/notify-removal.md, outside this
repository; where it and this ADR disagree, this ADR wins. Mirrors ADR-0057's
structure: manifest by identifier, split mixed modules, era matrix per
contract, historical artifacts untouched, atomic supersession with carve-outs,
docs-only with a separate implementation macro.
-->

## Context

The owner reviewed every notification, settings and permission surface one
item at a time on 2026-09-25, with the usage measured for each. Four surfaces
failed that review.

**Notification and egress (ADR-0040/0041/0047/0048).**
- In practice the machine uses exactly one path:
  - E1 Telegram egress, activated by a `~/.zshrc` `claude()` wrapper that
    injects `AGENTIC_NOTIFY_EGRESS_CHANNEL`, `TELEGRAM_CHAT_ID` and
    `TELEGRAM_BOT_TOKEN` from a mode-600 JSON file;
  - filtered to `approval` and `response-needed`.
- The local channel is `none`. The Codex shuttle is wired in `~/.codex/config.toml`.
- The subsystem is ≈ 8.1k runtime source LOC and ≈ 10.4k test LOC, plus an
  attention sensor group and a self-sensor in four persona peer-runners.
- The owner decided to remove all of it (REVIEW N1–N6), with no local fallback.

**The portable machine profile (ADR-0046 §7).**
- `bootstrap profile export` / `profile seed` / `plan --profile-file` have never
  been used on the owner's machine: there is no `~/.agentic-plugins/profiles/`.
- The profile schema **requires** the `notify` and `egress` families
  (`agentic-machine-profile-1.3.json`). Keeping it through the notification
  removal would cost a schema major/minor bump for a feature with no user.

**`runtime:doctor --sandbox-permission-probe`.** ADR-0057 kept it as "not
advisor machinery", and that classification stands. But usage decided it:
- 87 recorded doctor runs, **0** with the probe executed;
- `permission_proof` ran 77 times and `workflow_continuation_proof` 79 times,
  all passing as of 2026-09-23.

The proofs verify the same readiness by execution.

**`runtime:cutover`.** The omcc → agentic-plugins cutover audit (ADR-0007/0012):
- 16 recorded runs between 2026-05-16 and 06-03, none since;
- omcc and `codex-plugin-cc` are no longer installed;
- the footer's `--cutover-record` guidance has no caller in any runbook.

**Re-measured on 2026-10-04 (`efc81016`).**
- Every identifier in Decision 1's 2026-09-25 list still exists on `main`.
- That list missed the bootstrap machinery. `lib/step-registry.mjs` derives
  the four Stage 4/5 notify and egress steps and the opt-in
  `proof.egress-provider-ack`; `lib/completion-reducer.mjs` judges the egress
  proof and the owner's receipt testimony; `lib/evidence-contract.mjs`
  registers the two egress evidence kinds; and the `attest` verb exists only
  to record that testimony.
- The modules deleted whole hold 7,300 lines of runtime source and 10,419 of
  tests. The mixed files are the four largest runtime scripts (`doctor.mjs`
  7,068 lines, `bootstrap.mjs` 4,958, `settings.mjs` 2,881, `dashboard.mjs`
  1,193) and their tests (`test-doctor.mjs` 6,322, `test-bootstrap-cli.mjs`
  4,904).
- The owner's machine holds four bootstrap runs, all terminal: two `complete`
  and two `abandoned`, under schemas 1.1 and 1.2. Three carry the retired
  steps and two carry egress evidence files. No run is open.

**What is worth keeping, and must not be deleted by accident.** Several
surfaces live inside the ADRs this one supersedes, or share their vocabulary:

| Surface | Why it survives |
|---|---|
| `runtime:dashboard` (ADR-0040 §6) | Operator view, independent of notification; only its Tier-2 notify/egress rows go |
| attention SessionStart (entry brief, ADR-0045) + Stop capture (ADR-0044) | ADR-0044 re-chartered attention as the lifecycle sensor "before and independent of notification" |
| `runtime:retention` (ADR-0047 §7) | Citation-aware artifact retention; unrelated to notification |
| statusline (ADR-0048 §2) and its receiver | The owner's active `statusLine`; `receiver-api.mjs` / `receiver-inventory.mjs` keep the statusline half |
| `runtime:doctor --permission-proof`, workflow-continuation proof, `deep_peer_smoke` | Used and passing; not the sandbox probe |
| `runtime:settings` config keys (`model_effort`, `session`), plugin-management and cleanup executors, Codex hook readiness/attestation | Kept by the owner (REVIEW S1–S3) |
| `runtime:bootstrap` Stages 0–4, 5 (statusline), 7, 8 | Kept (REVIEW S4); only the notify/egress steps, the `attest` verb and the profile verbs go |
| Codex `[tui] notifications` in the owner's `~/.codex/config.toml` | Codex-native, not agentic-plugins |

## Decision

### Decision 1 — Remove notification and egress; the manifest is by identifier, not by the word

"notify", "notification" and "egress" also appear in unrelated prose and in
Codex-native keys. The manifest names identifiers.
- **Removed in full:**
  - `scripts/notify.mjs`;
  - `lib/notify-schema.mjs`, `lib/notification-plan.mjs` (after Decision 2),
    `lib/legacy-egress-discovery.mjs`, `lib/egress-{launcher-plan,semantics,config,channel,intent-wal}.mjs`;
  - `receivers/codex-notify-{shuttle,chain}.mjs`, their entries in
    `data/released-receiver-shapes.json`, and both shuttle template fixtures
    under `tests/fixtures/receivers/`;
  - attention's `Notification` and `SubagentStop` hooks with `notification.mjs`
    and `subagent-stop.mjs`, the Stop hook's notify stage, the sensor notify
    group, `RESPONSE_SIGNAL_MIN_RUNTIME_VERSION` and the notify floors;
  - the persona `emitPeerRunTerminal` self-sensor (4 peer-runners, 7 call sites
    each) and the `NOTIFY_*` discovery rungs;
  - the `notify` config-key family (6 keys);
  - the `--notification-plan` and `--egress-launcher-plan` settings surfaces;
  - doctor's `egress_ack_proof`, egress-activation, egress-intent and
    shuttle-receiver checks;
  - dashboard's Tier-2 notify-state and egress-throttle rows;
  - `runtime:migrate legacy-egress-intents`;
  - the control-plane credential scrubs: `redactEgressCredentialFromEnv` in
    settings and doctor, and bootstrap's `scrubbedControlPlaneEnv`
    (Decision 9 states what that leaves until the owner's cleanup).
- **Removed from the bootstrap machinery** (missing from the 2026-09-25
  inventory):
  - `lib/step-registry.mjs`: the step ids `config.notify_kinds`,
    `notify.configured`, `notify.codex.configured`, `egress.configured` and
    `proof.egress-provider-ack`, `OPT_IN_PROOF_STEPS`, and the
    `egressProofRequested` input of `deriveExpectedSteps`;
  - `lib/completion-reducer.mjs`: `egressProofOptedIn`, the
    `egress-provider-ack` branch of `recomputeProofStatus`,
    `recomputeReceiptAttestation`, the `currentActivationFingerprint` and
    `receiptEvidence` inputs, and the `egress_receipt_attestation` verdict it
    writes. `projectLegacyCompletion` keeps reading a stored one (Decision 7);
  - `lib/evidence-contract.mjs`: the `egress-provider-ack` proof kind and the
    `egress-receipt-attestation` attestation kind. `deriveActivationFingerprint`
    and its two domain constants go with doctor's `egress_ack_proof`, their
    last consumer;
  - `lib/answer-values.mjs`'s notify-kind grammar, and the `attest-receipt`
    answer value;
  - the `attest` verb, which exists only to record egress receipt testimony
    once a run is terminal;
  - bootstrap's Stage 5 notification and egress-launcher fragments, its
    notify and egress judges, and its `notify`, `egress`, `egressActivation`
    and `codexNotify` readers.
- **Reduced:**
  - `receiver-api.mjs` and `receiver-inventory.mjs` lose the shuttle and
    chain; `RECEIVER_KINDS` keeps `agentic-statusline.mjs`. The reinstall step
    `buildReceiverReinstallStep` builds, and doctor's receiver advice, present
    `runtime:settings --notification-plan` for every receiver, the statusline
    shim included; they point at bootstrap's Stage 5 statusline fragment
    instead, the surface that still renders the shim;
  - `lib/toml.mjs`: `renderCodexTuiTableToml` loses its `notifications` arm and
    keeps `statusLine`;
  - `lib/state-readers.mjs` loses the `notification` and `egress-launcher`
    artifact families;
  - `lib/profile-readers.mjs` loses `projectNotify`, `readUserGlobalNotify`
    and `readUserGlobalEgress`;
  - attention's session capture (`spawnPublishSession`) stops resolving its
    runtime through `resolveRuntimePluginRoot`, which accepts only a runtime
    carrying `scripts/notify.mjs`, and uses the manifest-identity resolver
    the entry brief already uses (Decision 7).
- **Text that describes these surfaces.** The runtime and attention plugin
  manifests (descriptions, the `notifications` keyword, the
  `$runtime:migrate legacy-egress-intents` starter prompt), their root catalog
  entries, and the README, AGENTS.md and stage-doc lines that describe
  attention as feeding a notify pipeline. Each changes in the slice that
  removes what it describes (Decision 8).
- **Registries, guards and mutation specs** that name a moved or deleted file
  change in the same slice, because each slice lands with a green suite
  (Decision 11). The executor registry (`tests/plugin-shape/runtime-executor-registry.mjs`)
  requires every registered file to exist and lists the files that read or
  name the credential; the plugin-shape tests pin where some helpers are
  defined; and the mutation harness refuses to score a spec whose anchor
  drifted. Known mutation specs today: `scripts/mutation-specs/codex-cache-discovery.mjs`
  (its shuttle rung and its `test-notification-plan.mjs` target) and
  `host-tracking-removal.mjs` (its cutover groups, Decision 5).

The per-file manifest with `path:line` is the implementation plan's §2 (the
handoff package's `design/notify-removal.md`). Where it and this list
disagree, this list wins. Each slice re-measures its rows against `main`
before editing.

### Decision 2 — Mixed modules split; survivors relocate before anything is deleted

Seven things that outlive the module they live in move first, in a
behaviour-neutral slice:
1. `resolveRepoRoot` (`notify.mjs`) moves to `lib/repo-root.mjs`. Consumers:
   `context.mjs`, `retention.mjs`, `dashboard.mjs`.
2. `scrubSecrets` (`egress-channel.mjs`) moves to a generic scrub module.
3. `safeOperatorText` (`egress-intent-wal.mjs`) moves to a generic text module.
4. `substituteOnce` (`notification-plan.mjs`) moves to `statusline-plan.mjs`.
5. `STATUSLINE_PRESET_AGENTIC_6` (`machine-profile.mjs`) moves to `statusline-plan.mjs`.
6. The `$CODEX_HOME/config.toml` read and the `[tui]` table parse move from
   `gatherCodexNotificationInputs` / `parseCodexNotifyConfigToml` to
   `lib/codex-config.mjs`, because bootstrap's Codex statusline judge consumes
   them. The `notify =` parse goes with Decision 1. *Corrected 2026-10-04:*
   the draft called this a new module, but `lib/codex-config.mjs` already
   exists. ADR-0057 Decision 4 made it the read-only Codex config parser, and
   its one function today, `parseCodexPermissionConfigToml`, loses its only
   consumer with Decision 3.
7. `EGRESS_CREDENTIAL_ENV_VAR` (`machine-profile.mjs`) moves to
   `lib/egress-config.mjs`, which already spells the same name in its own
   credential descriptor. *Added 2026-10-04.* Its consumers, doctor and
   bootstrap, are egress paths that Decision 1 removes, but Decision 3 deletes
   `machine-profile.mjs` first (Decision 11), so the constant needs a home
   until then. It is deleted with `egress-config.mjs`.

This is the ADR-0057 Decision 3/4 precedent: a module splits by consumer, not by
file.

### Decision 3 — Remove the portable machine profile

`bootstrap profile export`, `profile seed` and `plan --profile-file` go, along with:
- `lib/machine-profile.mjs`;
- the `agentic-machine-profile-1.3` schema;
- the machine-global artifact home `~/.agentic-plugins/profiles/`;
- the profile-only reader projections:
  - Claude/Codex permission projections in `lib/profile-readers.mjs`, and
    `parseCodexPermissionConfigToml` in `lib/codex-config.mjs`, which only
    they call;
  - `lossyProfileInputs`, and the `statuslinePreset` reader value that only
    the export reads;
- the profile plumbing outside the profile module: the profile validator and
  schema that bootstrap's context loader builds for every verb, the profile
  home helpers and readers/writers in `lib/bootstrap-artifacts.mjs`
  (`profilesRoot`, `profileFile`, `writeMachineProfile`, `readMachineProfile`,
  `listMachineProfiles`), the `profiles` family in `MACHINE_ARTIFACT_FAMILIES`
  (`lib/state-readers.mjs`), and the schema's entry in `PACKAGED_SCHEMA_FILES`
  (`lib/schema-validate.mjs`). `validateProfileName` stays, under that name or
  a neutral one: the fragment and proof writers validate their file stems with
  it.

`lib/profile-readers.mjs` keeps the readers that Stage 4/5 judges use: model
effort, session, Claude settings, statusline. Bootstrap still guides a new machine
stage by stage; only the "copy this machine" shortcut goes.

**It goes before notify.** `buildMachineProfile` iterates
`CONFIG_KEY_FAMILIES.notify`, and the profile schema requires the `notify` and
`egress` families. Removing the notify key family first would break the
profile in between, or cost a profile schema change for a feature that is
being deleted. Removing the profile first leaves the notify family with no
profile reader. The profile needs two relocations before it goes (Decision 2,
items 5 and 7).

The bootstrap run keeps its `seeded_from` member readable: retained runs carry
it, and the run schema still accepts it (Decision 7). No writer sets it after
this decision. The removal changes no bootstrap step, so it needs no
run-schema bump of its own.

`UNSAFE_*` (the never-propose-`bypassPermissions` rule) disappears with its only
consumer. The **policy** it encoded survives unchanged in ADR-0057 D8 and
ADR-0038 §6: no permission-relaxing default or hook is ever shipped.

### Decision 4 — Remove `doctor --sandbox-permission-probe`; the proofs survive

The option, `buildSandboxPermissionProbeSection`, the report section
`sandbox_permission_probe`, its readiness wording and its text rendering all go,
and so does the `settings` `doctor_hint` that points at it.

- `permission_proof`, `workflow_continuation_proof` and `deep_peer_smoke` stay.
- `EXIT_PROOF_SECTIONS` becomes those three: `egress_ack_proof` goes under
  Decision 1.
- The live-report pin in `tests/runtime/test-doctor-exit.mjs` is updated to match.
- The per-direction preflight behind the probe, `buildDirectionSandboxPermissionProbe`,
  is **kept**, under a neutral name: `buildPermissionProofSection` runs it
  before every permission proof. What goes with the option is the top-level
  `sandbox_permission_probe` section and the per-direction `sandbox_permission`
  members the option fills: the readiness object's, and the status the
  per-direction summary copies from it.
- The doctor report bump is shared with Decision 1 (Decision 7).

### Decision 5 — Retire `runtime:cutover`

These go:
- `scripts/cutover-audit.mjs`;
- `commands/cutover.md`;
- `core/skills/cutover/`;
- the footer's cutover-record guidance and its `--cutover-*` flags;
- retention's `cutover` citation-source family;
- the `/runtime:cutover` route mentions in engineer `start` and the entry-routing
  contract;
- the `cutover` keyword and wording in the runtime plugin manifests;
- the two guards that exist only to keep the audit's parse honest: the
  scorecard requirement-row pin in `tests/plugin-shape/test-runtime-plugin.mjs`
  and the real-file condition-matrix case in `tests/runtime/test-cutover-audit.mjs`
  (deleted with that file). The rows they guard, in the scorecard and in the
  ADR-0012 condition matrix of `docs/DEVELOPMENT.md`, stay as frozen history,
  unedited;
- the cutover groups of `scripts/mutation-specs/host-tracking-removal.mjs`.

ADR-0005, 0007 and 0012 remain as completed history. Their subject, the omcc
cutover, is done. Nothing is superseded because nothing is re-decided.

ADR-0060 D3 said: "`runtime:cutover` loses its compat freshness check…
an absent check must not read as a passing one." ADR-0060 landed first and made
that edit as written. Removing the audit makes the clause **moot** from here on:
there is no output left to misread.

Two consequences follow:
- **The audit stops disagreeing with the declaration.** The owner declared the
  cutover on 2026-06-03. The audit, run on 2026-09-23 and 2026-09-29, computes
  `not-ready`, only because its newest context artifact is from 2026-08-23. The
  scorecard states both facts, and review docket item A3 asked which one should
  stand. Retiring the audit answers it: the declaration is final, and the last
  audit run is history.
- **The scorecard is already out of the stage-doc pipeline.** The 2026-09-25
  draft of this decision took `docs/assurance/omcc-cutover-scorecard.md` out of
  the release job's version sync and the doc-evidence gate once the command it
  scores was gone. ADR-0065 did that first, for its own reasons: its
  Decision 7 froze the scorecard with a dated note, and its B1 slice deleted
  `scripts/sync-doc-versions.mjs` and `scripts/check-doc-evidence.mjs`. What
  remained tied to the audit is the two guards listed above.

### Decision 6 — Bootstrap Stage 5 becomes "statusline"; stage numbers are kept

- Stage 5 keeps its number and loses its notification and egress steps:
  - `notify.configured`;
  - `notify.codex.configured`;
  - `egress.configured`;
  - `proof.egress-provider-ack`;
  - `egress-receipt-attestation`;
  - the Stage-4 `config.notify_kinds` value step.
- The `attest` verb and the `attest-receipt` answer go with the receipt
  testimony they record.
- Stage 6 stays empty (ADR-0057) and 7/8 keep their numbers. Renumbering would
  invalidate every retained run manifest.
- The removed step ids stay **readable as historical** in retained runs. The
  owner's machine holds four retained runs, all terminal, and three carry the
  retired ids. Decision 7 states how retained and open runs are read.

### Decision 7 — Every contract that loses fields gets an era matrix

| Contract | Today (baseline) | Loses | Reader obligation |
|---|---|---|---|
| settings report | `runtime-settings-1.26` | `notification_plan`, `egress_launcher_plan`, `notify_settings`, `notify_warnings`, `notify_*` projections | bump to 1.27, a minor bump as settings has used for removals (ADR-0057 took it from 1.25 to 1.26). No reader pins the settings report version |
| doctor report / artifact | `runtime-doctor-1.3` / `runtime-doctor-artifact-1.3` (ADR-0060 already took both from 1.2) | `egress_ack_proof`, `sandbox_permission_probe` and the per-direction `sandbox_permission` members, shuttle receiver kinds | **one** bump to `1.4`/`1.4`, in one runtime release (Decision 11): the first slice that deletes a report field moves the pair, and the next deletes its field under the same unreleased pair. doctor + dashboard extend the **matched-pair** list (ADR-0057 D11) |
| dashboard report | `runtime-dashboard-3.0` (after ADR-0060) | Tier-2 notify-state/egress-throttle rows | bump to **`4.0`**. *Corrected 2026-10-04:* the draft said minor, but the dashboard's own rule, stated in `commands/dashboard.md` and applied by ADR-0060, makes every non-additive change major. The report is computed fresh and never persisted, so nothing reads an older one |
| bootstrap report (`--format json`) | `runtime-bootstrap-report-2.0` | the `attest` verb's report, the live `completion.egress_receipt_attestation`, the `egress-provider-ack` proof rows | bump to `3.0`, by the report's own precedent: 2.0 moved to a major because a key was removed (`machine-bootstrap-contract.md`). The report is emitted per invocation and not read back, so there is no host-pair skew. The historical projection of a retained run keeps its egress rows (below) |
| bootstrap run | `runtime-bootstrap-run-1.4` | the Stage 4/5 notify/egress steps, the `egress-provider-ack` proof kind, the receipt attestation | bump to 1.5, a semantic bump like ADR-0057's 1.4: it arms the existing refuse-newer and legacy-terminal fences, so an older runtime cannot restore the retired rows into a run this runtime migrated. The retired members stay valid in the schema (below) |
| machine profile | `agentic-machine-profile-1.3` | the whole contract | deleted; no reader survives |
| notification plan / egress-launcher plan / cutover evidence artifact families | 1.1 / — / 1.0 | the producers | orphaned history; retention stops managing them |

The implementation publishes, per contract, the tokens it writes new, the tokens
it still reads as historical, and the projection between them.

**Retained and open bootstrap runs.** Bootstrap runs are machine-scoped
(`~/.agentic-plugins/runs/bootstrap/`), and one packaged schema validates
documents of every minor. The 1.5 runtime:
- **keeps every retired member valid in the run schema**: the retired step ids
  (the step-id pattern never enumerated them), `seeded_from`, the
  `egress-provider-ack` kind with `provider_ack` and `mirror_correlated`, the
  `egressReceiptAttestation` definition and `completion.egress_receipt_attestation`.
  A 1.5 writer never writes them. Dropping them from the schema would make
  every retained run that carries one schema-invalid, and an invalid run can
  only be abandoned, not shown;
- **presents a terminal run of an earlier minor as history**, as ADR-0048 §1
  already does: `status` and `verify` exit 50, re-probe and re-certify
  nothing, and do not read its proof files. `projectLegacyCompletion` keeps
  projecting a stored `egress-provider-ack` row and receipt verdict. It
  filters rows through the live `PROOF_KINDS` today, so removing the egress
  kind there would silently count those rows as unreadable: the projection
  gets its own historical kind list, which keeps the retired kind, and both
  paths are tested. The owner's four runs take this path;
- **migrates an open run of an earlier minor on `resume`**, as it did for
  ADR-0057's Stage 6 rows: the retired step rows leave `steps[]`, the migration
  history row names them, and `choices[]`, `history[]` and `seeded_from` stay
  as written. The run is judged against the 1.5 registry, which owes none of
  the retired steps;
- **skips retired evidence files**, `egress-provider-ack.json` and
  `egress-receipt-attestation.json`, on every read of a run's `proof/`
  directory, instead of refusing the read. The proof reader refuses any unknown
  kind, so without this an open run holding one could not resume. The skip is
  not limited to open runs: a migrated run that later completes is a 1.5 run,
  so `status` and `verify` read its proof directory rather than taking the
  historical path. The files stay on disk as history; nothing validates or
  credits them;
- **keeps `abandon`** as the way out of a run the operator does not want to
  finish. It already accepts a run whose manifest no longer validates. `plan`
  keeps refusing to start while a run is open, so an operator who does not want
  to resume abandons first.

One resume at a time stays an operating assumption, as the contract already
states. The schema fence stops an older runtime from writing a newer
manifest, but a resume already in flight when the other host upgrades can
still write fragment and proof files before its manifest update is refused.

**A partially upgraded host pair.** Both hosts read the machine-scoped
`~/.agentic-plugins/runs/bootstrap/` and each repository's
`.agentic-plugins/runs/`, where the doctor proofs are. While one host runs the
release and the other an older runtime:

| Artifact | What the older runtime does with the newer one |
|---|---|
| bootstrap run 1.5 | refuses to `resume` it or change its steps (the existing future-minor fence: "upgrade the runtime plugin"). `abandon` is exempt, as a recovery verb: it can close a newer open run and keeps its schema string. `status` and `verify` re-judge the run against the older registry, rebuilding a row for every step that registry owes, so their verdict on the retired steps depends on whatever notify and egress configuration the machine still holds: missing, pending or satisfied. It is an obsolete, read-only judgment that ends when that host updates |
| doctor artifact 1.4 | counts it `malformed`, and that host's dashboard reports the doctor row blocked, until the host updates (the same-release note at `READABLE_DOCTOR_SCHEMA_PAIRS` in `doctor.mjs`) |
| settings report 1.27 | nothing pins the version; no skew |
| dashboard 4.0 | computed per run and never read back; no skew |
| an attention or persona install from before R2/R3, or the rendered Codex shuttle, once the installed runtime has no `scripts/notify.mjs` | attention's notify path, the founder and designer self-sensors and the shuttle filter cache candidates by `scripts/notify.mjs`, so they resolve the newest cached runtime that still **carries** it. Host caches keep earlier versions, so while an older runtime is cached, notifications keep flowing through it, Telegram included; when none is cached, the emit is skipped silently. The engineer and orchestrator self-sensors resolve the newest runtime by `scripts/footer.mjs` and skip the emit when it has no emitter |
| attention's session capture, from an install before R2 | resolves its publisher through the same notify-capable resolver, not the manifest-identity resolver the entry brief uses. With the new runtime it runs an older cached runtime's publisher, or, with none cached, stops silently. R2 switches it to the manifest-identity resolver |

So R2's attention release is installed before the R4 runtime release, and the
R4 release is installed on both hosts before either host's bootstrap verdict,
or a newly recorded doctor proof, is relied on. No proof is owed after the
release (ADR-0065 Decision 2); when one is recorded, both hosts are updated
first.

### Decision 8 — Historical artifacts and records are not rewritten

The following keep every statement they made:
- `.agentic-plugins/runs/{notification,egress-launcher,cutover}` and the
  owner-level `~/.agentic-plugins/runs/doctor/egress-intents`;
- the retained bootstrap runs, their proof files included (Decision 7);
- `docs/release-proofs/adr0041-*` and `adr0047-*`;
- `docs/assurance/omcc-cutover-scorecard.md`, frozen by ADR-0065 Decision 7;
- evidence records and changelog entries.

Present-tense prose describing a removed surface is corrected to past tense in
the same PR as the removal (ADR-0060 D6).

### Decision 9 — Leftover configuration is inert; cleanup is the owner's

- The config parser drops unknown keys (`runtime-config.mjs:262`, `:269`), so
  `notify_*` and `egress_headline` lines left in user config become inert, not
  errors. doctor may emit a one-line "retired key present" note.
- The owner-level cleanup runs **after the removal release is installed**:
  - the `~/.zshrc` wrapper, the Codex `notify =` line **before** its shuttle file,
    `~/.agentic-plugins/bin/codex-notify-*`, per-repo `state/runtime/notify/` and
    the Telegram credential (revoke the bot token);
  - where the chain receiver is installed, the Codex `notify =` line is
    **restored** to the argv the chain wraps rather than deleted: a rendered
    `codex-notify-chain.mjs` embeds the owner's earlier notifier
    (`PRIOR_NOTIFY`) and calls it on every event, so deleting the line would
    silence an unrelated notifier too;
  - the stale repo-local allow rules that point at version-pinned plugin-cache
    paths.
- It is a documented runbook, not an executor. ADR-0035 is unchanged: runtime
  still never edits host config.
- **Until that cleanup** (added 2026-10-04):
  - the rendered `~/.agentic-plugins/bin/codex-notify-shuttle.mjs` stays wired
    in the Codex `notify =` line and runs at each agent turn. It picks the
    newest cached runtime that still carries `scripts/notify.mjs`, so while an
    older runtime is cached it keeps delivering, Telegram included
    (Decision 7). Once no cached runtime carries the file, it exits 0 with at
    most one stderr line, so removing the line before the file is tidiness, not
    repair;
  - the credential scrubs are gone (Decision 1). The owner chose to stop
    Telegram at the cleanup (handoff package D16), so from the release until
    then the wrapper still injects the credential into `claude`, and no runtime
    code strips it from the processes doctor and settings spawn. Those
    processes run in the environment `claude` already holds. Removing the
    `~/.zshrc` wrapper ends that window at any time.

### Decision 10 — Amendments, atomic supersession, and the ADR-0060 coordination

**Supersession is atomic with acceptance** (ADR-0056 §Decision 9). This ADR's PR
edits the superseded ADRs' Status lines to "proposed to be superseded by
ADR-0064 (except …)". The acceptance commit flips them. The text blocks are in
§Amendment cascade.

**ADR-0060 ordering.** Its manifest touched doctor, dashboard, retention,
state-readers, cutover-audit and the executor-registry test, which are the same
files this ADR edits, so it was to run **first**. It did: #829 landed on
2026-09-28 and made its `cutover-audit.mjs` edit as written. Decision 5 deletes
the file afterwards.

### Decision 11 — This ADR is docs-only; the macro implements it

Two-stage, like ADR-0056/0057/0060. This change proposes it; the owner accepts
it in a later change, which applies the §Amendment cascade atomically
(Decision 10). Item D of macro `macro-plan-20261003T022443Z-139657`
implements it. Each slice lands with the command, skill and contract text it
changes (Decision 8), its readers, its tests, and the registries, guards and
mutation specs that name what it moves or deletes (Decision 1), with the suite
green. X deletes a file the executor registry lists, R1 moves helpers whose
definition site a plugin-shape test pins, and R4p deletes a file the
credential-reference registry lists; none of those edits can wait for R5.

| Slice | Removes | Order, and why |
|---|---|---|
| C1 | ADR-0060 | done (#829, runtime 0.99.0) |
| X | Decision 5 | first: nothing else depends on the audit |
| R1 | the seven relocations of Decision 2, behaviour-neutral | before any slice that deletes a module a survivor imports |
| R2 | attention's notify group; session capture moves to the manifest-identity runtime resolver | after R1. Its release is installed before the R4 runtime release (Decision 7) |
| R3 | the persona self-sensors and the `NOTIFY_*` rungs | after R1 |
| R4p | Decision 3 | after R1, which moves items 5 and 7; before R4n1, because the profile iterates the notify key family |
| R4n1 | the bootstrap half of Decision 1 and Decision 6: steps, judges, fragments and readers; the `attest` verb; the egress evidence kinds; run schema 1.5 with the retained- and open-run behaviour of Decision 7; bootstrap report 3.0 | after R4p. It ends bootstrap's use of doctor's `egress_ack_proof` and of the egress libraries |
| R4n2 | the rest of Decision 1: emitter, plans, launcher, receivers, config family, `migrate` subcommand, doctor checks (pair to 1.4), dashboard rows (to 4.0), settings surfaces (to 1.27) | after R4n1, R2 and R3 |
| R4s | Decision 4, under the same unreleased doctor 1.4; the permission proof keeps its preflight | after R4n2 |
| R5 | leftover prose, READMEs, follow-up dispositions, and whatever an earlier slice's search missed | last |
| R6 | the owner's machine cleanup (Decision 9) | after the R4 release is installed; a runbook, not a slice |

**Why the notify/egress removal is split.** As one slice it would delete
about 17,700 lines in whole modules, and at the same time edit the four
largest runtime scripts and about fifteen test files across two contract
families: the bootstrap run (registry, reducer, evidence reader, schema,
open-run migration) and the reports (settings, doctor, dashboard). The seam
between them is clean. R4n1 removes bootstrap's last use of doctor's
`egress_ack_proof` and of the egress libraries, and R4n2 then deletes them with
no bootstrap code left to edit. Each lands green with its own readers and
tests. *Changed 2026-10-04:* the draft had one R4a slice for all of it, and ran
it before the profile.

**Releases (ADR-0065).** No slice is followed by a proof re-record or a
recovery PR. release-please releases each package as its slices land. Two
things depend on what is installed. R2's acceptance runs its fresh-session
check of the entry brief and the capture against its installed release. And
R2's release is installed before the R4 runtime release, because until then
attention resolves its capture publisher through a runtime that carries
`scripts/notify.mjs` (Decision 7). Nothing else depends on install order:
older persona installs and the shuttle only go on emitting through an older
cached runtime, or skip the emit. One exception holds a release: from R4p's
merge until R4s lands, the owner does not merge the runtime release PR. One
runtime release then carries the profile, bootstrap run and report, settings,
doctor and dashboard contract changes, the doctor pair moves once, and the
owner installs on both hosts once. The cost is that no
runtime fix can be released during the hold without shipping a half-done
removal. If the hold proves too long, the fallback is one doctor pair bump per
slice that deletes a report field. *Changed 2026-10-04:* the draft said each
slice releases before the next starts, with R4a/b/c sharing one release.

## Amendment cascade (apply verbatim on acceptance)

`<date>` is the acceptance date.

**1. ADR-0041 — Status** (replaces the "Proposed to be superseded" line that this ADR's PR added; the rest of the Status section stays):

```markdown
Superseded by [ADR-0064](0064-runtime-surface-reduction.md) (<date>), in full.
The E1 egress tier, the Telegram channel, the headline, and the egress launcher
are removed; historical proofs under docs/release-proofs/adr0041-* are
unchanged.
```

**2. ADR-0040 — Status** (replaces the "Proposed to be superseded" line that this ADR's PR added; the ADR-0061 line and the rest of the Status section stay):

```markdown
Superseded by [ADR-0064](0064-runtime-surface-reduction.md) (<date>) **except
§6** (`runtime:dashboard`, minus its Tier-2 notify/egress rows) **and except §3
as re-chartered by ADR-0044** (attention as the Claude lifecycle sensor for
session capture and the entry brief). §1, §2, §4, §5 and §7 are removed.
```

**3. ADR-0047 — Status** (replaces the "Proposed to be superseded" line that this ADR's PR added; the rest of the Status section stays):

```markdown
Superseded by [ADR-0064](0064-runtime-surface-reduction.md) (<date>) **except
§7** (citation-aware artifact retention, `runtime:retention`), which stands. §5
was already amended by ADR-0060 D4, and §7's registry by ADR-0060 as well.
```

**4. ADR-0048 — amendment note (after Status):**

```markdown
> **Amendment ([ADR-0064](0064-runtime-surface-reduction.md), <date>):**
> Stage 5 is "statusline" only; its notification and egress steps are removed
> (their ids stay readable as historical in retained runs). §3 (egress evidence
> vocabulary, with the `attest` verb that recorded receipt testimony) and §4
> (egress credential boundary) are retired with E1. §2 (statusline shim policy)
> is unchanged.
```

**5. ADR-0035 §4 — note under the E1 amendment blockquote:**

```markdown
> **Retired ([ADR-0064](0064-runtime-surface-reduction.md), <date>):** tier E1
> (network egress) no longer has an executor. The ceiling and every other tier
> are unchanged; a future egress would need a new ADR.
```

**6. ADR-0046 — amendment note (after Status):**

```markdown
> **Amendment ([ADR-0064](0064-runtime-surface-reduction.md), <date>):** the
> portable machine profile is removed — `profile export`, `profile seed`,
> `plan --profile-file`, the `agentic-machine-profile` schema and the
> `~/.agentic-plugins/profiles/` home (§1 verb list, §4, §7, §8's
> profile-seeded default, Context §7). The bootstrap lifecycle itself stands.
```

**7. ADR-0057 — amendment note on the "three surfaces" table:**

```markdown
> **Amendment ([ADR-0064](0064-runtime-surface-reduction.md), <date>):**
> `runtime:doctor --sandbox-permission-probe` is removed (never executed in 87
> recorded doctor runs), and so is the `plugins/attention`
> `Notification/permission_prompt` matcher, with the rest of notification.
> `--permission-proof` is unaffected. Decision 8 (no permission-relaxing Guard
> Hook) is unaffected.
```

**8. ADR-0005 / ADR-0007 / ADR-0012 — status note:**

```markdown
> **Completed ([ADR-0064](0064-runtime-surface-reduction.md), <date>):** the
> omcc cutover is complete and `runtime:cutover` is retired. This ADR is kept
> as history; nothing in it is re-decided.
```

**9. `docs/adr/README.md` — the 0064 row becomes:**

```markdown
| [0064](0064-runtime-surface-reduction.md) | Runtime surface reduction — removes notification + egress (0041 in full; 0040 except §6 and §3-as-rechartered; 0047 except §7; 0048 amended; 0035 §4 E1 retired), including the bootstrap notify/egress steps, the `attest` verb and the egress evidence kinds; the portable machine profile (0046 amended), removed first; `doctor --sandbox-permission-probe` (0057 note); and `runtime:cutover` (0005/0007/0012 completed; answers the declared-vs-audited cutover question). Bootstrap run 1.5 keeps retired members readable and migrates open runs; one held runtime release moves the doctor pair to 1.4; follows ADR-0060 and ADR-0065 | Accepted |
```

Three more status cells change. The amended ADRs (0005, 0007, 0012, 0035,
0046, 0048, 0057) keep theirs, as ADR-0052's did when ADR-0060 amended it.

- ADR-0041: `Superseded by [ADR-0064](0064-runtime-surface-reduction.md) — in full`
- ADR-0047: `Superseded by [ADR-0064](0064-runtime-surface-reduction.md) — **except §7** (citation-aware retention)`
- ADR-0040, after its ADR-0061 entry, in the ADR-0019 row's form:
  `; by [ADR-0064](0064-runtime-surface-reduction.md) — **except §6** (dashboard) **and §3 as re-chartered by ADR-0044**`

## Consequences

**Positive.**
- ≈ 20k source+test LOC and three ADRs' worth of live contract leave the tree.
- The Telegram credential stops existing on the machine, and no network-egress
  executor remains in runtime.
- The bootstrap Stage 5 story becomes one sentence.
- doctor's proof set is the one actually used.
- The autopilot design loses its dependency on notify (halts report through the
  terminal and the run ledger).

**Negative.**
- **No push signal remains.** A waiting session is only noticed by looking.
  The autopilot's optional driver-local macOS notification is the documented
  substitute; it is the driver's own act and has no egress.
- A second machine cannot be seeded from the first; it is bootstrapped stage by
  stage.
- The sandbox probe's per-direction readiness summary is gone; readiness is
  proven only by the executing proofs.
- Retained notify/cutover/profile artifacts become unmanaged history.
- While the host pair is partly upgraded, the older host reports a 1.5
  bootstrap run `incomplete` and a 1.4 doctor proof `malformed` (Decision 7).
- No runtime release can ship between R4p and R4s without the half-done removal
  (Decision 11).
- Installing the release does not by itself stop notifications: attention's
  notify path, two persona self-sensors and the shuttle fall back to an older
  cached runtime that still carries the emitter, until R2/R3 are installed,
  the cache no longer holds such a version, or the owner's cleanup removes the
  wiring (Decision 7).

**Neutral.**
- `runtime:dashboard`, retention, statusline, entry brief and capture continue
  under their own ADRs.
- Leftover config keys are inert.
- Stage numbering is unchanged.
- The run schema keeps accepting the retired members, so it does not shrink.

## Alternatives Considered

**Keep local channels only** (`macos-osascript`/`file-log`, drop E1). Rejected
by the owner (REVIEW N2). The local channel was `none`, and keeping it keeps the
emitter, schema, kinds filter, dedupe and quiet-hours machinery (≈ 5k LOC) for a
signal the autopilot can raise itself.

**Remove the attention plugin entirely.** Rejected (REVIEW N3). The entry brief
and session capture are in active use. Moving their hooks into runtime would
break ADR-0044's "runtime stays hook-free".

**Keep the machine profile, bumping it to 1.4 without notify/egress.** Rejected
(REVIEW S5). It was never used, and the bump is pure cost.

**Keep the sandbox probe.** Rejected (REVIEW S7). It was never executed, and the
proofs supersede it by execution.

**Keep `runtime:cutover` as an audit tool.** Rejected (REVIEW S9). The cutover
is complete and nothing calls it.

**Leave everything inert (no removal).** Rejected. The Telegram credential and
the E1 executor would stay live on the machine, and the surfaces keep costing
maintenance: tests, doc drift, executor-registry entries.

**Remove notify before the profile** (the 2026-09-25 order). Rejected on
2026-10-04: the profile iterates the notify key family and its schema requires
it, so the profile would need a schema change in between, for a feature this
ADR deletes.

**Remove notify and egress in one slice.** Rejected on 2026-10-04 (Decision
11): it changes two contract families in the largest files at once, while a
clean seam lets each half land with its own readers and tests.

**Refuse an open bootstrap run that holds a retired evidence file, leaving
`abandon` as the only way out.** Considered for R4n1. The proof reader would
stay unchanged, but an open run would be stranded over files nothing reads any
more. Skipping two fixed file names costs one constant and one branch, and
`abandon` stays available either way.

**Drop the retired members from the run schema.** Rejected: one schema
validates every minor, so every retained run that carries one would turn
schema-invalid and could no longer be shown as history.
