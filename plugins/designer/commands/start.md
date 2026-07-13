---
description: Sequence one design/UX deliverable end-to-end — investigate → frame → decide → compose → critique → refine with approval gates. Designer's single-deliverable lifecycle macro
argument-hint: <one-line design topic> (single-pass; the saved spec is the artifact handoff to the frontend)
---

# Designer · Start

$ARGUMENTS

`/designer:start` is the designer plugin's **single-deliverable lifecycle
macro** (ADR-0020/0021, ADR-0042 SD7). It sequences the six designer verbs —
investigate → frame → decide → compose → critique → refine — into one pass
with user-approval gates at the direction (Phase 1) and the spec (Phase 2),
producing a reviewed, accessibility-gated design artifact. It is
single-pass; a program spanning design **and** frontend implementation runs
designer to a saved spec, then hands that spec to the engineer persona.

**Cognitive runbook + the Host-availability matrix live in
`$CLAUDE_PLUGIN_ROOT/skills/start/SKILL.md`** per ADR-0021. This command
file owns the Claude-host Phase 0 bootstrap bash; the per-phase cognitive
description, approval-gate prompts, and the privacy gate delegate to
SKILL.md.

> **designer is not an orchestrator dispatch target** (ADR-0042 Non-Goal 2):
> this command does NOT read the parent-workflow / originating-subtask
> environment variables, and designer `state.mjs create` rejects
> parent-linkage flags at the CLI. `start` sequences designer's own verbs
> in-place; it never transits cross-plugin boundaries.

Plugin root is `$CLAUDE_PLUGIN_ROOT` (set by Claude Code). If unset, fall
back to
`$(find ~/.claude/plugins/cache/agentic-plugins/designer -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

---

## Phase 0 — Bootstrap (continuity + clean-baseline gate)

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — designer workflows are anchored to a branch.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — designer workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to a branch first: git switch <branch>" >&2
  exit 1
fi
FIND_ERR="${TMPDIR:-/tmp}/designer-start-find-$$.err"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>"$FIND_ERR")"
FIND_RC=$?
if [ "$FIND_RC" -ne 0 ]; then
  echo "✗ find-active failed (exit $FIND_RC):" >&2; cat "$FIND_ERR" >&2; rm -f "$FIND_ERR"; exit "$FIND_RC"
fi
rm -f "$FIND_ERR"
```

- Empty `$ACTIVE` → **clean-baseline gate, then bootstrap** with
  `workflow_type=start`:

  ```bash
  BASELINE_ERR="${TMPDIR:-/tmp}/designer-start-baseline-$$.err"
  BASELINE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" check-clean-baseline --repo-root "$REPO_ROOT" 2>"$BASELINE_ERR")"
  BASELINE_RC=$?
  if [ "$BASELINE_RC" -ne 0 ]; then
    echo "✗ clean-baseline check failed (exit $BASELINE_RC):" >&2
    cat "$BASELINE_ERR" >&2; rm -f "$BASELINE_ERR"; exit "$BASELINE_RC"
  fi
  rm -f "$BASELINE_ERR"
  STATUS="$(printf '%s' "$BASELINE" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).status||"")}catch{process.stdout.write("")}})')"
  # Fail CLOSED: only an explicit clean/accepted proceeds. A dirty tree, an
  # empty status, or any unrecognized value stops the bootstrap — the gate
  # must never fail open on a parse error or a non-zero check.
  case "$STATUS" in
    clean|accepted) ;;  # proceed
    dirty)
      echo "✗ Working tree not clean — /designer:start gates a clean baseline before bootstrapping a deliverable." >&2
      echo "  Resolve, then re-run:" >&2
      echo "    • clean:  git restore . ; git clean -fd" >&2
      echo "    • stash:  git stash push --include-untracked  (re-run, then git stash pop)" >&2
      echo "    • accept: set ACCEPT_CURRENT_TREE=1 to acknowledge the dirty tree" >&2
      exit 1;;
    *)
      echo "✗ clean-baseline check returned an unrecognized status ('$STATUS') — refusing to bootstrap (fail-closed)." >&2
      exit 1;;
  esac
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb investigate --workflow-type start \
    --host "${AGENTIC_HOST:-claude}" --persona designer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "${AGENTIC_TOPIC:-<one-line genericized design topic from \$ARGUMENTS>}" \
    --current-phase phase-1-discover \
    --next-action "Run Phase 1 discover+frame+decide composite")"
  ```

