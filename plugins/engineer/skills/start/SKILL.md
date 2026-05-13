---
name: start
description: "Sequences the engineer single-deliverable lifecycle macro — Phase 0 continuity through Phase 7 commit — by chaining the six canonical verb skills (investigate / frame / decide / compose / critique / refine) with user-approval gates at brainstorm (Phase 1) and plan (Phase 3). Use when the user wants to take a single feature from idea to commit on the current branch in one pass. Trigger phrases include 'start feature', 'kick off feature', 'do this end-to-end', '기능 시작', '엔드 투 엔드로'. Single-pass only — for multi-deliverable features use `/orchestrator:plan` instead (ADR-0020 §Sub-decision 6)."
---

# Start (engineer persona, lifecycle macro)

The `start` macro is the engineer plugin's **single-deliverable
lifecycle macro skill** — a *macro skill* per ADR-0010 §3 cascade
(ADR-0021), and a *lifecycle macro command* on the Claude side per
ADR-0020 §Sub-decision 1. It sequences the canonical single-
deliverable lifecycle — Phase 0 continuity → Phase 1 brainstorm →
Phase 2 explore → Phase 3 plan-verify → Phase 4 implement → Phase 5
review → Phase 6 resolve → Phase 7 commit — through the six engineer
verb skills (`investigate / frame / decide / compose / critique /
refine` per ADR-0010 §3).

**Intra-document execution model**: this runbook executes the verb
skills' command-invoked semantics **in-place**. It does NOT invoke
the verb skills' commands recursively (recursive slash/skill dispatch
is not supported on either host's runtime). At each phase boundary
the orchestrator updates the workflow's `verb` field to the active
phase's primary cognitive activity (ADR-0020 §Sub-decision 5), keeping
SessionStart re-injection metadata current.

For multi-deliverable features use `/orchestrator:plan` (Claude) or
the orchestrator persona's equivalent on Codex (ADR-0020 §Sub-decision
6 — manual escalation; no automatic cross-plugin routing). `start` is
single-pass only.

---

## When invoked by command (`/engineer:start` Claude command or `$engineer:start` Codex skill mention)

Phase 0 host-side bootstrap (argument parsing, detached-HEAD guard,
redundancy probe, active-workflow branching) is owned by the entry
path: `commands/start.md` on the Claude side carries the canonical
bash. Direct `$engineer:start` invocation on Codex follows the
equivalent operational sequence inline using the same engineer
`scripts/state.mjs` CLI (the state writer is host-agnostic).

State writes at each phase boundary (`state.mjs append --verb …`)
are an orchestrator concern, not a skill concern — see
`skills/_shared/references/ensemble-protocol.md` § State Bookkeeping
and `skills/_shared/references/orchestration.md` for the canonical
state-write pattern shared with the verb skills.

### Phase 1 — Brainstorm composite (investigate → frame → decide)

Per ADR-0020 §Sub-decision 2, Phase 1 is a **composite** of three
verb skills. Execute each sub-phase's verb skill in-place by reading
its SKILL.md "When invoked by command" mode and applying its
presentation + ensemble protocol within this runbook context.

- **Sub-phase 1a — Investigate** (option generation): execute
  `skills/investigate/SKILL.md` to surface candidate directions and
  gather supporting evidence. Use `--profile=analysis` for codebase-
  grounded option discovery, or `--profile=cited-brief` when the
  decision needs external citations (ADR-0014).
- **Sub-phase 1b — Frame** (5-perspective model): execute
  `skills/frame/SKILL.md` to structure the option space across the
  five canonical perspectives.
- **Sub-phase 1c — Decide** (recommend + user approval): execute
  `skills/decide/SKILL.md` to converge on a single direction and
  surface it to the user for approval.

Rotate the workflow's `verb` field at each sub-phase entry so
SessionStart re-injection and audit tooling see the active cognitive
activity. The Codex `brainstorm` ensemble dispatch follows the
always-max policy (ADR-0020 §Sub-decision 3) — never ask whether to
invoke the peer; the verb skills' own ensemble protocol handles
launch-and-collect automatically.

**Do not proceed to Phase 2 until the user approves a direction.**

### Phase 2 — Explore codebase (investigate --profile=analysis)

Map the current codebase state and integration points affected by the
chosen direction. Execute `skills/investigate/SKILL.md` command-
invoked semantics with `--profile=analysis`. The Codex `explore`
ensemble runs in parallel per ADR-0020 §Sub-decision 3 (Independence
Rule honored — local + peer build independent maps before synthesis).

### Phase 3 — Plan-verify (compose --profile=plan + critique)

Execute `skills/compose/SKILL.md` with `--profile=plan` to produce
the plan artifact, then `skills/critique/SKILL.md` to verify
completeness and feasibility.

