---
description: Resume an active engineer workflow with a clean/dirty drift report, or archive it
argument-hint: [archive [<workflow-id>]]
---

# Engineer · Resume

$ARGUMENTS

`/engineer:resume` is a meta command per ADR-0017 §sub-decision-1: a
thin shim over `state.mjs` that surfaces the active workflow,
classifies drift as **clean** or **dirty** (ADR-0017 §sub-decision-1
explicitly defers the 4-tier `clean / compatible / conflicting /
rewound` taxonomy to a later trigger), and offers an `archive` path.
This command does NOT bootstrap a new workflow — use one of the 6
verbs (`/engineer:investigate`, `/engineer:frame`, `/engineer:decide`,
`/engineer:compose`, `/engineer:critique`, `/engineer:refine`) for
that.

The plugin root in shell snippets below is `$CLAUDE_PLUGIN_ROOT`
(set by Claude Code for plugin slash commands). If unset for any
reason, fall back to
`$(find ~/.claude/plugins/cache/agentic-plugins/engineer -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

---

## Phase 0 — Argument parsing

Inspect `$ARGUMENTS`:

- Empty → **resume mode** (default). Continue with Phase 1.
- Starts with `archive` (case-insensitive) → **archive mode**. Continue
  with Phase 3.
- Anything else → reject with a one-line usage hint and stop. Do NOT
  guess at intent — `/engineer:resume` accepts only the empty form or
  `archive [<id>]`.

---

## Phase 1 — Locate active workflow

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/engineer-resume-find.err)"
FIND_RC=$?
```

Branch on the result:

- **Exit 0, empty stdout** → no active workflow. Emit:
  > ✗ No active workflow; nothing to resume.
  > Recommended next: `/engineer:investigate` (or another verb) to
  > bootstrap a new workflow.

  Do NOT attempt to read the workflows directory yourself or fabricate
  a workflow file. This is the `(c) no-active` outcome required by
  ADR-0017 §sub-decision-1's validation contract.

- **Exit 0, single path on stdout** → that path is the single active
  workflow. Continue with Phase 2.

- **Exit 1, multi-active error on stderr** → the directory contains
  more than one workflow file, violating ADR-0011 §1 single-active
  invariant. List the candidate files (oldest first per filename
  ordering — the workflow_id timestamp is monotonic):

  ```bash
  ls -1 "$REPO_ROOT/.claude/agentic-engineer/workflows"/*.md 2>/dev/null
  ```

  Present each candidate with its frontmatter `current_phase` /
  `next_action` (parsed via `state.mjs read --workflow-path <p>`) and
  ask the user which one to resume — or whether to archive one or more
  stale candidates first via `/engineer:resume archive <id>`. Do NOT
  pick one yourself; multi-active is a user-resolvable invariant
  violation, not a drift case.

---

## Phase 2 — Drift report (clean / dirty)

Read the active workflow's frontmatter and compare git state:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read \
  --workflow-path "$ACTIVE" > /tmp/engineer-resume-frontmatter.json

CURRENT_BRANCH="$(git branch --show-current)"
CURRENT_HEAD="$(git rev-parse HEAD)"
CURRENT_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"

BASE_BRANCH="$(jq -r '.git_baseline.branch' /tmp/engineer-resume-frontmatter.json)"
BASE_HEAD="$(jq -r '.git_baseline.head' /tmp/engineer-resume-frontmatter.json)"
BASE_DIGEST="$(jq -r '.git_baseline.status_digest // ""' /tmp/engineer-resume-frontmatter.json)"
```

Classify per ADR-0017 §sub-decision-1's two-tier scheme:

- **clean**: `CURRENT_BRANCH == BASE_BRANCH` AND
  `CURRENT_HEAD == BASE_HEAD` AND
  (`BASE_DIGEST` is empty OR `CURRENT_DIGEST == BASE_DIGEST`).
  The working tree is exactly where the workflow last recorded.
- **dirty**: anything else — branch changed, HEAD advanced or
  diverged, or working-tree digest differs.

Note: this command intentionally does NOT split "dirty" into
`compatible / conflicting / rewound`. ADR-0017 §sub-decision-1
"Out of scope" defers that taxonomy to a Stage 3+ trigger
(cross-host same-file transition). Surface the raw deltas (branch
diff, HEAD diff via `git log --oneline BASE_HEAD..HEAD`, working-tree
modified files) so the user can decide whether to proceed.

Render the report:

```
Workflow: <ACTIVE>
  workflow_id:    <from frontmatter>
  workflow_type:  <verb>
  current_phase:  <current_phase>
  next_action:    <next_action>
  drift:          clean | dirty
    branch:       <BASE_BRANCH> → <CURRENT_BRANCH>      (only if changed)
    head:         <BASE_HEAD>… → <CURRENT_HEAD>…         (only if changed)
    commits:      <git log --oneline BASE_HEAD..HEAD>    (only if HEAD advanced)
    working tree: <count> file(s) modified               (only if digest changed)
```

If `latest_checkpoint` is present in frontmatter (schema 1.1
optional, ADR-0017 §sub-decision-2), include its `at` and `summary`
as a one-line "Last checkpoint" entry above the drift block.

---

## Phase 2b — Append resume marker

Record the resume event so subsequent SessionStart suffix and
post-mortem audit have a clean trail:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host claude \
  --phase-label "Resume: drift=<clean|dirty>" \
  --phase-note "<one-paragraph diff summary or 'no changes since baseline'>" \
  --event resumed
```

Do NOT bump `current_phase` or `next_action` — the resume marker is
purely a host-history append. The user (or the next verb command)
controls phase progression.

---

## Phase 3 — Archive mode (`$ARGUMENTS` starts with `archive`)

Parse the rest of the argument:

- `archive` (no id) → archive the **single active** workflow. If
  `find-active` returned multi-active, reject with a usage hint:
  `/engineer:resume archive <workflow-id>` is required when more than
  one workflow file exists.
- `archive <id>` → archive the named workflow. Validate the id
  matches the workflow_id regex per ADR-0011 §1. Resolve to
  `<REPO_ROOT>/.claude/agentic-engineer/workflows/<id>.md` and confirm
  it exists.

Confirm with the user before mutating state — archive is reversible
(the file moves to `archive/`, not deleted) but the active registry
loses the entry. Show the workflow_id, current_phase, and next_action
so the user can sanity-check.

On confirmation:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" archive \
  --workflow-path "$WORKFLOW" --host claude --repo-root "$REPO_ROOT"
```

The CLI is collision-safe (timestamp suffix on collision) and
idempotent (no-op if the file already moved). On success, surface the
archive destination path:

```
✓ Archived: <from> → <to>
```

If the archive subcommand reports `archived: false, reason:
source-missing`, treat it as already-archived and tell the user.

---

## Completion

Emit one of:

- `✓ Resumed: <workflow_id> (drift=<clean|dirty>)` — Phase 2 finished.
  Recommend the next verb based on `current_phase` / `next_action`.
- `✓ Archived: <id>` — Phase 3 finished.
- `✗ No active workflow; nothing to resume.` — Phase 1 found nothing.
  Recommend `/engineer:investigate` or another verb.
- `✗ Multi-active workflows detected: N candidates.` — Phase 1 found
  more than one. Show the candidate list and stop.

Always include the absolute workflow path so the user can inspect or
edit by hand:

```
Workflow: <absolute path>
```
