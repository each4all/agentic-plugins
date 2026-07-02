# Macro Completion Handoff Wiring (orchestrator, ADR-0029 + ADR-0031)

This is the orchestrator-side wiring for the two contracts a macro surface
consults **at completion**: the **Active Next-Action Proposal** (ADR-0029 — what
to do next) and the **session-level continue-vs-fresh preflight** (ADR-0031 —
whether to continue this session or hand off to a fresh one). Both **canonical
contracts** live in the engineer plugin's `entry-routing-contract.md` (the single
source; ADR-0010 §5 forbids a cross-plugin import, so this file points to those
sections **by name** rather than restating their schema, which would drift). This
file holds only the orchestrator-local wiring — how an orchestrator **macro**
surface adapts the proposal shape, and how it computes its own bounded projection
and passes it **into** the runtime seam — preserving the ADR-0010 L2 → L1
direction (the runtime layer never reads orchestrator state; projection /
inversion-of-control model).

## Active Next-Action Proposal (macro completion surfaces, ADR-0029)

Its **canonical contract** is `entry-routing-contract.md § Active Next-Action
Proposal (standalone verb completion)` in the engineer plugin (the single
source, cited by name per ADR-0010 §5). A **forward-decision** macro surface —
one whose completion leaves a genuine "what next?" choice: `/orchestrator:plan`,
`/orchestrator:next`, `/orchestrator:done`, and the `/orchestrator:audit` alias
(which reuses the `plan.md` runbook) — MUST NOT end with a **fixed lifecycle
literal** (e.g. always "recommend `/orchestrator:next`"). It emits an
**evidence-based proposal** derived from the macro's actual state — which
subtasks are ready, blocked, or terminal — with the six contract fields:

- **selected_next**: the recommended next step, chosen from the macro state — a
  macro command (`/orchestrator:next` when a subtask is ready;
  `/orchestrator:finalize` / `/orchestrator:abort` when work is intentionally
  closed), `commit`, or `owner decision`. Not a fixed table entry.
- **rejected_alternatives**: 1-2 plausible next steps, each with a one-line why-not.
- **rationale**: why `selected_next` is best, grounded in the decisive quality
  axes (본질 essence / 근본 foundation) and the Standards/Root-Cause gate.
- **evidence_pointers**: the macro subtask table, phase notes, or artifact
  pointers that support the recommendation (pointers only — never raw peer output).
- **confidence**: HIGH / MEDIUM / LOW, based on available evidence.
- **next_command**: the exact next step matching `selected_next` — the
  `/orchestrator:<verb> …` (Claude) or `$orchestrator:<verb>` (Codex) mention for
  a macro command; the concrete action for `commit` / `owner decision`.

The default macro sequence (a ready subtask → `/orchestrator:next`; all subtasks
terminal → `/orchestrator:finalize` or the Stop-hook auto-archive) remains the
**fallback** when evidence is genuinely neutral — but a fixed literal is no longer
the default output. Where a forward-decision surface writes a durable next-action
(e.g. `state.mjs --next-action`), record the compact form (selected_next +
one-line rationale + next_command); the fuller proposal (alternatives + evidence
+ confidence) belongs in the completion output and the phase note.

**Forward-decision vs terminal-close.** Only forward-decision surfaces carry the
six-field prose proposal, because only they leave a genuine forward branch to
reason about. The **terminal-close** surfaces — `/orchestrator:finalize` and
`/orchestrator:abort` — close the macro; they carry **no fixed literal** either,
but they do **not** hand-author the six-field proposal (a close has no
rejected-alternatives / confidence branch to populate). Their state-derived next
action is surfaced by the **ADR-0039 code-emitted runtime footer** instead — a
proportionality boundary, not a claim that the footer reproduces the six fields
(forcing the full proposal onto a terminal close would be the same
over-application ADR-0029 warns against for a trivial reversible step).
`/orchestrator:done` is a **hybrid**: when subtasks remain it is forward-decision
(emit the six-field proposal); when its completion auto-terminalizes the macro's
final subtask it is a terminal close (the footer fires, no hand-authored proposal).

