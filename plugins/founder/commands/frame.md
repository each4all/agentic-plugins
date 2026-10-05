---
description: Turn business evidence into a structured opportunity model — customer problem, value hypothesis, business-model sketch, validation criteria, key risks
argument-hint: (natural-language framing trigger or business-brief summary)
---

# Founder · Frame

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go
— use the host's task-tracking tools when the session exposes them,
and keep an inline checklist when it does not. The peer ensemble runs automatically (Frame point type) — never
ask the user whether to invoke the peer, and never direct them to run
companion CLIs manually. When the companions plugin or peer CLI is
unavailable, the ensemble degrades silently to local-only.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_FOUNDER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

> **founder is not an orchestrator dispatch target** (ADR-0036 Non-Goal
> 3): this command does NOT read `AGENTIC_PARENT_WORKFLOW` /
> `AGENTIC_ORIGINATING_SUBTASK`, and founder `state.mjs create` does not
> accept parent-linkage flags. founder workflows are user-invoked and
> branch-anchored only.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

<!-- pipeline:begin frame-phase-0 -->
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
<!-- pipeline:end frame-phase-0 -->

founder requires a git workspace (ADR-0036 SD5; recommended: a
per-venture content repository). If `git rev-parse` fails, refuse with
manual-init guidance (git init, or cd into your venture content repo).

Empty `$ACTIVE` → bootstrap a new workflow with verb=frame:

<!-- pipeline:begin frame-bootstrap -->
In the block, replace `<the original request described above>` with a
one-line genericized business topic; `AGENTIC_TOPIC` takes its place when it is set.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='frame'
GIT_BRANCH="$(git branch --show-current)"
GIT_HEAD="$(git rev-parse HEAD)"
STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb 'frame' --host "${AGENTIC_HOST:-claude}" --persona 'founder' \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --original-request "${AGENTIC_TOPIC:-<the original request described above>}" \
  --current-phase phase-0-bootstrap \
  --next-action "Run ${VERB} skill")" || exit $?
```
<!-- pipeline:end frame-bootstrap -->

Non-empty `$ACTIVE` → append-on-resume:

<!-- pipeline:begin frame-resume -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='frame'
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb 'frame' \
  --phase-label "Phase 0: Resume into ${VERB}" \
  --phase-note "Resumed from prior verb." \
  --current-phase phase-0-resume \
  --next-action "Run ${VERB} skill" --event resumed || exit $?
```
<!-- pipeline:end frame-resume -->

`state.mjs` enforces the directory-level lock + per-file lock with
ownership token + stale window per ADR-0011 §3, and writes only persona
`founder` (canonical-home guard).

---

## Phase 1 — Execute frame

Follow the frame skill's command-invoked mode at
`${CLAUDE_PLUGIN_ROOT}/core/skills/frame/SKILL.md`. The skill articulates the
business opportunity model: problem/opportunity, customer + job-to-be-done,
value hypothesis, business-model sketch, constraints, validation criteria,
key risks, out-of-scope items.

Frame is single-mode (no `--profile` argument). Business context flows
through the Business Task Profile per
`core/skills/_shared/references/orchestration.md`.

### Privacy gate (before any external call)

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web
search AND peer-host dispatch. Genericize before the peer prompt; the
pre-genericization value MUST never leave the local host. See
`core/skills/investigate/references/business-brief-spec.md` § Privacy Gate.

### Ensemble dispatch (Frame point type)

Build the Frame prompt and write it to a tempfile, then dispatch in the
background. The prompt template + synthesis contract live in
`core/skills/_shared/references/ensemble-protocol.md` §Frame:

