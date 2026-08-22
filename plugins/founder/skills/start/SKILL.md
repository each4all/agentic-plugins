---
name: start
description: "Sequences the founder single-deliverable lifecycle macro — Phase 0 continuity through the terminal present+save — by chaining the six canonical verb skills (investigate / frame / decide / compose / critique / refine) with user-approval gates at the direction (Phase 1) and the plan (Phase 2). Use to take a single business deliverable from idea to a reviewed plan in one pass. Trigger phrases include 'start the business plan', 'take this idea end-to-end', 'kick off the venture plan', '사업 기획 시작', '아이템 끝까지', '엔드 투 엔드로 기획'. Single-pass only — for a multi-deliverable program use the orchestrator persona instead (ADR-0020 §Sub-decision 6)."
---

# Start (founder persona, lifecycle macro)

The `start` macro is the founder plugin's **single-deliverable lifecycle
macro skill** — a *macro skill* per ADR-0010 §3 cascade (ADR-0021), and a
*lifecycle macro command* on the Claude side per ADR-0020 §Sub-decision 1.
It sequences the canonical business-deliverable lifecycle through the six
founder verb skills (`investigate / frame / decide / compose / critique /
refine` per ADR-0010 §3):

```
Phase 0 continuity
  → Phase 1 discover+frame+decide  (investigate business-brief → frame → decide)   [APPROVE direction]
  → Phase 2 compose                (plan | canvas | validation-plan)               [APPROVE plan]
  → Phase 3 critique               (review the planning artifact)
  → Phase 4 refine                 (address findings, iterate to convergence)
  → terminal: present + save the business artifact
```

This is **simpler than the engineer lifecycle**: a business deliverable has
no code-implement phase, no RED-GREEN-REFACTOR, and no automated commit. The
terminal step presents and saves the business artifact (a brief, a venture
plan, a lean canvas, a validation backlog); the user commits the deliverable
to their per-venture content repository per ADR-0036 §SD5 workspace
convention (founder does not auto-commit).

