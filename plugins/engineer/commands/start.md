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

**Quality-first defaults**: optimize for
`best-results-over-token-minimization`, not token saving. Default peer breadth
is the documented phase-boundary ensemble; model/effort defaults are
host-native or explicit `runtime:settings` values and must not be downshifted
for token saving without a user constraint; review depth follows the workflow
phase, including Phase 5 `parallel-review` and re-review after refine until
findings converge or a design-level issue is surfaced.

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
  echo "✗ Detached HEAD detected — no active branch context (ADR-0031); engineer workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
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

### Layer 1 clean-baseline gate (ADR-0028 §Layer-1)

Before `state.mjs create`, inspect the working tree. The Phase 7 commit
automation relies on the post-baseline manifest delta to know which paths
the workflow intended to touch — that signal only holds when the
baseline itself was clean (or the user explicitly bypassed the gate via
`ACCEPT_CURRENT_TREE=1`). A dirty baseline plus an unmodified resolution
would let phase7-commit.mjs sweep adjacent unrelated changes into the
workflow's commit.

```bash
BASELINE_ARGS=()
if [ "${ACCEPT_CURRENT_TREE:-}" = "1" ]; then
  BASELINE_ARGS=(--accept-current-tree true)
fi
BASELINE_ERR="$(mktemp -t engineer-start-baseline.XXXXXX)"
BASELINE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" check-clean-baseline \
  --repo-root "$REPO_ROOT" "${BASELINE_ARGS[@]}" 2>"$BASELINE_ERR")"
BASELINE_RC=$?
if [ "$BASELINE_RC" -ne 0 ]; then
  echo "✗ check-clean-baseline failed (exit $BASELINE_RC):" >&2
  cat "$BASELINE_ERR" >&2
  rm -f "$BASELINE_ERR"
  exit "$BASELINE_RC"
fi
rm -f "$BASELINE_ERR"
BASELINE_STATUS="$(echo "$BASELINE" | jq -r .status)"
if [ "$BASELINE_STATUS" = "dirty" ]; then
  echo "✗ Working tree is dirty — /engineer:start requires a clean baseline (ADR-0028 §Layer-1)." >&2
  echo "$BASELINE" | jq .categories >&2
  echo >&2
  echo "  Resolutions:" >&2
  echo "    - clean:                git restore . ; git clean -fd  (then re-run)" >&2
  echo "    - stash:                git stash push --include-untracked  (re-run, then git stash pop)" >&2
  echo "    - worktree:             /runtime:worktree apply  (ADR-0029)" >&2
  echo "    - accept-current-tree:  ACCEPT_CURRENT_TREE=1 /engineer:start ...  (sweep current tree into the workflow's commit)" >&2
  exit 1
fi
# BASELINE_STATUS is 'clean' (empty tree) or 'accepted' (dirty + bypass).
# Both proceed; phase7-commit.mjs honors the accept-current-tree mode by
# staging all of git_changes rather than the manifest intersection.
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

## Phase 0d — Entry routing and decision contract

Before Phase 1, present an **Entry routing recommendation** using
`skills/_shared/references/entry-routing-contract.md`. This is a
user-facing contract, not a hidden classifier. The recommendation must
name the selected route and the plausible alternatives:

- continue with `/engineer:start` / `$engineer:start` for one coherent
  deliverable on the current branch;
- switch to `/orchestrator:plan` / `$orchestrator:plan` for 2+
  independently completable deliverables, PRs, branches, owners, or
  dependency edges;
- run `/runtime:worktree plan` / `$runtime:worktree` when isolation or
  parallelization is likely because the checkout is dirty, risky,
  long-running, or suitable for parallel branches;
- run `/runtime:doctor`, `/runtime:settings`, `/runtime:compat`,
  `/runtime:context`, or `/runtime:cutover` when the task is runtime
  readiness, install/update, compatibility, handoff, or cutover
  evidence;
- use a single `/engineer:<verb>` / `$engineer:<verb>` when the user
  only needs investigate/frame/decide/compose/critique/refine without
  lifecycle state.

Whenever `/engineer:start` asks the user to proceed, abort, approve a
direction, approve a plan, or switch to another route, use this
decision prompt shape: **Options**, **Tradeoffs**, **Risks**,
**Recommendation**, **Confidence**, **Evidence pointers**, and the
**Default next command**.

Surface the **ADR-0031 session-level continue-vs-fresh preflight here**, at
Phase 0 before sequencing the lifecycle, per
`skills/_shared/references/session-handoff.md`: compute the engineer workflow
projection for the current branch and pass it — or, when no active workflow
exists, the standalone routing — to the runtime seam, so the routing
recommendation above is sized by context-budget risk + archive-gate readiness.
On detached HEAD the Phase 0a guard already reports "no active branch context";
do not auto-recommend a fresh session.

Before recommending a quick implementation/refinement path, state the
standards and root-cause quality gate: the source of truth or standard,
the invariant or root cause, the required verification evidence, and the
rollback/defer/escalation path. If that gate cannot be met, route back
to `engineer:investigate`, `engineer:decide`, or `orchestrator:plan`
instead of patching symptoms.

When the recommended route is `engineer:decide`, also surface the
**decision size** per ADR-0027 §1.5: `--size=minor` → `compact`
4-axis preset with the `entry-routing-guarantee` hard-gate;
`--size=standard` → `default` 5-axis (backward-compatible);
`--size=major` → `nine-axis` 9-axis preset + auto-enabled
sensitivity. The full sizing taxonomy lives in
`skills/_shared/references/entry-routing-contract.md` §"Routing into
`engineer:decide` — decision sizing".

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

## Phase 7 — Commit (ADR-0028 §Layer-3)

Terminal runbook. Phase 7 invokes the `phase7-commit.mjs` driver
(host-shared per ADR-0022 commands-hold-bootstrap / skills-hold-cognition
split): the driver computes the staging set from `commit_manifest` ∩
`git_changes`, splits per release-please package boundary (ADR-0016 +
P8), commits with the user-confirmed subject(s), runs post-commit gates
(P11 pending-ensemble, no-active-children, clean-after-commit, P10
sync writebackParent), and finally writes `set-terminal` LAST per the
P5 terminal-marker-last invariant.

Phase 7 NEVER auto-commits (P6). The flow is two-step: first the agent
invokes `--mode plan` to get suggested subjects, presents them to the
user, gets approval; then invokes `--mode execute --subject "..."`
with the user-confirmed text.

```bash
# Step 1 — plan mode: read workflow + git state, suggest subjects.
PHASE7_PLAN_ERR="$(mktemp -t phase7-plan.XXXXXX)"
PHASE7_PLAN="$(node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" \
  --mode plan \
  --workflow-path "$ACTIVE" \
  --repo-root "$REPO_ROOT" \
  --host "${AGENTIC_HOST:-claude}" \
  2>"$PHASE7_PLAN_ERR")"