**Meta / guard exception.** A **guard path** — one that exits early because there
is nothing to act on, not a verb completion with a result — is **not** bound by
the six-field proposal (mirroring the engineer meta skills, which ADR-0029 §1
likewise does not bind). A guard surfaces a **compact pointer to the single
honest recovery for its state**, which legitimately names a command: this is not
the W1 "fixed lifecycle table masking an evidence-based decision", because the
guard state has exactly one honest recovery (there is no branch to reason over).
The guard paths are:

- `/orchestrator:checkpoint` / `/orchestrator:resume` *no-active-workflow* → plan
  a macro **or** start a single-deliverable engineer workflow (`engineer:start`).
- `/orchestrator:next` dispatch guards → `empty_plan` points to
  `/orchestrator:plan`; `all_terminal` points to the terminal close
  (`/orchestrator:finalize` or the auto-archive Stop hook); `in_progress_or_blocked`
  points to `/orchestrator:done` for the in-flight subtask.
- `/orchestrator:done` *no-child* → re-dispatch via `/orchestrator:next` (manual
  completion without a child is unsupported — `subtask-update` requires the
  `engineer_workflow_id`).

None carry the full six-field proposal.

## Session-Level Continue-vs-Fresh Preflight (ADR-0031)

The Active Next-Action Proposal above answers *"what is the next macro step?"*.
This section adds its **session-level** counterpart: *"should that step continue
in the current session, or hand off to a fresh one?"* Its **canonical contract**
— the firing rules, the three inputs, the bounded projection schema, and the
continue-vs-fresh decision policy — is the `entry-routing-contract.md
§ Session-Level Continue-vs-Fresh Preflight (ADR-0031)` section in the engineer
plugin (the single source; cited by name per ADR-0010 §5). The wiring below is
the orchestrator-local single source for how an orchestrator **macro** surface
computes its own bounded projection and passes it **into** the runtime seam.

### When to surface it

Per the contract's firing rules, surface the preflight at the **macro-level
equivalents of verb completion** — before guiding the user toward substantial
next work:

- at **`orchestrator:next` dispatch completion** (after the dispatch summary), and
- at **`orchestrator:plan` / `orchestrator:finalize` / `orchestrator:abort`
  completion** (alongside the runtime completion footer), and
- whenever the caller-supplied **context risk is yellow/red** (continuing a
  near-full session is the case the handoff exists to catch).

It is not emitted on a trivial reversible step.

### How to compute + pass the projection

The orchestrator macro projection is computed **fail-closed** by a read-only
script that uses the **pure** `evaluateMacroStopArchive` evaluator (never the
side-effecting `runMacroStopArchive` runner), so computing it has no side
effects. The macro is resolved **across branches** — `find-active` on the
macro's own branch, then `find-macro` on a subtask branch — never `find-active`
alone on a subtask branch (it keys on the macro's own `git_baseline.branch` and
would miss the parent):

