---
description: Scan markets, regulations, competitors, and demand signals; produce a durable cited business brief — the founder persona's evidence-gathering verb
argument-hint: --profile=business-brief | (or natural-language business topic)
---

# Founder · Investigate

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go
— use the host's task-tracking tools when the session exposes them,
and keep an inline checklist when it does not. The peer ensemble runs automatically per
`core/skills/investigate/references/business-brief-ensemble.md` (research-scan
point type) — never ask the user whether to invoke the peer, and never
direct them to run companion CLIs manually. When the companions plugin or
peer CLI is unavailable, the ensemble degrades silently to local-only.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_FOUNDER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

> **founder is not an orchestrator dispatch target** (ADR-0036 Non-Goal
> 3): unlike the engineer commands, this command does NOT read
> `AGENTIC_PARENT_WORKFLOW` / `AGENTIC_ORIGINATING_SUBTASK`, and founder
> `state.mjs create` does not accept parent-linkage flags. founder
> workflows are user-invoked and branch-anchored only.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

Determine workflow state via the host-shared canonical I/O module:

<!-- pipeline:begin investigate-phase-0 -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='founder'
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — the persona's workflows are anchored to a branch.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — ${PERSONA} workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to a branch first: git switch <branch>" >&2
  exit 1
fi
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT")"
FIND_RC=$?
if [ "$FIND_RC" -ne 0 ]; then
  echo "✗ find-active failed (exit $FIND_RC); its error is above." >&2
  exit "$FIND_RC"
fi
```
<!-- pipeline:end investigate-phase-0 -->

founder requires a git workspace (ADR-0036 SD5; recommended: a
per-venture content repository). If `git rev-parse` fails, refuse with
manual-init guidance (git init, or cd into your venture content repo).
`find-active` exits 1 on a per-branch duplicate (corruption or an external
mutation); the block surfaces the diagnostic and aborts.

Empty `$ACTIVE` → bootstrap a new workflow with verb=investigate:

<!-- pipeline:begin investigate-bootstrap -->
In the block, replace the profile placeholder with the profile the arguments
name, and `<the original request described above>` with a
one-line genericized business topic; `AGENTIC_PROFILE` and `AGENTIC_TOPIC` take their
places when they are set.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='investigate'
DEFAULT_PROFILE='business-brief'
GIT_BRANCH="$(git branch --show-current)"
GIT_HEAD="$(git rev-parse HEAD)"
STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb 'investigate' --host "${AGENTIC_HOST:-claude}" --persona 'founder' \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --profile "${AGENTIC_PROFILE:-<profile from the arguments above — default ${DEFAULT_PROFILE}>}" \
  --original-request "${AGENTIC_TOPIC:-<the original request described above>}" \
  --current-phase phase-0-bootstrap \
  --next-action "Run ${VERB} skill")" || exit $?
```
<!-- pipeline:end investigate-bootstrap -->

`state.mjs create` enforces the directory-level lock + single-active
invariant per ADR-0011 §3, and writes only persona `founder`
(canonical-home guard).

Non-empty `$ACTIVE` → append-on-resume:

<!-- pipeline:begin investigate-resume -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='investigate'
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb 'investigate' \
  --profile "<profile or empty>" \
  --phase-label "Phase 0: Resume into ${VERB}" \
  --phase-note "Resumed from prior verb. Profile=<...>." \
  --current-phase phase-0-resume \
  --next-action "Run ${VERB} skill" --event resumed || exit $?
