# Architecture Decision Records (ADRs)

This directory contains the foundational architectural decisions for
agentic-plugins. Each ADR captures one decision with its context, the chosen
direction, and the consequences.

## Format

ADRs follow the standard five core sections, plus a closing `## History`
(below):

1. **Status** — `Proposed`, `Accepted`, `Superseded by ADR-NNNN`, `Deprecated`
2. **Context** — Forces at play and why a decision is needed
3. **Decision** — What was decided
4. **Consequences** — What follows from the decision (positive, negative, neutral)
5. **Alternatives Considered** — What else was on the table and why rejected

See [`template.md`](template.md) for the canonical layout. An ADR ends
with a `## History` section listing its history file's records.

## Current decision and history

An ADR states its decision as it stands now; the dated record of how it
got there lives in a companion file, `history/NNNN-<slug>.md`, with the
same basename ([ADR-0070](0070-adr-current-decision-and-history.md)):

- **The ADR** keeps a short Status (one line per decision when their
  statuses differ), the Context that explains the current decision, the
  operative Decision with every amendment folded in, Consequences and
  Alternatives Considered. Each item an amendment changed carries one
  marker, `*Amended YYYY-MM-DD (subject): [history](history/NNNN-<slug>.md#anchor).*`.
- **The history** holds every dated amendment as written, implementation
  notes, observations, applied cascades, decided "Left to the
  implementation" lists, superseded text and shipped records, in date
  order under `## ` headings. A record is added, never rewritten. It
  exists only once there is history to hold.
- **Citations.** Headings keep their text, so anchors stay stable; a live
  link to a moved heading becomes `history/NNNN-<slug>.md#anchor` in the
  same change. A dated citation (`ADR-NNNN Decision N, amendment of
  YYYY-MM-DD`) stays valid as written. A live `path:line` citation is
  updated; one inside dated text keeps its form.
- **Status** is shown per decision when mixed, and down to the clause
  when folded text depends on a Proposed decision; a migration never
  changes it.
- **Rules move by content.** A rule still in force is stated in the
  Decision text wherever it stood before (an implementation note, an
  observation, the Status); its original record goes to the history.

An ADR moves to this layout when it is next amended or when a subtask
migrates it; until then its in-file amendments stay valid. The index
below holds each ADR's title and status only.

## File naming

`NNNN-<kebab-case-slug>.md` where `NNNN` is a zero-padded sequence
number starting at 0001. Numbers are never reused. To replace a
decision, write a new ADR with `Status: Accepted` that references the
old one, and change the old one's status to `Superseded by ADR-NNNN`.

## Process

1. Copy `template.md` to `NNNN-<slug>.md` (next number)
2. Status starts as `Proposed`
3. Discuss / iterate
4. Merge with `Status: Accepted`
5. To supersede: new ADR + update old ADR's status
6. To amend: fold the change into the ADR's decision text, mark the item
   with its date, and append the record to `history/NNNN-<slug>.md`, in
   one change (§ Current decision and history)

### Amendments vs Supersedes

When an Accepted ADR needs revision, the choice between *Amendment*
(adding to the existing ADR) and *Supersede* (writing a new ADR
that replaces all or part of the old one) follows a single
discriminator:

- **Amendment** — the original Decision-section prose remains
  *operatively accurate* after the change. The Amendment adds
  clarifications, sub-finding additions, or downstream cascades
  that follow from the original Decision. Pattern: ADR-0008's
  Amendments (additive clarifications), ADR-0010's 2026-05-06
  Amendment (downstream cascade from ADR-0014/0015).
- **Supersede** — the original Decision-section prose is
  *no longer operatively accurate*. A reader landing on the old
  ADR must be pointed at the new one for the operative decision.
  Pattern: ADR-0015 supersedes ADR-0014's timeline portion;
  ADR-0014's Decision §1 ("plugin remains installable through
  Stage 3 entry") is reversed.

Partial supersedure is supported: if an ADR's Decision sections
divide cleanly (e.g., capability decision vs timeline), the old
ADR's Status becomes `Superseded by ADR-NNNN (X portion only)` and
the new ADR scopes its supersedure to that portion. ADR-0014/0015
is the precedent.

