# ADR-0027: Decide skill multi-axis evolution — axis registry, sizing, weighting/sensitivity, and the parallel-edit contract

## Status

Proposed

<!--
For revisions to an Accepted ADR, see README.md §"Amendments vs
Supersedes" — Amendment for clarifications/cascades; new ADR
(Supersede) for Decision-section reversals.
-->

## Context

The `engineer:decide` verb (per [ADR-0010](0010-plugin-boundary-policy.md)
§2) ships as a single-mode, 5-axis comparison engine. Its skill at
`plugins/engineer/skills/decide/SKILL.md` hardcodes **five
perspectives** — Essence, Foundation, Standards, Best Practice,
Practical Fit (SKILL.md:83-94) — across four interleaved surfaces:

| Surface | SKILL.md line | What it hardcodes |
|---------|--------------|-------------------|
| **Axis table** | 83-94 | The 5 perspectives + their core questions, mapped to user vocabulary (표준 / 정석 / 권장 / 근본 / 본질) |
| **Per-option REQUIRED output** | 101 | The five `- **<Axis>**:` bullets each option must produce |
| **Key Differences comparison table** | 120 | The five-column comparison matrix |
| **Recommendation rule** | 138 | The "when Essence and Foundation clearly favor one option, recommend it" privilege rule |

The user-visible decision methodology, however, has already moved past
5 axes. The user's preferred comparison frame is a **9-axis matrix**.
[ADR-0019](0019-cross-plugin-invocation-contract.md) §1 Phase 1
brainstorm referenced the same 9-axis set by Korean-name list but did
not define the axes' semantics; this ADR canonicalizes those
definitions in the table below so future ADRs and tooling can cite
ADR-0027 as the authoritative source:

| # | Axis (Korean / English) | Definition |
|---|--------------------------|-----------|
| 1 | **표준 / Standards** | Industry / external reference (AI agent frameworks, POSIX, git, RFCs, W3C). |
| 2 | **권장 / Recommendation** | Future-compatibility + cross-plugin/persona consistency (alignment with other plugins, personas, and adapters). |
| 3 | **정석 / Canonical-Precedent** | Best-practice precedent established by agentic-plugins core principles. |
| 4 | **본질 / Essence** | Responsibility separation (SRP), model honesty (does this solve the *fundamental* problem). |
| 5 | **근본 / Foundation** | Agentic-plugins ADR core principles (ADR-0001 hexagonal architecture, ADR-0010 4-layer composition, 6 cognitive verbs). |
| 6 | **확장 / Extensibility** | Depth + breadth growth path; can additions land without breaking the existing surface. |
| 7 | **유지보수 / Maintainability** | Cognitive load + boundary clarity; can a new contributor understand the surface in finite time. |
| 8 | **고도화 / Maturation** | Future-development path; does the design accommodate planned evolution. |
| 9 | **실용성 / Practical-Fit** | User operational burden + gradual-learning feasibility; can the user adopt it today without rebuilding habits. |

Workload is deliberately **excluded** from the matrix — it is a
factual cost computed after a decision is made, not a comparison
axis. The 9-axis frame has been used in macro decisions (ADR-0019
Phase 1 brainstorm explicitly cites it; this ADR's parent macro-plan
ran 9-axis Round 1 + 5-axis Round 2). The skill is now the only place
the agentic-plugins decision tooling still operates on 5 axes; the
gap between tool and methodology has begun to manifest as bespoke
critique outputs that don't match the SKILL.md output contract.

A second tension: even at 5 axes, the verb is single-mode. Memory
`feedback_presentation_mode_semantics` records that decision granularity
("item") is orthogonal to option count, but the skill currently has no
notion of decision *size* — a 3-line config flip and an architectural
fork receive the same ritual. A `minor / standard / major` sizing
dimension was proposed in the macro plan, but its argument-surface
collides with `commands/decide.md`'s current free-form
`$ARGUMENTS` body (`argument-hint: (decision question or list of
options)`).

The macro plan
`macro-plan-20260519T004937Z-a97fbf` (Plan-verify verdict=concerns,
peer expansions incorporated) decomposes the evolution into five
serial-then-parallel subtasks:

```
adr-0027 (PR1, this ADR)
   └─→ axis-registry (PR2)
         ├─→ sizing (PR3)              ┐
         └─→ weighting-sensitivity (PR4)  ┴─→ validation-contract (PR5)
```

The Plan-verify peer flagged five scope items as ADR-0027's
responsibility — they are decisions whose shape *must* be fixed before
PR2/PR3/PR4 can land independently:

1. **Registry resolution semantics** — preset names, axis ordering,
   override precedence, invalid/missing-registry fallback, and the
   engineer-local-vs-future-L2 portability question.
2. **Strict argument grammar** for `/engineer:decide` — how `--size`,
   `--weights`, and free-form user prose coexist when the current
   `$ARGUMENTS` model is free-form-text only.
3. **Extension-marker design** — PR3 and PR4 will edit the same
   SKILL.md (axis table, per-option output, comparison table,
   recommendation rule). Without a marker contract they will conflict
   on rebase or silently overlap.
4. **Brainstorm peer-prompt axis-awareness** — the Brainstorm
   ensemble template at `skills/_shared/references/ensemble-protocol.md`
   §Brainstorm currently passes free-form decision context to the peer
   and is axis-agnostic. Once axis registry lands, the peer should
   inherit the same axis frame.
5. **Implementation split for axis-registry (PR2)** — whether PR2
   ships as a single deliverable or splits into core+migration.

This ADR closes those five items as one decision because they are not
independent: the registry resolution model (§1) constrains the
argument grammar (§2); the marker contract (§3) must reference the
same surfaces the registry-reader will rewrite; the peer-prompt rule
(§4) reuses the registry's preset+weight context; and the PR2
split (§5) is an implementation-strategy consequence of §1+§3 coupling.

## Decision

### §1 — Axis registry resolution semantics

**1.1 — Registry artifact**

A single YAML file, `plugins/engineer/skills/decide/references/decision-axes.yml`,
is the source of truth for axis identity, ordering, localized labels,
and per-axis core question. The schema is:

```yaml
schema: "1.0"
presets:
  <preset-id>:
    description: "<one-line human description>"
    axes:
      - id: "<axis-id>"          # kebab-case, ASCII, unique within the file
        labels:
          en: "<English label>"  # SKILL.md surface text
          ko: "<Korean label>"   # user-vocabulary mapping
        question: "<core question shown in the axis table>"
        role: "decisive | supporting"  # see §1.3 recommendation rule
```

`presets` is a map keyed by preset id; `axes` within each preset is an
**ordered list** (YAML preserves order; the reader honors document
order). `role` distinguishes axes that may trigger the
recommendation-rule privilege (`decisive`) from axes that contribute
only to comparison (`supporting`); see §1.3 below.

