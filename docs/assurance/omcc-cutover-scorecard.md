# omcc Cutover Assurance Scorecard

Status: Draft
Last reviewed: 2026-05-17

This scorecard translates the user's omcc replacement requirements into
repo-verifiable assurance gates. It does not replace
[`adr/0007-migration-cutover-plan.md`](../adr/0007-migration-cutover-plan.md)
or [`adr/0012-omcc-removal-preconditions.md`](../adr/0012-omcc-removal-preconditions.md).
It is the operator-facing checklist for deciding whether agentic-plugins is
ready to replace omcc in daily development.

Cutover is not complete while any gate below is `partial` or `missing`.
Passing tests, synced manifests, or green release automation are evidence, not
completion by themselves.

## Current Verdict

Overall status: **not cutover-ready**.

The repo already has the right architectural direction:

- `plugins/engineer` is the primary L3 development workbench.
- `plugins/orchestrator` is the L2 multi-deliverable coordination surface.
- `plugins/runtime` is the L1 runtime/operator control plane.
- `plugins/companions` is the L1 script-only companion bridge library.

The remaining gap is assurance depth: the current-host UX parity gate is now
measured and satisfied, while self-hosted dogfood evidence, ADR-0012 condition
promotion, and final completion state still need to complete before omcc can be
removed without a fallback.
The legacy omcc-dev behavior map is now repo-verifiable through
[`omcc-legacy-pattern-map.md`](omcc-legacy-pattern-map.md) and
`runtime:cutover`.

## Cutover Gate Terms

The strengthened removal gate is intentionally stricter than "the replacement
features exist." It combines ADR-0012 capability evidence with a short real-use
stability window and this scorecard's broader product-quality checks.

- **Condition 2 satisfied** means engineer's real companion path can complete
  both `claude -> codex` and `codex -> claude` round-trips from the currently
  installed host versions. Fixture-only tests and historical `plugins/research`
  evidence do not satisfy this gate because engineer adds its own state,
  dispatch, and adapter code on the peer path.
- **Condition 3 satisfied** means agentic-plugins can be advanced through
  non-trivial repo work using agentic-plugins surfaces only: engineer,
  orchestrator, runtime, companions, git, and GitHub. A task does not count if
  it falls back to `omcc-dev` for planning, continuity, peer review, PR
  handling, or recovery.
- **One week of dogfood** means a calendar week of normal development after the
  condition 2/3 candidate point, with daily or task-level evidence that the
  agentic-plugins surfaces remained the primary workflow. Any `omcc-dev`
  fallback must either restart the window or be recorded as a blocker with a
  follow-up fix.
- The dogfood window is forward-looking: it starts from the first accepted
  no-omcc-dev evidence record after the candidate point, reports elapsed gaps as
  `missing`, and reports future dates still needed as `remaining`. It should not
  require backfilling dates before the candidate point.
- **Scorecard 100%** means every requirement row below is either `satisfied` or
  explicitly rejected/deferred with a rationale the user accepts. It does not
  mean every imaginable future plugin feature exists; it means no listed
  omcc-replacement requirement remains `partial` or `missing`.

The verifier can only report `cutover-ready-candidate`. The final cutover still
requires the user to explicitly declare that omcc can be archived or removed,
per ADR-0007.

## PR, Release, and Installed-State Continuity

Cutover evidence is only trustworthy if development continues from the same
published and installed surfaces that the user will actually use. A finished
implementation PR is therefore not the end of a slice.

For each runtime/engineer/orchestrator slice, use this continuity loop:

1. Develop on a non-default branch and open a draft PR with validation evidence.
2. After review and merge, let release-please open the package release PR when
   the commit touches a release-managed package path.
3. Merge the release PR, then verify manifest, plugin manifest, and marketplace
   version sync with `validate:versions` and `sync:marketplace --check`.
4. Refresh the locally installed agentic-plugins surfaces through
   `runtime:settings --execute-plugin-management` or the host-native commands it
   recommends. This must stay explicit; runtime must not silently mutate host
   plugin installs.
5. Run `runtime:doctor`, `runtime:settings`, and when host versions moved,
   `runtime:compat snapshot/check/plan` from the updated installed state.
6. Record the day's dogfood evidence with `runtime:cutover record` only after
   the operator can explicitly say whether `omcc-dev` was active and what the
   current completion footer state is.
7. Clean up merged branches/worktrees only after the release and installed-state
   checks are recorded.
8. Start the next development slice from the updated main branch and installed
   plugin state, not from the pre-release checkout.