- Non-empty `$ACTIVE` → **read `workflow_type` first** — the lifecycle macro
  must NOT absorb a single-verb (`verb-chain`) workflow into lifecycle phase
  space (state.mjs defaults non-start workflows to `verb-chain` and validates
  `start` as a separate discriminator):

  ```bash
  WF_TYPE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).workflow_type||"verb-chain")}catch{process.stdout.write("verb-chain")}})')"
  ```

  - `workflow_type == start` → **resume into start**: report the active
    workflow's `verb` / `current_phase` / `next_action` and continue the
    lifecycle from where it stopped (do not re-bootstrap).
  - `workflow_type != start` (a `verb-chain` single-verb workflow) →
    **reject**: do NOT mutate it into lifecycle phase space. Tell the user an
    active single-verb workflow exists on this branch; finish or archive it
    first (`/designer:resume` / `/designer:resume archive`), or continue it
    with the matching `/designer:<verb>`, then re-run `/designer:start`.

  For a clean/dirty drift report on the active workflow, the user can run
  `/designer:resume`.

The initial `verb` is `investigate` (Phase 1a); rotate the `verb` field at
each phase boundary via `state.mjs append --verb <verb>` so SessionStart
re-injection sees the active cognitive activity (SKILL.md § intra-document
execution model).

### L4 design profile (Design Task Profile → decide preset)

Record the Design Task Profile per
`skills/_shared/references/orchestration.md` § Step 1. The `Profile` field
is the L4 archetype; it selects the decision preset at Phase 1c:
`general`/`flow` → `balanced`; `ui` → `experience`; `cta` → `conversion`;
`content` → `clarity`. The map's single source of truth is
`PROFILE_PRESET_MAP` in `scripts/decide-registry.mjs`. An explicit
`--preset` / `--size` still wins (ADR-0027 §1.5). This is **not** the
`state.mjs` skill-profile field.

**The archetype is NOT durable state — carry it inline.** Shell state does
not survive across Bash tool invocations, so an `export` here is gone by
the time Phase 1c runs `decide-registry.mjs resolve` in a later block.
Prefix the resolve invocation in the **same block** instead, so the value
cannot be lost and cannot be inherited from a stale ambient export:

```bash
# Phase 1c, in the same Bash block as the resolve call:
AGENTIC_DESIGNER_PROFILE="<general|ui|flow|cta|content>" \
  node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve $ARGUMENTS \
  > "$AGENTIC_DECIDE_CONTEXT_FILE" 2>"$DECIDE_RESOLVE_ERR"
```

Two hazards this closes. (1) A *lost* export silently downgrades a `cta`
lifecycle to the `balanced` matrix. (2) A *stale* export left in the
operator's shell silently upgrades an unrelated standalone
`/designer:decide` to an archetype preset. The resolver emits a stderr
provenance diagnostic whenever an archetype changes the outcome, and
`commands/decide.md` surfaces the resolver's stderr — so an unexpected
preset is visible in the command output rather than silent. Read it.

---

## Privacy gate (whole lifecycle)

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data
visible in screenshots, and secret-bearing frontend code pass an explicit
privacy gate before BOTH web search AND peer-host dispatch. The lifecycle
runs web search (Phase 1 investigate) and dispatches the peer ensemble at
every phase boundary (always-max) — genericize before any external call; the
pre-genericization value MUST never leave the local host. **Screenshots are
sensitive by default**: the rendered screen is read host-direct and never
leaves the local host as bytes; the companion peer path has no `--image`
flag, so peer verification stays code/text. See
`skills/investigate/references/design-brief-spec.md` § Privacy Gate.

---

## Entry routing + Phases 1–4 + terminal

Follow `$CLAUDE_PLUGIN_ROOT/skills/start/SKILL.md` for the cognitive runbook:

1. **Entry routing recommendation** (Options / Tradeoffs / Risks /
   Recommendation / Confidence / Evidence pointers / Default next command):
   `/designer:start` for one design deliverable; `/engineer:start` or
   `/orchestrator:plan` when the real work is implementing an already-settled
   design; a single `/designer:<verb>` for one verb.
2. **Phase 1 — discover+frame+decide** (investigate design-brief → frame →
   decide). Rotate `verb`. The accessibility veto gate is checked FIRST.
   **APPROVE direction** before Phase 2.
3. **Phase 2 — compose** (spec / flow / wireframe), every element annotated
   with its accessibility + consistency acceptance criteria. Plan-verify peer
   ensemble (Independence-Rule exception). Generated imagery is an
   `image:compose` artifact handoff, never drawn here (ADR-0042 SD5).
   **APPROVE spec** before Phase 3. Surface the multi-surface prompt if the
   spec splits.
