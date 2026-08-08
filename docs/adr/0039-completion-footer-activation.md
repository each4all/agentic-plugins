# ADR-0039: Completion/handoff footer activation

## Status

Accepted (2026-07-02)

<!--
Relates to ADR-0024 (runtime operator control plane — introduced the
footer + `footer.mjs`), ADR-0029 (entry-routing / Active Next-Action
Proposal), and ADR-0031 (session-level active handoff — the sidecar
projection). This ADR does not modify those decisions; it wires the
already-built `footer.mjs` render engine into the already-code-spoken
ADR-0031 sidecar terminal path. The `/runtime:footer`-command option is
explicitly rejected here, preserving footer-contract.md's "script, not a
command" posture. Founder inclusion is deferred (see Decision §7).

Flipped to Accepted 2026-07-02 on completion of the implementation series
(engineer-wire #464 → orch-wire #466 + orch-next-action-shape #467 →
acceptance), mirroring the ADR-0027/0028 status-flip-on-series-completion
precedent. Acceptance evidence: the host-free black-box acceptance gate
(tests/acceptance/test-footer-activation-acceptance.mjs) proving the
cross-persona stdout-machine-channel / footer-on-stderr / concrete-elements /
fail-closed criteria plus the ADR-0010 §5 subprocess-only import boundary.
-->

## Context

The completion/handoff report a user reads at the end of a workflow verb
or lifecycle is meant to carry, in a durable and code-generated form:
work summary, results, the recommended next action + rationale, the exact
next command, context state, a continue-vs-fresh-session recommendation,
and the both-side next-session prompts. A 4-agent framework-wide
investigation (2026-07-01) found the machinery to produce this exists and
is unit-tested, but **is not wired to any live path** — the report is
still emitted as **prose** the model writes by following SKILL.md
instructions, not as code-generated output.

**The orphaned keystone.** `plugins/runtime/scripts/footer.mjs` (L1
runtime) exports `runFooter` / `parseArgs` / `formatText`
(footer.mjs:33/156/309). `runFooter` synthesizes the full report object —
context state, completion state, continue-vs-fresh `session_handoff`,
`next_session` prompts, artifact pointers — and is exercised by
`tests/runtime/test-footer.mjs`. But **no command, skill, hook, or script
invokes it**: its only references are its own `main()` and the two test
files. `footer-contract.md:42` states the render is "intentionally a
script, not a new public runtime command," and there is no
`commands/footer.md` / `skills/footer/`. The render engine is complete
and dead.

