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

Until agentic-plugins has its first published plugin stable enough to
self-serve, **agentic-plugins development uses Claude Code as the primary host**
and `omcc-dev` as the workflow framework.

Concrete:
- New work happens in Claude Code sessions in this directory
- Workflows go through `omcc-dev`'s `/start`, `/fix`, `/audit`, etc.
- The session reads `AGENTS.md` (via Claude Code's `CLAUDE.md` → `@AGENTS.md` redirect) for project conventions
- ADR proposals follow the process documented in `AGENTS.md`

This is **transitional**. Once agentic-plugins has its own equivalent plugin
(see "Dogfooding plan" below), agentic-plugins switches to itself.

---

## Dogfooding plan

The strategic intent is for agentic-plugins to develop agentic-plugins. The path:

### Stage 0 — Scaffolding (current)

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
development environment. Stage 2 exit establishes the following
partial status; remaining condition progress is tracked in
subsequent stages and updated here.

| # | Condition | Stage 2 status | Notes |
|---|-----------|----------------|-------|
| 1 | engineer reaches omcc-dev parity | partial | Infrastructure complete (lock ownership protocol / atomic-write token verify / frontmatter validation schema closed / extended secret patterns / SessionStart hardening / envelope strict + structuredOutputContract emit). Sustained dogfood through Stage 3 completes the parity claim. **2026-05-06 Stage 2.5+ exit audit ([docs/audits/2026-05-06-stage25-exit-validation.md](audits/2026-05-06-stage25-exit-validation.md)) Q6 PARTIAL with 10 gap (G-1..G-10). [ADR-0017](adr/0017-stage25-continuity-and-schema-roadmap.md) consolidates the meta-command + `ensemble_results` frontmatter + Stop auto-archive items into a roadmap with per-trigger acceptance criteria.** |
| 2 | engineer guarantees bidirectional companion round-trip | partial | Claude direction on engineer's own code: ✓ (D Phase 5 dispatch-peer parallel-review). Codex direction: pending — Codex CLI commands schema absence (see Honest scope above) blocks the auto-trigger path; manual or upstream-resolved path is Stage 2.5+ work (ADR-0013 candidate). **2026-05-06 Stage 2.5+ exit audit Q4 PASS adds substantial evidence (128 unit + 4 smoke 양방향 실 LLM round-trip + JSON envelope wire validation per `companions/contract.md` §4.2); satisfied label still requires Codex auto-trigger path (ADR-0013).** |
| 3 | engineer alone is sufficient for agentic-plugins development | partial | Stage 2 itself was developed using `omcc-dev`, not engineer. The first single-verb engineer dogfood (Codex-side `investigate`, chess design landscape) showed the SKILL substance is usable end-user. Full sufficiency accumulates as Stage 3 (designer plugin) is developed using engineer. **2026-05-06 Stage 2.5+ exit audit records second engineer dogfood evidence (4 parallel agent + Codex plan-verify ensemble via `companions/codex-companion.mjs`).** |
| 4 | self-contained development scaffolding | partial | The development surface (AGENTS.md / CLAUDE.md / 12 ADRs / `test:plugin-shape` / `lint:plugin-shape` / per-host CI / `release-please` / `scripts/` / `kit/` / `plugins/companions`) is in place, but a per-item omcc-dependency audit has not yet been performed. Targeted at Stage 3 cushion or a dedicated Stage 2.5 review. **2026-05-06 Stage 2.5+ exit audit Q3 PASS confirms infrastructure (release-please cascade + 3-way validate-versions + drift detection + 16 ADR + ADR-0016 cross-package commit splitting). per-item omcc-dependency lens audit remains pending — targeted at Stage 3 cushion.** |

##### Stage 2.5+ ADR candidates surfaced

- **ADR-0013** — Codex CLI commands integration mechanism (Honest scope
  above; condition 2 Codex-direction enabler).
- **[ADR-0017](adr/0017-stage25-continuity-and-schema-roadmap.md)** — Stage 2.5+
  continuity and schema roadmap (meta commands `/engineer:resume`, `/engineer:checkpoint`,
  `/engineer:peer-now` + `ensemble_results` frontmatter persistence + Stop auto-archive
  semantics). Status: Proposed (2026-05-06). Consolidates audit findings from
  [docs/audits/2026-05-06-stage25-exit-validation.md](audits/2026-05-06-stage25-exit-validation.md)
  Q6 gap list. Each sub-decision has its own acceptance trigger / implementation owner PR /
  validation command — adoption does not imply implementation.
- Verb-level alias expansion based on dogfood usage signal (deferred
  from Deliverable D, Phase 6 SUGGESTION #15).
- Larger per-deliverable scope criterion (Phase 6 SUGGESTION #16) — to
  be re-evaluated when a deliverable's review surfaces actionable
  segmentation rules.
These items are explicitly out of scope for Stage 2; they become
first-class Stage 2.5+ ADR follow-ups when accumulated dogfood usage
or Stage 3 work makes the design choice tractable.

### Stage 3+ — L2 capability + Design domain + remaining workflows

- **`plugins/orchestrator` (L2 capability)** ships per [ADR-0018](adr/0018-stage3-architecture-orchestrator-and-branch-context.md) §sub-decision-1 — first multi-verb L2 occupant. Plan-only MVP (`/orchestrator:plan` + Plan-verify Codex ensemble) lands first; `/orchestrator:next` and `/orchestrator:done` follow alongside the cross-plugin invocation contract (Sub-decision 1 follow-up ADR). Acceptance trigger of ADR-0018 §sub-1 is satisfied by user explicit request to scaffold the MVP. This advances [ADR-0012](adr/0012-omcc-removal-preconditions.md) condition 3 — the "first non-trivial Stage 3 workflow developed engineer-only" criterion is now reachable through the orchestrator → engineer composition (cross-plugin invocation contract pending).
- A design-domain plugin (`plugins/designer`) ships, referencing omcc-designer's experience (poster, social-graphics, frontend, brief, evaluation, etc.) with the same redesign stance
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
