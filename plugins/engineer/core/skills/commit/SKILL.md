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

| Operation | Claude | Codex |
|-----------|--------|-------|
| `phase7-commit.mjs --mode plan` / `execute` / `close` | `--host claude` | `--host codex` — the same driver and on-disk state; the host flag records write provenance and spells the `/orchestrator:done` pointer (`$orchestrator:done` on Codex) |
| `state.mjs autopilot-preflight` (mode + pending owner gate) | Yes | Yes — reports a pending gate the same way; there is no autopilot run on Codex, so it never prints the banner there |
| `phase7-commit.mjs --mode autopilot` (the whole step, decided in code) | Yes, only under an autopilot run (`AGENTIC_AUTOPILOT`) | No — autopilot mode is Claude-only (ADR-0063 D9); ignore it on Codex |
| Stop-hook archive after a commit | Yes — at the end of the committing turn when every gate passes | Once the plugin hooks are enabled and `/hooks`-trusted; otherwise `$engineer:resume` archives by hand |

---

## Claude/Codex command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Plugin root | Each shell block of the Claude command sets `$CLAUDE_PLUGIN_ROOT` first: from `AGENTIC_ENGINEER_ROOT` when set, else from the plugin path Claude Code writes into the command body when it loads it, else from the newest release (`X.Y.Z`) under `~/.claude/plugins/cache/agentic-plugins/engineer/` | For a mentioned `engineer` skill, the plugin directory that contains it (inside `$engineer:start`, the mentioned skill is `start`, which runs the six verb skills in place): Codex injects a mentioned skill with its absolute path (`<path>…/core/skills/<skill>/SKILL.md</path>`), and dropping `/core/skills/<skill>/SKILL.md` from it leaves the root, which holds `.codex-plugin/plugin.json`. If that path is no longer in context, for example after compaction, a new mention of the skill supplies it again. With the default Codex home and the `agentic-plugins` marketplace added from Git, the root is `~/.codex/plugins/cache/agentic-plugins/engineer/<version>`, the versioned copy Codex loads skills from, and `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/engineer` is the marketplace checkout, which tracks the repository's `main` branch, not that copy. |
| Entry path | `/engineer:commit` | `$engineer:commit` — this SKILL.md is the runbook |
| `--host` | `claude` | `codex` |

Every block below resolves the workflow again: a shell variable does not
outlive a Bash call.

---

## Phase 0 — Resolve the workflow and the mode

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch." >&2; exit 1; }
node "<plugin-root>/scripts/state.mjs" read --workflow-path "$ACTIVE"
node "<plugin-root>/scripts/state.mjs" autopilot-preflight \
  --workflow-path "$ACTIVE" --host <claude|codex> --surface commit || exit $?
```

- No active workflow, a detached HEAD, or `workflow_type: start` in the
  `read` output → stop with that reason.
- The preflight printed the **autopilot banner** (Claude only) → run
  `phase7-commit.mjs --mode autopilot` and report its `action`; that is the
  whole step. It commits only when the staging set is fully implied, the
  workflow began on a clean tree and nothing is pre-staged; otherwise it
  stops at the `staging-set` owner gate.
- It printed a pending **`staging-set`** gate → an autopilot run stopped on a
  staging set the owner has to confirm. Continue with Phase 1 and clear the
  gate in Phase 2 once they do.
- It printed **any other** pending gate → stop and put it to the user; that
  gate is resolved by the surface the notice names. Execute and close refuse
  while any owner gate is set.

---

## Phase 1 — Plan

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch." >&2; exit 1; }
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
    - `start-workflow` — an `/engineer:start` workflow is never closed here.

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

---

## Phase 2 — Commit

If a `staging-set` gate was pending and the user has confirmed the set:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch." >&2; exit 1; }
node "<plugin-root>/scripts/state.mjs" awaiting-owner-clear \
  --workflow-path "$ACTIVE" --host <claude|codex> --gate staging-set \
  --next-step-kind commit --next-step-confidence HIGH
```

The clear records the owner's resolution with the next step `commit` in the
same write, so a commit that fails afterwards does not leave the
`owner-decision` the gate had recorded.

Then:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch." >&2; exit 1; }
node "<plugin-root>/scripts/phase7-commit.mjs" --mode execute \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host <claude|codex> \
  <subject flags> [<staging flags>]
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
archived by a Stop hook that sees HEAD moved. On success it has sent the
parent note and written `set-terminal commit-complete` last. On failure it
printed what landed and what did not; the workflow stays active, and running
this skill again resumes: a rerun plans only what is left, and a clean tree
whose commits all landed is the `recovery` path.

ARCHIVE TIMING — decide before running execute. On Claude the Stop hook fires
at **every turn end**, so a successful commit's terminal write is evaluated
by the archive gates at the end of that turn, not at session close. Clearing
the marker with `--terminal-marker false` works only before that Stop fires
and needs set-terminal's full flag set. On Codex the Stop hook runs only once
the operator has trusted the plugin hooks (`/hooks`); until then archive the
committed workflow with `$engineer:resume`. The close path archives the
workflow itself. Full contract:
`../_shared/references/session-handoff.md` § Archive timing.

---

## Phase 3 — Close without a commit

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch." >&2; exit 1; }
node "<plugin-root>/scripts/phase7-commit.mjs" --mode close \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host <claude|codex>
```

It re-checks the close (`git status` clean, nothing committed,
`next_step_kind: done`, not a start workflow, no owner gate or pending
ensemble), writes `close-complete` with the terminal marker, and archives the
workflow: its HEAD never moved, so the Stop hook would not. It prints no
session-handoff footer, whose projection would read the unmoved HEAD as a
blocked archive. A close stopped between its two writes is finished by
running it again; the Stop hook never notes a `close-complete` workflow on a
parent macro, because it made no commit. For a macro subtask its output names the next step,
`/orchestrator:done <subtask> --no-commit`, which needs a reason.

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
