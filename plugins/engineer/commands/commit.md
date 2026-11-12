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
Claude-host bash below, and the Codex skill of the same name runs the same
blocks.

Under an autopilot run the whole step is the plan, the subject files the
worker writes from it, and one command that decides the rest in code
(`phase7-commit.mjs --mode autopilot`); the rules are in
`${CLAUDE_PLUGIN_ROOT}/core/skills/_shared/references/autopilot-mode.md`.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ENGINEER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not.

---

## Phase 0 — Resolve the workflow and the mode

<!-- pipeline:begin commit-phase-0 -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
GIT_BRANCH="$(git branch --show-current)"
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — ${PERSONA} workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  exit 1
fi
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
if [ -z "$ACTIVE" ]; then
  echo "✗ No active ${PERSONA} workflow on $GIT_BRANCH — nothing for /${PERSONA}:commit to commit or close." >&2
  exit 1
fi
# The read is checked on its own: a read that fails stops the block, whatever
# it printed, before the type is parsed.
WF_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE")" || exit $?
WORKFLOW_TYPE="$(printf '%s' "$WF_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).workflow_type||"verb-chain")}catch{process.exit(1)}})')" || exit 1
if [ "$WORKFLOW_TYPE" = "start" ]; then
  echo "✗ $ACTIVE is an /${PERSONA}:start workflow; its own Phase 7 commits it — continue it with /${PERSONA}:start." >&2
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
  the staging set an autopilot run stopped on.
  Continue with Phase 1; clear the gate in Phase 2 once they confirm it.
- **It printed any other pending gate** → stop and put it to the user. That
  gate is resolved by the surface the notice names, not by a commit; the
  driver's execute and close modes refuse while any gate is set.
- **It printed nothing** → Phase 1.
<!-- pipeline:end commit-phase-0 -->

---

## Autopilot — the whole step

<!-- pipeline:begin commit-autopilot -->
First read the plan; it writes nothing:

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode plan \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}"
```

Then write each commit's subject (ADR-0028 §P6, note of 2026-11-04). A subject
reaches the driver as a file, never in the block (ADR-0059, amendment of
2026-10-10): create a private directory with
`mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`, note the path it prints,
and with your file-writing tool, not the shell, write there one line ending
with one newline per entry of the plan's `commits`: `subject.txt` for a single
commit, `subject-<n>.txt` per commit when `requires_split` is true. Each is
`<type>(<scope>): <summary>`:

- the type one of the commit's `subject_rule.allowed_types` (any
  conventional type when `subject_rule` is null); between `feat` and `fix`,
  the one the change is;
- for a package commit (`package` set), the scope one of
  `subject_rule.scopes`;
- the summary your own one line on what the change does, never the topic or
  `original_request` cut short: the driver refuses that.

Beside each subject write its commit's body (ADR-0028 §P1, note of
2026-11-11), in the same directory and the same way: `body.txt` for a single
commit, `body-<n>.txt` per commit of a split. The body is what the commit
changes and why, in a few plain paragraphs, as a pull request body would say
it: never the topic or `original_request` copied, and never its first line the
subject again. No line of it opens with a trailer key (`Workflow-ID:`,
`Co-Authored-By:`, `BREAKING CHANGE:`, `Release-As:`, `Closes:`, `Fixes:` or
`Refs:`; the driver writes the trailers, and release-please reads
`Release-As:` as a version override), and none is shaped like a conventional headline
(`fix: …`, `feat(x)!: …`), which release-please would read as a changelog
entry of its own. It is committed as written, up to 4000 characters.

On a clean tree (`branch: no-changes`) write none, and leave `TEXT_DIR` empty:
the recovery and the close need no subject or body. Nothing in the step
deletes the files, but they do not outlive it: the run removes the step's
temporary directory, and when the step stops at the staging-set gate the
owner's interactive commit composes the body unless the owner passes one.

Writing the subjects is part of this step, and this text governs it. Where an
older instruction says the step commits with the suggested subject (the
worker's "use the suggested conventional subject", or a commit banner that says
the Autopilot block commits with the suggested subjects), follow this runbook:
the suggestion to follow is the plan's `subject_rule`, and a
`suggested_subject` whose description is the topic cut short is refused.

Then run the step, with `TEXT_DIR` set to that directory. The block passes
`subject.txt` and `body.txt` when the directory holds them; for a split, add
one `SUBJECT_ARGS+=` line per commit where the block shows it, after
`SUBJECT_ARGS=()` (a line before it is cleared), and one `BODY_ARGS+=` line
per commit where the block shows it, inside the `if` that passes the bodies,
`<n>` the 1-based index into the plan's `commits` and the key that commit's
`package` (`docs` when it is null):

```bash
TEXT_DIR='<the directory the subjects are in>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# Recovers an interrupted commit, closes a done workflow with nothing to
# commit, stops at the staging-set owner gate, or commits with the subjects in
# TEXT_DIR and --strict-cc, each subject's type and scope checked against the
# files of the commit it heads. The owner gate is also where it stops when the
# workflow did not begin on a clean tree or the index is pre-staged: only the
# owner can tell pre-existing hunks from the workflow's own. It takes no
# confirm or bypass flag and refuses outside an autopilot run, on a /start
# workflow, and while an owner gate or a peer ensemble is pending.
# The subjects in TEXT_DIR, none on a clean tree (TEXT_DIR empty): one commit's
# subject.txt when it is there.
SUBJECT_ARGS=()
if [ -n "$TEXT_DIR" ] && [ -e "$TEXT_DIR/subject.txt" ]; then
  SUBJECT_ARGS+=(--subject-file "$TEXT_DIR/subject.txt")
