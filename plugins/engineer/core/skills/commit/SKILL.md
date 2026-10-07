---
name: commit
description: "Commits the change a verb-chain engineer workflow produced, or closes the workflow without a commit when the last verb said the work needs none — the engineer plugin's commit meta skill (ADR-0063 D3, over the ADR-0028 Phase 7 driver). A workflow-continuity meta operation, not a cognitive verb and not a lifecycle macro. Use after /engineer:compose or /engineer:refine (or another verb) recorded next_step commit or done. Trigger phrases include 'commit this workflow', 'commit the change', 'close without a commit', '커밋', '작업 커밋', '변경 없이 닫기'. /engineer:start workflows keep their own Phase 7."
---

# Commit (engineer persona, meta skill)

The `commit` meta skill ends a **verb-chain** workflow — one built with the
six verbs rather than `/engineer:start` — in one of two ways
([ADR-0063](../../../../../docs/adr/0063-autopilot-fresh-session-driver.md) D3):

- **commit**: the staging set is the workflow's `commit_manifest`
  intersected with the changes, split per release-please package
  ([ADR-0016](../../../../../docs/adr/0016-cross-package-commit-splitting.md)),
  committed with conventional subjects, then the post-commit gates, the note
  to a parent macro (P10) and `set-terminal commit-complete` — the
  [ADR-0028](../../../../../docs/adr/0028-engineer-phase7-commit-automation.md)
  §Layer-3 driver `scripts/phase7-commit.mjs`, unchanged;
- **no-changes close**: the last verb recorded `next_step_kind: done`,
  nothing was committed since the workflow began, and nothing is left to
  commit. The workflow is written `close-complete` with the terminal marker
  and archived, with no commit.

Neither completes a macro subtask. A committed subtask stays in progress
until its pull request merges and `/orchestrator:done` records the merge
commit ([ADR-0062](../../../../../docs/adr/0062-subtask-completion-recorded-at-landing.md));
a closed one is recorded with `/orchestrator:done <subtask> --no-commit` and a
reason.

It is a **meta skill** per [ADR-0022](../../../../../docs/adr/0022-engineer-meta-skill-category.md)
(ADR-0010 §3 cascade): no cognitive activity, no phase sequencing, and no
workflow bootstrap. It needs an active verb-chain workflow on the current
branch and refuses an `/engineer:start` workflow, whose Phase 7 commits it.

---

## Host availability

<!-- pipeline:begin commit-host-availability -->
| Operation | Claude | Codex |
|-----------|--------|-------|
| `phase7-commit.mjs --mode plan` / `execute` / `close` | `--host claude` | `--host codex` — the same driver and on-disk state; the host flag records write provenance and spells the `/orchestrator:done` pointer (`$orchestrator:done` on Codex) |
| `state.mjs autopilot-preflight` (mode + pending owner gate) | Yes | Yes — reports a pending gate the same way; there is no autopilot run on Codex, so it never prints the banner there |
| `phase7-commit.mjs --mode autopilot` (the whole step, decided in code) | Yes, only under an autopilot run (`AGENTIC_AUTOPILOT`) | No — autopilot mode is Claude-only (ADR-0063 D9); ignore it on Codex |
| Stop-hook archive after a commit | Yes — at the end of the committing turn when every gate passes | Once the plugin hooks are enabled and `/hooks`-trusted; otherwise `$engineer:resume` archives by hand |
<!-- pipeline:end commit-host-availability -->

---

## Claude/Codex command resolution

<!-- pipeline:begin commit-command-resolution -->
| Concern | Claude | Codex |
|---------|--------|-------|
| Plugin root | Each shell block of the Claude command sets `$CLAUDE_PLUGIN_ROOT` first: from `AGENTIC_ENGINEER_ROOT` when set, else from the plugin path Claude Code writes into the command body when it loads it, else from the newest release (`X.Y.Z`) under `~/.claude/plugins/cache/agentic-plugins/engineer/` | For a mentioned `engineer` skill, the plugin directory that contains it (inside `$engineer:start`, the mentioned skill is `start`, which runs the six verb skills in place): Codex injects a mentioned skill with its absolute path (`<path>…/core/skills/<skill>/SKILL.md</path>`), and dropping `/core/skills/<skill>/SKILL.md` from it leaves the root, which holds `.codex-plugin/plugin.json`. If that path is no longer in context, for example after compaction, a new mention of the skill supplies it again. With the default Codex home and the `agentic-plugins` marketplace added from Git, the root is `~/.codex/plugins/cache/agentic-plugins/engineer/<version>`, the versioned copy Codex loads skills from, and `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/engineer` is the marketplace checkout, which tracks the repository's `main` branch, not that copy. |
| Entry path | `/engineer:commit` | `$engineer:commit` — this SKILL.md is the runbook |
| `--host` | `claude` | `codex` |

Every block below is the Claude command's block, with `<plugin-root>` for the
plugin root and `<claude|codex>` for the host, and resolves the workflow
again: a shell variable does not outlive a Bash call.
<!-- pipeline:end commit-command-resolution -->

