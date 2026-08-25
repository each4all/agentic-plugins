# agentic-plugins — Architecture

> Cross-host AI agent collaboration framework.
> Plugins author once, run natively in either Claude Code or OpenAI
> Codex CLI, with bidirectional companion bridges.

This document is the architectural overview. The foundational decisions
behind it live in [`adr/`](adr/) — when a section here references "why"
it points to an ADR rather than restating the rationale.

---

## The architecture: hexagonal core + 4-layer composition

agentic-plugins applies **Hexagonal architecture** (ports and adapters) to AI
agent plugins (ADR-0001), and extends it with a **4-layer composition
model** for plugin organization (ADR-0010).

### Hexagonal layers (per-plugin internal structure)

```
┌──────────────────────────────────────────────────────────┐
│ COMPANION (bidirectional bridges, first-party)           │
│  - claude-companion : Codex → Claude peer-agent call     │
│  - codex-companion  : Claude → Codex peer-agent call     │
│  - contract.md      : XML prompt + parsing spec (shared) │
├──────────────────────────────────────────────────────────┤
│ ADAPTER (host-specific, medium-thick)                    │
│  ┌────────────────────────┬─────────────────────────────┐│
│  │ claude/                │ codex/                       ││
│  │ - manifest             │ - manifest                   ││
│  │ - hooks (12 events)    │ - hooks (6 events, Stop-     ││
│  │ - subagent (md+YAML)   │   based continuity)          ││
│  │ - auto-delegation      │ - explicit dispatch          ││
│  │   orchestration        │   orchestration              ││
│  │ - ${CLAUDE_PLUGIN_ROOT}│ - absolute path / setup      ││
│  └────────────────────────┴─────────────────────────────┘│
├──────────────────────────────────────────────────────────┤
│ CORE (host-neutral, standards-aligned)                   │
│  - skills/<n>/SKILL.md  (Agent Skills standard)          │
│  - mcp-servers/<n>/      (MCP standard)                  │
│  - personas/<n>.md       (host-neutral subagent intent)  │
│  - prompt-templates/     (XML templates per companion)   │
│  - protocols/            (intent docs: ensemble,         │
│                           continuity, orchestration)     │
└──────────────────────────────────────────────────────────┘
```

### 4-layer plugin composition (cross-plugin organization)

```
┌─────────────────────────────────────────────────────────────┐
│ L4 — Profile (sub-discipline within persona, unbounded)     │
│   engineer: backend, frontend, devops, sre, ml, data, ...   │
│   designer: general, flow, ui, cta, content                 │
│     (image dropped per ADR-0042 SD5 — composed as L2)       │
│   (configuration data, not plugins; carried as args)        │
├─────────────────────────────────────────────────────────────┤
│ L3 — Persona / Workbench plugins (user install unit)        │
│   plugins/engineer  ← Stage 2                               │
│   plugins/founder   ← ADR-0036 (2nd L3 persona)             │
│   plugins/designer  ← ADR-0042 (3rd L3 persona)             │
│   skills: <persona>:<verb> for each of 6 verbs              │
│   verb-level sugar aliases inside plugin allowed (ADR-0010) │
├─────────────────────────────────────────────────────────────┤
│ L2 — Capability plugins (persona-agnostic activities)       │
│   plugins/orchestrator  ← Stage 3+ (first multi-verb L2     │
│                            occupant; ADR-0018/0019/0023)    │
│   (plugins/research retired at Stage 2.5+ per ADR-0014;     │
│    cited-brief absorbed into engineer:investigate)          │
│   plugins/image (ADR-0037) shipped; future: decision        │
│   skills: <capability>:<verb> for relevant verbs            │
├─────────────────────────────────────────────────────────────┤
│ L1 — Framework primitive plugins (infrastructure)           │
│   plugins/companions  ← Stage 1 (current, ADR-0008)         │
│   plugins/runtime    ← Stage 3+ runtime/operator (ADR-0024) │
│   plugins/attention  ← hook-only Claude sensors (ADR-0040)  │
└─────────────────────────────────────────────────────────────┘
```