fi
# A split: one line per commit here, after the two above, each as
#   SUBJECT_ARGS+=(--subject-pkg-file '<package>'="$TEXT_DIR/subject-<n>.txt")
# The bodies in TEXT_DIR, passed only to a driver that names --require-body
# (an older one composes the body itself): with it, a commit made without a
# body is refused.
BODY_ARGS=()
if [ -n "$TEXT_DIR" ] && grep -q -e "'require-body'" "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" 2>/dev/null; then
  BODY_ARGS+=(--require-body)
  if [ -e "$TEXT_DIR/body.txt" ]; then
    BODY_ARGS+=(--body-file "$TEXT_DIR/body.txt")
  fi
  # A split: one line per commit here, each as
  #   BODY_ARGS+=(--body-pkg-file '<package>'="$TEXT_DIR/body-<n>.txt")
fi
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode autopilot \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}" \
  "${BODY_ARGS[@]}" \
  "${SUBJECT_ARGS[@]}"
```

Report its JSON `action` in the Completion below. A subject that does not fit
its change, or none given where a commit is due, is refused (exit 9) with each
reason, and nothing is committed or written. Write the subject anew to its
file and run the step again: the corrected subject where the refusal gives
one; where it names the topic cut short or an empty description, it gives
none, and you write your own summary after the type and scope it names. A
subject file that cannot be read, or a subject flag that does not match the
plan's commits (a split given `--subject-file`), stops the step with exit 1 or
2 before anything is written: fix the files or the `SUBJECT_ARGS` lines and run
it again. A body is held to the same: one that breaks a rule above, a commit
left without one, or a body flag that does not match the plan's commits is
refused with each reason (exit 2 when the file alone shows it, exit 9
otherwise) and nothing is written; write the body file anew, or fix the
`BODY_ARGS` lines, and run the step again. A refusal that
names a landed commit is the owner's to reword, or to split where it touches
several packages: rewrite no history in the step (no amend, rebase or reset),
and report it, with its reason, in the step's report. A refusal with exit 10
(`review-held`) says the workflow's latest review outcome holds the commit
back (failed, degraded, unavailable, malformed or unknown), or the change is
not the one reviewed or cannot be compared with its reviews (ADR-0069), and
nothing was committed or written: the step never accepts it (`state.mjs
review-accept` and `review-binding-accept` are the owner's, and refused under
autopilot) and never reruns the review; report
the attempt and its outcome the refusal names in the step's report, with
`outcome` `needs_owner` and `awaiting_owner` null (the gate is the driver's to
report, and never stored), and stop.
Never push or open a pull request afterwards: waiting
for the landing is the owner's routine step, which the driver reads from
state, and it is not an owner gate.
<!-- pipeline:end commit-autopilot -->

---

## Phase 1 — Plan (interactive)

<!-- pipeline:begin commit-plan -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode plan \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}"
```

Read the plan JSON and follow `core/skills/commit/SKILL.md` § Phase 1 — Plan:

