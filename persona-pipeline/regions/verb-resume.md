{{#capability dispatch_target}}
The block prints `OP_DIR=<path>`, this command's operation directory: when
the workflow is a macro's child, its write opens the command's persona
operation there (ADR-0068 Decision 2, item 7). Keep the path for the finalize
block's `OP_DIR`.

{{/capability}}
```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A fresh shell: the workflow is found again here, never carried from an
# earlier block.
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
VERB={{verb}}
{{#capability dispatch_target}}
# ADR-0068 Decision 2, item 7 — this command's operation directory: this
# first write opens the command's persona operation there when the workflow
# is a macro's child, and the finalize block's last write closes it.
OP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentic-op.XXXXXX")" || exit 1
{{/capability}}
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb {{verb}} \
{{#capability dispatch_target}}
  --operation-dir "$OP_DIR" --open-operation verb \
{{/capability}}
  --phase-label "Phase 0: Resume into ${VERB}" \
  --phase-note "Resumed from prior verb." \
  --current-phase phase-0-resume \
  --clear-next-step true \
  --next-action "Run ${VERB} skill" --event resumed || exit $?
{{#capability dispatch_target}}
echo "OP_DIR=$OP_DIR"
{{/capability}}
```