**PR5 amendment — XML escaping for axis labels and questions**
(2026-05-26): `labels.en` / `labels.ko` / `question` are free-text
YAML strings written by registry authors. They are interpolated
verbatim into the `<axis_awareness>` XML block emitted by the
Brainstorm prompt builder (§4.2). Authors MUST keep these fields
free of the text-node-breaking XML characters **`&` and `<`**
(and, where the field appears immediately before a `]]>` token,
`>`). Apostrophes and double-quotes are intentionally NOT covered
by this rule — XML's `'` and `"` predefined entities are only
required inside attribute values, not inside element text, and
the `<axis_awareness>` block places `labels` / `question` strictly
in element-text positions. Phase 5 dual review (parallel-review
MAJOR-2 + Codex --scope branch MAJOR-4 of run_ids
`parallel-review-20260526T015850Z-1c906f44` /
`codex-scope-branch-20260526T015850Z-1c906f44`) caught the
original draft of this rule listing all five predefined entities,
which would have flagged the shipped `default` and `nine-axis`
presets (`"project's specific constraints?"` at
`decision-axes.yml:45, 67, 131`) as violations even though they
render safely. All presets shipped in PR2 are now correctly
escape-free under the narrowed rule; future preset authors must
keep `&` and `<` out of these fields, or pre-escape them as
`&amp;` / `&lt;` if they are required for the user-facing label.
The reader's §1.6 validation matrix is not extended for this
check — the rule is editorial, enforceable by hand-review or a
future lint rather than a runtime gate (Codex Plan-verify E5 +
Phase 5 dual review — accepted as a documentation-only deterrent
rather than runtime validation, since the registry's load-time
semantics remain graceful-degradation per §1.6).

**1.2 — Canonical presets**

The schema ships with three presets:

| Preset id | Axes | Source |
|-----------|------|--------|
| `default` | 5 axes — `essence`, `foundation`, `standards`, `best-practice`, `practical-fit` | Current SKILL.md:83-94 verbatim, backwards-compatible |
| `nine-axis` | 9 axes — `standards`, `recommendation`, `canonical-precedent`, `essence`, `foundation`, `extensibility`, `maintainability`, `maturation`, `practical-fit` | The 9-axis matrix reproduced in Context above |
| `compact` | 4 axes — `essence`, `foundation`, `practical-fit`, plus a single `entry-routing-guarantee` axis covering source-of-truth / root-cause / verification / rollback as one combined check | New, for `--size=minor` per PR3 |

`compact` is named here so PR3 (sizing) can reference it; PR3 ships its
content. `default` and `nine-axis` ship in PR2 with their full content.

The preset *id* is the YAML key — the SKILL.md surface labels come
from `axes[].labels.en`. The user-vocabulary mapping in `axes[].labels.ko`
preserves the existing 표준 / 정석 / 권장 / 근본 / 본질 mapping at
SKILL.md:91-93 and extends it for the 9-axis preset.

**1.3 — Recommendation rule (axis role)**

The current SKILL.md:138 rule reads:

> When Essence and Foundation clearly favor one option, recommend it.

Generalized: when **decisive** axes clearly favor one option,
recommend it; do not downgrade based on **supporting** axes alone.
Per-preset `axes[].role` assignment:

- `default`: `essence`, `foundation` are decisive; the rest are supporting.
- `nine-axis`: `essence`, `foundation` are decisive; the rest are
  supporting.
- `compact`: `essence`, `foundation` are decisive; the rest are
  supporting.

`essence` + `foundation` remain decisive across all presets — this
preserves SKILL.md:138 semantics under preset expansion. The
recommendation rule's prose is rewritten by PR2 to read from
`axes[].role` rather than hardcoded names.

**Minimum decisive-axis invariant**: every preset MUST declare **at
least 2 decisive axes**. A preset with 0 or 1 decisive axes is a
registry validation error (handled per §1.6 *Unknown / malformed
role* row). This bounds future preset designs against a single-axis
recommendation rule that would collapse the multi-perspective
comparison the verb exists to provide. A future preset with axes
that genuinely deserve finer-grained roles (e.g., `decisive-strong /
decisive-weak / supporting`) is a schema 1.1 evolution requiring its
own ADR.

**1.4 — Axis ordering**

Axis order is **document order** in the YAML file. The reader does
not sort, normalize, or rearrange. This guarantees:

- The axis table (SKILL.md:83-94) renders in author intent.
- The per-option output (SKILL.md:101) lists bullets in the same
  order as the axis table.
- The comparison table (SKILL.md:120) columns match.

If a future preset needs a different display order, ship a new preset
rather than introducing per-surface reordering.

**1.5 — Preset selection precedence**

Resolution at command dispatch time distinguishes **explicit** user
input from **default** values. Precedence from highest to lowest
priority:

1. **Explicit `--preset=<id>`** (per §2). Wins outright regardless of
   any other flag.
2. **Explicit `--size=<tier>` → implied preset**: `--size=minor` →
   `compact`; `--size=standard` → `default`; `--size=major` →
   `nine-axis`. Step 2 fires ONLY when `--size` is explicitly passed
   by the user. The default-fallback `--size=standard` value (when
   no flag is present) does NOT fire step 2 — it falls through to
   step 3.
3. **Persona/profile override**: a future L4 profile YAML (e.g.,
   `engineer:backend`) MAY declare a `decide.preset: <id>` field that
   the dispatch reader honors. None ship in PR2; the precedence slot
   is reserved.
4. **Default**: `default` preset (5-axis, backwards-compatible).

Precedence is **strictly ordered**; a higher rule that resolves to a
valid preset wins regardless of lower-rule values. Conflicts between
rules are not silently merged.

**Combined `--preset` + `--size`**: passing both is legal. `--preset`
controls the axis set (step 1 wins for preset resolution). `--size`
independently controls **ritual verbosity** — the per-option output
depth, comparison-table density, and recommendation rigor that PR3
defines. `--size=minor --preset=nine-axis` means "compact ritual,
9-axis frame"; `--size=major --preset=default` means "full ritual,
5-axis frame". The two flags are orthogonal: preset is an axis-set
identity, size is a per-axis effort budget. PR3 owns the
size→ritual mapping; this ADR fixes only that the two flags do not
silently merge.

**1.6 — Invalid / missing-registry fallback + schema invariants**

The reader treats the registry as a graceful-degradation artifact.
Every failure mode has a documented behavior:

| Failure mode | Behavior |
|--------------|----------|
| File missing | Fall back to the in-code `default` preset definition; emit a one-line stderr warning naming the missing path. |
| File-system permission error (`EACCES`, `EISDIR`, etc.) | Same fallback; stderr names the errno + path. |
| YAML invalid (parse error) | Same fallback; stderr names the parse error and line number when YAML library exposes them. |
| Schema invalid: unknown top-level key | Same fallback; stderr names the offending top-level key. |
| Schema invalid: missing `presets` map | Same fallback; stderr names the missing key. |
| Schema invalid: empty `presets` map (no presets defined) | Same fallback; stderr says "registry has no presets". |
| Schema invalid: malformed preset (non-map under a `presets.<id>` entry) | Same fallback; stderr names the offending preset id. |
| Schema invalid: malformed `axes` (non-list under `presets.<id>.axes`) | Same fallback; stderr names the offending preset id. |
| Schema invalid: missing required axis field (`id`, `labels.en`, `question`, `role`) | Reader rejects the *preset*; falls back to `default`. The reader does not silently fill in defaults for missing axis fields. |
| Schema invalid: invalid `role` value (not `decisive` or `supporting`) | Reader rejects the *preset*; falls back to `default`. |
| Schema invalid: invalid axis-id shape (not `[a-z][a-z0-9-]*`, contains whitespace, mixed-case, or non-ASCII) | Reader rejects the *preset*; falls back to `default`. |
| Schema invalid: invalid preset-id shape (same constraints as axis ids) | Reader rejects the *single offending preset*; the rest of the registry remains usable; stderr names the offending id. |
| Unknown preset id requested (`--preset=<id>` for an id not in registry) | Fall back to `default`; stderr names the requested id and the available ids. |
| Empty `axes` list in resolved preset | Fall back to `default`; stderr names the empty preset. |
| Duplicate axis id within a preset | Reader rejects the *preset*; fall back to `default`. The reader does not silently dedupe. |
| Duplicate preset-id key in the YAML map | Behavior is YAML-library-dependent (some libraries last-wins, some throw). PR2 MUST pick a library that errors on duplicate keys OR add a pre-parse uniqueness check; stderr names the duplicate id. |
| Decisive-axis count < 2 in resolved preset (§1.3 invariant) | Reader rejects the *preset*; fall back to `default`. |

