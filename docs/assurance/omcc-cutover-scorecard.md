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

Local dry-run evidence: the 2026-08-08Z `runtime:settings` run
(`settings-20260808T065145Z-c8409f`) reported all agentic-plugins surfaces
available with source/cache versions matching the manifest **as it then stood**
(`plugin-runtime` 0.89.0), and zero plugin-management config writes planned
against the state installed at that time. It has not been re-run since, so it is
historical rather than current evidence; the current manifest is 0.91.1. The
newest hook-review attestation is `settings-20260816T233407Z-4f23d9`, recorded
on 2026-08-16Z after an operator completed the Codex `/hooks` review that the
0.90.3 release had staled by bumping all four hook-bearing persona packages; it
binds designer@0.3.4 / engineer@0.21.5 / founder@0.4.4 / orchestrator@0.13.3
against Codex `0.147.0`, and the 0.91.1 proof reports it current with
`manual-followups=0`. Because it was recorded *after* the 0.90.3 proof was
taken, the 0.90.3 record below describes that follow-up as still open — a
reporting lag rather than a live gap, closed here. The current installed
`plugin-runtime` `0.91.1` state is claude=installed/0.91.1,
codex=installed/0.91.1, per the 2026-08-18Z
`doctor-20260818T115259Z-e7c325` read; the superseded 0.90.3 state was read by
doctor-20260816T144610Z-154506 on 2026-08-16Z, the 0.90.2 state before it by
doctor-20260814T083045Z-bc4fc6 on 2026-08-14Z, the 0.90.1 state before it by
doctor-20260812T022356Z-252fb9 on 2026-08-12Z, the 0.90.0 state before it by
doctor-20260810T135637Z-d49983 on 2026-08-10Z, and the 0.88.1 state before that
by doctor-20260803T091403Z-7f2850. (An earlier revision of this paragraph
attributed 0.89.0 `claude plugin list` / `codex plugin list` readings to a
0.90.0 installed state; those readings belonged to the settings run's own
2026-08-08 date, before that upgrade, and the mismatch is corrected here rather
than restated.)