Current local dry-run evidence: `runtime:settings` reports all agentic-plugins
surfaces available with source/cache versions matching the current repo
manifest, and zero plugin-management config writes planned against the installed
`plugin-runtime` `0.83.0` state (both the Claude plugin cache and `codex plugin
list --json` report the runtime plugin installed and enabled at 0.83.0 —
claude=installed/0.83.0, codex=installed/0.83.0 — alongside engineer 0.21.0 and
orchestrator 0.13.0, per the 2026-07-20Z doctor read; the Stage-0-form installs
again ran host-native — Claude `claude plugin update runtime@agentic-plugins`,
Codex `codex plugin marketplace upgrade agentic-plugins` + `codex plugin add
runtime@agentic-plugins` — so this upgrade too left no `runtime:settings
--execute-plugin-management` executor artifact of its own, the newest being
the 2026-07-14 `settings-20260714T021101Z-94f0f6`). Current runtime
execution evidence is native to the installed
`plugin-runtime` `0.83.0`: permission proof, deep peer smoke, and workflow
continuation proof executed and passed in both directions, recorded on
2026-07-20Z as `doctor-20260720T052332Z-a0d677` — the **ADR-0045
entry-time proposal surfaces** loop (feature PRs S6 #597 `932c135`, S7a
#598 `5c6dae8`, S7b #599 `45624bf`, S8 #600 `de20853`; release PR #596 squash
`e249ac7`, tag `plugin-runtime-v0.83.0` alongside `plugin-attention-v0.6.0` —
the ADR-0044 S5 Stop→publish-session sensor + publisher floor 0.82.0 pin,
#595 `3b8ed8d` — marketplace sync `360a71f`; Claude
Code `2.1.215` / `codex-cli 0.144.1`; the new doctor `entry_brief`
readiness section reads `off` against the installed binary — the shipped
default, the honest informational state before any operator opt-in,
mirroring the `session_capture` `off` precedent). `overall`
reads `pass`;
Codex hook state reads **12/12** expected `enabled_trusted` with
`unexpected_agentic_entries=2` (the retained pre-relocation attention rows,
display-only); **experience parity deliberately reads `partial` `91%`
(manual follow-up `codex-hook-review`)** — the S8a4-hardened currency evaluation
refuses to prove the pre-S8a4 four-plugin attestation
`settings-20260713T234950Z-f08600` (designer@0.3.0 / engineer@0.21.0 /
founder@0.4.0 / orchestrator@0.13.0) current: the artifact predates the
canonical `bound_versions` capture (`bound_versions.codex=null`), so it
evaluates `stale` (`currency_reason=codex_cli_version_changed`) against
`codex-cli 0.144.1` instead of being silently trusted — the fail-closed
half of contract §11.2 #24 observed live: attestation currency binds the Codex
CLI and the hook-bearing plugin versions, and the legacy null binding is
refused rather than trusted, while the hook-bearing-upgrade invalidation half
is unit-pinned in S8a2 and demonstrated by the recorded designer/founder
upgrade precedents; the trusted hook entries themselves are unchanged (neither
released package changed a Codex hook-bearing plugin — runtime ships no hooks
and attention exposes zero Codex hook surface), and a fresh operator
`/hooks` confirmation plus `runtime:settings --attest-codex-hook-review`
restores `ready`. **`host_parity_baseline` reads `stale`** — the recorded
baseline is 2026-07-14 Claude Code `2.1.208` while the observed CLI is
`2.1.215`, a Claude patch-level drift tracked to a baseline-refresh follow-up
slice per the 0.77.2 / attention-0.4.1 precedents and not pretended current.
The S8c released-package acceptance (an 0.81.0-era record) exercised the then-installed 0.81.0
from a consumer repo: `bootstrap.mjs` `status`/`verify` returned the contract
§3.1 exit-30 `no-active-run` semantics, a full `plan --bundle base` → `status`
→ `abandon` lifecycle ran as `bootstrap-20260718T081054Z-9be0cf` (24 expected
steps); a full installed `settings.mjs` probe run from the consumer repo
planned zero source-tree catalog remediations (the S8a1 regression observed
against the released package), the probe-free `--skip-host-cli-probes` mode
separately returned its discriminated `report_scope=local_plan` R0 report, and
a consumer-root deep-peer-smoke passed in both directions selecting the
**installed** companions `0.4.0` from both host caches (no workspace scripts on
the discovery ladder). This
supersedes the 0.82.0-native **ADR-0044 session-capture exit-side stack loop**
recorded on 2026-07-19Z as doctor-20260719T071752Z-6392f1 (feature PRs S2
#588 `9dc3eff`, S3a #590 `8b7d887`, S3b #591 `7f5710a`, S4 #592 `417bee6`;
release PR #589 squash `717c4c3`, tag plugin-runtime-v0.82.0 — backticks
deliberately omitted for the freshness gate — marketplace sync `31a01ba`;
Claude Code `2.1.215`; that record read `overall` `pass`, three execute
proofs passed both directions, parity partial 91% with the codex-hook-review
follow-up, and the then-new `session_capture` section read `off`), and in
turn the 0.81.0-native **ADR-0046 S8 machine-bootstrap stack loop**
recorded on 2026-07-18Z as doctor-20260718T080955Z-6eba4e (feature commits
S8a1 #576 `267cd33`, S8a2 `5af386e`, S8a4 `29bb5b1`, S8a5 #581 `8712eb9`, S8b
#582 `960c8bc`; release PR #577 squash `7adb9ef`, tag plugin-runtime-v0.81.0 —
backticks deliberately omitted for the freshness gate — marketplace sync
`769b527`; Claude Code `2.1.214`; that record read `overall` `pass`, three
execute proofs passed both directions, parity partial 6/8 with the
codex-hook-review follow-up), and in turn the 0.80.1-native **S1 permission-advisor defect-class fix loop**
recorded on 2026-07-14Z as doctor-20260714T235550Z-60336c (feature PR #573
squash-merged `89c16ad` — closing the permission-advisor defect class: secret
leak, danger-rule bypass, cross-bucket governance, and their two mirrors;
release PR #574 squash `6d82617`, tag plugin-runtime-v0.80.1 — backticks
deliberately omitted for the freshness gate — marketplace sync `160b3d8`;
Claude Code `2.1.209` / `codex-cli 0.144.1`; that record read `overall` `pass`,
experience parity `ready` `100%` 8/8 with zero manual follow-ups, and the
four-plugin attestation as current because that runtime-only bump changed no
hook-bearing plugin), and in turn the **S9 completion-output-contract loop** recorded on 2026-07-13Z as
`doctor-20260713T025136Z-7758d3` on the then-installed runtime 0.80.0 (feature
PR #558 rebase-merged as `00dbc80`/`85bbd3d`/`4c8e59f` per the ADR-0016
three-package split; release PR #559 squash `1d02390`, tag
plugin-runtime-v0.80.0 — backticks deliberately omitted for the freshness gate —
alongside plugin-engineer-v0.21.0 and plugin-orchestrator-v0.13.0, marketplace
sync `ddb43d4`; the installed-state refresh ran through the `runtime:settings
--execute-plugin-management` executor artifact
`settings-20260713T025027Z-8f625a`, 4 update commands executed, 0 failed, both
hosts reporting runtime 0.80.0 with engineer 0.21.0 and orchestrator 0.13.0;
Claude Code `2.1.207` / `codex-cli 0.144.1`). That record read `overall` `pass`
and `host_parity_baseline` `current` against the 2026-07-11 baseline (the #550
refresh), Codex hook state **12/12** expected `enabled_trusted` with
`unexpected_agentic_entries=2`, and **experience parity deliberately `partial`
`91%`** (manual follow-up `codex-hook-review`): the engineer 0.21.0 /
orchestrator 0.13.0 hook-bearing upgrades version-invalidated the four-plugin
`/hooks` attestation `settings-20260712T015100Z-312fbb` (attested at engineer
0.20.1 / orchestrator 0.12.1), so a fresh operator `/hooks` confirmation plus
`runtime:settings --attest-codex-hook-review` was required before parity read
`ready` again — the trusted hook entries themselves unchanged (no hook file
changed in that release, so trust hashes still matched). The operator completed
that confirmation the same day: the fresh four-plugin attestation
`settings-20260713T030937Z-f50815` (designer@0.2.1 / engineer@0.21.0 /
founder@0.3.1 / orchestrator@0.13.0) restored observed parity in the
post-attestation record `doctor-20260713T030956Z-20dcc3` — **`ready` `100%`
8/8** with zero manual follow-ups, `overall` `pass`, baseline `current`, and all
three execute proofs re-passed in both directions against the same installed
0.80.0 set. This supersedes the 2026-07-12Z
**ADR-0043 S2 four-persona workflow-projection seam** record recorded as
`doctor-20260712T080638Z-005af5` on the then-installed runtime 0.79.0
(feature PR #555 squash `cb720e7`, behind ADR authoring PR #553 and
Accepted-flip PR #554; release PR #556 squash `558f78a`, tag
plugin-runtime-v0.79.0 — backticks deliberately omitted for the freshness
gate — marketplace sync `8ca4651`; parity then `ready` `100%` 8/8, `overall`
`pass`, baseline `current`; the attestation was still current because runtime
ships no hooks). That record in turn superseded the 2026-07-11Z **attention 0.4.1 relocation
loop** record `doctor-20260711T045954Z-731e34`, measured on the then-installed
0.78.1 runtime — that loop (fix PR #546 squash `ceb2fb9` + docs PR #547
`1d20f82` + release PR #548 `beb4917`, tag `plugin-attention-v0.4.1`,
marketplace sync `553ac79`; installed-state refresh via the executor artifact
`settings-20260711T045604Z-075b26`, attention `0.4.1` enabled on both hosts;
Claude Code `2.1.207` / `codex-cli 0.144.1`) likewise read `ready` `100%` 8/8
and `overall` `pass`: the #543 command-portability gate cleared because the
relocated package supplies **neither** Codex discovery input — doctor reads
`effective.status = not_packaged` on the installed 0.4.1 cache (no
`.codex-plugin` `hooks` key, no root `hooks/hooks.json`), attention left the
bundled/review/command-warning sets, and the fresh **four-plugin** `/hooks`
attestation `settings-20260711T045915Z-5ca22a` (designer `0.2.0` / engineer
`0.20.0` / founder `0.3.0` / orchestrator `0.12.0`) read current at that
measurement — the prior five-plugin attestation was invalidated as
`plugin_set_changed` by design, and the persona-release re-attestation of
2026-07-12T01:51Z (`settings-20260712T015100Z-312fbb`) is the attestation of
record today.
Codex hook state reads **12/12** expected `enabled_trusted` with
`unexpected_agentic_entries=2`: the retained pre-relocation attention trust
rows, display-only — the host did **not** prune them across the upgrade, and
runtime's non-mutation is hash-verified (`config.toml` SHA-256 identical
before/after doctor+attest). Claude-side, the manifest-declared registration
is **live-fire proven**: a disposable repo with `notify_channel="file-log"`
recorded a `turn-complete` event from the relocated Stop sensor during a
`claude -p` turn against the installed 0.4.1, and `claude plugin validate
--strict` passes on the installed path. Honest caveat at that measurement:
`host_parity_baseline` read `stale` — Claude Code moved `2.1.206`→`2.1.207`
(patch drift) after the 2026-07-10 baseline; the same-day #550 refresh
(2026-07-11 baseline) closed it, per the 0.77.2 precedent. That record in turn
superseded the 0.78.1-native 2026-07-10Z record
`doctor-20260710T153802Z-276226` (Claude Code `2.1.206` / `codex-cli
0.144.1`; experience parity **deliberately** `partial` `95%` 7/8 and
`overall` `warning` — the #543 gate held `lifecycle_hook_continuity`
`partial` with `command-warnings=attention` until this relocation landed;
`host_parity_baseline` `current` against the 2026-07-10 baseline with
post-release `drift: none` `compat-20260710T140007Z-e0aaaf`; Codex hook state
14/14 with attention's trusted rows **inside** the expected set per the #543
fold and `Notification` `unmapped=1`; five-plugin attestation
`settings-20260710T153728Z-5796b6`), and before it the intermediate 0.78.0-era record
(`doctor-20260710T135955Z-d752f5`, `ready` `100%` 8/8 under the pre-#543
criterion with 12/12 expected + 2 trusted attention entries recorded as an
honest inventory-lag note — the note that became fix #543) is superseded by
this record, which in turn supersedes the 0.77.2-native proof
(`doctor-20260710T044745Z-1a789e`, parity `ready` `100%`, recorded with an
honest `host_parity_baseline` `stale` caveat that the 2026-07-10 baseline
refresh later closed), the prior 0.77.1-native proof
(`doctor-20260709T141930Z-515ebf`, parity `ready` `100%`) and,
before it, the 0.76.0 loop (`doctor-20260707T140348Z-5a8fb8`, parity `ready` `100%`).

**Experience parity read `partial` `91%` (6/8) in the earlier 0.77.0-native artifact, and the shortfall
is a runtime defect this release fixes — not a host regression.** Installing
`designer` `0.2.0` grew the Codex hook-bearing set to
`designer@0.2.0` / `engineer@0.20.0` / `orchestrator@0.12.0` / `founder@0.3.0`,
making designer the first hook-bearing plugin trusted on Codex since the
ADR-0035 §6 host-config writer was removed. A current Codex records a trusted
hook as a `trusted_hash` line with **no `enabled` key** (the `/hooks` view exposes
no enable toggle), while doctor read an absent key as `disabled`; the attestation
executor refuses while any expected entry is disabled, so
`runtime:settings --attest-codex-hook-review` blocked and both hook-continuity
criteria degraded. The designer `Stop` hook demonstrably fired and archived a
terminal designer workflow during a `codex exec` turn while doctor called it
disabled. The classifier now treats an absent `enabled` key as enabled — only an
explicit `enabled = false` disables — and
`plugins/runtime/docs/codex-capability-baseline.md` records the observed Codex
semantics. With the fix, hook state reads `12/12` `enabled_trusted`
(`untrusted=0`, `disabled=0`, `missing=0`) and the attestation covers all four
bundled plugins; the `ready` `100%` 8/8 proof is re-recorded against the released
fix rather than a patched working tree.

The `plugins/attention` `0.4.0` sensor plugin was long treated as a
deliberately Claude-hook-only plugin (ADR-0040 §3 hook-only L1) whose
`claude_adapter_only` classification kept it out of the Codex sets — until host
truth disproved that premise (see the #543 narrative below); the classification
survives as a command-shape diagnosis only, and the attention package has since
relocated its Claude registration out of Codex default discovery entirely
(2026-07-11; install proof landed the same day as
`doctor-20260711T045954Z-731e34` — parity `ready` `100%` restored, see the
release/install narrative above). Runtime still records the
operator attestation claim and does not mutate or independently prove Codex trust
state; the attestation is valid only while the hook-bearing plugin set and source
versions still match — which is exactly why adding designer invalidated the prior
`settings-20260704T170801Z-b66656` attestation and required a fresh `/hooks` review.
The latest `plugin-runtime` `0.83.0` release/install proof loop is the
**ADR-0045 entry-time proposal surfaces** slice — feature PRs S6 #597
`932c135` (the shared host-localization leaf extraction), S7a #598 `5c6dae8`
(the entry-brief bounded read layer: versioned tolerant parsers + bounded
scans), S7b #599 `45624bf` (the §16 arbiter + pointer-only brief +
user-scope-only session keys + context CLI), and S8 #600 `de20853` (the
snapshot-only dashboard entry advisory + §18 readiness diagnosis +
trusted-host threading); release PR #596 squash `e249ac7` cut tag
`plugin-runtime-v0.83.0` alongside `plugin-attention-v0.6.0` (the ADR-0044 S5
sensor slice, #595 `3b8ed8d`) and marketplace sync commit `360a71f`, and the
0.83.0-native proof doctor-20260720T052332Z-a0d677 (2026-07-20Z; `overall`
`pass`, three execute proofs executed and passed in both directions, Codex
hook state `12/12` expected `enabled_trusted` with
`unexpected_agentic_entries=2` retained pre-relocation attention rows,
display-only; the new doctor `entry_brief` readiness section reads `off`, the
shipped default, mirroring `session_capture` `off`) was taken against that
released binary, not a patched working tree. It supersedes the 0.82.0
**ADR-0044 session-capture exit-side** loop — feature PRs S2 #588 `9dc3eff`
(contract + schemas + session config family), S3a #590 `8b7d887` (note staging
+ `status --slot` + the hook-grade output-mode split), S3b #591 `7f5710a`
(the `publish-session` transaction + fs-mutation guard modeling), and S4 #592
`417bee6` (the shared session-readiness diagnosis + dynamic publisher-floor
declaration + operator docs + ADR pointer lines); release PR #589 squash
`717c4c3` cut tag plugin-runtime-v0.82.0 — backticks deliberately omitted for
the freshness gate — and marketplace sync commit `31a01ba`, its 0.82.0-native
proof doctor-20260719T071752Z-6392f1 (2026-07-19Z; `overall` `pass`, three
execute proofs both directions, the then-new `session_capture` section `off`)
likewise taken against the released binary — and in turn the 0.81.0
**ADR-0046 S8 machine-bootstrap stack** loop — feature commits S8a1 #576
`267cd33`, S8a2 `5af386e`, S8a4 `29bb5b1`, S8a5 #581 `8712eb9`, S8b #582
`960c8bc`; release PR #577 cut tag plugin-runtime-v0.81.0 — backticks
deliberately omitted for the freshness gate — and marketplace sync commit
`769b527`, with the 0.81.0-native proof doctor-20260718T080955Z-6eba4e
(2026-07-18Z; `overall` `pass`, three execute proofs both directions) taken
against that released binary — with the S8c released-package
acceptance additionally exercising the then-installed 0.81.0 plugin from a consumer repo
(exit-30 `no-active-run` semantics, the `plan --bundle base` → `abandon`
lifecycle `bootstrap-20260718T081054Z-9be0cf`, a full installed settings probe
run planning zero source-tree catalog remediations, and a consumer-root
deep-peer-smoke selecting the installed companions from both host caches). The release changed no
hook-bearing plugin, but experience parity deliberately reads `partial` (`91%`;
manual follow-up `codex-hook-review`): the S8a4-hardened currency evaluation
now finds the pre-repair four-plugin attestation
`settings-20260713T234950Z-f08600` `stale` (`bound_versions.codex=null`,
`currency_reason=codex_cli_version_changed`) instead of silently trusting it —
the fail-closed half of contract §11.2 #24 observed live (currency binds the
Codex CLI + hook-bearing plugin versions; the upgrade-invalidation half is
unit-pinned in S8a2) — and a
fresh `/hooks` review plus `runtime:settings --attest-codex-hook-review`
restores `ready`. Its other honest caveat is `host_parity_baseline` `stale` —
the recorded baseline is 2026-07-14 Claude Code `2.1.208` while the observed
CLI is `2.1.215` (Claude patch-level drift), tracked to a baseline-refresh
follow-up slice per the 0.77.2 / attention-0.4.1 precedents and not pretended
current. Before the 0.81.0 loop sat the 0.80.1 S1 permission-advisor
defect-class loop — feature PR #573 squash `89c16ad`; release PR #574 squash
`6d82617`, tag plugin-runtime-v0.80.1 — backticks deliberately omitted for the
freshness gate — marketplace sync `160b3d8`; its 0.80.1-native proof
doctor-20260714T235550Z-60336c read `overall` `pass` with experience parity
`ready` `100%` 8/8 and zero manual follow-ups — and the
preceding 0.80.0 loop, the **S9 completion-output-contract** slice — feature PR
#558 (rebase-merged `00dbc80`/`85bbd3d`/`4c8e59f`) added the runtime-owned
`completion-output-contract.md` (flag minimum-content floors + the
ADR-0043-delegated per-persona completion-state mapping rule), per-field
completion provenance with the visible ` [generic fallback]` marker, the
sanitized workflow-checkpoint footer line, and the engineer/orchestrator sidecar
gate-naming floor; release PR #559 cut tag plugin-runtime-v0.80.0 (backticks
deliberately omitted for the freshness gate; with plugin-engineer-v0.21.0 /
plugin-orchestrator-v0.13.0) and marketplace sync commit `ddb43d4`, and the
0.80.0-native proof `doctor-20260713T025136Z-7758d3` (2026-07-13Z; `overall`
`pass`, `host_parity_baseline` `current`, three execute proofs passed both
directions, experience parity deliberately `partial` `91%` pending the
post-upgrade four-plugin `/hooks` re-attestation for engineer 0.21.0 /
orchestrator 0.13.0) was taken against that released binary. The same-day
post-attestation record `doctor-20260713T030956Z-20dcc3` (fresh attestation
`settings-20260713T030937Z-f50815` at the upgraded versions) closed that loop's
only manual follow-up — `ready` `100%` 8/8, `overall` `pass`, all three execute
proofs re-passed both directions. The preceding 0.79.0 loop was the ADR-0043 S2
**four-persona workflow-projection seam** slice — feature PR #555
extended `VALID_WORKFLOW_KINDS` and the completion-footer projection to
founder/designer with per-persona footer command localization and the
whitespace-padded-kind malformed guard; release PR #556 cut tag
plugin-runtime-v0.79.0 (backticks deliberately omitted for the freshness
gate) with marketplace sync commit `8ca4651`, and the 0.79.0-native proof
`doctor-20260712T080638Z-005af5` (2026-07-12Z; parity `ready` `100%` 8/8,
`overall` `pass`, `host_parity_baseline` `current`, three execute proofs
passed both directions) was taken against that released binary. The
preceding 0.78.1 loop was an
ADR-0024 **host-truth slice** — fix PR #543 folded attention into doctor's expected
Codex hook sets after host observation disproved the claude-adapter-only
exclusion premise (Codex 0.144.1 default-file discovery is command-shape-blind:
it loaded attention's hooks/hooks.json and the operator trusted
`stop`/`subagent_stop`), gated expected hook-state entries on the observed
materialization vocabulary (`unmapped`, never permanently-`missing`, for
Claude's `Notification`), fixed the cache-only versioned-path matching
blocker and attestation version currency surfaced by its Codex Refine-verify
pass, and made command-portability warnings gate `lifecycle_hook_continuity`
so a fresh attestation cannot launder Claude-shaped hook commands into a 100%
parity score. Release PR #544 cut tag plugin-runtime-v0.78.1 (backticks
deliberately omitted so the freshness gate collects only the current tag) with
marketplace sync commit `e8d8fdc` (release-please Action follow-up), and the
0.78.1-native proof `doctor-20260710T153802Z-276226` (recorded
2026-07-10Z under Claude Code `2.1.206` / Codex `0.144.1`; three execute
proofs passed both directions; hook state `14/14` `enabled_trusted` with
`unexpected=0`/`unmapped=1`; `/hooks` re-attestation
`settings-20260710T153728Z-5796b6` covering all five hook-bearing plugins;
`host_parity_baseline` `current`; experience parity **deliberately** `partial`
`95%` 7/8 — `lifecycle_hook_continuity` held `partial` by the new
`command-warnings=attention` gate — the posture is resolved (2026-07-11
relocation) and the gate cleared once the relocated package was released,
installed, and proven, per `plugins/runtime/docs/follow-ups.md`) was that
loop's record of reference. The prior 0.78.0 loop shipped the owner-ratified probe-free
`runtime:settings --skip-host-cli-probes` mode (feature PR #540, contract
#539, tag plugin-runtime-v0.78.0 — backticks deliberately omitted so the
freshness gate collects only the current tag — sync `51db10f`); its `ready` `100%` proof
`doctor-20260710T135955Z-d752f5` was measured under the pre-#543 criterion and
its honest inventory-lag note became fix #543.

