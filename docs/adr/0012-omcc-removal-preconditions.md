# ADR-0012: omcc + codex-plugin-cc removal preconditions

## Status

Accepted

## Context

[ADR-0005](0005-separate-repo-from-omcc.md) establishes agentic-plugins
as the successor to omcc. [ADR-0007](0007-migration-cutover-plan.md)
defines the cutover plan and omcc archive procedure. Neither, however,
specifies *when* it becomes safe to remove the legacy plugin
dependencies that the agentic-plugins development workflow currently
sits on top of. This ADR closes that gap.

Two such dependencies exist as of 2026-05-06:

1. **omcc** (`omcc-dev` workflow plugin + `omcc-research` + `omcc-designer`)
   — the existing dev workflow surface that agentic-plugins itself uses
   to develop agentic-plugins (this conversation's `/omcc-dev:resume`
   is one example).
2. **codex-plugin-cc** — an external Claude Code plugin that some omcc
   workflows historically delegated to for Codex CLI integration.
   agentic-plugins explicitly forbids dependence on `codex-plugin-cc`
   and ships its own first-party companions
   ([ADR-0004](0004-companion-ownership.md)).

During Stage 2 deliverable E (validation + dogfood), an early candidate
plan was to uninstall both immediately upon Stage 2 exit. The user
rejected this and articulated a precise four-condition rubric for when
removal is appropriate. This ADR is that rubric, captured as a
durable decision record.

The relation to ADR-0007: ADR-0007 covers the *full* cutover (omcc
archive procedure, communication, etc.). This ADR covers the *earlier*
question — at what point have the agentic-plugins-side capabilities
matured enough that the legacy dependencies are no longer load-bearing.
ADR-0007's cutover step is *enabled* by satisfaction of this ADR, not
the other way around.

## Decision

### Removal trigger

Removing omcc + codex-plugin-cc (uninstall on the user's machine, plus
elimination of any references in agentic-plugins' development docs,
scripts, hooks, or test harnesses) shall proceed **only when all four
preconditions below are satisfied**. The earliest such moment is
expected to be at Stage 3 exit or in the cushion period that follows it,
after a deliberate evaluation of all four conditions.

### Four preconditions

1. **engineer has reached omcc-dev parity.** `plugins/engineer` is at
   least as capable, stable, and ergonomic as omcc-dev in the
   capabilities agentic-plugins development actually uses: workflow
   creation/append/snapshot/read, lock ownership protocol (atomic
   rename-based stale reclaim, ownership-token verify on atomic write),
   secret scrubbing, frontmatter validation (schema closed), continuity
   hooks (Claude PreCompact + Stop + SessionStart, Codex Stop helper),
   ensemble dispatch (always-max bidirectional). Stage 2 exit
   establishes this *partially*; sustained dogfood across Stage 3 work
   completes it.

2. **engineer guarantees bidirectional companion round-trip.** Both
   `claude→codex(agentic-plugins)` *and* `codex→claude(agentic-plugins)`
   round-trips are demonstrated end-to-end through engineer's
   `dispatch-peer.mjs`. Stage 1's `plugins/research` round-trip evidence
   does *not* satisfy condition 2 by itself: engineer adds non-trivial
   new code (`scripts/state.mjs`, `scripts/dispatch-peer.mjs`, four
   adapter hooks) on the path between SKILL invocation and the
   companion call, so the bidirectional guarantee must be re-established
   on engineer's actual code path.

3. **engineer alone is sufficient for agentic-plugins' continued
   development.** "Sufficient" means the user can advance, extend, and
   refine agentic-plugins (writing new plugins, evolving existing ones,
   handling regressions, performing audits, brainstorming
   architectural changes) using engineer commands without ever falling
   back to omcc-dev. Stage 2 deliverable E provides the first dogfood
   datapoint; Stage 3 (designer plugin) supplies the accumulated
   evidence — multiple non-trivial workflows completed end-to-end on
   engineer with no omcc-dev escape hatch.

4. **agentic-plugins' development scaffolding is self-contained.**
   The development guidance (`AGENTS.md`, `CLAUDE.md`), tooling
   (`scripts/`, `kit/`, `companions/`), environment (CI workflows under
   `.github/workflows/`, `release-please`, `package.json` scripts), and
   management strategy (ADR process, branching policy, Conventional
   Commits, `test:plugin-shape`, `lint:plugin-shape`) all operate
   without reference to omcc plugins or codex-plugin-cc paths.
   Itemised satisfaction of this condition is tracked in DEVELOPMENT.md
   rather than amended into this ADR — see "Progress tracking" below.