PHASE7_PLAN_RC=$?
if [ "$PHASE7_PLAN_RC" -ne 0 ]; then
  echo "✗ phase7-commit --mode plan failed (exit $PHASE7_PLAN_RC):" >&2
  cat "$PHASE7_PLAN_ERR" >&2
  rm -f "$PHASE7_PLAN_ERR"
  exit "$PHASE7_PLAN_RC"
fi
rm -f "$PHASE7_PLAN_ERR"
# Agent: parse $PHASE7_PLAN (JSON), present commits[].suggested_subject
# to the user with [a]ccept / [e]dit / [c]ancel. If ask_user=true also
# confirm the staging_set + extras with the user. The user picks ONE of:
#   - intersection only (default; no extra flag)
#   - opt specific extras back in (PR4 A4 — repeat --include-extra <path>
#     for each extras-list entry the user wants in this commit)
#   - sweep the entire working tree (--accept-current-tree; all-or-nothing)

# Step 2 — execute mode: receive the approved subject(s), commit + gate.
# Single-commit form:
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" \
  --mode execute \
  --workflow-path "$ACTIVE" \
  --repo-root "$REPO_ROOT" \
  --host "${AGENTIC_HOST:-claude}" \
  --subject "$APPROVED_SUBJECT" \
  --confirm-non-interactive
# Or, when shouldSplit=true (multi-package), repeat --subject-pkg:
# node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" \
#   --mode execute --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" \
#   --host "$AGENTIC_HOST" --confirm-non-interactive \
#   --subject-pkg 'plugins/engineer=feat(engineer): ...' \
#   --subject-pkg 'plugins/runtime=docs(runtime): ...'
# Or, when manifest-subset-of-git extras need to be opted in (PR4 A4):
# node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" \
#   --mode execute --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" \
#   --host "$AGENTIC_HOST" --subject "$APPROVED_SUBJECT" \
#   --confirm-non-interactive \
#   --include-extra docs/intro.md \
#   --include-extra docs/migration.md

PHASE7_RC=$?
if [ "$PHASE7_RC" -ne 0 ]; then
  # Driver already emitted the refine-fallback message on stderr.
  # The workflow remains active (terminal_marker unset); recovery is
  # via /engineer:refine + a follow-up /engineer:start that resumes
  # at Phase 7.
  exit "$PHASE7_RC"
fi
# On success the driver wrote set-terminal internally; the Stop hook
# auto-archive (ADR-0017 §sub-decision 5) takes over.
```

For multi-package splits the body composition (P1 + P9 trailer
allowlist) is shared across all per-package commits; only the subject
varies per `--subject-pkg`. Layer 1 forwarding: when the bootstrap was
flagged `accept-current-tree`, re-pass `ACCEPT_CURRENT_TREE=1` (or
`--accept-current-tree`) into the execute step so the driver stages all
of `git_changes` rather than the manifest intersection.

Append the runtime completion footer after the commit summary and workflow
path. Use the runtime footer helper when available, or render the same
fields manually: context state, completion state plus state-derived next
action, workflow id/path, artifact pointers, recommended next work, and
next-session action/command or prompt pointer.
The footer is advisory and pointer-only; do not mutate host session
context or paste raw peer / consensus output into the main session.

Surface the ADR-0031 session-level continue-vs-fresh preflight at this
completion (and at Phase 0 before sequencing a fresh lifecycle) per
`skills/_shared/references/session-handoff.md`: compute the engineer workflow
projection and pass it to the runtime footer/check
(`--workflow-projection-file`) so the footer carries the continue-vs-fresh
decision. On detached HEAD, report "no active branch context" — do not
auto-recommend a fresh session (already guarded at Phase 0a).

When the deliverable boundary is reached, include PR handling readiness
fields in the footer. Ask the user what to do with PR handling only when
the helper returns `pr_handling.recommendation == "ask-user"`; `defer`
means evidence is incomplete, and `block` means a readiness criterion
failed.

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
