# ADR-0022: Engineer meta-skill category — third category in skills/<plugin>/

## Status

Proposed

## Context

[ADR-0021](0021-codex-command-surface-parity-via-skill-wrappers.md)
accepted on 2026-05-12 introduced **macro skill** as a second category
inside `skills/<plugin>/`, alongside the pre-existing **verb skill**
category from ADR-0010 §3. The first macro skill was `engineer:start`,
mirroring the `/engineer:start` lifecycle macro command so Codex CLI
users gained command-surface parity for the single-deliverable
lifecycle.

ADR-0021 §6 explicitly **deferred** a related question:

> "Meta commands (`/engineer:resume`, `/engineer:checkpoint`,
> `/engineer:peer-now` per [ADR-0017](0017-stage25-continuity-and-schema-roadmap.md))
> remain command-only — the question of whether they should also
> mirror as macro skills (or carry their own third category) is
> deferred to a follow-up PR."

The follow-up question — *should* meta commands mirror, and if so,
*how*? — is what this ADR resolves.

### What meta commands are

Per ADR-0017 §sub-decision-1/2/3, the engineer plugin ships three
commands explicitly labelled as **meta commands**:

| Command | What it does | ADR-0017 sub-decision |
|---------|--------------|------------------------|
| `/engineer:resume` | `state.mjs find-active` + drift report (clean/dirty per ADR-0017; ADR-0018 §sub-decision-3 4-probe enrichment) + optional `archive [<id>]` | sub-decision-1 |
| `/engineer:checkpoint` | `state.mjs checkpoint-set` thin shim — writes a one-line `latest_checkpoint.summary` for SessionStart re-injection | sub-decision-2 |
| `/engineer:peer-now` | `dispatch-peer.mjs` thin wrapper — fires a verbatim prompt at the cross-host companion + optional `[Peer]` label phase note | sub-decision-3 |

Each is a *single host-bootstrap operation*, not a phase sequencer.

### Why neither existing category fits

- **Verb skill** is "cognitive primitive" (ADR-0010 §2). Meta commands
  are not cognitive activities — they are workflow-continuity
  operations on existing state. Verb extension is explicitly forbidden
  (`VALID_VERBS = 6`, ADR-0020 §Sub-decision 5).
- **Macro skill** (ADR-0021) is defined as "sequences multiple verb
  skill invocations across phases". Meta commands do not sequence
  verb skills; they do not rotate `verb` field; they do not introduce
  phase boundaries. Cramming them into `macro` would erode that
  definition six days after it shipped and would land future
  meta-style operations (`abort`, `lock`, `cleanup`, …) in the wrong
  slot.

The cross-host parity gap is concrete: Codex CLI users today cannot
invoke `$engineer:resume / :checkpoint / :peer-now` at all, because
the skill primitive is Codex's only command surface and these three
commands do not have one. [ADR-0013](README.md#status) (Codex CLI
plugin-commands schema) has no trigger; waiting is indefinite. The
test constant `tests/plugin-shape/test-engineer-plugin.mjs:73`
explicitly carries this deferral:

> "Meta commands remain command-only pending the ADR-0021 follow-up
> PR on whether resume/checkpoint/peer-now mirror as macro skills
> too."

### Decision forces

1. **Cross-host parity is core** (AGENTS.md charter). Three commands
   with demonstrable Codex utility (peer-now symmetric, resume
   cross-host workflow inspection, checkpoint Codex→Claude handoff)
   shipping Claude-only is a charter gap.
2. **Taxonomy integrity** matters. ADR-0021's macro definition must
   remain "multi-phase verb sequencer". Future readers landing on
   `MACRO_SKILLS` should not have to disambiguate workflow-continuity
   ops from lifecycle macros.
3. **Honesty over placeholder parity**. Codex SessionStart re-injection
   does not exist; `state.mjs` writes hardcode `--host claude` in
   current command bash. A skill mirror that pretends Codex has full
   parity is worse than no mirror — it would surface false promises.

## Decision

