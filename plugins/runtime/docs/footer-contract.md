# Completion Footer Contract

ADR-0024 defines a standard completion footer for engineer and
orchestrator completion surfaces. The footer is a runtime-owned advisory
surface: it helps the user decide whether to continue, pause, or start a
fresh session, but it does not mutate host session context or workflow
state.

## Required fields

Every footer contains:

- context state: `green`, `yellow`, or `red`;
- completion state: `review-needed`, `publish-needed`, `cleanup-needed`,
  `next-work-available`, `blocked`, or `closed`;
- completion reason and state-derived next action;
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

When a completion surface is part of the omcc cutover dogfood loop, it may
also include cutover record guidance. This is a pointer-only suggestion for
the exact `runtime:cutover record` command the operator can run after
confirming the footer state and omcc-dev activity evidence. The footer does
not write cutover evidence itself.

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
action, next-session prompt pointer, and host-specific handoff commands.
It does not print the context summary body or the next-session prompt body.
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
`--completion-state`, `--completion-reason`, `--completion-next-action`,
`--artifact`, `--next-session-action`, `--next-session-command`, and
`--next-session-prompt-pointer` directly.

### Completion state

The helper emits a completion-state contract so callers can guide the next
action without guessing:

| State | Meaning |
|---|---|
| `review-needed` | Evidence, validation, context, or review state still needs inspection before choosing the next command. |
| `publish-needed` | Work is ready for a user decision about commit, push, PR creation/update, or deferring publish. |
| `cleanup-needed` | The next action is cleanup of merged branches, stale worktrees, plugin/cache drift, or release follow-ups. |
| `next-work-available` | The current slice has an actionable next command or follow-up. |
| `blocked` | A validation, review, permission, sandbox, auth, owner-decision, or other operator precondition is blocking progress. |
| `closed` | No repo, PR, release, cleanup, or planned follow-up action remains. |

Inference is intentionally conservative. The helper can infer
`publish-needed` from passing PR handling readiness, `blocked` from failed
PR handling or blocking consensus guidance, `next-work-available` from
actionable consensus guidance or caller-supplied recommended next work, and
`review-needed` when evidence is incomplete. It does not infer
`cleanup-needed` or `closed`; callers must supply `--completion-state` for
those outcomes. A caller that emits `closed` is asserting that PR, release,
installed-state, cleanup, and planned follow-up evidence has already been
checked outside the footer.

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

### Cutover record guidance

Callers may request cutover record guidance when a completed slice should
count toward the one-week omcc-dev-free dogfood ledger:

```bash
node <runtime-plugin-root>/scripts/footer.mjs render \
  --repo-root "$REPO_ROOT" \
  --host codex \
  --completion-state next-work-available \
  --completion-reason "release/install loop complete; R4 remains open" \
  --cutover-record \
  --cutover-omcc-dev-active no \
  --cutover-omcc-dev-note "runtime-only dogfood" \
  --cutover-dogfood-date 2026-05-16
```

If `--cutover-omcc-dev-active yes|no|unknown` is present, the helper emits
a host-localized `runtime:cutover record` command containing the current
completion state, completion reason, omcc-dev activity statement, optional
activity note, and optional dogfood date. If the activity statement is
missing, the helper reports `needs-operator-evidence` and emits no command.

The generated command is advisory. Operators must only record
`--omcc-dev-active no` when the current work session actually avoided
omcc-dev. Recording remains an explicit `runtime:cutover record` action that
writes sanitized cutover evidence under `.agentic-plugins/runs/cutover/`.

## Boundaries

- Advisory only: no automatic context mutation, compaction, host switch, or
  workflow start.
- PR handling readiness is advisory only: no automatic commit, push, PR
  creation, PR metadata update, merge, or ready-for-review transition.
- Cutover record guidance is advisory only: no automatic dogfood evidence
  write and no automatic omcc-dev activity declaration.
- Pointer-only: raw peer output, consensus raw output, prompt bodies, and
  large artifacts stay in runtime-owned files.
- Consensus status is advisory only: no peer execution, synthesis,
  next-round planning, or artifact mutation happens through the footer.
- Existing engineer and orchestrator workflow state remains in its current
  storage; this contract is not a migration path.
- Codex plugin-hook and permission limits remain explicit and are not
  represented as host parity.
