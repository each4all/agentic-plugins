# ADR-0060: Remove host-version compatibility tracking — the baseline, the compat command, and the drift gate

## Status

Accepted (2026-09-18). Supersedes
[ADR-0026](0026-runtime-compatibility-drift-and-release-notes.md) and
[ADR-0051](0051-host-parity-baseline-source.md) in full — their subject is
removed, not re-decided — and amends
[ADR-0047](0047-notify-attention-gating-gc.md) §5 and §7 and
[ADR-0052](0052-release-obligation-enforcement.md) §Decision 1. Docs-only; an
implementation subtask executes the manifest below.

Amended 2026-09-28 by that implementation: see
[§Amendment 2026-09-28](#amendment-2026-09-28--what-the-implementation-measured),
which corrects Decision 1's neutral-module line, Decision 5's "tests
untouched" claim and the Neutral consequence, and records the schema contract.

Supersession was atomic with acceptance (the ADR-0056 §Decision 9 rule): the
change that flipped this ADR to `Accepted` flipped both superseded ADRs' wording
with it.

## Context

`runtime:compat` and `plugins/runtime/docs/host-parity-baseline.md` exist to
answer one question: *are the Claude Code and Codex CLI versions on this machine
the ones our behavioural claims were checked against?* Everything else in the
subsystem — snapshots, gap analysis, release-note ingestion, update plans, the
twice-daily drift cron, the tracking issue — serves that question.

The owner's decision is that the question is no longer worth its cost. The
measurements behind that, taken 2026-09-16/17:

- **The key moves far faster than the fact it gates.** The baseline was
  refreshed **8 times between 2026-06-03 and 2026-08-28** (roughly every 8–9
  days). Claude took 18 distinct versions at a median 2.1 days apart in the
  window ADR-0056 measured; Codex 7 at a median 10.2 days. The behavioural
  claims the document carries changed materially about once in the same period.
- **A null refresh is not cheap.** The file is one of three protected paths
  under ADR-0052, so even a `+4/-3` stamp edit (`d21a23c`) obliges a release, a
  doc-freshness recovery and a re-recorded doctor proof, and leaves `main` red
  in between.
- **The hit rate is low but not zero.** One refresh in that window produced real
  adoption work: Claude 2.1.233 withdrew the todo/task tools and twenty command
  runbooks across four plugins had to be rewritten. The pre-scan for the current
  window (Claude 2.1.251–2.1.270, Codex 0.151.0–0.154.0) found **zero** confirmed
  adoption items and one unverified question.
- **Machine dependence on the document is one line.** `HEADER_RE` in
  `lib/host-parity-baseline.mjs` parses the `Observed on <date> with Claude Code
  \`x\`, Codex CLI \`y\`` header; no code parses any other section. The remaining
  654 lines are read by people.
- **ADR-0056 already removed one layer built on the same arithmetic** — grants
  bound to version tuples were stale before they shipped — but kept exactness as
  the gate, so the treadmill survived one level down. This ADR removes the gate
  itself.

This ADR accepts the loss that follows: **nothing will notice host drift any
more.** A host change that breaks a surface this repository depends on will be
discovered when the surface breaks, not before.

## Decision

### Decision 1 — The manifest is by identifier, not by the word

`compat` appears in 27 runtime scripts; measured 2026-09-17, most occurrences are
`backward compat` / `forward-compat` / `compatible` in unrelated prose
(`footer.mjs`, `settings.mjs`, `bootstrap.mjs`, `profile-readers.mjs`,
`schema-validate.mjs`, `notify-schema.mjs`, and others). Those must not be
touched — the word is not the scope. The real dependency set is named here.

**Removed in full**

| Path | What it is |
|---|---|
| `plugins/runtime/scripts/compat.mjs` | the command implementation |
| `plugins/runtime/scripts/lib/compat-artifacts.mjs` | gap/plan schema families, status vocabularies, `isReadyCompatState` |
| `plugins/runtime/commands/compat.md`, `plugins/runtime/core/skills/compat/` | the Claude command and Codex skill surfaces |
| `plugins/runtime/docs/host-parity-baseline.md` | 654 lines: parity matrix, probed matrices, failure catalogue, drift policy, version history |
| `plugins/runtime/docs/codex-capability-baseline.md` | 267 lines, the sibling observation document |
| `scripts/check-host-version-drift.mjs`, `.github/workflows/host-version-drift.yml` | the twice-daily drift check and its tracking-issue upsert |
| `tests/runtime/test-compat.mjs`, `tests/runtime/test-compat-schema-era.mjs`, `tests/runtime/test-host-parity-baseline.mjs`, `tests/runtime/test-baseline-consumer-contract.mjs`, `tests/scripts/test-check-host-version-drift.mjs` | the tests of the above |

**Reduced, not removed**

| Module | What goes | What stays |
|---|---|---|
| `lib/host-parity-baseline.mjs` | `resolveHostParityBaseline`, `parseBaseline`, `extractBaselineVersions`, `baselineFailure`, `BASELINE_STATUSES`, `BASELINE_RELATIVE_PATH`, `defaultPluginRoot`, `classifyVersionRelation`, `classifyHostPairRelation`, `VERSION_RELATION_STATES`, `HOST_PAIR_RELATION_STATES`, and `releaseVersion` / `releaseCoreParts` / `compareReleaseCore` (drift-script-only consumers) | `normalizeVersion`, whose surviving consumers are `lib/plugin-manifest.mjs` and `lib/host-version-probe.mjs`; it **moves to a neutrally named module**, because a file named for a deleted document is a misleading home |
| `lib/state-readers.mjs` | the compat-run collection reader and its `runs/compat` paths, `COMPAT_RUN_ID_RE` (no consumer outside the module), and the gap/plan family projections | everything else |
| `scripts/doctor.mjs` | the `host_parity_baseline` check (id, status ladder, evidence, the `baseline-freshness` output line), `compat_runs` in the report, and the `inspectCompatRuns` wiring | the `claude --version` / `codex --version` probes, which keep reporting host versions as facts with no verdict |
| `scripts/cutover-audit.mjs` | the compat freshness check in full — both halves: `isReadyCompatState` over the recorded run, and `doctor.host_parity_baseline` for the live pair | the remaining cutover checks |
| `scripts/dashboard.mjs` | the Tier 2 baseline and compat rows | the rest of both tiers |
| `lib/retention-planner.mjs`, `lib/retention-apply.mjs` | the `compat` entry of `RETENTION_FAMILY_REGISTRY`, its branch of the run-id token pattern, and the family's mentions in the bounds and lock commentary | the `doctor` and `settings` families |

`readVersionToken` and `scanVersionTokens` are an **open item for the
implementation**: their measured consumers are `compat.mjs` (removed) and
`doctor.mjs` (inside the removed baseline check). If no consumer survives they
go; the implementation re-measures rather than assuming.

> **Amended 2026-09-28.** The re-measure found no survivor for `normalizeVersion`
> either, so no neutral module was created and `lib/host-parity-baseline.mjs` was
> deleted in full, not reduced. See §Amendment 2026-09-28 (a).

### Decision 2 — The probed knowledge is deleted, not relocated

The document's locally measured content — the Claude `SessionStart` matrix
(probed 2026-07-18), the Stop-payload matrix (probed 2026-07-21), and the
permission-mode enumeration read out of the 2.1.248 binary — is **deleted with
the file**, rather than moved to an undated reference.

This is the sharpest cost here and is recorded as such. Those facts are in no
vendor document. `plugins/attention/adapters/claude/hooks/notification.mjs`
branches on `payload.notification_type`, a field whose observed value set is
written down only there. Recovering any of it means running the probe again.
The decision is taken knowingly: the repository keeps the code that consumes
those fields and gives up the written record of what the fields contained.

### Decision 3 — What the surviving surfaces say instead

- **`runtime:doctor`** stops reporting baseline freshness and compat runs, and
  keeps reporting observed host versions with no verdict attached.
- **`runtime:cutover`** loses its compat freshness check entirely. The
  implementation states in the audit output that host-pair identity is no longer
  verified — **an absent check must not read as a passing one.**
- **`runtime:dashboard`** drops its baseline and compat rows.
- **The parity criterion `runtime_handoff_artifacts` (weight 15) is recomposed**
  from `settings + consensus + compat` to `settings + consensus`. Its status
  string, evidence string and `next_step` all name compat today, and its
  `release_notes_required` branch has no subject any more. This changes what the
  criterion measures at unchanged weight, so `runtime-experience-parity` is
  restated and its schema bumped, following the ADR-0056 §Decision 8 precedent.

### Decision 4 — The standing notification watch loses its host

ADR-0047 §5's standing rows — Codex `notify=` payload variants beyond
`agent-turn-complete`, and the Claude `agent_needs_input` / `agent_completed`
notification types — are emitted **only** by `runtime:compat plan`
(`NOTIFICATION_WATCH_ROWS`, ten sites in `compat.mjs`, measured 2026-09-17).
Removing compat removes the watch. ADR-0047 is amended to record that the
mechanism is gone and that the two questions it tracked are now untracked,
rather than leaving an accepted ADR describing a feature that no longer exists.

### Decision 5 — The protected-path list drops to two

`scripts/check-release-obligation.mjs` `PROTECTED_PATHS` loses
`plugins/runtime/docs/host-parity-baseline.md`; `data/plugin-set.json` and
`data/schemas` remain. The mechanism, its tests and ADR-0052's reasoning are
untouched — only the list shrinks, so ADR-0052 is amended rather than superseded.

> **Amended 2026-09-28.** "Its tests are untouched" is false, and the list
> shrinks one release later than this paragraph implies. Removing the entry
> fails 21 of the 48 release-obligation tests, and removing it in the change
> that deletes the file would hide that deletion from the gate. See
> §Amendment 2026-09-28 (b). The mechanism and ADR-0052's reasoning are still
> unchanged.

### Decision 6 — Historical artifacts and records are not rewritten

Recorded compat runs under `.agentic-plugins/runs/compat/` are local, gitignored
state; they are orphaned rather than deleted, and retention no longer manages
them. Evidence records, grant reviews, changelog entries and the cutover
scorecard keep every historical statement they made: they record what was true
when written. Prose that describes the subsystem in the **present tense** is
corrected to the past tense in the same PR as the removal.

### Decision 7 — This ADR is docs-only

Implementation lands as its own subtask carrying the manifest above, a per-row
disposition for the six `follow-ups.md` rows that cite the baseline, and the
doctor report schema change with its reader. The `main`-red window ADR-0052
describes applies one final time, because a protected path is edited on the way
out.

## Consequences

**Positive.** The 8–9 day refresh treadmill ends, with its release + recovery
loop, its by-design red PRs, and the twice-daily failing cron. Issue
[#388](https://github.com/each4all/agentic-plugins/issues/388) closes because its
subject is gone. Macro `23c112` loses its baseline subtask, and its accumulated
`plugin-runtime` release can ship immediately with three entries.

**Negative.** Nothing detects host drift. The probed matrices and the
binary-read permission enumeration are lost and cost a probe each to recover.
`runtime:cutover` can no longer bind a readiness claim to a host pair — the
protection ADR-0056 §Decision 6 explicitly declined to delete. This ADR reverses
that judgement with the cost stated rather than argued away. The ADR-0047 §5
watch questions become untracked.

**Neutral.** `runtime:doctor` keeps reporting host versions, so the raw
observation survives and only the verdict goes. The version grammar survives
under a neutral module name. The release-obligation mechanism survives with a
shorter list.

> **Amended 2026-09-28.** The version grammar did not survive: nothing read it
> once the baseline check was gone (§Amendment 2026-09-28 (a)). Doctor reports
> the probed `--version` text as it is.

## Alternatives Considered

**C — trim the narration, split the stamp from the claims.** Keep the probed
matrices, the runtime implications and the header; cut the per-version changelog
prose; give each evidence command its own `verified_at`, so a null re-observation
becomes a one-line edit. Rejected by the owner: it keeps the subsystem and its
maintenance surface.

**A′ — drop the gate, keep the knowledge.** Remove the freshness verdict from
doctor/cutover/dashboard and demote both documents to undated reference files
outside the protected set. Rejected by the owner: the documents themselves are
what was judged unnecessary.

**D — keep everything, stop re-observing.** Zero work, but doctor reports `stale`
forever, #388 stays open and the cron keeps failing — a permanently red signal
nobody acts on, which is worse than either keeping or removing the check.

**Baseline only, with compat kept.** The original framing of this option.
Rejected on measurement: without a baseline there is nothing for `check` to
compare against, so `check`, `ingest-release-notes` and `plan` become hollow and
`compat` collapses into a version recorder.

## Amendment 2026-09-28 — what the implementation measured

The implementation re-measured the Decision 1 manifest before deleting anything,
as that decision asks. Eight findings change or add to what the sections above
say. They are recorded here, with a note at each section they correct.

**(a) No version grammar survives.** Decision 1 kept `normalizeVersion` for two
consumers, `lib/plugin-manifest.mjs` and `lib/host-version-probe.mjs`. The first
only named it in a comment; its own shape check is `semver.mjs`'s. The second
had one importer, doctor's removed baseline check. So both libraries are
deleted, `readVersionToken` and `scanVersionTokens` go with them (the Decision 1
open item), and no neutral module exists. Two test files outside the Decision 1
list follow their subjects: `tests/runtime/test-host-version-comparator.mjs` is
deleted, and `test-host-plane-hardening.mjs` loses its version-token and
dated-header `describe`s. Surviving properties that the deleted suites tested
were moved first: the plugin-manifest readers (their only coverage) to a new
`test-plugin-manifest.mjs`, and path containment, byte-exact artifact reads, the
statusline shim and the cutover remediation fallback to the suites of the
modules that own them. At deletion, 17 files and 7,466 lines were removed;
Decision 1's in-full list accounts for 6,480 of them.

**(b) The protected-path list shrinks in two steps, and its tests change.**
Measured in a scratch clone: dropping `host-parity-baseline.md` from
`PROTECTED_PATHS` fails 21 of the 48 release-obligation tests. Sixteen synthetic
fixtures used the baseline as their protected specimen. Four real-history
replays anchor on the `16b1833` counterexample, whose only protected change was
the baseline, and none of the 15 real changes to the two remaining paths can stand in for it,
because none had another release between the change and its tag. One identity
test pins the list itself. Dropping the entry in the change that deletes the
file has a worse effect: both sides of the comparison are read through the
list, so the gate would report `fulfilled` while the newest release still ships
the file. Therefore:

- This change **keeps** the entry. The deletion is outstanding debt until the
  next `plugin-runtime-v*` tag carries it. That is the red window Decision 7
  names, and keeping the entry is what makes Decision 7 true.
- `classify`, `protectedEntries` and `protectedChangesInWindow` take an optional
  path list that defaults to `PROTECTED_PATHS`, and the report names the list it
  used. The replays pass the three-entry list of their time, so they keep
  testing what `16b1833` was. The synthetic fixtures moved to a schema specimen,
  and the CLI tests, which always judge through the live list, re-anchored on
  `f795085`, a schemas-only protected change.
- The release that ships the deletion removes the entry in its recovery, with
  the identity test's expectation. Nothing else changes then.

**(c) Schema contract.** Every change below is a deletion, so each version moves
and each reader states what it accepts.

| Surface | Before | After | What the reader does |
|---|---|---|---|
| `runtime:doctor` artifact / report | `runtime-doctor-artifact-1.2` / `runtime-doctor-1.2` | `1.3` / `1.3`: `host_parity_baseline` and `compat_runs` removed | doctor and dashboard both accept the matched pairs `1.0` to `1.3`, in the same release as the producer (the ADR-0056 and ADR-0057 precedent). The removed sections in older retained artifacts are left unread, not projected as history |
| `runtime-experience-parity` | `1.1` | `1.2`: `runtime_handoff_artifacts` is `settings + consensus` at weight 15, blocked if either collection is blocked, partial if either is missing | not persisted separately; rides the doctor report |
| `runtime:dashboard` | `runtime-dashboard-2.0` | `3.0`: `tier2.baseline` and `tier2.compat` removed | computed fresh on every run, so no historical corpus needs a reader |
| retention planner | `runtime-retention-planner-1.0` | `1.1`: the registry is `doctor` and `settings` | the planner version is part of the plan hash, so applying a plan reviewed under 1.0 is refused as `plan-hash-mismatch`, and the new plan's version field says why |
| `runtime:cutover` report | unversioned | the compat check leaves `checks[]`; `observations.host_pair_identity`, a `limits` entry and `completion_audit.unverified_scope` state that host-pair identity is not verified | the identity statement is not a `missing_or_weak` blocker, because no operator action could clear it; `ready_candidate` is unaffected, and tests pin both. The scorecard check gains a `withdrawn` status, see (h) |

**(d) Skew rule.** Accepting every older artifact in the new reader protects
one direction only. Both hosts read the same `.agentic-plugins/runs/doctor/`, so
a 1.3 proof recorded on one host while the other still runs the previous
runtime is `malformed` to that host's doctor, and its dashboard reports the
doctor row blocked (measured against the 1.2 dashboard reader) until that host
is updated too. Update both hosts, then record the proof.

**(e) Orphaned compat runs.** Recorded runs under `.agentic-plugins/runs/compat/`
stay where they are (Decision 6); 44 exist on the machine that implemented this.
The artifact inventory still reports them as over-cap attention, and its
recommendation, manual review and removal, is the honest remedy now that
retention does not manage the family. `runtime:retention --family compat` is
refused with that reason. A compat retention receipt left open by an apply that
was interrupted before the upgrade cannot be resolved afterwards; it blocks no
other family. The implementing machine's receipt was closed (16 targets
completed).

**(f) The executor guard's network gate is dormant.** `compat.mjs` was the only
network capability importer among the runtime scripts, through its GET-only
release-note fetch. The gate stays in the scanner as generic infrastructure for
the next network importer, and its tests run against an injected registry, so
they still prove the gate works.

**(g) Survivor-scan residual.** Docket C18's class, an unrecognised status read
as a good one, was looked for in the readers that survive. Two have it: the
consensus reader and doctor's settings reader both report an unrecognised
latest-run status as `available`. `runtime_handoff_artifacts` is recomposed onto
exactly those two collections, so it measures readability, not a recognised
successful run, and its comment says so. The review of this implementation
found a second gap in the same consensus reader: it skips an `execution.json`
that fails to parse instead of counting it malformed, so a corrupt consensus
history leaves the criterion `satisfied`, while the settings reader blocks on
the same corruption. Both fixes predate this removal and are recorded in
`plugins/runtime/docs/follow-ups.md`, not made here.

**(h) Scorecard R9 is withdrawn, not satisfied.** R9 of
`docs/assurance/omcc-cutover-scorecard.md` was the owner's requirement to track
host versions and plan compatibility updates from release notes. This decision
removed exactly that, so the row's evidence and gate stopped being true. The
owner decided on 2026-09-28 to record it as `withdrawn`. `runtime:cutover` now
reports a `withdrawn` row apart from both counts: it is not `satisfied`, and it
does not hold readiness, for the reason the host-pair identity statement is not
a blocker. The row stays visible in the completion audit, and every place that
prints the count names the withdrawn rows beside it. Relabelling a row must
not clear it, so a row counts as withdrawn only when its evidence or gate cell
cites an ADR that exists under `docs/adr/`, is Accepted, and has a paragraph
naming the row with a form of "withdraw" (this paragraph is that for R9). An
uncited row is `withdrawn-uncited` and a citation that does not check out is
`withdrawn-unverified`; both stay unresolved, and so does a requirement id
that appears on two rows (`duplicate-id`). The check reads a reviewed
document, so it catches a mistaken relabelling, not a determined one. The
scorecard now reads 11/11 satisfied, with R9 withdrawn by this ADR.
