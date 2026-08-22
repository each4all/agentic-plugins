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
`$CLAUDE_PLUGIN_ROOT/skills/resume/SKILL.md`** per ADR-0022. This command
file owns the Claude-host bash below; the drift semantics, dirty-case
enrichment rules, and host-availability matrix delegate to SKILL.md.

Plugin root is `$CLAUDE_PLUGIN_ROOT` (set by Claude Code). If unset, fall
back to
`$(find ~/.claude/plugins/cache/agentic-plugins/founder -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

---

## Phase 0 — Argument parsing

Inspect `$ARGUMENTS`:

- **Empty** → *resume mode* (default) → Phase 1.
- **Starts with `archive` (case-insensitive)** → *archive mode* → Phase 3.
- **Anything else** → reject with a one-line usage hint and stop. `resume`
  accepts only the empty form or `archive [<id>]`.

---

## Phase 1 — Locate active workflow

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/founder-resume-find.err)"
FIND_RC=$?
```

- **Exit 0, empty stdout** → "*No active workflow; nothing to resume.*"
  Recommend `/founder:investigate` (or another verb) to bootstrap one.
- **Exit 0, single path** → that path is the active workflow → Phase 2.
- **Exit 1, per-branch duplicate error** → list ALL candidate files with
  each file's `git_baseline.branch`; ask the user to pick one or to archive
  stale candidates via `/founder:resume archive <id>`. Do NOT pick one
  yourself (ADR-0018 §sub-2 user-resolvable invariant).

---

## Phase 2 — Drift report (clean / dirty)

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE" >/tmp/founder-resume-read.json
CURRENT_BRANCH="$(git branch --show-current)"
CURRENT_HEAD="$(git rev-parse HEAD)"
CURRENT_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
```

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

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host claude \
  --phase-label "Resume" --phase-note "Re-entered via /founder:resume; drift=<clean|dirty>." \
  --event resumed
```

Skip the marker when the baseline is invalid (re-validate; shell state may
not survive across Bash calls). Do NOT bump `current_phase` / `next_action`.

---

## Phase 3 — Archive mode

- `archive` (no id) → archive the single active workflow on the current
  branch (reject on per-branch duplicate; require an explicit id).
- `archive <id>` → validate against the workflow-id regex (ADR-0011 §1),
  resolve to
  `<REPO_ROOT>/.agentic-plugins/state/founder/workflows/<id>.md`, confirm it
  exists.

Confirm with the user before mutating (show workflow_id / current_phase /
next_action). The durable business artifact is NOT affected. On
confirmation:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" archive \
  --workflow-path "$WORKFLOW" --host claude --repo-root "$REPO_ROOT"
```

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
