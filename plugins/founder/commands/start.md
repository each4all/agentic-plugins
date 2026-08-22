---
description: Sequence a business deliverable end-to-end — investigate → frame → decide → compose → critique → refine with approval gates. Founder's single-deliverable lifecycle macro
argument-hint: <one-line business topic> (single-pass; for a multi-deliverable program use the orchestrator persona)
---

# Founder · Start

$ARGUMENTS

`/founder:start` is the founder plugin's **single-deliverable lifecycle
macro** (ADR-0020/0021, ADR-0036 SD2). It sequences the six founder verbs —
investigate → frame → decide → compose → critique → refine — into one pass
with user-approval gates at the direction (Phase 1) and the plan (Phase 2),
producing a reviewed business planning artifact. It is single-pass; for a
multi-deliverable program use the orchestrator persona.

**Cognitive runbook + the Host-availability matrix live in
`$CLAUDE_PLUGIN_ROOT/skills/start/SKILL.md`** per ADR-0021. This command
file owns the Claude-host Phase 0 bootstrap bash; the per-phase cognitive
description, approval-gate prompts, and the privacy gate delegate to
SKILL.md.

> **founder is not an orchestrator dispatch target** (ADR-0036 Non-Goal 3):
> this command does NOT read `AGENTIC_PARENT_WORKFLOW` /
> `AGENTIC_ORIGINATING_SUBTASK`, and founder `state.mjs create` rejects
> parent-linkage flags at the CLI. `start` sequences founder's own verbs
> in-place; it never transits cross-plugin boundaries.

Plugin root is `$CLAUDE_PLUGIN_ROOT` (set by Claude Code). If unset, fall
back to
`$(find ~/.claude/plugins/cache/agentic-plugins/founder -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

---

## Phase 0 — Bootstrap (continuity + clean-baseline gate)

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — founder workflows are anchored to a branch.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — founder workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to a branch first: git switch <branch>" >&2
  exit 1
fi
FIND_ERR="${TMPDIR:-/tmp}/founder-start-find-$$.err"
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
  BASELINE_ERR="${TMPDIR:-/tmp}/founder-start-baseline-$$.err"
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
      echo "✗ Working tree not clean — /founder:start gates a clean baseline before bootstrapping a deliverable." >&2
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
  STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb investigate --workflow-type start \
    --host "${AGENTIC_HOST:-claude}" --persona founder \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "${AGENTIC_TOPIC:-<one-line genericized business topic from \$ARGUMENTS>}" \
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
    first (`/founder:resume` / `/founder:resume archive`), or continue it with
    the matching `/founder:<verb>`, then re-run `/founder:start`.

  For a clean/dirty drift report on the active workflow, the user can run
  `/founder:resume`.

The initial `verb` is `investigate` (Phase 1a); rotate the `verb` field at
each phase boundary via `state.mjs append --verb <verb>` so SessionStart
re-injection sees the active cognitive activity (SKILL.md § intra-document
execution model).

---

## Privacy gate (whole lifecycle)

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web search
AND peer-host dispatch. The lifecycle runs web search (Phase 1 investigate)
and dispatches the peer ensemble at every phase boundary (always-max) —
genericize before any external call; the pre-genericization value MUST never
leave the local host. See
`skills/investigate/references/business-brief-spec.md` § Privacy Gate.

---

## Entry routing + Phases 1–4 + terminal

Follow `$CLAUDE_PLUGIN_ROOT/skills/start/SKILL.md` for the cognitive runbook:

1. **Entry routing recommendation** (Options / Tradeoffs / Risks /
   Recommendation / Confidence / Evidence pointers / Default next command):
   `/founder:start` for one deliverable; the orchestrator persona for a
   multi-deliverable program; a single `/founder:<verb>` for one verb.
2. **Phase 1 — discover+frame+decide** (investigate business-brief → frame →
   decide). Rotate `verb`. **APPROVE direction** before Phase 2.
3. **Phase 2 — compose** (plan / canvas / validation-plan). Plan-verify peer
   ensemble (Independence-Rule exception). **APPROVE plan** before Phase 3.
   Surface the multi-deliverable prompt if the plan splits.
4. **Phase 3 — critique** (multi-perspective business review; veto-gate
   findings are CRITICAL).
5. **Phase 4 — refine** to convergence (re-verify internal consistency; loop
   refine + peer re-verify until findings converge).

Each phase boundary writes state via `state.mjs append --verb <verb>
--current-phase <phase> --next-action <...> --event updated` and dispatches
the per-phase peer ensemble per
`skills/_shared/references/ensemble-protocol.md` (always-max).

---

## Terminal — present + save

Present the final business artifact and save it (durable
`business_brief.md` / venture plan / canvas at its
`<root>/YYYY-MM-DD_<topic-slug>/` location). Write terminal state:

```bash
# ADR-0029 §1 / completion-output contract §2 — write the COMPACT form
# (selected_next + one-line why + next_command) into --next-action; the
# code-emitted footer surfaces it verbatim as "recommended next work".
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase summary-complete --terminal-marker true \
  --next-action "Save/commit the business deliverable; optionally /founder:start the next item" \
  --event updated
```

founder does NOT auto-commit — the user saves the deliverable to their
per-venture content repository (ADR-0036 §SD5). The `set-terminal` above
fires the ADR-0031 session-handoff sidecar, which **code-emits** the
runtime completion footer on stderr (ADR-0039, enabled by ADR-0043 S3):
context state, completion state (`publish-needed` while only the owner's
save/commit remains) + state-derived next action, workflow id/path,
artifact pointers, recommended next work, and the continue-vs-fresh read —
the macro workflow is terminal, so a fresh deliverable starts a new
`/founder:start`. Do NOT hand-compose a second footer; surface the emitted
one. The footer never mutates host session context; detached HEAD never
auto-recommends a fresh session (the branch-based preflight is what
reports "no active branch context"). Wiring details:
`skills/_shared/references/session-handoff.md`.

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```
