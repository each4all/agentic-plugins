# ADR-0043: founder/designer workflow-projection and completion-footer enablement

## Status

Accepted (2026-07-12)

> Amended 2026-08-27 — see [Amendments](#amendments). The inherited
> ADR-0039 contract no longer passes `--context-state`.

<!--
This is the runtime-enablement ADR that ADR-0042 explicitly required
before extending workflow-projection semantics ("extending
workflow-projection semantics would be a separate runtime-enablement
ADR, not this RT track"). It executes the founder onboarding recipe
recorded in ADR-0039 §7 and the founder deferral in the ADR-0031
Amendment §Scope, extending both to designer. It does not modify the
projection model (ADR-0031), the piggyback mechanism (ADR-0039), or the
footer render interface (ADR-0024 / footer-contract.md) — it widens who
may ride them. Implementation is staged by the 2026-07-12 macro plan:
S2 (runtime enum expansion), S3 (founder onboarding), S4 (designer
onboarding), with S9 (completion-output contract) as a co-gate for
S3/S4.

Flipped to Accepted 2026-07-12 on merge of the authoring PR #553, per
the ADR process §3 merge-time default. The S2 macro subtask reads
"Per accepted ADR-0043", so acceptance gates the implementation
series rather than following it (contrast the ADR-0039
flip-on-series-completion precedent, whose implementation was bundled
with the ADR itself).
-->

## Context

**The lineage.** ADR-0024 introduced the completion footer and
`footer.mjs`; ADR-0031 shipped the bounded 8-field workflow projection
and — via its 2026-06-22 Amendment — made the session-handoff sidecar
fire from the terminal-mutation *scripts* rather than runbook prose;
ADR-0039 activated the footer by piggybacking the code-spoken sidecar
path via a subprocess. All of this landed for **engineer and
orchestrator only**.

**The deferral is recorded in four places, all pointing here.**

- ADR-0039 §7 deferred founder with an explicit onboarding recipe
  (build `emitTerminalHandoffSidecar` + the projection builder, extend
  `VALID_WORKFLOW_KINDS` + `footer-contract.md` scope, wire Stop-hook
  emit + SessionStart re-injection + the shared runbook, converge the
  Active Next-Action shape + shape test, then apply the piggyback).
- The ADR-0031 Amendment §Scope deferred founder-side wiring, noting
  that when taken up it "follows this amendment's same eight decisions
  verbatim, since founder's surfaces are structurally identical to
  engineer's".
- ADR-0042 (Consequences) recorded that runtime's `workflow_kind`
  projection is deliberately **not** extended for designer and that
  "extending workflow-projection semantics would be a separate
  runtime-enablement ADR, not this RT track". **This is that ADR.**
- The runtime CHANGELOG pinned the same intent with tests: "the runtime
  `workflow_kind` projection enum is **not** extended (designer reaches
  the session-handoff seam as an honest unsupported kind, like
  founder)".

**Current code state (verified 2026-07-12, runtime 0.78.1).**

- The runtime seam models two kinds: `VALID_WORKFLOW_KINDS =
  new Set(['engineer', 'orchestrator'])`
  (`plugins/runtime/scripts/context.mjs:19`). A projection of any other
  kind degrades honestly: the projection is rejected (`projection:
  null`), the continue-vs-fresh decision falls back to context budget +
  routing, and the report names the unsupported kind
  (`context.mjs:840`/`:880`/`:895`/`:916`). The degradation prose
  already anticipates this ADR: "Modeling new kinds (enablement) is a
  separate change, out of scope here" (`context.mjs:880`). Intentional
  reject-tests pin the behavior for designer
  (`tests/runtime/test-context.mjs:474`) and founder (`:517`).
- `footer-contract.md:3` scopes the footer to "engineer and
  orchestrator completion surfaces".
- `footer.mjs`'s host-localization regex omits designer:
  `PLUGIN_COMMAND_RE = /…(?:runtime|engineer|orchestrator|founder|image):…/g`
  (`plugins/runtime/scripts/footer.mjs:1030`) — a
  `designer:<verb>` command flowing through a footer would not be
  rewritten to the render host's prefix.
- founder and designer both carry a **dormant** projection builder
  (`computeFounderProjection` / `computeDesignerProjection`,
  `plugins/{founder,designer}/scripts/session-handoff.mjs:77`) that
  already assembles the exact 8-field shape (`:136-146`) — **the gap is
  plumbing, not schema**. Missing on both: `emitTerminalHandoffSidecar`
  and the footer-marker machinery (`footerMarkerFile` /
  `claimFooterRender` / `markFooterRendered`), the `setTerminal`
  `emitHandoff` opt-in firing (engineer's signature carries
  `emitHandoff = false` opted in by the production entry points,
  `plugins/engineer/scripts/state.mjs:2446`, fired post-lock via lazy
  import at `:2500`; founder/designer `setTerminal` has no such
  parameter, `plugins/{founder,designer}/scripts/state.mjs:2274-2317`),
  Stop-hook sidecar emission (their `stop.mjs` imports archive helpers
  only), and SessionStart pending-handoff consumption
  (`readPendingHandoff` / `pendingHandoffReinjectionLine` /
  `consumePendingHandoff`; engineer consumes at
  `plugins/engineer/adapters/claude/hooks/session-start.mjs:109-114`;
  founder's hook re-injects active-workflow metadata only). The
  founder/designer copies are line-identical to each other outside
  persona naming and ADR references, and their `session-handoff.mjs`
  is one third of engineer's (223 vs 675 lines) — exactly the missing
  plumbing.
- founder and designer each ship a `discover-runtime.mjs` whose **only**
  consumer is `peer-runner.mjs`'s notify emission — it gates on
  `scripts/notify.mjs` alone. Engineer's copy demonstrates the target
  shape: **two separate floors**, a footer floor and a notify floor
  (`plugins/engineer/scripts/discover-runtime.mjs:36-50`).
- All three persona state readers are schema-synchronized
  (`SUPPORTED_SCHEMA_VERSIONS = {1, '1.1', '1.2', '1.3'}`;
  engineer `state.mjs:77`, founder/designer `state.mjs:88`) — the
  workflow-file substrate needs no change.
- Downstream consumers are narrower than the seam, and **each carries a
  different persona set** — "the personas" is not one list:
  `VALID_WORKFLOW_KINDS` is {engineer, orchestrator}
  (`context.mjs:19`); the attention sensors hardcode
  `SENSOR_PERSONAS = ['engineer', 'orchestrator']`
  (`plugins/attention/scripts/lib/sensor.mjs:313`; the adjacent comment
  explains founder's exclusion but predates designer and never mentions
  it) and document that the footer-rendered marker **shape differs per
  persona** (`sensor.mjs:339-345`); the runtime dashboard's Tier-1
  persona set is engineer + orchestrator + founder
  (`DASHBOARD_PERSONAS`, `plugins/runtime/scripts/dashboard.mjs:79-83`,
  per ADR-0040 §6), with designer deliberately out — and the dashboard
  reads **workflow namespaces directly, never projections/sidecars**
  (`dashboard.mjs:89-130`, `:573-583`); doctor's workflow-ledger scan
  keeps its own {engineer, orchestrator} contract
  (`plugins/runtime/scripts/doctor.mjs:2015-2022`, render loop `:4990`,
  contract noted at `state-readers.mjs:20`); and doctor/settings
  `PLUGIN_NAMES` (`doctor.mjs:40`) already lists all eight plugins for
  inventory only. These sets differ **by decision, not by accident** —
  each surface was scoped by its own ADR.
- The projection JSON itself carries **no version field** (the bounded
  key set is the contract; `ARTIFACT_SCHEMA`, `context.mjs:12`, versions
  a different artifact) — so a persona emitting a projection has no
  in-band way to detect whether the consuming runtime models its kind;
  compatibility must be gated entirely on the producer side (see §4).

**Macro context.** The 2026-07-12 four-question diagnosis produced a
10-subtask macro plan whose footer track is: **S0** (this ADR) → **S2**
(runtime enum expansion) → **S3** (founder onboarding) ∥ **S4**
(designer onboarding), with **S9** (completion-output contract) gating
S3/S4 alongside S2. The macro's Plan-verify peer required this ADR to
scope the downstream reach explicitly (attention / dashboard) and to
set the compatibility floor.

## Decision

### 1. Extend the runtime seam to the four personas (implemented by S2)

`VALID_WORKFLOW_KINDS` (`context.mjs:19`) gains `founder` and
`designer`. The projection schema (8 bounded fields,
`context.mjs:23-27`) and the archive-gate enum are kind-agnostic and
unchanged — the expansion is **additive**.

The **unsupported-kind degradation path stays**. It is not scaffolding
to be torn down; it is the permanent honest-scope defense for typo'd
kinds and future personas. S2 therefore: flips the intentional
founder/designer reject-tests (`tests/runtime/test-context.mjs:474`,
`:517`) into acceptance tests, and **rewrites the unknown-kind
regression against a genuinely unsupported kind** so the degradation
path keeps a live test.

S2 also carries the seam's cleanup in the same runtime slice:

- `footer-contract.md` widens to the four personas with
  **rollout-neutral wording**: the contract's statements about *who
  code-emits* (`footer-contract.md:69`) and whose runbooks it links
  must stay true both before and after S3/S4 land — scope by "personas
  whose onboarding has landed per ADR-0043" (or equivalent), not by a
  hardcoded list that is false during the rollout window.
- `PLUGIN_COMMAND_RE` (`footer.mjs:1030`) gains `designer` — an
  independent latent defect, but the same contract surface ("persona
  projection routing" localization), so it rides S2 rather than a
  separate PR, with a dedicated designer command-localization
  regression.
- Runtime limits/README wording and the changelog's
  designer-unsupported statement are updated; the dashboard's
  designer-exclusion explanation is **re-grounded** (see §3), not
  deleted.

The regression blast radius is wider than the two intentional
reject-tests: founder/designer serve as unsupported-kind **fixtures**
across bounded-schema, file-loading, status, routing-preservation, and
footer tests (e.g. `tests/runtime/test-context.mjs:540`/`:591`/`:648`,
`tests/runtime/test-footer.mjs:767`). S2 converts these
systematically: acceptance coverage for all four supported kinds, a
genuinely-unknown kind exercised across **both** the context and
footer paths, and the designer-localization regression above.

### 2. founder/designer onboarding = the ADR-0039 §7 recipe under the ADR-0031 Amendment's eight decisions, verbatim (implemented by S3 ∥ S4)

Each persona onboards by copying the reference implementation (per
ADR-0010 §5; see §6) — with an **explicit behavioral baseline**,
because "copy engineer" alone under-specifies: engineer and
orchestrator already diverge on fail-closed details. The baseline is
**engineer's path-targeted projection semantics plus orchestrator's
hardened delivery and stale-file handling**, concretely:

- `emitTerminalHandoffSidecar` added to the persona's
  `session-handoff.mjs` copy, computing the projection **for the exact
  workflow being terminated (by path)** — not a current-branch lookup —
  and writing the projection file + best-effort stderr advisory, never
  stdout.
- **Delivery failure returns `rendered: false`** so SessionStart
  reconciliation stays live (orchestrator semantics,
  `plugins/orchestrator/scripts/session-handoff.mjs:485`; engineer
  swallows a failed stderr delivery and still reports rendered,
  `plugins/engineer/scripts/session-handoff.mjs:404` — not the
  baseline), and **a failed emit clears any stale projection from a
  prior successful emit** (orchestrator's fail-closed rule,
  `session-handoff.mjs:546` — the file always reflects *this* emit;
  engineer leaves the prior file in place — not the baseline).
- The projection slot is the single per-persona
  `last-session-handoff.json` (ADR-0031's design, engineer reference
  `session-handoff.mjs:193`). founder/designer allow one active
  workflow **per branch**, so concurrent cross-branch terminals can
  overwrite the slot between write and render — this ADR **explicitly
  accepts last-writer-wins** for that overlap (inherited from
  engineer/orchestrator; the at-most-once marker prevents double
  render, not cross-workflow overwrite). Per-workflow projection files
  would change the ADR-0031 slot model and are out of scope.
- Fired from the exported `setTerminal()` helper after the mutation
  succeeds and after lock release, via the lazy `await import()`
  pattern (ADR-0031 Amendment decisions 1/3; engineer precedent
  `state.mjs:2500`), including the `emitHandoff = false` **opt-in
  parameter** shape (`state.mjs:2446`): the production completion entry
  points opt in explicitly, so library callers and tests don't fire
  sidecars as a side effect.
- The ADR-0039 piggyback applied unchanged: `execFile` subprocess,
  no `--context-state` (amended 2026-08-27 — see
  [Amendments](#amendments)), completion-flags mapping,
  output re-emitted on the caller's **stderr only**, `emitted === true`
  gate, at-most-once render guard (atomic claimed/rendered marker with
  reconciliation), silent fail-closed (§§2-6 of ADR-0039).
- Stop-hook backstop emits the sidecar before the **current-branch**
  auto-archive move (founder/designer already ship
  Stop/PreCompact/SessionStart hook bindings — this extends their
  `stop.mjs`, it adds no new hook). Scope honesty: the branch-agnostic
  **orphan sweep** (`runStopArchiveOrphanSweep`,
  `plugins/founder/scripts/stop-archive.mjs:231`) archives
  deleted-branch terminal workflows **without** a final emit attempt —
  an inherited engineer/orchestrator limitation. S3/S4 either wire a
  final best-effort emit into the sweep or document the inherited
  limitation explicitly in the persona runbook; this ADR does not
  promise sidecar emission on the sweep path.
- SessionStart gains pending-handoff consumption
  (`pendingHandoffReinjectionLine` + `consumePendingHandoff`) that runs
  **independently of an active workflow**, mirroring engineer's hook.
  The SessionStart binding keeps its `compact` matcher — engineer,
  orchestrator, and designer all register `matcher: "compact"` only, so
  parity means same-matcher copy; the inherited consequence (a pending
  handoff written just before a session ends is consumed on the next
  *compaction* start, not an ordinary fresh startup) is documented, and
  widening to a startup matcher is entry-time surface work reserved for
  ADR-0045 (macro S6), not this enablement.
- `discover-runtime.mjs` grows to the dual-consumer ladder: a **new
  footer floor** (see §4) layered alongside the **existing notify
  floor**, which is unchanged. This is **not a verbatim engineer
  copy**: every resolver rung hardcodes the capability file it gates on
  (engineer probes `scripts/footer.mjs`,
  `plugins/engineer/scripts/discover-runtime.mjs:147`; founder/designer
  today probe `scripts/notify.mjs`,
  `plugins/founder/scripts/discover-runtime.mjs:142`). Copying
  engineer's resolver wholesale would silently change notify discovery
  from "notify exists" to "footer exists". The persona resolver
  therefore parameterizes (or duplicates per-consumer) the gating
  capability file so the notify ladder keeps gating on `notify.mjs`
  while the new footer ladder gates on `footer.mjs`, and the two floors
  get **independent** regression tests.
- The persona's diverged inline Active Next-Action shape converges on
  the ADR-0029 six-field proposal, with a shape test; verb/skill
  completion prose stops hand-composing the footer (ADR-0039 §9). The
  ADR-0039 §7 recipe's **shared runbook** lands as part of this: each
  persona gains a copied
  `skills/_shared/references/session-handoff.md` (engineer's runbook is
  the source), and the persona's verb commands/skills replace their
  inline "deeper ADR-0031 integration is future work" prose with
  references to it — the runbook is what documents the code-emitted
  footer, the fail-closed baseline above, and the reconciliation rules
  for that persona.
- **Completion-flag mapping comes from the S9 contract, not from
  copying engineer's.** Engineer's `mapCompletionFlags` collapses to a
  `blocked` / `next-work-available` dichotomy
  (`plugins/engineer/scripts/session-handoff.mjs:318-335`) and never
  emits `publish-needed` — acceptable for a persona whose Phase 7
  auto-commits, but founder/designer terminalize **without**
  auto-committing (the owner publishes manually), so on their common
  unchanged-HEAD terminal path the honest completion state is
  frequently `publish-needed`, not `blocked`. S9 (macro-gated ahead of
  S3/S4) delivers the durable output contract — a runtime-owned
  contract document per the `settings-report-contract.md` precedent —
  defining the minimum completion-flag content and the
  per-persona-semantics mapping rule; S3/S4 derive their
  `--completion-state` / `--completion-reason` /
  `--recommended-next-work` mapping from **their own terminal
  semantics under that contract**. If S9's runtime-side
  fallback-visibility change also defines flags the persona emissions
  depend on, the §4 floor covers it (see §4).

The footer-rendered **marker is a cross-package contract, not a
private implementation detail**: attention's enrichment gate hardcodes
both the per-persona marker *filename algorithm* and the required
*JSON shape* (`{workflow_id, status: 'rendered'}`) before it will
enrich (`sensor.mjs:339-345`, `:364-372`). S3/S4 therefore fix each
persona's marker filename + JSON shape as a **documented contract**
(in the persona's session-handoff runbook), pinned by regression
tests, and the §3 attention follow-up consumes that documented
contract rather than reverse-engineering the implementation.
Engineer's slot-shaped marker (`${projectionFile}.footer-rendered`,
workflow-id inside the JSON) is the natural fit — founder/designer
share engineer's single-projection-slot structure — but the binding
decision is the *documented-contract obligation*, not the filename.

### 3. Downstream scope: attention deferred with a trigger; dashboard designer-inclusion and doctor ledgers out of scope

**attention is an explicit non-goal of this ADR.** Extending
`SENSOR_PERSONAS` (`sensor.mjs:313`) is deferred to a separate
attention PR whose **trigger** is: S3/S4 released, i.e.
founder/designer sidecars actually emitting in the wild. Rationale:
(a) the attention sensors never assume a persona hook and operate
without sidecar enrichment (`stop.mjs:6` — enrichment is a
freshness-checked bonus, not a dependency), so nothing breaks in the
interim; (b) the enrichment reads the per-persona footer-rendered
marker, whose shape for founder/designer is fixed only by S3/S4 (§2) —
extending attention before those land would be coding against a
guessed contract; (c) `plugins/attention` is its own release-please
package (ADR-0016 — separate commit/PR anyway). That follow-up also
refreshes the `SENSOR_PERSONAS` comment (`sensor.mjs:308-312`), which
explains founder's exclusion via the pre-S2 premises ("the runtime
seam rejects workflow_kind 'founder'") and predates designer entirely.

**dashboard designer-inclusion is likewise out of scope.** The
dashboard's Tier-1 persona set (engineer/orchestrator/founder,
`DASHBOARD_PERSONAS`, `dashboard.mjs:79-83`) is an ADR-0040 §6 decision
**independent of the projection enum** — founder is already in Tier-1
today *despite* being an unsupported projection kind, and the dashboard
never reads projections/sidecars at all (it scans workflow namespaces
directly, `dashboard.mjs:573-583`), which proves the two surfaces are
orthogonal. S2 only **re-grounds** the dashboard's designer-exclusion
explanation: the old "unsupported projection kind, like founder"
comparison loses its premise once the enum is four-persona, so the
comment/docs/test pins must instead point at ADR-0040 §6's deliberate
Tier-1 scoping. Designer's Tier-1 inclusion is a demand-gated follow-up
(trigger: designer production dogfood surfacing a real need for
designer workflow visibility in the aggregate view), not part of this
enablement.

**doctor's workflow-ledger scan keeps its {engineer, orchestrator}
contract, likewise untouched.** `inspectWorkflowLedgers`
(`doctor.mjs:2015-2022`, render loop `:4990`) is a third
persona-scoped surface with its own explicitly noted contract
(`state-readers.mjs:20`); like the dashboard set, it reads workflow
files/ledgers — not projections — so the enum expansion neither breaks
nor half-enables it. Widening doctor's ledger health coverage to
founder/designer is observability scope, demand-gated the same way as
dashboard inclusion. This ADR fixes the vocabulary: "the four
personas" refers to the **projection seam** (`VALID_WORKFLOW_KINDS`)
only; dashboard Tier-1, doctor ledgers, attention sensors, and
`PLUGIN_NAMES` each keep their own deliberately-scoped sets.

### 4. Compatibility floor: first released runtime version containing S2

founder's and designer's **footer floor** in their
`discover-runtime.mjs` ladders is the **first released runtime version
that contains the S2 enum expansion** — and, if the S9 runtime-side
change (generic-fallback visibility) defines flag semantics the
persona emissions depend on, the first released version containing
**both** S2 and that S9 runtime slice. The concrete version is
deliberately **not pinned in this ADR** — the resolver-floor comments
forbid pinning unreleased versions; S3/S4 write the real number at
authoring time, after the covering release exists.

Rationale: engineer's footer floor (0.63.0) gates on the *render
interface* being complete. For founder/designer the binding constraint
is different — every released runtime ≥0.63.0 renders footers, but
any runtime **without S2 rejects the persona's `workflow_kind`** and
renders the unsupported-kind degradation text instead of the real
footer. And because the projection JSON carries **no version field**
(Context), the producing persona has no in-band signal that the
consuming runtime models its kind — the producer-side discovery floor
is the *only* compatibility gate available. Gating discovery on the
S2-containing release converts that confusing half-working state into
the established silent fail-closed behavior (no footer, workflow
proceeds — ADR-0039 §§5-6). The **notify floor stays where it is**:
notify emission is a released capability and must not be dragged up by
the footer floor (the two floors are separate by design, engineer
precedent `discover-runtime.mjs:36-50`).

### 5. Rollout and rollback

**Order (macro-enforced, as an explicit join):**

```
(S2 lands in plugins/runtime → release-please release → both hosts install)
        ∥ (S9 contract lands)
   → S3 ∥ S4 land in plugins/founder / plugins/designer
   → persona releases → both hosts install → Codex /hooks re-attestation
```

S3/S4 are gated on **both** arms: the released S2 floor (they cannot
name an unreleased version) *and* the S9 contract (they author their
completion-flag mapping against it, §2). The intermediate states are
safe by construction: with S2 released but S3/S4 unlanded, no
founder/designer sidecar exists, so the widened enum simply receives
no projections.

**Post-S3/S4 host rollout is part of the rollout, not an
afterthought.** The persona packages must be released and installed on
both hosts, and because S3/S4 modify **hook-bearing** plugins
(`stop.mjs`, `session-start.mjs`), the Codex side additionally
requires a `/hooks` review/trust **re-attestation** after the upgrade
(the established rule for hook-bearing upgrades;
`plugins/runtime/scripts/settings.mjs:1440`). Without it the primary
CLI emission still fires, but the Stop backstop and SessionStart
reconciliation silently do not run on Codex — the e2e verification
gate is therefore: install + re-attest + observe a real footer on a
terminal transition, per persona, per host.

**Shared-surface serialization inside the parallel arm:** S3 and S4
are code-parallel (different packages) but share one integration
surface — the root black-box acceptance suite
(`tests/acceptance/test-footer-activation-acceptance.mjs`) whose
persona×host matrix and import-boundary list currently cover
engineer/orchestrator only (`:3`, `:75`, `:188`). Root tests are
exempt from release-please routing (ADR-0016), so the rule is
ordering, not packaging: the first of S3/S4 to land extends the
matrix for its persona; the second **rebases and completes the
four-persona matrix** — neither ships a matrix that claims uniform
coverage it doesn't have.

**Rollback:**

- **Before S3/S4 ship**, S2 is a plain additive revert (reject-tests
  restored; engineer/orchestrator untouched).
- **Once S3/S4 have shipped, S2 is no longer independently
  revertible.** The discovery floor compares **versions, not
  capabilities** (`discover-runtime.mjs:136`, `:278`): a later runtime
  release that reverts the enum still satisfies `version ≥ floor`, so
  persona sidecars keep firing and runtime rejects them at
  normalization (`context.mjs:916`) — fail-closed but silently
  feature-dead, with the floor unable to protect anything. Rollback
  order is therefore **personas first, runtime second** (or:
  re-widening the floor requires a fresh persona release naming a new
  floor).
- S3/S4 roll back by reverting the persona package alone. A
  four-persona runtime with no founder/designer emitters is harmless.
  Reverting also **leaves durable one-shot artifacts** behind — the
  persona's `last-session-handoff.json` and footer-marker files have
  no age or workflow-existence check on the pending-read path
  (engineer reference `session-handoff.mjs:528`; cleanup happens only
  on consumption `:589`) — so a later re-enable could surface a
  pre-rollback handoff as current. The rollback runbook includes
  removing `.agentic-plugins/state/<persona>/last-session-handoff.json*`
  (projection + markers) for the rolled-back persona.
- Per ADR-0016, `plugins/runtime`, `plugins/founder`,
  `plugins/designer`, and `plugins/attention` (when its follow-up
  fires) are separate release-please packages: every slice above is a
  separate per-package commit/PR; no commit may span two of them.

### 6. Copy-not-import boundaries (ADR-0010 §5)

All onboarding machinery is **copied, never imported**:
`emitTerminalHandoffSidecar`, the footer-floor addition to
`discover-runtime.mjs`, and the SessionStart pending-handoff helpers
are copied from engineer's reference implementation into each persona,
exactly as the existing `session-handoff.mjs` / `discover-runtime.mjs`
copies were. No persona imports runtime (`footer.mjs` is reached only
by subprocess per ADR-0039 §2/§5), and no persona imports another
persona. This extends a duplication cost the framework has already
accepted (ADR-0039 Consequences); the S9 output contract governs the
copies' *content* as a documented contract personas conform to — not
as an importable module.

### 7. ADR index

`docs/adr/README.md` gains the 0043 row (this file). The number was
reserved by the macro plan's collision guard (0043=S0, 0044=S5,
0045=S6, 0046=S7-contingent).

## Consequences

**Positive**

- All four personas converge on one completion experience: the
  continue-vs-fresh handoff, next-session prompts, and code-emitted
  completion elements (ADR-0039 elements 2/3/4/7/8) fire for founder
  and designer terminal paths, not just engineer/orchestrator.
- Four recorded deferrals (ADR-0039 §7, ADR-0031 Amendment §Scope,
  ADR-0042 RT note, runtime changelog pin) are discharged by a single
  decision record, each implementation slice tracing back here.
- The latent `PLUGIN_COMMAND_RE` designer omission is cleaned up on
  the same contract surface that motivates it.
- The unsupported-kind degradation path survives with a live test,
  keeping the onboarding pattern repeatable for any future persona.

**Negative**

- Two more copies of the sidecar + discovery machinery
  (founder, designer) join the accepted ADR-0010 §5 duplication cost —
  now four parallel implementations to keep behaviorally aligned
  (S9's contract + shape tests are the mitigation).
- The S2-release gate serializes the footer track: S3/S4 cannot even
  name their floor until a runtime release ships (and wait on the S9
  contract besides), extending the macro's critical path by one
  release cascade. Once S3/S4 ship, S2 additionally becomes
  non-revertible without a coordinated persona rollback first (§5).
- Until the attention follow-up fires, founder/designer completions
  render footers but produce **no** attention-sidecar enrichment, and
  designer stays out of the dashboard Tier-1 view — a temporary,
  documented asymmetry.

**Neutral**

- `footer.mjs render`'s flag interface is unchanged; footer-contract.md
  changes scope and code-emit wording (rollout-neutral, §1) but no
  field, flag, or channel semantics.
- The workflow-file schema and the 8-field projection shape are
  untouched: founder/designer already share engineer's 1.3 lineage
  (orchestrator's separate 1.1 lineage is already onboarded), and the
  projection builders already emit the exact bounded shape — enablement
  is entirely in the kind enum + persona plumbing.
- Marker *filenames* stay per-persona (S3/S4 choose them), but each
  choice ships as a documented cross-package contract with regression
  pins (§2) — attention consumes the contract, not the implementation.

## Amendments

### 2026-08-27 — inherited from ADR-0039: no `--context-state`

This ADR applies [ADR-0039](0039-completion-footer-activation.md) §2's
subprocess contract unchanged, so it inherits that ADR's 2026-08-27
amendment: the sidecar passes no `--context-state`. The hard-coded `yellow`
was read by `footer.mjs` as a caller assertion, rendering an unmeasured
value as though it had been observed. Designer and founder now supply
nothing, and runtime reports its own conservative fallback as
`unmeasured (no budget sensor)`.

Both personas floor discovery at runtime **0.79.0**, and the provenance
render arrived in **0.92.0**, so 0.79.0–0.91.x remain reachable and render
`context state: yellow` exactly as before — the omission is byte-identical
there, which is why no capability floor was added. See ADR-0039
§Amendments for the full rationale and the measurement.

## Alternatives Considered

- **Runtime reads persona state directly (no per-persona sidecar).**
  Rejected — inverts the ADR-0031 layering ("the owning plugin computes
  these fields from its OWN state and passes them IN; runtime never
  shell-reads higher-layer state", `context.mjs:15-18`) and would make
  L1 depend on L2/L3 internals.
- **Drop the kind enum entirely (accept any `workflow_kind`).**
  Rejected — the enum is what turns a typo'd or future kind into an
  honest, named degradation instead of a silently wrong archive-gate
  read. The genuinely-unknown-kind regression (§1) exists precisely to
  keep that defense alive.
- **One persona at a time (founder-only ADR, designer later).**
  Rejected — the surfaces are structurally identical (ADR-0031
  Amendment §Scope), S3/S4 are already parallel macro subtasks, and a
  second ADR would re-litigate the same decision with the nouns
  swapped. Implementation still ships per-package (§5), so PR size is
  unaffected.
- **Extend attention's `SENSOR_PERSONAS` in this enablement.**
  Rejected — before S3/S4 land there is no founder/designer sidecar to
  enrich from, and the marker shape the enrichment reads is fixed only
  by S3/S4; extending now is dead code against a guessed contract.
  Deferred with an explicit trigger (§3).
- **Fold designer into the dashboard Tier-1 set now.** Rejected — the
  Tier-1 set is an ADR-0040 §6 decision orthogonal to the projection
  enum (founder proves it: in Tier-1 today while still an unsupported
  kind). Bundling it here would smuggle an observability-scope change
  into an enablement ADR; deferred behind a demand trigger (§3).
- **Unify all runtime persona lists into one shared registry.** The
  scatter is real — `VALID_WORKFLOW_KINDS`, `DASHBOARD_PERSONAS`,
  doctor's ledger set, `PLUGIN_NAMES`, attention's `SENSOR_PERSONAS`
  each hardcode a different set — and a single registry looks like the
  standards-axis fix. Rejected: the sets differ **by decision, not by
  drift** (each was scoped by its own ADR: 0031/0039, 0040 §6, doctor's
  contract, 0042 RT), and attention lives in a different release-please
  package, so a shared constant would either cross the ADR-0010 §5
  import boundary or decay into more copies. A registry would flatten
  five deliberately different scoping decisions into one constant and
  make every future persona addition implicitly global. §3's vocabulary
  fix (name which list you mean) addresses the actual confusion at zero
  structural cost.
- **Set the footer floor to the current runtime (0.78.1).** Rejected —
  a 0.78.1 runtime rejects `workflow_kind: founder/designer`, so the
  floor would admit runtimes that render the degradation text instead
  of the footer: a confusing half-working state where fail-closed
  silence is the designed behavior (§4).
