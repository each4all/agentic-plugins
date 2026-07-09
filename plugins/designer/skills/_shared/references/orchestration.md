# Dynamic Orchestration (designer persona)

Follow this framework at every stage that allocates analysis effort.
Pursue the best results through task-analysis-based dynamic composition,
not static counts.

**Plugin boundary note**: this orchestration framework is
designer-internal (lives at
`plugins/designer/skills/_shared/references/`). Per ADR-0010 §5,
cross-plugin imports are forbidden — designer ships its **own copy** of
the orchestration pattern rather than importing engineer's or founder's
(ADR-0029 §Neutral copy/adapt rule; designer is the fourth copy per
ADR-0042 SD7). The **Design Task Profile** fields below are the
persona-shaped data that distinguishes this copy (ADR-0042 SD6); the
orchestration *mechanics* are the shared shape. If the framework proves
universal across L3 personas, an L1/L2 extraction may be considered
through a fresh ADR; this file does NOT serve cross-persona imports
as-is.

The **orchestrator** is the host where the user is currently invoking
the skill (Claude Code or Codex CLI). It dispatches the **peer** host's
companion ensemble in parallel per `ensemble-protocol.md` (designer's own
copy; the six design-anchored point templates ship there, and its
reference-scan point cross-references `investigate`'s self-contained
`references/design-brief-ensemble.md` contract). The orchestrator/peer
assignment is symmetric — every `/designer:*` skill runs from either
side.

---

## Principles

1. **Quality first**: Optimize for result quality, not token efficiency.
2. **Max effort**: Every primary analysis uses the host's
   maximum-effort/maximum-depth configuration. Skills do not override
   the user's host-level model/effort settings.
3. **Task decides**: No predefined minimum/maximum effort. A single-CTA
   copy decision needs less orchestration than a full checkout-flow
   redesign.
4. **Mission-specific**: Assign concrete missions tailored to this
   design question, not generic perspective labels.
5. **No overlap**: Clearly delineate mission boundaries so multiple
   perspectives do not survey the same ground.

---

## Orchestration Process

Before allocating effort, always perform Step 1 (Task Profiling). Steps
2–3 (local-agent composition + mission briefing) are **reserved**: all
six designer verbs run **orchestrator-direct** (reference scanning /
frontend reading / problem modelling / host-direct vision critique) plus
the peer ensemble, and do **not** spawn local subagents. Steps 2–3 would
apply only to a future agent-spawning designer verb — none ship today.

### Step 1: Design Task Profiling

Analyze the task along the following dimensions and record the result in
this format. These design fields replace the engineer `Scope` / `Layers`
/ `Risks` software fields and founder's market fields, which do not map
onto a UI surface (ADR-0042 SD6):

```
Design Task Profile:
  Surface:             [the UI surface / screen / flow in scope — e.g., checkout flow, onboarding, settings dashboard]
  Users:               [target user segment or persona, or "undetermined"]
  Stage:               [discovery | design | evaluation]
  Persona:             designer
  Skill-profile:       [the verb's profile mode, when the verb has one — e.g. investigate's "design-brief", critique's "usability"; empty for single-mode verbs like frame and refine]
  Profile:             [L4 design archetype — general (default) | ui | flow | cta | content]
  Platform:            [delivery context — web (responsive) / iOS / Android / desktop; viewport class; LTR/RTL]
  Evidence-confidence: [LOW | MEDIUM | HIGH — how much validated evidence backs the current understanding]
  Ensemble Affinity:   [LOW | MEDIUM | HIGH]
```

This is the canonical Design Task Profile. The verb skills state it
inline for self-containment; where the two ever disagree, this file is
the source of truth.

Two distinct profile axes, kept separate to avoid conflation:

- **Skill-profile** — the verb's own profile *mode*
  (`investigate --profile=design-brief`,
  `critique --profile=usability|a11y|conversion|consistency`,
  `compose --profile=spec|flow|wireframe`). It selects how the verb runs,
  not the L4 sub-discipline. Single-mode verbs (`frame`, `decide`,
  `refine`) leave it empty.
- **Profile (L4 archetype)** — the 4-layer L4 axis (per ADR-0010): the
  persona dictates which L3 plugin owns the orchestration (`designer`);
  the L4 profile passes design sub-discipline context to skills. Its
  concrete effect is the decision-preset selection below.

