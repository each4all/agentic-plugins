---
description: Re-enter an active founder workflow with a clean/dirty drift report, or archive a stale one
argument-hint: (empty to resume) | archive [<workflow-id>]
---

# Founder · Resume

$ARGUMENTS

`/founder:resume` is a meta command per ADR-0022 (meta-skill category,
adopted for founder per ADR-0036 SD2): it re-enters an in-flight founder
workflow with a **clean/dirty** drift report against the recorded git
baseline, or archives a stale workflow. It does NOT advance the workflow
(that is the six verbs' job) and does NOT bootstrap a new one.

**Cognitive runbook + the Host-availability matrix live in
`${CLAUDE_PLUGIN_ROOT}/core/skills/resume/SKILL.md`** per ADR-0022. This command
file owns the Claude-host bash below; the drift semantics, dirty-case
enrichment rules, and host-availability matrix delegate to SKILL.md.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_FOUNDER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

---

## Phase 0 — Argument parsing

Inspect `$ARGUMENTS`:

- **Empty** → *resume mode* (default) → Phase 1.
- **Starts with `archive` (case-insensitive)** → *archive mode* → Phase 3.
- **Anything else** → reject with a one-line usage hint and stop. `resume`
  accepts only the empty form or `archive [<id>]`.

---

## Phase 1 — Locate active workflow

<!-- pipeline:begin resume-locate -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/'founder'-'resume'-find.err)"
FIND_RC=$?
```
<!-- pipeline:end resume-locate -->

- **Exit 0, empty stdout** → "*No active workflow; nothing to resume.*"
  Recommend `/founder:investigate` (or another verb) to bootstrap one.
- **Exit 0, single path** → that path is the active workflow → Phase 2.
- **Exit 1, per-branch duplicate error** → list ALL candidate files
  (`state.mjs list-workflows --repo-root "$REPO_ROOT"` prints those of this
  checkout's read set, ADR-0067 Decision 1(a)) with each file's
  `git_baseline.branch`; ask the user to pick one or to archive
  stale candidates via `/founder:resume archive <id>`. Do NOT pick one
  yourself (ADR-0018 §sub-2 user-resolvable invariant).

---

## Phase 2 — Drift report (clean / dirty)

<!-- pipeline:begin resume-read -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE" >/tmp/'founder'-resume-read.json
CURRENT_BRANCH="$(git branch --show-current)"
CURRENT_HEAD="$(git rev-parse HEAD)"
CURRENT_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
BASE_BRANCH="$(node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).git_baseline||{};process.stdout.write(String(b.branch??""))}catch{}' /tmp/'founder'-resume-read.json)"
BASE_HEAD="$(node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).git_baseline||{};process.stdout.write(String(b.head??""))}catch{}' /tmp/'founder'-resume-read.json)"
BASE_DIGEST="$(node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).git_baseline||{};process.stdout.write(String(b.status_digest??""))}catch{}' /tmp/'founder'-resume-read.json)"
```
<!-- pipeline:end resume-read -->

Classify: **clean** when current branch+HEAD+digest match the workflow's
`git_baseline`; **dirty** otherwise. Render the drift report per SKILL.md
§ Phase 2 (workflow_id / workflow_type / verb / current_phase / next_action / drift, with
the changed-only branch/head/commits/working-tree lines, and a "Last
checkpoint" line when `latest_checkpoint` is present).

On **dirty**, run the ADR-0018 §sub-3 git probes (guarded by `git cat-file
-e <base-head>^{commit}`): `git log <BASE_HEAD>..HEAD --oneline`, `git diff
--stat HEAD`, `git log --diff-filter=R` / `--diff-filter=D --name-status
<BASE_HEAD>..HEAD`. Each probe prints `(none; ...)` on empty or `(probe
failed: ...)` on error. Always close the dirty report with:

```
  current plugin does not auto-reconcile; review and decide [resume / archive / abort]
```

### Phase 2b — Append resume marker

If the baseline commit object is available, append a `host_history` entry
(no phase mutation):

<!-- pipeline:begin resume-marker -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# host_history fidelity (ADR-0017 §sub-decision-1): no marker over a baseline
# whose commit object is not available. Re-read here: shell variables from
# Phase 2 do not survive across Bash calls.
BASE_HEAD_CHECK="$(node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).git_baseline||{};process.stdout.write(String(b.head??""))}catch{}' /tmp/'founder'-resume-read.json)"
if [ -z "$BASE_HEAD_CHECK" ] || ! git cat-file -e "$BASE_HEAD_CHECK^{commit}" 2>/dev/null; then
  echo "Phase 2b: resume marker NOT appended (invalid baseline; ADR-0017 §sub-decision-1 host_history fidelity)."
else
  PERSONA='founder'
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --phase-label "Resume" --phase-note "Re-entered via /${PERSONA}:resume; drift=<clean|dirty>. <one-paragraph diff summary, or 'no changes since baseline'>" \
    --event resumed
fi
```
<!-- pipeline:end resume-marker -->

Skip the marker when the baseline is invalid (re-validate; shell state may
not survive across Bash calls). Do NOT bump `current_phase` / `next_action`.

---

## Phase 3 — Archive mode

- `archive` (no id) → archive the single active workflow on the current
  branch (reject on per-branch duplicate; require an explicit id).
- `archive <id>` → the file the block below prints, found in the workflow
  homes of this checkout's read set (ADR-0067 Decision 4, item 2), the
  default state root first; stop when it exits non-zero (not a workflow id,
  no root holds it, or two files do). Put the id in place of
  `<workflow-id>`:

<!-- pipeline:begin resume-archive-resolve -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ARCHIVE_WORKFLOW_ID='<workflow-id>'
if ! WORKFLOW="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$ARCHIVE_WORKFLOW_ID")"; then
  echo "✗ $ARCHIVE_WORKFLOW_ID names no single workflow file in the workflow homes of this checkout's read set (the reason is above); nothing archived." >&2
  exit 1
fi
printf 'WORKFLOW=%s\n' "$WORKFLOW"
```
<!-- pipeline:end resume-archive-resolve -->

Confirm with the user before mutating (show workflow_id / current_phase /
next_action). The durable business artifact is NOT affected. On
confirmation, put the workflow path (Phase 1's, or the one printed above) in
place of `<workflow path>`:

<!-- pipeline:begin resume-archive -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
WORKFLOW='<workflow path>'
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" archive \
  --workflow-path "$WORKFLOW" --host "${AGENTIC_HOST:-claude}" --repo-root "$REPO_ROOT"
```
<!-- pipeline:end resume-archive -->

Collision-safe + idempotent; `archived: false, reason: source-missing` means
already-archived.

---

## Completion

- `✓ Resumed <workflow_id> — drift=<clean|dirty>.` (+ the workflow path and,
  on dirty, the probe block + decide notice).
- `✓ Archived <workflow_id> → archive/.`
- `✗ No active workflow; nothing to resume.`
- `✗ Per-branch duplicate — pick one or archive a stale candidate first.`
- `✗ <usage hint>` — Phase 0 rejected an unexpected argument.
