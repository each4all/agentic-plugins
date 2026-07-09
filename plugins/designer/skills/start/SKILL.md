---
name: start
description: "Sequences the designer single-deliverable lifecycle macro — Phase 0 continuity through the terminal present+save+handoff — by chaining the six canonical verb skills (investigate / frame / decide / compose / critique / refine) with user-approval gates at the direction (Phase 1) and the spec (Phase 2). Use to take one design/UX deliverable — a screen, a flow, a CTA, an IA — from idea to a reviewed, accessibility-gated spec in one pass, and to hand the spec to the frontend. Trigger phrases include 'take this screen end-to-end', 'design this flow start to finish', 'kick off the UX work', '디자인 처음부터 끝까지', '이 화면 엔드 투 엔드로', 'UX 작업 시작'. Single-pass only — designer is non-dispatch; a program spanning design + frontend runs designer then engineer with artifact handoff (ADR-0042 Non-Goal 2)."
---

# Start (designer persona, lifecycle macro)

The `start` macro is the designer plugin's **single-deliverable lifecycle
macro skill** — a *macro skill* per ADR-0010 §3 cascade (ADR-0021), and a
*lifecycle macro command* on the Claude side per ADR-0020 §Sub-decision 1.
It sequences the canonical design-deliverable lifecycle through the six
designer verb skills (`investigate / frame / decide / compose / critique /
refine` per ADR-0010 §3):

```
Phase 0 continuity
  → Phase 1 discover+frame+decide  (investigate design-brief → frame → decide)  [APPROVE direction]
  → Phase 2 compose                (spec | flow | wireframe)                    [APPROVE spec]
  → Phase 3 critique               (usability / a11y / conversion / consistency)
  → Phase 4 refine                 (bounded convergence loop to a clean re-critique)
  → terminal: present + save the design artifact, then hand it to the frontend
```

This is **simpler than the engineer lifecycle**: a design deliverable has
no RED-GREEN-REFACTOR phase and no automated commit. The terminal step
presents and saves the design artifact (a cited design brief, a user-flow
spec, a wireframe spec, CTA copy, an IA) and names the **artifact handoff**
to `engineer:start` / `orchestrator:plan` that turns it into frontend code
(ADR-0042 Non-Goal 2). designer does not auto-commit and does not dispatch.

**Code-first, both directions.** The lifecycle runs pre-code (shaping the
spec that becomes frontend code) and post-code (critiquing the rendered
screen + the frontend code the spec produced). When `start` is invoked on a
surface that already ships, Phase 1's investigate reads the existing
frontend, and Phases 3–4 critique the **rendered screen** host-direct, not
just the spec. That post-code loop is designer's differentiator (ADR-0042
SD4) — the running frontend is the design artifact of record.