Dependency direction: L4 (data) → L3 → L2 → L1.

### Six universal cognitive verbs (ADR-0010 §2)

Every L3 persona plugin and L2 capability plugin exposes skills named
by canonical verb:

| Verb | What |
|------|------|
| **Investigate** | gather evidence, scan, probe |
| **Frame** | turn evidence into problem model (goals/constraints/risks) |
| **Decide** | select direction, reject alternatives |
| **Compose** | produce artifact (code, plan, brief, ...) |
| **Critique** | evaluate against evidence/standards/goals |
| **Refine** | apply feedback, repair, iterate |

Convergence basis: 6 cognitive/process frameworks (Bloom, Miller,
OODA, PDCA, Double Diamond, Design Thinking) reduce to a small
recurrent control loop matching this verb set. Profile axis carries
unbounded discipline expansion without skill explosion.

See [`adr/0001-hexagonal-architecture.md`](adr/0001-hexagonal-architecture.md)
and [`adr/0010-plugin-boundary-policy.md`](adr/0010-plugin-boundary-policy.md).

---

## Where each layer lives

### `companions/` — cross-host bridges

Two companion CLIs, both first-party, sharing one contract.

```
companions/
├── README.md
├── contract.md             # XML prompt + output parsing spec
├── claude-companion.mjs    # Codex → Claude bridge
├── codex-companion.mjs     # Claude → Codex bridge
└── tests/                  # Round-trip smoke tests
```

`claude-companion` shells out to the `claude` CLI (headless mode);
`codex-companion` shells out to the `codex` CLI. Both speak the same
XML prompt contract and produce parseable output for the calling
adapter to consume.

See [`adr/0003-mcp-vs-companion.md`](adr/0003-mcp-vs-companion.md) for
why peer-agent invocation is companion-CLI rather than MCP, and
[`adr/0004-companion-ownership.md`](adr/0004-companion-ownership.md) for
why both companions are first-party (no third-party dependency).

### `kit/` — plugin authoring toolkit

Tools for plugin authors (internal and external):

```
kit/
├── README.md
└── lint/                   # Plugin-shape conformance (active, CI-gated)
                            #   - check-plugin-shape.mjs:
                            #       manifest required fields / name match across
                            #       .claude-plugin and .codex-plugin / skills path /
                            #       scripts executable bit / adapter traversal
                            #   - run via `npm run lint:plugin-shape`
                            #   - planned (not yet built): adapter-contract
                            #     conformance per ADR-0002 four-item rubric
```

Sub-directories `adapter-generator/` and `manifest-templates/` are
planned futures listed in [`kit/README.md`](../kit/README.md) but not
yet built — they are trigger-driven (3+ plugins in tree / external
contributor onboarding pain). See `kit/README.md` §"When to build kit
features".

### `plugins/` — reference dual-host plugins

Each plugin demonstrates the layered structure:

```
plugins/<plugin-name>/
├── .claude-plugin/plugin.json     # Claude Code plugin manifest
├── .codex-plugin/plugin.json      # Codex CLI plugin manifest
├── skills/                         # CORE: Agent Skills standard
│   └── <skill>/SKILL.md
├── personas/                       # CORE: persona description
│   └── <agent>.md
├── mcp-servers/                    # CORE: MCP server impls
├── prompt-templates/               # CORE: companion XML templates
└── adapters/                       # PER-HOST: thin where possible, medium where required
    ├── claude/
    │   └── hooks/hooks.json
    └── codex/
        ├── hooks/hooks.json
        └── agents/<agent>.toml      # Generated from personas/
```

See [`adr/0006-directory-layout-install-pattern.md`](adr/0006-directory-layout-install-pattern.md).

### `.claude-plugin/` and `.agents/plugins/` — marketplace catalogs

Each host's marketplace catalog at the repo root:

