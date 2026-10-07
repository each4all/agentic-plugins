The lifecycle's one terminal write is the Phase 7 driver in execute mode
(`phase7-commit.mjs`): it commits, runs the post-commit gates and the P10
parent writeback, and writes `set-terminal` last; no `finish-verb` runs. The
driver writes the marker itself, so decide before running execute mode whether
the workflow may close in this turn (the archive timing below).

The runtime completion footer is **code-emitted** on that terminal write
(ADR-0039).
The write fires the session-handoff sidecar, which renders the runtime
`footer.mjs`, the ADR-0031 continue-vs-fresh session handoff included, on that
command's stderr. It is advisory and pointer-only, and never mutates host
session context. The workflow is then terminal, and the Stop hook archives it
once every archive gate passes; until then `/{{persona}}:start` on this branch
finds it and resumes it, so start the next deliverable after the archive, or
on another branch. Do not hand-compose a second footer or hand-pass the
projection; surface the emitted one. On a detached HEAD the branch-based
preflight reports "no active branch context" and never recommends a fresh
session (ADR-0018 §sub-2); the path-targeted terminal sidecar renders the
footer as on a branch, its continue-vs-fresh advice included.
`${{persona}}:start` on Codex surfaces the footer as `/{{persona}}:start`
does. Wiring: `core/skills/_shared/references/session-handoff.md`.

On Claude the Stop hook fires at **every turn end**, so that terminal write puts
the workflow in front of the archive gates at the end of **that same turn**, not
at session close — it archives then if every gate passes, and otherwise stays
marked for a later Stop to re-evaluate. Clearing the marker
(`--terminal-marker false`, with set-terminal's full flag set) works only before
that Stop fires and does not restore the previous phase. On Codex the hook runs
only once the operator has trusted the plugin hooks (`/hooks`), so evaluation
waits. Full contract: `core/skills/_shared/references/session-handoff.md`
§ Archive timing.
