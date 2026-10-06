```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# host_history fidelity (ADR-0017 §sub-decision-1): no marker over a baseline
# whose commit object is not available. Re-read here: shell variables from
# Phase 2 do not survive across Bash calls.
BASE_HEAD_CHECK="$(node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).git_baseline||{};process.stdout.write(String(b.head??""))}catch{}' /tmp/{{name}}-resume-read.json)"
if [ -z "$BASE_HEAD_CHECK" ] || ! git cat-file -e "$BASE_HEAD_CHECK^{commit}" 2>/dev/null; then
  echo "Phase 2b: resume marker NOT appended (invalid baseline; ADR-0017 §sub-decision-1 host_history fidelity)."
else
  PERSONA={{name}}
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --phase-label "Resume" --phase-note "Re-entered via /${PERSONA}:resume; drift=<clean|dirty>. <one-paragraph diff summary, or 'no changes since baseline'>" \
    --event resumed
fi
```
