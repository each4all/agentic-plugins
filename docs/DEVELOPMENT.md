# agentic-plugins — Development (Meta)

This document describes **how agentic-plugins is itself developed**. It is the
internal-face counterpart to `README.md` (which targets consumers) and
`docs/ARCHITECTURE.md` (which targets users of the framework).

agentic-plugins is built so it can build itself. This document explains the
plan for that.

---

## Why this document exists

agentic-plugins has two faces:

1. **External face** — published companions, plugins, kit, marketplace catalogs
2. **Internal face** — tooling that supports agentic-plugins' own continuous development

A framework that ships to others must also be sustainable for its own
maintainers. omcc has `omcc-dev` for this purpose; agentic-plugins needs an
equivalent. This document lays out the plan, including the dogfooding
transition.

---

## Initial development host

> **Stage 2.5+ snapshot (2026-05-13)**: Stage 2 exited 2026-05-06. Per
> dogfood policy, `omcc-dev` continues as the active authoring tool
> until a non-trivial engineer/orchestrator-driven Stage 3+ workflow
> completes without an escape hatch; agentic-plugins' scaffolding
> itself operates without `omcc-dev` reference per ADR-0012 condition
> 4 functional reading (audit `audit-20260509T105532Z-3f0021`).
> **ADR-0020 4-PR roadmap shipped 2026-05-12** ([#69](https://github.com/each4all/agentic-plugins/pull/69)
> ADR text → [#70](https://github.com/each4all/agentic-plugins/pull/70)
> PR 2 schema → [#72](https://github.com/each4all/agentic-plugins/pull/72)
> PR 3 lifecycle macro → [#73](https://github.com/each4all/agentic-plugins/pull/73)
> PR 4 manifest) — `/engineer:start` is now a live invocation surface
> on Claude Code, and the ADR-0012 condition 3 trigger candidate has
> fired. **ADR-0021 cross-host parity cascade shipped 2026-05-12**
> ([#75](https://github.com/each4all/agentic-plugins/pull/75)) —
> `$engineer:start` macro skill at `plugins/engineer/skills/start/`
> mirrors `/engineer:start` for Codex CLI without waiting on ADR-0013;
> ADR-0010 §3 amendment introduced the verb-skills + macro-skills
> split. **ADR-0022 follow-up cascade (also 2026-05-12)** closes
> ADR-0021 §6 by adding a third **meta-skill** category alongside
> verb and macro — the three engineer meta commands
> (`resume` / `checkpoint` / `peer-now`) now mirror as Codex meta
> skills at `plugins/engineer/skills/{resume,checkpoint,peer-now}/`,
> with mandatory host-availability matrices per skill. ADR-0010 §3
> is now a **three-category split (verb / macro / meta)** per the
> 2026-05-12 ADR-0022 cascade amendment. Evidence accumulation toward
> condition 3 satisfaction begins with the first non-trivial
> engineer-driven workflow that completes via `/engineer:start`
> (Claude) or `$engineer:start` (Codex) without `omcc-dev` escape
> hatch. **ADR-0024 (Accepted)** reframes the immediate Stage 3+
> candidate as runtime/operator control plane work. As of
> `plugin-runtime` v0.26.5, runtime ships `doctor`, `settings` with
> explicit plugin-management execution artifacts, consensus artifacts
> plus an explicit `execute --execute` companion boundary and remediation
> metadata, read-only worktree planning, context-hygiene artifacts with
> explicit budget checks, dirty/source-staleness handoff guidance,
> workflow-storage migration, runtime artifact inventory, and an
> advisory pointer-only completion footer with context, consensus, and
> PR-readiness guidance. Early PRs [#105](https://github.com/each4all/agentic-plugins/pull/105)
> / [#106](https://github.com/each4all/agentic-plugins/pull/106)
> and executor PRs [#129](https://github.com/each4all/agentic-plugins/pull/129)
> / [#130](https://github.com/each4all/agentic-plugins/pull/130)
> are historical ADR-0024 dogfood datapoints; the later v0.26.5 closeout
> through PR [#180](https://github.com/each4all/agentic-plugins/pull/180)
> plus release PR [#182](https://github.com/each4all/agentic-plugins/pull/182)
> records the current runtime state, but these do not by themselves
> satisfy ADR-0012 condition 3. `plugins/designer` remains
> deferred as a possible future L3 persona rather than the active
> next-step trigger. Detailed Stage 2 exit narrative under
> [§Stage 2 — Self-development plugin](#stage-2--self-development-plugin).

Until the ADR-0024 runtime/operator track accumulates enough
non-trivial self-hosted workflow evidence, **agentic-plugins
development still permits `omcc-dev` as a fallback workflow
framework**. Engineer and orchestrator are the intended dogfood path;
condition 3 is not satisfied until that path handles substantial work
without an escape hatch.

Concrete:
- New dogfood-targeted work should start with `/engineer:start`,
  `$engineer:start`, or `/orchestrator:plan` when feasible
- `omcc-dev` remains a legacy fallback until ADR-0012 condition 3 is
  satisfied
- The session reads `AGENTS.md` (via Claude Code's `CLAUDE.md` → `@AGENTS.md` redirect) for project conventions
- ADR proposals follow the process documented in `AGENTS.md`

This is **transitional**. Once the runtime/operator track proves the
self-hosted path on substantial work, agentic-plugins switches to itself
as the default development workflow.

---

## Dogfooding plan

The strategic intent is for agentic-plugins to develop agentic-plugins. The path:

### Stage 0 — Scaffolding (completed 2026-05-02)

- Repository structure exists
- All 7 ADRs accepted (0001–0007)
- Tooling decided: Node + pnpm + vitest + prettier + GitHub Actions + release-please + MIT
- No plugins yet
- No companions yet
- Development happens in Claude Code with omcc-dev as the workflow framework

### Stage 1 — Reference plugin and companion contract

- Companion contract finalized in `companions/contract.md`
- One small reference plugin shipped — references omcc-research's experience (single skill, ensemble protocol, graceful degradation), but plugin name, skill structure, and command surface are agentic-plugins' own design (not a 1:1 port — see ADR-0007)
- Both adapters (Claude, Codex) implemented for the reference plugin
- Smoke tests pass in both hosts via `kit/lint/` and `companions/tests/`
- Both companion CLIs (`claude-companion`, `codex-companion`) implemented

#### Stage 1 exit evidence

> Note: `plugins/research` was retired at Stage 2.5+ per
> [ADR-0014](adr/0014-plugins-research-deprecation.md); its
> cited-brief contract was absorbed into `engineer:investigate`'s
> cited-brief profile. The Stage 1 evidence below remains valid as
> historical record — it describes the round-trip that was achieved
> at the time and is the reason ADR-0010's Layer 2 was taken to be
> "current" before re-evaluation.

Stage 1 exit was reached on 2026-05-05 with `plugins/research` shipped
(PR #17, main `f1c398f`) plus the companion contract patches (PRs #19,
#20) and the Phase 5b cleanup (this PR). Round-trip is demonstrated
empirically by the canonical brief artifacts under `output/`:

- **Claude direction** — `output/2026-05-04_node_24_child_p_1145/research_brief.md`
  - Topic: "Node 24 child_process API surface"
  - Round-trip: ~5.5 min Codex peer turn via `codex-companion`
  - Synthesis: 7 cited sources, HIGH confidence; 4 PEER-ONLY claims all
    Path-A verified

- **Codex direction** — `output/2026-05-05_current_tls_13_1124/research_brief.md`
  - Topic: "current TLS 1.3 deployment guidance"
  - Round-trip: 5+ min Claude peer turn via `claude-companion`; gracefully
    degraded after the Codex background-terminal timeout (per the
    Stage 1 `plugins/research` ensemble-protocol Failure Handling
    spec, since absorbed into
    `plugins/engineer/skills/investigate/references/cited-brief-ensemble.md`)
  - Synthesis: 12 cited sources HIGH confidence (5 standards: RFC 8446 /
    8470 / 9001 / 9110 / 9325 + NIST SP 800-52r2; 7 official-docs:
    Cloudflare / Fastly / GCP / Akamai / nginx / OpenSSL)

Per-host CI workflows (`claude-tests.yml`, `codex-tests.yml`) gate
plugin-shape conformance + `kit/lint` + unit tests on every push.
Automated CI smoke that drives the companion CLIs end-to-end with real
peer-host credentials is **deferred to Stage 2** (see Risks #4 — bidirectional
companion auth in CI). Until then, the two artifacts above are the
canonical Stage 1 exit evidence for "round-trip companion call passes",
and `COMPANIONS_SMOKE=1 npm run test:smoke` is the opt-in local
verification path.

### Stage 2 — Self-development plugin

- New plugin ships: **`plugins/engineer`** (canonical L3 persona name per ADR-0010). Plugin-name level aliases (e.g., `/dev:` as marketplace alias) are NOT supported in Stage 2 — marketplace contract requires plugin name = catalog name = folder name = manifest name. Verb-level aliases within `engineer` (e.g., `/engineer:audit` ≡ `/engineer:critique --profile=full-codebase`) are permitted (ADR-0010 §3)
- Implements 4-layer composition (ADR-0010): L3 engineer plugin composes L2 research capability and L1 companions framework
- 6 universal cognitive verb skills (Investigate / Frame / Decide / Compose / Critique / Refine), naming `<persona>:<verb>` + profile arg
- References omcc-dev workflow experience (start, fix, audit, brainstorm, continuity, ensemble) but redesigned per ADR-0007 — keep what works (privacy gate, ensemble, structured workflow), drop accumulated structural debt (sharded layout and drift classification 4-tier remain deferred; multi-active workflows resolved as **per-branch** in Stage 3+ per ADR-0018 §sub-2 — directory may carry one workflow per branch)
- Minimal continuity Option III per ADR-0011: workflow state file (markdown + YAML frontmatter) + four hooks (Claude `PreCompact` mid-session, Claude `Stop` end-of-session, Claude `SessionStart` for new-session summary injection, Codex `Stop` end-of-session) for automatic snapshot and resume awareness. **Per-branch** single-active workflow constraint enforced by directory-level creation lock + branch-keyed lookup (ADR-0018 §sub-2)
- Always-max bidirectional ensemble policy: every phase boundary auto-dispatches the **other host's** peer-agent via companions (Claude session dispatches to Codex via `codex-companion`; Codex session dispatches to Claude via `claude-companion`). User does not choose
- agentic-plugins development workflows switch from `omcc-dev` to `plugins/engineer`
- The omcc-dev dependency for agentic-plugins development is dropped

#### Stage 2 deliverable plan (5 sharded deliverables)

| # | Deliverable | Summary |
|---|-------------|---------|
| A | Foundation | ADR-0010 + ADR-0011 + AGENTS/ARCHITECTURE/DEVELOPMENT updates + plugin name `engineer` confirmed + Stage 2 non-goals (9 items per ADR-0011) + command surface path contract |
| B | discovery library absorbed into companions plugin | Promote `discover-companion.mjs` from per-plugin duplicate to `plugins/companions/scripts/discover-peer.mjs` (canonical library bundled inside companions, not a separate `kit/discovery/` directory or new plugin). companions version bump 0.2.0 → 0.3.0. research adapter scripts re-implemented as ~120-line bootstrap + import wrappers. Trigger: engineer is the 2nd consumer per ADR-0008 §b.1; ADR-0010 §6 plugin-separation triggers evaluated 0/3 → no separate plugin needed (discovery is high-cohesion with companion invocation, transparent infrastructure, single cost/auth profile). Regression smoke: Stage 1 plugin-shape tests (28 research + 22 companions) all pass; AGENTIC_COMPANIONS_ROOT smoke test of both adapter scripts returns correct companion paths |
| C | engineer plugin core | `plugins/engineer/{.claude-plugin, .codex-plugin, README, CHANGELOG}` + `skills/{investigate,frame,decide,compose,critique,refine}/SKILL.md` × 6 + `skills/_shared/references/` + `skills/<verb>/agents/openai.yaml` × 6 + marketplace catalog updates |
| D | Adapters + minimal continuity | `commands/<verb>.md` × 6 + verb-level sugar aliases (e.g., `audit` → `critique --profile=full-codebase`) + `adapters/{claude,codex}/{hooks, scripts, agents}` + workflow state I/O + four hooks per ADR-0011 §4 (Claude `PreCompact` + Claude `Stop` + Claude `SessionStart` + Codex `Stop`). Risk mitigation: 1 verb (`investigate`) end-to-end first |
| E | Validation + dogfood | `tests/plugin-shape/test-engineer-plugin.mjs` (multi-skill variant) + unit tests + remaining 5 verbs activation (after the `investigate` end-to-end proof in D, E completes the other 5 so all 6 verbs are validated end-to-end before Stage 2 exit) + omcc-dev disabled dogfood + DEVELOPMENT.md Stage 2 exit evidence |

#### Stage 2 non-goals (explicit, ADR-0011 §Non-Goals)

These are intentionally **out of scope**:

1. Sharded workflow layout
2. Drift classification
3. Cross-host workflow id portability
4. omcc-dev → engineer data migration script (clean start per ADR-0007)
5. Multi-active workflows
6. `/engineer:resume`, `/engineer:checkpoint`, `/engineer:audit` as separate commands (resume implicit; audit ≈ `critique --profile=full-codebase` verb-level alias)
7. Active registry file (directory listing IS the registry in Stage 2)
8. Per-step state mutation lock-ordering across multiple files or shards (single-file = trivial lock-order)
9. Plugin-name level marketplace aliases (e.g., `/dev:` as alias for `/engineer:`) — marketplace contract constraint; verb-level aliases inside a plugin are permitted

Composition / non-continuity scope (ADR-0010 separation triggers):

10. Companions runtime absorption — separate `runtime` plugin only when 2+ consumers prove need (per ADR-0010 §6 trigger #1)

Out-of-scope items become Stage 2.5+ ADR follow-ups if the dogfood phase reveals genuine need.

#### Stage 2 exit evidence

Stage 2 exit was reached on 2026-05-06 with all five deliverables
merged onto main:

| # | Deliverable | PR | Merge commit |
|---|---|---|---|
| A | Foundation (ADR-0010 + ADR-0011 + AGENTS/ARCHITECTURE/DEVELOPMENT updates + plugin name `engineer`) | [#23](https://github.com/each4all/agentic-plugins/pull/23) | `a3afba3` |
| B | companions discovery library absorbed (canonical `discover-peer.mjs` in `plugins/companions/scripts/`) | [#25](https://github.com/each4all/agentic-plugins/pull/25) | `a0e8f6a` |
| C | engineer plugin core (manifests + 6 verb skills + 4 shared refs + 6 agents YAML + marketplace catalogs) | [#27](https://github.com/each4all/agentic-plugins/pull/27) | `3040a13` |
| D | Adapters + minimal continuity (6 commands + audit alias + state.mjs + dispatch-peer.mjs + 4 Claude hooks + Codex stop helper) | [#30](https://github.com/each4all/agentic-plugins/pull/30) | `af12326` |
| E | Validation + dogfood + Stage 2 exit evidence (`test-engineer-plugin.mjs` + `tests/engineer/*` unit tests + ADR-0012 + this section) | [#32](https://github.com/each4all/agentic-plugins/pull/32) | (this PR) |

##### Test green per host

Per-host CI workflows (`claude-tests.yml`, `codex-tests.yml`) gate the
plugin-shape and unit-test surface on every push:

- Plugin-shape conformance — companions / research (existing) +
  **engineer** (added in Deliverable E, multi-skill variant, 97 tests
  covering manifests / 6 skills / 4 shared refs / 2 host-shared scripts /
  7 commands / 5 hooks / verb-name consistency / verb→ensemble mapping
  cross-check / contract version freshness / stale-token audit).
- Unit tests for engineer Phase 6 fixes (added in Deliverable E):
  - `tests/engineer/test-state.mjs` — lock ownership protocol
    (serialization + ownership-object delivery; atomic-rename internals
    are public-API-tested rather than directly probed since a
    mid-lock-process kill is out of scope for in-process unit tests),
    `validateFrontmatter` schema=1 closed with nested key sets,
    extended secret patterns (AWS ASIA / GitHub fine-grained / sk-* /
    Slack / 32+ hex), single-active invariant, `withFileLock`
    serialization under concurrent acquirers.
  - `tests/engineer/test-dispatch-peer.mjs` — envelope strict
    validation per `companions/contract.md` §4.2 + §5.3 joint triple
    (`status` / `peer_host` enums, `success` exit_code=0 + no error,
    joint triple for `peer_error` and `companion_error`,
    `error.message` non-empty single-line, `error.detail` string-or-null),
    `AGENTIC_COMPANIONS_ROOT` env override (single root, not per-peer),
    optional `<structured_output_contract>` emission, XML escape rules.
  - `tests/engineer/test-session-start.mjs` — JSON-quoted
    `[engineer-active-metadata]` marker pair, profile-field
    separation, `next_action` exclusion as imperative-injection
    vector block, field length caps verified end-to-end with oversized
    inputs, control-char sanitization in payload.
- Existing tests (`research-discover-companion`, `kit/lint`,
  `companions` round-trip).

The plugin-shape + unit-test surface (`npm run test:plugin-shape`)
runs **243 tests** green on `feat/plugin-engineer-validation`
(HEAD of PR #32). The wider `npm test` runs **371 tests** green
(adds the `companions` round-trip unit suite). `npm run lint:plugin-shape`
reports `shape OK` for all three plugins (companions / engineer /
research).

##### Round-trip dogfood evidence

The round-trip companion-call guarantee is established in two empirical
datapoints — one per direction — plus a structural caveat captured in
the next subsection.

- **Claude direction (`claude→codex` on engineer's own
  `dispatch-peer.mjs`)** — Stage 2 Deliverable D Phase 5 review invoked
  `codex-companion` directly through `plugins/engineer/scripts/dispatch-peer.mjs`
  to obtain a parallel review of the D working tree. Companion auto-
  discovery (Claude cache 0.1.1 path) succeeded; the JSON envelope
  returned `status: success` with `exit_code: 0` and a 9482-byte
  stdout; the resulting 16-finding review (CRITICAL 2 + MAJOR 10 +
  MINOR 2 + SUGGESTION 2) drove the Phase 6 resolve commit `36b7ab1`.
  This is the canonical Claude-direction round-trip evidence on
  engineer's own code path — distinct from the Stage 1
  `plugins/research` round-trip because engineer's own
  `state.mjs` / `dispatch-peer.mjs` / four hooks did not yet exist
  at Stage 1 exit.

- **Codex direction (`codex→claude`)** — Stage 2 Deliverable E
  attempted a six-verb chain dogfood from a Codex CLI 0.128.0 session
  on a separate machine, with chess-game design as the task surface.
  The first verb (`/engineer:investigate`) demonstrated that
  engineer's SKILL substance is correctly invoked by Codex CLI and
  produces high-quality output: web-grounded landscape mapping for
  chess implementation options with citations to `chess.js`,
  Stockfish UCI, Vite, `react-chessboard`, Socket.IO, Firebase
  Realtime Database, `python-chess`, and a pragmatic 1–2 week MVP
  recommendation. The structural caveat below blocked the
  `commands/<verb>.md` Phase 0 / 1 / 2 contract from triggering on
  the Codex side, so engineer's `dispatch-peer.mjs` was not
  auto-invoked from Codex; the full `codex→claude` round-trip on
  engineer's *own* code path is therefore deferred to a Stage 2.5+
  follow-up. The Stage 1 `plugins/research` bidirectional artifacts
  (Node 24 brief, TLS 1.3 brief) continue to demonstrate the
  protocol-level guarantee for `codex-companion` ↔ `claude-companion`
  itself, but ADR-0012 condition (2) explicitly requires re-establishment
  on engineer's code, which becomes part of the same Stage 2.5+
  follow-up.

##### Honest scope: Codex CLI plugin commands schema absence

Codex CLI 0.128.0 does not expose a plugin-commands schema equivalent
to Claude Code's `commands/<verb>.md` thin shim. The engineer plugin's
seven commands (six canonical verbs + `audit` sugar alias per ADR-0010
§3) trigger their full Phase 0 / 1 / 2 contract (`state.mjs`
`find-active` → SKILL command-invoked mode → state finalize) **only
on the Claude side**. On the Codex side, the same plugin install
exposes the SKILL substance through `agents/openai.yaml` — verbs are
invokable by name, the substance runs, but workflow state files do
not auto-create and `dispatch-peer.mjs` is not auto-spawned at phase
boundaries.

This is a host-runtime asymmetry consistent with
[ADR-0001](adr/0001-hexagonal-architecture.md) §"What is host-neutral
vs host-specific" and [ADR-0011](adr/0011-workflow-continuity-storage.md)
§4 "Hook absence is non-fatal." Until upstream Codex CLI exposes a
plugin-commands schema or this project ships an alternate Codex-side
trigger mechanism (a candidate ADR-0013), the canonical Codex-side
pattern for bidirectional ensemble dispatch is either (a) manual
invocation of `dispatch-peer.mjs` from within the Codex session
(functionally equivalent to the Claude-side automatic path, lower
ergonomics) or (b) waiting for upstream Codex evolution. Both options
are deferred — not blocking Stage 2 exit per ADR-0012's
Stage-2-partial framework.

##### Opt-in local verification

`COMPANIONS_SMOKE=1 npm run test:smoke` runs the bidirectional
companion smoke tests with real peer-host invocations (Stage 1 pattern
mirrored unchanged in Stage 2). Per-CI real-auth smoke remains
deferred to Stage 2.5+, identical to the Stage 1 exit-evidence
statement.

##### ADR-0012 condition progress matrix at Stage 2 exit

[ADR-0012](adr/0012-omcc-removal-preconditions.md) defines a
four-condition rubric for when the legacy `omcc` and
`codex-plugin-cc` dependencies may be removed from the agentic-plugins
development environment. Stage 2 exit establishes the baseline
status below; per-row progress is tracked in subsequent stages and
updated here as conditions advance.

| # | Condition | Stage 2 status | Notes |
|---|-----------|----------------|-------|
| 1 | engineer reaches omcc-dev parity | satisfied | Infrastructure complete (lock ownership protocol / atomic-write token verify / frontmatter validation schema closed / extended secret patterns / SessionStart hardening / envelope strict + structuredOutputContract emit). Sustained dogfood through Stage 3 completes the parity claim. **2026-05-06 Stage 2.5+ exit audit ([docs/audits/2026-05-06-stage25-exit-validation.md](audits/2026-05-06-stage25-exit-validation.md)) Q6 PARTIAL with 10 gap (G-1..G-10). [ADR-0017](adr/0017-stage25-continuity-and-schema-roadmap.md) 5 sub-decisions all Implemented (PR2 [#46](https://github.com/each4all/agentic-plugins/pull/46) / PR3 [#47](https://github.com/each4all/agentic-plugins/pull/47) / PR4 [#48](https://github.com/each4all/agentic-plugins/pull/48) / PR5 [#49](https://github.com/each4all/agentic-plugins/pull/49) — meta commands `/engineer:resume` / `:checkpoint` / `:peer-now` + `ensemble_results` frontmatter persistence + Stop auto-archive 4-gate semantics). PR #53 follow-up review SUGGESTIONs 5/5 closed: PR [#54](https://github.com/each4all/agentic-plugins/pull/54) (a `recordPendingEnsemble` dedupe + b `extractFrontmatterBranch` guard parity tests) + PR [#55](https://github.com/each4all/agentic-plugins/pull/55) (d plan.md Phase 3 fold) + PR [#56](https://github.com/each4all/agentic-plugins/pull/56) (c state.mjs JSDoc engineer parity restoration) + PR [#57](https://github.com/each4all/agentic-plugins/pull/57) (e stale-token audit scope expansion to all docs) — orchestrator-engineer parity strengthened. **2026-05-11 satisfied transition**: [ADR-0019](adr/0019-cross-plugin-invocation-contract.md) cross-plugin invocation contract cascade fully shipped — PR-A [#61](https://github.com/each4all/agentic-plugins/pull/61) (engineer schema 1.1 parent linkage) → PR-B [#63](https://github.com/each4all/agentic-plugins/pull/63) (orchestrator schema bump + plan producers) → PR-C0 [#64](https://github.com/each4all/agentic-plugins/pull/64) (orchestrator subtask-update single-row API) → PR-C [#65](https://github.com/each4all/agentic-plugins/pull/65) (engineer parent-writeback helper + Stop hook integration) → PR-D [#66](https://github.com/each4all/agentic-plugins/pull/66) (`/orchestrator:next` + `/done` dispatch) → PR-E [#67](https://github.com/each4all/agentic-plugins/pull/67) (`/orchestrator:finalize` + `/abort` + macro Stop auto-archive A1-A4). Per ADR-0019 §Consequences "engineer parity unlock": multi-deliverable workflow shape that omcc-dev hosts via `plan.deliverables[]` + sharded layout is now expressible via orchestrator + engineer composition — flat `subtasks[]` + per-subtask engineer workflow is the equivalent expressive surface (sharded layout rejected per ADR-0018 §sub-1, replaced by branch-keyed per-subtask workflows). PR-F (`--peer` cross-host dispatch) remains scoped out per ADR-0019 §Implementation Roadmap trigger discipline; cross-host need has not surfaced and is independent of the satisfied transition for this condition.** |
| 2 | engineer guarantees bidirectional companion round-trip | partial | Claude direction on engineer's own code: ✓ (D Phase 5 dispatch-peer parallel-review). Codex direction: pending — Codex CLI commands schema absence (see Honest scope above) blocks the auto-trigger path; manual or upstream-resolved path is Stage 2.5+ work (ADR-0013 candidate). **2026-05-06 Stage 2.5+ exit audit Q4 PASS adds substantial evidence (128 unit + 4 smoke 양방향 실 LLM round-trip + JSON envelope wire validation per `companions/contract.md` §4.2). [ADR-0018](adr/0018-stage3-architecture-orchestrator-and-branch-context.md) §sub-5 ✅ PR [#54](https://github.com/each4all/agentic-plugins/pull/54) ships the cross-host integration test contract (claude→codex / codex→claude in-process state.mjs round-trip + stop-archive subprocess + standalone `.github/workflows/cross-host-tests.yml` CI matrix slot). Satisfied label still requires Codex auto-trigger path (ADR-0013 trigger pending — Codex CLI plugin-commands schema upstream).** |
| 3 | engineer alone is sufficient for agentic-plugins development | partial | Stage 2 itself was developed using `omcc-dev`, not engineer. The first single-verb engineer dogfood (Codex-side `investigate`, chess design landscape) showed the SKILL substance is usable end-user. Full sufficiency accumulates as Stage 3 work is developed using engineer. **2026-05-06 Stage 2.5+ exit audit records second engineer dogfood evidence (4 parallel agent + Codex plan-verify ensemble via `companions/codex-companion.mjs`). [ADR-0018](adr/0018-stage3-architecture-orchestrator-and-branch-context.md) §sub-1 ✅ PR [#53](https://github.com/each4all/agentic-plugins/pull/53) lands `plugins/orchestrator` MVP — first multi-verb L2 capability plugin (plan-only `/orchestrator:plan` + Plan-verify Codex ensemble). The "first non-trivial Stage 3 workflow developed engineer-only" criterion is now reachable through the orchestrator → engineer composition; cross-plugin invocation contract (orchestrator → engineer, surfaced via `/orchestrator:next` + `/:done`) is a follow-up ADR per ADR-0018 §sub-1. **2026-05-11**: [ADR-0019](adr/0019-cross-plugin-invocation-contract.md) cross-plugin invocation contract fully shipped (PR-A through PR-E, see condition 1 row for the cascade PR list); the "reachable through orchestrator + engineer composition" wording is now operational rather than prospective. The remaining gating event is a Stage 3 non-trivial workflow being driven engineer-only; that dogfood instance is the trigger for the `partial → satisfied` transition on this condition. **2026-05-11**: [ADR-0020](adr/0020-engineer-integrated-workflow-umbrella.md) (Proposed) introduces `/engineer:start` as the engineer-internal single-deliverable lifecycle macro command — the missing surface that previously routed every non-trivial workflow through `omcc-dev:/start`. ADR-0020 PR 3 (the implementation that ships `commands/start.md` + `state.mjs diagnose-redundancy` + plugin-shape test sync) is the **trigger candidate** that lets evidence accumulate toward condition 3 satisfaction. Per ADR-0012's immutable-rubric clause (line 95), satisfaction itself is determined by accumulated non-trivial engineer-only workflows tracked here, not by ADR-0020's merge alone. The `partial → satisfied` transition fires when accumulated Stage 3 non-trivial workflow evidence completes engineer-only with no `omcc-dev` escape hatch. **2026-05-12 trigger candidate fired**: ADR-0020 4-PR roadmap fully shipped — PR 2 [#70](https://github.com/each4all/agentic-plugins/pull/70) `70e7596` (engineer schema 1.1-additive `workflow_type`) → PR 3 [#72](https://github.com/each4all/agentic-plugins/pull/72) `a02ff3f` (`/engineer:start` lifecycle macro + `state.mjs diagnose-redundancy` + session-start workflow_type branch) → PR 4 [#73](https://github.com/each4all/agentic-plugins/pull/73) `16451d2` (marketplace + manifest descriptions/keywords for `/engineer:start`). ADR-0020 status flipped to Accepted in the post-PR-4 follow-up. PR 4 itself was authored via direct edits in that session (small scope: 3 files / 11 lines / no test changes), so it did NOT count as the predicted first engineer-driven workflow. **2026-05-12 cross-host parity cascade**: [ADR-0021](adr/0021-codex-command-surface-parity-via-skill-wrappers.md) PR [#75](https://github.com/each4all/agentic-plugins/pull/75) `1ea63fc` ships `$engineer:start` macro skill mirror under `plugins/engineer/skills/start/`, formalizing the verb-skills + macro-skills two-category split per ADR-0010 §3 cascade. Codex CLI users can now drive the same Phase 0~7 lifecycle that Claude Code users access via `/engineer:start`, without waiting on ADR-0013. PR #75 itself was authored via `omcc-dev:/start` per dogfood policy, so it does NOT count as engineer-driven dogfood evidence either. **2026-05-12 meta-skill cascade closing ADR-0021 §6**: [ADR-0022](adr/0022-engineer-meta-skill-category.md) PR [#77](https://github.com/each4all/agentic-plugins/pull/77) `c4dd712` adds the third **meta-skill** category to ADR-0010 §3 (verb / macro / meta three-category split). The three engineer meta commands (`resume` / `checkpoint` / `peer-now`) now mirror as Codex meta skills with mandatory host-availability matrices. Codex parity for workflow-continuity ops is restored without waiting on ADR-0013. PR #77 itself was authored via `omcc-dev:/start` per dogfood policy, so it does NOT count as engineer-driven dogfood evidence either. **2026-05-13 ADR-0024 runtime/operator dogfood datapoint**: PR [#105](https://github.com/each4all/agentic-plugins/pull/105) shipped `runtime` footer `--context-latest` with stale metadata while preserving the advisory/pointer-only boundary; release PR [#106](https://github.com/each4all/agentic-plugins/pull/106) released `plugin-runtime` v0.5.0, with tag `plugin-runtime-v0.5.0` and marketplace sync commit `ba4f5ff`. This records progress toward condition 3, but status remains `partial`; satisfaction still requires accumulated non-trivial engineer-only workflows without an `omcc-dev` escape hatch.** |
| 4 | self-contained development scaffolding | functional satisfied (below full satisfied) | The development surface (AGENTS.md / CLAUDE.md / 23 ADRs / `test:plugin-shape` / `lint:plugin-shape` / per-host CI / `release-please` / `scripts` / `kit` / `plugins/companions`) is in place. **2026-05-06 Stage 2.5+ exit audit Q3 PASS confirms infrastructure (release-please cascade + 3-way validate-versions + drift detection + ADR-0016 cross-package commit splitting). [ADR-0018](adr/0018-stage3-architecture-orchestrator-and-branch-context.md) Accepted (PR [#50](https://github.com/each4all/agentic-plugins/pull/50)) — Stage 3+ architecture cascade (5 sub-decisions, 4 implemented + 1 no-action). 2026-05-10 per-item omcc-dependency lens audit (workflow `audit-20260509T105532Z-3f0021`) confirms functional reading: 5/5 operational surfaces clean — Lens-B `scripts`+`kit` / Lens-C `plugins/companions` / Lens-D `.github/workflows` / Lens-E `package.json`+`release-please`+marketplace catalogs all 0 hits; Lens-A documentation 0 functional implicit, ~122 (c) clean for historical Context / Alternatives Considered / pattern attribution; Codex audit-scan (LOW affinity review-phase ensemble) ratifies functional verdict. Strict reading ("elimination of any references" per ADR-0012 line 46) remains pending until Stage 3 cushion concurrent with `omcc-dev` uninstall (= condition 3 trigger); ADR-0012 removal trigger requires all four conditions to reach the full satisfied state. F1 (DEVELOPMENT.md tone-drift in 'Initial development host' subsection + Stage 0 stage-history-stamp drift) was the single low-severity actionable; resolved in this PR. F2-F4 (ADR-0011 References list local-cache citation, audit provenance line, AGENTS.md/DEVELOPMENT.md `omcc-research`/`omcc-designer` experiential references) are acceptable-by-classification per Lens-A semantic verdict.** |

##### Stage 2.5+ ADR candidates surfaced

- **ADR-0013** — Codex CLI commands integration mechanism (Honest scope
  above; condition 2 Codex-direction enabler).
- **[ADR-0017](adr/0017-stage25-continuity-and-schema-roadmap.md)** — Stage 2.5+
  continuity and schema roadmap (meta commands `/engineer:resume`, `/engineer:checkpoint`,
  `/engineer:peer-now` + `ensemble_results` frontmatter persistence + Stop auto-archive
  semantics). **Status: Accepted (2026-05-06, [PR #40](https://github.com/each4all/agentic-plugins/pull/40)).
  5 sub-decisions all Implemented:** PR2 [#46](https://github.com/each4all/agentic-plugins/pull/46)
  (`/engineer:resume` command) / PR3 [#47](https://github.com/each4all/agentic-plugins/pull/47)
  (`/engineer:checkpoint` + `latest_checkpoint` field) / PR4 [#48](https://github.com/each4all/agentic-plugins/pull/48)
  (Stop hook auto-archive 4-gate semantics) / PR5 [#49](https://github.com/each4all/agentic-plugins/pull/49)
  (`/engineer:peer-now` + `ensemble_results` frontmatter wiring — sub-decisions 3 + 4 bundled).
  Consolidates audit findings from
  [docs/audits/2026-05-06-stage25-exit-validation.md](audits/2026-05-06-stage25-exit-validation.md)
  Q6 gap list. Each sub-decision shipped via its own acceptance trigger / implementation owner PR /
  validation command — the per-trigger pacing prevented Proposed-ADR drift.
- **[ADR-0018](adr/0018-stage3-architecture-orchestrator-and-branch-context.md)** — Stage 3+
  architecture (orchestration capability + branch-as-workflow-context + cross-host verification).
  **Status: Accepted (2026-05-06, [PR #50](https://github.com/each4all/agentic-plugins/pull/50)).
  5 sub-decisions:** sub-1 ✅ [PR #53](https://github.com/each4all/agentic-plugins/pull/53)
  (`plugins/orchestrator` MVP — multi-deliverable orchestration L2 plugin, plan-only)
  / sub-2 ✅ [PR #52](https://github.com/each4all/agentic-plugins/pull/52)
  (engineer branch-keyed active workflow lookup) / sub-3 ✅
  [PR #51](https://github.com/each4all/agentic-plugins/pull/51) (`/engineer:resume` drift dirty case
  enrichment) / sub-4 no-action (`active.md` registry stays absent — decision itself satisfies the
  resolution; no implementation required) / sub-5 ✅
  [PR #54](https://github.com/each4all/agentic-plugins/pull/54) (cross-host integration test contract).
  Resolves ADR-0011 §Stage 2 Non-Goals #1, #2, #3, #5, #7 in a single architectural cascade.
- **[ADR-0019](adr/0019-cross-plugin-invocation-contract.md)** — cross-plugin invocation contract
  (orchestrator → engineer dispatch + schema 1.1 parent linkage + macro completion semantics).
  ADR-0018 §sub-1 follow-up. **Status: Accepted (2026-05-10, [PR #60](https://github.com/each4all/agentic-plugins/pull/60)).
  6-PR cascade fully shipped:** PR-A ✅ [PR #61](https://github.com/each4all/agentic-plugins/pull/61)
  (engineer schema 1.1 — `parent_workflow` / `originating_subtask` / `parent_detached` fields)
  / PR-B ✅ [PR #63](https://github.com/each4all/agentic-plugins/pull/63)
  (orchestrator schema 1.0 → 1.1 bump + plan producers — required `verb` + `branch`, terminal-partial statuses, `terminal_marker`)
  / PR-C0 ✅ [PR #64](https://github.com/each4all/agentic-plugins/pull/64)
  (orchestrator single-subtask update API — atomic mutation + unblock pass + auto-terminal pass)
  / PR-C ✅ [PR #65](https://github.com/each4all/agentic-plugins/pull/65)
  (engineer parent-writeback helper + Stop hook integration — engineer-local until 2+ consumers per ADR-0010 §6)
  / PR-D ✅ [PR #66](https://github.com/each4all/agentic-plugins/pull/66)
  (`/orchestrator:next` same-host dispatch + `/orchestrator:done` manual backup + engineer Phase 0 parent-linkage env-var ingest)
  / PR-E ✅ [PR #67](https://github.com/each4all/agentic-plugins/pull/67)
  (`/orchestrator:finalize` + `/orchestrator:abort` §5 three-step ritual + macro Stop auto-archive A1-A4 — engineer `detach-archive` / `stop-archive` cross-plugin CLIs added in same cascade).
  PR-F (`--peer` cross-host dispatch via companions wire-spec) remains explicitly trigger-deferred per ADR-0019 §Implementation Roadmap.
  ADR-0011 amended in same Proposed → Accepted PR (§Stage 2 Non-Goal #8 + §3 cross-file lock-order pointer per ADR-0019 §6).
- **[ADR-0023](adr/0023-peer-runner-supervisor-layer.md)** — caller-side peer-runner
  supervisor for companion dispatch monitoring, cancellation, sweep, and bounded ledger
  retention without expanding `companions/contract.md` v0.1.1.
  **Status: Accepted (2026-05-12). PR-A through PR-E shipped:** PR-A
  [#80](https://github.com/each4all/agentic-plugins/pull/80) (ADR text) / PR-B
  [#81](https://github.com/each4all/agentic-plugins/pull/81) (engineer peer-runner primitive)
  / PR-C [#82](https://github.com/each4all/agentic-plugins/pull/82) (engineer command
  integration while preserving `dispatch-peer.mjs` compatibility and `peer-now` exclusion)
  / PR-D [#83](https://github.com/each4all/agentic-plugins/pull/83) (orchestrator mirror with
  resolve-before-record graceful degradation and `/orchestrator:plan` integration)
  / PR-E [#85](https://github.com/each4all/agentic-plugins/pull/85)
  (peer-now operational controls: `peer-runner.mjs run --kind peer-now` plus
  run-id based status/cancel while preserving `ensemble_results` exclusion).
- Verb-level alias expansion based on dogfood usage signal (deferred
  from Deliverable D, Phase 6 SUGGESTION #15).
- Larger per-deliverable scope criterion (Phase 6 SUGGESTION #16) — to
  be re-evaluated when a deliverable's review surfaces actionable
  segmentation rules.
These items are explicitly out of scope for Stage 2; they become
first-class Stage 2.5+ ADR follow-ups when accumulated dogfood usage
or Stage 3 work makes the design choice tractable.

### Stage 3+ — Runtime/operator track + remaining workflows

- **`plugins/orchestrator` (L2 capability)** ships per [ADR-0018](adr/0018-stage3-architecture-orchestrator-and-branch-context.md) §sub-decision-1 — first multi-verb L2 occupant. Plan-only MVP (`/orchestrator:plan` + Plan-verify peer ensemble) shipped first via [PR #53](https://github.com/each4all/agentic-plugins/pull/53); current plan skills document it as an opposite-host peer ensemble so Claude invokes Codex and Codex invokes Claude. The cross-plugin invocation contract is [ADR-0019](adr/0019-cross-plugin-invocation-contract.md) (sub-decision 1 follow-up). **As of 2026-05-11 the ADR-0019 cascade is fully shipped (PR-A through PR-E)** — `/orchestrator:plan` + `/next` + `/done` + `/finalize` + `/abort` + macro Stop auto-archive A1-A4 all operational on both hosts (Claude auto-archive via host Stop event; Codex manual helper via `adapters/codex/hooks/stop.mjs`). [ADR-0012](adr/0012-omcc-removal-preconditions.md) condition 1 transitions to satisfied (engineer parity unlocked — multi-deliverable workflow expressible via orchestrator + engineer composition); condition 3 still partial — accumulated Stage 3 non-trivial workflow evidence driven engineer-only is the trigger for that condition's satisfied transition. PR-F (`--peer` cross-host dispatch) remains trigger-deferred.
- **Runtime/operator control plane (ADR-0024, Accepted)** is the immediate Stage 3+ dogfood target. As of `plugin-runtime` v0.26.5, `plugins/runtime` is an L1 framework primitive with shipped `runtime:doctor`, `runtime:settings` with explicit plugin-management execution artifacts, `runtime:consensus` artifacts plus an explicit `execute --execute` companion boundary and remediation metadata, read-only `runtime:worktree` planning, runtime-owned `runtime:context` artifacts with explicit budget checks and dirty/source-staleness handoff guidance, explicit workflow-storage migration, runtime artifact inventory, and the advisory completion footer helper with latest context/consensus/PR-readiness guidance. Deferred boundaries remain explicit: no automatic unbounded consensus loops, no broad host-native config apply mode, no automatic host-session context mutation or compaction, no runtime artifact deletion, and no raw peer/consensus output in the main session.
- A design-domain plugin (`plugins/designer`) remains possible future work, referencing omcc-designer's experience (poster, social-graphics, frontend, brief, evaluation, etc.) with the same redesign stance, but it is no longer the active next-step trigger for ADR-0012 condition 3.
- Any omcc-dev workflow patterns not covered in Stage 2 are addressed (implemented or explicitly dropped with rationale)
- The user's daily workflows have agentic-plugins equivalents preferred over omcc
- omcc archived per ADR-0007's archive procedure

Cutover happens after Stage 3 exit criteria are met. See
[`adr/0007-migration-cutover-plan.md`](adr/0007-migration-cutover-plan.md)
for the cutover plan.

---

## Tooling

Decisions made 2026-05-02:

### Runtime and package management

- **Node** for companions and adapter scaffolding (`claude-companion.mjs`, `codex-companion.mjs`)
- **pnpm** as package manager — workspace-friendly for the monorepo (`companions/`, `kit/`, `plugins/<name>/`)
- **plain `.mjs`** (no TypeScript initially) — companions are small CLI shell-outs; introduce TS later if complexity demands
- No Python expected at this stage

### Test framework

- **vitest** for both unit and round-trip tests
- Companion round-trip tests invoke real `claude` / `codex` CLIs in CI — separate per-host workflow gates so each can fail independently
- Adapter conformance tests are pure unit tests (`kit/lint/`)

### CI

- **GitHub Actions**
- Per-host workflow gates: `claude-tests.yml`, `codex-tests.yml` — each can fail independently without blocking the other host's release
- Separate marketplace JSON validation workflow (cheap)

### Lint / format

- **prettier** for formatting (light footprint)
- eslint / biome added later if/when needed

### Release automation

- **release-please** (matches omcc precedent)
- SemVer with conventional-commits-driven version bumps
- Note: dual marketplace means dual catalog updates per release

### License

- **MIT** (matches omcc, simple and permissive)

---

## Quality bar for "actually works"

Adapted from the second research brief's "Phase exit criteria" section:

| Stage | Exit condition |
|---|---|
| Scaffolding | All ADRs 0001–0007 accepted; tooling decisions made |
| Reference plugin (Stage 1) | Reference plugin install→invoke→complete on both hosts; round-trip companion call passes; CI gates green per host |
| Self-development plugin (Stage 2) | Self-development plugin can drive agentic-plugins' own development workflow on both hosts; omcc-dev no longer required for agentic-plugins development |
| Cutover (after Stage 3) | All Stage 1–3 milestones met; user confirms ≥1 week sustained use without regression and with at least one clear improvement; omcc archive ready (per ADR-0007) |

Each stage's exit is **demonstrated working behavior**, not "code exists".

---

## Risks to track

These will get their own follow-up notes (probably as ADRs or DEV log
entries) when they materialize:

1. **Codex CLI evolves rapidly** — companion contract may need to adapt to new Codex versions. Mitigation: pin to specific Codex version ranges; track Codex changelog
2. **Agent Skills standard evolves** — SKILL.md frontmatter may gain/lose fields. Mitigation: validate skills against current spec in CI
3. **${CLAUDE_PLUGIN_ROOT} bug class in Claude Code** — known to fail in SessionStart hooks and Bash tool context. Mitigation: avoid relying on it for Claude adapter; use absolute paths derived at install time
4. **Bidirectional companion auth** — `claude` and `codex` both require credentials. Companion needs a story for non-interactive auth in CI. TBD
5. **omcc-dev's PreCompact-based continuity has no Codex equivalent** — see ADR-0007 stub

---

## Contributing (future)

Once agentic-plugins opens to external contributors:
- All changes via PR (no direct commit to main)
- ADRs for substantive design decisions
- Tests required for new adapter or companion features
- Documentation kept in sync with code

For now: solo development, but the conventions above are observed for
self-discipline.
