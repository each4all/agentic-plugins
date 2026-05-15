---
name: resume
description: "Re-enters an in-flight orchestrator macro workflow with a clean/dirty drift report, or archives a stale macro workflow. A workflow-continuity meta operation, not a macro planning verb. Use when the user wants to inspect or continue an active orchestrator plan after compaction, branch switching, or cross-host handoff."
---

# Resume (orchestrator meta skill)

`resume` inspects the active orchestrator macro workflow for the
current git branch. It reports clean/dirty drift against
`git_baseline`, optionally appends a resume marker, and can archive
stale macro workflows.

This is a meta skill, not a planning verb. It does not create a new
workflow and does not mutate `plan.subtasks[]`. Bootstrap new macro
work with `orchestrator:plan`.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| Locate active macro via `state.mjs find-active` | Yes | Yes — filesystem state is host-shared |
| Drift report with git probes | Yes | Yes |
| Append resume marker | `--host claude` | `--host codex` |
| Archive macro workflow | `--host claude` | `--host codex` |
| SessionStart re-injection | Yes, through Claude hook | Yes when Codex plugin hooks are enabled and trusted; otherwise resume reads the same durable workflow file |

Codex can inspect, append, and archive using the same `state.mjs`
surface. Automatic SessionStart re-injection in Codex additionally requires
`[features].plugin_hooks = true` and `/hooks` review/trust.

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:resume [archive [<id>]]` | `$orchestrator:resume [archive [<id>]]` |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | Codex marketplace install path for `plugins/orchestrator` |
| Host flag | `--host claude` | `--host codex` |

---

## Phase 0 — Argument intake

- Empty -> resume mode.
- Starts with `archive` -> archive mode.
- Anything else -> reject with
  `orchestrator:resume [archive [<workflow-id>]]`.

---

## Phase 1 — Locate active macro

Run:

```bash
node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT"
```

Outcomes:

- Empty stdout -> no active macro; recommend `orchestrator:plan`.
- One path -> continue.
- Non-zero -> duplicate/corrupt branch state; surface the diagnostic
  and do not choose a workflow for the user.

---

## Phase 2 — Drift report

Read the workflow with `state.mjs read --workflow-path <path>`.
Compare current branch, HEAD, and status digest against
`git_baseline`. Classify as:

- `clean` when all match.
- `dirty` when any differ.

For dirty drift, run git probes when the baseline commit object is
available: commits since baseline, working tree diff stat, renames,
and deletes. Always state that orchestrator does not auto-reconcile
macro workflows.

If `latest_checkpoint` exists, include `at` and `summary`.

Append a resume marker with:

```bash
node "<plugin-root>/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host <claude|codex> \
  --phase-label "Resume: drift=<clean|dirty>" \
  --phase-note "<summary>" \
  --event resumed
```

Do not mutate `current_phase`, `next_action`, or `plan`.

---

## Phase 3 — Archive mode

Resolve the active or named workflow and ask for confirmation before
mutation. Then run:

```bash
node "<plugin-root>/scripts/state.mjs" archive \
  --workflow-path "$WORKFLOW" --host <claude|codex> --repo-root "$REPO_ROOT"
```

Archive moves the file to the matching canonical or legacy
orchestrator `archive/` home.

---

## Anti-patterns

- Do not bootstrap a macro workflow from resume.
- Do not pick between duplicate same-branch macro files without user
  input.
- Do not auto-reconcile drift.
- Do not use engineer workflow ids or engineer schema paths.