---

## Phase 0 — Resolve the workflow and the mode

<!-- pipeline:begin commit-phase-0 -->
```bash
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
GIT_BRANCH="$(git branch --show-current)"
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — ${PERSONA} workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  exit 1
fi
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
if [ -z "$ACTIVE" ]; then
  echo "✗ No active ${PERSONA} workflow on $GIT_BRANCH — nothing for /${PERSONA}:commit to commit or close." >&2
  exit 1
fi
# The read is checked on its own: a read that fails stops the block, whatever
# it printed, before the type is parsed.
WF_JSON="$(node "<plugin-root>/scripts/state.mjs" read --workflow-path "$ACTIVE")" || exit $?
WORKFLOW_TYPE="$(printf '%s' "$WF_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).workflow_type||"verb-chain")}catch{process.exit(1)}})')" || exit 1
if [ "$WORKFLOW_TYPE" = "start" ]; then
  echo "✗ $ACTIVE is an /${PERSONA}:start workflow; its own Phase 7 commits it — continue it with /${PERSONA}:start." >&2
  exit 1
fi
# ADR-0063 D4 — prints nothing in interactive mode; this command's autopilot
# rules under an autopilot run; exits 1 under autopilot when an owner gate is
# set; prints a pending gate for the owner otherwise.
node "<plugin-root>/scripts/state.mjs" autopilot-preflight \
  --workflow-path "$ACTIVE" --host <claude|codex> --surface commit || exit $?
echo "Workflow: $ACTIVE"
```

- The block stops, with the reason, on a detached HEAD, on a branch with no
  active workflow, and on a `/engineer:start` workflow (`workflow_type:
  start`), whose own Phase 7 commits it; a workflow it cannot read stops it
  too.
- The preflight printed the **autopilot banner** (Claude only) → run
  `phase7-commit.mjs --mode autopilot` and report its `action`; that is the
  whole step. It commits only when the staging set is fully implied, the
  workflow began on a clean tree and nothing is pre-staged; otherwise it
  stops at the `staging-set` owner gate.
- It printed a pending **`staging-set`** gate → the owner has to confirm
  the staging set an autopilot run stopped on.
  Continue with Phase 1 and clear the gate in Phase 2 once they do.
- It printed **any other** pending gate → stop and put it to the user; that
  gate is resolved by the surface the notice names. Execute and close refuse
  while any owner gate is set.
<!-- pipeline:end commit-phase-0 -->

---

## Phase 1 — Plan

<!-- pipeline:begin commit-plan -->
```bash
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
node "<plugin-root>/scripts/phase7-commit.mjs" --mode plan \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host <claude|codex>
```

The plan is informational: execute and close re-derive everything.

- **`branch: no-changes`** — `no_changes.path` says what a clean tree means
  here. The same classifier runs in execute and close, so it is what they
  will do:
  - `recovery`: commits carrying this workflow's `Workflow-ID:` trailer
    landed and cover the manifest, but the run that made them stopped before
    its terminal write. Phase 2 finishes it with no subject.
  - `close`: nothing was committed since the workflow began, and the last
    verb recorded `next_step_kind: done`. Confirm with the user
    ("Recommended: close without a commit. Proceed?"), then Phase 3.
  - `blocked`, with `no_changes.reason`:
    - `partial-commit` — marked commits that do not cover the manifest;
    - `unmarked-commits` — HEAD moved with no marked commit;
    - `next-step-not-done` — nothing moved, but the last verb did not say
      the work needs no commit;
    - `no-baseline` — HEAD or the baseline could not be read;
    - `git-probe-failed` / `status-not-clean` — `git status` failed, or
      still reports a change the change list does not (a staged change the
      working tree reverted): a clean tree is proven, not inferred;
    - `start-workflow` — a `/engineer:start` workflow is never closed here.

    Report it and stop; nothing is written. A close never follows a commit
    of this workflow's, and a recovery never follows an empty history.
- **Otherwise** present the staging set and each
  `commits[].suggested_subject` for accept / edit / cancel, as
  `/engineer:start` Phase 7 does:
  - `ask_user: true` → also confirm the staging set: the intersection only
    (default), specific `extras` opted in, or the whole working tree.
  - `requires_split: true` → the change spans release-please packages, so it
    becomes one commit per package (ADR-0016). A split needs one subject per
    commit; `--subject` is refused.
<!-- pipeline:end commit-plan -->

---

## Phase 2 — Commit

<!-- pipeline:begin commit-staging-clear -->
If a `staging-set` gate was pending and the user has confirmed the set:

```bash
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
node "<plugin-root>/scripts/state.mjs" awaiting-owner-clear \
  --workflow-path "$ACTIVE" --host <claude|codex> --gate staging-set \
  --next-action "Commit the confirmed staging set with /${PERSONA}:commit" \
  --next-step-kind commit --next-step-confidence HIGH || exit $?
```

