---
description: Audit follow-up planning alias — canonicalizes to /orchestrator:plan for multi-deliverable remediation
argument-hint: <audit findings or follow-up objective>
---

# Orchestrator · Audit Follow-Up

$ARGUMENTS

`/orchestrator:audit` is a sugar alias for macro follow-up planning.
It does **not** add an orchestrator `critique` verb. The canonical
state mutation remains `/orchestrator:plan`, `verb=plan`, and a
`macro-plan-...` workflow id.

Use this alias when an audit has produced findings that need to become
a multi-deliverable remediation plan. If the task is to perform the
audit itself, use `/engineer:audit` or `/engineer:critique`; the
orchestrator owns the follow-up decomposition across branches and
engineer workflows.

---

## Canonical expansion

Map:

```text
/orchestrator:audit <findings or objective>
```

to:

```text
/orchestrator:plan Audit follow-up: <findings or objective>
```

Then execute `commands/plan.md` exactly as the active runbook.

---

## Schema Boundary

- `state.mjs create` is invoked with `--verb plan`.
- `workflow_id` starts with `macro-plan-`; this alias never creates
  an audit-prefixed macro workflow id.
- `workflow_type` remains `macro`.
- Findings become `plan.subtasks[]` deliverables with canonical
  engineer verbs (`investigate | frame | decide | compose | critique |
  refine`) on each subtask.

This mirrors engineer's alias discipline while preserving
orchestrator's L2 capability boundary: aliases canonicalize before any
state write.

---

## Completion

Same as `/orchestrator:plan`: present the macro plan and recommend
`/orchestrator:next` after user approval.
