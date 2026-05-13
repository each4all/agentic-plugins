# Completion Footer Contract

ADR-0024 defines a standard completion footer for engineer and
orchestrator completion surfaces. The footer is a runtime-owned advisory
surface: it helps the user decide whether to continue, pause, or start a
fresh session, but it does not mutate host session context or workflow
state.

## Required fields

Every footer contains:

- context state: `green`, `yellow`, or `red`;
- workflow kind, id, and repo-relative workflow path when known;
- artifact pointers, including a runtime context artifact pointer when one
  exists;
- recommended next work;
- next-session action;
- exact next-session command or prompt pointer when available;
- limits stating that the footer is advisory and pointer-only.

## Helper

The helper is intentionally a script, not a new public runtime command:

```bash
node <runtime-plugin-root>/scripts/footer.mjs render \
  --repo-root "$REPO_ROOT" \
  --host claude \
  --workflow-kind engineer \
  --workflow-id "$WORKFLOW_ID" \
  --workflow-path "$WORKFLOW_PATH" \
  --context-run-id "$CONTEXT_RUN_ID" \
  --recommended-next-work "Open the PR and wait for CI."
```

If `--context-run-id` is supplied, the helper reads:

```text
.agentic-plugins/runs/context/<run-id>/context.json
```

It uses only the context risk level, artifact pointers, recommended
action, and next-session prompt pointer. It does not print the context
summary body or the next-session prompt body.

Callers that want the newest existing handoff without creating or updating
context may use `--context-latest`:

```bash
node <runtime-plugin-root>/scripts/footer.mjs render \
  --repo-root "$REPO_ROOT" \
  --host codex \
  --context-latest \
  --stale-after-hours 12 \
  --workflow-kind engineer \
  --workflow-id "$WORKFLOW_ID" \
  --workflow-path "$WORKFLOW_PATH" \
  --recommended-next-work "Continue from the latest handoff pointer."
```

`--context-latest` selects the newest readable
`.agentic-plugins/runs/context/<run-id>/context.json` artifact and reports
lookup metadata (`mode`, `selected_at`, age, stale state, stale threshold,
and skipped invalid artifacts). It is mutually exclusive with
`--context-run-id`.

Without a context artifact, callers may supply `--context-state`,
`--artifact`, `--next-session-action`, `--next-session-command`, and
`--next-session-prompt-pointer` directly.

## Boundaries

- Advisory only: no automatic context mutation, compaction, host switch, or
  workflow start.
- Pointer-only: raw peer output, consensus raw output, prompt bodies, and
  large artifacts stay in runtime-owned files.
- Existing engineer and orchestrator workflow state remains in its current
  storage; this contract is not a migration path.
- Codex manual-hook and permission limits remain explicit and are not
  represented as host parity.