```xml
<task>
Independently build a business opportunity model from the evidence below.
Do not see the local host's model — produce a fresh, independent one.

Genericized business evidence: {genericized brief findings / topic}
Jurisdiction(s): {market geographies, or "unspecified"}
</task>

<structured_output_contract>
Return one opportunity model with these fields:
1. Problem / Opportunity (1-2 sentences)
2. Customer + Job-to-be-Done
3. Value hypothesis (the wedge / unfair-advantage thesis)
4. Business-model sketch (revenue model + rough unit-economics direction)
5. Constraints (regulatory / capital / time / capability / market-timing)
6. Validation criteria (measurable evidence that would confirm or refute)
7. Key risks (market / competitive / regulatory / unit-economics / safety / execution) + early-detection signal
8. Out of scope
Mark uncertain fields [to be validated] rather than guessing.
</structured_output_contract>

<privacy_contract>
The evidence has been pre-genericized. Do not fabricate or echo
proprietary identifiers, company names, or customer names, and do not
de-anonymize a genericized concept to a specific named company/product.
</privacy_contract>
```

Then write that prompt to a tempfile and dispatch:

<!-- pipeline:begin frame-dispatch -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ENSEMBLE_TYPE='frame'
PROMPT_FILE="$(mktemp -t 'founder'-'frame'-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="${ENSEMBLE_TYPE}-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the prompt to $PROMPT_FILE (the privacy gate above must have
#     passed; the prompt carries only genericized text) ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase 'frame' \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type 'frame' --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```
<!-- pipeline:end frame-dispatch -->

Use `run_in_background: true` on the Bash tool. `peer-runner.mjs run`
records the matching `pending_ensemble` row before spawning the companion
and writes raw peer output under the hidden peer-run ledger. Synthesize
per the AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT base categories.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

(founder's `core/skills/_shared/references/ensemble-protocol.md` §Frame carries
the formal prompt template + synthesis contract; the Frame dispatch shape
above mirrors the research-scan dispatch in
`core/skills/investigate/references/business-brief-ensemble.md`.)

---

## Phase 2 — State finalize

<!-- pipeline:begin frame-finalize -->
The phase note this step records — fill in every `<…>`:

```markdown
### Ensemble launched: frame at <iso-utc>

### Ensemble synthesis: frame verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Opportunity model

Problem / Opportunity: ...
Customer + Job-to-be-Done: ...
Value hypothesis: ...
Business-model sketch: ...
Constraints: ...
Validation criteria: ...
Key risks: ...
Out of scope: ...

### Active next-action proposal

- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + evidence-quality gate>
- evidence_pointers:     <opportunity-model fields / brief path — pointers only>
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
IFS= read -r -d '' NOTE <<'PHASE_NOTE' || true
<the phase note above, filled in>
PHASE_NOTE
# A shell whose read has no -d (dash) reads nothing: stop before any write.
[ -n "$NOTE" ] || { echo "✗ No phase note was read; nothing was written." >&2; exit 1; }

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label 'Phase 1: Frame (synthesized)' \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action 'Decide on a business direction given this frame' \
  --event updated || exit $?

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase 'frame' --ensemble-type 'frame' --run-id "$RUN_ID" \
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
  --next-action 'Decide on a business direction given this frame' \
  --event updated
```
<!-- pipeline:end frame-finalize -->

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If executing this verb surfaces a **genuine 2+-branch decision point** —
two viable opportunity framings, or two candidate customer segments —
surface a **compact multi-axis lens** across the decisive business axes
(시장성 market-attractiveness / 단위경제 unit-economics, per ADR-0036 SD3)
+ size-appropriate supporting axes, instead of a flat list. Resolve the
sized axis set from founder's decision registry
(`core/skills/decide/references/decision-axes.yml`), or read the decisive axes
inline as above when the resolver is not reachable. Bounded: only at a
genuine 2+-branch point.

---

## Completion

Output the synthesized opportunity model and one of:

- `✓ Frame complete.` — typical case.
- `✓ Frame complete (ambiguous boundary).` — when CONFLICT appeared in
  the problem/opportunity or customer-segment between local and peer.
  Surface the ambiguity and pause for reconciliation before downstream
  verbs.

Then emit an **Active Next-Action Proposal** (the inline shape shown in
`core/skills/frame/SKILL.md` § Completion): typical `selected_next` candidates
are `/founder:decide` when 2+ directions need comparison (name the size
`--size=minor|standard|major`), or `/founder:compose` when the direction
is already obvious. Do not end with a hardcoded "next: X".

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```

<!-- pipeline:begin frame-completion-footer -->
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
<!-- pipeline:end frame-completion-footer -->
