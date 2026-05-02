# ADR-0007: Migration cutover plan from omcc to agentic-plugins

## Status

Accepted

## Context

ADR-0005 establishes that agentic-plugins is the successor to omcc, that the
two coexist during agentic-plugins development, and that omcc is archived once
agentic-plugins reaches the cutover point. This ADR defines what the cutover
point is concretely, the Stage milestones leading to it, and the
operational procedure for switching.

A core insight that shapes this plan: **agentic-plugins is not a 1:1 port of
omcc.** The user's stated intent is to use omcc experience as input for
agentic-plugins' design and produce a *better, more advanced, more refined*
framework. Plugin names, skill names, command surfaces, workflow shapes,
and storage formats may all differ from their omcc counterparts when a
different choice represents improvement. omcc serves as **experiential
reference**, not as a porting target.

The cutover plan must address:

1. Redesign vs port stance — what does this ADR mean by Stage milestones?
2. Stage milestones — what concretely defines each Stage's exit?
3. Cutover trigger — when is the user ready to switch?
4. Data migration — what user state needs to migrate, and in what form?
5. Communication — how is the switch signaled (to self, to any external users)?
6. omcc archive procedure — what happens to the omcc repo at cutover?

## Decision

### Redesign stance (foundational)

agentic-plugins' Stage milestones are **redesign milestones**, not port
milestones. Each Stage references an omcc plugin as **experiential
input** — observed patterns, known pain points, useful protocols — and
produces a agentic-plugins artifact that may have different naming, structure,
storage format, and command surface from its omcc counterpart, as long
as the artifact represents a clear improvement (in cross-host
nativeness, structural simplicity, protocol precision, developer
experience, or similar).

This stance preempts the failure mode where a 1:1 port also inherits
omcc's accumulated quirks and structural debt. The expected mental model
is "What is the *better* form of this capability, given everything omcc
taught us, on a dual-host framework?" — not "How do I translate this
omcc file to agentic-plugins shape?"

### Stage milestones

#### Stage 1 — Reference plugin and companion contract

- One small reference plugin shipped, working natively in both Claude
  Code and Codex CLI per the ADR-0001 layered model
- The plugin's domain references **omcc-research's** experience: single
  skill, single command, ensemble protocol, graceful degradation when
  the peer host's CLI is unavailable
- Plugin name, skill structure, and command surface are agentic-plugins' own
  design — not constrained to mirror omcc-research
- Both companions (`claude-companion`, `codex-companion`) implemented
  and the contract (`companions/contract.md`) finalized
- Smoke tests pass in both hosts via `kit/lint/` and `companions/tests/`

Exit: install → invoke → complete cycle works end-to-end on both hosts;
companion round-trip call succeeds in both directions; CI gates green
per host.

#### Stage 2 — Self-development plugin

- A agentic-plugins plugin shipped that supports agentic-plugins' own development
  workflows on both Claude Code and Codex CLI
- Plugin design references **omcc-dev's** experience (workflows for
  `/start`, `/fix`, `/audit`, brainstorm, continuity, ensemble, etc.) —
  reviews each workflow's value, may consolidate, drop, or replace
  individual workflows where redesign produces a clearer or stronger
  result. Workflow names and shapes are agentic-plugins' own design
- Orchestration is implemented natively per host (Claude
  auto-delegation, Codex explicit-dispatch) — same intent, different
  execution paths
- agentic-plugins' development host migration: from this point on, agentic-plugins
  development uses the new self-development plugin, not omcc-dev. The
  omcc-dev dependency for agentic-plugins development is dropped here

Exit: the new self-development plugin can drive agentic-plugins' own
development workflow on both hosts without omcc-dev being installed.

#### Stage 3 — Design domain and remaining workflows

- A design-domain plugin shipped, referencing **omcc-designer's**
  experience (poster, social-graphics, frontend, brief, evaluation,
  extraction, etc.) with the same redesign stance — keep what works,
  rethink what doesn't, scope to what genuinely benefits from dual-host
- Any omcc-dev workflow patterns not covered in Stage 2 are addressed
  here — either implemented in the self-development plugin (Stage 2
  extension) or explicitly dropped with rationale

Exit: the user's daily workflows (development, design, research) all
have agentic-plugins equivalents that they prefer to omcc.

### Cutover trigger

The user declares cutover when **all** of the following are true:

1. Stage 1–3 milestones met (per the exit criteria above)
2. Daily-use confirmation: a sustained period (≥1 week) of using agentic-plugins
   for actual work without functional regression, AND with at least one
   clearly-identified improvement over omcc (dual-host operation,
   simpler structure, more precise protocol, better developer
   experience, etc.)