```
.claude-plugin/
└── marketplace.json        # Catalog for /plugin marketplace add each4all/agentic-plugins

.agents/
└── plugins/
    └── marketplace.json    # Catalog for codex plugin marketplace add each4all/agentic-plugins
```

### `docs/`

```
docs/
├── ARCHITECTURE.md         # This file
├── DEVELOPMENT.md          # How agentic-plugins is itself developed
└── adr/                    # Architecture Decision Records
```

---

## What is host-neutral vs host-specific

The split per [`adr/0001-hexagonal-architecture.md`](adr/0001-hexagonal-architecture.md):

| Concern | Layer | Why |
|---|---|---|
| SKILL.md content | CORE | Agent Skills open standard |
| MCP server impl | CORE | MCP open standard |
| Persona description (intent) | CORE | "What this agent does" is host-neutral |
| Prompt template (XML) | CORE | Companion contract is shared |
| Plugin manifest schema | ADAPTER | Different schemas per host |
| Hook event names | ADAPTER | Claude has 12 events, Codex has 6 |
| Hook payload semantics | ADAPTER | stdin near-1:1, stdout response divergent |
| Subagent format | ADAPTER | markdown+YAML (Claude) vs TOML (Codex) |
| Subagent invocation model | ADAPTER | Auto-delegate (Claude) vs explicit (Codex) |
| Continuity mechanism | ADAPTER | PreCompact (Claude) vs Stop-based (Codex) |
| Statusline | ADAPTER | Different native models — shell-command `statusLine` (Claude) vs closed-vocabulary `[tui].status_line` item list (Codex); ADR-0048, host truth in [`docs/assurance/statusline-host-truth-2026-07-22.md`](assurance/statusline-host-truth-2026-07-22.md) |
| Slash command surface | ADAPTER | `/plugin:skill` (Claude) vs `$skill` mention (Codex) |
| Companion bridge | COMPANION | Two scripts, one contract |

---

## What agentic-plugins does NOT try to unify

Per [`adr/0001-hexagonal-architecture.md`](adr/0001-hexagonal-architecture.md)
final note (the "honest scope" rule):

- Host-specific runtime semantics (auto-delegation, context lifecycle events) are NOT unified into a fake common API
- Each adapter implements its host's native pattern; core specifies *intent*, adapter specifies *execution*
- Where parity is impossible (e.g., arbitrary computed statusline segments on Codex, whose `[tui].status_line` is a closed item vocabulary), the limit is documented, not papered over

This avoids the Electron-style "feels off in both" failure mode.

---

## Migration from omcc

agentic-plugins replaces omcc. omcc remains operational (Claude-only)
until agentic-plugins reaches the cutover criteria.

See [`adr/0007-migration-cutover-plan.md`](adr/0007-migration-cutover-plan.md)
for the full cutover plan: redesign-over-port stance, Stage 1–3
milestones, cutover trigger conditions, data migration policy
(clean start, no automated import), and the omcc archive procedure.

Stage progression:

