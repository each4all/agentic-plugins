# ADR-0017: Stage 2.5+ continuity and schema roadmap

## Status

Accepted (2026-05-06; merged via [PR #40](https://github.com/each4all/agentic-plugins/pull/40), main commit `27fb308`). Adoption of this ADR records the *roadmap* — sub-decision implementations follow per-trigger acceptance criteria defined in §"Decision" and ship in their own PRs when triggers fire.

## Context

[ADR-0011](0011-workflow-continuity-storage.md) intentionally deferred several
continuity-protocol features to keep Stage 2 storage scope narrow and high
quality. The Stage 2.5+ exit validation audit
([docs/audits/2026-05-06-stage25-exit-validation.md](../audits/2026-05-06-stage25-exit-validation.md))
identified those deferred items as load-bearing for `omcc` and
`codex-plugin-cc` removal: without them, removal would regress users on
workflow-management UX (no resume, no auto-archive, no checkpoint, no
machine-parsable ensemble history).

The audit's Codex plan-verify ensemble flagged a meta concern about over-
fragmentation: splitting these into two separate ADRs (originally proposed
as 0017 meta-commands + 0018 frontmatter persistence) would scatter what
ultimately is one schema-extension decision. Per the Codex catch ("ADR-0011
already owns storage schema and non-goals; bundling Stage 2.5 continuity
extensions under one ADR avoids drift between them when one ships and the
other defers"), this ADR consolidates the continuity and schema roadmap
into one decision record with five sub-decisions.

In scope:

1. **Meta commands** (`/engineer:resume`, `/engineer:checkpoint`,
   `/engineer:peer-now`) — ADR-0011 §Stage 2 Non-Goals item 6 deferred
   these as separate commands. Resume is currently implicit via §5
   append-on-resume; checkpoint/audit semantics absorbed into the 6 verbs
   per [ADR-0010](0010-plugin-boundary-policy.md).
2. **`ensemble_results` frontmatter persistence** — Stage 2 stores
   ensemble outcomes only as Markdown body phase notes (prose), preventing
   programmatic retrospective query and retention enforcement.
3. **Stop hook auto-archive semantics** — ADR-0011 line 335 explicitly
   states "The Stop hook does NOT auto-archive". The future-ADR placeholder
   at ADR-0011 line 341 ("A future ADR (post-Stage 2) may add automatic
   archival") is this ADR.
4. **Schema 1.x bump policy** — additive frontmatter fields preserve
   schema 1.0 reader compatibility while emitting new fields when present.
5. **Cross-host transition guarantees, narrow subset only** — same-file
   resume across hosts works in practice (ADR-0011 §Stage 2 Non-Goal 3
   notes); this ADR does NOT promise full cross-host parity (that
   remains Stage 2.5+ scope per ADR-0011 Non-Goal 3).

This is a **roadmap**, not an implementation specification. Each item
ships in its own implementation PR. See "Decision" for per-item
acceptance trigger / implementation owner PR / validation command —
the explicit per-trigger pacing addresses the Codex plan-verify risk
that "Proposed ADRs only proliferate while implementation is deferred,
producing documentation drift".

## Decision

Stage 2.5+ extends ADR-0011's storage to include the following five
sub-decisions. Adoption of this ADR does **not** imply implementation;
each sub-decision becomes load-bearing only when its acceptance trigger
fires. This separation prevents Proposed-ADR drift.

### Sub-decision 1: `/engineer:resume` command

- **Acceptance trigger**: 3+ stale workflow files accumulate in any
  user's `.claude/agentic-engineer/workflows/` (audit count surfaced
  via SessionStart suffix), OR a user-reported case of "I have a stale
  workflow file and don't know how to resume / archive it".
- **Implementation owner PR**: separate
  `feat(plugins/engineer): /engineer:resume`.
- **Validation command**: new test
  `tests/engineer/test-resume.mjs` covering (a) find-active workflow
  + drift report (clean / dirty), (b) archive with confirmation,
  (c) no-active edge case ("no active workflow; nothing to resume").
- **Out of scope**: drift classification 4-tier (clean / compatible /
  conflicting / rewound). Defer to Stage 3+ trigger when same-file
  cross-host transition surfaces an actual reconciliation case.
- **Status**: **Implemented** (2026-05-07) — `commands/resume.md` thin
  shim over `state.mjs` with the four documented outcomes (single
  active / multi-active / no active / archive). Trigger satisfied by
  user explicit request as part of the ADR-0017 sub-decisions
  1+2+3+4+5 combined-implementation workflow (per the trigger-driven
  multi-fire pattern). Ships in PR2 of the 5-PR stack on top of PR1
  (ADR-0017 PR1 / `feat(plugins/engineer): schema 1.1 reader +
  ensemble bookkeeping helpers`, commit `67ca92a`). Validation
  artifact: `tests/engineer/test-resume.mjs` (15 tests, all green).

  **Cascade (ADR-0018 §sub-2, 2026-05-08)**: the "multi-active"
  outcome is renamed *per-branch duplicate*. The single-active
  invariant is per-branch (resolved via `git branch --show-current`),
  not directory-wide; cross-branch workflow coexistence is normal
  Stage 3+ behavior. The four documented outcomes therefore become
  **single active on this branch / per-branch duplicate / no active
  workflow / archive**. `commands/resume.md` Phase 1's per-branch
  duplicate branch lists every candidate file with its
  `git_baseline.branch` so the user can distinguish the corrupt
  same-branch row from coexisting parallel-branch rows.

### Sub-decision 2: `/engineer:checkpoint` command + `latest_checkpoint` field

- **Acceptance trigger**: first Stage 3+ deliverable that takes 3+
  working days (Stage 2 deliverables completed within 1 day each, so
  checkpoint had no measurable value yet).
- **Implementation owner PR**: separate
  `feat(plugins/engineer): /engineer:checkpoint + schema 1.1 latest_checkpoint`.
- **Schema bump**: `latest_checkpoint: { at: ISO-8601, summary: string }`
  optional field in workflow frontmatter. Schema-1.0 readers tolerantly
  ignore the field (additive, non-breaking). SessionStart hook
  re-injects the summary on resume.
- **Validation command**: `tests/engineer/test-checkpoint.mjs` covering
  set, read, and SessionStart re-injection of summary.
- **Status**: **Implemented** (2026-05-07) — `commands/checkpoint.md`
  thin shim over `state.mjs setCheckpoint` + SessionStart re-injection
  via `adapters/claude/hooks/session-start.mjs` reading the
  `latest_checkpoint` frontmatter. `setCheckpoint` preserves the
  on-disk schema marker bidirectionally (legacy schema=1 files stay at
  schema=1 even after the new field is written; new files emit
  schema='1.1'). Trigger satisfied by user explicit request as part of
  the ADR-0017 sub-decisions 1+2+3+4+5 combined-implementation
  workflow. Ships in PR3 of the 5-PR stack (`feat(plugins/engineer):
  /engineer:checkpoint + schema 1.1 latest_checkpoint emit`,
  commit `dabd898`, merge `304e3d9`). Validation artifact:
  `tests/engineer/test-checkpoint.mjs` (all green).

### Sub-decision 3: `/engineer:peer-now` command

- **Acceptance trigger**: user explicitly requests ad-hoc peer
  consultation in a non-ensemble context (outside a verb's natural
  ensemble dispatch). Surfaces as a feature-request issue or sustained
  inline request pattern.
- **Implementation owner PR**: separate
  `feat(plugins/engineer): /engineer:peer-now`.
- **Validation command**: `tests/engineer/test-peer-now.mjs`. Reuses
  `plugins/engineer/scripts/dispatch-peer.mjs` envelope validation;
  adds verbatim prompt pass-through plus synthesis label `[Peer]`
  injection in the workflow body.
- **Codex CLI commands schema dependency**: this command's
  auto-trigger from the Codex side inherits the
  [ADR-0013](README.md#index) (reserved) blocker. Manual invocation
  works on both hosts in the meantime.
- **Status**: **Implemented** (2026-05-07) — `commands/peer-now.md`
  thin wrapper over `dispatch-peer.mjs` (verbatim mode is the existing
  generic-wrapper behaviour; no script change was needed). The peer's
  response is appended under a `[Peer] $PEER consultation` label phase
  note via `state.mjs append` without `--current-phase` /
  `--next-action` (peer-now is a side-channel that does not advance
  phase). Excluded from `ensemble_results` by design — mirrors
  omcc-dev's `Result Bookkeeping exclusion` for `codex-now`. Trigger
  satisfied by user explicit request as part of the combined-
  implementation workflow. Ships in PR5 of the 5-PR stack (commit c1
  of `feat(plugins/engineer): /engineer:peer-now`). Validation
  artifact: `tests/engineer/test-peer-now.mjs`.

### Sub-decision 4: `ensemble_results` frontmatter persistence

- **Acceptance trigger**: first retrospective ensemble-quality query
  requiring programmatic parsing (e.g., "how often did Codex agree vs
  disagree across our verbs over the last month?"). Currently
  impossible because results are prose phase notes only.
- **Implementation owner PR**: separate
  `feat(plugins/engineer): ensemble_results schema 1.1 frontmatter`.
- **Schema bump**: `ensemble_results: list of {phase, ensemble_type,
  run_id, verdict, summary, completed_at, codex_session_id}` optional
  field. Retention cap `N=20` (oldest evicted on append). Three-step
  atomic mutation: (1) pop matching `pending_ensemble`, (2) append
  result, (3) prune to retention cap. Pattern mirrors omcc-dev's
  `continuity-protocol.md §Result Bookkeeping` (referenced in
  [docs/audits/2026-05-06-stage25-exit-validation.md](../audits/2026-05-06-stage25-exit-validation.md)
  Q6 G-3).
- **Validation command**: `tests/engineer/test-ensemble-results.mjs`
  covering append, retention-cap eviction, atomic 3-step mutation,
  and parse-tolerant fall-back for schema-1.0 readers.
- **Status**: **Implemented** (2026-05-07) — `state.mjs` exposes
  `recordPendingEnsemble` / `commitEnsemble` / `pruneEnsembleResults`
  helpers + `ensemble-pending` / `ensemble-commit` CLI subcommands
  (PR1 `67ca92a`); `dispatch-peer.mjs` accepts a four-flag
  bookkeeping bundle (`--workflow-path` / `--phase` /
  `--ensemble-type` / `--run-id`) that records a `pending_ensemble`
  entry under the workflow file's per-file lock BEFORE the companion
  spawns. Each of the six command-mode verbs (`compose` / `refine` /
  `frame` / `decide` / `critique` / `investigate`) was wired to
  generate a stable `RUN_ID` before dispatch and to invoke
  `state.mjs ensemble-commit` after synthesis (atomic three-step
  mutation: pop pending → append result → prune to N=20).
  `codex_session_id` is recorded as `null` for now (companion contract
  envelope does not surface it as of `companions/contract.md` v0.1.1
  — F-X10 PEER-ONLY, caller-side parsing deferred to a future trigger
  rather than expand the contract). Trigger satisfied by user
  explicit request as part of the combined-implementation workflow.
  Ships in PR5 of the 5-PR stack (commit c2 of
  `feat(plugins/engineer): ensemble_results frontmatter wiring`).
  Validation artifact: `tests/engineer/test-ensemble-results.mjs` (9
  integration cases) + the existing unit-level coverage in
  `tests/engineer/test-state.mjs` lines 629/680/738.

### Sub-decision 5: Stop hook auto-archive semantics

- **Acceptance trigger**: sustained user complaint about workflow-file
  accumulation (5+ stale workflow files survive a single session), OR
  sub-decision 1 (`/engineer:resume`) ships and reveals that manual
  archival remains painful.
- **Implementation owner PR**: separate
  `feat(plugins/engineer): Stop hook auto-archive`.
- **Required machinery** (instantiates ADR-0011 line 341's "decision
  protocol that mirrors omcc-dev's A1-A4 conditions" placeholder):
  - **Terminal phase whitelist**: `current_phase ∈
    {commit-complete, summary-complete, fix-complete}` (whitelist
    defined per workflow type — `start` / `fix` / `audit`).
  - **Head-moved verification**: `git rev-parse HEAD` differs from
    `git_baseline.head` recorded at workflow creation.
  - **Conventional commit subject** (omcc-dev's A3, optional gate):
    if HEAD's commit subject matches
    `^(feat|fix|docs|chore|refactor|test|ci)(\(.+\))?:`, additional
    confidence; otherwise still allow archive but emit a warning to
    stderr.
  - **No active children** (omcc-dev's A4): if `child_completions[]`
    has any entry without `commit:` and `closed_at:` recorded, do NOT
    archive.
  - **False-positive defense (REQUIRED)**: explicit
    `terminal_marker: true` workflow frontmatter field MUST be set
    (by the user or by the terminal-phase write step) before
    auto-archive triggers. Default off — addresses Codex plan-verify
    audit risk: "current_phase is free-form, git HEAD movement may be
    an intermediate commit, not workflow completion".
- **Validation command**: `tests/engineer/test-stop-archive.mjs`
  covering: (a) all conditions met → archive; (b) `terminal_marker`
  unset → no archive (default off); (c) head moved but no terminal
  marker → no archive; (d) active children present → no archive;
  (e) terminal phase outside whitelist → no archive.
- **Status**: **Implemented** (2026-05-07) — `runStopArchive` in
  `plugins/engineer/scripts/stop-archive.mjs` orchestrates a
  pure-evaluable four-gate check (terminal_marker, terminal-phase
  whitelist, HEAD-moved, no active children) plus the soft
  conventional-commit warning gate; the Claude `Stop` hook and Codex
  manual-invoke `stop.mjs` both call it under the same contract. The
  six command-mode verbs (`compose` / `refine` / `frame` / `decide` /
  `critique` / `investigate`) wire the X1 atomic terminal write
  (`state.mjs set-terminal --terminal-phase summary-complete
  --terminal-marker true`) immediately after their Phase 1 phase-note
  append, so a session that ends with a real `git commit` after a
  verb's synthesis triggers archive automatically. Trigger satisfied
  by user explicit request as part of the ADR-0017 sub-decisions
  1+2+3+4+5 combined-implementation workflow (per the trigger-driven
  multi-fire pattern). Ships in PR4 of the 5-PR stack on top of PR1
  (schema 1.1 reader). Validation artifact:
  `tests/engineer/test-stop-archive.mjs` (20 tests covering 11 pure
  evaluation cases + the five ADR-required scenarios + the
  conventional-commit warning case + Codex parity + idempotency, all
  green).

### Schema versioning policy

`SCHEMA_VERSION` in `plugins/engineer/scripts/state.mjs` bumps to
`1.1` when sub-decisions 2 or 4 ship their frontmatter field for the
first time. Older (1.0) readers tolerantly ignore unknown fields —
this is already the empirical behavior, asserted by
`tests/scripts/test-state.mjs` round-trip; sub-decisions 2/4 add
explicit unknown-field tolerance assertions for the new fields.

Schema 2 (sharded layout, multi-active, drift classification 4-tier)
remains explicitly out of scope of this ADR. Those are Stage 3+ work
per ADR-0011 Non-Goals 1, 2, 5 and surface as their own ADR if and
when triggered.

## Consequences

**Positive**:

- omcc-dev removal stops being blocked by "what about
  resume/checkpoint/auto-archive?" user-expectation regression — there
  is now a documented forward path with explicit per-item triggers.
- Each sub-decision has a single-PR scope, making review tractable.
- Schema 1.1 bump is additive; engineer adapter writers (and future
  designer-adapter writers) can implement sub-decisions in any order.
- Documentation drift risk (Codex plan-verify catch) is mitigated by
  per-sub-decision acceptance criteria — Proposed status does not
  pretend a feature exists.
- Stop auto-archive false-positive risk (Codex plan-verify largest
  flagged behavior risk) is mitigated by explicit `terminal_marker`
  field — default off.

**Negative**:

- Five trigger-only sub-decisions mean five delayed UX wins. Until
  triggers fire, users still feel the omcc-dev gap. Mitigation:
  trigger #1 (3+ stale workflow files) auto-satisfies for any
  sustained Stage 3 user; trigger #4 (retrospective ensemble query)
  auto-satisfies within a few weeks of regular dogfood.
- Schema 1.1 fields require parser tolerance from older readers; if a
  future tool forgets to ignore unknown fields, regression risk.
  Mitigation: `tests/scripts/test-state.mjs` already exercises
  unknown-field tolerance; sub-decisions 2/4 extend coverage.

**Neutral**:

- This ADR does not change Stage 2 behavior. Existing Stage 2
  workflows continue to use schema 1.0; deferred behaviors stay
  deferred until triggers fire.
- The five-item bundling reduces ADR count vs the originally proposed
  split (0017 + 0018), aligning with the Codex plan-verify
  recommendation.

## Alternatives Considered

### A. Split into two separate ADRs (0017 meta-commands + 0018 ensemble_results frontmatter)

Originally proposed in the audit's plan. The Codex plan-verify
catch: "both ultimately bump the same schema and live under
ADR-0011's storage roof; bundling under one ADR avoids drift between
them when one ships and the other defers". Adopting the catch — single
ADR-0017 with five sub-decisions.

### B. Direct ADR-0011 Amendment

Considered, but ADR-0011's Decision-section prose ("Stage 2 storage
scope") remains operatively accurate — the items here are Stage 2.5+
extensions, not Stage 2 corrections. The Amendment vs new-ADR
discriminator (README.md §Amendments) favors a new ADR for new scope.
A follow-up ADR-0011 Amendment will add a cross-reference pointer to
this ADR once this ADR is Accepted.

### C. Issue tracker only

Rejected. The items are decisions about persistent schema and
behavioral semantics, not implementation TODOs. ADRs preserve
decision context across implementation handoffs (Stage 3 designer
will need the rationale for these triggers when designing its own
workflow-continuity surface).

### D. Implement now, no triggers

Rejected. ADR-0011 §Honest scope requires Stage 2 ships at the
documented quality bar. Adding five features without empirical user
pain (no triggers fired) would violate honest-scope and risks
half-finished surfaces under PR-deadline pressure. Per-trigger pacing
keeps each implementation focused on actual user value at the moment
the work happens.

### E. Bundle Stop auto-archive (sub-decision 5) under sub-decision 1

Rejected. Stop auto-archive is hook-level (event-driven) decision
machinery; `/engineer:resume` is user-driven command machinery. Their
state-machine semantics differ — auto-archive needs terminal markers
+ children semantics; resume needs find-active + drift report. Codex
plan-verify catch: "auto-archive false-positive is the largest
behavior risk". Keeping it as a separate sub-decision with its own
trigger discipline minimizes that risk and keeps PR scope honest.
