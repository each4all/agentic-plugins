# engineer plugin

Engineer workbench for AI-assisted engineering across Claude Code &
Codex CLI, exposing **6 universal cognitive verbs** as canonical
skills:

| Verb | Skill | What it does |
|------|-------|--------------|
| **Investigate** | [`skills/investigate`](skills/investigate/SKILL.md) | Gather evidence, inspect context, scan codebase, diagnose bugs, produce cited briefs (`analysis` / `root-cause` / `cited-brief` profiles) |
| **Frame** | [`skills/frame`](skills/frame/SKILL.md) | Turn evidence into a problem model (goals, constraints, audience, success criteria, risks) |
| **Decide** | [`skills/decide`](skills/decide/SKILL.md) | Compare alternatives across multiple perspectives, recommend a direction |
| **Compose** | [`skills/compose`](skills/compose/SKILL.md) | Produce code or plan (`plan` / `code` profiles) |
| **Critique** | [`skills/critique`](skills/critique/SKILL.md) | Multi-perspective review of an artifact (default / `full-codebase` profiles) |
| **Refine** | [`skills/refine`](skills/refine/SKILL.md) | Apply feedback, fix bugs, iterate after critique |

Every command-mode skill dispatches a **bidirectional companion
ensemble** with an always-max policy: when invoked on Claude Code,
calls `codex-companion` for a Codex peer perspective; when invoked
on Codex CLI, calls `claude-companion` for a Claude peer
perspective. The peer's findings are reconciled into a unified
output through a 4-category synthesis taxonomy (`AGREED` /
`LOCAL-ONLY` / `PEER-ONLY` / `CONFLICT`) per
[`skills/_shared/references/ensemble-protocol.md`](skills/_shared/references/ensemble-protocol.md).

The 6-verb set is the canonical L3 persona surface defined in
[ADR-0010](../../docs/adr/0010-plugin-boundary-policy.md). Six
independent industry/cognitive frameworks (Bloom 1956, Miller 1956,
OODA, PDCA, Double Diamond, Design Thinking) converge on a small
recurrent control loop — gather → frame → choose → make → judge →
iterate — which the verb set names directly.

The plugin references the omcc-dev experience as a *lesson source*,
not a 1:1 port (per
[ADR-0007](../../docs/adr/0007-migration-cutover-plan.md)
§Redesign stance). The 4-layer composition (framework / capability /
persona / profile) is the structural extension over omcc-dev's flat
plugin model.

## Status

This plugin is in Stage 2 of agentic-plugins development (per
[`docs/DEVELOPMENT.md`](../../docs/DEVELOPMENT.md) §Stage 2). The
current release ships:

- 4 manifest + marketplace entries (Claude Code + Codex CLI)
- 10 SKILL.md bodies — 6 cognitive verb skills + 1 macro skill
  (`start` per ADR-0021) + 3 meta skills
  (`resume` / `checkpoint` / `peer-now` per ADR-0022)
- 4 shared protocol references (presentation / ensemble /
  orchestration / agent-taxonomy)
- 10 Codex agent definitions (`agents/openai.yaml` per skill — one
  per verb / macro / meta skill, with
  `policy.allow_implicit_invocation: false` on each)
- **Claude slash command surface** — 11 commands total:
  6 canonical verbs
  (`/engineer:investigate|frame|decide|compose|critique|refine`)
  + 1 sugar alias (`/engineer:audit` ≡
  `/engineer:critique --profile=full-codebase` per ADR-0010 §3)
  + 1 lifecycle macro command (`/engineer:start`,
  ADR-0020 §Sub-decision 1)
  + 3 meta commands (`/engineer:resume` / `:checkpoint` /
  `:peer-now`, ADR-0017 §sub-decisions 1/2/3)
- **Host-shared canonical scripts** — `scripts/state.mjs`
  (workflow I/O per ADR-0011) + `scripts/dispatch-peer.mjs`
  (blocking companion task wrapper per `companions/contract.md`
  v0.1.1) + `scripts/peer-runner.mjs` (ADR-0023 caller-side
  ledger/status/cancel/sweep primitive; managed verb-command ensemble
  dispatch path plus `peer-now` operational controls)
- **Claude Code hooks** (`hooks/hooks.json` + `adapters/claude/hooks/{pre-compact,stop,session-start}.mjs`) — automatic
  state snapshot per ADR-0011 §4 (PreCompact + Stop + SessionStart)
- **Codex stop helper** (`adapters/codex/hooks/stop.mjs`) —
  manual-invoke; Codex CLI does not expose a host hook surface
  (as of 0.128.0), so SKILL command-invoked mode triggers this
  script as its final step
- **Workflow state persistence** under
  `<cwd>/.claude/agentic-engineer/workflows/<workflow_id>.md` per
  [ADR-0011](../../docs/adr/0011-workflow-continuity-storage.md) §1

