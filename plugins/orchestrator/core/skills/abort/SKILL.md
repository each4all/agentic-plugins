---
name: abort
description: "Abandons an orchestrator macro plan with remaining work marked not-done. Codex skill mirror for /orchestrator:abort and ADR-0019 abort lifecycle."
---

# Abort (orchestrator lifecycle skill)

`abort` closes a macro plan when work cannot continue. It follows the
same three-step ritual as `finalize`, with different terminal labels:

- non-terminal subtasks become `abandoned`;
- macro `current_phase` becomes `aborted`.

Use `finalize` when remaining work is intentionally deferred. Use
`abort` when the plan is intentionally not done.

This is the Codex skill mirror of `commands/abort.md`. Preserve that
command file as the canonical Claude runbook.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| Resolve macro via `find-active` / `find-macro` | Yes | Yes |
| Bulk subtask transition to `abandoned` | `--host claude` | `--host codex` |
| Engineer child `stop-archive` / `detach-archive` pass | Yes | Yes |
| Set macro terminal markers | `--host claude` | `--host codex` |
| Macro auto-archive Stop hook | Automatic on Claude Stop | Automatic after the bundled hooks load (generic `[features].hooks`) + `/hooks` review/trust; manual helper fallback: `adapters/codex/hooks/stop.mjs` |

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:abort [--workflow=<macro-id>]` | `$orchestrator:abort [--workflow=<macro-id>]` |
| Canonical command runbook | `commands/abort.md` | `commands/abort.md` is the behavioral source |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | For a mentioned `orchestrator` skill, the plugin directory that contains it: Codex injects a mentioned skill with its absolute path (`<path>…/core/skills/<skill>/SKILL.md</path>`), and dropping `/core/skills/<skill>/SKILL.md` from it leaves the root, which holds `.codex-plugin/plugin.json`. If that path is no longer in context, for example after compaction, a new mention of the skill supplies it again. With the default Codex home and the `agentic-plugins` marketplace added from Git, the root is `~/.codex/plugins/cache/agentic-plugins/orchestrator/<version>`, the versioned copy Codex loads skills from, and `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/orchestrator` is the marketplace checkout, which tracks the repository's `main` branch, not that copy. |
| Host flag | `--host claude` | `--host codex` |

---

## Phase 0 - Resolve macro

The arguments reach the block below through an args file, never as shell
source (ADR-0059, C134(a)): typed into a command, a quote, `$` or backquote in
them would be read as code. Create a private directory for it
(`mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`, noting the path it
prints), write `args.json` in it with your file-editing tool, holding
`{"agentic_args": 1, "text": "…"}` with `text` set to the arguments exactly
as typed, as a JSON string (`""` when there are none), and put that path in
the block's `ARGS_DIR` line. The block reads it with `state.mjs command-args
--command abort` (grammar: `scripts/lib/command-args.mjs`), as
`commands/abort.md` Phase 0 does, which removes the file and its directory
once read; any argument but `--workflow=<macro-id>`, and a word holding a
quote or backslash, is refused. It resolves the macro by that id (refused
unless basename-shaped; `state.mjs resolve-workflow` looks in the orchestrator
workflow homes of this checkout's read set, ADR-0067 Decision 4, item 2, and
exits non-zero when no root holds it, 3, or two files do, 1), else the active
macro of the current branch, else the macro whose plan names it (`find-macro`),
and prints the macro's path and id:

```bash
ARGS_DIR='<directory from mktemp>'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
GIT_BRANCH="$(git branch --show-current)"
[ -n "$GIT_BRANCH" ] || { echo "✗ Detached HEAD — orchestrator macros are branch-anchored, as commands/abort.md refuses it." >&2; exit 1; }
ARGS_JSON="$(node "<orchestrator-plugin-root>/scripts/state.mjs" command-args \
  --command abort --args-file "$ARGS_DIR/args.json")" || exit 1
