# ADR-0021: Codex command-surface parity via skill wrappers — macro skill category

## Status

Accepted (shipped 2026-05-12 — [#75](https://github.com/each4all/agentic-plugins/pull/75) `1ea63fc`)

## Context

[ADR-0020](0020-engineer-integrated-workflow-umbrella.md) accepted
on 2026-05-12 introduced `/engineer:start`, a *lifecycle macro
command* (ADR-0020 §Sub-decision 1) that sequences the engineer
plugin's single-deliverable lifecycle through eight phases (Phase 0
continuity → Phase 7 commit). The macro shipped as a Claude-side
slash command at `plugins/engineer/commands/start.md`.

The cross-host parity gap surfaced immediately. The `plugins/engineer/
.codex-plugin/plugin.json` `longDescription` shipped with this self-
acknowledged limitation:

> "the macro is currently Claude-only pending ADR-0013 (Codex CLI
> plugin-commands schema), and on Codex CLI users continue to drive
> each phase via the six `$engineer:<verb>` skill mentions."

[ADR-0013](README.md#status) is reserved — the Codex CLI plugin-
commands schema has no trigger yet (Stage 3+ trigger candidate per
AGENTS.md). The Codex CLI runtime exposes plugins through the
**skills** primitive (`$<plugin>:<skill>` mention), not slash
commands. Skills already work on Codex; lifecycle macro commands
do not. Three forces tension the design:

1. **Cross-host parity is core**: agentic-plugins ships dual-host
   plugins by charter (AGENTS.md §"Cross-host AI agent
   collaboration framework"). A Claude-only macro violates that
   charter.
2. **Skill folder convention has been verb-only**: [ADR-0010](0010-plugin-boundary-policy.md)
   §2 establishes "six universal cognitive verbs" as the L3 persona
   surface. ADR-0010 §3 § "Naming convention" and §4 § "Plugin-
   internal skill use" describe `skills/<verb>/SKILL.md` files
   keyed to `VALID_VERBS`. The plugin-shape test
   `tests/plugin-shape/test-engineer-plugin.mjs` already
   distinguished `LIFECYCLE_MACROS = ['start']` as a separate
   category from `VERBS`, but the policy ADR has not yet codified
   that split.
3. **Lifecycle macro is not a verb**: ADR-0020 §Sub-decision 5
   explicitly excludes `start` from `VALID_VERBS` (kept at six
   canonical verbs). The 2026-05-11 amendment to ADR-0010
   distinguishes "lifecycle macro command" from "verb-level sugar
   alias" but does not address the skill-side mirror.

The question is **how the Codex `$engineer:start` surface should
exist** given that:

- Skill primitive is the only available Codex surface today.
- ADR-0013 has no trigger; waiting indefinitely is not an option.
- `start` is structurally not a verb, so it cannot reuse the verb-
  skill folder pattern *as a verb*.

## Decision

Introduce a second category — **macro skills** — to the
`skills/<plugin>/` folder convention. ADR-0010 §3 amendment
formalizes the two-category split. The first macro skill is
`engineer:start`.

### 1. Folder structure

The `skills/<plugin>/` folder permits two categories of children:

| Category | Folder naming | Source of name | Example |
|----------|---------------|----------------|---------|
| **Verb skill** | `skills/<verb>/` | one folder per `VALID_VERBS` member | `skills/investigate/` |
| **Macro skill** | `skills/<macro>/` | one folder per `LIFECYCLE_MACROS` entry (per ADR-0020 cascade) | `skills/start/` |

Both categories carry the same internal structure:
- `SKILL.md` with frontmatter (`name: <folder>`, `description: <…>`)
- `agents/openai.yaml` with `interface` block + `policy:
  allow_implicit_invocation: false`
- Optional `references/` for skill-specific contracts (verb skills
  use this for `investigate/references/cited-brief-spec.md` etc.;
  macro skills may use it for macro-specific contracts)

### 2. Content authority (SKILL.md vs command file)

The verb-skill convention is preserved verbatim for macro skills:

- **`skills/<macro>/SKILL.md`** is the canonical, host-agnostic
  cognitive runbook for the macro. It describes the phase sequence,
  user-approval gates, ensemble dispatch points, and anti-patterns
  in operational prose. It does **not** include bash for state
  writes (state writes are a host-orchestration concern, not a
  skill concern — see ADR-0010 §4 cascade for the parallel verb-
  skill discussion).
- **`commands/<macro>.md`** (Claude side) owns the Claude-host
  bootstrap (Phase 0 argument parsing, detached-HEAD guard,
  redundancy probe, active-workflow branching) and the
  `state.mjs` writes at each phase boundary. The cognitive
  description of each phase delegates to `skills/<macro>/SKILL.md`
  via `Follow $CLAUDE_PLUGIN_ROOT/skills/<macro>/SKILL.md § Phase
  N` pointers.
- **Codex side** (`$engineer:<macro>` skill mention) loads
  `skills/<macro>/SKILL.md` directly. Codex-side host bootstrap and
  state-write machinery is the same gap the verb skills face today
  when invoked as `$engineer:<verb>` directly (no enclosing command)
  — it remains a known limitation pending [ADR-0013](README.md#status)
  or alternative resolution. ADR-0021 does NOT close that gap; it
  closes the **cognitive runbook parity** gap so Codex users can
  follow the same lifecycle steps that Claude users follow.

### 3. VALID_VERBS unchanged

The six-verb enum in `plugins/engineer/scripts/state.mjs` (and the
ADR-0010 §2 invariant) is **not** extended. Macro skills are NOT
verbs. The `state.mjs append --verb …` calls at macro phase
boundaries still rotate through the six canonical verbs as the
phase-primary cognitive activity (ADR-0020 §Sub-decision 5).

### 4. First implementation — `engineer:start`

The accompanying PR ships the macro skill at
`plugins/engineer/skills/start/` (SKILL.md + agents/openai.yaml),
refactors `plugins/engineer/commands/start.md` so each phase's
cognitive prose delegates to SKILL.md while Phase 0 bash bootstrap
and per-phase `state.mjs` writes are retained, updates the
`.codex-plugin/plugin.json` `longDescription` to reflect the dual-
surface availability, and extends `tests/plugin-shape/
test-engineer-plugin.mjs` with macro-skill `describe` blocks
mirroring the verb-skill shape assertions.

### 5. ADR-0010 §3 amendment

Append a 2026-05-12 ADR-0021 cascade entry to ADR-0010's
Amendments section, declaring the two-category skills folder
contract and pointing back to this ADR.

### 6. Meta commands — deferred

Meta commands (`/engineer:resume`, `/engineer:checkpoint`,
`/engineer:peer-now` per
[ADR-0017](0017-stage25-continuity-and-schema-roadmap.md)) remain
command-only — the question of whether they should also mirror as
macro skills (or carry their own third category) is deferred to a
follow-up PR.

## Consequences

**Positive**:

- Codex parity for the lifecycle macro is restored without waiting
  on ADR-0013. Users on either host follow the same Phase 0~7
  runbook (SKILL.md is the single source).
- ADR-0010 §3 explicit: the `skills/<plugin>/` folder accepts two
  named categories. Future lifecycle macros automatically inherit
  the macro-skill mirror pattern.
- The plugin-shape test's pre-existing `LIFECYCLE_MACROS`
  distinction (line 74, added at ADR-0020 PR 3) is promoted from
  implementation detail to ADR-codified contract.
- ADR-0012 condition 3 trigger (Stage 3 designer landing as the
  test for omcc/codex-plugin-cc removal) gains an example pattern:
  any non-trivial workflow developed engineer-only via the
  lifecycle macro now works on both Claude and Codex by default.

**Negative**:

- `commands/start.md` undergoes a non-trivial structural refactor
  (cognitive prose → SKILL.md; bash + delegation pointers retained).
  This is a one-time cost but increases the file's reliance on
  SKILL.md cross-references; broken cross-references will surface
  as test failures only at runtime, not at static lint time.
- SKILL.md ↔ command-file drift is possible in the same way verb
  skills face today (the verb-skill convention already accepts this
  drift risk; the per-PR review process catches divergence).
- The Codex-side direct skill invocation still lacks the host
  bootstrap machinery (Phase 0 argument parsing, state.mjs probes)
  that Claude commands have. ADR-0021 does **not** close that gap —
  it only closes the cognitive runbook parity gap.

**Neutral**:

- The `MACRO_SKILLS` constant in
  `tests/plugin-shape/test-engineer-plugin.mjs` is currently an
  alias for `LIFECYCLE_MACROS`. If the follow-up meta-commands PR
  expands the category, the alias may diverge — at that point a
  proper enum split happens. For now the alias preserves intent
  (folder name = command name).

## Alternatives Considered

### Option C — Wait for ADR-0013 (Codex CLI plugin-commands schema)

Don't ship the macro skill mirror. Wait for Codex CLI to gain a
plugin-commands schema, then mirror `/engineer:start` natively as
a Codex command.

**Rejected** because:

- ADR-0013 has no trigger (Stage 3+ trigger candidate); waiting is
  indefinite.
- The parity gap is acknowledged in the shipping manifest itself
  (`longDescription` line 35 pre-ADR-0021) — leaving it unaddressed
  is worse UX than a skill mirror.
- The skill primitive is the *existing* Codex command surface;
  using it is the orthodox path (per the 9-axis quality matrix
  applied in the Phase 1 brainstorm).

### Option D — Manual verb-chain skill (no orchestration)

Ship `plugins/engineer/skills/start/SKILL.md` as an *instruction
document* — "to start a workflow on Codex, type
`$engineer:investigate` then `$engineer:frame` then …" — without
actually being an orchestrator skill.

**Rejected** because:

- Worse UX than Claude users get; violates the cross-host parity
  charter.
- Adds user-burden where the runbook should automate the sequence.

### Option E — Promote `start` to a 7th verb (`VALID_VERBS = 7`)

Add `start` to `VALID_VERBS` so it becomes a canonical verb-skill
folder, eliminating the need for a new category.

**Rejected** because:

- ADR-0020 §Sub-decision 5 explicitly fixed `VALID_VERBS = 6` and
  the 2026-05-11 ADR-0010 amendment ratified that. Reversing it
  would supersede both ADRs.
- `start` is not a *cognitive activity* — it is a *workflow shape*
  (macro). Conflating "what to think" with "what shape to
  orchestrate" muddles the ADR-0010 §2 six-verb cognitive model.

## References

- [ADR-0010](0010-plugin-boundary-policy.md) — 4-layer composition,
  six cognitive verbs, naming convention. ADR-0021 amends §3.
- [ADR-0013](README.md#status) — Codex CLI plugin-commands schema
  (reserved, Stage 3+ trigger). ADR-0021 bypasses this dependency
  for the lifecycle macro.
- [ADR-0017](0017-stage25-continuity-and-schema-roadmap.md) —
  meta-commands category (`resume`, `checkpoint`, `peer-now`)
  introduced. ADR-0021 explicitly defers meta-command skill-mirror
  decision to a follow-up PR.
- [ADR-0018](0018-stage3-architecture-orchestrator-and-branch-context.md)
  §sub-2 — branch=workflow invariant. Macro skill inherits this
  constraint.
- [ADR-0019](0019-cross-plugin-invocation-contract.md) — cross-
  plugin invocation contract. `start` is engineer-internal, NOT
  cross-plugin.
- [ADR-0020](0020-engineer-integrated-workflow-umbrella.md) —
  `/engineer:start` lifecycle macro command. ADR-0021 is the Codex
  parity cascade.
- `plugins/engineer/skills/start/SKILL.md` — the canonical
  lifecycle macro runbook.
- `tests/plugin-shape/test-engineer-plugin.mjs` § `LIFECYCLE_MACROS`
  constant — pre-existing test-side distinction that ADR-0021
  promotes from test constant to policy.
