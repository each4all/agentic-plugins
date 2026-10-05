If the baseline commit object is available, append a `host_history` entry
via `state.mjs append --event resumed` — host-flag is `claude` or `codex`
per the runtime invoking this skill. **Skip** the marker append when the
baseline is invalid (re-validate here because shell-variable state from
Phase 2 may not survive across Bash invocations).

Do NOT bump `current_phase` or `next_action` — the resume marker is purely a
host-history append. The user (or the next verb skill / `{{persona}}:start`)
controls phase progression.
