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
| Plugin root | Each shell block of the Claude command sets `$CLAUDE_PLUGIN_ROOT` first: from `AGENTIC_FOUNDER_ROOT` when set, else from the plugin path Claude Code writes into the command body when it loads it, else from the newest release (`X.Y.Z`) under `~/.claude/plugins/cache/agentic-plugins/founder/` | For a mentioned `founder` skill, the plugin directory that contains it (inside `$founder:start`, the mentioned skill is `start`, which runs the six verb skills in place): Codex injects a mentioned skill with its absolute path (`<path>…/core/skills/<skill>/SKILL.md</path>`), and dropping `/core/skills/<skill>/SKILL.md` from it leaves the root, which holds `.codex-plugin/plugin.json`. If that path is no longer in context, for example after compaction, a new mention of the skill supplies it again. With the default Codex home and the `agentic-plugins` marketplace added from Git, the root is `~/.codex/plugins/cache/agentic-plugins/founder/<version>`, the versioned copy Codex loads skills from, and `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/founder` is the marketplace checkout, which tracks the repository's `main` branch, not that copy. |
| Entry path | `/founder:start <one-line business topic>` (slash command in `commands/start.md`) | `$founder:start <one-line business topic>` — this SKILL.md is the runbook |
| `state.mjs` host flag | `--host claude` | `--host codex` |

---

## When invoked by command (`/founder:start` Claude command or `$founder:start` Codex skill mention)

<!-- pipeline:begin start-command-intro -->
Phase 0 host-side bootstrap (argument intake, detached-HEAD guard,
clean-baseline gate, active-workflow branching) is owned by the entry path:
`commands/start.md` carries the canonical bash on the Claude side, generated
from the shared start regions (ADR-0066). Direct `$founder:start` on Codex
follows the same operational sequence inline, in this order, using the same
`scripts/state.mjs` CLI (the state writer is host-agnostic):

1. **Guard and find.** Refuse a detached HEAD (workflows are anchored to a
   branch), then `state.mjs find-active --repo-root <root>`, then
   `state.mjs autopilot-preflight --workflow-path <found> --host codex`
   before any write: it reports a pending owner gate and writes nothing.
2. **Active-workflow branching.** `workflow_type` `start` → resume:
   `state.mjs append --workflow-path <found> --host codex --clear-next-step
   true --event resumed`; put an owner gate step 1 reported to the user
   first (once it is resolved, clear it with the phase the lifecycle
   continues at and that phase's next action, the owner's decision and the
   action each a file written with the file-writing tool:
   `--resolution-file`, `--next-action-file`), then continue from its
   `current_phase`; no description is needed. Any other workflow
   (`verb-chain`, or a legacy one without the field) → typed conflict:
   refuse, writing nothing, its owner gate included — `start` must not
   absorb a single-verb workflow into lifecycle phase space. The user
   continues it with its `$founder:<verb>`,
   archives it (`$founder:resume`) or switches branch, then runs
   `$founder:start` again. Either type: when the arguments are a new
   request that does not belong to the active workflow, nothing is written;
   the proposal selects a worktree first (ADR-0067 Decision 8, item 3) —
   write the arguments into an args file and run `scripts/discover-runtime.mjs
   worktree-plan --repo-root <root> --args-file <path> --host codex --format
   text`, which prints the runtime:worktree planner's `git worktree add`
   command for the request — and the ordinary resume stays the selection when
   the request belongs to the workflow.
3. **No active workflow.** The arguments are the description: the
   **clean-baseline gate** below, then `state.mjs create --workflow-type
   start --verb investigate --persona founder --original-request-file
   <the description's file>`. The description is text the user typed, so it
   reaches `state.mjs` as a file, never on the command line (ADR-0059,
   amendment of 2026-10-10): write it with the file-writing tool as
   `request.txt` in a directory from
   `mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`, ending with one newline.

The **clean-baseline gate** runs on the bootstrap branch (when `find-active`
returns empty and a new workflow is about to be created) before `state.mjs
create`. It calls `state.mjs check-clean-baseline --repo-root <root>` (with
`--accept-current-tree true` once the user accepts the current tree, as
`ACCEPT_CURRENT_TREE=1` does in the command) and inspects the returned
`status` (`clean` / `dirty` / `accepted`). The gate fails closed: only an
explicit `clean` / `accepted` status proceeds; a non-zero check, a `dirty`
tree, or an unparseable status stops the bootstrap. On `dirty` the gate
refuses to bootstrap and selects a worktree first (ADR-0067 Decision 8,
item 3): with the arguments in a new args file, never on a command line
(`{"agentic_args": 1, "text": "…"}`, written with the file-editing tool into a
directory from `mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`; the reader
removes it), `scripts/discover-runtime.mjs worktree-plan --repo-root <root>
--args-file <path> --host codex --format text` prints the runtime:worktree
planner's `git worktree add -b <branch> <path> <base>` for the request,
to run before the start again inside the new worktree, or why there is none
(no runtime with the planner, an existing branch, an occupied path, an
unresolved base). The resolutions here stay the rejected alternatives:
clean the tree, stash, or set `ACCEPT_CURRENT_TREE=1` to acknowledge the
dirty tree. `.agentic-plugins/state/**` is excluded from the dirty check.

