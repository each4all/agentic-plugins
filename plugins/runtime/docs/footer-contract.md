# Completion Footer Contract

ADR-0024 defines a standard completion footer for persona completion
surfaces; the workflow-projection seam behind it models the four personas
— engineer, orchestrator, founder, and designer (ADR-0043 §1). The footer
is a runtime-owned advisory surface: it helps the user decide whether to
continue, pause, or start a fresh session, but it does not mutate host
session context or workflow state.

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

**ADR-0039 (now-active wiring).** As of ADR-0039 the helper is no longer
invoked only by hand: the completion/terminal paths of the personas whose
ADR-0043 onboarding has landed **code-emit** it (ADR-0043 §5 tracks the
per-persona rollout; the projection seam accepts all four kinds either
way, so a not-yet-onboarded persona simply emits nothing). The
onboarded persona's ADR-0031 session-handoff sidecar shells out to this
`footer.mjs render` (subprocess, never an import — ADR-0010 §5) after writing the
projection, captures the child stdout, and re-emits it on the completing
command's **stderr** (the command's stdout stays a machine channel). This stays a
"script, not a command": the personas discover the runtime root
(`discoverRuntimePluginRoot`, copy-not-import), gate on `emitted===true`, guard
against double-emission, and fail closed silently on a missing/too-old runtime.
See ADR-0039, ADR-0043, and the onboarded persona's own
`skills/_shared/references/session-handoff.md` runbook (engineer's copy is
the reference implementation the other personas derive from, ADR-0043 §2).

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

Or they may select the newest non-terminal consensus run while preserving
cancelled, converged, and owner-decided runs as audit artifacts:

```bash
node <runtime-plugin-root>/scripts/footer.mjs render \
  --repo-root "$REPO_ROOT" \
  --host codex \
  --consensus-latest-open
```

Consensus lookup is read-only and mutually exclusive between
`--consensus-run-id`, `--consensus-latest`, and `--consensus-latest-open`.
The helper calls
`runtime:consensus status` internally and includes only status, run/result/
execution/progress/owner-decision/cancellation pointers, status guidance,
recommended next action, and safe follow-up commands. It does not print peer
prompts, peer raw outputs, consensus raw output, consensus body text, owner
decision text, or cancellation reason text. If the caller did not provide
`--recommended-next-work`, consensus `next_action` becomes the footer's
recommended next work.

Without a context artifact, callers may supply `--context-state`,
`--completion-state`, `--completion-reason`, `--completion-next-action`,
`--artifact`, `--next-session-action`, `--next-session-command`, and
`--next-session-prompt-pointer` directly.

### Context state and its measurement provenance

Runtime performs **no automatic host-context measurement**. The risk value and
the basis for that value are therefore different questions, and the footer
reports them on two independent axes. The risk enum stays `green | yellow | red`;
provenance is never expressed as an extra enum member, so every consumer that
switches on the risk keeps working.

| | `context_state_measurement` | `context_state_origin` | Rendered as |
|---|---|---|---|
| `--context-state green --context-state-source measured` | `measured` | `caller` | `context state: green` |
| `--context-state yellow` (no source flag) | `unmeasured` | `caller` | `context state: yellow [declared, not measured]` |
| `--context-run-id …` (artifact-recorded `risk_level`) | `unknown` | `context-artifact` | `context state: green [recorded in the context artifact; measurement basis not recorded]` |
| nothing supplied | `unmeasured` | `runtime-default` | `context state: unmeasured (no budget sensor)` |

**The two axes are deliberately not collapsed.** A context artifact records a
`risk_level` but nothing that says whether that level was measured, declared, or
itself defaulted — `captureContext` stores `yellow` both when `--risk` is omitted
and when `yellow` is supplied. Its *origin* is knowable; its *measurement basis*
is not. Reporting an artifact value as `measured` would launder a stored default
into a measurement claim, and reporting it as `unmeasured` would be equally
unsupported, so `unknown` is the only honest answer the record permits.

