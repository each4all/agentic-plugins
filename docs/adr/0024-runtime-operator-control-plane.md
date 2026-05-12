# ADR-0024: Runtime operator control plane

## Status

Accepted (2026-05-13, PR #91)

## Context

Stage 2 and the Stage 2.5+ cascade made `plugins/engineer` and
`plugins/orchestrator` usable as agentic-plugins' own development
surfaces. The remaining friction is no longer another persona domain by
default. The immediate gap is operational:

- Is this host actually usable?
- Are Claude Code, Codex CLI, and the required plugins installed?
- Is each host authenticated?
- Which model and effort settings will a companion actually use?
- Can Codex invoke Claude safely under the current sandbox / permission
  posture?
- How should many peer/subagent perspectives be launched without
  flooding the main session context?
- When peers disagree, what loop drives them toward agreement instead
  of merely listing opinions?
- After a workflow completes, should the user continue in the current
  session or start a fresh one, and with what command or prompt?

These questions are shared by `engineer` and `orchestrator`. Duplicating
them inside each plugin would recreate the workflow-runtime drift that
ADR-0010's Layer 1 `runtime` placeholder was meant to avoid.

At the same time, the `companions` plugin must remain a script-only
library per ADR-0008. Adding user-facing `doctor` or `settings` commands
there would violate the narrow library-plugin exception and blur the
companion wire contract with host-operator concerns.

The planned `plugins/designer` work is not the immediate Stage 3 focus.
ADR-0012 condition 3 still requires accumulated non-trivial
engineer-driven dogfood, but that evidence may come from any Stage 3+
workflow that is substantial enough to exercise the system end to end.
The runtime/operator track is the next such candidate.

## Decision

### 1. Stage 3+ immediate track

The immediate Stage 3+ dogfood track is **runtime/operator control
plane**, not `plugins/designer`.

`plugins/designer` remains a possible future L3 persona, but it is no
longer the active next-step trigger for ADR-0012 condition 3. A
non-trivial runtime/operator workflow completed through
`/engineer:start`, `$engineer:start`, or `/orchestrator:plan` without an
`omcc-dev` escape hatch is valid evidence toward condition 3.

### 2. New plugin boundary

When implemented, the operator surface lives in a new
`plugins/runtime` package:

- Layer: **L1 framework primitive** per ADR-0010.
- Role: shared host/runtime readiness, settings, peer policy, and
  context-hygiene infrastructure for multiple higher-layer plugins.
- Initial user surfaces:
  - `/runtime:doctor` and `$runtime:doctor`
  - `/runtime:settings` and `$runtime:settings`

`plugins/runtime` may expose user-facing operator commands even though it
is an L1 primitive. The distinction is role-based: the plugin owns
cross-plugin infrastructure and host-runtime truth, not persona work or
domain reasoning.

### 3. `doctor` surface

`runtime:doctor` is read-only by default. It reports:

- host CLI availability and versions (`claude`, `codex`)
- host feature surface relevant to plugins, hooks, subagents, and
  companions
- authentication state without exposing account secrets
- marketplace and plugin install/cache state for `companions`,
  `engineer`, `orchestrator`, and `runtime`
- companion discovery and contract compatibility
- optional deep peer smoke checks behind an explicit flag
- current and resolved model / effort settings for each host and peer
  direction
- sandbox / permission readiness for Codex -> Claude and Claude ->
  Codex companion invocation
- workflow and peer-run ledger health, including stale or orphaned runs

Doctor output must distinguish **unavailable**, **not installed**,
**installed but unauthenticated**, **installed but blocked by sandbox or
permissions**, and **available**.

### 4. `settings` surface

`runtime:settings` is dry-run by default. Any mutation requires an
explicit apply flag.

It may assist with:

- installing or updating agentic-plugins marketplace entries
- installing or updating `companions`, `engineer`, `orchestrator`, and
  `runtime`
- checking or recommending Claude Code and Codex CLI installation
- writing agentic-plugins model / effort / peer-routing defaults
- generating host-native commands or config edits when direct mutation
  would be too risky

It must not automate authentication, write secrets, or silently relax
sandbox / permission boundaries. Host-native config writes require an
explicit host-config apply mode; otherwise settings writes only
agentic-plugins-owned config.

### 5. Configuration and state paths

Host-required plugin surfaces stay host-native:

- `.claude-plugin/` for Claude marketplace / plugin metadata
- `.codex-plugin/` for Codex plugin metadata
- `.agents/plugins/` for the Codex marketplace catalog

Repo-local runtime configuration may use:

```text
<repo>/.agentic-plugins/config.toml
<repo>/.agentic-plugins/runs/
```

User-global runtime configuration may use:

```text
~/.agentic-plugins/config.toml
```

Existing workflow files under `<repo>/.claude/agentic-*` remain the
compatibility source of truth for `engineer` and `orchestrator` until a
separate migration ADR changes that. `.agentic-plugins` is for new
runtime/operator config and run artifacts first, not an implicit rewrite
of established workflow storage.

### 6. Model and effort resolution

Runtime-owned defaults resolve in this order:

1. explicit command flags
2. workflow/subtask override
3. repo-local `.agentic-plugins/config.toml`
4. user-global `~/.agentic-plugins/config.toml`
5. host-native default

Companion invocation continues to use the existing
`companions/contract.md` `--model` and `--effort` options. The runtime
layer records the **resolved** values in handles, ledgers, and summaries
where possible, while preserving host-default behavior when values are
omitted.

### 7. Dynamic peer fanout and consensus loop

The framework must not hard-code a small fixed peer/subagent count as a
product limit. Instead, runtime policy is budget-driven:

- user-requested breadth
- task risk and ambiguity
- configured token/time/process budgets
- host availability and sandbox readiness
- ledger retention limits

The default loop for multiple perspectives is:

1. independent fanout
2. disagreement extraction
3. targeted rebuttal or verification prompts
4. synthesis
5. repeat until convergence or until the configured budget is exhausted

Consensus means the remaining disagreements are either resolved or
explicitly labeled as durable non-consensus with evidence and owner
decision points. Raw peer outputs stay in run artifacts; the main
session receives only the synthesized result, unresolved disagreements,
evidence pointers, and next action.

### 8. Completion footer

Engineer and orchestrator completion surfaces should converge on a
standard footer:

- context state: green / yellow / red
- raw artifacts and workflow ids
- recommended next work
- whether to continue in the current session or start a new session
- exact command or prompt to start the recommended next session

The footer is advisory. It must not auto-open new workflows or switch
hosts without explicit user intent.

### 9. Host specialization policy

Runtime policy should use each host where it is naturally strong, while
keeping host-limit honesty:

- Claude Code: command-heavy flows, hook-supported continuity, plugin
  management surfaces, and Claude-native subagent behavior.
- Codex CLI: explicit skill-driven work, repo-grounded review and
  implementation, Codex-native multi-agent/subagent behavior where
  available, and cross-host challenge/verification.
- Companions: cross-host second opinions, peer review, disagreement
  loops, and host-asymmetric validation.

Doctor must observe the current host feature surface rather than assume
parity. If a capability is unavailable, the runtime reports the limit and
offers the nearest manual path.

## Consequences

**Positive**:

- `engineer` and `orchestrator` avoid duplicating host-readiness and
  settings logic.
- The next non-trivial dogfood target is aligned with actual user pain:
  installation, auth, model/effort, sandbox, peer breadth, and context
  management.
- `.agentic-plugins` becomes available for new agentic-plugins-owned
  runtime config without pretending host-native plugin directories can
  be replaced.
- Companion model/effort handling stays inside the existing wire
  contract instead of inventing a second path.

**Negative**:

- `plugins/runtime` adds another installable package and release-please
  package once implemented.
- A user-facing L1 primitive is slightly more subtle than the current
  script-only `companions` precedent.
- Settings writes are operationally sensitive and require conservative
  dry-run/apply boundaries.

**Neutral**:

- `plugins/designer` is deferred, not rejected.
- Existing `.claude/agentic-*` workflow storage remains unchanged until
  a separate migration decision.
- ADR-0013 remains reserved for Codex command integration. Runtime can
  improve diagnosis and manual paths but must not claim plugin-hook
  parity where Codex does not provide it.

## Alternatives Considered

### Put `doctor` and `settings` into `plugins/companions`

Rejected. `companions` is intentionally a script-only library plugin.
Operator commands would break the narrow ADR-0008 exception and couple
host install/config policy to the companion wire contract.

### Put `doctor` and `settings` into `plugins/engineer`

Rejected. The problem is shared by `engineer`, `orchestrator`, and future
plugins. Making it engineer-owned would bias persona-level workflow
toward framework-level runtime truth.

### Put all operator behavior into `plugins/orchestrator`

Rejected. Orchestrator owns macro planning and cross-plugin dispatch, not
host installation, authentication diagnosis, model/effort defaults, or
global peer policy.

### Continue with documentation-only manual setup

Rejected. Manual setup remains necessary for sensitive operations, but
the user needs a reliable status surface that distinguishes missing CLI,
missing plugin, unauthenticated host, sandbox blockage, and model/effort
drift.

### Move all workflow state to `.agentic-plugins` immediately

Rejected for this ADR. `.agentic-plugins` is a good home for new
runtime-owned config and run artifacts, but workflow storage migration
has compatibility and hook implications. That change requires its own
migration ADR.
