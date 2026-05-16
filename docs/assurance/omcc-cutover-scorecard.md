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

The remaining gap is assurance depth: current-host UX parity, self-hosted
dogfood evidence, and final completion state need to be measurable enough that
omcc can be removed without a fallback.
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

Current local dry-run evidence on 2026-05-17 KST: `runtime:settings` reports Claude
Code `2.1.143`, Codex CLI `0.130.0`, all four agentic-plugins surfaces
available, source/cache versions matching the current repo manifest, and zero
plugin-management recommendations after the `plugin-runtime` `0.51.1` release
and installed-state refresh. Current runtime execution evidence on 2026-05-17 KST
from installed `plugin-runtime` `0.51.1` reports permission proof, deep peer
smoke, and workflow continuation proof passed in both directions; experience
parity is 91%. The `plugin-runtime` `0.51.1` release/install proof loop is
carried by PR #296 and release PR #297, release tag
`plugin-runtime-v0.51.1`, marketplace sync commit `3903490`, and the follow-up
installed-cache refresh.
Subsequent dogfood records are intentionally tracked in runtime cutover
artifacts rather than hand-maintained here. Codex hook review/trust attestation
remains a manual active-session follow-up.

## Requirement Scorecard

| Req | User requirement | Current repo evidence | Status | Cutover gate |
|---|---|---|---|---|
| R1 | agentic-plugins must be superior-compatible with omcc/omcc-dev, not a simple baseline copy. | ADR-0007 mandates redesign-over-port; ADR-0010 maps omcc experience into a 4-layer/6-verb model; ADR-0019 and ADR-0020 replace omcc-dev single and multi-deliverable workflow shapes with engineer plus orchestrator. `omcc-legacy-pattern-map.md` inventories D1-D20 legacy surfaces and maps each to an agentic-plugins improvement, retained behavior, or explicit rejection/deferment rationale. | satisfied | Every retained omcc-dev behavior has an agentic-plugins equivalent, improvement, or documented rejection with rationale. |
| R2 | Overbuilt or unnecessary parts should be improved or removed. | `plugins/research` was retired and cited-brief moved into `engineer:investigate`; `plugins/designer` is deferred rather than shipped prematurely; hidden automatic ensembles and raw peer output are rejected. `runtime:cutover` reads `omcc-legacy-pattern-map.md` and blocks readiness when required D1-D20 rows are missing, statuses are invalid, or a rejected/deferred row is still an active daily dependency. | satisfied | A cutover audit lists all legacy omcc patterns as retained, improved, rejected, or deferred; no active daily workflow depends on a rejected/deferred pattern. |
| R3 | Switching development tools must work in both directions: Claude Code to Codex and Codex to Claude. | Cross-host tests cover resume and stop-archive behavior for engineer/orchestrator; companions exist in both directions. Installed `plugin-runtime` `0.51.1` executed `runtime:doctor --permission-proof --execute-permission-proof --deep-peer-smoke --execute-deep-peer-smoke --workflow-continuation-proof --execute-workflow-continuation-proof` on 2026-05-17 KST. Both `claude -> codex` and `codex -> claude` passed the permission proof, deep peer smoke, and engineer workflow continuation proof through `state.mjs create`, `dispatch-peer.mjs`, `pending_ensemble`, and `ensemble_results` in an ephemeral temp repo. | satisfied | Keep the explicit installed-runtime proof in the release/install continuity loop whenever the peer path changes. |
| R4 | Claude Code and Codex user experience must be equivalent where possible; non-portable host-specific features must not become hard dependencies. | Architecture documents host-specific adapter boundaries; runtime baseline documents command/hook/subagent differences; Codex macro/meta skill mirrors exist. `runtime:settings` reports source/cache version parity and zero plugin-management recommendations on 2026-05-17 KST after the `0.51.1` installed-state refresh; `runtime:doctor` reports 91% experience parity with installed `plugin-runtime` `0.51.1`. The remaining gap is the active-session Codex `/hooks` review/trust follow-up, which runtime deliberately does not infer non-interactively. | partial | Clear the Codex active-session hook review/trust follow-up and rerun doctor until the observed parity score reaches 100% without hiding host-specific syntax differences. |
| R5 | Optimize for best results, not token minimization. | Engineer now publishes a tested quality-first default contract: phase-boundary ensembles are the default peer breadth, model/effort defaults stay host-native or `runtime:settings` configured without token-saving downshift, and review depth follows the workflow phase through `parallel-review` and re-review after refine. `runtime:consensus` also records `best-results-over-token-minimization` in manifest, prompt artifacts, and text output with all-requested-peer breadth by default unless the operator constrains it. `tests/engineer/test-start-command.mjs` and `tests/runtime/test-consensus.mjs` cover these fields. | satisfied | Keep quality-first defaults explicit; budget, latency, model, effort, or peer limits must be user constraints with stated quality tradeoffs. |
| R6 | Context engineering should improve output quality; decisions requested from the user must be concrete, comparative, and evidence-based. | Runtime context artifacts, footer guidance, engineer/orchestrator presentation protocols, and the engineer entry-routing contract exist. `tests/engineer/test-start-command.mjs` verifies the decision prompt fields across `/engineer:start`, `$engineer:start`, and the shared contract. | satisfied | Keep every user decision prompt on the same options/tradeoffs/risks/recommendation/confidence/evidence/default-next-command shape. |
| R7a | Work must prioritize standards, root cause, quality, and recommended practice over short-term fixes. | ADRs enforce hexagonal architecture, adapter boundaries, explicit storage contracts, and no hidden permission/session mutation. The engineer entry-routing contract now requires a standards/root-cause quality gate before quick implementation/refinement paths, and refine already blocks bug fixes until root cause is confirmed. | satisfied | Keep implementation/refinement flows routed back to investigate/decide/orchestrator when the standards/root-cause/evidence gate cannot be met. |
| R7b | Completion must guide the next action, or confidently say there is nothing left. | Runtime footer is pointer-only and exposes context/consensus/PR readiness guidance, cutover record guidance, and a conservative completion-state enum with state-derived next actions. Engineer/orchestrator completion runbooks require that state in footer output. | satisfied | Keep future completion surfaces on the same state contract; do not infer `closed` without explicit PR, release, cleanup, and planned-follow-up evidence. |
| R8 | Domain entry should start with engineer when appropriate, and propose orchestrator/worktree/parallelization when useful. | ADR-0020 defines `/engineer:start` vs `/orchestrator:plan` entry routing; runtime has read-only worktree planning; `/engineer:start` and `$engineer:start` now present a tested entry routing recommendation covering engineer, orchestrator, runtime worktree, runtime readiness/handoff, and single-verb routes. | satisfied | Keep new domain entrypoints on the same routing recommendation contract rather than adding implicit auto-routing. |
| R9 | Track Claude Code and Codex CLI version history; when latest host versions differ from remembered versions, use release notes to plan compatibility updates. | Runtime host parity baselines record observed CLI versions and drift policy. `runtime:compat` records snapshots, compares remembered baseline versions, ingests explicit release-note artifacts, requires content-backed notes to mention the changed host and observed version before detailed planning, and emits update plans; `runtime:doctor` reads latest compat metadata into the handoff artifact criterion. Claude Code `2.1.142`/`2.1.143` release notes were ingested as explicit content-backed notes and the host parity baseline was refreshed to Claude Code `2.1.143`. `runtime:cutover` includes latest compat freshness and installed-version evidence in its read-only scorecard audit. `tests/runtime/test-compat.mjs` verifies that a note for the wrong host/version does not clear a drift gap. | satisfied | Keep content-backed release-note coverage or an accepted baseline refresh mandatory whenever host versions drift. |
| R10 | Claude and Codex should be used as complementary perspectives; same-issue opinion collection is valuable. | Companions and runtime consensus provide cross-host peer collection. `runtime:consensus` plans explicit companion-backed lanes and manual/subagent lanes, writes per-peer prompt/output pointers, and records peer roles such as `claude_companion_peer` and `security_manual_subagent_peer`; `tests/runtime/test-consensus.mjs` covers those manifest, prompt, status, and text-output fields. | satisfied | Keep consensus lanes role-explicit, artifact-pointer-only, and bounded by explicit peer rosters rather than hidden peer caps. |
| R11 | When Claude and Codex conflict, loop opinions back until there is a well-converged, non-compromise synthesis. | `runtime:consensus` records convergence state, contradiction summaries, bounded next-round availability, and contradiction-aware rebuttal prompts with issue framing, opposing views, and evidence standards. Automatic unbounded loops are forbidden. | satisfied | Keep future consensus surfaces on the same no-false-compromise taxonomy and require explicit user approval for any expansion beyond the max-round cap. |

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
- `owner-decision-required`: disagreement remains after bounded rebuttal rounds.
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
- Tests cover contradiction, complementary disagreement, empty disagreement, and
  owner-decision-required states.

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