```
<!-- pipeline:end investigate-resume -->

---

## Phase 1 — Execute investigate

Follow the investigate skill's "When invoked by command" mode at
`${CLAUDE_PLUGIN_ROOT}/core/skills/investigate/SKILL.md`. The skill performs:

- **Step 1**: Build the Business Task Profile (Persona=founder,
  Skill-profile=business-brief, Profile=general (L4 archetype), Market,
  Segment, Stage, Risk-class, Evidence-confidence per
  `core/skills/_shared/references/orchestration.md`),
  then confirm topic + jurisdiction + stage, draft 1–7 sub-questions,
  define scope, run the existing-directory check, and pass the privacy
  gate.
- **Step 2**: No subagent spawning — the orchestrator runs WebSearch +
  WebFetch directly per-sub-question, using the 5 source-type tiers in
  `core/skills/investigate/references/business-brief-spec.md`.
- **Step 3**: Dispatch the research-scan peer ensemble per
  `core/skills/investigate/references/business-brief-ensemble.md` via
  `${CLAUDE_PLUGIN_ROOT}/scripts/peer-runner.mjs run`. The peer runs in the
  background; the orchestrator continues its own per-sub-question web
  search in parallel.
- **Step 4**: Collect both sources, classify findings per AGREED /
  LOCAL-ONLY / PEER-ONLY / CONFLICT; apply the bidirectional Independence
  Rule (Path A locally verify + cite with tier/as-of/jurisdiction tags,
  Path B move to Open Questions); remap citation numbers to local capture
  order.
- **Step 5**: Run the Audit Checklist
  (`core/skills/investigate/references/business-brief-spec.md`) and save the
  brief per `core/skills/investigate/references/output-file-rules.md`
  (per-topic directory under the resolved output root, fixed filename
  `business_brief.md`).

### Privacy gate (before any external call)

<!-- pipeline:begin investigate-privacy-gate -->
PRIVACY GATE: proprietary venture concepts, interview/customer data, and unpublished business material
pass an explicit privacy gate before BOTH web search AND peer-host dispatch.
Genericize or remove proprietary content from the topic and sub-questions before WebSearch / WebFetch or peer dispatch; only the genericized form leaves the local host. If the topic cannot be genericized without losing the question, run local-only or abort at scoping. The pre-genericization value MUST never leave the local host.
See `core/skills/investigate/references/business-brief-spec.md` § Privacy Gate.
<!-- pipeline:end investigate-privacy-gate -->

<!-- pipeline:begin investigate-privacy-no-image -->
No dispatch passes `--image`: the companion peer path has no image channel, so
an image never reaches the peer as bytes.
<!-- pipeline:end investigate-privacy-no-image -->

### Ensemble dispatch — concrete invocation

Build the research-scan prompt per
`core/skills/investigate/references/business-brief-ensemble.md` § Prompt
Construction (it carries the genericized topic, confirmed sub-questions,
scope, jurisdiction, and the `<citation_contract>` + `<privacy_contract>`
XML blocks) and spawn the peer in the background:

<!-- pipeline:begin investigate-dispatch -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ENSEMBLE_TYPE='research-scan'
PROMPT_FILE="$(mktemp -t 'founder'-'investigate'-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="${ENSEMBLE_TYPE}-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the prompt to $PROMPT_FILE (the privacy gate above must have
#     passed; the prompt carries only genericized text) ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase 'investigate' \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type 'research-scan' --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```
<!-- pipeline:end investigate-dispatch -->

`--prompt-file` keeps user-controlled material (topic, sub-questions) out
of shell parsing and process argv per `companions/contract.md` § 2.2. Use
`run_in_background: true` on the Bash tool; collect output once the
orchestrator's local per-sub-question web search completes.

When the companion is missing or returns exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`),
record the failure in the workflow body under "### Ensemble degraded:"
and proceed with local-only synthesis per the protocol's *Failure
Handling*.

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
`core/skills/investigate/references/business-brief-spec.md` § Ensemble Label
Policy.

<!-- pipeline:begin investigate-finalize -->
The phase note this step records — fill in every `<…>`:

```markdown
### Ensemble launched: research-scan at <iso-utc>

### Ensemble synthesis: business-brief verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Brief saved

<absolute path to business_brief.md>

### Active next-action proposal