Introduce a third category — **meta skill** — to the
`skills/<plugin>/` folder convention. ADR-0010 §3 grows from
two-category (verb / macro) to three-category (verb / macro / meta).

### 1. Folder structure

The `skills/<plugin>/` folder permits three categories of children:

| Category | Folder | Naming | Source of name |
|----------|--------|--------|----------------|
| **Verb skill** | `skills/<verb>/` | `<persona>:<verb>` / `<capability>:<verb>` | one folder per `VALID_VERBS` member |
| **Macro skill** | `skills/<macro>/` | `<plugin>:<macro>` | one folder per `LIFECYCLE_MACROS` entry (per ADR-0020 cascade) |
| **Meta skill** | `skills/<meta>/` | `<plugin>:<meta>` | one folder per `META_COMMANDS` entry (per ADR-0017 cascade) |

All three share the same internal shape:
- `SKILL.md` with frontmatter (`name: <folder>`, `description: <…>`)
- `agents/openai.yaml` with `interface` block + `policy:
  allow_implicit_invocation: false`

Meta skills do NOT extend `VALID_VERBS` (kept at six per ADR-0020
§Sub-decision 5) and are NOT macro skills (macro = multi-phase verb
sequencer per ADR-0021).

### 2. Content authority

The content-authority convention from ADR-0021 §2 carries forward:

- **`skills/<meta>/SKILL.md`** is the canonical, host-agnostic
  cognitive runbook for the meta operation. It describes the
  operation's purpose, per-phase semantics, anti-patterns, and a
  **host-availability matrix** (see §3 below) — but it does NOT
  embed Claude-host bash. State writes are an orchestration
  concern, not a skill concern.
- **`commands/<meta>.md`** (Claude side) owns the Claude-host
  bootstrap (argument parsing, plugin-root resolution,
  `state.mjs` invocations) and adds delegation pointers
  (`Cognitive runbook lives in $CLAUDE_PLUGIN_ROOT/skills/<meta>/SKILL.md
  per ADR-0022`; per-phase `see SKILL.md § Phase N` references) so
  the cognitive description stays single-sourced.
- **Codex side** (`$engineer:<meta>` skill mention) loads
  `skills/<meta>/SKILL.md` directly. The runbook tells the
  invoking AI how to translate Claude-side bash equivalents into
  Codex-operable Bash tool calls.

### 3. Host-availability matrix (mandatory)

Each meta `SKILL.md` MUST include an explicit
**Host availability** section describing which parts of the
operation work on which host. Stub-mirror "looks like parity"
runbooks are not acceptable — the matrix is the load-bearing
honesty mechanism that distinguishes (c) from (a) all-macro.

The Stage 2.5+ host-availability shape:

| Meta operation | Claude | Codex |
|----------------|--------|-------|
| `resume` | Full drift report + `host_history` append (`--host claude`) + `archive` | Full drift report + `host_history` append (`--host codex`) + `archive`. Filesystem state is host-shared; cross-host inspection is the canonical Codex use case |
| `checkpoint` | Full write + SessionStart re-injection in next Claude session | Write only (`--host codex`). Codex does not have a SessionStart hook today; the next *Claude* session re-injects the summary (cross-host Codex→Claude handoff) |
| `peer-now` | `--peer codex` invokes `codex-companion.mjs` | `--peer claude` invokes `claude-companion.mjs`. Symmetric per `companions/contract.md` bidirectional design |

Each SKILL.md SHOULD also include an explicit **Claude/Codex
command resolution table** covering plugin-root discovery and the
`--host` flag value for `state.mjs` invocations.

### 4. ADR-0010 §3 amendment

Append a 2026-05-12 ADR-0022 cascade entry to ADR-0010's Amendments
section, declaring the three-category split and pointing back to
this ADR. The new entry sits below the existing
"2026-05-12 — ADR-0021 cascade (macro skill category)" entry; both
share the date but encode distinct decisions.

### 5. Test-side promotion