**`measured` is caller-attested, not runtime-verified.** Runtime cannot check
that a measurement happened; `--context-state-source measured` records the
caller's assertion and nothing more.

**There is no caller-selectable `default`.** The honest way to say "I measured
nothing" is to pass no value at all — which needs no flag, and therefore no
runtime version floor for a consumer that wants to become honest. A selectable
default would also have permitted `--context-state red --context-state-source
default`, splitting the `red` that drives PR readiness and completion inference
from the `yellow` the session handoff re-derives. `--context-state-source`
accepts `measured` or `declared`, and requires `--context-state` — a provenance
claim needs a value to attach to.

Three consequences worth knowing:

- **An unmeasured default renders as unmeasured in text and in JSON.** The text
  line replaces the value rather than annotating it, so a fallback cannot be
  read as an observation. JSON keeps `context_state` as the effective enum — it
  is still what the rest of the footer reasoned with — and adds
  `context_state_measurement`, `context_state_origin`, and
  `context_state_report`.
- **An unmeasured default is reported to the session handoff as unsupplied.**
  `session_handoff.context_risk_supplied` is `false` and the rendered handoff
  names the fallback explicitly. The continue-vs-fresh decision is unchanged —
  the conservative yellow still drives it. The supply fact travels to
  `evaluateSessionHandoff` on its own `riskSupplied` parameter rather than by
  passing `riskLevel: null`, because an absent risk collides with that
  evaluator's all-inputs-absent early return and would drop `session_handoff`
  entirely — which every persona sidecar reads as fail-closed, rendering no
  footer at all.
- **Artifact prose is never echoed into the footer.** `context.json` is
  user-editable and is not schema-validated here, so a crafted multi-line
  `risk_reason` could forge footer lines. Every provenance string the footer
  renders is runtime-authored; the artifact stays a pointer, per the footer's
  pointer-only contract.

An artifact that records no `risk_level` is reported as `runtime-default`, not as
`context-artifact` — reading an absent risk as a recorded one would manufacture
exactly the fabricated value this contract exists to expose.

This is an honesty contract, not a sensor: nothing here measures context usage.
A real read-only budget sensor remains separate, future work.

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
actionable consensus guidance, recorded owner-decision guidance, or
caller-supplied recommended next work, and `review-needed` when evidence is
incomplete. It does not infer
`cleanup-needed` or `closed`; callers must supply `--completion-state` for
those outcomes. A caller that emits `closed` is asserting that PR, release,
installed-state, cleanup, and planned follow-up evidence has already been
checked outside the footer.

Completion provenance is reported per field
([`completion-output-contract.md`](completion-output-contract.md)):
`completion.sources` classifies state/reason/next-action as
`explicit | derived | generic` (the legacy coarse `completion.source` is
frozen), `recommended_next_work_source` does the same for the recommended
next work, and text output suffixes ` [generic fallback]` onto any
completion surface whose value is a no-evidence runtime template — silent
degradation never renders indistinguishable from caller-authored content.
That contract also fixes the minimum content callers must pass in
`--completion-reason` / `--recommended-next-work` /
`--completion-next-action`.

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

The context-risk criterion reads the **resolved** risk, so an unmeasured default
is evaluated as its conservative `yellow` (a pass) exactly as before — this
change does not alter any PR-readiness decision. The criterion additionally
carries the `measurement` axis, so an `ask-user` verdict cannot present a
never-measured fallback as observed evidence.

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
- Pointer-only: raw peer output, consensus raw output, prompt bodies, owner
  decision text, cancellation reason text, and large artifacts stay in
  runtime-owned files.
- Consensus status is advisory only: no peer execution, synthesis,
  next-round planning, or artifact mutation happens through the footer.
- Existing persona workflow state remains in its current storage; this
  contract is not a migration path.
- Codex plugin-hook and permission limits remain explicit and are not
  represented as host parity.
