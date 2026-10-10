### Owner gates

A genuine owner judgment ends a verb with an owner gate instead of a terminal
write. The verb records the judgment in its phase note under the heading the
table names, then its last write is `finish-verb --next-step-kind
owner-decision --owner-gate <gate> --owner-gate-anchor <anchor>`: the gate
and the next step in one write, with the workflow left open. Recording a gate
turns an inherited terminal marker off, the Stop hook never archives a
workflow with a gate pending (on its branch or in the off-branch sweep), and
the session handoff names the gate's resolving surface as the next action.

| gate | set when | heading · anchor | resolved by |
|---|---|---|---|
| `decide-conflict` | `/{{persona}}:decide` leaves the decision to the owner: a CONFLICT remained (recorded with its run id) or a veto gate is unresolved | `Ensemble synthesis` · `ensemble-synthesis` | the owner's selection in `/{{persona}}:decide` (its Owner selection step clears the gate) |
| `peer-conflict` | `/{{persona}}:critique` or `/{{persona}}:investigate`: the synthesis verdict is `conflict` (recorded with its run id) | `Ensemble synthesis` · `ensemble-synthesis` | the owner rules on the contested items, then `awaiting-owner-clear --gate peer-conflict --resolution-file <the ruling's file>` with the next step |
| `recurring-finding` | `/{{persona}}:refine`: a finding an earlier refine pass on this workflow already addressed survives verification again | `Recurring finding` · `recurring-finding` | the owner's fix-now-or-defer in `/{{persona}}:refine` (its Owner decision step clears the gate) |
| `scope-routing` | a verb concludes the request does not belong in this verb or workflow (another route in the Routing Recommendation fits) | `Routing recommendation` · `routing-recommendation` | the owner picks the route, then `awaiting-owner-clear` with the next step |
{{#capability commit_surface}}
| `staging-set` | `/{{persona}}:commit` under autopilot (with `dispatch_target` on, the one path that records it): the staging set needs the owner | `Phase 7 plan` · `phase7-plan` | interactive `/{{persona}}:commit`, which clears it once the owner confirms the set |
{{/capability}}
{{#capability dispatch_target}}
| `pr-handling` | under autopilot, the task itself needs an outward action: a push, a pull request, a release or an issue | `Outward action needed` · `pr-handling` | the owner takes or declines the action, then `awaiting-owner-clear` with the next step |
{{/capability}}

`state.mjs awaiting-owner-clear --gate <gate> --resolution-file <the decision's
file> --next-step-kind … --next-step-confidence … [--next-step-verb …]
--next-action-file <the next action's file>` records the owner's decision,
clears the gate, names the next step and replaces the gate's `Owner: …` next
action in one write; it refuses, writing nothing, when the gate set on the
workflow is another one. The decision and the next action are text: each
reaches `state.mjs` as a file written with the file-writing tool into a
private `mktemp -d` directory, never on the command line (ADR-0059,
amendment of 2026-10-10).
Inside a `/{{persona}}:start` lifecycle, decide's Owner selection records no
next step instead (`--clear-next-step true`): the lifecycle owns its phase
order.
{{^capability commit_surface}}
`staging-set` belongs to a commit command, and {{persona}} declares
`commit_surface` off, so `state.mjs` refuses to set it, naming the capability.
{{/capability}}
{{^capability dispatch_target}}
`pr-handling` belongs to autopilot dispatch, and {{persona}} declares
`dispatch_target` off, so `state.mjs` refuses to set it, naming the
capability; an inherited `AGENTIC_AUTOPILOT` changes nothing a {{persona}}
command writes (ADR-0066 Decision 3).
{{/capability}}
Reading a workflow file, `state.mjs` accepts all six gate names (ADR-0066
Decision 7 validates each schema 1.4 key on its own).

**The conflict gates and their consensus task file (ADR-0067 Decision 8).**
`decide-conflict` and `peer-conflict` are the conflict gates. On a synthesis
verdict of `conflict` the verb writes the contested items to
`.agentic-plugins/state/{{persona}}/consensus/<workflow id>.<run id>.md`, in
the workflow's own home (`state.mjs consensus-task`, which refuses unless
`ensemble_results` holds the run with the verdict `conflict`), and records the
gate with that run id, `awaiting_owner_run_id` (`finish-verb
--owner-gate-run-id`, or `awaiting-owner-set --run-id` inside a lifecycle).
The file is current only while the gate names the run, `ensemble_results`
holds that run with the verdict `conflict`, and the file exists
(`state.mjs consensus-proposal`). A gate set without a run id (an owner
selection, a veto) deletes the key; a gate set again over itself that names
another run, or none, and every clear retire the file of the run they
replace, renamed `<workflow id>.<run id>.resolved.md` and kept as evidence.
The proposal selects the owner's decision after a bounded consensus round,
`/runtime:consensus plan --task-file <the file's absolute path> --peers
claude,codex --max-rounds 2`, which the owner runs; nothing runs it
automatically.
