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
> `plugin-runtime` v0.80.0 (the S9 completion-output contract:
> `plugins/runtime/docs/completion-output-contract.md` flag
> minimum-content floors, the per-persona completion-state mapping rule,
> per-field completion provenance with the visible generic-fallback
> marker, and the sanitized workflow-checkpoint footer line; plus
> ADR-0040 operator observability: the
> notify-schema contract lib, `notify_*` settings keys, the `notify.mjs`
> emitter, `--notification-plan` Codex fragments, and the
> `runtime:dashboard` Tier 1+2 aggregate view; plus the ADR-0041 E1
> cross-machine notification egress channel; plus the probe-free
> `runtime:settings --skip-host-cli-probes` local-plan mode with its
> owner-ratified discriminated report contract,
> `plugins/runtime/docs/settings-report-contract.md`; plus the ADR-0043
> four-persona workflow-projection seam — `VALID_WORKFLOW_KINDS` and the
> completion-footer projection spanning
> engineer/orchestrator/founder/designer with per-persona footer command
> localization, the founder and designer sidecar emitters shipped via
> `plugin-founder-v0.4.0` (ADR-0043 S3) and `plugin-designer-v0.3.0`
> (ADR-0043 S4), completing the four-persona onboarding), runtime ships `doctor`, `settings` with
> observed experience-parity scoring, explicit plugin-management and retired-plugin cleanup execution artifacts, semantic failure
> classification for unavailable host plugin surfaces and sandboxed peer
> proof failures, Claude plugin command-surface preflight/blocking with
> manual follow-up checklists for host-native `claude plugin ...`
> cleanup commands when cleanup is not executed or cannot complete,
> Codex `/hooks` review/trust manual follow-ups when packaged hooks are ready,
> per-plugin hook review target checklists and disabled hook-state diagnostics,
> explicit `Trust: New hook - review required` and `Active=0` blocker guidance,
> manifest-declared Codex hook command-portability diagnostics, including
> bare `node` hook command detection,
> artifact-only operator attestation
> after that review (the former narrow Codex
> `plugin_hooks` host-config apply was removed per ADR-0035 §6), explicit workflow continuation proof through engineer state and dispatch, consensus artifacts with quality-first policy
> plus explicit consensus round policy (default 2 total rounds, hard cap 3,
> then `owner-decision-required`), owner-decision artifacts for exhausted
> or otherwise unresolved consensus, artifact-only consensus cancellation for
> stopped or abandoned runs with a `--confirm-no-active-process` boundary,
> latest-open consensus status selection that skips terminal consensus runs
> while preserving them as artifacts,
> an explicit `execute --execute` companion boundary, convergence
> taxonomy, contradiction-aware rebuttal prompts, and remediation
> metadata, `runtime:compat` host-version drift and release-note gap
> planning with changed-host/version coverage and operator-explicit URL fetch
> via `--fetch-release-notes-url`,
> read-only worktree planning, context-hygiene artifacts with
> explicit budget checks, dirty/source-staleness handoff guidance,
> workflow-storage migration, `runtime:cutover` omcc readiness
> auditing with explicit gate, unresolved-row details, legacy omcc-dev
> pattern-map checking, and explicit forward-looking dogfood evidence recording, runtime artifact
> inventory, and an
> advisory pointer-only completion footer with context, consensus,
> cancellation, PR-readiness guidance, cutover record guidance, and
> conservative completion-state next actions. Early PRs [#105](https://github.com/each4all/agentic-plugins/pull/105)
> / [#106](https://github.com/each4all/agentic-plugins/pull/106)
> and executor PRs [#129](https://github.com/each4all/agentic-plugins/pull/129)
> / [#130](https://github.com/each4all/agentic-plugins/pull/130)
> are historical ADR-0024 dogfood datapoints; the later runtime closeout
> through PR [#180](https://github.com/each4all/agentic-plugins/pull/180)
> plus release PR [#182](https://github.com/each4all/agentic-plugins/pull/182),
> followed by Codex hook settings PR [#196](https://github.com/each4all/agentic-plugins/pull/196)
> and release PR [#197](https://github.com/each4all/agentic-plugins/pull/197),
> plus semantic plugin-management failure PR [#198](https://github.com/each4all/agentic-plugins/pull/198)
> and release PR [#199](https://github.com/each4all/agentic-plugins/pull/199),
> followed by Claude plugin surface preflight PR [#200](https://github.com/each4all/agentic-plugins/pull/200)
> and release PR [#201](https://github.com/each4all/agentic-plugins/pull/201),
> then sandboxed peer proof failure classification PR [#202](https://github.com/each4all/agentic-plugins/pull/202)
> and release PR [#203](https://github.com/each4all/agentic-plugins/pull/203),
> followed by Claude manual follow-up checklist PR [#204](https://github.com/each4all/agentic-plugins/pull/204)
> and release PR [#205](https://github.com/each4all/agentic-plugins/pull/205),
> then doctor manual follow-up checklist PR [#206](https://github.com/each4all/agentic-plugins/pull/206)
> and release PR [#207](https://github.com/each4all/agentic-plugins/pull/207),
> then cleanup manual follow-up PR [#208](https://github.com/each4all/agentic-plugins/pull/208)
> and release PR [#209](https://github.com/each4all/agentic-plugins/pull/209),
> followed by consensus cancellation PR [#315](https://github.com/each4all/agentic-plugins/pull/315)
> and release PR [#316](https://github.com/each4all/agentic-plugins/pull/316),
> then latest-open consensus selection PR [#318](https://github.com/each4all/agentic-plugins/pull/318)
> and release PR [#319](https://github.com/each4all/agentic-plugins/pull/319),
> then footer latest-open linkage PR [#321](https://github.com/each4all/agentic-plugins/pull/321)
> and release PR [#322](https://github.com/each4all/agentic-plugins/pull/322),
> records the current runtime state, but these do not by themselves
> satisfy ADR-0012 condition 3. `plugins/designer` shipped later as the
> third L3 persona (ADR-0042); it was never the active next-step
> trigger for that condition. Detailed Stage 2 exit narrative under
> [§Stage 2 — Self-development plugin](#stage-2--self-development-plugin).

The ADR-0024 runtime/operator track accumulated the self-hosted
workflow evidence this transition required: all four ADR-0012
conditions reached `satisfied` on 2026-06-03 (conditions 3 and 4 by
owner determination), and per ADR-0007 the owner declared the
omcc → agentic-plugins cutover the same day — see
[§Cutover status (2026-06-03)](#cutover-status-2026-06-03). **`omcc-dev`
is retired as a fallback; agentic-plugins is the sole development
environment.** The cutover assurance map lives in
[`assurance/omcc-cutover-scorecard.md`](assurance/omcc-cutover-scorecard.md).

Concrete:
- New work starts with `/engineer:start`, `$engineer:start`, or
  `/orchestrator:plan` when feasible
- `omcc-dev` is retired; the canonical omcc history (including
  `omcc-dev`) is preserved at https://github.com/e16tae/omcc
- The session reads `AGENTS.md` (via Claude Code's `CLAUDE.md` → `@AGENTS.md` redirect) for project conventions
- ADR proposals follow the process documented in `AGENTS.md`

The transition is **complete**: agentic-plugins develops itself as the
default development workflow, with ongoing dogfood now feeding evidence
freshness (doctor proof re-records, hook re-attestation, host-parity
baseline refreshes) rather than condition promotion.

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
| 2 | engineer guarantees bidirectional companion round-trip | satisfied | Claude direction on engineer's own code: ✓ (D Phase 5 dispatch-peer parallel-review). Codex direction was historically pending on a Codex CLI commands auto-trigger path, with ADR-0013 retained as the future host-native command integration candidate. **2026-05-06 Stage 2.5+ exit audit Q4 PASS adds substantial evidence (128 unit + 4 smoke 양방향 실 LLM round-trip + JSON envelope wire validation per `companions/contract.md` §4.2). [ADR-0018](adr/0018-stage3-architecture-orchestrator-and-branch-context.md) §sub-5 ✅ PR [#54](https://github.com/each4all/agentic-plugins/pull/54) ships the cross-host integration test contract (claude→codex / codex→claude in-process state.mjs round-trip + stop-archive subprocess + standalone `.github/workflows/cross-host-tests.yml` CI matrix slot). 2026-05-16 satisfied transition. Latest installed proof: `plugin-runtime` `0.80.0` carries the native `runtime:doctor --permission-proof --execute-permission-proof --deep-peer-smoke --execute-deep-peer-smoke --workflow-continuation-proof --execute-workflow-continuation-proof` proof re-recorded on 2026-07-13Z as `doctor-20260713T235039Z-a35cb7` — the **ADR-0043 S4 designer footer-onboarding** loop (feature PR [#565](https://github.com/each4all/agentic-plugins/pull/565) rebase-merged as `2df14d5` — the designer terminal-handoff sidecar + completion-footer onboarding mirroring the founder S3 reference under copy-not-import, with the Plan-verify peer's 7 applied findings (rename-artifact and stale pre-S4 wording fixes, runbook §Scope-honesty documentation of the cross-workflow LWW re-render window, command-carrying compact next-action defaults, a multiline-static-import hardening of the acceptance boundary scan, and extended runbook pins) and the marker/slot concurrency family adjudicated to the ADR-0043 §2 last-writer-wins acceptance per the S3 precedent, completing the four-persona acceptance matrix; release PR [#566](https://github.com/each4all/agentic-plugins/pull/566) squash `9e6c9e5`, tag `plugin-designer-v0.3.0`, marketplace sync `176478f`; installed refresh via the settings executor `settings-20260713T152632Z-faeb49`, Claude `update-plugin` + Codex `upgrade-marketplace` both exit 0, both hosts report designer `0.3.0`; the hook-bearing designer upgrade (four hook files changed) version-invalidated the prior four-plugin attestation `settings-20260713T092639Z-52bd42`, and the operator's fresh `/hooks` confirmation was recorded as `settings-20260713T234950Z-f08600` (designer@0.3.0 / engineer@0.21.0 / founder@0.4.0 / orchestrator@0.13.0) **before** this proof; Claude Code `2.1.207` / `codex-cli 0.144.1`): experience parity **`ready` `100%` 8/8** with zero manual follow-ups, `overall` `pass` with `host_parity_baseline` `current`, Codex hook state `12/12` expected `enabled_trusted` with `unexpected_agentic_entries=2` (the retained pre-relocation attention rows, display-only), and all three execute proofs passed in **both** directions. The **ADR-0043 §5 per-persona e2e gate** is now discharged for **all four personas**: unpinned installed-cache discovery on each host's designer `0.3.0` rendered a real completion footer on a `set-terminal` terminal transition — `completion state: publish-needed` with host-localized routing (`/designer:resume` on Claude, `$designer:resume` on Codex), generic-marker-free per the completion-output contract §3.2 — closing the designer half of the install + re-attest + observe gate (the founder half was discharged by the S3 record below). This supersedes the **ADR-0043 S3 founder footer-onboarding** record `doctor-20260713T092820Z-0efc74`, whose loop (feature PR [#562](https://github.com/each4all/agentic-plugins/pull/562) rebase-merged as `578936b`/`cdd246d` per ADR-0016 two-package routing — the founder terminal-handoff sidecar + completion-footer onboarding with the Plan-verify peer's 11 applied findings (rendered-tombstone + primary/backstop origin split, immutable snapshot render, publish-needed mapping under the completion-output contract §2, dual 0.79.0 footer / 0.71.0 notify discovery floors) plus the engineer `entry-routing-contract.md` four-persona fold; release PR [#563](https://github.com/each4all/agentic-plugins/pull/563) squash `cbb282e`, tag `plugin-founder-v0.4.0`, marketplace sync `6fa5adf`; installed refresh via the settings executor `settings-20260713T092325Z-8faf07`, Claude `update-plugin` + Codex `upgrade-marketplace` both exit 0, both hosts report founder `0.4.0`; the hook-bearing founder upgrade (four hook files changed) version-invalidated the prior four-plugin attestation `settings-20260713T030937Z-f50815`, and the operator's fresh `/hooks` confirmation was recorded as `settings-20260713T092639Z-52bd42` (designer@0.2.1 / engineer@0.21.0 / founder@0.4.0 / orchestrator@0.13.0) **before** this proof; Claude Code `2.1.207` / `codex-cli 0.144.1`): experience parity **`ready` `100%` 8/8** with zero manual follow-ups, `overall` `pass` with `host_parity_baseline` `current`, Codex hook state `12/12` expected `enabled_trusted` with `unexpected_agentic_entries=2` (the retained pre-relocation attention rows, display-only), and all three execute proofs passed in **both** directions. The **ADR-0043 §5 per-persona e2e gate** was observed against the same installed set: unpinned installed-cache discovery on each host's founder `0.4.0` rendered a real completion footer on a `set-terminal` terminal transition — `completion state: publish-needed` with host-localized routing (`/founder:resume` on Claude, `$founder:resume` on Codex), generic-marker-free per the completion-output contract §3.2 — discharging the founder half of the ADR-0043 §5 install + re-attest + observe gate (designer's half was discharged by the S4 record above). This supersedes the **S9 completion-output-contract** record `doctor-20260713T025136Z-7758d3`, whose loop (feature PR [#558](https://github.com/each4all/agentic-plugins/pull/558) rebase-merged as `00dbc80`/`85bbd3d`/`4c8e59f` per ADR-0016 three-package routing; release PR [#559](https://github.com/each4all/agentic-plugins/pull/559) squash `1d02390`, tags `plugin-runtime-v0.80.0` + plugin-engineer-v0.21.0 + plugin-orchestrator-v0.13.0, marketplace sync `ddb43d4`; installed refresh via the settings executor `settings-20260713T025027Z-8f625a`, 4 update commands executed / 0 failed, both hosts report runtime `0.80.0` with engineer `0.21.0` / orchestrator `0.13.0`; Claude Code `2.1.207` / `codex-cli 0.144.1`): `overall` `pass` with `host_parity_baseline` `current` against the 2026-07-11 baseline, Codex hook state `12/12` expected `enabled_trusted` with `unexpected_agentic_entries=2` (the retained pre-relocation attention rows, display-only), and all three execute proofs passed in **both** directions. **Experience parity deliberately reads `partial` `91%`** (manual follow-up `codex-hook-review`): the engineer/orchestrator hook-bearing upgrades version-invalidated the four-plugin `/hooks` attestation `settings-20260712T015100Z-312fbb` (attested at engineer 0.20.1 / orchestrator 0.12.1), so a fresh operator `/hooks` confirmation plus `runtime:settings --attest-codex-hook-review` is required before parity reads `ready` again — the trusted hook entries themselves are unchanged (no hook file changed in this release, so trust hashes still match). The operator completed that `/hooks` confirmation the same day: the fresh four-plugin attestation `settings-20260713T030937Z-f50815` (designer@0.2.1 / engineer@0.21.0 / founder@0.3.1 / orchestrator@0.13.0) restored observed parity in the post-attestation record `doctor-20260713T030956Z-20dcc3` — **`ready` `100%` 8/8** with zero manual follow-ups, `overall` `pass`, baseline `current`, and all three execute proofs re-passed in **both** directions against the same installed 0.80.0 set. This supersedes the 0.79.0 four-persona-seam record re-recorded on 2026-07-12Z as `doctor-20260712T080638Z-005af5` — that loop (feature PR [#555](https://github.com/each4all/agentic-plugins/pull/555) squash `cb720e7`, behind ADR authoring PR [#553](https://github.com/each4all/agentic-plugins/pull/553) and Accepted-flip PR [#554](https://github.com/each4all/agentic-plugins/pull/554); release PR [#556](https://github.com/each4all/agentic-plugins/pull/556) squash `558f78a`, tag `plugin-runtime-v0.79.0`, marketplace sync `8ca4651`; installed refresh via the settings executor `settings-20260712T080408Z-5b98f9`, Claude `update-plugin` + Codex `upgrade-marketplace` both exit 0, both hosts report runtime `0.79.0`; Claude Code `2.1.207` / `codex-cli 0.144.1`): experience parity **`ready` `100%` 8/8** and `overall` `pass` with `host_parity_baseline` `current` against the 2026-07-11 baseline (the #550 refresh), Codex hook state `12/12` expected `enabled_trusted` with `unexpected_agentic_entries=2` (the retained pre-relocation attention rows, display-only), the four-plugin `/hooks` attestation `settings-20260712T015100Z-312fbb` (attested 2026-07-12T01:51Z) still current — runtime ships no hooks, so this upgrade did not change the hook-bearing set — and all three execute proofs passed in **both** directions. This supersedes the attention `0.4.1` relocation record, re-recorded on 2026-07-11Z as `doctor-20260711T045954Z-731e34` against the then-installed runtime 0.78.1 — the relocation loop (fix PR [#546](https://github.com/each4all/agentic-plugins/pull/546) `ceb2fb9` + docs PR [#547](https://github.com/each4all/agentic-plugins/pull/547) `1d20f82` + release PR [#548](https://github.com/each4all/agentic-plugins/pull/548), tag `plugin-attention-v0.4.1`, sync `553ac79`; installed refresh via the settings executor `settings-20260711T045604Z-075b26`, both hosts report `0.4.1`; Claude Code `2.1.207` / `codex-cli 0.144.1`): experience parity **`ready` `100%` 8/8** and `overall` `pass` — the #543 command-portability gate cleared because the relocated attention supplies neither Codex discovery input (`effective.status=not_packaged` on the installed cache), Codex hook state reads **12/12** `enabled_trusted` with `unexpected_agentic_entries=2` (retained pre-relocation attention rows, display-only; host did not prune, runtime non-mutation hash-verified), the four-plugin `/hooks` attestation `settings-20260711T045915Z-5ca22a` reads current, the Claude-side manifest-declared registration is live-fire proven (file-log `turn-complete` from a `claude -p` turn on the installed 0.4.1), and all three execute proofs passed in **both** directions — with the honest `host_parity_baseline` `stale` caveat (Claude Code `2.1.206`→`2.1.207` patch drift after the 2026-07-10 baseline; closed the same day by the #550 refresh to the 2026-07-11 baseline, per the 0.77.2 precedent). That record in turn superseded the 0.78.1-native 2026-07-10Z record `doctor-20260710T153802Z-276226` (Claude Code `2.1.206` / `codex-cli 0.144.1`, runtime installed `0.78.1` on **both** hosts — the installed-state refresh ran through the `runtime:settings --execute-plugin-management` executor, artifact `settings-20260710T153653Z-a8e721`, Claude `update-plugin` + Codex `upgrade-marketplace` both exit 0; all three execute proofs `passed` in **both** directions; `host_parity_baseline` `current`). Codex hook state now reads `14/14` expected bundled hooks `enabled_trusted` with `unexpected_agentic_entries=0` — attention's trusted `stop`/`subagent_stop` entries sit **inside** doctor's expected set (the #543 fix working as designed) and Claude's `Notification`, which current Codex never materializes, is surfaced as `unmapped=1` instead of a permanently-missing expectation. The `/hooks` re-attestation `settings-20260710T153728Z-5796b6` covers all **five** bundled hook-bearing plugins (`attention` `0.4.0` / `designer` `0.2.0` / `engineer` `0.20.0` / `founder` `0.3.0` / `orchestrator` `0.12.0`) and reads current — the prior 4-plugin attestation `settings-20260709T141913Z-8b7122` was invalidated as `plugin_set_changed` by design. **Experience parity deliberately reads `partial` `95%` (7/8 satisfied, weight 109/115) and `overall` reads `warning`**: the same release added the command-portability parity gate, so `lifecycle_hook_continuity` holds `partial` with `command-warnings=attention` (bare `node` + Claude-adapter command shape) until the attention package resolves its Codex posture — portable wrappers, manifest declaration, or restructure, tracked in `plugins/runtime/docs/follow-ups.md` (resolved 2026-07-11 by **restructure**: the Claude registration relocated to a manifest-declared `adapters/claude/hooks/hooks.json` with no root default file; the install proof landed the same day as `doctor-20260711T045954Z-731e34` — see the newest record above). The criterion got stricter; the host did not regress — every surface scored before #543 still passes, and a fresh attestation can no longer launder the warning into a 100% score. Fix PR [#543](https://github.com/each4all/agentic-plugins/pull/543) folded attention into doctor's expected Codex hook sets after host truth disproved the claude-adapter-only exclusion premise (Codex 0.144.1 default-file discovery is command-shape-blind), and its Codex Refine-verify pass surfaced and fixed the cache-only versioned-path matching blocker plus attestation version currency; release PR [#544](https://github.com/each4all/agentic-plugins/pull/544) cut tag `plugin-runtime-v0.78.1` with marketplace sync commit `e8d8fdc`, and the proof above was taken against that released binary, not a patched working tree. This record supersedes the 0.78.0 record `doctor-20260710T135955Z-d752f5` (`ready` `100%` 8/8 under the pre-#543 criterion; its loop was feature PR [#540](https://github.com/each4all/agentic-plugins/pull/540) probe-free `--skip-host-cli-probes` settings with contract PR [#539](https://github.com/each4all/agentic-plugins/pull/539) + release PR [#541](https://github.com/each4all/agentic-plugins/pull/541), tag `plugin-runtime-v0.78.0`, sync `51db10f`; its honest inventory-lag note — 2 trusted attention entries outside the expected set — became fix #543), and before it the 0.77.2 record `doctor-20260710T044745Z-1a789e` — identical pass results whose honest `host_parity_baseline` `stale` caveat was closed the same day by the baseline-refresh slice (`compat-20260710T054356Z-34315e` ingest, post-refresh `drift: none` `compat-20260710T104459Z-67ece6`); that record's own loop was fix PR [#534](https://github.com/each4all/agentic-plugins/pull/534) + release PR [#535](https://github.com/each4all/agentic-plugins/pull/535), tag `plugin-runtime-v0.77.2`, sync `e351888`, preserved as-recorded — the 0.77.1 record `doctor-20260709T141930Z-515ebf`, the 0.76.0 loop `doctor-20260707T140348Z-5a8fb8`, and the intermediate 0.77.0 record `doctor-20260709T131625Z-33c54d`, which read `partial` `91%` because doctor mis-classified designer’s newly-trusted Codex hooks as disabled — an absent `enabled` key means enabled, `/hooks` exposes no enable toggle, and the attestation executor is fail-closed while any expected entry is disabled, so no hook-bearing plugin trusted after the ADR-0035 §6 writer removal could be attested. designer was the first such plugin; its `Stop` hook demonstrably fired and archived a terminal designer workflow during a `codex exec` turn while doctor called it disabled. Fix PR [#530](https://github.com/each4all/agentic-plugins/pull/530) corrected the classifier (only an explicit `enabled = false` disables) and recorded the observed Codex semantics in `plugins/runtime/docs/codex-capability-baseline.md`; release PR [#531](https://github.com/each4all/agentic-plugins/pull/531) cut tag `plugin-runtime-v0.77.1` with marketplace sync commit `73b2a75`, and that release's own `ready` `100%` proof was likewise taken against a released binary, not a patched working tree. The preceding ADR-0042 releases — feat PR [#528](https://github.com/each4all/agentic-plugins/pull/528) (designer in the doctor/settings inventory) and PR [#529](https://github.com/each4all/agentic-plugins/pull/529) (ADR-0042 `Accepted`, `plugin-designer-v0.2.0`) via release PR [#521](https://github.com/each4all/agentic-plugins/pull/521), sync commit `7dce7fe` — bumped the installed runtime and closed the prior proof’s reuse gate. Both `claude -> codex` and `codex -> claude` passed the permission proof, deep peer smoke, and engineer workflow continuation proof through `state.mjs create`, `dispatch-peer.mjs`, `pending_ensemble`, and `ensemble_results` in an ephemeral temp repo. The explicit engineer dispatch proof satisfies ADR-0012 condition 2; ADR-0013 remains future command-surface integration work, not a blocker for this condition.** |
| 3 | engineer alone is sufficient for agentic-plugins development | satisfied | Stage 2 itself was developed using `omcc-dev`, not engineer. The first single-verb engineer dogfood (Codex-side `investigate`, chess design landscape) showed the SKILL substance is usable end-user. Full sufficiency accumulates as Stage 3 work is developed using engineer. **2026-05-06 Stage 2.5+ exit audit records second engineer dogfood evidence (4 parallel agent + Codex plan-verify ensemble via `companions/codex-companion.mjs`). [ADR-0018](adr/0018-stage3-architecture-orchestrator-and-branch-context.md) §sub-1 ✅ PR [#53](https://github.com/each4all/agentic-plugins/pull/53) lands `plugins/orchestrator` MVP — first multi-verb L2 capability plugin (plan-only `/orchestrator:plan` + Plan-verify Codex ensemble). The "first non-trivial Stage 3 workflow developed engineer-only" criterion is now reachable through the orchestrator → engineer composition; cross-plugin invocation contract (orchestrator → engineer, surfaced via `/orchestrator:next` + `/:done`) is a follow-up ADR per ADR-0018 §sub-1. **2026-05-11**: [ADR-0019](adr/0019-cross-plugin-invocation-contract.md) cross-plugin invocation contract fully shipped (PR-A through PR-E, see condition 1 row for the cascade PR list); the "reachable through orchestrator + engineer composition" wording is now operational rather than prospective. The remaining gating event is a Stage 3 non-trivial workflow being driven engineer-only; that dogfood instance is the trigger for the `partial → satisfied` transition on this condition. **2026-05-11**: [ADR-0020](adr/0020-engineer-integrated-workflow-umbrella.md) (Proposed) introduces `/engineer:start` as the engineer-internal single-deliverable lifecycle macro command — the missing surface that previously routed every non-trivial workflow through `omcc-dev:/start`. ADR-0020 PR 3 (the implementation that ships `commands/start.md` + `state.mjs diagnose-redundancy` + plugin-shape test sync) is the **trigger candidate** that lets evidence accumulate toward condition 3 satisfaction. Per ADR-0012's immutable-rubric clause (line 95), satisfaction itself is determined by accumulated non-trivial engineer-only workflows tracked here, not by ADR-0020's merge alone. The `partial → satisfied` transition fires when accumulated Stage 3 non-trivial workflow evidence completes engineer-only with no `omcc-dev` escape hatch. **2026-05-12 trigger candidate fired**: ADR-0020 4-PR roadmap fully shipped — PR 2 [#70](https://github.com/each4all/agentic-plugins/pull/70) `70e7596` (engineer schema 1.1-additive `workflow_type`) → PR 3 [#72](https://github.com/each4all/agentic-plugins/pull/72) `a02ff3f` (`/engineer:start` lifecycle macro + `state.mjs diagnose-redundancy` + session-start workflow_type branch) → PR 4 [#73](https://github.com/each4all/agentic-plugins/pull/73) `16451d2` (marketplace + manifest descriptions/keywords for `/engineer:start`). ADR-0020 status flipped to Accepted in the post-PR-4 follow-up. PR 4 itself was authored via direct edits in that session (small scope: 3 files / 11 lines / no test changes), so it did NOT count as the predicted first engineer-driven workflow. **2026-05-12 cross-host parity cascade**: [ADR-0021](adr/0021-codex-command-surface-parity-via-skill-wrappers.md) PR [#75](https://github.com/each4all/agentic-plugins/pull/75) `1ea63fc` ships `$engineer:start` macro skill mirror under `plugins/engineer/skills/start/`, formalizing the verb-skills + macro-skills two-category split per ADR-0010 §3 cascade. Codex CLI users can now drive the same Phase 0~7 lifecycle that Claude Code users access via `/engineer:start`, without waiting on ADR-0013. PR #75 itself was authored via `omcc-dev:/start` per dogfood policy, so it does NOT count as engineer-driven dogfood evidence either. **2026-05-12 meta-skill cascade closing ADR-0021 §6**: [ADR-0022](adr/0022-engineer-meta-skill-category.md) PR [#77](https://github.com/each4all/agentic-plugins/pull/77) `c4dd712` adds the third **meta-skill** category to ADR-0010 §3 (verb / macro / meta three-category split). The three engineer meta commands (`resume` / `checkpoint` / `peer-now`) now mirror as Codex meta skills with mandatory host-availability matrices. Codex parity for workflow-continuity ops is restored without waiting on ADR-0013. PR #77 itself was authored via `omcc-dev:/start` per dogfood policy, so it does NOT count as engineer-driven dogfood evidence either. **2026-05-13 ADR-0024 runtime/operator dogfood datapoint**: PR [#105](https://github.com/each4all/agentic-plugins/pull/105) shipped `runtime` footer `--context-latest` with stale metadata while preserving the advisory/pointer-only boundary; release PR [#106](https://github.com/each4all/agentic-plugins/pull/106) released `plugin-runtime` v0.5.0, with tag `plugin-runtime-v0.5.0` and marketplace sync commit `ba4f5ff`. **2026-05-16 release/install dogfood loop**: PR [#274](https://github.com/each4all/agentic-plugins/pull/274), release PR [#275](https://github.com/each4all/agentic-plugins/pull/275), PR [#277](https://github.com/each4all/agentic-plugins/pull/277), release PR [#278](https://github.com/each4all/agentic-plugins/pull/278), and docs/test PR [#279](https://github.com/each4all/agentic-plugins/pull/279) were completed without `omcc-dev`; runtime cutover records include `cutover-20260516T140012Z-a8a89e` for the PR #279 closeout. This records progress toward condition 3, but status remains `partial`; satisfaction still requires the forward one-week dogfood window to complete and no `omcc-dev` escape hatch to appear. **2026-05-29 ADR-0024 runtime/operator dogfood datapoint**: consensus run `consensus-20260529T123635Z-8722ee` produced converged aligned outcome on the "operator UX for `owner-decision-required`" design question (P4 hybrid: P1 enrich-status canonical + P3 doc backup, defer P2). Tracked summary at [`docs/assurance/runtime-consensus-dogfood-2026-05-29.md`](assurance/runtime-consensus-dogfood-2026-05-29.md). Full engineer cascade drove the dogfood (`investigate → decide → compose → critique → refine → execute`) without `omcc-dev:*` invocations. Friction surfaced: default `execution_timeout_ms=120000` was tight under `process_budget=2` concurrent dispatch; remediation guidance (single-peer retry with `--timeout-ms 240000`) worked as designed. This records additional progress toward condition 3 but per ADR-0012's immutable-rubric clause status remains `partial` until accumulated forward dogfood and no `omcc-dev` escape hatch sustain. **2026-06-03 satisfied (owner determination per ADR-0012 line 95)**: the forward one-week dogfood window completed (covered 7/7 across 2026-05-16..22, cutover records under `.agentic-plugins/runs/cutover`) with no `omcc-dev` escape hatch, and the engineer-only dogfood cascade `consensus-20260529T123635Z-8722ee` (full `investigate → execute` with no `omcc-dev:*` invocation) stands as the substantive engineer-only Stage 3 evidence. The owner (maintainer) explicitly determined accumulated sufficiency. **Honest caveat**: the 2026-06-03 runtime/cutover work in this same transition was authored directly (not via `engineer:start`), so it counts as omcc-dev-free development but NOT as additional engineer-only dogfood evidence — the satisfied transition rests on the owner determination plus prior accumulation, not on a fresh engineer-only workflow this session.** |
| 4 | self-contained development scaffolding | satisfied | The development surface (AGENTS.md / CLAUDE.md / 23 ADRs / `test:plugin-shape` / `lint:plugin-shape` / per-host CI / `release-please` / `scripts` / `kit` / `plugins/companions`) is in place. **2026-05-06 Stage 2.5+ exit audit Q3 PASS confirms infrastructure (release-please cascade + 3-way validate-versions + drift detection + ADR-0016 cross-package commit splitting). [ADR-0018](adr/0018-stage3-architecture-orchestrator-and-branch-context.md) Accepted (PR [#50](https://github.com/each4all/agentic-plugins/pull/50)) — Stage 3+ architecture cascade (5 sub-decisions, 4 implemented + 1 no-action). 2026-05-10 per-item omcc-dependency lens audit (workflow `audit-20260509T105532Z-3f0021`) confirms functional reading: 5/5 operational surfaces clean — Lens-B `scripts`+`kit` / Lens-C `plugins/companions` / Lens-D `.github/workflows` / Lens-E `package.json`+`release-please`+marketplace catalogs all 0 hits; Lens-A documentation 0 functional implicit, ~122 (c) clean for historical Context / Alternatives Considered / pattern attribution; Codex audit-scan (LOW affinity review-phase ensemble) ratifies functional verdict. Strict reading ("elimination of any references" per ADR-0012 line 46) remains pending until Stage 3 cushion concurrent with `omcc-dev` uninstall (= condition 3 trigger); ADR-0012 removal trigger requires all four conditions to reach the full satisfied state. F1 (DEVELOPMENT.md tone-drift in 'Initial development host' subsection + Stage 0 stage-history-stamp drift) was the single low-severity actionable; resolved in this PR. F2-F4 (ADR-0011 References list local-cache citation, audit provenance line, AGENTS.md/DEVELOPMENT.md `omcc-research`/`omcc-designer` experiential references) are acceptable-by-classification per Lens-A semantic verdict. **2026-06-03 satisfied (owner determination, concurrent with condition 3)**: `omcc-dev` is not installed as a Claude or Codex plugin (no `omcc` entry in `claude plugin list`) and was unused across the completed dogfood window; the local `~/Workspace/omcc` repo remains only as an archival source pending the owner's explicit ADR-0007 declaration. The strict-reading historical references (F2-F4) stay acceptable-by-classification per the Lens-A verdict, and the owner determined condition 4 satisfied for cutover-candidate purposes. Full elimination of historical references is intentionally NOT performed (it would distort the Context/Alternatives record); the owner accepts that classification.** |

##### Cutover status (2026-06-03)

All four ADR-0012 conditions are now `satisfied` (conditions 3 and 4 by owner
determination on 2026-06-03; the matrix rows above carry the honest caveat that
the 2026-06-03 runtime/cutover work was authored directly rather than via
`engineer:start`). `runtime:cutover-audit` reported **cutover-ready-candidate:
true** — omcc replacement scorecard 12/12, observed experience parity
ready/100% with zero manual follow-ups, the one-week omcc-dev-free dogfood
window covered 7/7 (2026-05-16..22), completion footer closed, consensus
`passed`, and consensus/context artifacts fresh.

Per [ADR-0007](adr/0007-migration-cutover-plan.md) the owner (maintainer) made
the explicit cutover declaration on 2026-06-03: **omcc may be archived/removed
from the agentic-plugins development environment.** The local `~/Workspace/omcc`
working copy was removed; the canonical omcc history (including `omcc-dev`) is
preserved on its remote `https://github.com/e16tae/omcc`. agentic-plugins is now
the sole development environment, completing the omcc → agentic-plugins cutover
planned by ADR-0005 / ADR-0007 / ADR-0012.

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

- **`plugins/orchestrator` (L2 capability)** ships per [ADR-0018](adr/0018-stage3-architecture-orchestrator-and-branch-context.md) §sub-decision-1 — first multi-verb L2 occupant. Plan-only MVP (`/orchestrator:plan` + Plan-verify peer ensemble) shipped first via [PR #53](https://github.com/each4all/agentic-plugins/pull/53); current plan skills document it as an opposite-host peer ensemble so Claude invokes Codex and Codex invokes Claude. The cross-plugin invocation contract is [ADR-0019](adr/0019-cross-plugin-invocation-contract.md) (sub-decision 1 follow-up). **As of 2026-05-11 the ADR-0019 cascade is fully shipped (PR-A through PR-E)** — `/orchestrator:plan` + `/next` + `/done` + `/finalize` + `/abort` + macro Stop auto-archive A1-A4 all operational on both hosts (Claude auto-archive via host Stop event; Codex automatic Stop hook once the bundled hooks load (generic `[features].hooks`, default on) plus `/hooks` review/trust, with `adapters/codex/hooks/stop.mjs` remaining the fallback helper). [ADR-0012](adr/0012-omcc-removal-preconditions.md) condition 1 transitions to satisfied (engineer parity unlocked — multi-deliverable workflow expressible via orchestrator + engineer composition); condition 3 still partial — accumulated Stage 3 non-trivial workflow evidence driven engineer-only is the trigger for that condition's satisfied transition. PR-F (`--peer` cross-host dispatch) remains trigger-deferred.
- **Runtime/operator control plane (ADR-0024, Accepted)** is the immediate Stage 3+ dogfood target. As of `plugin-runtime` v0.80.0, `plugins/runtime` is an L1 framework primitive with the shipped ADR-0040 operator-observability track (notify-schema contract lib with atomic TTL dedupe, `notify_*` settings keys via the generalized key-family plan pipeline, the fail-closed `notify.mjs emit` fixed-argv channel emitter, `runtime:settings --notification-plan` Codex M1 fragment plans, and the `runtime:dashboard` Tier 1+2 read-only aggregate operator view) plus the ADR-0041 **E1 cross-machine notification egress** channel (a single pinned Telegram `POST` of a redacted, enumerated, capped metadata field set behind an env/verified-ignored-local opt-in — ADR-0035 §4 amended head-on to add exactly one bounded network-egress effect domain — one channel serving both hosts) plus the ADR-0043 **four-persona workflow-projection seam** (`VALID_WORKFLOW_KINDS` and the completion-footer projection spanning engineer/orchestrator/founder/designer with per-persona footer command localization; a whitespace-padded supported kind classifies as malformed rather than unsupported; the founder and designer sidecar emitters shipped with `plugin-founder-v0.4.0` (ADR-0043 S3) and `plugin-designer-v0.3.0` (ADR-0043 S4) — publish-needed mapping + the 0.79.0 footer discovery floor, completing the four-persona onboarding) plus the S9 **completion-output contract** (`plugins/runtime/docs/completion-output-contract.md`: completion-flag minimum-content floors, the ADR-0043-delegated per-persona completion-state mapping rule with founder/designer's unchanged-HEAD `publish-needed` semantics, per-field completion provenance `explicit | derived | generic` with the visible ` [generic fallback]` text marker, and the sanitized `workflow checkpoint` footer line) plus shipped `runtime:doctor` readiness diagnostics with observed experience-parity scoring, a host-parity-baseline freshness check (installed claude/codex versions vs the recorded baseline → current/stale/missing/unknown), and stage-aware Codex `plugin_hooks` readiness (ADR-0030), explicit workflow continuation proof through engineer state/dispatch bookkeeping, Claude plugin CLI management diagnosis with slash `/plugin` observed only as host asymmetry, retired-plugin cleanup, and Codex `/hooks` review/trust when packaged hooks are ready, per-plugin hook review target checklists, including explicit disabled hook-state diagnostics, explicit `Trust: New hook - review required` and `Active=0` blocker guidance plus manifest-declared Codex hook command-portability diagnostics including bare `node` hook command detection, `runtime:settings` with a probe-free `--skip-host-cli-probes` local-plan mode (owner-ratified discriminated report contract at `plugins/runtime/docs/settings-report-contract.md`: evidence collection orthogonal to mutation, `report_scope`/`section_presence` discriminators in both modes, null-not-empty probe sections, no `runs/settings` execution artifact), explicit plugin-management and retired-plugin cleanup execution artifacts, semantic failure classification for unavailable host plugin surfaces and sandboxed peer proof failures, Claude `claude plugin ...` install/update execution when the non-slash CLI is available, a narrow doctor-detected `claude plugin uninstall <plugin>@agentic-plugins` cleanup executor, manual follow-up checklists for host-native cleanup commands when cleanup is not executed or cannot complete, and an artifact-only `--attest-codex-hook-review` path that records the operator-completed Codex `/hooks` review/trust step without mutating trust state, sandbox-limited host auth diagnosis, retired plugin cleanup planning, `runtime:consensus` artifacts plus role-explicit peer lanes, quality-first policy, explicit consensus round policy (default 2 total rounds, hard cap 3, then `owner-decision-required`), owner-decision artifacts for exhausted or otherwise unresolved consensus, converged-run owner-ratification artifacts (`runtime:consensus ratify`) for synthesis-flagged residual owner levers with terminal-artifact mutation gates, artifact-only cancellation artifacts for stopped or abandoned consensus runs with a `--confirm-no-active-process` boundary, `runtime:consensus status --latest-open` selection for the newest non-terminal consensus run while preserving cancelled, converged, and owner-decided runs as audit artifacts, an explicit `execute --execute` companion boundary, convergence taxonomy, contradiction-aware rebuttal prompts, and remediation metadata, `runtime:compat` host-version drift snapshots, explicit release-note gap planning with changed-host/version coverage, and operator-explicit release-note URL fetch via `--fetch-release-notes-url`, read-only `runtime:worktree` planning, runtime-owned `runtime:context` artifacts with explicit budget checks and dirty/source-staleness handoff guidance, explicit workflow-storage migration, `runtime:cutover` omcc readiness auditing with explicit gate, unresolved-row details, unresolved scorecard requirement/gate detail, prompt-to-artifact completion audit checklist, ADR-0012 transition advice for condition 3/4 promotion blockers, latest footer reason output, legacy omcc-dev pattern-map checking, explicit forward-looking dogfood evidence recording, host/command-preserving observed-parity follow-up details, and concrete cutover operator-verification actions for Codex hook review, dogfood-window recording, and the blocked final owner declaration, runtime artifact inventory, the explicit non-interactive Codex hook trust-query boundary, and the advisory completion footer helper with latest context/consensus/cancellation/PR-readiness/cutover-record guidance plus conservative completion-state next actions. Deferred boundaries remain explicit: no automatic unbounded consensus loops, no host-native config apply mode (the former narrow Codex `[features].plugin_hooks` write was removed per ADR-0035 §6), no implicit release-note URL fetch without operator opt-in, no general plugin uninstall, no automatic host-session context mutation or compaction, no Codex trust-state mutation, no runtime artifact deletion, no process killing through consensus cancellation, and no raw peer/consensus output in the main session.
- **`plugins/designer` (L3 persona)** ships per [ADR-0042](adr/0042-designer-persona-design-ux-workbench.md) (Accepted 2026-07-09) — the third L3 persona and the design-domain occupant reserved since ADR-0007 §Stage 3. Scoped as a **code-first design/UX decision & quality workbench**, not a visual-production tool: the six cognitive verbs re-anchored to UX/UI/CTA/flow, a 7-axis decision registry whose second decisive axis shifts with the L4 design archetype (`general`/`flow`→balanced, `cta`→conversion, `ui`→experience, `content`→clarity) and whose accessibility axis is a candidate-only veto gate, and a post-code critique→refine→re-critique convergence loop over the rendered screen + frontend code. Redesigned from omcc-designer's experience (poster, social-graphics, frontend, brief, evaluation), never ported: `print`/`brand`/`motion` are explicit Non-Goals, Figma is excluded in v1, imagery composes the `image` L2 capability (ADR-0037), and designer is non-dispatch (founder precedent). The nine-subtask `orchestrator:plan` macro drove PR1→PR7 plus a parallel runtime-inventory RT track; the PR7 real-topic dogfood found seven defects, fixed six, and recorded the seventh (a source-taxonomy gap) as demand-gated follow-up. It was never the active next-step trigger for ADR-0012 condition 3.
- Any omcc-dev workflow patterns not covered in Stage 2 are addressed in
  [`assurance/omcc-legacy-pattern-map.md`](assurance/omcc-legacy-pattern-map.md)
  as implemented, retained, rejected, or deferred with rationale.
- The user's daily workflows have agentic-plugins equivalents preferred over omcc
- omcc archived per ADR-0007's archive procedure

Cutover happens after Stage 3 exit criteria are met. See
[`adr/0007-migration-cutover-plan.md`](adr/0007-migration-cutover-plan.md)
for the cutover plan and
[`assurance/omcc-cutover-scorecard.md`](assurance/omcc-cutover-scorecard.md)
for the requirement-to-evidence gates that must be cleared before the user
declares cutover.

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