**Analysis dimensions**:

- **Surface**: the screen / flow / component in scope. Drives which
  source tiers matter (see `../../investigate/references/design-brief-spec.md`).
- **Users**: who the user is. Sharpens sub-questions and the
  usability evidence the brief must seek.
- **Stage**: `discovery` (reference + pattern scanning), `design`
  (composing flows / specs / copy), or `evaluation` (critiquing a spec
  or a rendered screen). Stage sets evidence-depth expectations — a
  `discovery` scan tolerates more Open Questions than an `evaluation` pass.
- **Platform**: web / iOS / Android / desktop, viewport class, LTR/RTL.
  A pattern that is correct on desktop web may violate a mobile
  platform convention; platform is not decoration.
- **Evidence-confidence**: how validated the current picture is. LOW
  with honest Open Questions beats HIGH that hides gaps.
- **Ensemble Affinity**: LOW / MEDIUM / HIGH. Recorded for context;
  **NOT a dispatch gate** — designer's always-max policy dispatches the
  peer ensemble at every command-mode phase boundary regardless, per
  `ensemble-protocol.md` / `design-brief-ensemble.md`.

---

## L4 profiles → decision presets (ADR-0042 SD3 / SD6)

The `Profile` axis selects the decision preset `designer:decide` resolves
when the user supplies no explicit `--preset` / `--size`. Every profile
resolves to a preset **defined** in
`../../decide/references/decision-axes.yml`:

| L4 Profile | Design archetype | Decision preset | Decisive axes (usability is common) |
|---|---|---|---|
| `general` | default; no archetype declared | `balanced` | usability + consistency |
| `flow` | multi-step user flows, navigation, IA | `balanced` | usability + consistency |
| `ui` | UI polish, visual/interaction treatment, brand surface | `experience` | usability + desirability |
| `cta` | calls-to-action, conversion / growth surfaces | `conversion` | usability + conversion |
| `content` | microcopy, labels, information clarity | `clarity` | usability + content-clarity |

**접근성 accessibility is the veto gate in every preset** — it is never
traded off against the decisive axes (ADR-0042 SD3); a hard candidate
WCAG A/AA barrier vetoes an option regardless of its decisive strength.
The candidate-only boundary holds (ADR-0042 Non-Goal 6): designer flags
and prioritizes; it does not certify conformance.

The map above is **not** re-declared here as data. Its single source of
truth is `PROFILE_PRESET_MAP` in `../../../scripts/decide-registry.mjs`,
which satisfies the ADR-0027 §1.5(3) profile-override slot; the table is
its documentation.

**Precedence (ADR-0027 §1.5, unchanged)**: an explicit `--preset=<id>`
wins, then an explicit `--size=<tier>`, then the L4 profile, then the
`balanced` default. Two consequences worth stating plainly:

- **`--size` outranks the profile, and designer's size→preset map is
  degenerate** (every tier implies `balanced`, because `--size` controls
  per-axis rendering depth here, not preset choice). So
  `--size=minor` on a `cta` profile resolves `balanced`, **not**
  `conversion` — the archetype is dropped. This is ladder-correct (a typed
  flag outranks ambient context) but easy to trip over, so the resolver
  emits a stderr diagnostic naming the archetype it discarded. Drop
  `--size` to let the profile's preset apply.
- **An unknown profile degrades to `balanced` with a diagnostic** and sets
  `registry_fallback` — it never halts a decision, and the fallback signal
  suppresses the Brainstorm `<axis_awareness>` block so the peer is not
  pinned to an axis frame the caller never chose.

A profile-implied resolution that *changes* the outcome also emits a
provenance diagnostic (`general` / `flow` resolve the default and stay
silent). The §5.6 context carries no chosen-source field, so stderr is the
only place a preset's provenance is visible.

The CLI reads the active profile from the `AGENTIC_DESIGNER_PROFILE`
environment variable (the L4 archetype this Design Task Profile
recorded). The profile is **not** a `/designer:decide` command flag — the
ADR-0027 §2.2 grammar (`--size` / `--preset` / `--weights`) is unchanged —
and it is **not** the `state.mjs --profile` skill-profile field either.

**The env seam is ambient, not durable.** It is process state, not
workflow state, with two consequences the runbooks must respect:

- Shell state does not survive across Bash tool invocations. An `export`
  in one block is gone in the next, so the archetype must be carried
  **inline** on the resolve invocation:
  `AGENTIC_DESIGNER_PROFILE="<archetype>" node …/decide-registry.mjs resolve …`.
  A lost value silently resolves `balanced`.
- Conversely, a value left exported in the operator's shell is inherited
  by an unrelated standalone `/designer:decide`, silently selecting an
  archetype preset the user did not ask for.

Both are observable rather than silent: the resolver emits a stderr
provenance diagnostic whenever an archetype changes the outcome, and
`commands/decide.md` cats the resolver's stderr into the command output,
so the LLM and the user both see which preset arrived and why. The §5.6
on-wire context deliberately carries no chosen-source field (ADR-0027 PR4
refine M4 dropped `_chosenSource` as off-schema), so **stderr is the
provenance channel** — widening the context schema would be an ADR-0027
amendment, not a designer-local change.

`print` / `brand` / `motion` are visual-production disciplines and are
**not** designer L4 profiles (ADR-0042 Non-Goal 5).

---

## Bilingual triggers (EN / KO)

designer is authored for a bilingual operator. Every skill's frontmatter
`description` carries **both** English and Korean trigger phrases so
auto-activation fires on either language (ADR-0042 SD6). The convention:

| Concern | English triggers | Korean triggers |
|---|---|---|
| investigate | "research UX patterns", "competitor UX", "design system", "heuristic standards" | "레퍼런스 조사", "경쟁 UX", "디자인 시스템" |
| frame | "define the UX problem", "success metrics", "job-to-be-done" | "문제 정의", "성공 지표", "스코프 잡아줘" |
| decide | "which pattern", "compare these layouts", "pick a direction" | "어떤 패턴", "비교해줘", "결정 도와줘" |
| compose | "user flow", "wireframe spec", "CTA copy", "information architecture" | "유저플로우", "와이어프레임", "화면 설계" |
| critique | "review this UI", "heuristic evaluation", "accessibility review" | "UX 검토", "접근성", "화면 리뷰" |
| refine | "apply the findings", "fix the a11y issue", "iterate on this screen" | "리뷰 반영", "수정해줘", "다시 검토" |
| start | "take this screen end-to-end", "design this flow start to finish" | "디자인 처음부터 끝까지", "엔드 투 엔드로" |
| checkpoint / resume / peer-now | "checkpoint", "resume designer", "ask the peer" | "체크포인트", "재개", "피어 자문" |

A new skill without Korean triggers is a defect: the operator's own
vocabulary is the auto-activation surface.

---

## image L2 composition boundary (ADR-0042 SD5)

When a design deliverable needs **actual generated imagery** — a concept
visual, a hero image, a moodboard, an illustration — designer
**composes** the already-shipped `image` L2 capability (ADR-0037). It
does **not** generate imagery itself, and it never calls an image
generation API.

The composition is an **artifact handoff**, not a dispatch (designer is
non-dispatch, ADR-0042 Non-Goal 2):

1. designer's `compose` produces the structural/textual artifact and, in
   it, an explicit **image brief** — subject, composition, style,
   palette, aspect ratio, success criteria — as the handoff payload.
2. The user (or the operator's next command) runs `/image:frame` →
   `/image:compose` with that brief. `image` generates through Codex's
   integrated gpt-image tool; agentic-plugins **never** calls the OpenAI
   image API directly (ADR-0037 Alternative 6).
3. The generated image returns to designer as an input to
   `designer:critique` (host-direct vision) like any other rendered
   surface.

Two hard boundaries hold in code, not just prose:

- **No generation in designer.** No designer script, hook, or helper
  implements image generation.
- **No direct image API in designer.** No designer file constructs an
  OpenAI client, reads `OPENAI_API_KEY`, or calls `api.openai.com`.
  A shape test scans the plugin tree for these forms (the
  `plugins/image` direct-API-ban sentinel precedent).

Pixel-accurate UI mockups are outside both plugins' scope: `image`
(gpt-image) is strong at concept/illustration, and the code-first
delivery does not need mockups — the running frontend is the design
artifact of record (ADR-0042 Non-Goal 3).

---

## Step 2: Composition (reserved — no agent-spawning designer verb ships today)

Select local-analysis roles from designer's design-analysis roster (a
future agent-taxonomy reference — designer ships no agent-spawning verb
today, so Steps 2–3 are reserved, not exercised).

