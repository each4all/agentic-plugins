# Completion Output Contract — flag minimum content, provenance, and the six-field proposal split

Normative contract for **what persona completion surfaces must pass** into the
runtime completion footer (`scripts/footer.mjs render`) and **how the footer
reports the provenance of what it renders**. Decided 2026-07-13 (macro
`macro-plan-20260712T022752Z-d542f5` subtask S9; engineer workflow
`compose-20260712T213315Z-e16157`). Vehicle: runtime-owned contract document
per the [`settings-report-contract.md`](settings-report-contract.md) precedent
(also [`footer-contract.md`](footer-contract.md), [`artifact-policy.md`](artifact-policy.md));
no ADR — ADR-0029/0031/0039 own the policy layer and are unchanged.

Scope boundaries with the sibling contracts (single source, no restatement):

- [`footer-contract.md`](footer-contract.md) owns the footer's **rendering
  surface** (required fields, helper invocation, boundaries).
- The persona-side `entry-routing-contract.md`
  (engineer's copy is the reference implementation) owns the **projection
  schema, firing rules, and continue-vs-fresh policy** (ADR-0031).
- **This document** owns the **minimum content / depth criteria** of the
  completion flags, the **per-field provenance schema**, and the
  **six-field Active Next-Action Proposal split** between code emission and
  prose (ADR-0029 §1).

Line references are anchors observed at decision time (`plugin-runtime`
0.79.0 tree) and may drift; the contract text governs.

## 1. Decision record

- **No new footer flags.** Provenance is computed runtime-internally from
  which inputs actually shaped each field. Rejected: a caller-declared
  `--completion-derived` flag — the generic fallback this contract exposes is
  the *runtime's own* no-input default path, not the persona sidecar's
  designed mapping (ADR-0039 §3 renders concrete by design), and a new flag
  would add a version-skew surface (older runtimes throw on unknown
  arguments → the footer would silently stop rendering) for no content gain.
- **Provenance is tri-state, extending the legacy coarse field.** The
  pre-existing `completion.source` (`explicit` | `inferred`, keyed only on
  `--completion-state` presence) is **frozen for backward compatibility** and
  superseded in expressiveness by per-field `completion.sources`.
- **Only `generic` is marked in text output.** A marker that fires on honest
  evidence-based derivation would train readers to ignore it (false-positive
  fatigue); the marker exists to make *silent degradation* visible, not to
  annotate every default.
- **The durable `next_action` string stays schema-frozen** (ADR-0029 §3: no
  durable next_action schema change; the ADR-0031 8-field projection is
  likewise frozen — the runtime seam rejects unknown keys). Everything this
  contract adds rides flag values, return values, and report fields.
- **S9 is additive-visible, not semantics-defining (ADR-0043 §4
  determination).** This slice adds no footer flags and no flag semantics a
  persona emission depends on: the enriched sidecar flags render correctly
  against any runtime ≥ the existing 0.63.0 footer floor
  (`--completion-next-action` predates it), and the provenance/marker
  rendering is a runtime-internal additive change. The founder/designer
  onboarding discovery floor therefore remains "the first released runtime
  version containing the ADR-0043 S2 enum expansion" — it is **not** moved
  by S9. **Known feature-skew window (intentional):** a contract-era persona
  against a 0.63.0–0.79.x runtime renders a fully functional footer without
  provenance fields, generic markers, or the checkpoint line (the sidecar
  still reports the render as successful — its validation gate is
  `session_handoff` presence, not feature completeness); a pre-contract
  persona against a contract-era runtime renders its broad legacy reasons
  unmarked (`explicit`) and shows one honest marker on a blocked
  `completion next action:` line (§3.2).
- **Name disambiguation.** The footer report's `session_handoff.next_command`
  and `next_session.command` are runtime **session-level** pointers (resume /
  `runtime:context status` / `runtime:consensus status` commands). They are
  distinct from the six-field proposal's `next_command` field (§4), which
  travels inside the compact `next_action` string. Same identifier, two
  contracts — do not conflate them when asserting output.

## 2. Flag minimum-content contract

These criteria bind every caller of `footer.mjs render` that passes the flag
in question; the persona terminal sidecars (engineer + orchestrator today;
founder/designer must author against this contract from the start) are the
primary bound callers. All values are single-line (the footer rejects
multi-line flag values).

| Flag | Minimum content | Anti-pattern |
|---|---|---|
| `--completion-reason` | Names the **specific state evidence** that produced the completion state: for workflow terminals, the current phase and — when blocked — the specific failed archive gate tokens from the pure evaluator's verdict (e.g. `head_moved`, `all_subtasks_terminal`). | Restating the state enum ("work is blocked"), or enumerating *possible* causes instead of the observed one. |
| `--recommended-next-work` | Actionable next **work** in imperative form, concrete enough to start from in a fresh session. When a durable workflow exists, this SHOULD be the workflow's recorded `next_action` — which itself carries the ADR-0029 §1 compact proposal form (see §4). | A vague pointer ("continue the work"), or content that duplicates the completion reason. |
| `--completion-next-action` | The **state-scoped immediate action**. For `blocked`, names the concrete unblocking action derived from the failed gates (commit so HEAD moves, settle child workflows, advance the terminal phase, …). | Omitting it on `blocked` terminals (the runtime's static blocked default is generic by definition). |
| durable `next_action` (via the projection) | The ADR-0029 §1 **compact proposal form**: selected next step + one-line rationale + the exact next command (host-neutral or host-local colon-command; the footer host-localizes plugin commands on render). | A bare verb literal ("critique"), or a table-driven "next: X" without rationale. |

The completion-state enum itself is owned by
[`footer-contract.md`](footer-contract.md) §Completion state: `review-needed`,
`publish-needed`, `cleanup-needed`, `next-work-available`, `blocked`,
`closed`.

Sidecar mapping floor (the ADR-0039 §3 mapping, hardened by this contract).
This is the **per-persona-semantics mapping rule** ADR-0043 assigns to this
contract: a persona maps `--completion-state` from **its own terminal
semantics**, not by copying another persona's mapper.

- **Auto-committing lifecycles (engineer, orchestrator)**: `--completion-state`
  maps from the projection's `archive_gate` (`blocked` → `blocked`, else
  `next-work-available`). Their terminal paths commit (engineer Phase 7) or
  close over committed subtasks (macro finalize/abort/auto-terminal), so an
  unmet gate is genuinely *blocked* work.
- **Manually-published lifecycles (founder, designer — S3/S4)**: these
  personas terminalize **without** auto-committing (the owner publishes the
  deliverable manually), so their common unchanged-HEAD terminal is not
  *blocked* — the honest state is **`publish-needed`** (the deliverable is
  ready for the owner's save/commit decision). Their sidecars map:
  a gate verdict whose only unmet evidence is the unmoved HEAD →
  `publish-needed`; a genuinely blocking gate (e.g. live children, invalid
  terminal phase) → `blocked`; else `next-work-available`. S3/S4 encode the
  exact per-gate rule from their own evaluators under this principle.
- `cleanup-needed` / `closed` are never inferred by any sidecar.
- `--completion-reason` names the projection `phase`, and for `blocked` the
  failed gate tokens. The gate tokens travel from the pure stop-archive
  evaluator's `gateFailures` via the projection-compute **return value**
  (`gate_failures`), never inside the frozen 8-field projection JSON. Gate
  tokens are **fail-closed collapses**: `head_moved` also covers a failed
  git probe, and `no_active_engineer_children` also covers a failed child
  scan (the conservative sentinel) — unblocking-action wording must not
  overclaim a single cause.
- `--recommended-next-work` carries the projection's `next_action` verbatim.
- `--completion-next-action` is **always** added when
  `archive_gate === blocked`: gate-specific unblocking actions when the
  tokens are known, else a sidecar-authored fallback naming the raw tokens —
  never an omission that would let the runtime's no-input default render
  (the §3.2 marker-free floor).

## 3. Provenance schema and rendering

### 3.1 Report schema (additive)

- `completion.sources`: `{ state, reason, next_action }`, each
  `explicit | derived | generic`:
  - `explicit` — the field's own caller flag supplied the value
    (whitespace-only values do NOT count: they are treated as absent and
    fall through to the defaults, so a blank line can never render
    marker-free).
  - `derived` — a runtime default consumed **completion-specific evidence**:
    another caller flag's **content** (the recommended next work), consensus
    status guidance, PR-handling readiness, or red context risk. Selecting a
    state template from an explicit `--completion-state` alone is NOT
    evidence — state-only defaults classify `generic`. Evidence must also be
    **consistent** with the state: a blocked reason/next-action may cite
    consensus only when the guidance is itself blocking, and the
    publish-needed strings (which assert readiness passed) count PR handling
    as evidence only on an `ask-user` verdict.
  - `generic` — a static state-template fallback composed with **no**
    completion-specific evidence.
  - Documented exception: for `--completion-state closed`, the static
    reason/next-action restate a definitionally complete assertion and
    classify as `derived` — `closed` already asserts that evidence was
    checked outside the footer (footer-contract.md §Completion state), so a
    generic-fallback nudge would be a false positive.
- `recommended_next_work_source`: `explicit | derived | generic`. When the
  recommended next work falls back to `completion.next_action`, it inherits
  that field's provenance (an explicit `--completion-next-action` reads as
  `derived` here — authored content arriving via another flag).
- `completion.source` (legacy, coarse): unchanged semantics
  (`explicit | inferred` keyed on `--completion-state` presence only). New
  consumers use `completion.sources`.

### 3.2 Text rendering

- Every completion surface whose provenance is `generic` renders with the
  ` [generic fallback]` suffix — `completion state:`, `completion reason:`,
  `completion next action:`, and `recommended next work:` lines.
- The marker is **text-format only**. JSON report field values never carry
  it (the false-pass rule inverse: a machine consumer reads provenance from
  the schema fields, a human reads it from the marker — neither channel may
  silently disagree with the other).
- `workflow checkpoint:` renders when the projection carries a checkpoint —
  the durable checkpoint **summary** (the nearest durable analog to the
  proposal's `evidence_pointers`, §4). The renderer single-line-sanitizes it
  (control characters and newlines collapse to spaces): the projection file
  accepts free text, and interpolating it raw could fabricate footer lines.
- A persona sidecar terminal footer is **generic-marker-free by
  construction**: the sidecar passes state, reason, and recommended next
  work explicitly (and the unblocking next action when blocked). A marker
  appearing on a persona terminal footer means that persona is below this
  contract's flag floor — e.g. a pre-contract sidecar omitting the blocked
  unblocking action renders one honest marker on the `completion next
  action:` line against a contract-era runtime. The remedy is upgrading the
  persona plugin, not suppressing the marker.

## 4. The six-field proposal split (code-backed floor vs prose)

The ADR-0029 §1 Active Next-Action Proposal has six fields. Under the frozen
schemas (§1), they split honestly as follows:

| Field | Durable home | Code-emitted at terminal | Limit |
|---|---|---|---|
| `selected_next` | inside the compact `next_action` string | ✅ via `recommended next work` | not separately parseable (single string by design) |
| `rationale` (one-line) | inside the compact `next_action` string | ✅ via `recommended next work` | full rationale is prose-only |
| `next_command` | inside the compact `next_action` string | ✅ via `recommended next work` (+ host localization) | — |
| `evidence_pointers` | workflow path + `latest_checkpoint.summary` | ✅ via `workflow path` artifact + `workflow checkpoint` line | only pointer-shaped evidence; inline evidence lists are prose-only |
| `rejected_alternatives` | none | ❌ | prose-only — no durable home without a schema change (forbidden, ADR-0029 §3) |
| `confidence` | none | ❌ | prose-only — same reason |

**Honest limit (ADR-0031 lesson: prose-only = zero active triggers).** The
prose-only fields (`rejected_alternatives`, `confidence`, the full
`rationale`) have **no code trigger**: they render only because the model
follows the completion runbook. The code-backed floor is exactly the compact
`next_action` + the footer render on the terminal path; everything above the
floor is display-layer obligation, pinned by shape tests
(§5), not by execution.

### 4.1 Canonical template (single shared source)

Every persona completion surface (command `.md` and skill `SKILL.md`
completion sections, and the state-write phase-note blocks) emits the
proposal with **these six field keys, in this order**:

```
- selected_next:         <the recommended next step>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — decisive axes + the persona's quality gate>
- evidence_pointers:     <pointers only — phase notes / files / artifacts>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact runnable next step>
```

Allowed per-persona/per-verb variation (**slots**, not structure):

- the `selected_next` value space follows the persona lifecycle (e.g.
  engineer's `commit` is the Phase 7 auto-commit; founder/designer may also
  name `commit` — there it means the **owner's manual publish step**, since
  their lifecycles terminalize without auto-committing);
- the `rationale` quality gate names the persona's own gate (engineer:
  Standards/Root-Cause gate; founder: evidence-quality gate; designer:
  accessibility/consistency criteria);
- placeholder hints may be verb-specific (e.g. `spec sections / flow
  states` vs `plan sections / brief path`);
- surrounding prose (typical candidates, routing guidance) stays
  persona-authored.

Forbidden: dropping/renaming/reordering the six keys, and **re-enumerating
the field list in surrounding prose** (a second enumeration is the drift
vector this template exists to remove — point at the block or the persona's
contract section instead).

## 5. Test obligations

1. **Runtime provenance suite**
   (`tests/runtime/test-footer-completion-provenance.mjs`): per-field tier
   classification (explicit/derived/generic across the branch table), the
   `closed` exception, marker rendering including the 4-marker fully-generic
   case, marker absence from JSON values, checkpoint rendering, and legacy
   `completion.source` freeze.
2. **Persona flag floor** (`tests/engineer/test-footer-activation.mjs`,
   `tests/orchestrator/test-footer-activation.mjs`): the sidecar mapping
   names phase + failed gates, passes the unblocking `--completion-next-action`
   when blocked, single-line values, and E2E terminal footers are
   generic-marker-free.
3. **Cross-persona template conformance**
   (`tests/plugin-shape/test-completion-output-contract.mjs`): every
   `- selected_next:` block across the four personas' commands/skills carries
   the six keys in canonical order; per-persona site floors hold; no
   surrounding-prose re-enumeration of 3+ field tokens on one line; this
   document's own template block stays in lockstep.
4. **Doc ↔ code lockstep** (same test file): the six completion states, the
   provenance vocabulary, and the ` [generic fallback]` marker documented
   here match the `footer.mjs` constants and renderer.

## 6. Non-goals

- No durable `next_action` schema change and no new projection fields
  (ADR-0029 §3 / ADR-0031 — both schemas stay frozen).
- No new footer flags and no new runtime command surface
  (footer-contract.md "script, not a command" posture stands).
- No parsing of the compact `next_action` string back into structured
  fields — the string is the contract; fragile prose parsing is explicitly
  rejected.
- No founder/designer sidecar wiring here — their onboarding subtasks
  (macro S3/S4) build against this contract from the start.
- No change to consensus/PR-handling/cutover guidance semantics; their
  states feed the `derived` tier and are otherwise untouched.