- **Stage 1** (complete) — `plugins/companions` + `plugins/research` (research retired at Stage 2.5+ per [ADR-0014](adr/0014-plugins-research-deprecation.md); cited-brief contract absorbed into `engineer:investigate`). Bidirectional companion contract verified.
- **Stage 2** (complete) — `plugins/engineer` self-development plugin. See [`adr/0010-plugin-boundary-policy.md`](adr/0010-plugin-boundary-policy.md), [`adr/0011-workflow-continuity-storage.md`](adr/0011-workflow-continuity-storage.md), and the ADR-0017 / ADR-0020–0023 continuity follow-ups.
- **Stage 3+** (in progress) — `plugins/orchestrator` L2 capability is shipped for macro planning, same-host engineer dispatch, macro completion, meta continuity commands, and peer-runner-supervised Plan-verify. `plugins/runtime` is the ADR-0024 L1 runtime/operator primitive; as of `plugin-runtime` v0.93.0 it ships the ADR-0048 bootstrap-observability surfaces (0.86.1 hardening the egress-ack intent WAL into a machine-global, fingerprint-scoped fence behind a strict wire-disposition gate; 0.86.2 deriving the Stage-8 egress-proof opt-in from run provenance rather than the derived row, and rendering each Stage-8 proof once from the completion reducer so control rows stay distinct from evidence rows) — run schema 1.2 + evidence-contract vnext (kind-discriminated fail-closed proof validators separating directional proofs from the single `egress-provider-ack` evidence member; the `notify.configured` / `notify.codex.configured` axis split; open-run additive migration with terminal runs kept as immutable evidence), the mode-bound exact Codex notify wiring probe with per-OS receiver argv, the agentic-6 statusline adapter (`statusline-plan.mjs` per-host exact probes — Claude `statusLine.command` with a render-only credential-free shim, Codex `[tui].status_line` ordered array; configured≠active honesty), and the triple-consent `runtime:doctor` egress-ack-proof executor — the one real-network Stage-8 proof: one closed-vocabulary synthetic send through the pinned `notify.mjs` emitter with write-ahead intent and mirror correlation, sanitized metadata only, the provider ack recorded separately from the owner's phone-receipt attestation with the derived `delivery-attested` label — atop the ADR-0047 Release B surfaces — the §6 bounded expired-claim sweep (`sweepExpiredClaims` behind the non-recursive `withReclaimLock` lock repair) and the §7 citation-aware artifact retention (`planRetention` read-only planner with a closed family registry, four fail-closed pins, and a reviewed plan hash; the `applyRetention` M1 deleting executor gated on that plan hash and a `--confirm`/dry-run boundary; and the `runtime:retention` CLI, adopted by doctor/dashboard) — atop the Release A notification surfaces — the filterable `response-needed` kind (new enum member with fixed `fired` status, normal urgency, and a `turn-complete`-mirroring subject) with the Codex shuttle `agent-turn-complete` → `response-needed` remap (kind-only, soft-degrading for un-re-rendered shuttles), the chain-aware notification-plan re-render, and the ADR-0047 §5 seeded standing notification watch in `runtime:compat plan` (host-scoped release-note signals, planning rows only — never an automatic mapping; plan schema 1.1 with an `actionable` flag so a standing-watch-only plan no longer degrades doctor/cutover compat state) — atop the ADR-0040 operator-observability surfaces — the notify-schema contract lib with atomic TTL dedupe, `notify_*` settings keys with a generalized key-family plan pipeline, the fail-closed `notify.mjs emit` fixed-argv channel emitter, `runtime:settings --notification-plan` Codex M1 fragment planning, and the `runtime:dashboard` Tier 1+2 read-only aggregate operator view — plus the ADR-0041 **E1 cross-machine notification egress** channel (a single pinned Telegram `POST` of a redacted, enumerated, capped metadata field set behind an env/verified-ignored-local opt-in over an in-process `node:https` IPv4-preferred transport (ADR-0041 §2d, swapped from the initial undici `fetch`); §4-amended head-on, one channel serving both the Claude attention sensors and the Codex `notify=` shuttle) — plus the ADR-0043 **four-persona workflow-projection seam** (`VALID_WORKFLOW_KINDS` and the completion-footer projection now span engineer/orchestrator/founder/designer, with per-persona footer command localization; the founder and designer sidecar emitters shipped with `plugin-founder-v0.4.0` (ADR-0043 S3) and `plugin-designer-v0.3.0` (ADR-0043 S4) — publish-needed completion mapping under the completion-output contract, dual 0.79.0 footer / 0.71.0 notify discovery floors, completing the four-persona onboarding — and a whitespace-padded supported kind is classified malformed rather than unsupported) — plus the S9 **completion-output contract** (`plugins/runtime/docs/completion-output-contract.md`: completion-flag minimum-content floors, the ADR-0043-delegated per-persona completion-state mapping rule with founder/designer's unchanged-HEAD `publish-needed` semantics, per-field completion provenance `explicit | derived | generic` with a visible ` [generic fallback]` text marker so silent runtime defaults can never render as authored content, and a sanitized `workflow checkpoint` footer line) — plus the ADR-0044 **session-generic handoff capture** exit side (S2–S4: the packaged `session-capture-contract.md` with its three closed `runtime-session-*-1.0` schemas and the `session` config family — `session_capture` enum `off | stop-hook`, shipped default `off`, one shared `loadSessionConfig` loader for the publisher gate and both diagnosis surfaces; explicit `runtime:context note --text|--file|--clear` staging and `status --slot` validated read-only slot inspection; the hook-grade `publish-session` slot publisher with commit-record `entry.json`, `fp1:` fingerprint no-op, `O_EXCL` mutex, and bounded sweep; and the shared `lib/session-readiness.mjs` half-enabled-chain diagnosis surfaced as doctor's `session_capture` and settings' `session_readiness` (report schema 1.21) sections, with the attention publisher floor read dynamically from its `data/runtime-floors.json` declaration — the Claude Stop firing point itself ships with attention S5) — plus the ADR-0045 **entry-time proposal surfaces** (S6–S8: the read-only `runtime:context entry-brief` arbiter — versioned tolerant readers with bounded scans over the entry sources, the §16 precedence lattice rendering one pointer-only brief with a single host-localized leading command, validated against the closed `runtime-entry-brief-1.0` schema (≤12 command-free rows, fixed safety note) via the shared `lib/host-localization.mjs` leaf; the user-scope-only `entry_brief` / `entry_brief_empty` config keys (resolution env > user-global > shipped default `off` / `silent`, repo targets structurally refused and reported via `refused_user_scope_only`); the snapshot-only `runtime:dashboard` `tier1.entry_advisory` reusing the same executor (dashboard schema 1.0 → 1.1 additive, absent in `--watch` along with the arbiter's git probes); and the `assessEntryBriefReadiness` §18 half-enabled-chain diagnosis surfaced as doctor's `entry_brief` and settings' `entry_readiness` sections — the Claude SessionStart firing point itself ships with attention S9, pinned to the S8a-recorded released floor 0.83.0 per the ADR-0043 released-floor rule) — plus `runtime:doctor` readiness diagnostics with an observed experience-parity score, a host-parity-baseline freshness check, stage-aware Codex `plugin_hooks` readiness (ADR-0030, including the peer-direction hook-gate readiness warning), recognition of the Codex per-plugin command surface (`codex plugin add`/`list`/`remove`, ADR-0032) with installed-state read from `codex plugin list --json` (ADR-0034) and an explicit policy-gated `codex plugin add` install executor behind `--execute-plugin-management` (ADR-0035 §5/§6), explicit workflow continuation proof through engineer state/dispatch bookkeeping, Claude plugin CLI diagnosis with slash `/plugin` observed only as host asymmetry, retired-plugin cleanup, and Codex `/hooks` review/trust when packaged hooks are ready, per-plugin hook review target checklists, including explicit disabled hook-state diagnostics, explicit `Trust: New hook - review required` and `Active=0` blocker guidance plus manifest-declared Codex hook command-portability diagnostics including bare `node` hook command detection, `runtime:settings` dry-run/apply planning with a probe-free `--skip-host-cli-probes` local-plan mode (owner-ratified discriminated report contract, `plugins/runtime/docs/settings-report-contract.md`) plus explicit plugin-management and retired-plugin cleanup execution artifacts, semantic failure classification for unavailable host plugin surfaces and sandboxed peer proof failures, Claude `claude plugin ...` install/update execution when the non-slash CLI is available, a narrow doctor-detected `claude plugin uninstall <plugin>@agentic-plugins` cleanup executor, manual follow-up checklists for host-native cleanup commands when cleanup is not executed or cannot complete, and an artifact-only `--attest-codex-hook-review` path for recording the operator-completed Codex `/hooks` review/trust step, sandbox-limited host auth diagnosis, retired plugin cleanup planning, `runtime:consensus` artifacts plus role-explicit peer lanes, quality-first policy, explicit consensus round policy (default 2 total rounds, hard cap 3, then `owner-decision-required`), owner-decision artifacts for exhausted or otherwise unresolved consensus, converged-run owner-ratification artifacts (`runtime:consensus ratify`) for synthesis-flagged residual owner levers with terminal-artifact mutation gates, artifact-only cancellation artifacts for stopped or abandoned consensus runs with a `--confirm-no-active-process` boundary, `runtime:consensus status --latest-open` selection for the newest non-terminal consensus run while preserving cancelled, converged, and owner-decided runs as audit artifacts, an explicit `execute --execute` companion boundary, convergence taxonomy, contradiction-aware rebuttal prompts, and remediation metadata, `runtime:compat` host-version drift snapshots, explicit release-note gap planning with changed-host/version coverage, and operator-explicit release-note URL fetch via `--fetch-release-notes-url`, read-only `runtime:worktree` planning, runtime-owned `runtime:context` handoff artifacts with budget checks, source-freshness and dirty-worktree guidance, an explicit workflow-storage migration surface, `runtime:cutover` omcc readiness auditing with explicit gate, unresolved-row details, unresolved scorecard requirement/gate detail, prompt-to-artifact completion audit checklist, ADR-0012 transition advice for condition 3/4 promotion blockers, latest footer reason output, legacy omcc-dev pattern-map checking, explicit forward-looking dogfood evidence recording, host/command-preserving observed-parity follow-up details, and concrete cutover operator-verification actions for Codex hook review, dogfood-window recording, and the blocked final owner declaration, runtime artifact inventory, the explicit non-interactive Codex hook trust-query boundary, and an advisory pointer-only completion footer with context/consensus/cancellation/PR-readiness/cutover-record guidance plus conservative completion-state next actions. The ADR-0046 **machine bootstrap** track adds `runtime:bootstrap` as the tenth runtime command — a machine-scoped, artifact-only bootstrap lifecycle: the live two-host probe seam (`probeMachineHostState`), bundle planning with hard-dependency closure, Stage 0 peer-host command detection, Stage 4–6 fragment rendering, the §1.6 plan-hash executor handoff to the settings executor, resume-with-mandatory-re-probe, read-only verification against recorded proof evidence, and a secrets-free portable machine profile export/seed — normatively pinned by the packaged `machine-bootstrap-contract.md` (§11.3 content tokens plus Stage 0 command-block agreement across the contract, the plugin README, the repo-root README, and the in-code `STAGE0_COMMANDS`, all content-enforced in CI). Automatic unbounded consensus loops, host-native config apply (the former narrow Codex `[features].plugin_hooks` write was removed per ADR-0035 §6), implicit release-note URL fetch without operator opt-in, automatic host-session context mutation/compaction, general plugin uninstall, Codex trust-state mutation, artifact deletion beyond the §7 plan-hash-gated retention executor, process killing through consensus cancellation, and richer risk/budget peer selection policy remain follow-up boundaries. `plugins/founder` ships as agentic-plugins' **second L3 persona** — new-business planning, [ADR-0036](adr/0036-founder-persona-business-planning.md) Accepted — re-anchoring the six cognitive verbs and the ensemble templates to business concerns and proving the 4-layer L3 model outside engineering. `plugins/designer` ships as the **third L3 persona** — code-first design/UX decision & quality assurance, [ADR-0042](adr/0042-designer-persona-design-ux-workbench.md) Accepted — adding a post-code critique loop over rendered screens + frontend code under usability / accessibility / conversion / consistency lenses with accessibility as a candidate-only veto gate, a 7-axis decision registry whose decisive axis shifts with the L4 design archetype, and a non-dispatch lifecycle that hands its saved spec to the frontend. designer composes the `image` L2 capability rather than re-implementing imagery, and excludes Figma in v1. Same 4-layer composition.
- **Cutover** — declared by user when Stage 1–3 milestones met, ≥1 week sustained use without regression, and ≥1 clear improvement over omcc.
