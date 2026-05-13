---
description: Sequence the engineer single-deliverable lifecycle (Phase 0 continuity through Phase 7 commit) end-to-end using the six canonical verb skills
argument-hint: <feature description> [--base-branch <ref>]
---

# Engineer · Start

$ARGUMENTS

`/engineer:start` is a **lifecycle macro command** (ADR-0020 §Sub-
decision 1): neither a verb nor a verb-level sugar alias. Sequences
Phase 0 continuity → Phase 1 brainstorm → Phase 2 explore → Phase 3
plan-verify → Phase 4 implement → Phase 5 review → Phase 6 resolve
→ Phase 7 commit through the six engineer verb skills.

**Cognitive runbook lives in
`$CLAUDE_PLUGIN_ROOT/skills/start/SKILL.md`** per ADR-0021 (macro-
skill category). This command file owns the Claude-host bootstrap
(Phase 0 below) and the `state.mjs` writes at each phase boundary;
for each Phase 1–7 below, follow the matching `§ Phase N` section
of SKILL.md for the cognitive description, user-approval gates, and
ensemble dispatch points.

The plugin root in shell snippets below is `$CLAUDE_PLUGIN_ROOT`
(set by Claude Code for plugin slash commands). If unset for any
reason, fall back to
`$(find ~/.claude/plugins/cache/agentic-plugins/engineer -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

---

## Phase 0 — Argument parsing

Inspect `$ARGUMENTS`:

- Empty → reject with a one-line usage hint and stop. `/engineer:start`
  requires a feature description so the workflow's `original_request`
  has substance.
- Contains `--base-branch <ref>` → extract `<ref>` for the redundancy
  probe (Phase 0c-bootstrap). Default when omitted: `origin/main`.
- Remaining text after stripping the flag is the feature description.

```bash
BASE_BRANCH="origin/main"
FEATURE=""
# Token-level parsing — portable across GNU/BSD shell environments
# (macOS BSD sed does not support `\+` in basic regex; bash positional
# iteration sidesteps that compatibility surface). `set -f` disables
# glob expansion for the unquoted `set -- $ARGUMENTS` split — without
# this guard, an `*` or `?` token would glob-expand into matching
# filenames and corrupt FEATURE before it lands in --original-request
# (Codex Phase 6 re-review MAJOR).
set -f
set -- $ARGUMENTS
SKIP_NEXT=0
for tok in "$@"; do
  if [ "$SKIP_NEXT" = 1 ]; then
    BASE_BRANCH="$tok"
    SKIP_NEXT=0
    continue
  fi
  if [ "$tok" = "--base-branch" ]; then
    SKIP_NEXT=1
    continue
  fi
  if [ -z "$FEATURE" ]; then
    FEATURE="$tok"
  else
    FEATURE="$FEATURE $tok"
  fi
done
set +f
[ -z "$FEATURE" ] && { echo "✗ /engineer:start requires a feature description (got '--base-branch' only)"; exit 1; }
```

---

## Phase 0a — Detached HEAD guard (ADR-0018 §sub-2)

Engineer workflows are anchored to a branch. `/engineer:start` rejects
detached-HEAD invocation rather than bootstrapping a workflow that
cannot be re-found later by branch.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — engineer workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to a branch first: git switch <branch>" >&2
  exit 1
fi
```

---

## Phase 0b — Active workflow branching (ADR-0020 §Sub-decision 4)

`find-active` runs first so resume / typed-conflict paths short-circuit
without the redundancy probe (the probe is only meaningful when this
branch is going to receive a NEW workflow). ADR-0020 §Implementation
Guide step 1 specifies this ordering.

```bash
FIND_ERR="$(mktemp -t engineer-start-find-active.XXXXXX)"
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

Branch on the result:

### Empty `$ACTIVE` → Phase 0c redundancy probe + bootstrap

The redundancy probe runs **only** on the empty-active branch — there
is no point asking "does this branch already have overlapping work?"
when the answer to "is there an active workflow?" is yes (the resume
path handles that case). This ordering matches ADR-0020
§Implementation Guide step 1's empty-active branch.

```bash
DIAG_ERR="$(mktemp -t engineer-start-diagnose.XXXXXX)"
DIAG="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" diagnose-redundancy \
  --repo-root "$REPO_ROOT" --base-branch "$BASE_BRANCH" 2>"$DIAG_ERR")"
