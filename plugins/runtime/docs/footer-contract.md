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

When a completion surface is continuing or finishing runtime consensus work,
it may include the current consensus run id, status, artifact pointers, and
bounded `runtime:consensus status` guidance.

When a completion surface has enough local evidence, it may also include
PR handling readiness. This is a decision aid for asking the user what to
do next; it does not commit, push, open, update, merge, or mark any PR
ready for review.

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
It also reports the same read-only handoff lookup and guidance used by
`runtime:context status`: age/stale metadata, source-freshness metadata,
guidance state, recommended session shape, recommended action, and safe
follow-up commands.

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
skipped invalid artifacts, source-freshness state when the context artifact
contains a git source snapshot, and handoff guidance). It is mutually
exclusive with `--context-run-id`. Source freshness is read-only: the
helper compares the artifact's recorded git commit and dirty state with the
current git commit and dirty state when both are available, reports `unknown`
otherwise, and never mutates git or host session context. Guidance is advisory
only: it may recommend reusing the handoff, inspecting unverifiable source
state, capturing new context, or settling a dirty current or dirty-captured
worktree before capture, but the footer does not perform any of those actions.

Callers that want to surface consensus progress may use an explicit run id:

```bash
node <runtime-plugin-root>/scripts/footer.mjs render \
  --repo-root "$REPO_ROOT" \
  --host codex \
  --consensus-run-id "$CONSENSUS_RUN_ID" \
  --workflow-kind orchestrator \
  --workflow-id "$WORKFLOW_ID"
```

Or they may select the newest readable consensus run by manifest freshness:

```bash
node <runtime-plugin-root>/scripts/footer.mjs render \
  --repo-root "$REPO_ROOT" \
  --host codex \
  --consensus-latest
```

Consensus lookup is read-only and mutually exclusive between
`--consensus-run-id` and `--consensus-latest`. The helper calls
`runtime:consensus status` internally and includes only status, run/result/
execution/progress pointers, status guidance, recommended next action, and
safe follow-up commands. It does not print peer prompts, peer raw outputs,
consensus raw output, or consensus body text. If the caller did not provide
`--recommended-next-work`, consensus `next_action` becomes the footer's
recommended next work.

Without a context artifact, callers may supply `--context-state`,
`--artifact`, `--next-session-action`, `--next-session-command`, and
`--next-session-prompt-pointer` directly.

### PR handling readiness

Callers should include PR handling fields only after the work itself has
reached a completion boundary. The helper returns `ask-user` only when all
readiness criteria pass:

| Criterion | Pass values | Blocking values |
|---|---|---|
| deliverable boundary | `--pr-completion-boundary reached` | `not-reached` |
| validation | `--pr-validation-state passed` or `waived` | `failed` or `not-run` |
| context risk | `--context-state green` or `yellow` | `red` |
| blocking reviews | `--pr-review-state clear` | `blocking` |
| branch state | `--pr-branch-state pushable` | `not-pushable` |

Any `unknown` criterion returns `defer`; an explicit blocking value returns
`block`. Only `ask-user` means the host should ask the user whether to
commit, push, and open a PR now; continue without PR; or defer PR handling.

Example:

```bash
node <runtime-plugin-root>/scripts/footer.mjs render \
  --repo-root "$REPO_ROOT" \
  --host codex \
  --workflow-kind engineer \
  --workflow-id "$WORKFLOW_ID" \
  --context-state yellow \
  --pr-handling \
  --pr-completion-boundary reached \
  --pr-validation-state passed \
  --pr-review-state clear \
  --pr-branch-state pushable
```

## Boundaries

- Advisory only: no automatic context mutation, compaction, host switch, or
  workflow start.
- PR handling readiness is advisory only: no automatic commit, push, PR
  creation, PR metadata update, merge, or ready-for-review transition.
- Pointer-only: raw peer output, consensus raw output, prompt bodies, and
  large artifacts stay in runtime-owned files.
- Consensus status is advisory only: no peer execution, synthesis,
  next-round planning, or artifact mutation happens through the footer.
- Existing engineer and orchestrator workflow state remains in its current
  storage; this contract is not a migration path.
- Codex manual-hook and permission limits remain explicit and are not
  represented as host parity.