Codex `plan-verify` ensemble runs at this phase boundary; this is
the documented **Independence Rule exception** (ADR-0020 §Sub-decision
3) — Codex receives Claude's draft plan rather than building an
independent plan from scratch, because re-deriving the plan would
waste tokens and surface false-disagreements on incidental choices.

**Multi-deliverable detection prompt** (ADR-0020 §Sub-decision 6): if
the plan groups into 2+ independently completable deliverables,
surface this to the user — *"This feature reads as multi-deliverable.
`engineer:start` is single-pass only. Consider aborting and restarting
with `/orchestrator:plan` (Claude) or the orchestrator persona's
equivalent."* The user may abort or proceed in single-pass.

**Do not proceed to Phase 4 until the user approves the plan.**

### Phase 4 — Implement (compose --profile=code)

Execute `skills/compose/SKILL.md` with `--profile=code`. RED-GREEN-
REFACTOR per planned task — write a failing test first, implement
minimally to pass, then clean up while keeping tests green. In
projects without a test framework, skip the cycle, implement
directly, and verify each task manually (inform the user about the
absent framework).

Mid-task brainstorm dispatch is allowed when ambiguity surfaces
(ADR-0020 §Sub-decision 3 — mid-task brainstorm only, not at phase
boundary). For genuine design forks discovered during implementation,
follow Phase 1's brainstorm composite and re-converge before
resuming.

### Phase 5 — Review (critique --profile=parallel-review)

Execute `skills/critique/SKILL.md` with `--profile=parallel-review`
for multi-perspective code review across the diff. The Codex `review
--scope working-tree` ensemble runs in parallel per ADR-0020 §Sub-
decision 3 — the two reviews catch complementary findings (per-file
correctness vs runbook system patterns) per the doctrine established
in PR-E.

### Phase 6 — Resolve (refine)

Execute `skills/refine/SKILL.md` to address Phase 5 findings.
Iterate refine + Codex re-review (fresh `run_id` each pass) until
the diff converges. If the same finding recurs across two resolve
loops, surface to the user as a design-level issue and discuss
whether to address now or defer to a separate `/engineer:refine`
follow-up workflow.

### Phase 7 — Commit

Terminal runbook: create the commit (and an optional PR if the
user requests one). Phase 7 itself has no cognitive verb update —
`refine` is the last cognitive activity recorded. The orchestrator
writes the workflow's terminal state per
`skills/_shared/references/orchestration.md` § Terminal write, which
flips the workflow into the auto-archive whitelist for the next
Stop hook pass (ADR-0017 §sub-decision-5).

The Stop hook gates auto-archive on four conditions (A1–A4):
terminal marker, terminal phase, HEAD movement (real commit progress),
and no active children. When all four hold, the workflow archives
without manual cleanup.

Append the runtime completion footer after the commit summary and workflow
path. The footer is advisory and pointer-only: include context state,
workflow id/path, artifact pointers, recommended next work, and
next-session action/command or prompt pointer, but do not mutate host
session context or paste raw peer / consensus output into the main
session.
When the deliverable boundary is reached, include PR handling readiness
fields in the footer. Ask the user what to do with PR handling only when
the helper returns `pr_handling.recommendation == "ask-user"`; `defer`
means evidence is incomplete, and `block` means a readiness criterion
failed.

---

## Anti-patterns (do not produce)

- Skipping the Phase 1 brainstorm composite or the Phase 3 user-
  approval gate. The composite + approval is what distinguishes
  `start` from a bare `compose --profile=plan`; auto-proceeding past
  either gate is a protocol violation.
- Silent multi-deliverable splitting. When Phase 3 surfaces the
  Multi-deliverable Detection Prompt, the user — not the runbook —
  decides whether to abort and restart with `/orchestrator:plan`.

The remaining structural invariants (no 7th verb, no recursive
slash/skill dispatch, branch=workflow anchor) are policy concerns
codified in ADR-0010 §2 / ADR-0020 §Sub-decision 1 / ADR-0018 §sub-2,
not runbook decisions — they hold for the whole engineer persona,
not just `start`.

---

## Notes

- ADR-0020 §Sub-decision 1 — `start` is a **lifecycle macro**, not a
  7th canonical verb; the six-verb enum is unchanged.
- ADR-0021 — this SKILL.md is the Codex-side parity mirror for the
  `/engineer:start` command (ADR-0010 §3 macro-skill category
  amendment formalizes the structural rule).
- ADR-0018 §sub-2 — branch=workflow invariant; `start` cannot run
  from detached HEAD.
- ADR-0019 — `start` is engineer-internal verb sequencing and does
  NOT transit cross-plugin boundaries; `parent_workflow` is unset
  for direct invocation.
- ADR-0017 §sub-decision-5 — Stop hook auto-archive gates evaluate
  `terminal_marker`, terminal phase, HEAD movement, and no-active-
  children transparently. `workflow_type` is read transparently and
  does NOT affect gate logic.