**The code-spoken path that stops one edge short.** ADR-0031 added
`emitTerminalHandoffSidecar` (engineer `session-handoff.mjs:259`,
orchestrator `:324` — copied per-plugin per ADR-0010 §5). It **is**
code-spoken on terminal paths (engineer `state.mjs` set-terminal +
`phase7-commit.mjs:1015`; orchestrator `state.mjs` fireMacroHandoffSidecar
+ the `/done`/`/finalize`/`/abort` surfaces; plus the four Stop-hook
backstops, 2 plugins × 2 hosts). But it writes **only** an 8-field
projection JSON to a file (`workflow_kind`, `workflow_id`,
`workflow_path`, `phase`, `next_action`, `archive_gate`,
`routing_recommendation`, and conditional `checkpoint` —
`context.mjs:23-27`) plus a one-line stderr advisory. It deliberately
does **not** compose risk or call the runtime seam
(`session-handoff.mjs`: "the footer step owns the single
continue-vs-fresh composition"). So the projection is code-spoken; the
footer synthesis on top of it is not. The single missing edge is any
code-spoken caller that hands the projection to `footer.mjs` and surfaces
the result. `SessionStart` re-injection currently backstops the gap ("in
case the completion footer … was missed"), which is why the footer never
firing has gone unnoticed.

**Three per-plugin footer layers, wired unevenly.** (A) the ADR-0024
completion footer (`footer.mjs`, scoped by `footer-contract.md:3` to
engineer + orchestrator); (B) the ADR-0029 Active Next-Action Proposal
(engineer shape-tested at `test-engineer-plugin.mjs:303`; orchestrator
uses a **forbidden fixed lifecycle literal** and has no shape test;
founder inline-copies a diverged shape, untested); (C) the ADR-0031
session handoff (engineer + orchestrator wired; founder dormant). This
ADR targets promoting the prose elements to code across the plugins that
already carry the sidecar (A + C), and removing orchestrator's fixed
literal (B).

**Binding constraints (from the investigation + a Codex Plan-verify peer
that reviewed the implementation plan).**

- **No cross-plugin import (ADR-0010 §5).** `footer.mjs` is L1; the
  personas are L2/L3. They **cannot** `import` it — the sanctioned
  cross-plugin mechanism is a subprocess shell-out (the same shape as
  `discover-engineer.mjs` / `parent-writeback.mjs`). No
  `discoverRuntimePluginRoot` resolver exists yet.
- **The stdout channel is load-bearing.** Completion scripts emit
  machine-readable JSON / path-only on stdout (parsed by `peer-runner.mjs`
  and `state.mjs`). The sidecar writes **only** a file + one stderr line,
  **never stdout** (`session-handoff.mjs:234-251`). The footer must obey
  the same rule.
- **`footer.mjs render` uses `--context-state`, not `--risk`**
  (footer.mjs:214). `--risk` is a `runtime:context` flag. (The Plan-verify
  peer caught that a `--risk` invocation would throw on every render →
  fail-closed → the feature would silently never emit a footer.)
- **Context-usage has no host sensor** (ADR-0031 §7 honest limit) — risk
  is caller-supplied and defaults to `yellow` (conservative). The footer
  must not imply it measured live usage.
- **Advisory, fail-closed, no host-session mutation** (footer-contract.md
  §Boundaries; ADR-0024 §4).

## Decision

### 1. Activate the footer by piggybacking the code-spoken sidecar path (not a new command)

The terminal paths that already invoke `emitTerminalHandoffSidecar` gain
one additional step: after the sidecar has written the projection file
**and only when it returned `emitted: true`**, invoke the runtime footer
render engine as a **subprocess** and surface the rendered text on the
caller's **stderr**. No `/runtime:footer` command is added;
`footer-contract.md`'s "script, not a command" posture stands.

This choice was resolved with the 9-axis decision registry
(`decide-registry.mjs resolve --size=major`; decisive axes = essence
本질 + foundation 근본). Piggyback wins on both decisive axes: the footer
is *essentially* an automatic code-spoken side effect of completion (a
report a user must remember to invoke is not a completion footer), and
the *root cause* of the orphaning is the missing code-spoken caller —
which piggyback supplies directly. See Alternatives Considered for the
rejected command / both options. An independent cross-host brainstorm
peer (Codex), reasoning from the constraints without seeing this draft,
converged on the same recommendation and the same essence/foundation
rationale, and rejected the command-alone option for the same reason (a
host-mediated command "cannot guarantee completion-time rendering").

### 2. The subprocess invocation contract

Each persona wiring uses Node's `execFile` (no shell), captures the
child's stdout, and re-emits it on the **caller's stderr**; the child's
own stderr is discarded (so an unknown-flag or diagnostic line cannot
leak into the caller's channels):

```
execFile(process.execPath, [
  <runtime-root>/scripts/footer.mjs, 'render',
  '--workflow-projection-file', <projection-file>,
  '--context-state', 'yellow',          // NOT --risk; footer.mjs:214
  '--host', <host>,                      // threaded through the sidecar
  '--repo-root', <repoRoot>,             // not the child's cwd
  '--completion-state', <mapped>,        // see §3
  '--completion-reason', <mapped>,
  '--recommended-next-work', <mapped>,
  '--format', 'text',
])
```

- Output goes to the caller's **stderr only, never stdout** (mirrors the
  sidecar's two-channel model; preserves the machine-channel contract).
- `--context-state` defaults to `yellow` (conservative → the handoff
  fires); the caller may pass a better value if one is ever available, but
  the footer never claims to have measured live token usage.
- `--host` and `--repo-root` are passed explicitly. The sidecar signature
  (`{ repoRoot, workflowPath, projectionFile }`) currently carries no
  `host`; the wiring threads `host` through it from the call site (which
  already has it).

### 3. Projection → completion-flags mapping (so elements 2/3/4 are concrete, not generic)

A bare `footer.mjs render --workflow-projection-file <file>` renders only
**generic** completion guidance — the projection's `next_action` is stored
in the report but not surfaced as recommended-next-work by default. To
actually promote elements 2 (results) / 3 (next-action) / 4 (exact
command) from prose to code, the wiring derives
`--completion-state` / `--completion-reason` / `--recommended-next-work`
from the workflow frontmatter the sidecar already reads, and passes them
explicitly. `engineer-wire` establishes this mapping as the reference;
`orch-wire` reuses it. `--completion-state` values are the six-value enum
(`review-needed`, `publish-needed`, `cleanup-needed`,
`next-work-available`, `blocked`, `closed`); `cleanup-needed` / `closed`
are never inferred and must be mapped explicitly by the caller.

### 4. Idempotency, gating, and SessionStart reconciliation

- **Single-emission guard.** The primary terminal mutation and the
  Stop-hook backstop both funnel through the same sidecar; the wiring must
  render the footer **at most once** per terminal transition (guard on a
  marker so the backstop does not re-render what the primary already
  rendered).
- **`emitted === true` gate.** The footer renders only when the sidecar
  successfully wrote the projection. On a fail-closed sidecar path
  (including orchestrator's `clearStaleProjection`), no footer is
  attempted.
- **SessionStart reconciliation.** A successfully rendered footer must
  reconcile with the pending-handoff re-injection so the next session does
  not show a false "missed-footer" nudge for a footer that did fire.

### 5. `discoverRuntimePluginRoot` (copy-not-import)

Locating `footer.mjs` at the installed runtime plugin root requires a new
resolver, **copied into each persona** (ADR-0010 §5 — not shared),
mirroring `discover-engineer.mjs`'s env → Claude-cache SemVer →
Codex-fixed-cache → sibling-monorepo ladder, filesystem-only,
`child_process` exec. A missing or too-old runtime root is a **silent
fail-closed** (no footer, workflow proceeds) — **no** fall-back to a stale
cache.

### 6. Fail-closed = silent

If any step fails (runtime root not found, subprocess error, malformed
projection), the wiring emits nothing (at most one stderr diagnostic
line), never throws, and the completion/commit proceeds normally. A
failure must never assert a *more permissive* state than reality
(conservative defaults only) — reusing the ADR-0031 fail-closed
precedents.

### 7. Founder is deferred (recorded as explicit future work)

Founder is **not** included in this change. The 9-axis registry resolved
defer on both decisive axes: this change is *essentially* the activation
of an already-code-spoken path, but founder has **no**
`emitTerminalHandoffSidecar` (only a dormant `computeFounderProjection`),
no Stop-hook emit, no SessionStart re-injection, no shared runbook; the
runtime seam does not model it (`VALID_WORKFLOW_KINDS = {engineer,
orchestrator}`, `context.mjs:19`); and `footer-contract.md:3` scopes the
footer to engineer + orchestrator.
*(amended 2026-08-08, see
[ADR-0022 §Amendments](0022-engineer-meta-skill-category.md#amendments)
— read "no SessionStart re-injection **of the handoff**". Founder's
SessionStart hook already re-injected `latest_checkpoint` when this was
written; what it lacked was the pending-handoff backstop, added during
the [ADR-0043](0043-founder-designer-footer-enablement.md) work, which
also resolved the deferral this list justifies. Every other item here is
about the footer/handoff wiring too, but unqualified the phrase reads as
a claim about SessionStart itself.)* Founder would be a *greenfield
persona-onboarding* effort of a different essence and a different
root problem, not a dead-code revival. **Founder onboarding recipe (for a
future ADR/PR):** build `emitTerminalHandoffSidecar` + the projection
builder for founder, extend `VALID_WORKFLOW_KINDS` and
`footer-contract.md` scope to model `workflow_kind: 'founder'`, wire the
Stop-hook emit + SessionStart re-injection + the shared runbook, converge
founder's diverged inline Active Next-Action shape + add a shape test,
then apply this ADR's piggyback. Per ADR-0016 this spans `plugins/founder`
+ `plugins/runtime` and must be split into per-package commits.

### 8. Orchestrator fixed-literal removal (separate deliverable)

Orchestrator's hardcoded "next work" lifecycle literals
(`plan.md:153-159` / `:192`, `next.md:376`, `checkpoint.md:50`,
`resume.md:54`, `audit.md:59`, `plan/SKILL.md:111`) violate ADR-0029's
"no static lifecycle table" rule and are unprotected by any shape test.
They are removed and replaced with the ADR-0029 6-field Active Next-Action
Proposal + an orchestrator shape test, as a **separate** deliverable from
the footer wiring (they are ADR-0029 conformance, not footer plumbing).

### 9. Prose de-duplication

Each persona's own verb command/skill completion prose is updated to
**stop** hand-composing the footer and defer to the code-emitted footer,
so the code path does not produce output that duplicates or conflicts with
the model's prose.

## Consequences

**Positive.**
- Completion elements 2/3/4/7/8 become **code-generated** on engineer +
  orchestrator terminal paths — no longer dependent on the model reading
  and executing SKILL.md prose. Dead code (`footer.mjs`) is revived with
  minimal new code (one shell-out per plugin + one discovery helper each).
- The continue-vs-fresh recommendation and next-session prompts fire
  automatically at completion instead of only via `SessionStart`
  re-injection backstop.
- Orchestrator gains ADR-0029 conformance + a shape test, closing a
  known anti-pattern gap.

**Negative.**
- Two per-plugin copies of `discoverRuntimePluginRoot` and the footer
  invocation (ADR-0010 §5 copy-not-import) — a maintenance duplication the
  framework already accepts for `session-handoff.mjs` / `discover-*`.
- The footer remains **script-enforced, not host-enforced**: a persona
  whose terminal path is bypassed (or a host that does not run the
  Stop hook) still will not emit it. This is the same markdown/hook
  honesty boundary ADR-0031 already documents.
- Founder stays inconsistent with engineer/orchestrator until its own
  onboarding lands.

**Neutral.**
- Context-usage (element 5) is still caller-supplied; the footer defaults
  to `yellow` and never claims host measurement.
- `footer.mjs` itself is unchanged (no new flag); the wiring uses its
  existing `render` interface. `footer-contract.md` gains a note that the
  sidecar terminal path now invokes the render step.

## Alternatives Considered

- **New `/runtime:footer` command (option B).** Rejected. It contradicts
  `footer-contract.md:42` / `README.md:58` ("script, not a command"), and
  — decisively — it does not solve the orphaning: a user-invoked command
  still requires manual invocation, so the automatic completion footer
  would remain unfired. It fails the essence and foundation axes.
- **Both piggyback + command (option C).** Rejected as premature. The
  piggyback (§1) fully closes the observed gap; a command adds a parallel
  surface to maintain for a manual-render need nobody has expressed. The
  brainstorm peer's steelman for a command — manual recovery when the
  stderr output is lost (re-render from the retained projection file) and
  direct host-native testing/observability — is a real but *future*
  trigger: the maturation axis keeps the door open, since a command can be
  added later without reworking the piggyback. Bundling it now is
  unjustified and would incur public-API debt against the current footer
  contract.
- **Import `footer.mjs` into the persona hooks instead of shelling out.**
  Rejected — forbidden by ADR-0010 §5 (cross-plugin import breaks SemVer
  independence). A subprocess is the sanctioned mechanism and also avoids
  the intra-plugin `state.mjs → session-handoff` cycle entirely.
- **Include founder now (Decision §7 option A).** Rejected — different
  essence (greenfield onboarding vs dead-code revival) and different root
  problem; oversized for one reviewable PR (the Plan-verify peer flagged
  it), and cross-package. Deferred with an explicit onboarding recipe.
- **Render the footer to stdout (as `footer.mjs main()` does when run
  directly).** Rejected — stdout is the load-bearing machine channel of
  the completion scripts; the footer text must ride stderr/file only.
