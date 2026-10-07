Run by `/{{persona}}:{{verb}}`, the command's last write, `state.mjs
finish-verb`, records this proposal's closed-enum form — `next_step_kind`,
`next_step_verb` and `next_step_confidence` (ADR-0063 D6;
`../_shared/references/entry-routing-contract.md` § Active Next-Action
Proposal); the fields are host-shared. Unless it ends with an owner gate, that
write is terminal. Inside `/{{persona}}:start` no phase makes a verb's
terminal write: the lifecycle makes its one terminal write at its end. A
standalone skill invocation writes no workflow state and emits no footer.
The owner gates, and the step that resolves each:
`../_shared/references/entry-routing-contract.md` § Owner gates.
{{#capability dispatch_target}}

Autopilot mode, which changes the ceremonies and leaves the terminal marker
unset, is Claude-only (ADR-0063); ignore it on Codex. Under an autopilot run
`finish-verb` writes the next step only and leaves the terminal marker for the
commit command, which alone closes a workflow there, so no footer is printed:
the driver is the handoff.
{{/capability}}

The runtime completion footer is **code-emitted** on that terminal write
(ADR-0039): its completion state is
{{^capability commit_surface}}
`publish-needed` when only the owner's save and commit remain, since
{{persona}} runs no commit itself.
{{/capability}}
{{#capability commit_surface}}
`blocked`, with the commit as its unblocking action, when only the commit
remains — `/{{persona}}:commit` commits the change, or closes the workflow
when there is none.
{{/capability}}
The write fires the session-handoff sidecar, which renders the runtime
`footer.mjs`, the ADR-0031 continue-vs-fresh session handoff included, on that
command's stderr. Do not hand-compose a second footer or hand-pass the
projection; surface the emitted one. On a detached HEAD the branch-based
preflight reports "no active branch context" and never recommends a fresh
session (ADR-0018 §sub-2); the path-targeted terminal sidecar renders the
footer as on a branch, its continue-vs-fresh advice included.
`${{persona}}:{{verb}}` on Codex surfaces the footer as
`/{{persona}}:{{verb}}` does. Wiring:
`core/skills/_shared/references/session-handoff.md`.

On Claude the Stop hook fires at **every turn end**, so that terminal write puts
the workflow in front of the archive gates at the end of **that same turn**, not
at session close — it archives then if every gate passes, and otherwise stays
marked for a later Stop to re-evaluate. Clearing the marker
(`--terminal-marker false`, with set-terminal's full flag set) works only before
that Stop fires and does not restore the previous phase. On Codex the hook runs
only once the operator has trusted the plugin hooks (`/hooks`), so evaluation
waits. Full contract: `core/skills/_shared/references/session-handoff.md`
§ Archive timing.