**Intra-document execution model**: this runbook executes the verb skills'
command-invoked semantics **in-place**. It does NOT invoke the verb skills'
commands recursively (recursive slash/skill dispatch is not supported on
either host's runtime). At each phase boundary the orchestrator updates the
workflow's `verb` field to the active phase's primary cognitive activity,
keeping SessionStart re-injection metadata current.

For a program that spans design **and** frontend implementation, run
designer to a saved spec, then hand that spec to the engineer persona —
`start` is single-pass only (ADR-0020 §Sub-decision 6 — manual escalation;
no automatic cross-plugin routing). **designer is not an orchestrator
dispatch target** (ADR-0042 Non-Goal 2): `start` sequences designer's own
verbs in-place and never reads parent-linkage env.

---

## Host availability (ADR-0022)

| Operation | Claude | Codex |
|-----------|--------|-------|
| Phase 0 bootstrap (find-active, clean-baseline gate, `state.mjs create`) | Native — `commands/start.md` carries the canonical bash | Equivalent inline sequence using the same host-agnostic `state.mjs` CLI; the Codex side runs this SKILL.md as a cognitive runbook (ADR-0021 boundary) |
| Phase 1–4 verb sequencing + per-phase peer ensemble (always-max) | Yes | Yes — the verb skills' own ensemble protocol handles launch/collect; cognitive-runbook parity, not host-bootstrap parity |
| **Host-direct vision** on a rendered screen (Phases 3–4) | Yes — native image input | Yes — `codex exec --image <file>` on the **active** host. The companion **peer** path has no `--image` flag on either side, so peer verification stays code/text (ADR-0042 SD4 item 3) |
| Per-phase `state.mjs append --verb …` (phase-boundary state writes) | `--host claude` | `--host codex` — same on-disk schema; on Codex the writes happen via the host-agnostic CLI when invoked |
| `AGENTIC_DESIGNER_PROFILE` export (L4 archetype → decide preset) | Yes | Yes — read by `decide-registry.mjs`, host-agnostic |
| SessionStart re-injection of `[designer-active-metadata]` between sessions | Yes (next Claude session) | Yes when the designer plugin's hooks are enabled (`[features].hooks`, default on) and `/hooks`-reviewed/trusted; otherwise `$designer:resume` reads the durable workflow |

The Codex parity is at the **cognitive-runbook** level (ADR-0021): a Codex
user running `$designer:start` follows this runbook's phase sequence and
approval gates, writing durable state through the same host-agnostic
`state.mjs`. The Claude-side `commands/start.md` owns the host-bootstrap
bash; Codex does not get a separate host-bootstrap command. (Per ADR-0030/0035
the Codex hook model is generic `[features].hooks` + `/hooks` trust — there
is no `plugin_hooks` settings key.)

---

## Claude/Codex command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Plugin root | `$CLAUDE_PLUGIN_ROOT` (set by Claude Code); Claude fallback `$(find ~/.claude/plugins/cache/agentic-plugins/designer -maxdepth 1 -mindepth 1 -type d \| sort -V \| tail -1)` | Direct path: `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/designer` (Codex marketplace install layout per ADR-0008) |
| Entry path | `/designer:start <one-line design topic>` (slash command in `commands/start.md`) | `$designer:start <one-line design topic>` — this SKILL.md is the runbook |
| `state.mjs` host flag | `--host claude` | `--host codex` |

---

## When invoked by command (`/designer:start` Claude command or `$designer:start` Codex skill mention)

Phase 0 host-side bootstrap (argument intake, detached-HEAD guard,
clean-baseline gate, active-workflow branching) is owned by the entry path:
`commands/start.md` carries the canonical bash on the Claude side. Direct
`$designer:start` on Codex follows the equivalent operational sequence
inline using the same `scripts/state.mjs` CLI (the state writer is
host-agnostic).

**Active-workflow branching** (both hosts): when `find-active` returns a
non-empty workflow, read its `workflow_type` before continuing. Resume into
the lifecycle only when `workflow_type == start`; when it is a single-verb
`verb-chain` workflow, **reject** — `start` must not absorb a single-verb
workflow into lifecycle phase space. The user finishes or archives it
(`/designer:resume`) or continues it with the matching `/designer:<verb>`
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

### Design Task Profile + the L4 profile

Record the Design Task Profile per
`../_shared/references/orchestration.md` § Step 1 before Phase 1. Its
`Profile` field is the L4 archetype: `general`/`flow` → `balanced`;
`ui` → `experience`; `cta` → `conversion`; `content` → `clarity`. The
map's single source of truth is `PROFILE_PRESET_MAP` in
`../../scripts/decide-registry.mjs`. An explicit `--preset` / `--size` at
Phase 1c still wins (ADR-0027 §1.5) — and because designer's size→preset
map is degenerate, an explicit `--size` **drops** the archetype (the
resolver says so on stderr).

**Carry the archetype inline, not as durable state.** Shell state does not
survive across Bash tool invocations, so an `export` recorded here is gone
by the time Phase 1c resolves the preset in a later block. Prefix the
`decide-registry.mjs resolve` invocation in the same block:
`AGENTIC_DESIGNER_PROFILE="<archetype>" node …/decide-registry.mjs resolve …`.
A lost value silently downgrades the lifecycle to `balanced`; a stale value
left exported in the operator's shell silently upgrades an unrelated
standalone `/designer:decide`. The resolver's provenance diagnostic on
stderr is how either is noticed.

### Privacy gate (applies to every phase that calls the peer or the web)

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data
visible in screenshots, and secret-bearing frontend code pass an explicit
privacy gate before BOTH web search AND peer-host dispatch. The lifecycle
dispatches the peer ensemble at every phase boundary (always-max), and
Phase 1 investigate runs web search — genericize before any external call;
the pre-genericization value MUST never leave the local host.
**Screenshots are sensitive by default**: a raw screenshot of a real UI is
read host-direct and never leaves the local host as bytes; the companion
peer path has no `--image` flag. Each verb skill restates this gate; the
macro inherits it at every phase. See
`../investigate/references/design-brief-spec.md` § Privacy Gate.

### Entry routing recommendation (before Phase 1)

Present a short routing recommendation with **Options / Tradeoffs / Risks /
Recommendation / Confidence / Evidence pointers / Default next command**:

- continue with `/designer:start` for one coherent design deliverable on
  the current branch;
- hand off to the engineer persona (`/engineer:start`) or the orchestrator
  persona (`/orchestrator:plan`) when the real work is implementing an
  already-settled design — designer's artifact is the input there, not the
  output;
- use a single `/designer:<verb>` when the user only needs one verb
  (investigate / frame / decide / compose / critique / refine) without the
  full lifecycle — a one-off `critique` of a shipped screen is the common
  case.

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

- **1a — Investigate** (`--profile=design-brief`): scan heuristic /
  accessibility standards, the design system, competitor UX, and the design
  press across the 5-tier source taxonomy; **read the existing frontend**
  for the surface in scope; fold in local user-research aggregates (the
  privacy gate per `../investigate/references/design-brief-spec.md`).
- **1b — Frame**: turn the evidence into a structured UX problem model
  (user problem, primary user + job-to-be-done, goals, **measurable UX
  success metrics**, constraints, key risks, out-of-scope).
- **1c — Decide**: compare 2+ candidate directions across the decisive
  usability axis + the L4 archetype axis, with **accessibility as the veto
  gate** checked FIRST (`../decide/references/decision-axes.yml`),
  recommend one, and surface it for approval.

The opposite-host ensemble (reference-scan → frame → brainstorm) dispatches
automatically per `../_shared/references/ensemble-protocol.md` (always-max).

**Do not proceed to Phase 2 until the user approves a direction.** Every
direction-approval prompt carries Options / Tradeoffs / Risks /
Recommendation / Confidence / Evidence pointers / Default next command, plus
the accessibility gate verdict (PASS / CONDITIONAL / CANDIDATE-FAIL /
UNKNOWN — the vocabulary of
`../_shared/references/ensemble-protocol.md` § Brainstorm, where
`CANDIDATE-FAIL` is the peer-side spelling of `FAIL`). A **CONDITIONAL**
direction may be recommended, but only with its remediation named as a
blocking precondition. A **CANDIDATE-FAIL** direction vetoes: it is not
recommended on usability/archetype strength, and a candidate WCAG A/AA
barrier is not a tradeoff to fold into the build plan. An **UNKNOWN** verdict
is a request for context, not evidence of safety.

### Phase 2 — Compose the design artifact

Execute `../compose/SKILL.md` with the appropriate profile (`spec` default /
`flow` / `wireframe`) to produce the artifact — user flows, wireframe specs,
CTA copy, information architecture, component specs — every element
annotated with its **accessibility + consistency acceptance criteria**, and
every unvalidated pattern claim marked `[to be validated]`. The opposite-host
Plan-verify ensemble runs at this boundary (the peer receives the genericized
draft artifact and returns missing states, unhandled branches, accessibility
criteria holes, and consistency departures — the documented Independence-Rule
exception).

**Generated imagery is an `image:compose` handoff, never drawn here**
(ADR-0042 SD5). When the deliverable needs a concept visual, a hero image,
or a moodboard, the artifact carries an explicit **image brief** (subject,
composition, style, palette, aspect ratio, success criteria) and the user
runs `/image:frame` → `/image:compose`. designer never implements image
generation and never calls an image generation API; `image` generates only
through Codex's integrated gpt-image tool. See
`../_shared/references/orchestration.md` § image L2 composition boundary.

**Do not proceed to Phase 3 until the user approves the spec.** If the spec
reads as a multi-surface program, surface it: *"This spans multiple
surfaces. `designer:start` is single-pass. Consider running it per surface,
or hand the settled parts to the engineer persona."* The user decides —
abort or proceed single-pass.

### Phase 3 — Critique the artifact

Execute `../critique/SKILL.md` across the four active lenses (usability /
a11y / conversion / consistency), all four held to the single internalized
`../critique/references/quality-criteria.md`. Input is the composed spec
**and**, when the surface already ships, the rendered screen (host-direct
vision) plus the frontend code. An unmitigated accessibility veto gate is
**CRITICAL by definition**. Accessibility findings are **candidate-level**
(ADR-0042 Non-Goal 6): focus order, keyboard traversal, and screen-reader
behavior need runtime testing and are reported unverified, not certified.
The opposite-host Review ensemble runs in parallel on the code/text.

### Phase 4 — Refine to convergence

Execute `../refine/SKILL.md` to address the Phase 3 findings, then re-verify
the design reconciles (acceptance criteria intact; the measurable UX success
metrics still honored; `[to be validated]` markers intact) and — the
load-bearing design gate — that the revision did **not** open a new
accessibility barrier. A revision that clears a usability/conversion problem
by introducing a candidate WCAG A/AA barrier has moved the veto gate, not
cleared it.

Iterate refine + peer re-verify + re-critique (fresh `run_id` each pass) in
a **bounded** loop (default 2 passes, hard cap 3). If findings do not
converge, STOP: pause and route to the owner — a genuine 2+-direction
remediation fork goes to `/designer:decide`, a load-bearing unverified claim
to `/designer:investigate`, otherwise present the residual findings for an
owner decision. **designer does not run the frontend build**: the
re-rendered screen is supplied by the user / frontend engineer. When it is
unavailable or the edit broke the render, the vision re-critique is
**UNVERIFIED** — report the code/text verification only and do not claim
convergence.

A non-converged Phase 4 does **not** reach the terminal write. The macro
stays active; the user resolves the flagged item first.

### Terminal — present + save + hand off

Present the final design artifact and save it (the durable design brief /
flow spec / wireframe spec / CTA copy at its
`<root>/YYYY-MM-DD_<topic-slug>/` location per
`../investigate/references/output-file-rules.md`). Write the terminal
state — **only when Phase 4 converged**:

```bash
node "<plugin-root>/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host <claude|codex> \
  --terminal-phase summary-complete --terminal-marker true \
  --next-action "Hand the spec to the frontend (/engineer:start or /orchestrator:plan); optionally /designer:start the next surface" \
  --event updated
```

designer does NOT auto-commit and does NOT dispatch (ADR-0042 Non-Goal 2).
The terminal output names the **artifact handoff** explicitly: the saved
spec is the input to `engineer:start` (single surface) or
`orchestrator:plan` (multi-deliverable frontend program), and the rendered
result comes back to `/designer:critique` for the post-code quality pass.
Append an advisory, pointer-only completion summary: context state,
completion state + state-derived next action, workflow id/path, the saved
artifact pointer, and the recommended next work. The macro workflow is
terminal, so a fresh deliverable starts a new `/designer:start`; do not
mutate host session context. On detached HEAD, report "no active branch
context".

designer surfaces the inline next-action proposal + the workflow path; the
deeper runtime-completion-footer / ADR-0031 session-handoff seam integration
that the engineer plugin carries is not part of designer's surface (future
work if demand arrives).