(per `core/skills/_shared/references/entry-routing-contract.md` § Active Next-Action Proposal — derived from this artifact, not a fixed table)
- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + evidence-quality gate>
- evidence_pointers:     <brief path / sub-questions / Open Questions — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or $founder:<verb> for a verb>
```

Then run the block with the filled-in note in place of its placeholder line,
between the two `PHASE_NOTE` lines. The quoted heredoc hands the note to
`state.mjs` as written: no quote, `$`, backtick or backslash in it is read by
the shell. The first line that reads `PHASE_NOTE` alone ends the note, and
the shell runs every line after it as a command, so when the note itself holds
such a line, replace both `PHASE_NOTE` delimiters with a word no line of the
note consists of.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# Where read takes no -d (dash) it assigns nothing, so clear NOTE first: a
# value the shell inherited must not stand in for the note.
unset NOTE
IFS= read -r -d '' NOTE <<'PHASE_NOTE' || true
<the phase note above, filled in>
PHASE_NOTE
# A shell whose read has no -d (dash) reads nothing: stop before any write.
[ -n "$NOTE" ] || { echo "✗ No phase note was read; nothing was written." >&2; exit 1; }

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label 'Phase 1: Investigate (synthesized)' \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action '<one-sentence imperative for next verb>' \
  --event updated || exit $?

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase 'investigate' --ensemble-type 'research-scan' --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ADR-0029 §1 / completion-output contract §2 — set --next-action (the
# append above and this terminal write) to the COMPACT form of the
# proposal above (selected_next + one-line why + next_command) so the
# durable state and the code-emitted completion footer agree with the
# Active Next-Action Proposal. The value shown is the typical-case
# default; override it when the verb's result selects a different next
# step (e.g. the owner publish/commit step).
# ADR-0017 §sub-decision 5 — atomic terminal write.
# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
# archive gates are evaluated at the end of THIS turn, not at session close;
# if a gate fails the workflow stays marked and a later Stop re-evaluates it.
# Clearing the marker with `--terminal-marker false` works only before that
# Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
# --terminal-phase), and does not restore the previous phase or next_action.
# On Codex the Stop hook runs only once the operator has trusted the plugin
# hooks (`/hooks`), so evaluation waits for that. Full contract:
# core/skills/_shared/references/session-handoff.md § Archive timing.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action '<one-sentence imperative for next verb>' \
  --event updated
```
<!-- pipeline:end investigate-finalize -->

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If executing this verb surfaces a **genuine 2+-branch decision point** —
two viable candidate items, or two competing readings of the same demand
evidence — surface a **compact multi-axis lens** comparing the branches
across the decisive business axes (시장성 market-attractiveness / 단위경제
unit-economics, per ADR-0036 SD3) + size-appropriate supporting axes,
instead of a flat list. Resolve the decisive axes from founder's decision
registry (`scripts/decide-registry.mjs` +
`core/skills/decide/references/decision-axes.yml`), or read them inline as above
when the resolver is not reachable. Bounded: only at a genuine 2+-branch
point, never a full matrix for a trivial reversible step.

---

## Completion

Output the synthesized brief summary and one of:

- `✓ Business brief saved.` — audit passed, file written to
  `<resolved-root>/YYYY-MM-DD_<topic-slug>/business_brief.md`. Show the
  saved path, sub-question coverage, source-tier breakdown, overall
  confidence, and any degraded-ensemble note.
- `✗ Business brief aborted at save.` — the user declined at the
  existing-directory gate or final review. No file written; the
  synthesized brief is shown inline only.
- `✗ Business brief aborted at scoping.` — the user declined the topic,
  sub-questions, or privacy gate before dispatch. No web search / peer
  dispatch ran.

For the saved case, emit an **Active Next-Action Proposal** (the inline
shape shown in `core/skills/investigate/SKILL.md` § Completion): typical
`selected_next` candidates are `/founder:frame` (scope a problem model
from the brief), `/founder:decide` (choose between surveyed directions —
name the size `--size=minor|standard|major`), or `/founder:compose`
(draft from it). Do not end with a hardcoded "next: X". The two aborted
cases have no forward result, so they skip the proposal.

Always include the workflow path so the user can inspect or resume:

```
Workflow: <absolute path to workflow .md file>
```

<!-- pipeline:begin investigate-completion-footer -->
The runtime completion footer is **code-emitted** on this verb's terminal
path (ADR-0039, enabled for founder by ADR-0043): `state.mjs
set-terminal` fires the ADR-0031 session-handoff sidecar, which shells out
to the runtime `footer.mjs` and prints the rendered footer — context
state, completion state (founder's manually-published mapping surfaces
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
`core/skills/_shared/references/session-handoff.md`.
<!-- pipeline:end investigate-completion-footer -->