The preceding 0.77.1 loop was the ADR-0042 **designer persona acceptance** — feat
PR #528 taught doctor/settings to recognize designer in the plugin inventory,
alongside PR #529 (ADR-0042 `Accepted`, `plugin-designer-v0.2.0`), release PR #521,
release tag plugin-runtime-v0.77.1, marketplace sync commit `7dce7fe`. The
0.77.0-native proof `doctor-20260709T131625Z-33c54d` read `partial` `91%` on the
hook-state defect above; fix PR #530 and release PR #531 cut the 0.77.1 tag
(marketplace sync commit `73b2a75`), restoring `ready` `100%`.
Earlier release/install proof loops (the 0.75.0 ADR-0041 §3a opt-in
closed-vocabulary headline egress loop — release PR #512 + acceptance gate
PR #514, release tag plugin-runtime-v0.75.0, proof
`doctor-20260707T071802Z-482de4`, with real owner Telegram delivery proven
byte-for-byte `approval · complete · @mba · …` per
`docs/release-proofs/adr0041-headline-egress.md`; the 0.74.0 ADR-0041 §2d E1 egress transport fix loop, the 0.73.0 ADR-0041 E1 cross-machine notification egress loop, the 0.72.0 ADR-0040 §3/§5 loop, the 0.71.0 emitter/dashboard slices, the 0.70.1
ADR-0039 follow-up #469, and the 0.60.0 cutover-checklist loop PR #342) are superseded; subsequent
dogfood records are intentionally tracked in runtime cutover artifacts rather than
hand-maintained here.

## Requirement Scorecard

| Req | User requirement | Current repo evidence | Status | Cutover gate |
|---|---|---|---|---|
| R1 | agentic-plugins must be superior-compatible with omcc/omcc-dev, not a simple baseline copy. | ADR-0007 mandates redesign-over-port; ADR-0010 maps omcc experience into a 4-layer/6-verb model; ADR-0019 and ADR-0020 replace omcc-dev single and multi-deliverable workflow shapes with engineer plus orchestrator. `omcc-legacy-pattern-map.md` inventories D1-D20 legacy surfaces and maps each to an agentic-plugins improvement, retained behavior, or explicit rejection/deferment rationale. | satisfied | Every retained omcc-dev behavior has an agentic-plugins equivalent, improvement, or documented rejection with rationale. |
| R2 | Overbuilt or unnecessary parts should be improved or removed. | `plugins/research` was retired and cited-brief moved into `engineer:investigate`; `plugins/designer` was deferred until real demand arrived, then shipped as the third L3 persona (ADR-0042); hidden automatic ensembles and raw peer output are rejected. `runtime:cutover` reads `omcc-legacy-pattern-map.md` and blocks readiness when required D1-D20 rows are missing, statuses are invalid, or a rejected/deferred row is still an active daily dependency. | satisfied | A cutover audit lists all legacy omcc patterns as retained, improved, rejected, or deferred; no active daily workflow depends on a rejected/deferred pattern. |
| R3 | Switching development tools must work in both directions: Claude Code to Codex and Codex to Claude. | Cross-host tests cover resume and stop-archive behavior for engineer/orchestrator; companions exist in both directions. Installed `plugin-runtime` `0.83.0` carries the native `runtime:doctor --permission-proof --execute-permission-proof --deep-peer-smoke --execute-deep-peer-smoke --workflow-continuation-proof --execute-workflow-continuation-proof` proof re-recorded under the 0.83.0 install on 2026-07-20Z (doctor-20260720T105456Z-e1f9a9, Claude Code `2.1.215` / Codex `0.144.6`, runtime installed 0.83.0 and attention 0.7.0 on both hosts with engineer 0.21.0 / orchestrator 0.13.0; the ADR-0045 S9 loop — feature PR #602 rebase pair `5b840bd`+`9460682` (S9-gate re-validation recorded ahead of the SessionStart registration), release tag `plugin-attention-v0.7.0` from release PR #603 squash `0f8d84f`, marketplace sync `b0db587`; `overall` `pass` with zero warnings; all three execute proofs executed and passed in both directions; `host_parity_baseline` **current** — the prior record's baseline-stale follow-up closed in-slice by the 2026-07-20 refresh (compat `compat-20260720T104815Z-9323ec` with content-backed notes for both drifted hosts, re-check `drift=none` at `compat-20260720T105414Z-87af5e`); doctor `entry_brief` and `session_capture` readiness both read `off`, the shipped defaults; experience parity deliberately `partial` `91%` with manual follow-up `codex-hook-review` — the pre-S8a4 four-plugin attestation `settings-20260713T234950Z-f08600` stays `stale` (`currency_reason=codex_cli_version_changed`), and attention 0.7.0 changed only the Claude hook surface while keeping zero Codex hook surface, so the trusted hook entries are unchanged and a fresh `/hooks` review plus `runtime:settings --attest-codex-hook-review` restores `ready`). This supersedes the same-day 0.83.0-native record re-recorded on 2026-07-20Z (doctor-20260720T052332Z-a0d677, Claude Code `2.1.215` / Codex `0.144.1`, runtime installed 0.83.0 on both hosts — claude=installed/0.83.0, codex=installed/0.83.0 — with engineer 0.21.0 / orchestrator 0.13.0; release tag `plugin-runtime-v0.83.0` alongside `plugin-attention-v0.6.0` (ADR-0044 S5), marketplace sync `360a71f`; hook state `12/12` expected `enabled_trusted`, `unexpected_agentic_entries=2` retained pre-relocation attention rows, display-only; all three execute proofs executed and passed in both directions; the new doctor `entry_brief` readiness section reads `off`, the shipped default, alongside the `session_capture` `off` precedent; experience parity deliberately `partial` `91%` with manual follow-up `codex-hook-review` — the S8a4-hardened currency evaluation still finds the pre-repair four-plugin attestation `settings-20260713T234950Z-f08600` `stale` (`bound_versions.codex=null`, `currency_reason=codex_cli_version_changed`) instead of silently trusting it; neither released package changed a Codex hook-bearing plugin — runtime ships no hooks, attention exposes zero Codex hook surface — so the trusted hook entries are unchanged, and a fresh `/hooks` review plus `runtime:settings --attest-codex-hook-review` restores `ready`; the other honest caveat is `host_parity_baseline` `stale` — the recorded baseline is 2026-07-14 Claude Code `2.1.208` while the observed CLI is `2.1.215`, Claude patch-level drift tracked to a baseline-refresh follow-up slice per the 0.77.2 / attention-0.4.1 precedents, not pretended current). This supersedes the 0.82.0-native ADR-0044 session-capture exit-side record re-recorded under the 0.82.0 install on 2026-07-19Z (doctor-20260719T071752Z-6392f1, Claude Code 2.1.215 / Codex 0.144.1, runtime installed 0.82.0 on both hosts with engineer 0.21.0 / orchestrator 0.13.0; release tag plugin-runtime-v0.82.0 — backticks deliberately omitted for the freshness gate — marketplace sync `31a01ba`; hook state 12/12 expected enabled_trusted; all three execute proofs passed both directions; parity partial 91% with the codex-hook-review follow-up — the fail-closed half of contract §11.2 #24 observed live (currency binds the Codex CLI + hook-bearing plugin versions); the then-new session_capture section read off), and in turn the 0.81.0-native ADR-0046 S8 machine-bootstrap record re-recorded under the 0.81.0 install on 2026-07-18Z (doctor-20260718T080955Z-6eba4e, Claude Code 2.1.214 / Codex 0.144.1, runtime installed 0.81.0 on both hosts with engineer 0.21.0 / orchestrator 0.13.0; release tag plugin-runtime-v0.81.0 — backticks deliberately omitted for the freshness gate — marketplace sync `769b527`; hook state 12/12 expected enabled_trusted; all three execute proofs passed both directions; parity partial 6/8 with the codex-hook-review follow-up), and before it the 0.80.1-native S1 permission-advisor defect-class record re-recorded under the 0.80.1 install on 2026-07-14Z (doctor-20260714T235550Z-60336c, Claude Code 2.1.209 / Codex 0.144.1; release tag plugin-runtime-v0.80.1 — backticks deliberately omitted for the freshness gate — marketplace sync `160b3d8`; experience parity ready 100% 8/8 with zero manual follow-ups, all three execute proofs passed both directions), and before it the 0.80.0-native S9 completion-output-contract record re-recorded under the 0.80.0 install on 2026-07-13Z (`doctor-20260713T025136Z-7758d3`, Claude Code `2.1.207` / Codex `0.144.1`, runtime installed 0.80.0 on both hosts with engineer 0.21.0 / orchestrator 0.13.0; release tag plugin-runtime-v0.80.0 — backticks deliberately omitted for the freshness gate — marketplace sync `ddb43d4`; hook state `12/12` expected `enabled_trusted`, `unexpected_agentic_entries=2` retained pre-relocation attention rows, display-only; experience parity deliberately `partial` `91%` at that initial post-install measurement — the engineer/orchestrator hook-bearing upgrades version-invalidated the four-plugin `/hooks` attestation `settings-20260712T015100Z-312fbb`; the same-day fresh attestation `settings-20260713T030937Z-f50815` and post-attestation record `doctor-20260713T030956Z-20dcc3` restored `ready` `100%` 8/8 with all three execute proofs re-passed both directions; `host_parity_baseline` `current` against the 2026-07-11 baseline). The superseded 0.79.0-native 2026-07-12Z four-persona-seam record (doctor-20260712T080638Z-005af5, release tag plugin-runtime-v0.79.0, sync 8ca4651 — backticks deliberately omitted for the freshness gate) read `ready` `100%` 8/8 with that attestation then current, since runtime ships no hooks and the 0.79.0 upgrade left the hook-bearing set unchanged. The superseded 2026-07-11Z attention-relocation record `doctor-20260711T045954Z-731e34` (then-installed runtime 0.78.1) also read `ready` `100%` 8/8, with an honest baseline-stale caveat the same-day #550 refresh closed; before it the 0.78.1-native 2026-07-10Z record `doctor-20260710T153802Z-276226` (Claude Code `2.1.206`, tag plugin-runtime-v0.78.1 — backticks deliberately omitted for the freshness gate; hook state `14/14` `enabled_trusted`, `unexpected=0`, `unmapped=1`; five-plugin re-attestation `settings-20260710T153728Z-5796b6`) read experience parity **deliberately** `partial` `95%` 7/8 — that release's command-portability gate held `lifecycle_hook_continuity` `partial` with `command-warnings=attention` until the relocation landed, while the bidirectional proof surfaces themselves all passed. The superseded 0.78.0 record `doctor-20260710T135955Z-d752f5` read `ready` `100%` 8/8 under the pre-#543 criterion; before it, the 0.77.2 record `doctor-20260710T044745Z-1a789e` (same host versions, parity `ready` `100%`) honestly read `stale` on baseline freshness at measurement time; the same-day baseline-refresh slice closed it. The intermediate 0.77.0 record `doctor-20260709T131625Z-33c54d` read `partial` `91%` because doctor mis-read the newly-trusted designer hooks as disabled; the classifier fix released as 0.77.1 restored `ready` `100%`. Both `claude -> codex` and `codex -> claude` passed the permission proof, deep peer smoke, and engineer workflow continuation proof through `state.mjs create`, `dispatch-peer.mjs`, `pending_ensemble`, and `ensemble_results` in an ephemeral temp repo. | satisfied | Keep the explicit installed-runtime proof in the release/install continuity loop whenever the peer path changes. |
| R4 | Claude Code and Codex user experience must be equivalent where possible; non-portable host-specific features must not become hard dependencies. | Architecture documents host-specific adapter boundaries; runtime baseline documents command/hook/subagent differences; Codex macro/meta skill mirrors exist. The native `runtime:doctor` execute proofs re-recorded under the 0.77.1 install on 2026-07-09 (`doctor-20260709T141930Z-515ebf`, Claude Code `2.1.205` / Codex `0.143.0`, runtime `0.77.1` on both hosts) confirmed bidirectional peer execution and engineer workflow continuation passed both directions, and `runtime:settings` reports source/cache version parity with zero plugin-management config writes planned. Installing designer `0.2.0` grew the hook-bearing set to `designer@0.2.0`/`engineer@0.20.0`/`orchestrator@0.12.0`/`founder@0.3.0`, invalidating the 2026-07-04 attestation `settings-20260704T170801Z-b66656` and requiring a fresh Codex `/hooks` review — which in turn exposed the doctor hook-state defect fixed in 0.77.1 (an absent `enabled` key means enabled, not disabled), after which `~/.codex/config.toml` hook-state reads `12/12` `enabled_trusted` (`untrusted=0`/`disabled=0`/`missing=0`) and the attestation `settings-20260709T141913Z-8b7122` covers all four bundled plugins; At that 0.77.1-era measurement `attention@0.4.0` was still read as a deliberately Claude-hook-only plugin (`claude_adapter_only`, excluded from the Codex sets) and `image` ships no Codex hooks manifest, so observed experience parity then read `ready` (score `100%`, 8/8 satisfied) per this row's gate — a record superseded by the #543 host-truth fold (its 0.78.1 proof read **deliberately** `partial` `95%` with `command-warnings=attention`) and restated by the 2026-07-11 attention relocation install proof `doctor-20260711T045954Z-731e34`: attention `0.4.1` supplies zero Codex hook surface (machine-proven `not_packaged` on the installed cache), the four-plugin attestation `settings-20260711T045915Z-5ca22a` reads current, and observed experience parity is back to `ready` (`100%`, 8/8) per this row's gate — the honest `host_parity_baseline` `stale` caveat (Claude Code `2.1.207` patch drift) was closed by the same-day #550 baseline refresh, and the 0.79.0-native 2026-07-12Z four-persona-seam record (`doctor-20260712T080638Z-005af5`; attestation `settings-20260712T015100Z-312fbb` still current, since runtime ships no hooks and the hook-bearing set is unchanged) re-confirms `ready` (`100%`, 8/8) with the baseline `current` — while the 0.80.0-native 2026-07-13Z S9 completion-output-contract record (`doctor-20260713T025136Z-7758d3`) reads observed parity **deliberately `partial` `91%`** per this row's own gate: the engineer `0.21.0` / orchestrator `0.13.0` hook-bearing upgrades version-invalidated that attestation, and parity was not claimed `ready` until the post-attestation evidence landed (hook trust entries themselves read `12/12` `enabled_trusted`; no hook file changed in this release). The operator's same-day `/hooks` confirmation produced the fresh four-plugin attestation `settings-20260713T030937Z-f50815` (designer@0.2.1 / engineer@0.21.0 / founder@0.3.1 / orchestrator@0.13.0), and the post-attestation record `doctor-20260713T030956Z-20dcc3` restores observed parity to `ready` (`100%`, 8/8, zero manual follow-ups) per this row's gate, with all three execute proofs re-passed both directions. | satisfied | Refresh the active-session `/hooks` review/trust attestation after hook-bearing plugin upgrades or hook packaging changes; do not claim observed parity `ready` until the post-attestation doctor/cutover evidence is recorded. |
| R5 | Optimize for best results, not token minimization. | Engineer now publishes a tested quality-first default contract: phase-boundary ensembles are the default peer breadth, model/effort defaults stay host-native or `runtime:settings` configured without token-saving downshift, and review depth follows the workflow phase through `parallel-review` and re-review after refine. `runtime:consensus` also records `best-results-over-token-minimization` in manifest, prompt artifacts, and text output with all-requested-peer breadth by default unless the operator constrains it. `tests/engineer/test-start-command.mjs` and `tests/runtime/test-consensus.mjs` cover these fields. | satisfied | Keep quality-first defaults explicit; budget, latency, model, effort, or peer limits must be user constraints with stated quality tradeoffs. |
| R6 | Context engineering should improve output quality; decisions requested from the user must be concrete, comparative, and evidence-based. | Runtime context artifacts, footer guidance, engineer/orchestrator presentation protocols, and the engineer entry-routing contract exist. `tests/engineer/test-start-command.mjs` verifies the decision prompt fields across `/engineer:start`, `$engineer:start`, and the shared contract. | satisfied | Keep every user decision prompt on the same options/tradeoffs/risks/recommendation/confidence/evidence/default-next-command shape. |
| R7a | Work must prioritize standards, root cause, quality, and recommended practice over short-term fixes. | ADRs enforce hexagonal architecture, adapter boundaries, explicit storage contracts, and no hidden permission/session mutation. The engineer entry-routing contract now requires a standards/root-cause quality gate before quick implementation/refinement paths, and refine already blocks bug fixes until root cause is confirmed. | satisfied | Keep implementation/refinement flows routed back to investigate/decide/orchestrator when the standards/root-cause/evidence gate cannot be met. |
| R7b | Completion must guide the next action, or confidently say there is nothing left. | Runtime footer is pointer-only and exposes context/consensus/cancellation/PR readiness guidance, cutover record guidance, and a conservative completion-state enum with state-derived next actions. Engineer/orchestrator completion runbooks require that state in footer output. | satisfied | Keep future completion surfaces on the same state contract; do not infer `closed` without explicit PR, release, cleanup, and planned-follow-up evidence. |
| R8 | Domain entry should start with engineer when appropriate, and propose orchestrator/worktree/parallelization when useful. | ADR-0020 defines `/engineer:start` vs `/orchestrator:plan` entry routing; runtime has read-only worktree planning; `/engineer:start` and `$engineer:start` now present a tested entry routing recommendation covering engineer, orchestrator, runtime worktree, runtime readiness/handoff, and single-verb routes. | satisfied | Keep new domain entrypoints on the same routing recommendation contract rather than adding implicit auto-routing. |
| R9 | Track Claude Code and Codex CLI version history; when latest host versions differ from remembered versions, use release notes to plan compatibility updates. | Runtime host parity baselines record observed CLI versions and drift policy. `runtime:compat` records snapshots, compares remembered baseline versions, ingests explicit release-note artifacts, requires content-backed notes to mention the changed host and observed version before detailed planning, and emits update plans; `runtime:doctor` reads latest compat metadata into the handoff artifact criterion. Claude Code `2.1.142`/`2.1.143` release notes were ingested as explicit content-backed notes and the host parity baseline was refreshed to Claude Code `2.1.143`. `runtime:cutover` includes latest compat freshness and installed-version evidence in its read-only scorecard audit. `tests/runtime/test-compat.mjs` verifies that a note for the wrong host/version does not clear a drift gap. | satisfied | Keep content-backed release-note coverage or an accepted baseline refresh mandatory whenever host versions drift. |
| R10 | Claude and Codex should be used as complementary perspectives; same-issue opinion collection is valuable. | Companions and runtime consensus provide cross-host peer collection. `runtime:consensus` plans explicit companion-backed lanes and manual/subagent lanes, writes per-peer prompt/output pointers, records peer roles such as `claude_companion_peer` and `security_manual_subagent_peer`, and provides `status --latest-open` so terminal consensus artifacts do not hide the next open run; `tests/runtime/test-consensus.mjs` covers those manifest, prompt, status, selection, and text-output fields. | satisfied | Keep consensus lanes role-explicit, artifact-pointer-only, and bounded by explicit peer rosters rather than hidden peer caps. |
| R11 | When Claude and Codex conflict, loop opinions back until there is a well-converged, non-compromise synthesis. | `runtime:consensus` records convergence state, contradiction summaries, bounded next-round availability, and contradiction-aware rebuttal prompts with issue framing, opposing views, and evidence standards. When bounded rebuttal still ends unresolved, `runtime:consensus decide` records the owner decision as pointer-only artifacts instead of forcing false compromise or opening an unbounded loop. Automatic unbounded loops are forbidden. | satisfied | Keep future consensus surfaces on the same no-false-compromise taxonomy and require explicit user approval for any expansion beyond the max-round cap. |

## Required Design Extensions

### 1. Runtime Compatibility Surface

The first runtime-owned surface is `runtime:compat`, with these commands:

- `snapshot`: record local `claude --version`, `codex --version`, selected
  help surfaces, plugin versions, and baseline source hashes.
- `check`: compare the latest snapshot with the stored baseline and classify
  drift as `none`, `host-version-changed`, `plugin-surface-changed`,
  `docs-baseline-stale`, or `release-notes-required`.
- `ingest-release-notes`: attach release notes from explicit files or URLs.
  Network fetch, if added, must be explicit and must not be the default.
- `plan`: produce a compatibility update plan that maps release-note changes to
  affected surfaces: companions, hooks, skills, subagents, plugin management,
  model/effort resolution, sandbox/permissions, and docs/tests.

Artifacts should live under:

```text
.agentic-plugins/runs/compat/<run-id>/
  snapshot.json
  release-notes/
  gap-analysis.json
  update-plan.md
  latest.json
```

Current and remaining acceptance evidence:

- Unit tests for snapshot schema, drift classification, release-note file
  ingestion, URL pointer recording, and update-plan generation.
- Unit tests and live doctor output for latest compat snapshot/gap metadata,
  release-note-required blocking, and raw release-note body non-disclosure.
- A docs update to `plugins/runtime/docs/host-parity-baseline.md` whenever
  `claude --version`, `codex --version`, or documented host behavior changes.
- `runtime:doctor` reads the latest compat status and reports stale baselines;
  the Claude Code `2.1.143` baseline refresh produces a `current`
  `runtime:compat check` result from the refreshed checkout.

### 2. Completion State Contract

Extend the runtime footer from advisory text to an explicit state contract.
The footer must still be pointer-only and must not mutate host session context.

States:

- `review-needed`: local changes exist or peer/review results need owner review.
- `publish-needed`: commit/PR/release work is ready but not complete.
- `cleanup-needed`: branch/worktree/plugin/cache cleanup is the next action.
- `next-work-available`: requested work is complete, but planned follow-up work
  remains and should be offered with a concrete entry command.
- `blocked`: operator action, auth, permission, sandbox, or external review is
  required.
- `closed`: no repo, PR, release, cleanup, or planned follow-up work remains.

Acceptance evidence:

- Footer helper emits the state in text and JSON.
- Engineer/orchestrator completion commands include the state and next command
  or "no further action" guidance.
- Tests verify that raw peer/consensus output is never printed in the footer.

### 3. Consensus Convergence Contract

Extend `runtime:consensus` with a convergence taxonomy:

- `aligned`: peers agree on the recommendation and risk framing.
- `complementary`: peers emphasize different dimensions without contradiction.
- `contradiction`: peers recommend mutually exclusive actions or incompatible
  facts.
- `insufficient-evidence`: peers disagree because evidence is missing.
- `owner-decision-required`: disagreement remains after bounded rebuttal rounds;
  use `runtime:consensus decide` to record the owner decision as durable,
  pointer-only evidence.
- `non-consensus`: irreducible disagreement is preserved with evidence and no
  false compromise.

Rules:

- `next-round` is required for `contradiction` unless the user explicitly stops.
- Rebuttal prompts must include the opposing view, synthesized issue framing,
  and requested evidence standard.
- Automatic unbounded loops stay forbidden. Default max rounds should remain
  bounded; further rounds require explicit user approval.
- A synthesis must not average incompatible recommendations. It should either
  converge on evidence, ask the owner to choose, or record non-consensus.

Acceptance evidence:

- `consensus.json` records convergence state and contradiction summaries.
- `next-round` prompts are generated only from durable disagreements.
- Tests cover contradiction, complementary disagreement, empty disagreement,
  owner-decision-required states, and owner-decision artifact recording.

### 4. Cutover Audit Command or Script

Add a lightweight verifier after the contracts above land. It may be a runtime
command (`runtime:doctor --cutover-scorecard`) or a repo script.

It should check:

- ADR-0012 condition statuses.
- Host parity baseline freshness.
- Current installed plugin versions vs release-please manifest versions.
- Latest compat snapshot freshness.
- Latest consensus and context artifact state.
- One-week omcc-dev-free dogfood evidence from recorded runtime cutover
  artifacts.
- Footer state from the latest explicit cutover evidence or current completion
  surface.
- Whether any daily workflow is still being completed through omcc-dev.

The verifier must not declare cutover by itself. It can only report
`cutover-ready-candidate`; the user declares cutover per ADR-0007.

## Recommended PR Sequence

Landed slices:

1. **PR A: scorecard + compatibility ADR/design**
   - Land this scorecard.
   - Decide whether the surface is named `runtime:compat` or folded into
     `runtime:doctor`.
   - Define artifact schemas before implementation.

2. **PR B: runtime compatibility snapshot/check**
   - Implement version snapshot and drift classification.
   - Wire stale compat status into `runtime:doctor`.

3. **PR C: release-note gap planner**
   - Implement explicit release-note ingestion.
   - Generate compatibility update plans.

R9 maintenance follow-up:

- Future compatibility slices may add automated baseline freshness warnings and
  deeper source-specific release-note taxonomies, but R9's cutover gate is
  satisfied by changed-host/version release-note coverage plus the accepted
  current host baseline.

4. **PR D: completion-state footer**
   - Add footer state enum and tests.
   - Update engineer/orchestrator completion surfaces.

5. **PR E: consensus convergence taxonomy** (landed)
   - Add convergence state to `runtime:consensus`.
   - Add contradiction-aware next-round prompts.

6. **PR F: cutover audit** (landed)
   - Add the non-mutating cutover readiness report.
   - Keep `docs/DEVELOPMENT.md` ADR-0012 rows unchanged until real evidence exists.

Remaining follow-up:

- Update `docs/DEVELOPMENT.md` ADR-0012 rows only when real evidence exists.

## Open Decisions

1. Should the host-version tool be a new `runtime:compat` command, or a
   `runtime:doctor` sub-mode?
   - Recommendation: new `runtime:compat`. Version/release-note analysis has
     durable artifacts and planning behavior; doctor should consume its status,
     not own all of it.

2. Should release notes be fetched automatically?
   - Recommendation: no by default. Use explicit files/URLs first; URL content
     fetch is allowed only when the operator adds `--fetch-release-notes-url`.

3. What is the bounded consensus default?
   - Recommendation: default `max_rounds=2`, hard cap `3`, with explicit owner
     approval for any further round.

4. What counts as same user experience across Claude and Codex?
   - Recommendation: equivalent outcome, state, recovery path, and evidence,
     not identical invocation syntax.

5. When can omcc be removed?
   - Recommendation: only after ADR-0012 conditions 1-4 are satisfied, this
     scorecard has no `partial` or `missing` gate, at least one week of
     sustained daily use is recorded, and the user explicitly declares cutover.
