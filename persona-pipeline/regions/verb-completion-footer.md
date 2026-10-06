{{^capability commit_surface}}
The runtime completion footer is **code-emitted** on this verb's terminal
path (ADR-0039, enabled for {{persona}} by ADR-0043): the terminal write
(`state.mjs finish-verb`, which takes `set-terminal`'s path) fires the
ADR-0031 session-handoff sidecar, which shells out
to the runtime `footer.mjs` and prints the rendered footer — context
state, completion state ({{persona}}'s manually-published mapping surfaces
`publish-needed` when only the owner's save/commit remains) + state-derived
next action, workflow id/path, artifact pointers, recommended next work,
and the continue-vs-fresh session-handoff — on that command's **stderr**.
{{/capability}}
{{#capability commit_surface}}
The runtime completion footer is **code-emitted** on this verb's terminal
path (ADR-0039): the terminal write (`state.mjs finish-verb`, which takes
`set-terminal`'s path) fires the ADR-0031 session-handoff sidecar, which
shells out to the runtime `footer.mjs` and prints the rendered footer —
context state, completion state (`blocked`, with the commit as its
unblocking action, when only the commit remains) + state-derived next action,
workflow id/path, artifact pointers, recommended next work, and the
continue-vs-fresh session-handoff — on that command's **stderr**.
{{/capability}}
Do **not** hand-compose a second footer; surface the one the terminal
command already emitted. The footer is advisory + pointer-only and
fail-closed (a missing/too-old runtime emits nothing, and the SessionStart
backstop still re-surfaces the handoff); it never mutates host session
context. Detached HEAD never auto-recommends a fresh session (ADR-0018
§sub-2; the branch-based preflight is what reports "no active branch
context" — the path-targeted terminal sidecar still renders normally).
{{#capability dispatch_target}}
Under an autopilot run `finish-verb` makes no terminal write, so no footer is
printed: the driver is the handoff.
{{/capability}}
Wiring details:
`core/skills/_shared/references/session-handoff.md`.
