---
description: Approve the macro plan as shown — records plan_approval bound to the plan's hash (ADR-0063 D6)
argument-hint: [--workflow=<macro-id>]
---

# Orchestrator · Approve

$ARGUMENTS

`/orchestrator:approve` records the owner's approval of a macro plan in the
macro workflow's frontmatter: `plan_approval_status=approved`,
`plan_approval_approved_at`, and `plan_approval_plan_hash`, the hash of the
subtasks as they stand (ADR-0063 D6). It prints the plan it approves and binds
the approval to that plan: the hash it shows is the hash it approves, and a
plan that changes in between is refused. Any later `plan-set` returns the plan
to pending approval, so an approval never outlives the plan it was given for.
Under ADR-0063's autopilot, `/orchestrator:next` dispatches only an approved
plan whose hash still matches and refuses anything else (`plan-unapproved`);
an interactive `/orchestrator:next` does not require an approval, and prints
one warning line for a plan pending approval or changed since it was approved.

It does not mutate `current_phase`, `next_action`, or `plan.subtasks[]`. The
workflow namespace is `.agentic-plugins/state/orchestrator/` for new repos;
legacy `.claude/agentic-orchestrator/` state remains active until explicit
migration.

**Cognitive runbook lives in
`${CLAUDE_PLUGIN_ROOT}/core/skills/approve/SKILL.md`**. This command owns
Claude-host shell bootstrap; the skill documents Codex use.

Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ORCHESTRATOR_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep that opening line when you run a block: a
shell variable does not outlive a Bash call.

**Argument parsing**: extract from `$ARGUMENTS`:
- `EXPLICIT_WORKFLOW_ID` ← value of `--workflow=<id>`, or empty if absent.

Approval is the owner's act. Run this command only when the owner asked for
it; never approve on the owner's behalf, and never from an autopilot worker
(`state.mjs plan-approve` refuses when `AGENTIC_AUTOPILOT` names a run).

**Run the block below in one Bash invocation.** It resolves the macro, prints
what it will approve, and approves exactly that.

---

## Phase 0 — Resolve the macro, show the plan, approve it

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
MACRO_PATH=""
if [ -n "${EXPLICIT_WORKFLOW_ID:-}" ]; then
  # Reject path-component overrides — `--workflow=../archive/<id>` would
  # otherwise address an archived or unrelated file.
  case "$EXPLICIT_WORKFLOW_ID" in
    */*|*\\*|..|.*)
      echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID invalid — must be a basename-shaped workflow id (no '/', '\\\\', '..', or leading '.')." >&2
      exit 1;;
  esac
  # ADR-0067 Decision 4, item 2 — the macro file in the orchestrator workflow
  # homes of this checkout's read set, the default state root's first. Two
  # files holding the id are an error, named on stderr, never a choice.
  if ! MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$EXPLICIT_WORKFLOW_ID")"; then
    echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID names no single macro file in the orchestrator workflow homes of this checkout's read set (the reason is above; archived macros are not addressed)." >&2
    exit 1
  fi
else
  if [ -z "$GIT_BRANCH" ]; then
    echo "✗ Detached HEAD — pass --workflow=<macro-id>, or switch to the macro's branch or a subtask branch." >&2
    exit 1
  fi
  MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit 1
  if [ -z "$MACRO_PATH" ]; then
    MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH")" || exit 1
  fi
fi
if [ -z "$MACRO_PATH" ]; then
  echo "✗ No macro workflow on branch '$GIT_BRANCH'. Pass --workflow=<macro-id>, or run /orchestrator:plan first." >&2
  exit 1
fi

# What the approval binds to: the hash and the subtask fields it covers.
SHOWN="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" plan-hash --workflow-path "$MACRO_PATH")" || exit 1
# Every field the hash covers is shown — id, label, branch, blocked_by,
# verb, profile, topic — with | and line breaks escaped so a cell stays one cell.
printf '%s\n' "$SHOWN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);const keys=["id","label","verb","profile","branch","blocked_by","topic"];const cell=(v)=>(v===undefined?"":Array.isArray(v)?v.join(", "):String(v)).replace(/\\/g,"\\\\").replace(/\|/g,"\\|").replace(/\r\n|\r|\n/g,"\\n");process.stdout.write("| "+keys.join(" | ")+" |\n|"+keys.map(()=>"---").join("|")+"|\n");for(const s of o.subtasks)process.stdout.write("| "+keys.map((k)=>cell(s[k])).join(" | ")+" |\n");process.stdout.write("\nplan_hash: "+o.plan_hash+"\napproval before: "+o.approval.status+(o.awaiting_owner_gate?" (awaiting_owner_gate="+o.awaiting_owner_gate+")":"")+"\n")})' || exit 1
PLAN_HASH="$(printf '%s\n' "$SHOWN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).plan_hash))')" || exit 1

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" plan-approve \
  --workflow-path "$MACRO_PATH" --host claude \
  --expect-hash "$PLAN_HASH" || exit 1
echo "workflow: $MACRO_PATH"
```

`plan-approve` prints `{workflowPath, plan_hash, approved_at}`, with
`noop: true` when this hash was already approved (nothing is written). On a
refusal it exits 1 with the reason on stderr; surface it verbatim:

- **the plan changed since it was shown** — another session rewrote the plan
  between the two calls. Run `/orchestrator:approve` again and review the new
  table.
- **the Plan-verify ensemble reported a conflict** (`awaiting_owner_gate=plan-conflict`)
  — the owner revises the plan (`/orchestrator:plan`), or decides the conflict
  and clears it first:
  `node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear --workflow-path "$MACRO_PATH" --host claude --gate plan-conflict`,
  then approves again. Clearing returns the plan to `plan-approval` and
  records the resolution in the macro.
- **no subtasks to approve** / **this macro is terminal** — there is no plan
  to approve; plan the work with `/orchestrator:plan`.
- **refused under autopilot** — only the owner approves.

---

## Completion

- `✓ Plan approved: <n> subtasks, hash <first 12 hex>.` + the workflow path.
- `✓ Plan already approved at <approved_at> (hash <first 12 hex>); nothing written.`
- `✗ Approval refused: <reason>.` + the recovery above.

Then emit an **Active Next-Action Proposal** instead of a fixed next command, per
`core/skills/_shared/references/session-handoff.md § Active Next-Action Proposal`
(canonical: `entry-routing-contract.md § Active Next-Action Proposal` in the
engineer plugin) — the canonical six-field template (runtime
completion-output contract):

```
- selected_next:         <macro action | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <macro plan / subtask states / phase notes — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /orchestrator:<command> … — or the wait / owner-decision action>
```

For an approved plan the typical `selected_next` is `/orchestrator:next`, which
dispatches the first ready subtask; for a refusal it is the recovery above.
Derive it from the macro state (`state.mjs next-ready` reports readiness and
approval together), not from a fixed table.
