---
name: investigate
description: "Gathers design/UX evidence — scans references, competitor UX, design systems, and heuristic/accessibility standards, and reads the existing frontend code, then produces a durable cited design brief. The designer persona's evidence-gathering verb (ADR-0042 SD2). Use when the user wants to survey patterns for a screen or flow, gather accessibility/usability standards, study competitor UX, check design-system fit, or read how the current frontend implements something before framing or deciding. Trigger phrases include 'research this UI pattern', 'how do others do this', 'design references', 'competitor UX', 'design system', 'accessibility standards', 'heuristic evaluation reference', 'how is this screen built', 'read the frontend', 'UX research', '레퍼런스 조사', 'UX 리서치', '패턴 조사', '디자인 시스템 조사', '접근성 표준', '경쟁 UX', '프론트엔드 코드 확인', '조사해줘'. Do NOT jump to deciding or composing — gather evidence first."
---

# Investigate (designer persona)

The designer plugin's evidence-gathering verb (per ADR-0010 §2, ADR-0042
SD2). designer:investigate scans references, competitor UX, design
systems, and heuristic/accessibility standards, reads the existing
frontend code, and produces a durable cited **design brief**.

| Profile | What it does |
|---------|--------------|
| `design-brief` (default) | Research a design/UX topic across authoritative sources (UX/accessibility standards, design systems, competitor patterns, design press) AND read the existing frontend code, then produce a durable cited design-brief artifact (5-tier source taxonomy, freshness/platform tagging, paywalled/vendor-claim rules, privacy gate with screenshots sensitive-by-default) |

The profile is set via `--profile=design-brief` on
`/designer:investigate`, or inferred from the user's intent when
auto-activated. A missing or unknown profile defaults to `design-brief`
(designer:investigate is single-profile at MVP; the reference-gathering
verb is the design-brief verb). Additional investigate profiles (e.g., an
accessibility-audit deep-dive or a competitor deep-dive) are deferred
until demand arrives — the design-brief profile already spans the
evidence-gathering requirement.

**Core principle**: do NOT decide a direction or draft a spec until
evidence is gathered and the user has reviewed it. Investigation produces
a cited brief; deciding belongs to `/designer:decide`, framing the UX
problem belongs to `/designer:frame`, drafting flows/specs belongs to
`/designer:compose`, evaluating a rendered screen belongs to
`/designer:critique`.

---

## Design Task Profile

Every command-mode run records a **Design Task Profile** before allocating
effort. The canonical source is the shared Dynamic Orchestration reference —
`_shared/references/orchestration.md`, carrying the full Design Task Profile
and bilingual triggers; this section restates it inline for
self-containment. Where the two disagree, the shared reference wins. Record:

```
Design Task Profile:
  Surface:             [the UI surface / screen / flow in scope — e.g., checkout flow, onboarding, settings dashboard]
  Users:               [target user segment or persona, or "undetermined"]
  Stage:               [discovery | design | evaluation]
  Persona:             designer
  Skill-profile:       [the verb's profile mode — investigate's "design-brief"; empty for single-mode verbs like frame]
  Profile:             [L4 design archetype — general (default) | ui | flow | cta | content]
  Platform:            [delivery context — web (responsive) / iOS / Android / desktop; viewport class; LTR/RTL]
  Evidence-confidence: [LOW | MEDIUM | HIGH — how much validated evidence backs the current understanding]
  Ensemble Affinity:   [LOW | MEDIUM | HIGH — recorded, NOT a dispatch gate; always-max policy dispatches regardless]
```

Surface / Users / Stage / Platform are descriptive context for the
design-brief profile (the domain's quality dimensions — reference breadth,
standards coverage, platform spread, freshness — do not map onto
file/layer/risk axes). Skill-profile is the verb's mode
(`design-brief`); Profile is the L4 archetype (`general` at MVP).

---

## When auto-activated (without command)

Lightweight in-context investigation — no peer ensemble dispatch. The
depth is appropriate for a quick scoping pass.

### Step 1: Confirm topic and scope

1. Restate the design/UX topic as a single concise statement (the user's
   phrasing, normalized) and confirm the platform(s) (web / iOS / Android
   / desktop; viewport; LTR/RTL) and stage (discovery / design /
   evaluation).