Current runtime execution evidence is native to the
installed `plugin-runtime` `0.91.1`: permission proof, deep peer smoke, and
workflow continuation proof executed and passed in both directions, recorded
on 2026-08-18Z as
`doctor-20260818T115259Z-e7c325` — the post-release record of the **assurance
plane** loop (ADR-0053 `38e59bb` PR #701 and ADR-0054 `48db4f3` PR #702, six
implementation commits `e8f6d2b` / `79003cc` / `b8ad2b3` / `c535c1a` /
`6651c5c` / `70e0461`, and the adversarial-audit hardening commit `4ee8764`;
release PR [#704](https://github.com/each4all/agentic-plugins/pull/704) squash
`47bc9c9`, tag plugin-runtime-v0.91.0 (backticks deliberately omitted for the
freshness gate), marketplace sync `361952c`, stage-doc
sync `e8a9b44`, then release PR
[#711](https://github.com/each4all/agentic-plugins/pull/711) squash `48f50d2`,
tag `plugin-runtime-v0.91.1`, marketplace sync `024ec42`, stage-doc sync
`f24727b`), with `host_parity` `pass` under Claude Code `2.1.234` / Codex
`0.147.0`. `overall` reads **`warning`** — `hard_failures` is empty, and the one
warning is "latest compatibility check requires release notes"; no hard failures
is not the same claim as `pass`. No install was performed by this
recovery: both hosts already carried 0.91.1, and the evidence is the byte
comparison rather than the version string — both caches hold an identical
124-file package (whole-tree digest
`56f82e713e9649be8d95e98dc975af9ecbb5421c11944e84a6f20f1a4594c29d`), and the
packaged baseline hashes
`3ad3afa1f82d8e3d3441719e7bbcf02a50156b7d049c3cd1a28bc8d08e1adf49` identically
across both caches, the `plugin-runtime-v0.91.1` tag and the repository at
`f24727b`, which is also the value doctor independently records as
`host_parity_baseline.provenance.content_sha256`.

**This is the first recorded proof in which the assurance verdict is visible to
an operator, and it returns a refusal.** (The verdict became reachable in
0.91.0, which carried `70e0461`; 0.91.1 added the adversarial hardening.) `host_parity_baseline` reads `stale` with
`baseline-direction` `ahead` (Claude reached `2.1.234` after the `2.1.233`
baseline was cut; Codex is `exact`), and the separate assurance layer reads
**`unassured`** because no grant names the host pair claude `2.1.234` / codex
`0.147.0`. ADR-0054 rollout R1 (not the scorecard's requirement row R1) ships an
empty grant list by owner decision (2026-08-17), so every host reads `unassured`
and assurance-**dependent** readiness is gated shut — the bidirectional execution
proofs in this same run all pass, so peer execution itself is unaffected. That is the designed
outcome, not a defect: it is the point at which
[ADR-0053](../adr/0053-baseline-exactness-and-compatibility-assurance.md) §Decision 6's
requirement — that the gate's rejection path be observed on a real machine — is
actually met. Assurance is granted by human review of this host pair against
this installed code, never by a version match, an upgrade, or elapsed time, so
the first grant is a separate forward-patch loop; it could not have ridden along
with this recovery even in principle, because the grant lives in the protected
baseline this recovery is forbidden to edit.

Observed experience parity reads **`blocked` `82%`** (106/130; 7 satisfied, 0
partial, 1 not-verified, 1 blocked, zero manual follow-ups), and the number must
not be read as a single trend, because it moved in two directions at once.
Earned weight went **up**, 105/115 to 106/130: the previous record's two
partials were one operator action — a Codex `/hooks` review after all four
hook-bearing packages bumped — and that action was completed on 2026-08-16Z as
`settings-20260816T233407Z-4f23d9`, *after* the 0.90.3 proof was taken. Both
criteria now read satisfied. The percentage nonetheless **fell** because the
denominator grew: `host_compatibility_assurance` is a ninth criterion
introduced by this very release, worth 15, of which an unassured host earns 6.
Three items stay open, and they are **independent** — doctor records a distinct
next step for each, so they must not be chained into one remedy:

1. `runtime_handoff_artifacts` — **blocked**. Doctor's next step is content-backed
   release-note ingestion for `compat-20260818T115200Z-a2cd91`, and nothing more.
   This is the loop's own measurement rather than an inherited fault: the mandated
   host re-measurement took a fresh snapshot, Claude had moved `2.1.233`→`2.1.234`,
   and the run legitimately reports `release_notes_required`.
2. `host_parity_baseline` — **stale**/`ahead`. Refreshing the packaged baseline is
   protected-asset work; editing it here would start a new release obligation and
   manufacture another release-and-recovery lap.
3. `host_compatibility_assurance` — **unassured**. Clearing it needs human review
   plus a released grant.

Only items 2 and 3 are forward-release work. On the baseline: this is a stale
landing, but **not** a consecutive run of them — the immediately preceding 0.90.3
proof recorded the baseline `current`. It is consistent with
[ADR-0052](../adr/0052-release-obligation-enforcement.md)'s modelled result that a
loop of this shape lands current on 3 of 12 **publishes** (the denominator is
publish intervals, not loops).

The superseded 0.90.3 loop refreshed only Claude host-
native — Codex already carried 0.90.2 when the loop began, and on Claude
`claude plugin marketplace update agentic-plugins` was what pulled the release
into the cache, after which `claude plugin update runtime@agentic-plugins`
reported it already current. The installed state is doctor-observed, so this
upgrade too left no `runtime:settings --execute-plugin-
management` executor artifact of its own, the newest being the 2026-07-14
`settings-20260714T021101Z-94f0f6`. That loop's runtime execution evidence was
native to the installed `plugin-runtime` 0.90.3: permission proof, deep peer
smoke, and workflow continuation proof executed and passed in both directions,
recorded on 2026-08-16Z as `doctor-20260816T144610Z-154506` — the post-release
record of the **Claude 2.1.233 host-parity baseline refresh and
withdrawn-todo-tool adaptation** loop (implementation PR #698, rebase-merged as
five package-scoped commits `2eea2b3` runtime / `0cb184e` designer /
`feeeafb` engineer / `e563921` founder / `6abe4be` orchestrator; release PR
#699 squash `38fedaf`; tags plugin-runtime-v0.90.3,
`plugin-designer-v0.3.4`, `plugin-engineer-v0.21.5`, `plugin-founder-v0.4.4`,
`plugin-orchestrator-v0.13.3`; marketplace sync `e46256b`, stage-doc sync
`5ee8024`), with `host_parity` `pass` and `overall.hard_failures` empty under
Claude Code `2.1.233` / Codex `0.147.0`. **`host_parity_baseline` reads
`current`** — the inherited staleness the previous record carried is closed,
and this is the first loop in three to land on the version it observed. That
was not luck alone: the host held at `2.1.233` for the ≈42.8h between the
observation snapshot `compat-20260816T092409Z-9297c1` and the post-install
verification snapshot `compat-20260816T144459Z-360191` (`status` `current`,
`drift` `none`), a quiet interval longer than any inter-patch gap inside the
`2.1.228`–`2.1.233` window this loop refreshed across (20.8h, 25.7h, 13.0h,
13.1h, 21.3h by npm publish time). Observed experience parity is **`partial`
`91%`** (6 satisfied, 2 partial, zero blocked). The drop from the previous
record's `95%` is not a regression and not a new class of gap: both partials —
`plugin_management_followups` and `lifecycle_hook_continuity` — emit the same
next step, because all four hook-bearing persona packages bumped in this release
and `~/.codex/config.toml` `[hooks.state]` is now empty, so Codex will present
the bundled hooks as new. Closing them is an interactive Codex `/hooks` review
and trust followed by `runtime:settings --attest-codex-hook-review`; that is an
operator step under ADR-0035 §6 and was deliberately not attested here on the
operator's behalf, since attesting a review nobody performed would be
manufacturing the evidence this scorecard exists to record. The byte comparison
is clean: both host caches hold an identical 0.90.3 package (117 files,
whole-tree digest
`7cfbc4965451f2bdf11d246e67d46fbcacac78f64ebd9017dbaf457dee6523a8`) and the
packaged baseline hashes
`bdb6eeb7e5b343641905de877ac562057a7841f736c6cafd0ffa65f56fbc3285` in the
Claude cache, the Codex cache and the repository alike — the same value doctor
records as `host_parity_baseline.provenance.content_sha256`, taken over the
file's bytes per the ADR-0051 §Decision 5 extension, with `provenance.status`
`resolved` and `source` `package`. It supersedes the 0.90.2 record recorded on
2026-08-14Z as doctor-20260814T083045Z-bc4fc6 — the **ADR-0051 P2 review
hardening** loop (implementation PR #694 squash `aaf4744`; release PR #695
squash `271c5ae`; tag plugin-runtime-v0.90.2; marketplace sync `dbcb983`,
stage-doc sync `3ea869a`), which read `partial` `95%` 7/8 with
`host_parity_baseline` `stale` under Claude Code `2.1.232` / Codex `0.147.0`,
and whose owner-amended stop clause opened the named baseline follow-up this
loop closes. That in turn supersedes the 0.90.1 record recorded on 2026-08-12Z as
doctor-20260812T022356Z-252fb9 — the **Claude 2.1.227 host-parity baseline
refresh** loop (implementation PR #688 squash `354a95d`; release PR #689 squash
`8c9789a`; tag plugin-runtime-v0.90.1; marketplace sync `6ba5f21`, stage-doc
sync `94de990`), the first baseline refresh to carry the ADR-0051 §Decision 2
release obligation rather than landing as a docs-only edit, which read `partial`
`95%` 7/8 with `host_parity_baseline` `stale` under Claude Code `2.1.228` /
Codex `0.147.0`: Claude published `2.1.228` 20.8h after `2.1.227` — 13.8h after
that loop observed `2.1.227`, and 7.8h **before** its PR merged — so that
baseline was stale before it shipped. Measured against Claude's median
24.0h inter-patch interval (11 intervals from `2.1.217` to `2.1.228`, npm
publish times), its 22.1h loop — measured between the observation snapshot
`compat-20260811T035848Z-d6c3df` and the post-install verification snapshot
`compat-20260812T020732Z-295af8` — could not reliably close, which makes `ready` `100%`
a transient with a one-patch-interval lifetime rather than a steady state; that
datum is what [ADR-0052](../adr/0052-release-obligation-enforcement.md) used to
re-judge ADR-0051 §Alternatives D and leave it deferred. That record supersedes
the 0.90.0 record recorded on 2026-08-10Z as doctor-20260810T135637Z-d49983 —
the **ADR-0051 host-parity baseline source** loop (ADR PR #684 squash
`4bb25a5`; implementation PR #685 squash `20ebed7`; release PR #686 squash
`4a23a5b`; tag plugin-runtime-v0.90.0; marketplace sync `926ec01`, stage-doc
sync `d9b6e93`), which read `host_parity` `pass`, `host_parity_baseline`
`current` under Claude Code `2.1.226` / Codex `0.147.0`, and experience parity
`ready` `100%` 8/8. That record's own predecessor's `95%` was a structural
ceiling, not a regression, and that loop is what removed it: it named the cause
correctly — `runtime:compat` resolved
the host baseline from the installed plugin root while `runtime:doctor` resolved
it from the repo, so an in-repo refresh could not clear compat's drift — and
ADR-0051 makes the packaged copy the sole authority for both. Measured right
after the release, a fresh compat snapshot from the installed `0.90.0` read
`drift: none` / `current` for the first time, with the baseline's recorded
provenance reading `source: package`, `runtime_version: 0.90.0`, plus a content
hash. Two same-day records show the path to it:
`doctor-20260808T063339Z-74647d` (2026-08-08Z) read `blocked` `78%` with the
engineer peer-run ledger blocked by a five-day-old non-terminal `plan-verify`
handle and the Codex hook attestation version-stale; after the handle was
reconciled to `orphaned` and `settings-20260808T065145Z-c8409f` recorded a fresh
attestation binding designer@0.3.1 / engineer@0.21.2 / founder@0.4.1 /
orchestrator@0.13.1 against Codex `0.147.0`, `doctor-20260808T065825Z-2dfe23`
(2026-08-08Z) read `blocked` `87%`. Here too the stale thing was runtime's
attestation artifact, not the host's trust: `[hooks.state]` carried
`enabled = true` and a matching `trusted_hash` for all twelve entries
throughout, because every hook command is the same `${PLUGIN_ROOT}`-relative
text that the version bump did not edit. This supersedes the 0.88.1
post-attestation record doctor-20260803T091403Z-7f2850 (2026-08-03Z) — the
**presentation-and-persistence** loop, a five-package patch release (release PR
#666 squash `208545c`; tags plugin-runtime-v0.88.1, plugin-engineer-v0.21.1,
plugin-designer-v0.3.1, plugin-founder-v0.4.1, plugin-orchestrator-v0.13.1;
marketplace sync `4e6ee69`, stage-doc sync `0b98de6`), which read `ready` `100%`
8/8 (115/115, zero manual follow-ups). The install proof
taken earlier that day, `doctor-20260803T033236Z-f56d25`, read `partial`
`91%` (105/115) with one manual follow-up,
`codex-hook-review`: all four hook-bearing plugins changed version, so the Codex
`/hooks` trust attestation went stale and only the owner can clear it
interactively. The record says so rather than claiming `ready`. Cleared the same day:
fresh attestation `settings-20260803T091332Z-ec30fe` and post-attestation record
`doctor-20260803T091403Z-7f2850` restore observed parity to `ready` `100%` 8/8
(115/115, zero manual follow-ups). The stale artifact was runtime's own
attestation, not the host's trust. This supersedes
the 0.88.0-native record `doctor-20260802T132248Z-2b8a4c` (2026-08-02Z) — the **one
machine snapshot per verb** loop, a MAJOR-bearing release of four runtime
commits (feature PR #663 squash `383dc14` made every verb gather ONE machine
snapshot — probe, raw host facts and user-global readers together — and
rebuild everything it judges, persists and reports from it, after measurement
showed `resume` was reducing and persisting against a post-execution probe
while its own steps, Stage 0 and fragment composition still derived from the
pre-execution one; three cross-host review rounds each found the repair had
moved the problem rather than removed it, and every finding was reproduced
before it was accepted — a false terminal completion the first reconstruction
introduced, a convergence that belonged in the shared re-judgement rather than
in `resume` alone, a snapshot trigger that had to become the doctor spawn
rather than 'evidence imported', two user-global config files each opened
twice, and the D0.1 receipt door the convergence closed until `attest` was
made to judge the run as it was reduced; five contract and comment sentences
in that slice asserted behaviour the code did not have, each caught by running
the path rather than re-reading it, so §7 is now deliberately narrow and five
reproduced gaps are recorded rather than claimed; feature PR #662 squash
`5c8cf79` carries the release's BREAKING change moving the report identifier
to `runtime-bootstrap-report-2.0`; feature PR #661 squash `358a75a` judged
`tui.notifications` as the second half of `notify.codex.configured`; and
`67bbc54` landed one grammar for answer applicability at both boundaries with
no PR number of its own; release PR #660 `chore: release main` squash
`6ea6208`, tag plugin-runtime-v0.88.0, marketplace sync `8243de5`; Claude
Code `2.1.220` / `codex-cli 0.145.0`; the doctor `entry_brief` and
`session_capture` readiness sections both read `ready`). `overall` reads
`pass`; experience parity reads **`ready` `100%` 8/8** with zero manual
follow-ups and zero not-verified rows (runtime ships no hooks, so the four-
plugin attestation `settings-20260722T021211Z-364c8f` stays current);
**`host_parity_baseline` reads `current`** — neither host drifted this loop,
so the 2026-07-25 `2.1.220` / `0.145.0` baseline stands unchanged and the
drift=none re-check `compat-20260725T020139Z-f0cc72` still reads both hosts
`matches`; and the workflow ledgers read clean. One honest note belongs on
this record: the egress provider-ack proof was NOT re-executed this loop and
stays stale against the installed version, because §4 requires the owner's
explicit triple consent for a real send and this release did not carry one —
the three proofs this record cites are the three that ran. This
supersedes the 0.87.0-native record `doctor-20260731T051408Z-210043`
(2026-07-31Z) — the **bootstrap effective-selection + model/effort posture**
loop (feature PRs #655 `3b75915` and #657 `167fd4a`; release PR #656 squash
`7fc7e63`, tag plugin-runtime-v0.87.0, marketplace sync `6d53cab`), which in
turn supersedes the 0.86.3-native record `doctor-20260728T013239Z-2a6995`
(2026-07-28Z) — the **#645 Codex /hooks
attestation import** loop (bootstrap read the attestation from a top-level
`doctorReport.codex_hook_review` that doctor emits on no report, so the import
never ran and the non-declinable `hooks.codex.attested` step could never be
satisfied on any hook-bearing bundle, silently; the fix reads doctor's
`settings_runs.codex_hook_review` currency wrapper and judges the claim by the
run's own selection rather than doctor's machine-wide verdict, refreshes a
stale stored record instead of short-circuiting on its presence, and re-judges
the step within the importing resume so it no longer takes a second one;
feature PR #652 squash `b55ce53`, whose subject carries no PR number because
the squash subject was passed explicitly; release PR #653 `chore: release
main` squash `9abddc6`, tag
plugin-runtime-v0.86.3 — backticks deliberately omitted for the freshness
gate — marketplace sync `5bb88c1`; Claude Code `2.1.220` /
`codex-cli 0.145.0`; the doctor `entry_brief` and `session_capture` readiness
sections both read `ready`). `overall` reads `pass`; experience parity reads
**`ready` `100%` 8/8** with zero manual follow-ups (runtime ships no hooks,
so the four-plugin attestation `settings-20260722T021211Z-364c8f` stays
current); **`host_parity_baseline` reads `current`** — this patch loop drifted
neither host, so the 2026-07-25 `2.1.220` / `0.145.0` baseline stands unchanged
and no compat refresh was required (that baseline was set one loop earlier by
the content-backed `CHANGELOG.md` ingest via explicit
`--fetch-release-notes-url` in run `compat-20260725T015749Z-387259`, with the
drift=none re-check `compat-20260725T020139Z-f0cc72` reading `current` /
`drift_class` `none` and both hosts `matches`) — with the
honest pre-proof ledger note that the first 0.86.0 doctor read `warning` on
one stale `running` engineer peer-run handle
(`review-20260722T232336Z-146d22c0`, orphaned by a session end), reconciled
to `orphaned` plus a 138-handle TTL prune via engineer `peer-runner.mjs sweep
--apply` before the proof (the sweep dry-run's empty prune preview is a
recorded follow-up). **The ADR-0048 §3 live-fire egress dogfood closed in the
same loop**: the run-schema-1.2 bootstrap run
`bootstrap-20260723T124729Z-b5191c` (bundle `base`, 28 steps) took the
operator's explicit `execute` answer on `proof.egress-provider-ack`; the
operator exported the egress credential directly in their own shell (triple
consent including `AGENTIC_EGRESS_REAL_SMOKE=1` — no token through agent or
tool, ADR-0048 §4), the doctor egress executor
`doctor-20260723T133245Z-ac0499` dispatched one closed-vocabulary synthetic
`response-needed` send through the pinned `notify.mjs` emitter — provider
`acked`, `mirror_correlated=true`, write-ahead intent resolved `acked`,
sanitized metadata only — and the owner then confirmed the message on their
phone (subject `egress-proof-5f00461ebdc9`), recording the receipt
attestation (`surface=owner-phone`, matching `attempt_hash`, linked
provider-proof artifact hash) that derives the run's **`delivery-attested`**
completion label; this scorecard records that evidence only AFTER the real
send and phone receipt, per the no-pre-recording discipline. Honest caveats
(the first and third recorded as follow-up rows; the statusline decline is an
owner decision, not a defect): the bootstrap run stays `open` on the undeclinable
`config.model_effort` step (this machine deliberately runs host-default
model/effort), both statusline steps were declined (the existing operator
statusLine is kept — replace/manual-merge is a separate owner decision), and
the run's `steps[]` row for the executed egress proof renders `pending` while
the completion reducer reads `passed` (display divergence). This supersedes
the 0.85.0-native **ADR-0047 Release B** record doctor-20260722T012908Z-472538
(2026-07-22Z; runtime 0.85.0 + attention 0.9.0 — backticks deliberately
omitted for the freshness gate — release PR #616 merge c2bc0f9, tags
plugin-attention-v0.9.0 + plugin-runtime-v0.85.0, marketplace sync 36057ad;
Claude Code 2.1.217 / codex-cli 0.145.0; that record read `overall` `pass`
with zero warnings, three execute proofs both directions, hook state 12/12
`enabled_trusted` `unexpected_agentic_entries=0`, `host_parity_baseline`
`current` after the same-day dual-drift compat cycle —
compat-20260722T011840Z-a3fb14 ingest, drift=none re-check
compat-20260722T012840Z-915f54 — and parity first deliberately `partial`
`91%` on the Codex-CLI-minor-bump-invalidated four-plugin attestation
settings-20260720T151554Z-3b543f, restored the same day by the fresh
attestation settings-20260722T021211Z-364c8f and the post-attestation record
doctor-20260722T021258Z-4c7514 reading `ready` `100%` 8/8 with all three
execute proofs re-passed in both directions). This
supersedes the 0.84.0-native **ADR-0047 Release A** record recorded on
2026-07-21Z as doctor-20260721T110155Z-928e38 (feature PR #611 squash
560527f + #613 rebase-merged 54f39c0 / 952af14 / 73b88c1; release PR #612
squash d9a8a7d, tags plugin-attention-v0.8.0 + plugin-runtime-v0.84.0 —
backticks deliberately omitted for the freshness gate — marketplace sync
d93d23e; Claude Code 2.1.216 / codex-cli 0.144.6; that record read `overall`
`pass` with zero warnings, three execute proofs passed both directions, hook
state 12/12 `enabled_trusted` `unexpected_agentic_entries=0`, and parity
`ready` `100%` 8/8 with the four-plugin attestation
`settings-20260720T151554Z-3b543f` then current since attention 0.8.0 was
vocabulary-only and codex-cli 0.144.6 was unchanged — the no-invalidation
half of the discipline), and in turn the 0.83.1-native S9 record recorded on
2026-07-20Z as doctor-20260720T175310Z-a0fd88 — the **S9 peer-follow-up
hardening** loop (feature PR #606, rebase-merged eb480f3 / ba1c201 / fd381b4;
release PR #607 squash 9a69944, tags plugin-attention-v0.7.1 +
plugin-runtime-v0.83.1 — backticks deliberately omitted for the freshness
gate — marketplace sync f54d70c; Claude Code 2.1.215 / codex-cli 0.144.6;
that record read `overall` `pass` with zero warnings, three execute proofs
passed both directions, hook state 12/12 `enabled_trusted` with the two
retained pre-relocation attention rows still present, and parity `ready`
`100%`).
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
The latest `plugin-runtime` `0.91.1` release/install proof loop is the
**assurance plane** slice, whose 0.91.1-native proof
`doctor-20260818T115259Z-e7c325` (2026-08-18Z) reads `blocked` `82%` 7/9
(106/130), `host_parity` `pass`, `overall` `warning` (zero hard failures, one
warning: latest compatibility check requires release notes), and
`host_parity_baseline` **`stale`** with `baseline-direction` `ahead`. It is the
first recorded proof in which the assurance layer is separately visible, and it reads
**`unassured`**: no grant names the host pair claude `2.1.234` / codex
`0.147.0`, because ADR-0054 rollout R1 ships an empty grant list by owner
decision. The refusal is the designed outcome, and it gates assurance-dependent
readiness only — every bidirectional execution proof in the same run passed. See
the release/install narrative above for the three independent open items and why
the blocked criterion is a self-taken measurement rather than an inherited fault. Its predecessor's two
partials are closed here: the Codex `/hooks` re-attestation
`settings-20260816T233407Z-4f23d9` landed on 2026-08-16Z, after the 0.90.3
proof was taken, so this is the first proof to observe it. It supersedes the
0.90.3-native proof `doctor-20260816T144610Z-154506` (2026-08-16Z) of the
**Claude 2.1.233 host-parity baseline refresh and withdrawn-todo-tool
adaptation** slice, which read `partial` 91% 6/8 with zero
blocked criteria, `host_parity` `pass`, `overall.hard_failures` empty, and
`host_parity_baseline` **`current`**. That slice is also the clearest live case
of the rule stated just above: it bumped all four hook-bearing persona packages,
`~/.codex/config.toml` `[hooks.state]` was left empty, and both of its partials
(`plugin_management_followups`, `lifecycle_hook_continuity`) are that one
operator action rather than two findings. It supersedes the 0.90.2-native proof
`doctor-20260814T083045Z-bc4fc6` (2026-08-14Z) of the **ADR-0051 P2 review
hardening** slice, which read `partial` `95%` 7/8 and honestly read
`host_parity_baseline` `stale` because that release did not touch the baseline,
leaving it on the 2026-08-11 observation of `2.1.227` while the host had reached
`2.1.232`. Two readings in this loop are worth separating from
the release itself. `workflow_continuity_storage` read `blocked` before the proof
and `satisfied` in it: a dead `plan-verify` peer handle from 2026-08-13 had been
left non-terminal by the preceding slice and was reconciled to `orphaned` before
recording — the same failure mode, and the same repair, as the five-day-old
handle the 0.90.0 loop hit. And the one partial, `runtime_handoff_artifacts`, is
this loop's own compat snapshot recording real drift rather than a defect. Its
drift is materially unlike the previous one: the 2.1.228–2.1.232 range changes
plugin-marketplace sources, `/plugin install` ordering, self-hosted-runner hooks,
subagent forking defaults, and plugin-cache handling of symlinked development
checkouts — all surfaces this baseline documents — so the follow-up it needs is a
real re-judgement, not a version-number bump. It supersedes the **Claude 2.1.227
host-parity baseline refresh** slice, whose 0.90.1-native proof
doctor-20260812T022356Z-252fb9 (2026-08-12Z) read `partial` `95%` 7/8 with zero
blocked criteria, `host_parity` `pass`, and `host_parity_baseline` `stale` —
Claude moved to `2.1.228` 7.8h before that loop's own PR merged, so the refreshed
baseline was overtaken before it shipped.
That in turn supersedes the ADR-0051 host-parity baseline source slice, whose 0.90.0-native
proof doctor-20260810T135637Z-d49983 (2026-08-10Z) read `ready` `100%` 8/8 with
zero blocked criteria, `host_parity` `pass` and `host_parity_baseline` `current`
— the compat baseline-source asymmetry that held the record before it at `95%`
was resolved by ADR-0051, whose release that proof records. (An earlier revision
of this paragraph attributed that 0.90.0 loop to the **ADR-0013 trigger
re-evaluation** slice and called its proof 0.89.0-native. Both belong to the
preceding 0.89.0 release — tag plugin-runtime-v0.89.0, PR #672 — whose own
proofs are the three 2026-08-08 0.89.0-native runs recorded in
`egress-durability-and-adr0013-verdict`; the misattribution is corrected here
rather than restated.) It supersedes the
presentation-and-persistence slice, whose 0.88.1-native post-attestation proof
doctor-20260803T091403Z-7f2850 (2026-08-03Z) read `ready` `100%` 8/8, after the
same-day install proof `doctor-20260803T033236Z-f56d25` ( `overall` `pass`, three execute
proofs passed in both directions) reads experience parity **`partial` `91%`**
with the `codex-hook-review` follow-up open, because the designer, engineer,
founder and orchestrator version bumps staled the Codex `/hooks` attestation.
The post-attestation record `doctor-20260803T091403Z-7f2850` (2026-08-03Z), taken
after `settings-20260803T091332Z-ec30fe`, restores `ready` `100%` 8/8.
It supersedes the **one machine snapshot per verb** slice, whose 0.87.0-native proof
`doctor-20260802T132248Z-2b8a4c` (2026-08-02Z; `overall` `pass`, three execute
proofs passed in both directions, experience parity `ready` `100%` 8/8 with
zero manual follow-ups, `host_parity_baseline` `current`) was taken against
the released binary rather than a patched working tree. Four runtime commits
shipped in it: feature PR #663 squash `383dc14` made every verb gather one
machine snapshot and rebuild everything it judges, persists and reports from
that one gathering, converging the effective selection in the shared re-
judgement and again after a Stage-8 executor, and leaving `attest` as the one
verb that judges the run as it was reduced so a refusal that lapsed after the
run closed cannot shut the D0.1 receipt door; feature PR #662 squash `5c8cf79`
carries the release's BREAKING change moving the report identifier to
`runtime-bootstrap-report-2.0` and replacing an exit-50 report's `completion`
key with `legacy_completion_summary`; feature PR #661 squash `358a75a` judged
`tui.notifications` as the second half of `notify.codex.configured`; and
`67bbc54` landed one grammar for answer applicability, asked at both
boundaries. Release PR #660 (`chore: release main`, squash `6ea6208`) cut tag
plugin-runtime-v0.88.0 with marketplace sync commit `8243de5`. In turn the
0.87.0 loop was the **bootstrap effective-selection + model/effort posture**
slice (feature PRs #655 `3b75915` and #657 `167fd4a`, release PR #656 squash
`7fc7e63`, tag plugin-runtime-v0.87.0, marketplace sync `6d53cab`), and
before it the 0.86.3 loop was the **#645 Codex /hooks attestation
import** slice — bootstrap read the operator
attestation from a top-level `doctorReport.codex_hook_review` key that doctor
emits on no report, so the import never ran and the non-declinable
`hooks.codex.attested` step could never be satisfied on any hook-bearing
bundle, silently. The fix reads the `settings_runs.codex_hook_review` currency
wrapper doctor actually publishes; judges the claim by the run's own selection
rather than doctor's machine-wide verdict; refreshes a stale stored record
instead of short-circuiting on its presence; and re-judges the step inside the
importing resume, against that resume's own answered rows so operator declines
survive — feature PR #652 squash `b55ce53`,
whose subject carries no PR number because the squash subject was passed
explicitly on the CLI; release PR #653 (`chore: release
main`, squash `9abddc6`) cut tag plugin-runtime-v0.86.3 — backticks deliberately omitted for
the freshness gate — with marketplace
sync commit `5bb88c1`, and the 0.86.3-native proof
doctor-20260728T013239Z-2a6995 (2026-07-28Z; `overall` `pass` with zero
warnings and zero hard failures, three execute
proofs executed and passed in both directions, experience parity `ready`
`100%` 8/8 with zero manual follow-ups — runtime ships no hooks, so the
four-plugin attestation `settings-20260722T021211Z-364c8f` stays current;
`entry_brief` and `session_capture` both `ready`; `host_parity_baseline`
`current` with neither host drifting this patch loop, so the 2026-07-25
`2.1.220` / `0.145.0` baseline stands unchanged and no compat cycle was
required) was taken
against that released binary, not a patched working tree — and in turn the
0.86.2 **ADR-0048 bootstrap-observability** loop (run schema 1.2 +
evidence-contract vnext, the notify axis split, the agentic-6 statusline
adapter, the triple-consent egress-ack-proof doctor executor, and the
single-merge-owner integration; feature PRs #631 `f9e7d07` / #632 `cd27d2d` /
#633 `84b2c86` / #634 `ac5803a` / #635 `73127e3` atop the pre-macro
activation-semantics fix #629 `3615dcc`, hardened by the 0.86.1 egress-ack
intent-WAL fence #637 `b984dc8` and the 0.86.2 Stage-8 proof-rendering pair
#641 `af620df` / #639 `c549ed2`; release PR #642 `chore: release main` squash
`9e2af7d` cut tag plugin-runtime-v0.86.2 — backticks deliberately omitted for
the freshness gate — with marketplace sync commit `668c325`, its 0.86.2-native
proof doctor-20260726T014023Z-1b377b taken against that released binary)
closed the **ADR-0048 §3 live-fire egress dogfood**: bootstrap run
bootstrap-20260723T124729Z-b5191c took the operator's explicit `execute`
answer on `proof.egress-provider-ack` (triple consent including
`AGENTIC_EGRESS_REAL_SMOKE=1`, the credential exported by the operator in
their own shell — never through agent or tool), the doctor egress executor
doctor-20260723T133245Z-ac0499 dispatched one closed-vocabulary synthetic
`response-needed` send through the pinned `notify.mjs` emitter (provider
`acked`, mirror correlated, write-ahead intent resolved, sanitized metadata
only), and the owner's phone receipt (subject `egress-proof-5f00461ebdc9`)
was attested separately (`surface=owner-phone`, matching `attempt_hash`,
linked provider-proof artifact hash), deriving the run's `delivery-attested`
completion label — recorded here only after the real send and phone receipt,
per the no-pre-recording discipline. It supersedes the 0.85.0-native
**ADR-0047 Release B** slice — the §6 bounded expired-claim sweep
sweepExpiredClaims (behind the non-recursive withReclaimLock lock repair) and
the §7 citation-aware artifact retention (planRetention read-only planner,
applyRetention M1 deleting executor gated on a reviewed plan hash,
runtime:retention CLI), §6 commits 1dc3bc4/949aa65 and §7 commits
123e9a0/e9d5a1c/1a3c5c6/0bdbdd5; release PR #616 (chore: release main, merge
c2bc0f9) cut tags plugin-attention-v0.9.0 and plugin-runtime-v0.85.0
(backticks deliberately omitted for the freshness gate) with marketplace sync
commit 36057ad, whose 0.85.0-native proof doctor-20260722T012908Z-472538
(2026-07-22Z) read overall pass with zero warnings, three execute proofs both
directions, hook state 12/12 enabled_trusted, host_parity_baseline current
after the dual-drift compat cycle (compat-20260722T011840Z-a3fb14 ingest,
drift=none re-check compat-20260722T012840Z-915f54), and parity first
deliberately partial 91% on the Codex-minor-bump-invalidated attestation,
restored the same day to ready 100% 8/8 by settings-20260722T021211Z-364c8f +
doctor-20260722T021258Z-4c7514 — and in turn the 0.84.0-native
**ADR-0047 Release A** slice — feature PR #611 squash 560527f (the §5 seeded
standing notification watch) and feature PR #613 rebase-merged 54f39c0 /
952af14 / 73b88c1, release PR #612 squash d9a8a7d cutting tags
plugin-attention-v0.8.0 and plugin-runtime-v0.84.0 (backticks omitted for the
freshness gate) with sync d93d23e, whose 0.84.0-native proof
doctor-20260721T110155Z-928e38 read `ready` `100%` 8/8 with the four-plugin
attestation then current (attention 0.8.0 vocabulary-only, codex-cli 0.144.6
unchanged) — and in turn the 0.83.1
**S9 peer-follow-up hardening** loop — feature PR #606, rebase-merged
eb480f3 / ba1c201 / fd381b4; release PR #607 squash 9a69944, tags
plugin-attention-v0.7.1 and plugin-runtime-v0.83.1 — backticks deliberately
omitted for the freshness gate — marketplace sync f54d70c, and the
0.83.1-native proof doctor-20260720T175310Z-a0fd88 (2026-07-20Z; `overall`
`pass` with zero warnings, three execute proofs both directions, hook state
12/12 with the two pre-relocation rows then retained, parity `ready` `100%`)
likewise taken against the released binary — and in turn the 0.83.0
**ADR-0045 entry-time proposal surfaces** loop —
feature PRs S6 #597 `932c135` (the shared host-localization leaf extraction),
S7a #598 `5c6dae8` (the entry-brief bounded read layer: versioned tolerant
parsers + bounded scans), S7b #599 `45624bf` (the §16 arbiter + pointer-only
brief + user-scope-only session keys + context CLI), and S8 #600 `de20853`
(the snapshot-only dashboard entry advisory + §18 readiness diagnosis +
trusted-host threading); release PR #596 squash `e249ac7` cut tag
plugin-runtime-v0.83.0 — backticks deliberately omitted for the freshness gate
— alongside `plugin-attention-v0.6.0` (the ADR-0044 S5 sensor slice, #595
`3b8ed8d`) and marketplace sync commit `360a71f`, and the 0.83.0-native proof
doctor-20260720T052332Z-a0d677 (2026-07-20Z; `overall` `pass`, three execute
proofs executed and passed in both directions, hook state `12/12` expected
`enabled_trusted`; the then-new doctor `entry_brief` section read `off`, the
shipped default, mirroring `session_capture` `off`) likewise taken against the
released binary — and in turn the 0.82.0
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
release tag plugin-runtime-v0.77.0, marketplace sync commit `7dce7fe`. The
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
| R3 | Switching development tools must work in both directions: Claude Code to Codex and Codex to Claude. | Cross-host tests cover resume and stop-archive behavior for engineer/orchestrator; companions exist in both directions. Installed `plugin-runtime` `0.91.1` carries the native `runtime:doctor --permission-proof --execute-permission-proof --deep-peer-smoke --execute-deep-peer-smoke --workflow-continuation-proof --execute-workflow-continuation-proof` proof recorded on 2026-08-18Z as `doctor-20260818T115259Z-e7c325` (Claude Code `2.1.234` / Codex `0.147.0`, runtime installed 0.91.1 on both hosts and byte-identical between them — 124 files, whole-tree digest `56f82e713e9649be8d95e98dc975af9ecbb5421c11944e84a6f20f1a4594c29d`, packaged baseline `3ad3afa1f82d8e3d3441719e7bbcf02a50156b7d049c3cd1a28bc8d08e1adf49` matching repository, the `plugin-runtime-v0.91.1` tag and both caches; the assurance plane loop — ADR-0053 `38e59bb` PR #701 and ADR-0054 `48db4f3` PR #702, implementation commits `e8f6d2b`/`79003cc`/`b8ad2b3`/`c535c1a`/`6651c5c`/`70e0461` and hardening commit `4ee8764`, release PR #704 squash `47bc9c9` tag plugin-runtime-v0.91.0 marketplace sync `361952c` stage-doc sync `e8a9b44`, then release PR #711 squash `48f50d2` tag `plugin-runtime-v0.91.1` marketplace sync `024ec42` stage-doc sync `f24727b`; all three execute proofs passed in both directions, `host_parity` `pass`, `overall` `warning` (zero hard failures, one warning: latest compatibility check requires release notes), `host_parity_baseline` `stale` and `baseline-direction` `ahead` — Claude reached 2.1.234 after the 2.1.233 baseline was cut, and refreshing that baseline is protected-asset work this recovery is forbidden to do; the separate assurance layer reads `unassured` because ADR-0054 rollout R1 ships no grants, the first RECORDED proof of ADR-0053 §Decision 6's rejection path (the verdict became reachable one release earlier, in 0.91.0 via `70e0461`), gating assurance-dependent readiness only; observed experience parity `blocked` `82%` 7/9 (106/130), where earned weight rose from 105/115 as the predecessor's two partials closed via `settings-20260816T233407Z-4f23d9` while the percentage fell because a ninth criterion, `host_compatibility_assurance`, was introduced by this very release). It supersedes the 0.90.3 proof recorded on 2026-08-16Z as doctor-20260816T144610Z-154506 (Claude Code `2.1.233` / Codex `0.147.0`, runtime installed 0.90.3 on both hosts; the Claude 2.1.233 host-parity baseline refresh and withdrawn-todo-tool adaptation loop — implementation PR #698 rebase-merged as five package-scoped commits `2eea2b3`/`0cb184e`/`feeeafb`/`e563921`/`6abe4be`, release PR #699 squash `38fedaf`, tag plugin-runtime-v0.90.3, marketplace sync `e46256b`, stage-doc sync `5ee8024`; all three execute proofs passed in both directions, `host_parity` `pass`, observed experience parity `partial` 91% 6/8 with `host_parity_baseline` `current`). It supersedes the 0.90.2 proof recorded on 2026-08-14Z as doctor-20260814T083045Z-bc4fc6 (Claude Code `2.1.232` / Codex `0.147.0`, runtime installed 0.90.2 on both hosts; the ADR-0051 P2 review hardening loop — implementation PR #694 squash `aaf4744`, release PR #695 squash `271c5ae`, tag plugin-runtime-v0.90.2, marketplace sync `dbcb983`, stage-doc sync `3ea869a`; all three execute proofs passed in both directions, `host_parity` `pass`, observed experience parity `partial` `95%` 7/8 with `host_parity_baseline` `stale`, that release having left the baseline on its 2026-08-11 observation of 2.1.227 against an observed 2.1.232). That in turn supersedes the 0.90.1 proof recorded on 2026-08-12Z as doctor-20260812T022356Z-252fb9 (Claude Code `2.1.228` / Codex `0.147.0`, runtime installed 0.90.1 on both hosts; the Claude 2.1.227 host-parity baseline refresh loop — implementation PR #688 squash `354a95d`, release PR #689 squash `8c9789a`, tag plugin-runtime-v0.90.1, marketplace sync `6ba5f21`, stage-doc sync `94de990`; all three execute proofs passed in both directions, `host_parity` `pass`, observed experience parity `partial` `95%` 7/8 with zero blocked and `host_parity_baseline` `stale` — Claude published 2.1.228 7.8h before that loop's own PR merged, so the refreshed baseline was overtaken before it shipped, and the single partial is runtime_handoff_artifacts 9/15 whose whole remedy is refresh-baseline), and before it the 0.90.0 proof recorded on 2026-08-10Z as doctor-20260810T135637Z-d49983 (Claude Code `2.1.226` / Codex `0.147.0`, runtime installed 0.90.0 on both hosts; the ADR-0051 host-parity baseline source loop — ADR PR #684 squash `4bb25a5`, implementation PR #685 squash `20ebed7`, release PR #686 squash `4a23a5b`, tag plugin-runtime-v0.90.0, marketplace sync `926ec01`, stage-doc sync `d9b6e93`; all three execute proofs passed in both directions, `host_parity` `pass`, `host_parity_baseline` `current`, observed experience parity `ready` `100%` with zero blocked), and before it the 0.88.1 proof recorded on 2026-08-03Z (doctor-20260803T091403Z-7f2850 post-attestation, after install proof doctor-20260803T033236Z-f56d25; Claude Code `2.1.220` / Codex `0.145.0`, runtime installed 0.88.1 on both hosts; the presentation-and-persistence loop — release PR #666 squash `208545c`, five package tags cut together, marketplace sync `4e6ee69`, stage-doc sync `0b98de6`; `overall` `pass` with all three execute proofs passed in both directions, observed experience parity `partial` `91%` 105/115 with one manual follow-up `codex-hook-review` open because the four hook-bearing plugin bumps staled the Codex `/hooks` attestation and only the owner can clear it interactively); the same-day fresh attestation `settings-20260803T091332Z-ec30fe` and post-attestation record `doctor-20260803T091403Z-7f2850` restore observed parity to `ready` `100%` 8/8 with zero manual follow-ups, confirming the stale artifact was runtime's attestation record rather than the host's hook trust. This supersedes the 0.88.0-native record recorded on 2026-08-02Z (doctor-20260802T132248Z-2b8a4c, Claude Code `2.1.220` / Codex `0.145.0`, runtime installed 0.88.0 on both hosts; the one machine snapshot per verb loop — feature PR #663 squash `383dc14` made every verb gather one machine snapshot and rebuild everything it judges, persists and reports from it, feature PR #662 squash `5c8cf79` carries the release's BREAKING report-identifier change, feature PR #661 squash `358a75a` judged tui.notifications as the second half of notify.codex.configured, and `67bbc54` landed one grammar for answer applicability at both boundaries; release PR #660 `chore: release main` squash `6ea6208`, tag plugin-runtime-v0.88.0, marketplace sync `8243de5`; installs refreshed host-native (claude plugin update / codex plugin marketplace upgrade + codex plugin add) with the installed state doctor-observed, no settings-executor artifact claimed; `overall` `pass` with zero hard failures; all three execute proofs executed and passed in both directions; experience parity `ready` `100%` 8/8 with zero manual follow-ups and zero not-verified rows; `host_parity_baseline` `current` — neither host drifted this loop, so the 2026-07-25 2.1.220 / 0.145.0 baseline stands unchanged and no compat cycle was required; doctor `entry_brief` and `session_capture` both read `ready`; the workflow ledgers read clean; the egress provider-ack proof was NOT re-executed and stays stale, §4 requiring the owner's explicit triple consent for a real send; and the posture this release shipped was exercised on the spot — the machine recorded model_effort_fallback = "host-native" in user-global config through `runtime:settings --apply --target user`, so model/effort resolves host-native defaults in both directions as a declared posture, with the ADR-0048 §3 dogfood run bootstrap-20260723T124729Z-b5191c re-judging its Stage-4 step on its next verb and its own run document untouched until a resume runs). This supersedes the 0.86.3-native record doctor-20260728T013239Z-2a6995 (2026-07-28Z; the #645 Codex /hooks attestation import loop — bootstrap read the operator attestation from a top-level doctorReport.codex_hook_review key doctor emits on no report, so the non-declinable hooks.codex.attested step could never be satisfied on any hook-bearing bundle, silently; the fix reads the settings_runs.codex_hook_review currency wrapper doctor publishes, judges the claim by the run own selection rather than doctor machine-wide verdict, refreshes a stale stored record instead of short-circuiting on its presence, and re-judges the step inside the importing resume; feature PR #652 squash b55ce53 (subject carries no PR number, passed explicitly on the CLI); release PR #653 `chore: release main` squash `9abddc6`, tag plugin-runtime-v0.86.3, marketplace sync `5bb88c1`; installs refreshed host-native (claude plugin update / codex plugin marketplace upgrade + codex plugin add) with the installed state doctor-observed, no settings-executor artifact claimed; `overall` `pass` with zero warnings; all three execute proofs executed and passed in both directions; experience parity `ready` `100%` 8/8 with zero manual follow-ups — runtime ships no hooks, so the four-plugin attestation `settings-20260722T021211Z-364c8f` stays current; `host_parity_baseline` `current` — neither host drifted this patch loop, so the 2026-07-25 2.1.220 / 0.145.0 baseline stands unchanged and no compat cycle was required; doctor `entry_brief` and `session_capture` both read `ready`; the pre-proof workflow ledgers read clean, with no stale peer-run handle to reconcile this time; and the same loop closed the ADR-0048 §3 live-fire egress dogfood — bootstrap run bootstrap-20260723T124729Z-b5191c, operator-exported credential with triple consent including AGENTIC_EGRESS_REAL_SMOKE=1 (no token through agent or tool), one closed-vocabulary synthetic `response-needed` send via the pinned notify.mjs emitter acked by the provider with the mirror correlated (doctor-20260723T133245Z-ac0499), and the owner's phone receipt (subject egress-proof-5f00461ebdc9) attested separately with matching attempt_hash, deriving the run's delivery-attested completion label — recorded only after the real send and phone receipt, per the no-pre-recording discipline). This supersedes the 0.85.0-native ADR-0047 Release B record re-recorded under the 0.85.0 install on 2026-07-22Z (doctor-20260722T012908Z-472538, Claude Code 2.1.217 / Codex 0.145.0, runtime installed 0.85.0 and attention 0.9.0 on both hosts with engineer 0.21.0 / orchestrator 0.13.0; the ADR-0047 Release B loop — the §6 bounded expired-claim sweep `sweepExpiredClaims` behind the non-recursive `withReclaimLock` lock repair, and the §7 citation-aware retention planner + M1 deleting apply executor + `runtime:retention` CLI, §6 commits `1dc3bc4`/`949aa65` and §7 commits `123e9a0`/`e9d5a1c`/`1a3c5c6`/`0bdbdd5`; release PR #616 `chore: release main` merge `c2bc0f9`, tags plugin-attention-v0.9.0 + plugin-runtime-v0.85.0 (backticks deliberately omitted for the freshness gate), marketplace sync `36057ad`; installs refreshed host-native (claude plugin update / codex plugin marketplace upgrade) with the installed state doctor-observed, no settings-executor artifact claimed; `overall` `pass` with zero warnings; all three execute proofs executed and passed in both directions; `host_parity_baseline` `current` — the dual Claude 2.1.216→2.1.217 / Codex 0.144.6→0.145.0 drift the first proof run exposed was closed the same day by the compat cycle — content-backed CHANGELOG + Codex atom ingest in compat-20260722T011840Z-a3fb14, drift=none re-check in compat-20260722T012840Z-915f54; doctor `entry_brief` reads `ready` — the operator's ADR-0045 user-scope startup opt-in, the `floors.entry_brief=0.83.0` pin satisfied by `0.85.0` — alongside `session_capture` `ready`; experience parity **deliberately `partial` `91%` (6/8 satisfied)** with the manual `codex-hook-review` follow-up — the honest fail-closed case: the Codex CLI 0.144.6→0.145.0 minor bump version-invalidated the four-plugin attestation `settings-20260720T151554Z-3b543f` (`currency_reason=codex_cli_version_changed`); the trusted hook entries themselves stay unchanged and healthy (`12/12` expected `enabled_trusted`, `unexpected_agentic_entries=0`), neither released package touched a Codex hook-bearing plugin (runtime ships no hooks, attention 0.9.0 changed only the Claude hook surface with zero Codex hook surface, the four attested plugins designer@0.3.0 / engineer@0.21.0 / founder@0.4.0 / orchestrator@0.13.0 unchanged), so a fresh owner-gated `/hooks` review plus `runtime:settings --attest-codex-hook-review` restores `ready` — which landed the same day: the operator's `/hooks` confirmation produced attestation `settings-20260722T021211Z-364c8f` (`bound_versions.codex=0.145.0`) and the post-attestation record `doctor-20260722T021258Z-4c7514` restored observed parity to `ready` `100%` 8/8 with all three execute proofs re-passed both directions). This supersedes the 0.84.0-native ADR-0047 Release A record doctor-20260721T110155Z-928e38 (2026-07-21Z; runtime 0.84.0 + attention 0.8.0 on both hosts, Claude Code 2.1.216 / codex-cli 0.144.6; feature PR #611 squash 560527f + #613 rebase-merged 54f39c0 / 952af14 / 73b88c1, release PR #612 squash d9a8a7d, tags plugin-attention-v0.8.0 + plugin-runtime-v0.84.0, marketplace sync d93d23e; overall pass with zero warnings, three execute proofs both directions, hook state 12/12 enabled_trusted unexpected_agentic_entries=0, parity ready 100% 8/8 with the four-plugin attestation then current since attention 0.8.0 was vocabulary-only and codex-cli 0.144.6 unchanged), and in turn the 0.83.1-native S9 peer-follow-up hardening record re-recorded on 2026-07-20Z (doctor-20260720T175310Z-a0fd88, Claude Code 2.1.215 / Codex 0.144.6, runtime installed 0.83.1 and attention 0.7.1 on both hosts; feature PR #606 rebase-merged eb480f3 / ba1c201 / fd381b4, release PR #607 squash 9a69944, tags plugin-attention-v0.7.1 + plugin-runtime-v0.83.1 — backticks deliberately omitted for the freshness gate — marketplace sync f54d70c; overall pass with zero warnings, all three execute proofs both directions, hook state 12/12 with unexpected_agentic_entries=2 then-retained pre-relocation rows, parity ready 100% 8/8), and the same-day attention-0.7.0 freshness record re-recorded on 2026-07-20Z (doctor-20260720T105456Z-e1f9a9, Claude Code `2.1.215` / Codex `0.144.6`, runtime installed 0.83.0 and attention 0.7.0 on both hosts with engineer 0.21.0 / orchestrator 0.13.0; the ADR-0045 S9 loop — feature PR #602 rebase pair `5b840bd`+`9460682` (S9-gate re-validation recorded ahead of the SessionStart registration), release tag `plugin-attention-v0.7.0` from release PR #603 squash `0f8d84f`, marketplace sync `b0db587`; `overall` `pass` with zero warnings; all three execute proofs executed and passed in both directions; `host_parity_baseline` **current** — the prior record's baseline-stale follow-up closed in-slice by the 2026-07-20 refresh (compat `compat-20260720T104815Z-9323ec` with content-backed notes for both drifted hosts, re-check `drift=none` at `compat-20260720T105414Z-87af5e`); doctor `entry_brief` and `session_capture` readiness both read `off`, the shipped defaults; experience parity deliberately `partial` `91%` with manual follow-up `codex-hook-review` — the pre-S8a4 four-plugin attestation `settings-20260713T234950Z-f08600` stays `stale` (`currency_reason=codex_cli_version_changed`), and attention 0.7.0 changed only the Claude hook surface while keeping zero Codex hook surface, so the trusted hook entries are unchanged and a fresh `/hooks` review plus `runtime:settings --attest-codex-hook-review` restores `ready` — which landed the same day: fresh four-plugin attestation `settings-20260720T151554Z-3b543f` (`bound_versions.codex=0.144.6`) and post-attestation record `doctor-20260720T151637Z-e2e061` reading `ready` `100%` with zero manual follow-ups, all three execute proofs re-passed both directions, baseline still `current`). This supersedes the same-day 0.83.0-native record re-recorded on 2026-07-20Z (doctor-20260720T052332Z-a0d677, Claude Code `2.1.215` / Codex `0.144.1`, runtime installed 0.83.0 on both hosts — claude=installed/0.83.0, codex=installed/0.83.0 — with engineer 0.21.0 / orchestrator 0.13.0; release tag plugin-runtime-v0.83.0 — backticks deliberately omitted for the freshness gate — alongside `plugin-attention-v0.6.0` (ADR-0044 S5), marketplace sync `360a71f`; hook state `12/12` expected `enabled_trusted`, `unexpected_agentic_entries=2` retained pre-relocation attention rows, display-only; all three execute proofs executed and passed in both directions; the new doctor `entry_brief` readiness section reads `off`, the shipped default, alongside the `session_capture` `off` precedent; experience parity deliberately `partial` `91%` with manual follow-up `codex-hook-review` — the S8a4-hardened currency evaluation still finds the pre-repair four-plugin attestation `settings-20260713T234950Z-f08600` `stale` (`bound_versions.codex=null`, `currency_reason=codex_cli_version_changed`) instead of silently trusting it; neither released package changed a Codex hook-bearing plugin — runtime ships no hooks, attention exposes zero Codex hook surface — so the trusted hook entries are unchanged, and a fresh `/hooks` review plus `runtime:settings --attest-codex-hook-review` restores `ready`; the other honest caveat is `host_parity_baseline` `stale` — the recorded baseline is 2026-07-14 Claude Code `2.1.208` while the observed CLI is `2.1.215`, Claude patch-level drift tracked to a baseline-refresh follow-up slice per the 0.77.2 / attention-0.4.1 precedents, not pretended current). This supersedes the 0.82.0-native ADR-0044 session-capture exit-side record re-recorded under the 0.82.0 install on 2026-07-19Z (doctor-20260719T071752Z-6392f1, Claude Code 2.1.215 / Codex 0.144.1, runtime installed 0.82.0 on both hosts with engineer 0.21.0 / orchestrator 0.13.0; release tag plugin-runtime-v0.82.0 — backticks deliberately omitted for the freshness gate — marketplace sync `31a01ba`; hook state 12/12 expected enabled_trusted; all three execute proofs passed both directions; parity partial 91% with the codex-hook-review follow-up — the fail-closed half of contract §11.2 #24 observed live (currency binds the Codex CLI + hook-bearing plugin versions); the then-new session_capture section read off), and in turn the 0.81.0-native ADR-0046 S8 machine-bootstrap record re-recorded under the 0.81.0 install on 2026-07-18Z (doctor-20260718T080955Z-6eba4e, Claude Code 2.1.214 / Codex 0.144.1, runtime installed 0.81.0 on both hosts with engineer 0.21.0 / orchestrator 0.13.0; release tag plugin-runtime-v0.81.0 — backticks deliberately omitted for the freshness gate — marketplace sync `769b527`; hook state 12/12 expected enabled_trusted; all three execute proofs passed both directions; parity partial 6/8 with the codex-hook-review follow-up), and before it the 0.80.1-native S1 permission-advisor defect-class record re-recorded under the 0.80.1 install on 2026-07-14Z (doctor-20260714T235550Z-60336c, Claude Code 2.1.209 / Codex 0.144.1; release tag plugin-runtime-v0.80.1 — backticks deliberately omitted for the freshness gate — marketplace sync `160b3d8`; experience parity ready 100% 8/8 with zero manual follow-ups, all three execute proofs passed both directions), and before it the 0.80.0-native S9 completion-output-contract record re-recorded under the 0.80.0 install on 2026-07-13Z (`doctor-20260713T025136Z-7758d3`, Claude Code `2.1.207` / Codex `0.144.1`, runtime installed 0.80.0 on both hosts with engineer 0.21.0 / orchestrator 0.13.0; release tag plugin-runtime-v0.80.0 — backticks deliberately omitted for the freshness gate — marketplace sync `ddb43d4`; hook state `12/12` expected `enabled_trusted`, `unexpected_agentic_entries=2` retained pre-relocation attention rows, display-only; experience parity deliberately `partial` `91%` at that initial post-install measurement — the engineer/orchestrator hook-bearing upgrades version-invalidated the four-plugin `/hooks` attestation `settings-20260712T015100Z-312fbb`; the same-day fresh attestation `settings-20260713T030937Z-f50815` and post-attestation record `doctor-20260713T030956Z-20dcc3` restored `ready` `100%` 8/8 with all three execute proofs re-passed both directions; `host_parity_baseline` `current` against the 2026-07-11 baseline). The superseded 0.79.0-native 2026-07-12Z four-persona-seam record (doctor-20260712T080638Z-005af5, release tag plugin-runtime-v0.79.0, sync 8ca4651 — backticks deliberately omitted for the freshness gate) read `ready` `100%` 8/8 with that attestation then current, since runtime ships no hooks and the 0.79.0 upgrade left the hook-bearing set unchanged. The superseded 2026-07-11Z attention-relocation record `doctor-20260711T045954Z-731e34` (then-installed runtime 0.78.1) also read `ready` `100%` 8/8, with an honest baseline-stale caveat the same-day #550 refresh closed; before it the 0.78.1-native 2026-07-10Z record `doctor-20260710T153802Z-276226` (Claude Code `2.1.206`, tag plugin-runtime-v0.78.1 — backticks deliberately omitted for the freshness gate; hook state `14/14` `enabled_trusted`, `unexpected=0`, `unmapped=1`; five-plugin re-attestation `settings-20260710T153728Z-5796b6`) read experience parity **deliberately** `partial` `95%` 7/8 — that release's command-portability gate held `lifecycle_hook_continuity` `partial` with `command-warnings=attention` until the relocation landed, while the bidirectional proof surfaces themselves all passed. The superseded 0.78.0 record `doctor-20260710T135955Z-d752f5` read `ready` `100%` 8/8 under the pre-#543 criterion; before it, the 0.77.2 record `doctor-20260710T044745Z-1a789e` (same host versions, parity `ready` `100%`) honestly read `stale` on baseline freshness at measurement time; the same-day baseline-refresh slice closed it. The intermediate 0.77.0 record `doctor-20260709T131625Z-33c54d` read `partial` `91%` because doctor mis-read the newly-trusted designer hooks as disabled; the classifier fix released as 0.77.1 restored `ready` `100%`. Both `claude -> codex` and `codex -> claude` passed the permission proof, deep peer smoke, and engineer workflow continuation proof through `state.mjs create`, `dispatch-peer.mjs`, `pending_ensemble`, and `ensemble_results` in an ephemeral temp repo. | satisfied | Keep the explicit installed-runtime proof in the release/install continuity loop whenever the peer path changes. |
| R4 | Claude Code and Codex user experience must be equivalent where possible; non-portable host-specific features must not become hard dependencies. | Architecture documents host-specific adapter boundaries; runtime baseline documents command/hook/subagent differences; Codex macro/meta skill mirrors exist. The native `runtime:doctor` execute proofs re-recorded under the 0.77.1 install on 2026-07-09 (`doctor-20260709T141930Z-515ebf`, Claude Code `2.1.205` / Codex `0.143.0`, runtime `0.77.1` on both hosts) confirmed bidirectional peer execution and engineer workflow continuation passed both directions, and `runtime:settings` reports source/cache version parity with zero plugin-management config writes planned. Installing designer `0.2.0` grew the hook-bearing set to `designer@0.2.0`/`engineer@0.20.0`/`orchestrator@0.12.0`/`founder@0.3.0`, invalidating the 2026-07-04 attestation `settings-20260704T170801Z-b66656` and requiring a fresh Codex `/hooks` review — which in turn exposed the doctor hook-state defect fixed in 0.77.1 (an absent `enabled` key means enabled, not disabled), after which `~/.codex/config.toml` hook-state reads `12/12` `enabled_trusted` (`untrusted=0`/`disabled=0`/`missing=0`) and the attestation `settings-20260709T141913Z-8b7122` covers all four bundled plugins; At that 0.77.1-era measurement `attention@0.4.0` was still read as a deliberately Claude-hook-only plugin (`claude_adapter_only`, excluded from the Codex sets) and `image` ships no Codex hooks manifest, so observed experience parity then read `ready` (score `100%`, 8/8 satisfied) per this row's gate — a record superseded by the #543 host-truth fold (its 0.78.1 proof read **deliberately** `partial` `95%` with `command-warnings=attention`) and restated by the 2026-07-11 attention relocation install proof `doctor-20260711T045954Z-731e34`: attention `0.4.1` supplies zero Codex hook surface (machine-proven `not_packaged` on the installed cache), the four-plugin attestation `settings-20260711T045915Z-5ca22a` reads current, and observed experience parity is back to `ready` (`100%`, 8/8) per this row's gate — the honest `host_parity_baseline` `stale` caveat (Claude Code `2.1.207` patch drift) was closed by the same-day #550 baseline refresh, and the 0.79.0-native 2026-07-12Z four-persona-seam record (`doctor-20260712T080638Z-005af5`; attestation `settings-20260712T015100Z-312fbb` still current, since runtime ships no hooks and the hook-bearing set is unchanged) re-confirms `ready` (`100%`, 8/8) with the baseline `current` — while the 0.80.0-native 2026-07-13Z S9 completion-output-contract record (`doctor-20260713T025136Z-7758d3`) reads observed parity **deliberately `partial` `91%`** per this row's own gate: the engineer `0.21.0` / orchestrator `0.13.0` hook-bearing upgrades version-invalidated that attestation, and parity was not claimed `ready` until the post-attestation evidence landed (hook trust entries themselves read `12/12` `enabled_trusted`; no hook file changed in this release). The operator's same-day `/hooks` confirmation produced the fresh four-plugin attestation `settings-20260713T030937Z-f50815` (designer@0.2.1 / engineer@0.21.0 / founder@0.3.1 / orchestrator@0.13.0), and the post-attestation record `doctor-20260713T030956Z-20dcc3` restores observed parity to `ready` (`100%`, 8/8, zero manual follow-ups) per this row's gate, with all three execute proofs re-passed both directions. The same discipline repeated for the attention `0.7.0` release (2026-07-20Z): the freshness-recovery record `doctor-20260720T105456Z-e1f9a9` deliberately read `partial` `91%` while the pre-S8a4 attestation stayed stale (`codex_cli_version_changed`), and only after the operator's `/hooks` confirmation and the fresh CLI-version-bound attestation `settings-20260720T151554Z-3b543f` did the post-attestation record `doctor-20260720T151637Z-e2e061` claim `ready` (`100%`, zero manual follow-ups, all three execute proofs re-passed both directions). The complementary no-invalidation case landed with the attention 0.7.1 / runtime 0.83.1 S9-hardening install (2026-07-20Z, `doctor-20260720T175310Z-a0fd88`): zero Codex hook-surface change — the patch touched only attention's Claude-side Stop-seam spawns and runtime ships no hooks — with the four-plugin attested set and `codex-cli 0.144.6` both unchanged kept `settings-20260720T151554Z-3b543f` current, so observed parity read `ready` (`100%`, 8/8) end-to-end with no fresh `/hooks` review required; the attestation-refresh discipline includes not forcing a refresh when the currency binding still holds. The ADR-0047 Release B install (2026-07-22Z, `doctor-20260722T012908Z-472538`, runtime 0.85.0 + attention 0.9.0) was the fail-closed case again: the Codex CLI `0.144.6`→`0.145.0` minor bump version-invalidated `settings-20260720T151554Z-3b543f` (`currency_reason=codex_cli_version_changed`) even though no hook-bearing plugin changed — runtime ships no hooks, attention `0.9.0` altered only the Claude hook surface, and the four attested plugins (designer@0.3.0 / engineer@0.21.0 / founder@0.4.0 / orchestrator@0.13.0) are unchanged with the Codex hook entries still `12/12` `enabled_trusted` — so the install proof `doctor-20260722T012908Z-472538` was recorded **`partial` `91%`** and `ready` was not claimed without post-attestation evidence. The operator's `/hooks` confirmation then produced the fresh attestation `settings-20260722T021211Z-364c8f` (`bound_versions.codex=0.145.0`) and the post-attestation record `doctor-20260722T021258Z-4c7514` restored observed parity to **`ready` `100%` 8/8** (zero manual follow-ups, all three execute proofs re-passed both directions) — the discipline upheld end-to-end: the CLI-version currency binding refused the stale attestation, and `ready` was claimed only after the fresh CLI-version-bound attestation and post-attestation proof landed. The ADR-0048 runtime 0.86.0 install (2026-07-23Z, `doctor-20260723T124714Z-a2e2e0`) then repeated the no-invalidation case: runtime ships no hooks and no hook-bearing plugin changed, so `settings-20260722T021211Z-364c8f` stayed current and observed parity read `ready` (`100%`, 8/8, zero manual follow-ups) end-to-end with no fresh `/hooks` review required. | satisfied | Refresh the active-session `/hooks` review/trust attestation after hook-bearing plugin upgrades or hook packaging changes; do not claim observed parity `ready` until the post-attestation doctor/cutover evidence is recorded. |
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