### Progress tracking layer

This ADR records the *decision and rubric* (immutable). The *progress*
toward each condition is tracked in `docs/DEVELOPMENT.md` (mutable —
updated as Stages exit). Concretely, the Stage 2 exit evidence section
shall cite this ADR, classify which conditions are partially or fully
satisfied at Stage 2 exit, and note which conditions remain outstanding
for Stage 3 + cushion to address. Subsequent stages mirror that
pattern.

## Consequences

**Positive**:

- Stage 2 exit no longer implicitly promises removal. The user's
  conservative four-condition stance is preserved as a durable record
  rather than as a single conversational turn.
- Future stage-transition decisions have a cited rubric. "Are we ready
  to remove omcc?" becomes a tractable evaluation against four
  conditions, not a judgment call.
- ADR-0007's cutover plan now has a clear precondition: cutover may
  proceed once this ADR's four conditions are met.
- Conditions (2) and (3) reframe Stage 2 deliverable E's dogfood scope:
  bidirectional dogfood is required (not just Claude direction), and
  Stage 2's single dogfood session is recognised as a *partial* —
  not complete — satisfaction of condition (3).

**Negative**:

- omcc and codex-plugin-cc remain installed on the user's machine until
  Stage 3 exit (or its cushion). The development environment carries a
  documented but not yet shed dependency for an additional stage.
- Conditions (3) and (4) involve judgment-call evaluation rather than a
  hard metric. Future reviewers may interpret "sufficient" or
  "self-contained" differently. Mitigation: DEVELOPMENT.md progress
  matrix explicitly lists which sub-items have been verified.
- Condition (4) implicitly invites a Stage 2.5+ ADR follow-up if the
  itemised checklist proves to need its own first-class decision
  surface (e.g., a list of dev-infra items each with explicit
  pass/fail).

**Neutral**:

- Cluster-3 ground rules in the Stage 2 deliverable E plan target
  bidirectional dogfood as the canonical condition (2) evidence path.
  At Stage 2 exit only the Claude direction is established (D Phase 5
  `dispatch-peer` parallel-review on engineer's own code path). The
  Codex direction is deferred — Codex CLI 0.128.0 plugin commands
  schema absence blocks the engineer-side auto-trigger for
  `dispatch-peer.mjs`, recorded as a Stage 2.5+ ADR-0013 candidate in
  `docs/DEVELOPMENT.md` "Stage 2 exit evidence" subsection.
- Responsibility split between ADR-0007 and ADR-0012 is now explicit:
  0007 owns the cutover plan (archive, communication, switch
  procedure); 0012 owns the precondition rubric that gates entry into
  0007's cutover step.

## Alternatives Considered

### A. Remove immediately at Stage 2 exit

This was the initial candidate before the user articulated the
four-condition rubric. Rejected because conditions (3) and (4) cannot
be established at Stage 2 exit by construction: condition (3) requires
*accumulated* dogfood across multiple non-trivial workflows (Stage 3
work), and condition (4) requires an evaluation of dev-infra items
that have not yet been audited against the omcc-dependency lens.
Removing at Stage 2 exit would leave a meaningful chance of regression
that forces a re-install, which would itself contaminate the
"engineer is sufficient" evidence claim.

### B. Record the four conditions in DEVELOPMENT.md only

Considered as a lighter-weight alternative. Rejected because the
four-condition rubric is a *decision* — "removal proceeds when these
hold, and not before" — and decisions are the responsibility of ADRs in
this project. DEVELOPMENT.md tracks *progress*; ADRs record
*resolutions*. Putting both in DEVELOPMENT.md would conflate the two
and weaken the durability of the rubric (future edits to
DEVELOPMENT.md could quietly rewrite preconditions; ADR amendments are
visible in git history with a Status change).

### C. Fold the four conditions into ADR-0007

Considered. Rejected because ADR-0007 already covers a substantial
scope (the cutover and archive procedure). Splicing the precondition
rubric in would (i) blur the distinction between "what triggers
cutover" and "what cutover entails," (ii) make ADR-0007's status
harder to manage (precondition can be Proposed while cutover plan is
Accepted), and (iii) force any future revision of the rubric to ripple
into the cutover plan. A separate ADR keeps both decisions
independently amendable.

### D. Defer the decision

Considered. Rejected because the user explicitly enumerated the four
conditions in conversation, and that articulation has lasting value
beyond the current Stage. Deferring the record risks losing the precise
phrasing or the underlying intent. Capturing the rubric immediately
preserves the user's resolved stance even before any of the conditions
are individually evaluated.