**Inside the lifecycle** (both hosts, ADR-0066 PC2b): Phase 0 runs
`state.mjs autopilot-preflight` once, before any write, and a resumed start
workflow clears the next step it carried. Each phase's ensemble attempt is
settled from its run ledger (`peer-runner.mjs settle`) before the next phase,
a repeated phase under a new run id. No phase makes a verb's terminal write;
the lifecycle's one terminal write is `finish-verb` at the end, once it
converged where the persona waits for convergence.
An owner gate met in a
phase (a decide CONFLICT, a recurring finding) is recorded with
`state.mjs awaiting-owner-set`, which leaves the workflow open; the lifecycle
pauses, and continues at the next phase once the owner's decision clears it
(`state.mjs awaiting-owner-clear` with that phase as the next step and its
action as the next action).
<!-- pipeline:end start-command-intro -->

### Privacy gate (applies to every phase that calls the peer or the web)

<!-- pipeline:begin start-privacy-gate -->
PRIVACY GATE: proprietary venture concepts, interview/customer data, and unpublished business material
pass an explicit privacy gate before BOTH web search AND peer-host dispatch.
The lifecycle runs web search (Phase 1 investigate) and dispatches the peer ensemble at every phase boundary (always-max) — genericize before any external call; the pre-genericization value MUST never leave the local host. Each verb skill restates this gate; the macro inherits it at every phase.
See `../investigate/references/business-brief-spec.md` § Privacy Gate.
<!-- pipeline:end start-privacy-gate -->

<!-- pipeline:begin start-privacy-no-image -->
No dispatch passes `--image`: the companion peer path has no image channel, so
an image never reaches the peer as bytes.
<!-- pipeline:end start-privacy-no-image -->

### Entry routing recommendation (before Phase 1)

Present a short routing recommendation with **Options / Tradeoffs / Risks /
Recommendation / Confidence / Evidence pointers / Default next command**
(the routes, the prompt shape and the quality-first defaults are defined in
`../_shared/references/entry-routing-contract.md` § Routing Recommendation
and the sections after it):

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
`<root>/YYYY-MM-DD_<topic-slug>/` location). founder does NOT auto-commit —
the user saves the deliverable to their per-venture content repository
(ADR-0036 §SD5).

<!-- pipeline:begin start-finish -->
The lifecycle's last write, `state.mjs finish-verb`, records its next step in
closed-enum form, `--next-step-kind commit`: the owner saves and commits the
deliverable (founder runs no commit itself). It closes the workflow
`summary-complete` and sets the terminal marker. The next action shown is the
lifecycle's default; when the result selects another, write the compact form
of the proposal instead (selected_next, a one-line why, next_command), which
the footer shows as recommended next work.

The next action is text, so it reaches `state.mjs` as a file, never on the
command line: in shell source a quote, `$` or backtick of it would be read as
code (ADR-0059, amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `next-action.txt` in
   that directory, ending with one newline. The lifecycle's default is

   ```text
   Save/commit the business deliverable; optionally /founder:start the next item
   ```

   Nothing deletes the file.

Then run the block with `TEXT_DIR` set to that directory.

```bash
TEXT_DIR='<directory from step 1>'
# ADR-0063 D3 — finish-verb is the lifecycle's last write: the ADR-0017
# §sub-decision 5 atomic terminal write (summary-complete + terminal marker)
# with the next step, kind commit (the owner saves and commits).
# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
# archive gates are evaluated at the end of THIS turn, not at session close;
# if a gate fails the workflow stays marked and a later Stop re-evaluates it.
# Clearing the marker with `--terminal-marker false` works only before that
# Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
# --terminal-phase), and does not restore the previous phase or next_action.
# On Codex the Stop hook runs only once the operator has trusted the plugin
# hooks (`/hooks`), so evaluation waits for that. Full contract:
# core/skills/_shared/references/session-handoff.md § Archive timing.
node "<plugin-root>/scripts/state.mjs" finish-verb \
  --workflow-path "$ACTIVE" --host <claude|codex> \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --next-step-kind commit --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
```

The runtime completion footer is **code-emitted** on that terminal write
(ADR-0039): its completion state is
`publish-needed` while only the owner's save and commit remain, since
founder runs no commit itself.
The write fires the session-handoff sidecar, which renders the runtime
`footer.mjs`, the ADR-0031 continue-vs-fresh session handoff included, on that
command's stderr. It is advisory and pointer-only, and never mutates host
session context. The workflow is then terminal, and the Stop hook archives it
once every archive gate passes; until then `/founder:start` on this branch
finds it and resumes it, so start the next deliverable after the archive, or
on another branch. Do not hand-compose a second footer or hand-pass the
projection; surface the emitted one. On a detached HEAD the branch-based
preflight reports "no active branch context" and never recommends a fresh
session (ADR-0018 §sub-2); the path-targeted terminal sidecar renders the
footer as on a branch, its continue-vs-fresh advice included.
`$founder:start` on Codex surfaces the footer as `/founder:start`
does. Wiring: `core/skills/_shared/references/session-handoff.md`.

On Claude the Stop hook fires at **every turn end**, so that terminal write puts
the workflow in front of the archive gates at the end of **that same turn**, not
at session close — it archives then if every gate passes, and otherwise stays
marked for a later Stop to re-evaluate. Clearing the marker
(`--terminal-marker false`, with set-terminal's full flag set) works only before
that Stop fires and does not restore the previous phase. On Codex the hook runs
only once the operator has trusted the plugin hooks (`/hooks`), so evaluation
waits. Full contract: `core/skills/_shared/references/session-handoff.md`
§ Archive timing.
<!-- pipeline:end start-finish -->

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