```bash
# 1. Compute the bounded macro projection from orchestrator's OWN state.
#    --routing is the macro's resolved next route (e.g. /orchestrator:next to
#    dispatch the next ready subtask, else /orchestrator:resume).
HANDOFF="$(node "$CLAUDE_PLUGIN_ROOT/scripts/session-handoff.mjs" project \
  --repo-root "$REPO_ROOT" --routing "/orchestrator:next")"
STATUS="$(echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).status||"")}catch{}})')"
# Routing is always present in the result (ADR-0031 input (c)) — pass it
# standalone when there is no projection so the seam never loses it.
ROUTING="$(echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).routing||"")}catch{}})')"

case "$STATUS" in
  ok)
    # 2. Materialize just the projection object to a temp file and pass it to
    #    the runtime seam. runtime composes context-risk × archive_gate into
    #    the continue-vs-fresh decision + next-session prompt/command.
    PROJ_FILE="$(mktemp -t orchestrator-projection.XXXXXX).json"
    echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify(JSON.parse(s).projection))})' > "$PROJ_FILE"
    # The runtime footer/check is advisory + pointer-only; --risk is the
    # caller-supplied context-budget risk (host-measured tokens are not
    # available — ADR-0031 §7). Use the runtime footer helper when present:
    #   runtime:context check --risk <green|yellow|red> --workflow-projection-file "$PROJ_FILE"
    #   runtime footer --workflow-projection-file "$PROJ_FILE" ...
    ;;
  no_active_branch_context)
    # Detached HEAD — report it, do NOT auto-recommend a fresh session
    # (ADR-0018 §sub-2). Surface: "no active branch context".
    ;;
  no_active_workflow|fail_closed)
    # No active macro on this branch, or a corrupt / ambiguous (canonical+legacy
    # split, or one subtask branch matching 2+ macros) state. Degrade: NO
    # projection, but routing is still available — pass it standalone so the
    # seam keeps the routing-shaped next command:
    #   runtime:context check --risk <green|yellow|red> --routing-recommendation "$ROUTING"
    # Surface the reason from the handoff result.
    ;;
esac
```

The projection schema (workflow_kind=`orchestrator`, workflow_id, workflow_path,
phase, next_action, checkpoint, archive_gate, routing_recommendation) and its
fail-closed rules are owned by the canonical contract named above; this wiring
just produces a schema-valid macro projection and hands it to the seam.

### Codex hook parity (diagnose + operator attestation only)

The preflight itself fires **synchronously at completion** and is fully
host-symmetric: a Codex `$orchestrator:{next,plan,finalize,abort}` skill
computes and passes the macro projection exactly as the Claude command does.

What is **not** non-interactively provable on Codex is the *re-surfacing* of the
emitted next-session prompt in a later session: that re-injection rides the
SessionStart hook, which on Codex additionally requires the stage-appropriate
hook gate (generic `[features].hooks`, default on, on current Codex;
`[features].plugin_hooks = true` enabled manually on legacy Codex < ~0.134)
plus a `/hooks` review/trust of the packaged hook. agentic-plugins
cannot prove that trust state from a headless run (settings.mjs:955) — so this
is **diagnose + operator attestation only**:

- diagnose readiness with `runtime:doctor` (Codex plugin-hook readiness) and
  attest with `runtime:settings` (`--attest-codex-hook-review`; hook-gate
  enablement is manual per ADR-0035 §6);
- the durable handoff (the `runtime:context` artifact's next-session field)
  is host-shared and survives regardless — only its automatic re-injection
  depends on the attested Codex hook state.

This is the honest-scope boundary (ADR-0001 §5): the preflight computes and
reports identically on both hosts; only Codex auto-re-injection is gated on an
operator-attested hook trust the framework does not silently assume.

## Boundaries

- **Read-only / non-mutating.** `session-handoff.mjs` only reads orchestrator
  state and runs the pure evaluator; it never archives, marks terminal, or
  mutates the macro. The runtime footer it feeds is advisory and pointer-only.
- **Fail-closed.** A corrupt or ambiguous macro state (canonical+legacy
  duplicates, or one subtask branch matching 2+ macros) yields no projection;
  the seam degrades to context-risk + routing rather than trusting a partial
  projection.
- **Macro resolution, not subtask.** Resolve the macro via `find-active` then
  `find-macro`; a completing surface projects the **macro** workflow only. An
  engineer verb on a subtask branch projects the engineer workflow at its own
  completion — the two are never merged (one projection per surface).
- **HEAD-independent readiness.** Macro `archive_gate` comes from the pure
  `evaluateMacroStopArchive` gates (terminal_marker + macro_terminal_phase +
  all_subtasks_terminal + no_active_engineer_children); it never probes git
  HEAD, because a macro spans branches and HEAD comparison is meaningless.
- **No auto-fresh on detached HEAD.** Report "no active branch context"; do not
  recommend a fresh session from a state with no branch to anchor to.
