---
name: next
description: "Dispatches the next ready orchestrator macro subtask into the engineer plugin with parent-linkage preserved. Codex skill mirror for /orchestrator:next; same-host dispatch only, cross-host --peer remains deferred."
---

# Next (orchestrator dispatch skill)

`next` dispatches one ready macro subtask into `plugins/engineer` and
records the immutable parent linkage needed for engineer Stop-hook
writeback:

- `AGENTIC_PARENT_WORKFLOW=<macro id>`
- `AGENTIC_ORIGINATING_SUBTASK=<subtask id>`
- `AGENTIC_HOST=<claude|codex>`

This is the Codex skill mirror of `commands/next.md`. Preserve that
command file as the canonical line-by-line Claude runbook; this skill
spells out the same operational boundary for `$orchestrator:next`.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| Resolve macro via `state.mjs find-active` / `find-macro` | Yes | Yes |
| Select ready subtask via `read-subtask` / `next-ready` | Yes | Yes |
| Switch/create subtask branch | Yes, explicit git action | Yes, explicit git action |
| Discover and preflight `engineer` | Yes | Yes |
| Same-host engineer dispatch with AGENTIC parent-linkage | Yes | Yes |
| Cross-host `--peer` dispatch | Deferred PR-F scope | Deferred PR-F scope |

Codex can dispatch the same macro state because workflow files are
host-shared. The limitation is host-native slash-command execution:
Codex must follow the engineer command markdown explicitly instead of
assuming a Claude slash command runner exists.

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:next [<subtask-id>] [--workflow=<macro-id>]` | `$orchestrator:next [<subtask-id>] [--workflow=<macro-id>]` |
| Canonical command runbook | `commands/next.md` | `commands/next.md` is the behavioral source |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | Codex marketplace install path for `plugins/orchestrator` |
| Host flag | `--host claude` | `--host codex` |

---

## Phase 0 - Argument intake

Parse:

- optional leading `<subtask-id>`;
- optional `--workflow=<macro-id>`.

Reject `--workflow` values that are not basename-shaped. Do not allow
`/`, `\`, `..`, leading `.`, or NUL.

---

## Phase 1 - Resolve macro and subtask

Resolve the macro workflow:

1. If `--workflow=<id>` is supplied, look in canonical
   `.agentic-plugins/state/orchestrator/workflows/<id>.md`, then legacy
   `.claude/agentic-orchestrator/workflows/<id>.md`.
2. Otherwise run `state.mjs find-active --repo-root "$REPO_ROOT"`.
3. If no active macro exists for the current branch, run
   `state.mjs find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH"`.

Resolve the subtask:

- explicit id -> `state.mjs read-subtask`;
- no id -> `state.mjs next-ready`.

Reject dispatch when the selected subtask is `completed`, `deferred`,
`abandoned`, `blocked`, or `pending` with incomplete `blocked_by`
predecessors. `in_progress` is allowed only as the idempotent
reattach path.

---

## Phase 2 - Branch and ownership preconditions

Before switching branches:

1. Require a clean worktree.
2. Resolve the engineer plugin with
   `scripts/discover-engineer.mjs discover`.
3. Run `scripts/discover-engineer.mjs preflight --root "$ENGINEER_PLUGIN_ROOT"`.
4. Ask engineer `state.mjs find-active --repo-root "$REPO_ROOT" --branch "$SUBTASK_BRANCH"`.

If an engineer workflow already exists on the subtask branch, it must
match both `parent_workflow == <macro id>` and
`originating_subtask == <subtask id>`. Otherwise stop; do not reuse an
unrelated engineer workflow.

Then switch to the subtask branch, creating it only when absent.

---

## Phase 3 - Invoke engineer with parent-linkage

Do not invoke `skills/<verb>/SKILL.md` directly. Do not call engineer
`state.mjs create` directly. Both bypass the engineer command Phase 0
bootstrap and break ADR-0019 writeback.

Read `<engineer-root>/commands/<subtask.verb>.md` and execute its
Phase 0 plus verb body with this prelude in the same shell session:

```bash
ORCH_PLUGIN_ROOT="<orchestrator-plugin-root>"
export CLAUDE_PLUGIN_ROOT="$ENGINEER_PLUGIN_ROOT"
export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"
export AGENTIC_ORIGINATING_SUBTASK="$SUBTASK_ID"
export AGENTIC_HOST="codex"
export AGENTIC_PROFILE="${SUBTASK_PROFILE:-}"
export AGENTIC_TOPIC="${SUBTASK_TOPIC:-}"
```

On Claude the host flag is `claude`; on Codex use `codex`. If the
current checkout is a direct development checkout rather than an
installed cache, prefer the actual invoking host over path-shape
guessing.

---

## Phase 4 - Post-create writeback

After engineer Phase 0 creates or reattaches a workflow, find the
active engineer workflow on the subtask branch and write it back:

```bash
node "<orchestrator-plugin-root>/scripts/state.mjs" subtask-update \
  --workflow-path "$MACRO_PATH" \
  --host codex \
  --subtask-id "$SUBTASK_ID" \
  --status in_progress \
  --engineer-workflow-id "$ENGINEER_WF_ID" \
  --event updated
```

Surface the JSON envelope. Respect skipped absorbing-terminal results:
`deferred` and `abandoned` must not be advanced back to
`in_progress`.

---

## Completion

Report the macro id, subtask id, engineer workflow id, branch, and the
next recommended command. Append the runtime completion footer when
available. The footer is advisory and pointer-only; do not mutate host
session context or paste raw peer output into the main session.

Surface the ADR-0031 session-level continue-vs-fresh preflight per
`skills/_shared/references/session-handoff.md`: compute the macro projection
(find-active then find-macro) and pass it to the runtime footer/check. The
preflight computes identically on Codex; only auto re-injection of the
next-session prompt depends on the stage-appropriate Codex hook gate
(generic `[features].hooks`, default on) + a `/hooks` trust
(operator-attested via `runtime:doctor` / `runtime:settings`; not provable
non-interactively). On detached HEAD, report "no active branch context".

---

## Anti-patterns

- Do not bypass engineer command Phase 0.
- Do not split AGENTIC_* exports into a separate shell call.
- Do not dispatch a blocked subtask.
- Do not treat `--peer` as implemented.
- Do not relax git cleanliness or ownership checks.
