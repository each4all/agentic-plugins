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

`core/skills/_shared/references/entry-routing-contract.md` is the shared
operator-facing contract for routing and decision prompts. It keeps
Claude and Codex behavior equivalent by requiring the same outcome,
state, recovery path, and evidence even when command syntax differs.

---

## When invoked by command (`/engineer:start` Claude command or `$engineer:start` Codex skill mention)

<!-- pipeline:begin start-command-intro -->
Phase 0 host-side bootstrap (argument intake, detached-HEAD guard,
redundancy probe, clean-baseline gate, active-workflow branching) is owned by
the entry path:
`commands/start.md` carries the canonical bash on the Claude side, generated
from the shared start regions (ADR-0066). Direct `$engineer:start` on Codex
follows the same operational sequence inline, in this order, using the same
`scripts/state.mjs` CLI (the state writer is host-agnostic):

1. **Guard and find.** Refuse a detached HEAD (workflows are anchored to a
   branch), then `state.mjs find-active --repo-root <root>`, then
   `state.mjs autopilot-preflight --workflow-path <found> --host codex`
   before any write: it reports a pending owner gate and writes nothing.
2. **Active-workflow branching.** `workflow_type` `start` → resume:
   `state.mjs append --workflow-path <found> --host codex --clear-next-step
   true --event resumed`; put an owner gate step 1 reported to the user
   first (once it is resolved, clear it with the phase the lifecycle
   continues at and that phase's next action, the owner's decision and the
   action each a file written with the file-writing tool:
   `--resolution-file`, `--next-action-file`), then continue from its
   `current_phase`; no description is needed. Any other workflow
   (`verb-chain`, or a legacy one without the field) → typed conflict:
   refuse, writing nothing, its owner gate included — `start` must not
   absorb a single-verb workflow into lifecycle phase space. The user
   continues it with its `$engineer:<verb>`,
   commits it (`$engineer:commit`),
   archives it (`$engineer:resume`) or switches branch, then runs
   `$engineer:start` again. Either type: when the arguments are a new
   request that does not belong to the active workflow, nothing is written;
   the proposal selects a worktree first (ADR-0067 Decision 8, item 3) —
   write the arguments into an args file and run `scripts/discover-runtime.mjs
   worktree-plan --repo-root <root> --args-file <path> --host codex --format
   text`, which prints the runtime:worktree planner's `git worktree add`
   command for the request — and the ordinary resume stays the selection when
   the request belongs to the workflow.
3. **No active workflow.** The arguments are read from an args file, twice:
   first for the **redundancy probe** (`state.mjs diagnose-redundancy
   --repo-root <root> --base-branch <ref>`, informational — a failed probe
   never stops; a finding is put to the user for proceed or abort, and abort
   writes nothing), then, with a new args file, for the bootstrap: the
   **clean-baseline gate** below, then `state.mjs create --workflow-type
   start --verb investigate --persona engineer --original-request-file
   <the description's file>`: the description the extractor read, program
   data the block writes to a file (`printf '%s\n' "$FEATURE"`) in a
   directory from `mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`, so a
   description beginning with `--` is never read as a flag (ADR-0059,
   amendment of 2026-10-10).

Argument parsing is `scripts/start-args.mjs --args-file <path>` on both
hosts (ADR-0059 Decision 7). The description, with any
`--base-branch <ref>` in it, goes into an args file — never into a command
line, where an apostrophe aborts the line and `;` or `$(…)` cuts or runs it.
Write `{"agentic_args": 1, "text": "…"}` with the file-editing tool into a
directory from `mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`, then run
the extractor in the same shell as the steps that read `BASE_BRANCH` and
`FEATURE`. It removes the args file and its directory once it has read them,
so running it again needs a new args file:

```bash
ARGS_DIR='<directory mktemp printed>'
START_ARGS="$(node "<plugin-root>/scripts/start-args.mjs" --args-file "$ARGS_DIR/args.json")" || exit $?
printf '%s\n' "$START_ARGS"
BASE_BRANCH="$(printf '%s' "$START_ARGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).base_branch))')" || exit $?
# A command substitution drops trailing newlines; the sentinel keeps them.
FEATURE="$(printf '%s' "$START_ARGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).feature))'; printf x)"; FEATURE="${FEATURE%x}"
```

The **clean-baseline gate** (ADR-0028 §Layer-1) runs on the bootstrap branch
(when `find-active`
returns empty and a new workflow is about to be created) before `state.mjs
create`. It calls `state.mjs check-clean-baseline --repo-root <root>` (with
`--accept-current-tree true` once the user accepts the current tree, as
`ACCEPT_CURRENT_TREE=1` does in the command) and inspects the returned
`status` (`clean` / `dirty` / `accepted`). The gate fails closed: only an
explicit `clean` / `accepted` status proceeds; a non-zero check, a `dirty`
tree, or an unparseable status stops the bootstrap. On `dirty` the gate
refuses to bootstrap and selects a worktree first (ADR-0067 Decision 8,
item 3): with the arguments in a new args file, never on a command line
(`{"agentic_args": 1, "text": "…"}`, written with the file-editing tool into a
directory from `mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`; the reader
removes it), `scripts/discover-runtime.mjs worktree-plan --repo-root <root>
--args-file <path> --host codex --format text` prints the runtime:worktree
planner's `git worktree add -b <branch> <path> <base>` for the request,
from the `--base-branch <ref>` in it when there is one,
to run before the start again inside the new worktree, or why there is none
(no runtime with the planner, an existing branch, an occupied path, an
unresolved base). The resolutions here stay the rejected alternatives:

- **clean** — `git restore . ; git clean -fd` and re-run;
- **stash** — `git stash push --include-untracked`, re-run, then `git stash pop`;
- **accept-current-tree** — set `ACCEPT_CURRENT_TREE=1` before re-running.
  The workflow's commit will sweep whatever was in the tree; the user
  acknowledges this.

`.agentic-plugins/state/**` is excluded from the dirty check — workflow
storage is the persona's own bookkeeping and never counts. An accepted tree
is not remembered: Phase 7 stages all of `git_changes` rather than the
manifest intersection only when it is told again, so pass
`--accept-current-tree` to both of its modes (the plan too, so its preview
matches what execute commits).

**Inside the lifecycle** (both hosts, ADR-0066 PC2b): Phase 0 runs
`state.mjs autopilot-preflight` once, before any write, and a resumed start
workflow clears the next step it carried. Each phase's ensemble attempt is
settled from its run ledger (`peer-runner.mjs settle`) before the next phase,
a repeated phase under a new run id. No phase makes a verb's terminal write;
the lifecycle's one terminal write is the Phase 7 commit driver
(`phase7-commit.mjs` in execute mode, which writes `set-terminal` last).
An owner gate met in a
phase (a decide CONFLICT, a recurring finding) is recorded with
`state.mjs awaiting-owner-set`, which leaves the workflow open; the lifecycle
pauses, and continues at the next phase once the owner's decision clears it
(`state.mjs awaiting-owner-clear` with that phase as the next step and its
action as the next action).
<!-- pipeline:end start-command-intro -->

State writes at each phase boundary (`state.mjs append --verb …`)
are an orchestrator concern, not a skill concern — see
`core/skills/_shared/references/ensemble-protocol.md` § State Bookkeeping
and `core/skills/_shared/references/orchestration.md` for the canonical
state-write pattern shared with the verb skills.

### Entry routing recommendation (before Phase 1)

Before Phase 1, present an **Entry routing recommendation** (the routes, the
prompt shape and the quality-first defaults are defined in
`../_shared/references/entry-routing-contract.md` § Routing Recommendation
and the sections after it):

- continue with `/engineer:start` / `$engineer:start` for one coherent
  deliverable on the current branch;