Both hosts can invoke engineer verbs in **command-invoked mode**
(local subagent dispatch + peer ensemble dispatch). On Claude Code
the slash command additionally wires Phase 0 (continuity) and Phase 2
(state finalize) automatically; on Codex CLI the workflow state
writes are NOT yet automatic — see "Codex-side scope (Stage 2,
honest)" below for the precise division. The engineer Stage 2
non-goals (sharded workflow / drift classification / cross-host
transition guarantees / `/engineer:resume`) were resolved across
the ADR-0017 + ADR-0018 cascade; **multi-active workflows are now
per-branch via [ADR-0018](../../docs/adr/0018-stage3-architecture-orchestrator-and-branch-context.md)
§sub-2** — `git checkout <branch>` swaps the active workflow,
and the workflows directory may carry one workflow per branch.

The plugin is invokable through:

- **Claude Code**: explicit slash command (`/engineer:<verb>`)
  for full command-mode behavior (Phase 0 continuity → SKILL
  command-invoked mode → state finalize), OR skill
  auto-activation for lightweight in-context mode (no subagent
  spawning, no peer dispatch).
- **Codex CLI**: explicit skill mention via `$engineer:<verb>`.
  Each `agents/openai.yaml` ships
  `policy.allow_implicit_invocation: false` (matching the Stage 1
  research plugin pattern), so trigger-phrase auto-activation does
  NOT fire on Codex — the user must invoke skills explicitly.
  When invoked through SKILL command-invoked mode, the skill runs
  full command-mode behavior; in lightweight context, it runs the
  reduced in-context mode.

## Install

The engineer plugin discovers companion scripts via cache-glob
through the [`companions`](../companions/) plugin's
`discover-peer.mjs` library. The companions plugin must be installed
alongside it. Install order does not matter; the plugin degrades
gracefully when companions are absent (skills proceed
orchestrator-only).

### Claude Code

```sh
/plugin marketplace add each4all/agentic-plugins
/plugin install companions@agentic-plugins
/plugin install engineer@agentic-plugins
```

### Codex CLI

```sh
codex plugin marketplace add each4all/agentic-plugins
```

Then enable both plugins by adding the following to
`~/.codex/config.toml`:

```toml
[plugins."companions@agentic-plugins"]
enabled = true

[plugins."engineer@agentic-plugins"]
enabled = true
```

## Invocation

### Claude Code — slash command (full command-mode)

```text
/engineer:investigate <topic>
/engineer:frame <problem context>
/engineer:decide <decision question>
/engineer:compose <task description>
/engineer:critique <change description or area>
/engineer:refine <feedback or bug context>

# Sugar alias (ADR-0010 §3 verb-level alias):
/engineer:audit <area>     # ≡ /engineer:critique --profile=full-codebase

# Meta commands (ADR-0017 §sub-decisions 1/2/3; mirror as Codex meta skills per ADR-0022):
/engineer:resume [archive [<workflow-id>]]   # Drift report / archive the active workflow
/engineer:checkpoint <one-line summary>      # Record a progress checkpoint
/engineer:peer-now --peer <claude|codex> --prompt-text "..."  # Ad-hoc side-channel peer consultation
                                          # (or --prompt-file <path>; not an ensemble — no synthesis label)

# Lifecycle macro (ADR-0020 §Sub-decision 1):
/engineer:start <feature> [--base-branch <ref>]
    # Sequences Phase 0 (continuity + diagnose-redundancy) through
    # Phase 7 (commit) using the six verb skills intra-document.
    # Single-pass only; for multi-deliverable use /orchestrator:plan.
```

Each slash command runs:
1. **Phase 0** — workflow continuity check per ADR-0011 §5 implicit
   resume. Either creates a new workflow under the directory-level
   lock or appends a phase note to the existing **same-branch**
   active workflow (per-branch single-active per ADR-0018 §sub-2;
   parallel-branch workflows coexist in the workflows directory).
2. **Phase 1** — SKILL.md command-invoked mode: local subagents
   dispatched in parallel, peer ensemble dispatched in background
   per `skills/_shared/references/ensemble-protocol.md`,
   synthesized into AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT.
3. **Phase 2** — state finalize: phase note appended to the
   workflow body recording ensemble launch, synthesis verdict, and
   recommended next verb.

Hooks (PreCompact / Stop / SessionStart on Claude Code) snapshot
the workflow's `last_snapshot` field automatically without user
action.

### Claude Code — skill auto-activation (lightweight)

When the user's prompt matches trigger phrases in a SKILL's
frontmatter `description` AND no slash command was issued, the
skill auto-activates in lightweight in-context mode — no subagent
spawning, no peer ensemble dispatch, no workflow state writes.
Examples:

- *"explain this codebase"* → `investigate` (analysis profile)
- *"why isn't this working"* → `investigate` (root-cause profile)
- *"which approach is better, X or Y?"* → `decide`
- *"review my changes"* → `critique`
- *"fix the bug we found"* → `refine`

For full command-mode behavior, use the slash command form above.

### Codex CLI — explicit skill mention

```text
# Verb skills (cognitive activity)
$engineer:investigate <topic>
$engineer:frame <problem context>
$engineer:decide <decision question>
$engineer:compose <task description>
$engineer:critique <change description or area>
$engineer:refine <feedback or bug context>

# Macro skill (lifecycle sequencer — Phase 0 continuity → Phase 7 commit)
$engineer:start <feature description>

# Meta skills (workflow-continuity ops on the active workflow)
$engineer:resume [archive [<workflow-id>]]
$engineer:checkpoint <one-line progress summary>
$engineer:peer-now --peer <claude|codex> --prompt-text "..."   # or --prompt-file <path>
```

**Codex-side parity** (per ADR-0021 + ADR-0022): the Codex manifest
exposes the six verb skills, the `start` macro skill (ADR-0021), and
three meta skills (`resume` / `checkpoint` / `peer-now` per
ADR-0022). Each skill's canonical cognitive runbook lives in
`skills/<name>/SKILL.md` and is loaded directly when the skill is
mentioned. Codex CLI's plugin-commands integration is still
unfinalized (ADR-0013 reserved), so Codex side does not yet have
Claude-equivalent slash commands; the skill-mention surface is the
canonical Codex entry point.

**Host-availability honesty** (per ADR-0022 §Decision §3): meta
skills carry an explicit Host availability matrix in their
SKILL.md describing which parts work on Claude vs Codex. The
prominent asymmetry: SessionStart re-injection (which surfaces the
`latest_checkpoint.summary` written by `$engineer:checkpoint`) is
**Claude-only** today — a Codex session writes the checkpoint, but
only the next Claude session re-injects it. peer-now is symmetric
(`companions/` ships bidirectional bridges). resume's drift report
and archive subcommand are host-agnostic.

Each `agents/openai.yaml` sets
`policy.allow_implicit_invocation: false` (matching the Stage 1
research plugin pattern), which deliberately disables
trigger-phrase auto-activation on Codex side — explicit mention
is required, even when the user's prompt contains words that match
trigger phrases.

**Codex-side scope (Stage 2, honest)**:

- **What works**: explicit `$engineer:<verb>` mention runs the SKILL's
  command-invoked mode, including managed peer ensemble dispatch via
  `scripts/peer-runner.mjs run` (which calls `claude-companion` for
  the Claude peer perspective and synthesizes AGREED / LOCAL-ONLY /
  PEER-ONLY / CONFLICT findings). `$engineer:peer-now` also routes
  through `scripts/peer-runner.mjs run --kind peer-now`, preserving
  raw response semantics while adding `run_id` status/cancel support.
  `scripts/dispatch-peer.mjs` remains available as the blocking
  compatibility surface for raw callers.
- **What is NOT yet wired**: workflow continuity on Codex side
  (Phase 0 directory-lock + create-or-append, Phase 2 state finalize)
  is *not* automatic — Codex CLI does not expose a slash-command surface
  equivalent to Claude Code's `/engineer:<verb>`, and the Codex
  command-adapter that would call `state.mjs` create/append wrappers
  ships in a follow-up. Until then, Codex-side invocations either run
  state-less, or the user invokes `state.mjs` CLI subcommands manually
  (`node "$ENGINEER_ROOT/scripts/state.mjs" find-active|create|append|snapshot ...`).
- **Stop snapshot**: Codex CLI lacks a native session-end hook surface;
  the helper `adapters/codex/hooks/stop.mjs` exists for manual
  invocation but is not auto-triggered.

Claude side ships full command-mode (Phase 0/1/2 + automatic
PreCompact/Stop/SessionStart hooks). The output structure is
host-agnostic — when Phase 1 ensemble dispatches on Codex, the
synthesis follows the same AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT
categories as on Claude; only the surrounding state-write semantics
differ.

### Profile arguments

Three verbs accept profile arguments:

```text
$engineer:investigate --profile=root-cause <bug context>
$engineer:investigate --profile=cited-brief <topic>     # produces a saved cited brief artifact
$engineer:compose --profile=code <task description>
$engineer:critique --profile=full-codebase <area>
```