When in doubt, ask: *does the original Decision-section prose remain
operatively accurate?* If no, write a new ADR (Supersede).

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-hexagonal-architecture.md) | Hexagonal architecture (core / adapter / companion) | Accepted |
| [0002](0002-adapter-contract.md) | Adapter contract — 4 required items | Accepted |
| [0003](0003-mcp-vs-companion.md) | MCP vs companion-CLI — when to use which | Accepted |
| [0004](0004-companion-ownership.md) | Companion ownership — agentic-plugins owns both | Accepted |
| [0005](0005-separate-repo-from-omcc.md) | Separate repo from omcc | Accepted |
| [0006](0006-directory-layout-install-pattern.md) | Directory layout + install pattern | Accepted |
| [0007](0007-migration-cutover-plan.md) | Migration cutover plan from omcc to agentic-plugins | Accepted |
| [0008](0008-companion-distribution-model.md) | Companion distribution model — `companions` plugin + cache-glob discovery + env override | Superseded by [ADR-0061](0061-codex-installs-pinned-to-release-commits.md) — § (b) Codex discovery candidate only |
| [0009](0009-companion-contract-v0-1-1-prompt-file-stdin-precedence.md) | Companion contract v0.1.1 — `--prompt-file` and PROMPT_ARG precedence over stdin | Accepted |
| [0010](0010-plugin-boundary-policy.md) | Plugin boundary policy — 4-layer composition + universal cognitive verbs + naming convention | Accepted |
| [0011](0011-workflow-continuity-storage.md) | Workflow continuity storage — minimal Option III for Stage 2 | Accepted |
| [0012](0012-omcc-removal-preconditions.md) | omcc + codex-plugin-cc removal preconditions | Accepted |
| 0013 | Codex CLI commands integration mechanism (file pending — Stage 3+ trigger) | Reserved |
| [0014](0014-plugins-research-deprecation.md) | plugins/research deprecation — capability folded into plugins/engineer:investigate cited-brief profile | Superseded by [ADR-0015](0015-research-archive-timeline-collapse.md) (timeline portion only) |
| [0015](0015-research-archive-timeline-collapse.md) | Research archive timeline collapse — supersedes ADR-0014 timeline portion | Accepted |
| [0016](0016-cross-package-commit-splitting.md) | Cross-package commit splitting for release-please routing | Accepted |
| [0017](0017-stage25-continuity-and-schema-roadmap.md) | Stage 2.5+ continuity and schema roadmap | Accepted |
| [0018](0018-stage3-architecture-orchestrator-and-branch-context.md) | Stage 3+ architecture — orchestration capability, branch-as-workflow-context, cross-host verification | Accepted |
| [0019](0019-cross-plugin-invocation-contract.md) | Cross-plugin invocation contract — orchestrator → engineer (Stage 3+ §sub-1 follow-up) | Superseded by [ADR-0061](0061-codex-installs-pinned-to-release-commits.md) — Codex resolver layout only; by [ADR-0062](0062-subtask-completion-recorded-at-landing.md) — §4 completion timing only |
| [0020](0020-engineer-integrated-workflow-umbrella.md) | engineer integrated workflow umbrella — `/engineer:start` lifecycle macro command | Accepted |
| [0021](0021-codex-command-surface-parity-via-skill-wrappers.md) | Codex command-surface parity via skill wrappers — macro skill category | Accepted |
| [0022](0022-engineer-meta-skill-category.md) | Engineer meta-skill category — third category in skills/<plugin>/ | Accepted |
| [0023](0023-peer-runner-supervisor-layer.md) | Peer-runner supervisor layer for companion dispatch | Accepted |
| [0024](0024-runtime-operator-control-plane.md) | Runtime operator control plane | Accepted |
| [0025](0025-workflow-storage-migration.md) | Workflow storage migration to `.agentic-plugins` | Accepted |
| [0026](0026-runtime-compatibility-drift-and-release-notes.md) | Runtime compatibility drift and release-note evidence | Superseded by [ADR-0060](0060-remove-host-version-tracking.md) — in full; the subject is removed, not re-decided |
| [0027](0027-decide-skill-multi-axis-evolution.md) | Decide skill multi-axis evolution — axis registry, sizing, weighting/sensitivity, and the parallel-edit contract | Accepted |
| [0028](0028-engineer-phase7-commit-automation.md) | Engineer Phase 7 commit automation | Superseded by [ADR-0062](0062-subtask-completion-recorded-at-landing.md) — §P10 only |
| [0029](0029-entry-routing-contract-enforcement.md) | Extend entry-routing contract enforcement to standalone verbs — active, evidence-based next-action guidance | Accepted |
| [0030](0030-codex-plugin-hooks-removal-stage-aware-migration.md) | Codex `plugin_hooks` removal — stage-aware runtime migration | Accepted |
| [0031](0031-session-level-active-handoff-layer.md) | Session-level active handoff layer | Accepted |
| [0032](0032-codex-per-plugin-command-surface-adoption.md) | Codex per-plugin command surface adoption — stage-aware runtime recognition | Accepted |
| [0033](0033-ci-full-test-suite-coverage.md) | CI full-suite coverage via test discovery | Accepted |
| [0034](0034-codex-plugin-list-read-signal.md) | Codex `plugin list --json` as host-native installed-state read signal | Accepted |
| [0035](0035-runtime-active-execution-boundary-policy.md) | Runtime active-execution boundary policy | Accepted |
| [0036](0036-founder-persona-business-planning.md) | founder persona (L3) — new-business planning workbench | Superseded by [ADR-0066](0066-persona-pipeline-canonical-source.md) — Sub-decision 7 only |
| [0037](0037-image-capability-plugin.md) | `image` capability plugin — cross-host image generation via the companion bridge | Superseded by [ADR-0055](0055-image-transparent-background-support.md) — Decision 7 transparency clause only; Decision 5 amended 2026-10-12 (a send disclosure replaces the privacy gate; amendment Accepted) |
| [0038](0038-runtime-permission-prompt-advisory.md) | Runtime permission-prompt reduction advisory | Superseded by [ADR-0057](0057-permission-advisor-removal.md) — **except §6**, whose effect-not-ownership Guard-Hook refusal ADR-0057 §Decision 8 carries forward as binding |
| [0039](0039-completion-footer-activation.md) | Completion/handoff footer activation | Superseded by [ADR-0061](0061-codex-installs-pinned-to-release-commits.md) — §5 Codex rung and Codex-caller host order only |
| [0040](0040-operator-observability.md) | Operator situational awareness — attention notifications and state dashboard | Superseded by [ADR-0061](0061-codex-installs-pinned-to-release-commits.md) — §3 Codex rung and Codex-caller host order only (incl. §4 shuttle, §5 self-sensor); by [ADR-0064](0064-runtime-surface-reduction.md) — **except §6** (dashboard) **and §3 as re-chartered by ADR-0044** |
| [0041](0041-cross-machine-notification-egress.md) | Cross-machine notification egress | Superseded by [ADR-0064](0064-runtime-surface-reduction.md) — in full |
| [0042](0042-designer-persona-design-ux-workbench.md) | `designer` persona (L3) — code-first design/UX decision & quality workbench | Superseded by [ADR-0066](0066-persona-pipeline-canonical-source.md) — Sub-decision 7 only |
| [0043](0043-founder-designer-footer-enablement.md) | founder/designer workflow-projection and completion-footer enablement | Accepted |
| [0044](0044-session-generic-handoff-capture.md) | Session-generic handoff capture — a code firing point for out-of-workflow session boundaries | Accepted |
| [0045](0045-entry-time-proposal-surfaces.md) | Entry-time proposal surfaces — one arbitrated, pointer-only entry brief | Accepted |
| [0046](0046-machine-bootstrap.md) | Machine bootstrap — `runtime:bootstrap` lifecycle command + portable machine profile | Accepted |
| [0047](0047-notify-attention-gating-gc.md) | Response-needed notification signal + bounded notify/artifact GC | Superseded by [ADR-0064](0064-runtime-surface-reduction.md) — **except §7** (citation-aware retention) |
| [0048](0048-bootstrap-observability.md) | Bootstrap observability — statusline stage, shipped-component policy, egress evidence vocabulary, credential boundary | Accepted |
| [0049](0049-evidence-as-data.md) | Evidence as data — a validated record store for release/proof facts, forward-only | Superseded by [ADR-0065](0065-release-ceremony-reduction.md) — in full |
| [0050](0050-fragment-persistence-boundary.md) | Fragment persistence boundary: immutable fragments, one commit point | Accepted |
| [0051](0051-host-parity-baseline-source.md) | Host-parity baseline source — the packaged copy is the only authority, and changing it obliges a release | Superseded by [ADR-0060](0060-remove-host-version-tracking.md) — in full; the packaged baseline it made authoritative is removed |
| [0052](0052-release-obligation-enforcement.md) | Enforcing the baseline release obligation — history/tag reconciliation, and why Alternatives D stays deferred | Superseded by [ADR-0065](0065-release-ceremony-reduction.md) — in full |
| [0053](0053-baseline-exactness-and-compatibility-assurance.md) | The baseline has no assurance verdict — exactness stays strict, and assurance becomes a fact of its own | Superseded by ADR-0056 (in part) |
| [0054](0054-assurance-record-schema-and-rollout.md) | The assurance record — one grammar, two validators, no doctor bump, and a gate that ships empty | Superseded by ADR-0056 (in part) |
| [0055](0055-image-transparent-background-support.md) | Transparent backgrounds in `image` — verified in the bytes, contracted for PNG; partially supersedes ADR-0037 Decision 7 | Accepted |
| [0056](0056-assurance-matcher-removal.md) | Remove the assurance grant/cohort matcher — keep the review, drop the machine verdict | Accepted |
| [0057](0057-permission-advisor-removal.md) | Remove the permission-prompt advisor — the host solved the problem, and the advisor now recommends against the cure | Accepted |
| [0058](0058-evidence-store-disposition.md) | Evidence-store disposition — most of the gap is a judgment no rule makes, and the coverage half of the precondition was never built | Superseded by [ADR-0065](0065-release-ceremony-reduction.md) — in full |
| [0059](0059-runbook-argument-transport.md) | Runbook argument transport — the text reaches the CLI as a written file, and the shell never sees it | Accepted |
| [0060](0060-remove-host-version-tracking.md) | Remove host-version compatibility tracking — the baseline, the compat command, and the drift gate | Accepted |
| [0061](0061-codex-installs-pinned-to-release-commits.md) | Codex installs pinned to release commits — the catalog carries the pin, and cross-plugin discovery reads the installed cache | Accepted |
| [0062](0062-subtask-completion-recorded-at-landing.md) | Macro subtask completion is recorded when the work lands | Accepted |
| [0063](0063-autopilot-fresh-session-driver.md) | Autopilot — owner-launched fresh-session driver (Claude-only) | Accepted |
| [0064](0064-runtime-surface-reduction.md) | Runtime surface reduction — remove notification and egress, the machine profile, the sandbox probe, and the cutover audit | Accepted |
| [0065](0065-release-ceremony-reduction.md) | Release ceremony reduction — the repository stops restating, proving and recording each release; the catalog sync stays | Accepted |
| [0066](0066-persona-pipeline-canonical-source.md) | Persona pipeline — one canonical source, generated into each persona plugin | Accepted |
| [0067](0067-autopilot-worktree-lanes-and-proposals.md) | Worktree lanes for the autopilot driver, and proposals for worktrees, lanes and consensus | Accepted |
| [0068](0068-autopilot-lanes-that-keep-going.md) | Autopilot lanes that keep going | Accepted |
| [0069](0069-review-change-identity.md) | The change a review is bound to | Accepted (slice 1); slice 2 Proposed |
| [0070](0070-adr-current-decision-and-history.md) | An ADR states its current decision; its history lives in a companion file | Proposed |
| [0071](0071-autopilot-step-model-from-settings.md) | Autopilot step model and effort from settings | Proposed |