---

## Anti-patterns (do not produce)

- **Skipping the Phase 1 direction-approval gate or the Phase 2
  spec-approval gate.** The approval gates are what distinguish `start` from
  a bare `compose`; auto-proceeding past either is a protocol violation.
- **Marking the macro terminal on a non-converged Phase 4.** A pending
  accessibility barrier, an exhausted bounded loop, or an UNVERIFIED vision
  re-critique leaves the workflow ACTIVE so the Stop hook cannot
  auto-archive an unresolved session.
- **Trading the accessibility gate against the decisive axes.** The gate is
  checked FIRST, at Phase 1c and again at Phases 3–4. A candidate WCAG A/AA
  barrier vetoes; it is not folded into the build plan.
- **Claiming visual convergence the peer supplied.** The peer never sees the
  screen. A visual claim with no host-direct read behind it is UNVERIFIED.
- **Generating imagery inside designer, or calling an image generation API.**
  Imagery is an `image:compose` artifact handoff (ADR-0042 SD5); designer
  never implements generation.
- **Auto-committing the frontend, or dispatching the engineer persona.**
  designer presents and saves; the user carries the artifact across the
  handoff. There is no phase7 commit automation (that is an engineer
  concern) and no cross-plugin dispatch (Non-Goal 2).
- **Leaking proprietary UI, screenshots, or secret-bearing code** to the
  peer or to web search at any phase. Genericize before every external call;
  the privacy gate holds for the whole lifecycle.
- **Reading parent-linkage env.** designer is not an orchestrator dispatch
  target (Non-Goal 2); `start` sequences designer's own verbs and never
  reads the parent-workflow or originating-subtask environment variables.

---

## Notes

- ADR-0020 §Sub-decision 1 — `start` is a **lifecycle macro**, not a 7th
  canonical verb; the six-verb enum is unchanged.
- ADR-0021 — this SKILL.md is the Codex-side parity mirror for the
  `/designer:start` command (cognitive-runbook level).
- ADR-0018 §sub-2 — branch=workflow invariant; `start` cannot run from
  detached HEAD.
- ADR-0042 Non-Goal 2 — `start` is designer-internal verb sequencing and
  does NOT transit cross-plugin boundaries; `parent_workflow` is unset.
- ADR-0042 is `Accepted` (the real-topic dogfood validated the persona). All
  six verbs, this macro, and the three meta skills ship.
