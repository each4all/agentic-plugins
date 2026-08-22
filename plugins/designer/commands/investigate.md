---
description: Scan references, competitor UX, design systems, and heuristic/accessibility standards; read the frontend; produce a durable cited design brief — the designer persona's evidence-gathering verb
argument-hint: --profile=design-brief | (or natural-language design/UX topic)
---

# Designer · Investigate

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go
— use the host's task-tracking tools when the session exposes them,
and keep an inline checklist when it does not. The peer ensemble runs automatically per
`skills/investigate/references/design-brief-ensemble.md` (reference-scan
point type) — never ask the user whether to invoke the peer, and never
direct them to run companion CLIs manually. When the companions plugin or
peer CLI is unavailable, the ensemble degrades silently to local-only.

The plugin root in shell snippets below is `$CLAUDE_PLUGIN_ROOT` (set by
Claude Code for plugin slash commands). If unset for any reason, fall back
to
`$(find ~/.claude/plugins/cache/agentic-plugins/designer -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

> **designer is not an orchestrator dispatch target** (ADR-0042 Non-Goal
> 2): unlike the engineer commands, this command does NOT read
> `AGENTIC_PARENT_WORKFLOW` / `AGENTIC_ORIGINATING_SUBTASK`, and designer
> `state.mjs create` does not accept parent-linkage flags. designer
> workflows are user-invoked and branch-anchored only.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

Determine workflow state via the host-shared canonical I/O module:

1. **Find active workflow**:

   ```bash
   REPO_ROOT="$(git rev-parse --show-toplevel)"
   GIT_BRANCH="$(git branch --show-current)"
   # ADR-0018 §sub-2 — designer workflows are anchored to a branch;
   # detached HEAD has no branch context to anchor to.
   if [ -z "$GIT_BRANCH" ]; then
     echo "✗ Detached HEAD detected — designer workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
     echo "  Switch to a branch first: git switch <branch>" >&2
     exit 1
   fi
   # ADR-0042 — designer anchors to the frontend/design project git
   # repository (design briefs + flow/wireframe specs are version-controlled
   # deliverables that feed frontend code). git rev-parse above fails outside
   # a repo; if so, refuse with manual-init guidance:
   #   git init   # or: cd into your frontend/design project repo
   FIND_ERR="${TMPDIR:-/tmp}/designer-find-active-$$.err"
   ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
     find-active --repo-root "$REPO_ROOT" 2>"$FIND_ERR")"
   FIND_RC=$?
   if [ "$FIND_RC" -ne 0 ]; then
     echo "✗ find-active failed (exit $FIND_RC):" >&2
     cat "$FIND_ERR" >&2
     rm -f "$FIND_ERR"
     exit "$FIND_RC"
   fi
   rm -f "$FIND_ERR"
   ```

   - Empty `$ACTIVE` → no active workflow on this branch → bootstrap (Step 2).
   - Non-empty path → active workflow on this branch → append-on-resume (Step 3).
   - `find-active` exits 1 on per-branch duplicate (corruption / external mutation); the snippet surfaces the diagnostic and aborts.

2. **Bootstrap** (no active workflow):

   ```bash
   GIT_BRANCH="$(git branch --show-current)"
   GIT_HEAD="$(git rev-parse HEAD)"
   STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
   ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
     --repo-root "$REPO_ROOT" \
     --verb investigate --host "${AGENTIC_HOST:-claude}" \
     --persona designer \
     --git-baseline-branch "$GIT_BRANCH" \
     --git-baseline-head "$GIT_HEAD" \
     --status-digest "$STATUS_DIGEST" \
     --profile "${AGENTIC_PROFILE:-<profile from $ARGUMENTS — design-brief; default 'design-brief'>}" \
     --original-request "${AGENTIC_TOPIC:-<one-line genericized design/UX topic>}" \
     --current-phase phase-0-bootstrap \
     --next-action "Run investigate skill")"
   ```

   `state.mjs create` enforces the directory-level lock + single-active
   invariant per ADR-0011 §3, and writes only persona `designer`
   (canonical-home guard).

3. **Append-on-resume** (active workflow exists):

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
     --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
     --verb investigate \
     --profile "<profile or empty>" \
     --phase-label "Phase 0: Resume into investigate" \
     --phase-note "Resumed from prior verb. Profile=<...>." \
     --current-phase phase-0-resume \
     --next-action "Run investigate skill" \
     --event resumed
   ```

---

## Phase 1 — Execute investigate

Follow the investigate skill's "When invoked by command" mode at
`$CLAUDE_PLUGIN_ROOT/skills/investigate/SKILL.md`. The skill performs:

