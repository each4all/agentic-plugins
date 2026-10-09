---
name: approve
description: "Records the owner's approval of the macro plan as it stands — plan_approval bound to the plan's hash (ADR-0063 D6). A workflow meta operation, not a planning verb. Use only when the owner asks to approve the plan; never to approve on the owner's behalf."
---

# Approve (orchestrator meta skill)

`approve` records the owner's approval of a macro plan:
`plan_approval_status=approved`, `plan_approval_approved_at`, and
`plan_approval_plan_hash`, the sha256 of the subtasks as they stand
(ADR-0063 D6). It shows the plan it approves and binds the approval to it: the
hash shown is the hash approved, and a plan that changes in between is
refused. It does not mutate `current_phase`, `next_action`, or
`plan.subtasks[]`.

Any later `plan-set` returns the plan to pending approval
(`awaiting_owner_gate=plan-conflict` when its Plan-verify verdict is
`conflict`, `plan-approval` otherwise). Under ADR-0063's Claude autopilot,
`orchestrator:next` dispatches only an approved plan whose hash still matches
the plan and refuses anything else (`plan-unapproved`); an interactive
`orchestrator:next` does not require an approval, and prints one warning line
for a plan pending approval or changed since it was approved.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| `state.mjs plan-hash` (read-only) | Yes | Yes |
| `state.mjs plan-approve` | `--host claude` | `--host codex` |
| `state.mjs awaiting-owner-clear --gate plan-conflict` | `--host claude` | `--host codex` |
| Schema preservation | Yes | Yes |

Approval is host-neutral state: a plan approved on Codex is approved for a
Claude autopilot run, because both hosts read the same macro file.

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:approve [--workflow=<macro-id>]` | `$orchestrator:approve [--workflow=<macro-id>]` |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | For a mentioned `orchestrator` skill, the plugin directory that contains it: Codex injects a mentioned skill with its absolute path (`<path>…/core/skills/<skill>/SKILL.md</path>`), and dropping `/core/skills/<skill>/SKILL.md` from it leaves the root, which holds `.codex-plugin/plugin.json`. If that path is no longer in context, for example after compaction, a new mention of the skill supplies it again. With the default Codex home and the `agentic-plugins` marketplace added from Git, the root is `~/.codex/plugins/cache/agentic-plugins/orchestrator/<version>`, the versioned copy Codex loads skills from, and `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/orchestrator` is the marketplace checkout, which tracks the repository's `main` branch, not that copy. |
| Host flag | `--host claude` | `--host codex` |

The Claude command runbook is `commands/approve.md`.

---

## Phase 0 — Resolve the macro

With `--workflow=<macro-id>`, use the file `state.mjs resolve-workflow
--repo-root "$REPO_ROOT" --workflow-id "<macro-id>"` prints: the macro in the
orchestrator workflow homes of this checkout's read set (ADR-0067 Decision 4,
item 2); it exits non-zero when no root holds it (3) or two files do (1). Refuse
an id containing `/`, `\`, `..` or a leading `.`. Otherwise:

```bash
node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT"
# empty → the macro whose plan names the current branch:
node "<plugin-root>/scripts/state.mjs" find-macro --repo-root "$REPO_ROOT" --subtask-branch "$(git branch --show-current)"
```

If neither finds a macro, stop: there is no plan to approve.

---

## Phase 1 — Show what the approval binds to

```bash
node "<plugin-root>/scripts/state.mjs" plan-hash --workflow-path "$MACRO_PATH"
```

It prints `{plan_hash, subtasks, approval, approved_at, awaiting_owner_gate,
awaiting_owner_pointer}`. `subtasks` is exactly what the hash covers: each
subtask's id, label, branch, blocked_by, verb, profile and topic. Progress
(status, the engineer workflow, commit, pull request) is not covered, so a plan
stays approved while it executes. Show the owner the subtask table and the
hash.

---

## Phase 2 — Approve exactly that

```bash
node "<plugin-root>/scripts/state.mjs" plan-approve \
  --workflow-path "$MACRO_PATH" --host <claude|codex> \
  --expect-hash "<plan_hash from Phase 1>"
```

It prints `{workflowPath, plan_hash, approved_at}` (`noop: true` when this
hash was already approved; nothing is written), removes the `plan-approval`
gate, and appends `### Plan approved at <iso> (hash <12 hex>)` to the macro.
It exits 1 with the reason when:

- the plan changed since Phase 1 — show the new plan and ask again;
- `awaiting_owner_gate=plan-conflict` — the Plan-verify ensemble disagreed.
  The owner revises the plan (`orchestrator:plan`), or decides the conflict,
  clears it with `state.mjs awaiting-owner-clear --workflow-path "$MACRO_PATH"
  --host <claude|codex> --gate plan-conflict` (the plan returns to
  `plan-approval` and the macro records the resolution), and approves again;
- the plan has no subtasks, or the macro is terminal;
- `AGENTIC_AUTOPILOT` names an autopilot run — only the owner approves.

---

## Completion

Report the approved hash (first 12 hex characters), the subtask count, and the
workflow path, then the next step derived from the macro state — for an
approved plan, typically `orchestrator:next` (`/orchestrator:next` on
Claude, `$orchestrator:next` on Codex).

---

## Anti-patterns

- Do not approve on the owner's behalf, or as a side effect of another
  command.
- Do not clear `plan-conflict` without the owner's decision on the conflict.
- Do not edit the approval keys in the workflow frontmatter by hand.
- Do not approve a hash the owner was not shown.
