This lifecycle closes only once Phase 4 converged
(`terminal_requires_convergence`). Set `CONVERGED` in the block to `yes` only
when the Phase 4 re-critique converged; anything else, an unset value
included, reads as not converged. Converged, the last write is `finish-verb`.
Not converged, the last write is an `append` that records the next step
resolving the flagged item (`refine`, `decide` or `investigate`) and turns off
a terminal marker an earlier write left, so the workflow stays open and the
Stop hook cannot archive it.

The last write, `finish-verb`, records the lifecycle's next step in
closed-enum form, `--next-step-kind commit`: the owner saves and commits the
deliverable ({{persona}} runs no commit itself). It closes the workflow
`summary-complete`, and the code-emitted completion footer follows.

```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# FAIL-CLOSED: shell state does not survive between Bash calls, so a
# CONVERGED set in the Phase 4 block is gone here, and an unset value reads as
# not converged, never as success. Assign it here, from the Phase 4 result.
CONVERGED="<yes|no — from the Phase 4 re-critique verdict; unset means no>"
if [ "${CONVERGED:-no}" = "yes" ]; then
  # ADR-0029 §1 / completion-output contract §2 — write the COMPACT form
  # (selected_next + one-line why + next_command) into --next-action; the
  # code-emitted footer surfaces it verbatim as "recommended next work".
  # ADR-0063 D3 — finish-verb is the lifecycle's last write: the ADR-0017
  # §sub-decision 5 atomic terminal write (summary-complete + terminal marker)
  # with the next step. ADR-0066 Decision 3: an inherited AGENTIC_AUTOPILOT
  # changes nothing here.
  # ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
  # archive gates are evaluated at the end of THIS turn, not at session close;
  # if a gate fails the workflow stays marked and a later Stop re-evaluates it.
  # Clearing the marker with `--terminal-marker false` works only before that
  # Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
  # --terminal-phase), and does not restore the previous phase or next_action.
  # On Codex the Stop hook runs only once the operator has trusted the plugin
  # hooks (`/hooks`), so evaluation waits for that. Full contract:
  # core/skills/_shared/references/session-handoff.md § Archive timing.
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --next-action {{next_action}} \
    --next-step-kind commit --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
else
  # Not converged: the workflow stays open, with the next step that resolves
  # the flagged item, and a terminal marker an earlier write left turned off.
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --next-action '<Paused: the flagged item, and the next step that resolves it>' \
    --next-step-kind verb --next-step-verb "<refine|decide|investigate>" \
    --next-step-confidence "<HIGH|MEDIUM|LOW>" \
    --clear-terminal-marker true --event updated || exit $?
  echo "→ PAUSED (not converged): the workflow stays open, not terminal. Resolve the flagged item, then run the next step recorded above." >&2
fi
```
