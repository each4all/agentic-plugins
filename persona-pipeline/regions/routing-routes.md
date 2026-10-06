## Routing Recommendation

Before continuing a non-trivial lifecycle macro, present one routing
recommendation:

| Route | Use when | Command |
|---|---|---|
{{#capability commit_surface}}
| `{{persona}}:start` | One coherent {{deliverable_noun}} can be carried from idea to commit on the current branch. | `/{{persona}}:start` or `${{persona}}:start` |
{{/capability}}
{{^capability commit_surface}}
| `{{persona}}:start` | One coherent {{deliverable_noun}} can be carried from idea to its saved artifact on the current branch. | `/{{persona}}:start` or `${{persona}}:start` |
{{/capability}}
{{#capability dispatch_target}}
| `orchestrator:plan` | The work naturally splits into 2+ independently completable deliverables, PRs, branches, owners, or dependency edges. | `/orchestrator:plan` or `$orchestrator:plan` |
{{/capability}}
{{^capability dispatch_target}}
| `orchestrator:plan` | The work naturally splits into 2+ independently completable deliverables, PRs, branches, owners, or dependency edges. The orchestrator plans the program but dispatches its subtasks into engineer only, so a {{deliverable_noun}} inside it runs through `/{{persona}}:start` on its own branch. | `/orchestrator:plan` or `$orchestrator:plan` |
{{/capability}}
| `runtime:worktree` | The next slice should be isolated because the current checkout is dirty, long-running, risky, or parallelizable. | `/runtime:worktree plan` or `$runtime:worktree` |
| `runtime:*` | The problem is host readiness, plugin install/update, context handoff, or workflow storage. | `/runtime:doctor`, `/runtime:settings`, `/runtime:context` or Codex equivalents |
| Single verb | The user only needs investigation, framing, decision support, composition, critique, or refinement without lifecycle state. | `/{{persona}}:<verb>` or `${{persona}}:<verb>` |

The recommendation must include the selected route, the rejected
alternatives that were plausible, and the next command to run.
