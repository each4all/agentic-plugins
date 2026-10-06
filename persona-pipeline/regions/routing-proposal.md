## Active Next-Action Proposal (standalone verb completion)

This contract applies not only to `{{persona}}:start` lifecycle entry but
to **every standalone verb completion** (`/{{persona}}:<verb>` or
`${{persona}}:<verb>` invoked without the lifecycle macro). A verb MUST NOT
end with a fixed lifecycle-table literal (e.g. always "next:
`/{{persona}}:decide`"). It MUST instead emit an evidence-based proposal
derived from the verb's actual result and the current workflow state:

{{#capability commit_surface}}
- **selected_next**: the recommended next step — a verb, `commit`,
  `owner decision`, or `done` (the deliverable is complete and produced
  nothing to commit, e.g. an investigation or decision whose output is the
  phase note itself). Chosen from the verb's result, not from a fixed
  table.
{{/capability}}
{{^capability commit_surface}}
- **selected_next**: the recommended next step — a verb, `commit`,
  `owner decision`, or `done`, chosen from the verb's result, not from a
  fixed table. A {{persona}} workflow has no commit command: `commit` means
  the owner saves, commits or publishes the {{deliverable_noun}}, and `done`
  that nothing is left to publish (an investigation or decision whose output
  is the phase note itself). Either way the verb command's terminal write,
  `finish-verb`, records that next step and marks the workflow
  `summary-complete`, and it stays active-terminal until its archive gates
  pass (the footer reports it as `publish-needed` while only the
  HEAD-movement gate is unmet). An `owner decision` that sets an owner gate
  leaves the workflow open until the owner resolves the gate. A verb whose
  terminal write waits for a converged re-critique stays non-terminal until it
  converges, and a skill invoked on its own, outside a workflow command, writes
  no workflow state.
{{/capability}}
- **rejected_alternatives**: 1-2 plausible next steps that were
  considered, each with a one-line why-not.
- **rationale**: why `selected_next` is best, grounded in the verb's
  declared quality gate (the Standards and Root-Cause Gate below names it
  per verb).
- **evidence_pointers**: workflow phase notes, files, or artifact
  pointers that support the recommendation (pointers only — never raw
  peer output or full comparison dumps).
- **confidence**: HIGH / MEDIUM / LOW, based on available evidence.
{{#capability commit_surface}}
- **next_command**: the exact next step, matching `selected_next` — for
  a verb, the `/{{persona}}:<verb> …` (Claude) or `${{persona}}:<verb>` (Codex)
  mention; for `commit` or `done`, `/{{persona}}:commit` /
  `${{persona}}:commit`; for `owner decision`, surfacing the decision to the
  owner rather than a command to run.
{{/capability}}
{{^capability commit_surface}}
- **next_command**: the exact next step, matching `selected_next` — for
  a verb, the `/{{persona}}:<verb> …` (Claude) or `${{persona}}:<verb>` (Codex)
  mention; for `commit`, the owner's save and commit, which nothing here
  runs; for `done`, none; for `owner decision`, surfacing the decision to
  the owner rather than a command to run. There is no `/{{persona}}:commit`.
{{/capability}}

The default verb sequence (Routing Recommendation table above) remains
the **fallback** when evidence is genuinely neutral — but a fixed
literal is no longer the default output. When a verb surfaces 2+ viable
next branches, surface the compact multi-axis lens per the decision
sizing below (sized to the decision's weight, not the full matrix for a
trivial reversible step).

Anti-pattern (explicitly forbidden): **static lifecycle table** —
ending a verb with a hardcoded "next: X" instead of reasoning about the
best next action given the current result and state.

The durable `state.mjs --next-action` write SHOULD carry the compact
form (selected_next + one-line rationale + next_command); the fuller
proposal (alternatives + evidence + confidence) belongs in the
completion output and the phase note.

**Closed-enum projection: `next_step` (ADR-0063 D6, ported by ADR-0066
Stage 2).** A verb command's last write, `state.mjs finish-verb`, also
records `selected_next` and `confidence` as three flat keys. `next_action`
stays the free-text form for humans; a machine consumer reads the closed-enum
keys and never parses `next_action`.

| `selected_next` | `next_step_kind` | `next_step_verb` |
|---|---|---|
| a verb | `verb` | that verb |
| `commit` | `commit` | absent |
| `owner decision` | `owner-decision` | absent |
| `done` | `done` | absent |

`next_step_confidence` is the proposal's confidence. A verb's Phase 0 clears
the three keys when it resumes a workflow (`append --clear-next-step true`),
so a verb that stops before its last write leaves no next step behind.
