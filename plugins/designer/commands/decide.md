---
description: Compare 2+ design/UX directions under constraints, recommend one with rationale — designer's decision verb (decisive usability + archetype axes, accessibility veto gate)
argument-hint: "[--size=<minor|standard|major>] [--preset=<id>] [--weights=<spec>] [--] <design decision question or candidate directions>"
---

# Designer · Decide

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. The peer ensemble
runs automatically (Brainstorm point type) — never ask the user whether to
invoke the peer, and never direct them to run companion CLIs manually. When
the companions plugin or peer CLI is unavailable, the ensemble degrades
silently to local-only.

Plugin root: `$CLAUDE_PLUGIN_ROOT` (set by Claude Code for plugin slash
commands). If unset, fall back to
`$(find ~/.claude/plugins/cache/agentic-plugins/designer -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

> **designer is not an orchestrator dispatch target** (ADR-0042 Non-Goal
> 2): this command does NOT read `AGENTIC_PARENT_WORKFLOW` /
> `AGENTIC_ORIGINATING_SUBTASK`, and designer `state.mjs create` does not
> accept parent-linkage flags. designer workflows are user-invoked and
> branch-anchored only.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — designer workflows are anchored to a branch.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — designer workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to a branch first: git switch <branch>" >&2
  exit 1
fi
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

- Empty `$ACTIVE` → bootstrap with verb=decide (single-mode — no `--profile`):

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb decide --host "${AGENTIC_HOST:-claude}" --persona designer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "${AGENTIC_TOPIC:-<one-line genericized design decision>}" \
    --current-phase phase-0-bootstrap \
    --next-action "Run decide skill")"
  ```

- Non-empty `$ACTIVE` → append-on-resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb decide \
    --phase-label "Phase 0: Resume into decide" \
    --phase-note "Resumed from prior verb." \
    --current-phase phase-0-resume \
    --next-action "Run decide skill" --event resumed
  ```

`state.mjs` enforces the directory-level lock + per-file lock with
ownership token + stale window per ADR-0011 §3, and writes only persona
`designer` (canonical-home guard).

---

## Phase 0.5 — Resolve design decision axes from the registry (ADR-0042 SD3 / ADR-0027 §5.6)

Parse `$ARGUMENTS` into flags + body and resolve the preset from
`skills/decide/references/decision-axes.yml`. The resulting
`ResolvedDecisionContext` JSON is stashed at
`$AGENTIC_DECIDE_CONTEXT_FILE` for the skill body to consume.

The CLI reuses `scripts/lib/decide-args.mjs` internally so the same flag
grammar applies: unknown flags, invalid `--size=<tier>` values, or
malformed `--weights=<spec>` (non-numeric/negative/exponent weight,
uppercase or duplicate axis-id, empty spec, whitespace) produce a parser
error and exit 2 (we halt). `--preset=<id>` is passed through by the parser
(not shape-validated there) and semantically resolved by the registry per
ADR-0027 §1.6 graceful-degradation — an unknown, empty, or otherwise
unresolvable preset id triggers `context.registry_fallback = true` +
fall-back to the `balanced` preset with a diagnostic (no halt). Body tokens go after a `--` separator and are threaded into
`context.body`.

```bash
AGENTIC_DECIDE_CONTEXT_FILE="$(mktemp -t designer-decide-context.XXXXXX).json"
DECIDE_RESOLVE_ERR="$(mktemp -t designer-decide-resolve.XXXXXX).err"
export AGENTIC_DECIDE_CONTEXT_FILE

# `$ARGUMENTS` is the verbatim user input. Expand unquoted so the shell
# word-tokenizes flags / body tokens for the CLI; `set -f` disables
# globbing during expansion so body tokens like `*` reach the CLI
# literally — restore globbing immediately after.
set -f
node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve $ARGUMENTS \
  > "$AGENTIC_DECIDE_CONTEXT_FILE" 2>"$DECIDE_RESOLVE_ERR"
RESOLVE_RC=$?
set +f

[ -s "$DECIDE_RESOLVE_ERR" ] && cat "$DECIDE_RESOLVE_ERR" >&2
rm -f "$DECIDE_RESOLVE_ERR"

if [ "$RESOLVE_RC" -eq 2 ]; then
  echo "✗ decide-registry rejected the argument list — fix the invocation and rerun." >&2
  rm -f "$AGENTIC_DECIDE_CONTEXT_FILE"
  exit 1
elif [ "$RESOLVE_RC" -ne 0 ]; then
  echo "✗ decide-registry failed with exit $RESOLVE_RC; see diagnostics above." >&2
  exit 1