`tests/plugin-shape/test-engineer-plugin.mjs` gains a `META_SKILLS`
constant aliasing `META_COMMANDS` (mirroring the
`MACRO_SKILLS = LIFECYCLE_MACROS` precedent from ADR-0021), plus
three `describe` blocks asserting:

- `skills/<meta>/SKILL.md` exists with frontmatter `name == <meta>`
- `skills/<meta>/agents/openai.yaml` exists with `interface` block
  and `policy: allow_implicit_invocation: false`
- Body content sanity: each SKILL.md mentions "Host availability",
  "Claude", "Codex", `--host codex`, and a delegation pointer back
  from the matching `commands/<meta>.md` to its SKILL.md

The comment block at lines 64-82 referencing "ADR-0021 follow-up PR"
is replaced with the ADR-0022 resolution.

## Consequences

**Positive**:

- Codex parity for the three meta commands is restored without
  waiting on ADR-0013. The skill primitive carries the cognitive
  runbook; the honest host-availability matrix prevents users from
  expecting parity that does not exist.
- ADR-0010 §3 explicit: `skills/<plugin>/` accepts three named
  categories. Future meta-style commands (`abort`, `lock`,
  `cleanup`, future ADR-0017 sub-decisions) inherit the meta slot
  by adding their entry to `META_COMMANDS` and creating one folder.
- Taxonomy integrity preserved: `macro` keeps the precise
  ADR-0021 meaning (multi-phase verb sequencer). `meta` slots in as
  a structurally distinct kind.
- The test-side constants (`VERBS`, `MACRO_SKILLS`, `META_SKILLS`)
  form a coherent three-tier vocabulary that plugin-shape conformance
  can assert against — no exception-driven case-by-case logic.
- ADR-0021 §6 deferral is closed; future readers of ADR-0021 follow
  the back-reference to ADR-0022 for the resolution.

**Negative**:

- The Codex-side meta-skill invocation still lacks the host-bootstrap
  machinery (argument parsing, `state.mjs` probes) that Claude
  commands have. ADR-0022 does NOT close that gap — same caveat
  as ADR-0021 for macro skills. The host-availability matrix
  documents it instead of pretending it's resolved.
- One more ADR-0010 cascade entry on a single day (two on
  2026-05-12). Decision history per ADR is still readable but the
  Amendments section grows.
- Future meta-style commands now require three artifacts
  (command file + SKILL.md + `agents/openai.yaml`) instead of one
  (command file). Per-command cost rises; per-category cost is the
  same as macro / verb.

**Neutral**:

- The `META_SKILLS` constant in
  `tests/plugin-shape/test-engineer-plugin.mjs` aliases
  `META_COMMANDS` for now. If a future ADR adds a meta command
  that is exposed *only* as a skill (not a Claude command), the
  alias may diverge — at that point a proper enum split happens.
- `VALID_HOSTS` already accepts both `claude` and `codex`
  (`state.mjs:101`); the meta-skill mirror does not require runtime
  changes to the state machinery. The current command bash that
  hardcodes `--host claude` continues to work; the Codex-side
  SKILL.md runbook uses `--host codex`.

## Alternatives Considered

The four-option decision space was evaluated through Phase 1
brainstorm (Codex + Claude ensemble AGREED, run_id
`20260512T061534Z-cdb584`) using the 9-axis quality matrix
(표준 / 권장 / 정석 / 본질 / 근본 / 확장 / 유지보수 / 고도화 / 실용성),
deliberately excluding the cost axis per the agentic-plugins
decision-methodology convention.