A missing profile uses the default (per each SKILL.md profile
table). An unknown profile falls back to the default with a one-line
user-facing warning.

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `AGENTIC_COMPANIONS_ROOT` | Absolute path containing `claude-companion.mjs` and `codex-companion.mjs`; the discovery library resolves the peer companion under this root, bypassing cache-glob discovery. Useful for development workflows pointing at a source-tree checkout. | (cache-glob fallback through the `companions` plugin) |
| `PEER_RUN_CANCEL_GRACE_MS` | Grace period used by `scripts/peer-runner.mjs cancel` between TERM and KILL. | `10000` |
| `PEER_RUN_STALE_GRACE_MS` | Age threshold used by `scripts/peer-runner.mjs sweep` before a dead, no-envelope non-terminal run is marked `orphaned`. | `60000` |
| `PEER_RUN_RETENTION_TTL_DAYS` | Terminal peer-run ledger TTL used by `scripts/peer-runner.mjs sweep --apply`. | `14` |
| `PEER_RUN_RETENTION_CAP` | Maximum terminal peer-run ledger directories retained per repo by `scripts/peer-runner.mjs sweep --apply`. Non-terminal runs are preserved. | `200` |
| `RESEARCH_OUTPUT_ROOT` | Absolute path for cited-brief artifacts produced by `engineer:investigate --profile=cited-brief`. The brief saves to `<root>/YYYY-MM-DD_<topic-slug>/research_brief.md`. Name preserved from Stage 1 `plugins/research` for backwards compatibility per [ADR-0014](../../docs/adr/0014-plugins-research-deprecation.md). | `./output/` |

Companion discovery flows through the canonical `companions` plugin's
`discover-peer.mjs` library, so `AGENTIC_COMPANIONS_ROOT` overrides
the cache-glob discovery for development workflows. Note that
`discover-peer.mjs` itself is loaded from the consumer plugin's
cache-glob bootstrap, not from the env-var-resolved directory.

`RESEARCH_OUTPUT_ROOT` applies only to the `cited-brief` profile of
`engineer:investigate` — see
`skills/investigate/references/output-file-rules.md` for sandbox
enforcement and topic-slug sanitization rules.

## What this plugin does NOT do (Stage 2 non-goals)

- **Sharded workflow storage** — `/start`-equivalent multi-deliverable
  workflow shards are deferred. Stage 2 ships single-pass workflow
  state only (per ADR-0011 §Stage 2 Non-Goals item 1).
- **Fine-grained drift classification ladder** — Stage 2 implements
  only `clean` vs `dirty` detection; the
  `clean / dirty-aligned / dirty-divergent / divergent` 4-tier
  ladder is deferred (item 2).
- **Explicit cross-host workflow transition guarantees** — the
  workflow file format itself is host-agnostic (Markdown+YAML, no
  host-specific binary state), but Stage 2 does not promise that a
  workflow started on Claude can be picked up on Codex mid-flight
  with parity (item 3).
- **omcc-dev data migration** — workflows produced under omcc-dev are
  not consumed by engineer; users migrate by starting fresh (item 4).
- **Plugin-name-level aliases** (`/dev:`, `/eng:`) — not supported
  in Stage 2 (item 9). Verb-level sugar aliases inside the plugin
  are permitted; `/engineer:audit` (≡
  `/engineer:critique --profile=full-codebase`) ships in this
  release as the sole sugar alias.

## References

- [ADR-0001](../../docs/adr/0001-hexagonal-architecture.md) —
  hexagonal layered model that this plugin extends to 4 layers
- [ADR-0006](../../docs/adr/0006-directory-layout-install-pattern.md)
  — per-plugin layout this plugin follows
- [ADR-0007](../../docs/adr/0007-migration-cutover-plan.md) —
  redesign stance: omcc-dev is the lesson source, not a port target
- [ADR-0008](../../docs/adr/0008-companion-distribution-model.md) —
  cache-glob discovery + `AGENTIC_COMPANIONS_ROOT` env override
  contract this plugin consumes via the `companions` plugin's
  `discover-peer.mjs`
- [ADR-0009](../../docs/adr/0009-companion-contract-v0-1-1-prompt-file-stdin-precedence.md)
  — companion contract v0.1.1: `--prompt-file` precedence fix
- [ADR-0010](../../docs/adr/0010-plugin-boundary-policy.md) — 4-layer
  composition + 6 cognitive verbs + naming convention + sugar alias
  policy this plugin instantiates
- [ADR-0011](../../docs/adr/0011-workflow-continuity-storage.md) —
  workflow continuity Option III storage format implemented by
  `scripts/state.mjs` + the Claude Code hooks in this release
- [`companions/contract.md`](../../companions/contract.md) —
  wire-spec contract v0.1.1
- [`plugins/companions/`](../companions/) — L1 framework primitive
  the engineer skills discover via `discover-peer.mjs`
- [ADR-0014](../../docs/adr/0014-plugins-research-deprecation.md) —
  plugins/research retirement (Stage 2.5+ archive per Amendment
  2026-05-06); cited-brief contract absorbed into the cited-brief
  profile of `engineer:investigate` (this plugin)