fi
```

The skill body reads `$AGENTIC_DECIDE_CONTEXT_FILE` to obtain:

- `axes[]` — ordered axis descriptors (id, en/ko labels, question, role,
  `gate`) for the resolved preset. `gate: true` marks the **veto gate**
  (접근성 Accessibility) — a hard candidate WCAG A/AA barrier vetoes the
  option regardless of the decisive axes (see `skills/decide/SKILL.md`
  @decide:recommendation-rule; candidate-level per ADR-0042 Non-Goal 6).
- `preset_id` — the active preset id (balanced | conversion | experience |
  clarity).
- `size` / `size_explicit` — the resolved ritual tier (minor | standard |
  major). When `--size` was not passed, `size` defaults to `"standard"`.
- `weights` — `Record<string, number>` from `--weights=<spec>`. Empty `{}`
  is the sentinel for "no `--weights` flag" (uniform 1.0 downstream).
- `weights_explicit` — boolean; `true` iff the user passed `--weights`.

If the file is missing or the JSON is unparseable, fall back to the in-code
default preset (the 7-axis `balanced` design matrix — 사용성 usability +
일관성 consistency decisive, 접근성 accessibility gate) — the registry is a
graceful-degradation artifact per ADR-0027 §1.6.

---

## Phase 1 — Execute decide

Follow the decide skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/decide/SKILL.md`. The skill performs 2+
design-direction generation, evidence-based comparison across **the axes
resolved from `$AGENTIC_DECIDE_CONTEXT_FILE`** (usability / consistency /
conversion / desirability / content-clarity / feasibility, plus the
accessibility veto gate), and recommends a direction with explicit
rationale. The user makes the final call.

Decide is single-mode (no `--profile` argument). Design sub-discipline
context flows through the Design Task Profile per `skills/investigate/SKILL.md`
§ Design Task Profile (the shared `skills/_shared/references/orchestration.md`
reference).

### Privacy gate (before any external call)

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data
visible in screenshots, and secret-bearing frontend code pass an explicit
privacy gate before BOTH web search AND peer-host dispatch. Genericize
before the peer prompt; the pre-genericization value MUST never leave the
local host. **Screenshots are sensitive by default** and are never sent to
the peer as bytes (the peer path is code/text-based; vision critique is a
same-host `designer:critique` capability). See
`skills/investigate/references/design-brief-spec.md` § Privacy Gate.

### Ensemble dispatch (Brainstorm point type)

Build the Brainstorm prompt (independent generation of 2-3 design
directions with tradeoffs across the resolved axes), write it to a
tempfile, and dispatch in the background. The prompt template (with the
`<axis_awareness>` design-axis block) + synthesis contract land in
`skills/_shared/references/ensemble-protocol.md` §Brainstorm; the
dispatch shape mirrors the reference-scan dispatch in
`skills/investigate/references/design-brief-ensemble.md`:

```bash
PROMPT_FILE="$(mktemp -t designer-decide-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="brainstorm-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Brainstorm XML prompt to $PROMPT_FILE (privacy gate
#     must have passed; genericize the directions, no screenshot bytes) ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase decide \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type brainstorm --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

Use `run_in_background: true` on the Bash tool. `peer-runner.mjs run`
records the matching `pending_ensemble` row before spawning the companion
and writes raw peer output under the hidden peer-run ledger. Synthesize:
merge orchestrator + peer direction sets. PEER-ONLY directions → add.
AGREED → elevate confidence. CONFLICT → present both with evidence and ask
the user.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: decide at <iso-utc>

### Ensemble synthesis: decide verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Directions compared

<table or list of directions with tradeoffs across the resolved design axes>

### Recommendation

<chosen direction + rationale + accessibility gate verdict + risks>

### Active next-action proposal

- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — decisive 사용성/archetype axis + the accessibility gate verdict>
- evidence_pointers:     <phase notes / brief / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or \$designer:<verb> for a verb>
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Decide (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Compose the flows/specs for the chosen direction (/designer:compose)" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase decide --ensemble-type brainstorm --run-id "$RUN_ID" \
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
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "Compose the flows/specs for the chosen direction (/designer:compose)" \
  --event updated

# ADR-0027 §4.3 snapshot rule — remove the temp context file once the
# skill body has consumed it (symmetric with the parser-error cleanup
# in Phase 0.5).
rm -f "$AGENTIC_DECIDE_CONTEXT_FILE"
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

Decide IS the multi-axis verb — the comparison above already renders the
resolved axes. If a *sub-fork* surfaces mid-decision (e.g. two ways to
structure the same flow), keep the lens bounded to the decisive design axes
(사용성 + the archetype axis) + the accessibility gate rather than
re-running the full matrix.

---

## Completion

Output the comparison and one of:

- `✓ Decision recommended.` + chosen direction.
- `✓ Decision pending user input.` — when CONFLICT remained, or the
  accessibility veto gate is unresolved. Surface both options with
  evidence; pause until the user selects.

Then emit an **Active Next-Action Proposal** (the inline shape in
`skills/decide/SKILL.md` § Completion): typical `selected_next` is
`/designer:compose` to draft the flows/specs for the chosen direction — or
`/designer:investigate` if a decisive evidence gap (or an unresolved gate)
surfaced, or `/designer:frame` if deciding reframed the UX problem. Do not
end with a hardcoded "next: X".

ADR-0042 is `Accepted` — the full designer surface (the six verbs, the
`/designer:start` lifecycle macro, and the `resume` / `checkpoint` /
`peer-now` meta skills) ships, so every `next_command` is runnable. The decision record is the durable
handoff. See `skills/decide/SKILL.md` § Completion.

Always include the workflow path:

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
