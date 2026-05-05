# engineer plugin

Engineer workbench for AI-assisted engineering across Claude Code &
Codex CLI, exposing **6 universal cognitive verbs** as canonical
skills:

| Verb | Skill | What it does |
|------|-------|--------------|
| **Investigate** | [`skills/investigate`](skills/investigate/SKILL.md) | Gather evidence, inspect context, scan codebase, diagnose bugs (`analysis` / `root-cause` profiles) |
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
0.1.0 release ships:

- 4 manifest + marketplace entries (Claude Code + Codex CLI)
- 6 SKILL.md bodies (cognitive verb skills)
- 4 shared protocol references (presentation / ensemble /
  orchestration / agent-taxonomy)
- 6 Codex agent definitions (`agents/openai.yaml` per skill)

Slash command surface (`/engineer:<verb>`), Codex skill mention
dispatch wiring (`$engineer:<verb>`), host adapters
(Claude PreCompact / Codex Stop hooks), peer ensemble dispatch
(`adapters/<host>/scripts/dispatch-peer.mjs`), and workflow state
I/O all ship in Stage 2 **Deliverable D** as a follow-up. Until
then, the 0.1.0 release is a documentation-and-skill-bodies
scaffold; the plugin is invokable only through:

- **Claude Code**: skill auto-activation. The Claude skill router
  matches trigger phrases in each SKILL frontmatter `description`
  and runs the skill in lightweight in-context mode (no subagent
  spawning, no peer ensemble dispatch).
- **Codex CLI**: explicit skill mention via `$engineer:<verb>`.
  Each `agents/openai.yaml` ships
  `policy.allow_implicit_invocation: false` (matching the Stage 1
  research plugin pattern), so trigger-phrase auto-activation does
  NOT fire on Codex — the user must invoke skills explicitly.
  Once invoked, the skill runs in the same lightweight in-context
  mode as Claude side.

Full command-mode behavior — local subagent dispatch + peer
ensemble synthesis + workflow state writes — is **not yet wired**
in 0.1.0. The SKILL.md "When invoked by command" sections describe
the contract that Deliverable D's adapters implement.

Workflow state persistence under
`<cwd>/.claude/agentic-engineer/workflows/` (per
[ADR-0011](../../docs/adr/0011-workflow-continuity-storage.md)
§Storage layout) is added in Deliverable D.

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

## Invocation (0.1.0 — pre-Deliverable D)

### Claude Code (skill auto-activation)

Each SKILL frontmatter `description` contains trigger phrases (English +
Korean). When the user's prompt matches, the skill auto-activates in
lightweight in-context mode (no subagent spawning, no peer ensemble
dispatch). Examples:

- *"explain this codebase"* → `investigate` (analysis profile)
- *"why isn't this working"* → `investigate` (root-cause profile)
- *"which approach is better, X or Y?"* → `decide`
- *"review my changes"* → `critique`
- *"fix the bug we found"* → `refine`

For full command-mode behavior (full subagent dispatch + peer
ensemble), use the Codex side until Deliverable D ships
`/engineer:<verb>` slash commands.

### Codex CLI (explicit skill mention)

```text
$engineer:investigate <topic>
$engineer:frame <problem context>
$engineer:decide <decision question>
$engineer:compose <task description>
$engineer:critique <change description or area>
$engineer:refine <feedback or bug context>
```

In 0.1.0 the user invokes engineer skills via explicit
`$engineer:<verb>` mention. The skills run in **lightweight
in-context mode**. Each `agents/openai.yaml` sets
`policy.allow_implicit_invocation: false` (matching the Stage 1
research plugin pattern), which deliberately disables
trigger-phrase auto-activation on Codex side — explicit mention
is required to invoke a skill, even when the user's prompt
contains words that match the skill's frontmatter trigger phrases.
Full command-mode behavior (local agent dispatch + peer ensemble +
synthesis) requires Deliverable D's
`adapters/codex/scripts/dispatch-peer.mjs` and is not yet
operational.

Once Deliverable D ships, both hosts dispatch the peer companion
(Claude side calls `codex-companion`, Codex side calls
`claude-companion`) via the canonical `companions` plugin, and
synthesis returns AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT-
classified findings in a single unified output.

### Profile arguments

Three verbs accept profile arguments:

```text
$engineer:investigate --profile=root-cause <bug context>
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

The plugin has no plugin-specific environment variables. All
companion discovery flows through the canonical `companions` plugin's
`discover-peer.mjs` library, so its `AGENTIC_COMPANIONS_ROOT`
override is the only relevant env var. Note that
`discover-peer.mjs` itself is loaded from the consumer plugin's
cache-glob bootstrap, not from the env-var-resolved directory.

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
  are permitted (e.g., `/engineer:audit` ≡
  `/engineer:critique --profile=full-codebase` once
  Deliverable D ships slash commands).

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
  workflow continuity Option III storage format (full implementation
  in Deliverable D)
- [`companions/contract.md`](../../companions/contract.md) —
  wire-spec contract v0.1.1
- [`plugins/companions/`](../companions/) — L1 framework primitive
  the engineer skills discover via `discover-peer.mjs`
- [`plugins/research/`](../research/) — L2 capability plugin;
  cross-plugin handoff target for cited evidence per
  ADR-0010 §5
