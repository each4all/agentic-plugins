If the baseline commit object is available, append a `host_history` entry
via `state.mjs append --event resumed` — host-flag is `claude` or `codex`
per the runtime invoking this skill. **Skip** the marker append when the
baseline is invalid (re-validate here because shell-variable state from
Phase 2 may not survive across Bash invocations).
{{#capability dispatch_target}}
Pass `--once-operation resume` with it: on a macro's child the marker is this
skill's one write, an operation of one write that is refused beside another
operation open in its lane (ADR-0068 Decision 2, item 7).
{{/capability}}

Do NOT bump `current_phase` or `next_action` — the resume marker is purely a
host-history append. The user (or the next verb skill / `{{persona}}:start`)
controls phase progression.
