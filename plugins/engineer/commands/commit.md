---
description: Commit a verb-chain workflow's change, or close it without a commit when there is none — the verb-chain commit surface over the Phase 7 driver
argument-hint: (no arguments)
---

# Engineer · Commit

`/engineer:commit` is the commit surface for a workflow built with the six
verbs (`/engineer:compose`, `/engineer:refine`, …) rather than with
`/engineer:start`, whose own Phase 7 commits it. It reuses the Phase 7 driver
`phase7-commit.mjs` (ADR-0028 §Layer-3): the staging set is the workflow's
`commit_manifest` intersected with the changes, split per release-please
package, committed with conventional subjects, and followed by the
post-commit gates, the note to a parent macro, and the terminal write. It
covers both ends of a verb chain
([ADR-0063](../../../docs/adr/0063-autopilot-fresh-session-driver.md) D3):

- **commit** — the last verb said the artifact is ready (`next_step_kind:
  commit`, or `done` with changes still to commit);
- **no-changes close** — the last verb said the work needs no commit
  (`next_step_kind: done`) and nothing was committed: the workflow closes
  as `close-complete` and is archived, with no commit.

A commit does not complete a macro subtask. The subtask stays in progress
until its pull request merges and `/orchestrator:done` records the merge
commit (ADR-0062); after a no-changes close, `/orchestrator:done <subtask>
--no-commit` records it with a reason.

It is a meta command (ADR-0022 meta-skill category, ADR-0010 §3): it runs no
cognitive verb and bootstraps no workflow. **Cognitive runbook lives in
`${CLAUDE_PLUGIN_ROOT}/core/skills/commit/SKILL.md`**; this file owns the
Claude-host bash below, and the Codex skill of the same name mirrors it.

Under an autopilot run the whole step is one command, decided in code
(`phase7-commit.mjs --mode autopilot`); the rules are in
`${CLAUDE_PLUGIN_ROOT}/core/skills/_shared/references/autopilot-mode.md`.

Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ENGINEER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep that opening line when you run a block: a
shell variable does not outlive a Bash call, so every block below resolves
the workflow again.

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not.

---

## Phase 0 — Resolve the workflow and the mode

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
GIT_BRANCH="$(git branch --show-current)"
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — engineer workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  exit 1
fi
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
if [ -z "$ACTIVE" ]; then
  echo "✗ No active engineer workflow on $GIT_BRANCH — nothing for /engineer:commit to commit or close." >&2
  exit 1
fi
WORKFLOW_TYPE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).workflow_type||"verb-chain")}catch{process.exit(1)}})')" || exit 1
if [ "$WORKFLOW_TYPE" = "start" ]; then
  echo "✗ $ACTIVE is an /engineer:start workflow; its own Phase 7 commits it — continue it with /engineer:start." >&2
  exit 1
fi
# ADR-0063 D4 — prints nothing in interactive mode; this command's autopilot
# rules under an autopilot run; exits 1 under autopilot when an owner gate is
# set; prints a pending gate for the owner otherwise.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" autopilot-preflight \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --surface commit || exit $?
echo "Workflow: $ACTIVE"
```

Then:

- **The preflight printed the autopilot banner** → run the Autopilot block
  below and nothing else.
- **It printed a pending `staging-set` gate** → the owner is here to confirm
  the staging set an autopilot run stopped on. Continue with Phase 1; clear the
  gate in Phase 2 once they confirm it.
- **It printed any other pending gate** → stop and put it to the user. That
  gate is resolved by the surface the notice names, not by a commit; the
  driver's execute and close modes refuse while any gate is set.
- **It printed nothing** → Phase 1.

---

## Autopilot — the whole step in one command

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch." >&2; exit 1; }
# Recovers an interrupted commit, closes a done workflow with nothing to
# commit, stops at the staging-set owner gate, or commits with plan mode's
# suggested subjects and --strict-cc. The owner gate is also where it stops
# when the workflow did not begin on a clean tree or the index is pre-staged:
# only the owner can tell pre-existing hunks from the workflow's own. It takes
# no confirm or bypass flag and refuses outside an autopilot run, on an
# /engineer:start workflow, and while an owner gate or a peer ensemble is
# pending.
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode autopilot \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}"
```

Report its JSON `action` in the Completion below. Never push or open a pull
request afterwards: waiting for the landing is the owner's routine step, which
the driver reads from state, and it is not an owner gate.

---