- switch to `/orchestrator:plan` / `$orchestrator:plan` for 2+
  independently completable deliverables, PRs, branches, owners, or
  dependency edges;
- run `/runtime:worktree plan` / `$runtime:worktree` when isolation or
  parallelization is likely because the checkout is dirty, risky,
  long-running, or suitable for parallel branches;
- run `/runtime:doctor`, `/runtime:settings`, or `/runtime:context`
  when the task is runtime readiness, install/update, or handoff;
- use a single `/engineer:<verb>` / `$engineer:<verb>` when the user
  only needs investigate/frame/decide/compose/critique/refine without
  lifecycle state.

Every proceed/abort, direction approval, plan approval, and route-switch
prompt must include **Options**, **Tradeoffs**, **Risks**,
**Recommendation**, **Confidence**, **Evidence pointers**, and the
**Default next command**. Before recommending a quick implementation or
refinement path, state the standards/root-cause quality gate: source of
truth or standard, invariant or root cause, verification evidence, and
rollback/defer/escalation path.

When the recommended route is `engineer:decide`, also surface the
**decision size** per ADR-0027 §1.5: `--size=minor` → `compact`
4-axis preset with the `entry-routing-guarantee` hard-gate;
`--size=standard` → `default` 5-axis (backward-compatible);
`--size=major` → `nine-axis` 9-axis preset + auto-enabled
sensitivity. The full sizing taxonomy lives in the entry-routing
contract reference (§"Routing into `engineer:decide` — decision
sizing").

Apply the shared **Quality-first defaults** from the entry-routing contract:
optimize for `best-results-over-token-minimization`; use the documented
phase-boundary ensemble as default peer breadth; keep model/effort defaults at
host-native or explicit `runtime:settings` values without downshift for token saving;
and choose review depth from the workflow phase, including Phase 5
`parallel-review` plus re-review after refine until findings converge or a
design-level issue is surfaced. Treat budget, latency, model, effort, or peer
limits as user constraints and state the quality tradeoff before proceeding.

### Session-level handoff preflight (Phase 0, ADR-0031)

Before sequencing the Phase 1–7 lifecycle, surface the ADR-0031 session-level
continue-vs-fresh preflight per
`core/skills/_shared/references/session-handoff.md`: compute the engineer workflow
projection for the current branch and pass it — or, when no active workflow
exists, the standalone routing — to the runtime seam, so the Entry routing
recommendation above is sized by context-budget risk + archive-gate readiness.
On a detached HEAD the entry's guard (step 1 above) stops it before any write
(workflows are anchored to a branch); do not auto-recommend a fresh session.
This mirrors the `/engineer:start` command's Phase 0d preflight so
`$engineer:start` on Codex surfaces it identically.

### Phase 1 — Brainstorm composite (investigate → frame → decide)

Per ADR-0020 §Sub-decision 2, Phase 1 is a **composite** of three
verb skills. Execute each sub-phase's verb skill in-place by reading
its SKILL.md "When invoked by command" mode and applying its
presentation + ensemble protocol within this runbook context.

- **Sub-phase 1a — Investigate** (option generation): execute
  `core/skills/investigate/SKILL.md` to surface candidate directions and
  gather supporting evidence. Use `--profile=analysis` for codebase-
  grounded option discovery, or `--profile=cited-brief` when the
  decision needs external citations (ADR-0014).
- **Sub-phase 1b — Frame** (5-perspective model): execute
  `core/skills/frame/SKILL.md` to structure the option space across the
  five canonical perspectives.
- **Sub-phase 1c — Decide** (recommend + user approval): execute
  `core/skills/decide/SKILL.md` to converge on a single direction and
  surface it to the user for approval.

Rotate the workflow's `verb` field at each sub-phase entry so
SessionStart re-injection and audit tooling see the active cognitive
activity. The opposite-host `brainstorm` ensemble dispatch follows
the always-max policy (ADR-0020 §Sub-decision 3) — never ask whether
to invoke the peer; the verb skills' own ensemble protocol handles
launch-and-collect automatically.

**Do not proceed to Phase 2 until the user approves a direction.**

### Phase 2 — Explore codebase (investigate --profile=analysis)

Map the current codebase state and integration points affected by the
chosen direction. Execute `core/skills/investigate/SKILL.md` command-
invoked semantics with `--profile=analysis`. The opposite-host
`explore` ensemble runs in parallel per ADR-0020 §Sub-decision 3
(Independence Rule honored — local + peer build independent maps
before synthesis).

### Phase 3 — Plan-verify (compose --profile=plan + critique)

Execute `core/skills/compose/SKILL.md` with `--profile=plan` to produce
the plan artifact, then `core/skills/critique/SKILL.md` to verify
completeness and feasibility.

The opposite-host `plan-verify` ensemble runs at this phase boundary;
this is the documented **Independence Rule exception** (ADR-0020
§Sub-decision 3) — the peer receives the local draft plan rather than
building an independent plan from scratch, because re-deriving the
plan would waste tokens and surface false-disagreements on incidental
choices.

**Multi-deliverable detection prompt** (ADR-0020 §Sub-decision 6): if
the plan groups into 2+ independently completable deliverables,
surface this to the user — *"This feature reads as multi-deliverable.
`engineer:start` is single-pass only. Consider aborting and restarting
with `/orchestrator:plan` (Claude) or the orchestrator persona's
equivalent."* The user may abort or proceed in single-pass.

**Do not proceed to Phase 4 until the user approves the plan.**

### Phase 4 — Implement (compose --profile=code)

Execute `core/skills/compose/SKILL.md` with `--profile=code`. RED-GREEN-
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

Execute `core/skills/critique/SKILL.md` with `--profile=parallel-review`
for multi-perspective code review across the diff. The opposite-host
`review --scope working-tree` ensemble runs in parallel per ADR-0020
§Sub-decision 3 — the two reviews catch complementary findings
(per-file correctness vs runbook system patterns) per the doctrine
established in PR-E.

### Phase 6 — Resolve (refine)

Execute `core/skills/refine/SKILL.md` to address Phase 5 findings.
Iterate refine + peer re-review (fresh `run_id` each pass) until the
diff converges. If the same finding recurs across two resolve loops,
surface to the user as a design-level issue and discuss whether to
address now or defer to a separate `/engineer:refine` follow-up
workflow.

### Phase 7 — Commit (ADR-0028 §Layer-3)

Terminal runbook: invoke the host-shared `phase7-commit.mjs` driver to
compose, stage, commit, gate, and set-terminal in one atomic pass.
Phase 7 itself has no cognitive verb update — `refine` is the last
cognitive activity recorded.

The driver is invoked in two steps (the agent loop has no stdin to
prompt the user from inside Node, so the user-approval gate runs in
the agent dialog between the two CLI invocations):

1. `phase7-commit.mjs --mode plan --workflow-path "$ACTIVE" --repo-root
   "$REPO_ROOT" --host "$AGENTIC_HOST"` — driver reads the workflow's
   `commit_manifest`, computes `git_changes` (tracked + untracked
   minus workflow storage), intersects, classifies cross-package
   routes (ADR-0028 §P12), and emits a JSON plan with suggested
   subjects + ask-user signals. NO git mutations.
2. Codex (or Claude) presents the suggested subjects + staging set to
   the user; the user accepts / edits the subjects and confirms the
   set (especially when `ask_user=true` because the manifest is empty
   or a subset of `git_changes`). When the branch is
   `manifest-subset-of-git` with non-empty extras, the user picks ONE
   of three resolutions per ADR-0028 PR4 A4: (a) intersection only
   (default — no flag), (b) opt specific extras back in via repeated
   `--include-extra <path>` per chosen extras entry, or (c) sweep the
   entire working tree with `--accept-current-tree` (all-or-nothing).
3. `phase7-commit.mjs --mode execute --workflow-path "$ACTIVE"
   --repo-root "$REPO_ROOT" --host "$AGENTIC_HOST" --subject-file
   "$TEXT_DIR/subject.txt" --confirm-non-interactive` — the subject the
   user confirmed, written with the file-writing tool into a private
   `mktemp -d` directory, never on the command line (ADR-0059, amendment of
   2026-10-10), or `--suggested-subjects` for a suggestion taken as it
   stands. The driver stages with explicit pathspecs (`git add <paths>`,
   never `-A`), commits per package (P8 split via repeated
   `--subject-pkg-file <pkg>=<file>`), runs P11 / no-children /
   clean-after-commit / P10 synchronous `writebackParent` (for a macro
   subtask this notes the terminal commit on the macro; the subtask
   completes when `/orchestrator:done` records the merge, ADR-0062), and
   writes set-terminal LAST (P5 terminal-marker-last invariant). Per-path
   extras opt-in (option b above) is forwarded as repeated
   `--include-extra <path>`; each path MUST appear in the plan-mode
   extras list AND clear `assertSafePath` — invalid entries throw.

Layer 3 read-side defense: every `commit_manifest[*].path` is
re-validated via `assertSafePath` before each `git add` — a workflow
file hand-edited with an injected path is rejected at the driver
boundary even though the parser left the field permissive (ADR-0028
N1).

Hook failures (pre-commit, commit-msg, partial split) emit a
refine-fallback message on stderr and exit non-zero. The workflow
remains active (terminal_marker unset); recovery is via
`/engineer:refine "<failure>"` followed by a fresh `/engineer:start`
that resumes at Phase 7.

The Stop hook gates auto-archive on four conditions (A1–A4):
terminal marker, terminal phase, HEAD movement (real commit progress),
and no active children. When all four hold, the workflow archives
without manual cleanup.

When the deliverable boundary is reached, include PR handling readiness
fields in the footer. Ask the user what to do with PR handling only when
the helper returns `pr_handling.recommendation == "ask-user"`; `defer`
means evidence is incomplete, and `block` means a readiness criterion
failed.

<!-- pipeline:begin start-finish-commit -->
The lifecycle's one terminal write is the Phase 7 driver in execute mode
(`phase7-commit.mjs`): it commits, runs the post-commit gates and the P10
parent writeback, and writes `set-terminal` last; no `finish-verb` runs. The
driver writes the marker itself, so decide before running execute mode whether
the workflow may close in this turn (the archive timing below).

The runtime completion footer is **code-emitted** on that terminal write
(ADR-0039).
The write fires the session-handoff sidecar, which renders the runtime
`footer.mjs`, the ADR-0031 continue-vs-fresh session handoff included, on that
command's stderr. It is advisory and pointer-only, and never mutates host
session context. The workflow is then terminal, and the Stop hook archives it
once every archive gate passes; until then `/engineer:start` on this branch
finds it and resumes it, so start the next deliverable after the archive, or
on another branch. Do not hand-compose a second footer or hand-pass the
projection; surface the emitted one. On a detached HEAD the branch-based
preflight reports "no active branch context" and never recommends a fresh
session (ADR-0018 §sub-2); the path-targeted terminal sidecar renders the
footer as on a branch, its continue-vs-fresh advice included.
`$engineer:start` on Codex surfaces the footer as `/engineer:start`
does. Wiring: `core/skills/_shared/references/session-handoff.md`.

On Claude the Stop hook fires at **every turn end**, so that terminal write puts
the workflow in front of the archive gates at the end of **that same turn**, not
at session close — it archives then if every gate passes, and otherwise stays
marked for a later Stop to re-evaluate. Clearing the marker
(`--terminal-marker false`, with set-terminal's full flag set) works only before
that Stop fires and does not restore the previous phase. On Codex the hook runs
only once the operator has trusted the plugin hooks (`/hooks`), so evaluation
waits. Full contract: `core/skills/_shared/references/session-handoff.md`
§ Archive timing.
<!-- pipeline:end start-finish-commit -->

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