Fallback is the only failure path. The skill does not crash. Every
fallback emits one stderr line so the user sees what happened; SKILL.md
output is never silently degraded.

**Schema invariants summary**: PR2's reader MUST validate, at load
time, the invariants implicit in the failure-mode table above:
(i) `presets` is a non-empty map; (ii) each preset's `axes` is a
non-empty list; (iii) each axis has all required fields with the
correct shapes; (iv) axis ids are unique within a preset; (v) each
preset has ≥ 2 decisive axes; (vi) preset ids are unique across the
file. Validation failures DO NOT halt the skill — they degrade
gracefully per the table — but they MUST be loud (one stderr line
per failure) so the user can fix the registry. PR2 must ship
positive-and-negative reader tests covering every row of this table
(see §5.4 LOC budget revision and §5 PR2 test requirement below).

**1.7 — Engineer-local vs future L2 portability**

The registry lives in `plugins/engineer/skills/decide/references/`
following the [ADR-0010](0010-plugin-boundary-policy.md) §5 +
[ADR-0014](0014-plugins-research-deprecation.md) precedent (the
cited-brief spec migrated from `plugins/research` to
`plugins/engineer/skills/investigate/references/`).

**Portability is scoped to the schema, not the path.** PR2 guarantees:

- The `decision-axes.yml` schema (§1.1) is portable: any future
  consumer (the L2 `decision` plugin, or another L3 persona's verb)
  can adopt the same schema verbatim without re-deciding axis
  semantics.
- The reader interface (the in-process JavaScript module loaded by
  `plugins/engineer/skills/decide/`) is engineer-local. PR2 does
  NOT extract a cross-plugin discovery library; cross-plugin
  imports are forbidden per [ADR-0010](0010-plugin-boundary-policy.md)
  §5.

**When (and if) an L2 `decision` plugin lands** (per ADR-0010 §1
Layer 2 planned occupants list, gated by §6 trigger 1 — second
consumer plugin needing the registry), the migration requires a
fresh ADR deciding:

- Whether engineer's `decide` reads the L2-owned registry through a
  typed artifact file (per ADR-0010 §5), through a companion-primitive
  proxy (per ADR-0008 + ADR-0009), or by a new ADR-0013-shaped
  mechanism that lands in the meantime.
- How the engineer-local schema 1.0 reconciles with whatever schema
  version the L2 plugin ships.

This ADR explicitly does NOT decide that migration path. PR2 ships
the **schema** as the portability contract; the **path**
abstraction is future work behind a §6 trigger 1 event.

### §2 — Strict argument grammar for `/engineer:decide`

**2.1 — Current state**

`plugins/engineer/commands/decide.md:4` declares
`argument-hint: (decision question or list of options)`. The command
body uses `$ARGUMENTS` as a free-form prose blob that the skill
interprets. There is no flag parsing.

**2.2 — Grammar**

The post-PR3/PR4 grammar accepts three flags and one free-form body:

```
/engineer:decide [--size=<tier>] [--preset=<id>] [--weights=<spec>] [--] <decision body>
```

Where:

- `--size=<tier>` — `minor | standard | major`. When omitted, the
  resolved size is `standard` *as a ritual budget* (per PR3) but the
  preset-implication path in §1.5(2) does NOT fire (only explicit
  `--size` triggers preset implication per §1.5).
- `--preset=<id>` — any preset id defined in `decision-axes.yml`.
  Overrides `--size` preset implication per §1.5(1) > §1.5(2).
- `--weights=<spec>` — comma-separated axis-id:weight pairs:
  `--weights=essence:2,foundation:2,practical-fit:1`. Weights are
  non-negative numbers (integer or decimal); missing axes default to
  `1.0`. PR4 (`weighting-sensitivity`) owns the parsing, normalization,
  and sensitivity-flip semantics; this ADR fixes only the *grammar*
  (where the flag lives and how it tokenizes).
- `--` — explicit separator. Everything after `--` is the free-form
  decision body. Optional but recommended for bodies that begin with
  `-` or contain `=`.
- `<decision body>` — free-form prose; the existing skill consumes
  this verbatim as `$ARGUMENTS` content per current behavior.

**2.3 — Flag parsing rules**

1. Flags MUST appear before the decision body. The first non-flag,
   non-`--` token starts the decision body; everything from that
   token onward is body, including any later `--foo` tokens.
2. Flags use `--key=value` form. `--key value` (space-separated) is
   NOT supported — this avoids ambiguity with body prose that begins
   with `-`.
3. Unknown `--key=value` tokens **before** the body or `--` separator
   emit a stderr **error** and halt parsing. The error names the
   unknown flag, lists known flags (`--size`, `--preset`, `--weights`),
   and instructs the user to either fix the typo or escape with `--`
   if the prose literally starts with `--<word>=`. This catches
   typos like `--seize=major` rather than silently consuming the body.
   After `--`, unknown-looking tokens are body content (the `--` is
   a hard escape, see rule 6).
4. **Invalid known-value tokens** (e.g., `--size=1` where `1` is not
   in the `{minor, standard, major}` whitelist; `--preset=nonexistent`
   where the registry has no such preset id; `--weights=garbage`
   that does not match the comma-separated `axis:weight` grammar) get
   per-flag-specific treatment:
   - `--size=<invalid-tier>` emits a stderr error and halts with the
     same diagnostic shape as rule 3 (lists valid tiers).
   - `--preset=<unknown-id>` triggers §1.6's *Unknown preset id
     requested* row — falls back to `default` with a stderr warning.
     This is graceful degradation, NOT halt, because the registry is
     a graceful-degradation artifact (§1.6 invariant).
   - `--weights=<malformed-spec>` emits a stderr error and halts;
     PR4 owns the grammar definition and full error matrix.
   Per-flag handlers (per §2.7) own their own value validators. The
   skeleton in PR2 only validates the *shape* (`--key=value` form,
   no spaces); semantic validation is per-flag.
5. Repeated flags: the last occurrence wins; a stderr warning notes
   the duplicate.
6. `--` is a hard separator; everything after `--` is body, even
   tokens that look like flags.

**2.4 — Coexistence with the current free-form contract**

The default invocation `/engineer:decide which approach for X` remains
valid and unchanged. The first token `which` is not a recognized flag
and does not match `--<key>=`, so the entire argument string is treated
as body. Backward compatibility is **near-total** with one explicit
corner case:

- A body that literally begins with `--<known-flag>=<value>` (e.g.,
  `/engineer:decide --size=1 in CSS?`) parses the leading token as a
  flag attempt. If the value is invalid for the flag (e.g.,
  `--size=1` is not a valid tier), this resolves to the appropriate
  §2.3(4) per-flag invalid-value handler — `--size`'s handler halts;
  `--preset`'s handler degrades gracefully per §1.6 — not a silent
  body fallback.
- The canonical escape is `--`: write
  `/engineer:decide -- --size=1 in CSS?` to force the entire string
  after `--` to be body. This is a known, documented edge — the
  ADR does not claim "total" backward compatibility but does claim
  the escape mechanism is unambiguous.

**2.5 — Sugar aliases (verb-level, per ADR-0010 §3)**

Within `plugins/engineer/commands/`, the following sugar aliases MAY be
published as additional command files that canonicalize to a
flag-bearing form before dispatch:

```
/engineer:decide-major   ≡ /engineer:decide --size=major
/engineer:decide-minor   ≡ /engineer:decide --size=minor
```

PR3 (`sizing`) decides whether to ship these aliases or leave only the
`--size=` flag form. This ADR permits but does not require them.
Sugar aliases at the verb level are within-plugin and require no
marketplace support (per ADR-0010 §3 + ADR-0011 §9 cascade).

**2.6 — Standalone-skill mode (auto-activation)**

Auto-activated `decide` (no command, in-context Skill invocation) does
not pass through `$ARGUMENTS` parsing — it receives free-form user
intent. The skill reads `--size`-style hints from the user's prose
when present ("compare these as a minor decision") but does not
require strict grammar. Strict grammar is a *command-mode* contract.
This matches ADR-0017 §sub-decisions 2/4's principle that command-mode
adds bookkeeping rigor that auto-activated mode does not need.

**2.7 — Argument-parser skeleton ownership**

The argument-parser **skeleton** — flag tokenizer, `--key=value`
splitter, `--` separator handling per §2.3(6), unknown-flag error
path per §2.3(3), invalid known-value shape rejection per §2.3(4),
repeat-flag last-wins per §2.3(5), `--key=value` shape validator —
ships in **PR2** (`axis-registry`), not PR3 or PR4.

Subsequent PRs register their flags against the shared skeleton:

- PR3 (`sizing`) registers `--size=<tier>` with the tier whitelist
  `{minor, standard, major}` and the §1.5(2) preset implication.
- PR4 (`weighting-sensitivity`) registers `--weights=<spec>` with
  its tokenizer, normalization, and sensitivity-flip semantics
  (the *grammar* slot is reserved by §2.2; the parsing semantics
  belong to PR4).

This prevents two independent argument parsers from drifting between
PR3 and PR4, and gives PR5's `validation-contract` a single parser
surface to assert against. PR2 ships the skeleton with `--preset=`
already registered (since `--preset=` belongs in PR2's registry
scope) plus stub registration points for `--size` / `--weights` so
PR3/PR4 wire into known slots.

### §3 — Extension-marker design (parallel-edit contract for SKILL.md)

**3.1 — Problem statement**

PR3 (`sizing`) and PR4 (`weighting-sensitivity`) must both edit
`plugins/engineer/skills/decide/SKILL.md`. PR3 changes the axis-table /
per-option-output / comparison-table content when `--size=minor` or
`--size=major` is active; PR4 adds a weighting + sensitivity output
block after the comparison table. Without a marker contract:

- They will rebase-conflict on overlapping SKILL.md lines.
- They will silently overwrite each other if either lands without the
  other rebasing.
- Future preset additions (a 7th axis preset, a different recommendation
  rule) repeat the same problem.

**3.2 — Marker convention**

PR2 inserts paired HTML-comment markers around the four current
surfaces. Markers are markdown-invisible (HTML comments render to
nothing) and treat the enclosed region as an *edit boundary* that
downstream PRs respect:

```markdown
<!-- @decide:axis-table:begin -->
| # | Perspective | Core question |
|---|-------------|---------------|
... (axis table body — generated from decision-axes.yml at PR2) ...
<!-- @decide:axis-table:end -->
```

The four marker pairs PR2 ships are:

| Marker id | SKILL.md region | Current line range |
|-----------|-----------------|---------------------|
| `@decide:axis-table` | The 5-row axis table + the "five anchors map to user vocabulary" prose | 83-94 |
| `@decide:per-option-output` | The `### Option [letter]:` REQUIRED-output block | 101-118 |
| `@decide:comparison-table` | The `### Key Differences` matrix | 120-131 |
| `@decide:recommendation-rule` | The "when Essence and Foundation favor" prose + REQUIRED-output recommendation block | 138-154 |

**Intentionally unmarked SKILL.md regions** (axis-agnostic content
PR3/PR4 are NOT expected to edit):

| Region | Lines | Why unmarked |
|--------|-------|--------------|
| Header + Step 1 + Step 2 | 1-76 | Verb description, auto-activated flow, research targets — independent of axis set. |
| "Step 3 Compare across multi-perspective" intro paragraph | 77-82 | Generic framing; does not name specific axes. |
| "Presentation Mode Protocol" prose between axis-table and per-option-output markers | 96-99 | Generic mode-protocol pointer; does not name axes. |
| "Step 4: Recommend" heading + "Always provide a recommendation" intro between comparison-table and recommendation-rule markers | 133-137 | Recommendation rationale framing; does not name axes. |
| Confidence levels enum (HIGH/MEDIUM/LOW) | 156-159 | Axis-agnostic confidence taxonomy. |
| "Wait for user to choose a direction" + Edge cases | 161-179 | Edge-case behaviors are preset-independent. |
| Step 5 Peer ensemble + Anti-patterns + closing | 181-end | Ensemble protocol + anti-patterns are axis-agnostic. |

If PR3 or PR4 (or any future feature PR) needs to edit an unmarked
region, the rule in §3.4 below applies: such edits cannot run in
parallel with another unmarked-region edit on the same lines.

**Marker wording rule**: the literal text inside each HTML comment
MUST be exactly `@decide:<region-id>:begin` or
`@decide:<region-id>:end` — no explanatory prose, no version
strings, no surrounding text inside the comment. Markers are
*model-visible* in the raw SKILL.md (the LLM reads markdown
source even though renderers strip HTML comments — see §3
Alternative 1 rejection); semantic prose inside markers would
pollute the model's view of the skill description. Marker text
is bookkeeping, not documentation.

**3.3 — Marker naming convention**

Marker ids use the form `@<plugin-scope>:<region-id>`:

- `@decide:` namespaces all engineer-decide markers, isolating them
  from any future engineer-skill marker conventions.
- `<region-id>` is kebab-case ASCII; uniqueness is per-file (not
  global), since markers are file-local edit boundaries.
- Begin/end suffix MUST be exactly `:begin` and `:end`; no spaces
  inside the HTML comment.

The HTML-comment form (`<!-- @decide:foo:begin -->`) is preferred
over alternatives (XML tags, YAML pointers, a separate
`markers.json`) because it preserves SKILL.md as a single self-
contained markdown file readable in any markdown renderer (GitHub
preview, IDE preview, plain cat) without external lookup.

**3.4 — Disjoint-region contract**

The contract PR3 and PR4 inherit:

- An edit to region X may modify only the lines strictly between
  `@decide:X:begin` and `@decide:X:end` markers (exclusive of the
  marker lines themselves).
- An edit that needs to cross marker boundaries (e.g., moving
  content from the axis table into the per-option output) MUST be
  staged as a separate marker-restructuring PR, not bundled into a
  feature PR.
- Two PRs editing **different** marker regions are **conflict-
  minimized** against each other; this is the parallel-PR
  contract for {PR3, PR4}. "Conflict-minimized" rather than
  "guaranteed" because git rebase semantics can still produce
  spurious conflicts when context lines (the surrounding
  unchanged lines git uses for hunk anchoring) overlap. The
  marker contract reduces conflict probability to near-zero for
  cleanly-bounded edits; it does not formally eliminate it.
  The §3.5 lint enforces marker compliance; CI is the practical
  failure detector.
- Two PRs editing the **same** marker region (e.g., both modifying
  `@decide:recommendation-rule`) must serialize. The marker
  contract does not eliminate same-region serialization — it
  bounds it.
- **Unmarked-region edits**: a PR that needs to edit an unmarked
  SKILL.md region (per the §3.2 unmarked-regions table) is not
  bounded by the marker contract. Two PRs editing the same
  unmarked region MUST serialize against each other if their
  edit-line ranges overlap. PR3 and PR4 are expected to confine
  all edits to marked regions; if either subsequently needs to
  edit unmarked prose, it serializes behind the other (or behind
  any unmarked-region-touching PR landed earlier on the same
  branch chain).

**3.5 — Marker validation (presence + content sanity)**

PR2 ships a lint check in `tests/plugin-shape/test-engineer-plugin.mjs`
(or a new `test-decide-markers.mjs` if the engineer-plugin test grows
too large) verifying:

*Structural checks*:

- All four marker pairs are present in `plugins/engineer/skills/decide/SKILL.md`.
- Each `:begin` has a matching `:end` after it (no orphan markers).
- No nested markers.
- Marker ids match the canonical set in §3.2.
- Each marker's HTML comment text matches exactly
  `<!-- @decide:<region-id>:<begin|end> -->` — no surrounding prose
  inside the comment (per §3.2 marker-wording rule).

*Content-sanity checks*: the first non-empty line **inside** each
marker pair MUST match a region-specific sentinel pattern, catching
"marker pair exists but wraps the wrong content":

| Marker id | Required first-inside-line pattern |
|-----------|-------------------------------------|
| `@decide:axis-table` | `\| # \| Perspective \| Core question \|` (markdown table header) |
| `@decide:per-option-output` | `#### REQUIRED output format — for each option:` (heading) |
| `@decide:comparison-table` | `#### REQUIRED output format — after all options:` (heading) |
| `@decide:recommendation-rule` | A prose line beginning with `When ` (the rule statement) |

The content-sanity patterns are conservative — they catch the most
likely "marker around wrong content" failures (e.g., axis-table
marker accidentally wrapping the comparison table) without
over-fitting to byte-exact content (which would force lint updates
on every minor wording tweak).

This combination — structural presence + content sentinel — makes
"drop a marker on rebase" AND "marker wraps wrong region" both
CI-detectable failures rather than silent content corruption.

### §4 — Brainstorm peer-prompt axis-awareness

**4.1 — Current state**

`plugins/engineer/skills/_shared/references/ensemble-protocol.md`
§Brainstorm (lines 328-355) declares the Brainstorm peer-prompt
template:

```xml
<task>
Given this design decision, independently propose 2-3 approaches with
tradeoffs.
Decision: {user's decision context from task profile}
Repository: {repo context}
</task>
```

The peer receives no axis context. When orchestrator runs
`/engineer:decide` with `--size=major` (9-axis), the peer still
proposes free-form 2-3 approaches without knowing the comparison
frame the orchestrator will apply. Synthesis quality (AGREED /
LOCAL-ONLY / PEER-ONLY / CONFLICT categorization per
ensemble-protocol.md §Step 3) degrades because the peer's tradeoff
vocabulary is unaligned with the orchestrator's axis vocabulary.

**4.2 — `<axis_awareness>` block**

The Brainstorm prompt template gains a new optional block:

```xml
<axis_awareness>
Preset: {preset-id resolved per §1.5}
Size: {minor | standard | major}
Axes:
  - id: <axis-id>; label: <en-label>; question: <core question>; role: <decisive | supporting>
  - ...
Weights: {comma-separated id:weight | "uniform"}
</axis_awareness>
```

The block lists the *same* axes the orchestrator will use, in the
*same* order, with the *same* roles. The peer is expected to
ground its 2-3 approaches in tradeoffs expressed against these axis
labels.

**4.3 — Presence rule + snapshot rule**

`<axis_awareness>` is present when both conditions hold:

1. The orchestrator successfully resolved a preset (no §1.6 fallback
   path triggered), and
2. The orchestrator is in command mode (`/engineer:decide`); auto-
   activated mode does not have a registry-resolved preset.

When either fails, the block is omitted entirely. The peer falls back
to free-form 2-3 approaches per current behavior. This preserves
graceful degradation per ensemble-protocol.md §Failure Handling.

**Snapshot rule (the resolved-context invariant)**: when
`<axis_awareness>` is present in the prompt, the orchestrator MUST
also persist the corresponding **ResolvedDecisionContext** object
(per §5.6) — specifically its `{preset_id, axes, size, weights}`
subset — to a local snapshot before dispatching the peer.
Synthesis (§4.4) consumes the snapshot, not the registry. If the
registry file changes, the reader falls back, or the user's CLI
context changes between dispatch and synthesis, the snapshot still
authoritatively describes the axis frame both sides shared. This
makes the peer's view and the orchestrator's synthesis view
guaranteed-consistent. The snapshot is in-memory for the duration
of the command; it does NOT need to persist to disk across
sessions. Field names match §5.6 verbatim (no aliasing).

**4.4 — Synthesis impact**

When `<axis_awareness>` is present, the orchestrator's synthesis step
(§Step 3) gains an additional constraint: PEER-ONLY approaches MUST
be evaluated against the snapshotted axis set (§4.3 snapshot rule)
before being merged. An approach the peer proposed that maps cleanly
to {essence: ◎, foundation: ○, practical-fit: ◎} is more compatible
with the orchestrator's recommendation rule than an axis-agnostic
prose approach.

**Unmapped peer approaches**: when a peer-proposed approach does
not map cleanly to any axis in the snapshotted set (the peer's
tradeoff vocabulary uses concepts orthogonal to the axes —
e.g., the peer proposed an approach justified by "operator
cognitive load" when the snapshot includes only `essence /
foundation / standards / best-practice / practical-fit`), the
orchestrator MUST:

1. Tag the approach `[Peer · unmapped]` (extending the standard
   `[Peer]` label per ensemble-protocol §Step 3 base categories).
2. Attempt local axis assessment — i.e., the orchestrator looks
   at the peer's approach and rates it against the snapshot's axes
   from its own analysis before merging.
3. If local mapping fails (the approach is genuinely outside the
   axis frame), present as PEER-ONLY with reduced confidence and
   surface the unmapped-axis-vocabulary list to the user. The
   user MAY then choose to widen the preset (re-invoke with
   `--preset=nine-axis`, for example) or accept the unmapped
   approach as a frame-incompatibility signal.

This is a *quality* improvement, not a correctness gate — the AGREED
/ LOCAL-ONLY / PEER-ONLY / CONFLICT base categorization remains the
same. The `[Peer · unmapped]` sub-label is a presentation refinement
on top of the existing four categories.

**4.5 — PR ownership**

The Brainstorm template update lives in PR5 (`validation-contract`),
not PR2, because:

- PR5 owns ensemble-protocol.md updates already (per macro plan
  subtask `validation-contract`'s topic field — "also update
  ensemble-protocol.md Brainstorm peer prompt").
- The template update requires PR3 (`--size`) and PR4 (`--weights`)
  to be landed for the template to fully populate (`Size:` and
  `Weights:` lines).

PR2 (`axis-registry`) does not modify ensemble-protocol.md.

**PR5 scope expansion — command-surface symmetry**: the current
Brainstorm peer-prompt is **not** a coded template — it is
constructed in-line by the LLM following prose instructions at
`plugins/engineer/commands/decide.md:100-118` (`# ... LLM writes
the Brainstorm XML prompt to $PROMPT_FILE ...`). On Codex, there
is no equivalent slash-command file (decide is a verb skill with no
ADR-0021 macro wrapper or ADR-0022 meta wrapper); Codex dispatch
runs through SKILL.md's "When invoked by command" section which
currently delegates wholly to `ensemble-protocol.md` for the
template (`plugins/engineer/skills/decide/SKILL.md:197-204`). The
manifest at `plugins/engineer/skills/decide/agents/openai.yaml` is
interface metadata only (display_name, default_prompt,
allow_implicit_invocation) — NOT a prompt-construction surface.

PR5 MUST update the following surfaces in lockstep, in dependency
order:

1. `plugins/engineer/skills/_shared/references/ensemble-protocol.md`
   §Brainstorm — the canonical template specification. Both hosts
   read this; updating it covers Codex side fully because Codex's
   SKILL.md path is delegation-only.
2. `plugins/engineer/commands/decide.md` — the Claude-side bash
   boilerplate comment (`# ... LLM writes the Brainstorm XML
   prompt to $PROMPT_FILE ...`). PR5 enriches this prose so the
   LLM building the Claude-side prompt knows to emit
   `<axis_awareness>` per §4.2 when the snapshot rule fires.
3. `plugins/engineer/skills/decide/SKILL.md` "Step 5: Peer ensemble
   parallel analysis" — currently delegates to
   ensemble-protocol.md unconditionally. PR5 SHOULD add an explicit
   pointer to §4 of this ADR so authors editing SKILL.md know the
   axis-awareness contract exists.

All updates must agree on the `<axis_awareness>` block shape and
the §4.3 snapshot rule. PR5 ships them together; partial-update
PRs are rejected (`validation-contract`'s test suite asserts
cross-surface symmetry per ensemble-protocol.md §Bidirectional
invocation pattern). Note: `plugins/engineer/skills/decide/agents/openai.yaml`
is NOT in this list — it is metadata, not a prompt surface.

### §5 — `axis-registry` (PR2) implementation split decision

**5.1 — Question**

Should PR2 ship as a single deliverable, or split into a `core`
PR (schema + 9-axis preset + minimum-viable reader) and a
`migration` PR (rewrite the 4 SKILL.md surfaces + extension
markers)?

**5.2 — Decision**

**Single PR.** PR2 ships schema + presets + reader + all four
SKILL.md surface rewrites + all four extension markers + the
marker-presence lint, atomically.

**5.3 — Rationale**

Three forces favor single-PR:

1. **No intermediate-state benefit** — a split would create an
   intermediate state where `decision-axes.yml` exists but SKILL.md
   still hardcodes the 5 axes. That state has no consumer, no test
   value, and adds review surface (two PR descriptions, two CI
   runs, two reviews) without buying isolation.
2. **Markers must precede C/D** — PR3 (sizing) and PR4
   (weighting-sensitivity) consume the extension-marker contract
   from §3. A core-only PR that defers markers would force PR3 and
   PR4 to wait on a third PR before they can be authored, breaking
   the parallel-PR guarantee that the {C, D} fork relies on.
3. **No second consumer** — the registry has no consumer outside
   `engineer:decide` yet. ADR-0010 §6 trigger 1 (infrastructure
   used by 2+ plugins) is not met, so there is no migration risk
   for downstream callers. The schema is allowed to evolve in
   future PRs without coordinating with absent consumers.

**5.4 — Review-surface bound + YAML parser decision**

The single PR's review surface, with peer-reviewer feedback
incorporated, is bounded by:

- 1 schema file (`decision-axes.yml`, ~80 lines).
- 1 reader module (`scripts/decide-registry.mjs` or similar, ~150
  LOC) + reader tests covering every §1.6 failure-mode row (~150
  LOC; peer O1 + G2 requirement). Reader-test growth is the
  largest line-count contributor.
- 1 argument-parser skeleton (per §2.7, ~80 LOC) + parser tests
  (~80 LOC).
- 1 SKILL.md rewrite (4 marked surfaces + 8 marker comment lines,
  ~60 lines changed; the SKILL.md decision-method block currently
  spans lines 77-179 = 103 lines).
- 1 marker-validation lint (per §3.5, ~80 LOC for structural +
  content-sanity checks).
- 0 new tests for sizing or weighting (those land in PR3/PR4).

Realistic total **~600-700 LOC** across 6-8 files, up from the
initial ~330 LOC estimate. This is still well under the
ensemble-protocol.md §Failure Handling slicing threshold (1500
lines), so peer review does not need to slice; but the budget
honestly reflects the reader-test + parser-skeleton scope that
peer review demanded.

**YAML parser source decision**: agentic-plugins currently has no
runtime YAML dependency in any `package.json` (the project uses
JSON for `release-please-config.json` and YAML only in GitHub
Actions YAML, which the host parses, not the repo). PR2's first
decision is the parser source. Three options:

1. **Node 24 built-in** (if available) — preferred when feasible;
   no dependency surface.
2. **Vendor a small parser** — copy a minimal YAML 1.2 parser into
   `plugins/engineer/scripts/lib/` (no npm dependency, audited
   source). The parser only needs to handle the `decision-axes.yml`
   subset (scalars, sequences, maps, comments) — full YAML 1.2
   parsing is overkill.
3. **Add `js-yaml` as a runtime dependency** — `npm install
   js-yaml`. Adds dependency manifest surface; release-please
   needs to track it.

PR2 makes the call based on Node 24 availability check at PR
authoring time. Option 2 is the conservative default if
unclear. This ADR does not pick the parser — only that PR2 must
pick one explicitly and document the choice in its commit
message.

**5.5 — Rollback path**

Rollback complexity depends on what has landed since PR2:

- **Before PR3 or PR4 lands**: one-commit revert. PR2's atomic
  shape means a single `git revert` restores SKILL.md, removes the
  registry file, removes the reader, and removes the marker
  contract together. No coordination needed.
- **After PR3 or PR4 lands**: rollback requires either (a)
  coordinated revert of all downstream PRs that reference preset
  ids or marker regions, or (b) a compatibility shim restoring
  the in-code `default` preset behavior alongside the rollback.
  Workflow phase notes (the markdown body in
  `.agentic-plugins/state/engineer/workflows/*.md`) that mention
  preset ids in human-readable prose cannot be retroactively
  rewritten — they remain as audit history references; this is a
  one-way serialization, not a blocker. Note: the `ensemble_results`
  frontmatter list does NOT carry preset ids — its schema is fixed
  at `{phase, ensemble_type, run_id, verdict, summary, completed_at,
  codex_session_id}` per `plugins/engineer/scripts/state.mjs:827-835`.
  The schema is closed at two levels: the top-level frontmatter
  unknown-key check (`state.mjs:1003-1010`) rejects unknown top-level
  keys, and `validateListOfObjectsField` (`state.mjs:1352-1373`)
  rejects unknown nested keys within `ensemble_results[*]`. PR2/PR3/PR4
  MUST NOT extend this list with preset-aware keys; §5.6 keeps the
  ResolvedDecisionContext in-memory specifically to honor this
  invariant.

The single-PR atomic shape is strictly better than a split here
**before downstream consumers land**, and is no worse than a
split **after downstream consumers land** (a split's
"intermediate state" rollback would face the same downstream-
coordination cost).

**5.6 — Resolved-decision-context object**

Across PR2 / PR3 / PR4 / PR5, a single in-process object accumulates
the resolved decision context. The object is emitted by the
argument-parser skeleton (§2.7) at command dispatch time and threaded
through the skill body, the Brainstorm prompt construction (§4), and
the synthesis snapshot (§4.3):

```
ResolvedDecisionContext = {
  body: string,                  // free-form user prose after flag parsing
  preset_id: string,             // §1.5 resolution result
  axes: AxisDescriptor[],        // §1.1 axes from resolved preset (frozen at dispatch)
  size: "minor" | "standard" | "major",  // §2.2 resolved tier (defaults to "standard")
  size_explicit: boolean,        // §1.5(2) explicit-vs-default discriminator
  weights: Record<string, number>, // §2.2 weighting map; empty {} means "no --weights flag passed"
  weights_explicit: boolean,     // PR4 refine M1 amendment — LLM-observable explicit-presence signal (mirrors size_explicit pattern)
  resolved_at: ISO8601-string,   // for snapshot diagnostics
  registry_fallback: boolean,    // PR5 amendment — true when any §1.6 fallback path fired; gates §4.3 axis_awareness emission
}
```

**PR4 refine M1 amendment** (2026-05-25): `weights_explicit` is added
to the on-wire context as a snake_case top-level field mirroring
`size_explicit`. The SKILL.md `@decide:weighting-sensitivity-output`
opt-in gate references `context.weights_explicit === true` directly so
the LLM body consumer reads it from `$AGENTIC_DECIDE_CONTEXT_FILE` rather
than inferring "explicit" from `Object.keys(context.weights).length > 0`,
which would re-introduce the `weights !== {}` object-identity trap peer
G3 had warded off at the JS-API layer. The JS-API parser result retains
its top-level `weightsExplicit` camelCase field (peer G3 placement);
the two names are intentional — JS-API conventions inside the parser
versus JSON-on-wire snake_case for the LLM consumer.

**PR5 amendment — `registry_fallback` on-wire signal** (2026-05-26):
`registry_fallback: boolean` is added as the ninth canonical field on
the §5.6 ResolvedDecisionContext. It surfaces the in-process
`fallbackTriggered` boolean (already returned by
`resolvePreset()` for JS callers) onto the JSON written to
`$AGENTIC_DECIDE_CONTEXT_FILE`, so the §4.3 Brainstorm
`<axis_awareness>` presence rule can be enforced deterministically by
the LLM prompt-builder in `commands/decide.md` Phase 1. Without this
field, `preset_id: "default"` is ambiguous between **intentional
default** (no flag passed, registry healthy) and **fallback default**
(§1.6 row 1/2/3/etc. fired, registry rejected) — and the §4.3 rule
hinges precisely on that branch. Codex Plan-verify (run_id
`plan-verify-20260526T012732Z-1a205273`) raised this as G2/G3 + E2
critical gap: stderr-only fallback diagnostics are consumed and removed
by the bash boilerplate at `commands/decide.md:122-124`, leaving the
LLM with no signal at prompt-construction time. The field is
snake_case to match `size_explicit` / `weights_explicit` and is
populated for every resolution path — happy registry load
(`false`), §1.5(1)/(2)/(4) successful resolution (`false`), and any
§1.6 fallback (`true`), including the E2 edge `--preset=bad
--size=minor` where `preset_id="default"` + `size="minor"` would
otherwise look identical to a healthy compact-preset resolution from
the consumer's perspective.

**Weights internal representation is canonical**: `weights` is
always `Record<string, number>`. An empty object `{}` is the
sentinel for "no `--weights` flag was passed" (and by PR4
normalization rules, this is treated equivalently to "all axes
weight 1.0 / uniform"). The string `"uniform"` is NOT an internal
type — it is a **peer-prompt serialization convention** for §4.2's
`Weights:` line, used because the literal `{}` is less readable
than the word `uniform` in an XML prompt. PR2 ships the object
shape with `weights = {}` default; PR4 owns the normalization
(empty → uniform-1.0) and the peer-prompt rendering (empty → emit
`Weights: uniform`).

Per-PR ownership of fields:

- **PR2** (`axis-registry`) ships the object shape, populates
  `body / preset_id / axes / resolved_at`, and reserves
  `size / size_explicit / weights` slots with default values
  (`"standard" / false / {}`).
- **PR3** (`sizing`) populates `size / size_explicit` from the
  parser skeleton.
- **PR4** (`weighting-sensitivity`) populates `weights` from the
  parser skeleton + normalization.
- **PR5** (`validation-contract`) consumes the object in the
  Brainstorm prompt construction surfaces (per §4.5) and asserts
  field invariants in the validation tests.

This contract — one object, additive field ownership — prevents
PR3 and PR4 from inventing parallel state shapes and gives PR5 a
single surface to validate. The object is in-memory only; no
schema-1.1 frontmatter change is implied.

## Consequences

**Positive**:

- The decide skill ships with the user's preferred 9-axis frame as a
  first-class preset, closing the methodology-vs-tooling gap.
- PR3 (sizing) and PR4 (weighting-sensitivity) can land in parallel
  without rebase conflict — the marker contract bounds their edit
  regions.
- Backward compatibility is near-total (per §2.4): the default
  preset stays at 5 axes, the flag-less invocation
  `/engineer:decide <prose>` is unchanged for any body that does
  not literally begin with `--<known-flag>=<value>`, and
  auto-activated decide is not affected by command-mode strict
  grammar. The one corner case (body literally starting with
  `--size=` etc.) is escapable via the `--` separator.
- The registry contract is portable to a future L2 `decision` plugin
  without re-deciding axis semantics.
- Brainstorm peer ensemble (post-PR5) inherits orchestrator's axis
  frame, raising AGREED-rate without changing the synthesis schema.
- The CI marker-presence lint catches "rebase dropped a marker"
  failures at PR time instead of after merge.

**Negative**:

- Four marker pairs add SKILL.md surface (8 HTML-comment lines per
  pair where there were 0). Markdown renderers ignore them, but
  authors editing SKILL.md need to know the contract.
- Strict flag grammar is a new cognitive load for `/engineer:decide`
  users — the previous shape was "type whatever you want". The
  backward-compatibility rule (first-non-flag-token-starts-body)
  mitigates this but does not eliminate it.
- The single-PR PR2 has a wider review surface (~600-700 LOC after
  reader-test + parser-skeleton scope additions per §5.4) than a
  hypothetical core-only PR2 (~150 LOC). The trade-off was made
  explicitly in §5.3.
- Future axis presets ship as YAML additions, not code additions —
  contributors need to learn the registry format. The format is
  small (one schema, one example) and documented in
  `decision-axes.yml` itself.

**Neutral**:

- The recommendation rule generalizes from "Essence and Foundation"
  to "decisive axes", but every shipped preset keeps Essence and
  Foundation as decisive — current behavior is unchanged for all
  default callers.
- The `<axis_awareness>` block is opt-in via §4.3 presence rule;
  peers that cannot consume the block (Codex / Claude older
  builds) continue to receive the same prompt minus the block.

## Alternatives Considered

### §1 alternatives

1. **JSON instead of YAML** for the registry — rejected because
   the registry is human-authored and human-reviewed; YAML's
   comments and document-order semantics are first-class. The
   `decision-axes.yml` precedent matches `release-please-config.json`
   only loosely; that file is machine-generated downstream from
   `.release-please-manifest.json`. For human-authored configs,
   the agentic-plugins norm leans YAML (companion config, future
   profile YAMLs).

2. **Hardcoded constant in `decide.mjs`** instead of a registry —
   rejected because §1.7 portability (engineer-local-vs-L2) needs
   a contract that survives plugin relocation. A constant move
   would be a code-level migration; a YAML schema move is a
   path-level relocation.

3. **Per-axis weight defaults inside the registry** — rejected for
   PR2 scope. Weights are PR4's concern; baking weight defaults
   into the registry would couple PR2 and PR4 and force a registry
   schema bump if PR4's weighting semantics evolve. §2.2's
   `--weights=` flag is the contract surface; the registry stays
   weight-agnostic.

### §2 alternatives

1. **`--key value` (space-separated) flag form** — rejected because
   `/engineer:decide` body prose may begin with `-` ("are - and *
   equivalent in markdown?") and space-separated flags create
   ambiguity. `--key=value` form is unambiguous against any body
   content.

2. **Positional `<size>` argument** instead of `--size=` — rejected
   because the current `$ARGUMENTS` model is free-form prose; any
   positional argument breaks backward compatibility. The flag form
   preserves the "type whatever you want" shape when flags are
   absent.

3. **JSON-blob argument** (`--config='{"size":"major"}'`) — rejected
   on user-vocabulary grounds. The user types decide commands
   conversationally; demanding JSON serialization at the command
   line is an unnecessary cognitive tax.

### §3 alternatives

1. **XML-tag markers** (`<axis-table>...</axis-table>`) — rejected
   because markdown's interaction with raw inline HTML is
   renderer-dependent. Some renderers parse XML-style tags as HTML
   elements (introducing rendering artifacts), some don't.
   HTML-comment markers are uniformly **renderer-invisible** across
   markdown renderers (GitHub preview, IDE preview, Claude/Codex
   plugin command rendering all strip HTML comments). Note that
   markers remain **source-visible** to the LLM that loads SKILL.md
   raw — this is why §3.2 imposes the marker-wording rule (no
   semantic prose inside markers) so the LLM's view of the skill
   description is not polluted by bookkeeping prose.

2. **Out-of-file marker registry** (`markers.json` listing line
   ranges) — rejected because line ranges drift with every SKILL.md
   edit; an external registry would require synchronized updates
   on every change. In-line markers self-locate.

3. **YAML-frontmatter region IDs** — rejected because SKILL.md
   frontmatter is reserved for the skill manifest (name,
   description). Adding region IDs to frontmatter mixes manifest
   concerns with body-structure concerns.

4. **No marker contract, rely on small-diff PR discipline** —
   rejected because §3.1's collision risk is concrete: PR3 and PR4
   both edit overlapping line ranges on the same file with no other
   coordination signal. A discipline-only approach trades a small
   tooling cost for a high coordination cost.

### §4 alternatives

1. **Always include `<axis_awareness>`** (even when registry
   fallback triggered) — rejected because graceful-degradation per
   ensemble-protocol.md §Failure Handling requires that the peer
   path stays valid when orchestrator config fails. Forcing the
   block on fallback would create an `<axis_awareness>` filled
   with the in-code `default` preset content, which is confusing
   when the user's actual registry was broken.

2. **Pass `<axis_awareness>` only at `--size=major`** — rejected
   because the synthesis benefit (axis-aligned approach
   evaluation) applies at every preset, not only 9-axis. The
   `default` (5-axis) preset benefits equally.

3. **Push axis awareness through a Task Profile field rather than
   a prompt block** — rejected because the Task Profile mechanism
   (per `skills/_shared/references/orchestration.md`) is per-skill,
   not per-ensemble-prompt; threading it through to the Brainstorm
   prompt template requires the prompt-construction code to read
   Task Profile state. A dedicated `<axis_awareness>` block is a
   simpler contract.

### §5 alternatives

1. **Core + Migration two-PR split** — rejected per §5.3 rationale:
   no intermediate-state benefit; markers must precede C/D; no
   second consumer.

2. **Schema-only PR2, all SKILL.md surfaces and markers in a
   PR2.5** — same as alternative 1 with a different cut point.
   Same rejection reasons; this cut is strictly worse because
   PR2.5 would need to land before PR3/PR4, blocking parallel-PR
   work for longer.

3. **Three-PR split (schema / reader / SKILL.md rewrite)** —
   rejected on review-surface-vs-coordination-cost grounds. The
   single PR's ~600-700 LOC (per §5.4) is well under the ensemble
   slicing threshold; three PRs trade ~200-230 LOC each for two
   additional coordination boundaries (rebase ordering, merge-time
   sequencing).

## References

- [ADR-0010](0010-plugin-boundary-policy.md) §2 (6 cognitive verbs),
  §3 (naming convention + verb-level sugar aliases), §5 (cross-
  plugin handoff and the cited-brief in-persona precedent), §6
  (plugin separation triggers — applied negatively here: registry
  stays in-persona until trigger 1 fires).
- [ADR-0011](0011-workflow-continuity-storage.md) §9 (Stage 2
  Non-Goals item 9, marketplace plugin-name alias non-goal — the
  reason `--preset=<id>` is preferred over `/engineer:decide-<preset>`
  marketplace aliasing).
- [ADR-0014](0014-plugins-research-deprecation.md) §2 + §3 (the
  cited-brief-spec migration from L2 to L3 in-persona — §1.7
  portability follows this precedent).
- [ADR-0017](0017-stage25-continuity-and-schema-roadmap.md)
  §sub-decisions 2/4 (command-mode bookkeeping rigor vs auto-
  activated mode — §2.6 follows this principle).
- [ADR-0018](0018-stage3-architecture-orchestrator-and-branch-context.md)
  §sub-decision 2 (single-active-workflow-per-branch, relevant
  to PR3/PR4 parallel branches `feat/decide/sizing` and
  `feat/decide/weighting-sensitivity`).
- [ADR-0019](0019-cross-plugin-invocation-contract.md) §1 Phase 1
  brainstorm (9-axis matrix Round 1 precedent — same axis frame
  this ADR codifies for `engineer:decide`).
- 9-axis canonical text — reproduced in this ADR's Context section
  above (table of 9 axes with Korean / English names + definitions);
  ADR-0019 §1 Phase 1 brainstorm is the load-bearing in-repo
  reference. Workload is deliberately excluded.
- Decision-size vs option-count orthogonality — the principle that
  "decision size" measures granularity (config flip vs architectural
  fork) and is orthogonal to "option count" (how many alternatives
  per item). Motivates §2 `--size=` flag distinct from option
  enumeration. (Originating discussion: auto-memory
  `feedback_presentation_mode_semantics`; the canonical operative
  statement is this ADR §2 plus PR3's topic field in
  `macro-plan-20260519T004937Z-a97fbf`.)
- "최상 = 표준 · 정석 · 근본 quality" user vocabulary — the
  principle that the user's "최상" (best) maps to the standards /
  canonical-precedent / foundation axes specifically, not to
  automation or velocity. Motivates the §1.3 recommendation-rule
  generalization that keeps Essence + Foundation decisive across
  every preset. (Originating discussion: auto-memory
  `feedback_user_value_terms`; the canonical operative statement
  is this ADR §1.3 + the 9-axis canonical text above.)
- `plugins/engineer/skills/decide/SKILL.md` lines 83-94, 101, 120,
  138 — current 5-axis surfaces this ADR plans to rewrite.
- `plugins/engineer/skills/_shared/references/ensemble-protocol.md`
  §Brainstorm (lines 328-355) — current axis-agnostic peer prompt
  template §4 plans to extend.
- `plugins/engineer/commands/decide.md` lines 1-9 — current
  free-form `$ARGUMENTS` contract §2 plans to extend.
- Macro plan workflow `macro-plan-20260519T004937Z-a97fbf` — the
  5-subtask decomposition this ADR's decisions thread through.