3. omcc archive procedure (below) is ready to execute

Each condition is independently verifiable; missing any one means not
cutover-ready.

### Data migration

- **Workflow state** (omcc-dev `workflows/` YAML, ensemble run history,
  etc.): agentic-plugins' storage format may differ. If different, a one-shot
  migration script converts omcc state to agentic-plugins state, OR the user
  manually re-creates active workflows in agentic-plugins (acceptable for a
  solo user with a small number of in-flight workflows). The exact
  decision is made when Stage 2's storage format is finalized
- **Settings**: the user sets up agentic-plugins' keys cleanly in
  `~/.claude/settings.json` and `~/.codex/config.toml`. No automatic
  import of legacy omcc settings — clean start
- **Caches and outputs**: regenerable; no migration needed

### Communication

- **Solo user**: cutover is self-declared; the user updates their
  install lists, shell config, and CLAUDE.md references away from omcc
- **External users**: none initially. If agentic-plugins grows to have external
  users, this ADR is amended (or superseded) with an
  external-communication subsection
- **omcc README update**: at cutover, omcc README gains an `Archive
  Notice` block at the top pointing to `each4all/agentic-plugins` as successor
- **agentic-plugins README update**: Status section moves from "Early
  scaffolding" to a description of the cutover-complete state

### omcc archive procedure

1. Final omcc release tagged in omcc's release-please workflow
2. omcc README updated with archive notice (top-of-file block,
   ~3 lines: "Archived. Successor: `each4all/agentic-plugins`. Last release:
   vX.Y.Z.")
3. omcc GitHub repo set to archived (read-only) via repository settings
4. User's local environment cleaned: omcc removed from any auto-install
   scripts, shell startup, `~/.claude/settings.json` references, etc.

## Consequences

**Positive**:

- Stage milestones are concrete and independently verifiable, not vague
  "feature parity" handwaving
- Redesign stance prevents porting omcc's structural debt forward and
  positions agentic-plugins as a genuine improvement, not a repackaging
- The user retains a working tool (omcc) throughout development; cutover
  is a deliberate event, not an accident
- Clean settings/storage boundary at cutover — no legacy state coupling
- omcc archive is procedural, reversible (could be un-archived if
  needed), and informational for future visitors

**Negative**:

- Redesign stance means each Stage is heavier than a port — more design
  decisions, more chances to over-scope. Mitigation: each Stage exit is
  defined by a working observable outcome, not by completeness of design
- The "≥1 week sustained use" cutover criterion is subjective. The user
  is the sole arbiter; this is acceptable for a solo project but would
  need stronger criteria for a team handoff
- Data migration shape is deferred to Stage 2 finalization — until
  then, the exact migration approach is unknown

**Neutral**:

- This ADR is itself subject to amendment as Stages execute. If Stage 2
  or Stage 3 reveals that the planned scope was wrong, this ADR is
  superseded by a new one (per the ADR process in `AGENTS.md`)

## Alternatives Considered

1. **1:1 port (no redesign)** — Rejected. Inherits omcc's accumulated
   structural quirks and provides no clear improvement to justify the
   cost of building a new framework. The user's stated intent is for
   agentic-plugins to be *better*, not just dual-host.

2. **Big-bang cutover** (port everything in one push, switch in one
   day) — Rejected. Validation risk too high; no incremental
   confirmation that each subsystem works before depending on it. Also
   incompatible with the dogfood-at-Stage-2 pattern (need
   self-development plugin working before late-Stage work).

3. **Side-by-side permanent operation** (keep both omcc and agentic-plugins
   alive long-term) — Rejected. Conflicts with ADR-0005 (replace, not
   coexist) and creates indefinite dual-maintenance burden.

4. **Stage 2 before Stage 1** (build self-development plugin first) —
   Rejected. Self-development plugin would be built on an unvalidated
   framework — chicken-and-egg. Stage 1's reference plugin is the
   framework's first proof point; Stage 2 builds *on* that proof.

5. **Automatic settings/state migration** (preserve all omcc state into
   agentic-plugins) — Rejected. Clean start at cutover gives agentic-plugins' storage
   design freedom and avoids carrying forward stale state. Workflow YAML
   migration if needed is one-shot, not continuous.

## References

- ADR-0005 — Separate repo from omcc (establishes replace intent)
- `docs/DEVELOPMENT.md` — Stage descriptions and tooling decisions
- omcc plugins observed: `omcc-research/`, `omcc-dev/`, `omcc-designer/`
  in `e16tae/omcc`