2. **Privacy gate (initial pass)**: PRIVACY GATE: proprietary UI,
   unreleased features/flows, customer data visible in screenshots, and
   secret-bearing frontend code pass an explicit privacy gate before BOTH
   web search AND peer-host dispatch. Review the topic now for proprietary
   content and genericize or remove it (e.g., "our unreleased two-tap
   checkout for the Acme app" → "a two-step mobile checkout flow").
   **Screenshots are sensitive by default** — a raw screenshot of a real
   UI is never sent to web search; describe it in genericized terms. This
   is the first pass; the binding gate runs after sub-questions are
   drafted (Step 3), because sub-questions are also external transmission.
   See `references/design-brief-spec.md` § Privacy Gate.

### Step 2: Scope the brief

1. Draft 1–7 sub-questions that decompose the topic into investigation
   axes (established patterns, accessibility requirements, competitor UX,
   design-system fit, current-frontend behavior, …). Confirm with the
   user (or auto-proceed if obvious).
2. Define scope — what the brief covers and explicitly excludes.

### Step 3: Source-tier scan + frontend read

**Binding privacy gate (before any external call)**: re-run the gate now
over the topic AND scope AND platform AND every confirmed sub-question —
not just the topic. The spec requires topic and confirmed sub-questions to
pass before web search or peer dispatch; a sub-question can carry
proprietary content the topic alone did not (an unreleased feature name, a
customer identifier). Genericize any that does; only the genericized form
leaves the local host. Raw screenshots and raw user-research artifacts are
never transmitted. Only after this gate passes:

For each confirmed sub-question, gather evidence from three streams:

- **External references** — the **four URL-bearing tiers** from
  `references/design-brief-spec.md` § Source Type Taxonomy:
  `standards-heuristics`, `design-system`, `competitor-reference`,
  `design-press`. Use WebSearch + WebFetch. (The fifth tier,
  `user-research`, is NOT web-searched — see the third stream below.)
- **Local frontend code** — read the existing frontend implementation
  (components, styles, tokens, routing) for the surface in scope. Reading
  local code is not external transmission (no privacy gate needed to
  *read* it); it grounds the brief in how the product actually behaves
  today. Any local code excerpt that later feeds a web search or the peer
  prompt must first be redacted of secrets per the privacy gate.
- **User research** (the `user-research` tier) — anonymized aggregates the
  team already holds (usability tests, interviews, analytics, session
  replays). This stream is **local-only and supplied, never web-searched**:
  it has no public URL and is cited by the Evidence-ID field shape per
  `references/design-brief-spec.md` § User-research citation shape. Raw
  research artifacts (recordings, transcripts, real-session screenshots)
  are never transmitted externally, and the peer never invents
  user-research (it has no first-party access).

Collection priority: prefer `standards-heuristics` and `design-system` for
normative principles (what pattern is correct, what accessibility rule
applies); use `competitor-reference` for prevailing convention; use
`user-research` for how *this* product's real users behave; fall back to
`design-press` for emerging techniques and leads.

Capture sources in **research-execution order** (`[1]`, `[2]`, …),
deduplicate URLs canonically, and record title, URL, access date, tier,
plus as-of version/date and platform for any version- or
platform-sensitive claim. Mark paywalled / vendor-claim / unverified /
summary-of-paid-report sources via the `Access-note` field — never launder
a claim up the tier ladder (a common competitor pattern is not a
standard).

### Step 4: Synthesize and present (auto mode)

Produce the durable artifact per `references/design-brief-spec.md`
(canonical structure, citation conventions, audit checklist) and save it
per `references/output-file-rules.md` (per-topic directory under the
resolved output root, fixed filename `design_brief.md`):

1. Run the **Audit Checklist** before saving — every finding cited or
   sentinel-marked; freshness/platform tagged; no tier laundering;
   accessibility findings carry the honesty-boundary note (candidate
   issues, not a conformance certificate).
2. Save to `<resolved-root>/YYYY-MM-DD_<topic-slug>/design_brief.md`.
3. Present a completion summary inline — saved path, sub-questions
   covered, source-tier breakdown, overall confidence, any Open Questions.

The design-brief profile produces a saved artifact, not a workflow state
write — the artifact is the handoff. Other designer verbs
(`/designer:frame`, `/designer:decide`, `/designer:compose`,
`/designer:critique`, `/designer:refine`) consume it as additional
context.

---

## When invoked by command (`/designer:investigate` Claude command or `$designer:investigate` Codex skill mention)

Full investigation with peer ensemble parallel research and (when invoked
from a workflow command) state writes.

### Step 1: Design Task Profile

Build the Design Task Profile per the section above, capturing `Persona:
designer`, `Skill-profile: design-brief` (the verb mode), `Profile:
general` (the L4 archetype — default), Surface, Users, Stage,
Platform, Evidence-confidence, and Ensemble Affinity (recorded but not
gating — always-max policy). After the Task Profile, run the auto-mode
Step 1–3 flow above (topic + platform + stage confirmation, sub-questions,
scope, existing-directory check per `references/output-file-rules.md`, and
the privacy gate) before proceeding.

### Step 2: Local evidence gathering

No subagent spawning. The orchestrator runs WebSearch + WebFetch directly
per-sub-question AND reads the local frontend code (Step 3 above).
Local-host evidence-gathering is single-actor here because external source
retrieval + local code reading is the work, and parallelizing it across
read-only-file subagents (which lack web tools) would not help — the
cited-brief precedent designer copies.

### Step 3: Peer ensemble parallel research

Simultaneously with the local web-search + frontend-read work, launch the
peer ensemble — the **reference-scan** ensemble point per
`references/design-brief-ensemble.md`. Dispatch goes through
`plugins/designer/scripts/peer-runner.mjs run` for command-managed
ensembles; the prompt carries the genericized topic, confirmed
sub-questions, scope, platform(s), and the `<citation_contract>` and
`<privacy_contract>` XML blocks per the ensemble protocol; the companion
is invoked in JSON envelope mode via `--prompt-file`.

The privacy gate (Step 1) MUST have passed before this dispatch — the peer
prompt is external transmission. **Screenshots are never sent to the peer**
(the reference-scan path is code/text-based; `codex-companion` has no
`--image` flag — vision critique is a same-host `designer:critique`
capability). The peer call is automatic (always-max policy); skills do not
pass `--model` or `--effort` flags.

### Step 4: Collect, evaluate, synthesize

1. Wait for the local per-sub-question WebSearch / WebFetch + frontend-read
   run to return; collect findings.
2. Wait for the peer ensemble background notification; read the peer
   envelope.
3. Synthesize per `references/design-brief-ensemble.md` § Synthesis —
   `AGREED` / `LOCAL-ONLY` / `PEER-ONLY` / `CONFLICT`; PEER-ONLY claims
   undergo the bidirectional Independence Rule (Path A locally verify and
   cite with tier/as-of/platform tags, Path B move to Open Questions);
   citation numbering is remapped to local capture order (peer's internal
   labels MUST NOT be copied verbatim).

### Step 5: Present

Present clearly and confirm with the user before finalizing (present the
synthesized brief and ask the user to confirm before save; designer has no
separate formal presentation protocol — the inline present-and-confirm
flow described here is what designer ships). The design-brief profile has
three possible terminal outcomes:

- **saved** — audit passed and the brief was written to
  `<resolved-root>/YYYY-MM-DD_<topic-slug>/design_brief.md`. Show the saved
  path, sub-question coverage, source-tier breakdown, overall confidence,
  and any degraded-ensemble note.
- **aborted-at-save** — the user chose abort at the existing-directory
  gate or at a final review prompt. No file written; the synthesized brief
  is shown inline only.
- **aborted-at-scoping** — the user declined the topic, sub-questions, or
  privacy gate before dispatch. No web search / peer dispatch ran.

### State write (when invoked from a workflow command)

When `/designer:investigate` is invoked as a sub-step of a designer
workflow command (e.g., the `/designer:start` lifecycle macro), the invoking
command writes the investigation results to its
workflow file. This skill itself does not write workflow state — it hands
findings to the invoking command, which owns the write.

When invoked standalone (no parent workflow command), no workflow file
write occurs.

The saved brief artifact
(`<resolved-root>/YYYY-MM-DD_<topic-slug>/design_brief.md`) is
**orthogonal** to any workflow state write — when invoked from a workflow
command, the workflow file gets the phase-note write AND the brief
artifact is saved separately (dual write, no collision). The brief
artifact is never tracked in the workflow's state-managed body; it is
referenced by saved-path only.

---

## Completion — Active Next-Action Proposal

At the end of a successful investigation (the `saved` outcome, both the
auto-activated and the command path above), emit an **Active Next-Action
Proposal** instead of a fixed next verb — derived from these findings, not
a fixed table:

```
- selected_next:         <verb | commit | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + the evidence-quality gate>
- evidence_pointers:     <brief path / sub-questions / Open Questions — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or $designer:<verb> for a verb; the action otherwise>
```

Typical `selected_next` candidates for design-brief: `/designer:frame`
(structure a UX problem model from the brief), `/designer:decide` (choose
between surveyed patterns/directions — name the decision size
`--size=minor|standard|major`), or `/designer:compose` (draft flows/specs
from it). The routing is a fallback only when evidence is genuinely
neutral — do not end with a hardcoded "next: X". The two aborted outcomes
have no forward result, so they skip the proposal.

**Surface note (ADR-0042 Accepted).** The full designer surface ships: the
six cognitive verbs (`investigate` / `frame` / `decide` / `compose` /
`critique` / `refine`), the `/designer:start` lifecycle macro, and the
`resume` / `checkpoint` / `peer-now` meta skills. Every `next_command` this
proposal can name is runnable. The saved design brief is the durable handoff.

Always include the workflow path when invoked from a workflow command, so
the user can inspect or resume:

```
Workflow: <absolute path to workflow .md file>
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

When this verb reaches a **genuine 2+-branch decision point** — two viable
reference patterns, or two competing readings of the same accessibility or
competitor evidence, or a non-neutral `selected_next` with 2+ candidates —
surface a **compact multi-axis lens** comparing the branches across the
decisive design axes + size-appropriate supporting axes, instead of a flat
list.

The designer decision registry (`scripts/decide-registry.mjs` +
`skills/decide/references/decision-axes.yml`, ADR-0042 SD3) is the single
axis source of truth; resolve the axis set from it. When the registry is
unreachable, fall back inline: keep the decisive axes **usability
사용성** (the common-decisive design axis) and the **context lens** the
question turns on (consistency 일관성 / conversion 전환 / desirability
매력도 / content-clarity 명확성), and treat **accessibility 접근성** as the
veto gate (a hard WCAG A/AA fail is checked first). Bounded: only at a
genuine 2+-branch point (not every invocation); never a full matrix for a
trivial reversible step.

---

## Anti-patterns (do not produce)

- **Deciding or composing** while still in investigate. Investigation
  produces a cited brief; choosing a direction belongs to
  `/designer:decide`, drafting flows/specs to `/designer:compose`.
- **Skipping the peer ensemble** in command mode to save tokens.
  designer's policy is always-max — the peer is dispatched at every
  command-mode boundary, degrading silently only when the companion is
  unavailable.
- **Leaking proprietary material** through the privacy gate. The topic and
  sub-questions are external transmission — genericize before any web
  search or peer dispatch. Screenshots are sensitive by default and are
  never sent externally as bytes; the pre-genericization value MUST never
  leave the local host.
- **Tier laundering** — presenting a `competitor-reference` pattern as a
  `standards-heuristics` rule, or a vendor / unverified / paywalled claim
  at a higher authority than its tier and access-note warrant. "Three
  competitors do it" is not a standard. Every source keeps its
  `Access-note`.
- **Stale or platform-blind guidance** stated as current fact. Pattern /
  accessibility / component claims carry an as-of version/date and a
  platform tag; cross-platform transfer (iOS→web, desktop→touch, LTR→RTL)
  is an inference, not a cited fact.
- **Source-of-discovery labels in the brief artifact**. The saved brief
  MUST NOT carry `[Local]` / `[Peer]` / `[Both]` markers or any
  host-specific equivalent. Numeric `[N]` citations are the only allowed
  labeling format. See `references/design-brief-spec.md` § Ensemble Label
  Policy.
- **Decision-bound option comparisons** in the design-brief profile.
  design-brief is **topic-bound** evidence gathering. Comparing 2+
  directions against criteria to pick a path belongs to `/designer:decide`
  (or `/designer:frame` when scoping the decision).
- **Certifying accessibility conformance**. A static reference/code review
  flags *candidate* WCAG A/AA issues (contrast, semantic structure, alt
  text, visible focus) but cannot certify conformance — focus order,
  keyboard traversal, and screen-reader behavior need runtime testing
  (ADR-0042 Non-Goal 6). designer flags and prioritizes; it does not issue
  a certificate.