DIAG_RC=$?
if [ "$DIAG_RC" -ne 0 ]; then
  echo "✗ diagnose-redundancy failed (exit $DIAG_RC):" >&2
  cat "$DIAG_ERR" >&2
  rm -f "$DIAG_ERR"
  # Continue bootstrap — the probe is informational. A failed probe
  # MUST NOT block the user from starting a workflow.
  DIAG=""
fi
rm -f "$DIAG_ERR"
DIAG_STATUS="$(echo "$DIAG" | jq -r '.status // ""' 2>/dev/null)"
GIT_PRESENT="$(echo "$DIAG" | jq -r '.scanned.git_present // false' 2>/dev/null)"
BASE_FAILED="$(echo "$DIAG" | jq -r '.scanned.base_resolution_failed // false' 2>/dev/null)"
```

**Caller policy** (ADR-0020 §Sub-decision 7 + Codex plan-verify MINOR
#4): when `DIAG_STATUS=redundancy`, **surface the evidence to the user
and ask for an explicit proceed-or-abort decision**. `/engineer:start`
does NOT auto-archive on redundancy — that is a user judgment, not a
plugin policy. Likewise, `git_present=false` (no git on PATH) or
`base_resolution_failed=true` (origin/main not fetched / typo) are
non-fatal informational signals.

```bash
if [ "$GIT_PRESENT" = "false" ]; then
  echo "⚠ git is not on PATH — redundancy probe blind. Proceeding without overlap detection."
elif [ "$BASE_FAILED" = "true" ]; then
  echo "⚠ Base branch '$BASE_BRANCH' did not resolve — pass --base-branch <ref> if a different baseline applies (e.g., stacked branches). Proceeding without overlap detection."
elif [ "$DIAG_STATUS" = "redundancy" ]; then
  echo "⚠ Redundancy detected on branch '$GIT_BRANCH' (base=$BASE_BRANCH):"
  echo "$DIAG" | jq '.scanned, .evidence, .recommended_action'
  echo
  echo "  Options:"
  echo "    - proceed: continue bootstrap if the evidence is unrelated"
  echo "    - abort:   stop here; review the evidence (recent commits / open PRs)"
  echo "               and either continue the existing PR or archive it first"
  # Surface to the user; do not auto-abort.
fi
```

Bootstrap the new workflow with `--workflow-type start`, recording
`verb: investigate` as the Phase 1 brainstorm entry point. Subsequent
phase boundaries rotate `verb` to the phase-primary value via
`state.mjs append --verb`.

```bash
GIT_HEAD="$(git rev-parse HEAD)"
STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb investigate --host "${AGENTIC_HOST:-claude}" \
  --workflow-type start \
  --git-baseline-branch "$GIT_BRANCH" \
  --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --current-phase phase-0-bootstrap \
  --next-action "Phase 1 brainstorm — investigate options, frame the model, decide a direction" \
  --original-request "$FEATURE")"
```

### Non-empty `$ACTIVE` → inspect `workflow_type`

```bash
ACTIVE_TYPE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read \
  --workflow-path "$ACTIVE" | jq -r '.workflow_type // "verb-chain"')"
```

- **`workflow_type=start`** → auto-resume. Append a resume marker and
  continue from the recorded `current_phase`. Same shape as the
  engineer six-verb commands' Phase 0 append-on-resume.

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --event resumed \
    --phase-label "Resume /engineer:start" \
    --phase-note "Auto-resume of active workflow_type=start on $GIT_BRANCH"
  ```

- **`workflow_type=verb-chain`** (or absent / legacy) → **typed
  conflict**, exit non-zero. ADR-0020 §Sub-decision 4 explicitly
  rejects auto-archive of a verb-chain workflow under `/engineer:start`:
  the user must clear it deliberately (switch branch, let it reach
  `commit-complete`, or `/engineer:resume archive <id>`).

  ```bash
  CURRENT_PHASE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read \
    --workflow-path "$ACTIVE" | jq -r .current_phase)"
  echo "✗ Active workflow on '$GIT_BRANCH' is workflow_type=verb-chain, not start." >&2
  echo "  /engineer:start would mutate a single-verb workflow's current_phase into the lifecycle macro phase space — reject." >&2
  echo "  Active workflow: $ACTIVE" >&2
  echo "  current_phase:   $CURRENT_PHASE" >&2
  echo "  To proceed with /engineer:start, first clear the active workflow:" >&2
  echo "    - switch branch (git switch -c <new>)" >&2
  echo "    - let it reach commit-complete (Stop hook auto-archives)" >&2
  echo "    - /engineer:resume archive $(basename "$ACTIVE" .md)" >&2
  exit 1
  ```