- `branch: no-changes` → `no_changes.path` decides:
  - `recovery` → an earlier run's commits landed but its terminal write did
    not. Phase 2 finishes it (no subject needed).
  - `close` → the last verb recorded that the work needs no commit, and
    nothing was committed. Confirm with the user ("Recommended: close without
    a commit. Proceed?"), then Phase 3.
  - `blocked` → report `no_changes.reason` and stop; nothing is written.
- Otherwise present the staging set and `commits[].suggested_subject`, with
  `ask_user`, `extras` and `requires_split`, exactly as `/engineer:start`
  Phase 7 does, and get the user's accept / edit / cancel. When a commit has
  a `subject_rule` (the repository's release-please configuration names
  packages), an edited subject takes one of its `allowed_types` and, for a
  package commit, one of its `scopes`; check it before execute. Execute warns
  on one that does not fit, commits it as given, and prints the corrected
  subject: pass the warning and the corrected subject to the user (ADR-0028
  §P6, note of 2026-11-04).

When the plan's `review_hold` is set, a review outcome holds this commit back:
show the user that line before asking anything. It names the attempt and the
ways on, and execute warns only as it commits, so this is where the user
decides (ADR-0028, note of 2026-11-07).

The plan's `review_binding` says how the change compares with its reviews
(ADR-0069 Decision 3). When its `hold` is set show that line too. `state:
different` means the change is not the one reviewed: execute refuses it (exit
10), and the way on is `/engineer:critique` of the change as it is now, or the
owner's `state.mjs review-binding-accept`. `state: not-comparable` proves nothing
either way: execute warns and commits.
<!-- pipeline:end commit-plan -->

---

## Phase 2 — Commit (interactive)

<!-- pipeline:begin commit-staging-clear -->
When the preflight reported a pending `staging-set` gate and the user has now
confirmed the staging set, clear it first:

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate staging-set \
  --next-action "Commit the confirmed staging set with /${PERSONA}:commit" \
  --next-step-kind commit --next-step-confidence HIGH || exit $?
```

The clear records the owner's resolution with the next step `commit` and its
next action in the same write, so a commit that fails afterwards leaves
neither the `owner-decision` the gate had recorded nor the gate's
`Owner: confirm the staging set …` next action.
<!-- pipeline:end commit-staging-clear -->

<!-- pipeline:begin commit-execute -->
Then commit with what the user confirmed.

An edited subject reaches the driver as a file, never in the block: in shell
source a quote, `$` or backtick of it would be read as code (ADR-0059,
amendment of 2026-10-10). Create a private directory for it with
`mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`, note the path it prints,
and with your file-writing tool, not the shell, write each edited subject
there, one line ending with one newline: `subject.txt`, or `subject-<n>.txt`
per commit of a split. Then add `TEXT_DIR='<that directory>'` at the top of
the block. Nothing deletes the files.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# Subjects, one of:
#   --suggested-subjects                   the user accepted every suggestion (single or split);
#   --subject-file "$TEXT_DIR/subject.txt"
#                                          one commit, edited;
#   --subject-pkg-file '<package>'="$TEXT_DIR/subject-<n>.txt"
#                                          repeated, one per commit of a split
#                                          (the docs commit's key is `docs`).
# Bodies, only when the user edited the composed one (written as subjects are):
#   --body-file "$TEXT_DIR/body.txt"       one commit;
#   --body-pkg-file '<package>'="$TEXT_DIR/body-<n>.txt"
#                                          repeated, one per commit of a split.
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
archived by a Stop that sees HEAD moved. On success it has
already sent the parent note (P10) and
written `set-terminal commit-complete` last. On failure it printed what
landed and what did not; the workflow stays active, and rerunning
`/engineer:commit` resumes from there.

ARCHIVE TIMING — decide before running execute. On Claude the Stop hook fires
at **every turn end**, so a successful commit's terminal write is evaluated
by the archive gates at the end of this turn, not at session close, and the
workflow is archived then when every gate passes. Clearing the marker with
`--terminal-marker false` works only before that Stop fires and needs
set-terminal's full flag set. On Codex the Stop hook runs only once the
operator has trusted the plugin hooks (`/hooks`), so the archive waits for
that. The close path archives the workflow itself. Full contract:
`core/skills/_shared/references/session-handoff.md` § Archive timing.
<!-- pipeline:end commit-execute -->

---

## Phase 3 — Close without a commit (interactive)

<!-- pipeline:begin commit-close -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# Re-checks everything: git status clean (index, working tree, untracked),
# nothing committed since the workflow began, next_step_kind done, not a
# /start workflow, no owner gate or pending ensemble. Writes close-complete
# with the terminal marker, then archives the workflow (its HEAD never moved,
# so the Stop hook would not). A close stopped between the two is finished by
# running it again.
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode close \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}"
```
<!-- pipeline:end commit-close -->

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

<!-- pipeline:begin commit-completion-footer -->
The runtime completion footer is **code-emitted** on the commit path
(ADR-0039): the driver's terminal write fires the ADR-0031 session-handoff
sidecar, which prints the footer on stderr. Do **not** hand-compose a second
one. The footer is advisory + pointer-only and fail-closed, and it never
mutates host session context. The close path prints none — its projection
would read the unmoved HEAD as a blocked archive and advise a commit — so the
Completion above names the next step instead.
<!-- pipeline:end commit-completion-footer -->
