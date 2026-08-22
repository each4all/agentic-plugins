---
description: Resume an active orchestrator macro workflow with a clean/dirty drift report, or archive it
argument-hint: [archive [<workflow-id>]]
---

# Orchestrator · Resume

$ARGUMENTS

`/orchestrator:resume` is a workflow-continuity meta command: a thin
shim over `scripts/state.mjs` for the active macro workflow on the
current git branch. It mirrors the engineer resume pattern where that
pattern is useful, but the workflow remains orchestrator-native:
`workflow_type: macro`, `workflow_id: macro-plan-...`, and state under
canonical `.agentic-plugins/state/orchestrator/` (legacy
`.claude/agentic-orchestrator/` remains readable until explicit
migration per ADR-0025).

**Cognitive runbook lives in
`$CLAUDE_PLUGIN_ROOT/skills/resume/SKILL.md`**. This command file owns
Claude-host shell bootstrap and state writes; the skill documents the
cross-host runbook and Codex hook-gate caveats.

Plugin root: `$CLAUDE_PLUGIN_ROOT` is the orchestrator plugin root. If
unset, discover the latest Claude cache entry under
`~/.claude/plugins/cache/agentic-plugins/orchestrator`.

---

## Phase 0 — Argument parsing

Inspect `$ARGUMENTS`:

- Empty -> **resume mode**. Continue with Phase 1.
- Starts with `archive` -> **archive mode**. Continue with Phase 3.
- Anything else -> reject with:
  `Usage: /orchestrator:resume [archive [<workflow-id>]]`

---

## Phase 1 — Locate active macro workflow

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/orchestrator-resume-find.err)"
FIND_RC=$?
```

Branch on the result:

- **Exit 0, empty stdout** -> no active macro workflow. Emit:
  `✗ No active orchestrator workflow; nothing to resume.`
  No macro to reason about — this guard surfaces a compact pointer, not the
  full Active Next-Action Proposal (per
  `skills/_shared/references/session-handoff.md § Active Next-Action Proposal`
  meta/guard exception): the honest next step is `/orchestrator:plan <feature>`
  for a multi-deliverable macro (or `/engineer:start` for a single deliverable),
  sized to the work shape.
- **Exit 0, single path** -> continue with Phase 2.
- **Exit 1** -> per-branch duplicate or malformed-file fail-closed
  diagnostic. Surface stderr and stop. Do not pick a workflow yourself;
  branch-keyed duplicates are user-resolvable corruption.

---

## Phase 2 — Drift report

Read frontmatter and compare current git state against the macro's
`git_baseline`:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read \
  --workflow-path "$ACTIVE" > /tmp/orchestrator-resume-frontmatter.json

CURRENT_BRANCH="$(git branch --show-current)"
CURRENT_HEAD="$(git rev-parse HEAD)"
CURRENT_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"

BASE_BRANCH="$(jq -r '.git_baseline.branch' /tmp/orchestrator-resume-frontmatter.json)"
BASE_HEAD="$(jq -r '.git_baseline.head' /tmp/orchestrator-resume-frontmatter.json)"
BASE_DIGEST="$(jq -r '.git_baseline.status_digest // ""' /tmp/orchestrator-resume-frontmatter.json)"
SUBTASK_COUNT="$(jq -r '(.plan.subtasks // []) | length' /tmp/orchestrator-resume-frontmatter.json)"
```

Drift is **clean** only when branch, HEAD, and status digest match
the baseline. Any mismatch is **dirty**. This command reports drift;
it does not auto-reconcile or rewrite the plan.

Render:

```text
Workflow: <ACTIVE>
  workflow_id:    <workflow_id>
  workflow_type:  macro
  command:        /orchestrator:plan
  current_phase:  <current_phase>
  subtask_count:  <N>
  drift:          clean | dirty
```

If `latest_checkpoint` is present, include:

```text
  last_checkpoint: <at> — <summary>
```

For dirty state, include native git probes when `BASE_HEAD` is an
available commit object:

```bash
git log "$BASE_HEAD..HEAD" --oneline
git diff --stat HEAD
git log --diff-filter=R --name-status "$BASE_HEAD..HEAD"
git log --diff-filter=D --name-status "$BASE_HEAD..HEAD"
```

Always print this dirty-state notice:

```text
current plugin does not auto-reconcile macro workflows; review and decide [resume / archive / abort]
```

---

## Phase 2b — Append resume marker

When the baseline commit object is available, append a resume marker.
Do not mutate `current_phase` or `next_action`.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host claude \
  --phase-label "Resume: drift=<clean|dirty>" \
  --phase-note "<one-paragraph macro drift summary>" \
  --event resumed
```

If the baseline commit is unavailable, skip the marker and say why.

---

## Phase 3 — Archive Mode

Forms:

- `/orchestrator:resume archive` -> archive the single active macro
  workflow on the current branch.
- `/orchestrator:resume archive <workflow-id>` -> archive the named
  macro workflow under `.agentic-plugins/state/orchestrator/workflows/`
  or the legacy `.claude/agentic-orchestrator/workflows/` home.

Confirm with the user before mutation. Show workflow id, current
phase, subtask counts, and path.

On confirmation:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" archive \
  --workflow-path "$WORKFLOW" --host claude --repo-root "$REPO_ROOT"
```

Archive is a move to the matching canonical or legacy `archive/` home,
not a delete. The state CLI is collision-safe and idempotent.

---

## Completion

- `✓ Resumed orchestrator macro: <workflow_id> (drift=<clean|dirty>)`
- `✓ Archived orchestrator macro: <workflow_id>`
- `✗ No active orchestrator workflow; nothing to resume.`
- `✗ Per-branch duplicate detected — reconcile or archive stale macro workflows first.`

Always include the absolute workflow path.