The clear records the owner's resolution with the next step `commit` and its
next action in the same write, so a commit that fails afterwards leaves
neither the `owner-decision` the gate had recorded nor the gate's
`Owner: confirm the staging set …` next action.
<!-- pipeline:end commit-staging-clear -->

<!-- pipeline:begin commit-execute -->
Then:

```bash
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# Subjects, one of:
#   --suggested-subjects                   the user accepted every suggestion (single or split);
#   --subject '<confirmed subject>'        one commit, edited;
#   --subject-pkg '<package>=<subject>'    repeated, one per commit of a split
#                                          (the docs commit's key is `docs`).
# Staging, only when the plan had ask_user=true and the user confirmed the set:
#   --confirm-non-interactive, plus --include-extra <path> per extra they opted
#   in, or --accept-current-tree to take every change.
# A recovery (no_changes.path=recovery) needs no subject flag.
node "<plugin-root>/scripts/phase7-commit.mjs" --mode execute \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host <claude|codex> \
  --suggested-subjects
```

- Subject flags: `--suggested-subjects` when the user accepted every
  suggestion; otherwise `--subject '<text>'` for one commit, or
  `--subject-pkg '<package>=<text>'` once per commit of a split (the docs
  commit's key is `docs`). A recovery needs none.
- Staging flags, only when the plan had `ask_user: true` and the user
  confirmed: `--confirm-non-interactive`, plus `--include-extra <path>` per
  opted-in extra or `--accept-current-tree`.

Before the first commit the driver takes the workflow out of its terminal
state (`phase-7-commit`, no marker), so a split that fails halfway is never
archived by a Stop hook that sees HEAD moved. On success it has
sent the parent note and
written `set-terminal commit-complete` last. On failure it printed what
landed and what did not; the workflow stays active, and running this skill
again resumes: a rerun plans only what is left, and a clean tree whose
commits all landed is the `recovery` path.

ARCHIVE TIMING — decide before running execute. On Claude the Stop hook fires
at **every turn end**, so a successful commit's terminal write is evaluated
by the archive gates at the end of that turn, not at session close. Clearing
the marker with `--terminal-marker false` works only before that Stop fires
and needs set-terminal's full flag set. On Codex the Stop hook runs only once
the operator has trusted the plugin hooks (`/hooks`); until then archive the
committed workflow with `$engineer:resume`. The close path archives the
workflow itself. Full contract:
`../_shared/references/session-handoff.md` § Archive timing.
<!-- pipeline:end commit-execute -->

---

## Phase 3 — Close without a commit

<!-- pipeline:begin commit-close -->
```bash
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# Re-checks everything: git status clean (index, working tree, untracked),
# nothing committed since the workflow began, next_step_kind done, not a
# /start workflow, no owner gate or pending ensemble. Writes close-complete
# with the terminal marker, then archives the workflow (its HEAD never moved,
# so the Stop hook would not). A close stopped between the two is finished by
# running it again.
node "<plugin-root>/scripts/phase7-commit.mjs" --mode close \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host <claude|codex>
```

It re-checks the close (`git status` clean, nothing committed,
`next_step_kind: done`, not a start workflow, no owner gate or pending
ensemble), writes `close-complete` with the terminal marker, and archives the
workflow: its HEAD never moved, so the Stop hook would not. It prints no
session-handoff footer, whose projection would read the unmoved HEAD as a
blocked archive. A close stopped between its two writes is finished by
running it again.
The Stop hook never notes a `close-complete` workflow on a parent macro,
because it made no commit. For a macro subtask its output names the next step,
`/orchestrator:done <subtask> --no-commit`, which needs a reason.
<!-- pipeline:end commit-close -->

---

## Completion outcomes

- `✓ Committed.` + each landed `<sha> <subject>`.
- `✓ Closed without a commit.` + the archived path.
- `⏸ The staging set needs the owner.` — autopilot recorded the
  `staging-set` gate (Claude only).
- `✗ Nothing to commit, and the workflow cannot close (<reason>).` — or the
  driver's failure message.

Then the Active Next-Action Proposal, per
`../_shared/references/entry-routing-contract.md` § Active Next-Action
Proposal:

```
- selected_next:         <owner decision | verb>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: the landing action, $orchestrator:done / /orchestrator:done …, or a verb>
```

After a commit the next step is the owner's landing — push, open and merge
the pull request — then `/orchestrator:done <subtask>` for a macro subtask.
That is routine, not an owner gate: nothing records `pr-handling` for it.

---

## Anti-patterns

- **Committing with plain `git commit`.** It bypasses the manifest staging,
  the per-package split and the `Workflow-ID` trailer that recovery depends
  on.
- **Closing a workflow whose commits have not landed.** A close is only for
  work that produced no commit; `blocked/unmarked-commits` and
  `blocked/partial-commit` exist so it cannot be mistaken for one.
- **Passing a confirm flag the user did not give.** Under an autopilot run
  every bypass flag is refused; interactively it would stage what the user
  never saw.
- **Using it for an `/engineer:start` workflow.** Its Phase 7 commits it.