4. **Phase 3 — critique** (usability / a11y / conversion / consistency, all
   held to `skills/critique/references/quality-criteria.md`; an unmitigated
   accessibility veto gate is CRITICAL; a11y findings are candidate-level per
   ADR-0042 Non-Goal 6). Post-code, the rendered screen is read host-direct.
5. **Phase 4 — refine** to convergence in a **bounded** loop (default 2
   passes, hard cap 3): apply → Refine-verify → re-critique. A revision must
   not open a new accessibility barrier. designer does **not** run the
   frontend build; when the re-rendered screen is unavailable the vision
   re-critique is UNVERIFIED. Non-convergence pauses and routes to the owner
   (`/designer:decide` for a 2+-direction fork, `/designer:investigate` for a
   load-bearing unverified claim).

Each phase boundary writes state via `state.mjs append --verb <verb>
--current-phase <phase> --next-action <...> --event updated` and dispatches
the per-phase peer ensemble per
`skills/_shared/references/ensemble-protocol.md` (always-max). No dispatch in
any phase passes `--image` — the companion peer path has no image channel.

---

## Terminal — present + save + hand off

Present the final design artifact and save it (the durable design brief /
flow spec / wireframe spec / CTA copy at its
`<root>/YYYY-MM-DD_<topic-slug>/` location per
`skills/investigate/references/output-file-rules.md`). Write terminal state
**only when Phase 4 converged**:

```bash
# CONVERGENCE GUARD — FAIL-CLOSED. A paused Phase 4 (a new accessibility
# barrier, an exhausted bounded loop, or a vision re-critique that could not
# run) must leave the workflow ACTIVE so the Stop hook cannot auto-archive an
# unresolved session.
#
# The default is `no`, NOT `yes`. Shell state does not survive across Bash tool
# invocations, so a `CONVERGED=yes` exported in the Phase 4 block is *gone* by
# the time this block runs. A `:-yes` default would therefore mark the workflow
# terminal on a paused refine simply because the variable was lost — the exact
# fail-open the guard exists to prevent (`state.mjs set-terminal` also defaults
# `--terminal-marker` to true, so nothing downstream catches it).
#
# Set CONVERGED explicitly IN THIS BLOCK from the Phase 4 result. An unset
# variable means "convergence not established", and the macro stays active.
CONVERGED="<yes|no — from the Phase 4 re-critique verdict; unset means no>"
if [ "${CONVERGED:-no}" = "yes" ]; then
  # ADR-0029 §1 / completion-output contract §2 — write the COMPACT form
  # (selected_next + one-line why + next_command) into --next-action; the
  # code-emitted footer surfaces it verbatim as "recommended next work".
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --terminal-phase summary-complete --terminal-marker true \
    --next-action "Hand the spec to the frontend (/engineer:start or /orchestrator:plan); optionally /designer:start the next surface" \
    --event updated
else
  echo "→ Lifecycle PAUSED at Phase 4 (non-convergence / new accessibility barrier / vision re-critique unavailable) — workflow left ACTIVE, NOT marked terminal. Resolve the flagged item, then re-run /designer:refine or route to /designer:decide." >&2
fi
```

designer does NOT auto-commit and does NOT dispatch (ADR-0042 Non-Goal 2).
The terminal output names the **artifact handoff** explicitly: the saved spec
is the input to `/engineer:start` (single surface) or `/orchestrator:plan`
(multi-deliverable frontend program), and the rendered result comes back to
`/designer:critique` for the post-code quality pass. The `set-terminal` above
fires the ADR-0031 session-handoff sidecar, which **code-emits** the
runtime completion footer on stderr (ADR-0039, enabled by ADR-0043 S4):
context state, completion state (`publish-needed` while only the owner's
save/commit remains) + state-derived next action, workflow id/path,
artifact pointers, recommended next work, and the continue-vs-fresh read —
the macro workflow is terminal, so a fresh deliverable starts a new
`/designer:start`. Do NOT hand-compose a second footer; surface the emitted
one. The footer never mutates host session context; detached HEAD never
auto-recommends a fresh session (the branch-based preflight is what
reports "no active branch context"). Wiring details:
`skills/_shared/references/session-handoff.md`.

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```

ADR-0042 is `Accepted` — the six cognitive verbs, this `start` macro, and the
`resume` / `checkpoint` / `peer-now` meta skills all ship.