**Selection criteria — ask yourself for each role:**

> "If this perspective is missing, could this design judgment carry an
> **undetected blind spot** (a user segment, an assistive-technology
> path, a conversion leak)?"

- YES → include
- NO → exclude

> "Can this perspective provide meaningful feedback that **does not
> overlap** with other selected perspectives?"

- YES → include
- NO → exclude (absorbed by another perspective)

**Guidelines:**

- Do not over-allocate for a quick pass. A single button-label choice
  does not need a full heuristic sweep.
- Do not omit perspectives for a committed surface. A checkout flow must
  include the accessibility perspective — it carries the veto gate.
- Judge by **actual risk**, not surface framing. A "simple" settings
  toggle can carry heavy accessibility and destructive-action exposure.

## Step 3: Mission Briefing (reserved — no agent-spawning designer verb ships today)

Give each selected perspective a **concrete mission specific to this
design question**.

**Bad mission:**
> "Look at the usability"

**Good mission:**
> "Evaluate the three-step mobile checkout against Nielsen heuristics 1
> (system status), 5 (error prevention), and 9 (error recovery). Focus on
> the payment-failure path at 375px viewport. Do not evaluate visual
> styling — that is the desirability perspective's ground."

**Mission writing rules:**

1. Include the specific design context (surface, users, stage, platform).
2. Specify which criteria sections / viewports / states to focus on.
3. Concretize the key question for this task.
4. Explicitly state boundaries to avoid overlap with other missions.

**Ensemble parallel track:**

The orchestrator launches the peer ensemble (Codex from Claude side, or
Claude from Codex side) in parallel with any local analysis. Dispatch is
automatic on every `/designer:*` phase boundary (always-max policy);
affinity is recorded but does not gate. The peer runs as an independent
parallel track — it is NOT a local agent and is not included in any
agent count or mission briefing. It receives its own prompt per the
ensemble contract (`design-brief-ensemble.md` for reference-scan;
`ensemble-protocol.md` for the other point types). **The peer path is
code/text only** — vision-grounded judgment is same-host (ADR-0042 SD4
item 3).

### Failure handling

If any local analysis fails to return: notify the user which
perspective failed, ask retry-or-proceed, follow the user's decision,
and if proceeding note the missing perspective in the synthesis so the
user knows coverage was incomplete. Peer ensemble failures are handled
separately per the ensemble contract — graceful degradation, never
blocks the workflow.

---

## Examples

### Example 1: Investigate (design-brief) — pattern + standards scan

```
Design Task Profile:
  Surface:             mobile web checkout, 3 steps (cart → address → pay)
  Users:               first-time buyers on 375px viewport
  Stage:               discovery
  Persona:             designer
  Skill-profile:       design-brief
  Profile:             flow
  Platform:            web (responsive), 375–768px, LTR + RTL required
  Evidence-confidence: LOW
  Ensemble Affinity:   HIGH (broad pattern landscape, contested guidance)

Execution: design-brief profile — orchestrator runs per-sub-question
  WebSearch/WebFetch across the 4 URL-bearing source tiers, reads the
  existing frontend, and folds in local user-research aggregates; peer
  reference-scan dispatched per design-brief-ensemble.md (always-max).
  No local subagents. Screenshots never leave the local host.
```

### Example 2: Critique (a11y lens) — post-code quality pass

```
Design Task Profile:
  Surface:             checkout payment step (rendered screen + component code)
  Users:               first-time buyers; assistive-technology users
  Stage:               evaluation
  Persona:             designer
  Skill-profile:       a11y
  Profile:             flow
  Platform:            web (responsive), 375px + 1280px
  Evidence-confidence: MEDIUM
  Ensemble Affinity:   MEDIUM

Execution: critique reads the rendered screenshot host-direct (same-host
  vision) plus the frontend code, against quality-criteria.md § Accessibility.
  Findings are CANDIDATE WCAG A/AA issues (ADR-0042 Non-Goal 6) — an
  unmitigated gate finding is CRITICAL. The peer Review-point ensemble
  receives the genericized code/text only (no image bytes). No local subagents.
```