Option labels: **(a)** all-macro (extend macro category to cover
meta commands); **(b)** command-only (defer Codex mirror); **(c)**
third meta-skill category (chosen — see [Decision](#decision)
above); **(d)** case-by-case (mirror only a subset). The
Alternatives subsections below cover (a), (b), and (d) — (c) is
the Decision section and is not repeated as an Alternative.

### Option A — All three as macro skills

Reuse the `macro skill` category from ADR-0021 for
`resume / checkpoint / peer-now`. No new ADR-0010 §3 amendment beyond
adding three entries to `LIFECYCLE_MACROS`.

**Rejected** because:

- ADR-0021's macro definition ("sequences multiple verb skill
  invocations across phases") would be eroded six days after it
  shipped. Meta commands do not sequence verb skills.
- `LIFECYCLE_MACROS` constant becomes a catch-all. Future readers
  cannot tell from the name which entries are lifecycle macros and
  which are workflow-continuity ops.
- Future meta-style commands (`abort`, `lock`, `cleanup`) land in the
  wrong slot.

### Option B — All three command-only (defer)

Keep meta commands as Claude-side commands only. Acknowledge the
parity gap in `longDescription` (same idiom ADR-0020 PR 3 used
before ADR-0021 closed the lifecycle macro gap). Wait for ADR-0013
or a clearer need.

**Rejected** because:

- Cross-host parity is the default policy (AGENTS.md). All three
  meta commands have demonstrable Codex utility:
  - `peer-now`: symmetric — companions are bidirectional first-party.
  - `resume`: cross-host workflow inspection is highly valuable;
    drift report is filesystem + git state, both host-agnostic.
  - `checkpoint`: Codex→Claude handoff path works today (Codex writes
    `latest_checkpoint`; next Claude SessionStart re-injects).
- ADR-0013 has no trigger; waiting is indefinite.
- Future meta-style commands would have no positive policy slot —
  every new one would re-trigger the same taxonomy debate.

### Option D — Case-by-case

Mirror some subset (e.g., resume only; or resume + peer-now but not
checkpoint), judge each command on its own merits.

**Rejected** because:

- Once all three meta commands have demonstrable Codex utility
  (verified above), partial coverage is policy-poor — the
  justification reduces to "less useful subset is harder to
  document", which is content-level concern, not category-level.
- Tests become exception-driven instead of category-driven; each
  new meta command requires fresh taxonomy debate.
- Future readers cannot tell why some meta commands are skills and
  others are not — the rule degrades to "ask the original author".

## References

- [ADR-0010](0010-plugin-boundary-policy.md) — 4-layer composition,
  six cognitive verbs, naming convention. ADR-0022 amends §3 again
  (the second 2026-05-12 cascade after ADR-0021).
- [ADR-0011](0011-workflow-continuity-storage.md) — workflow
  continuity storage. Meta commands operate on the schema defined
  here.
- [ADR-0013](README.md#status) — Codex CLI plugin-commands schema
  (reserved, Stage 3+ trigger). ADR-0022 bypasses this dependency
  for the meta commands (same approach as ADR-0021 for macros).
- [ADR-0017](0017-stage25-continuity-and-schema-roadmap.md) —
  meta-commands category (`resume`, `checkpoint`, `peer-now`)
  introduced. ADR-0022 closes ADR-0017's Codex-side surface gap
  for those three sub-decisions.
- [ADR-0018](0018-stage3-architecture-orchestrator-and-branch-context.md)
  §sub-2 — branch=workflow invariant. Meta skills inherit this
  constraint (per-branch single-active discipline).
- [ADR-0019](0019-cross-plugin-invocation-contract.md) — cross-plugin
  invocation contract. Meta commands are engineer-internal, NOT
  cross-plugin.
- [ADR-0020](0020-engineer-integrated-workflow-umbrella.md) —
  `/engineer:start` lifecycle macro command. The `MACRO_SKILLS`
  constant introduced here is the structural sibling of the new
  `META_SKILLS` constant.
- [ADR-0021](0021-codex-command-surface-parity-via-skill-wrappers.md)
  — macro skill category. ADR-0022 closes ADR-0021 §6.
- `plugins/engineer/skills/{resume,checkpoint,peer-now}/SKILL.md` —
  the canonical meta-skill runbooks (this PR ships them).
- `tests/plugin-shape/test-engineer-plugin.mjs` §`META_SKILLS`
  constant — test-side promotion of the meta-skill category.