## Phase 1 — Plan (interactive)

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode plan \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}"
```

Read the plan JSON and follow `core/skills/commit/SKILL.md` § Phase 1:

- `branch: no-changes` → `no_changes.path` decides:
  - `recovery` → an earlier run's commits landed but its terminal write did
    not. Phase 2 finishes it (no subject needed).
  - `close` → the last verb recorded that the work needs no commit, and
    nothing was committed. Confirm with the user ("Recommended: close without
    a commit. Proceed?"), then Phase 3.
  - `blocked` → report `no_changes.reason` and stop; nothing is written.
- Otherwise present the staging set and `commits[].suggested_subject`, with
  `ask_user`, `extras` and `requires_split`, exactly as `/engineer:start`
  Phase 7 does, and get the user's accept / edit / cancel.

---

## Phase 2 — Commit (interactive)

When the preflight reported a pending `staging-set` gate and the user has now
confirmed the staging set, clear it first:

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate staging-set \
  --next-step-kind commit --next-step-confidence HIGH
```

The clear records the owner's resolution with the next step `commit` in the
same write, so a commit that fails afterwards does not leave the
`owner-decision` the gate had recorded.

Then commit with what the user confirmed:

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch." >&2; exit 1; }
# Subjects, one of:
#   --suggested-subjects                   the user accepted every suggestion (single or split);
#   --subject '<confirmed subject>'        one commit, edited;
#   --subject-pkg '<package>=<subject>'    repeated, one per commit of a split
#                                          (the docs commit's key is `docs`).
# Staging, only when the plan had ask_user=true and the user confirmed the set:
#   --confirm-non-interactive, plus --include-extra <path> per extra they opted
#   in, or --accept-current-tree to take every change.
# A recovery (no_changes.path=recovery) needs no subject flag.
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode execute \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}" \
  --suggested-subjects
```

The driver takes the workflow out of its terminal state before the first
commit (`phase-7-commit`, no marker), so a split that fails halfway is never
archived by a Stop that sees HEAD moved. On success it has already sent the
parent note (P10) and written `set-terminal commit-complete` last. On failure
it printed what landed and what did not; the workflow stays active, and
rerunning `/engineer:commit` resumes from there.

ARCHIVE TIMING — decide before running execute. On Claude the Stop hook fires
at **every turn end**, so a successful commit's terminal write is evaluated
by the archive gates at the end of this turn, not at session close, and the
workflow is archived then when every gate passes. Clearing the marker with
`--terminal-marker false` works only before that Stop fires and needs
set-terminal's full flag set. On Codex the Stop hook runs only once the
operator has trusted the plugin hooks (`/hooks`), so the archive waits for
that. The close path archives the workflow itself. Full contract:
`core/skills/_shared/references/session-handoff.md` § Archive timing.

---

## Phase 3 — Close without a commit (interactive)

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch." >&2; exit 1; }
# Re-checks everything: git status clean (index, working tree, untracked),
# nothing committed since the workflow began, next_step_kind done, not an
# /engineer:start workflow, no owner gate or pending ensemble. Writes
# close-complete with the terminal marker, then archives the workflow (its
# HEAD never moved, so the Stop hook would not). A close stopped between the
# two is finished by running it again.
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode close \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}"
```

---

## Completion

Report one of:

- `✓ Committed.` + each landed `<sha> <subject>`, and the workflow path.
- `✓ Closed without a commit.` + the archived path.
- `⏸ The staging set needs the owner.` — autopilot recorded the
  `staging-set` gate; nothing was committed.
- `✗ Nothing to commit, and the workflow cannot close (<reason>).` — or the
  driver's failure message.

Then emit an **Active Next-Action Proposal**, per
`core/skills/_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal — the canonical six-field template (runtime
completion-output contract):

```
- selected_next:         <owner decision | verb>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: the landing action, /orchestrator:done …, or /engineer:<verb> …>
```

Typical `selected_next` after a commit is the owner's landing: push the
branch, open and merge the pull request, then `/orchestrator:done <subtask>`
for a macro subtask. After a no-changes close of a macro subtask it is
`/orchestrator:done <subtask> --no-commit` with the reason. After a refusal it
is the verb that fixes the cause (`/engineer:refine` for a hook or subject
failure). Derive it from the result; do not end with a fixed literal.

The runtime completion footer is **code-emitted** on the commit path
(ADR-0039): the driver's terminal write fires the ADR-0031 session-handoff
sidecar, which prints the footer on stderr. Do **not** hand-compose a second
one. The footer is advisory + pointer-only and fail-closed, and it never
mutates host session context. The close path prints none — its projection
would read the unmoved HEAD as a blocked archive and advise a commit — so the
Completion above names the next step instead.