ARG_WORKFLOW_ID="$(printf '%s' "$ARGS_JSON" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).workflow_id))')" || exit 1
if [ -n "$ARG_WORKFLOW_ID" ]; then
  case "$ARG_WORKFLOW_ID" in
    */*|*\\*|..|.*) echo "✗ --workflow=$ARG_WORKFLOW_ID is not a basename-shaped workflow id." >&2; exit 1;;
  esac
  MACRO_PATH="$(node "<orchestrator-plugin-root>/scripts/state.mjs" resolve-workflow \
    --repo-root "$REPO_ROOT" --workflow-id "$ARG_WORKFLOW_ID")" || exit 1
else
  MACRO_PATH="$(node "<orchestrator-plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit 1
  if [ -z "$MACRO_PATH" ]; then
    MACRO_PATH="$(node "<orchestrator-plugin-root>/scripts/state.mjs" find-macro \
      --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH")" || exit 1
  fi
fi
[ -n "$MACRO_PATH" ] || { echo "✗ No macro workflow references branch '$GIT_BRANCH'; name one with --workflow." >&2; exit 1; }
printf 'MACRO_PATH=%s\nMACRO_ID=%s\n' "$MACRO_PATH" "$(basename "$MACRO_PATH" .md)"
```

The later blocks use the `MACRO_PATH` and `MACRO_ID` it printed, the path a
program found, never the id you were given.

Set `DETECTED_HOST=codex` when running from Codex.

---

## Phase 1 - Bulk transition to abandoned

Run:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# ADR-0067 Decision 4, item 5 — join the macro's run lock before the first
# write: a run or another session holding it refuses here, naming the
# holder, and nothing is written.
ADMISSION="$(node "<orchestrator-plugin-root>/scripts/state.mjs" admission join \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --command abort --host codex)" || exit 1
# ADR-0068 Decision 2, item 8 — the holds are checked before the first bulk
# status write: an open persona operation in a lane, a busy lane, holds that
# cannot be read, or (the holds on) an engineer whose archive is not
# hold-aware stops here, naming each, and nothing is written.
HOLDS_ENGINEER_ROOT="$(node "<orchestrator-plugin-root>/scripts/discover-engineer.mjs" discover 2>/dev/null)" || HOLDS_ENGINEER_ROOT=''
node "<orchestrator-plugin-root>/scripts/state.mjs" holds-preflight \
  --workflow-path "$MACRO_PATH" --engineer-root "$HOLDS_ENGINEER_ROOT" || {
  node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
  exit 1
}
node "<orchestrator-plugin-root>/scripts/state.mjs" bulk-subtask-status \
  --workflow-path "$MACRO_PATH" \
  --host codex \
  --from-statuses pending,blocked,in_progress \
  --to-status abandoned || {
  node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
  exit 1
}
```

Carry the admission id the join printed into Phases 2 and 3 as `ADMISSION`,
as you carry `MACRO_PATH`. When Phase 2 stops, release it before you stop
(`state.mjs admission release --macro "$MACRO_ID" --checkout "$REPO_ROOT"
--admission "$ADMISSION"`); Phase 3 releases it after its write.

Parent per-file lock is released after this command returns.

---

## Phase 2 - Archive or detach engineer children

This phase is identical to `finalize`:

1. resolve and preflight the engineer plugin (`preflight --purpose lifecycle`);
2. scan the engineer workflow homes of every root `state.mjs scan-roots`
   prints for `parent_workflow == <macro id>`, each physical file once
   (ADR-0067 Decision 1(b));
3. route terminal children through engineer `state.mjs stop-archive`;
4. route mid-flight and deleted-branch children through engineer
   `state.mjs detach-archive`, and every child whose `stop-archive` answers
   with an envelope of `archived: false`, whatever its `reason`
   (`gate-not-met`, or `held-lane` for a child in a held lane, ADR-0068
   Decision 2, item 7), as `commands/abort.md` does: that answer is not a
   failure;
5. stop before Phase 3 if any child failed to archive or detach (a
   `stop-archive` or `detach-archive` that fails, or prints no envelope).

The parent macro lock must not be held during this pass. Engineer-side
CLI invocations must use `$ENGINEER_PLUGIN_ROOT` in argv.

Phases 1-3 run in separate shell calls here, so begin every Phase 2 shell
call that archives a child with the admission check, and stop (releasing the
admission) when it fails: the admission was released meanwhile, and a run or
another session may hold the macro now.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
node "<orchestrator-plugin-root>/scripts/state.mjs" admission check \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION" || {
  node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
  exit 1
}
```

---

## Phase 3 - Set macro terminal markers

Run:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# ADR-0067 Decision 4, item 5 — release the admission on every exit, after
# the write included, and check it before the write: it may have been
# released since Phase 1's join.
release_admission() {
  node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
}
trap 'release_admission' EXIT
node "<orchestrator-plugin-root>/scripts/state.mjs" admission check \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION" || exit 1
# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
# macro archive gates are evaluated at the end of THIS turn, not at session
# close; if a gate fails (a subtask still non-terminal, an engineer child
# still active) the macro stays marked and a later Stop re-evaluates it.
# Clearing the marker with `--terminal-marker false` works only before that
# Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
# --terminal-phase), and does not reopen the subtasks /finalize or /abort
# already closed. Once archived the macro is outside find-active, so recovery
# is a fresh /orchestrator:plan. On Codex the Stop hook runs only once the
# operator has trusted the plugin hooks (`/hooks`), so evaluation waits.
node "<orchestrator-plugin-root>/scripts/state.mjs" set-terminal \
  --workflow-path "$MACRO_PATH" \
  --host codex \
  --terminal-phase aborted \
  --terminal-marker true \
  --next-action archive || exit $?
# ADR-0068 Decision 2, item 8 — only after the terminal write, the macro's
# holds retire: its holds directory goes. One that waits says why on stderr,
# and a later Stop retries it.
node "<orchestrator-plugin-root>/scripts/state.mjs" holds-retire \
  --workflow-path "$MACRO_PATH" --macro-end true || true
```

---

## Phase 4 - Codex Stop hook / fallback

Codex can load orchestrator's bundled Stop hook when the plugin is enabled,
generic `[features].hooks` (default on) is set, and the hook has passed Codex
review/trust.
After a successful Codex abort, run the fallback helper when plugin hooks are
disabled, not yet trusted, not active in the current host session, or the user
wants immediate archive parity:

```bash
node "<orchestrator-plugin-root>/adapters/codex/hooks/stop.mjs"
```

Claude runs the Stop hook automatically through the Claude plugin hook
binding.

---

## Completion

Report the macro id, abandoned subtask count, child archive/detach
summary, whether Codex Stop hook automation is expected for the active session,
and whether the fallback helper was run. The runtime completion footer is
**code-emitted** on this verb's terminal path (ADR-0039): the macro terminal
write (`set-terminal`) fires the ADR-0031 session-handoff sidecar, which renders
the runtime `footer.mjs` on the command's stderr. Do not hand-compose the footer
or hand-pass the projection here; surface the emitted one. An aborted macro
normally projects `archive_gate=ready_to_archive` once every macro gate passes;
the footer reports whatever gate it computes — never archive from it. The render
computes identically on Codex; only auto re-injection of the next-session prompt
depends on the stage-appropriate Codex hook gate (generic `[features].hooks`,
default on) + a `/hooks` trust (operator-attested; not provable
non-interactively). The terminal footer resolves the macro by PATH (not by
branch), so it renders even on detached HEAD — the "no active branch context"
degradation applies only to the branch-resolved `/plan`/`/next` preflight.

---

## Anti-patterns

- Do not use abort for merely postponed work; use finalize/deferred.
- Do not set terminal markers if child archive/detach failed.
- Do not hold the parent lock while archiving children.
- Do not claim Codex Stop hook auto-archive runs automatically unless
  the stage-appropriate hook gate (generic `[features].hooks`, default on)
  and `/hooks` review/trust are complete for
  the active session.