**Intra-document execution model**: this runbook executes the verb skills'
command-invoked semantics **in-place**. It does NOT invoke the verb skills'
commands recursively (recursive slash/skill dispatch is not supported on
either host's runtime). At each phase boundary the orchestrator updates the
workflow's `verb` field to the active phase's primary cognitive activity,
keeping SessionStart re-injection metadata current.

For a multi-deliverable program (a portfolio of ventures, or a venture that
splits into independently plannable workstreams), use the orchestrator
persona — `start` is single-pass only (ADR-0020 §Sub-decision 6 — manual
escalation; no automatic cross-plugin routing). **founder is not an
orchestrator dispatch target itself** (ADR-0036 Non-Goal 3): `start`
sequences founder's own verbs in-place and never reads parent-linkage env.

---

## Host availability (ADR-0022)

| Operation | Claude | Codex |
|-----------|--------|-------|
| Phase 0 bootstrap (find-active, clean-baseline gate, `state.mjs create`) | Native — `commands/start.md` carries the canonical bash | Equivalent inline sequence using the same host-agnostic `state.mjs` CLI; the Codex side runs this SKILL.md as a cognitive runbook (ADR-0021 boundary) |
| Phase 1–4 verb sequencing + per-phase peer ensemble (always-max) | Yes | Yes — the verb skills' own ensemble protocol handles launch/collect; cognitive-runbook parity, not host-bootstrap parity |
| Per-phase `state.mjs append --verb …` (phase-boundary state writes) | `--host claude` | `--host codex` — same on-disk schema; on Codex the writes happen via the host-agnostic CLI when invoked |
| SessionStart re-injection of `[founder-active-metadata]` between sessions — both hosts register the hook with `matcher: "compact"`, so this is post-compact only | Yes — after compact | Yes when the founder plugin's hooks are enabled (`[features].hooks`, default on) and `/hooks`-reviewed/trusted; otherwise `$founder:resume` reads the durable workflow |

The Codex parity is at the **cognitive-runbook** level (ADR-0021): a Codex
user running `$founder:start` follows this runbook's phase sequence and
approval gates, writing durable state through the same host-agnostic
`state.mjs`. The Claude-side `commands/start.md` owns the host-bootstrap
bash; Codex does not get a separate host-bootstrap command. (Per ADR-0030/0035
the Codex hook model is generic `[features].hooks` + `/hooks` trust — there
is no `plugin_hooks` settings key.)

---

## Claude/Codex command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Plugin root | `$CLAUDE_PLUGIN_ROOT` (set by Claude Code); Claude fallback `$(find ~/.claude/plugins/cache/agentic-plugins/founder -maxdepth 1 -mindepth 1 -type d \| sort -V \| tail -1)` | Direct path: `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/founder` (Codex marketplace install layout per ADR-0008) |
| Entry path | `/founder:start <one-line business topic>` (slash command in `commands/start.md`) | `$founder:start <one-line business topic>` — this SKILL.md is the runbook |
| `state.mjs` host flag | `--host claude` | `--host codex` |

---

## When invoked by command (`/founder:start` Claude command or `$founder:start` Codex skill mention)

Phase 0 host-side bootstrap (argument intake, detached-HEAD guard,
redundancy probe, clean-baseline gate, active-workflow branching) is owned
by the entry path: `commands/start.md` carries the canonical bash on the
Claude side. Direct `$founder:start` on Codex follows the equivalent
operational sequence inline using the same `scripts/state.mjs` CLI (the
state writer is host-agnostic).

**Active-workflow branching** (both hosts): when `find-active` returns a
non-empty workflow, read its `workflow_type` before continuing. Resume into
the lifecycle only when `workflow_type == start`; when it is a single-verb
`verb-chain` workflow, **reject** — `start` must not absorb a single-verb
workflow into lifecycle phase space. The user finishes or archives it
(`/founder:resume`) or continues it with the matching `/founder:<verb>`
first. The **clean-baseline gate** fails closed: only an explicit
`clean` / `accepted` status proceeds; a non-zero check, a `dirty` tree, or an
unparseable status stops the bootstrap.

The **clean-baseline gate** runs on the bootstrap branch (when `find-active`
returns empty and a new workflow is about to be created) before `state.mjs
create`. It calls `state.mjs check-clean-baseline --repo-root <root>` and
inspects the returned `status` (`clean` / `dirty` / `accepted`). On `dirty`
the gate refuses to bootstrap and presents resolutions: clean the tree,
stash, or set `ACCEPT_CURRENT_TREE=1` to acknowledge the dirty tree.
`.agentic-plugins/state/**` is excluded from the dirty check.

### Privacy gate (applies to every phase that calls the peer or the web)

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web search
AND peer-host dispatch. The lifecycle dispatches the peer ensemble at every
phase boundary (always-max), and Phase 1 investigate runs web search —
genericize before any external call; the pre-genericization value MUST never
leave the local host. Each verb skill restates this gate; the macro inherits
it at every phase. See
`../investigate/references/business-brief-spec.md` § Privacy Gate.

### Entry routing recommendation (before Phase 1)

Present a short routing recommendation with **Options / Tradeoffs / Risks /
Recommendation / Confidence / Evidence pointers / Default next command**:

- continue with `/founder:start` for one coherent business deliverable on
  the current branch;
- switch to the orchestrator persona for a multi-deliverable program (2+
  independently plannable ventures/workstreams);
- use a single `/founder:<verb>` when the user only needs one verb
  (investigate / frame / decide / compose / critique / refine) without the
  full lifecycle.

Apply **Quality-first defaults**: optimize for best-results-over-token-
minimization; keep the per-phase peer ensemble at always-max; keep
model/effort at host-native values without downshift for token saving.
Treat budget/latency/model/effort limits as user constraints and state the
quality tradeoff before proceeding.

### Phase 1 — Discover + Frame + Decide composite

Execute each sub-phase's verb skill in-place by reading its SKILL.md "When
invoked by command" mode and applying its presentation + ensemble protocol
within this runbook context. Rotate the workflow's `verb` field at each
sub-phase entry.

- **1a — Investigate** (`--profile=business-brief`): surface candidate
  business items and gather cited market/regulatory/competitive evidence
  (the 5-tier source taxonomy + privacy gate per
  `../investigate/references/business-brief-spec.md`).
- **1b — Frame**: turn the evidence into a structured business opportunity
  model (problem, customer + JTBD, value hypothesis, business-model sketch,
  constraints, validation criteria, key risks, out-of-scope).
- **1c — Decide**: compare 2+ candidate directions across the decisive
  market + unit-economics axes and the regulatory + safety veto gates
  (`../decide/references/decision-axes.yml`), recommend one, and surface it
  for approval.

The opposite-host ensemble (research-scan → frame → brainstorm) dispatches
automatically per `../_shared/references/ensemble-protocol.md` (always-max).

**Do not proceed to Phase 2 until the user approves a direction.** Every
direction-approval prompt carries Options / Tradeoffs / Risks /
Recommendation / Confidence / Evidence pointers / Default next command, plus
the gate verdict (규제노출 / 안전리스크) when a veto gate is in play.

### Phase 2 — Compose the planning artifact

Execute `../compose/SKILL.md` with the appropriate profile (`plan` default /
`canvas` / `validation-plan`) to produce the planning artifact, marking
every unverified revenue / cost / demand number `[to be validated]`. The
opposite-host Plan-verify ensemble runs at this boundary (the peer receives
the genericized draft plan and returns gaps / unit-economics holes /
sequencing issues — the documented Independence-Rule exception).

**Do not proceed to Phase 3 until the user approves the plan.** If the plan
reads as a multi-deliverable program, surface it: *"This reads as
multi-deliverable. `founder:start` is single-pass. Consider the orchestrator
persona."* The user decides — abort or proceed single-pass.

### Phase 3 — Critique the artifact

Execute `../critique/SKILL.md` (default review profile) for a
multi-perspective business review of the plan across market-attractiveness,
unit-economics, willingness-to-pay, competitive-intensity, the regulatory +
safety gates, execution, and evidence quality. An unmitigated veto gate is
CRITICAL. The opposite-host Review ensemble runs in parallel.

### Phase 4 — Refine to convergence

Execute `../refine/SKILL.md` to address the Phase 3 findings, then re-verify
internal consistency (unit-economics ↔ go-to-market ↔ pricing reconcile; no
new gate exposure; `[to be validated]` markers intact). Iterate refine + peer
re-verify (fresh `run_id` each pass) until findings converge. If the same
finding recurs across two resolve loops, surface it as a design-level issue
and discuss whether to address now or defer to a follow-up `/founder:refine`.

### Terminal — present + save

Present the final business artifact and save it (the durable
`business_brief.md` / venture plan / canvas at its
`<root>/YYYY-MM-DD_<topic-slug>/` location). Write the terminal state:

```bash
# ADR-0029 §1 / completion-output contract §2 — write the COMPACT form
# (selected_next + one-line why + next_command) into --next-action; the
# code-emitted footer surfaces it verbatim as "recommended next work".
# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
# archive gates are evaluated at the end of THIS turn, not at session close;
# if a gate fails the workflow stays marked and a later Stop re-evaluates it.
# Clearing the marker with `--terminal-marker false` works only before that
# Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
# --terminal-phase), and does not restore the previous phase or next_action.
# On Codex the Stop hook runs only once the operator has trusted the plugin
# hooks (`/hooks`), so evaluation waits for that. Full contract:
# skills/_shared/references/session-handoff.md § Archive timing.
node "<plugin-root>/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host <claude|codex> \
  --terminal-phase summary-complete --terminal-marker true \
  --next-action "Save/commit the business deliverable; optionally /founder:start the next item" \
  --event updated
```

founder does NOT auto-commit — the user saves the deliverable to their
per-venture content repository (ADR-0036 §SD5). The `set-terminal` above
fires the ADR-0031 session-handoff sidecar, which **code-emits** the
runtime completion footer on stderr (ADR-0039, enabled by ADR-0043 S3):
context state, completion state (`publish-needed` while only the owner's
save/commit remains) + state-derived next action, workflow id/path,
artifact pointers, recommended next work, and the continue-vs-fresh read —
the macro workflow is terminal, so a fresh deliverable starts a new
`/founder:start`. Do NOT hand-compose a second footer; surface the emitted
one. The footer never mutates host session context; detached HEAD never
auto-recommends a fresh session (the branch-based preflight is what
reports "no active branch context"). Wiring:
`skills/_shared/references/session-handoff.md`.

---

## Anti-patterns (do not produce)

- **Skipping the Phase 1 direction-approval gate or the Phase 2
  plan-approval gate.** The approval gates are what distinguish `start` from
  a bare `compose`; auto-proceeding past either is a protocol violation.
- **Auto-committing the business deliverable.** founder presents and saves;
  the user commits to their content repo. There is no phase7 commit
  automation (that is an engineer concern).
- **Silent multi-deliverable splitting.** When Phase 2 surfaces the
  multi-deliverable prompt, the user — not the runbook — decides whether to
  escalate to the orchestrator persona.
- **Leaking proprietary material** to the peer or to web search at any
  phase. Genericize before every external call; the privacy gate holds for
  the whole lifecycle.
- **Reading parent-linkage env.** founder is not an orchestrator dispatch
  target (Non-Goal 3); `start` sequences founder's own verbs and never reads
  `AGENTIC_PARENT_WORKFLOW` / `AGENTIC_ORIGINATING_SUBTASK`.

---

## Notes

- ADR-0020 §Sub-decision 1 — `start` is a **lifecycle macro**, not a 7th
  canonical verb; the six-verb enum is unchanged.
- ADR-0021 — this SKILL.md is the Codex-side parity mirror for the
  `/founder:start` command (cognitive-runbook level).
- ADR-0018 §sub-2 — branch=workflow invariant; `start` cannot run from
  detached HEAD.
- ADR-0036 Non-Goal 3 — `start` is founder-internal verb sequencing and does
  NOT transit cross-plugin boundaries; `parent_workflow` is unset.