- **Step 1**: Build the Design Task Profile (Persona=designer,
  Skill-profile=design-brief, Profile=general (L4 archetype), Surface,
  Users, Stage, Platform, Evidence-confidence — canonically defined in the
  shared `_shared/references/orchestration.md` Dynamic Orchestration
  reference, restated inline in the skill), then confirm topic + platform +
  stage, draft 1–7 sub-questions, define scope, run the existing-directory
  check, and pass the privacy gate.
- **Step 2**: No subagent spawning — the orchestrator runs WebSearch +
  WebFetch directly per-sub-question (using the 5 source-type tiers in
  `skills/investigate/references/design-brief-spec.md`) AND reads the local
  frontend code for the surface in scope.
- **Step 3**: Dispatch the reference-scan peer ensemble per
  `skills/investigate/references/design-brief-ensemble.md` via
  `$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs run`. The peer runs in the
  background; the orchestrator continues its own per-sub-question web
  search + frontend read in parallel.
- **Step 4**: Collect both sources, classify findings per AGREED /
  LOCAL-ONLY / PEER-ONLY / CONFLICT; apply the bidirectional Independence
  Rule (Path A locally verify + cite with tier/as-of/platform tags, Path B
  move to Open Questions); remap citation numbers to local capture order.
- **Step 5**: Run the Audit Checklist
  (`skills/investigate/references/design-brief-spec.md`) and save the brief
  per `skills/investigate/references/output-file-rules.md` (per-topic
  directory under the resolved output root, fixed filename
  `design_brief.md`).

### Privacy gate (before any external call)

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data
visible in screenshots, and secret-bearing frontend code pass an explicit
privacy gate before BOTH web search AND peer-host dispatch. Genericize or
remove proprietary content from the topic and sub-questions before
WebSearch / WebFetch or peer dispatch; only the genericized form leaves
the local host. **Screenshots are sensitive by default** — a raw
screenshot of a real UI is never sent to web search or the peer; describe
it in genericized terms (host-direct vision critique of a screenshot is a
same-host `designer:critique` capability, not this reference-scan flow).
Frontend code is redacted of secrets before any external send. If the
topic cannot be genericized without losing the question, run local-only or
abort at scoping. The pre-genericization value MUST never leave the local
host. See `skills/investigate/references/design-brief-spec.md` § Privacy
Gate.

### Ensemble dispatch — concrete invocation

Build the reference-scan prompt per
`skills/investigate/references/design-brief-ensemble.md` § Prompt
Construction (it carries the genericized topic, confirmed sub-questions,
scope, platform, and the `<citation_contract>` + `<privacy_contract>` XML
blocks) and spawn the peer in the background:

```bash
PROMPT_FILE="$(mktemp -t designer-investigate-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="reference-scan-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the reference-scan XML prompt to $PROMPT_FILE (privacy gate must have passed; no screenshot bytes) ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase investigate \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type reference-scan --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

`--prompt-file` keeps user-controlled material (topic, sub-questions) out
of shell parsing and process argv per `companions/contract.md` § 2.2. Use
`run_in_background: true` on the Bash tool; collect output once the
orchestrator's local per-sub-question web search + frontend read completes.

When the companion is missing or returns exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`),
record the failure in the workflow body under "### Ensemble degraded:" and
proceed with local-only synthesis per the protocol's *Failure Handling*.

---

## Phase 2 — State finalize

After Phase 1 returns the synthesized brief, append a phase note that
captures (a) the synthesis verdict, (b) ensemble launch + result markers,
and (c) the active next-action proposal. Include the saved brief's
absolute path under a `### Brief saved` heading so future workflow
consumers can locate the artifact (the brief itself stays orthogonal to
the workflow body — referenced by path only, never inlined). Workflow
phase notes MAY carry source-of-discovery labels (`[Both]` / `[Local]` /
`[Peer]`); the saved brief artifact MUST NOT, per
`skills/investigate/references/design-brief-spec.md` § Ensemble Label
Policy.

