---
description: Compare 2+ business directions under constraints, recommend one with rationale — founder's decision verb (decisive market/unit-economics axes + regulatory/safety veto gates)
argument-hint: "[--size=<minor|standard|major>] [--preset=<id>] [--weights=<spec>] [--] <business decision question or candidate directions>"
---

# Founder · Decide

$ARGUMENTS

Use `TaskCreate` and `TaskUpdate` to track progress. The peer ensemble
runs automatically (Brainstorm point type) — never ask the user whether
to invoke the peer, and never direct them to run companion CLIs manually.
When the companions plugin or peer CLI is unavailable, the ensemble
degrades silently to local-only.

Plugin root: `$CLAUDE_PLUGIN_ROOT` (set by Claude Code for plugin slash
commands). If unset, fall back to
`$(find ~/.claude/plugins/cache/agentic-plugins/founder -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

> **founder is not an orchestrator dispatch target** (ADR-0036 Non-Goal
> 3): this command does NOT read `AGENTIC_PARENT_WORKFLOW` /
> `AGENTIC_ORIGINATING_SUBTASK`, and founder `state.mjs create` does not
> accept parent-linkage flags. founder workflows are user-invoked and
> branch-anchored only.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — founder workflows are anchored to a branch.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — founder workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to a branch first: git switch <branch>" >&2
  exit 1
fi
FIND_ERR="${TMPDIR:-/tmp}/founder-find-active-$$.err"
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

- Empty `$ACTIVE` → bootstrap with verb=decide:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb decide --host "${AGENTIC_HOST:-claude}" --persona founder \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "${AGENTIC_TOPIC:-<one-line genericized business decision>}" \
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

---

## Phase 0.5 — Resolve business decision axes from the registry (ADR-0036 SD3 / ADR-0027 §5.6)

Parse `$ARGUMENTS` into flags + body and resolve the preset from
`skills/decide/references/decision-axes.yml`. The resulting
`ResolvedDecisionContext` JSON is stashed at
`$AGENTIC_DECIDE_CONTEXT_FILE` for the skill body to consume.

The CLI reuses `scripts/lib/decide-args.mjs` internally so the same flag
grammar applies: unknown flags, invalid `--size=<tier>` values, or
malformed `--weights=<spec>` (non-numeric/negative/exponent weight,
uppercase or duplicate axis-id, empty spec, whitespace) produce a parser
error and exit 2 (we halt). `--preset=<id>` is shape-validated by the
parser but semantically resolved by the registry per ADR-0027 §1.6
graceful-degradation — an unknown preset id triggers
`context.registry_fallback = true` + fall-back to the `default` preset
(no halt). Body tokens go after a `--` separator and are threaded into
`context.body`.

```bash
AGENTIC_DECIDE_CONTEXT_FILE="$(mktemp -t founder-decide-context.XXXXXX).json"
DECIDE_RESOLVE_ERR="$(mktemp -t founder-decide-resolve.XXXXXX).err"
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
  `gate`) for the resolved preset. `gate: true` marks a **veto gate**
  (규제노출 / 안전리스크) — a hard fail vetoes the option regardless of the
  decisive axes (see `skills/decide/SKILL.md` @decide:recommendation-rule).
- `preset_id` — the active preset id (default | compact).
- `size` / `size_explicit` — the resolved ritual tier (minor | standard |
  major). When `--size` was not passed, `size` defaults to `"standard"`.
- `weights` — `Record<string, number>` from `--weights=<spec>`. Empty `{}`
  is the sentinel for "no `--weights` flag" (uniform 1.0 downstream).
- `weights_explicit` — boolean; `true` iff the user passed `--weights`.

If the file is missing or the JSON is unparseable, fall back to the
in-code default preset (the 6-axis business matrix — market-attractiveness
+ unit-economics decisive, regulatory-exposure + safety-risk gates) — the
registry is a graceful-degradation artifact per ADR-0027 §1.6.

---

## Phase 1 — Execute decide

Follow the decide skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/decide/SKILL.md`. The skill performs 2+
business-direction generation, evidence-based comparison across **the axes
resolved from `$AGENTIC_DECIDE_CONTEXT_FILE`** (market / unit-economics /
willingness-to-pay / competitive-intensity, plus the regulatory + safety
veto gates), and recommends a direction with explicit rationale. The user
makes the final call.

Decide is single-mode (no `--profile` argument). Business sub-discipline
context flows through the Business Task Profile per
`skills/_shared/references/orchestration.md`.

### Privacy gate (before any external call)

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web
search AND peer-host dispatch. Genericize before the peer prompt; the
pre-genericization value MUST never leave the local host. See
`skills/investigate/references/business-brief-spec.md` § Privacy Gate.

### Ensemble dispatch (Brainstorm point type)

Build the Brainstorm prompt (independent generation of 2-3 business
directions with tradeoffs across the resolved axes), write it to a
tempfile, and dispatch in the background. The prompt template (with the
`<axis_awareness>` business-axis block) + synthesis contract live in
`skills/_shared/references/ensemble-protocol.md` §Brainstorm; the shape
mirrors the research-scan dispatch in
`skills/investigate/references/business-brief-ensemble.md`:

```bash
PROMPT_FILE="$(mktemp -t founder-decide-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="brainstorm-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Brainstorm XML prompt to $PROMPT_FILE (privacy gate
#     must have passed; genericize the directions before the peer sees them) ...
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

<table or list of directions with tradeoffs across the resolved business axes>

### Recommendation

<chosen direction + rationale + gate verdict (regulatory/safety) + risks>

### Active next-action proposal

- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — decisive 시장성/단위경제 (market/unit-economics) + the regulatory/safety gate verdict>
- evidence_pointers:     <phase notes / brief / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or \$founder:<verb> for a verb>
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Decide (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Compose the planning artifact for the chosen direction" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase decide --ensemble-type brainstorm --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ADR-0017 §sub-decision 5 — atomic terminal write.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "Compose the planning artifact for the chosen direction" \
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
structure the same direction), keep the lens bounded to the decisive
business axes (시장성 / 단위경제) + the gates rather than re-running the full
matrix.

---

## Completion

Output the comparison and one of:

- `✓ Decision recommended.` + chosen direction.
- `✓ Decision pending user input.` — when CONFLICT remained, or a veto
  gate (regulatory / safety) is unresolved. Surface both options with
  evidence; pause until the user selects.

Then emit an **Active Next-Action Proposal** (the inline shape in
`skills/decide/SKILL.md` § Completion): typical `selected_next` is
`/founder:compose` to produce the planning artifact for the chosen
direction — or `/founder:investigate` if a decisive evidence gap (or an
unresolved gate) surfaced, or `/founder:frame` if deciding reframed the
opportunity. Do not end with a hardcoded "next: X".

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```

The runtime completion footer + ADR-0031 session-level continue-vs-fresh
preflight land with founder's meta skills (ADR-0036 PR6); until then,
state the workflow path and the next-action proposal above.