---

## Phase 1 — Brainstorm composite (investigate → frame → decide)

Composite of three verbs per ADR-0020 §Sub-decision 2; rotate the
workflow's `verb` field at each sub-phase entry so SessionStart
re-injection sees the active cognitive activity (intra-document
execution, no recursive slash dispatch):

```bash
# Sub-phase 1a — Investigate (option generation)
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb investigate \
  --current-phase phase-1-brainstorm-investigate \
  --next-action "Generate option candidates and gather supporting evidence" \
  --event updated

# Sub-phase 1b — Frame (5-perspective model)
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb frame \
  --current-phase phase-1-brainstorm-frame \
  --next-action "Frame options across 5 perspectives" \
  --event updated

# Sub-phase 1c — Decide (recommend + user approval)
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb decide \
  --current-phase phase-1-brainstorm-decide \
  --next-action "Recommend direction and obtain user approval" \
  --event updated
```

**Do not proceed to Phase 2 until the user approves a direction.**

---

## Phase 2 — Explore codebase (investigate --profile=analysis)

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb investigate --profile analysis \
  --current-phase phase-2-explore \
  --next-action "Map current codebase state and integration points" \
  --event updated
```

---

## Phase 3 — Plan-verify (compose --profile=plan + critique)

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb compose --profile plan \
  --current-phase phase-3-plan \
  --next-action "Produce plan artifact" \
  --event updated

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb critique \
  --current-phase phase-3-verify \
  --next-action "Verify plan completeness and feasibility" \
  --event updated
```

Surface the **multi-deliverable detection prompt** if the plan
groups into 2+ deliverables (ADR-0020 §Sub-decision 6); user chooses
abort vs single-pass continuation.

**Do not proceed to Phase 4 until the user approves the plan.**

---

## Phase 4 — Implement (compose --profile=code)

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb compose --profile code \
  --current-phase phase-4-implement \
  --next-action "RED-GREEN-REFACTOR loop per planned task" \
  --event updated
```

---

## Phase 5 — Review (critique --profile=parallel-review)

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb critique --profile parallel-review \
  --current-phase phase-5-review \
  --next-action "Multi-perspective code review + Codex working-tree review" \
  --event updated
```

---

## Phase 6 — Resolve (refine)

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --verb refine \
  --current-phase phase-6-resolve \
  --next-action "Address findings; converge or escalate same-finding recurrence" \
  --event updated
```

---

## Phase 7 — Commit

Terminal runbook. Commit + optional PR creation, then the terminal
state write below flips the workflow into the auto-archive whitelist
(ADR-0017 §sub-decision-5):

```bash
# (commit + optional gh pr create — verb=refine is the last cognitive
#  activity; Phase 7 itself has no cognitive verb update, only a
#  terminal state write per ADR-0017 §sub-decision-5)

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase commit-complete \
  --terminal-marker true \
  --next-action archive \
  --event updated
```

Append the runtime completion footer after the commit summary and workflow
path. Use the runtime footer helper when available, or render the same
fields manually: context state, workflow id/path, artifact pointers,
recommended next work, and next-session action/command or prompt pointer.
The footer is advisory and pointer-only; do not mutate host session
context or paste raw peer / consensus output into the main session.

---

## Notes

- ADR-0020 §Sub-decision 1 — `/engineer:start` is a **command**, not a
  7th canonical verb; the six-verb enum (`VALID_VERBS` in `state.mjs`)
  is unchanged.
- ADR-0021 — The canonical lifecycle runbook lives in
  `skills/start/SKILL.md` (macro-skill category per ADR-0010 §3
  cascade). This command file owns the Claude-host bootstrap (Phase 0)
  and the state.mjs writes at each phase boundary. The Codex-side
  parity is `$engineer:start` (same SKILL.md content).
- ADR-0018 §sub-2 — branch=workflow invariant; one workflow per branch.
- ADR-0019 — `/engineer:start` is engineer-internal verb sequencing
  and does NOT transit cross-plugin boundaries; `parent_workflow` is
  unset for direct `/engineer:start` invocation.
- ADR-0017 §sub-decision-5 — Stop hook auto-archive gates evaluate
  `terminal_marker`, terminal phase, HEAD movement, and no-active-children
  transparently. `workflow_type` is read transparently and does NOT
  affect gate logic.