```bash
NOTE="### Ensemble launched: reference-scan at <iso-utc>

### Ensemble synthesis: design-brief verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Brief saved

<absolute path to design_brief.md>

### Active next-action proposal

- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + evidence-quality gate>
- evidence_pointers:     <brief path / sub-questions / Open Questions — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or \$designer:<verb> for a verb>
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Investigate (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "<compact selected_next + why + next_command — e.g. 'Frame the UX problem from this cited brief (/designer:frame)'>" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase investigate --ensemble-type reference-scan --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ADR-0029 §1 / completion-output contract §2 — set --next-action (the
# append above and this terminal write) to the COMPACT form of the
# proposal above (selected_next + one-line why + next_command) so the
# durable state and the code-emitted completion footer agree with the
# Active Next-Action Proposal. The value shown is the typical-case
# default; override it when the verb's result selects a different next
# step (e.g. the owner publish/commit step).
# ADR-0017 §sub-decision 5 — atomic terminal write. Bumps current_phase
# into the auto-archive whitelist + sets terminal_marker=true so the Stop
# hook can archive (the HEAD-moved gate still enforces real progress
# before the archive triggers).
# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
# archive gates are evaluated at the end of THIS turn, not at session close;
# if a gate fails the workflow stays marked and a later Stop re-evaluates it.
# Clearing the marker with `--terminal-marker false` works only before that
# Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
# --terminal-phase), and does not restore the previous phase or next_action.
# On Codex the Stop hook runs only once the operator has trusted the plugin
# hooks (`/hooks`), so evaluation waits for that. Full contract:
# skills/_shared/references/session-handoff.md § Archive timing.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "<compact selected_next + why + next_command — e.g. 'Frame the UX problem from this cited brief (/designer:frame)'>" \
  --event updated
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If executing this verb surfaces a **genuine 2+-branch decision point** —
two viable reference patterns, or two competing readings of the same
accessibility / competitor evidence — surface a **compact multi-axis lens**
comparing the branches across the decisive design axes (usability 사용성 +
the context lens the question turns on, with accessibility 접근성 as the
veto gate, per ADR-0042 SD3) + size-appropriate supporting axes, instead
of a flat list. The designer decision registry
(`scripts/decide-registry.mjs` +
`skills/decide/references/decision-axes.yml`) is the axis source of truth;
when it is unreachable, read the decisive axes inline as above.
Bounded: only at a genuine 2+-branch point, never a full matrix for a
trivial reversible step.

---

## Completion

Output the synthesized brief summary and one of:

- `✓ Design brief saved.` — audit passed, file written to
  `<resolved-root>/YYYY-MM-DD_<topic-slug>/design_brief.md`. Show the saved
  path, sub-question coverage, source-tier breakdown, overall confidence,
  and any degraded-ensemble note.
- `✗ Design brief aborted at save.` — the user declined at the
  existing-directory gate or final review. No file written; the
  synthesized brief is shown inline only.
- `✗ Design brief aborted at scoping.` — the user declined the topic,
  sub-questions, or privacy gate before dispatch. No web search / peer
  dispatch ran.

For the saved case, emit an **Active Next-Action Proposal** (the inline
shape shown in `skills/investigate/SKILL.md` § Completion): typical
`selected_next` candidates are `/designer:frame` (structure a UX problem
model from the brief), `/designer:decide` (choose between surveyed
patterns — name the size `--size=minor|standard|major`), or
`/designer:compose` (draft flows/specs from it). Do not end with a
hardcoded "next: X". The two aborted cases have no forward result, so they
skip the proposal.

ADR-0042 is `Accepted` — the full designer surface (the six verbs, the
`/designer:start` lifecycle macro, and the `resume` / `checkpoint` /
`peer-now` meta skills) ships, so every `next_command` is runnable. The saved brief is the durable
handoff. See
`skills/investigate/SKILL.md` § Completion.

Always include the workflow path so the user can inspect or resume:

```
Workflow: <absolute path to workflow .md file>
```

The runtime completion footer is **code-emitted** on this verb's terminal
path (ADR-0039, enabled for designer by ADR-0043 S4): `state.mjs
set-terminal` fires the ADR-0031 session-handoff sidecar, which shells out
to the runtime `footer.mjs` and prints the rendered footer — context
state, completion state (designer's manually-published mapping surfaces
`publish-needed` when only the owner's save/commit remains) + state-derived
next action, workflow id/path, artifact pointers, recommended next work,
and the continue-vs-fresh session-handoff — on that command's **stderr**.
Do **not** hand-compose a second footer; surface the one the terminal
command already emitted. The footer is advisory + pointer-only and
fail-closed (a missing/too-old runtime emits nothing, and the SessionStart
backstop still re-surfaces the handoff); it never mutates host session
context. Detached HEAD never auto-recommends a fresh session (ADR-0018
§sub-2; the branch-based preflight is what reports "no active branch
context" — the path-targeted terminal sidecar still renders normally).
Wiring details:
`skills/_shared/references/session-handoff.md`.
