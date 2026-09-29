# ADR-0064: Runtime surface reduction — remove notification and egress, the machine profile, the sandbox probe, and the cutover audit

## Status

Proposed (2026-09-29). Drafted 2026-09-25 in the owner's handoff package,
outside this repository, from the owner's item-by-item review, and realigned
before adoption to ADR-0060's implementation and ADR-0059–0062. Proposed
alongside [ADR-0063](0063-autopilot-fresh-session-driver.md); the two are
independent.
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
- **Sibling removal.** [ADR-0060](0060-remove-host-version-tracking.md)
  (accepted 2026-09-18) was planned as the first slice of this ADR's
  implementation macro. It was implemented on its own on 2026-09-28 in #829 and
  released as runtime 0.99.0 (#830), before this ADR was proposed
  (§Decision 10).

<!--
Drafted 2026-09-25 against the fix/adr0061-sibling-resolvers branch, which
landed as #812; citations re-verified at 68438b9e on 2026-09-29. Evidence: the owner's item-by-item review
of 2026-09-25 (REVIEW.md in the owner's handoff package) and the measurements
quoted in Context. Plan, per-file manifest and slice order: the handoff
package's design/notify-removal.md, outside this repository; it lands with the
implementing pull requests. Mirrors ADR-0057's structure: manifest by
identifier, split mixed modules, era matrix per contract, historical artifacts
untouched, atomic supersession with carve-outs, docs-only with a separate
implementation macro.
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
| `runtime:bootstrap` Stages 0–4, 5 (statusline), 7, 8 | Kept (REVIEW S4); only the notify/egress steps and the profile verbs go |
| Codex `[tui] notifications` in the owner's `~/.codex/config.toml` | Codex-native, not agentic-plugins |

## Decision

### Decision 1 — Remove notification and egress; the manifest is by identifier, not by the word

"notify", "notification" and "egress" also appear in unrelated prose and in
Codex-native keys. The manifest names identifiers.
- **Removed in full:**
  - `scripts/notify.mjs`;
  - `lib/notify-schema.mjs`, `lib/notification-plan.mjs` (after Decision 2),
    `lib/legacy-egress-discovery.mjs`, `lib/egress-{launcher-plan,semantics,config,channel,intent-wal}.mjs`;
  - `receivers/codex-notify-{shuttle,chain}.mjs`;
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
  - `runtime:migrate legacy-egress-intents`.
- **Reduced:** `receiver-api.mjs` and `receiver-inventory.mjs`. They lose the
  shuttle and chain; `RECEIVER_KINDS` keeps `agentic-statusline.mjs`.

The per-file manifest with `path:line` is the implementation plan's §2 (the handoff package's `design/notify-removal.md`).

### Decision 2 — Mixed modules split; survivors relocate before anything is deleted

Six things that survivors use live in modules this ADR deletes. They move first,
in a behaviour-neutral slice:
1. `resolveRepoRoot` (`notify.mjs`) moves to `lib/repo-root.mjs`. Consumers:
   `context.mjs`, `retention.mjs`, `dashboard.mjs`.
2. `scrubSecrets` (`egress-channel.mjs`) moves to a generic scrub module.
3. `safeOperatorText` (`egress-intent-wal.mjs`) moves to a generic text module.
4. `substituteOnce` (`notification-plan.mjs`) moves to `statusline-plan.mjs`.
5. `STATUSLINE_PRESET_AGENTIC_6` (`machine-profile.mjs`) moves to `statusline-plan.mjs`.
6. The `$CODEX_HOME/config.toml` read and the `[tui]` table parse move from
   `gatherCodexNotificationInputs` / `parseCodexNotifyConfigToml` to
   `lib/codex-config.mjs`, because bootstrap's Codex statusline judge consumes
   them. The `notify =` parse goes with Decision 1.

This is the ADR-0057 Decision 3/4 precedent: a module splits by consumer, not by
file.

### Decision 3 — Remove the portable machine profile

`bootstrap profile export`, `profile seed` and `plan --profile-file` go, along with:
- `lib/machine-profile.mjs`;
- the `agentic-machine-profile-1.3` schema;
- the machine-global artifact home `~/.agentic-plugins/profiles/`;
- the profile-only reader projections:
  - Claude/Codex permission projections in `lib/profile-readers.mjs`;
  - `lossyProfileInputs`.

`lib/profile-readers.mjs` keeps the readers that Stage 4/5 judges use: model
effort, session, Claude settings, statusline. Bootstrap still guides a new machine
stage by stage; only the "copy this machine" shortcut goes.

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

### Decision 5 — Retire `runtime:cutover`

These go:
- `scripts/cutover-audit.mjs`;
- `commands/cutover.md`;
- `core/skills/cutover/`;
- the footer's cutover-record guidance and its `--cutover-*` flags;
- retention's `cutover` citation-source family;
- the `/runtime:cutover` route mentions in engineer `start` and the entry-routing
  contract.

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
- **The scorecard leaves the stage-doc pipeline.**
  `docs/assurance/omcc-cutover-scorecard.md` is one of the three stage docs.
  `scripts/sync-doc-versions.mjs` rewrites its runtime tokens after each release,
  `scripts/check-doc-evidence.mjs` gates its proof citations, and
  `.github/workflows/release-please.yml` runs the sync.
  - Once the command it scores is gone, it gets a dated closing note, and those
    three stop treating it as a live document.
  - It is not rewritten (Decision 8). Only the note is added.

### Decision 6 — Bootstrap Stage 5 becomes "statusline"; stage numbers are kept

- Stage 5 keeps its number and loses its notification and egress steps:
  - `notify.configured`;
  - `notify.codex.configured`;
  - `egress.configured`;
  - `proof.egress-provider-ack`;
  - `egress-receipt-attestation`;
  - the Stage-4 `config.notify_kinds` value step.
- Stage 6 stays empty (ADR-0057) and 7/8 keep their numbers. Renumbering would
  invalidate every retained run manifest.
- The removed step ids stay **readable as historical** in retained runs.
  Four exist on the owner's machine.

### Decision 7 — Every contract that loses fields gets an era matrix

| Contract | Today (baseline) | Loses | Reader obligation |
|---|---|---|---|
| settings report | `runtime-settings-1.26` | `notification_plan`, `egress_launcher_plan`, `notify_settings`, `notify_warnings`, `notify_*` projections | bump to 1.27. Readers of retained reports accept 1.26 as historical |
| doctor report / artifact | `runtime-doctor-1.3` / `runtime-doctor-artifact-1.3` (ADR-0060 already took both from 1.2) | `egress_ack_proof`, `sandbox_permission_probe`, shuttle receiver kinds | **one** bump to `1.4`/`1.4` when Decisions 1 and 4 ship in one runtime release, otherwise one bump each. doctor + dashboard extend the **matched-pair** list (ADR-0057 D11). The release is installed on both hosts before a new proof is recorded, because an older reader on the other host counts it `malformed` (`doctor.mjs:124-130`) |
| dashboard report | `runtime-dashboard-3.0` (after ADR-0060) | Tier-2 notify-state/egress-throttle rows | minor bump; historical dashboards are not re-read |
| bootstrap run | `runtime-bootstrap-run-1.4` | the Stage 5 notify/egress steps, the profile/seed fields | bump to 1.5 with the removed ids readable as historical |
| machine profile | `agentic-machine-profile-1.3` | the whole contract | deleted; no reader survives |
| notification plan / egress-launcher plan / cutover evidence artifact families | 1.1 / — / 1.0 | the producers | orphaned history; retention stops managing them |

The implementation publishes, per contract, the tokens it writes new, the tokens
it still reads as historical, and the projection between them.

### Decision 8 — Historical artifacts and records are not rewritten

The following keep every statement they made:
- `.agentic-plugins/runs/{notification,egress-launcher,cutover}` and the
  owner-level `~/.agentic-plugins/runs/doctor/egress-intents`;
- `docs/release-proofs/adr0041-*` and `adr0047-*`;
- `docs/assurance/omcc-cutover-scorecard.md`;
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
  - the stale repo-local allow rules that point at version-pinned plugin-cache
    paths.
- It is a documented runbook, not an executor. ADR-0035 is unchanged: runtime
  still never edits host config.

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

### Decision 11 — This ADR is docs-only; `surface-reduction-impl` implements it

Two-stage, like ADR-0056/0057/0060. This change proposes it; the owner accepts
it in a later change, which applies the §Amendment cascade atomically
(Decision 10).
The implementation macro carries the slices in the plan's §4:
- C1 — ADR-0060, already done (#829);
- X — cutover;
- R1 — relocations;
- R2 — attention;
- R3 — personas, after the ADR-0061 branch series merges;
- R4a/b/c — runtime notify, profile, sandbox probe (one runtime release, so the
  doctor report bumps once);
- R5 — docs/tests;
- R6 — owner runbook.

Each slice releases before the next starts.

## Amendment cascade (apply verbatim on acceptance)

**1. ADR-0041 — Status** (replaces the "Proposed to be superseded" line that this ADR's PR added; the rest of the Status section stays):

```markdown
Superseded by [ADR-0064](0064-runtime-surface-reduction.md) (in full). The E1
egress tier, the Telegram channel, the headline, and the egress launcher are
removed; historical proofs under docs/release-proofs/adr0041-* are unchanged.
```

**2. ADR-0040 — Status** (replaces the "Proposed to be superseded" line that this ADR's PR added; the ADR-0061 line and the rest of the Status section stay):

```markdown
Superseded by [ADR-0064](0064-runtime-surface-reduction.md) **except §6**
(`runtime:dashboard`, minus its Tier-2 notify/egress rows) **and except §3 as
re-chartered by ADR-0044** (attention as the Claude lifecycle sensor for
session capture and the entry brief). §1, §2, §4, §5 and §7 are removed.
```

**3. ADR-0047 — Status** (replaces the "Proposed to be superseded" line that this ADR's PR added; the rest of the Status section stays):

```markdown
Superseded by [ADR-0064](0064-runtime-surface-reduction.md) **except §7**
(citation-aware artifact retention, `runtime:retention`), which stands. §5 was
already amended by ADR-0060 D4, and §7's registry by ADR-0060 as well.
```

**4. ADR-0048 — amendment note (after Status):**

```markdown
> **Amendment ([ADR-0064](0064-runtime-surface-reduction.md)):** Stage 5 is
> "statusline" only; its notification and egress steps are removed (their ids
> stay readable as historical in retained runs). §3 (egress evidence vocabulary)
> and §4 (egress credential boundary) are retired with E1. §2 (statusline shim
> policy) is unchanged.
```

**5. ADR-0035 §4 — note under the E1 amendment blockquote:**

```markdown
> **Retired ([ADR-0064](0064-runtime-surface-reduction.md)):** tier E1 (network
> egress) no longer has an executor. The ceiling and every other tier are
> unchanged; a future egress would need a new ADR.
```

**6. ADR-0046 — amendment note (after Status):**

```markdown
> **Amendment ([ADR-0064](0064-runtime-surface-reduction.md)):** the portable
> machine profile is removed — `profile export`, `profile seed`,
> `plan --profile-file`, the `agentic-machine-profile` schema and the
> `~/.agentic-plugins/profiles/` home (§1 verb list, §4, §7, §8's
> profile-seeded default, Context §7). The bootstrap lifecycle itself stands.
```

**7. ADR-0057 — amendment note on the "three surfaces" table:**

```markdown
> **Amendment ([ADR-0064](0064-runtime-surface-reduction.md)):**
> `runtime:doctor --sandbox-permission-probe` is removed (never executed in 87
> recorded doctor runs). `--permission-proof` is unaffected. Decision 8 (no
> permission-relaxing Guard Hook) is unaffected.
```

**8. ADR-0005 / ADR-0007 / ADR-0012 — status note:**

```markdown
> **Completed ([ADR-0064](0064-runtime-surface-reduction.md)):** the omcc
> cutover is complete and `runtime:cutover` is retired. This ADR is kept as
> history; nothing in it is re-decided.
```

**9. `docs/adr/README.md` — index row:**

```markdown
| [0064](0064-runtime-surface-reduction.md) | Runtime surface reduction — removes notification + egress (0041 in full; 0040 except §6 and §3-as-rechartered; 0047 except §7; 0048 amended; 0035 §4 E1 retired), the portable machine profile (0046 amended), `doctor --sandbox-permission-probe` (0057 note), and `runtime:cutover` (0005/0007/0012 completed; answers the declared-vs-audited cutover question and retires the scorecard from the stage-doc pipeline); follows ADR-0060, implemented first | Proposed |
```

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

**Neutral.**
- `runtime:dashboard`, retention, statusline, entry brief and capture continue
  under their own ADRs.
- Leftover config keys are inert.
- Stage numbering is unchanged.

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
