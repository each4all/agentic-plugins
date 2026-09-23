# ADR-0060: Remove host-version compatibility tracking — the baseline, the compat command, and the drift gate

## Status

Accepted (2026-09-18). Supersedes
[ADR-0026](0026-runtime-compatibility-drift-and-release-notes.md) and
[ADR-0051](0051-host-parity-baseline-source.md) in full — their subject is
removed, not re-decided — and amends
[ADR-0047](0047-notify-attention-gating-gc.md) §5 and §7 and
[ADR-0052](0052-release-obligation-enforcement.md) §Decision 1. Docs-only; an
implementation subtask executes the manifest below.

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
